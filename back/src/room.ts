import { applyCardToLoadout, CARD, type Card, drawSpread } from '@shared/cards';
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
  PROJECTILE_CAPACITY,
  SYNERGY_MAX,
  TICK_HZ,
  XP_PER_ORB,
} from '@shared/constants';
import { FlowField } from '@shared/flowfield';
import { entityIdOf, Horde } from '@shared/horde';
import { Loadout } from '@shared/loadout';
import { palierHp } from '@shared/paliers';
import { PlayerHistory } from '@shared/player-history';
import { Projectiles } from '@shared/projectiles';
import { encodeSnapshot, OUTCOME, type PlayerSnapshot } from '@shared/protocol';
import { makeRandom } from '@shared/random';
import type { WaveOrder } from '@shared/waves';
import { BASE_WEAPON_ID, cooldownWithBonus, salvoCount, WEAPONS, weaponOf } from '@shared/weapons';
import { applyObstacles, generateObstacles } from '@shared/worldmap';
import { ZoneField } from '@shared/zones';

import {
  applyReactions,
  type ContactPlayer,
  markInZones,
  OrbField,
  Reactions,
  resolveBurn,
  resolveContact,
  resolveProjectileDamage,
} from './combat';
import { Draft } from './draft';
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
   * Ce que ce joueur possede : armes et passifs, chacun avec son nombre
   * d'exemplaires — tout s'empile (§3.3 de la spec). Naît ici (tache 6), consomme par les taches 7 et 8.
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

/**
 * Une zone posee, telle que `ZONE` la transporte (§5.3 / §8) — element, x, y,
 * tick de naissance, joueur.
 *
 * ⚠️ **Pas de rayon, et pas de mort.** Toutes les zones portent `ZONE_RADIUS`,
 * une constante que les deux cotes lisent deja ; leur peremption se derive du
 * seul `bornTick`, comme celle des orbes. Voir `ZoneMessage`.
 */
export interface ZoneEvent {
  element: number;
  x: number;
  y: number;
  bornTick: number;
  by: number;
}

/**
 * Une reaction a diffuser, telle que `REACTION` la transporte (§6.1 / §8) —
 * couple d'elements, ou, quand, et **un seul bit** : la Synergie a-t-elle
 * ete chargee.
 *
 * ⚠️ **Pas les deux identites** (constat R20 de la tache 5). Le serveur
 * COMPARE le joueur qui a marque et celui qui declenche ; le fil ne porte que
 * le booleen qui en sort. Envoyer deux identites que le client ne pourrait que
 * recomparer l'inviterait a refaire l'arbitrage — donc a diverger. Les deux
 * joueurs vivent dans `ReactionTrigger`, cote combat, et n'en sortent pas.
 *
 * `synergyCharge` est le resultat de cette comparaison, faite dans `step` :
 * vrai quand les deux joueurs different. Il dit ce que la reaction A VALU,
 * pas ou en est la barre — le total, lui, voyage dans le `SNAPSHOT`.
 */
export interface ReactionEvent {
  pair: number;
  x: number;
  y: number;
  tick: number;
  synergyCharge: boolean;
}

/** Une montee de niveau, datee au tick ou le gel prend effet (§6.2). */
/** Un etalage a diffuser, tel que `DRAFT_OPEN` le transporte. */
export interface DraftOpenEvent {
  deadlineTick: number;
  cards: readonly { nature: number; refId: number }[];
}

