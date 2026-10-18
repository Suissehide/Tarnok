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
  PORTEUR_ARCHETYPE,
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
  PLAYER_SPEED,
  PORTAL_EVERY_WAVES,
  PROJECTILE_CAPACITY,
  SHIELD_CALM_TICKS,
  SHIELD_REGEN_PER_SEC,
  SYNERGY_MAX,
  TICK_HZ,
  WIPE_GOLD_KEPT,
  XP_PER_ORB,
} from '@shared/constants';
import { type Decoy, substituteDecoys } from '@shared/decoys';
import { EnemyShots } from '@shared/enemy-shots';
import { aimPoint, armedWeapon, critOf, shotDamage } from '@shared/firing';
import { FlowField } from '@shared/flowfield';
import { dropsCoin, entityIdOf, Horde, pushOutOfGuards } from '@shared/horde';
import { Loadout, maxHpOf, maxShieldOf } from '@shared/loadout';
import {
  type FrappeImpact,
  frappeDueTick,
  frappeIsDue,
  frappeTargets,
  type Onde,
  ondeIsAlive,
} from '@shared/onde-frappe';
import { bossHp, extractGold, palierGold, palierHp } from '@shared/paliers';
import { PlayerHistory } from '@shared/player-history';
import { type Anchor, Projectiles } from '@shared/projectiles';
import {
  encodeSnapshot,
  OUTCOME,
  type PlayerSnapshot,
  packZoneKind,
  VOTE_CHOICE,
} from '@shared/protocol';
import { makeRandom } from '@shared/random';
import { CHEST_RARITY_FLOOR, RARITY } from '@shared/rarity';
import { BONUS_ZERO, type BonusKind } from '@shared/shop';
import { FORMATION, type WaveOrder } from '@shared/waves';
import {
  BASE_WEAPON_ID,
  beamRange,
  cooldownWithBonus,
  FIRE_RATE_PER_UPGRADE,
  type Guard,
  guardCenter,
  guardIsAlive,
  guardPulsesAt,
  UPGRADE,
  WEAPONS,
  weaponOf,
} from '@shared/weapons';
import { applyObstacles, generateObstacles, moveOnMap } from '@shared/worldmap';
import { ZoneField } from '@shared/zones';

import {
  applyReactions,
  type BeamPulse,
  type Blast,
  type ContactPlayer,
  type HaloPulse,
  hurtPlayer,
  markInZones,
  OrbField,
  Reactions,
  resolveBeams,
  resolveBlasts,
  resolveBurn,
  resolveChargeHit,
  resolveContact,
  resolveHalos,
  resolveOndes,
  resolveProjectileDamage,
  resolveVerglasCollisions,
  spreadMarkOnDeath,
  Venins,
} from './combat';
import { Draft } from './draft';
import { Portal } from './portal';
import { WaveDirector } from './wave-director';

/**
 * Le salon ne connait pas le reseau.
 *
 * Il recoit des entrees, avance d'un pas fixe, et ecrit ses sorties dans une
 * outbox que l'appelant vide, ce qui rend mecanique un passage en
 * `worker_threads` (un salon par worker). Une regle Biome le verifie sur ce
 * fichier et sur `combat.ts`.
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
   * Direction de visee, telle que recue par `INPUT` : deja
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
  /** PV maximum de ce joueur : `PLAYER_MAX_HP` plus ses cartes de vitalite. */
  maxHp: number;
  /**
   * Reserve de bouclier, absorbee avant les PV (voir `hurtPlayer`). `0` chez
   * qui ne porte pas Transcendance.
   */
  shield: number;
  /** Ticks ecoules sans degat — remis a zero par tout coup recu, voir `hurtPlayer`. */
  shieldCalmTicks: number;
  /** Plafond du bouclier (`maxShieldOf`), repose par `grantCard` a chaque carte de passif. */
  maxShield: number;
  /** Ticks restants avant qu'un nouveau contact puisse a nouveau faire mal. */
  contactInvulnTicks: number;
  /**
   * Dernier tick auquel ce joueur a tire, **par arme** : indice = identifiant
   * d'arme, `-Infinity` = jamais, donc tire des que possible.
   *
   * ⚠️ **Un compteur par arme, pas un pour le joueur.** Avec un compteur
   * unique, tout l'arsenal se rechargerait a la cadence de l'arme la plus
   * lente : drafter une grenade briderait la dague, et chaque carte prise
   * affaiblirait le joueur.
   *
   * Un `Float64Array` : `-Infinity` y tient, l'indice est l'identifiant (comme
   * dans `WEAPONS`), et la table est lue a chaque tick pour chaque joueur.
   */
  lastFireTick: Float64Array;
  /**
   * Ce que ce joueur possede : armes et passifs, chacun avec son nombre
   * d'exemplaires — tout s'empile.
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
   * Nombre de vagues tronquees par `Horde.spawn` depuis le dernier drainage :
   * la horde a atteint sa capacite et une partie de la vague n'est jamais
   * apparue.
   */
  truncatedSpawns: number;
}

/** Un lot d'identites datees, pour DEATHS et PICKUPS. */
export interface IdBatch {
  tick: number;
  ids: number[];
}

/**
 * Une zone posee, telle que `ZONE` la transporte.
 *
 * ⚠️ **Pas de rayon, et pas de mort.** Toutes les zones portent `ZONE_RADIUS`,
 * que les deux cotes connaissent ; leur peremption se derive du seul
 * `bornTick`. Voir `ZoneMessage`.
 *
 * ⚠️ **`kind` est l'octet empaquete par `packZoneKind`**, pas un element seul.
 */
export interface ZoneEvent {
  kind: number;
  x: number;
  y: number;
  bornTick: number;
  by: number;
}

/**
 * Une reaction a diffuser, telle que `REACTION` la transporte.
 *
 * ⚠️ **Pas les deux identites.** Le serveur compare le joueur qui a marque et
 * celui qui declenche ; le fil ne porte que le booleen `synergyCharge` (vrai
 * quand ils different). Envoyer les identites inviterait le client a refaire
 * l'arbitrage, donc a diverger. Le booleen dit ce que la reaction a valu, pas
 * ou en est la barre : le total voyage dans le `SNAPSHOT`.
 */
export interface ReactionEvent {
  pair: number;
  x: number;
  y: number;
  tick: number;
  synergyCharge: boolean;
}

