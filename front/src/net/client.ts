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
  PLAYER_MAX_HP,
  PLAYER_SPEED,
  PROJECTILE_CAPACITY,
  ROLLBACK_DEPTH_TICKS,
  TICK_HZ,
  ZONE_RADIUS,
} from '@shared/constants';
import { type Decoy, substituteDecoys } from '@shared/decoys';
import { ELEMENT } from '@shared/elements';
import { EnemyShots } from '@shared/enemy-shots';
import { armedWeapon, critOf, shotDamage } from '@shared/firing';
import { FlowField } from '@shared/flowfield';
import { entityIdOf, Horde, leavesDrop, pushOutOfGuards } from '@shared/horde';
import { HordeHistory } from '@shared/horde-history';
import { Loadout } from '@shared/loadout';
import { PlayerHistory } from '@shared/player-history';
import { Projectiles } from '@shared/projectiles';
import {
  type AbilityUsedMessage,
  type BossChargeMessage,
  decode,
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
 * Une paire d'axes dans [-1, 1] — reutilisee telle quelle pour le deplacement
 * ET pour la visee (tache 13) : les deux sont structurellement la meme chose,
 * un vecteur 2D normalise, seule leur INTERPRETATION differe (`readInput` vs
 * `readAim` ci-dessous).
 */
export interface InputAxes {
  x: number;
  y: number;
}

/**
 * Masque d'obstacles livre au rendu (tache 28), avec la geometrie qui va
 * avec — `cols`/`rows`/`cellSize` viennent du MEME `FlowField` sonde que
 * celui qui a servi a generer `mask`, jamais recalcules a cote.
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
   * Charge de la barre de Synergie, commune a toute l'equipe — **un seul
   * nombre dans le snapshot**, exactement comme `xp` (§7 et §8 de la spec de
   * l'etape 5a), et pour la meme raison : c'est une ressource d'equipe, pas
   * une statistique par joueur.
   *
   * Le client ne la calcule jamais : il l'affiche. La comparaison qui la fait
   * monter — deux joueurs differents a l'origine d'une reaction — est arbitree
   * serveur, et le bit qui en resulte voyage dans `REACTION`.
   */
  synergy: number;
  /** Positions a dessiner : les autres interpolees, la sienne predite. */
  players: PlayerSnapshot[];
  /** La classe de chaque joueur, lue au salon (`LOBBY`) : son unite a l'ecran. */
  classes?: ReadonlyMap<number, number>;
}

/**
 * Ce que ce client sait du boss vivant : ce que le `SNAPSHOT` transporte
 * (identite, PV courants — tache 4 de l'etape 6a) **plus le maximum qu'il lui a
 * vu**, qui ne voyage pas.
 *
 * ⚠️ **Le maximum est OBSERVE, pas recu, et il ne peut pas etre derive.** Une
 * barre a besoin d'une fraction, donc d'un total, et le client n'a aucun moyen
 * de le calculer : `bossHp(k, joueurs)` demande le palier `k`, qui ne voyage
 * NULLE PART — ni dans `SNAPSHOT`, ni dans l'ordre de vague de 19 octets. C'est
 * une decision de la tache 2, assumee : l'echelle de palier est appliquee cote
 * serveur seul (`Room#step`, `back/src/room.ts`), et `Horde.spawn` pose de son
 * cote les PV bruts de l'archetype, que personne cote client ne lit.
 *
 * **Ce que ca coute, dit franchement** : un client qui rejoint un salon PENDANT
 * un combat de boss prend pour maximum les PV qu'il voit en arrivant. Sa barre
 * demarre donc pleine et se vide correctement ensuite — l'evolution est juste,
 * le point de depart est faux, et rien a l'ecran ne ment sur autre chose. La
 * seule alternative serait de faire voyager le total, soit quatre octets par
 * tick pour une valeur qui ne bouge qu'a l'apparition du boss — un choix qui
 * appartient au protocole (tache 4), pas au rendu.
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
 * PURE, donc testable sans WebSocket — meme motif que `orbFlightFraction` et
 * `hudInfo`.
 *
 * ⚠️ **Le changement d'IDENTITE remet le maximum a zero**, et c'est la seule
 * chose qui le remette : le boss du palier 2 a plus de PV que celui du palier 1
 * (`hpScale`), donc garder l'ancien maximum afficherait une barre pleine a 80 %
 * des l'apparition. La sentinelle est sur l'identite, jamais sur les PV — un
 * boss a 0 PV est un boss, il meurt au tick suivant par `DEATHS` (voir
 * `NO_BOSS_ID` dans `shared/protocol.ts`), et le lire comme une absence ferait
 * disparaitre sa barre juste avant sa mort.
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
 * est le fonctionnement normal — la latence reseau fait que le dernier
 * snapshot recu decrit toujours un instant deja passe — et ne doit jamais
 * declencher de recalage : le faire reviendrait a figer en permanence le
 * compteur local sur un tick perime, annulant l'absorption de latence de
 * `FIELD_INPUT_DELAY_TICKS`. Etre EN RETARD, en revanche, ne devrait jamais
 * arriver en fonctionnement normal — seulement apres une perte de pas (onglet
 * en arriere-plan, §6.1c de la spec) — et doit se corriger immediatement : le
 * flowfield est un champ de directions discret, mesure (voir
 * `shared/horde.replication.test.ts`, scenarios C1) a etre assez sensible
 * pour faire la difference entre 0 et plus de 600 px de derive selon qu'un
 * retard persistant d'un ou de deux ticks est tolere.
 */
const HORDE_TICK_LAG_TOLERANCE = 1;

/** Pas fixe de la simulation de horde, partage entre l'avancement normal et le rejeu. */
const FIXED_DT = 1 / TICK_HZ;

/** Cadence de rafraichissement du champ, en pas : meme calcul que `Room.step` et `Horde.replication.test.ts`. */
const STEPS_PER_FIELD = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));

/** Un lot de morts en attente d'application, tel que recu par `DEATHS` (§3.1). */
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
 * Duree du bandeau « Un porteur de coffre est apparu ! » (etape 11, §5.4), en
 * horloge murale depuis la RECEPTION de son ordre — quelques ticks avant sa
 * naissance, au meme moment chez chacun.
 */
export const PORTEUR_BANNER_MS = 4000;
/** Duree du sort de transformation (necromancien) : dix images, plus lent. */
export const RAISE_FLASH_MS = 800;

/** Combien de temps cet eclat reste a l'ecran. */
export function flashLifeMs(b: BlastFlash): number {
  return b.kind === 'releve' ? RAISE_FLASH_MS : BLAST_FLASH_MS;
}

/**
 * Orbes vivants, cote client — **derives des morts, jamais transmis** (§6.1 de
 * la spec). Meme raisonnement que `OrbField` cote serveur (`back/src/combat.ts`),
 * duplique ici plutot qu'importe : le client ne peut dependre que de `shared/`,
 * et `back/` connait `ws`/`fastify` (regle Biome, voir `room.ts`).
 *
 * `PICKUPS` dit quelles identites ont ete ramassees ; l'existence et la
 * position de l'orbe, elles, ne transitent jamais — `GameClient` les pose a la
 * position de l'entite au moment de sa mort, lue depuis la horde restauree par
 * `HordeHistory` (voir `GameClient#applyDeaths`), avant compaction par `kill`.
 *
 * Tableaux types, jamais un objet par orbe — meme regle que `Horde` et
 * `Projectiles` (§4.4 de l'orientation).
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
   * Une mort DEMANDE un orbe ; toutes ne l'obtiennent pas (tache 17, etape 5a).
   *
   * ⚠️ **La MEME garde que `OrbField.spawn`, cote serveur, et elle DOIT y
   * rester des deux cotes.** Le client ne recoit jamais « un orbe existe » : il
   * le derive du seul `DEATHS`. La garde d'un seul cote ferait donc dessiner
   * ici des orbes que le serveur ne ramassera jamais — ou l'inverse, des
   * ramassages sans rien a l'ecran. Le predicat lui-meme, `leavesDrop`, vit
   * dans `shared/` : c'est lui qui n'a pas le droit d'exister en deux
   * exemplaires.
   *
   * ⚠️ **Depuis la tache 14 de l'etape 6a, la reserve tient les orbes ET les
   * PIECES**, sans les distinguer : leur nature se relit de l'identite
   * (`dropsOrb` / `dropsCoin`, disjoints) au moment de les dessiner. Voir
   * `OrbField.spawn`, cote serveur, qui porte la meme remarque.
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
   * Retire les orbes qu'un joueur vient de RAMASSER et les confie a `flights`
   * — tache 20, sur retour de jeu : *« l'aimantation est plus proche du joueur
   * et attire l'xp jusqu'a lui, meme s'il l'eloigne »*.
   *
   * ## La capture EST le ramassage
   *
   * ⚠️ **Le predicat est celui du serveur, au pixel pres — mais plus au MEME
   * rayon depuis la tache 7 de l'etape 7b.** C'est `OrbField.resolvePickups`
   * (`back/src/combat.ts`) qui arbitre, et rien ici ne decide de
   * l'experience ; les deux comparent les MEMES positions repliquees, chacune
   * au rayon DE SON PROPRE joueur, transporte par le `SNAPSHOT` (voir
   * `PickupTarget.pickupRadius`) — le rayon de ramassage est devenu
   * personnel (boutique), donc un rayon unique ne suffit plus a dire qui
   * atteint quoi. C'est precisement cela qui empeche la capture de mentir :
   * le vol part a l'instant ou le serveur ramasse, au rayon que CE joueur a
   * reellement. **L'experience est deja acquise quand le vol commence**, il
   * ne fait que decorer un fait accompli.
   *
   * C'est cela, et rien d'autre, qui autorise l'orbe a suivre un joueur qui
   * fuit. L'attraction de la tache 17 ne pouvait pas se le permettre : elle
   * etait une fonction pure de la distance, donc elle revenait sur ses pas des
   * que le joueur s'eloignait — elle ne promettait rien. Une capture qui
   * PERSISTE, elle, dessine l'orbe sur un joueur ; elle mentirait si elle
   * pouvait se declencher sans ramassage.
   *
   * ⚠️ **Le premier joueur a portee, pas le plus proche** — meme boucle que le
   * serveur, qui s'arrete lui aussi au premier. Ce choix n'a d'effet que
   * cosmetique : l'experience est une ressource d'EQUIPE (`XP_PER_ORB` va au
   * salon, pas au ramasseur), seule la trajectoire dessinee en depend.
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
   * ⚠️ **`expire` a disparu ICI EN MEME TEMPS QUE COTE SERVEUR** (etape 6a,
   * tache 15) : *« l'xp ne doit pas disparaitre »*. Un orbe non ramasse vivait
   * `ORB_LIFETIME_TICKS` puis s'evaporait, des deux cotes, par derivation de
   * `bornTick`.
   *
   * ⚠️ **Les deux cessent ENSEMBLE, ou pas du tout.** L'existence d'un orbe ne
   * transite jamais : le client la derive de `DEATHS`, le serveur arbitre le
   * ramassage. Une peremption retiree d'un seul cote ferait disparaitre ici un
   * orbe que le serveur ramasse encore — ou laisserait a l'ecran un orbe dont
   * le `PICKUPS` n'arrivera jamais. Meme raison que `dropsOrb`, qui vit dans
   * `shared/` pour n'exister qu'une fois.
   *
   * `bornTick` reste, lui : `OrbRenderer` en tire la phase du scintillement.
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
 * **Jumelle de `PickupPoint`** (`back/src/combat.ts`), a l'identite pres : le
 * serveur compare des positions et n'a que faire de savoir qui ramasse, alors
 * que le vol, lui, doit pouvoir retrouver le joueur A CHAQUE IMAGE — c'est
 * toute la difference entre suivre quelqu'un et viser un point.
 *
 * Une interface plutot que `PlayerSnapshot`, pour que le test n'ait pas a
 * fabriquer un snapshot entier.
 */
