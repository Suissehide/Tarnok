import {
  ABILITY_COOLDOWN_TICKS,
  type AbilityUsed,
  DECOY_LIFETIME_TICKS,
  VERB_IDS,
} from '@shared/abilities';
import { archetypeIdOf, archetypeOf, NECRO_CHILD, PORTEUR_ARCHETYPE } from '@shared/archetypes';
import type { BossCharge } from '@shared/boss';
import { applyCardToLoadout, type Card } from '@shared/cards';
import { chainTargets } from '@shared/chain';
import { classOf } from '@shared/classes';
import {
  CHAIN_JUMPS,
  CHAIN_RADIUS,
  CONTACT_RADIUS,
  FIELD_INPUT_DELAY_TICKS,
  FLOWFIELD_CELL,
  FLOWFIELD_HZ,
  INPUT_HZ,
  LEVEL_RESUME_TICKS,
  MAP_SIZE,
  MAX_ENTITIES,
  MAX_PLAYERS,
  PLAYER_SPEED,
  PROJECTILE_CAPACITY,
  ROLLBACK_DEPTH_TICKS,
  TICK_HZ,
  ZONE_RADIUS,
} from '@shared/constants';
import { type Decoy, substituteDecoys } from '@shared/decoys';
import { ELEMENT } from '@shared/elements';
import { EnemyShots } from '@shared/enemy-shots';
import { EVENT_KIND, EVENT_OUTCOME, EVENT_STATE_PERIOD_TICKS } from '@shared/evenements';
import { aimPoint, armedWeapon, critOf, shotDamage } from '@shared/firing';
import { FlowField } from '@shared/flowfield';
import { entityIdOf, Horde, leavesDrop, pushOutOfGuards } from '@shared/horde';
import { HordeHistory } from '@shared/horde-history';
import { Loadout, maxHpOf } from '@shared/loadout';
import {
  FRAPPE_DELAY_TICKS,
  type FrappeImpact,
  frappeDueTick,
  frappeIsDue,
  frappeTargets,
  type Onde,
  ondeBand,
} from '@shared/onde-frappe';
import { PlayerHistory } from '@shared/player-history';
import { type Anchor, distanceToSegmentSquared, Projectiles } from '@shared/projectiles';
import {
  type AbilityUsedMessage,
  type BossChargeMessage,
  decode,
  type EventMessage,
  encodeAbility,
  encodeDraftToken,
  encodeHello,
  encodeInput,
  encodePick,
  encodePing,
  encodeStart,
  encodeVote,
  type LobbyMessage,
  MSG,
  NO_WEAPON,
  OUTCOME,
  type PingShownMessage,
  type PlayerSnapshot,
  quantizeAxis,
  type WaveOrderMessage,
  type ZoneMessage,
  zoneElement,
} from '@shared/protocol';
import { BONUS_ZERO, type BonusKind } from '@shared/shop';
import { FORMATION } from '@shared/waves';
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
import { applyObstacles, generateWorld, type WorldMap } from '@shared/worldmap';
import { ZoneField } from '@shared/zones';

import { SnapshotBuffer } from './interpolation';

/**
 * Combien de temps une annonce de verbe reste dans `abilityEvents`, pour le
 * rendu : plus que la plus longue vie d'un effet visible (zone de Rempart,
 * leurre), sans grossir sans fin.
 */
const ABILITY_EVENT_MEMORY_TICKS = 10 * TICK_HZ;

import { type MoveMap, PredictedPlayer } from './prediction';

/**
 * Une paire d'axes dans [-1, 1], pour le deplacement ET pour la visee : seule
 * leur INTERPRETATION differe (`readInput` vs `readAim`).
 */
export interface InputAxes {
  x: number;
  y: number;
}

/**
 * Masque d'obstacles livre au rendu, avec sa geometrie : `cols`/`rows`/
 * `cellSize` viennent du MEME `FlowField` que celui qui a genere `mask`,
 * jamais recalcules a cote.
 */
export interface ObstacleMap {
  mask: Uint8Array;
  cols: number;
  rows: number;
  cellSize: number;
  /** Le sol et le decor, pour le rendu en tuiles et la mini-carte. */
  world: WorldMap;
}

export interface RenderState {
  /** Identifiant du joueur local, ou null tant que le WELCOME n'est pas arrive. */
  localId: number | null;
  /** Experience de l'equipe — commune a tous, pas un champ par joueur. */
  xp: number;
  /**
   * Charge de la barre de Synergie, commune a toute l'equipe : un seul nombre
   * dans le snapshot, comme `xp`.
   *
   * Le client ne la calcule jamais : il l'affiche. Ce qui la fait monter
   * (deux joueurs differents a l'origine d'une reaction) est arbitre serveur,
   * et le bit qui en resulte voyage dans `REACTION`.
   */
  synergy: number;
  /** Positions a dessiner : les autres interpolees, la sienne predite. */
  players: PlayerSnapshot[];
  /** La classe de chaque joueur, lue au salon (`LOBBY`) : son unite a l'ecran. */
  classes?: ReadonlyMap<number, number>;
}

/**
 * Ce que ce client sait du boss vivant : ce que le `SNAPSHOT` transporte
 * (identite, PV courants) **plus le maximum qu'il lui a vu**, qui ne voyage pas.
 *
 * ⚠️ **Le maximum est OBSERVE, pas recu, et il ne peut pas etre derive** :
 * `bossHp(k, joueurs)` demande le palier `k`, qui ne voyage nulle part.
 * L'echelle de palier est appliquee cote serveur seul (`Room#step`).
 *
 * Consequence assumee : un client qui rejoint PENDANT un combat de boss prend
 * pour maximum les PV qu'il voit en arrivant. Sa barre demarre pleine puis se
 * vide correctement. Faire voyager le total couterait quatre octets par tick
 * pour une valeur qui ne bouge qu'a l'apparition du boss.
 */
export interface BossVitals {
  readonly id: number;
  /** PV courants, tels que le dernier snapshot les porte. */
  readonly hp: number;
  /** Le plus grand nombre de PV que ce client ait vu a CE boss. Voir ci-dessus. */
  readonly maxHp: number;
}

/**
 * Met a jour ce qu'on sait du boss a partir de ce que le snapshot en dit.
 * PURE, donc testable sans WebSocket.
 *
 * ⚠️ **Seul le changement d'IDENTITE remet le maximum a zero** : les boss
 * successifs n'ont pas les memes PV (`hpScale`). La sentinelle est sur
 * l'identite, jamais sur les PV : un boss a 0 PV est un boss, il meurt au tick
 * suivant par `DEATHS` (voir `NO_BOSS_ID` dans `shared/protocol.ts`), et le
 * lire comme une absence ferait disparaitre sa barre juste avant sa mort.
 */
export function trackBoss(
  previous: BossVitals | null,
  seen: { id: number; hp: number } | null,
): BossVitals | null {
  if (seen === null) {
    return null;
  }
  if (previous === null || previous.id !== seen.id) {
    return { id: seen.id, hp: seen.hp, maxHp: seen.hp };
  }
  return { id: seen.id, hp: seen.hp, maxHp: Math.max(previous.maxHp, seen.hp) };
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

/**
 * Tolerance de retard du compteur de tick local de la horde sur le tick
 * serveur porte par le dernier snapshot recu.
 *
 * Volontairement asymetrique et serree. Etre EN AVANCE du tick serveur connu
 * est normal (le dernier snapshot decrit toujours un instant passe) et ne doit
 * jamais recaler : ce serait figer le compteur sur un tick perime et annuler
 * l'absorption de latence de `FIELD_INPUT_DELAY_TICKS`. Etre EN RETARD
 * n'arrive qu'apres une perte de pas (onglet en arriere-plan) et doit se
 * corriger aussitot : le flowfield est assez sensible pour qu'un retard
 * persistant de deux ticks au lieu d'un fasse deriver la horde de centaines
 * de pixels (voir `shared/horde.replication.test.ts`, scenarios C1).
 */
const HORDE_TICK_LAG_TOLERANCE = 1;

/** Pas fixe de la simulation de horde, partage entre l'avancement normal et le rejeu. */
const FIXED_DT = 1 / TICK_HZ;

/** Cadence de rafraichissement du champ, en pas : meme calcul que `Room.step` et `Horde.replication.test.ts`. */
const STEPS_PER_FIELD = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));

/** Un lot de morts en attente d'application, tel que recu par `DEATHS`. */
interface PendingDeathBatch {
  tick: number;
  ids: number[];
}

/** Une explosion vue par le client : son centre et l'instant de la mort. */
export interface BlastFlash {
  x: number;
  y: number;
  bornMs: number;
  /** `releve` : un mort qui se releve sous le sort du necromancien. Absent : une explosion. */
  kind?: 'releve';
}

/** Duree de l'explosion a l'ecran, en ms. */
export const BLAST_FLASH_MS = 450;

/**
 * Duree du bandeau « Un porteur de coffre est apparu ! », en
 * horloge murale depuis la RECEPTION de son ordre — quelques ticks avant sa
 * naissance, au meme moment chez chacun.
 */
export const PORTEUR_BANNER_MS = 4000;

/**
 * Duree du bandeau d'un evenement (etape 14, §7.1), depart ou fin, en
 * horloge murale depuis la RECEPTION du message.
 */
export const EVENT_BANNER_MS = 4000;

/**
 * Le chariot est montre une periode d'`EVENT_STATE` en retard, interpole sur
 * elle (§6.2) : 200 ms, 12 px a 60 px/s. Les PV, eux, viennent du serveur.
 */
const CART_LERP_MS = (1000 * EVENT_STATE_PERIOD_TICKS) / TICK_HZ;

/** Le bandeau du depart, par genre (`EVENT_KIND`). */
const EVENT_START_BANNERS: readonly string[] = [
  "Les sceaux s'éveillent !",
  "La forge s'allume !",
  'Un convoi attend son escorte !',
];

/** Le bandeau de la fin, par issue (`EVENT_OUTCOME`). */
const EVENT_END_BANNERS: readonly string[] = [
  'Réussi — étalage de règles !',
  "L'événement s'éteint…",
  'Le convoi est détruit…',
];

/** Ce que l'ecran montre d'un evenement (etape 14) : HUD, sol, fleches de bord. */
export interface EventView {
  /** `EVENT_KIND`. */
  kind: number;
  /** Tels qu'`EVENT_START` les a portes : sceaux, forge, ou depart puis arrivee. */
  points: readonly { x: number; y: number }[];
  /** De 0 a 1. */
  progress: number;
  /** Sur `pingClock` : fige pendant le gel et la rampe, comme l'evenement au serveur. */
  secondsLeft: number;
  /** Le chariot interpole (convoi), `null` sinon. */
  cart: { x: number; y: number } | null;
  /** PV du chariot, de 0 a 1. */
  cartHp: number;
}

/** Le miroir d'un evenement en cours, tel que les messages l'ont dit. */
interface EventMirror {
  kind: number;
  points: readonly { x: number; y: number }[];
  /** Echeance sur `pingClock`, posee a la reception d'`EVENT_START`. */
  deadline: number;
  progress: number;
  cartFrom: { x: number; y: number };
  cartTo: { x: number; y: number };
  cartAtMs: number;
  cartHp: number;
}

/** Duree du sort de transformation (necromancien) : dix images, plus lent. */
export const RAISE_FLASH_MS = 800;

/** Combien de temps cet eclat reste a l'ecran. */
export function flashLifeMs(b: BlastFlash): number {
  return b.kind === 'releve' ? RAISE_FLASH_MS : BLAST_FLASH_MS;
}

/**
 * Orbes vivants, cote client — **derives des morts, jamais transmis**. Meme
 * raisonnement que `OrbField` cote serveur (`back/src/combat.ts`), duplique
 * ici plutot qu'importe : le client ne peut dependre que de `shared/`, et
 * `back/` connait `ws`/`fastify` (regle Biome).
 *
 * `PICKUPS` dit quelles identites ont ete ramassees ; l'existence et la
 * position de l'orbe, elles, ne transitent jamais — `GameClient` les pose a la
 * position de l'entite au moment de sa mort, lue depuis la horde restauree par
 * `HordeHistory` (voir `GameClient#applyDeaths`), avant compaction par `kill`.
 *
 * Tableaux types, jamais un objet par orbe, comme `Horde` et `Projectiles`.
 */
export class DerivedOrbs {
  /** Identite du monstre qui a laisse l'orbe. */
  readonly id: Uint32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Tick de la mort qui a fait apparaitre l'orbe : sert au calcul de peremption. */
  readonly bornTick: Uint32Array;
  #count = 0;

  constructor(readonly capacity: number) {
    this.id = new Uint32Array(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.bornTick = new Uint32Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  /**
   * Une mort DEMANDE un orbe ; toutes ne l'obtiennent pas.
   *
   * ⚠️ **La MEME garde que `OrbField.spawn`, cote serveur, des deux cotes.**
   * Le client derive l'orbe du seul `DEATHS` : une garde d'un seul cote
   * dessinerait des orbes que le serveur ne ramassera jamais, ou l'inverse.
   * Le predicat, `leavesDrop`, vit dans `shared/` pour n'exister qu'une fois.
   *
   * ⚠️ **La reserve tient les orbes ET les PIECES**, sans les distinguer : leur
   * nature se relit de l'identite (`dropsOrb` / `dropsCoin`, disjoints) au
   * moment de les dessiner.
   *
   * Ignore silencieusement si la capacite (tres large) est atteinte.
   */
  spawn(entityId: number, x: number, y: number, tick: number): void {
    if (!leavesDrop(entityId)) {
      return;
    }
    if (this.#count >= this.capacity) {
      return;
    }
    const slot = this.#count++;
    this.id[slot] = entityId;
    this.x[slot] = x;
    this.y[slot] = y;
    this.bornTick[slot] = tick;
  }

  /**
   * Retire les orbes qu'un joueur vient de RAMASSER et les confie a `flights`,
   * qui les fait voler jusqu'a lui, meme s'il s'eloigne.
   *
   * ## La capture EST le ramassage
   *
   * ⚠️ **Le predicat est celui du serveur, au pixel pres.** C'est
   * `OrbField.resolvePickups` (`back/src/combat.ts`) qui arbitre ; les deux
   * comparent les MEMES positions repliquees, chacune au rayon DE SON PROPRE
   * joueur (`PickupTarget.pickupRadius`, transporte par le `SNAPSHOT` : le
   * rayon s'achete en boutique). Le vol part donc a l'instant ou le serveur
   * ramasse : **l'experience est deja acquise quand il commence**, il ne fait
   * que decorer un fait accompli. C'est ce qui autorise l'orbe a suivre un
   * joueur qui fuit sans mentir.
   *
   * ⚠️ **Le premier joueur a portee, pas le plus proche**, comme le serveur.
   * Effet seulement cosmetique : l'experience va a l'EQUIPE, seule la
   * trajectoire dessinee en depend.
   *
   * `PICKUPS` arrivera un aller-retour plus tard et ne trouvera plus rien a
   * retirer : `remove` ignore silencieusement une identite absente.
   */
  capture(players: readonly PickupTarget[], flights: OrbFlights, nowMs: number): void {
    // ⚠️ **Precalcule hors des deux boucles**, meme raisonnement que
    // `OrbField.resolvePickups` : un rayon par joueur recalcule dans la
    // boucle interne le serait pour chaque orbe ET chaque joueur.
    const r2 = players.map((p) => p.pickupRadius * p.pickupRadius);
    // Par indice DECROISSANT, meme raisonnement que `expire` et que
    // `OrbField.resolvePickups` : un orbe deplace dans un trou par la
    // compaction ne doit jamais etre saute ensuite.
    for (let i = this.#count - 1; i >= 0; i--) {
      const ox = this.x[i] ?? 0;
      const oy = this.y[i] ?? 0;
      for (let j = 0; j < players.length; j++) {
        const p = players[j];
        if (!p) {
          continue;
        }
        const dx = ox - p.x;
        const dy = oy - p.y;
        if (dx * dx + dy * dy <= (r2[j] ?? 0)) {
          flights.spawn(ox, oy, p.id, this.id[i] ?? 0, nowMs);
          this.#removeAt(i);
          break;
        }
      }
    }
  }

  /** Retire les orbes ramasses : identites recues par `PICKUPS`. */
  remove(entityIds: readonly number[]): void {
    for (const entityId of entityIds) {
      const slot = this.#slotOf(entityId);
      if (slot >= 0) {
        this.#removeAt(slot);
      }
    }
  }

  /*
   * ⚠️ **Pas de peremption des orbes, ni ici ni cote serveur** : l'xp ne
   * disparait pas. Si elle revenait, ce serait des DEUX cotes a la fois :
   * d'un seul, un orbe disparaitrait ici alors que le serveur le ramasse
   * encore, ou resterait a l'ecran sans `PICKUPS` a venir.
   *
   * `bornTick` sert a `OrbRenderer` pour la phase du scintillement.
   */

  #slotOf(entityId: number): number {
    for (let i = 0; i < this.#count; i++) {
      if (this.id[i] === entityId) {
        return i;
      }
    }
    return -1;
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.id[slot] = this.id[last] ?? 0;
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
      this.bornTick[slot] = this.bornTick[last] ?? 0;
    }
    this.#count = last;
  }
}

/**
 * Ce que la capture a besoin de connaitre d'un joueur : ou il est, et QUI il
 * est. `PlayerSnapshot` la satisfait sans rien declarer.
 *
 * **Jumelle de `PickupPoint`** (`back/src/combat.ts`), plus l'identite : le vol
 * doit retrouver le joueur A CHAQUE IMAGE pour le suivre.
 */
export interface PickupTarget {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** Rayon de ramassage de CE joueur, transporte par le `SNAPSHOT`. */
  readonly pickupRadius: number;
}

/**
 * Duree d'un vol d'orbe capturee, en millisecondes horloge murale : **le vol
 * n'arbitre rien** (voir `DerivedOrbs.capture`), le serveur ignore cette
 * constante.
 *
 * ⚠️ **Assez court pour que l'orbe DEPASSE un joueur qui fuit** : vitesse
 * moyenne `ORB_PICKUP_RADIUS / duree` bien au-dessus de `PLAYER_SPEED`. Plus
 * long, l'orbe trainerait derriere le joueur. `client.test.ts` garde ce
 * rapport.
 */
export const ORB_FLIGHT_LIFETIME_MS = 200;

/**
 * Capacite du reservoir de vols.
 *
 * Bien plus petite que `MAX_ENTITIES` : un vol vit 200 ms, et seuls les orbes
 * tenant dans un disque de `ORB_PICKUP_RADIUS` autour d'un joueur peuvent etre
 * captures ensemble. Meme ordre de grandeur que `REACTION_FLASH_CAPACITY`.
 */
const ORB_FLIGHT_CAPACITY = 64;