/** Un etalage a diffuser, tel que `DRAFT_OPEN` le transporte. */
export interface DraftOpenEvent {
  deadlineTick: number;
  cards: readonly Card[];
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
 * monde a vote, donc n'importe quand avant l'echeance : le client ne peut pas
 * le deduire. Voir `PortalResultMessage`.
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
 * tick qu'un verdict : le relire au moment d'encoder ne marcherait que par
 * chance d'ordonnancement. L'evenement porte la valeur vraie a l'ouverture,
 * comme `DraftOpenEvent` porte ses cartes.
 */
export interface PortalOpenEvent {
  deadlineTick: number;
  /** Le multiplicateur qui s'applique si l'equipe part maintenant. Voir `#extractMultiplier`. */
  multiplier: number;
}

/** Une montee de niveau, datee au tick ou le gel prend effet. */
export interface LevelUpEvent {
  tick: number;
  level: number;
}

/** La fin d'une run, une seule fois. */
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
 * tour de compteur des que `seq` repasse par zero, soit toutes les 36 minutes a
 * 30 Hz.
 */
function isNewer(a: number, b: number): boolean {
  return a !== b && ((a - b) & 0xffff) < 0x8000;
}

export class Room {
  /**
   * Graine de la carte : obstacles, generateur de vagues, tirage du draft en
   * derivent tous. Aleatoire par defaut, **injectable** : un salon dont on
   * fixe la graine se rejoue a l'identique.
   *
   * ⚠️ Certains tests en dependent : celui des drafts enchainees construit un
   * tas d'orbes dont la geometrie depend des obstacles, et devient intermittent
   * avec une graine au hasard.
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
   * Les zones au sol. Vivent ici et nulle part ailleurs cote serveur :
   * `Room.step` est le seul a respecter le contrat d'ordre « expirer avant de
   * poser, une fois par tick » que `ZoneField.spawn` exige.
   */
  readonly #zones = new ZoneField();
  /**
   * Les reactions du tick en cours. Collectees par trois chemins (impact,
   * entree en zone, recouvrement de zones), puis resolues et
   * videes a la fin de `step`, jamais au fil de l'eau : voir `Reactions`.
   */
  readonly #reactions = new Reactions();
  #pendingZones: ZoneEvent[] = [];
  #pendingReactions: ReactionEvent[] = [];
  /**
   * Les verbes acceptes depuis le dernier drainage. `useAbility` y pousse
   * l'annonce en plus de la rendre a l'appelant, et c'est ce tableau, pas le
   * retour, que `#broadcast` diffuse. Voir `drainAbilities`.
   */
  #pendingAbilities: AbilityUsed[] = [];
  /** Les leurres plantes, purges a chaque nouvelle pose ; `substituteDecoys` ignore les expires. */
  #decoys: Decoy[] = [];
  /** Les zones de Rempart posees, purgees a chaque nouvelle pose ; `armorOf` ignore les expirees. */
  #remparts: { x: number; y: number; bornTick: number; by: number }[] = [];
  /**
   * La charge du boss en cours, ou `null`. Une seule a la fois : seul le plus
   * ancien boss charge (voir `#bosses`).
   *
   * ⚠️ **Gardee apres sa fin, jamais remise a `null` par le temps.** Une charge
   * finie est inerte (`chargeHoldsAt` rend faux), comme une zone perimee
   * laissee dans sa reserve : c'est le predicat qui decide, pas la presence.
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
   * ⚠️ Le draft ne participe pas au contrat de replication : aucun client ne
   * refait ce tirage. La graine sert la reproductibilite des tests, pas la
   * convergence.
   */
  readonly #draftRng: () => number;
  /** Le poison des cartes « venin » — serveur seul, voir `Venins`. */
  readonly #venins = new Venins();
  /**
   * Le vote d'extraction en cours. `phase === 'closed'` : aucun portail ouvert.
   *
   * ⚠️ **Il n'est PAS le pendant de `#draft` dans `step`.** Un etalage ouvert
   * gele le monde ; un portail ouvert non : la horde avance, les vagues
   * tombent. Le draft gele parce qu'un choix de carte n'a pas d'enjeu
   * temporel ; le vote ne gele pas parce que le temps est son enjeu.
   */
  readonly #portal = new Portal();
  /** Ouvertures de portail depuis le dernier drainage. Voir `PortalOpenEvent`. */
  #pendingPortalOpens: PortalOpenEvent[] = [];
  #pendingPortalResults: PortalResultEvent[] = [];
  /**
   * Le multiplicateur d'extraction : ce par quoi l'or non securise sera
   * majore le jour ou l'equipe partira.
   *
   * ⚠️ **Il part de 1, donc la premiere extraction n'ajoute rien** : elle
   * acquiert seulement. Partir au premier portail n'est pas puni ; ce que
   * « rester » achete, c'est la majoration des paliers suivants, contre le
   * risque de tout perdre.
   *
   * Il ne redescend jamais : l'extraction termine la run.
   */
  #extractMultiplier = 1;
  /** Niveaux gagnes dont le draft n'a pas encore eu lieu. */
  #pendingLevels = 0;
  /**
   * Les coffres dus : un par porteur abattu. Un coffre est un etalage d'equipe
   * comme un niveau (meme gel, memes jetons, memes conflits), au plancher
   * `CHEST_RARITY_FLOOR`. `#openDraft` en consomme un AVANT tout niveau : c'est
   * ce qui laisse le client le reconnaitre sans octet.
   */
  #chestsOwed = 0;
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
   * Le compteur de Synergie de l'EQUIPE.
   *
   * ⚠️ **UN SEUL NOMBRE, pour tout le salon**, comme `#xp` : une valeur par
   * joueur ferait deux sources de verite. Il ne sort d'ici que par l'en-tete
   * du `SNAPSHOT`, jamais par le bloc d'un joueur.
   *
   * ⚠️ **Il monte et ne descend jamais** : rien ne depense encore la barre,
   * donc `SYNERGY_MAX` est un plafond voulu. Un ultime d'equipe soustraira ici.
   */
  #synergy = 0;

  /**
   * L'or NON SECURISE de l'equipe : il se gagne a la mort de chaque boss, et
   * il n'est **acquis** qu'a l'extraction.
   *
   * ⚠️ **UN SEUL NOMBRE, pour tout le salon**, comme `#xp` et `#synergy` : ce
   * qui se decide au vote, c'est ce que l'equipe risque, pas chacun. Il ne
   * sort d'ici que par l'en-tete du `SNAPSHOT`.
   *
   * La mort d'un seul joueur ne le touche pas ; l'effacement de l'equipe le
   * fait perdre (`#checkRunOver`). Le multiplicateur d'extraction vit a part,
   * dans `#extractMultiplier`.
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
   * Identites des boss VIVANTS, du plus ancien au plus recent. Le plus ancien
   * porte la barre de vie (`SNAPSHOT`) et la charge.
   *
   * ⚠️ **Des identites, pas des creneaux.** Les creneaux se compactent a chaque
   * mort (`Horde.#removeAt`) : un indice retenu d'un tick a l'autre designerait
   * un autre monstre. `entityIdOf(waveId, 0)` est stable pour toute la vie de
   * l'entite.
   */
  #bosses: number[] = [];
  /**
   * Le porteur de coffre vivant, par IDENTITE comme `#bosses` —
   * `null` s'il n'y en a pas. Le directeur n'en demande pas d'autre tant que
   * `porteurGone` n'est pas venu.
   */
  #porteur: number | null = null;
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
    // ⚠️ Initialise ici, pas a la declaration : les initialiseurs de champ
    // s'executent avant le corps du constructeur et liraient une graine
    // indefinie (TS2729).
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
   * Zones posees a diffuser, une par POSE — creation comme
   * rafraichissement.
   *
   * ⚠️ **Un rafraichissement s'annonce aussi, et il le faut.** La regle de
   * fusion fait repartir le `bornTick` d'une zone existante sans
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
   * Les verbes acceptes a diffuser, un par `ABILITY_USED`.
   *
   * ⚠️ **Au meme tick que `DEATHS`, et dans le MEME drain.** Un envoi immediat
   * depuis le gestionnaire de `MSG.ABILITY` partirait hors du cycle ou les
   * evenements du tick partent ensemble dans un ordre garanti : le Relais
   * derive sa cible du tick ou l'allie peut mourir, et un client qui recevrait
   * l'annonce avant ou apres `DEATHS` selon le reseau viserait un allie vivant
   * ou mort selon l'ordre de reception.
   */
  drainAbilities(): AbilityUsed[] {
    const out = this.#pendingAbilities;
    this.#pendingAbilities = [];
    return out;
  }

  /**
   * Les charges de boss annoncees depuis le dernier drainage — **au plus une
   * par charge, et rien ensuite**. La progression ne se diffuse jamais : les
   * deux cotes la derivent des ticks que ce seul message porte.
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
   * Reactions a diffuser. Rares — contrairement aux zones, rien ne les
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

  /** Lots de morts a diffuser, un par tick ou quelqu'un est mort. */
  drainDeaths(): IdBatch[] {
    const out = this.#pendingDeaths;
    this.#pendingDeaths = [];
    return out;
  }

  /** Lots de ramassages a diffuser, un par tick ou un orbe a ete pris. */
  drainPickups(): IdBatch[] {
    const out = this.#pendingPickups;
    this.#pendingPickups = [];
    return out;
  }

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
   * Les portails ouverts depuis le dernier drainage, avec l'echeance de leur
   * fenetre et le multiplicateur qui s'y applique.
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
   * Voir qui n'a pas encore tranche est la matiere de la negociation. Voir
   * `Portal#votes`.
   */
  portalVotes(): ReadonlyMap<number, number> {
    return this.#portal.votes();
  }

  /**
   * Enregistre le vote d'un joueur, ou le retire (`NO_VOTE`). Rend `false` si
   * le geste est refuse.
   *
   * ⚠️ **Aucun garde sur les points de vie, c'est voulu** : tout joueur
   * connecte vote, **mort ou vif**. La mort d'un seul ne coute rien, pas meme
   * sa voix.
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
   * et le marquage en O(zones x entites), donc c'est CE nombre, et pas
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
   * Orbes encore au sol, pour les bancs et les tests d'integration : c'est ce
   * qui verifie le taux de chute (`ORB_DROP_ONE_IN`) sur une vraie run, et pas
   * seulement a l'unite dans `combat.test.ts`.
   */
  get orbCount(): number {
    return this.#orbs.count;
  }

  /**
   * Zones qu'une pose n'a pas pu creer faute de place, depuis le debut de la
   * run. Voir `ZoneField.truncatedZones`.
   *
   * ⚠️ **Une zone qui ne se pose pas est un effet que le joueur a paye et qui
   * ne se voit pas** : sans ce lecteur, atteindre `ZONE_CAPACITY` serait
   * silencieux.
   */
  get zonesTronquees(): number {
    return this.#zones.truncatedZones;
  }

