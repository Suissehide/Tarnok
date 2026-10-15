import {
  ABILITY_COOLDOWN_TICKS,
  ABILITY_ZONE_RADIUS,
  type AbilityUsed,
  ADJACENT_RANGE,
  DECOY_LIFETIME_TICKS,
  RELAIS_INTANGIBLE_TICKS,
  RELAIS_RANGE,
  REMPART_ARMOR,
  REMPART_LIFETIME_TICKS,
  VERB_IDS,
} from '@shared/abilities';
import {
  archetypeIdOf,
  archetypeOf,
  NECRO_CHILD,
  NECRO_COOLDOWN_TICKS,
  NECRO_RADIUS,
  NECRO_RAISE_MAX,
  SHAMAN_AURA_RADIUS,
  SHOT_DAMAGE,
  SPLIT_CHILD,
  SPLIT_COUNT,
  THIEF_STEAL_SHARE,
} from '@shared/archetypes';
import { BOSS_CHARGE_COOLDOWN_TICKS, type BossCharge, makeBossCharge } from '@shared/boss';
import { applyCardToLoadout, CARD, type Card, drawSpread } from '@shared/cards';
import { classOf, DEFAULT_CLASS_ID, type VerbKind } from '@shared/classes';
import {
  CONTACT_INTERVAL_TICKS,
  CONTACT_RADIUS,
  EXTRACT_MULTIPLIER_STEP,
  FLOWFIELD_CELL,
  FLOWFIELD_HZ,
  LEVEL_RESUME_TICKS,
  LEVEL_XP_BASE,
  MAP_SIZE,
  MAX_ENTITIES,
  MAX_PLAYERS,
  ORB_PICKUP_RADIUS,
  PLAYER_MAX_HP,
  PLAYER_SPEED,
  PORTAL_EVERY_WAVES,
  PROJECTILE_CAPACITY,
  SYNERGY_MAX,
  TICK_HZ,
  WIPE_GOLD_KEPT,
  XP_PER_ORB,
} from '@shared/constants';
import { type Decoy, substituteDecoys } from '@shared/decoys';
import { EnemyShots } from '@shared/enemy-shots';
import { FlowField } from '@shared/flowfield';
import { dropsCoin, entityIdOf, Horde, pushOutOfGuards } from '@shared/horde';
import { Loadout } from '@shared/loadout';
import { bossHp, extractGold, palierGold, palierHp } from '@shared/paliers';
import { PlayerHistory } from '@shared/player-history';
import { Projectiles } from '@shared/projectiles';
import {
  encodeSnapshot,
  OUTCOME,
  type PlayerSnapshot,
  packZoneKind,
  VOTE_CHOICE,
} from '@shared/protocol';
import { makeRandom } from '@shared/random';
import { BONUS_ZERO, type BonusKind } from '@shared/shop';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { BASE_WEAPON_ID, cooldownWithBonus, salvoCount, WEAPONS, weaponOf } from '@shared/weapons';
import { applyObstacles, generateObstacles, moveOnMap } from '@shared/worldmap';
import { ZoneField } from '@shared/zones';

import {
  applyReactions,
  type Blast,
  type ContactPlayer,
  markInZones,
  OrbField,
  Reactions,
  resolveBlasts,
  resolveBurn,
  resolveChargeHit,
  resolveContact,
  resolveProjectileDamage,
  resolveVerglasCollisions,
} from './combat';
import { Draft } from './draft';
import { Portal } from './portal';
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

/**
 * Ce qu'un compte apporte a la run de son joueur : ses bonus permanents
 * achetes. Construit par `server.ts` depuis les achats lus en base, consomme
 * par `Room#join`.
 *
 * ⚠️ Vit ici et pas dans `shared/` : ce sont des donnees de compte, que le
 * client n'importe jamais.
 */
export interface AccountGrants {
  bonuses: Readonly<Record<BonusKind, number>>;
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
  /**
   * Bonus permanents achetes par le COMPTE de ce joueur, par cle. Distincts des
   * bonus de cartes : ils ne consomment aucun slot de passif et survivent a la
   * run.
   */
  readonly accountBonuses: Readonly<Record<BonusKind, number>>;
  /** La classe choisie au salon. Posee une fois a `join`, jamais mutee ensuite. */
  readonly classId: number;
  /** Tick du dernier verbe ACCEPTE. `-Infinity` : jamais utilise. */
  lastAbilityTick: number;
  /**
   * Vrai si ce joueur tire l'arme neutre. **Une seule arme au depart** :
   * l'arme choisie en salle d'attente REMPLACE la dague, elle ne s'y ajoute
   * pas ; seul un joueur sans arme de depart (ou arrive en cours de partie)
   * garde la dague. Pose a `join`, jamais modifie ensuite.
   */
  readonly keepsBase: boolean;
  /**
   * L'armure EFFECTIVE de ce tick, celle que `resolveContact` lit : le maximum
   * de l'armure du compte et de toute protection de Rempart qui couvre le
   * joueur. Recalculee par `Room#step` juste avant les degats — voir `armorOf`.
   */
  armor: number;
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
 * Une zone posee, telle que `ZONE` la transporte (§5.3 / §8) — kind, x, y,
 * tick de naissance, joueur.
 *
 * ⚠️ **Pas de rayon, et pas de mort.** Toutes les zones portent `ZONE_RADIUS`,
 * une constante que les deux cotes lisent deja ; leur peremption se derive du
 * seul `bornTick`, comme celle des orbes. Voir `ZoneMessage`.
 *
 * ⚠️ **`kind` est l'octet empaquete par `packZoneKind`** (tache 5 de l'etape
 * 5b), pas un element seul : voir `ZoneField.kind` et `ZoneMessage`.
 */
