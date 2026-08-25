import {
  FLOWFIELD_CELL,
  FLOWFIELD_HZ,
  LEVEL_FREEZE_TICKS,
  LEVEL_RESUME_TICKS,
  LEVEL_XP_BASE,
  MAP_SIZE,
  MAX_ENTITIES,
  MAX_PLAYERS,
  PLAYER_MAX_HP,
  PLAYER_SPEED,
  TICK_HZ,
  XP_PER_ORB,
} from '@shared/constants';
import { FlowField } from '@shared/flowfield';
import { Horde } from '@shared/horde';
import { PlayerHistory } from '@shared/player-history';
import { Projectiles } from '@shared/projectiles';
import { encodeSnapshot, type PlayerSnapshot } from '@shared/protocol';
import type { WaveOrder } from '@shared/waves';
import { weaponOf } from '@shared/weapons';
import { applyObstacles, generateObstacles } from '@shared/worldmap';

import { type ContactPlayer, OrbField, resolveContact, resolveProjectileDamage } from './combat';
import { WaveDirector } from './wave-director';

/**
 * Le salon ne connait pas le reseau.
 *
 * Il recoit des entrees, avance d'un pas fixe, et ecrit ses sorties dans une
 * outbox que l'appelant vide. C'est ce qui rendra le passage en `worker_threads`
 * (un salon par worker, §3 de la spec) mecanique au lieu d'etre une reecriture —
 * et c'est verifie par une regle Biome sur ce fichier (et sur `combat.ts`), pas
 * seulement par la discipline.
 */
export interface Outbox {
  push(msg: ArrayBuffer): void;
}

export interface PlayerState extends ContactPlayer {
  id: number;
  x: number;
  y: number;
  /** Axe de deplacement normalise, dans [-1, 1]. */
  moveX: number;
  moveY: number;
  /**
   * Direction de visee (tache 13), telle que recue par `INPUT` : deja
   * quantifiee sur un octet signe (-127..127), jamais renormalisee ici — seul
   * `Math.atan2` en tirera un angle (voir `Projectiles.fireSalvoDirected`),
   * et l'angle ne depend pas de la norme du vecteur. `(0, 0)` : ce joueur ne
   * tire pas ce tick.
   */
  aimX: number;
  aimY: number;
  /** Derniere sequence d'entree appliquee, sur 16 bits. */
  lastSeq: number;
  /** Points de vie, personnels (voir `combat.ts`). */
  hp: number;
  /** Ticks restants avant qu'un nouveau contact puisse a nouveau faire mal. */
  contactInvulnTicks: number;
  /** Dernier tick auquel ce joueur a tire. `-Infinity` : jamais — tire des que possible. */
  lastFireTick: number;
}

export interface RoomMetrics {
  /** Octets pousses dans l'outbox depuis le dernier drainage. */
  bytesSent: number;
  /** Micro-secondes passees a encoder depuis le dernier drainage. */
  encodeMicros: number;
  /** Nombre de snapshots encodes depuis le dernier drainage. */
  snapshots: number;
  /**
   * Nombre de vagues tronquees par `Horde.spawn` depuis le dernier drainage —
   * la horde a atteint sa capacite et une partie de la vague n'est jamais
   * apparue. Reste possible a l'etape 3 (les morts vident la horde mais une
   * vague ponctuelle peut toujours depasser la capacite instantanee) : ce
   * compteur reste donc utile, pas seulement un vestige de l'etape 2.
   */
  truncatedSpawns: number;
}

/** Un lot d'identites datees, pour DEATHS et PICKUPS (§3.1 / §6.1 de la spec). */
export interface IdBatch {
  tick: number;
  ids: number[];
}

/** Une montee de niveau, datee au tick ou le gel prend effet (§6.2). */
export interface LevelUpEvent {
  tick: number;
  level: number;
}

/** La fin d'une run, une seule fois (§6.3). */
export interface RunOverEvent {
  tick: number;
  survivedTicks: number;
  level: number;
  kills: number;
}

/**
 * Positions de depart, autour du centre de la carte. Distinctes pour que quatre
 * joueurs ne se superposent pas a la connexion.
 */
const SPAWN_OFFSETS: readonly (readonly [number, number])[] = [
  [-120, -120],
  [120, -120],
  [-120, 120],
  [120, 120],
];