/** Une resolution a diffuser, telle que `DRAFT_RESULT` la transporte. */
export interface DraftResultEvent {
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
  /**
   * Graine de la carte : obstacles, generateur de vagues, tirage du draft en
   * derivent tous. Aleatoire par defaut, **injectable** — un salon dont on
   * fixe la graine se rejoue a l'identique.
   *
   * ⚠️ Ce n'est pas un confort de test, c'est ce qui rend certains tests
   * possibles. Le test des drafts enchainees construit un tas d'orbes dont la
   * geometrie depend des obstacles ; avec une graine tiree au hasard il
   * echouait environ une fois sur quatre — un test intermittent est pire
   * qu'un test absent, parce qu'on finit par l'ignorer.
   */
  readonly mapSeed: number;
  readonly horde = new Horde(MAX_ENTITIES);
  readonly #players = new Map<number, PlayerState>();
  readonly #fields: FlowField[];
  readonly #history = new PlayerHistory();
  readonly #director: WaveDirector;
  readonly #projectiles = new Projectiles(PROJECTILE_CAPACITY);
  readonly #orbs = new OrbField(MAX_ENTITIES);
  /**
   * Les zones au sol (§5). Vivent ici et nulle part ailleurs cote serveur :
   * `Room.step` est le seul a respecter le contrat d'ordre « expirer avant de
   * poser, une fois par tick » que `ZoneField.spawn` exige.
   */
  readonly #zones = new ZoneField();
  /**
   * Les reactions du tick en cours (§6). Collectees par les trois chemins du
   * §6.2 — impact, entree en zone, recouvrement de zones — puis resolues et
   * videes a la fin de `step`, jamais au fil de l'eau : voir `Reactions`.
   */
  readonly #reactions = new Reactions();
  #pendingZones: ZoneEvent[] = [];
  #pendingReactions: ReactionEvent[] = [];
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
  readonly #draftRng: () => number;
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
   * Le compteur de Synergie de l'EQUIPE (§7 de la spec, « le cœur du projet »
   * du §6.5 de l'orientation).
   *
   * ⚠️ **UN SEUL NOMBRE, pour tout le salon** — comme `#xp`, et pas un par
   * joueur. C'est le defaut que l'etape 3 a commis puis corrige sur
   * l'experience : deux sources de verite pour un seul nombre. Il ne sort
   * d'ici que par l'en-tete du `SNAPSHOT`, jamais par le bloc d'un joueur.
   *
   * ⚠️ **Il monte et ne descend JAMAIS a cette etape.** L'ultime d'equipe que
   * la barre pleine declenche est hors perimetre (§1) : rien ne la depense,
   * donc `SYNERGY_MAX` est un plafond voulu, pas un oubli. Le jour ou l'ultime
   * arrive, c'est ici qu'il soustraira.
   */
  #synergy = 0;

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

  /**
   * Identite du boss du palier en cours, `null` tant qu'aucun n'est en jeu.
   *
   * ⚠️ **Une identite, pas un creneau.** Les creneaux se compactent a chaque
   * mort (`Horde.#removeAt`) : un indice retenu d'un tick a l'autre designerait
   * un autre monstre des la premiere mort. `entityIdOf(waveId, 0)` est stable
   * pour toute la vie de l'entite — c'est deja ce dont depend `DEATHS`.
   */
  #bossEntityId: number | null = null;