/**
 * Orbes CAPTUREES, en vol vers le joueur qui les a ramassees.
 *
 * ⚠️ **Une collection cosmetique, hors de `DerivedOrbs`, et c'est structurel.**
 * `DerivedOrbs` est le miroir de la reserve du serveur : une orbe ramassee n'y
 * est plus, donc un vol ne peut pas y vivre comme un drapeau. Il vit ici,
 * comme `HitFlashes` et `ReactionFlashes` : tableaux types, duree de vie en
 * millisecondes, aucun arbitrage.
 *
 * La position DESSINEE n'est pas stockee : elle se calcule a l'image, depuis
 * la position de depart, l'age du vol et la position COURANTE de la cible —
 * voir `orbFlightFraction` et `OrbRenderer.draw`. C'est ce qui fait qu'une
 * orbe suit un joueur qui fuit au lieu de viser l'endroit ou il etait.
 */
export class OrbFlights {
  /** Position de la CAPTURE : la ou l'orbe attendait au sol. Le vol part de la. */
  readonly fromX: Float32Array;
  readonly fromY: Float32Array;
  /** Identite du joueur vise — pas sa position : c'est la position courante qui compte. */
  readonly targetId: Uint32Array;
  /**
   * Identite du MONSTRE qui a laisse l'objet : elle dit sa nature
   * (`dropsCoin`). Sans elle, une piece capturee redeviendrait une orbe verte
   * en decollant. Purement local, rien de plus sur le fil.
   */
  readonly dropId: Uint32Array;
  /** Horloge murale de naissance (`performance.now()`), voir `ORB_FLIGHT_LIFETIME_MS`. */
  readonly bornMs: Float64Array;
  #count = 0;

  constructor(readonly capacity: number) {
    this.fromX = new Float32Array(capacity);
    this.fromY = new Float32Array(capacity);
    this.targetId = new Uint32Array(capacity);
    this.dropId = new Uint32Array(capacity);
    this.bornMs = new Float64Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  /** Lance un vol. Ignore silencieusement si la capacite est atteinte. */
  spawn(x: number, y: number, targetId: number, dropId: number, nowMs: number): void {
    if (this.#count >= this.capacity) {
      return;
    }
    const slot = this.#count++;
    this.fromX[slot] = x;
    this.fromY[slot] = y;
    this.targetId[slot] = targetId;
    this.dropId[slot] = dropId;
    this.bornMs[slot] = nowMs;
  }

  /**
   * Retire les vols arrives : `orbFlightFraction` vaut 1 exactement a
   * `ORB_FLIGHT_LIFETIME_MS`, donc la meme echeance decrit l'arrivee et la fin
   * de vie.
   */
  expire(nowMs: number): void {
    for (let i = this.#count - 1; i >= 0; i--) {
      if (nowMs - (this.bornMs[i] ?? 0) >= ORB_FLIGHT_LIFETIME_MS) {
        this.#removeAt(i);
      }
    }
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.fromX[slot] = this.fromX[last] ?? 0;
      this.fromY[slot] = this.fromY[last] ?? 0;
      this.targetId[slot] = this.targetId[last] ?? 0;
      this.dropId[slot] = this.dropId[last] ?? 0;
      this.bornMs[slot] = this.bornMs[last] ?? 0;
    }
    this.#count = last;
  }
}

/** Capacite du reservoir de flashes d'impact — un burst cosmetique reste petit, jamais toute la horde a la fois. */
const HIT_FLASH_CAPACITY = 128;

/**
 * Duree de vie d'un flash d'impact, en millisecondes horloge murale : un flash
 * court, pas un halo permanent. Pas en ticks : purement cosmetique, il n'a pas
 * a se calculer identiquement des deux cotes, et l'horloge murale l'anime
 * independamment de la cadence de simulation.
 */
export const HIT_FLASH_LIFETIME_MS = 220;

/**
 * Bilan de fin de run, tel que porte par `RUN_OVER`, sans `type`/`tick` qui
 * n'interessent que le protocole.
 */
export interface RunOverSummary {
  survivedTicks: number;
  level: number;
  kills: number;
}

/**
 * Flashs d'impact, cote client — purement cosmetiques, jamais arbitres.
 *
 * Nes de `Projectiles.collide` (voir `GameClient#advanceHorde`), qui ne
 * consomme que les projectiles du client et ne touche jamais `horde` ni `hp` :
 * ce n'est PAS de l'arbitrage de degats. Deux clients peuvent voir des flashs
 * legerement differents, sans consequence.
 *
 * Tableaux types : un burst d'impacts n'alloue jamais un objet par flash.
 */
export class HitFlashes {
  readonly x: Float32Array;
  readonly y: Float32Array;
  /**
   * Teinte du flash, 0xRRGGBB : celle de l'ARME qui vient de toucher
   * (`Weapon.look.tint`), recopiee a la naissance.
   *
   * ⚠️ **Recopiee, jamais relue au dessin** : le projectile est consomme par
   * `collide` a l'instant meme et son creneau deja reutilise quand le calque
   * dessine.
   *
   * ⚠️ **La teinte dit l'ARME, pas l'element** (garde par
   * `assertWeaponLooks`) : l'element se lit a la zone au sol et a la marque
   * sur l'ennemi. Teinte par l'element, chaque coup deviendrait une
   * mini-reaction, et les vraies reactions se perdraient dans le bruit.
   */
  readonly tint: Uint32Array;
  /**
   * Rayon du souffle, en pixels monde : `Weapon.blastRadius` recopie du
   * projectile qui vient de toucher. `0` pour la plupart des armes : le coup
   * ne touche que ce qu'il percute.
   *
   * ⚠️ **C'est le rayon qui DECIDE DE CE QUI MEURT** (`Projectiles.
   * blastRadiusAt`). Le flash s'y asservit exactement : plus large, il
   * promettrait des morts qui n'auront pas lieu ; plus etroit, il tuerait hors
   * du dessin.
   */
  readonly radius: Float32Array;
  /**
   * Degats du coup, recopies du projectile : la PUISSANCE de l'impact, qui
   * decide de la taille du flash et du nombre d'eclats.
   *
   * ⚠️ **Les degats BRUTS de l'arme, pas ce que l'ennemi a encaisse** : les PV
   * ne sont pas sur le fil et l'armure est arbitree serveur.
   */
  readonly power: Float32Array;
  /**
   * `1` si ce flash doit SECOUER la camera.
   *
   * ⚠️ **Par defaut, « ce coup a un souffle » ; le halo est l'exception.** Une
   * explosion est un EVENEMENT, un halo PULSE sans arret tant que le joueur le
   * porte : il rendrait la secousse permanente.
   */
  readonly shakes: Uint8Array;
  /** Horloge murale de naissance (`performance.now()`), voir `HIT_FLASH_LIFETIME_MS`. */
  readonly bornMs: Float64Array;
  #count = 0;

  constructor(readonly capacity: number) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.tint = new Uint32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.power = new Float32Array(capacity);
    this.shakes = new Uint8Array(capacity);
    this.bornMs = new Float64Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  /** Fait naitre un flash. Ignore silencieusement si la capacite (un burst reste petit) est atteinte. */
  spawn(
    x: number,
    y: number,
    tint: number,
    radius: number,
    power: number,
    nowMs: number,
    shakes = radius > 0,
  ): void {
    if (this.#count >= this.capacity) {
      return;
    }
    const slot = this.#count++;
    this.x[slot] = x;
    this.y[slot] = y;
    this.tint[slot] = tint;
    this.radius[slot] = radius;
    this.power[slot] = power;
    this.shakes[slot] = shakes ? 1 : 0;
    this.bornMs[slot] = nowMs;
  }

  /** Retire les flashs dont la duree de vie a expire. */
  expire(nowMs: number): void {
    for (let i = this.#count - 1; i >= 0; i--) {
      if (nowMs - (this.bornMs[i] ?? 0) >= HIT_FLASH_LIFETIME_MS) {
        this.#removeAt(i);
      }
    }
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
      this.tint[slot] = this.tint[last] ?? 0;
      this.radius[slot] = this.radius[last] ?? 0;
      this.power[slot] = this.power[last] ?? 0;
      this.shakes[slot] = this.shakes[last] ?? 0;
      this.bornMs[slot] = this.bornMs[last] ?? 0;
    }
    this.#count = last;
  }
}

/** Capacite du reservoir de chiffres de degats — meme ordre que les flashs d'impact. */
const DAMAGE_NUMBER_CAPACITY = 128;

/**
 * Duree de vie d'un chiffre de degats, en millisecondes d'horloge murale.
 *
 * ⚠️ **Bien plus longue qu'un flash d'impact, d'ou un reservoir a part** : un
 * nombre qui s'efface aussi vite qu'un flash ne se LIT pas, et le flash doit
 * rester court.
 */
export const DAMAGE_NUMBER_LIFETIME_MS = 700;

/**
 * Les chiffres de degats qui montent au-dessus des monstres.
 *
 * ⚠️ **Ce qu'ils affichent est ce que le TIR envoie, pas ce que l'ennemi
 * encaisse** : les PV ne sont pas sur le fil, l'armure et les flaques sont
 * arbitrees serveur. Le critique, lui, est DERIVE du tir, donc exact (voir
 * `Projectiles.critAt`).
 *
 * Tableaux types, comme `HitFlashes`.
 */
export class DamageNumbers {
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Le nombre a ecrire, deja arrondi : le rendu ne decide pas du format. */
  readonly amount: Float32Array;
  /** `1` pour un coup critique — il s'ecrit plus gros et rouge. */
  readonly crit: Uint8Array;
  /**
   * L'element qui a porte le coup, index dans `ELEMENTS` — `ELEMENT.NEUTRE`
   * quand l'arme n'en porte aucun.
   *
   * ⚠️ **Il voyage avec le chiffre pour que le rendu le TEINTE**, et c'est le
   * rendu qui choisit la couleur : celles de `ELEMENTS` disent la matiere au
   * sol, sur de l'herbe, a `ZONE_ALPHA` — un chiffre, lui, doit se lire par
   * dessus n'importe quoi. Voir `DAMAGE_TINTS`.
   */
  readonly element: Uint8Array;
  readonly bornMs: Float64Array;
  #count = 0;

  constructor(readonly capacity: number) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.amount = new Float32Array(capacity);
    this.crit = new Uint8Array(capacity);
    this.element = new Uint8Array(capacity);
    this.bornMs = new Float64Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  spawn(x: number, y: number, amount: number, crit: boolean, element: number, nowMs: number): void {
    if (this.#count >= this.capacity) {
      return;
    }
    const slot = this.#count++;
    this.x[slot] = x;
    this.y[slot] = y;
    this.amount[slot] = Math.max(1, Math.round(amount));
    this.crit[slot] = crit ? 1 : 0;
    this.element[slot] = element;
    this.bornMs[slot] = nowMs;
  }

  expire(nowMs: number): void {
    for (let i = this.#count - 1; i >= 0; i--) {
      if (nowMs - (this.bornMs[i] ?? 0) >= DAMAGE_NUMBER_LIFETIME_MS) {
        this.#removeAt(i);
      }
    }
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
      this.amount[slot] = this.amount[last] ?? 0;
      this.crit[slot] = this.crit[last] ?? 0;
      this.element[slot] = this.element[last] ?? 0;
      this.bornMs[slot] = this.bornMs[last] ?? 0;
    }
    this.#count = last;
  }
}

/**
 * Duree de vie d'un flash de reaction, en millisecondes horloge murale.
 *
 * ⚠️ **Deux fois `HIT_FLASH_LIFETIME_MS`** : l'etat persistant est discret, la
 * reaction spectaculaire. Le flash d'impact accompagne des dizaines de coups
 * par seconde et reste bref ; la reaction est rare et TUE, c'est la que passe
 * le budget VFX. Plus long, des reactions voisines se recouvriraient en un
 * halo continu.
 *
 * En millisecondes : un flash n'arbitre rien.
 */
export const REACTION_FLASH_LIFETIME_MS = 440;

/**
 * Capacite du reservoir de flashs de reaction.
 *
 * Bien plus petite que `HIT_FLASH_CAPACITY` (128) : une reaction demande deux
 * elements differents sur la meme cible, elle est rare par construction,
 * et la borne serveur « une reaction par ennemi et par tick » la borne encore.
 */
const REACTION_FLASH_CAPACITY = 64;

/**
 * Flashs de reaction, cote client — **annonces par le serveur**, jamais
 * derives, a la difference des flashs d'impact juste au-dessus.
 *
 * C'est la seule chose de tout le systeme elementaire que le client ne devine
 * pas : la reaction TUE, donc elle est arbitree serveur et
 * annoncee par `REACTION`. La teinte des ennemis, elle, est approximee
 * localement — voir `GameClient#markLocally`.
 *
 * Tableaux types, comme `HitFlashes`.
 */
export class ReactionFlashes {
  readonly x: Float32Array;
  readonly y: Float32Array;
  /**
   * Couple d'elements, tel qu'empaquete par `packElementPair` — deux quartets
   * dans un octet. Le rendu en derive sa teinte (`reactionTint`) ; ce fichier
   * ne l'interprete jamais.
   */
  readonly pair: Uint8Array;
  /**
   * `1` si cette reaction a charge la barre de Synergie, c'est-a-dire si deux
   * joueurs DIFFERENTS en sont a l'origine.
   *
   * ⚠️ **Le client ne recalcule PAS cette comparaison, il la lit** : le message
   * ne porte volontairement pas les deux identites, pour ne pas refaire
   * l'arbitrage cote client. Le TOTAL de la barre vit dans le `SNAPSHOT`.
   */
  readonly charged: Uint8Array;
  /** Horloge murale de naissance (`performance.now()`), voir `REACTION_FLASH_LIFETIME_MS`. */
  readonly bornMs: Float64Array;
  #count = 0;

  constructor(readonly capacity: number) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.pair = new Uint8Array(capacity);
    this.charged = new Uint8Array(capacity);
    this.bornMs = new Float64Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  /** Fait naitre un flash. Ignore silencieusement si la capacite est atteinte. */
  spawn(x: number, y: number, pair: number, charged: boolean, nowMs: number): void {
    if (this.#count >= this.capacity) {
      return;
    }
    const slot = this.#count++;
    this.x[slot] = x;
    this.y[slot] = y;
    this.pair[slot] = pair;
    this.charged[slot] = charged ? 1 : 0;
    this.bornMs[slot] = nowMs;
  }

  /** Retire les flashs dont la duree de vie a expire. */
  expire(nowMs: number): void {
    for (let i = this.#count - 1; i >= 0; i--) {
      if (nowMs - (this.bornMs[i] ?? 0) >= REACTION_FLASH_LIFETIME_MS) {
        this.#removeAt(i);
      }
    }
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
      this.pair[slot] = this.pair[last] ?? 0;
      this.charged[slot] = this.charged[last] ?? 0;
      this.bornMs[slot] = this.bornMs[last] ?? 0;
    }
    this.#count = last;
  }
}

/**
 * Nombre maximal de points d'une polyligne de chaine : le point d'impact, puis
 * au plus `CHAIN_JUMPS` sauts — voir `shared/chain.ts` (`chainTargets`).
 */
const CHAIN_FLASH_MAX_POINTS = 1 + CHAIN_JUMPS;

/**
 * Capacite du reservoir de flashs de chaine. Bien plus petite que
 * `HIT_FLASH_CAPACITY` (128) : une chaine ne nait que d'un impact de FOUDRE,
 * un sous-ensemble des impacts elementaires, eux-memes un sous-ensemble de
 * tous les impacts.
 */
const CHAIN_FLASH_CAPACITY = 32;

/**
 * Duree de vie d'un flash de chaine, en millisecondes horloge murale : meme
 * famille que `REACTION_FLASH_LIFETIME_MS` (evenement rare), pas
 * `HIT_FLASH_LIFETIME_MS`.
 *
 * ⚠️ Un flash seme a l'impact, pas une chaine redessinee chaque image depuis
 * la marque `FOUDRE` : ce serait O(horde) par ennemi marque et par image,
 * jusqu'a O(horde²) avec `#markInZones`, qui peut marquer toute la horde.
 */
export const CHAIN_FLASH_LIFETIME_MS = 260;

/**
 * Duree de vie d'un trait de faisceau (`ChainFlashes.owner >= 0`) : plus
 * longue que la chaine, le temps que la frappe, le corps et l'extinction du
 * rayon se lisent (voir `ChainRenderer`). Cosmetique : les degats sont deja
 * arbitres au tick du tir.
 */
export const BEAM_FLASH_LIFETIME_MS = 380;

/** Une onde telle que le client la dessine : celle du serveur, plus sa teinte et sa naissance murale. */
export interface OndeTrace extends Onde {
  readonly tint: number;
  /** Horloge murale du tir : le calque en interpole le rayon entre deux ticks. */
  readonly bornMs: number;
}

/** Un impact de frappe tel que le client le dessine — voir `GameClient.frappes`. */
export interface FrappeTrace extends FrappeImpact {
  readonly tint: number;
  /** Horloge murale du tir : l'avertissement se resserre sur `FRAPPE_DELAY_MS`. */
  readonly bornMs: number;
  /** Horloge murale de l'impact, `-1` tant qu'il est en attente. */
  struckMs: number;
}

/** Ondes dessinees a la fois : bien au-dela d'une onde par joueur et par cadence. */
export const ONDE_TRACE_CAPACITY = 32;
/** Impacts de frappe tenus a la fois (attente et eclair compris). */
export const FRAPPE_TRACE_CAPACITY = 64;
/** Duree de l'eclair d'une frappe, a l'horloge murale. Cosmetique. */
export const FRAPPE_BOLT_MS = 220;
/** Le delai d'une frappe a l'horloge murale, pour l'avertissement qui se resserre. */
export const FRAPPE_DELAY_MS = (FRAPPE_DELAY_TICKS * 1000) / TICK_HZ;

/**
 * Flashs de chaine de Foudre, cote client : purement cosmetiques, comme
 * `HitFlashes` (nes de `Projectiles.collide` sur les projectiles de ce
 * client, voir `GameClient#seedChainFlash`).
 *
 * ⚠️ **Le CHEMIN est FIGE a la naissance, jamais rederive.** La chaine du
 * serveur est un evenement PONCTUEL (`resolveProjectileDamage`,
 * `back/src/combat.ts`) : rappeler `chainTargets` a chaque image sur la horde
 * courante dessinerait une approximation qui bouge, pas ce que le serveur a
 * fait.
 *
 * Tableaux types a largeur FIXE (`CHAIN_FLASH_MAX_POINTS` par flash) : aucune
 * allocation par flash, pour quelques flottants perdus sur une chaine courte.
 */