export interface PickupTarget {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** Rayon de ramassage de CE joueur, transporte par le `SNAPSHOT` (tache 7 de l'etape 7b). */
  readonly pickupRadius: number;
}

/**
 * Duree d'un vol d'orbe capturee, en millisecondes horloge murale — tache 20.
 *
 * En millisecondes et pas en ticks, exactement comme `HIT_FLASH_LIFETIME_MS` :
 * **le vol n'arbitre rien**, il decore un ramassage deja acquis (voir
 * `DerivedOrbs.capture`), donc rien n'exige qu'il se calcule identiquement des
 * deux cotes du fil. Le serveur, lui, ne connait meme pas cette constante.
 *
 * ⚠️ **Assez court pour que l'orbe DEPASSE un joueur qui fuit.** Le vol part
 * d'au plus `ORB_PICKUP_RADIUS` (90 px) : 200 ms font une vitesse moyenne de
 * 450 px/s, largement au-dessus de `PLAYER_SPEED` (260). Plus long, l'orbe
 * trainerait derriere le joueur au lieu d'etre aspiree — c'est une regle, pas
 * un reglage, et `client.test.ts` la garde par ce rapport-la.
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
 * Orbes CAPTUREES, en vol vers le joueur qui les a ramassees — tache 20.
 *
 * ⚠️ **Une collection cosmetique, hors de `DerivedOrbs`, et c'est structurel.**
 * `DerivedOrbs` est le miroir client de la reserve du serveur : ce qu'elle
 * contient est dicte par les morts et par `PICKUPS`. Une orbe ramassee n'y est
 * plus — ni ici, ni cote serveur — donc un vol ne peut pas y vivre comme un
 * drapeau sur une entree. Il vit ici, avec `HitFlashes` et `ReactionFlashes`
 * pour voisines : meme forme de tableaux types, meme duree de vie en
 * millisecondes, meme absence totale d'arbitrage.
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
   * Identite du MONSTRE qui a laisse l'objet — celle qui dit sa nature (etape
   * 6a, tache 14).
   *
   * ⚠️ **Un vol doit garder l'apparence de ce qui vole.** Sans elle, une piece
   * capturee redeviendrait une orbe verte a l'instant ou elle decolle : la
   * nature se relit de l'identite (`dropsCoin`), donc elle doit voyager du sol
   * jusqu'au vol. Purement local — cette identite est deja connue des deux
   * cotes, rien de plus ne passe sur le fil.
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
   * Retire les vols arrives. **Un vol se termine quand l'orbe atteint le
   * joueur**, et `orbFlightFraction` vaut 1 exactement a `ORB_FLIGHT_LIFETIME_MS` :
   * la meme echeance decrit donc l'arrivee et la fin de vie, il n'y a pas deux
   * regles a garder d'accord.
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
 * Duree de vie d'un flash d'impact, en millisecondes horloge murale — §4.3 :
 * « un flash court, large et genereux… pas un halo permanent ». Pas en ticks
 * comme `DerivedOrbs` : un flash est purement cosmetique, jamais arbitre, donc
 * rien n'exige qu'il se calcule identiquement des deux cotes (voir le
 * commentaire de `GameClient#advanceHorde` sur `Projectiles.collide`).
 * L'horloge murale donne une animation lisse, independante de la cadence des
 * pas de simulation.
 */
export const HIT_FLASH_LIFETIME_MS = 220;

/**
 * Bilan de fin de run, tel que porte par `RUN_OVER` (§7 de la spec). Recopie
 * sous un nom local plutot que reexportee telle quelle : `main.ts` n'a besoin
 * que de ces trois champs, pas de `type`/`tick` qui n'interessent que le
 * protocole.
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
 * consomme que les propres projectiles du client et ne touche jamais `horde`
 * ni `hp` : ce n'est PAS de l'arbitrage de degats (reserve au serveur, §5.4),
 * seulement la meme divergence acceptee que documentee sur `fireSalvo`. Deux
 * clients peuvent donc voir des flashs legerement differents — sans
 * consequence, puisqu'aucune decision de jeu n'en depend.
 *
 * Tableaux types, meme regle que `DerivedOrbs` et `Horde` (§4.4 de
 * l'orientation) — un burst d'impacts simultane ne doit jamais allouer un
 * objet par flash.
 */
export class HitFlashes {
  readonly x: Float32Array;
  readonly y: Float32Array;
  /**
   * Teinte du flash, 0xRRGGBB : celle de l'ARME qui vient de toucher
   * (`Weapon.look.tint`), recopiee a la naissance (etape 8).
   *
   * ⚠️ **Recopiee, jamais relue dans `WEAPONS` au dessin.** Le projectile qui
   * a produit ce flash est consomme par `collide` a l'instant meme : son
   * creneau est deja reutilise par un autre tir quand le calque dessine. Meme
   * discipline que `Projectiles.#damage` et `#element`, qui sont recopies a
   * l'emission pour que la suite ne depende plus d'une table.
   *
   * ⚠️ **La teinte dit l'ARME, pas l'element** — c'est la regle du §6.6 que
   * `assertWeaponLooks` garde : l'element se lit a la zone au sol et a la
   * marque sur l'ennemi. Un flash d'impact teinte par l'element ferait de
   * chaque coup une mini-reaction, et la hierarchie *« etat persistant
   * discret, reaction spectaculaire »* s'effondrerait dans le bruit.
   */
  readonly tint: Uint32Array;
  /**
   * Rayon du souffle, en pixels monde : `Weapon.blastRadius` recopie du
   * projectile qui vient de toucher (etape 8). `0` — seize armes sur
   * dix-sept — : ce coup ne touche que ce qu'il percute, et son flash garde sa
   * taille de coup.
   *
   * ⚠️ **C'est le rayon qui DECIDE DE CE QUI MEURT**, lu sur le projectile
   * (`Projectiles.blastRadiusAt`) et pas sur une table. Le flash s'y asservit
   * exactement, comme `reactionFlashScale` s'asservit a `REACTION_RADIUS` : un
   * souffle dessine plus large que le vrai promettrait des morts qui n'auront
   * pas lieu, plus etroit il tuerait hors du dessin.
   */
  readonly radius: Float32Array;
  /**
   * Degats du coup, recopies du projectile (etape 8). C'est la PUISSANCE de
   * l'impact : elle decide de la taille du flash et du nombre d'eclats.
   *
   * ⚠️ **Les degats BRUTS de l'arme, pas ce que l'ennemi a reellement
   * encaisse.** Les PV ne sont pas sur le fil (§5.4) et l'armure est arbitree
   * serveur : le client ne connait que ce qu'il a tire. Un flash qui
   * pretendrait dire le degat reel mentirait sur les ennemis blindes —
   * celui-ci dit « ce coup-la pese lourd », ce qui est vrai de l'arme.
   */
  readonly power: Float32Array;
  /**
   * `1` si ce flash doit SECOUER la camera (etape 8).
   *
   * ⚠️ **Par defaut, c'est « ce coup a un souffle » — et le halo est
   * l'exception qui a rendu le drapeau necessaire.** Une explosion est un
   * EVENEMENT ; un halo PULSE toutes les dix-huit ticks, sans arret, tant que
   * le joueur le porte. Le laisser secouer l'ecran aurait rendu la secousse
   * permanente — exactement le defaut que la fenetre de `cameraShake` vient de
   * corriger, et cette fois aucune fenetre n'y aurait suffi puisque la source
   * est continue par nature.
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
 * ⚠️ **TROIS FOIS la vie d'un flash d'impact, et c'est pour ca que les
 * chiffres ont leur propre reservoir** (etape 8). Le §4.3 veut le flash
 * *« court, large et genereux »* — 220 ms — mais un nombre qui s'efface en
 * 220 ms ne se LIT pas. Les faire vivre sur `HitFlashes` aurait voulu dire
 * allonger le flash lui-meme, donc remplacer la regle du §4.3 par un reglage
 * d'affichage.
 */
export const DAMAGE_NUMBER_LIFETIME_MS = 700;

/**
 * Les chiffres de degats qui montent au-dessus des monstres (etape 8) —
 * *« il faut afficher les degats sur les monstres avec des chiffres »*.
 *
 * ⚠️ **Ce qu'ils affichent est ce que le TIR envoie, pas ce que l'ennemi
 * encaisse.** Les PV ne sont pas sur le fil (§5.4) et l'armure comme les
 * flaques sont arbitrees serveur : le client ne connait que les degats de
 * l'arme, critique compris (lui est DERIVE du tir, donc exact — voir
 * `Projectiles.critAt`). Un chiffre qui pretendrait dire le degat reel
 * mentirait sur les ennemis blindes, exactement comme un flash teinte par
 * l'element mentirait sur l'element qui a touche.
 *
 * Tableaux types, meme regle que `HitFlashes` : une volee d'impacts simultanes
 * ne doit jamais allouer un objet par chiffre.
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
 * ⚠️ **Plus longue que `HIT_FLASH_LIFETIME_MS` (220 ms), et c'est toute la
 * hierarchie du §6.6.** *« L'etat persistant est discret, la reaction est
 * spectaculaire »* : le flash d'impact accompagne chaque projectile qui
 * touche — des dizaines par seconde — donc il doit rester bref ; la reaction
 * est rare et elle TUE, donc c'est la que passe le budget VFX. Deux fois plus
 * long reste « court » : au-dela, plusieurs reactions voisines se
 * recouvriraient en un halo continu, exactement ce que le §6.6 exclut.
 *
 * En millisecondes et pas en ticks, meme raison que `HIT_FLASH_LIFETIME_MS` :
 * un flash n'arbitre rien, donc rien n'exige qu'il se calcule identiquement
 * des deux cotes du fil.
 */
export const REACTION_FLASH_LIFETIME_MS = 440;

/**
 * Capacite du reservoir de flashs de reaction.
 *
 * Bien plus petite que `HIT_FLASH_CAPACITY` (128) : une reaction demande deux
 * elements differents sur la meme cible, elle est rare par construction (§6.2),
 * et la borne serveur « une reaction par ennemi et par tick » la borne encore.
 */
const REACTION_FLASH_CAPACITY = 64;

/**
 * Flashs de reaction, cote client — **annonces par le serveur**, jamais
 * derives, a la difference des flashs d'impact juste au-dessus.
 *
 * C'est la seule chose de tout le systeme elementaire que le client ne devine
 * pas : la reaction TUE (§6.1 de la spec), donc elle est arbitree serveur et
 * annoncee par `REACTION`. La teinte des ennemis, elle, est approximee
 * localement — voir `GameClient#markLocally`.
 *
 * Tableaux types, meme regle que `HitFlashes` et `DerivedOrbs`.
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
   * joueurs DIFFERENTS en sont a l'origine (§7 de la spec).
   *
   * ⚠️ **Le client ne recalcule PAS cette comparaison, il la lit.** Le message
   * ne porte volontairement pas les deux identites (§6.1) : les recomparer ici
   * serait refaire l'arbitrage cote client, donc l'occasion de le faire
   * diverger. Le TOTAL de la barre, lui, vit dans le `SNAPSHOT`.
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
 * Duree de vie d'un flash de chaine, en millisecondes horloge murale — meme
 * famille que `REACTION_FLASH_LIFETIME_MS` (evenement rare, remarquable), pas
 * `HIT_FLASH_LIFETIME_MS` (un impact ordinaire, tres frequent). Voir le tour
 * de correction 1 de la tache 3 (etape 5b) : la chaine etait redessinee a
 * chaque image depuis la marque `FOUDRE` (60 ticks, 2 s) — un cout O(horde)
 * par ennemi marque et par image, jusqu'a O(horde²) une fois compose avec
 * `#markInZones`, qui peut marquer TOUTE la horde d'un coup. Un flash, semé
 * une fois puis amorti, n'a plus ce risque : le calcul n'a lieu qu'a
 * l'impact, jamais au dessin.
 */
export const CHAIN_FLASH_LIFETIME_MS = 260;

/**
 * Flashs de chaine de Foudre, cote client — purement cosmetiques, jamais
 * arbitres, exactement comme `HitFlashes` (et pour la meme raison : nes de
 * `Projectiles.collide` sur les PROPRES projectiles de ce client, voir
 * `GameClient#seedChainFlash`).
 *
 * ⚠️ **Le CHEMIN est FIGE a la naissance, jamais redérivé.** Contrairement a
 * la marque elementaire (`#markLocally`, un etat DURABLE, redessine chaque
 * image depuis `Horde.markAt`), la chaine du serveur est un evenement
 * PONCTUEL : elle a lieu une fois, a l'impact, et n'existe plus ensuite —
 * voir `resolveProjectileDamage` (`back/src/combat.ts`), qui ne la recalcule
 * jamais au tick suivant. Stocker les points ici, plutot que de rappeler
 * `chainTargets` a chaque image depuis la horde courante, c'est donc dessiner
 * ce que le serveur a REELLEMENT fait, pas une approximation qui continuerait
 * de bouger avec des ennemis qui, eux, ont cesse d'etre chaines depuis
 * longtemps.
 *
 * Tableaux types a largeur FIXE (`CHAIN_FLASH_MAX_POINTS` par flash), meme
 * regle que `HitFlashes`/`ReactionFlashes`/`DerivedOrbs` (§4.4 de
 * l'orientation) : un burst de chaines simultanees ne doit jamais allouer un
 * objet (ni un tableau de taille variable) par flash. `CHAIN_JUMPS` (3) etant
 * une petite constante, la largeur fixe ne gaspille qu'un negligeable nombre
 * de flottants inutilises pour une chaine plus courte que le maximum.
 */
export class ChainFlashes {
  /** Points aplatis : le point `p` du flash `slot` est a l'indice `slot * CHAIN_FLASH_MAX_POINTS + p`. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Nombre de points REELLEMENT valides pour ce flash — entre 2 (un saut) et `CHAIN_FLASH_MAX_POINTS`. */
  readonly pointCount: Uint8Array;
  /**
   * Teinte du trait, 0xRRGGBB — la Foudre par defaut (etape 8).
   *
   * ⚠️ **Elle etait CONSTANTE dans le renderer jusqu'ici**, parce qu'un seul
   * evenement dessinait une polyligne : la chaine de Foudre. Le faisceau est
   * le second, et il porte la teinte de SON arme — un rayon de Givre jaune
   * aurait menti sur son element a chaque tir.
   */
  readonly tint: Uint32Array;
  /** Epaisseur du trait, en pixels monde : une chaine est fine, un faisceau a sa largeur d'arme. */
  readonly width: Float32Array;
  /** Horloge murale de naissance (`performance.now()`), voir `CHAIN_FLASH_LIFETIME_MS`. */
  readonly bornMs: Float64Array;
  #count = 0;