  constructor(mapSeed: number = (Math.random() * 0xffff_ffff) >>> 0) {
    this.mapSeed = mapSeed;
    // ⚠️ Initialise ICI, pas a la declaration : depuis que `mapSeed` est
    // injectable, les initialiseurs de champ s'executent AVANT le corps du
    // constructeur et liraient une graine encore indefinie. TypeScript le
    // refuse (TS2729), et c'est bien qu'il le refuse.
    this.#draftRng = makeRandom((mapSeed ^ 0x7a3c_11e5) >>> 0);
    const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    const mask = generateObstacles(this.mapSeed, probe.cols, probe.rows);
    this.#fields = Array.from({ length: MAX_PLAYERS }, () => {
      const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
      applyObstacles(f, mask);
      return f;
    });
    this.#director = new WaveDirector(this.mapSeed ^ 0x5bf0_3a17);
  }

  /**
   * Zones posees a diffuser (§5.3), une par POSE — creation comme
   * rafraichissement.
   *
   * ⚠️ **Un rafraichissement s'annonce aussi, et il le faut.** La regle de
   * fusion (§5.1 bis) fait repartir le `bornTick` d'une zone existante sans
   * en creer de nouvelle ; le client, qui derive la mort de ses zones de ce
   * seul `bornTick`, verrait sinon la sienne mourir avant celle du serveur —
   * et le ralentissement du Givre divergerait de la duree du rafraichissement.
   * Le message porte le centre STOCKE, pas celui du projectile, pour que le
   * `spawn` du client retombe sur la meme zone (distance nulle) sans avoir a
   * deviner laquelle fusionner.
   */
  drainZones(): ZoneEvent[] {
    const out = this.#pendingZones;
    this.#pendingZones = [];
    return out;
  }

  /**
   * Reactions a diffuser (§6.1). Rares — contrairement aux zones, rien ne les
   * entretient : chacune consomme la marque, ou nait d'une zone qui vient
   * d'etre creee et ne se rejoue jamais.
   */
  drainReactions(): ReactionEvent[] {
    const out = this.#pendingReactions;
    this.#pendingReactions = [];
    return out;
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

  /** Projectiles vivants, pour les bancs et les metriques. */
  get projectileCount(): number {
    return this.#projectiles.count;
  }

  /**
   * Projectiles qu'une salve n'a pas pu poser faute de place, depuis le debut
   * de la run. Voir `Projectiles.truncatedProjectiles`.
   */
  get projectilesTronques(): number {
    return this.#projectiles.truncatedProjectiles;
  }

  /**
   * Zones au sol vivantes, pour les bancs — le recouvrement est en O(zones²)
   * et le marquage en O(zones x entites) (§5.2), donc c'est CE nombre, et pas
   * le nombre de projectiles, qui pilote le cout des zones dans un pas.
   *
   * ⚠️ Compte les creneaux occupes, pas les zones que `aliveAt` juge encore
   * vivantes : `Room.step` expire a l'heure (voir le contrat d'ordre de
   * `ZoneField.spawn`), donc les deux coincident cote serveur. Ce ne serait
   * PAS vrai cote client, qui garde ses zones mortes `ROLLBACK_DEPTH_TICKS`
   * ticks de plus pour pouvoir rejouer.
   */
  get zoneCount(): number {
    return this.#zones.count;
  }

  /**
   * Orbes encore au sol, pour les bancs et les tests d'integration.
   *
   * ⚠️ **C'est LE nombre que la tache 17 fait baisser**, et il n'avait aucun
   * lecteur avant elle : *« moins d'xp qui tombe »* parle du nombre d'objets
   * qui trainent, pas de la courbe de progression (voir `ORB_DROP_ONE_IN`).
   * Sans ce lecteur, le taux de chute ne pouvait se verifier qu'a l'unite,
   * dans `combat.test.ts`, jamais sur une vraie run. Meme motif que
   * `zoneCount` juste au-dessus.
   */
  get orbCount(): number {
    return this.#orbs.count;
  }

  /**
   * Zones qu'une pose n'a pas pu creer faute de place, depuis le debut de la
   * run. Voir `ZoneField.truncatedZones`.
   *
   * ⚠️ **Une zone qui ne se pose pas est un effet que le joueur a paye et qui
   * ne se voit pas** (§5.1 bis) : sans ce lecteur, `truncatedZones` n'avait
   * AUCUN appelant hors de son propre test unitaire, et le second rideau de
   * `ZONE_CAPACITY` se serait declenche sans que rien ne le dise. Meme motif
   * que `projectilesTronques` juste au-dessus.
   */
  get zonesTronquees(): number {
    return this.#zones.truncatedZones;
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

  /**
   * Le palier courant, `0` pour le premier — l'argument `k` des formules de
   * `shared/paliers.ts`.
   *
   * ⚠️ **Le palier est une donnee du SALON, et c'est pour ca que les formules
   * sont pures et sans etat.** Il n'avance qu'a la mort du boss, jamais a un
   * tick (§2 de la spec).
   */
  get palier(): number {
    return this.#director.palier;
  }

  /**
   * Identite du boss vivant, `null` quand il n'y en a pas.
   *
   * Exposee pour les tests : c'est elle que `Room.step` compare au lot de
   * morts du tick, et sans elle un test devrait deviner quel ordre de vague
   * etait le boss a partir de son seul `count`.
   */
  get bossEntityId(): number | null {
    return this.#bossEntityId;
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
   *    — un impact MARQUE, il ne laisse plus rien au sol (tache 21)
   * 7 bis. marquer ce que les champs couvrent, resoudre les reactions du tick,
   *    **puis annoncer les champs qu'elles viennent de poser**
   * 8. arbitrer le contact avec les joueurs
   * 9. resoudre les ramassages d'orbes
   * 10. mettre en file morts et ramassages pour diffusion
   * ```
   *
   * ⚠️ **Etape 7 bis : l'annonce vient APRES la reaction, depuis la tache 21.**
   * `#announceZones` ne reconnait une pose qu'a `bornTick === #tick` ; tant que
   * la zone naissait du projectile, l'annoncer avant `markInZones` marchait.
   * Maintenant qu'elle nait de `applyReactions`, l'annoncer avant laisserait
   * chaque champ sans message, pour toujours.
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
      // ⚠️ **Lu AVANT `spawn`, et avant tout le reste** : `bossWaveId` designe
      // le boss que `due` vient eventuellement de demander.
      const estBoss = this.#director.bossWaveId === order.waveId;
      const before = this.horde.count;
      // `this.#fields[0]` : les quatre champs partagent le meme masque
      // d'obstacles (`applyObstacles` au constructeur) — n'importe lequel
      // convient pour eviter de faire naitre une entite en plein mur (tache 18).
      this.horde.spawn(order, this.#fields[0]);
      // Rend visible une troncature silencieuse : voir `RoomMetrics.truncatedSpawns`.
      if (this.horde.count - before < order.count) {
        this.#metrics.truncatedSpawns++;
      }
      this.#scalePalierHp(before);
      if (estBoss) {
        if (this.horde.count > before) {
          this.#bossEntityId = entityIdOf(order.waveId, 0);
        } else {
          // La horde etait pleine : le boss n'existe pas. Sans ce chemin, le
          // verrou du directeur ne se relacherait jamais et le palier serait
          // fige pour le reste de la run.
          this.#director.bossMissing();
        }
      }
      this.#pendingOrders.push(order);
    }

    // ⚠️ **Expirer AVANT de poser, une fois par tick** — le contrat d'ordre
    // que `ZoneField.spawn` exige, le meme que `OrbField.resolvePickups`
    // s'impose a lui-meme.
    //
    // ⚠️ **Et AUCUN TEST NE GARDE cet appel — verifie par application, pas
    // raisonne.** Depuis que `aliveAt` et `slowsAt` decident seuls de ce qui
    // existe et de ce qui ralentit (voir `ZoneField`), l'expiration n'est plus
    // une regle de jeu mais une REPRISE DE MEMOIRE : une zone perimee laissee
    // dans la reserve est deja inerte, et le retirer ne change aucune issue
    // observable a l'echelle d'un test. Ce qu'il change se voit seulement au
    // bout de `ZONE_CAPACITY` (128) zones mortes accumulees, quand la reserve
    // pleine se met a tronquer les poses vivantes — soit bien plus de zones
    // qu'un test unitaire ne peut en faire naitre en `ZONE_LIFETIME_TICKS`
    // ticks. Garde, et dit tel quel plutot que de laisser croire a un appel
    // teste (meme choix que le `slot < 0` de `resolveProjectileDamage`).
    this.#zones.expire(this.#tick);
    this.horde.step(scaledDt, this.#fields, this.#tick, this.#zones);

    this.#fireWeapons(this.#tick);
    const deadIds = resolveProjectileDamage(
      this.#projectiles,
      scaledDt,
      this.horde,
      this.#orbs,
      this.#tick,
      this.#reactions,
    );
    markInZones(this.horde, this.#zones, this.#tick, this.#reactions);
    // ⚠️ **Les reactions se resolvent ICI, apres les DEUX chemins qui les
    // declenchent, et une seule fois.** `Reactions` ne fait que collecter :
    // resoudre au fil de l'eau tuerait des entites pendant que
    // `Projectiles.collide` ou `markInZones` balaient encore la horde par
    // indice de creneau. `drain` remet du meme coup la borne « une reaction
    // par ennemi et par tick » a zero.
    const triggers = this.#reactions.drain();
    const reactedIds = applyReactions(
      this.horde,
      this.#orbs,
      this.#tick,
      triggers,
      this.#zones,
      this.#reactions,
    );
    // ⚠️ **APRES `applyReactions`, et c'est la tache 21 qui l'a deplace.** Les
    // zones naissaient du projectile, donc avant `markInZones` ; elles naissent
    // maintenant de la reaction, donc apres. `#announceZones` ne reconnait une
    // pose qu'a `bornTick === #tick` : l'annoncer avant laisserait chaque champ
    // sans message, pour toujours — et le client ne dessinerait plus rien.
    this.#announceZones();
    for (const t of triggers) {
      // ⚠️ **LA REGLE DU §7, en une comparaison, et elle n'existe qu'ICI.**
      // Deux joueurs differents a l'origine de la reaction — l'un a applique
      // le premier element, l'autre le second — et l'equipe gagne une charge.
      // Le meme joueur des deux cotes : la reaction a lieu, elle ne rapporte
      // rien. C'est ce que le §6.5 de l'orientation appelle « le cœur du
      // projet » : un outil de regroupement qui fonctionne PAR LE GAIN, jamais
      // par la punition — rien n'est retire au joueur qui joue seul.
      //
      // ⚠️ **En solo la barre ne monte donc JAMAIS, par construction** : un
      // seul joueur ne peut poser que sa propre identite des deux cotes, et
      // aucun code n'a a le verifier. C'est voulu, pas un effet de bord.
      //
      // ⚠️ **Le bit annonce la COMPARAISON, pas le mouvement de la barre.** A
      // plafond atteint, une reaction inter-joueurs porte toujours
      // `synergyCharge: true` : le §6.1 dit « un seul bit : la reaction a-t-elle
      // charge la Synergie », et la comparaison est ce qui ne rend qu'un
      // booleen (R20). Le TOTAL, lui, voyage dans le `SNAPSHOT` et fait foi
      // pour la jauge — le client n'a donc rien a recalculer.
      const charge = t.markBy !== t.by;
      if (charge) {
        this.#synergy = Math.min(SYNERGY_MAX, this.#synergy + 1);
      }
      // Le couple d'elements, lui, est deja canonicalise par `packElementPair`
      // cote combat — sans quoi Braise+Givre et Givre+Braise porteraient deux
      // octets differents pour le meme evenement, et deux clients
      // dessineraient deux flashs differents.
      this.#pendingReactions.push({
        pair: t.pair,
        x: t.x,
        y: t.y,
        tick: this.#tick,
        synergyCharge: charge,
      });
    }
    const burntIds = resolveBurn(this.horde, this.#orbs, this.#tick);
    // ⚠️ **UN SEUL lot de morts par tick, brulures ET reactions comprises.**
    // `GameClient` documente cette hypothese et s'appuie dessus : deux lots
    // vises au meme tick, rejoues l'un apres l'autre, verraient le second
    // effacer la correction du premier (`#drainPendingDeaths`). Ni les
    // brulures ni les reactions n'ont donc de chemin de mort a elles — elles
    // rejoignent celui de l'etape 3.
    //
    // Aucun doublon possible, et l'ORDRE est ce qui le garantit : chacune des
    // trois passes tourne APRES la compaction de la precedente, donc les
    // identites deja listees n'existent plus dans la horde quand la suivante
    // la balaie.
    const allDead =
      reactedIds.length > 0 || burntIds.length > 0
        ? [...deadIds, ...reactedIds, ...burntIds]
        : deadIds;
    if (allDead.length > 0) {
      this.#totalKills += allDead.length;
      this.#pendingDeaths.push({ tick: this.#tick, ids: allDead });
      // ⚠️ **LE palier se termine ICI, et nulle part ailleurs.** Le salon sait
      // deja quand une entite meurt : ce lot est le SEUL du tick, brulures et
      // reactions comprises (voir le commentaire ci-dessus). Un second chemin
      // de mort pour le boss casserait le rejeu de l'etape 3 exactement comme
      // deux lots vises au meme tick le casseraient.
      //
      // ⚠️ **Et c'est une MORT, pas un tick.** Rien dans `step` ne date la fin
      // d'un palier : une equipe qui peine reste plus longtemps, une equipe qui
      // domine avance (§2 de la spec).
      if (this.#bossEntityId !== null && allDead.includes(this.#bossEntityId)) {
        this.#bossEntityId = null;
        this.#director.bossDefeated();
      }
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
    // `#xp` et `#synergy` cote a cote, tous deux dans l'EN-TETE : deux donnees
    // d'equipe, deux nombres uniques, aucun bloc de joueur ne les porte.
    const buf = encodeSnapshot(this.#tick, this.#xp, this.#synergy, this.#scratch);
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
   * Applique l'echelle de PV du palier aux entites nees a ce tick, c'est-a-dire
   * a tous les creneaux a partir de `depuis`.
   *
   * ⚠️ **LA QUESTION OUVERTE DU PLAN, et voici la reponse : les PV mis a
   * l'echelle NE VOYAGENT PAS, et n'ont pas a voyager.** Le plan (tache 2,
   * etape 4) craint que le serveur et le client ne calculent pas les memes PV
   * de depart, *« et le client tue des monstres que le serveur garde »*. Ce
   * risque n'existe pas : **le client ne tue rien, et ne lit jamais
   * `Horde.hp`** — il apprend qui meurt par `DEATHS`, depuis l'etape 3. La
   * documentation de `Horde.hp` le dit deja mot pour mot : *« Seul le serveur
   * la soustrait [...] Rien cote client ne la lit. »*
   *
   * C'est donc une **quatrieme voie**, que le plan ne listait pas : ni un
   * champ de plus dans l'ordre de vague, ni un palier derive du `waveId`, ni
   * des PV resolus sur le fil — mais **une grandeur qui n'a jamais eu besoin
   * de traverser**. Les trois voies du plan ajoutaient toutes quelque chose au
   * contrat de replication pour une valeur que personne ne lit de l'autre cote.
   *
   * ⚠️ **Et la deuxieme voie du plan est en plus IMPOSSIBLE.** « Le palier se
   * derive du `waveId` » suppose un nombre fixe de vagues par palier ; le §2 de
   * la spec l'interdit — le palier se termine a la mort du boss et les vagues
   * ne s'arretent pas pendant le combat, donc deux runs a la meme vague 12
   * peuvent etre a des paliers differents.
   *
   * ⚠️ **Ce qui voyage, en revanche, c'est le COMPTE** — et il voyage deja
   * resolu, `waveCountScale` etant applique dans `WaveDirector.due` avant que
   * l'ordre ne parte. Les deux grandeurs du §3 de la spec sont donc traitees
   * differemment, et pour la meme raison : ce que le client lit voyage resolu,
   * ce qu'il ne lit pas reste ici.
   *
   * **Mesure**, pas supposition : `shared/horde.replication.test.ts` porte un
   * scenario qui donne au serveur des PV mis a l'echelle du palier 5 et au
   * client les PV bruts de l'archetype, puis compare — 0,000 px de derive,
   * zero mesappariement d'identite.
   *
   * ⚠️ **Ecrit sans condition** (pas de `if (echelle === 1)`) : au palier 0
   * l'echelle vaut exactement 1 et la multiplication est neutre. Un raccourci
   * ici serait une seconde garde couvrant la premiere, et ferait de la boucle
   * un chemin non teste tant qu'aucun test n'atteint le palier 1.
   *
   * ⚠️ **Ce n'est plus `hpScale` qui est appele ici mais `palierHp`** (tache 3,
   * etape 0) : la pietaille LEGERE est exemptee de la montee, parce que
   * `LIGHT_HP` vaut exactement les degats de la dague et que la premiere marche
   * de l'escalier de durabilite doublait donc son cout. La regle vit dans
   * `shared/paliers.ts`, pas ici : elle doit se lire et se tester sans salon.
   *
   * ⚠️ **`horde.hp[i]` EST la reserve d'archetype a cet instant precis** —
   * `Horde.spawn` vient de l'y ecrire et rien ne l'a encore entamee. C'est ce
   * qui autorise `palierHp` a decider a partir de cette seule valeur ; deplacer
   * cet appel apres le moindre degat lui ferait comparer une reserve entamee au
   * seuil de la chair a canon.
   */
  #scalePalierHp(depuis: number): void {
    const palier = this.#director.palier;
    for (let i = depuis; i < this.horde.count; i++) {
      this.horde.hp[i] = palierHp(this.horde.hp[i] ?? 0, palier);
    }
  }

  /**
   * Met en file un `ZONE` pour chaque zone posee ou rafraichie a ce tick.
   *
   * ⚠️ **Aucun compteur a tenir : `bornTick === #tick` EST la trace de la
   * pose.** La regle de fusion ecrit le tick courant aussi bien quand elle
   * cree que quand elle rafraichit, donc balayer la reserve apres coup dit
   * exactement ce qu'un rappel par pose aurait dit — pour un balayage en
   * O(zones), borne par `ZONE_CAPACITY`, contre une allocation par impact.
   */
  #announceZones(): void {
    for (let z = 0; z < this.#zones.count; z++) {
      if (this.#zones.bornTick[z] !== this.#tick) {
        continue;
      }
      this.#pendingZones.push({
        element: this.#zones.element[z] ?? 0,
        x: this.#zones.x[z] ?? 0,
        y: this.#zones.y[z] ?? 0,
        bornTick: this.#tick,
        by: this.#zones.by[z] ?? 0,
      });
    }
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
    // ⚠️ Chaque exemplaire empile de cette arme elargit la salve d'un
    // projectile : « c'est l'accumulation des cartes qui fait la puissance ».
    // L'arme neutre n'est jamais empilee, `salvoCount` lui rend son compte de
    // base sans cas particulier.
    const count = salvoCount(weapon, p.loadout.stacksOfWeapon(weaponId));
    this.#projectiles.fireSalvoDirected(
      weapon,
      tick,
      p.x,
      p.y,
      p.aimX,
      p.aimY,
      damage,
      count,
      p.id,
    );
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
    this.#draft.open(this.#tick, spread, [...this.#players.keys()], loadouts);
    this.#pendingLevelUps.push({ tick: this.#tick, level: this.#level });
    this.#pendingDraftOpens.push({ deadlineTick: this.#draft.deadlineTick, cards: spread });
  }

  /**
   * Fait avancer l'etalage d'un tick. Quand une phase se ferme, applique les
   * cartes et met le resultat en file.
   *
   * ⚠️ **`deadlineTick` du resultat porte la fin du gel.** Le client ne peut
   * plus la deduire : la fenetre dure jusqu'a ce que tout le monde ait pose son
   * jeton, et en solo elle se ferme au clic. Sans ce champ, chaque client en
   * devinerait une differente — exactement la divergence que le gel date par
   * tick de l'etape 3 existait pour empecher.
   *
   * **Un seul resultat par draft** : la repioche a disparu, la resolution est
   * un seul moment.
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

    this.#freezeUntilTick = this.#tick;
    this.#resumeEndTick = this.#tick + LEVEL_RESUME_TICKS;
    this.#pendingDraftResults.push({ deadlineTick: this.#tick, outcomes: issues });
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
    // La traduction « nature de carte -> mutation d'inventaire » vit dans
    // `shared/` : le client la relit telle quelle pour son propre miroir
    // (tache 9), et deux copies divergeraient.
    applyCardToLoadout(player.loadout, card);
    if (card.nature === CARD.PASSIVE) {
      // ⚠️ Le gain de vie maximum est AUSSI un soin du meme montant. Sans ca
      // la carte « vitalite » ne ferait rien de perceptible : rien ne soigne
      // dans cette etape, donc un plafond releve sans les points qui vont avec
      // ne se verrait qu'apres avoir encaisse des degats. Hors inventaire,
      // donc hors `applyCardToLoadout` : `hp`/`maxHp` sont des champs de
      // `PlayerState`, que le client n'arbitre jamais (§5.4).
      const nouveauMax = PLAYER_MAX_HP + player.loadout.bonus('maxHp');
      player.hp += nouveauMax - player.maxHp;
      player.maxHp = nouveauMax;
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
