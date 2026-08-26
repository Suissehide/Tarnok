import { CARD, type Card, drawSpread } from '@shared/cards';
import {
  FLOWFIELD_CELL,
  FLOWFIELD_HZ,
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
import { Loadout } from '@shared/loadout';
import { PlayerHistory } from '@shared/player-history';
import { Projectiles } from '@shared/projectiles';
import { encodeSnapshot, type PlayerSnapshot } from '@shared/protocol';
import { makeRandom } from '@shared/random';
import type { WaveOrder } from '@shared/waves';
import { BASE_WEAPON_ID, WEAPONS, weaponOf } from '@shared/weapons';
import { applyObstacles, generateObstacles } from '@shared/worldmap';

import { type ContactPlayer, OrbField, resolveContact, resolveProjectileDamage } from './combat';
import { Draft, OUTCOME } from './draft';
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
  /**
   * Points de vie maximum de CE joueur : `PLAYER_MAX_HP` plus le bonus des
   * cartes de vitalite empilees. Personnel, comme `hp`.
   */
  maxHp: number;
  /** Ticks restants avant qu'un nouveau contact puisse a nouveau faire mal. */
  contactInvulnTicks: number;
  /**
   * Dernier tick auquel ce joueur a tire, **par arme** : indice = identifiant
   * d'arme, `-Infinity` = jamais, donc tire des que possible.
   *
   * ⚠️ **Un compteur par arme, pas un pour le joueur.** Avec un compteur
   * unique, l'arsenal entier se recharge a la cadence de l'arme qui vient de
   * tirer : drafter une grenade (75 ticks) briderait la dague neutre (7 ticks)
   * a une salve toutes les 75. Le joueur perdrait en puissance a chaque carte
   * prise — l'inverse exact de ce que le draft promet.
   *
   * Un `Float64Array` et pas un `Map` : `-Infinity` y tient, l'indice EST
   * l'identifiant (meme convention que `WEAPONS`), et la table est lue a
   * chaque tick pour chaque joueur.
   */
  lastFireTick: Float64Array;
  /**
   * Ce que ce joueur possede : armes draftees avec leur niveau, passifs
   * empiles. Naît ici (tache 6), consomme par les taches 7 et 8.
   */
  loadout: Loadout;
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
/** Un etalage a diffuser, tel que `DRAFT_OPEN` le transporte. */
export interface DraftOpenEvent {
  deadlineTick: number;
  cards: readonly { nature: number; refId: number; owner: number }[];
}

/** Une resolution a diffuser, telle que `DRAFT_RESULT` la transporte. */
export interface DraftResultEvent {
  /** `0` : draft termine, `deadlineTick` est la fin du gel. `1` : repioche. */
  phase: number;
  deadlineTick: number;
  outcomes: readonly { playerId: number; cardIndex: number; outcome: number }[];
}

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
 * Reduction maximale de cadence, toutes cartes « cadence » confondues.
 *
 * ⚠️ Le bonus est une FRACTION retiree (0,08 par carte) : treize cartes
 * donneraient 1,04, donc une recharge negative — l'arme tirerait a chaque
 * tick, et une quatorzieme ne changerait plus rien puisque le plancher d'un
 * tick est deja atteint. Plafonner ici garde la courbe lisible et laisse la
 * derniere carte utile.
 */
export const MAX_FIRE_RATE_BONUS = 0.75;

/**
 * Recharge d'une arme apres application des passifs de cadence.
 *
 * Le plancher d'UN tick n'est pas cosmetique : a zero, `tick - lastFireTick`
 * vaut toujours au moins la recharge et l'arme tirerait plusieurs fois par
 * tick si la boucle changeait.
 */
export function cooldownWithBonus(base: number, bonus: number): number {
  const reduction = Math.min(Math.max(bonus, 0), MAX_FIRE_RATE_BONUS);
  return Math.max(1, Math.round(base * (1 - reduction)));
}

/**
 * Capacite de la file de projectiles du salon.
 *
 * ⚠️ **Revisite a la tache 7 de l'etape 4, et desormais MESUREE** — la note
 * precedente disait « marge large sans jamais avoir ete mesuree ».
 *
 * Un joueur entretient au plus `projectileCount * ceil(projectileLifeTicks /
 * cooldownTicks)` projectiles par arme. Sur le catalogue actuel, les cinq
 * pires armes valent 8 (canon-a-mitraille), 6 (lance-flammes), 5 (eventail),
 * 4 (fleches-jumelles) et 1, plus 4 pour l'arme neutre : **28 par joueur**,
 * donc **112 a quatre joueurs avec cinq slots pleins**. 256 tient, avec un
 * facteur 2,3 de marge.
 *
 * A recalculer si une arme au `projectileCount` eleve entre au catalogue :
 * c'est ce produit-la qui domine, pas la cadence seule.
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
  /** L'etalage en cours. `phase === 'closed'` : aucun draft, le monde tourne. */
  readonly #draft = new Draft();
  /**
   * Source aleatoire du draft, derivee de `mapSeed` comme celle du generateur
   * de vagues — avec une constante de melange differente, pour que deux
   * tirages independants ne se suivent pas.
   *
   * ⚠️ Le draft ne participe pas au contrat de replication (§2 de la spec de
   * l'etape 4) : aucun client ne refait ce tirage. La graine sert la
   * reproductibilite des tests, pas la convergence.
   */
  readonly #draftRng = makeRandom((this.mapSeed ^ 0x7a3c_11e5) >>> 0);
  /** Niveaux gagnes dont le draft n'a pas encore eu lieu. */
  #pendingLevels = 0;
  #pendingDraftOpens: DraftOpenEvent[] = [];
  #pendingDraftResults: DraftResultEvent[] = [];
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
  /** Les etalages ouverts depuis le dernier drainage. */
  drainDraftOpens(): DraftOpenEvent[] {
    const out = this.#pendingDraftOpens;
    this.#pendingDraftOpens = [];
    return out;
  }

  /** Les resolutions depuis le dernier drainage. */
  drainDraftResults(): DraftResultEvent[] {
    const out = this.#pendingDraftResults;
    this.#pendingDraftResults = [];
    return out;
  }

  /** Les intentions en cours : qui vise quoi. Vide hors draft. */
  draftIntents(): ReadonlyMap<number, number> {
    return this.#draft.intents();
  }

  /** Pose ou deplace le jeton d'un joueur. Rend `false` si le geste est refuse. */
  setDraftToken(playerId: number, cardIndex: number): boolean {
    return this.#draft.setToken(playerId, cardIndex);
  }

  /**
   * Ce que ce joueur a accumule au fil des drafts. `undefined` s'il n'est pas
   * dans le salon.
   */
  loadoutOf(playerId: number): Loadout | undefined {
    return this.#players.get(playerId)?.loadout;
  }

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
      maxHp: PLAYER_MAX_HP,
      contactInvulnTicks: 0,
      lastFireTick: new Float64Array(WEAPONS.length).fill(Number.NEGATIVE_INFINITY),
      loadout: new Loadout(),
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

    // Un niveau attend et aucun etalage n'est ouvert : on ouvre.
    if (this.#draft.phase === 'closed' && this.#pendingLevels > 0) {
      this.#openDraft();
    }

    // Un etalage est ouvert : le monde est gele, seule la machine avance.
    if (this.#draft.phase !== 'closed') {
      this.#stepDraft();
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
      // Vitesse propre a ce joueur : les cartes « fougue » empilees s'ajoutent
      // a `PLAYER_SPEED`, en pixels monde par seconde.
      const speed = PLAYER_SPEED + p.loadout.bonus('speed');
      p.x = clamp(p.x + p.moveX * speed * scaledDt, 0, MAP_SIZE);
      p.y = clamp(p.y + p.moveY * speed * scaledDt, 0, MAP_SIZE);
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

    for (const p of this.#players.values()) {
      if (p.hp <= 0) {
        continue;
      }
      if (p.aimX === 0 && p.aimY === 0) {
        continue;
      }
      // ⚠️ L'arme neutre d'abord, et TOUJOURS : elle vit hors des slots (§6.1),
      // ne figure dans aucun `Loadout`, et ne disparait jamais de l'arsenal.
      this.#fireOne(p, BASE_WEAPON_ID, tick);
      for (const id of p.loadout.weaponIds) {
        this.#fireOne(p, id, tick);
      }
    }
  }

  /**
   * Tire une salve de cette arme si sa propre recharge est faite, passifs
   * empiles appliques (tache 8).
   *
   * Le catalogue `WEAPONS` n'est JAMAIS modifie : les bonus se calculent ici,
   * a chaque tir, a partir de l'inventaire du joueur.
   */
  #fireOne(p: PlayerState, weaponId: number, tick: number): void {
    const weapon = weaponOf(weaponId);
    const cooldown = cooldownWithBonus(weapon.cooldownTicks, p.loadout.bonus('fireRate'));
    if (tick - (p.lastFireTick[weaponId] ?? Number.NEGATIVE_INFINITY) < cooldown) {
      return;
    }
    const damage = weapon.damage * (1 + p.loadout.bonus('damage'));
    this.#projectiles.fireSalvoDirected(weapon, tick, p.x, p.y, p.aimX, p.aimY, damage);
    p.lastFireTick[weaponId] = tick;
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
  /**
   * Ouvre un etalage : tire les cartes, met en file le `LEVEL_UP` **date du
   * tick courant** et le `DRAFT_OPEN`.
   *
   * ⚠️ Le `LEVEL_UP` est date d'ici, pas de `#gainXp` : c'est ici que le gel
   * commence reellement. Le §6.2 exige que les clients figent au tick indique
   * et non a la reception, sans quoi chacun figerait selon sa latence.
   */
  #openDraft(): void {
    this.#pendingLevels--;
    const loadouts = new Map<number, Loadout>();
    for (const [id, p] of this.#players) {
      loadouts.set(id, p.loadout);
    }
    const spread = drawSpread(loadouts, this.#draftRng);
    this.#draft.open(this.#tick, spread, [...this.#players.keys()]);
    this.#pendingLevelUps.push({ tick: this.#tick, level: this.#level });
    this.#pendingDraftOpens.push({ deadlineTick: this.#draft.deadlineTick, cards: spread });
  }

  /**
   * Fait avancer l'etalage d'un tick. Quand une phase se ferme, applique les
   * cartes et met le resultat en file.
   *
   * ⚠️ **`deadlineTick` du resultat porte la fin du gel** quand la phase vaut
   * `0`. Le client ne peut plus la deduire : la fenetre dure jusqu'a ce que
   * tout le monde ait pose son jeton, et en solo elle se ferme au clic. Sans
   * ce champ, chaque client en devinerait une differente — exactement la
   * divergence que le gel date par tick de l'etape 3 existait pour empecher.
   */
  #stepDraft(): void {
    const issues = this.#draft.step(this.#tick, this.#draftRng);
    if (!issues) {
      return;
    }
    const spread = this.#draft.spread;
    for (const r of issues) {
      if (r.outcome === OUTCOME.LOST) {
        continue;
      }
      const card = spread[r.cardIndex];
      const player = this.#players.get(r.playerId);
      if (!card || !player) {
        continue;
      }
      this.grantCard(r.playerId, card);
    }

    const termine = this.#draft.phase === 'closed';
    if (termine) {
      this.#freezeUntilTick = this.#tick;
      this.#resumeEndTick = this.#tick + LEVEL_RESUME_TICKS;
    }
    this.#pendingDraftResults.push({
      phase: termine ? 0 : 1,
      deadlineTick: termine ? this.#tick : this.#draft.deadlineTick,
      outcomes: issues,
    });
  }

  /**
   * Range une carte dans l'inventaire de son preneur, et applique ce qui en
   * decoule immediatement (les points de vie de « vitalite »).
   *
   * **C'est le seul chemin par lequel une carte entre dans un inventaire.**
   * Public pour cette raison : passer par `loadoutOf(id).addPassive(...)`
   * sauterait le soin, et deux chemins d'entree divergeraient tot ou tard.
   */
  grantCard(playerId: number, card: Card): void {
    const player = this.#players.get(playerId);
    if (!player) {
      return;
    }
    const { nature, refId } = card;
    switch (nature) {
      case CARD.NEW_WEAPON:
        player.loadout.addWeapon(refId);
        break;
      case CARD.WEAPON_LEVEL:
      case CARD.EVOLUTION:
        player.loadout.levelUpWeapon(refId);
        break;
      case CARD.PASSIVE: {
        player.loadout.addPassive(refId);
        // ⚠️ Le gain de vie maximum est AUSSI un soin du meme montant. Sans
        // ca la carte « vitalite » ne ferait rien de perceptible : rien ne
        // soigne dans cette etape, donc un plafond releve sans les points qui
        // vont avec ne se verrait qu'apres avoir encaisse des degats.
        const nouveauMax = PLAYER_MAX_HP + player.loadout.bonus('maxHp');
        player.hp += nouveauMax - player.maxHp;
        player.maxHp = nouveauMax;
        break;
      }
      default:
        break;
    }
  }

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
      // ⚠️ **Plus rien a programmer ici.** A l'etape 3, le gel durait une
      // constante, donc on pouvait calculer sa fin d'avance — et il fallait
      // enchainer les gels a la main quand plusieurs niveaux tombaient d'un
      // coup. Desormais le gel dure jusqu'a la fermeture du draft : on se
      // contente de compter les niveaux dus, et `step` ouvre le suivant quand
      // le precedent se referme. Le chainage disparait de lui-meme.
      this.#pendingLevels++;
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