export class ChainFlashes {
  /** Points aplatis : le point `p` du flash `slot` est a l'indice `slot * CHAIN_FLASH_MAX_POINTS + p`. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Nombre de points REELLEMENT valides pour ce flash — entre 2 (un saut) et `CHAIN_FLASH_MAX_POINTS`. */
  readonly pointCount: Uint8Array;
  /**
   * Teinte du trait, 0xRRGGBB — la Foudre par defaut. Un faisceau porte la
   * teinte de SON arme.
   */
  readonly tint: Uint32Array;
  /** Epaisseur du trait, en pixels monde : une chaine est fine, un faisceau a sa largeur d'arme. */
  readonly width: Float32Array;
  /**
   * Le tireur d'un faisceau, `-1` pour une chaine. Un faisceau SUIT son
   * tireur a l'ecran (le trait reste accroche a lui, direction figee) ; une
   * chaine relie des ennemis et ne suit personne.
   */
  readonly owner: Int32Array;
  /** Horloge murale de naissance (`performance.now()`), voir `CHAIN_FLASH_LIFETIME_MS`. */
  readonly bornMs: Float64Array;
  #count = 0;

  constructor(readonly capacity: number) {
    this.owner = new Int32Array(capacity).fill(-1);
    this.tint = new Uint32Array(capacity);
    this.width = new Float32Array(capacity);
    this.x = new Float32Array(capacity * CHAIN_FLASH_MAX_POINTS);
    this.y = new Float32Array(capacity * CHAIN_FLASH_MAX_POINTS);
    this.pointCount = new Uint8Array(capacity);
    this.bornMs = new Float64Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  /** Abscisse/ordonnee du point `p` (0 = l'impact) du flash `slot`. */
  pointX(slot: number, p: number): number {
    return this.x[slot * CHAIN_FLASH_MAX_POINTS + p] ?? 0;
  }
  pointY(slot: number, p: number): number {
    return this.y[slot * CHAIN_FLASH_MAX_POINTS + p] ?? 0;
  }

  /**
   * Fait naitre un flash a partir d'un chemin DEJA CALCULE — jamais recalcule
   * ici. Ignore silencieusement un chemin de moins de deux points (rien a
   * relier : la chaine n'a touche personne) ou une reserve pleine.
   */
  spawn(
    points: readonly { x: number; y: number }[],
    nowMs: number,
    /**
     * `0` : le CALQUE retombe sur la Foudre et son epaisseur de chaine. Les
     * constantes de dessin vivent dans le renderer, jamais ici.
     */
    tint = 0,
    width = 0,
    owner = -1,
  ): void {
    if (points.length < 2 || this.#count >= this.capacity) {
      return;
    }
    const slot = this.#count++;
    this.owner[slot] = owner;
    this.tint[slot] = tint;
    this.width[slot] = width;
    const n = Math.min(points.length, CHAIN_FLASH_MAX_POINTS);
    for (let p = 0; p < n; p++) {
      const point = points[p];
      this.x[slot * CHAIN_FLASH_MAX_POINTS + p] = point?.x ?? 0;
      this.y[slot * CHAIN_FLASH_MAX_POINTS + p] = point?.y ?? 0;
    }
    this.pointCount[slot] = n;
    this.bornMs[slot] = nowMs;
  }

  /** Retire les flashs dont la duree de vie a expire. */
  expire(nowMs: number): void {
    for (let i = this.#count - 1; i >= 0; i--) {
      const life = (this.owner[i] ?? -1) >= 0 ? BEAM_FLASH_LIFETIME_MS : CHAIN_FLASH_LIFETIME_MS;
      if (nowMs - (this.bornMs[i] ?? 0) >= life) {
        this.#removeAt(i);
      }
    }
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      const src = last * CHAIN_FLASH_MAX_POINTS;
      const dst = slot * CHAIN_FLASH_MAX_POINTS;
      for (let p = 0; p < CHAIN_FLASH_MAX_POINTS; p++) {
        this.x[dst + p] = this.x[src + p] ?? 0;
        this.y[dst + p] = this.y[src + p] ?? 0;
      }
      this.pointCount[slot] = this.pointCount[last] ?? 0;
      this.tint[slot] = this.tint[last] ?? 0;
      this.width[slot] = this.width[last] ?? 0;
      this.owner[slot] = this.owner[last] ?? -1;
      this.bornMs[slot] = this.bornMs[last] ?? 0;
    }
    this.#count = last;
  }
}

/**
 * Une invocation vivante cote client : la meme que celle du serveur, plus ce
 * que seul le dessin lit — sa teinte et son heure murale de naissance.
 */
export interface GuardTrace extends Guard {
  readonly tint: number;
  readonly bornMs: number;
}

/** Un ping annonce par le salon, tel que le rendu le lit. */
export interface ActivePing {
  playerId: number;
  intent: number;
  x: number;
  y: number;
  /**
   * Tick de `GameClient#pingClock` a la RECEPTION : c'est lui qui fait
   * expirer le ping. PAS le tick de horde, qui avance pendant le gel de
   * niveau — voir `pingClock`.
   */
  tick: number;
}

/** Duree du bouillonnement vert apres un coup de venin, en ticks (~ la duree du poison serveur). */
const POISON_VISUAL_TICKS = 75;
const POISON_BUBBLE_EVERY = 8;
const POISON_TINT = 0x7ccf3a;

/**
 * Le client de jeu : une socket, un tampon d'interpolation, une prediction.
 *
 * Il ne dessine rien et ne lit pas le clavier : il recoit une fonction qui lui
 * rend les axes courants, ce qui permet de le tester sans navigateur.
 */
export class GameClient {
  #ws: WebSocket | null = null;
  #inputTimer: ReturnType<typeof setInterval> | null = null;
  readonly #buffer = new SnapshotBuffer();
  #local: PredictedPlayer | null = null;
  #localId: number | null = null;
  /**
   * Derniers pv (personnels) connus du joueur local, tels que portes par le
   * dernier snapshot : la prediction ne simule que la position, pas les pv.
   */
  #localHp = 0;
  /**
   * Rayon de ramassage (personnel) du joueur local, tel que porte par le
   * dernier snapshot. Non predit, comme `#localHp`.
   */
  #localPickupRadius = 0;
  /**
   * Reserve de bouclier (personnelle) du joueur local, telle que portee par
   * le dernier snapshot. Non predite, comme `#localHp`.
   */
  #localShield = 0;
  /** Experience de l'equipe, telle que portee par le dernier snapshot. */
  #teamXp = 0;
  /**
   * Charge de Synergie de l'equipe, telle que portee par le dernier snapshot.
   * Lue, jamais deduite des `REACTION` : un client connecte en cours de partie
   * en aurait manque, et un recompte pourrait diverger du total qui fait foi.
   */
  #teamSynergy = 0;
  /**
   * L'or NON SECURISE de l'equipe, tel que le dernier snapshot le porte.
   *
   * ⚠️ **Il vit ici et PAS dans `RenderState`** (ou `xp` et `synergy` sont
   * restes par heritage) : `RenderState` est ce que la PREDICTION produit, et
   * l'or n'est ni predit ni interpole, comme `boss`.
   *
   * ⚠️ **Lu a chaque snapshot, meme quand le bloc du joueur local est
   * introuvable** : c'est une donnee d'EQUIPE.
   */
  #teamGold = 0;
  /**
   * Le boss vivant, tel que le dernier snapshot le porte — `null` quand il n'y
   * en a pas. Donnee d'equipe comme `xp` et `synergy` : elle est dans l'en-tete
   * du snapshot, pas dans un bloc joueur. Voir `BossVitals` et `trackBoss`.
   */
  #boss: BossVitals | null = null;
  /**
   * Niveau de l'equipe, tel que porte par le dernier `LEVEL_UP` (ou `RUN_OVER`
   * au bilan). Ne peut PAS se deriver de `#teamXp` seul : `xp` est remis a
   * l'excedent apres chaque niveau (`Room#gainXp`), donc la valeur cumulee
   * est perdue cote fil.
   */
  #level = 1;
  #seq = 0;
  #status: ConnectionStatus = 'closed';

  readonly horde = new Horde(MAX_ENTITIES);
  #fields: FlowField[] = [];
  readonly #history = new PlayerHistory();
  /** Accumulateur de pas fixes : la horde avance a 30 Hz, comme le serveur. */
  #hordeAcc = 0;
  #lastHordeTick = 0;

  /** Anneau d'etats de horde, pour le rejeu des morts en retard. */
  readonly #hordeHistory = new HordeHistory(MAX_ENTITIES);
  /**
   * Les zones au sol, ANNONCEES par le serveur et jamais derivees : le client
   * ne peut pas savoir ou finit un projectile serveur. Leur MORT se derive du
   * seul `bornTick`.
   *
   * Lecture publique : le rendu y lit ses quads teintes, et `Horde.step` le
   * ralentissement du Givre.
   */
  readonly zones = new ZoneField();
  /** Orbes derives des morts, jamais transmis. Lecture publique pour le rendu et le HUD. */
  readonly orbs = new DerivedOrbs(MAX_ENTITIES);
  /**
   * Orbes capturees, en vol vers leur ramasseur : purement cosmetique.
   * Lecture publique pour le rendu.
   */
  readonly orbFlights = new OrbFlights(ORB_FLIGHT_CAPACITY);

  /**
   * Projectiles, simules localement — **jamais repliques** (voir
   * `shared/projectiles.ts`) : chaque cote tire ses propres salves a partir de
   * donnees partagees. `#fireWeapons` est le miroir client de
   * `Room#fireWeapons`. Lecture publique pour le rendu.
   */
  readonly projectiles = new Projectiles(PROJECTILE_CAPACITY);
  /**
   * Recharge **par joueur ET par arme**, cote client — miroir exact de
   * `PlayerState.lastFireTick` cote serveur (un `Float64Array` indexe par
   * identifiant d'arme, `-Infinity` = jamais tire).
   *
   * ⚠️ **Pas un seul compteur par joueur** : la recharge la plus lente
   * bloquerait toutes les autres armes, et l'affichage montrerait moins de
   * salves que le serveur n'en arbitre.
   */
  readonly #lastFireTick = new Map<number, Float64Array>();
  /**
   * Miroir des inventaires, un par joueur, alimente par `DRAFT_RESULT`.
   *
   * ⚠️ **Le client ne decide rien ici** : il range ce que le serveur lui dit
   * d'avoir range. Deux usages :
   *
   * - `#fireWeapons` en tire l'arsenal a afficher. Sans lui, aucun projectile
   *   d'arme draftee ne s'affiche — ni pour son porteur, ni pour ses allies ;
   * - la prediction locale en tire sa vitesse. Sans elle, la premiere carte
   *   « fougue » fait decrocher la prediction du serveur a chaque tick.
   *
   * ⚠️ **Le miroir peut etre incomplet pour un joueur DISTANT**, et c'est sans
   * consequence : un client qui rejoint un salon en cours n'a jamais vu les
   * `DRAFT_RESULT` d'avant sa connexion. Le sien, lui, est exact — le serveur
   * lui cree un `Loadout` vide au meme instant (`Room.join`).
   */
  readonly #loadouts = new Map<number, Loadout>();
  /** Impacts et reactions vus depuis le debut : des compteurs QUI MONTENT, pour le son. */
  #hitCount = 0;
  /** Ennemis touches par un projectile a venin -> tick ou l'effet visuel s'eteint. Cosmetique. */
  readonly #poisoned = new Map<number, number>();