/** Un axe d'entree tient sur un octet signe : on le ramene dans [-1, 1]. */
const AXIS_SCALE = 1 / 127;

/**
 * Capacite de la file de projectiles du salon.
 *
 * ⚠️ Cette etape ne cable que l'arme neutre de base (§6.1) — voir la doc de
 * `#fireWeapons` pour pourquoi. A un projectile par joueur et par cooldown
 * (15 ticks, vie 20 ticks), quatre joueurs entretiennent au plus quelques
 * projectiles simultanes chacun : 256 laisse une marge large sans jamais
 * avoir ete mesuree comme necessaire — a revisiter si l'etape 4 ajoute des
 * armes a cadence plus rapide.
 */
const PROJECTILE_CAPACITY = 256;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Compare deux sequences sur 16 bits en tenant compte du rebouclage.
 *
 * Une comparaison naive `a > b` rejetterait toutes les entrees pendant un demi
 * tour de compteur des que `seq` repasse par zero — soit toutes les 36 minutes a
 * 30 Hz. Le cout de s'en occuper maintenant est de trois lignes.
 */
function isNewer(a: number, b: number): boolean {
  return a !== b && ((a - b) & 0xffff) < 0x8000;
}

export class Room {
  /** Graine de la carte d'obstacles, tiree a la creation du salon. */
  readonly mapSeed: number = (Math.random() * 0xffff_ffff) >>> 0;
  readonly horde = new Horde(MAX_ENTITIES);
  readonly #players = new Map<number, PlayerState>();
  readonly #fields: FlowField[];
  readonly #history = new PlayerHistory();
  readonly #director: WaveDirector;
  readonly #projectiles = new Projectiles(PROJECTILE_CAPACITY);
  readonly #orbs = new OrbField(MAX_ENTITIES);
  #pendingOrders: WaveOrder[] = [];
  #pendingDeaths: IdBatch[] = [];
  #pendingPickups: IdBatch[] = [];
  #pendingLevelUps: LevelUpEvent[] = [];
  #pendingRunOver: RunOverEvent | null = null;
  #tick = 0;
  /** Tick des positions ayant servi au dernier calcul des champs. Voir `fieldInputTick`. */
  #fieldInputTick = 0;
  #metrics: RoomMetrics = { bytesSent: 0, encodeMicros: 0, snapshots: 0, truncatedSpawns: 0 };
  /** Reutilise d'un snapshot a l'autre : pas d'allocation par tick. */
  readonly #scratch: PlayerSnapshot[] = [];

  /** Experience de l'equipe, EN COURS DE NIVEAU : remise a l'excedent a chaque montee, jamais cumulee sur toute la run. */
  #xp = 0;
  /** Niveau courant de l'equipe, commence a 1. */
  #level = 1;
  /** Ennemis tues depuis le debut de la run, cumule pour `RUN_OVER.kills`. */
  #totalKills = 0;

  /**
   * Dernier tick du gel courant (inclus) : tant que `#tick <= #freezeUntilTick`,
   * `step` ne fait qu'incrementer le tick et revient. `0` hors gel, puisque le
   * premier tick reel vaut 1.
   */
  #freezeUntilTick = 0;
  /** Dernier tick de la reprise progressive qui suit le gel (voir `#movementScale`). */
  #resumeEndTick = 0;

  /** Vrai une fois que `RUN_OVER` a ete mis en file — la simulation s'arrete alors pour de bon. */
  #runOver = false;