  constructor(readonly capacity: number) {
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
   * relier : la chaine n'a touche personne) ou une reserve pleine (meme
   * discipline que `HitFlashes`/`OrbFlights` : un burst reste petit).
   */
  spawn(
    points: readonly { x: number; y: number }[],
    nowMs: number,
    /**
     * `0` : « rien de particulier », et c'est le CALQUE qui retombe alors sur
     * la Foudre et sur son epaisseur de chaine. Les constantes de dessin
     * vivent dans le renderer, jamais ici — ce fichier ne sait pas a quoi
     * ressemble un trait.
     */
    tint = 0,
    width = 0,
  ): void {
    if (points.length < 2 || this.#count >= this.capacity) {
      return;
    }
    const slot = this.#count++;
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
      if (nowMs - (this.bornMs[i] ?? 0) >= CHAIN_FLASH_LIFETIME_MS) {
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
      this.bornMs[slot] = this.bornMs[last] ?? 0;
    }
    this.#count = last;
  }
}

/** Un ping annonce par le salon (etape 9), tel que le rendu le lit. */
export interface ActivePing {
  playerId: number;
  intent: number;
  x: number;
  y: number;
  /**
   * Tick de `GameClient#pingClock` a la RECEPTION : c'est lui qui fait
   * expirer le ping. PAS le tick de horde (revue finale, etape 9) : celui-ci
   * avance pendant le gel de niveau, et un ping date dessus s'eteindrait
   * pendant que l'equipe choisit ses cartes — voir `pingClock`.
   */
  tick: number;
}

/**
 * Le client de jeu : une socket, un tampon d'interpolation, une prediction.
 *
 * Il ne dessine rien et ne lit pas le clavier — il recoit une fonction qui lui
 * rend les axes courants. C'est ce qui permet de le tester sans navigateur, et
 * ce qui evite que le rendu et le reseau se contaminent.
 */
/** Duree du bouillonnement vert apres un coup de venin, en ticks (~ la duree du poison serveur). */
const POISON_VISUAL_TICKS = 75;
const POISON_BUBBLE_EVERY = 8;
const POISON_TINT = 0x7ccf3a;

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
   * dernier snapshot (tache 7 de l'etape 7b) — meme regle que `#localHp` :
   * non predit, c'est la derniere valeur serveur connue.
   */
  #localPickupRadius = 0;
  /** Experience de l'equipe, telle que portee par le dernier snapshot. */
  #teamXp = 0;
  /**
   * Charge de Synergie de l'equipe, telle que portee par le dernier snapshot
   * (§7). Lue, jamais deduite : le client ne compte pas les `REACTION` chargees
   * pour la reconstituer — un client connecte en cours de partie en aurait
   * manque, et un client qui recompterait pourrait diverger du seul total qui
   * fasse foi.
   */
  #teamSynergy = 0;
  /**
   * L'or NON SECURISE de l'equipe, tel que le dernier snapshot le porte (§5 de
   * la spec de l'etape 6a).
   *
   * ⚠️ **Il vit ici et PAS dans `RenderState`**, a la difference de `xp` et de
   * `synergy` qui y sont pour des raisons historiques. `RenderState` est ce que
   * la PREDICTION produit — des positions predites et interpolees — et l'or
   * n'est ni predit ni interpole : c'est une valeur d'en-tete lue telle quelle,
   * exactement comme `boss` juste en dessous, qui a ete tenu hors de
   * `RenderState` pour ce motif precis.
   *
   * ⚠️ **Lu a chaque snapshot, meme quand le bloc du joueur local est
   * introuvable** — donnee d'EQUIPE, quatrieme fois : c'est le §5 de la spec,
   * ce qui se decide au vote est ce que l'EQUIPE risque.
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
   * est perdue cote fil — voir `RunOverSummary` et le HUD (§4.6).
   */
  #level = 1;
  /**
   * `#level` a-t-il deja ete pose par un VRAI `LEVEL_UP` recu depuis la
   * connexion ? Distinct de `#level` lui-meme, dont la valeur par defaut (1)
   * est indiscernable d'un vrai niveau 1 annonce — voir le repli de
   * `#draftIsChest` dans le gestionnaire de `LEVEL_UP`, qui a besoin de savoir
   * si comparer a `#level` a seulement un sens.
   */
  #levelKnown = false;
  #seq = 0;
  #status: ConnectionStatus = 'closed';

  readonly horde = new Horde(MAX_ENTITIES);
  #fields: FlowField[] = [];
  readonly #history = new PlayerHistory();
  /** Accumulateur de pas fixes : la horde avance a 30 Hz, comme le serveur. */
  #hordeAcc = 0;
  #lastHordeTick = 0;

  /** Anneau d'etats de horde, pour le rejeu des morts en retard (§3.2). */
  readonly #hordeHistory = new HordeHistory(MAX_ENTITIES);
  /**
   * Les zones au sol, ANNONCEES par le serveur et jamais derivees (§5.3 de
   * l'etape 5a) — le client ne peut pas savoir ou finit un projectile serveur.
   * Leur MORT, elle, se derive du seul `bornTick`, comme celle des orbes.
   *
   * Lecture publique : le rendu (tache 9) y lit ses quads teintes, et
   * `Horde.step` y lit le ralentissement du Givre.
   */
  readonly zones = new ZoneField();
  /** Orbes derives des morts (§6.1), jamais transmis. Lecture publique pour le rendu et le HUD. */
  readonly orbs = new DerivedOrbs(MAX_ENTITIES);
  /**
   * Orbes capturees, en vol vers leur ramasseur (tache 20) — purement
   * cosmetique, jamais arbitre. Lecture publique pour le rendu.
   */
  readonly orbFlights = new OrbFlights(ORB_FLIGHT_CAPACITY);

  /**
   * Projectiles, simules localement — **jamais repliques**, exactement comme
   * documente sur `shared/projectiles.ts` : chaque cote (serveur, chaque
   * client) tire ses propres salves a partir de donnees deja partagees
   * (l'arme, le tick, la horde). `#fireWeapons` est le miroir client de
   * `Room#fireWeapons` (back/src/room.ts). Lecture publique pour le rendu
   * (tache 11).
   */
  readonly projectiles = new Projectiles(PROJECTILE_CAPACITY);
  /**
   * Recharge **par joueur ET par arme**, cote client — miroir exact de
   * `PlayerState.lastFireTick` cote serveur (un `Float64Array` indexe par
   * identifiant d'arme, `-Infinity` = jamais tire).
   *
   * ⚠️ **Un seul compteur par joueur bridait tout l'arsenal.** C'est ce que ce
   * fichier faisait jusqu'a la tache 9 : la recharge la plus lente qui vient
   * de partir empechait toutes les autres armes de tirer. Le serveur, lui,
   * compte par arme depuis la tache 7 — l'affichage aurait donc montre moins
   * de salves que le serveur n'en arbitre, et de plus en plus a chaque carte
   * draftee.
   */
  readonly #lastFireTick = new Map<number, Float64Array>();
  /**
   * Miroir des inventaires, un par joueur, alimente par `DRAFT_RESULT`.
   *
   * ⚠️ **Le client ne decide rien ici** (§7.2) : il range ce que le serveur
   * lui dit d'avoir range, et rien d'autre. Deux usages, tous deux
   * indispensables :
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
  /** Flashs d'impact derives des collisions locales (§4.3). Lecture publique pour le rendu. */
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
  readonly hitFlashes = new HitFlashes(HIT_FLASH_CAPACITY);
  /** Les chiffres de degats qui montent au-dessus des monstres — voir `DamageNumbers`. */
  readonly damageNumbers = new DamageNumbers(DAMAGE_NUMBER_CAPACITY);
  /**
   * Flashs de reaction, ANNONCES par `REACTION` (§6.1). Lecture publique pour
   * le rendu — voir `ReactionFlashes`.
   */
  readonly reactionFlashes = new ReactionFlashes(REACTION_FLASH_CAPACITY);
  /** Les explosions de kamikazes en cours d'affichage — voir `BehaviorRenderer`. */
  blastFlashes: BlastFlash[] = [];
  /** Les tirs des tireurs, derives de la horde — voir `EnemyShots`. */
  readonly shots = new EnemyShots();
  /**
   * Flashs de chaine de Foudre, derives des collisions locales (etape 5b,
   * tache 3, tour de correction 1) — meme famille que `hitFlashes` : semes
   * une fois par `#seedChainFlash`, jamais redérivés. Lecture publique pour
   * le rendu — voir `ChainFlashes`.
   */
  readonly chainFlashes = new ChainFlashes(CHAIN_FLASH_CAPACITY);

  /**
   * Nombre cumule d'identites tuees en dehors de la portee de `HordeHistory`
   * (`ROLLBACK_DEPTH_TICKS`) : appliquees au present plutot qu'au tick de la
   * mort, faute de pouvoir revenir en arriere. Lecture seule, pour le HUD de
   * debug (§4.6 de l'orientation demande un HUD, pas des logs) et pour les tests.
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
   * est exactement la latence excedentaire. L'etape 3 a chiffre le cas
   * equivalent pour les morts (93,007 px). On applique quand meme — un effet
   * que le joueur a paye ne doit pas disparaitre — mais on le COMPTE, plutot
   * que de pretendre a l'exactitude.
   */
  #lateZones = 0;

  /** Lots de morts recus mais pas encore appliques. Meme discipline que `#pendingOrders`. */
  readonly #pendingDeaths: PendingDeathBatch[] = [];

  /** Zones recues mais pas encore appliquees. Meme discipline que `#pendingDeaths`. */
  readonly #pendingZones: ZoneMessage[] = [];

  /** Charges de boss recues mais pas encore appliquees. Meme discipline que `#pendingZones`. */
  readonly #pendingCharges: BossChargeMessage[] = [];
  /** Leurres annonces, en attente d'etre plantes au tick deja simule (`#applyDecoy`). */
  /** Le decor qui bloque le joueur local, pose au WELCOME (`PredictedPlayer`). */
  #moveMap: MoveMap | null = null;
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
   * remplace l'ancien (§6 de la spec de l'etape 9). Jamais purges ici — c'est
   * `livePings` qui dit lesquels sont encore vivants, a l'horloge `pingClock`
   * (figee pendant le gel de niveau).
   */
  readonly pings = new Map<number, ActivePing>();
  #pingCount = 0;
  /**
   * Le porteur de coffre annonce et pas encore mort (etape 11), par identite.
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
   * niveau et diffuse les morts AVANT les `LEVEL_UP` (§4.3 de la spec).
   *
   * ⚠️ **Ce compteur est le PREMIER signal, pas le seul.** Un client qui
   * rejoint ou se reconnecte pendant qu'un porteur est vivant n'a jamais recu
   * son `WAVE_ORDER` (§5.4 de la spec de l'etape 11) : `#porteurId` reste
   * `null`, donc sa mort n'incremente rien ici. Le gestionnaire de `LEVEL_UP`
   * retombe alors sur un SECOND signal, sans octet de plus : un vrai niveau
   * fait TOUJOURS monter `#level`, alors qu'un coffre porte le niveau
   * d'avant-meme-tick — au plus egal a celui deja connu. Voir `#levelKnown`.
   */
  #chestsOwed = 0;
  #draftIsChest = false;
  #lastPingIntent = -1;
  /** Horloge de ping (revue finale, etape 9) : voir l'accesseur `pingClock`. */
  #pingClock = 0;