export interface ZoneEvent {
  kind: number;
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

/**
 * Un verdict de portail a diffuser, tel que `PORTAL_RESULT` le transporte.
 *
 * ⚠️ **`effectTick`, pas `deadlineTick`.** Le vote se ferme des que tout le
 * monde a vote, donc n'importe quand entre l'ouverture et l'echeance : le
 * client ne peut pas le deduire, et c'est la lecon R3 de l'etape 4, payee
 * d'une tache. Voir `PortalResultMessage`.
 *
 * ⚠️ **`gold` est l'or ACQUIS si l'equipe part, l'or REPORTE si elle reste** —
 * un seul champ, dont le sens se lit dans `decision`.
 */
export interface PortalResultEvent {
  effectTick: number;
  decision: number;
  gold: number;
}

/**
 * Une ouverture de portail a diffuser, telle que `PORTAL_OPEN` la transporte.
 *
 * ⚠️ **Le multiplicateur voyage DANS l'evenement, pas lu au moment de la
 * diffusion.** `#extractMultiplier` change dans `#stepPortal`, donc au meme
 * tick qu'un verdict : le lire depuis `Room` au moment d'encoder marcherait
 * aujourd'hui par chance d'ordonnancement, et cesserait de marcher le jour ou
 * deux salons ou deux paliers se chevauchent. L'evenement porte la valeur qui
 * etait vraie A L'OUVERTURE — la meme discipline que `DraftOpenEvent`, qui
 * porte ses cartes plutot que de laisser l'encodeur relire l'etalage courant.
 */
export interface PortalOpenEvent {
  deadlineTick: number;
  /** Le multiplicateur qui s'applique si l'equipe part maintenant. Voir `#extractMultiplier`. */
  multiplier: number;
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
  /** Les tirs des tireurs — derives de la horde, identiques au client (`EnemyShots`). */
  readonly shots = new EnemyShots();
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
  /**
   * Les verbes acceptes depuis le dernier drainage (tache 3 de l'etape 8) —
   * meme patron que `#pendingZones` juste au-dessus : `useAbility` y pousse
   * l'annonce EN PLUS de la rendre a l'appelant (ses tests directs en ont
   * besoin), et c'est ce tableau, pas le retour de `useAbility`, que
   * `#broadcast` diffuse. Ronde de correction 1 : l'envoi immediat depuis le
   * gestionnaire de `MSG.ABILITY` cassait l'ordre garanti face a `DEATHS` —
   * voir le docbloc de `useAbility`.
   */
  #pendingAbilities: AbilityUsed[] = [];
  /** Les leurres plantes, purges a chaque nouvelle pose ; `substituteDecoys` ignore les expires. */
  #decoys: Decoy[] = [];
  /** Les zones de Rempart posees, purgees a chaque nouvelle pose ; `armorOf` ignore les expirees. */
  #remparts: { x: number; y: number; bornTick: number; by: number }[] = [];
  /**
   * La charge du boss en cours, ou `null` — **la seule qui existe a la fois**,
   * puisqu'il n'y a qu'un boss vivant (§1.1 de la spec).
   *
   * ⚠️ **Gardee APRES sa fin, jamais remise a `null` par le temps.** Une charge
   * finie est inerte (`chargeHoldsAt` rend faux), exactement comme une zone
   * perimee laissee dans sa reserve : c'est le predicat qui decide, pas la
   * presence. La garder est ce qui laisse `#nextChargeTick` se lire d'un seul
   * champ, et ce qui evite un `null` de plus a distinguer d'un « jamais
   * charge ».
   */
  #charge: BossCharge | null = null;
  /**
   * Identites des joueurs deja touches par la charge en cours — la borne
   * « une seule fois par charge » de `resolveChargeHit`. Vide a chaque nouvelle
   * annonce, jamais entre deux ticks d'une meme traversee.
   */
  #chargeHit = new Set<number>();
  /** Premier tick auquel une nouvelle charge peut s'annoncer. Voir `#stepBossCharge`. */
  #nextChargeTick = 0;
  #pendingCharges: BossCharge[] = [];
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
  /**
   * Le vote d'extraction en cours. `phase === 'closed'` : aucun portail ouvert.
   *
   * ⚠️ **Il n'est PAS le pendant de `#draft` dans `step`, et c'est toute la
   * tache.** Un etalage ouvert fait revenir `step` immediatement : le monde
   * est gele. Un portail ouvert ne fait revenir personne — la horde avance,
   * les vagues tombent, le palier suivant approche. Le §6 de la spec en fait
   * la difference structurante : *« le draft gele parce qu'un choix de carte
   * n'a pas d'enjeu temporel ; le vote ne gele pas parce que le temps EST son
   * enjeu »*.
   */
  readonly #portal = new Portal();
  /** Ouvertures de portail depuis le dernier drainage. Voir `PortalOpenEvent`. */
  #pendingPortalOpens: PortalOpenEvent[] = [];
  #pendingPortalResults: PortalResultEvent[] = [];
  /**
   * Le multiplicateur d'extraction : ce par quoi l'or non securise sera
   * majore le jour ou l'equipe partira (§5).
   *
   * ⚠️ **Il part de 1, donc la premiere extraction n'ajoute rien** — elle
   * ACQUIERT, ce qui est deja tout ce que le vote engage. Un depart au premier
   * portail ne doit pas etre puni : ce que « rester » achete, c'est la majoration
   * des paliers SUIVANTS, contre le risque de tout perdre.
   *
   * ⚠️ **Il ne redescend jamais, et rien ne le remet a zero** — il n'y a rien
   * apres l'extraction : la run se termine. La persistance de l'or entre les
   * runs est l'etape 7 (§1.3).
   */
  #extractMultiplier = 1;
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
   * L'or NON SECURISE de l'equipe (§5 de la spec de l'etape 6a) : il se gagne
   * a la mort de chaque boss, et il n'est **acquis** qu'a l'extraction.
   *
   * ⚠️ **UN SEUL NOMBRE, pour tout le salon** — comme `#xp` et `#synergy`, et
   * pour la meme raison, deja payee une fois : l'etape 3 avait donne a
   * l'experience une valeur par joueur **et** une valeur d'equipe, soit deux
   * sources de verite pour un seul nombre, et l'implementeur l'avait signale.
   * L'or est encore moins divisible que l'experience : ce qui se decide au
   * vote, c'est ce que l'EQUIPE risque, pas ce que chacun risque.
   *
   * ⚠️ **Il ne sort d'ici que par l'en-tete du `SNAPSHOT`** (tache 7), jamais
   * par le bloc d'un joueur.
   *
   * ⚠️ **Ce qui le fait bouger tient en deux lignes dans tout ce fichier** :
   * l'ajout du bonus de palier dans `step` quand le boss tombe, et la perte
   * dans `#checkRunOver` quand l'equipe est effacee. Le MULTIPLICATEUR
   * d'extraction n'est pas ici — il appartient au portail (tache 9) — et la
   * mort d'un seul joueur ne le touche pas du tout, le §5 de la spec est
   * explicite : *« Mort d'un seul joueur : rien »*.
   */
  #gold = 0;

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
  /**
   * Les boss VIVANTS, du plus ancien au plus recent. Plusieurs a la fois
   * depuis le retour de playtest. Le plus ancien porte la barre de vie
   * (`SNAPSHOT`) et la charge.
   */
  #bosses: number[] = [];
  /** Explosions de kamikazes tues au tick precedent, a resoudre au suivant. */
  #pendingBlasts: Blast[] = [];
  /** L'or que chaque voleur en fuite emporte, par identite : rendu a sa mort. */
  readonly #loot = new Map<number, number>();
  /** Positions d'avant degats des diviseurs et des morts a portee d'un necromancien. */
  #splitters = new Map<number, Blast>();
  #corpses = new Map<number, Blast>();
  #necroReadyTick = 0;
  /** Vagues tombees depuis la derniere ouverture du portail. */
  #wavesSincePortal = 0;

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
   * Les verbes acceptes a diffuser (tache 3 de l'etape 8), un par `ABILITY_USED`
   * — meme forme que `drainZones` juste au-dessus.
   *
   * ⚠️ **Au meme tick que `DEATHS`, et dans le MEME drain** (ronde de
   * correction 1). Un envoi immediat depuis le gestionnaire de `MSG.ABILITY`
   * laisserait `ABILITY_USED` quitter le serveur hors du cycle ou `DEATHS`,
   * `ZONE` et les autres evenements du tick partent ensemble, dans un ordre
   * garanti : la tache 7 (Relais) derive sa cible du meme tick que celui ou
   * l'allie peut mourir, et un client qui recevrait l'annonce avant ou apres
   * `DEATHS` selon le hasard du reseau deriverait vers un allie vivant ou
   * mort selon l'ordre de reception — exactement la divergence que ce depot
   * refuse depuis l'etape 2. Vider cette file depuis `#broadcast`, avec le
   * reste, est ce qui la rend impossible : les deux evenements partent dans
   * le MEME paquet logique de diffusion, au meme tick.
   */
  drainAbilities(): AbilityUsed[] {
    const out = this.#pendingAbilities;
    this.#pendingAbilities = [];
    return out;
  }

  /**
   * Les charges de boss annoncees depuis le dernier drainage — **au plus une
   * par charge, et rien ensuite** (§4 de la spec).
   *
   * La progression ne se diffuse jamais : les deux cotes la DERIVENT des ticks
   * que ce seul message porte. C'est ce qui rend le premier effet de l'etape
   * qui touche le DEPLACEMENT aussi peu couteux que les zones — zero octet
   * apres l'annonce.
   */
  drainBossCharges(): BossCharge[] {
    const out = this.#pendingCharges;
    this.#pendingCharges = [];
    return out;
  }

  /**
   * La charge en cours, ou `null` — lecture seule, pour les tests et les bancs.
   * Le fil, lui, ne la voit qu'une fois, par `drainBossCharges`.
   */
  get bossCharge(): BossCharge | null {
    return this.#charge;
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

  /**
   * Les portails ouverts depuis le dernier drainage — un par boss vaincu, avec
   * l'echeance de sa fenetre et le multiplicateur qui s'y applique.
   */
  drainPortalOpens(): PortalOpenEvent[] {
    const out = this.#pendingPortalOpens;
    this.#pendingPortalOpens = [];
    return out;
  }

  /** Les verdicts rendus depuis le dernier drainage. */
  drainPortalResults(): PortalResultEvent[] {
    const out = this.#pendingPortalResults;
    this.#pendingPortalResults = [];
    return out;
  }

  /**
   * Qui a vote quoi, silencieux compris. Vide hors vote.
   *
   * ⚠️ **Les silencieux en font partie, a la difference des jetons du draft.**
   * Le §6 veut qu'on voie *qui n'a pas encore tranche* : c'est la matiere de la
   * negociation. Voir `Portal#votes`.
   */
  portalVotes(): ReadonlyMap<number, number> {
    return this.#portal.votes();
  }

  /**
   * Enregistre le vote d'un joueur, ou le retire (`NO_VOTE`). Rend `false` si
   * le geste est refuse.
   *
   * ⚠️ **Aucun garde sur les points de vie ICI, et c'est la regle, pas un
   * oubli** : tout joueur connecte vote, **mort ou vif** (§6). Le §9.3 dit que
   * la mort d'un seul ne coute rien — elle ne coute donc pas la voix non plus.
   */
  setVote(playerId: number, choice: number): boolean {
    return this.#portal.setVote(playerId, choice);
  }

  /** L'echeance du portail en cours. Voir `drainPortalOpens` pour la diffusion. */
  get portalDeadlineTick(): number {
    return this.#portal.deadlineTick;
  }

  /** Vrai tant que le vote d'extraction est ouvert. Le monde tourne quand meme. */
  get portalOpen(): boolean {
    return this.#portal.phase === 'open';
  }

  /**
   * Le multiplicateur d'extraction courant (1 au depart). Voir
   * `#extractMultiplier`.
   */
  get extractMultiplier(): number {
    return this.#extractMultiplier;
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
   * Orbes qu'une mort n'a pas pu poser faute de place, depuis le debut de la
   * run. Voir `OrbField.truncatedOrbs`.
   *
   * ⚠️ **C'est le compteur que la tache 15 rendait INDISPENSABLE.** Tant que
   * les orbes s'evaporaient au bout de 20 s, la reserve se vidait toute seule
   * et sa capacite ne servait jamais ; l'expiration retiree, la capacite est
   * devenue la SEULE borne — et elle est silencieuse. Sans ce lecteur,
   * l'experience refusee au sol disparaitrait sans trace. Meme motif que
   * `zonesTronquees` et `projectilesTronques` juste au-dessus.
   */
  get orbesTronquees(): number {
    return this.#orbs.truncatedOrbs;
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

  /** Le maximum de points de vie de ce joueur, bonus de cartes et de compte compris. */
  /** Bonus « Fortune » du compte de ce joueur, 0 s'il est absent. */
  goldBonusOf(playerId: number): number {
    return this.#players.get(playerId)?.accountBonuses.gold ?? 0;
  }

  maxHpOf(playerId: number): number {
    return this.#players.get(playerId)?.maxHp ?? 0;
  }

  /** PV courants d'un joueur, `0` s'il est absent. Lecture etroite, comme `maxHpOf`. */
  hpOf(playerId: number): number {
    return this.#players.get(playerId)?.hp ?? 0;
  }

  /**
   * L'armure effective d'un joueur : le MAXIMUM de celle de son compte et de
   * toute protection de Rempart qui le couvre.
   *
   * ⚠️ **Un MAXIMUM, jamais une somme ni un produit** — la meme regle que
   * `ZoneField` applique deja entre deux zones, et pour la raison que son
   * docbloc donne : deux flaques qui se recouvrent « ne doublent pas : elles
   * donnent la plus forte ». Une somme ferait de « cinq paliers d'Armure
   * achetes, plus un Rempart » une quasi-immunite (§6.2 de la spec).
   */
  armorOf(playerId: number): number {
    const p = this.#players.get(playerId);
    if (!p) {
      return 0;
    }
    return Math.max(p.accountBonuses.armor, this.#rempartCouvre(p) ? REMPART_ARMOR : 0);
  }

  /**
   * Un joueur est couvert s'il se tient dans une zone de Rempart vivante, OU
   * (trait `remparteAllie`) s'il est adjacent a un joueur de classe Rempart
   * dont une zone est vivante — la protection suit alors le Rempart lui-meme.
   */
  #rempartCouvre(p: PlayerState): boolean {
    for (const z of this.#remparts) {
      if (this.#tick - z.bornTick >= REMPART_LIFETIME_TICKS) {
        continue;
      }
      if (Math.hypot(p.x - z.x, p.y - z.y) <= ABILITY_ZONE_RADIUS) {
        return true;
      }
      const poseur = this.#players.get(z.by);
      if (
        poseur &&
        poseur.id !== p.id &&
        classOf(poseur.classId)?.trait === 'remparteAllie' &&
        Math.hypot(p.x - poseur.x, p.y - poseur.y) <= ADJACENT_RANGE
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * ⚠️ **Ecritures de TEST, aucun chemin de production ne les appelle** — meme
   * statut que `debugSetGold`. Un test de verbe a besoin de poser un joueur a
   * une distance controlee d'une zone ou d'un allie ; le faire marcher au
   * clavier pendant des secondes de simulation rendrait chaque test lent et
   * fragile, sans rien eprouver de plus.
   */
  /**
   * Le Relais : le lanceur se teleporte sur l'allie VIVANT le plus proche du
   * point vise, a `RELAIS_RANGE` du lanceur au plus.
   *
   * ⚠️ **Rend `null` sur tout refus** — pas d'allie, allie mort ou hors de
   * portee, soi-meme — et c'est ce qui laisse la recharge intacte : `useAbility`
   * ne la pose qu'apres une annonce. Un joueur ne doit pas etre puni d'un verbe
   * qu'il n'a pas eu (tache 7 du plan).
   *
   * ⚠️ **L'intangibilite du trait `relaisIntangible` est `contactInvulnTicks`**,
   * le compteur que le contact et la charge du boss lisent deja : un second
   * compteur d'invulnerabilite divergerait du premier, et le jour ou ils
   * divergent c'est un test qui manque.
   */
  #relais(p: PlayerState, aimX: number, aimY: number): AbilityUsed | null {
    let cible: PlayerState | null = null;
    let meilleure = Number.POSITIVE_INFINITY;
    for (const autre of this.#players.values()) {
      if (autre.id === p.id || autre.hp <= 0) {
        continue;
      }
      if (Math.hypot(autre.x - p.x, autre.y - p.y) > RELAIS_RANGE) {
        continue;
      }
      const d = Math.hypot(autre.x - aimX, autre.y - aimY);
      if (d < meilleure) {
        meilleure = d;
        cible = autre;
      }
    }
    if (!cible) {
      return null;
    }
    p.x = cible.x;
    p.y = cible.y;
    if (classOf(p.classId)?.trait === 'relaisIntangible') {
      cible.contactInvulnTicks = Math.max(cible.contactInvulnTicks, RELAIS_INTANGIBLE_TICKS);
    }
    // L'annonce porte la DESTINATION : le client recale sa prediction dessus.
    return {
      tick: this.#tick,
      playerId: p.id,
      verb: VERB_IDS.relais,
      x: Math.round(cible.x),
      y: Math.round(cible.y),
      targetId: cible.id,
    };
  }

  /** Position courante d'un joueur ; `null` s'il est absent. Lecture etroite. */
  positionOf(playerId: number): { x: number; y: number } | null {
    const p = this.#players.get(playerId);
    return p ? { x: p.x, y: p.y } : null;
  }

  /** Ticks d'intangibilite restants d'un joueur (contact et charge), `0` s'il est absent. */
  intangibleTicksOf(playerId: number): number {
    return this.#players.get(playerId)?.contactInvulnTicks ?? 0;
  }

  #refreshArmor(): void {
    for (const p of this.#players.values()) {
      p.armor = this.armorOf(p.id);
    }
  }

  debugPlace(playerId: number, x: number, y: number): void {
    const p = this.#players.get(playerId);
    if (p) {
      p.x = x;
      p.y = y;
    }
  }

  debugKill(playerId: number): void {
    const p = this.#players.get(playerId);
    if (p) {
      p.hp = 0;
    }
  }

  debugRevive(playerId: number): void {
    const p = this.#players.get(playerId);
    if (p) {
      p.hp = p.maxHp;
    }
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
    return this.#bosses[0] ?? null;
  }

  /**
   * L'or non securise de l'equipe. Un seul nombre pour tout le salon — voir
   * `#gold`.
   */
  get gold(): number {
    return this.#gold;
  }

  /**
   * Pose la cagnotte, pour les tests du credit UNIQUEMENT.
   *
   * ⚠️ **Nomme `debug` pour que personne ne s'en serve en production.** La
   * facon de GAGNER de l'or est couverte par l'etape 6a ; ce qui se teste ici
   * est le transfert vers le compte, et faire jouer vingt minutes pour poser
   * une cagnotte rendrait le test inutilisable.
   *
   * ⚠️ **Leve sur un non-entier, plutot que de le tronquer.** Chaque chemin de
   * PRODUCTION qui ecrit `#gold` rend deja un entier (`palierGold`,
   * `extractGold` et le wipe arrondissent tous). Cette methode est la SEULE
   * ecriture qui pourrait y introduire un flottant, et `Session#creditAccounts`
   * fait `BigInt(this.room.gold)` AVANT son `try` -- un flottant y leverait un
   * `RangeError` qui, derriere le `void` de l'appel fire-and-forget,
   * deviendrait une exception non rattrapee et tuerait le process. Tronquer en
   * silence masquerait un bug de test au lieu de le signaler a l'endroit qui
   * l'a introduit.
   */
  debugSetGold(gold: number): void {
    if (!Number.isInteger(gold)) {
      throw new Error(`debugSetGold : ${gold} n'est pas un entier`);
    }
    this.#gold = gold;
  }

  /** Ecriture de test, meme statut que `debugSetGold` : le niveau de l'equipe. */
  debugSetLevel(level: number): void {
    this.#level = level;
  }

  get metrics(): Readonly<RoomMetrics> {
    return this.#metrics;
  }

  /**
   * Rend false si le salon est plein.
   *
   * ⚠️ `compte` est optionnel, et ce n'est PAS le piege « un chemin qui
   * n'existe que pour les tests ». Un joueur sans aucun achat a legitimement
   * des bonus tous nuls et un ensemble de deblocages vide : le defaut EST un
   * etat de production valide, pas un contournement. Il evite seulement
   * d'editer les dizaines d'appels existants de `join` qui ne s'interessent
   * pas aux comptes.
   */
  join(
    id: number,
    compte?: AccountGrants,
    startWeapon?: number,
    classId: number = DEFAULT_CLASS_ID,
  ): boolean {
    if (this.#players.has(id)) {
      return true;
    }
    if (this.#players.size >= MAX_PLAYERS) {
      return false;
    }
    // L'arme de depart de la salle d'attente, deja validee par `Session`
    // (`startingWeapons`). Elle entre dans le `Loadout` comme une carte draftee.
    const loadout = new Loadout();
    if (startWeapon !== undefined) {
      loadout.addWeapon(startWeapon);
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
      accountBonuses: compte?.bonuses ?? BONUS_ZERO,
      armor: compte?.bonuses.armor ?? 0,
      hp: PLAYER_MAX_HP + (compte?.bonuses.maxHp ?? 0),
      maxHp: PLAYER_MAX_HP + (compte?.bonuses.maxHp ?? 0),
      contactInvulnTicks: 0,
      lastFireTick: new Float64Array(WEAPONS.length).fill(Number.NEGATIVE_INFINITY),
      loadout,
      classId,
      lastAbilityTick: Number.NEGATIVE_INFINITY,
      keepsBase: startWeapon === undefined,
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
   * Arbitre une demande de verbe. Rend l'annonce a diffuser, ou `null`.
   *
   * ⚠️ **Le refus est SILENCIEUX** — meme discipline que `setDraftToken` et
   * `setVote` : un geste refuse n'est simplement pas enregistre, et le client le
   * verra a la prochaine diffusion. Aucun client ne decide de quoi que ce soit.
   *
   * ⚠️ **L'annonce est a la fois RENDUE et MISE EN FILE** (ronde de correction
   * 1) : rendue, parce que les tests directs de cette methode et le refus en
   * ont besoin ; mise en file dans `#pendingAbilities`, parce que c'est cette
   * file — drainee par `#broadcast`, voir `drainAbilities` — qui part
   * reellement sur le fil, au MEME tick et dans le MEME paquet que `DEATHS`.
   * Un appelant qui enverrait aussi le retour de cette methode doublerait
   * l'annonce.
   *
   * ⚠️ **La recharge se pose APRES `#applyAbility`, jamais avant** (amendement
   * du controleur, tache 3 de l'etape 8). La tache 7 (Relais) exige qu'un refus
   * ne consomme PAS la recharge : un Relais demande sans allie valide a portee
   * doit rester gratuit. Avec l'ordre inverse, le joueur serait puni d'un verbe
   * qu'il n'a jamais eu — dix secondes d'attente pour rien, et ca se lirait
   * comme un bug.
   *
   * ⚠️ **La contrepartie est load-bearing.** Chaque branche de `#applyAbility`
   * DOIT rendre explicitement `null` quand elle refuse : une branche qui
   * echouerait en silence tout en rendant une annonce donnerait un verbe
   * gratuit — exactement le defaut inverse de celui que cet ordre corrige. A
   * cette tache, aucune branche ne refuse encore (voir le rapport de la tache
   * pour la mesure de cette mutation) ; les taches 4 a 7 y branchent chacune un
   * effet, et donc un chemin de refus, sous ce meme contrat.
   */
  useAbility(playerId: number, aimX: number, aimY: number): AbilityUsed | null {
    const p = this.#players.get(playerId);
    if (!p || p.hp <= 0) {
      return null;
    }
    const classe = classOf(p.classId);
    if (!classe) {
      return null;
    }
    const recharge = ABILITY_COOLDOWN_TICKS[classe.verb];
    if (this.#tick - p.lastAbilityTick < recharge) {
      return null;
    }
    const annonce = this.#applyAbility(p, classe.verb, aimX, aimY);
    if (!annonce) {
      return null;
    }
    p.lastAbilityTick = this.#tick;
    this.#pendingAbilities.push(annonce);
    return annonce;
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
   * 8. arbitrer le contact avec les joueurs, **puis rendre aux survivants les
   *    points de vie de leurs cartes « regain » (tache 17)** — dans cet ordre,
   *    pour qu'un joueur acheve par le contact de ce tick-ci ne se releve pas
   *    dans le meme tick
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
      const speed = PLAYER_SPEED + p.loadout.bonus('speed') + p.accountBonuses.speed;
      // Le decor bloque les joueurs comme la horde : meme masque que le champ
      // de flux (`#fields[0]`), meme regle que la prediction (`moveOnMap`).
      const sol = this.#fields[0];
      const pos = sol
        ? moveOnMap(
            p.x,
            p.y,
            p.moveX * speed * scaledDt,
            p.moveY * speed * scaledDt,
            sol.blocked,
            sol.cols,
            sol.rows,
            sol.cellSize,
            MAP_SIZE,
          )
        : {
            x: clamp(p.x + p.moveX * speed * scaledDt, 0, MAP_SIZE),
            y: clamp(p.y + p.moveY * speed * scaledDt, 0, MAP_SIZE),
          };
      // Les gardiens font mur : le joueur ne les traverse pas. Meme poussee
      // que la prediction du client (`pushOutOfGuards`), et le decor bloque
      // aussi la poussee.
      const pousse = pushOutOfGuards(pos.x, pos.y, this.horde, CONTACT_RADIUS / 2);
      const fin =
        sol && (pousse.dx !== 0 || pousse.dy !== 0)
          ? moveOnMap(
              pos.x,
              pos.y,
              pousse.dx,
              pousse.dy,
              sol.blocked,
              sol.cols,
              sol.rows,
              sol.cellSize,
              MAP_SIZE,
            )
          : { x: clamp(pos.x + pousse.dx, 0, MAP_SIZE), y: clamp(pos.y + pousse.dy, 0, MAP_SIZE) };
      p.x = fin.x;
      p.y = fin.y;
    }

    // Arrondies, comme sur le fil (constat C1.4) : le client ne connaitra
    // jamais que la version quantifiee en int16 du protocole (`encodeSnapshot`
    // arrondit deja). Si le serveur alimentait son propre flowfield avec des
    // positions flottantes, les deux cotes enracineraient leur BFS dans des
    // cellules differentes une fois par cellule et par axe — le serveur doit
    // s'imposer l'arrondi comme il s'impose deja le retard.
    const ids: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    for (const p of this.#players.values()) {
      ids.push(p.id);
      xs.push(Math.round(p.x));
      ys.push(Math.round(p.y));
    }
    // Les identifiants voyagent avec les positions : un leurre retrouve son
    // lanceur par son id, jamais par un rang qui bouge (`shared/decoys.ts`).
    this.#history.record(this.#tick, xs, ys, ids);

    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    if (this.#tick % stepsPerField === 0) {
      // ⚠️ Les positions **retardees**, pas les courantes. Le serveur s'impose
      // le retard qu'il inflige au client : c'est ce qui rend les deux champs
      // identiques (§5 de la spec de l'etape 2).
      const seen = this.#history.delayed(this.#tick);
      if (seen) {
        this.#fieldInputTick = seen.tick;
        // ⚠️ Les leurres remplacent leur lanceur, au tick des POSITIONS
        // (`seen.tick`), jamais au tick courant : c'est lui que le client
        // partage. Meme fonction que les sites du miroir client.
        const cible = substituteDecoys(seen.ids, seen.x, seen.y, this.#decoys, seen.tick);
        for (let f = 0; f < cible.x.length && f < this.#fields.length; f++) {
          this.#fields[f]?.update(cible.x[f] ?? 0, cible.y[f] ?? 0);
        }
        this.horde.retarget(cible.x, cible.y);
      }
    }

    // Une vague est un GROUPE d'ordres (principal, escorte) : chacun nait comme
    // avant, dans l'ordre, et la vague ne compte qu'UNE fois pour le portail.
    const vague = this.#director.dueWave(this.#tick, xs, ys, this.#level);
    for (const order of vague) {
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
      if (estBoss) {
        if (this.horde.count > before) {
          const premier = this.#bosses.length === 0;
          this.#bosses.push(entityIdOf(order.waveId, 0));
          // ⚠️ **Le boss ne passe PAS par `#scalePalierHp`, et une seule ligne
          // ecrit sa reserve.** `bossHp` contient deja `palierHp` (voir
          // `shared/paliers.ts`) : lui laisser d'abord ecrire l'echelle du
          // palier puis la recouvrir ici ferait deux ecritures dont la
          // premiere serait morte — et une mutation de la boucle ne rougirait
          // plus pour le boss. Le creneau est `before` : la vague de boss vaut
          // `count: 1`, donc l'entite d'indice 0 est la seule, celle-la meme
          // que `entityIdOf(order.waveId, 0)` designe juste au-dessus.
          //
          // ⚠️ **`#players.size` est lu ICI, une fois, et n'est plus jamais
          // relu : les PV du boss sont FIGES A SON APPARITION.** Le nombre de
          // joueurs bouge pendant un palier — quelqu'un se deconnecte,
          // quelqu'un rejoint — et suivre ce nombre ferait regagner de la vie
          // a un boss deja entame parce qu'un joueur arrive : ca se lirait
          // comme un bug, et la barre de vie de la tache 5 le montrerait a
          // l'ecran. Ce que ca coute, dit en face : trois joueurs qui quittent
          // laissent au dernier un boss de quatre joueurs jusqu'a sa mort.
          this.horde.hp[before] = bossHp(this.#director.palier, this.#players.size);
          // ⚠️ **Il n'arrive pas en chargeant.** Le boss apparait au bord de la
          // carte, loin de tout le monde : une charge annoncee au tick de son
          // apparition traverserait un couloir vide, et son unique fenetre de
          // reaction serait dilapidee hors de portee. Le premier delai est le
          // meme que celui qui separe deux charges — un seul nombre a regler.
          // Un boss de plus ne remet pas a zero la charge d'un boss deja la.
          if (premier) {
            this.#charge = null;
            this.#chargeHit.clear();
            this.#nextChargeTick = this.#tick + BOSS_CHARGE_COOLDOWN_TICKS;
          }
        } else {
          // La horde etait pleine : le boss n'existe pas. Sans ce chemin, le
          // verrou du directeur ne se relacherait jamais et le palier serait
          // fige pour le reste de la run.
          this.#director.bossMissing();
        }
      } else {
        this.#scalePalierHp(before);
      }
      this.#pendingOrders.push(order);
    }
    // ⚠️ **Le portail s'ouvre toutes les `PORTAL_EVERY_WAVES` vagues**, plus
    // a la mort de chaque boss (retour de playtest : *« ne fait pas de fin a
    // chaque boss »*). Une vague = un groupe, quel que soit son nombre d'ordres.
    if (vague.length > 0) {
      this.#wavesSincePortal++;
      if (this.#wavesSincePortal >= PORTAL_EVERY_WAVES && !this.portalOpen) {
        this.#wavesSincePortal = 0;
        this.#openPortal();
      }
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
    // ⚠️ **La charge REMPLACE le deplacement du boss** (tache 5 bis) : `step`
    // l'applique en dernier, apres l'avancement par vitesse et la separation,
    // et c'est cet ordre qui fait que le boss n'avance pas deux fois. Voir
    // `Horde#applyCharge`.
    this.horde.step(scaledDt, this.#fields, this.#tick, this.#zones, this.#charge);
    this.shots.step(this.horde, this.#tick, scaledDt);

    // Les comportements du tick (retour de playtest : « des monstres uniques »).
    // L'aura des chamans protege leurs voisins de TOUTES les passes de degats
    // qui suivent ; les kamikazes sont releves AVANT les degats, pour savoir ou
    // exploser s'ils meurent en chemin.
    const kamikazes = this.#behaviorsBeforeDamage();

    this.#fireWeapons(this.#tick);
    const deadIds = resolveProjectileDamage(
      this.#projectiles,
      scaledDt,
      this.horde,
      this.#orbs,
      this.#tick,
      this.#zones,
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
    const burntIds = resolveBurn(this.horde, this.#orbs, this.#tick, this.#zones);
    // ⚠️ **Verglas (tache 8 de l'etape 5b) : « les ennemis derapent ET se
    // percutent ».** Le derapage lui-meme vit dans `Horde.step`, deja joue
    // plus haut ; la collision est un degat, resolue ICI comme la brulure,
    // au meme titre et pour la meme raison — voir `resolveVerglasCollisions`.
    const collidedIds = resolveVerglasCollisions(this.horde, this.#orbs, this.#tick, this.#zones);
    // Les kamikazes : ceux qui touchent leur cible se font sauter maintenant,
    // ceux que les passes precedentes ont tues exploseront au tick suivant
    // (leur position a ete relevee avant les degats), comme ceux que les
    // explosions de ce tick emportent — d'ou les reactions en chaine.
    const blastIds = this.#resolveKamikazes(kamikazes, [
      ...deadIds,
      ...reactedIds,
      ...burntIds,
      ...collidedIds,
    ]);
    // ⚠️ **UN SEUL lot de morts par tick, brulures, reactions ET collisions
    // comprises.** `GameClient` documente cette hypothese et s'appuie
    // dessus : deux lots vises au meme tick, rejoues l'un apres l'autre,
    // verraient le second effacer la correction du premier
    // (`#drainPendingDeaths`). Ni les brulures, ni les reactions, ni les
    // collisions de Verglas n'ont donc de chemin de mort a elles — elles
    // rejoignent celui de l'etape 3.
    //
    // Aucun doublon possible, et l'ORDRE est ce qui le garantit : chacune des
    // quatre passes tourne APRES la compaction de la precedente, donc les
    // identites deja listees n'existent plus dans la horde quand la suivante
    // la balaie.
    const allDead =
      reactedIds.length > 0 || burntIds.length > 0 || collidedIds.length > 0 || blastIds.length > 0
        ? [...deadIds, ...reactedIds, ...burntIds, ...collidedIds, ...blastIds]
        : deadIds;
    if (allDead.length > 0) {
      this.#totalKills += allDead.length;
      this.#pendingDeaths.push({ tick: this.#tick, ids: allDead });
      this.#afterDeaths(allDead);
      // ⚠️ **LE palier se termine ICI, et nulle part ailleurs.** Le salon sait
      // deja quand une entite meurt : ce lot est le SEUL du tick, brulures et
      // reactions comprises (voir le commentaire ci-dessus). Un second chemin
      // de mort pour le boss casserait le rejeu de l'etape 3 exactement comme
      // deux lots vises au meme tick le casseraient.
      //
      // ⚠️ **Et c'est une MORT, pas un tick.** Rien dans `step` ne date la fin
      // d'un palier : une equipe qui peine reste plus longtemps, une equipe qui
      // domine avance (§2 de la spec).
      // ⚠️ **Chaque boss abattu paie son palier et fait monter la difficulte**
      // — mais ne termine plus rien : le portail a son propre rythme
      // (`PORTAL_EVERY_WAVES`). Plusieurs boss peuvent mourir au meme tick.
      for (const bossId of this.#bosses.filter((id) => allDead.includes(id))) {
        this.#bosses = this.#bosses.filter((id) => id !== bossId);
        // ⚠️ **AVANT `bossDefeated()`, et l'ordre EST le sens.** Le bonus paye
        // le palier qu'on vient de FINIR, pas celui qu'on commence.
        this.#gold += palierGold(this.#director.palier);
        // La charge d'un boss mort est inerte ; l'oublier evite qu'elle
        // survive jusqu'a un boss dont l'identite pourrait exister a nouveau.
        if (this.#charge?.entityId === bossId) {
          this.#charge = null;
        }
        this.#director.bossDefeated();
      }
    }

    // Un boss retire de la horde hors du lot de morts (bancs, tests) ne doit pas
    // rester « vivant » ici : la barre et la charge suivraient un fantome.
    if (this.#bosses.some((id) => this.horde.slotOf(id) < 0)) {
      this.#bosses = this.#bosses.filter((id) => this.horde.slotOf(id) >= 0);
    }

    // ⚠️ **APRES le deplacement de la horde, AVANT le contact ordinaire.** Le
    // corps qui blesse est celui que `Horde.step` vient de poser sur le
    // couloir ce tick-ci ; et toucher avant `resolveContact` est ce qui laisse
    // l'invulnerabilite posee par la charge produire son effet des le tick
    // suivant plutot qu'un tick plus tard.
    // L'armure effective du tick (compte + Rempart), juste avant les DEUX
    // sources de degats : la charge du boss et le contact la lisent toutes deux
    // sur `player.armor`.
    this.#refreshArmor();
    this.#stepBossCharge();

    // Les tirs : meme armure effective, et meme fenetre d'invulnerabilite que
    // le contact — dix tireurs ne blessent pas plus vite qu'une meute au corps
    // a corps (`CONTACT_INTERVAL_TICKS`). Le tir est consomme dans tous les cas.
    const vivants = [...this.#players.values()].filter((p) => p.hp > 0);
    this.shots.hits(vivants, CONTACT_RADIUS / 2).forEach((n, k) => {
      const p = vivants[k];
      if (p && n > 0 && p.contactInvulnTicks === 0) {
        p.hp = Math.max(0, p.hp - SHOT_DAMAGE * (1 - (p.armor ?? 0)));
        p.contactInvulnTicks = CONTACT_INTERVAL_TICKS;
      }
    });
    resolveContact([...this.#players.values()], this.horde);
    this.#regenerate();

    const pickedIds = this.#orbs.resolvePickups(
      [...this.#players.values()].map((p) => ({
        x: p.x,
        y: p.y,
        pickupRadius: this.#pickupRadiusOf(p),
      })),
    );
    if (pickedIds.length > 0) {
      this.#pendingPickups.push({ tick: this.#tick, ids: pickedIds });
      // ⚠️ **La NATURE d'un ramassage se lit dans son IDENTITE** (etape 6a,
      // tache 14) : `dropsCoin` et `dropsOrb` sont disjoints, donc `PICKUPS`
      // n'a pas eu besoin d'un octet de plus pour dire ce qui a ete pris. Le
      // meme raisonnement que celui qui fait exister ces deux predicats.
      let pieces = 0;
      for (const id of pickedIds) {
        if (dropsCoin(id)) {
          pieces++;
        }
      }
      // ⚠️ **Une piece vaut UN or, et il n'y a pas de constante pour le dire.**
      // La rarete et la valeur decriraient la meme grandeur a deux endroits ;
      // le seul levier est `COIN_DROP_ONE_IN`, et sa doc porte le raisonnement.
      this.#gold += pieces;
      // Les orbes restantes, et elles seules : une piece ne vaut aucune
      // experience, sans quoi la rarefier reviendrait a ralentir les niveaux.
      const orbes = pickedIds.length - pieces;
      if (orbes > 0) {
        this.#gainXp(orbes * XP_PER_ORB);
      }
    }

    this.#checkRunOver();
    // ⚠️ **APRES `#checkRunOver`, et SANS garde de fin de run.** Les deux
    // chemins peuvent tomber sur le meme tick — l'equipe est effacee pendant
    // que le portail tranche — et cet ordre est ce qui les rend compatibles
    // sans une ligne de plus : l'effacement a deja ramene la cagnotte a
    // `WIPE_GOLD_KEPT`, donc un « partir » resolu juste apres majore zero et
    // annonce zero, ce que le snapshot du meme tick dit aussi. Un garde
    // `if (#runOver) return` serait exact, mais il couvrirait un chemin que
    // celui-ci rend deja inoffensif — enieme occurrence des deux gardes qui se
    // couvrent, soldee comme les autres par une absence de code.
    //
    // ⚠️ **Et ce n'est PAS un retour anticipe.** Rien au-dessus de cette ligne
    // ne consulte le portail : le monde a tourne tout entier pendant le vote.
    this.#stepPortal();
  }

  snapshot(out: Outbox): void {
    this.#scratch.length = 0;
    for (const p of this.#players.values()) {
      this.#scratch.push({
        id: p.id,
        x: p.x,
        y: p.y,
        hp: p.hp,
        aimX: p.aimX,
        aimY: p.aimY,
        pickupRadius: this.#pickupRadiusOf(p),
      });
    }

    // ⚠️ **La vie du boss est LUE DANS LA HORDE a chaque tick, jamais tenue en
    // double.** `#bosses` est la seule source de verite de « qui est le
    // boss » ; sa reserve, elle, vit ou vit celle de tout le monde. Un champ
    // `#bossHp` a cote se decalerait au premier degre soigne autrement — le
    // defaut que l'etape 3 a paye avec deux experiences pour un seul nombre.
    //
    // `slotOf` rend `-1` quand l'entite n'est plus la : le `?? 0` couvre le
    // seul cas ou cela arrive, un boss retire de la horde sans passer par le
    // lot de morts du salon (ce que les bancs font avec `Horde.kill`).
    const bossId = this.#bosses[0] ?? null;
    const boss =
      bossId === null ? null : { id: bossId, hp: this.horde.hp[this.horde.slotOf(bossId)] ?? 0 };

    const started = performance.now();
    // `#xp`, `#synergy` et `#gold` cote a cote, tous trois dans l'EN-TETE :
    // trois donnees d'equipe, trois nombres uniques, aucun bloc de joueur ne
    // les porte. Le boss les rejoint (tache 4) pour la meme raison, et pour
    // une de plus : il est UN, et c'est ce nombre qui autorise sa vie a
    // voyager (§1.1).
    //
    // ⚠️ **L'or part a CHAQUE tick, pas au vote.** C'est l'enjeu du portail
    // (§6) : un vote dont on ne voit pas l'enjeu n'est pas un vote, et il
    // bouge pendant la fenetre — le monde ne s'arrete pas.
    const buf = encodeSnapshot(
      this.#tick,
      this.#xp,
      this.#synergy,
      this.#scratch,
      boss,
      this.#gold,
    );
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
   * Construit l'annonce d'un verbe ACCEPTE — jamais son effet (tache 3 de
   * l'etape 8). Les taches 4 a 7 branchent chacune un effet ici, par verbe ;
   * cette tache ne livre que le socle, donc aucune branche ne refuse encore.
   *
   * ⚠️ **Toute branche future DOIT rendre `null` explicitement sur un refus**
   * (amendement du controleur) : `useAbility` ne pose la recharge qu'apres cet
   * appel, et seulement s'il rend une annonce. Un refus silencieux qui
   * laisserait passer une annonce quand meme donnerait un verbe gratuit.
   */
  #applyAbility(p: PlayerState, verb: VerbKind, aimX: number, aimY: number): AbilityUsed | null {
    if (verb === 'amorce') {
      this.#poseZoneAmorce(p, aimX, aimY);
    }
    if (verb === 'relais') {
      return this.#relais(p, aimX, aimY);
    }
    if (verb === 'appat') {
      // Arrondi comme les positions de joueurs (le serveur s'impose l'arrondi
      // du fil) : un leurre est une entree du MEME tableau.
      const x = Math.round(aimX);
      const y = Math.round(aimY);
      this.#decoys = this.#decoys.filter((d) => this.#tick - d.bornTick < DECOY_LIFETIME_TICKS);
      this.#decoys.push({ playerId: p.id, x, y, bornTick: this.#tick });
      // Trait `leurreElementaire` : le leurre porte l'element de l'arme, il
      // pose donc a sa naissance la meme zone qu'une Amorce.
      if (classOf(p.classId)?.trait === 'leurreElementaire') {
        this.#poseZoneAmorce(p, x, y);
      }
    }
    if (verb === 'rempart') {
      // Un champ PROPRE, jamais un `ZoneField` elementaire : une zone de
      // Rempart ne marque aucun element et ne participe a aucune reaction.
      this.#remparts = this.#remparts.filter(
        (z) => this.#tick - z.bornTick < REMPART_LIFETIME_TICKS,
      );
      this.#remparts.push({ x: aimX, y: aimY, bornTick: this.#tick, by: p.id });
    }
    return {
      tick: this.#tick,
      playerId: p.id,
      verb: VERB_IDS[verb],
      x: aimX,
      y: aimY,
      targetId: 0,
    };
  }

  /**
   * L'arme dont Amorce emprunte son element : la PREMIERE du loadout, celle que
   * le joueur a choisie au salon. A defaut, l'arme neutre.
   *
   * ⚠️ **Une classe ne porte jamais d'element** (§3 de la spec de l'etape 8) :
   * Amorce emprunte celui de l'ARME, et c'est ce qui la laisse compatible avec
   * l'exclusivite des armes. Le repli sur l'arme neutre garde le verbe utilisable
   * plutot que de le faire refuser sur un loadout vide — le salon autorise
   * explicitement `NO_WEAPON`, donc ce cas existe.
   */
  #armeAmorce(p: PlayerState): number {
    return p.loadout.weaponIds[0] ?? BASE_WEAPON_ID;
  }

  /**
   * Pose la zone d'Amorce : l'element de l'arme du joueur, a REACTION NULLE,
   * donc sans degats — elle marque, elle ne brule pas.
   *
   * ⚠️ **L'annonce est poussee ICI, et pas laissee a `#announceZones()`.**
   * Celle-la ne pousse que les zones dont `bornTick === this.#tick`, et elle
   * tourne DANS `step()`, apres `tick++`. Or `useAbility` est appelee ENTRE deux
   * pas, depuis le gestionnaire de message : une zone posee ici porterait un
   * `bornTick` deja perime au pas suivant, et ne serait donc **JAMAIS**
   * annoncee. Le serveur l'aurait, le client non — et aucun test du serveur seul
   * ne verrait cette divergence.
   */
  #poseZoneAmorce(p: PlayerState, x: number, y: number): void {
    const kind = packZoneKind(weaponOf(this.#armeAmorce(p)).element, 0);
    this.#zones.spawn(kind, x, y, p.id, this.#tick);
    this.#pendingZones.push({ kind, x, y, bornTick: this.#tick, by: p.id });
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
   * ⚠️ **LE BOSS NE PASSE PAS PAR ICI** (tache 3 bis). Sa reserve depend aussi
   * du nombre de joueurs, que cette fonction ne connait pas et n'a pas a
   * connaitre : `#step` l'ecrit d'une seule ligne, par `bossHp`, qui contient
   * deja `palierHp`. Les deux chemins sont EXCLUSIFS — un ordre est un ordre de
   * boss ou il ne l'est pas — donc aucune entite n'est mise a l'echelle deux
   * fois, et aucune ne l'est zero fois.
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
   * La charge du boss, en un seul endroit : elle blesse si elle traverse, et
   * elle s'annonce si l'heure est venue (etape 6a, tache 5 bis).
   *
   * ⚠️ **UN SEUL MESSAGE, A L'ANNONCE.** Ce qui part sur le fil, c'est
   * l'origine, la direction, la longueur, la largeur et les trois ticks ; la
   * POSITION du boss pendant toute la charge se derive de ces nombres, des deux
   * cotes, sans un octet de plus. C'est la parade qui a deja servi trois fois
   * dans ce depot — les zones, le gel de niveau, le vol des orbes — appliquee
   * au premier effet de cette etape qui touche le DEPLACEMENT.
   *
   * ⚠️ **La direction se lit sur les positions COURANTES, pas sur les positions
   * retardees du flowfield.** C'est un arbitrage, comme `resolveContact` et
   * `resolvePickups` : le serveur tranche, et le couloir doit viser la ou le
   * joueur est vraiment. Le client, lui, n'a rien a recalculer — il recoit la
   * direction deja figee.
   *
   * ⚠️ **Une charge en cours n'en annonce pas une autre.** Le retour anticipe
   * sur `chargeHoldsAt` est ce qui garantit qu'il n'y a jamais qu'un couloir a
   * la fois, donc jamais qu'un `#charge` a passer a `Horde.step` — deux charges
   * simultanees sur la meme entite se disputeraient sa position et la derniere
   * ecrite gagnerait, en silence.
   *
   * ⚠️ **Le cooldown se mesure depuis la FIN de la charge**, pas depuis son
   * annonce : sinon le rythme dependrait de la duree de la traversee, que la
   * tache 12 va justement retoucher.
   */
  #stepBossCharge(): void {
    const charge = this.#charge;
    if (charge) {
      for (const id of resolveChargeHit(
        [...this.#players.values()],
        this.horde,
        charge,
        this.#tick,
        this.#chargeHit,
      )) {
        this.#chargeHit.add(id);
      }
    }

    // ⚠️ **UNE SEULE garde decide qu'une nouvelle charge peut partir, et c'est
    // `#nextChargeTick`.** Une seconde garde, `chargeHoldsAt(charge, tick)`,
    // vivait ici — « une charge en cours n'en annonce pas une autre » — et la
    // mutation qui la retire est restee VERTE : elle etait entierement couverte
    // par celle-ci, puisque `#nextChargeTick` vaut `endTick +
    // BOSS_CHARGE_COOLDOWN_TICKS`, donc strictement au-dela de la charge en
    // cours des lors que ce delai est non nul. C'est la « deux gardes qui se
    // couvrent » du depot, seizieme occurrence, soldee comme plusieurs des
    // precedentes : **par une suppression**. La propriete dont depend le
    // retrait — `BOSS_CHARGE_COOLDOWN_TICKS > 0` — est gardee par un test de
    // `shared/boss.test.ts`, pour qu'un reglage a zero a la tache 12 fasse
    // rougir plutot que de laisser deux couloirs se disputer un boss.
    // La charge est celle du PLUS ANCIEN boss vivant.
    const chargeur = this.#bosses[0] ?? null;
    if (chargeur === null || this.#tick < this.#nextChargeTick) {
      return;
    }
    const slot = this.horde.slotOf(chargeur);
    if (slot < 0) {
      return;
    }
    const bx = this.horde.x[slot] ?? 0;
    const by = this.horde.y[slot] ?? 0;

    // Le joueur VIVANT le plus proche : la meme cible que celle vers laquelle
    // le boss marchait deja (`Horde.retarget` choisit le plus proche), donc la
    // charge prolonge son intention au lieu de la contredire.
    let targetX = 0;
    let targetY = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const p of this.#players.values()) {
      if (p.hp <= 0) {
        continue;
      }
      const dx = p.x - bx;
      const dy = p.y - by;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        targetX = p.x;
        targetY = p.y;
      }
    }
    if (bestDist === Number.POSITIVE_INFINITY) {
      // Personne de vivant a viser : rien a annoncer, et surtout pas un couloir
      // dans une direction par defaut. La run est de toute facon en train de se
      // terminer (`#checkRunOver`).
      return;
    }

    const next = makeBossCharge(chargeur, bx, by, targetX, targetY, this.#tick);
    this.#charge = next;
    this.#chargeHit.clear();
    this.#nextChargeTick = next.endTick + BOSS_CHARGE_COOLDOWN_TICKS;
    this.#pendingCharges.push(next);
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
        kind: this.#zones.kind[z] ?? 0,
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
      // L'arme neutre d'abord : elle vit hors des slots (§6.1) et ne figure
      // dans aucun `Loadout`. Elle ne tire que chez qui n'a pas choisi d'arme
      // de depart — l'arme choisie la remplace (`keepsBase`).
      if (p.keepsBase) {
        this.#fireOne(p, BASE_WEAPON_ID, tick);
      }
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
    const cooldown = cooldownWithBonus(
      weapon.cooldownTicks,
      p.loadout.bonus('fireRate') + p.accountBonuses.fireRate,
    );
    if (tick - (p.lastFireTick[weaponId] ?? Number.NEGATIVE_INFINITY) < cooldown) {
      return;
    }
    const damage = weapon.damage * (1 + p.loadout.bonus('damage') + p.accountBonuses.damage);
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
   * Fait avancer le vote d'un tick, et applique son verdict quand il tombe.
   *
   * ⚠️ **`decision === null` et « rester » sont tous deux faux en JS** :
   * `VOTE_CHOICE.STAY` vaut zero parce que c'est la valeur par defaut du jeu,
   * pas parce que c'est une absence. Comparer a `null`, jamais tester la
   * verite du retour.
   *
   * ⚠️ **Partir reutilise `RUN_OVER`, il n'invente pas une seconde fin de
   * run.** Le message existe depuis l'etape 3 et `#endRun` est le seul endroit
   * qui le met en file : une extraction et un effacement se terminent par le
   * meme evenement, et le client n'a pas deux fins a distinguer. Ce qui les
   * distingue, c'est l'OR — acquis d'un cote, perdu de l'autre — et il voyage
   * dans le `SNAPSHOT` a chaque tick.
   */
  /**
   * Ouvre le vote d'extraction. ⚠️ **Le multiplicateur part AVEC l'ouverture,
   * une seule fois** : constant sur toute la fenetre, il s'annonce comme les
   * cartes du draft plutot que de se repeter dans chaque snapshot. Voir
   * `PortalOpenMessage`.
   */
  #openPortal(): void {
    this.#portal.open(this.#tick, [...this.#players.keys()]);
    this.#pendingPortalOpens.push({
      deadlineTick: this.#portal.deadlineTick,
      multiplier: this.#extractMultiplier,
    });
  }

  /**
   * Avant les degats : remplit l'aura des chamans (`Horde.aura`) et rend la
   * position de chaque kamikaze vivant, par identite.
   */
  #behaviorsBeforeDamage(): Map<number, Blast> {
    const kamikazes = new Map<number, Blast>();
    const chamans: Blast[] = [];
    const necros: Blast[] = [];
    this.horde.aura.clear();
    this.#splitters = new Map();
    this.#corpses = new Map();
    for (let i = 0; i < this.horde.count; i++) {
      const behavior = archetypeOf(this.horde.archetype[i] ?? 0).behavior;
      const id = this.horde.entityIdAt(i);
      const pos = { x: this.horde.x[i] ?? 0, y: this.horde.y[i] ?? 0 };
      if (behavior === 'kamikaze') {
        kamikazes.set(id, pos);
      } else if (behavior === 'chaman') {
        chamans.push(pos);
      } else if (behavior === 'diviseur') {
        this.#splitters.set(id, pos);
      } else if (behavior === 'necro') {
        necros.push(pos);
      } else if (behavior === 'voleur' && this.horde.fleeing[i] === 1 && !this.#loot.has(id)) {
        // `fleeing` vient de passer a 1 (au contact, dans `retarget`) : il vole.
        const pris = Math.floor(this.#gold * THIEF_STEAL_SHARE);
        this.#gold -= pris;
        this.#loot.set(id, pris);
      }
    }
    if (necros.length > 0 && this.#tick >= this.#necroReadyTick) {
      for (let i = 0; i < this.horde.count; i++) {
        const id = this.horde.entityIdAt(i);
        if (
          archetypeOf(this.horde.archetype[i] ?? 0).behavior === 'necro' ||
          this.#bosses.includes(id)
        ) {
          continue;
        }
        const x = this.horde.x[i] ?? 0;
        const y = this.horde.y[i] ?? 0;
        if (necros.some((n) => Math.hypot(n.x - x, n.y - y) < NECRO_RADIUS)) {
          this.#corpses.set(id, { x, y });
        }
      }
    }
    if (chamans.length > 0) {
      for (let i = 0; i < this.horde.count; i++) {
        const x = this.horde.x[i] ?? 0;
        const y = this.horde.y[i] ?? 0;
        if (chamans.some((c) => Math.hypot(c.x - x, c.y - y) < SHAMAN_AURA_RADIUS)) {
          this.horde.aura.add(this.horde.entityIdAt(i));
        }
      }
    }
    return kamikazes;
  }

  /**
   * Ce que les morts du tick declenchent : l'or des voleurs rendu, les petits
   * des diviseurs, et les morts que releve un necromancien.
   *
   * ⚠️ **Les naissances passent par un ORDRE de vague ordinaire**, date du tick
   * SUIVANT : le client le pose en tete de ce tick-la, exactement la ou le
   * serveur l'a pose (apres le pas de celui-ci). Rien de neuf sur le fil.
   */
  #afterDeaths(dead: readonly number[]): void {
    for (const id of dead) {
      const butin = this.#loot.get(id);
      if (butin !== undefined) {
        this.#gold += butin;
        this.#loot.delete(id);
      }
      const p = this.#splitters.get(id);
      if (p) {
        this.#spawnAt(p, archetypeIdOf(SPLIT_CHILD), SPLIT_COUNT);
      }
    }
    const releves = dead.flatMap((id) => this.#corpses.get(id) ?? []).slice(0, NECRO_RAISE_MAX);
    const premier = releves[0];
    if (premier) {
      this.#spawnAt(premier, archetypeIdOf(NECRO_CHILD), releves.length);
      this.#necroReadyTick = this.#tick + NECRO_COOLDOWN_TICKS;
    }
  }

  #spawnAt(at: Blast, archetype: number, count: number): void {
    const waveId = this.#director.allocWaveId();
    const order: WaveOrder = {
      waveId,
      spawnTick: this.#tick + 1,
      seed: waveId,
      archetype,
      formation: FORMATION.POINT,
      anchorX: Math.round(at.x),
      anchorY: Math.round(at.y),
      count,
    };
    const before = this.horde.count;
    this.horde.spawn(order, this.#fields[0]);
    this.#scalePalierHp(before);
    this.#pendingOrders.push(order);
  }

  /** Explosions du tick ; rend les identites qu'elles tuent (kamikazes compris). */
  #resolveKamikazes(
    kamikazes: ReadonlyMap<number, Blast>,
    deadThisTick: readonly number[],
  ): number[] {
    // Au contact : `stopped` dit « a portee de sa cible », derive a l'identique
    // des deux cotes — la mort qui suit passe par le lot de morts habituel.
    const selfIds = [...kamikazes.keys()].filter((id) => {
      const slot = this.horde.slotOf(id);
      return slot >= 0 && this.horde.stopped[slot] === 1;
    });
    const blasts = [
      ...this.#pendingBlasts,
      ...selfIds.map((id) => kamikazes.get(id)).filter((b): b is Blast => b !== undefined),
    ];
    this.#pendingBlasts = [];
    for (const id of deadThisTick) {
      const b = kamikazes.get(id);
      if (b) {
        this.#pendingBlasts.push(b);
      }
    }
    if (blasts.length === 0) {
      return [];
    }
    const ids = resolveBlasts(
      this.horde,
      this.#orbs,
      blasts,
      selfIds,
      [...this.#players.values()],
      this.#tick,
      this.#zones,
    );
    for (const id of ids) {
      const b = kamikazes.get(id);
      if (b && !selfIds.includes(id)) {
        this.#pendingBlasts.push(b);
      }
    }
    return ids;
  }

  #stepPortal(): void {
    const decision = this.#portal.step(this.#tick);
    if (decision === null) {
      return;
    }
    if (decision === VOTE_CHOICE.LEAVE) {
      // ⚠️ **La seule ligne de tout le fichier qui MAJORE l'or**, et elle
      // passe par `extractGold` plutot que par une multiplication ecrite ici :
      // la borne du fil (`GOLD_MAX`) et l'arrondi vivent avec la formule, pas
      // a cote d'elle. Voir `shared/paliers.ts`.
      this.#gold = extractGold(this.#gold, this.#extractMultiplier);
      this.#endRun();
    } else {
      // Rester ne touche pas a la cagnotte : elle reste NON SECURISEE, et
      // c'est tout le risque du §5. Ce qui monte, c'est ce qu'elle vaudra si
      // l'equipe va au bout du palier suivant.
      this.#extractMultiplier += EXTRACT_MULTIPLIER_STEP;
    }
    this.#pendingPortalResults.push({
      effectTick: this.#tick,
      decision,
      // Un seul champ pour deux sens : l'or ACQUIS si on part, l'or REPORTE si
      // on reste. Deux champs en laisseraient toujours un a zero.
      gold: this.#gold,
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
      const nouveauMax =
        PLAYER_MAX_HP + player.loadout.bonus('maxHp') + player.accountBonuses.maxHp;
      player.hp += nouveauMax - player.maxHp;
      player.maxHp = nouveauMax;
    }
  }

  /**
   * Rend a chaque joueur vivant les points de vie de ses cartes « regain »
   * (etape 6a, tache 17, sur retour de jeu : *« il faut un moyen de regen
   * aussi »*).
   *
   * ⚠️ **RIEN NE SOIGNAIT avant cette tache.** « vitalite » releve `maxHp` et
   * offre le delta UNE FOIS, dans `grantCard` ; passe ce cadeau, `hp` ne
   * remontait jamais. Se soigner devient un CHOIX DE CONSTRUCTION plutot qu'un
   * cadeau : le draft, l'empilement et `Loadout.bonus(kind)` existaient deja,
   * cette methode ne fait que les lire.
   *
   * ⚠️ **Borne par `maxHp`, jamais par `PLAYER_MAX_HP`.** Le plafond est
   * PERSONNEL et suit les cartes de vitalite depuis l'etape 4 : le lire dans la
   * constante ferait d'une vitalite empilee un plafond qui monte sans que rien
   * ne puisse le remplir, et rendrait les deux cartes incompatibles.
   *
   * ⚠️ **Un joueur MORT ne regenere pas, et c'est le seul garde qui le dit.**
   * Rien d'autre ici ne regarde `hp` : sans lui, un joueur tombe a zero
   * remonterait tout seul et `#checkRunOver` verrait la run repartir. C'est
   * aussi pour ca que l'appel vient APRES `resolveContact` — un joueur acheve
   * ce tick-ci ne se releve pas dans le meme tick.
   *
   * ⚠️ **`hp` devient FRACTIONNAIRE, et le fil ne s'en emeut pas.** Le bonus
   * est en points par seconde, donc `magnitude / TICK_HZ` par tick ;
   * `encodeSnapshot` le porte en `u16` et tronque. Aucun repli possible : la
   * borne `maxHp` garantit que la valeur encodee ne depasse jamais le plafond
   * du joueur, qui est deja ce que le passage `u8 -> u16` de l'etape 4 rend
   * transportable.
   *
   * ⚠️ **Le TICK, pas le `dt` mis a l'echelle.** La rampe de reprise
   * (`#movementScale`) ne module que ce qui BOUGE ; ni le tir, ni le contact,
   * ni les ramassages ne la subissent (voir le garde de gel dans `step`), et un
   * soin ralenti par une reprise de niveau serait une regle de plus a
   * expliquer. `step` revient de toute facon avant d'arriver ici pendant le
   * gel strict.
   */
  #regenerate(): void {
    for (const p of this.#players.values()) {
      if (p.hp <= 0) {
        continue;
      }
      // ⚠️ **Pas de `if (bonus <= 0) return` : aucun test ne pourrait le faire
      // rougir.** A bonus nul, `Math.min(maxHp, hp + 0)` rend `hp` — la borne
      // ci-dessous couvre deja le cas, puisque `grantCard` maintient
      // `hp <= maxHp` a chaque carte. Deux gardes qui se couvrent, enieme
      // occurrence du depot ; soldee comme les autres, par une absence de code.
      p.hp = Math.min(
        p.maxHp,
        p.hp + (p.loadout.bonus('regen') + p.accountBonuses.regen) / TICK_HZ,
      );
    }
  }

  /**
   * Rayon de ramassage de CE joueur (tache 7 de l'etape 7b) : `ORB_PICKUP_RADIUS`
   * plus ses achats d'aimant. Personnel, donc lu ici et nulle part en dur —
   * c'est ce qui rend le rayon achetable plutot que fixe pour tout le monde.
   */
  #pickupRadiusOf(p: PlayerState): number {
    return ORB_PICKUP_RADIUS + p.accountBonuses.pickupRadius;
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
    // L'experience est d'EQUIPE : l'amelioration « Savoir » s'applique en
    // MOYENNE sur les joueurs presents, pour qu'un compte riche n'accelere pas
    // seul la partie des autres.
    let savoir = 0;
    for (const p of this.#players.values()) {
      savoir += p.accountBonuses.xp;
    }
    this.#xp += amount * (1 + savoir / Math.max(1, this.#players.size));
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
    // ⚠️ **La perte de l'or non securise vit ICI, sur cette seule ligne** (§5
    // de la spec). Ici, c'est-a-dire dans le chemin de l'EFFACEMENT DE
    // L'EQUIPE — la boucle ci-dessus n'arrive a cette ligne que si plus
    // personne n'est debout. La mort d'un joueur seul ne coute donc rien, et
    // ce n'est pas un oubli : le §9.3 de l'orientation est explicite.
    //
    // ⚠️ **`WIPE_GOLD_KEPT`, jamais un `0` ecrit ici.** C'est LE parametre de
    // playtest du §9.3 — voir sa doc dans `shared/constants.ts`, qui dit aussi
    // ce que la seconde alternative (« le bonus de palier toujours paye »)
    // demanderait de plus. Une valeur en dur ferait de son reglage un
    // chantier.
    //
    // L'arrondi garde l'or entier : c'est un compteur affiche, et c'est un
    // `u32` sur le fil (tache 7).
    this.#gold = Math.round(this.#gold * WIPE_GOLD_KEPT);
    this.#endRun();
  }

  /**
   * Termine la run : met `RUN_OVER` en file et arrete la simulation.
   *
   * **LE seul endroit qui termine une run, et il y a maintenant DEUX chemins
   * pour y arriver** : l'equipe effacee (`#checkRunOver`) et l'equipe qui part
   * par le portail (`#stepPortal`). Le second REUTILISE le message du premier
   * — la tache 9 ne devait pas inventer une seconde fin de run, et le client
   * n'a donc rien de neuf a apprendre pour savoir qu'une run s'arrete.
   *
   * ⚠️ **Toujours pas de garde « une seule fois » ici, et toujours pour la
   * meme raison** : `step()` ne rappelle jamais ses appelants une fois
   * `#runOver` vrai, son garde de tete rend cet appel inatteignable — verifie
   * par mutation a l'etape 3. Le seul cas ou les deux chemins tombent sur le
   * MEME tick ecrirait deux fois le meme evenement dans un champ unique, donc
   * une seule fois sur le fil.
   *
   * ⚠️ **L'or n'est pas touche ici.** Chaque chemin a deja fait son compte
   * avant d'appeler : `WIPE_GOLD_KEPT` d'un cote, `extractGold` de l'autre.
   * C'est ce qui garde la ligne de la perte unique, la ou le §5 veut qu'une
   * seconde bourse vienne un jour se brancher.
   */
  #endRun(): void {
    this.#runOver = true;
    this.#pendingRunOver = {
      tick: this.#tick,
      survivedTicks: this.#tick,
      level: this.#level,
      kills: this.#totalKills,
    };
  }
}