  /**
   * Orbes qu'une mort n'a pas pu poser faute de place, depuis le debut de la
   * run. Voir `OrbField.truncatedOrbs`.
   *
   * ⚠️ Les orbes n'expirent pas : la capacite est leur SEULE borne, et elle
   * est silencieuse. Sans ce lecteur, l'experience refusee au sol
   * disparaitrait sans trace.
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

  /** Montees de niveau a diffuser, datees au tick ou le gel prend effet. */
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

  /** Bonus « Fortune » du compte de ce joueur, 0 s'il est absent. */
  goldBonusOf(playerId: number): number {
    return this.#players.get(playerId)?.accountBonuses.gold ?? 0;
  }

  /** Le maximum de points de vie de ce joueur, bonus de cartes et de compte compris. */
  maxHpOf(playerId: number): number {
    return this.#players.get(playerId)?.maxHp ?? 0;
  }

  /** PV courants d'un joueur, `0` s'il est absent. Lecture etroite, comme `maxHpOf`. */
  hpOf(playerId: number): number {
    return this.#players.get(playerId)?.hp ?? 0;
  }

  /** Reserve de bouclier courante d'un joueur, `0` s'il est absent. */
  shieldOf(playerId: number): number {
    return this.#players.get(playerId)?.shield ?? 0;
  }