  /**
   * La charge du boss en cours, ou `null` — annoncee UNE FOIS par le serveur,
   * puis derivee ici tick par tick (§4 de la spec de l'etape 6a).
   *
   * ⚠️ **C'est le deuxieme effet du jeu qui touche le DEPLACEMENT**, apres le
   * ralentissement du Givre : pendant toute la charge, la position du boss vient
   * de cette valeur et non du champ de flux. Elle est donc DATEE PAR TICK et
   * appliquee par rejeu, exactement comme une zone — voir `#applyBossCharge`.
   *
   * Gardee apres sa fin, jamais effacee par le temps : une charge finie est
   * inerte (`chargeHoldsAt`), et la garder est ce qui permet a un rejeu qui
   * enjambe sa fin de la retrouver — meme raisonnement que les zones que le
   * client laisse mourir `ROLLBACK_DEPTH_TICKS` ticks en retard.
   */
  #bossCharge: BossCharge | null = null;

  /**
   * Nombre cumule de charges annoncees trop tard pour l'anneau
   * (`ROLLBACK_DEPTH_TICKS`), donc installees au present. Meme degradation
   * assumee et meme refus du silence que `#lateZones` et `#lateDeaths` : le
   * boss saute alors sur son couloir de l'ecart exact de la latence
   * excedentaire.
   */
  #lateCharges = 0;

  /**
   * Dernier tick du gel courant (inclus), et dernier tick de la reprise
   * progressive qui suit. `-1` hors gel — et non `0` comme cote serveur
   * (`Room` commence son compteur a 1, jamais `GameClient`, dont le tout
   * premier tick reel peut valoir `0` — voir `#onFrame`/WELCOME). Avec `0`
   * comme sentinelle, `#movementScale(0)` rendrait `0` (gel) des le tout
   * premier tick d'une connexion fraiche, sans qu'aucun `LEVEL_UP` ne soit
   * jamais arrive : `-1` ecarte ce cas plutot que de le tolerer.
   */
  #freezeUntilTick = -1;
  #resumeEndTick = -1;
  /**
   * Tick auquel le gel courant a commence, `-1` hors gel.
   *
   * ⚠️ **Ce champ existe parce que la fin du gel n'est plus calculable.** A
   * l'etape 3 le client la deduisait — `msg.tick + LEVEL_FREEZE_TICKS - 1` —
   * parce que le gel durait une constante. Depuis l'etape 4, il dure jusqu'a ce
   * que tout le monde ait pose son jeton, et en solo jusqu'au clic : seul le
   * serveur la connait, et il l'annonce dans `DRAFT_RESULT`. Entre les deux, le
   * client sait seulement qu'il est gele DEPUIS ce tick.
   */
  #freezeStartTick = -1;

  /** L'etalage en cours, vide hors draft. Le client l'AFFICHE, il n'en decide rien (§7.2). */
  #draftCards: readonly Card[] = [];
  #draftDeadlineTick = 0;
  /**
   * `true` des que la negociation est close (`DRAFT_RESULT` de phase 0), et
   * jusqu'au prochain `DRAFT_OPEN`.
   *
   * ⚠️ **Ce n'est pas la meme chose que « l'etalage est vide ».** L'etalage
   * survit a la fermeture, exactement pour que l'ecran puisse jouer la
   * revelation du §4.2 — illuminer la carte gagnee, consumer les perdues —
   * sur des cartes qui existent encore. Ce drapeau est le signal « on ne
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
   * ⚠️ **Trois valeurs, et la du milieu est la seule subtile.** `-1` : aucun
   * portail. `Number.MAX_SAFE_INTEGER` : un portail est ouvert et **on ne sait
   * pas encore quand il se fermera** — le vote se resout des que tout le monde
   * a vote, donc n'importe quand entre l'ouverture et l'echeance, et seul le
   * serveur le sait. Un tick fini : le `PORTAL_RESULT` est arrive et a dit son
   * tick d'effet.
   *
   * C'est exactement la forme de `#freezeUntilTick` a l'etape 4, et pour la
   * meme raison, payee d'une tache la-bas (lecon R3) : **repousser la borne a
   * l'infini plutot que la deviner**. Deviner voudrait dire fermer a
   * `deadlineTick`, et l'ecran resterait affiche vingt secondes apres un vote
   * unanime rendu en trois.
   *
   * ⚠️ **Et la fermeture est DATEE PAR TICK, jamais appliquee a la
   * reception.** Fermer a l'arrivee du message ferait fermer l'ecran de chaque
   * client a un tick different — celui de sa propre latence — au moment meme
   * ou les quatre joueurs regardent le meme verdict.
   */
  #portalCloseTick = -1;
  /** Echeance de la fenetre courante, pour le chronometre. Voir `portalDeadlineTick`. */
  #portalDeadlineTick = 0;
  /**
   * Le multiplicateur d'extraction annonce par le dernier `PORTAL_OPEN`.
   *
   * ⚠️ **ANNONCE, jamais compte.** Le deriver du nombre de portails vus
   * s'ouvrir tromperait tout client connecte en cours de run — il en a vu
   * zero — et le coder en dur ferait mentir l'ecran au premier reglage de
   * `EXTRACT_MULTIPLIER_STEP`. Voir `PortalOpenMessage`.
   *
   * Vaut 1 avant le premier portail : c'est la valeur de depart cote salon
   * (`Room#extractMultiplier`), donc un ecran qui s'afficherait avant toute
   * annonce ne dirait rien de faux — mais il ne s'affiche pas, `portalOpen`
   * etant faux.
   */
  #portalMultiplier = 1;
  /**
   * `playerId -> VOTE_CHOICE.STAY | VOTE_CHOICE.LEAVE | NO_VOTE` : qui a vote
   * quoi, remplacee entierement a chaque `VOTES`.
   *
   * ⚠️ **L'abstention est une ENTREE, pas une absence d'entree** — `NO_VOTE`
   * circule sur le fil exactement pour qu'on voie qui n'a pas encore tranche
   * (§6). Un client qui la filtrerait ici rendrait « n'a pas vote »
   * indistinguable de « a vote RESTER » a l'ecran, et la negociation serait
   * fausse.
   */
  #portalVotes: ReadonlyMap<number, number> = new Map();
  /**
   * Le verdict du dernier `PORTAL_RESULT`, `null` tant qu'aucun n'est tombe.
   *
   * Remis a `null` a chaque ouverture : un verdict de palier precedent
   * s'afficherait sinon sur le portail suivant, comme les jetons du draft
   * s'affichaient d'une negociation revolue.
   */
  #portalDecision: number | null = null;
  /** L'or du verdict : acquis si l'equipe part, reporte si elle reste. Voir `PortalResultMessage`. */
  #portalGold = 0;

  /**
   * Ordres recus mais pas encore appliques.
   *
   * Le gestionnaire de message ne fait QUE empiler. L'application a lieu dans
   * `#advanceHorde`, avant le rafraichissement du champ — l'ordre inverse
   * multiplie la derive par trente-cinq (§6.2 de la spec).
   */
  readonly #pendingOrders: WaveOrderMessage[] = [];

  /**
   * Visee locale, quantifiee (tache 13) — memes entiers que ceux envoyes par
   * le prochain `INPUT`. Recalculee a chaque `update()` a partir de
   * `readAim()`, PUIS figee pour toute la duree de cet appel (elle peut
   * avancer plusieurs pas de simulation fixes, voir `update`) : c'est ce qui
   * garantit que `#fireWeapons` tire avec la valeur quantifiee, jamais avec
   * le flottant brut renvoye par `readAim` (voir `quantizeAxis`).
   */
  #localAim: { x: number; y: number } = { x: 0, y: 0 };