  /**
   * Des bulles vertes sur les ennemis empoisonnes, une toutes les
   * `POISON_BUBBLE_EVERY` ticks — decalees par identite pour ne pas pulser en
   * cadence. Approximation assumee : le client ne connait pas la reserve du
   * serveur, seulement le dernier coup de venin qu'il a vu.
   */
  #bubblePoison(tick: number, nowMs: number): void {
    if (this.#poisoned.size === 0) {
      return;
    }
    // Un seul balayage de la horde — `slotOf` en est un, voir `Venins.resolve`.
    for (let slot = 0; slot < this.horde.count; slot++) {
      const id = this.horde.entityIdAt(slot);
      const until = this.#poisoned.get(id);
      if (until === undefined || tick > until || (tick + id) % POISON_BUBBLE_EVERY !== 0) {
        continue;
      }
      this.hitFlashes.spawn(
        this.horde.x[slot] ?? 0,
        this.horde.y[slot] ?? 0,
        POISON_TINT,
        0,
        1,
        nowMs,
        false,
      );
    }
    for (const [id, until] of this.#poisoned) {
      if (tick > until) {
        this.#poisoned.delete(id);
      }
    }
  }
  #reactionCount = 0;
  get hitCount(): number {
    return this.#hitCount;
  }
  get reactionCount(): number {
    return this.#reactionCount;
  }
  /** Flashs d'impact derives des collisions locales. Lecture publique pour le rendu. */
  readonly hitFlashes = new HitFlashes(HIT_FLASH_CAPACITY);
  /** Les chiffres de degats qui montent au-dessus des monstres — voir `DamageNumbers`. */
  readonly damageNumbers = new DamageNumbers(DAMAGE_NUMBER_CAPACITY);
  /**
   * Flashs de reaction, ANNONCES par `REACTION`. Lecture publique pour
   * le rendu — voir `ReactionFlashes`.
   */
  readonly reactionFlashes = new ReactionFlashes(REACTION_FLASH_CAPACITY);
  /** Les explosions de kamikazes en cours d'affichage — voir `BehaviorRenderer`. */
  blastFlashes: BlastFlash[] = [];
  /** Les tirs des tireurs, derives de la horde — voir `EnemyShots`. */
  readonly shots = new EnemyShots();
  /**
   * Flashs de chaine de Foudre, derives des collisions locales comme
   * `hitFlashes` : semes une fois par `#seedChainFlash`, jamais rederives.
   * Lecture publique pour le rendu — voir `ChainFlashes`.
   */
  readonly chainFlashes = new ChainFlashes(CHAIN_FLASH_CAPACITY);

  /**
   * Nombre cumule d'identites tuees en dehors de la portee de `HordeHistory`
   * (`ROLLBACK_DEPTH_TICKS`) : appliquees au present plutot qu'au tick de la
   * mort, faute de pouvoir revenir en arriere. Lecture seule, pour le HUD de
   * debug et pour les tests.
   */
  #lateDeaths = 0;
  /** Ennemis abattus depuis le WELCOME, cumules depuis les lots `DEATHS`. */
  #kills = 0;

  /**
   * Nombre cumule de zones annoncees trop tard pour l'anneau
   * (`ROLLBACK_DEPTH_TICKS`) : posees au present plutot qu'a leur `bornTick`.
   *
   * ⚠️ **Meme degradation que `#lateDeaths`, et pour la meme raison : elle ne
   * doit jamais etre silencieuse.** Le Givre ralentit le DEPLACEMENT ; une
   * zone appliquee au present ralentit quelques ticks trop tard, et l'ecart
   * est exactement la latence excedentaire. On applique quand meme (un effet
   * que le joueur a paye ne doit pas disparaitre), mais on le COMPTE.
   */
  #lateZones = 0;

  /** Lots de morts recus mais pas encore appliques. Meme discipline que `#pendingOrders`. */
  readonly #pendingDeaths: PendingDeathBatch[] = [];

  /** Zones recues mais pas encore appliquees. Meme discipline que `#pendingDeaths`. */
  readonly #pendingZones: ZoneMessage[] = [];

  /** Charges de boss recues mais pas encore appliquees. Meme discipline que `#pendingZones`. */
  readonly #pendingCharges: BossChargeMessage[] = [];
  /** Le decor qui bloque le joueur local, pose au WELCOME (`PredictedPlayer`). */
  #moveMap: MoveMap | null = null;
  /** Leurres annonces, en attente d'etre plantes au tick deja simule (`#applyDecoy`). */
  readonly #pendingDecoys: Decoy[] = [];
  /** Leurres plantes, que l'entree du champ substitue (`#feedFields`). */
  #decoys: Decoy[] = [];
  /** La classe du joueur local, lue du dernier `LOBBY` au WELCOME ; `null` sans salle d'attente. */
  #localClassId: number | null = null;
  /** Leurres annonces trop tard pour l'anneau, plantes au present. */
  #lateDecoys = 0;
  /** Tick du dernier verbe ACCEPTE du joueur local ; `-Infinity` : jamais. */
  #lastAbilityTick = Number.NEGATIVE_INFINITY;
  /**
   * Les verbes annonces recemment, pour le rendu (zones de Rempart, leurres,
   * eclairs de Relais). Purges au-dela de quelques secondes.
   */
  readonly abilityEvents: AbilityUsed[] = [];

  /**
   * Les pings annonces, AU PLUS UN par joueur (cle : son id) : un nouveau ping
   * remplace l'ancien. Jamais purges ici — c'est
   * `livePings` qui dit lesquels sont encore vivants, a l'horloge `pingClock`
   * (figee pendant le gel de niveau).
   */
  readonly pings = new Map<number, ActivePing>();
  #pingCount = 0;
  /**
   * Le porteur de coffre annonce et pas encore mort, par identite.
   * Reconnu a son `archetype` dans `WAVE_ORDER`, oublie a sa mort dans `DEATHS`.
   */
  #porteurId: number | null = null;
  /** Ordres de porteur recus depuis la connexion : l'audio en deduit quand sonner. */
  #porteurCount = 0;
  /** Horloge murale de la derniere annonce, pour le bandeau. */
  #porteurAnnouncedMs = Number.NEGATIVE_INFINITY;
  /**
   * Coffres dus : un par porteur dont `DEATHS` a annonce la mort, consommes un
   * par un au `LEVEL_UP` suivant. Le serveur ouvre un coffre du AVANT tout
   * niveau et diffuse les morts AVANT les `LEVEL_UP`.
   */
  #chestsOwed = 0;
  #draftIsChest = false;
  /** L'evenement en cours (etape 14), `null` hors evenement. Pose, mis a jour et efface par le fil. */
  #event: EventMirror | null = null;
  /** `EVENT_START` recus depuis la connexion : l'audio en deduit quand sonner. */
  #eventCount = 0;
  /** Le dernier bandeau d'evenement, depart ou fin. */
  #eventBanner: { text: string; atMs: number } | null = null;
  /**
   * Etalages d'evenement dus : un par `EVENT_END` reussi, consommes au
   * `LEVEL_UP` suivant APRES les coffres — la meme priorite fixe que le salon.
   */
  #eventDraftsOwed = 0;
  #draftIsEvent = false;
  #lastPingIntent = -1;
  /** Horloge de ping : voir l'accesseur `pingClock`. */
  #pingClock = 0;

  /**
   * La charge du boss en cours, ou `null` — annoncee UNE FOIS par le serveur,
   * puis derivee ici tick par tick.
   *
   * ⚠️ **Elle touche le DEPLACEMENT** : pendant la charge, la position du boss
   * vient d'elle et non du champ de flux. Elle est donc DATEE PAR TICK et
   * appliquee par rejeu, comme une zone — voir `#applyBossCharge`.
   *
   * Gardee apres sa fin : une charge finie est inerte (`chargeHoldsAt`), et un
   * rejeu qui enjambe sa fin doit la retrouver.
   */
  #bossCharge: BossCharge | null = null;

  /**
   * Nombre cumule de charges annoncees trop tard pour l'anneau
   * (`ROLLBACK_DEPTH_TICKS`), donc installees au present, comme `#lateZones`
   * et `#lateDeaths` : le boss saute alors sur son couloir de l'ecart de la
   * latence excedentaire.
   */
  #lateCharges = 0;

  /**
   * Dernier tick du gel courant (inclus), et dernier tick de la reprise
   * progressive qui suit. `-1` hors gel, et non `0` comme cote serveur : le
   * premier tick de `GameClient` peut valoir `0`, et `#movementScale(0)`
   * rendrait alors un gel sans qu'aucun `LEVEL_UP` ne soit arrive.
   */
  #freezeUntilTick = -1;
  #resumeEndTick = -1;
  /**
   * Tick auquel le gel courant a commence, `-1` hors gel.
   *
   * ⚠️ **La fin du gel n'est pas calculable** : il dure jusqu'a ce que tout le
   * monde ait pose son jeton. Seul le serveur la connait et l'annonce dans
   * `DRAFT_RESULT` ; d'ici la, le client sait seulement qu'il est gele DEPUIS
   * ce tick.
   */
  #freezeStartTick = -1;

  /** L'etalage en cours, vide hors draft. Le client l'AFFICHE, il n'en decide rien. */
  #draftCards: readonly Card[] = [];
  #draftDeadlineTick = 0;
  /**
   * `true` des que la negociation est close (`DRAFT_RESULT` de phase 0), et
   * jusqu'au prochain `DRAFT_OPEN`.
   *
   * ⚠️ **Ce n'est pas la meme chose que « l'etalage est vide ».** L'etalage
   * survit a la fermeture, pour que l'ecran puisse jouer la revelation
   * (illuminer la carte gagnee, consumer les perdues). Ce drapeau dit « on ne
   * negocie plus », pas « il n'y a plus rien a montrer ».
   */
  #draftSettled = false;
  /** `playerId -> cardIndex` : les jetons poses, ceux des autres compris. */
  #draftIntents = new Map<number, number>();
  /** La derniere resolution recue — ce qui dit a l'ecran quelle carte illuminer ou consumer. */
  #draftOutcomes: readonly { playerId: number; cardIndex: number; outcome: number }[] = [];

  /**
   * Le tick auquel le portail courant cesse d'etre affichable, `-1` quand il
   * n'y en a jamais eu.
   *
   * ⚠️ **Trois valeurs.** `-1` : aucun portail. `Number.MAX_SAFE_INTEGER` : un
   * portail est ouvert et **on ne sait pas encore quand il se fermera** (le
   * vote se resout des que tout le monde a vote). Un tick fini : le
   * `PORTAL_RESULT` a dit son tick d'effet. Repousser la borne a l'infini
   * plutot que la deviner : fermer a `deadlineTick` laisserait l'ecran affiche
   * longtemps apres un vote unanime.
   *
   * ⚠️ **La fermeture est DATEE PAR TICK, jamais appliquee a la reception** :
   * sinon chaque client fermerait a un tick different, celui de sa latence.
   */
  #portalCloseTick = -1;
  /** Echeance de la fenetre courante, pour le chronometre. Voir `portalDeadlineTick`. */
  #portalDeadlineTick = 0;
  /**
   * Le multiplicateur d'extraction annonce par le dernier `PORTAL_OPEN`.
   *
   * ⚠️ **ANNONCE, jamais compte** : un client connecte en cours de run n'a pas
   * vu les portails precedents. Voir `PortalOpenMessage`.
   *
   * Vaut 1 avant le premier portail, comme `Room#extractMultiplier`.
   */
  #portalMultiplier = 1;
  /**
   * `playerId -> VOTE_CHOICE.STAY | VOTE_CHOICE.LEAVE | NO_VOTE` : qui a vote
   * quoi, remplacee entierement a chaque `VOTES`.
   *
   * ⚠️ **L'abstention est une ENTREE, pas une absence d'entree** : `NO_VOTE`
   * circule pour qu'on voie qui n'a pas encore tranche. La filtrer rendrait
   * « n'a pas vote » indistinguable de « a vote RESTER ».
   */
  #portalVotes: ReadonlyMap<number, number> = new Map();
  /**
   * Le verdict du dernier `PORTAL_RESULT`, `null` tant qu'aucun n'est tombe.
   *
   * Remis a `null` a chaque ouverture : un verdict de palier precedent
   * s'afficherait sinon sur le portail suivant.
   */
  #portalDecision: number | null = null;
  /** L'or du verdict : acquis si l'equipe part, reporte si elle reste. Voir `PortalResultMessage`. */
  #portalGold = 0;

  /**
   * Ordres recus mais pas encore appliques.
   *
   * Le gestionnaire de message ne fait QUE empiler. L'application a lieu dans
   * `#advanceHorde`, avant le rafraichissement du champ — l'ordre inverse
   * multiplie la derive par trente-cinq.
   */
  readonly #pendingOrders: WaveOrderMessage[] = [];

  /**
   * Visee locale, quantifiee : memes entiers que ceux du prochain `INPUT`.
   * Recalculee a chaque `update()` puis figee pour tout l'appel (plusieurs pas
   * fixes possibles) : `#fireWeapons` tire avec la valeur quantifiee, jamais
   * le flottant brut de `readAim` (voir `quantizeAxis`).
   */
  #localAim: { x: number; y: number } = { x: 0, y: 0 };

  constructor(
    private readonly url: string,
    private readonly readInput: () => InputAxes,
    private readonly onStatusChange: (status: ConnectionStatus) => void,
    /** Appele une seule fois, a la reception de `RUN_OVER`. */
    private readonly onRunOver: (summary: RunOverSummary) => void = () => undefined,
    /**
     * Rend la direction visee, en coordonnees MONDE, deja normalisee (ou
     * `(0, 0)` si le joueur ne vise nulle part, ce qui vaut « pas de tir »).
     * Par defaut, ne vise jamais.
     */
    private readonly readAim: () => InputAxes = () => ({ x: 0, y: 0 }),
    /**
     * Appele une seule fois, a la reception de `WELCOME`, seul moment ou la
     * carte d'obstacles existe. Livre le masque et la geometrie qui alimentent
     * `#fields` : le rendu dessine les MEMES cellules murees que celles que le
     * champ de flux evite.
     */
    private readonly onMapReady: (map: ObstacleMap) => void = () => undefined,
    /**
     * Le jeton de compte, en octets. Envoye comme PREMIER message de la socket
     * (`MSG.HELLO`) : le serveur n'attribue aucun slot avant de l'avoir
     * reconnu.
     *
     * ⚠️ **Optionnel ici, obligatoire cote SERVEUR** : une socket sans `HELLO`
     * valide est fermee. L'optionalite evite seulement d'imposer une valeur
     * aux tests.
     */
    private readonly accountToken: Uint8Array | null = null,
    /**
     * Les bonus PERMANENTS du compte (boutique), tels que `bonusesOf` les
     * derive de ses achats.
     *
     * ⚠️ **ZERO octet sur le fil** : le client lit SES PROPRES achats en HTTP
     * au chargement (`GET /accounts/me`) et derive ces bonus avec la fonction
     * partagee.
     *
     * ⚠️ **Fige a la construction** : le serveur les pose une seule fois au
     * `join`, constants sur toute la run (voir `Room.join`).
     *
     * ⚠️ **Le serveur reste l'autorite** : ces valeurs n'alimentent QUE la
     * prediction d'affichage.
     */
    private readonly accountBonuses: Readonly<Record<BonusKind, number>> = BONUS_ZERO,
  ) {}

  get status(): ConnectionStatus {
    return this.#status;
  }

  get localId(): number | null {
    return this.#localId;
  }

  /**
   * Position AFFICHEE du joueur local (`PredictedPlayer.renderX/renderY`), ou
   * `null` tant qu'aucun snapshot ne l'a fait exister. Sert a `main.ts` pour
   * convertir le curseur en direction de visee : c'est CELLE que la camera
   * centre (`Stage#centerOn`), donc la direction correspond a ce que l'ecran
   * montre.
   */
  get localPosition(): { x: number; y: number } | null {
    return this.#local ? { x: this.#local.renderX, y: this.#local.renderY } : null;
  }

  /** Niveau courant de l'equipe, pour le HUD. Voir `#level`. */
  get level(): number {
    return this.#level;
  }

  /**
   * Tick courant de la horde locale. Expose pour l'observabilite, comme
   * `Room.fieldInputTick` : les tests verrouillent qu'il s'aligne sur le tick
   * absolu du WELCOME puis se recale sur les snapshots (voir `#onFrame`).
   */
  get hordeTick(): number {
    return this.#lastHordeTick;
  }

  /**
   * Horloge dediee aux pings. Avance comme `hordeTick` SAUF pendant que
   * `isFrozen` est vrai (gel strict ET rampe de reprise) : un ping pose juste
   * avant une montee de niveau ne doit pas s'eteindre pendant le choix des
   * cartes. `hordeTick`, lui, avance a chaque pas fixe, gel ou pas.
   *
   * ⚠️ **Mesuree UNE SEULE FOIS par appel a `update()`**, sur l'ECART du tick
   * de horde entre le debut et la fin de cet appel — jamais depuis
   * `#advanceHorde` : le rejeu (`#replayTick`) peut executer ce dernier
   * plusieurs fois pour le MEME tick, et compterait alors deux fois le meme
   * pas. `isFrozen` est stable sur toute la duree d'un `update()` : seul
   * `#onFrame` (jamais appele depuis `update()`) fait avancer les bornes du
   * gel.
   */
  get pingClock(): number {
    return this.#pingClock;
  }

  /** L'etalage a afficher. Vide quand aucun draft n'est ouvert. */
  get draftCards(): readonly Card[] {
    return this.#draftCards;
  }

  /**
   * Echeance de la fenetre courante, pour le chronometre. A la fermeture, vaut
   * le tick de fermeture lui-meme : le chronometre lit zero restant, au lieu
   * de continuer a decompter une echeance perimee.
   */
  get draftDeadlineTick(): number {
    return this.#draftDeadlineTick;
  }

  /**
   * La negociation est close, mais l'etalage reste affichable — c'est pendant
   * cette phase que se joue la revelation.
   */
  get draftSettled(): boolean {
    return this.#draftSettled;
  }

  /** Qui vise quoi — c'est cette visibilite qui fait exister la negociation. */
  get draftIntents(): ReadonlyMap<number, number> {
    return this.#draftIntents;
  }

  /** La derniere resolution : quelle carte s'illumine, laquelle se consume. */
  get draftOutcomes(): readonly { playerId: number; cardIndex: number; outcome: number }[] {
    return this.#draftOutcomes;
  }

  /** C -> S : je pose mon jeton, ou je le retire avec `NO_TOKEN`. */
  placeToken(cardIndex: number): void {
    this.#ws?.send(encodeDraftToken(cardIndex));
  }

  /**
   * Le vote d'extraction est-il affichable ?
   *
   * Vrai de l'ouverture jusqu'au TICK D'EFFET du verdict — pas jusqu'a sa
   * reception. Voir `#portalCloseTick` pour les trois valeurs et pour la
   * raison.
   *
   * ⚠️ **Ne regarde NI les points de vie NI le joueur local** : tout joueur
   * connecte vote, mort ou vif, comme dans `Portal#pending` cote serveur.
   */
  get portalOpen(): boolean {
    return this.#lastHordeTick < this.#portalCloseTick;
  }

  /**
   * Echeance de la fenetre de vote, pour le chronometre. C'est un PLAFOND : le
   * vote peut se resoudre bien avant, des que tout le monde a vote.
   */
  get portalDeadlineTick(): number {
    return this.#portalDeadlineTick;
  }

  /** Le multiplicateur qui s'applique si l'equipe part MAINTENANT. Voir `#portalMultiplier`. */
  get portalMultiplier(): number {
    return this.#portalMultiplier;
  }

  /** Qui a vote quoi, abstentions comprises — c'est cette visibilite qui fait exister le vote. */
  get portalVotes(): ReadonlyMap<number, number> {
    return this.#portalVotes;
  }

  /** Le verdict rendu, ou `null` tant que le vote est en cours. Jamais `NO_VOTE`. */
  get portalDecision(): number | null {
    return this.#portalDecision;
  }

  /** L'or du verdict : acquis si l'equipe part, reporte si elle reste. */
  get portalGold(): number {
    return this.#portalGold;
  }

  /**
   * L'or NON SECURISE de l'equipe, tel que le dernier snapshot le porte.
   *
   * C'est l'ENJEU du vote, que le HUD montre en permanence : une cagnotte vue
   * seulement au vote ne se vit pas comme un risque.
   */
  get gold(): number {
    return this.#teamGold;
  }

  /**
   * C -> S : je vote, ou je retire mon vote (`NO_VOTE`).
   *
   * ⚠️ **Le client PROPOSE, le serveur arbitre** : rien n'est enregistre
   * localement. Un vote refuse n'est simplement pas pris, et la prochaine
   * diffusion des votes le montrera. Comme `placeToken`.
   */
  castVote(choice: number): void {
    this.#ws?.send(encodeVote(choice));
  }

  /**
   * Ce que ce joueur possede, tel que le client l'a reconstitue depuis les
   * `DRAFT_RESULT` recus. Meme signature que `Room.loadoutOf` cote serveur,
   * pour que les deux se comparent directement.
   *
   * Cree l'entree a la volee, AVEC la dague : c'est ce que `Room.join` donne
   * a qui n'a pas choisi d'arme (et ce qu'on suppose d'un joueur dont on ne
   * connait pas le choix). Une arme choisie au salon la remplace au WELCOME.
   */
  loadoutOf(playerId: number): Loadout {
    const found = this.#loadouts.get(playerId);
    if (found) {
      return found;
    }
    const fresh = new Loadout();
    fresh.addWeapon(BASE_WEAPON_ID);
    this.#loadouts.set(playerId, fresh);
    return fresh;
  }

  /** La vitesse du monde au tick courant : `0` gele, une rampe a la reprise, `1` sinon. */
  get motionScale(): number {
    return this.#movementScale(this.#lastHordeTick);
  }

  /**
   * Vrai pendant le gel de montee de niveau **et sa rampe de reprise** : un
   * monde fige sans explication se lit comme un plantage, et une seconde de
   * ralenti inexpliquee aussi.
   */
  get isFrozen(): boolean {
    if (this.#freezeStartTick < 0) {
      return false;
    }
    return (
      this.#lastHordeTick >= this.#freezeStartTick && this.#lastHordeTick <= this.#resumeEndTick
    );
  }

  /** Ennemis abattus depuis le debut de la run (ou du WELCOME pour un retardataire). */
  get kills(): number {
    return this.#kills;
  }

  /**
   * PV max du joueur local : meme somme que `Room` (base, cartes, achats du
   * compte), lue sur le miroir d'inventaire.
   *
   * ⚠️ **`maxHpOf` (`@shared/loadout`), pas une copie locale** : deux copies
   * divergeraient a la premiere regle qui touche au plafond.
   */
  get localMaxHp(): number {
    const id = this.#localId;
    if (id === null) {
      return maxHpOf(new Loadout(), this.accountBonuses.maxHp);
    }
    return maxHpOf(this.loadoutOf(id), this.accountBonuses.maxHp);
  }

  /**
   * Nombre cumule de morts appliquees au present, faute d'anneau assez
   * profond pour les rejouer (`ROLLBACK_DEPTH_TICKS`). Voir `#lateDeaths`.
   */
  get lateDeaths(): number {
    return this.#lateDeaths;
  }

  /** Zones posees au present faute d'anneau assez profond. Voir `#lateZones`. */
  get lateZones(): number {
    return this.#lateZones;
  }

  /** Charges installees au present faute d'anneau assez profond. Voir `#lateCharges`. */
  get lateCharges(): number {
    return this.#lateCharges;
  }

  /**
   * La charge du boss en cours, ou `null` — ce que le rectangle d'annonce
   * dessine a chaque image (`ChargeRenderer`).
   *
   * Comme `boss` : ni predite ni interpolee, une valeur annoncee dont le reste
   * se derive au tick.
   */
  get bossCharge(): BossCharge | null {
    return this.#bossCharge;
  }

  /**
   * Charge de Synergie de l'equipe, telle que portee par le dernier snapshot.
   *
   * Doublon assume de `RenderState.synergy`, pour les tests et les appelants
   * sans etat de rendu.
   */
  get synergy(): number {
    return this.#teamSynergy;
  }

  /**
   * Le boss vivant, ou `null` — ce que la barre de vie lit a chaque image
   * (`BossBarRenderer.draw`, via `composeFrame`).
   *
   * Un getter et pas un champ de `RenderState` : le boss n'est ni predit ni
   * interpole.
   */
  get boss(): BossVitals | null {
    return this.#boss;
  }

  /** Dernier etat de la salle d'attente, `null` avant le premier `LOBBY`. */
  #lobby: LobbyMessage | null = null;
  /** Appele a chaque `LOBBY` recu, jusqu'au lancement. */
  onLobby: (lobby: LobbyMessage) => void = () => undefined;

  /**
   * Salle d'attente : choisit l'arme de depart (`NO_WEAPON` : la dague) et la
   * classe. **Les deux ensemble**, puisque `PICK` porte les deux : l'ecran
   * renvoie toujours le couple complet, jamais une moitie.
   */
  pick(weaponId: number, classId: number): void {
    this.#ws?.send(encodePick(weaponId, classId));
  }

  /** Salle d'attente : lance la run (le serveur ignore si on n'est pas l'hote). */
  startRun(): void {
    this.#ws?.send(encodeStart());
  }

  /**
   * Demande le verbe de sa classe, vise au point MONDE `(x, y)`.
   *
   * ⚠️ **Le client PROPOSE, le salon arbitre** : rien n'est applique ici, ni
   * la recharge ni l'effet. Un refus est silencieux — aucune annonce
   * n'arrive. Le joueur ne dit pas quel verbe : c'est le salon qui lit sa
   * classe (`encodeAbility`).
   */
  useAbility(x: number, y: number): void {
    this.#ws?.send(encodeAbility(this.hordeTick, x, y));
  }

  /**
   * Pose un ping au point MONDE `(x, y)`. Le client PROPOSE : rien n'est
   * affiche ici, pas meme pour soi — le ping apparait a l'annonce du salon,
   * pour qu'un ping refuse n'existe chez personne.
   */
  sendPing(intent: number, x: number, y: number): void {
    this.#ws?.send(encodePing(intent, x, y));
  }

  /** Pings recus depuis la connexion : l'audio en deduit quand sonner. */
  get pingCount(): number {
    return this.#pingCount;
  }

  /** L'etalage courant est-il un coffre ? Fige au `LEVEL_UP` qui l'annonce. */
  get draftIsChest(): boolean {
    return this.#draftIsChest;
  }

  /** Ordres de porteur recus depuis la connexion : l'audio en deduit quand sonner. */
  get porteurCount(): number {
    return this.#porteurCount;
  }

  /** Le bandeau du porteur est-il allume (`PORTEUR_BANNER_MS` apres l'annonce) ? */
  get porteurBannerOn(): boolean {
    return performance.now() - this.#porteurAnnouncedMs < PORTEUR_BANNER_MS;
  }

  /**
   * Position du porteur dans la horde DU CLIENT, `null` s'il n'est pas, ou
   * plus, dans la horde. Un `slotOf` par appel : le meme balayage que la barre
   * du boss, une fois par image.
   */
  get porteur(): { x: number; y: number } | null {
    if (this.#porteurId === null) {
      return null;
    }
    const slot = this.horde.slotOf(this.#porteurId);
    if (slot < 0) {
      return null;
    }
    return { x: this.horde.x[slot] ?? 0, y: this.horde.y[slot] ?? 0 };
  }

  /** L'etalage courant est-il un etalage d'evenement (etape 14) ? Fige au `LEVEL_UP`. */
  get draftIsEvent(): boolean {
    return this.#draftIsEvent;
  }

  /** `EVENT_START` recus depuis la connexion (etape 14). */
  get eventCount(): number {
    return this.#eventCount;
  }

  /** Le texte du bandeau d'evenement pendant `EVENT_BANNER_MS`, sinon `null`. */
  get eventBanner(): string | null {
    const b = this.#eventBanner;
    return b !== null && performance.now() - b.atMs < EVENT_BANNER_MS ? b.text : null;
  }

  /** L'evenement en cours (etape 14), ou `null`. */
  get event(): EventView | null {
    const ev = this.#event;
    if (ev === null) {
      return null;
    }
    return {
      kind: ev.kind,
      points: ev.points,
      progress: ev.progress,
      secondsLeft: Math.max(0, ev.deadline - this.#pingClock) / TICK_HZ,
      cart: ev.kind === EVENT_KIND.CONVOI ? this.#cartAt(ev, performance.now()) : null,
      cartHp: ev.cartHp,
    };
  }

  /** Intention du dernier ping recu, `-1` si aucun. */
  get lastPingIntent(): number {
    return this.#lastPingIntent;
  }

  /** La classe du joueur local, ou `null` (arrive en cours de partie, sans salle d'attente). */
  get localClassId(): number | null {
    return this.#localClassId;
  }

  /**
   * Ticks avant que le verbe local soit de nouveau pret, `0` s'il l'est. Derive
   * de la DERNIERE annonce recue et de la recharge partagee : zero octet par
   * tick.
   */
  get abilityCooldownTicks(): number {
    const classe = this.#localClassId === null ? undefined : classOf(this.#localClassId);
    if (!classe) {
      return 0;
    }
    const pret = this.#lastAbilityTick + ABILITY_COOLDOWN_TICKS[classe.verb];
    return Math.max(0, pret - this.hordeTick);
  }

  /** Leurres annonces trop tard pour l'anneau, plantes au present (diagnostic). */
  get lateDecoys(): number {
    return this.#lateDecoys;
  }

  /**
   * Un verbe ANNONCE par le salon. Le client derive ensuite son effet de
   * l'annonce et de son tick, jamais d'un etat envoye :
   * - **Appat** : un leurre a planter, par rejeu (`#applyDecoy`) ;
   * - **Relais** : si c'est le joueur local, la prediction se RECALE sur la
   *   destination, sans lissage — sinon chaque snapshot rattraperait une
   *   position d'un bout a l'autre de la carte (`PredictedPlayer.teleport`) ;
   * - **Amorce** : rien ici, sa zone arrive deja par `ZONE` ;
   * - tous : gardes pour le rendu (`abilityEvents`) et, pour le joueur local,
   *   la recharge.
   */
  #onAbilityUsed(msg: AbilityUsedMessage): void {
    const used: AbilityUsed = {
      tick: msg.tick,
      playerId: msg.playerId,
      verb: msg.verb,
      x: msg.x,
      y: msg.y,
      targetId: msg.targetId,
    };
    this.abilityEvents.push(used);
    while (
      this.abilityEvents.length > 0 &&
      msg.tick - (this.abilityEvents[0]?.tick ?? msg.tick) > ABILITY_EVENT_MEMORY_TICKS
    ) {
      this.abilityEvents.shift();
    }
    if (msg.playerId === this.#localId) {
      this.#lastAbilityTick = msg.tick;
    }
    if (msg.verb === VERB_IDS.appat) {
      this.#pendingDecoys.push({
        playerId: msg.playerId,
        x: msg.x,
        y: msg.y,
        bornTick: msg.tick,
      });
    }
    if (msg.verb === VERB_IDS.relais && msg.playerId === this.#localId) {
      this.#local?.teleport(msg.x, msg.y);
    }
  }

  #onPingShown(msg: PingShownMessage): void {
    this.pings.set(msg.playerId, {
      playerId: msg.playerId,
      intent: msg.intent,
      x: msg.x,
      y: msg.y,
      // `pingClock`, pas `hordeTick` : voir l'accesseur.
      tick: this.pingClock,
    });
    this.#pingCount += 1;
    this.#lastPingIntent = msg.intent;
  }

  /**
   * Les trois messages d'evenement (etape 14), lus A LA RECEPTION : ils ne
   * touchent pas la simulation, rien a rejouer.
   */
  #onEvent(msg: EventMessage): void {
    const now = performance.now();
    if (msg.type === MSG.EVENT_START) {
      const depart = msg.points[0] ?? { x: 0, y: 0 };
      this.#event = {
        kind: msg.kind,
        points: msg.points,
        // Une DUREE, posee sur `pingClock` : elle dort exactement quand
        // l'evenement dort au serveur.
        deadline: this.#pingClock + msg.durationTicks,
        progress: 0,
        cartFrom: depart,
        cartTo: depart,
        cartAtMs: now,
        cartHp: 1,
      };
      this.#eventCount++;
      this.#eventBanner = { text: EVENT_START_BANNERS[msg.kind] ?? '', atMs: now };
      return;
    }
    if (msg.type === MSG.EVENT_STATE) {
      const ev = this.#event;
      // Arrive en cours d'evenement : sans depart, rien a montrer (§10).
      if (ev === null) {
        return;
      }
      ev.progress = msg.progress / 255;
      ev.cartFrom = this.#cartAt(ev, now);
      ev.cartTo = { x: msg.cartX, y: msg.cartY };
      ev.cartAtMs = now;
      ev.cartHp = msg.cartHp / 255;
      return;
    }
    this.#event = null;
    // ⚠️ Compte meme sans depart vu (ecart n° 12 du plan) : l'`EVENT_END`
    // suffit a nommer l'etalage qui suit.
    if (msg.outcome === EVENT_OUTCOME.REUSSI) {
      this.#eventDraftsOwed++;
    }
    this.#eventBanner = { text: EVENT_END_BANNERS[msg.outcome] ?? '', atMs: now };
  }

  /** Le chariot a l'instant `now`, entre ses deux derniers etats connus. */
  #cartAt(ev: EventMirror, now: number): { x: number; y: number } {
    const t = Math.min(1, Math.max(0, (now - ev.cartAtMs) / CART_LERP_MS));
    return {
      x: ev.cartFrom.x + (ev.cartTo.x - ev.cartFrom.x) * t,
      y: ev.cartFrom.y + (ev.cartTo.y - ev.cartFrom.y) * t,
    };
  }

  connect(): void {
    this.#setStatus('connecting');
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;

    ws.addEventListener('open', () => {
      // Le PREMIER octet que ce client envoie, toujours — avant le moindre
      // INPUT, parce que le serveur n'attribue pas de slot avant.
      if (this.accountToken) {
        ws.send(encodeHello(this.accountToken));
      }
      this.#setStatus('open');
      // Cadence d'envoi, pas cadence de simulation : un peu de gigue ici n'a
      // aucune consequence, le serveur horodate par son propre tick.
      this.#inputTimer = setInterval(() => {
        this.#sendInput();
      }, 1000 / INPUT_HZ);
    });

    ws.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
      this.#onFrame(event.data);
    });

    ws.addEventListener('close', () => {
      this.disconnect();
    });
  }

  disconnect(): void {
    if (this.#inputTimer !== null) {
      clearInterval(this.#inputTimer);
      this.#inputTimer = null;
    }
    this.#ws?.close();
    this.#ws = null;
    this.#setStatus('closed');
  }

  /**
   * Une image de rendu. `now` est l'horloge du navigateur, `dt` le temps ecoule
   * depuis l'image precedente, en secondes.
   */
  update(now: number, dt: number): RenderState {
    const axes = this.readInput();
    // ⚠️ **La prediction locale honore le gel de niveau**, comme `Room.step` :
    // sinon le personnage avancerait en local puis serait ramene en arriere
    // par le snapshot suivant.
    //
    // Le tick de reference est celui de la horde, c'est-a-dire le tick SERVEUR
    // recale en continu : `#freezeUntilTick` et `#resumeEndTick` sont dates
    // dans ce repere par `LEVEL_UP`, jamais dans un tick local.
    //
    // ⚠️ **La vitesse vient de l'inventaire ET du compte** : voir `#localSpeed`.
    this.#local?.predict(
      axes.x,
      axes.y,
      dt,
      this.#movementScale(this.#lastHordeTick),
      this.#localSpeed(),
    );

    // Visee locale, lue puis QUANTIFIEE une seule fois pour tout l'appel (voir
    // `#localAim`). La mise a l'echelle par 127 avant `quantizeAxis` reproduit
    // exactement ce que `#sendInput` envoie : `#fireWeapons` ne tire jamais
    // avec plus de precision que ce que le serveur recoit.
    const aim = this.readAim();
    this.#localAim = { x: quantizeAxis(aim.x * 127), y: quantizeAxis(aim.y * 127) };

    // La horde avance au **pas fixe** du serveur, pas au rythme des images :
    // deux clients a 60 et 144 fps appliqueraient sinon des suites de `dt`
    // differentes, et la derive serait proportionnelle au temps de vie.
    const STEP = 1 / TICK_HZ;
    this.#hordeAcc += dt;
    let steps = 0;
    const hordeTickAvant = this.#lastHordeTick;
    while (this.#hordeAcc >= STEP && steps < 5) {
      this.#advanceHorde(STEP, now);
      this.#hordeAcc -= STEP;
      steps++;
    }
    if (steps === 5) {
      this.#hordeAcc = 0;
    }
    // ⚠️ `pingClock` se mesure ICI, une fois par appel, jamais dans
    // `#advanceHorde`, que le rejeu peut executer plusieurs fois pour le meme
    // tick. `#onFrame` ne s'execute jamais depuis `update()` (handler
    // WebSocket), donc `isFrozen` est stable sur toute la boucle ci-dessus.
    if (!this.isFrozen) {
      this.#pingClock += this.#lastHordeTick - hordeTickAvant;
    }

    const players = this.#buffer.sample(now);
    const local = this.#local;
    if (local && this.#localId !== null) {
      const index = players.findIndex((p) => p.id === this.#localId);
      const predicted = {
        id: this.#localId,
        x: local.renderX,
        y: local.renderY,
        hp: this.#localHp,
        aimX: this.#localAim.x,
        aimY: this.#localAim.y,
        pickupRadius: this.#localPickupRadius,
        shield: this.#localShield,
      };
      if (index >= 0) {
        players[index] = predicted;
      } else {
        players.push(predicted);
      }
    }

    // ⚠️ **Apres `players`, jamais avant, et jamais depuis `#advanceHorde`.**
    // La capture compare les positions DESSINEES (predite pour soi,
    // interpolees pour les autres), celles qui portent l'orbe a l'ecran, une
    // fois par image quel que soit le nombre de pas de horde.
    this.orbFlights.expire(now);
    this.orbs.capture(players, this.orbFlights, now);

    const classes = new Map((this.#lobby?.players ?? []).map((p) => [p.playerId, p.classId]));
    return {
      localId: this.#localId,
      xp: this.#teamXp,
      synergy: this.#teamSynergy,
      players,
      classes,
    };
  }

  /**
   * Vitesse de deplacement du joueur local — meme formule que `Room.step`
   * (`PLAYER_SPEED + loadout.bonus('speed') + accountBonuses.speed`), pas une
   * approximation.
   *
   * ⚠️ **Les TROIS termes.** Un terme omis fait avancer la prediction moins
   * vite que l'autorite, et chaque snapshot ramene le joueur en arriere (voir
   * `PredictedPlayer.predict`).
   *
   * Sans WELCOME, pas d'inventaire, mais les bonus de compte sont connus des
   * la construction.
   */
  #localSpeed(): number {
    const base = PLAYER_SPEED + this.accountBonuses.speed;
    if (this.#localId === null) {
      return base;
    }
    return base + this.loadoutOf(this.#localId).bonus('speed');
  }

  #sendInput(): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const axes = this.readInput();
    // `encodeInput` applique `quantizeAxis`, la meme fonction que `update()`
    // pour `#localAim` : tir local et entree envoyee partagent la meme
    // quantification, meme lus a des instants differents.
    const aim = this.readAim();
    this.#seq = (this.#seq + 1) & 0xffff;
    ws.send(encodeInput(this.#seq, axes.x * 127, axes.y * 127, aim.x * 127, aim.y * 127));
  }

  #onFrame(data: ArrayBuffer): void {
    const msg = decode(data);

    if (msg.type === MSG.WELCOME) {
      this.#localId = msg.playerId;
      // Le tick du salon est ABSOLU et grandit pendant toute sa vie. Sans cet
      // alignement, `spawnTick - tickLocal` serait negatif pour tout joueur qui
      // rejoint apres le premier, le rattrapage ne s'executerait jamais, et le
      // rafraichissement du champ serait dephase de facon permanente par
      // rapport au serveur.
      this.#lastHordeTick = msg.tick;
      // Le client **regenere** la carte depuis la graine, il ne la recoit pas :
      // envoyer 8 836 cellules couterait plus cher que tout le protocole.
      const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
      const world = generateWorld(msg.mapSeed, probe.cols, probe.rows);
      const mask = world.blocked;
      this.#fields = Array.from({ length: MAX_PLAYERS }, () => {
        const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
        applyObstacles(f, mask);
        return f;
      });
      // Les armes de depart choisies en salle d'attente : `Room.join` les a
      // posees dans chaque `Loadout` au meme instant que ce WELCOME.
      for (const p of this.#lobby?.players ?? []) {
        // Sans choix, la dague (`loadoutOf` la pose) ; une arme choisie la
        // remplace — meme regle que `Room.join`.
        if (p.weaponId !== NO_WEAPON) {
          const choisi = new Loadout();
          choisi.addWeapon(p.weaponId);
          this.#loadouts.set(p.playerId, choisi);
        }
        if (p.playerId === msg.playerId) {
          this.#localClassId = p.classId;
        }
      }
      // Meme `mask` et meme geometrie que `#fields` : le rendu dessine les
      // obstacles que la simulation evite.
      this.#moveMap = { mask, cols: probe.cols, rows: probe.rows, cellSize: probe.cellSize };
      this.onMapReady({ ...this.#moveMap, world });
      return;
    }
    if (msg.type === MSG.LOBBY) {
      this.#lobby = msg;
      this.onLobby(msg);
      return;
    }
    if (msg.type === MSG.WAVE_ORDER) {
      this.#pendingOrders.push(msg);
      // Des squelettes nes sur place : le necromancien vient de relever des
      // morts (`Room#afterDeaths`). Le sort se joue la, sans octet de plus.
      if (msg.formation === FORMATION.POINT && msg.archetype === archetypeIdOf(NECRO_CHILD)) {
        this.blastFlashes.push({
          x: msg.anchorX,
          y: msg.anchorY,
          bornMs: performance.now(),
          kind: 'releve',
        });
      }
      // Le porteur se reconnait a son archetype, comme le releve du
      // necromancien juste au-dessus. Annonce a la RECEPTION.
      if (msg.archetype === PORTEUR_ARCHETYPE) {
        this.#porteurId = entityIdOf(msg.waveId, 0);
        this.#porteurCount++;
        this.#porteurAnnouncedMs = performance.now();
      }
      return;
    }
    if (msg.type === MSG.DEATHS) {
      // Comme les ordres de vague : le gestionnaire ne fait QU'empiler,
      // l'application (restauration, rejeu) a lieu dans `#advanceHorde`, au
      // tick local qui vient d'etre simule — voir `#applyDeaths`.
      this.#pendingDeaths.push({ tick: msg.tick, ids: msg.ids });
      // Lu A LA RECEPTION, sur les identites du message — sans
      // attendre que le rejeu l'applique. Le `LEVEL_UP` qui suit est le coffre.
      if (this.#porteurId !== null && msg.ids.includes(this.#porteurId)) {
        this.#chestsOwed++;
        this.#porteurId = null;
      }
      return;
    }
    if (msg.type === MSG.ZONE) {
      // Meme discipline que les morts : empiler ici, appliquer (et rejouer) au
      // tick local deja simule — voir `#applyZone`.
      this.#pendingZones.push(msg);
      return;
    }
    if (msg.type === MSG.ABILITY_USED) {
      this.#onAbilityUsed(msg);
      return;
    }
    if (msg.type === MSG.PING_SHOWN) {
      this.#onPingShown(msg);
      return;
    }
    if (
      msg.type === MSG.EVENT_START ||
      msg.type === MSG.EVENT_STATE ||
      msg.type === MSG.EVENT_END
    ) {
      this.#onEvent(msg);
      return;
    }
    if (msg.type === MSG.BOSS_CHARGE) {
      // Meme discipline que les zones et les morts : empiler ici, appliquer (et
      // rejouer) au tick local deja simule — voir `#applyBossCharge`. Une
      // charge DEPLACE le boss : elle doit prendre effet au tick que le serveur
      // a date, quitte a rejouer, jamais a la reception.
      this.#pendingCharges.push(msg);
      return;
    }
    if (msg.type === MSG.REACTION) {
      // ⚠️ **Applique A LA RECEPTION, pas au tick date**, a l'oppose de `ZONE` :
      // une zone RALENTIT, donc touche le deplacement ; un flash de reaction ne
      // fait que se voir, et quelques dizaines de millisecondes de retard ne se
      // voient pas.
      //
      // ⚠️ **Le client ne rejoue rien et ne tue personne ici** : les morts de
      // la reaction arrivent par `DEATHS`, sans chemin de mort parallele.
      this.reactionFlashes.spawn(msg.x, msg.y, msg.pair, msg.synergyCharge, performance.now());
      this.#reactionCount++;
      return;
    }
    if (msg.type === MSG.PICKUPS) {
      // Pur retrait derive : aucune position ni existence d'orbe ne transite,
      // seules les identites ramassees le font (voir `DerivedOrbs`).
      this.orbs.remove(msg.ids);
      return;
    }
    if (msg.type === MSG.LEVEL_UP) {
      // ⚠️ `msg.tick` est le tick auquel le gel PREND EFFET, pas celui de
      // l'emission (voir `LevelUpMessage`) : geler a la reception ferait geler
      // chaque client a un tick different selon sa latence, et le gel
      // deviendrait une source de divergence au lieu d'une pause commune.
      // Gel d'une duree INCONNUE : il commence au tick date, et ne finira que
      // quand `DRAFT_RESULT` l'annoncera. D'ici la, les deux bornes hautes sont
      // repoussees a l'infini plutot que devinees.
      this.#freezeStartTick = msg.tick;
      this.#freezeUntilTick = Number.MAX_SAFE_INTEGER;
      this.#resumeEndTick = Number.MAX_SAFE_INTEGER;
      // Contrairement au gel, le niveau affiche au HUD peut se mettre a jour
      // des la reception : ce n'est pas une simulation partagee qui doit
      // diverger identiquement des deux cotes, seulement un chiffre a
      // afficher.
      this.#level = msg.level;
      // Etape 11 : un coffre du est TOUJOURS le premier `LEVEL_UP` qui suit la
      // mort du porteur — le salon l'ouvre avant tout niveau. Etape 14 : puis
      // un etalage d'evenement, avant tout niveau. Meme priorite que le salon.
      this.#draftIsChest = this.#chestsOwed > 0;
      if (this.#draftIsChest) {
        this.#chestsOwed--;
      }
      this.#draftIsEvent = !this.#draftIsChest && this.#eventDraftsOwed > 0;
      if (this.#draftIsEvent) {
        this.#eventDraftsOwed--;
      }
      return;
    }

    if (msg.type === MSG.DRAFT_OPEN) {
      this.#draftCards = msg.cards;
      this.#draftDeadlineTick = msg.deadlineTick;
      this.#draftOutcomes = [];
      this.#draftSettled = false;
      // ⚠️ Un etalage neuf : personne n'a encore pose. Le serveur cesse aussi
      // de diffuser les jetons du tour precedent (voir `Draft#step`), mais
      // l'invariant tient ici et pas seulement la-bas — un client ne doit
      // jamais afficher un jeton qui appartient a une negociation revolue.
      this.#draftIntents = new Map();
      return;
    }

    if (msg.type === MSG.DRAFT_INTENTS) {
      this.#draftIntents = new Map(msg.intents.map((i) => [i.playerId, i.cardIndex]));
      return;
    }

    if (msg.type === MSG.DRAFT_RESULT) {
      // ⚠️ AVANT de vider `#draftCards` plus bas : les issues designent les
      // cartes par leur INDICE dans l'etalage courant, et l'etalage est la
      // seule chose qui dise ce que cet indice contient.
      this.#applyDraftOutcomes(msg.outcomes);
      this.#draftOutcomes = msg.outcomes;
      this.#draftIntents = new Map();
      this.#draftDeadlineTick = msg.deadlineTick;
      // ⚠️ **C'est ICI que le client apprend la fin du gel**, et nulle part
      // ailleurs. Il ne peut pas la deduire : la fenetre dure jusqu'a ce que
      // tout le monde ait pose son jeton, et en solo elle se ferme au clic.
      //
      // ⚠️ **L'etalage n'est PAS vide ici** : les issues designent les cartes
      // par leur INDICE dans l'etalage, et l'ecran en a besoin pour jouer la
      // revelation.
      //
      // C'est `draftSettled` qui dit « la negociation est finie », et c'est
      // l'ecran qui decide quand il arrete de dessiner. Le prochain
      // `DRAFT_OPEN` remplace l'etalage.
      this.#draftSettled = true;
      this.#freezeUntilTick = msg.deadlineTick;
      this.#resumeEndTick = msg.deadlineTick + LEVEL_RESUME_TICKS;
      return;
    }
    if (msg.type === MSG.PORTAL_OPEN) {
      this.#portalDeadlineTick = msg.deadlineTick;
      // ⚠️ **Le multiplicateur est LU, jamais recalcule.** Le client ne compte
      // pas les portails et ne code rien en dur : il prend le chiffre que le
      // serveur applique. Voir `#portalMultiplier`.
      this.#portalMultiplier = msg.multiplier;
      // ⚠️ Un portail neuf : personne n'a encore vote, et le verdict du palier
      // precedent ne doit pas rester affiche.
      this.#portalVotes = new Map();
      this.#portalDecision = null;
      // Fenetre de duree INCONNUE, jusqu'a `PORTAL_RESULT` : voir
      // `#portalCloseTick`.
      this.#portalCloseTick = Number.MAX_SAFE_INTEGER;
      return;
    }

    if (msg.type === MSG.VOTES) {
      // ⚠️ **Les abstentions passent telles quelles** : voir `#portalVotes`.
      this.#portalVotes = new Map(msg.votes.map((v) => [v.playerId, v.choice]));
      return;
    }

    if (msg.type === MSG.PORTAL_RESULT) {
      this.#portalDecision = msg.decision;
      this.#portalGold = msg.gold;
      // ⚠️ **`msg.effectTick` est le tick d'EFFET, pas celui de la
      // reception** : voir `#portalCloseTick`.
      this.#portalCloseTick = msg.effectTick;
      return;
    }

    if (msg.type === MSG.RUN_OVER) {
      // Une seule fois par salon : `Room` ne met `RUN_OVER` en file qu'une
      // fois (`#runOver`).
      // Etape 14 : la fin de run l'emporte sans message (§2.4).
      this.#event = null;
      this.onRunOver({ survivedTicks: msg.survivedTicks, level: msg.level, kills: msg.kills });
      return;
    }
    if (msg.type !== MSG.SNAPSHOT) {
      return;
    }

    this.#buffer.push(msg, performance.now());

    // Recalage continu : sans lui, le compteur reste calé
    // sur le retard du WELCOME pour toute la vie de la connexion, et un
    // onglet remis au premier plan après une pause ne rattrape jamais les pas
    // perdus. Voir `HORDE_TICK_LAG_TOLERANCE`.
    if (msg.tick - this.#lastHordeTick > HORDE_TICK_LAG_TOLERANCE) {
      this.#lastHordeTick = msg.tick;
    }

    // Donnees d'EQUIPE, dans l'en-tete du snapshot et pas dans un bloc
    // joueur : lues AVANT le `return` ci-dessous, meme quand `mine` est
    // introuvable.
    this.#teamXp = msg.xp;
    this.#teamSynergy = msg.synergy;
    this.#teamGold = msg.gold;
    this.#boss = trackBoss(this.#boss, msg.boss);

    const mine =
      this.#localId === null ? undefined : msg.players.find((p) => p.id === this.#localId);
    if (!mine) {
      return;
    }
    // Pas predit, contrairement a la position : on prend simplement la
    // derniere valeur connue du serveur.
    this.#localHp = mine.hp;
    this.#localPickupRadius = mine.pickupRadius;
    this.#localShield = mine.shield;
    if (this.#local === null) {
      // Premier snapshot ou l'on se voit : on se pose la, sans adoucissement.
      this.#local = new PredictedPlayer(mine.x, mine.y, this.#moveMap);
      this.#local.guards = (x, y) => pushOutOfGuards(x, y, this.horde, CONTACT_RADIUS / 2);
    } else {
      this.#local.reconcile(mine.x, mine.y);
    }
  }

  /**
   * Range dans les inventaires les cartes que le serveur vient d'attribuer.
   *
   * ⚠️ **`OUTCOME.LOST` ne donne rien** : c'est le joueur qui visait une carte
   * qu'un autre a eue. Seuls `WON` (il l'a gagnee) et `AUTO` (le serveur a
   * tranche pour lui) attribuent. Traiter les trois pareil donnerait la carte
   * contestee a TOUS ses pretendants.
   *
   * La traduction elle-meme vit dans `shared/cards.ts` : c'est la MEME
   * fonction que `Room#grantCard` appelle, pas une seconde copie.
   */
  #applyDraftOutcomes(
    outcomes: readonly { playerId: number; cardIndex: number; outcome: number }[],
  ): void {
    for (const issue of outcomes) {
      if (issue.outcome === OUTCOME.LOST) {
        continue;
      }
      // Un indice qui ne designe aucune carte : le client a manque le
      // `DRAFT_OPEN` de ce tour (connexion en cours de draft).
      //
      // ⚠️ **Aucun test ne peut verrouiller cette garde** : le `catch` plus bas
      // absorberait son retrait. C'est `noUncheckedIndexedAccess` qui la tient
      // (la supprimer ne compile pas).
      const card: Card | undefined = this.#draftCards[issue.cardIndex];
      if (!card) {
        continue;
      }
      try {
        applyCardToLoadout(this.loadoutOf(issue.playerId), card);
      } catch {
        // Miroir incomplet d'un joueur DISTANT : un client qui rejoint un
        // salon en cours n'a jamais vu les `DRAFT_RESULT` d'avant sa
        // connexion, donc une montee de niveau peut porter sur une arme qu'il
        // ne lui connait pas. Purement cosmetique (le serveur arbitre seul), et
        // le sien reste exact.
      }
    }
  }

  /** `nowMs` est l'horloge murale du navigateur (`performance.now()`), portee par `update()` — voir `HitFlashes`. */
  #advanceHorde(dt: number, nowMs: number): void {
    if (this.#fields.length === 0) {
      return;
    }
    const tick = this.#lastHordeTick++;

    // ⚠️ LES ORDRES EN ATTENTE S'APPLIQUENT ICI, EN PREMIER, avant le
    // rafraichissement du champ : dans l'ordre inverse, la derive due a la
    // latence devient pire que sans rattrapage du tout. C'est la raison de la
    // file plutot qu'une application a la reception.
    while (this.#pendingOrders.length > 0) {
      const order = this.#pendingOrders.shift();
      if (order) {
        // Les pas que le serveur a deja fait faire pendant que l'ordre voyageait.
        const missed = Math.max(0, tick - order.spawnTick);
        this.horde.spawnCatchingUp(order, missed, dt, this.#fields, this.zones, this.#bossCharge);
      }
    }

    // Les positions telles que le client les connait : celles du dernier
    // snapshot recu, enregistrees sous le tick SERVEUR auquel elles ont ete
    // calculees, jamais sous le tick local `tick` : sinon `delayed()` ne
    // lirait plus la meme chose des deux cotes.
    //
    // ⚠️ Non gate par le gel : le serveur continue d'emettre des snapshots
    // pendant le gel ; le gater ouvrirait un trou dans l'anneau court de
    // `PlayerHistory`.
    const snapshot = this.#buffer.latest();
    if (snapshot) {
      this.#history.record(
        snapshot.tick,
        snapshot.players.map((p) => p.x),
        snapshot.players.map((p) => p.y),
        // Le meme ordre que le serveur, et les identifiants avec : un leurre
        // retrouve son lanceur par son id (`shared/decoys.ts`).
        snapshot.players.map((p) => p.id),
      );
    }

    // Le rafraichissement du champ et le reciblage, eux, SONT gates par le
    // gel : le serveur ne les execute pas non plus pendant le gel (`Room.step`
    // revient avant d'y arriver). Sans ce garde, `targetField` se
    // desynchroniserait.
    if (tick > this.#freezeUntilTick && tick % STEPS_PER_FIELD === 0) {
      this.#feedFields(tick, true);
    }

    // Le mouvement de la horde est module par `#movementScale`, le facteur que
    // `Room.step` applique a son propre `dt` (a `0`, le pas ne deplace rien).
    // `tick` reste le tick ABSOLU, non mis a l'echelle : il decide la phase de
    // recalcul de trajectoire, qui ne doit jamais deraper au gre du gel.
    //
    // ⚠️ **Expirer AVANT d'avancer, comme `Room.step`**, mais
    // `ROLLBACK_DEPTH_TICKS` ticks EN RETARD : `HordeHistory` ne sauvegarde
    // pas les zones, et un rejeu doit retrouver celles qui vivaient encore.
    // Une zone gardee est inerte : c'est `ZoneField.slowsAt`, pas sa presence
    // dans le tableau, qui dit si elle agit.
    this.zones.expire(tick - ROLLBACK_DEPTH_TICKS);
    const scale = this.#movementScale(tick);
    // ⚠️ **La charge REMPLACE le deplacement du boss** : `Horde.step` l'applique
    // en dernier, apres l'avancement et la separation — sans quoi il avancerait
    // deux fois. Le client passe exactement la meme valeur que le serveur,
    // recue une fois puis derivee.
    this.horde.step(dt * scale, this.#fields, tick, this.zones, this.#bossCharge);
    // Les tirs des tireurs : meme derivation que le serveur, au tick PRESENT
    // seulement (voir `EnemyShots`). Un tir qui atteint un joueur du dernier
    // snapshot s'efface — les degats, eux, viennent du serveur.
    this.shots.step(this.horde, tick, dt * scale);
    this.shots.hits(this.#buffer.latest()?.players ?? [], CONTACT_RADIUS / 2);
    // Teinte elementaire, moitie « zones » — voir `#markInZones`. Place ici,
    // apres le deplacement, comme `Room.step` place `markInZones` apres avoir
    // avance sa horde.
    this.#markInZones(tick);

    // Tir, deplacement des projectiles, collision : miroir cosmetique de
    // `Room.step`, gate par le meme garde de gel que le champ. La rampe de
    // reprise (`scale`) ne ralentit QUE le deplacement des projectiles, jamais
    // le tir, comme `Room#movementScale`.
    //
    // ⚠️ Les projectiles ne sont PAS rejoues par `#replayTick` : leur position
    // ne depend pas de la horde, et les rejouer les ferait avancer deux fois.
    if (tick > this.#freezeUntilTick) {
      this.#anchorPlayers = snapshot?.players ?? [];
      this.#fireWeapons(tick, snapshot?.players ?? [], nowMs);
      this.#pulseGuards(tick, nowMs);
      this.#sweepOndes(tick, nowMs);
      this.#strikeFrappes(tick, nowMs);
      // Le miroir cosmetique du souffle de fin de course : la
      // grenade explose meme sans avoir percute personne, cote serveur — ici
      // on en dessine le flash, au meme endroit et au meme rayon.
      this.projectiles.step(
        dt * scale,
        (slot) => {
          const souffle = this.projectiles.blastRadiusAt(slot);
          if (souffle <= 0) {
            return;
          }
          this.hitFlashes.spawn(
            this.projectiles.x[slot] ?? 0,
            this.projectiles.y[slot] ?? 0,
            weaponOf(this.projectiles.weaponAt(slot)).look.tint,
            souffle,
            this.projectiles.damageAt(slot),
            nowMs,
          );
        },
        this.horde,
        this.#anchor,
      );
      // Collision purement cosmetique : `collide` ne lit `horde` qu'en
      // lecture (position, `slotOf`) et ne consomme que les propres
      // projectiles du client — jamais un degat, jamais un `kill`, qui serait
      // prononcer une mort que le serveur n'a pas prononcee.
      this.projectiles.collide(this.horde, (entityId, _damage, projectileSlot) => {
        const slot = this.horde.slotOf(entityId);
        if (slot < 0) {
          return;
        }
        // La teinte de l'arme qui touche : `weaponAt` est le champ purement
        // cosmetique de `Projectiles`.
        this.hitFlashes.spawn(
          this.horde.x[slot] ?? 0,
          this.horde.y[slot] ?? 0,
          weaponOf(this.projectiles.weaponAt(projectileSlot)).look.tint,
          // Le souffle, lu sur le PROJECTILE : c'est le rayon qui vient de
          // decider des morts, pas celui que la table porterait aujourd'hui.
          this.projectiles.blastRadiusAt(projectileSlot),
          // La puissance, lue sur le PROJECTILE comme le souffle et l'element
          // — jamais relue dans `WEAPONS`.
          this.projectiles.damageAt(projectileSlot),
          nowMs,
        );
        this.#hitCount++;
        // ⚠️ **Le chiffre dit ce que CE tir envoie**, critique compris — il est
        // derive du tir, donc le serveur arbitre exactement le meme (voir
        // `Projectiles.critAt`). L'armure et les flaques, elles, restent
        // serveur : voir le docbloc de `DamageNumbers`.
        const critique = this.projectiles.critAt(projectileSlot);
        // ⚠️ Lu ICI, avant le chiffre, et relu tel quel plus bas pour la
        // marque : une seule lecture du creneau, deux usages.
        const element = this.projectiles.elementAt(projectileSlot);
        this.damageNumbers.spawn(
          this.horde.x[slot] ?? 0,
          this.horde.y[slot] ?? 0,
          this.projectiles.damageAt(projectileSlot) * this.projectiles.critFactorAt(projectileSlot),
          critique,
          element,
          nowMs,
        );
        // Le venin : le serveur seul en tire des degats (`Venins`) ; ici, de
        // quoi le VOIR — l'ennemi bouillonne de vert tant qu'il en porte.
        if (this.projectiles.venomAt(projectileSlot) > 0) {
          this.#poisoned.set(entityId, tick + POISON_VISUAL_TICKS);
        }
        // Teinte elementaire, moitie « mes propres projectiles » — voir
        // `#markLocally`. Le test `element !== NEUTRE` recopie celui de
        // `resolveProjectileDamage` (back/src/combat.ts) : une arme neutre ne
        // marque rien, et surtout n'EFFACE pas la marque d'une autre.
        if (element !== ELEMENT.NEUTRE) {
          this.#markLocally(slot, element, this.projectiles.ownerAt(projectileSlot), tick);
          // La chaine est un EVENEMENT, pas un etat : semee ici, jamais
          // rederivee au dessin. Voir `#seedChainFlash`.
          if (element === ELEMENT.FOUDRE) {
            this.#seedChainFlash(slot, entityId, nowMs);
          }
        }
      });
    }
    this.#bubblePoison(tick, nowMs);
    this.hitFlashes.expire(nowMs);
    this.damageNumbers.expire(nowMs);
    this.reactionFlashes.expire(nowMs);
    this.blastFlashes = this.blastFlashes.filter((b) => nowMs - b.bornMs < flashLifeMs(b));
    this.chainFlashes.expire(nowMs);

    // Instantane pour le rejeu : DOIT etre pris a chaque tick, gel ou
    // pas, sans quoi une mort qui viserait un tick gele serait « trop vieille »
    // a tort — l'anneau la jugerait absente plutot que simplement inchangee.
    this.#hordeHistory.record(tick, this.horde);
    this.#drainPendingZones(tick);
    this.#drainPendingCharges(tick);
    // Les leurres reecrivent l'anneau comme une charge : AVANT les morts.
    while (this.#pendingDecoys.length > 0) {
      const decoy = this.#pendingDecoys.shift();
      if (decoy) {
        this.#applyDecoy(decoy, tick);
      }
    }
    this.#drainPendingDeaths(tick);
  }

  /**
   * Pose une marque elementaire **cosmetique** sur un ennemi.
   *
   * ⚠️⚠️ **CETTE MARQUE EST UNE APPROXIMATION, ET ELLE DOIT LE RESTER.** Une
   * teinte de sprite est cosmetique : si le client marque un ennemi que le
   * serveur n'avait pas marque, personne ne meurt de travers. Le client marque
   * ce que SES PROPRES projectiles (cosmetiques) touchent et ce qui tombe dans
   * une zone annoncee. Il se trompe donc regulierement :
   *
   * | Ce que le serveur fait et que ce client ne fait pas | Consequence |
   * | --- | --- |
   * | consommer la marque quand une reaction a lieu | un ennemi reste teinte un peu trop longtemps |
   * | marquer depuis les projectiles des AUTRES joueurs | un ennemi teinte chez son tireur, pas ici |
   * | ne pas marquer un ennemi tue du meme impact | une teinte d'un tick sur un mourant |
   *
   * **Et ca ne coute rien**, parce que rien de ce que ce fichier ecrit ici
   * n'entre dans une decision :
   *
   * - `Horde.step` ne lit JAMAIS `mark` — le ralentissement du Givre vient des
   *   ZONES (`ZoneField.slowsAt`, via `Horde#computeSlow`), qui sont annoncees
   *   et datees par tick. Une marque fausse ne peut donc pas deplacer une
   *   entite d'un pixel ;
   * - les degats, les morts et les reactions sont arbitres serveur et annonces
   *   (`DEATHS`, `REACTION`). Le client n'en prononce aucun.
   *
   * ⚠️ **NE PAS « CORRIGER » CETTE APPROXIMATION EN LA RENDANT AUTORITAIRE.**
   * La rendre exacte demanderait de refaire l'arbitrage des reactions cote
   * client, et d'inviter la divergence dans la replication de la horde. Si la
   * teinte parait fausse, on la juge a l'oeil.
   */
  #markLocally(slot: number, element: number, by: number, tick: number): void {
    this.horde.applyMark(slot, element, by, tick);
  }

  /**
   * Seme un flash de chaine de Foudre, **au moment de l'impact predit par CE
   * client** — jamais depuis une annonce du serveur.
   *
   * ⚠️ **Meme contrat que `#markLocally`** : semee depuis les PROPRES
   * projectiles de ce client, jamais ceux des autres. Consequences assumees :
   *
   * | Ce que le serveur fait et que ce client ne fait pas | Consequence |
   * | --- | --- |
   * | chainer depuis les projectiles des AUTRES joueurs | une chaine tiree par un allie n'apparait pas ici |
   * | exclure les morts DU MEME tick (`dead`, cote serveur) | ce client ne connait aucune mort avant `DEATHS` : son chemin peut differer du serveur d'un maillon si un voisin vient tout juste de mourir d'un AUTRE impact |
   *
   * **NE PAS « CORRIGER » EN LA RENDANT AUTORITAIRE**, comme pour
   * `#markLocally` : exclure les morts demanderait de refaire une part de
   * l'arbitrage serveur.
   *
   * ⚠️ **Le CHEMIN est calcule UNE FOIS, ICI, et FIGE dans `chainFlashes`** :
   * `chainTargets` n'est appele qu'a l'impact, jamais a chaque image (voir
   * `CHAIN_FLASH_LIFETIME_MS`).
   */
  #seedChainFlash(slot: number, entityId: number, nowMs: number): void {
    const cx = this.horde.x[slot] ?? 0;
    const cy = this.horde.y[slot] ?? 0;
    const path = chainTargets(this.horde, cx, cy, CHAIN_RADIUS, CHAIN_JUMPS, new Set([entityId]));
    if (path.length === 0) {
      return;
    }
    const points: { x: number; y: number }[] = [{ x: cx, y: cy }];
    for (const id of path) {
      const s = this.horde.slotOf(id);
      // INATTEIGNABLE par construction : `chainTargets` ne rend que des
      // identites lues DANS `horde` a l'instant meme, sans compaction entre
      // les deux. Gardee quand meme, par prudence.
      if (s >= 0) {
        points.push({ x: this.horde.x[s] ?? 0, y: this.horde.y[s] ?? 0 });
      }
    }
    this.chainFlashes.spawn(points, nowMs);
  }

  /**
   * Teinte les ennemis couverts par une zone — moitie « zones » de
   * l'approximation decrite sur `#markLocally`, et miroir COSMETIQUE de
   * `markInZones` (back/src/combat.ts).
   *
   * ⚠️ **Miroir de la moitie qui teinte, jamais de celle qui arbitre.** Le
   * balayage serveur passe par `applyElement`, qui declenche les reactions ;
   * celui-ci pose la marque et rien d'autre.
   *
   * ⚠️ **`aliveAt`, pas `slowsAt`** — meme predicat que cote serveur : c'est
   * lui qui dit si la zone EXISTE, alors qu'elle ne ralentit qu'a partir de
   * `T + 1` (le deplacement de `T` etait deja joue). Confondre les deux ferait
   * clignoter la teinte d'un tick a la pose de chaque zone.
   *
   * Le serveur, lui, ne marque pas au tick de la pose : ses champs naissent de
   * `applyReactions`, APRES son `markInZones`. Un tick d'ecart sur une teinte,
   * approximation assumee (voir `#markLocally`).
   *
   * Cout : O(zones x entites) par tick, comme cote serveur.
   */
  #markInZones(tick: number): void {
    const r2 = ZONE_RADIUS * ZONE_RADIUS;
    for (let z = 0; z < this.zones.count; z++) {
      if (!this.zones.aliveAt(z, tick)) {
        continue;
      }
      const element = zoneElement(this.zones.kind[z] ?? 0);
      const by = this.zones.by[z] ?? 0;
      const zx = this.zones.x[z] ?? 0;
      const zy = this.zones.y[z] ?? 0;
      for (let i = 0; i < this.horde.count; i++) {
        const dx = (this.horde.x[i] ?? 0) - zx;
        const dy = (this.horde.y[i] ?? 0) - zy;
        if (dx * dx + dy * dy < r2) {
          this.#markLocally(i, element, by, tick);
        }
      }
    }
  }

  /**
   * Les invocations vivantes, cote client — la meme liste que celle
   * du serveur, derivee des memes trois choses, plus la TEINTE de l'arme qui
   * n'interesse que le dessin.
   */
  #guards: GuardTrace[] = [];

  /** Les invocations vivantes, en lecture pour le calque de l'aura. */
  get guards(): readonly GuardTrace[] {
    return this.#guards;
  }

  /**
   * Dessine une pulsation par invocation due a ce tick, et oublie celles qui
   * se sont eteintes — le miroir cosmetique de `Room#pulseGuards`.
   *
   * ⚠️ **Elle NE SECOUE PAS l'ecran** (`shakes: false`), comme le halo : une
   * invocation frappe en continu, et la secousse deviendrait permanente.
   */
  #pulseGuards(tick: number, nowMs: number): void {
    if (this.#guards.length === 0) {
      return;
    }
    for (const guard of this.#guards) {
      if (!guardPulsesAt(guard, tick)) {
        continue;
      }
      // L'aura est DESSINEE en continu par son calque ; une
      // pulsation n'est plus un grand disque, c'est la brulure sur chaque
      // ennemi touche — petit flash, chiffre, marque du plus proche, la meme
      // geometrie que `resolveHalos`.
      const c = guardCenter(guard, this.#anchor);
      const cx = c.x;
      const cy = c.y;
      const r2 = guard.radius * guard.radius;
      let nearest = -1;
      let nearestD2 = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.horde.count; i++) {
        const ex = this.horde.x[i] ?? 0;
        const ey = this.horde.y[i] ?? 0;
        const d2 = (ex - cx) * (ex - cx) + (ey - cy) * (ey - cy);
        if (d2 > r2) {
          continue;
        }
        this.hitFlashes.spawn(ex, ey, guard.tint, 0, guard.damage, nowMs, false);
        this.damageNumbers.spawn(ex, ey, guard.damage, false, guard.element, nowMs);
        if (d2 < nearestD2) {
          nearestD2 = d2;
          nearest = i;
        }
      }
      if (nearest >= 0 && guard.element !== ELEMENT.NEUTRE) {
        this.#markLocally(nearest, guard.element, guard.by, tick);
      }
    }
    this.#guards = this.#guards.filter((g) => guardIsAlive(g, tick));
  }

  /** Les joueurs que `#anchor` lit : ceux du dernier snapshot, pose a chaque tick avant `step`. */
  #anchorPlayers: readonly PlayerSnapshot[] = [];
  /** Le point que `#anchor` rend, reutilise : aucune allocation par projectile et par tick. */
  readonly #anchorPoint = { x: 0, y: 0 };
  /**
   * Ou est le tireur `by` a ce tick — la MEME source que
   * `#fireWeapons` : la position simulee pour le joueur local, celle du dernier
   * snapshot pour les autres. Creee une fois ; l'orbite et le retour du
   * boomerang la lisent.
   */
  readonly #anchor: Anchor = (by) => {
    const local = by === this.#localId ? this.#local : null;
    if (local) {
      this.#anchorPoint.x = local.simX;
      this.#anchorPoint.y = local.simY;
      return this.#anchorPoint;
    }
    for (const p of this.#anchorPlayers) {
      if (p.id === by) {
        this.#anchorPoint.x = p.x;
        this.#anchorPoint.y = p.y;
        return this.#anchorPoint;
      }
    }
    return undefined;
  };

  /**
   * Les ondes vivantes, cote client : la liste du serveur,
   * derivee des memes trois choses, plus ce qui n'interesse que le dessin
   * (teinte, horloge murale de naissance). Lecture publique pour
   * `OndeFrappeRenderer`.
   */
  readonly ondes: OndeTrace[] = [];
  /**
   * Les impacts de frappe, en attente PUIS frappes (`struckMs >= 0`) le temps
   * de l'eclair, `FRAPPE_BOLT_MS`. Lecture publique pour `OndeFrappeRenderer`.
   */
  readonly frappes: FrappeTrace[] = [];

  /**
   * Fait avancer chaque onde d'une bande, miroir cosmetique de la resolution
   * serveur : flash (SANS secousse — une onde est une nappe, pas une
   * explosion) et chiffre pour chaque ennemi franchi, marque du plus proche
   * (une reaction par source). Oublie les ondes eteintes, en place.
   */
  #sweepOndes(tick: number, nowMs: number): void {
    let kept = 0;
    for (const onde of this.ondes) {
      const band = ondeBand(onde, tick);
      if (band === null) {
        continue;
      }
      this.ondes[kept++] = onde;
      let nearest = -1;
      let nearestD = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.horde.count; i++) {
        const ex = this.horde.x[i] ?? 0;
        const ey = this.horde.y[i] ?? 0;
        const d = Math.hypot(ex - onde.x, ey - onde.y);
        if (d <= band.inner || d > band.outer) {
          continue;
        }
        this.hitFlashes.spawn(ex, ey, onde.tint, 0, onde.damage, nowMs, false);
        this.damageNumbers.spawn(ex, ey, onde.damage, false, onde.element, nowMs);
        this.#hitCount++;
        if (d < nearestD) {
          nearestD = d;
          nearest = i;
        }
      }
      if (nearest >= 0 && onde.element !== ELEMENT.NEUTRE) {
        this.#markLocally(nearest, onde.element, onde.by, tick);
      }
    }
    this.ondes.length = kept;
  }

  /**
   * Frappe les impacts echus — le flash existant AVEC secousse (c'est un
   * evenement, pas une pulsation), un chiffre par ennemi dans le rayon, la
   * marque du plus proche — et oublie ceux dont l'eclair s'est eteint.
   * L'horloge murale ne sert qu'au dessin : l'echeance, elle, est au tick.
   */
  #strikeFrappes(tick: number, nowMs: number): void {
    let kept = 0;
    for (const impact of this.frappes) {
      if (impact.struckMs < 0 && frappeIsDue(impact, tick)) {
        impact.struckMs = nowMs;
        this.#strike(impact, tick, nowMs);
      }
      if (impact.struckMs < 0 || nowMs - impact.struckMs < FRAPPE_BOLT_MS) {
        this.frappes[kept++] = impact;
      }
    }
    this.frappes.length = kept;
  }

  #strike(impact: FrappeTrace, tick: number, nowMs: number): void {
    this.hitFlashes.spawn(impact.x, impact.y, impact.tint, impact.radius, impact.damage, nowMs);
    const r2 = impact.radius * impact.radius;
    let nearest = -1;
    let nearestD2 = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.horde.count; i++) {
      const ex = this.horde.x[i] ?? 0;
      const ey = this.horde.y[i] ?? 0;
      const d2 = (ex - impact.x) * (ex - impact.x) + (ey - impact.y) * (ey - impact.y);
      if (d2 > r2) {
        continue;
      }
      this.damageNumbers.spawn(ex, ey, impact.damage, false, impact.element, nowMs);
      this.#hitCount++;
      if (d2 < nearestD2) {
        nearestD2 = d2;
        nearest = i;
      }
    }
    if (nearest >= 0 && impact.element !== ELEMENT.NEUTRE) {
      this.#markLocally(nearest, impact.element, impact.by, tick);
    }
  }

  /**
   * Tire les salves dues, cote client — miroir cosmetique de
   * `Room#fireWeapons` ; les degats restent arbitres par le serveur.
   *
   * ⚠️ **Parcourt TOUT l'arsenal de chaque joueur**, dans l'ordre du serveur :
   * l'arme neutre d'abord, TOUJOURS (hors des slots, dans aucun `Loadout`),
   * puis les armes draftees dans leur ordre d'acquisition.
   *
   * ⚠️ **La visee suit le curseur, sans ciblage dans `horde`.** Une visee
   * nulle ne tire pas, comme cote serveur (`Projectiles.fireSalvoDirected`).
   *
   * `players` vient du dernier snapshot connu. Le joueur local utilise sa
   * position simulee (`#local.simX/simY`) et sa visee locale (`#localAim`,
   * DEJA quantifiee), plus a jour que son bloc du snapshot. Les allies n'ont
   * pas d'autre source que ce bloc, d'ou la visee transmise par `SNAPSHOT`.
   */
  #fireWeapons(tick: number, players: readonly PlayerSnapshot[], nowMs: number): void {
    if (players.length === 0) {
      return;
    }

    for (const p of players) {
      if (p.hp <= 0) {
        continue;
      }
      const local = p.id === this.#localId ? this.#local : null;
      const x = local ? local.simX : p.x;
      const y = local ? local.simY : p.y;
      const aimX = local ? this.#localAim.x : p.aimX;
      const aimY = local ? this.#localAim.y : p.aimY;
      if (aimX === 0 && aimY === 0) {
        continue;
      }
      const loadout = this.loadoutOf(p.id);
      for (const weaponId of loadout.weaponIds) {
        this.#fireOne(p.id, weaponId, loadout, tick, x, y, aimX, aimY, nowMs);
      }
    }
  }

  /**
   * Tire une salve de cette arme si SA PROPRE recharge est faite — miroir de
   * `Room#fireOne`, passifs empiles compris.
   *
   * ⚠️ **`cooldownWithBonus` vient de `shared/weapons.ts`, pas d'une copie
   * locale** : c'est la fonction que le serveur applique. Les degats suivent
   * la meme regle : un projectile affiche porte le nombre que le serveur
   * arbitre.
   *
   * ⚠️ **Les bonus de COMPTE s'ajoutent aux passifs du draft, sur les deux
   * calculs**, comme dans `Room#fireOne`. En omettre un fait perdre des salves
   * (l'arrondi de `cooldownWithBonus` amplifie le bonus sur une recharge
   * courte), et la phase de tir derive sans borne. Comme `#markLocally` n'est
   * appele que depuis `projectiles.collide`, la teinte elementaire serait
   * posee moins souvent que le serveur ne marque : des reactions partiraient
   * sans que le joueur les voie venir.
   */
  #fireOne(
    playerId: number,
    weaponId: number,
    loadout: Loadout,
    tick: number,
    x: number,
    y: number,
    aimX: number,
    aimY: number,
    /** Horloge murale, pour le flash d'une pulsation de halo — voir plus bas. */
    nowMs: number,
  ): void {
    // La MEME fonction que `Room#fireOne` (`shared/firing.ts`), passifs
    // globaux (Volee, Ampleur) compris.
    const weapon = armedWeapon(loadout, weaponId);
    const cooldown = cooldownWithBonus(
      weapon.cooldownTicks,
      loadout.bonus('fireRate') +
        this.accountBonuses.fireRate +
        FIRE_RATE_PER_UPGRADE * loadout.upgradesOf(weaponId, UPGRADE.FIRE_RATE),
    );
    let last = this.#lastFireTick.get(playerId);
    if (!last) {
      last = new Float64Array(WEAPONS.length).fill(Number.NEGATIVE_INFINITY);
      this.#lastFireTick.set(playerId, last);
    }
    if (tick - (last[weaponId] ?? Number.NEGATIVE_INFINITY) < cooldown) {
      return;
    }
    // ⚠️ Le PV max d'un ALLIE se derive ici avec les bonus de compte du joueur
    // LOCAL, la meme approximation que `accountBonuses.damage`. Cosmetique.
    //
    // ⚠️ **`maxHpOf`, pas une copie de la somme** : Colosse
    // (`shared/firing.ts`) echelonne ses degats sur ce `maxHp`, et
    // Transcendance le modifie. Une copie predirait des degats que le serveur
    // n'arbitre pas.
    const damage = shotDamage(
      weapon,
      loadout,
      this.accountBonuses.damage,
      maxHpOf(loadout, this.accountBonuses.maxHp),
    );
    // Meme fonctions (`armedWeapon`, `shotDamage`) que `Room#fireOne` : deux
    // formules divergeraient, et le joueur verrait une salve que le serveur
    // n'arbitre pas.
    if (weapon.kind === 'halo') {
      // ⚠️ **Le miroir cosmetique d'une pulsation de halo est un FLASH, pas un
      // projectile** : il porte le rayon que le serveur vient d'arbitrer
      // (`armedWeapon`, la meme fonction des deux cotes), donc le disque
      // dessine ne peut pas mentir sur la portee — meme discipline que
      // `reactionFlashScale` face a `REACTION_RADIUS`.
      //
      // ⚠️ **Il ne SECOUE PAS** : un halo pulse sans arret. Voir
      // `HitFlashes.shakes`.
      this.hitFlashes.spawn(
        x,
        y,
        weapon.look.tint,
        weapon.blastRadius,
        weapon.damage,
        nowMs,
        false,
      );
      last[weaponId] = tick;
      return;
    }
    if (weapon.kind === 'invocation') {
      // ⚠️ **Le miroir garde la MEME liste que le serveur**, derivee des memes
      // trois choses (l'arme, le tick, la position du tireur) : rien n'est
      // annonce pour une invocation. Ce que le client en fait est cosmetique —
      // une pulsation dessinee par `#pulseGuards` — mais la liste, elle, est
      // la meme.
      this.#guards.push({
        x,
        y,
        bornTick: tick,
        lifeTicks: weapon.projectileLifeTicks,
        radius: weapon.blastRadius,
        damage: weapon.damage,
        element: weapon.element,
        by: playerId,
        // La teinte voyage AVEC l'invocation, pas a cote : c'est elle qui dira
        // a l'ecran de quelle arme vient la pulsation.
        tint: weapon.look.tint,
        bornMs: nowMs,
      });
      last[weaponId] = tick;
      return;
    }
    if (weapon.kind === 'faisceau') {
      // ⚠️ **Le miroir cosmetique d'un faisceau est une POLYLIGNE a deux
      // points, et elle reutilise le calque de la chaine de Foudre**, seul
      // calque qui trace un trait entre deux points du monde.
      //
      // Les deux bouts sont derives comme cote serveur (`beamRange` et la
      // visee), donc le trait dessine est exactement celui que le serveur
      // vient de faucher.
      // La visee n'est PAS unitaire : voir `aimPoint`.
      const { x: toX, y: toY } = aimPoint(x, y, aimX, aimY, beamRange(weapon));
      this.chainFlashes.spawn(
        [
          { x, y },
          { x: toX, y: toY },
        ],
        nowMs,
        weapon.look.tint,
        2 * weapon.blastRadius,
        playerId,
      );
      // Le retour d'impact, meme geometrie que `resolveBeams` : sans lui, le
      // rayon aurait l'air de ne rien faire. Cosmetique, comme
      // `projectiles.collide`.
      const w2 = weapon.blastRadius * weapon.blastRadius;
      let nearest = -1;
      let nearestD2 = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.horde.count; i++) {
        const ex = this.horde.x[i] ?? 0;
        const ey = this.horde.y[i] ?? 0;
        if (distanceToSegmentSquared(ex, ey, x, y, toX, toY) >= w2) {
          continue;
        }
        this.hitFlashes.spawn(ex, ey, weapon.look.tint, 0, damage, nowMs, false);
        this.damageNumbers.spawn(ex, ey, damage, false, weapon.element, nowMs);
        this.#hitCount++;
        const d2 = (ex - x) * (ex - x) + (ey - y) * (ey - y);
        if (d2 < nearestD2) {
          nearestD2 = d2;
          nearest = i;
        }
      }
      if (nearest >= 0 && weapon.element !== ELEMENT.NEUTRE) {
        this.#markLocally(nearest, weapon.element, playerId, tick);
      }
      last[weaponId] = tick;
      return;
    }
    if (weapon.kind === 'onde') {
      // ⚠️ Le plafond est cosmetique : le serveur arbitre toutes ses ondes,
      // ce calque n'en dessine que `ONDE_TRACE_CAPACITY` a la fois.
      if (this.ondes.length < ONDE_TRACE_CAPACITY) {
        this.ondes.push({
          x,
          y,
          bornTick: tick,
          speed: weapon.projectileSpeed,
          maxRadius: weapon.blastRadius,
          damage,
          element: weapon.element,
          by: playerId,
          tint: weapon.look.tint,
          bornMs: nowMs,
        });
      }
      last[weaponId] = tick;
      return;
    }
    if (weapon.kind === 'frappe') {
      // Le point vise a PORTEE de l'arme (la visee n'est qu'une
      // direction), et les cibles choisies sur NOTRE horde — approximation
      // cosmetique, comme la chaine de Foudre.
      const vise = aimPoint(x, y, aimX, aimY, beamRange(weapon));
      for (const p of frappeTargets(this.horde, vise.x, vise.y, weapon.projectileCount)) {
        if (this.frappes.length >= FRAPPE_TRACE_CAPACITY) {
          break;
        }
        this.frappes.push({
          x: p.x,
          y: p.y,
          radius: weapon.blastRadius,
          damage,
          element: weapon.element,
          by: playerId,
          dueTick: frappeDueTick(tick),
          tint: weapon.look.tint,
          bornMs: nowMs,
          struckMs: -1,
        });
      }
      last[weaponId] = tick;
      return;
    }
    const count = weapon.projectileCount;
    // ⚠️ **Le tireur ET son critique**, comme `Room#fireOne` : sans `playerId`
    // le tirage partait de `hashRoll(tick, 0, i)`, et le critique affiche
    // n'etait pas celui que le serveur arbitre.
    this.projectiles.fireSalvoDirected(
      weapon,
      tick,
      x,
      y,
      aimX,
      aimY,
      damage,
      count,
      playerId,
      critOf(loadout),
    );
    last[weaponId] = tick;
  }

  /**
   * Applique toutes les zones recues mais pas encore posees, au tick local
   * `currentTick`.
   *
   * ⚠️ **APPELE AVANT `#drainPendingDeaths`, et l'ordre n'est pas
   * interchangeable.** Les deux rejouent, et un rejeu REECRIT l'anneau depuis
   * son tick de depart. Si une mort du tick `D` etait rejouee d'abord, puis
   * une zone du tick `Z < D`, la restauration au tick `Z` rendrait un etat
   * d'AVANT la mort, et le rejeu de `Z+1..present` ecraserait l'anneau avec
   * une horde ou l'entite tuee est toujours vivante : **la mort serait
   * perdue**. Dans l'autre sens, la zone est deja posee quand la mort rejoue,
   * donc le rejeu de la mort la reapplique — quel que soit l'ordre des ticks.
   */
  #drainPendingZones(currentTick: number): void {
    while (this.#pendingZones.length > 0) {
      const zone = this.#pendingZones.shift();
      if (zone) {
        this.#applyZone(zone, currentTick);
      }
    }
  }

  /**
   * Pose une zone annoncee, par rejeu — meme mecanique que `#applyDeaths`, et
   * pour la meme raison.
   *
   * ⚠️ **L'effet est DATE PAR TICK, jamais applique a la reception.** Le
   * serveur ralentit depuis `bornTick` ; le message arrive quelques ticks plus
   * tard. L'appliquer au present ferait diverger le client de sa latence
   * exacte, sur un effet qui touche le DEPLACEMENT.
   *
   * `bornTick >= currentTick` : rien a rejouer. Une zone ne ralentit qu'a
   * partir du tick SUIVANT sa pose (voir `ZoneField.slowsAt`), donc son effet
   * est encore entierement devant nous.
   *
   * ⚠️ **La zone est posee AVANT le rejeu**, sans quoi le rejeu avancerait la
   * horde sans elle et ne corrigerait rien.
   */
  #applyZone(zone: ZoneMessage, currentTick: number): void {
    if (zone.bornTick >= currentTick) {
      this.zones.spawn(zone.kind, zone.x, zone.y, zone.by, zone.bornTick);
      return;
    }
    if (!this.#hordeHistory.restore(zone.bornTick, this.horde)) {
      // Trop vieux pour l'anneau : pose au present, et SIGNALE — meme
      // degradation assumee que pour une mort trop vieille, meme refus de la
      // faire en silence. Voir `#lateZones`.
      this.#lateZones++;
      this.zones.spawn(zone.kind, zone.x, zone.y, zone.by, zone.bornTick);
      return;
    }
    this.zones.spawn(zone.kind, zone.x, zone.y, zone.by, zone.bornTick);
    this.#primeFieldForReplay(zone.bornTick);
    for (let t = zone.bornTick + 1; t <= currentTick; t++) {
      this.#replayTick(t);
    }
  }

  /**
   * Applique toutes les charges recues mais pas encore installees, au tick local
   * `currentTick`.
   *
   * ⚠️ **APPELE AVANT `#drainPendingDeaths`, comme les zones et pour la meme
   * raison** : un rejeu REECRIT l'anneau depuis son tick de depart, donc une
   * mort rejouee d'abord puis une charge plus ancienne rejouee ensuite
   * ressusciterait l'entite tuee. Dans cet ordre-ci, la charge est deja
   * installee quand la mort rejoue, et le rejeu de la mort la reapplique.
   */
  #drainPendingCharges(currentTick: number): void {
    while (this.#pendingCharges.length > 0) {
      const charge = this.#pendingCharges.shift();
      if (charge) {
        this.#applyBossCharge(charge, currentTick);
      }
    }
  }

  /**
   * Installe une charge annoncee, par rejeu — meme mecanique que `#applyZone`,
   * et pour une raison plus forte encore.
   *
   * ⚠️ **UNE CHARGE DEPLACE LE BOSS.** Une zone ralentit ; une charge, elle,
   * PILOTE une position. L'installer au present ferait deriver le boss de la
   * latence exacte du message pendant tout le reste de la traversee — et le
   * rejeu ramene cet ecart a zero (scenario 11 de
   * `shared/horde.replication.test.ts`).
   *
   * `windupTick >= currentTick` : rien a rejouer. C'est le cas NOMINAL, le
   * chargement (`BOSS_CHARGE_WINDUP_TICKS`) durant bien plus que le trajet
   * d'un message ; le rejeu ne sert qu'a la queue de distribution.
   *
   * ⚠️ **La charge est installee AVANT le rejeu**, sans quoi le rejeu avancerait
   * le boss sans elle et ne corrigerait rien.
   */
  #applyBossCharge(msg: BossChargeMessage, currentTick: number): void {
    const charge: BossCharge = {
      entityId: msg.entityId,
      x: msg.x,
      y: msg.y,
      dirX: msg.dirX,
      dirY: msg.dirY,
      length: msg.length,
      width: msg.width,
      windupTick: msg.windupTick,
      startTick: msg.startTick,
      endTick: msg.endTick,
    };
    this.#bossCharge = charge;
    if (charge.windupTick >= currentTick) {
      return;
    }
    if (!this.#hordeHistory.restore(charge.windupTick, this.horde)) {
      // Trop vieille pour l'anneau : installee au present, et SIGNALEE — meme
      // degradation assumee que pour une mort ou une zone trop vieille.
      this.#lateCharges++;
      return;
    }
    this.#primeFieldForReplay(charge.windupTick);
    for (let t = charge.windupTick + 1; t <= currentTick; t++) {
      this.#replayTick(t);
    }
  }

  /**
   * Applique tous les lots de morts recus mais pas encore traites, au tick
   * local `currentTick` — celui que `#advanceHorde` vient de simuler et
   * d'enregistrer dans `#hordeHistory`.
   *
   * ⚠️ Suppose la file triee par tick SERVEUR, sans le reverifier : `Room.step`
   * n'emet qu'UN `DEATHS` par tick, et WebSocket livre les trames dans leur
   * ordre d'emission. Rejouer un lot plus recent AVANT un plus ancien
   * effacerait la correction du second par le rejeu du premier.
   */
  #drainPendingDeaths(currentTick: number): void {
    while (this.#pendingDeaths.length > 0) {
      const batch = this.#pendingDeaths.shift();
      if (batch) {
        this.#applyDeaths(batch.tick, batch.ids, currentTick);
      }
    }
  }

  /**
   * Applique un lot de morts par rejeu : restaure la horde au tick de la mort,
   * tue, rejoue jusqu'au present. Appliquer directement au present laisserait
   * un ecart s'installer, que la separation propage aux voisines : sans rejeu,
   * la derive croit sans borne (scenario 8 de `horde.replication.test.ts`).
   *
   * Les orbes sont derives ICI, a la position lue dans la horde restauree —
   * juste avant `kill`, comme `resolveProjectileDamage` cote serveur lit la
   * position juste avant sa propre compaction (voir `back/src/combat.ts`).
   *
   * ⚠️ Le rejeu ne rejoue QUE le mouvement — champ, horde, separation — jamais
   * l'arbitrage (degats, contact, ramassages), prerogative du serveur. Un
   * client qui le rejouerait prononcerait des morts que le serveur n'a pas
   * decidees.
   */
  #applyDeaths(deathTick: number, ids: readonly number[], currentTick: number): void {
    this.#kills += ids.length;
    if (!this.#hordeHistory.restore(deathTick, this.horde)) {
      // Trop vieux pour l'anneau (`ROLLBACK_DEPTH_TICKS`) : applique au
      // present, et SIGNALE au HUD : une degradation silencieuse est un piege.
      // Le scenario 10 de `horde.replication.test.ts` mesure la derive
      // residuelle de ce chemin.
      this.#spawnOrbs(ids, deathTick);
      this.#lateDeaths += ids.length;
      this.horde.kill(ids);
      this.#forgetChargeOf(ids);
      return;
    }
    this.#spawnOrbs(ids, deathTick);
    this.horde.kill(ids);
    this.#forgetChargeOf(ids);
    // ⚠️ Le champ de flux n'est pas dans l'anneau : `HordeHistory.restore`
    // remet la HORDE au tick de la mort, mais `FlowField` est un objet mutable
    // PARTAGE que l'anneau ne sauvegarde jamais. Sans ce reamorcage, le rejeu
    // demarrerait avec le contenu du DERNIER rafraichissement reel — celui du
    // tick present, plus frais que ce que le serveur avait au tick restaure,
    // et le rejeu deriverait.
    this.#primeFieldForReplay(deathTick);
    for (let t = deathTick + 1; t <= currentTick; t++) {
      this.#replayTick(t);
    }
  }

  /**
   * Oublie la charge en cours si c'est SON boss qui vient de mourir.
   *
   * ⚠️ **C'est le RENDU que ca protege, pas la simulation.** `Horde#applyCharge`
   * ne trouve deja plus de creneau pour une entite morte, donc rien ne bougeait
   * de travers ; mais le rectangle d'annonce, lui, continuerait de s'afficher
   * jusqu'a `endTick` au-dessus d'un boss qui n'existe plus.
   */
  #forgetChargeOf(ids: readonly number[]): void {
    const charge = this.#bossCharge;
    if (charge && ids.includes(charge.entityId)) {
      this.#bossCharge = null;
    }
  }

  /** Fait apparaitre un orbe par identite morte, a sa position dans la horde COURANTE (avant `kill`). */
  #spawnOrbs(ids: readonly number[], tick: number): void {
    for (const id of ids) {
      const slot = this.horde.slotOf(id);
      if (slot >= 0) {
        this.orbs.spawn(id, this.horde.x[slot] ?? 0, this.horde.y[slot] ?? 0, tick);
        // Un kamikaze qui meurt explose : le serveur l'a deja resolu, le client
        // n'en montre que l'eclair, a la position d'AVANT `kill`.
        if (archetypeOf(this.horde.archetype[slot] ?? 0).behavior === 'kamikaze') {
          this.blastFlashes.push({
            x: this.horde.x[slot] ?? 0,
            y: this.horde.y[slot] ?? 0,
            bornMs: performance.now(),
          });
        }
      }
    }
  }

  /**
   * Remet le champ a son contenu du dernier rafraichissement du a `atTick` ou
   * avant — jamais `atTick` lui-meme, sauf s'il tombe pile sur une frontiere.
   * Version de reference : `primeFieldForReplay` de `shared/horde.replication.test.ts`.
   */
  #primeFieldForReplay(atTick: number): void {
    const lastDue = atTick - (((atTick % STEPS_PER_FIELD) + STEPS_PER_FIELD) % STEPS_PER_FIELD);
    this.#feedFields(lastDue, false);
  }

  /**
   * L'entree du champ au tick `tick` : les positions RETARDEES, leurres
   * substitues au tick des positions (`seen.tick`) — la meme fonction et le
   * meme tick que `Room#step`. Les trois sites du miroir (pas courant, rejeu,
   * amorce du rejeu) passent ici : trois copies de la regle divergeraient, et
   * un cran de decalage sur l'entree reassigne toute la horde.
   */
  #feedFields(tick: number, retarget: boolean): void {
    const seen = this.#history.delayed(tick);
    if (!seen) {
      return;
    }
    const cible = substituteDecoys(seen.ids, seen.x, seen.y, this.#decoys, seen.tick);
    for (let f = 0; f < cible.x.length && f < this.#fields.length; f++) {
      this.#fields[f]?.update(cible.x[f] ?? 0, cible.y[f] ?? 0);
    }
    if (retarget) {
      this.horde.retarget(cible.x, cible.y);
    }
  }

  /**
   * Plante un leurre annonce, par rejeu — le patron de `#applyBossCharge`,
   * eprouve a 0,000 px par le scenario AP2 de `shared/horde.replication.test.ts`.
   *
   * Un leurre n'agit que sur des positions de `bornTick` ou plus recentes, et
   * l'entree du champ est lue `FIELD_INPUT_DELAY_TICKS` en retard : tant que
   * l'annonce arrive dans ce delai, aucun pas deja simule ne l'a manque. Au-dela,
   * on restaure l'anneau a la naissance du leurre et on rejoue.
   */
  #applyDecoy(decoy: Decoy, currentTick: number): void {
    // Garde un leurre au-dela de sa vie le temps qu'un rejeu puisse encore
    // revisiter ses ticks (`ROLLBACK_DEPTH_TICKS`) : `substituteDecoys` ignore
    // de toute facon un leurre expire au tick des positions.
    this.#decoys = this.#decoys.filter(
      (d) =>
        currentTick - d.bornTick <
        DECOY_LIFETIME_TICKS + FIELD_INPUT_DELAY_TICKS + ROLLBACK_DEPTH_TICKS,
    );
    this.#decoys.push(decoy);
    if (decoy.bornTick >= currentTick) {
      return;
    }
    if (!this.#hordeHistory.restore(decoy.bornTick, this.horde)) {
      // Trop vieux pour l'anneau : plante au present, et SIGNALE — meme
      // degradation assumee que pour une charge ou une zone trop vieille.
      this.#lateDecoys++;
      return;
    }
    this.#primeFieldForReplay(decoy.bornTick);
    for (let t = decoy.bornTick + 1; t <= currentTick; t++) {
      this.#replayTick(t);
    }
  }

  /**
   * Un pas de rejeu : rafraichit le champ si du, recalcule la trajectoire des
   * entites en phase puis avance la horde — les etapes 4 et 6 de la sequence
   * serveur, jamais l'arbitrage (7 a 9). Reecrit aussi l'anneau pour ce tick :
   * une mort suivante qui viserait l'un de ces ticks doit restaurer la
   * version rejouee, pas l'ancienne version d'avant correction.
   *
   * ⚠️ `tick` doit etre le meme tick ABSOLU que celui utilise par la
   * simulation d'origine (voir `Horde.step`) : c'est lui qui determine la
   * phase de recalcul de trajectoire, pas un compteur propre au rejeu.
   */
  #replayTick(tick: number): void {
    if (tick > this.#freezeUntilTick && tick % STEPS_PER_FIELD === 0) {
      this.#feedFields(tick, true);
    }
    const scale = this.#movementScale(tick);
    this.horde.step(FIXED_DT * scale, this.#fields, tick, this.zones, this.#bossCharge);
    this.#hordeHistory.record(tick, this.horde);
  }

  /**
   * Facteur applique au `dt` de tout ce qui bouge (la horde) : `0` pendant
   * le gel strict, une rampe de `0` (exclu) a `1` pendant les
   * `LEVEL_RESUME_TICKS` qui suivent, `1` en fonctionnement normal. Miroir
   * exact de `Room#movementScale` cote serveur — necessaire pour que le rejeu
   * d'un tick gele ou en reprise avance exactement comme le serveur l'a fait.
   */
  #movementScale(tick: number): number {
    if (tick > this.#resumeEndTick) {
      return 1;
    }
    const sinceFreezeEnd = tick - this.#freezeUntilTick;
    return Math.min(1, Math.max(0, sinceFreezeEnd / LEVEL_RESUME_TICKS));
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status !== status) {
      this.#status = status;
      this.onStatusChange(status);
    }
  }
}