  /**
   * L'armure effective d'un joueur : le MAXIMUM de celle de son compte et de
   * toute protection de Rempart qui le couvre, PUIS la contribution des
   * cartes de passif.
   *
   * ⚠️ **Le compte et le Rempart restent un MAXIMUM, jamais une somme**, comme
   * deux zones qui se recouvrent dans `ZoneField` : une somme ferait de
   * « Armure achetee au maximum, plus un Rempart » une quasi-immunite.
   *
   * ⚠️ **`loadout.bonus('armor')` s'AJOUTE apres ce maximum** : c'est le seul
   * chemin par lequel le malus de Hate funeste atteint `hurtPlayer`. Le total
   * peut donc etre NEGATIF, et c'est voulu : les degats depassent alors les
   * degats bruts (`Math.max(0, 1 - armor)` dans `hurtPlayer` ne borne que par
   * le haut).
   */
  armorOf(playerId: number): number {
    const p = this.#players.get(playerId);
    if (!p) {
      return 0;
    }
    return (
      Math.max(p.accountBonuses.armor, this.#rempartCouvre(p) ? REMPART_ARMOR : 0) +
      p.loadout.bonus('armor')
    );
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
   * Le Relais : le lanceur se teleporte sur l'allie VIVANT le plus proche du
   * point vise, a `RELAIS_RANGE` du lanceur au plus.
   *
   * ⚠️ **Rend `null` sur tout refus** — pas d'allie, allie mort ou hors de
   * portee, soi-meme — et c'est ce qui laisse la recharge intacte : `useAbility`
   * ne la pose qu'apres une annonce.
   *
   * ⚠️ **L'intangibilite du trait `relaisIntangible` est `contactInvulnTicks`**,
   * le compteur que le contact et la charge du boss lisent deja : un second
   * compteur d'invulnerabilite finirait par diverger du premier.
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

  /**
   * ⚠️ **Ecritures de TEST, aucun chemin de production ne les appelle**, comme
   * `debugSetGold`. Un test de verbe doit poser un joueur a une distance
   * controlee ; le faire marcher pendant des secondes de simulation rendrait
   * chaque test lent et fragile.
   */
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

  /**
   * ⚠️ **Restitue aussi `shield` et `shieldCalmTicks`, pas seulement `hp`** :
   * sinon un porteur de Transcendance ressusciterait avec une reserve a `0`
   * et un compteur de calme perime.
   */
  debugRevive(playerId: number): void {
    const p = this.#players.get(playerId);
    if (p) {
      p.hp = p.maxHp;
      p.shield = p.maxShield;
      p.shieldCalmTicks = 0;
    }
  }

  /** Ecriture de test, meme statut que `debugSetGold` : passe `hurtPlayer` sur un joueur. */
  debugHurt(playerId: number, degats: number): void {
    const p = this.#players.get(playerId);
    if (p) {
      hurtPlayer(p, degats);
    }
  }

  /**
   * Ecriture de test, meme statut que `debugSetGold` : pose les PV courants
   * d'un joueur sans toucher a son plafond, pour eprouver une carte a malus
   * de PV max (Fournaise) sur un joueur deja blesse.
   */
  debugSetHp(playerId: number, hp: number): void {
    const p = this.#players.get(playerId);
    if (p) {
      p.hp = hp;
    }
  }

  /**
   * Le palier courant, `0` pour le premier — l'argument `k` des formules de
   * `shared/paliers.ts`.
   *
   * ⚠️ **Le palier est une donnee du SALON**, ce qui garde les formules pures
   * et sans etat. Il n'avance qu'a la mort du boss, jamais a un tick.
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
   * ⚠️ **Nomme `debug` pour que personne ne s'en serve en production.** Ce
   * qui se teste ici est le transfert vers le compte ; faire jouer vingt
   * minutes pour poser une cagnotte rendrait le test inutilisable.
   *
   * ⚠️ **Leve sur un non-entier, plutot que de le tronquer.** Les chemins de
   * production rendent tous un entier ; cette methode est la seule ecriture
   * qui pourrait introduire un flottant, et `Session#creditAccounts` fait
   * `BigInt(this.room.gold)` AVANT son `try` : le `RangeError`, derriere un
   * appel fire-and-forget, tuerait le process. Tronquer en silence masquerait
   * le bug de test.
   */
  debugSetGold(gold: number): void {
    if (!Number.isInteger(gold)) {
      throw new Error(`debugSetGold : ${gold} n'est pas un entier`);
    }
    this.#gold = gold;
  }

  /**
   * Ecriture de test, meme statut que `debugSetGold` : vide l'arsenal d'un
   * joueur (la dague comprise), pour les tests qui ont besoin de TOUS les slots.
   */
  debugResetLoadout(id: number): void {
    const p = this.#players.get(id);
    if (p) {
      p.loadout = new Loadout();
    }
  }

  /** Ecriture de test, meme statut que `debugSetGold` : le niveau de l'equipe. */
  debugSetLevel(level: number): void {
    this.#level = level;
  }

  /**
   * Ecriture de test, meme statut que `debugSetGold` : `n` niveaux montes et
   * dus, comme si l'XP venait de franchir `n` seuils. Sert a provoquer « un
   * coffre et un niveau dus au meme tick », que le jeu ne produit
   * qu'au hasard d'une orbe.
   */
  debugOweLevels(n: number): void {
    this.#level += n;
    this.#pendingLevels += n;
  }

  /**
   * Ecriture de test, meme statut que `debugSetGold` : ouvre la reserve de
   * bouclier d'un joueur sans passer par Transcendance.
   *
   * ⚠️ **Remplit aussi `shield`, pas seulement le plafond.** `join` laisse
   * `shield: 0` : sans ce remplissage, un test qui donne un coup juste apres
   * comparerait 0 a 0, et ne prouverait jamais l'absorption.
   */
  debugSetMaxShield(playerId: number, maxShield: number): void {
    const p = this.#players.get(playerId);
    if (p) {
      p.maxShield = maxShield;
      p.shield = maxShield;
    }
  }

  get metrics(): Readonly<RoomMetrics> {
    return this.#metrics;
  }

  /**
   * Rend false si le salon est plein.
   *
   * `compte` est optionnel sans etre un raccourci de test : un joueur sans
   * aucun achat a legitimement des bonus tous nuls, le defaut est un etat de
   * production valide.
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
    // (`startingWeapons`), ou la dague a defaut. Elle entre dans le `Loadout`
    // comme une carte draftee : une arme comme les autres, que le draft
    // ameliore.
    const loadout = new Loadout();
    loadout.addWeapon(startWeapon ?? BASE_WEAPON_ID);
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
      hp: maxHpOf(loadout, compte?.bonuses.maxHp ?? 0),
      maxHp: maxHpOf(loadout, compte?.bonuses.maxHp ?? 0),
      // Bouclier ferme : seul `grantCard` (Transcendance) ouvre `maxShield`.
      shield: 0,
      shieldCalmTicks: 0,
      maxShield: 0,
      contactInvulnTicks: 0,
      lastFireTick: new Float64Array(WEAPONS.length).fill(Number.NEGATIVE_INFINITY),
      loadout,
      classId,
      lastAbilityTick: Number.NEGATIVE_INFINITY,
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
   * `aimX`/`aimY` sont bornes comme `moveX`/`moveY` mais jamais renormalises :
   * seul l'ANGLE de la visee compte (voir `PlayerState.aimX`). Par defaut
   * `(0, 0)`, soit « pas de tir ».
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
   * ⚠️ **L'annonce est a la fois RENDUE et MISE EN FILE** : rendue pour les
   * tests directs, mise en file dans `#pendingAbilities`, qui seule part sur le
   * fil (voir `drainAbilities`). Un appelant qui enverrait aussi le retour
   * doublerait l'annonce.
   *
   * ⚠️ **La recharge se pose APRES `#applyAbility`, jamais avant** : un refus
   * (un Relais sans allie valide a portee) ne doit pas consommer la recharge.
   * En contrepartie, chaque branche de `#applyAbility` DOIT rendre `null`
   * quand elle refuse, sinon le verbe devient gratuit.
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
   * ⚠️ **L'ordre compte, et il doit rester identique cote client.**
   * Sequence (voir aussi `combat.ts`, qui porte les etapes 7 a 9) :
   *
   * ```
   * 1. tick++
   * 2. deplacer les joueurs
   * 3. enregistrer l'historique de positions (arrondi !)
   * 4. rafraichir les champs si du (tick % stepsPerField)
   * 5. appliquer les ordres de vague en attente
   * 6. avancer la horde — `Horde.step` recalcule d'abord la trajectoire des
   *    entites dont c'est le tour (direction du champ + repulsion sommee),
   *    puis avance tout le monde
   * 7. tirer les salves dues, avancer les projectiles, resoudre les collisions
   *    — un impact MARQUE, il ne laisse rien au sol
   * 7 bis. marquer ce que les champs couvrent, resoudre les reactions du tick,
   *    **puis annoncer les champs qu'elles viennent de poser**
   * 8. arbitrer le contact avec les joueurs, **puis rendre aux survivants les
   *    points de vie de leurs cartes « regain »** — dans cet ordre, pour qu'un
   *    joueur acheve par le contact de ce tick-ci ne se releve pas
   * 9. resoudre les ramassages d'orbes
   * 10. mettre en file morts et ramassages pour diffusion
   * ```
   *
   * ⚠️ **Etape 7 bis : l'annonce vient APRES la reaction.** `#announceZones`
   * ne reconnait une pose qu'a `bornTick === #tick`, et les zones naissent de
   * `applyReactions` : annoncer avant laisserait chaque champ sans message.
   *
   * ⚠️ **Etapes 4 et 5 : le rafraichissement precede l'engendrement.**
   * `shared/horde.replication.test.ts` verifie cet ordre a 0 px de derive avec
   * rejeu (scenario 9). Ne pas inverser sans rejouer ce scenario.
   */
  step(dt: number): void {
    this.#tick++;

    if (this.#runOver) {
      // Fin de run : plus rien n'avance, mais le tick continue de compter —
      // c'est lui qui date le message deja mis en file. Seul garde de cette
      // garantie : le deplacement plus bas ne verifie pas `hp`, et un joueur
      // a 0 pv glisserait encore sur la carte.
      return;
    }

    // Un coffre ou un niveau attend, et aucun etalage n'est ouvert : on ouvre.
    if (this.#draft.phase === 'closed' && (this.#chestsOwed > 0 || this.#pendingLevels > 0)) {
      this.#openDraft();
    }

    // Un etalage est ouvert : le monde est gele, seule la machine avance.
    if (this.#draft.phase !== 'closed') {
      this.#stepDraft();
      return;
    }

    if (this.#tick <= this.#freezeUntilTick) {
      // Gel : le monde ne bouge pas, mais le tick continue d'avancer — c'est
      // lui qui date le LEVEL_UP deja mis en file, pour que les clients figent
      // au meme tick plutot qu'a la reception.
      //
      // ⚠️ Ce garde n'est PAS redondant avec `#movementScale()` plus bas, qui
      // ne module que le deplacement : sans ce retour, le tir, le contact et
      // les ramassages continueraient pendant le gel.
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

    // Arrondies, comme sur le fil : le client ne connait que la version
    // quantifiee en int16 (`encodeSnapshot`). Avec des positions flottantes,
    // les deux cotes enracineraient parfois leur BFS dans des cellules
    // differentes : le serveur s'impose l'arrondi comme il s'impose le retard.
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
      // identiques.
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

    // Une vague est un GROUPE d'ordres (principal, escorte) : chacun nait dans
    // l'ordre, et la vague ne compte qu'UNE fois pour le portail.
    const vague = this.#director.dueWave(this.#tick, xs, ys, this.#level);
    for (const order of vague) {
      // ⚠️ **Lu AVANT `spawn`, et avant tout le reste** : `bossWaveId` designe
      // le boss que `due` vient eventuellement de demander.
      const estBoss = this.#director.bossWaveId === order.waveId;
      const before = this.horde.count;
      // `this.#fields[0]` : les quatre champs partagent le meme masque
      // d'obstacles (`applyObstacles` au constructeur) — n'importe lequel
      // convient pour eviter de faire naitre une entite en plein mur.
      this.horde.spawn(order, this.#fields[0]);
      // Rend visible une troncature silencieuse : voir `RoomMetrics.truncatedSpawns`.
      if (this.horde.count - before < order.count) {
        this.#metrics.truncatedSpawns++;
      }
      if (estBoss) {
        if (this.horde.count > before) {
          const premier = this.#bosses.length === 0;
          this.#bosses.push(entityIdOf(order.waveId, 0));
          // ⚠️ **Le boss ne passe PAS par `#scalePalierHp`** : `bossHp`
          // contient deja `palierHp`, une seule ecriture suffit. Le creneau est
          // `before` : la vague de boss vaut `count: 1`.
          //
          // ⚠️ **Les PV du boss sont FIGES A SON APPARITION** (`#players.size`
          // lu une fois) : suivre le nombre de joueurs ferait regagner de la
          // vie a un boss entame quand quelqu'un rejoint. Le prix : trois
          // joueurs qui quittent laissent au dernier un boss de quatre.
          this.horde.hp[before] = bossHp(this.#director.palier, this.#players.size);
          // ⚠️ **Il n'arrive pas en chargeant** : il apparait au bord de la
          // carte, et une charge immediate traverserait un couloir vide. Le
          // premier delai est celui qui separe deux charges. Un boss de plus ne
          // remet pas a zero la charge d'un boss deja la.
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
        // Le porteur passe par le chemin ordinaire des PV
        // (`palierHp`), puis le salon retient son identite. Horde pleine : il
        // n'existe pas, et le directeur doit le savoir (meme parade que
        // `bossMissing`).
        if (order.archetype === PORTEUR_ARCHETYPE) {
          if (this.horde.count > before) {
            this.#porteur = entityIdOf(order.waveId, 0);
          } else {
            this.#director.porteurGone();
          }
        }
      }
      this.#pendingOrders.push(order);
    }
    // ⚠️ **Le portail s'ouvre toutes les `PORTAL_EVERY_WAVES` vagues**, et
    // seulement la : la mort d'un boss ne l'ouvre pas. Une vague = un groupe,
    // quel que soit son nombre d'ordres.
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
    // ⚠️ **Aucun test ne garde cet appel.** `aliveAt` et `slowsAt` decident
    // seuls de ce qui existe (voir `ZoneField`) : l'expiration n'est qu'une
    // reprise de memoire. Sans elle, les zones mortes s'accumulent jusqu'a
    // `ZONE_CAPACITY` et la reserve pleine tronque les poses vivantes, ce
    // qu'aucun test unitaire n'atteint.
    this.#zones.expire(this.#tick);
    // ⚠️ **La charge REMPLACE le deplacement du boss** : `step`
    // l'applique en dernier, apres l'avancement par vitesse et la separation,
    // et c'est cet ordre qui fait que le boss n'avance pas deux fois. Voir
    // `Horde#applyCharge`.
    this.horde.step(scaledDt, this.#fields, this.#tick, this.#zones, this.#charge);
    this.shots.step(this.horde, this.#tick, scaledDt);

    // Les comportements du tick. L'aura des chamans protege leurs voisins de TOUTES les passes de degats
    // qui suivent ; les kamikazes sont releves AVANT les degats, pour savoir ou
    // exploser s'ils meurent en chemin.
    const kamikazes = this.#behaviorsBeforeDamage();

    this.#fireWeapons(this.#tick);
    // Les invocations posees aux ticks precedents frappent AVANT la resolution :
    // leurs pulsations rejoignent celles des halos, qui sont la meme chose a un
    // centre pres.
    this.#pulseGuards(this.#tick);
    // Les frappes echues aussi : un impact de frappe EST une
    // pulsation de halo differee.
    this.#dropFrappes(this.#tick);
    // Les halos, resolus AVANT les projectiles pour la meme raison que les
    // projectiles le sont avant les zones : chaque source de degat passe une
    // fois, et `Room.step` reste le seul endroit ou une mort se prononce.
    const haloIds = resolveHalos(
      this.#haloPulses,
      this.horde,
      this.#orbs,
      this.#tick,
      this.#zones,
      this.#reactions,
    );
    this.#haloPulses.length = 0;
    const beamIds = resolveBeams(
      this.#beamPulses,
      this.horde,
      this.#orbs,
      this.#tick,
      this.#zones,
      this.#reactions,
    );
    this.#beamPulses.length = 0;
    const ondeIds = resolveOndes(
      this.#ondes,
      this.horde,
      this.#orbs,
      this.#tick,
      this.#zones,
      this.#reactions,
    );
    if (this.#ondes.length > 0) {
      this.#ondes = this.#ondes.filter((o) => ondeIsAlive(o, this.#tick + 1));
    }
    const deadIds = resolveProjectileDamage(
      this.#projectiles,
      scaledDt,
      this.horde,
      this.#orbs,
      this.#tick,
      this.#zones,
      this.#reactions,
      this.#venins,
      this.#anchor,
    );
    markInZones(this.horde, this.#zones, this.#tick, this.#reactions);
    // ⚠️ **Les reactions se resolvent ICI, apres les DEUX chemins qui les
    // declenchent, et une seule fois.** `Reactions` ne fait que collecter :
    // resoudre au fil de l'eau tuerait des entites pendant que
    // `Projectiles.collide` ou `markInZones` balaient encore la horde par
    // indice de creneau. `drain` remet du meme coup la borne « une reaction
    // par ennemi et par tick » a zero.
    const triggers = this.#reactions.drain(this.#tick);
    const reactedIds = applyReactions(
      this.horde,
      this.#orbs,
      this.#tick,
      triggers,
      this.#zones,
      this.#reactions,
      // Echo : les reactions que CE joueur declenche.
      (id) => this.#players.get(id)?.loadout.bonus('echo') ?? 0,
    );
    // ⚠️ **APRES `applyReactions`** : voir l'etape 7 bis du docbloc de `step`.
    this.#announceZones();
    for (const t of triggers) {
      // ⚠️ **La regle de Synergie, en une comparaison, et elle n'existe
      // qu'ICI.** Deux joueurs differents a l'origine de la reaction (l'un a
      // applique le premier element, l'autre le second) : l'equipe gagne une
      // charge. Le meme joueur des deux cotes : la reaction a lieu, elle ne
      // rapporte rien. Le jeu recompense le regroupement, il ne punit pas le
      // joueur seul.
      //
      // ⚠️ **En solo la barre ne monte donc JAMAIS, par construction.** C'est
      // voulu.
      //
      // ⚠️ **Le bit annonce la COMPARAISON, pas le mouvement de la barre** : a
      // plafond atteint, une reaction inter-joueurs porte toujours
      // `synergyCharge: true`. Le total voyage dans le `SNAPSHOT`.
      const charge = t.markBy !== t.by;
      if (charge) {
        this.#synergy = Math.min(SYNERGY_MAX, this.#synergy + 1);
      }
      // Le couple d'elements est deja canonicalise par `packElementPair` :
      // Braise+Givre et Givre+Braise portent le meme octet.
      this.#pendingReactions.push({
        pair: t.pair,
        x: t.x,
        y: t.y,
        tick: this.#tick,
        synergyCharge: charge,
      });
    }
    const burntIds = resolveBurn(this.horde, this.#orbs, this.#tick, this.#zones);
    // Le poison des cartes « venin », au meme titre que la brulure.
    const poisonedIds = this.#venins.resolve(this.horde, this.#orbs, this.#tick, this.#zones);
    // ⚠️ **Verglas : les ennemis derapent ET se percutent.** Le derapage vit
    // dans `Horde.step`, deja joue ; la collision est un degat, resolue ICI
    // comme la brulure. Voir `resolveVerglasCollisions`.
    const collidedIds = resolveVerglasCollisions(this.horde, this.#orbs, this.#tick, this.#zones);
    // Les kamikazes : ceux qui touchent leur cible se font sauter maintenant,
    // ceux que les passes precedentes ont tues exploseront au tick suivant
    // (leur position a ete relevee avant les degats), comme ceux que les
    // explosions de ce tick emportent — d'ou les reactions en chaine.
    const blastIds = this.#resolveKamikazes(kamikazes, [
      ...haloIds,
      ...beamIds,
      ...ondeIds,
      ...deadIds,
      ...reactedIds,
      ...burntIds,
      ...poisonedIds,
      ...collidedIds,
    ]);
    // ⚠️ **UN SEUL lot de morts par tick, toutes passes comprises.**
    // `GameClient` s'appuie dessus : deux lots vises au meme tick, rejoues
    // l'un apres l'autre, verraient le second effacer la correction du premier
    // (`#drainPendingDeaths`). Aucune passe n'a donc de chemin de mort a elle.
    //
    // Aucun doublon possible, et l'ORDRE le garantit : chaque passe tourne
    // APRES la compaction de la precedente, donc les identites deja listees
    // n'existent plus dans la horde quand la suivante la balaie.
    const allDead =
      haloIds.length > 0 ||
      beamIds.length > 0 ||
      ondeIds.length > 0 ||
      reactedIds.length > 0 ||
      burntIds.length > 0 ||
      poisonedIds.length > 0 ||
      collidedIds.length > 0 ||
      blastIds.length > 0
        ? [
            ...haloIds,
            ...beamIds,
            ...ondeIds,
            ...deadIds,
            ...reactedIds,
            ...burntIds,
            ...poisonedIds,
            ...collidedIds,
            ...blastIds,
          ]
        : deadIds;
    if (allDead.length > 0) {
      this.#totalKills += allDead.length;
      this.#pendingDeaths.push({ tick: this.#tick, ids: allDead });
      this.#afterDeaths(allDead);
      // ⚠️ **LE palier avance ICI, et nulle part ailleurs** : un second chemin
      // de mort pour le boss casserait le rejeu (voir ci-dessus). C'est une
      // MORT, pas un tick : une equipe qui peine reste plus longtemps, une
      // equipe qui domine avance.
      // ⚠️ **Chaque boss abattu paie son palier et fait monter la difficulte**
      // mais ne termine rien : le portail a son propre rythme
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
      // Le porteur tombe dans CE lot, le seul du tick (meme regle
      // que le boss). Il doit un coffre ; `step` l'ouvrira au tick suivant.
      if (this.#porteur !== null && allDead.includes(this.#porteur)) {
        this.#porteur = null;
        this.#chestsOwed++;
        this.#director.porteurGone();
      }
    }

    // Un boss retire de la horde hors du lot de morts (bancs, tests) ne doit pas
    // rester « vivant » ici : la barre et la charge suivraient un fantome.
    if (this.#bosses.some((id) => this.horde.slotOf(id) < 0)) {
      this.#bosses = this.#bosses.filter((id) => this.horde.slotOf(id) >= 0);
    }

    // Meme garde pour le porteur : retire hors du lot (bancs, tests), il ne
    // doit AUCUN coffre — mais le directeur doit etre relache, sinon plus
    // aucun porteur pour le reste de la run.
    if (this.#porteur !== null && this.horde.slotOf(this.#porteur) < 0) {
      this.#porteur = null;
      this.#director.porteurGone();
    }

    // ⚠️ **APRES le deplacement de la horde, AVANT le contact ordinaire.** Le
    // corps qui blesse est celui que `Horde.step` vient de poser sur le
    // couloir ce tick-ci ; et toucher avant `resolveContact` est ce qui laisse
    // l'invulnerabilite posee par la charge produire son effet des le tick
    // suivant plutot qu'un tick plus tard.
    // L'armure effective du tick, juste avant les DEUX
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
        hurtPlayer(p, SHOT_DAMAGE);
        p.contactInvulnTicks = CONTACT_INTERVAL_TICKS;
      }
    });
    resolveContact([...this.#players.values()], this.horde);
    this.#regenerate();
    // `step` retourne plus haut pendant le gel et pendant un etalage ouvert :
    // le bouclier ne se regenere donc pas pendant une montee de niveau.
    this.#regenerateShield();

    // Contagion : les morts de CE tick, ou qu'elles viennent (`OrbField.spawn`
    // les note toutes). Drainee a chaque tick, porteur ou pas, pour que la
    // file ne s'accumule jamais ; le `some` evite le balayage de
    // `spreadMarkOnDeath` quand personne ne porte la carte.
    const fallenMarks = this.#orbs.drainFallen();
    if (
      fallenMarks.length > 0 &&
      [...this.#players.values()].some((p) => p.loadout.hasRule('contagion'))
    ) {
      spreadMarkOnDeath(this.horde, fallenMarks, this.#tick);
    }

    const pickedIds = this.#orbs.resolvePickups(
      [...this.#players.values()].map((p) => ({
        x: p.x,
        y: p.y,
        pickupRadius: this.#pickupRadiusOf(p),
      })),
    );
    if (pickedIds.length > 0) {
      this.#pendingPickups.push({ tick: this.#tick, ids: pickedIds });
      // ⚠️ **La NATURE d'un ramassage se lit dans son IDENTITE** : `dropsCoin`
      // et `dropsOrb` sont disjoints, donc `PICKUPS` n'a pas besoin d'un octet
      // de plus pour dire ce qui a ete pris.
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
    // ⚠️ **APRES `#checkRunOver`, et SANS garde de fin de run.** Si l'equipe
    // est effacee au tick ou le portail tranche, l'effacement a deja ramene la
    // cagnotte a `WIPE_GOLD_KEPT` : un « partir » resolu juste apres majore
    // cette cagnotte-la, ce que le snapshot du meme tick dit aussi.
    //
    // Rien au-dessus de cette ligne ne consulte le portail : le monde a tourne
    // tout entier pendant le vote.
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
        shield: p.shield,
      });
    }

    // ⚠️ **La vie du boss est LUE DANS LA HORDE a chaque tick, jamais tenue en
    // double** : un champ `#bossHp` a cote finirait par se decaler.
    //
    // `slotOf` rend `-1` quand l'entite n'est plus la : le `?? 0` couvre un
    // boss retire de la horde hors du lot de morts (les bancs, `Horde.kill`).
    const bossId = this.#bosses[0] ?? null;
    const boss =
      bossId === null ? null : { id: bossId, hp: this.horde.hp[this.horde.slotOf(bossId)] ?? 0 };

    const started = performance.now();
    // `#xp`, `#synergy`, `#gold` et le boss dans l'EN-TETE : donnees
    // d'equipe, aucun bloc de joueur ne les porte.
    //
    // ⚠️ **L'or part a CHAQUE tick, pas au vote** : c'est l'enjeu du portail,
    // et il bouge pendant la fenetre.
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
   * Applique l'effet d'un verbe et construit son annonce.
   *
   * ⚠️ **Toute branche DOIT rendre `null` explicitement sur un refus** : voir
   * `useAbility`, qui ne pose la recharge que sur une annonce.
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
   * ⚠️ **Une classe ne porte jamais d'element** : Amorce emprunte celui de
   * l'ARME, ce qui la laisse compatible avec l'exclusivite des armes. Le repli
   * sur l'arme neutre garde le verbe utilisable sur un loadout vide, que le
   * salon autorise (`NO_WEAPON`).
   */
  #armeAmorce(p: PlayerState): number {
    return p.loadout.weaponIds[0] ?? BASE_WEAPON_ID;
  }

  /**
   * Pose la zone d'Amorce : l'element de l'arme du joueur, a REACTION NULLE,
   * donc sans degats — elle marque, elle ne brule pas.
   *
   * ⚠️ **L'annonce est poussee ICI, et pas laissee a `#announceZones()`**,
   * qui ne pousse que les zones dont `bornTick === this.#tick` apres `tick++`.
   * `useAbility` est appelee ENTRE deux pas : la zone porterait un `bornTick`
   * deja perime au pas suivant et ne serait **jamais** annoncee, divergence
   * qu'aucun test du serveur seul ne verrait.
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
   * ⚠️ **Les PV mis a l'echelle NE VOYAGENT PAS** : le client ne lit jamais
   * `Horde.hp`, il apprend qui meurt par `DEATHS`.
   * `shared/horde.replication.test.ts` verifie qu'un serveur a PV mis a
   * l'echelle et un client a PV bruts ne derivent pas. La regle (pietaille
   * LEGERE exemptee) vit dans `palierHp`.
   *
   * ⚠️ **LE BOSS NE PASSE PAS PAR ICI** : `step` ecrit sa reserve par `bossHp`,
   * qui contient deja `palierHp`.
   *
   * ⚠️ **`horde.hp[i]` doit etre la reserve d'archetype intacte** : `palierHp`
   * decide sur cette valeur, donc cet appel doit preceder tout degat.
   */
  #scalePalierHp(depuis: number): void {
    const palier = this.#director.palier;
    for (let i = depuis; i < this.horde.count; i++) {
      this.horde.hp[i] = palierHp(this.horde.hp[i] ?? 0, palier);
    }
  }

  /**
   * La charge du boss, en un seul endroit : elle blesse si elle traverse, et
   * elle s'annonce si l'heure est venue.
   *
   * ⚠️ **UN SEUL MESSAGE, A L'ANNONCE** : la POSITION du boss pendant toute la
   * charge se derive de ses nombres, des deux cotes.
   *
   * ⚠️ **La direction se lit sur les positions COURANTES**, pas celles,
   * retardees, du flowfield : c'est un arbitrage serveur, le client la recoit
   * figee.
   *
   * ⚠️ **Une charge en cours n'en annonce pas une autre** : deux charges sur
   * la meme entite se disputeraient sa position en silence.
   *
   * ⚠️ **Le cooldown se mesure depuis la FIN de la charge**, pas depuis son
   * annonce : sinon le rythme dependrait de la duree de la traversee.
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

    // ⚠️ **UNE SEULE garde decide qu'une nouvelle charge peut partir :
    // `#nextChargeTick`** (`endTick + BOSS_CHARGE_COOLDOWN_TICKS`), au-dela de
    // la charge en cours tant que ce delai est non nul, ce que
    // `shared/boss.test.ts` garde.
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

    // Le joueur VIVANT le plus proche, comme `Horde.retarget` : la charge
    // prolonge la marche du boss au lieu de la contredire.
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
      // Personne de vivant a viser : surtout pas de couloir dans une direction
      // par defaut. La run se termine de toute facon (`#checkRunOver`).
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
   * `bornTick === #tick` EST la trace de la pose : la fusion ecrit le tick
   * courant quand elle cree comme quand elle rafraichit. Un balayage borne par
   * `ZONE_CAPACITY`, plutot qu'une allocation par impact.
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
   * Les pulsations de halo du tick, remplies par `#fireOne` et
   * videes par `resolveHalos` dans `step`.
   *
   * ⚠️ **Vide a la fin de chaque tick**, jamais entre deux : une pulsation qui
   * survivrait frapperait deux fois.
   */
  readonly #haloPulses: HaloPulse[] = [];

  /** Les traits de faisceau du tick — meme vie que `#haloPulses` juste au-dessus. */
  readonly #beamPulses: BeamPulse[] = [];

  /**
   * Les invocations posees et encore vivantes.
   *
   * ⚠️ **Elles SURVIVENT au tick, contrairement aux deux reserves
   * ci-dessus** : une invocation tient plusieurs secondes et frappe
   * periodiquement. C'est `#pulseGuards` qui la purge quand elle s'eteint.
   */
  #guards: Guard[] = [];

  /**
   * Les ondes vivantes : comme les invocations, elles SURVIVENT au
   * tick, et `step` oublie celles qui n'auront plus de bande a balayer.
   */
  #ondes: Onde[] = [];

  /** Les impacts de frappe en attente de leur echeance. */
  #frappes: FrappeImpact[] = [];

  /**
   * Ou est le tireur `by` maintenant, pour l'orbite et le boomerang.
   * Une seule fonction pour la vie de la salle, et `PlayerState` EST un
   * `{x, y}` : rien n'est alloue par projectile ni par tick.
   */
  readonly #anchor: Anchor = (by) => this.#players.get(by);

  /**
   * Verse dans `#haloPulses` les impacts de frappe echus et les oublie.
   *
   * ⚠️ **Le gel ne les retient pas** : `frappeIsDue` compare en `>=`, donc un
   * impact du pendant un gel tombe au premier tick de la reprise, au point
   * fige au tir.
   */
  #dropFrappes(tick: number): void {
    if (this.#frappes.length === 0) {
      return;
    }
    for (const f of this.#frappes) {
      if (frappeIsDue(f, tick)) {
        this.#haloPulses.push({
          x: f.x,
          y: f.y,
          radius: f.radius,
          damage: f.damage,
          element: f.element,
          by: f.by,
        });
      }
    }
    this.#frappes = this.#frappes.filter((f) => !frappeIsDue(f, tick));
  }