  constructor(
    private readonly url: string,
    private readonly readInput: () => InputAxes,
    private readonly onStatusChange: (status: ConnectionStatus) => void,
    /** Appele une seule fois, a la reception de `RUN_OVER` (§7 de la spec). */
    private readonly onRunOver: (summary: RunOverSummary) => void = () => undefined,
    /**
     * Rend la direction visee, en coordonnees MONDE, deja normalisee (ou
     * `(0, 0)` si le joueur ne vise nulle part) — voir `front/src/input/mouse.ts`
     * et `Stage.screenToWorld`. Par defaut, ne vise jamais : les tests qui ne
     * s'interessent pas au tir n'ont donc rien a fournir ici, `(0, 0)` etant
     * deja « pas de tir » (tache 13).
     */
    private readonly readAim: () => InputAxes = () => ({ x: 0, y: 0 }),
    /**
     * Appele une seule fois, a la reception de `WELCOME` — c'est le seul
     * moment ou la carte d'obstacles existe (tache 28). Livre exactement le
     * masque et la geometrie (`cols`/`rows`/`cellSize`) qui alimentent
     * `#fields` juste en dessous : c'est ce qui garantit au rendu de dessiner
     * les MEMES cellules murees que celles que le champ de flux evite, plutot
     * que de regenerer un masque a cote qui pourrait diverger.
     */
    private readonly onMapReady: (map: ObstacleMap) => void = () => undefined,
    /**
     * Le jeton de compte, en octets. Envoye comme PREMIER message de la socket
     * (`MSG.HELLO`) : le serveur n'attribue aucun slot avant de l'avoir
     * reconnu (§2.2 de la spec de l'etape 7a).
     *
     * ⚠️ **Optionnel ici, obligatoire cote SERVEUR.** Ce client n'a aucune
     * autorite : une socket sans `HELLO` valide est fermee par le serveur.
     * L'optionalite n'ouvre donc aucun chemin de jeu, elle evite seulement
     * d'imposer une valeur inutile aux quarante constructions de
     * `client.test.ts`.
     */
    private readonly accountToken: Uint8Array | null = null,
    /**
     * Les bonus PERMANENTS du compte (boutique, etape 7b), tels que
     * `bonusesOf` les derive de ses achats.
     *
     * ⚠️ **ZERO octet sur le fil, et c'est une contrainte, pas une economie.**
     * Comme le grisage de l'etalage (§3.5 de la spec), le client lit SES
     * PROPRES achats en HTTP au chargement (`GET /accounts/me`) et derive ces
     * bonus avec la fonction partagee. Aucun message, aucune route, aucun champ
     * de snapshot n'a ete ajoute pour eux.
     *
     * ⚠️ **Fige a la construction, jamais relu.** Le serveur pose ces bonus une
     * seule fois au `join` et ils sont constants sur toute la run (voir
     * `Room.join`) : un miroir qui les relirait en continu reintroduirait
     * exactement la divergence que ce parametre existe pour retirer.
     *
     * ⚠️ **Le serveur reste l'autorite.** Ces valeurs n'alimentent QUE la
     * prediction d'affichage ; si un ecart subsiste, c'est le snapshot qui a
     * raison.
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
   * convertir le curseur (coordonnees monde, via `Stage.screenToWorld`) en
   * direction de visee (tache 13) : cette position est CELLE que la camera
   * centre (voir `Stage#centerOn`), donc la direction calculee a partir
   * d'elle correspond exactement a ce que l'ecran montre.
   */
  get localPosition(): { x: number; y: number } | null {
    return this.#local ? { x: this.#local.renderX, y: this.#local.renderY } : null;
  }

  /** Niveau courant de l'equipe, pour le HUD (§4.6). Voir `#level`. */
  get level(): number {
    return this.#level;
  }

  /**
   * Tick courant de la horde locale. Expose pour l'observabilite, comme
   * `Room.fieldInputTick` cote serveur : c'est ce qui permet de verrouiller
   * par test que le compteur reste aligne sur le tick absolu recu au WELCOME,
   * puis recale en continu sur celui des snapshots recus (voir `#onFrame`) —
   * sans quoi il resterait en permanence en retard du temps de trajet du
   * WELCOME, pour toute la vie de la connexion (constat C1.b).
   */
  get hordeTick(): number {
    return this.#lastHordeTick;
  }

  /**
   * Horloge dediee aux pings (revue finale de l'etape 9). Avance comme
   * `hordeTick` SAUF pendant que `isFrozen` est vrai — gel strict ET rampe de
   * reprise comprises (tache 24) : c'est la MEME perturbation que celle que
   * `isFrozen` decrit deja pour le HUD, et un ping pose juste avant une
   * montee de niveau ne doit pas s'eteindre pendant que l'equipe choisit ses
   * cartes. `hordeTick`, lui, avance a chaque pas fixe, gel ou pas — seul
   * `#movementScale` ralentit le MOUVEMENT, jamais ce compteur, et c'est
   * precisement la confusion que la revue a trouvee.
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
   * cette phase que se joue la revelation du §4.2.
   */
  get draftSettled(): boolean {
    return this.#draftSettled;
  }

  /** Qui vise quoi — c'est cette visibilite qui fait exister la negociation (§7.2 point 3). */
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
   * ⚠️ **Ne regarde NI les points de vie NI le joueur local.** Un joueur mort
   * vote : le §6 dit *« tout joueur connecte, mort ou vif »*, et le §9.3 que
   * *« la mort d'un seul joueur ne coute rien »* — donc elle ne coute pas la
   * voix, donc elle ne coute pas l'ecran non plus. Il n'y a rien a filtrer
   * ici : le filtre n'existe pas plutot que d'exister a `false`, exactement
   * comme dans `Portal#pending` cote serveur.
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

  /** Qui a vote quoi, abstentions comprises — c'est cette visibilite qui fait exister le vote (§6). */
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
   * C'est l'ENJEU du vote (§5, §6) et la seule chose que le HUD doive montrer
   * en permanence : une cagnotte qu'on ne verrait qu'au moment du vote ne se
   * VIT pas comme une cagnotte non securisee pendant cinq minutes.
   */
  get gold(): number {
    return this.#teamGold;
  }

  /**
   * C -> S : je vote, ou je retire mon vote (`NO_VOTE`).
   *
   * ⚠️ **Le client PROPOSE, le serveur arbitre** (§7.2 de l'etape 4) : rien
   * n'est enregistre localement ici. Un vote refuse — portail ferme, choix
   * inconnu — n'est simplement pas pris, et la prochaine diffusion des votes le
   * montrera. C'est le miroir exact de `placeToken`.
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

  /**
   * Vrai pendant le gel de montee de niveau **et sa rampe de reprise**
   * (tache 24).
   *
   * Sert la seule indication a l'ecran d'ici l'etalage de cartes de l'etape 4 :
   * deux secondes ou plus rien ne bouge, sans explication, se lisent comme un
   * plantage — l'auteur les a d'ailleurs signalees comme telles.
   *
   * ⚠️ Couvre la **rampe** autant que le gel strict : c'est toute la
   * perturbation qui doit se voir, pas seulement sa moitie la plus visible. Un
   * accesseur qui s'eteindrait a la fin du gel laisserait une seconde de
   * ralenti inexpliquee.
   */
  /** La vitesse du monde au tick courant : `0` gele, une rampe a la reprise, `1` sinon. */
  get motionScale(): number {
    return this.#movementScale(this.#lastHordeTick);
  }

  get isFrozen(): boolean {
    if (this.#freezeStartTick < 0) {
      return false;
    }
    return (
      this.#lastHordeTick >= this.#freezeStartTick && this.#lastHordeTick <= this.#resumeEndTick
    );
  }

  /**
   * Nombre cumule de morts appliquees au present, faute d'anneau assez
   * profond pour les rejouer (`ROLLBACK_DEPTH_TICKS`). Lecture seule : voir
   * `#lateDeaths`.
   */
  /** Ennemis abattus depuis le debut de la run (ou du WELCOME pour un retardataire). */
  get kills(): number {
    return this.#kills;
  }

  /**
   * PV max du joueur local : meme somme que `Room` (base, cartes de vitalite,
   * achats du compte), lue sur le miroir d'inventaire.
   */
  get localMaxHp(): number {
    const id = this.#localId;
    const cartes = id === null ? 0 : this.loadoutOf(id).bonus('maxHp');
    return PLAYER_MAX_HP + cartes + this.accountBonuses.maxHp;
  }

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
   * Meme place que `boss`, `zones` ou `hordeTick`, et pour la meme raison : ce
   * n'est ni predit ni interpole, c'est une valeur annoncee dont tout le reste
   * se derive au tick.
   */
  get bossCharge(): BossCharge | null {
    return this.#bossCharge;
  }

  /**
   * Charge de Synergie de l'equipe, telle que portee par le dernier snapshot.
   *
   * Doublon assume de `RenderState.synergy` : le HUD la lit dans l'etat de
   * rendu (comme `xp`), et ce getter existe pour les tests et pour tout
   * appelant qui n'a pas d'etat de rendu sous la main — exactement comme
   * `level` a cote.
   */
  get synergy(): number {
    return this.#teamSynergy;
  }

  /**
   * Le boss vivant, ou `null` — ce que la barre de vie lit a chaque image
   * (`BossBarRenderer.draw`, via `composeFrame`).
   *
   * Un getter et pas un champ de `RenderState` : `RenderState` est ce que la
   * PREDICTION produit (positions predites et interpolees), et le boss n'est
   * predit ni interpole. Meme place que `hordeTick`, `zones` ou `orbs`, lus eux
   * aussi directement sur le client par la boucle de rendu.
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
   * pour qu'un ping refuse n'existe chez personne (§5 de la spec de l'etape 9).
   */
  sendPing(intent: number, x: number, y: number): void {
    this.#ws?.send(encodePing(intent, x, y));
  }

  /** Pings recus depuis la connexion : l'audio en deduit quand sonner. */
  get pingCount(): number {
    return this.#pingCount;
  }

  /**
   * L'etalage courant est-il un coffre (etape 11) ? Fige au `LEVEL_UP` qui
   * l'annonce, sur l'un des deux signaux portes par ce message — voir
   * `#chestsOwed`.
   */
  get draftIsChest(): boolean {
    return this.#draftIsChest;
  }

  /** Ordres de porteur recus depuis la connexion (etape 11) : l'audio en deduit quand sonner. */
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
   * tick (§5 de la spec de l'etape 8).
   */
  get abilityCooldownTicks(): number {
    const classe = this.#localClassId === null ? undefined : classOf(this.#localClassId);
    if (!classe) {
      return 0;
    }
    const pret = this.#lastAbilityTick + ABILITY_COOLDOWN_TICKS[classe.verb];
    return Math.max(0, pret - this.hordeTick);
  }

  /** Leurres annonces trop tard pour l'anneau, plantes au present (diagnostic, §4.6). */
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
      // `pingClock`, pas `hordeTick` (revue finale, etape 9) : voir l'accesseur.
      tick: this.pingClock,
    });
    this.#pingCount += 1;
    this.#lastPingIntent = msg.intent;
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
    // ⚠️ **La prediction locale honore le gel de niveau** (tache 24). Sans ce
    // facteur, `Room.step` figeait tout le monde — joueur compris, il retourne
    // tot pendant le gel — pendant que le client continuait d'avancer son
    // personnage en local, puis se faisait remettre en place par le snapshot
    // suivant. L'auteur voyait « les monstres se figent » et un retour
    // elastique de son propre personnage.
    //
    // Le tick de reference est celui de la horde, c'est-a-dire le tick SERVEUR
    // recale en continu : `#freezeUntilTick` et `#resumeEndTick` sont dates
    // dans ce repere par le message `LEVEL_UP`, jamais dans un tick local.
    //
    // ⚠️ **La vitesse vient de l'inventaire ET du compte, pas de
    // `PLAYER_SPEED`** (tache 9 de l'etape 4, puis la revue finale de l'etape
    // 7b). `Room.step` avance le joueur a
    // `PLAYER_SPEED + loadout.bonus('speed') + accountBonuses.speed` ; des la
    // premiere carte « fougue » (+15 px/s) ou du premier palier de « Celerite »
    // achete (+6 px/s), une prediction qui omet un terme avance moins vite que
    // l'autorite a CHAQUE tick, et chaque snapshot recale le personnage en
    // arriere — le joueur voit une reconciliation permanente, exactement le
    // defaut que la prediction existe pour eviter. Voir `#localSpeed`.
    this.#local?.predict(
      axes.x,
      axes.y,
      dt,
      this.#movementScale(this.#lastHordeTick),
      this.#localSpeed(),
    );