  constructor() {
    const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    const mask = generateObstacles(this.mapSeed, probe.cols, probe.rows);
    this.#fields = Array.from({ length: MAX_PLAYERS }, () => {
      const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
      applyObstacles(f, mask);
      return f;
    });
    this.#director = new WaveDirector(this.mapSeed ^ 0x5bf0_3a17);
  }

  /** Ordres de vague a diffuser. Le serveur les vide a chaque tick. */
  drainWaveOrders(): WaveOrder[] {
    const orders = this.#pendingOrders;
    this.#pendingOrders = [];
    return orders;
  }

  /** Lots de morts a diffuser (§3.1), un par tick ou quelqu'un est mort. */
  drainDeaths(): IdBatch[] {
    const out = this.#pendingDeaths;
    this.#pendingDeaths = [];
    return out;
  }

  /** Lots de ramassages a diffuser (§6.1), un par tick ou un orbe a ete pris. */
  drainPickups(): IdBatch[] {
    const out = this.#pendingPickups;
    this.#pendingPickups = [];
    return out;
  }

  /** Montees de niveau a diffuser (§6.2), datees au tick ou le gel prend effet. */
  drainLevelUps(): LevelUpEvent[] {
    const out = this.#pendingLevelUps;
    this.#pendingLevelUps = [];
    return out;
  }

  /** Fin de run a diffuser, ou `null` si elle n'a pas encore eu lieu (ou deja ete diffusee). */
  drainRunOver(): RunOverEvent | null {
    const out = this.#pendingRunOver;
    this.#pendingRunOver = null;
    return out;
  }

  get tick(): number {
    return this.#tick;
  }

  /**
   * Tick dont proviennent les positions ayant servi au dernier calcul des
   * champs. Doit rester en retard de `FIELD_INPUT_DELAY_TICKS` sur le tick
   * courant : c'est ce retard, que le serveur s'impose a lui-meme, qui rend son
   * champ reproductible par le client.
   */
  get fieldInputTick(): number {
    return this.#fieldInputTick;
  }

  get playerCount(): number {
    return this.#players.size;
  }

  get metrics(): Readonly<RoomMetrics> {
    return this.#metrics;
  }

  /** Rend false si le salon est plein. */
  join(id: number): boolean {
    if (this.#players.has(id)) {
      return true;
    }
    if (this.#players.size >= MAX_PLAYERS) {
      return false;
    }
    const offset = SPAWN_OFFSETS[this.#players.size] ?? [0, 0];
    this.#players.set(id, {
      id,
      x: MAP_SIZE / 2 + offset[0],
      y: MAP_SIZE / 2 + offset[1],
      moveX: 0,
      moveY: 0,
      aimX: 0,
      aimY: 0,
      lastSeq: 0,
      hp: PLAYER_MAX_HP,
      contactInvulnTicks: 0,
      lastFireTick: Number.NEGATIVE_INFINITY,
    });
    return true;
  }

  leave(id: number): void {
    this.#players.delete(id);
  }

  /**
   * Une entree d'un joueur absent est ignoree sans bruit : a la deconnexion, des
   * trames peuvent encore arriver apres le `leave`, et ce n'est pas une erreur.
   *
   * `aimX`/`aimY` (tache 13) sont bornes comme `moveX`/`moveY` mais jamais
   * renormalises : contrairement au deplacement, seul l'ANGLE de la visee
   * compte (`Math.atan2` dans `Projectiles.fireSalvoDirected` ignore la
   * norme), donc rien ne justifie d'imposer un cercle unite ici. Les valeurs
   * par defaut sont `0`, pour que les tests de deplacement existants (qui
   * n'appellent `applyInput` qu'avec quatre arguments) restent silencieux sur
   * la visee — `(0, 0)` signifiant deja « pas de tir ».
   */
  applyInput(id: number, seq: number, moveX: number, moveY: number, aimX = 0, aimY = 0): void {
    const p = this.#players.get(id);
    if (!p || !isNewer(seq, p.lastSeq)) {
      return;
    }
    p.lastSeq = seq;

    let nx = clamp(moveX, -127, 127) * AXIS_SCALE;
    let ny = clamp(moveY, -127, 127) * AXIS_SCALE;
    // On normalise au-dela du cercle unite, jamais en deca : sans ca on avance
    // 41 % plus vite en diagonale, ce qui se sent immediatement a la manette.
    const len = Math.hypot(nx, ny);
    if (len > 1) {
      nx /= len;
      ny /= len;
    }
    p.moveX = nx;
    p.moveY = ny;

    p.aimX = clamp(aimX, -127, 127);
    p.aimY = clamp(aimY, -127, 127);
  }

  /**
   * Un pas de simulation. `dt` est fixe : 1 / TICK_HZ.
   *
   * ⚠️ **L'ordre compte, et il doit rester identique cote client (tache 10).**
   * Sequence retenue (voir aussi `combat.ts`, qui porte les etapes 7 a 9) :
   *
   * ```
   * 1. tick++
   * 2. deplacer les joueurs
   * 3. enregistrer l'historique de positions (arrondi !)
   * 4. rafraichir les champs si du (tick % stepsPerField)
   * 5. appliquer les ordres de vague en attente
   * 6. avancer la horde — `Horde.step` recalcule d'abord la trajectoire des
   *    entites dont c'est le tour (direction du champ + repulsion sommee,
   *    tache 19), puis avance tout le monde ; l'ancienne etape separee
   *    « appliquer la separation » a fusionne dans cet appel unique
   * 7. tirer les salves dues, avancer les projectiles, resoudre les collisions
   * 8. arbitrer le contact avec les joueurs
   * 9. resoudre les ramassages d'orbes
   * 10. mettre en file morts et ramassages pour diffusion
   * ```
   *
   * ⚠️ **Etapes 4 et 5 : le rafraichissement precede l'engendrement, depuis
   * l'etape 2 — un ordre unique, pas un choix fait ici.** `shared/horde.replication.test.ts`
   * documente cette meme sequence serveur (« enregistrement -> rafraichissement
   * -> apparition simple ») et c'est cet ordre-la, precisement, que ses
   * scenarios verifient a 0,000 px de derive avec rejeu (scenario 9). Le code
   * de cette methode existait deja dans cet ordre avant la tache 9 — c'est le
   * code eprouve qui fait foi. Ne pas inverser sans rejouer ce scenario.
   */
  step(dt: number): void {
    this.#tick++;

    if (this.#runOver) {
      // Fin de run : plus rien n'avance, mais le tick continue de compter —
      // c'est lui qui date le message deja mis en file. C'est le SEUL garde
      // qui porte cette garantie (verifie par mutation) : rien dans le
      // deplacement des joueurs plus bas ne verifie `hp`, donc sans ce
      // retour un joueur a 0 pv continuerait de glisser sur la carte si une
      // entree de mouvement lui arrivait encore.
      return;
    }

    if (this.#tick <= this.#freezeUntilTick) {
      // Gel (§6.2) : le monde ne bouge pas, mais le tick continue d'avancer —
      // c'est lui qui date le LEVEL_UP deja mis en file, pour que les clients
      // figent au meme tick plutot qu'a la reception.
      //
      // ⚠️ Ce garde n'est PAS redondant avec `#movementScale()` plus bas.
      // Le facteur de vitesse ne module que le DEPLACEMENT (joueurs, horde,
      // separation, projectiles) ; le tir automatique, le contact et les
      // ramassages ne sont moderes par aucune rampe. Sans ce retour, un
      // monstre pose au contact d'un joueur continuerait a lui infliger des
      // degats PENDANT le gel — verifie par mutation : le retirer fait
      // baisser les pv du joueur alors que le monde est cense etre fige.
      return;
    }

    const movementScale = this.#movementScale();
    const scaledDt = dt * movementScale;

    for (const p of this.#players.values()) {
      p.x = clamp(p.x + p.moveX * PLAYER_SPEED * scaledDt, 0, MAP_SIZE);
      p.y = clamp(p.y + p.moveY * PLAYER_SPEED * scaledDt, 0, MAP_SIZE);
    }

    // Arrondies, comme sur le fil (constat C1.4) : le client ne connaitra
    // jamais que la version quantifiee en int16 du protocole (`encodeSnapshot`
    // arrondit deja). Si le serveur alimentait son propre flowfield avec des
    // positions flottantes, les deux cotes enracineraient leur BFS dans des
    // cellules differentes une fois par cellule et par axe — le serveur doit
    // s'imposer l'arrondi comme il s'impose deja le retard.
    const xs: number[] = [];
    const ys: number[] = [];
    for (const p of this.#players.values()) {
      xs.push(Math.round(p.x));
      ys.push(Math.round(p.y));
    }
    this.#history.record(this.#tick, xs, ys);

    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    if (this.#tick % stepsPerField === 0) {
      // ⚠️ Les positions **retardees**, pas les courantes. Le serveur s'impose
      // le retard qu'il inflige au client : c'est ce qui rend les deux champs
      // identiques (§5 de la spec de l'etape 2).
      const seen = this.#history.delayed(this.#tick);
      if (seen) {
        this.#fieldInputTick = seen.tick;
        for (let f = 0; f < seen.x.length && f < this.#fields.length; f++) {
          this.#fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
        }
        this.horde.retarget(seen.x, seen.y);
      }
    }

    const order = this.#director.due(this.#tick, xs, ys);
    if (order) {
      const before = this.horde.count;
      // `this.#fields[0]` : les quatre champs partagent le meme masque
      // d'obstacles (`applyObstacles` au constructeur) — n'importe lequel
      // convient pour eviter de faire naitre une entite en plein mur (tache 18).
      this.horde.spawn(order, this.#fields[0]);
      // Rend visible une troncature silencieuse : voir `RoomMetrics.truncatedSpawns`.
      if (this.horde.count - before < order.count) {
        this.#metrics.truncatedSpawns++;
      }
      this.#pendingOrders.push(order);
    }

    this.horde.step(scaledDt, this.#fields, this.#tick);

    this.#fireWeapons(this.#tick);
    const deadIds = resolveProjectileDamage(
      this.#projectiles,
      scaledDt,
      this.horde,
      this.#orbs,
      this.#tick,
    );
    if (deadIds.length > 0) {
      this.#totalKills += deadIds.length;
      this.#pendingDeaths.push({ tick: this.#tick, ids: deadIds });
    }

    resolveContact([...this.#players.values()], this.horde);

    const pickedIds = this.#orbs.resolvePickups([...this.#players.values()], this.#tick);
    if (pickedIds.length > 0) {
      this.#pendingPickups.push({ tick: this.#tick, ids: pickedIds });
      this.#gainXp(pickedIds.length * XP_PER_ORB);
    }

    this.#checkRunOver();
  }

  snapshot(out: Outbox): void {
    this.#scratch.length = 0;
    for (const p of this.#players.values()) {
      this.#scratch.push({ id: p.id, x: p.x, y: p.y, hp: p.hp, aimX: p.aimX, aimY: p.aimY });
    }

    const started = performance.now();
    const buf = encodeSnapshot(this.#tick, this.#xp, this.#scratch);
    this.#metrics.encodeMicros += (performance.now() - started) * 1000;
    this.#metrics.bytesSent += buf.byteLength;
    this.#metrics.snapshots++;

    out.push(buf);
  }

  /** Rend les compteurs accumules et les remet a zero. */
  drainMetrics(): RoomMetrics {
    const drained = this.#metrics;
    this.#metrics = { bytesSent: 0, encodeMicros: 0, snapshots: 0, truncatedSpawns: 0 };
    return drained;
  }

  /**
   * Tire les salves dues (etape 8, premiere moitie) : chaque joueur vivant,
   * dont le cooldown est ecoule et dont la visee n'est pas nulle, tire dans
   * la direction qu'il vise.
   *
   * ⚠️ **Decision de conception, absente du brief.** Seule l'arme neutre de
   * base (`WEAPONS[0]`, §6.1) est tiree, par tous les joueurs, pendant toute
   * cette etape. Le §6.2 de la spec evoque « monter une arme automatiquement »
   * a chaque niveau, mais le tableau « Hors de l'etape » de la meme spec place
   * explicitement l'etalage de cartes — et tout ce qui change l'arsenal d'un
   * joueur — a l'etape 4 : « le gel est cable ici, l'etalage s'y branchera ».
   * Construire une progression d'armes maintenant anticiperait ce que l'etape
   * 4 doit trancher avec un vrai choix du joueur.
   *
   * ⚠️ **La visee suit le curseur, decision de l'auteur (tache 13), contre le
   * §5.3 de la spec d'etape et le §5 de l'orientation, qui partaient tous
   * deux sur une auto-visee.** La cadence reste automatique (le cooldown
   * ci-dessus) ; c'est la DIRECTION qui est une entree joueur, portee par
   * `PlayerState.aimX`/`aimY` — voir leur doc et celle d'`applyInput`. Ce
   * fichier ne cible donc plus rien dans `horde` : `fireSalvo` (par cible) et
   * `nearestTarget` restent disponibles ailleurs mais ne sont plus appeles
   * ici, voir le rapport de la tache 13.
   *
   * Une visee nulle ne tire pas : `(0, 0)` est la direction qu'envoie un
   * curseur pile sur le joueur, ou une souris jamais bougee, et les DEUX
   * cotes la voient identique — ne pas tirer est deterministe, choisir une
   * direction par defaut ne le serait pas (voir `Projectiles.fireSalvoDirected`).
   */
  #fireWeapons(tick: number): void {
    if (this.#players.size === 0) {
      return;
    }
    const weapon = weaponOf(0);

    for (const p of this.#players.values()) {
      if (p.hp <= 0) {
        continue;
      }
      if (tick - p.lastFireTick < weapon.cooldownTicks) {
        continue;
      }
      if (p.aimX === 0 && p.aimY === 0) {
        continue;
      }
      this.#projectiles.fireSalvoDirected(weapon, tick, p.x, p.y, p.aimX, p.aimY);
      p.lastFireTick = tick;
    }
  }

  /**
   * Facteur applique au `dt` de tout ce qui bouge (joueurs, horde, separation,
   * projectiles) : `0` pendant le gel strict (jamais atteint ici — `step`
   * revient avant), une rampe de `0` (exclu) a `1` pendant les
   * `LEVEL_RESUME_TICKS` qui suivent, `1` en fonctionnement normal.
   *
   * ⚠️ **La reprise doit etre PROGRESSIVE, pas un interrupteur.** Sans rampe,
   * un monstre reste colle au joueur au moment du gel et le touche des le
   * premier tick de la reprise, sans lui laisser le temps de reagir (§6.2,
   * comme *Swarm*).
   */
  #movementScale(): number {
    if (this.#tick > this.#resumeEndTick) {
      return 1;
    }
    const sinceFreezeEnd = this.#tick - this.#freezeUntilTick;
    return Math.min(1, Math.max(0, sinceFreezeEnd / LEVEL_RESUME_TICKS));
  }

  /**
   * Ajoute de l'experience a l'equipe et fait monter les niveaux que le total
   * franchit (§6.2). Une pile plutot qu'un simple `if` : un gros lot de
   * ramassages au meme tick peut franchir plusieurs seuils d'un coup.
   *
   * Chaque niveau obtenu programme SON PROPRE gel, mis bout a bout apres celui
   * qui serait deja en file : deux montees dans un meme lot ne doivent pas se
   * chevaucher.
   */
  #gainXp(amount: number): void {
    this.#xp += amount;
    while (this.#xp >= this.#xpToNextLevel()) {
      this.#xp -= this.#xpToNextLevel();
      this.#level++;
      // Le gel prend effet au tick SUIVANT le dernier deja programme (ou le
      // tick courant, s'il n'y en a pas) — jamais a l'emission : §6.2, meme
      // raison que pour DEATHS.
      const freezeStart = Math.max(this.#tick, this.#resumeEndTick) + 1;
      this.#freezeUntilTick = freezeStart + LEVEL_FREEZE_TICKS - 1;
      this.#resumeEndTick = this.#freezeUntilTick + LEVEL_RESUME_TICKS;
      this.#pendingLevelUps.push({ tick: freezeStart, level: this.#level });
    }
  }

  /** Seuil pour passer du niveau courant au suivant. Voir `LEVEL_XP_BASE`. */
  #xpToNextLevel(): number {
    return LEVEL_XP_BASE * this.#level * Math.max(1, this.#players.size);
  }

  /**
   * Detecte la fin de run — tous les joueurs presents a 0 pv (§6.3) — et met
   * `RUN_OVER` en file **une seule fois**.
   *
   * Pas de garde sur `#runOver` ICI : `step()` ne l'appelle jamais une fois
   * `#runOver` vrai (son propre garde de tete rend cet appel inatteignable),
   * donc un second garde ici serait mort — verifie par mutation, sa
   * suppression ne fait echouer aucun test. C'est le garde de `step()` qui
   * porte a lui seul la garantie « une seule fois ».
   */
  #checkRunOver(): void {
    if (this.#players.size === 0) {
      return;
    }
    for (const p of this.#players.values()) {
      if (p.hp > 0) {
        return;
      }
    }
    this.#runOver = true;
    this.#pendingRunOver = {
      tick: this.#tick,
      survivedTicks: this.#tick,
      level: this.#level,
      kills: this.#totalKills,
    };
  }
}