  /**
   * Verse une pulsation par invocation DUE a ce tick, et oublie celles qui se
   * sont eteintes.
   *
   * ⚠️ **Elle alimente `#haloPulses`, elle ne resout rien** : une invocation
   * frappe comme un halo centre sur son invocateur (`guardCenter`).
   */
  #pulseGuards(tick: number): void {
    if (this.#guards.length === 0) {
      return;
    }
    for (const guard of this.#guards) {
      if (!guardPulsesAt(guard, tick)) {
        continue;
      }
      // Le centre SUIT l'invocateur : l'aura brule autour de lui.
      const centre = guardCenter(guard, this.#anchor);
      this.#haloPulses.push({
        x: centre.x,
        y: centre.y,
        radius: guard.radius,
        damage: guard.damage,
        element: guard.element,
        by: guard.by,
      });
    }
    this.#guards = this.#guards.filter((g) => guardIsAlive(g, tick));
  }

  /**
   * Tire les salves dues : chaque joueur vivant dont la visee n'est pas nulle
   * tire, pour chaque arme dont la recharge est faite, dans la direction qu'il
   * vise. La cadence est automatique, la DIRECTION est une entree joueur.
   *
   * Une visee nulle (curseur pile sur le joueur, souris jamais bougee) ne tire
   * pas : c'est deterministe, une direction par defaut ne le serait pas.
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
      for (const id of p.loadout.weaponIds) {
        this.#fireOne(p, id, tick);
      }
    }
  }

  /**
   * Tire une salve de cette arme si sa propre recharge est faite. Le catalogue
   * `WEAPONS` n'est JAMAIS modifie : les bonus se calculent a chaque tir.
   */
  #fireOne(p: PlayerState, weaponId: number, tick: number): void {
    // Ses bonus propres ET ceux des passifs (Volee, Ampleur) appliques — la
    // MEME fonction que le miroir client (`shared/firing.ts`).
    const weapon = armedWeapon(p.loadout, weaponId);
    const cooldown = cooldownWithBonus(
      weapon.cooldownTicks,
      p.loadout.bonus('fireRate') +
        p.accountBonuses.fireRate +
        FIRE_RATE_PER_UPGRADE * p.loadout.upgradesOf(weaponId, UPGRADE.FIRE_RATE),
    );
    if (tick - (p.lastFireTick[weaponId] ?? Number.NEGATIVE_INFINITY) < cooldown) {
      return;
    }
    const damage = shotDamage(weapon, p.loadout, p.accountBonuses.damage, p.maxHp);
    if (weapon.kind === 'halo') {
      // ⚠️ **Le halo ne tire rien : il met une PULSATION en file** : `step`
      // reste le seul endroit ou une mort se prononce (un seul `DEATHS`).
      //
      // Le filtre de visee nulle de `#fireWeapons` s'applique quand meme : un
      // halo dont le porteur ne vise rien ne pulse pas. Limite assumee.
      this.#haloPulses.push({
        x: p.x,
        y: p.y,
        radius: weapon.blastRadius,
        damage,
        element: weapon.element,
        by: p.id,
      });
      p.lastFireTick[weaponId] = tick;
      return;
    }
    if (weapon.kind === 'invocation') {
      // ⚠️ **Elle ne frappe pas ICI** : elle entre dans `#guards`, et c'est
      // `#pulseGuards` qui en tirera une pulsation tous les
      // `GUARD_PULSE_TICKS` jusqu'a son extinction.
      this.#guards.push({
        x: p.x,
        y: p.y,
        bornTick: tick,
        lifeTicks: weapon.projectileLifeTicks,
        radius: weapon.blastRadius,
        damage,
        element: weapon.element,
        by: p.id,
      });
      p.lastFireTick[weaponId] = tick;
      return;
    }
    if (weapon.kind === 'faisceau') {
      // La visee donne la DIRECTION, la portee la longueur ; les deux bouts du
      // trait sont derives ici. La visee n'est PAS unitaire : voir `aimPoint`.
      const bout = aimPoint(p.x, p.y, p.aimX, p.aimY, beamRange(weapon));
      this.#beamPulses.push({
        x: p.x,
        y: p.y,
        toX: bout.x,
        toY: bout.y,
        width: weapon.blastRadius,
        damage,
        element: weapon.element,
        by: p.id,
      });
      p.lastFireTick[weaponId] = tick;
      return;
    }
    if (weapon.kind === 'onde') {
      // Centre fige au point de tir ; `resolveOndes` la fait frapper des ce
      // tick, bande `[0, 0]`.
      this.#ondes.push({
        x: p.x,
        y: p.y,
        bornTick: tick,
        speed: weapon.projectileSpeed,
        maxRadius: weapon.blastRadius,
        damage,
        element: weapon.element,
        by: p.id,
      });
      p.lastFireTick[weaponId] = tick;
      return;
    }
    if (weapon.kind === 'frappe') {
      // Le point vise est a PORTEE dans la direction visee, et les cibles
      // sont figees ICI : l'ennemi qui bouge pendant le delai l'esquive.
      //
      // La visee n'est PAS unitaire : voir `aimPoint`.
      const vise = aimPoint(p.x, p.y, p.aimX, p.aimY, beamRange(weapon));
      const dueTick = frappeDueTick(tick);
      for (const pt of frappeTargets(this.horde, vise.x, vise.y, weapon.projectileCount)) {
        this.#frappes.push({
          x: pt.x,
          y: pt.y,
          radius: weapon.blastRadius,
          damage,
          element: weapon.element,
          by: p.id,
          dueTick,
        });
      }
      p.lastFireTick[weaponId] = tick;
      return;
    }
    const count = weapon.projectileCount;
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
      critOf(p.loadout),
    );
    p.lastFireTick[weaponId] = tick;
  }

  /**
   * Ouvre un etalage : tire les cartes, met en file le `LEVEL_UP` **date du
   * tick courant** et le `DRAFT_OPEN`.
   *
   * ⚠️ Le `LEVEL_UP` est date d'ici, pas de `#gainXp` : c'est ici que le gel
   * commence. Les clients figent au tick indique, pas a la reception, sans
   * quoi chacun figerait selon sa latence.
   *
   * ⚠️ **Un coffre passe AVANT un niveau.** Le seul cas de file est « coffre et
   * niveau dus au meme tick » (le monde est gele pendant un etalage) : le
   * client sait alors, sans octet, que le premier `LEVEL_UP` apres la mort du
   * porteur est le coffre.
   */
  #openDraft(): void {
    const coffre = this.#chestsOwed > 0;
    if (coffre) {
      this.#chestsOwed--;
    } else {
      this.#pendingLevels--;
    }
    const loadouts = new Map<number, Loadout>();
    for (const [id, p] of this.#players) {
      loadouts.set(id, p.loadout);
    }
    const spread = drawSpread(
      loadouts,
      this.#draftRng,
      coffre ? CHEST_RARITY_FLOOR : RARITY.COMMUNE,
    );
    this.#draft.open(this.#tick, spread, [...this.#players.keys()], loadouts);
    // ⚠️ **Le niveau annonce pour un coffre est celui d'AVANT tout niveau
    // encore en file.** `#level` inclut deja les niveaux montes mais pas
    // encore tires (`#pendingLevels`) : sans la soustraction, le client
    // jouerait le son de niveau un etalage trop tot. Un niveau ordinaire vient
    // de decrementer `#pendingLevels` et annonce `#level`.
    const niveauAnnonce = coffre ? this.#level - this.#pendingLevels : this.#level;
    this.#pendingLevelUps.push({ tick: this.#tick, level: niveauAnnonce });
    this.#pendingDraftOpens.push({ deadlineTick: this.#draft.deadlineTick, cards: spread });
  }

  /**
   * Fait avancer l'etalage d'un tick. Quand une phase se ferme, applique les
   * cartes et met le resultat en file.
   *
   * ⚠️ **`deadlineTick` du resultat porte la fin du gel.** Le client ne peut
   * pas la deduire (la fenetre se ferme quand tous ont pose leur jeton) : sans
   * ce champ, chaque client en devinerait une differente.
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
   * Ouvre le vote d'extraction. ⚠️ **Le multiplicateur part AVEC l'ouverture,
   * une seule fois** : constant sur toute la fenetre, il ne se repete pas dans
   * chaque snapshot.
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

  /**
   * Fait avancer le vote d'un tick, et applique son verdict quand il tombe.
   *
   * ⚠️ **`decision === null` et « rester » (`0`) sont tous deux faux en JS** :
   * comparer a `null`, jamais tester la verite du retour.
   *
   * Partir reutilise `RUN_OVER` via `#endRun` : extraction et effacement
   * finissent par le meme evenement, et c'est l'OR (dans le `SNAPSHOT`) qui
   * les distingue.
   */
  #stepPortal(): void {
    const decision = this.#portal.step(this.#tick);
    if (decision === null) {
      return;
    }
    if (decision === VOTE_CHOICE.LEAVE) {
      // ⚠️ **La seule ligne du fichier qui MAJORE l'or**, via `extractGold` :
      // la borne du fil (`GOLD_MAX`) et l'arrondi vivent avec la formule.
      this.#gold = extractGold(this.#gold, this.#extractMultiplier);
      this.#endRun();
    } else {
      // Rester laisse la cagnotte NON SECURISEE, c'est tout le risque ; ce qui
      // monte, c'est ce qu'elle vaudra au bout du palier suivant.
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
   * **Le seul chemin par lequel une carte entre dans un inventaire** : passer
   * par `loadoutOf(id).addPassive(...)` sauterait le soin.
   */
  grantCard(playerId: number, card: Card): void {
    const player = this.#players.get(playerId);
    if (!player) {
      return;
    }
    // La traduction « carte -> inventaire » vit dans `shared/` : le client la
    // relit pour son propre miroir.
    applyCardToLoadout(player.loadout, card);
    if (card.nature === CARD.PASSIVE) {
      // ⚠️ Le gain de vie maximum est AUSSI un soin du meme montant, sans quoi
      // « vitalite » ne se verrait qu'apres avoir encaisse des degats. Hors
      // `applyCardToLoadout` : `hp`/`maxHp` sont des champs de `PlayerState`,
      // que le client n'arbitre jamais.
      const nouveauMax = maxHpOf(player.loadout, player.accountBonuses.maxHp);
      // ⚠️ **Borne.** Le delta brut tuerait un joueur blesse sur une carte a
      // malus de PV max : un vivant reste vivant (plancher a 1), et `hp` ne
      // depasse jamais le nouveau maximum.
      //
      // ⚠️ **Un mort reste a zero, jamais sous zero** : le draft peut attribuer
      // une carte a un mort (`AUTO`), et un `hp` negatif, encode en `u16` sur
      // le fil, montrerait un mort a PV quasi plein.
      const vivant = player.hp > 0;
      player.hp = player.hp + (nouveauMax - player.maxHp);
      player.hp = Math.min(nouveauMax, player.hp);
      player.hp = Math.max(vivant ? 1 : 0, player.hp);
      player.maxHp = nouveauMax;
      // ⚠️ **Ouvre la reserve, ne la remplit pas**, contrairement a `hp`
      // ci-dessus : le bouclier se recharge par `#regenerateShield`.
      player.maxShield = maxShieldOf(player.loadout);
    }
  }

  /**
   * Rend a chaque joueur vivant les points de vie de ses cartes « regain » :
   * se soigner est un CHOIX DE CONSTRUCTION.
   *
   * ⚠️ **Borne par `maxHp`, jamais par `PLAYER_MAX_HP`** : le plafond est
   * PERSONNEL et suit les cartes de vitalite.
   *
   * ⚠️ **Un joueur MORT ne regenere pas, et c'est le seul garde qui le dit** :
   * sans lui, `#checkRunOver` verrait la run repartir. D'ou aussi l'appel
   * APRES `resolveContact` : un joueur acheve ce tick-ci ne se releve pas.
   *
   * `hp` devient FRACTIONNAIRE (points par seconde / `TICK_HZ`) ;
   * `encodeSnapshot` le tronque en `u16`, et la borne `maxHp` le garde
   * transportable.
   *
   * ⚠️ **Le TICK, pas le `dt` mis a l'echelle** : la rampe de reprise
   * (`#movementScale`) ne module que ce qui BOUGE.
   */
  #regenerate(): void {
    for (const p of this.#players.values()) {
      if (p.hp <= 0) {
        continue;
      }
      // Pas de garde `bonus <= 0` : a bonus nul la borne rend `hp`, puisque
      // `grantCard` maintient `hp <= maxHp`.
      p.hp = Math.min(
        p.maxHp,
        p.hp + (p.loadout.bonus('regen') + p.accountBonuses.regen) / TICK_HZ,
      );
    }
  }

  /**
   * Regeneration du bouclier : `SHIELD_CALM_TICKS` sans
   * degat avant que la reserve reprenne, puis `SHIELD_REGEN_PER_SEC` par
   * seconde jusqu'au plafond.
   *
   * ⚠️ **Appelee APRES les retours de gel et d'etalage de `step`** : c'est la
   * SEULE chose qui empeche une montee de niveau de recharger le bouclier.
   *
   * ⚠️ **Decale d'UN tick** : `hurtPlayer` remet `shieldCalmTicks` a zero puis
   * cette methode l'incremente dans la MEME passe, donc la reserve reprend
   * `SHIELD_CALM_TICKS - 1` ticks apres celui du coup.
   */
  #regenerateShield(): void {
    for (const p of this.#players.values()) {
      if (p.hp <= 0 || p.maxShield === 0) {
        continue;
      }
      p.shieldCalmTicks++;
      if (p.shieldCalmTicks >= SHIELD_CALM_TICKS && p.shield < p.maxShield) {
        p.shield = Math.min(p.maxShield, p.shield + SHIELD_REGEN_PER_SEC / TICK_HZ);
      }
    }
  }

  /**
   * Rayon de ramassage de CE joueur : `ORB_PICKUP_RADIUS` plus ses achats
   * d'aimant.
   */
  #pickupRadiusOf(p: PlayerState): number {
    return ORB_PICKUP_RADIUS + p.accountBonuses.pickupRadius;
  }

  /**
   * Facteur applique au `dt` de tout ce qui bouge : une rampe de `0` (exclu) a
   * `1` pendant les `LEVEL_RESUME_TICKS` qui suivent un gel, `1` sinon.
   *
   * ⚠️ **La reprise doit etre PROGRESSIVE** : sans rampe, un monstre colle au
   * joueur au moment du gel le touche des le premier tick de la reprise.
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
   * franchit. Une boucle plutot qu'un `if` : un gros lot de ramassages peut
   * franchir plusieurs seuils d'un coup.
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
      // On compte seulement les niveaux dus : le gel dure jusqu'a la fermeture
      // du draft, et `step` ouvre le suivant quand le precedent se referme.
      this.#pendingLevels++;
    }
  }

  /** Seuil pour passer du niveau courant au suivant. Voir `LEVEL_XP_BASE`. */
  #xpToNextLevel(): number {
    return LEVEL_XP_BASE * this.#level * Math.max(1, this.#players.size);
  }

  /**
   * Detecte la fin de run — tous les joueurs presents a 0 pv — et met
   * `RUN_OVER` en file **une seule fois**. Pas de garde sur `#runOver` ici :
   * celui de tete de `step()` porte seul cette garantie.
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
    // ⚠️ **La perte de l'or non securise vit ICI, sur cette seule ligne**, dans
    // le chemin de l'EFFACEMENT DE L'EQUIPE : la mort d'un joueur seul ne
    // coute rien, volontairement.
    //
    // ⚠️ **`WIPE_GOLD_KEPT`, jamais un `0` ecrit ici** : c'est un parametre de
    // playtest (voir sa doc dans `shared/constants.ts`).
    //
    // L'arrondi garde l'or entier : compteur affiche, `u32` sur le fil.
    this.#gold = Math.round(this.#gold * WIPE_GOLD_KEPT);
    this.#endRun();
  }

  /**
   * Termine la run : met `RUN_OVER` en file et arrete la simulation.
   *
   * **LE seul endroit qui termine une run**, par deux chemins : l'equipe
   * effacee (`#checkRunOver`) et l'equipe qui part par le portail
   * (`#stepPortal`), avec le meme message.
   *
   * Pas de garde « une seule fois » : le garde de tete de `step()` la porte.
   * Si les deux chemins tombaient au MEME tick, ils ecriraient le meme
   * evenement dans un champ unique, donc une seule fois sur le fil.
   *
   * ⚠️ **L'or n'est pas touche ici** : chaque chemin a fait son compte avant
   * (`WIPE_GOLD_KEPT` d'un cote, `extractGold` de l'autre).
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