    // Visee locale (tache 13) : lue puis QUANTIFIEE une seule fois pour toute
    // la duree de cet appel — voir la doc de `#localAim`. `readAim` rend deja
    // une direction normalisee ou nulle ; la mise a l'echelle par 127 avant
    // `quantizeAxis` reproduit exactement ce que `#sendInput` envoie sur le
    // fil (memes constantes, meme fonction), pour que `#fireWeapons` ne tire
    // jamais avec un flottant plus precis que ce que le serveur pourra jamais
    // recevoir.
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
    // `pingClock` (revue finale, etape 9) : voir l'accesseur. Mesuree ICI,
    // une seule fois pour tout cet appel — jamais dans `#advanceHorde`, que le
    // rejeu peut executer plusieurs fois pour le meme tick. `#onFrame` ne
    // s'execute jamais depuis `update()` (c'est le handler WebSocket qui
    // l'appelle), donc `isFrozen` est stable sur toute la boucle ci-dessus.
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
      };
      if (index >= 0) {
        players[index] = predicted;
      } else {
        players.push(predicted);
      }
    }

    // ⚠️ **Apres `players`, jamais avant, et jamais depuis `#advanceHorde`.**
    // La capture compare les positions DESSINEES — celle qu'on se predit, celles
    // qu'on interpole pour les autres — parce que ce sont les seules que l'oeil
    // voie et que ce sont elles qui portent l'orbe. Un pas de horde peut ne pas
    // tourner de l'image (accumulateur) ou tourner cinq fois : le ramassage
    // n'est ni plus ni moins frequent que l'image qui le montre.
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
   * ⚠️ **Les TROIS termes, pas deux.** Ce miroir n'additionnait que les deux
   * premiers : le bonus de compte « Celerite » (jusqu'a +30 px/s au palier
   * maximum) manquait a chaque tick. Mesure de l'ecart en regime etabli : 1,57
   * px de retard — invisible a l'oeil, mais c'est exactement le mecanisme que
   * la tache 9 de l'etape 4 a paye une tache entiere pour fermer (voir le
   * docbloc de `PredictedPlayer.predict`), rouvert d'un cran par l'etape 7b.
   *
   * Sans WELCOME, il n'y a pas d'inventaire a consulter — mais les bonus de
   * compte, eux, sont connus des la construction : la vitesse de base les
   * porte donc deja.
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
    // Visee (tache 13) : `encodeInput` applique `quantizeAxis` en interne,
    // exactement la meme fonction que celle utilisee par `update()` pour
    // `#localAim` — c'est ce qui garantit que le tir local et l'entree
    // envoyee au serveur reposent sur la meme discipline de quantification,
    // meme si les deux lectures de `readAim()`/`readInput()` ne tombent pas
    // au meme instant (cadences d'envoi et de simulation decouplees, comme
    // deja le cas pour le deplacement).
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
      // Meme `mask`, memes `probe.cols`/`probe.rows`/`probe.cellSize` que ceux
      // qui viennent d'alimenter `#fields` ci-dessus : c'est la condition du
      // §5.1 appliquee au rendu, pas seulement a la simulation (tache 28).
      // Les armes de depart choisies en salle d'attente : `Room.join` les a
      // posees dans chaque `Loadout` au meme instant que ce WELCOME.
      // Sans choix, la dague : meme regle que `Room.join`.
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
      // Etape 11 : le porteur se reconnait a son archetype, comme le releve du
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
      // Etape 11 : lu A LA RECEPTION, sur les identites du message — sans
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
    if (msg.type === MSG.BOSS_CHARGE) {
      // Meme discipline que les zones et les morts : empiler ici, appliquer (et
      // rejouer) au tick local deja simule — voir `#applyBossCharge`. Une
      // charge DEPLACE le boss : elle doit prendre effet au tick que le serveur
      // a date, quitte a rejouer, jamais a la reception.
      this.#pendingCharges.push(msg);
      return;
    }
    if (msg.type === MSG.REACTION) {
      // ⚠️ **Applique A LA RECEPTION, pas au tick date — a l'oppose exact de
      // `ZONE` juste au-dessus, et la difference est le coeur du §2 de la
      // spec.** Une zone RALENTIT : elle touche le deplacement, donc elle doit
      // etre posee au tick que le serveur a date, quitte a rejouer. Un flash de
      // reaction ne touche rien : il ne fait que se voir. Le dater par tick
      // demanderait de convertir un tick en horloge murale pour une animation
      // dont personne ne peut mesurer les quelques dizaines de millisecondes
      // de retard — meme arbitrage que `HitFlashes`, qui est en horloge murale
      // pour cette raison exacte.
      //
      // ⚠️ **Le client ne rejoue rien et ne tue personne ici.** Les morts de la
      // reaction arrivent par le `DEATHS` existant (§7 du plan : « aucun chemin
      // de mort parallele »), et c'est le rejeu de l'etape 3 qui les place.
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
      // Etape 11 (revue finale) : un coffre du (`#chestsOwed`) est TOUJOURS un
      // coffre — le premier signal, pose par le `WAVE_ORDER` + `DEATHS` de CE
      // porteur. Mais un client qui a rejoint pendant qu'un porteur etait deja
      // vivant n'a jamais vu ce `WAVE_ORDER` : rien n'est du ici, et pourtant
      // le serveur ouvre bien un coffre. Repli, sans octet de plus : une VRAIE
      // montee de niveau fait TOUJOURS strictement monter `#level`, alors que
      // le `LEVEL_UP` d'un coffre porte le niveau d'avant-meme-tick, au plus
      // egal a celui deja connu — voir back/src/room.test.ts, test "coffre et
      // niveau dus au MEME tick...". Inutilisable avant tout niveau connu
      // (`#levelKnown` faux) : un client tout juste connecte ne doit jamais
      // deviner un coffre sur la seule foi de son niveau par defaut.
      this.#draftIsChest = this.#chestsOwed > 0 || (this.#levelKnown && msg.level <= this.#level);
      if (this.#chestsOwed > 0) {
        this.#chestsOwed--;
      }
      // Contrairement au gel, le niveau affiche au HUD peut se mettre a jour
      // des la reception : ce n'est pas une simulation partagee qui doit
      // diverger identiquement des deux cotes, seulement un chiffre a
      // afficher. Pose APRES le repli ci-dessus, qui compare au niveau
      // D'AVANT ce message.
      this.#level = msg.level;
      this.#levelKnown = true;
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
      // ⚠️ **L'etalage n'est PAS vide ici.** Une premiere version le faisait,
      // et rendait la revelation du §4.2 impossible a dessiner : ce message
      // est precisement celui qui dit quelle carte s'illumine, et les issues
      // designent les cartes par leur INDICE dans l'etalage. Le vider ici
      // laissait l'ecran avec des indices pointant vers rien.
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
      // precedent ne doit pas rester affiche. Meme invariant que `DRAFT_OPEN`,
      // qui vide les jetons d'une negociation revolue.
      this.#portalVotes = new Map();
      this.#portalDecision = null;
      // Fenetre de duree INCONNUE : elle commence, et ne finira que quand
      // `PORTAL_RESULT` l'annoncera. La borne est repoussee a l'infini plutot
      // que devinee — la deviner a `deadlineTick` laisserait l'ecran vingt
      // secondes de plus qu'un vote unanime rendu en trois.
      this.#portalCloseTick = Number.MAX_SAFE_INTEGER;
      return;
    }

    if (msg.type === MSG.VOTES) {
      // ⚠️ **Les abstentions passent telles quelles.** `NO_VOTE` circule pour
      // qu'on voie qui n'a pas encore tranche (§6) ; le filtrer ici rendrait
      // « n'a pas vote » indistinguable de « a vote RESTER ».
      this.#portalVotes = new Map(msg.votes.map((v) => [v.playerId, v.choice]));
      return;
    }

    if (msg.type === MSG.PORTAL_RESULT) {
      this.#portalDecision = msg.decision;
      this.#portalGold = msg.gold;
      // ⚠️ **`msg.effectTick` est le tick d'EFFET, pas celui de la
      // reception** — meme discipline que `LEVEL_UP` plus haut. Fermer l'ecran
      // a l'arrivee du message le fermerait chez chacun a un tick different,
      // celui de sa propre latence, au moment meme ou les quatre joueurs
      // regardent le meme verdict.
      this.#portalCloseTick = msg.effectTick;
      return;
    }

    if (msg.type === MSG.RUN_OVER) {
      // Une seule fois par salon (§7) : `Room` ne met `RUN_OVER` en file
      // qu'une fois (`#runOver`), donc rien ici n'a besoin de garde
      // supplementaire cote client.
      this.onRunOver({ survivedTicks: msg.survivedTicks, level: msg.level, kills: msg.kills });
      return;
    }
    if (msg.type !== MSG.SNAPSHOT) {
      return;
    }

    this.#buffer.push(msg, performance.now());

    // Recalage continu (constat C1.b/c) : sans lui, le compteur reste calé
    // sur le retard du WELCOME pour toute la vie de la connexion, et un
    // onglet remis au premier plan après une pause ne rattrape jamais les pas
    // perdus. Voir `HORDE_TICK_LAG_TOLERANCE`.
    if (msg.tick - this.#lastHordeTick > HORDE_TICK_LAG_TOLERANCE) {
      this.#lastHordeTick = msg.tick;
    }

    // `xp` est celui de l'equipe : porte par le snapshot entier, pas par un
    // bloc joueur — on le lit a chaque snapshot, meme si `mine` reste
    // introuvable ci-dessous.
    this.#teamXp = msg.xp;
    // Meme raisonnement que `xp` juste au-dessus : donnee d'EQUIPE, portee par
    // le snapshot entier et pas par un bloc joueur, donc lue a chaque snapshot
    // meme quand `mine` reste introuvable ci-dessous.
    this.#teamSynergy = msg.synergy;
    // Meme raison, une troisieme fois : l'or est celui de l'EQUIPE (§5), porte
    // par l'en-tete du snapshot et pas par un bloc joueur, donc lu a chaque
    // snapshot meme quand `mine` reste introuvable ci-dessous. C'est l'ENJEU
    // du vote : le HUD le montre en permanence, l'ecran du portail le
    // multiplie.
    this.#teamGold = msg.gold;
    // Meme raison, une quatrieme fois : le boss est dans l'EN-TETE du snapshot,
    // pas dans un bloc joueur (§1.1 de la spec — il est UN). On le lit donc
    // avant le `return` ci-dessous, qui ne concerne que le bloc du joueur local.
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
   * tranche pour lui, §4.4) attribuent. Traiter les trois pareil donnerait la
   * carte contestee a TOUS ses pretendants — l'exclusivite du §6.2 s'effondre
   * et le conflit n'aurait plus d'enjeu a l'ecran.
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
      // ⚠️ **Cette garde n'est pas verrouillee par un test, et ne peut pas
      // l'etre** — meme motif que R8 au registre : le `catch` plus bas absorbe
      // son retrait, puisque `undefined.nature` y leve comme n'importe quoi
      // d'autre. Ce qui la tient, c'est `noUncheckedIndexedAccess` : la
      // supprimer ne compile pas (verifie), seul un `as Card` delibere la
      // defait. Deux gardes qui se couvrent l'une l'autre ne sont gardees par
      // aucun test — autant l'ecrire que le laisser croire.
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
        // ne lui connait pas. Purement cosmetique (§5.4 : le serveur arbitre
        // seul), et le sien reste exact — il commence vide des deux cotes.
      }
    }
  }

  /** `nowMs` est l'horloge murale du navigateur (`performance.now()`), portee par `update()` — voir `HitFlashes`. */
  #advanceHorde(dt: number, nowMs: number): void {
    if (this.#fields.length === 0) {
      return;
    }
    const tick = this.#lastHordeTick++;

    // ⚠️ LES ORDRES EN ATTENTE S'APPLIQUENT ICI, EN PREMIER — avant le
    // rafraichissement du champ plus bas. Mesure (§6.2 de la spec) : dans cet
    // ordre, la derive due a la latence reste bornee autour de 20 a 50 px ;
    // dans l'ordre inverse, elle monte a 782 px, soit pire que de ne pas
    // rattraper du tout. C'est la seule raison pour laquelle les ordres sont
    // mis en file plutot qu'appliques a la reception.
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
    // calculees — jamais sous le tick local `tick` (constat C1.a). Le serveur
    // enregistre les siennes sous son propre tick reel ; si le client
    // enregistrait les memes positions sous une cle differente, `delayed()`
    // ne lirait plus la meme chose des deux cotes, meme quand le compteur
    // local est par ailleurs bien recale.
    //
    // ⚠️ Non gate par le gel : le serveur continue d'emettre des snapshots
    // pendant le gel (positions inchangees mais tick qui avance), donc cet
    // enregistrement reste la verite du serveur, gel ou pas. Le gater
    // ouvrirait un trou dans l'anneau court de `PlayerHistory` pour rien.
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
    // revient avant d'y arriver). Sans ce garde, le client rafraichirait un
    // champ — et reciblerait la horde — a un instant ou le serveur ne l'a pas
    // fait, ce qui desynchronise `targetField` independamment de toute
    // difference de position.
    if (tick > this.#freezeUntilTick && tick % STEPS_PER_FIELD === 0) {
      this.#feedFields(tick, true);
    }

    // Le mouvement de la horde est module par `#movementScale` : `0` pendant
    // le gel strict, une rampe pendant la reprise, `1` sinon — exactement le
    // facteur que `Room.step` applique a son propre `dt`. A `0` le pas ne
    // fait litteralement rien (deplacement nul) : inutile de le sauter par un
    // `if` separe. `tick` reste le tick ABSOLU, non mis a l'echelle : c'est
    // lui qui decide la phase de recalcul de trajectoire (tache 19), et cette
    // phase ne doit jamais deraper au gre du gel.
    // ⚠️ **Expirer AVANT d'avancer, comme `Room.step`** — sauf que le client
    // expire `ROLLBACK_DEPTH_TICKS` ticks EN RETARD, et c'est delibere :
    // `HordeHistory` ne sauvegarde que la horde, jamais les zones. Un rejeu
    // qui repart d'un tick ou une zone vivait encore doit pouvoir la
    // retrouver — une zone retiree du tableau est irrecuperable. Elle reste
    // donc en memoire quelques ticks de plus, inerte : c'est
    // `ZoneField.slowsAt`, pas la presence dans le tableau, qui dit si elle
    // agit (voir sa doc). Le serveur, lui, ne rejoue jamais et expire a
    // l'heure ; les deux repondent la meme chose parce que les deux passent
    // par le meme predicat.
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

    // Tir, deplacement des projectiles, collision — miroir cosmetique de
    // l'etape 8 de `Room.step` (back/src/room.ts). Gate par le meme garde de
    // gel que le rafraichissement du champ ci-dessus (le serveur ne tire pas
    // non plus pendant le gel strict, son `step()` y revient avant). Le
    // ralentissement de la reprise (`scale`), lui, ne s'applique QU'au
    // deplacement des projectiles, jamais au tir lui-meme — meme regle que
    // `Room#movementScale` : « le tir automatique… n'est modere par aucune
    // rampe ».
    //
    // ⚠️ Les projectiles ne sont PAS rejoues par `#replayTick` : leur position
    // ne depend que de leur propre vitesse, jamais de la horde — contrairement
    // au mouvement de la horde, il n'y a donc rien a corriger apres une mort
    // tardive. Les y rejouer les ferait avancer deux fois pour les ticks deja
    // simules en temps reel (une fois ici, une fois au rejeu) : une regression
    // silencieuse, pas une amelioration. C'est pour cette meme raison que le
    // pseudo-code du brief de la tache 10 (« le rejeu deplace aussi les
    // projectiles ») n'a pas ete suivi a la lettre ici — voir le rapport de
    // la tache 11.
    if (tick > this.#freezeUntilTick) {
      this.#fireWeapons(tick, snapshot?.players ?? [], nowMs);
      this.#pulseGuards(tick, nowMs);
      // Le miroir cosmetique du souffle de fin de course (etape 8) : la
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
      );
      // Collision purement cosmetique : `collide` ne lit `horde` qu'en
      // lecture (position, `slotOf`) et ne consomme que les propres
      // projectiles du client — jamais un degat, jamais un `kill`. Arbitrer
      // reellement les degats ici serait exactement l'erreur que le §3.2 et
      // `#applyDeaths` interdisent deja au rejeu : prononcer une mort que le
      // serveur n'a pas prononcee.
      this.projectiles.collide(this.horde, (entityId, _damage, projectileSlot) => {
        const slot = this.horde.slotOf(entityId);
        if (slot < 0) {
          return;
        }
        // La teinte de l'arme qui touche (etape 8) : dix-sept armes, dix-sept
        // couleurs d'impact, la ou toutes partageaient le meme flash dore.
        // `weaponAt` est le champ purement cosmetique de `Projectiles`, et
        // c'est exactement son emploi.
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
          // Etape 5b, tache 3 (tour de correction 1) : la chaine est un
          // EVENEMENT, pas un etat — elle se seme ici, au meme instant que la
          // marque, jamais redérivée au dessin. Voir `#seedChainFlash`.
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

    // Instantane pour le rejeu (§3.2) : DOIT etre pris a chaque tick, gel ou
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
   * ⚠️⚠️ **CETTE MARQUE EST UNE APPROXIMATION, ET ELLE DOIT LE RESTER.**
   * C'est le §2 de la spec de l'etape 5a, en toutes lettres : *« une teinte de
   * sprite est cosmetique : si le client marque un ennemi que le serveur
   * n'avait pas marque, personne ne meurt de travers »*. Le client marque ce
   * que SES PROPRES projectiles touchent (des projectiles eux-memes cosmetiques
   * depuis l'etape 3, tires d'une position predite puis reconciliee) et ce qui
   * tombe dans une zone annoncee. Il se trompe donc regulierement, dans les
   * deux sens :
   *
   * | Ce que le serveur fait et que ce client ne fait pas | Consequence |
   * | --- | --- |
   * | consommer la marque quand une reaction a lieu (§4.3) | un ennemi reste teinte un peu trop longtemps |
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
   * Rendre la marque exacte cote client demanderait d'y refaire l'arbitrage
   * des reactions — donc de prononcer localement ce que le serveur seul
   * prononce, et d'inviter la divergence dans le seul mecanisme que tout le
   * projet protege depuis l'etape 2 (trois chiffres de replication a 0,000 px).
   * Le bon reflexe, si la teinte parait fausse, est de la juger a l'oeil : elle
   * n'a pas d'autre juge, et elle n'en merite pas d'autre.
   */
  #markLocally(slot: number, element: number, by: number, tick: number): void {
    this.horde.applyMark(slot, element, by, tick);
  }

  /**
   * Seme un flash de chaine de Foudre, **au moment de l'impact predit par CE
   * client** — jamais depuis une annonce du serveur (etape 5b, tache 3, tour
   * de correction 1).
   *
   * ⚠️ **Meme contrat que `#markLocally`, et pour la meme raison.** §2 de la
   * spec : le client ne prononce jamais un degat — il seme depuis ses PROPRES
   * projectiles (cosmetiques, tires d'une position predite puis reconciliee),
   * jamais depuis ceux des autres joueurs. Deux consequences assumees,
   * identiques a celles de `#markLocally` :
   *
   * | Ce que le serveur fait et que ce client ne fait pas | Consequence |
   * | --- | --- |
   * | chainer depuis les projectiles des AUTRES joueurs | une chaine tiree par un allie n'apparait pas ici |
   * | exclure les morts DU MEME tick (`dead`, cote serveur) | ce client ne connait aucune mort avant `DEATHS` : son chemin peut differer du serveur d'un maillon si un voisin vient tout juste de mourir d'un AUTRE impact |
   *
   * **NE PAS « CORRIGER » EN LA RENDANT AUTORITAIRE** — meme interdiction que
   * sur `#markLocally` : reproduire l'exclusion des morts demanderait de
   * suivre ici l'etat de mort de chaque entite, donc de refaire une part de
   * l'arbitrage serveur. Le flash reste un dessin approximatif d'un evenement
   * arbitre ailleurs, pas une seconde source de verite.
   *
   * ⚠️ **Le CHEMIN est calcule UNE FOIS, ICI, et FIGE dans `chainFlashes`** —
   * voir sa doc. `chainTargets` n'est donc appele qu'a l'impact (un par
   * projectile de Foudre qui touche), jamais a chaque image : c'est ce qui
   * retire le cout O(horde) par ennemi marque et par image de l'ancienne
   * version de ce calque (voir `CHAIN_FLASH_LIFETIME_MS`).
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
      // ⚠️ **INATTEIGNABLE par construction** — meme raisonnement que le
      // `chainedSlot >= 0` de `resolveProjectileDamage` cote serveur :
      // `chainTargets` ne rend que des identites lues DANS `horde` a
      // l'instant meme de cet appel, et rien ne compacte entre les deux.
      // Gardee quand meme : un point manquant silencieux briserait la
      // polyligne sans qu'aucune trace n'existe.
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
   * balayage serveur passe par `applyElement`, qui declenche les reactions du
   * §6.2 ; celui-ci pose la marque et rien d'autre. Une reaction decidee ici
   * serait une reaction que le serveur n'a pas prononcee.
   *
   * ⚠️ **`aliveAt`, pas `slowsAt`** — meme predicat que cote serveur : c'est
   * lui qui dit si la zone EXISTE, alors qu'elle ne ralentit qu'a partir de
   * `T + 1` (le deplacement de `T` etait deja joue). Confondre les deux ferait
   * clignoter la teinte d'un tick a la pose de chaque zone.
   *
   * ⚠️ **Le serveur, lui, ne marque plus des le tick de la pose depuis la
   * tache 21** : ses champs naissent de `applyReactions`, donc APRES son propre
   * `markInZones`. L'ecart est d'un tick, sur une teinte — c'est exactement le
   * genre d'approximation que `#markLocally` documente et assume, et le
   * corriger ici demanderait au client de connaitre l'ordre du tick serveur.
   *
   * Cout : O(zones x entites) par tick, le meme que celui que le §5.2 annonce
   * cote serveur. C'est la contrepartie assumee de la seule ligne du §9 qui
   * soit gratuite a l'affichage (« teinte du sprite — 0 ») : la teinte ne coute
   * rien au rendu, c'est la savoir qui coute.
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
   * Tire les salves dues, cote client — miroir de `Room#fireWeapons`
   * (back/src/room.ts), pour que les projectiles affiches correspondent a ce
   * que chaque joueur voit tirer.
   *
   * Purement cosmetique : les degats restent arbitres par le serveur (§5.4),
   * jamais deduits d'ici.
   *
   * ⚠️ **Parcourt TOUT l'arsenal de chaque joueur, pas la seule arme neutre.**
   * Jusqu'a la tache 9 ce miroir tirait `weaponOf(0)` et rien d'autre — la
   * copie de ce que `Room` faisait avant la tache 7 : aucun projectile d'arme
   * draftee ne s'affichait, ni pour son porteur ni pour ses allies. L'ordre est
   * celui du serveur : l'arme neutre d'abord, TOUJOURS (elle vit hors des
   * slots, §6.1, ne figure dans aucun `Loadout` et ne disparait jamais), puis
   * les armes draftees dans leur ordre d'acquisition.
   *
   * ⚠️ **La visee suit le curseur (tache 13), plus de ciblage.** Ce fichier ne
   * cible donc plus rien dans `horde` : `nearestTarget` et `fireSalvo` (par
   * cible) restent disponibles ailleurs mais ne sont plus appeles ici, voir
   * le rapport de la tache 13. Une visee nulle ne tire pas — meme regle que
   * cote serveur, voir `Projectiles.fireSalvoDirected`.
   *
   * `players` vient du dernier snapshot connu (voir l'appelant) : le client
   * n'a pas de position « vraie » continue pour les joueurs distants, il n'a
   * que la derniere connue — meme source que `#localHp`/`#teamXp`. Le joueur
   * local, lui, utilise sa position simulee (`#local.simX/simY`), plus a jour
   * que le dernier snapshot recu — et de meme, sa visee locale
   * (`#localAim`, DEJA quantifiee, voir `update()`) plutot que celle,
   * retardee par l'aller-retour reseau, que porterait son propre bloc dans
   * `players`. Les allies, eux, n'ont pas d'autre source que ce bloc : sans
   * leur visee transmise par `SNAPSHOT`, ce client ne saurait pas ou dessiner
   * leurs projectiles (voir la doc de `PlayerSnapshot`).
   */
  /**
   * Les invocations vivantes, cote client (etape 8) — la meme liste que celle
   * du serveur, derivee des memes trois choses, plus la TEINTE de l'arme qui
   * n'interesse que le dessin.
   */
  #guards: (Guard & { tint: number })[] = [];

  /**
   * Dessine une pulsation par invocation due a ce tick, et oublie celles qui
   * se sont eteintes — le miroir cosmetique de `Room#pulseGuards`.
   *
   * ⚠️ **Elle NE SECOUE PAS l'ecran** (`shakes: false`), pour la meme raison
   * que le halo : une invocation frappe deux fois par seconde pendant cinq
   * secondes, et une secousse continue est exactement ce que l'etape 8 vient
   * de corriger.
   */
  #pulseGuards(tick: number, nowMs: number): void {
    if (this.#guards.length === 0) {
      return;
    }
    for (const guard of this.#guards) {
      if (guardPulsesAt(guard, tick)) {
        this.hitFlashes.spawn(
          guard.x,
          guard.y,
          guard.tint,
          guard.radius,
          guard.damage,
          nowMs,
          false,
        );
      }
    }
    this.#guards = this.#guards.filter((g) => guardIsAlive(g, tick));
  }

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
   * locale** : c'est litteralement la fonction que le serveur applique. Le
   * multiplicateur de degats l'accompagne pour la meme raison — un projectile
   * affiche doit porter le meme nombre que celui que le serveur arbitre, meme
   * si rien ici n'en decide l'issue (§5.4).
   *
   * ⚠️ **Les bonus de COMPTE s'ajoutent aux passifs du draft, sur les deux
   * calculs** (revue finale de l'etape 7b). `Room#fireOne` somme
   * `loadout.bonus('fireRate') + accountBonuses.fireRate` et
   * `1 + loadout.bonus('damage') + accountBonuses.damage` ; ce miroir n'en
   * lisait que le premier terme. Mesure du defaut : avec Cadence au palier
   * maximum (+0,15), sur 30 s a 30 Hz, l'arme neutre — celle que tout le monde
   * porte en permanence — affichait **225 salves pour 300 cote serveur, 25% de
   * perte**, parce que l'arrondi de `cooldownWithBonus` amplifie le bonus sur
   * une recharge de 4 ticks. Et la phase derivait sans borne : les deux suites
   * de ticks de tir n'ont aucun point de resynchronisation.
   *
   * ⚠️ **Ce que ca coutait depasse « des tirs manquants ».** `#markLocally`
   * n'est appele que depuis `projectiles.collide` : la teinte elementaire etait
   * donc posee 25% moins souvent que le serveur ne marque. Le joueur lisait un
   * monstre non teinte, planifiait en consequence, et une reaction partait sans
   * qu'il l'ait vue venir — le pendant exact du « une capture declenchee sans
   * ramassage reel MENTIRAIT » que le §5 de la spec invoque pour justifier
   * l'octet du rayon de ramassage.
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
    // LOCAL — la meme approximation que `accountBonuses.damage` juste a cote.
    // Cosmetique (§5.4).
    const damage = shotDamage(
      weapon,
      loadout,
      this.accountBonuses.damage,
      PLAYER_MAX_HP + loadout.bonus('maxHp') + this.accountBonuses.maxHp,
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
      // ⚠️ **Il ne SECOUE PAS** : un halo pulse sans arret, et une secousse
      // continue est precisement ce que cette etape vient de corriger. Voir
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
      });
      last[weaponId] = tick;
      return;
    }
    if (weapon.kind === 'faisceau') {
      // ⚠️ **Le miroir cosmetique d'un faisceau est une POLYLIGNE a deux
      // points, et elle reutilise le calque de la chaine de Foudre** : c'est
      // deja le seul calque du jeu qui sache tracer un trait entre deux points
      // du monde, avec son extinction. Un calque de plus aurait redit la meme
      // chose — et le §6.6 compte les calques.
      //
      // Les deux bouts sont derives comme cote serveur (`beamRange` et la
      // visee), donc le trait dessine est exactement celui que le serveur
      // vient de faucher.
      const portee = beamRange(weapon);
      this.chainFlashes.spawn(
        [
          { x, y },
          { x: x + aimX * portee, y: y + aimY * portee },
        ],
        nowMs,
        weapon.look.tint,
        2 * weapon.blastRadius,
      );
      last[weaponId] = tick;
      return;
    }
    const count = weapon.projectileCount;
    // ⚠️ **Le tireur ET son critique**, comme `Room#fireOne` : sans `playerId`
    // le tirage partait de `hashRoll(tick, 0, i)`, et le critique affiche
    // n'etait pas celui que le serveur arbitre (corrige a l'etape 10).
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
   * Applique tous les lots de morts recus mais pas encore traites, au tick
   * local `currentTick` — celui que `#advanceHorde` vient tout juste de
   * simuler et d'enregistrer dans `#hordeHistory`.
   *
   * ⚠️ Suppose que la file reste dans l'ordre chronologique des ticks
   * SERVEUR des lots, pas seulement dans l'ordre de leur reception. Deux
   * faits, tous deux vrais aujourd'hui et tous deux necessaires, portent
   * cette hypothese :
   *   1. `Room.step` (voir `room.ts`) n'empile jamais qu'UN SEUL `DEATHS` par
   *      tick, dans le tableau `#pendingDeaths` du serveur, donc l'emission
   *      elle-meme est deja triee par tick croissant, sans jamais interfoliation.
   *   2. WebSocket, sur une MEME connexion TCP, livre les trames dans leur
   *      ordre d'emission — jamais de reordonnancement, jamais de duplication.
   * Aucune des deux n'est reverifiee ici : ce n'est pas une garde, c'est une
   * hypothese documentee, dont la rupture romprait un invariant que rien
   * dans ce fichier ne produit aujourd'hui (voir le rapport de la tache 10,
   * qui explique pourquoi une garde contre un desordre que rien ne cause n'a
   * pas ete ajoutee). Rejouer un lot plus recent AVANT un lot plus ancien
   * effacerait la correction du second par le rejeu du premier.
   */
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
   * exacte — c'est la lecon du gel de niveau de l'etape 3, transposee au
   * premier effet qui touche le DEPLACEMENT.
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
   * rejeu est precisement ce qui ramene cet ecart a zero (mesure : scenario 11
   * de `shared/horde.replication.test.ts`).
   *
   * `windupTick >= currentTick` : rien a rejouer, la charge est entierement
   * devant nous — c'est meme le cas NOMINAL, puisque le chargement dure
   * `BOSS_CHARGE_WINDUP_TICKS` (30 ticks) et qu'un message met un a trois ticks
   * a arriver. Le rejeu n'existe ici que pour la queue de distribution.
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

  #drainPendingDeaths(currentTick: number): void {
    while (this.#pendingDeaths.length > 0) {
      const batch = this.#pendingDeaths.shift();
      if (batch) {
        this.#applyDeaths(batch.tick, batch.ids, currentTick);
      }
    }
  }

  /**
   * Applique un lot de morts par rejeu (§3.2) : restaure la horde au tick de
   * la mort, tue, rejoue jusqu'au present. Appliquer directement au present
   * laisserait un ecart d'un ou plusieurs ticks s'installer — et la
   * separation (tache 1) le propage a des dizaines de voisines plutot que de
   * l'absorber : mesure a l'etape 2, l'equivalent sans rejeu croit sans borne
   * jusqu'a 694 px en dix secondes (scenario 8 de `horde.replication.test.ts`).
   *
   * Les orbes sont derives ICI, a la position lue dans la horde restauree —
   * juste avant `kill`, comme `resolveProjectileDamage` cote serveur lit la
   * position juste avant sa propre compaction (voir `back/src/combat.ts`).
   *
   * ⚠️ Le rejeu ne rejoue QUE le mouvement — champ, horde, separation — jamais
   * l'arbitrage (degats, contact, ramassages) : ce sont les etapes 8 a 10 de
   * `Room.step`, prerogative exclusive du serveur. Un client qui les rejouerait
   * prononcerait des morts que le serveur n'a pas decidees, et divergerait
   * precisement la ou le rejeu cherche a converger.
   */
  #applyDeaths(deathTick: number, ids: readonly number[], currentTick: number): void {
    this.#kills += ids.length;
    if (!this.#hordeHistory.restore(deathTick, this.horde)) {
      // Trop vieux pour l'anneau (`ROLLBACK_DEPTH_TICKS`) : applique au
      // present, et SIGNALE — une degradation silencieuse est un piege (§4.6
      // de l'orientation demande un HUD, pas des logs). Scenario 10 de
      // `horde.replication.test.ts` mesure la derive residuelle de ce chemin.
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
    // tick present, plusieurs generations plus frais que ce que le serveur
    // avait sous les yeux au tick restaure. Mesure a la tache 8 : 79 px de
    // derive residuelle sur un scenario qui aurait du rendre zero.
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
   * jusqu'a `endTick` au-dessus d'un boss qui n'existe plus. Le boss tombe
   * pendant sa charge — c'est un cas rare, pas un cas impossible.
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
