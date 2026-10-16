import { archetypeIdOf, NECRO_CHILD, PORTEUR_ARCHETYPE, SPLIT_CHILD } from '@shared/archetypes';
import { type BossCharge, makeBossCharge } from '@shared/boss';
import { CARD } from '@shared/cards';
import {
  CHAIN_JUMPS,
  CHAIN_RADIUS,
  COIN_DROP_ONE_IN,
  FLOWFIELD_CELL,
  FLOWFIELD_HZ,
  INPUT_HZ,
  LEVEL_RESUME_TICKS,
  MAP_SIZE,
  MARK_DURATION_TICKS,
  ORB_DROP_ONE_IN,
  ORB_PICKUP_RADIUS,
  PLAYER_SPEED,
  PROJECTILE_HIT_RADIUS,
  ROLLBACK_DEPTH_TICKS,
  TICK_HZ,
  TRANSCENDANCE_MAX_HP,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
  ZONE_REFRESH_INTERVAL_TICKS,
} from '@shared/constants';
import { ELEMENT } from '@shared/elements';
import { critOf } from '@shared/firing';
import { FlowField } from '@shared/flowfield';
import { dropsCoin, dropsOrb, entityIdOf, Horde, leavesDrop } from '@shared/horde';
import { FRAPPE_DELAY_TICKS } from '@shared/onde-frappe';
import { PASSIVES, passiveOf } from '@shared/passives';
import { PlayerHistory } from '@shared/player-history';
import {
  decode,
  encodeBossCharge,
  encodeDeaths,
  encodeDraftIntents,
  encodeDraftOpen,
  encodeDraftResult,
  encodeLevelUp,
  encodePickups,
  encodePortalOpen,
  encodePortalResult,
  encodeReaction,
  encodeRunOver,
  encodeSnapshot,
  encodeVotes,
  encodeWaveOrder,
  encodeWelcome,
  encodeZone,
  MSG,
  NO_VOTE,
  OUTCOME,
  packElementPair,
  packZoneKind,
  TOKEN_BYTES,
  VOTE_CHOICE,
} from '@shared/protocol';
import { RARITY } from '@shared/rarity';
import { bonusesOf, maxBonus, SHOP_ITEMS } from '@shared/shop';
import { FORMATION, type WaveOrder } from '@shared/waves';
import {
  BASE_WEAPON_ID,
  beamRange,
  cooldownWithBonus,
  ORBIT_BREATH,
  ORBIT_RADIUS,
  stackGain,
  WEAPONS,
  type Weapon,
  weaponOf,
} from '@shared/weapons';
import { applyObstacles, generateObstacles } from '@shared/worldmap';
import { ZoneField } from '@shared/zones';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHAIN_FLASH_LIFETIME_MS,
  DerivedOrbs,
  GameClient,
  HIT_FLASH_LIFETIME_MS,
  type InputAxes,
  type ObstacleMap,
  ORB_FLIGHT_LIFETIME_MS,
  OrbFlights,
  PORTEUR_BANNER_MS,
  REACTION_FLASH_LIFETIME_MS,
  trackBoss,
} from './client';

/**
 * Faux `WebSocket` : ni connexion reseau ni serveur, juste de quoi capturer
 * les ecouteurs et simuler l'arrivee de messages. `GameClient` n'importe pas
 * `WebSocket` explicitement — il lit le symbole global — donc le remplacer
 * globalement suffit a l'isoler du reseau.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  /**
   * Meme valeur que le vrai `WebSocket.OPEN` : `#sendInput` ne parle que si
   * `readyState === WebSocket.OPEN`, et `WebSocket` est ici CETTE classe
   * (`vi.stubGlobal`). Sans elle, aucun INPUT ne partirait jamais.
   */
  static readonly OPEN = 1;
  readonly #listeners = new Map<string, ((event: { data: ArrayBuffer }) => void)[]>();
  binaryType = '';
  readyState = 0;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (event: { data: ArrayBuffer }) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(cb);
    this.#listeners.set(type, list);
  }

  /** Trames poussees par le client — le chemin SORTANT (`DRAFT_TOKEN`...). */
  readonly sent: ArrayBuffer[] = [];

  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    // Rien a fermer.
  }

  emit(type: string, event: { data: ArrayBuffer }): void {
    // Un vrai WebSocket passe a OPEN AVANT de declencher son evenement 'open'.
    if (type === 'open') {
      this.readyState = FakeSocket.OPEN;
    }
    for (const cb of this.#listeners.get(type) ?? []) {
      cb(event);
    }
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

function latestSocket(): FakeSocket {
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (!socket) {
    throw new Error('aucune fausse socket creee');
  }
  return socket;
}

describe('GameClient — alignement du tick de la horde sur le WELCOME', () => {
  it('initialise hordeTick avec le tick absolu du WELCOME, pas avec zero', () => {
    // `WelcomeMessage.tick` est le tick ABSOLU du salon (`this.room.tick` cote
    // serveur), pas un compteur qui repart de zero par joueur. Un salon qui
    // vit depuis plusieurs minutes envoie un tick eleve a un joueur qui vient
    // tout juste de rejoindre.
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();

    latestSocket().emit('message', { data: encodeWelcome(1, 5000, 0xabc_def) });

    expect(client.hordeTick).toBe(5000);
  });

  it('calcule un rattrapage non nul pour un ordre emis avant le tick local courant', () => {
    // Sans l'alignement, `tick - spawnTick` serait massivement negatif,
    // `missed` clampe a zero en permanence, et le rattrapage ne s'executerait
    // jamais.
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();

    socket.emit('message', { data: encodeWelcome(1, 5000, 0xabc_def) });

    const spy = vi.spyOn(client.horde, 'spawnCatchingUp');

    const STEP = 1 / TICK_HZ;
    // Deux pas locaux avant que l'ordre n'arrive : le tick local passe de
    // 5000 a 5002.
    client.update(0, STEP);
    client.update(STEP, STEP);

    // L'ordre a ete emis au tick serveur 5000 : le client, qui en est
    // maintenant a 5002, doit rattraper deux pas.
    socket.emit('message', {
      data: encodeWaveOrder({
        waveId: 1,
        spawnTick: 5000,
        seed: 0x51ee_d001,
        archetype: 0,
        formation: FORMATION.CLUSTER,
        anchorX: 3000,
        anchorY: 3000,
        count: 10,
      }),
    });

    client.update(2 * STEP, STEP);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ spawnTick: 5000 }),
      2,
      STEP,
      expect.anything(),
      // Les zones : le rattrapage doit ralentir comme le serveur l'a fait
      // pendant les pas manques.
      client.zones,
      // La charge du boss : meme raison. `null` ici, mais le parametre DOIT
      // etre passe, sans quoi un rattrapage pendant une charge avancerait le
      // boss par sa vitesse au lieu de le deriver le long du couloir.
      null,
    );
    expect(client.horde.count).toBe(10);
  });
});

describe('GameClient — livre le masque d obstacles au rendu (tache 28)', () => {
  it('livre au rendu exactement le meme masque et la meme geometrie que ceux appliques aux champs de flux', () => {
    // Mutation testee : un masque regenere a part (autre graine, ou decale
    // d'une cellule) plutot que CELUI qui alimente `#fields` fait echouer ce
    // test.
    const mapSeed = 0x51ee_d0;
    const onMapReady = vi.fn();
    const client = new GameClient(
      'ws://test',
      () => ({ x: 0, y: 0 }),
      vi.fn(),
      undefined,
      undefined,
      onMapReady,
    );
    client.connect();

    latestSocket().emit('message', { data: encodeWelcome(1, 0, mapSeed) });

    expect(onMapReady).toHaveBeenCalledTimes(1);
    const map = onMapReady.mock.calls[0]?.[0] as ObstacleMap;

    // Reconstruit independamment, avec la meme sonde `FlowField` que
    // `client.ts`, comme `makeReferenceServer` plus bas.
    const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    const expectedMask = generateObstacles(mapSeed, probe.cols, probe.rows);

    expect(map.cols).toBe(probe.cols);
    expect(map.rows).toBe(probe.rows);
    expect(map.cellSize).toBe(probe.cellSize);
    expect([...map.mask]).toEqual([...expectedMask]);
  });

  it('le masque livre n est pas vide — un `generateObstacles` appele sans cols/rows le rendrait tel, en silence', () => {
    // Mutation testee : oublier `cols`/`rows` (ou les passer a zero) sur le
    // chemin qui alimente `onMapReady` rend `generateObstacles` silencieux —
    // voir sa doc — et ce test est la seule garantie que le masque livre au
    // rendu contient reellement des cellules murees.
    const onMapReady = vi.fn();
    const client = new GameClient(
      'ws://test',
      () => ({ x: 0, y: 0 }),
      vi.fn(),
      undefined,
      undefined,
      onMapReady,
    );
    client.connect();

    latestSocket().emit('message', { data: encodeWelcome(1, 0, 0x51ee_d0) });

    const map = onMapReady.mock.calls[0]?.[0] as ObstacleMap;
    const blocked = map.mask.reduce((n, v) => n + v, 0);
    expect(blocked).toBeGreaterThan(0);
  });
});

describe('GameClient — hp du joueur local et xp d equipe', () => {
  it(
    'reprend hp du dernier snapshot pour le joueur local predit, ' +
      'la prediction ne simule que la position',
    () => {
      const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
      client.connect();
      const socket = latestSocket();

      socket.emit('message', { data: encodeWelcome(1, 0, 0) });
      socket.emit('message', {
        data: encodeSnapshot(0, 777, 0, [
          {
            id: 1,
            x: 10,
            y: 20,
            hp: 42,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });

      const state = client.update(0, 0);

      expect(state.players.find((p) => p.id === 1)).toMatchObject({ hp: 42 });
    },
  );

  /**
   * ⚠️ **La valeur, pas seulement le champ.** Seule une valeur NON NULLE et
   * NON PAR DEFAUT (33) prouve que `#localShield` est lu depuis le dernier
   * snapshot plutot que laisse a son defaut de construction.
   */
  it('reprend le bouclier du dernier snapshot pour le joueur local predit', () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();

    socket.emit('message', { data: encodeWelcome(1, 0, 0) });
    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, [
        {
          id: 1,
          x: 10,
          y: 20,
          hp: 100,
          aimX: 0,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 33,
        },
      ]),
    });

    const state = client.update(0, 0);

    expect(state.players.find((p) => p.id === 1)).toMatchObject({ shield: 33 });
  });

  it("reprend l'experience d'equipe du dernier snapshot, au niveau du RenderState", () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();

    socket.emit('message', { data: encodeWelcome(1, 0, 0) });
    socket.emit('message', {
      data: encodeSnapshot(0, 777, 0, [
        {
          id: 1,
          x: 10,
          y: 20,
          hp: 42,
          aimX: 0,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 0,
        },
      ]),
    });

    const state = client.update(0, 0);

    expect(state.xp).toBe(777);
  });
});

/**
 * La vie du boss, telle que le client la retient.
 *
 * ⚠️ **Le maximum est OBSERVE, jamais recu** : le palier ne voyage nulle part,
 * donc `bossHp(k, joueurs)` est hors de portee du client — voir `BossVitals`.
 * `trackBoss` est pure, donc ces assertions n'ouvrent aucun WebSocket.
 */
describe('trackBoss — les PV du boss et le maximum que ce client lui a vu', () => {
  it('prend le premier releve pour maximum', () => {
    expect(trackBoss(null, { id: 8193, hp: 6000 })).toEqual({ id: 8193, hp: 6000, maxHp: 6000 });
  });

  it('garde le maximum pendant que les PV descendent', () => {
    const debut = trackBoss(null, { id: 8193, hp: 6000 });
    const apres = trackBoss(debut, { id: 8193, hp: 2400 });
    expect(apres).toEqual({ id: 8193, hp: 2400, maxHp: 6000 });
  });

  /**
   * ⚠️ **Le changement d'IDENTITE remet le maximum a zero, et rien d'autre.**
   *
   * ⚠️ **Le decor est un boss PLUS PETIT que le precedent** : avec un boss
   * plus gros, `Math.max(ancien, nouveau)` rend deja la bonne reponse et la
   * mutation « ne jamais reinitialiser sur un nouvel identifiant » survit.
   *
   * Et le cas est reel : `bossHp` suit le palier ET le nombre de joueurs. Un
   * joueur qui se deconnecte entre deux paliers fait apparaitre un boss moins
   * gros que le precedent.
   */
  it('repart d un maximum neuf quand un autre boss apparait, meme plus petit', () => {
    const premier = trackBoss(null, { id: 8193, hp: 6000 });
    const suivant = trackBoss(premier, { id: 12289, hp: 1680 });
    expect(suivant).toEqual({ id: 12289, hp: 1680, maxHp: 1680 });
  });

  /**
   * ⚠️ **La sentinelle est sur l'IDENTITE, pas sur les PV** (`NO_BOSS_ID`,
   * `shared/protocol.ts`) : un boss a 0 PV est un boss — il meurt au tick
   * suivant, par `DEATHS`, comme tout le monde. Le lire comme une absence
   * ferait disparaitre sa barre juste avant sa mort.
   */
  it('garde un boss a zero PV, et n oublie que sur une absence', () => {
    const vivant = trackBoss(null, { id: 8193, hp: 6000 });
    expect(trackBoss(vivant, { id: 8193, hp: 0 })).toEqual({ id: 8193, hp: 0, maxHp: 6000 });
    expect(trackBoss(vivant, null)).toBeNull();
  });

  it('rend null tant qu aucun boss n est en jeu', () => {
    expect(trackBoss(null, null)).toBeNull();
  });
});

describe('GameClient — le boss du snapshot (etape 6a, tache 5)', () => {
  /** Le decor sans boss : `encodeSnapshot` met `NO_BOSS_ID` quand on ne lui en donne pas. */
  it('n a pas de boss tant que le snapshot n en porte pas', () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();

    socket.emit('message', { data: encodeWelcome(1, 0, 0) });
    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, [
        {
          id: 1,
          x: 10,
          y: 20,
          hp: 42,
          aimX: 0,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 0,
        },
      ]),
    });

    expect(client.boss).toBeNull();
  });

  /**
   * ⚠️ **Lu AVANT le `return` du bloc joueur local.** Le boss est dans
   * l'EN-TETE du snapshot, comme `xp` et `synergy` : un client qui ne se voit
   * pas encore dans la liste des joueurs (premiers ticks apres le WELCOME, ou
   * salon rejoint en cours) doit quand meme voir le boss. Ce decor n'envoie
   * DELIBEREMENT aucun bloc pour le joueur 1.
   */
  it('lit le boss meme quand le snapshot ne porte pas le bloc du joueur local', () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();

    socket.emit('message', { data: encodeWelcome(1, 0, 0) });
    socket.emit('message', {
      data: encodeSnapshot(
        0,
        0,
        0,
        [
          {
            id: 2,
            x: 10,
            y: 20,
            hp: 42,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ],
        {
          id: 8193,
          hp: 6000,
        },
      ),
    });

    expect(client.boss).toEqual({ id: 8193, hp: 6000, maxHp: 6000 });
  });

  it('suit ses PV d un snapshot a l autre en gardant le maximum vu', () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();

    socket.emit('message', { data: encodeWelcome(1, 0, 0) });
    const joueurs = [
      { id: 1, x: 10, y: 20, hp: 42, aimX: 0, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS, shield: 0 },
    ];
    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, joueurs, { id: 8193, hp: 6000 }),
    });
    socket.emit('message', {
      data: encodeSnapshot(1, 0, 0, joueurs, { id: 8193, hp: 1800 }),
    });

    expect(client.boss).toEqual({ id: 8193, hp: 1800, maxHp: 6000 });
  });

  it('oublie le boss des que le snapshot n en porte plus', () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();

    socket.emit('message', { data: encodeWelcome(1, 0, 0) });
    const joueurs = [
      { id: 1, x: 10, y: 20, hp: 42, aimX: 0, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS, shield: 0 },
    ];
    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, joueurs, { id: 8193, hp: 6000 }),
    });
    socket.emit('message', { data: encodeSnapshot(1, 0, 0, joueurs) });

    expect(client.boss).toBeNull();
  });
});

const STEP = 1 / TICK_HZ;
const STEPS_PER_FIELD = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));

/**
 * Duree de gel choisie par ces tests.
 *
 * ⚠️ Ce n'est pas une constante du jeu : le gel dure jusqu'a ce que tout le
 * monde ait pose son jeton, et **seul le serveur en connait la fin**, qu'il
 * annonce par `DRAFT_RESULT` de phase 0.
 *
 * ⚠️ **Une duree arbitraire, egale a aucune constante du jeu** : c'est ce qui
 * fait echouer un client qui deduirait la fin du gel d'une constante au lieu
 * d'attendre le message.
 */
const GEL_TICKS = 137;

/**
 * Simulation "serveur" de reference, batie directement sur les modules
 * `shared/` — meme raisonnement que `shared/horde.replication.test.ts`. Sert
 * de point de comparaison pour mesurer la derive du vrai `GameClient`.
 */
interface ReferenceServer {
  horde: Horde;
  fields: FlowField[];
  playerHistory: PlayerHistory;
}

function makeReferenceServer(mapSeed: number, capacity: number): ReferenceServer {
  const horde = new Horde(capacity);
  const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
  const mask = generateObstacles(mapSeed, probe.cols, probe.rows);
  const fields = Array.from({ length: 4 }, () => {
    const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    applyObstacles(f, mask);
    return f;
  });
  return {
    horde,
    fields,
    playerHistory: new PlayerHistory(),
  };
}

/**
 * Index de creneau par index de vague, ou -1 : une mort compacte le tableau
 * differemment des deux cotes, comparer par CRENEAU comparerait deux entites
 * differentes. Meme raisonnement que `shared/horde.replication.test.ts`.
 */
function slotByWaveIndex(horde: Horde, span: number): Int32Array {
  const out = new Int32Array(span).fill(-1);
  for (let slot = 0; slot < horde.count; slot++) {
    const idx = horde.indexInWave[slot] ?? 0;
    if (idx < span) {
      out[idx] = slot;
    }
  }
  return out;
}

/** Derive maximale entre deux hordes, appariees par IDENTITE ; ignore les entites absentes d'un cote. */
function measureDrift(reference: Horde, participant: Horde, span: number): number {
  const refSlots = slotByWaveIndex(reference, span);
  const partSlots = slotByWaveIndex(participant, span);
  let maxDrift = 0;
  for (let e = 0; e < span; e++) {
    const rs = refSlots[e] ?? -1;
    const ps = partSlots[e] ?? -1;
    if (rs < 0 || ps < 0) {
      continue;
    }
    const drift = Math.hypot(
      (participant.x[ps] ?? 0) - (reference.x[rs] ?? 0),
      (participant.y[ps] ?? 0) - (reference.y[rs] ?? 0),
    );
    if (drift > maxDrift) {
      maxDrift = drift;
    }
  }
  return maxDrift;
}

/** Index de vague encore vivants, tries — pour comparer deux ensembles d'identites terme a terme. */
function aliveWaveIndices(horde: Horde): number[] {
  const out: number[] = [];
  for (let slot = 0; slot < horde.count; slot++) {
    out.push(horde.indexInWave[slot] ?? 0);
  }
  return out.sort((a, b) => a - b);
}

interface DeathSchedule {
  tick: number;
  ids: number[];
  /** Retard de livraison propre a ce lot ; par defaut celui de `deathDelayTicks`. */
  delay?: number;
}

interface DeathScenarioResult {
  client: GameClient;
  reference: Horde;
  maxDrift: number;
  travelled: number;
}

/**
 * Fait tourner en parallele une reference "serveur" (les modules `shared/`
 * pilotes directement, comme le ferait `Room.step`) et un vrai `GameClient`
 * connecte a une fausse socket, qui lui livre `WELCOME`, `WAVE_ORDER`,
 * `SNAPSHOT` (chaque tick) et `DEATHS` (retardees de `deathDelayTicks`).
 *
 * Les positions des joueurs suivent le meme mouvement circulaire que
 * `shared/horde.replication.test.ts` : un champ fige ne prouverait rien.
 */
function runClientDeathScenario(params: {
  mapSeed: number;
  waveId: number;
  entities: number;
  deaths: readonly DeathSchedule[];
  deathDelayTicks: number;
  ticks: number;
}): DeathScenarioResult {
  const { mapSeed, waveId, entities, deaths, deathDelayTicks, ticks } = params;

  const ref = makeReferenceServer(mapSeed, entities);
  const order: WaveOrder = {
    waveId,
    spawnTick: 0,
    seed: 0x51ee_d001,
    archetype: 0,
    formation: FORMATION.CLUSTER,
    anchorX: 1200,
    anchorY: 1200,
    count: entities,
  };
  // `ref.fields[0]` evite de faire naitre une entite en plein mur, comme
  // `Room.step` et comme `GameClient` via `spawnCatchingUp`.
  ref.horde.spawn(order, ref.fields[0]);

  const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
  client.connect();
  const socket = latestSocket();
  socket.emit('message', { data: encodeWelcome(1, 0, mapSeed) });
  socket.emit('message', { data: encodeWaveOrder(order) });

  const delivered = deaths.map(() => false);
  let inFlight = 0;
  let maxDrift = 0;
  let travelled = 0;
  let prevX = 0;
  let prevY = 0;
  let hasPrev = false;
  // Un index de vague qui n'entre jamais dans le calendrier de morts : il
  // survit tout le run, et prouve que la horde a REELLEMENT avance — une
  // derive nulle peut vouloir dire "rien n'a bouge" autant que "replication
  // parfaite".
  const trackedId = entityIdOf(waveId, entities - 1);

  for (let tick = 0; tick < ticks; tick++) {
    // ⚠️ Arrondies, comme sur le fil (voir `Room.step`) : le client ne connait
    // que la version quantifiee en int16. Avec des flottants, les deux cotes
    // enracineraient leur BFS dans des cellules differentes aux frontieres, et
    // la derive n'aurait plus rien a voir avec le rejeu des morts.
    const xs = [0, 1, 2, 3].map((p) => Math.round(3000 + Math.cos(tick * 0.02 + p) * 1500));
    const ys = [0, 1, 2, 3].map((p) => Math.round(3000 + Math.sin(tick * 0.02 + p) * 1500));

    ref.playerHistory.record(tick, xs, ys);
    if (tick % STEPS_PER_FIELD === 0) {
      const seen = ref.playerHistory.delayed(tick);
      if (seen) {
        for (let f = 0; f < 4; f++) {
          ref.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
        }
        ref.horde.retarget(seen.x, seen.y);
      }
    }
    ref.horde.step(STEP, ref.fields, tick);

    // Le serveur de reference arbitre et applique a l'instant meme : lui seul
    // decide QUAND une mort a lieu, jamais avec latence sur lui-meme.
    for (const batch of deaths) {
      if (batch.tick === tick) {
        ref.horde.kill(batch.ids);
        inFlight++;
      }
    }

    const players = xs.map((x, i) => ({
      id: i,
      x,
      y: ys[i] ?? 0,
      hp: 100,
      aimX: 0,
      aimY: 0,
      pickupRadius: ORB_PICKUP_RADIUS,
      shield: 0,
    }));
    socket.emit('message', { data: encodeSnapshot(tick, 0, 0, players) });

    // Livraison retardee au client : latence reseau simulee.
    deaths.forEach((batch, i) => {
      const delay = batch.delay ?? deathDelayTicks;
      if (!delivered[i] && batch.tick + delay === tick) {
        socket.emit('message', { data: encodeDeaths(batch.tick, batch.ids) });
        delivered[i] = true;
        inFlight--;
      }
    });

    client.update(tick * STEP, STEP);

    // « Derive residuelle » se lit APRES application : entre la decision et sa
    // livraison retardee, le client porte encore des voisins que le serveur a
    // deja retires — un ecart du au transit du message, pas au rejeu.
    if (inFlight === 0) {
      const drift = measureDrift(ref.horde, client.horde, entities);
      if (drift > maxDrift) {
        maxDrift = drift;
      }
    }

    const trackedSlot = ref.horde.slotOf(trackedId);
    if (trackedSlot >= 0) {
      const x = ref.horde.x[trackedSlot] ?? 0;
      const y = ref.horde.y[trackedSlot] ?? 0;
      if (hasPrev) {
        travelled += Math.hypot(x - prevX, y - prevY);
      }
      prevX = x;
      prevY = y;
      hasPrev = true;
    }
  }

  return { client, reference: ref.horde, maxDrift, travelled };
}

describe('GameClient — morts appliquees par rejeu (rollback + replay, tache 10)', () => {
  it(
    'une mort livree dans la portee de ROLLBACK_DEPTH_TICKS converge par rejeu : ' +
      'identites exactes, derive faible, lateDeaths a zero',
    () => {
      const WAVE_ID = 21;
      const ENTITIES = 300;
      // 151, pas 150 : hors des frontieres de rafraichissement du champ
      // (stepsPerField = 3, et 151 % 3 = 1) — sinon un `primeFieldForReplay`
      // qui utiliserait directement `atTick` au lieu de le ramener a `lastDue`
      // passerait inapercu.
      const DEATH_TICK = 151;
      const DEATH_IDS = Array.from({ length: 30 }, (_, k) => entityIdOf(WAVE_ID, k));
      // Bien en-deca de ROLLBACK_DEPTH_TICKS (8) : latence reseau realiste
      // (33-99 ms a 30 Hz), le cas que le rejeu doit absorber.
      const DELAY = 3;

      const result = runClientDeathScenario({
        mapSeed: 0xc1e2_0001,
        waveId: WAVE_ID,
        entities: ENTITIES,
        deaths: [{ tick: DEATH_TICK, ids: DEATH_IDS }],
        deathDelayTicks: DELAY,
        ticks: DEATH_TICK + DELAY + 100,
      });

      process.stdout.write(
        `[tache 10] mort dans l'anneau (delai ${DELAY}) : derive maximale ` +
          `${result.maxDrift.toFixed(3)} px, horde deplacee de ${result.travelled.toFixed(1)} px\n`,
      );

      // Preuve que le scenario mesure quelque chose de reel : la horde a
      // vraiment bouge, et la mort a vraiment eu lieu.
      expect(result.travelled).toBeGreaterThan(300);
      expect(result.reference.count).toBe(ENTITIES - DEATH_IDS.length);

      // Le signal "trop vieux" ne doit JAMAIS se declencher ici : un delai de
      // 3 ticks tient largement dans ROLLBACK_DEPTH_TICKS (8).
      expect(result.client.lateDeaths).toBe(0);
      expect(result.client.horde.count).toBe(result.reference.count);
      // Identites STRICTEMENT egales, pas seulement leur nombre.
      expect(aliveWaveIndices(result.client.horde)).toEqual(aliveWaveIndices(result.reference));

      // Le rejeu (restauration + primeFieldForReplay + rejeu du mouvement)
      // doit ramener la derive a un ordre de grandeur "bruit residuel", pas
      // "propagation de separation non corrigee" (des dizaines a des
      // centaines de px, voir le scenario 8 de `horde.replication.test.ts`).
      expect(result.maxDrift).toBeLessThan(10);
    },
  );

  it(
    'une mort livree au-dela de ROLLBACK_DEPTH_TICKS est appliquee au present, ' +
      'signalee par lateDeaths, et ne fait pas planter le client',
    () => {
      const WAVE_ID = 22;
      const ENTITIES = 300;
      const DEATH_TICK = 100; // 100 % 3 = 1, hors frontiere
      const DEATH_IDS = Array.from({ length: 20 }, (_, k) => entityIdOf(WAVE_ID, k));
      // Strictement au-dela de ROLLBACK_DEPTH_TICKS (8), avec marge : sinon
      // l'anneau absorbe tout et ce scenario ne prouve rien.
      const DELAY = ROLLBACK_DEPTH_TICKS + 4;

      const result = runClientDeathScenario({
        mapSeed: 0xc1e2_0002,
        waveId: WAVE_ID,
        entities: ENTITIES,
        deaths: [{ tick: DEATH_TICK, ids: DEATH_IDS }],
        deathDelayTicks: DELAY,
        ticks: DEATH_TICK + DELAY + 80,
      });

      process.stdout.write(
        `[tache 10] mort hors anneau (delai ${DELAY} > ROLLBACK_DEPTH_TICKS=${ROLLBACK_DEPTH_TICKS}) : ` +
          `derive residuelle ${result.maxDrift.toFixed(3)} px, lateDeaths=${result.client.lateDeaths}\n`,
      );

      expect(result.travelled).toBeGreaterThan(300);
      expect(result.reference.count).toBe(ENTITIES - DEATH_IDS.length);

      // Signalee : le compteur a bien vu passer les 20 morts trop vieilles
      // pour l'anneau.
      expect(result.client.lateDeaths).toBe(DEATH_IDS.length);
      // Appliquee quand meme, sans planter : le compte final converge malgre
      // l'absence de rejeu pour cette mort-la.
      expect(result.client.horde.count).toBe(result.reference.count);

      // La derive residuelle est mesuree, pas verrouillee finement : ce
      // chemin de secours n'a jamais pretendu preserver la precision du
      // rejeu, seulement eviter le silence et le crash.
      expect(Number.isFinite(result.maxDrift)).toBe(true);
    },
  );

  it(
    'deux lots de morts decides a des ticks differents mais livres au MEME tick local ' +
      'sont tous les deux appliques (la file se draine entierement, pas un lot par tick)',
    () => {
      // Les tests precedents ne mettent jamais plus d'un lot en attente : rien
      // n'y distingue `#drainPendingDeaths` qui vide la file de sa mutation
      // qui n'en traiterait qu'UN par tick. Un retard reseau variable peut
      // pourtant livrer au meme tick local des morts de deux ticks serveur.
      const WAVE_ID = 23;
      const ENTITIES = 300;
      // 151 et 154 : deux decisions serveur distinctes (151 % 3 = 1, 154 % 3 = 1),
      // avec des retards differents (5 et 2) choisis pour que les deux
      // livraisons tombent sur le MEME tick local (156).
      const BATCH_A = {
        tick: 151,
        ids: Array.from({ length: 15 }, (_, k) => entityIdOf(WAVE_ID, k)),
        delay: 5,
      };
      const BATCH_B = {
        tick: 154,
        ids: Array.from({ length: 15 }, (_, k) => entityIdOf(WAVE_ID, 100 + k)),
        delay: 2,
      };
      expect(BATCH_A.tick + BATCH_A.delay).toBe(BATCH_B.tick + BATCH_B.delay); // meme tick de livraison, par construction

      const result = runClientDeathScenario({
        mapSeed: 0xc1e2_0005,
        waveId: WAVE_ID,
        entities: ENTITIES,
        deaths: [BATCH_A, BATCH_B],
        deathDelayTicks: 5, // non utilise : chaque lot porte son propre `delay`
        ticks: 156 + 100,
      });

      process.stdout.write(
        `[tache 10] deux lots livres au meme tick : derive maximale ${result.maxDrift.toFixed(3)} px\n`,
      );

      expect(result.travelled).toBeGreaterThan(300);
      // Les DEUX lots doivent avoir disparu du compte final, pas seulement le
      // premier de la file.
      expect(result.reference.count).toBe(ENTITIES - BATCH_A.ids.length - BATCH_B.ids.length);
      expect(result.client.lateDeaths).toBe(0);
      expect(result.client.horde.count).toBe(result.reference.count);
      expect(aliveWaveIndices(result.client.horde)).toEqual(aliveWaveIndices(result.reference));
      expect(result.maxDrift).toBeLessThan(10);
    },
  );
});

/**
 * Toutes les morts ne laissent pas d'orbe.
 *
 * ⚠️ **La garde DOIT etre des deux cotes du fil.** Le client ne recoit jamais
 * « un orbe existe » : il le derive du seul `DEATHS`. Le predicat, lui, n'a pas
 * le droit d'exister en deux exemplaires — c'est `dropsOrb`, dans `shared/`.
 */
describe('DerivedOrbs.spawn — le client filtre les memes morts que le serveur', () => {
  it('ne retient que les morts que leavesDrop accepte, orbes ET pieces', () => {
    // ⚠️ **Assez de morts pour qu'une PIECE tombe** : `COIN_DROP_ONE_IN` vaut
    // quatre fois `ORB_DROP_ONE_IN`, donc un lot de 40 index consecutifs en
    // contient plusieurs de chaque ; un lot plus court ne montrerait que des
    // orbes.
    const MORTS = 64;
    const orbs = new DerivedOrbs(MORTS);
    const attendues: number[] = [];
    let pieces = 0;
    for (let i = 0; i < MORTS; i++) {
      const id = entityIdOf(9, i);
      orbs.spawn(id, 100 + i, 200, 0);
      if (leavesDrop(id)) {
        attendues.push(id);
      }
      if (dropsCoin(id)) {
        pieces++;
      }
    }

    expect(orbs.count).toBe(MORTS / ORB_DROP_ONE_IN + MORTS / COIN_DROP_ONE_IN);
    expect([...orbs.id.slice(0, orbs.count)]).toEqual(attendues);
    // Non-vacuite : le decor contient bien des pieces, et les deux natures sont
    // DISJOINTES — un cadavre laisse une orbe, une piece, ou rien.
    expect(pieces).toBe(MORTS / COIN_DROP_ONE_IN);
    expect(attendues.filter((id) => dropsOrb(id) && dropsCoin(id))).toHaveLength(0);
  });
});

/**
 * L'orbe ramassee vole jusqu'au joueur, meme s'il s'eloigne.
 *
 * ⚠️ **Le predicat est celui du serveur** : `OrbField.resolvePickups`
 * (`back/src/combat.ts`) arbitre au rayon PERSONNEL de chaque joueur ; la
 * capture cliente compare les MEMES positions repliquees, chacune au rayon DE
 * SON PROPRE joueur (`PickupTarget.pickupRadius`). **L'experience est deja
 * acquise quand le vol commence** : c'est ce qui autorise l'orbe a suivre un
 * joueur qui fuit. Pas de second rayon d'attraction : il finirait par
 * contredire le premier.
 */
describe('DerivedOrbs.capture — la capture EST le ramassage (tache 20)', () => {
  /** Un orbe unique. Le `count` verifie que le decor ne ment pas (`dropsOrb`). */
  function unOrbeEn(x: number, y: number, id = entityIdOf(9, 0)): DerivedOrbs {
    const orbs = new DerivedOrbs(8);
    orbs.spawn(id, x, y, 3);
    expect(orbs.count).toBe(1);
    return orbs;
  }

  /**
   * ⚠️ **Les deux bornes dans la MEME execution**, comme pour la peremption :
   * un seul cote de la fenetre ne prouve rien, et un rayon de capture qui
   * derive du rayon de ramassage rendrait le vol menteur — l'orbe partirait
   * vers un joueur que le serveur n'a pas encore laisse ramasser.
   */
  it('met en vol AU rayon de ramassage exact, et laisse au sol un pixel au-dela', () => {
    const dedans = unOrbeEn(1000, 1000);
    const volsDedans = new OrbFlights(8);
    dedans.capture(
      [{ id: 5, x: 1000 + ORB_PICKUP_RADIUS, y: 1000, pickupRadius: ORB_PICKUP_RADIUS }],
      volsDedans,
      1234,
    );

    expect(dedans.count).toBe(0);
    expect(volsDedans.count).toBe(1);

    const dehors = unOrbeEn(1000, 1000);
    const volsDehors = new OrbFlights(8);
    dehors.capture(
      [{ id: 5, x: 1000 + ORB_PICKUP_RADIUS + 1, y: 1000, pickupRadius: ORB_PICKUP_RADIUS }],
      volsDehors,
      1234,
    );

    expect(dehors.count).toBe(1);
    expect(volsDehors.count).toBe(0);
  });

  /**
   * Le vol part de la ou l'orbe attendait, vers CELUI qui l'a ramassee : sans
   * l'identite, il ne pourrait viser que l'endroit ou le joueur etait, et
   * n'aurait aucun moyen de le suivre s'il s'eloigne.
   */
  it('emporte le point de capture, l identite du ramasseur et l heure', () => {
    const orbs = unOrbeEn(1234, 5678);
    const vols = new OrbFlights(8);

    orbs.capture([{ id: 42, x: 1234, y: 5678, pickupRadius: ORB_PICKUP_RADIUS }], vols, 9_000.5);

    expect(vols.fromX[0]).toBe(1234);
    expect(vols.fromY[0]).toBe(5678);
    expect(vols.targetId[0]).toBe(42);
    expect(vols.bornMs[0]).toBe(9_000.5);
  });

  /**
   * ⚠️ **Une orbe ne se ramasse qu'UNE fois**, meme quand deux joueurs la
   * touchent dans la meme image : la boucle s'arrete au premier a portee,
   * exactement comme `OrbField.resolvePickups`. Sans cet arret, un tas d'orbes
   * au milieu d'un groupe lancerait autant de vols que de joueurs autour, tous
   * pour une seule experience.
   */
  it('ne lance qu un seul vol quand deux joueurs touchent la meme orbe', () => {
    const orbs = unOrbeEn(1000, 1000);
    const vols = new OrbFlights(8);

    orbs.capture(
      [
        { id: 5, x: 1000, y: 1000, pickupRadius: ORB_PICKUP_RADIUS },
        { id: 6, x: 1000, y: 1000, pickupRadius: ORB_PICKUP_RADIUS },
      ],
      vols,
      0,
    );

    expect(orbs.count).toBe(0);
    expect(vols.count).toBe(1);
    expect(vols.targetId[0]).toBe(5);
  });

  /**
   * ⚠️ **Le tas ramasse d'un coup.** La boucle compacte la reserve en
   * deplacant la derniere entree dans le trou : parcourue a l'endroit, elle
   * sauterait l'orbe qui vient d'y atterrir — meme piege que `Horde.kill` et
   * `OrbField.resolvePickups`, et une seule orbe de decor ne le montrerait
   * jamais.
   */
  it('n oublie aucune orbe d un tas ramasse dans la meme image', () => {
    const orbs = new DerivedOrbs(8);
    for (let i = 0; i < 4; i++) {
      orbs.spawn(entityIdOf(9, i * ORB_DROP_ONE_IN), 1000 + i, 1000, 3);
    }
    // Le quatrieme est hors de portee : il doit rester, seul, au sol.
    orbs.spawn(entityIdOf(9, 99 * ORB_DROP_ONE_IN), 1000 + 10 * ORB_PICKUP_RADIUS, 1000, 3);
    expect(orbs.count).toBe(5);
    const vols = new OrbFlights(8);

    orbs.capture([{ id: 1, x: 1000, y: 1000, pickupRadius: ORB_PICKUP_RADIUS }], vols, 0);

    expect(vols.count).toBe(4);
    expect(orbs.count).toBe(1);
    expect(orbs.x[0]).toBe(1000 + 10 * ORB_PICKUP_RADIUS);
  });

  /**
   * ⚠️ **L'INDEXATION, pas seulement le cablage** : CHAQUE joueur compare a
   * SON rayon. Seul un appel avec deux joueurs de rayons DIFFERENTS fait
   * echouer la mutation `r2[j]` -> `r2[0]`.
   *
   * Ici, B n'est PAS au premier indice : si la capture comparait tout le monde
   * au rayon du PREMIER joueur, l'orbe « dans la bande » ne serait jamais
   * prise, puisque A est loin de tout.
   *
   * ⚠️ **Et la seconde moitie** : une orbe au-dela du rayon ELARGI de B doit
   * rester au sol, sans quoi un rayon infini passerait aussi.
   */
  it('cible le joueur au rayon elargi meme hors du premier indice, et ne ment pas au-dela', () => {
    const BONUS = 50;
    const elargi = ORB_PICKUP_RADIUS + BONUS;
    const orbs = new DerivedOrbs(8);
    const dansLaBande = entityIdOf(9, 0);
    const horsPortee = entityIdOf(9, ORB_DROP_ONE_IN);
    // B est en (0, 0). dansLaBande est entre le rayon de base et le rayon
    // elargi de B ; horsPortee est juste au-dela du rayon elargi de B.
    orbs.spawn(dansLaBande, ORB_PICKUP_RADIUS + 20, 0, 3);
    orbs.spawn(horsPortee, 0, elargi + 1, 3);
    expect(orbs.count).toBe(2);

    const vols = new OrbFlights(8);
    orbs.capture(
      [
        // A : premier indice, loin de tout, au rayon de BASE.
        { id: 1, x: 10_000, y: 10_000, pickupRadius: ORB_PICKUP_RADIUS },
        // B : second indice, au rayon ELARGI.
        { id: 2, x: 0, y: 0, pickupRadius: elargi },
      ],
      vols,
      0,
    );

    // dansLaBande est prise, par B (le seul qui l'atteint) ; horsPortee reste.
    expect(orbs.count).toBe(1);
    expect(orbs.id[0]).toBe(horsPortee);
    expect(vols.count).toBe(1);
    expect(vols.targetId[0]).toBe(2);
  });

  /**
   * ⚠️ **Une seule echeance decrit l'arrivee ET la fin de vie** : la fraction
   * de `orbFlightFraction` vaut 1 a `ORB_FLIGHT_LIFETIME_MS`, et c'est la que
   * le vol s'eteint. Les deux bornes dans la meme execution, comme partout
   * ailleurs dans ce fichier.
   */
  it('eteint le vol pile a ORB_FLIGHT_LIFETIME_MS, pas avant', () => {
    const vols = new OrbFlights(8);
    vols.spawn(1000, 1000, 5, 4, 1000);

    vols.expire(1000 + ORB_FLIGHT_LIFETIME_MS - 1);
    expect(vols.count).toBe(1);

    vols.expire(1000 + ORB_FLIGHT_LIFETIME_MS);
    expect(vols.count).toBe(0);
  });
});

describe('GameClient — orbes derivees des morts (tache 10)', () => {
  /**
   * ⚠️ **Le meme filtre, atteint par le VRAI chemin** : un lot `DEATHS` d'une
   * vague entiere, index consecutifs. Sans ce test, la garde de
   * `DerivedOrbs.spawn` pourrait etre retiree sans qu'une assertion bouge.
   */
  it('un lot de morts a index consecutifs ne laisse que ce que leavesDrop accepte', () => {
    const WAVE_ID = 31;
    const ENTITIES = 40;

    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0xc1e2_0004) });
    socket.emit('message', {
      data: encodeWaveOrder({
        waveId: WAVE_ID,
        spawnTick: 0,
        seed: 0x51ee_d002,
        archetype: 0,
        formation: FORMATION.CLUSTER,
        anchorX: 1200,
        anchorY: 1200,
        count: ENTITIES,
      }),
    });

    const killedIds = Array.from({ length: ENTITIES }, (_, i) => entityIdOf(WAVE_ID, i));
    const DEATH_TICK = 10;
    for (let tick = 0; tick <= DEATH_TICK + 3; tick++) {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [
          {
            id: 1,
            x: 3000,
            y: 3000,
            hp: 100,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });
      if (tick === DEATH_TICK + 2) {
        socket.emit('message', { data: encodeDeaths(DEATH_TICK, killedIds) });
      }
      client.update(tick * STEP, STEP);
    }

    // ⚠️ **Attendu DERIVE des identites reellement tuees, jamais d'une division
    // sur `ENTITIES`.** Le premier index de la vague n'est pas force d'etre un
    // multiple des deux taux, donc « 40 / 16 » rendrait 2,5 la ou la regle en
    // pose 3. Un attendu calcule de tete est un decor qui ment.
    const attendues = killedIds.filter((id) => leavesDrop(id));
    const piecesAttendues = killedIds.filter((id) => dropsCoin(id));
    expect(client.orbs.count).toBe(attendues.length);
    const poses = [...client.orbs.id.slice(0, client.orbs.count)];
    expect(poses.every((id) => leavesDrop(id))).toBe(true);
    // Les pieces par le VRAI chemin : le lot en contient, derivees du
    // seul `DEATHS` comme les orbes — pas un octet de plus sur le fil.
    expect(poses.filter((id) => dropsCoin(id))).toHaveLength(piecesAttendues.length);
    // Non-vacuite des deux cotes : il y a des pieces, et il n'y a pas QUE ca.
    expect(piecesAttendues.length).toBeGreaterThan(0);
    expect(attendues.length).toBeGreaterThan(piecesAttendues.length);
  });

  it('une mort fait apparaitre un orbe a la position de l entite, et PICKUPS le retire', () => {
    const WAVE_ID = 30;
    const ENTITIES = 10;

    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();

    const mapSeed = 0xc1e2_0003;
    socket.emit('message', { data: encodeWelcome(1, 0, mapSeed) });
    const order: WaveOrder = {
      waveId: WAVE_ID,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 1200,
      anchorY: 1200,
      count: ENTITIES,
    };
    socket.emit('message', { data: encodeWaveOrder(order) });

    // ⚠️ **Des index ESPACES de `ORB_DROP_ONE_IN`, pas 0 et 1** : toutes les
    // morts ne laissent pas d'orbe (`dropsOrb`), et ce test parle du chemin
    // `DEATHS` -> orbe -> `PICKUPS`, pas du taux de chute.
    const killedIds = [entityIdOf(WAVE_ID, 0), entityIdOf(WAVE_ID, ORB_DROP_ONE_IN)];
    const DEATH_TICK = 10;
    const DELAY = 2;

    for (let tick = 0; tick < DEATH_TICK + DELAY + 5; tick++) {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [
          {
            id: 1,
            x: 3000,
            y: 3000,
            hp: 100,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });
      if (tick === DEATH_TICK + DELAY) {
        socket.emit('message', { data: encodeDeaths(DEATH_TICK, killedIds) });
      }
      client.update(tick * STEP, STEP);
    }

    expect(client.orbs.count).toBe(2);
    const seenIds = new Set([client.orbs.id[0], client.orbs.id[1]]);
    expect(seenIds).toEqual(new Set(killedIds));
    // La position doit venir de l'entite, pas d'un placeholder fixe : elle
    // reste dans les bornes de la carte et n'est pas figee a l'origine.
    expect(client.orbs.x[0]).toBeGreaterThan(0);
    expect(client.orbs.x[0]).toBeLessThan(MAP_SIZE);

    socket.emit('message', { data: encodePickups(DEATH_TICK + DELAY + 1, [killedIds[0] ?? 0]) });
    client.update((DEATH_TICK + DELAY + 5) * STEP, STEP);

    expect(client.orbs.count).toBe(1);
    expect(client.orbs.id[0]).toBe(killedIds[1]);
  });

  /**
   * ⚠️ **Le chemin complet de la capture, par le VRAI chemin.** Les tests
   * unitaires de `DerivedOrbs.capture` ne prouvent rien tant que
   * `GameClient.update` ne l'appelle pas. Ici la capture est declenchee par un
   * coequipier qui vient se poser sur l'orbe, aux positions DESSINEES.
   *
   * ⚠️ **Un COEQUIPIER, pas le joueur local** : sa position dessinee est
   * exactement celle du snapshot (interpolation), la ou celle du joueur local
   * est predite puis reconciliee — un decor qui ne saurait pas dire ou est le
   * joueur ne saurait pas dire a quel rayon il capture.
   */
  it('un coequipier qui marche sur une orbe la met en vol, et PICKUPS n a plus rien a retirer', () => {
    const WAVE_ID = 32;
    const ENTITIES = 10;
    const MS_PER_TICK = 1000 / TICK_HZ;

    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();

    socket.emit('message', { data: encodeWelcome(1, 0, 0xc1e2_0009) });
    socket.emit('message', {
      data: encodeWaveOrder({
        waveId: WAVE_ID,
        spawnTick: 0,
        seed: 0x51ee_d001,
        archetype: 0,
        formation: FORMATION.CLUSTER,
        anchorX: 1200,
        anchorY: 1200,
        count: ENTITIES,
      }),
    });

    const killedId = entityIdOf(WAVE_ID, 0);
    const DEATH_TICK = 10;
    const MOI = {
      id: 1,
      x: 3000,
      y: 3000,
      hp: 100,
      aimX: 0,
      aimY: 0,
      pickupRadius: ORB_PICKUP_RADIUS,
      shield: 0,
    };
    let tick = 0;

    /** Une image : un snapshot, l'horloge murale qui va avec, et le tick qui avance. */
    const image = (allie: { id: number; x: number; y: number }): number => {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [
          MOI,
          { ...allie, hp: 100, aimX: 0, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS, shield: 0 },
        ]),
      });
      if (tick === DEATH_TICK + 2) {
        socket.emit('message', { data: encodeDeaths(DEATH_TICK, [killedId]) });
      }
      const nowMs = tick * MS_PER_TICK;
      client.update(nowMs, STEP);
      tick++;
      return nowMs;
    };

    // L'allie reste d'abord LOIN de la vague : l'orbe tombe et personne ne la
    // prend.
    for (let i = 0; i < DEATH_TICK + 4; i++) {
      image({ id: 2, x: 3000, y: 3000 });
    }
    expect(client.orbs.count).toBe(1);
    expect(client.orbFlights.count).toBe(0);
    const ox = client.orbs.x[0] ?? 0;
    const oy = client.orbs.y[0] ?? 0;

    // Puis il vient se poser JUSTE dans le rayon de ramassage : ce que le
    // serveur arbitre au meme instant, sur les memes positions.
    //
    // ⚠️ **Un pixel en deça, pas le rayon pile** : `SNAPSHOT` transporte des
    // positions ENTIERES, donc une position de joueur posee a `ox + 90` arrive
    // arrondie et retombe a 90,47 px de l'orbe — dehors. La borne exacte se
    // verifie sur `DerivedOrbs.capture`, ou aucun encodage ne s'interpose ;
    // ici, ce qui compte est que le chemin complet passe.
    let captureMs = -1;
    for (let i = 0; i < 16 && captureMs < 0; i++) {
      const nowMs = image({ id: 2, x: Math.round(ox) + ORB_PICKUP_RADIUS - 1, y: oy });
      if (client.orbFlights.count > 0) {
        captureMs = nowMs;
      }
    }

    expect(captureMs).toBeGreaterThanOrEqual(0);
    expect(client.orbs.count).toBe(0);
    expect(client.orbFlights.count).toBe(1);
    expect(client.orbFlights.fromX[0]).toBe(ox);
    expect(client.orbFlights.fromY[0]).toBe(oy);
    expect(client.orbFlights.targetId[0]).toBe(2);

    // `PICKUPS` arrive un aller-retour plus tard : l'orbe a deja quitte la
    // reserve, il n'y a plus rien a retirer — et le vol, lui, continue.
    socket.emit('message', { data: encodePickups(tick, [killedId]) });
    client.update(captureMs + 1, STEP);
    expect(client.orbs.count).toBe(0);
    expect(client.orbFlights.count).toBe(1);

    // Le vol s'eteint a son echeance, pas avant : les deux bornes.
    client.update(captureMs + ORB_FLIGHT_LIFETIME_MS - 1, STEP);
    expect(client.orbFlights.count).toBe(1);
    client.update(captureMs + ORB_FLIGHT_LIFETIME_MS, STEP);
    expect(client.orbFlights.count).toBe(0);
  });

  it(
    'un orbe non ramasse ne disparait JAMAIS : il attend le ramassage, ' +
      'des milliers de ticks apres la mort (etape 6a, tache 15)',
    () => {
      // ⚠️ **Le pendant exact du test serveur.** L'existence d'un orbe ne
      // transite jamais : ce cote-ci la DERIVE de `DEATHS`, l'autre arbitre le
      // ramassage. Une peremption retiree d'un seul cote ferait disparaitre
      // ici un orbe que le serveur ramasse encore.
      //
      // ⚠️ **La propriete gardee est une ABSENCE d'echeance** : le seul nombre
      // est la duree qu'on accepte d'attendre, assez longue pour qu'un simple
      // rallongement de la vie des orbes ne passe pas pour une suppression.
      const TRES_LONGTEMPS = 3000;
      const WAVE_ID = 60;
      const ENTITIES = 5;

      const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
      client.connect();
      const socket = latestSocket();

      const mapSeed = 0xc1e2_0007;
      socket.emit('message', { data: encodeWelcome(1, 0, mapSeed) });
      const order: WaveOrder = {
        waveId: WAVE_ID,
        spawnTick: 0,
        seed: 0x51ee_d001,
        archetype: 0,
        formation: FORMATION.CLUSTER,
        anchorX: 1200,
        anchorY: 1200,
        count: ENTITIES,
      };
      socket.emit('message', { data: encodeWaveOrder(order) });

      const killedId = entityIdOf(WAVE_ID, 0);
      const DEATH_TICK = 10;
      const DELAY = 2;
      // Le joueur reste a 3000 px de la horde : jamais a `ORB_PICKUP_RADIUS`,
      // donc rien ne peut retirer l'orbe par le seul chemin qui subsiste.
      let vuApresLaMort = false;

      for (let tick = 0; tick < DEATH_TICK + TRES_LONGTEMPS; tick++) {
        socket.emit('message', {
          data: encodeSnapshot(tick, 0, 0, [
            {
              id: 1,
              x: 3000,
              y: 3000,
              hp: 100,
              aimX: 0,
              aimY: 0,
              pickupRadius: ORB_PICKUP_RADIUS,
              shield: 0,
            },
          ]),
        });
        if (tick === DEATH_TICK + DELAY) {
          socket.emit('message', { data: encodeDeaths(DEATH_TICK, [killedId]) });
        }
        client.update(tick * STEP, STEP);

        if (tick === DEATH_TICK + DELAY) {
          // Non-vacuite : l'orbe a bien ete pose. Sans cette borne basse, un
          // orbe jamais ne passerait le test final sans rougir.
          expect(client.orbs.count).toBe(1);
          vuApresLaMort = true;
        }
      }

      expect(vuApresLaMort).toBe(true);
      expect(client.orbs.count).toBe(1);
    },
  );
});

describe('GameClient — le gel est date, pas applique a la reception (tache 10)', () => {
  it('la horde continue de bouger apres reception de LEVEL_UP, gele exactement au tick indique, puis reprend', () => {
    const WAVE_ID = 40;
    const ENTITIES = 40;

    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();

    const mapSeed = 0xc1e2_0004;
    socket.emit('message', { data: encodeWelcome(1, 0, mapSeed) });
    const order: WaveOrder = {
      waveId: WAVE_ID,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      // Loin de l'endroit ou les joueurs stationnent : assez de distance a
      // parcourir pour que le mouvement reste mesurable sur toute la duree du
      // test, gel et reprise compris. ⚠️ SUR l'ile : (500, 500) est de l'eau,
      // et la vague y naitrait collee au rivage.
      anchorX: 1500,
      anchorY: 1500,
      count: ENTITIES,
    };
    socket.emit('message', { data: encodeWaveOrder(order) });

    // Le gel prend effet a FREEZE_START, pas a la reception du message plus
    // bas (envoye bien avant).
    const FREEZE_START = 200;
    const FREEZE_END = FREEZE_START + GEL_TICKS - 1;
    const RESUME_END = FREEZE_END + LEVEL_RESUME_TICKS;
    const END = RESUME_END + 60;

    const trackedId = entityIdOf(WAVE_ID, 0);

    let beforeFreezeTravel = 0;
    let duringFreezeTravel = 0;
    let afterResumeTravel = 0;
    let prevX = 0;
    let prevY = 0;
    let hasPrev = false;

    for (let tick = 0; tick < END; tick++) {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [
          {
            id: 1,
            x: 3000,
            y: 3000,
            hp: 100,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });
      // Envoye bien avant que le gel ne prenne effet : si le client gelait a
      // la reception, tout mouvement s'arreterait des ce tick au lieu de
      // FREEZE_START.
      if (tick === 20) {
        socket.emit('message', { data: encodeLevelUp(FREEZE_START, 2) });
      }
      // ⚠️ C'est le SERVEUR qui annonce la fin du gel : sans ce message, le
      // client resterait gele pour toujours, et c'est voulu.
      if (tick === FREEZE_END) {
        socket.emit('message', { data: encodeDraftResult(FREEZE_END, []) });
      }

      client.update(tick * STEP, STEP);

      const slot = client.horde.slotOf(trackedId);
      if (slot >= 0) {
        const x = client.horde.x[slot] ?? 0;
        const y = client.horde.y[slot] ?? 0;
        if (hasPrev) {
          const d = Math.hypot(x - prevX, y - prevY);
          if (tick < FREEZE_START) {
            beforeFreezeTravel += d;
          } else if (tick <= FREEZE_END) {
            duringFreezeTravel += d;
          } else if (tick > RESUME_END) {
            afterResumeTravel += d;
          }
        }
        prevX = x;
        prevY = y;
        hasPrev = true;
      }
    }

    process.stdout.write(
      `[tache 10] gel : avant=${beforeFreezeTravel.toFixed(1)}px, ` +
        `pendant=${duringFreezeTravel.toFixed(3)}px, apres=${afterResumeTravel.toFixed(1)}px\n`,
    );

    // Le message est arrive au tick 20, bien avant FREEZE_START (200) : si le
    // gel s'appliquait a la reception, ce parcours serait nul.
    expect(beforeFreezeTravel).toBeGreaterThan(50);
    // Fige EXACTEMENT au tick indique : aucun deplacement mesurable pendant
    // la fenetre de gel strict.
    expect(duringFreezeTravel).toBe(0);
    // Le monde reprend : ce n'est pas un gel permanent.
    expect(afterResumeTravel).toBeGreaterThan(50);
  });
});

describe('GameClient — la prediction locale honore le gel de niveau (tache 24)', () => {
  it(
    'une entree de deplacement envoyee pendant le gel ne deplace pas le joueur predit ; ' +
      'la meme entree, envoyee apres la reprise, le deplace',
    () => {
      // Entree CONSTANTE tout du long : c'est la meme commande qui doit rester
      // sans effet pendant le gel, puis reprendre effet apres — pas une entree
      // differente selon la phase.
      const client = new GameClient('ws://test', () => ({ x: 1, y: 0 }), vi.fn());
      client.connect();
      const socket = latestSocket();

      socket.emit('message', { data: encodeWelcome(1, 0, 0xc0ff_ee01) });
      // Fait apparaitre le joueur local : seul ce premier snapshot compte,
      // aucun autre n'est envoye ensuite — sans quoi `reconcile` ecraserait la
      // prediction a chaque tick et rendrait tout mouvement invisible,
      // gel ou pas (voir `PredictedPlayer.reconcile`).
      socket.emit('message', {
        data: encodeSnapshot(0, 0, 0, [
          {
            id: 1,
            x: 500,
            y: 500,
            hp: 100,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });

      const FREEZE_START = 10;
      const FREEZE_END = FREEZE_START + GEL_TICKS - 1;
      const RESUME_END = FREEZE_END + LEVEL_RESUME_TICKS;
      const END = RESUME_END + 30;
      socket.emit('message', { data: encodeLevelUp(FREEZE_START, 2) });

      let duringFreezeTravel = 0;
      let afterResumeTravel = 0;
      let prevX: number | null = null;

      for (let tick = 0; tick < END; tick++) {
        if (tick === FREEZE_END) {
          socket.emit('message', { data: encodeDraftResult(FREEZE_END, []) });
        }
        const state = client.update(tick * STEP, STEP);
        const me = state.players.find((p) => p.id === 1);
        const x = me?.x ?? 0;
        if (prevX !== null) {
          const d = Math.abs(x - prevX);
          if (tick >= FREEZE_START && tick <= FREEZE_END) {
            duringFreezeTravel += d;
          } else if (tick > RESUME_END) {
            afterResumeTravel += d;
          }
        }
        prevX = x;
      }

      process.stdout.write(
        `[tache 24] joueur predit : pendant=${duringFreezeTravel.toFixed(3)}px, ` +
          `apres=${afterResumeTravel.toFixed(1)}px\n`,
      );

      // Fige pendant le gel strict : sinon le joueur avance en prediction
      // pendant que la horde s'arrete, et se fait remettre en place au
      // prochain snapshot (effet elastique).
      expect(duringFreezeTravel).toBe(0);
      // Un gel permanent laisserait aussi `duringFreezeTravel` a zero : cette
      // seconde moitie est ce qui l'exclut.
      expect(afterResumeTravel).toBeGreaterThan(50);
    },
  );
});

describe('GameClient — isFrozen, pour l indication HUD du gel (tache 24)', () => {
  it('vaut faux avant le gel, vrai pendant le gel et sa rampe de reprise, puis de nouveau faux', () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0xc0ff_ee02) });

    expect(client.isFrozen).toBe(false);

    const FREEZE_START = 10;
    const FREEZE_END = FREEZE_START + GEL_TICKS - 1;
    const RESUME_END = FREEZE_END + LEVEL_RESUME_TICKS;
    socket.emit('message', { data: encodeLevelUp(FREEZE_START, 2) });

    // Bien avant FREEZE_START : encore faux, marge de securite loin de la
    // frontiere pour ne pas dependre d'un decalage d'un tick pres.
    for (let tick = 0; tick < FREEZE_START - 5; tick++) {
      client.update(tick * STEP, STEP);
    }
    expect(client.isFrozen).toBe(false);

    // Au milieu du gel strict, puis au milieu de la rampe de reprise : vrai
    // dans les deux cas, c'est toute la perturbation qui doit se voir.
    for (let tick = FREEZE_START - 5; tick < FREEZE_START + 5; tick++) {
      client.update(tick * STEP, STEP);
    }
    expect(client.isFrozen).toBe(true);

    for (let tick = FREEZE_START + 5; tick < FREEZE_END; tick++) {
      client.update(tick * STEP, STEP);
    }
    expect(client.isFrozen).toBe(true);

    // Le serveur annonce la fin : c'est la SEULE facon pour le client de
    // l'apprendre.
    socket.emit('message', { data: encodeDraftResult(FREEZE_END, []) });
    for (let tick = FREEZE_END; tick < RESUME_END - 5; tick++) {
      client.update(tick * STEP, STEP);
    }
    // Toujours vrai pendant la rampe de reprise : c'est toute la perturbation
    // qui doit se voir, pas seulement sa moitie la plus visible.
    expect(client.isFrozen).toBe(true);

    for (let tick = RESUME_END - 5; tick < RESUME_END + 10; tick++) {
      client.update(tick * STEP, STEP);
    }
    expect(client.isFrozen).toBe(false);
  });
});

describe('GameClient — niveau de l equipe (tache 11)', () => {
  it('demarre a 1, et LEVEL_UP le met a jour des la reception (pas au tick date, contrairement au gel)', () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0) });

    expect(client.level).toBe(1);

    // Le tick (5000) est loin dans le futur : seul le GEL doit attendre ce
    // tick, le niveau affiche au HUD, lui, n'a aucune raison d'attendre.
    socket.emit('message', { data: encodeLevelUp(5000, 3) });

    expect(client.level).toBe(3);
  });
});

describe('GameClient — bilan de run (RUN_OVER, tache 11)', () => {
  it('declenche onRunOver avec les trois chiffres exacts du message, une seule fois, sans les permuter', () => {
    const onRunOver = vi.fn();
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn(), onRunOver);
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0) });

    socket.emit('message', { data: encodeRunOver(500, 480, 7, 213) });

    expect(onRunOver).toHaveBeenCalledTimes(1);
    expect(onRunOver).toHaveBeenCalledWith({ survivedTicks: 480, level: 7, kills: 213 });
  });

  it("n'appelle pas onRunOver tant que RUN_OVER n'est pas arrive", () => {
    const onRunOver = vi.fn();
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn(), onRunOver);
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0) });
    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, [
        {
          id: 1,
          x: 0,
          y: 0,
          hp: 100,
          aimX: 0,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 0,
        },
      ]),
    });
    client.update(0, 0);

    expect(onRunOver).not.toHaveBeenCalled();
  });
});

/**
 * Tir automatique cote client — miroir cosmetique de
 * `Room#fireWeapons`/`resolveProjectileDamage` : jamais d'arbitrage de
 * degats ici, seulement de quoi dessiner une salve et un flash d'impact.
 *
 * ⚠️ La visee vient de `readAim`, sans ciblage automatique : chaque test doit
 * fournir une direction, pas seulement une position de joueur a portee.
 */
describe('GameClient — tir automatique et impact cote client (tache 11/13)', () => {
  const MS_PER_TICK = 1000 / TICK_HZ;
  /** Le monstre est toujours pose a droite du joueur dans ces tests : viser a droite l'engage. */
  const AIM_RIGHT: InputAxes = { x: 1, y: 0 };

  /**
   * Fait apparaitre un unique monstre puis lit sa position REELLE apres coup,
   * plutot que de supposer qu'elle tombe pres de l'ancre : `formationPositions`
   * (`shared/waves.ts`) disperse meme `FORMATION.CLUSTER` sur plusieurs
   * centaines de pixels (`CLUSTER_SPREAD = 800`), donc deviner un ecart fixe
   * a l'ancre est fragile — lire la position posee, deterministe pour une
   * graine donnee, ne l'est pas.
   *
   * `readAim` par defaut vise a droite (`AIM_RIGHT`) : tous les appelants
   * placent leur joueur a gauche du monstre. Le test de visee nulle le
   * redefinit explicitement.
   */
  function setupWithOneMonster(
    mapSeed: number,
    waveId: number,
    readAim: () => InputAxes = () => AIM_RIGHT,
  ): { client: GameClient; socket: FakeSocket; monsterX: number; monsterY: number } {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn(), undefined, readAim);
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, mapSeed) });
    const order: WaveOrder = {
      waveId,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 3000,
      anchorY: 3000,
      count: 1,
    };
    socket.emit('message', { data: encodeWaveOrder(order) });

    // Tick d'amorce : fait naitre le monstre (les ordres en attente
    // s'appliquent en tete d'`#advanceHorde`) SANS pretendre a une position de
    // joueur pertinente — aucune assertion sur le tir ne porte sur ce tick.
    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, [
        {
          id: 1,
          x: 0,
          y: 0,
          hp: 100,
          aimX: 0,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 0,
        },
      ]),
    });
    client.update(0, STEP);
    if (client.horde.count !== 1) {
      throw new Error(`amorce du test : horde.count=${client.horde.count}, attendu 1`);
    }

    return {
      client,
      socket,
      monsterX: client.horde.x[0] ?? 0,
      monsterY: client.horde.y[0] ?? 0,
    };
  }

  it(
    'vise le monstre en direction duquel pointe readAim, et le projectile finit par le toucher ' +
      '(un flash d impact apparait)',
    () => {
      const { client, socket, monsterX, monsterY } = setupWithOneMonster(0xc1e2_0010, 70);
      // Distance CALCULEE, pas une constante en dur : elle doit laisser au
      // moins un tick de vol au projectile, quelle que soit la vitesse de
      // l'arme. Trop courte, l'impact tomberait au tick du tir et
      // `firedAtTick` resterait a -1. Le monstre fonce droit sur le joueur,
      // sur la ligne visee par la salve (AIM_RIGHT).
      const weapon = weaponOf(0);
      const perTickTravel = weapon.projectileSpeed / TICK_HZ;
      const offset = Math.round(perTickTravel * 3 + PROJECTILE_HIT_RADIUS);
      const PLAYER = { x: monsterX - offset, y: monsterY };

      let firedAtTick = -1;
      for (let tick = 1; tick <= 40; tick++) {
        socket.emit('message', {
          data: encodeSnapshot(tick, 0, 0, [
            {
              id: 1,
              ...PLAYER,
              hp: 100,
              aimX: 0,
              aimY: 0,
              pickupRadius: ORB_PICKUP_RADIUS,
              shield: 0,
            },
          ]),
        });
        client.update(tick * MS_PER_TICK, STEP);
        if (firedAtTick < 0 && client.projectiles.count > 0) {
          firedAtTick = tick;
        }
        if (client.hitFlashes.count > 0) {
          break;
        }
      }

      expect(firedAtTick).toBeGreaterThanOrEqual(0);
      expect(client.hitFlashes.count).toBeGreaterThan(0);
    },
  );

  it('ne tire pas quand la visee est nulle, meme avec un monstre tout pres (tache 13)', () => {
    // ⚠️ Curseur pile sur le joueur, ou souris jamais bougee : `(0, 0)` ne tire
    // pas, deterministe des deux cotes. La proximite du monstre n'entre pas en
    // jeu : seul `readAim` gate ici.
    const { client, socket, monsterX, monsterY } = setupWithOneMonster(0xc1e2_0014, 74, () => ({
      x: 0,
      y: 0,
    }));
    const PLAYER = { x: monsterX - 50, y: monsterY };
    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');

    for (let tick = 1; tick <= 20; tick++) {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [
          {
            id: 1,
            ...PLAYER,
            hp: 100,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });
      client.update(tick * MS_PER_TICK, STEP);
    }

    expect(spy).not.toHaveBeenCalled();
  });

  it('ne tire pas pour un joueur a 0 pv, meme avec une visee non nulle', () => {
    const { client, socket, monsterX, monsterY } = setupWithOneMonster(0xc1e2_0012, 72);
    const PLAYER = { x: monsterX - 50, y: monsterY };
    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');

    for (let tick = 1; tick <= 20; tick++) {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [
          { id: 1, ...PLAYER, hp: 0, aimX: 0, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS, shield: 0 },
        ]),
      });
      client.update(tick * MS_PER_TICK, STEP);
    }

    expect(spy).not.toHaveBeenCalled();
  });

  it('respecte le cooldown de l arme : jamais plus d une salve toutes les cooldownTicks images', () => {
    const { client, socket, monsterX, monsterY } = setupWithOneMonster(0xc1e2_0011, 71);
    // 300 px : loin du monstre, mais assez proche pour laisser le temps
    // d'observer plusieurs fenetres de cooldown avant que la premiere salve
    // ne touche.
    const PLAYER = { x: monsterX - 300, y: monsterY };
    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');

    const TICKS = 90;
    for (let tick = 1; tick <= TICKS; tick++) {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [
          {
            id: 1,
            ...PLAYER,
            hp: 100,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });
      client.update(tick * MS_PER_TICK, STEP);
    }

    const cooldown = weaponOf(0).cooldownTicks;
    const maxPossibleShots = Math.floor(TICKS / cooldown) + 1;
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(maxPossibleShots);
  });

  it('un flash d impact expire apres HIT_FLASH_LIFETIME_MS, jamais avant (verifie aux deux bornes)', () => {
    const { client, socket, monsterX, monsterY } = setupWithOneMonster(0xc1e2_0013, 73);
    // Tres proche : collision quasi immediate, avant que le cooldown de
    // l'arme ne permette une seconde salve.
    const PLAYER = { x: monsterX - 20, y: monsterY };

    let hitNowMs = -1;
    for (let tick = 1; tick <= 20 && hitNowMs < 0; tick++) {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [
          {
            id: 1,
            ...PLAYER,
            hp: 100,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });
      const nowMs = tick * MS_PER_TICK;
      client.update(nowMs, STEP);
      if (client.hitFlashes.count > 0) {
        hitNowMs = nowMs;
      }
    }

    expect(hitNowMs).toBeGreaterThanOrEqual(0);
    expect(client.hitFlashes.count).toBe(1);

    // Encore la juste avant l'echeance.
    client.update(hitNowMs + HIT_FLASH_LIFETIME_MS - 1, STEP);
    expect(client.hitFlashes.count).toBe(1);

    // Disparu pile a l'echeance, pas un tick plus tard.
    client.update(hitNowMs + HIT_FLASH_LIFETIME_MS, STEP);
    expect(client.hitFlashes.count).toBe(0);
  });
});

/**
 * La chaine de Foudre est un FLASH, seme UNE FOIS a l'impact predit par ce
 * client (`GameClient#seedChainFlash`), jamais rederive de la horde a chaque
 * image.
 *
 * Une arme SYNTHETIQUE, tiree directement sur `client.projectiles`, en
 * court-circuitant `#fireWeapons` et le loadout, comme `back/src/combat.test.ts`.
 * `readAim` reste nul dans ce bloc : seul le projectile de Foudre tire a la
 * main doit voler.
 */
describe('GameClient — le flash de chaine de Foudre, seme une fois a l impact (etape 5b, tache 3, tour de correction 1)', () => {
  const MS_PER_TICK = 1000 / TICK_HZ;
  const FOUDRE_WEAPON: Weapon = { ...weaponOf(BASE_WEAPON_ID), element: ELEMENT.FOUDRE };

  /**
   * Fait apparaitre DEUX monstres a des positions CONTROLEES, pas celles de
   * la dispersion : le percute (futur point d'impact) et un voisin a portee
   * de `CHAIN_RADIUS` — meme technique que `addOne` cote serveur
   * (`back/src/combat.test.ts`), positions ecrites directement dans les
   * tableaux publics de `Horde` apres l'apparition.
   */
  function setupPercuteEtVoisin(
    mapSeed: number,
    waveId: number,
  ): { client: GameClient; socket: FakeSocket; percuteId: number; voisinId: number } {
    const client = new GameClient(
      'ws://test',
      () => ({ x: 0, y: 0 }),
      vi.fn(),
      undefined,
      () => ({
        x: 0,
        y: 0,
      }),
    );
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, mapSeed) });
    socket.emit('message', {
      data: encodeWaveOrder({
        waveId,
        spawnTick: 0,
        seed: 0x51ee_d002,
        archetype: 0,
        formation: FORMATION.SCATTER,
        anchorX: 3000,
        anchorY: 3000,
        count: 2,
      }),
    });
    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, [
        {
          id: 1,
          x: 0,
          y: 0,
          hp: 100,
          aimX: 0,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 0,
        },
      ]),
    });
    client.update(0, STEP);
    if (client.horde.count !== 2) {
      throw new Error(`amorce du test : horde.count=${client.horde.count}, attendu 2`);
    }
    // Le percute a 300 px du joueur : sous la portee de l'arme synthetique,
    // pour que le projectile le touche avant d'expirer. 100 px separent le
    // percute du voisin : dans `CHAIN_RADIUS`.
    expect(100).toBeLessThan(CHAIN_RADIUS);
    client.horde.x[0] = 300;
    client.horde.y[0] = 0;
    client.horde.x[1] = 300;
    client.horde.y[1] = 100;
    return {
      client,
      socket,
      percuteId: client.horde.entityIdAt(0),
      voisinId: client.horde.entityIdAt(1),
    };
  }

  /**
   * Tire `arme` (synthetique) directement sur `client.projectiles`, vers
   * `cibleId`, et avance jusqu'a l'impact (ou l'expiration du projectile).
   * Rend l'horloge murale (`nowMs`) de ce dernier pas.
   */
  function frappe(
    client: GameClient,
    socket: FakeSocket,
    cibleId: number,
    arme: Weapon,
    startTick: number,
  ): number {
    const s = client.horde.slotOf(cibleId);
    const dx = client.horde.x[s] ?? 0;
    const dy = client.horde.y[s] ?? 0;
    client.projectiles.fireSalvoDirected(arme, startTick, 0, 0, dx, dy, arme.damage, 1, 7);
    expect(client.projectiles.count).toBeGreaterThan(0); // sanity : le tir est bien parti

    let nowMs = -1;
    for (let tick = startTick; tick < startTick + 20 && client.projectiles.count > 0; tick++) {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [
          {
            id: 1,
            x: 0,
            y: 0,
            hp: 100,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });
      nowMs = tick * MS_PER_TICK;
      client.update(nowMs, STEP);
    }
    if (nowMs < 0 || client.projectiles.count > 0) {
      throw new Error('le projectile ne touche jamais');
    }
    return nowMs;
  }

  it('un impact de Foudre seme un flash de chaine, avec le point d impact PUIS le voisin', () => {
    const { client, socket, percuteId, voisinId } = setupPercuteEtVoisin(0xc1e2_00f0, 80);

    const impactNowMs = frappe(client, socket, percuteId, FOUDRE_WEAPON, 1);

    expect(client.chainFlashes.count).toBe(1);
    expect(client.chainFlashes.pointCount[0]).toBe(2);
    expect(client.chainFlashes.bornMs[0]).toBe(impactNowMs);
    // Le premier point est le PERCUTE (le point d'impact), pas le voisin.
    const percuteSlot = client.horde.slotOf(percuteId);
    const voisinSlot = client.horde.slotOf(voisinId);
    expect(client.chainFlashes.pointX(0, 0)).toBeCloseTo(client.horde.x[percuteSlot] ?? 0, 0);
    expect(client.chainFlashes.pointY(0, 0)).toBeCloseTo(client.horde.y[percuteSlot] ?? 0, 0);
    expect(client.chainFlashes.pointX(0, 1)).toBeCloseTo(client.horde.x[voisinSlot] ?? 0, 0);
    expect(client.chainFlashes.pointY(0, 1)).toBeCloseTo(client.horde.y[voisinSlot] ?? 0, 0);
  });

  /**
   * ⚠️ Une chaine semee, puis la horde deplacee, puis une image de plus : la
   * polyligne DEJA DESSINEE ne doit pas bouger d'un pixel. C'est la mutation
   * « rederiver a chaque image » qui doit rougir ici.
   */
  it('le chemin est FIGE a la naissance : deplacer la horde ensuite ne change rien au flash deja seme', () => {
    const { client, socket, percuteId, voisinId } = setupPercuteEtVoisin(0xc1e2_00f1, 81);
    frappe(client, socket, percuteId, FOUDRE_WEAPON, 1);
    expect(client.chainFlashes.count).toBe(1);
    expect(client.chainFlashes.pointCount[0]).toBe(2);

    const figeX0 = client.chainFlashes.pointX(0, 0);
    const figeY0 = client.chainFlashes.pointY(0, 0);
    const figeX1 = client.chainFlashes.pointX(0, 1);
    const figeY1 = client.chainFlashes.pointY(0, 1);

    // La horde bouge VRAIMENT ensuite (mutation directe des tableaux publics
    // de `Horde`, comme les decors de `back/src/combat.test.ts`) : sans ce
    // controle, « rien n'a change » pourrait aussi bien dire « rien n'a
    // bouge ».
    const percuteSlot = client.horde.slotOf(percuteId);
    const voisinSlot = client.horde.slotOf(voisinId);
    client.horde.x[percuteSlot] = (client.horde.x[percuteSlot] ?? 0) + 500;
    client.horde.y[percuteSlot] = (client.horde.y[percuteSlot] ?? 0) + 500;
    client.horde.x[voisinSlot] = (client.horde.x[voisinSlot] ?? 0) + 500;
    client.horde.y[voisinSlot] = (client.horde.y[voisinSlot] ?? 0) + 500;
    expect(client.horde.x[percuteSlot]).not.toBe(figeX0);

    expect(client.chainFlashes.pointX(0, 0)).toBe(figeX0);
    expect(client.chainFlashes.pointY(0, 0)).toBe(figeY0);
    expect(client.chainFlashes.pointX(0, 1)).toBe(figeX1);
    expect(client.chainFlashes.pointY(0, 1)).toBe(figeY1);
  });

  it('un flash de chaine expire apres CHAIN_FLASH_LIFETIME_MS, jamais avant (verifie aux deux bornes)', () => {
    const { client, socket, percuteId } = setupPercuteEtVoisin(0xc1e2_00f2, 82);
    const impactNowMs = frappe(client, socket, percuteId, FOUDRE_WEAPON, 1);
    expect(client.chainFlashes.count).toBe(1);

    client.update(impactNowMs + CHAIN_FLASH_LIFETIME_MS - 1, STEP);
    expect(client.chainFlashes.count).toBe(1);

    client.update(impactNowMs + CHAIN_FLASH_LIFETIME_MS, STEP);
    expect(client.chainFlashes.count).toBe(0);
  });

  /**
   * ⚠️ **Le filtre Foudre — une arme elementaire NON-Foudre marque mais ne
   * seme jamais de flash de chaine.** Seule `ELEMENT.FOUDRE` declenche
   * `#seedChainFlash` ; les autres elements suivent leur seul chemin
   * (`#markLocally`).
   */
  it('un impact elementaire NON-Foudre marque, mais ne seme AUCUN flash de chaine', () => {
    const { client, socket, percuteId } = setupPercuteEtVoisin(0xc1e2_00f3, 83);
    const BRAISE_WEAPON: Weapon = { ...weaponOf(BASE_WEAPON_ID), element: ELEMENT.BRAISE };

    frappe(client, socket, percuteId, BRAISE_WEAPON, 1);

    expect(client.horde.markAt(client.horde.slotOf(percuteId), client.hordeTick - 1)).toBe(
      ELEMENT.BRAISE,
    );
    expect(client.chainFlashes.count).toBe(0);
  });

  /**
   * `pointCount` d'un flash ne peut jamais depasser `1 + CHAIN_JUMPS` — un
   * controle direct sur ce que `ChainFlashes` accepte, complementaire de la
   * borne deja gardee cote serveur et cote `shared/chain.test.ts`.
   */
  it('un flash de chaine ne porte jamais plus de 1 + CHAIN_JUMPS points', () => {
    const { client, socket, percuteId } = setupPercuteEtVoisin(0xc1e2_00f4, 84);

    frappe(client, socket, percuteId, FOUDRE_WEAPON, 1);

    expect(client.chainFlashes.count).toBe(1);
    expect(client.chainFlashes.pointCount[0]).toBeLessThanOrEqual(1 + CHAIN_JUMPS);
  });
});

describe('GameClient — proprietes du tir que le code affirme (tache 11/13)', () => {
  const MS_PER_TICK = 1000 / TICK_HZ;
  const AIM_RIGHT: InputAxes = { x: 1, y: 0 };

  it('tire depuis la position PREDITE du joueur local, pas depuis celle du dernier snapshot', () => {
    // ⚠️ Garde la mutation « jeter la prediction locale » (`const x = p.x` au
    // lieu de `local ? local.simX : p.x`).
    //
    // On fait diverger les deux volontairement : le snapshot repete une
    // position FIXE pendant que l'entree pousse la prediction vers la droite.
    // L'assertion porte sur l'origine reelle de la salve, pas sur un effet
    // indirect : avec la mutation, elle vaudrait exactement `SNAPSHOT_X`.
    const client = new GameClient(
      'ws://test',
      () => ({ x: 1, y: 0 }),
      vi.fn(),
      undefined,
      () => AIM_RIGHT,
    );
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0xc1e2_0020) });
    const order: WaveOrder = {
      waveId: 80,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 3000,
      anchorY: 3000,
      count: 1,
    };
    socket.emit('message', { data: encodeWaveOrder(order) });
    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, [
        {
          id: 1,
          x: 0,
          y: 0,
          hp: 100,
          aimX: 0,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 0,
        },
      ]),
    });
    client.update(0, STEP);
    expect(client.horde.count).toBe(1);

    const monsterX = client.horde.x[0] ?? 0;
    const monsterY = client.horde.y[0] ?? 0;
    // Le snapshot fige le joueur a gauche du monstre — la visee AIM_RIGHT
    // pointe donc bien vers lui, quelle que soit la position reellement
    // utilisee pour l'origine de la salve (l'objet de ce test).
    const SNAPSHOT_X = monsterX - 100;
    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');

    for (let tick = 1; tick <= 30 && spy.mock.calls.length === 0; tick++) {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [
          {
            id: 1,
            x: SNAPSHOT_X,
            y: monsterY,
            hp: 100,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });
      client.update(tick * MS_PER_TICK, STEP);
    }

    expect(spy).toHaveBeenCalled();
    const originX = spy.mock.calls[0]?.[2] ?? 0;
    // La prediction a pousse le joueur vers la droite : l'origine doit s'en
    // ressentir. Avec la mutation, `originX === SNAPSHOT_X` a l'unite pres.
    expect(originX).toBeGreaterThan(SNAPSHOT_X + 1);
  });

  it(
    'tire avec la visee QUANTIFIEE (i8), jamais avec le flottant brut rendu par readAim ' +
      '(tache 13)',
    () => {
      // ⚠️ La direction part sur le fil quantifiee sur un octet signe. Si
      // `#localAim` utilisait le
      // flottant brut de `readAim` au lieu de le faire passer par
      // `quantizeAxis`, cette assertion echouerait — 0.6 * 127 = 76,2, jamais
      // 76. Le vecteur (0.6, 0.8) est choisi PRECISEMENT parce que ses deux
      // composantes, une fois mises a l'echelle par 127, ne tombent PAS sur un
      // entier : un vecteur qui coinciderait deja avec sa version quantifiee
      // (comme (1, 0), utilise par les autres tests de ce fichier) ne
      // prouverait rien.
      const client = new GameClient(
        'ws://test',
        () => ({ x: 0, y: 0 }),
        vi.fn(),
        undefined,
        () => ({ x: 0.6, y: 0.8 }),
      );
      client.connect();
      const socket = latestSocket();
      socket.emit('message', { data: encodeWelcome(1, 0, 0xc1e2_0023) });
      socket.emit('message', {
        data: encodeSnapshot(0, 0, 0, [
          {
            id: 1,
            x: 0,
            y: 0,
            hp: 100,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });
      // Le spy est pose AVANT le tout premier `update()` : c'est celui-la qui
      // tire (cooldown jamais entame), et le rater ferait attendre la
      // prochaine fenetre de cooldown pour rien.
      const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
      client.update(0, STEP);
      for (let tick = 1; tick <= 5 && spy.mock.calls.length === 0; tick++) {
        socket.emit('message', {
          data: encodeSnapshot(tick, 0, 0, [
            {
              id: 1,
              x: 0,
              y: 0,
              hp: 100,
              aimX: 0,
              aimY: 0,
              pickupRadius: ORB_PICKUP_RADIUS,
              shield: 0,
            },
          ]),
        });
        client.update(tick * MS_PER_TICK, STEP);
      }

      expect(spy).toHaveBeenCalled();
      const [, , , , dirX, dirY] = spy.mock.calls[0] ?? [];
      expect(dirX).toBe(76);
      expect(dirY).toBe(102);
    },
  );

  it('tire avec la visee LOCALE quantifiee, pas avec celle (retardee) du dernier snapshot recu', () => {
    // ⚠️ Le joueur local tire avec `#localAim`
    // (fraiche, calculee a chaque `update()`), jamais avec le bloc `aimX`/
    // `aimY` que son PROPRE snapshot rapporte — celui-ci a fait l'aller-retour
    // reseau et peut retarder d'un ou plusieurs ticks sur la souris reelle. On
    // fait diverger les deux volontairement : le snapshot annonce une visee
    // opposee (quantifiee : `aimX: -127`) a celle que `readAim` fournit
    // reellement (`AIM_RIGHT`) — si `#fireWeapons` utilisait le snapshot pour
    // le joueur local, la salve partirait a gauche, jamais vers le monstre a
    // droite.
    const client = new GameClient(
      'ws://test',
      () => ({ x: 0, y: 0 }),
      vi.fn(),
      undefined,
      () => AIM_RIGHT,
    );
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0xc1e2_0021) });
    const order: WaveOrder = {
      waveId: 81,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 3000,
      anchorY: 3000,
      count: 1,
    };
    socket.emit('message', { data: encodeWaveOrder(order) });
    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, [
        {
          id: 1,
          x: 0,
          y: 0,
          hp: 100,
          aimX: 0,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 0,
        },
      ]),
    });
    client.update(0, STEP);
    expect(client.horde.count).toBe(1);

    const monsterX = client.horde.x[0] ?? 0;
    const monsterY = client.horde.y[0] ?? 0;
    const PLAYER = { x: monsterX - 50, y: monsterY };
    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');

    for (let tick = 1; tick <= 20 && spy.mock.calls.length === 0; tick++) {
      socket.emit('message', {
        // Le snapshot ment sur la visee (AIM_LEFT quantifiee) : si le code
        // s'y fiait pour le joueur local, aucun tir ne toucherait jamais le
        // monstre, a droite.
        data: encodeSnapshot(tick, 0, 0, [
          {
            id: 1,
            ...PLAYER,
            hp: 100,
            aimX: -127,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });
      client.update(tick * MS_PER_TICK, STEP);
    }

    expect(spy).toHaveBeenCalled();
    const [, , , , dirX] = spy.mock.calls[0] ?? [];
    expect(dirX).toBeGreaterThan(0);
  });

  it('ne tire pas pendant le gel, et retire des la reprise', () => {
    // ⚠️ Garde la mutation `if (true)` a la place de `tick > #freezeUntilTick`.
    // Les deux moities comptent : verifier seulement que le tir s'arrete
    // laisserait passer un gel permanent.
    const client = new GameClient(
      'ws://test',
      () => ({ x: 0, y: 0 }),
      vi.fn(),
      undefined,
      () => AIM_RIGHT,
    );
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0xc1e2_0022) });
    const order: WaveOrder = {
      waveId: 82,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 3000,
      anchorY: 3000,
      count: 1,
    };
    socket.emit('message', { data: encodeWaveOrder(order) });
    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, [
        {
          id: 1,
          x: 0,
          y: 0,
          hp: 100,
          aimX: 0,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 0,
        },
      ]),
    });
    client.update(0, STEP);
    expect(client.horde.count).toBe(1);

    const monsterX = client.horde.x[0] ?? 0;
    const monsterY = client.horde.y[0] ?? 0;
    const PLAYER = { x: monsterX - 50, y: monsterY };
    const snapshot = (tick: number): ArrayBuffer =>
      encodeSnapshot(tick, 0, 0, [
        { id: 1, ...PLAYER, hp: 100, aimX: 0, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS, shield: 0 },
      ]);

    // Le gel prend effet au tick 2 : le message part avant, comme le fait le
    // serveur, et c'est le tick DATE qui compte.
    const FREEZE_START = 2;
    socket.emit('message', { data: encodeLevelUp(FREEZE_START, 2) });

    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    // Fenetre de gel strict : `#advanceHorde` ne tire pas tant que
    // `tick <= #freezeUntilTick`.
    const FREEZE_END = FREEZE_START + GEL_TICKS - 1;
    for (let tick = FREEZE_START; tick <= FREEZE_END; tick++) {
      if (tick === FREEZE_END) {
        socket.emit('message', { data: encodeDraftResult(FREEZE_END, []) });
      }
      socket.emit('message', { data: snapshot(tick) });
      client.update(tick * MS_PER_TICK, STEP);
    }
    expect(spy).not.toHaveBeenCalled();

    // La reprise rend le tir : ce n'est pas un gel permanent.
    for (let tick = FREEZE_END + 1; tick <= FREEZE_END + 30; tick++) {
      socket.emit('message', { data: snapshot(tick) });
      client.update(tick * MS_PER_TICK, STEP);
    }
    expect(spy).toHaveBeenCalled();
  });
});

/**
 * Le draft, cote client : un `Loadout` par joueur, alimente par
 * `DRAFT_RESULT`. `#fireWeapons` en tire tout l'arsenal (une recharge par
 * arme), et la prediction locale sa vitesse (`bonus('speed')`).
 */
describe('GameClient — le draft recu et ses effets (tache 9)', () => {
  const MS_PER_TICK = 1000 / TICK_HZ;
  /** Une visee non nulle : sans elle, aucun des deux cotes ne tire. */
  const AIM_RIGHT: InputAxes = { x: 1, y: 0 };
  /** Identifiants du catalogue, nommes ici pour que les tests se relisent. */
  const GRENADE = 4;
  const ARC_LOURD = 2;
  const CADENCE = 1;
  const PUISSANCE = 2;
  const FOUGUE = 3;

  function setup(
    localId = 1,
    readInput: () => InputAxes = () => ({ x: 0, y: 0 }),
    readAim: () => InputAxes = () => AIM_RIGHT,
    /** Les bonus PERMANENTS du compte (boutique) — voir `GameClient`. */
    accountBonuses = bonusesOf(new Map()),
  ): { client: GameClient; socket: FakeSocket } {
    const client = new GameClient(
      'ws://test',
      readInput,
      vi.fn(),
      undefined,
      readAim,
      undefined,
      null,
      accountBonuses,
    );
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(localId, 0, 0xd8a5_0001) });
    return { client, socket };
  }

  /**
   * Un tour de draft complet a une seule carte : l'etalage s'ouvre, le serveur
   * tranche, le gel se referme au tick 0.
   *
   * ⚠️ `deadlineTick = 0` sur le resultat n'est pas un detail : c'est lui qui
   * dit au client que le gel est deja fini. Une echeance dans le futur
   * empecherait `#fireWeapons` de tirer et remettrait `#movementScale` a zero —
   * les tests de tir et de vitesse ci-dessous ne mesureraient plus rien.
   */
  function grant(
    socket: FakeSocket,
    card: { nature: number; refId: number },
    outcomes: readonly { playerId: number; cardIndex: number; outcome: number }[],
  ): void {
    socket.emit('message', { data: encodeDraftOpen(600, [card]) });
    socket.emit('message', { data: encodeDraftResult(0, outcomes) });
  }

  /** Fait avancer le client de `ticks` images d'un pas de simulation chacune. */
  function run(
    client: GameClient,
    socket: FakeSocket,
    ticks: number,
    players: readonly {
      id: number;
      x: number;
      y: number;
      hp: number;
      aimX: number;
      aimY: number;
      pickupRadius: number;
      shield: number;
    }[],
    withSnapshots = true,
  ): void {
    for (let tick = 1; tick <= ticks; tick++) {
      if (withSnapshots) {
        socket.emit('message', { data: encodeSnapshot(tick, 0, 0, players) });
      }
      client.update(tick * MS_PER_TICK, STEP);
    }
  }

  it('envoie un DRAFT_TOKEN portant l indice de la carte visee (etape 2 du plan)', () => {
    const { client, socket } = setup();

    client.placeToken(3);

    const jetons = socket.sent.map((f) => decode(f)).filter((m) => m.type === MSG.DRAFT_TOKEN);
    expect(jetons).toHaveLength(1);
    expect(jetons[0]).toMatchObject({ cardIndex: 3 });
  });

  it('un jeton refuse par le serveur ne s affiche pas comme pose', () => {
    // ⚠️ Le client ne DECIDE rien : l'ecran montre `DRAFT_INTENTS`, jamais le
    // geste local. Un jeton affiche des le clic mentirait a chaque refus.
    //
    // Le refus vient de l'inventaire (`Loadout.canTake` : des slots d'armes
    // pleins refusent une arme NOUVELLE), que le client ne connait pas : d'ou
    // l'interdiction de l'affichage optimiste.
    const { client, socket } = setup(1);
    const etalage = [
      { nature: CARD.WEAPON, refId: GRENADE },
      { nature: CARD.PASSIVE, refId: FOUGUE },
    ];
    socket.emit('message', { data: encodeDraftOpen(600, etalage) });

    // Un premier jeton, accepte : le serveur le rediffuse.
    client.placeToken(1);
    socket.emit('message', { data: encodeDraftIntents([{ playerId: 1, cardIndex: 1 }]) });
    expect(client.draftIntents.get(1)).toBe(1);

    // Un second, que le serveur REFUSE : il rediffuse les intentions
    // inchangees.
    client.placeToken(0);

    // Avant meme la rediffusion, rien n'a bouge a l'ecran : c'est ici qu'un
    // affichage optimiste se verrait.
    expect(client.draftIntents.get(1)).toBe(1);

    socket.emit('message', { data: encodeDraftIntents([{ playerId: 1, cardIndex: 1 }]) });
    expect(client.draftIntents.get(1)).toBe(1);
  });

  it('les issues d un autre joueur ne modifient pas mon inventaire', () => {
    const { client, socket } = setup(1);

    grant(socket, { nature: CARD.WEAPON, refId: GRENADE }, [
      { playerId: 2, cardIndex: 0, outcome: OUTCOME.WON },
    ]);

    // Chacun part avec la dague (`loadoutOf`, comme `Room.join`).
    expect([...client.loadoutOf(2).weaponIds]).toEqual([BASE_WEAPON_ID, GRENADE]);
    expect([...client.loadoutOf(1).weaponIds]).toEqual([BASE_WEAPON_ID]);
  });

  it('une carte perdue au conflit ne donne rien, la meme carte gagnee la donne', () => {
    // ⚠️ Les trois issues ne se valent pas : `LOST` (1) est le joueur qui
    // visait une carte qu'un AUTRE a eue. Les traiter comme les deux autres
    // donnerait la carte contestee a tous ses pretendants.
    const { client, socket } = setup(1);

    grant(socket, { nature: CARD.WEAPON, refId: GRENADE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.LOST },
      { playerId: 2, cardIndex: 0, outcome: OUTCOME.WON },
    ]);

    expect([...client.loadoutOf(1).weaponIds]).toEqual([BASE_WEAPON_ID]);
    expect([...client.loadoutOf(2).weaponIds]).toEqual([BASE_WEAPON_ID, GRENADE]);
  });

  it('une attribution d office donne la carte comme une victoire', () => {
    // Le joueur absent : il n'a pose aucun jeton, le serveur a tranche pour
    // lui. `AUTO` (2) attribue tout autant que `WON` (0) ; ne retenir que `WON`
    // rendrait invisible l'arsenal d'un joueur en arriere-plan, cas frequent.
    const { client, socket } = setup(1);

    grant(socket, { nature: CARD.PASSIVE, refId: FOUGUE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.AUTO },
    ]);

    expect(client.loadoutOf(1).stacksOf(FOUGUE)).toBe(1);
  });

  it('un nouvel etalage efface les jetons du precedent', () => {
    // ⚠️ L'entree est un `DRAFT_INTENTS` **perime**, arrivant apres le
    // resultat : `DRAFT_RESULT` vide deja les intentions, donc sans ce message
    // la remise a zero de `DRAFT_OPEN` ne serait pas exercee. Le client est un
    // decodeur du FIL : il ne doit pas dependre de ce que `back/` emet.
    const { client, socket } = setup(1);
    socket.emit('message', {
      data: encodeDraftOpen(600, [{ nature: CARD.PASSIVE, refId: FOUGUE }]),
    });
    socket.emit('message', { data: encodeDraftIntents([{ playerId: 1, cardIndex: 0 }]) });
    expect(client.draftIntents.get(1)).toBe(0);

    socket.emit('message', {
      data: encodeDraftResult(300, [{ playerId: 1, cardIndex: 0, outcome: OUTCOME.WON }]),
    });
    // Le jeton perime, rediffuse apres la fermeture.
    socket.emit('message', { data: encodeDraftIntents([{ playerId: 1, cardIndex: 0 }]) });
    expect(client.draftIntents.get(1)).toBe(0);

    // Le meme passif revient — les passifs ne sont JAMAIS exclus, donc
    // c'est le cas courant, pas un cas tordu.
    socket.emit('message', {
      data: encodeDraftOpen(900, [{ nature: CARD.PASSIVE, refId: FOUGUE }]),
    });
    expect(client.draftIntents.size).toBe(0);
  });

  it('l etalage survit a la fermeture : c est la revelation qui en a besoin', () => {
    // ⚠️ L'etalage ne doit pas etre vide a la fermeture : c'est l'instant ou
    // l'ecran illumine la carte obtenue, et les issues designent les cartes
    // par leur INDICE.
    const { client, socket } = setup(1);
    const etalage = [
      { nature: CARD.PASSIVE, refId: FOUGUE },
      { nature: CARD.WEAPON, refId: GRENADE },
    ];
    socket.emit('message', { data: encodeDraftOpen(600, etalage) });
    expect(client.draftSettled).toBe(false);

    socket.emit('message', {
      data: encodeDraftResult(300, [{ playerId: 1, cardIndex: 1, outcome: OUTCOME.WON }]),
    });

    // La negociation est close...
    expect(client.draftSettled).toBe(true);
    // ...mais la carte que l'issue designe est toujours la, et c'est la bonne.
    expect(client.draftCards).toHaveLength(2);
    const gagnee = client.draftCards[client.draftOutcomes[0]?.cardIndex ?? -1];
    expect(gagnee).toEqual({ nature: CARD.WEAPON, refId: GRENADE, upgrade: 0, rarity: 0 });

    // Le prochain etalage remplace le precedent, et rouvre la negociation :
    // c'est LUI qui borne l'affichage, pas la fermeture.
    socket.emit('message', {
      data: encodeDraftOpen(900, [{ nature: CARD.PASSIVE, refId: FOUGUE }]),
    });
    expect(client.draftSettled).toBe(false);
    expect(client.draftCards).toHaveLength(1);
  });

  it('une issue que le miroir ne peut pas ranger n interrompt pas la reception', () => {
    // ⚠️ Le client est un decodeur du FIL : il doit survivre a une trame qu'il
    // ne sait pas ranger. Deux cas concrets — un indice de carte qui ne
    // designe rien (il a manque le `DRAFT_OPEN` en rejoignant un salon en
    // cours), et un `refId` que son catalogue ne connait pas (`weaponOf`
    // leve). Sans rattrapage, l'exception remonte hors du gestionnaire de
    // message : le gel n'est plus date, les issues ne sont plus affichees, et
    // tout ce que ce message portait d'autre est perdu.
    const { client, socket } = setup(1);

    // Aucun `DRAFT_OPEN` recu : l'indice ne designe rien.
    socket.emit('message', {
      data: encodeDraftResult(700, [{ playerId: 2, cardIndex: 0, outcome: OUTCOME.WON }]),
    });
    expect(client.draftOutcomes).toHaveLength(1);

    // Etalage connu, mais une arme absente du catalogue de ce client.
    const INCONNUE = 200;
    expect(() => weaponOf(INCONNUE)).toThrow();
    socket.emit('message', {
      data: encodeDraftOpen(600, [{ nature: CARD.WEAPON, refId: INCONNUE }]),
    });
    socket.emit('message', {
      data: encodeDraftResult(42, [{ playerId: 2, cardIndex: 0, outcome: OUTCOME.WON }]),
    });

    // Le message a ete traite jusqu'au bout : la negociation est marquee close
    // et le gel est date. (« L'etalage est vide » ne prouverait rien :
    // l'etalage survit a la fermeture.)
    expect(client.draftSettled).toBe(true);
    expect(client.draftDeadlineTick).toBe(42);
    expect(client.draftOutcomes).toHaveLength(1);
    expect(client.loadoutOf(2).stacksOfWeapon(INCONNUE)).toBe(0);
  });

  it('l arme draftee tire — pour son porteur comme pour son allie', () => {
    // ⚠️ Deux armes DISTINCTES, une par joueur, parce que l'espion ne voit que
    // l'arme, pas qui tire.
    const { client, socket } = setup(1);
    socket.emit('message', { data: encodeDraftOpen(600, []) });
    grant(socket, { nature: CARD.WEAPON, refId: GRENADE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
    ]);
    grant(socket, { nature: CARD.WEAPON, refId: ARC_LOURD }, [
      { playerId: 2, cardIndex: 0, outcome: OUTCOME.WON },
    ]);

    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    run(client, socket, 5, [
      {
        id: 1,
        x: 2000,
        y: 2000,
        hp: 100,
        aimX: 127,
        aimY: 0,
        pickupRadius: ORB_PICKUP_RADIUS,
        shield: 0,
      },
      {
        id: 2,
        x: 2200,
        y: 2000,
        hp: 100,
        aimX: 127,
        aimY: 0,
        pickupRadius: ORB_PICKUP_RADIUS,
        shield: 0,
      },
    ]);

    const tirees = new Set(spy.mock.calls.map((c) => c[0].id));
    expect(tirees.has(BASE_WEAPON_ID)).toBe(true);
    expect(tirees.has(GRENADE)).toBe(true);
    expect(tirees.has(ARC_LOURD)).toBe(true);
  });

  it('chaque arme a SA recharge : la grenade ne bride pas la dague, et tire quand meme', () => {
    // ⚠️ Avec un compteur unique par joueur, l'une des deux armes disparait
    // selon l'ordre du parcours : la lente si
    // la rapide passe d'abord, la rapide sinon. Compter les DEUX est ce qui
    // ferme les deux cas d'un coup.
    const { client, socket } = setup(1);
    grant(socket, { nature: CARD.WEAPON, refId: GRENADE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
    ]);

    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    const TICKS = 70;
    run(client, socket, TICKS, [
      {
        id: 1,
        x: 2000,
        y: 2000,
        hp: 100,
        aimX: 127,
        aimY: 0,
        pickupRadius: ORB_PICKUP_RADIUS,
        shield: 0,
      },
    ]);

    const dague = spy.mock.calls.filter((c) => c[0].id === BASE_WEAPON_ID).map((c) => c[1]);
    const grenade = spy.mock.calls.filter((c) => c[0].id === GRENADE).length;

    // ⚠️ **On lit les INTERVALLES, pas un compte** : un compte depend du tick
    // de la premiere salve et ne coincide avec une formule que par hasard,
    // jusqu'au prochain reglage de la table.
    expect(dague.length).toBeGreaterThan(1);
    for (let i = 1; i < dague.length; i++) {
      expect((dague[i] ?? 0) - (dague[i - 1] ?? 0)).toBe(weaponOf(BASE_WEAPON_ID).cooldownTicks);
    }
    // Et la grenade tire au moins une fois : c'est l'autre moitie du piege.
    expect(grenade).toBeGreaterThanOrEqual(1);
  });

  it('empiler une arme elargit la salve AFFICHEE, exactement comme celle du serveur', () => {
    // ⚠️ **Une seule fonction, jamais deux copies.** `salvoCount` vit dans
    // `shared/weapons.ts` : `Room#fireOne` la lit, ce miroir aussi. Deux
    // formules divergeraient a la premiere retouche, et le joueur verrait une
    // salve que le serveur n'arbitre pas — le cas le plus difficile a
    // diagnostiquer, parce que l'ecran a l'air juste.
    //
    // ⚠️ Le canon a mitraille tire DEJA huit projectiles : sur une arme a
    // projectile unique, un miroir qui rendrait `stacks` au lieu de la vraie
    // formule donnerait les memes nombres.
    const EVENTAIL = 7;
    const eventail = weaponOf(EVENTAIL);
    expect(eventail.projectileCount).toBeGreaterThan(1);

    function projectilesDeLaSalve(exemplaires: number): number {
      const { client, socket } = setup(1);
      for (let i = 0; i < exemplaires; i++) {
        grant(socket, { nature: CARD.WEAPON, refId: EVENTAIL }, [
          { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
        ]);
      }
      expect(client.loadoutOf(1).stacksOfWeapon(EVENTAIL)).toBe(exemplaires);

      const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
      run(client, socket, 3, [
        {
          id: 1,
          x: 2000,
          y: 2000,
          hp: 100,
          aimX: 127,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 0,
        },
      ]);
      const salve = spy.mock.calls.find((c) => c[0].id === EVENTAIL);
      const neutre = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
      if (!salve || !neutre) {
        throw new Error('salve manquante');
      }
      // L'arme neutre vit hors des slots : jamais empilee, jamais elargie.
      expect(neutre[7]).toBe(weaponOf(BASE_WEAPON_ID).projectileCount);
      return salve[7] ?? 0;
    }

    // ⚠️ **`stackGain` et pas `+ 1`** : le gain suit la largeur de la salve de
    // base. Ce que ce cas garde, c'est que le MIROIR
    // lit la meme fonction que le serveur — la regle elle-meme est gardee par
    // `shared/weapons.test.ts`.
    const gain = stackGain(eventail);
    expect(gain).toBeGreaterThan(1);
    expect(projectilesDeLaSalve(1)).toBe(eventail.projectileCount);
    expect(projectilesDeLaSalve(2)).toBe(eventail.projectileCount + gain);
    expect(projectilesDeLaSalve(3)).toBe(eventail.projectileCount + 2 * gain);
  });

  it('les passifs de cadence empiles accelerent le tir AFFICHE', () => {
    // Le serveur applique `cooldownWithBonus` a chaque tir ; le client doit
    // lire LA MEME fonction, pas la cadence brute du catalogue. Trois cartes :
    // un pas visible malgre l'arrondi qui avale les deux premieres.
    const CARTES = 3;
    const { client, socket } = setup(1);
    for (let i = 0; i < CARTES; i++) {
      grant(socket, { nature: CARD.PASSIVE, refId: CADENCE }, [
        { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
      ]);
    }
    expect(client.loadoutOf(1).stacksOf(CADENCE)).toBe(CARTES);

    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    const TICKS = 70;
    run(client, socket, TICKS, [
      {
        id: 1,
        x: 2000,
        y: 2000,
        hp: 100,
        aimX: 127,
        aimY: 0,
        pickupRadius: ORB_PICKUP_RADIUS,
        shield: 0,
      },
    ]);

    const base = weaponOf(BASE_WEAPON_ID);
    const attendue = cooldownWithBonus(base.cooldownTicks, passiveOf(CADENCE).magnitude * CARTES);
    expect(attendue).toBeLessThan(base.cooldownTicks);
    // ⚠️ L'INTERVALLE entre deux salves, jamais leur compte : voir le test
    // « chaque arme a SA recharge ».
    const salves = spy.mock.calls.filter((c) => c[0].id === BASE_WEAPON_ID).map((c) => c[1]);
    expect(salves.length).toBeGreaterThan(1);
    for (let i = 1; i < salves.length; i++) {
      expect((salves[i] ?? 0) - (salves[i - 1] ?? 0)).toBe(attendue);
    }
  });

  it('les passifs de degats empiles voyagent avec le projectile affiche', () => {
    // Inerte sur l'issue — la piétaille n'a pas de reserve de PV et le serveur
    // arbitre seul — mais pas silencieux pour autant : le nombre porte
    // par le projectile est son seul point observable, et il doit valoir
    // exactement ce que `Room#fireOne` calcule.
    const CARTES = 2;
    const { client, socket } = setup(1);
    for (let i = 0; i < CARTES; i++) {
      grant(socket, { nature: CARD.PASSIVE, refId: PUISSANCE }, [
        { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
      ]);
    }

    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    run(client, socket, 3, [
      {
        id: 1,
        x: 2000,
        y: 2000,
        hp: 100,
        aimX: 127,
        aimY: 0,
        pickupRadius: ORB_PICKUP_RADIUS,
        shield: 0,
      },
    ]);

    const base = weaponOf(BASE_WEAPON_ID);
    const attendu = base.damage * (1 + passiveOf(PUISSANCE).magnitude * CARTES);
    expect(attendu).toBeGreaterThan(base.damage);
    const tir = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
    expect(tir?.[6]).toBeCloseTo(attendu, 6);
  });

  /**
   * Effet de jeu NUL (le serveur arbitre seul), mais le docbloc de `#fireOne`
   * affirme qu'un projectile affiche porte le MEME nombre que celui que le
   * serveur arbitre : ce test garde cette affirmation, et la mutation
   * « retirer `accountBonuses.damage` ».
   *
   * ⚠️ L'attendu vient du catalogue (`maxBonus('damage')`), jamais du miroir.
   */
  it('le bonus de PUISSANCE achete voyage aussi avec le projectile affiche', () => {
    const puissance = SHOP_ITEMS.find((i) => i.bonusKind === 'damage');
    if (!puissance) {
      throw new Error('aucun article de puissance');
    }
    const achats = new Map([[puissance.id, puissance.levels]]);
    const { client, socket } = setup(
      1,
      () => ({ x: 0, y: 0 }),
      () => AIM_RIGHT,
      bonusesOf(achats),
    );

    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    run(client, socket, 3, [
      {
        id: 1,
        x: 2000,
        y: 2000,
        hp: 100,
        aimX: 127,
        aimY: 0,
        pickupRadius: ORB_PICKUP_RADIUS,
        shield: 0,
      },
    ]);

    const base = weaponOf(BASE_WEAPON_ID);
    const attendu = base.damage * (1 + maxBonus('damage'));
    expect(maxBonus('damage')).toBeGreaterThan(0);
    const tir = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
    expect(tir?.[6]).toBeCloseTo(attendu, 6);
    expect(tir?.[6]).not.toBeCloseTo(base.damage, 3);
  });

  /**
   * Le serveur somme les bonus de COMPTE aux passifs du draft (`Room#fireOne` :
   * `loadout.bonus('fireRate') + accountBonuses.fireRate`). Sans le second
   * terme, l'arme neutre afficherait nettement moins de salves que le serveur,
   * avec une phase qui derive sans borne.
   *
   * ⚠️ **L'attendu ne vient PAS du miroir.** Il est derive du CATALOGUE
   * (`maxBonus('fireRate')`) passe a la fonction partagee que `Room#fireOne`
   * applique — jamais de `client.accountBonuses` ni d'une repetition de
   * l'expression testee. Un attendu calcule avec la meme expression que le
   * code teste ne verifierait rien.
   *
   * ⚠️ **Et l'assertion de non-egalite est load-bearing** : sans elle, un
   * miroir qui ignore `accountBonuses.fireRate` tirerait a 4 ticks, et il
   * faudrait que la cadence attendue soit par chance egale a la cadence de
   * base pour que ce test passe. La ligne `not.toBe` rend ce hasard
   * impossible a ignorer si un reglage de table venait a l'introduire.
   */
  it('la cadence AFFICHEE somme le bonus de CADENCE achete, pas seulement les passifs', () => {
    const cadence = SHOP_ITEMS.find((i) => i.bonusKind === 'fireRate');
    if (!cadence) {
      throw new Error('aucun article de cadence');
    }
    // Tous les paliers achetes : la recharge de l'arme neutre doit descendre.
    const achats = new Map([[cadence.id, cadence.levels]]);
    const { client, socket } = setup(
      1,
      () => ({ x: 0, y: 0 }),
      () => AIM_RIGHT,
      bonusesOf(achats),
    );

    const base = weaponOf(BASE_WEAPON_ID);
    const attendue = cooldownWithBonus(base.cooldownTicks, maxBonus('fireRate'));
    // Si le catalogue cessait de faire descendre la recharge, ce test ne
    // mesurerait plus rien — et il le dirait ici, pas en silence.
    expect(attendue).toBeLessThan(base.cooldownTicks);

    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    run(client, socket, 70, [
      {
        id: 1,
        x: 2000,
        y: 2000,
        hp: 100,
        aimX: 127,
        aimY: 0,
        pickupRadius: ORB_PICKUP_RADIUS,
        shield: 0,
      },
    ]);

    // ⚠️ L'INTERVALLE entre deux salves, jamais leur compte : meme raison que
    // le test « chaque arme a SA recharge ».
    const salves = spy.mock.calls.filter((c) => c[0].id === BASE_WEAPON_ID).map((c) => c[1]);
    expect(salves.length).toBeGreaterThan(1);
    for (let i = 1; i < salves.length; i++) {
      expect((salves[i] ?? 0) - (salves[i - 1] ?? 0)).toBe(attendue);
      expect((salves[i] ?? 0) - (salves[i - 1] ?? 0)).not.toBe(base.cooldownTicks);
    }
  });

  /**
   * Le pendant pour `speed` : l'ecart est faible, mais c'est le mecanisme de
   * la reconciliation permanente (voir `PredictedPlayer.predict`).
   *
   * ⚠️ **Sans carte de draft, exprès** : seul le bonus de COMPTE est en jeu,
   * donc un miroir qui sommerait le draft mais pas le compte ne peut pas
   * passer par compensation. L'attendu vient du catalogue
   * (`maxBonus('speed')`), jamais de `#localSpeed`.
   */
  it('la prediction locale somme le bonus de CELERITE achete, pas seulement les cartes', () => {
    const celerite = SHOP_ITEMS.find((i) => i.bonusKind === 'speed');
    if (!celerite) {
      throw new Error('aucun article de celerite');
    }
    const achats = new Map([[celerite.id, celerite.levels]]);
    let entree: InputAxes = { x: 0, y: 0 };
    const { client, socket } = setup(
      1,
      () => entree,
      () => AIM_RIGHT,
      bonusesOf(achats),
    );

    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, [
        {
          id: 1,
          x: 2000,
          y: 2000,
          hp: 100,
          aimX: 0,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 0,
        },
      ]),
    });

    // Chauffe sans entree : le client n'a recu aucun LEVEL_UP, donc aucune
    // rampe de reprise n'est en cours — mais la position predite doit exister
    // avant qu'on mesure un deplacement.
    client.update(0, STEP);
    const avant = client.localPosition;
    entree = { x: 1, y: 0 };
    const IMAGES = 20;
    for (let i = 1; i <= IMAGES; i++) {
      client.update(i * MS_PER_TICK, STEP);
    }
    const apres = client.localPosition;

    const parcouru = (apres?.x ?? 0) - (avant?.x ?? 0);
    const vitesse = PLAYER_SPEED + maxBonus('speed');
    expect(maxBonus('speed')).toBeGreaterThan(0);
    expect(parcouru).toBeCloseTo(vitesse * STEP * IMAGES, 6);
    // Et surtout : PAS la vitesse sans compte. C'est cette ligne qui rougit si
    // `#localSpeed` oublie `accountBonuses.speed`.
    expect(parcouru).not.toBeCloseTo(PLAYER_SPEED * STEP * IMAGES, 2);
  });

  it('la prediction locale avance a la vitesse de l inventaire, pas a PLAYER_SPEED', () => {
    // ⚠️ `Room.step` avance le joueur a
    // `PLAYER_SPEED + bonus('speed')`. Une prediction cablee sur la constante
    // prend du retard a CHAQUE tick, et chaque snapshot la ramene en arriere :
    // le joueur voit une reconciliation permanente. Mesure sur la position
    // PREDITE (un flottant), jamais sur celle du snapshot — elle y est
    // arrondie a l'entier, et un pas sous-pixel s'y lirait zero.
    const CARTES = 2;
    let entree: InputAxes = { x: 0, y: 0 };
    const { client, socket } = setup(1, () => entree);

    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, [
        {
          id: 1,
          x: 2000,
          y: 2000,
          hp: 100,
          aimX: 0,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 0,
        },
      ]),
    });
    for (let i = 0; i < CARTES; i++) {
      grant(socket, { nature: CARD.PASSIVE, refId: FOUGUE }, [
        { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
      ]);
    }

    // Chauffe SANS entree ni snapshot : le resultat a referme le gel au tick 0,
    // donc la rampe de reprise (`LEVEL_RESUME_TICKS`) court encore. La mesurer
    // pendant la rampe melerait deux facteurs.
    const CHAUFFE = LEVEL_RESUME_TICKS + 5;
    for (let i = 0; i < CHAUFFE; i++) {
      client.update(i * MS_PER_TICK, STEP);
    }

    const avant = client.localPosition;
    entree = { x: 1, y: 0 };
    const IMAGES = 20;
    for (let i = 0; i < IMAGES; i++) {
      client.update((CHAUFFE + i) * MS_PER_TICK, STEP);
    }
    const apres = client.localPosition;

    const parcouru = (apres?.x ?? 0) - (avant?.x ?? 0);
    const vitesse = PLAYER_SPEED + passiveOf(FOUGUE).magnitude * CARTES;
    expect(parcouru).toBeCloseTo(vitesse * STEP * IMAGES, 6);
    // Et surtout : PAS la vitesse de base. Sans cette ligne, un `toBeCloseTo`
    // trop laxiste laisserait passer la constante en dur.
    expect(parcouru).not.toBeCloseTo(PLAYER_SPEED * STEP * IMAGES, 1);
  });

  it('etape 10 : une carte RARE gagnee s applique deux fois au miroir, comme au salon', () => {
    const { client, socket } = setup(1);
    socket.emit('message', {
      data: encodeDraftOpen(600, [{ nature: CARD.PASSIVE, refId: FOUGUE, rarity: RARITY.RARE }]),
    });
    socket.emit('message', {
      data: encodeDraftResult(0, [{ playerId: 1, cardIndex: 0, outcome: OUTCOME.WON }]),
    });
    expect(client.loadoutOf(1).stacksOf(FOUGUE)).toBe(2);
  });

  // ⚠️ Legendaire change une regle, elle ne se multiplie pas
  // (`RARITY_MULTIPLIERS` vaut 1 a cet index) : une seule application, donc
  // la pure acquisition, sans cran d'amelioration. Meme regle cote serveur
  // (`back/src/room.test.ts`, legendaire x1).
  it('etape 10 : une arme LEGENDAIRE servie d office a un allie : acquisition seule, aucun cran', () => {
    const { client, socket } = setup(1);
    socket.emit('message', {
      data: encodeDraftOpen(600, [
        { nature: CARD.WEAPON, refId: GRENADE, upgrade: 1, rarity: RARITY.LEGENDAIRE },
      ]),
    });
    socket.emit('message', {
      data: encodeDraftResult(0, [{ playerId: 2, cardIndex: 0, outcome: OUTCOME.AUTO }]),
    });
    expect(client.loadoutOf(2).stacksOfWeapon(GRENADE)).toBe(1);
    expect(client.loadoutOf(2).upgradesOf(GRENADE, 1)).toBe(0);
  });

  it('etape 10 : Volee elargit la salve affichee exactement comme celle du serveur', () => {
    const VOLEE = PASSIVES.find((p) => p.kind === 'salvo')?.id ?? -1;
    const { client, socket } = setup(1);
    grant(socket, { nature: CARD.PASSIVE, refId: VOLEE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
    ]);
    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    run(client, socket, 3, [
      {
        id: 1,
        x: 2000,
        y: 2000,
        hp: 100,
        aimX: 127,
        aimY: 0,
        pickupRadius: ORB_PICKUP_RADIUS,
        shield: 0,
      },
    ]);
    const base = weaponOf(BASE_WEAPON_ID);
    const tir = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
    expect(tir?.[7]).toBe(base.projectileCount + stackGain(base));
  });

  it('etape 10 : Colosse voyage avec le projectile affiche, comme au salon', () => {
    const COLOSSE = PASSIVES.find((p) => p.kind === 'colossus')?.id ?? -1;
    const { client, socket } = setup(1);
    grant(socket, { nature: CARD.PASSIVE, refId: COLOSSE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
    ]);
    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    run(client, socket, 3, [
      {
        id: 1,
        x: 2000,
        y: 2000,
        hp: 100,
        aimX: 127,
        aimY: 0,
        pickupRadius: ORB_PICKUP_RADIUS,
        shield: 0,
      },
    ]);
    const base = weaponOf(BASE_WEAPON_ID);
    const tir = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
    expect(tir?.[6]).toBeCloseTo(base.damage * 1.1, 6);
  });

  /**
   * Un porteur de Transcendance ET de Colosse : la raison d'etre de `maxHpOf`
   * dans `shared/loadout.ts`.
   *
   * `localMaxHp` (le HUD) et le miroir de `shotDamage` dans `#fireOne`
   * appellent tous les deux `maxHpOf`. Ce test garde le second appel : une
   * copie de `PLAYER_MAX_HP` en dur echelonnerait Colosse sur ~100 PV quand le
   * serveur arbitre sur 1.
   */
  it('etape 13 : Transcendance ecrase Colosse, cote client comme au salon — aucune divergence', () => {
    const COLOSSE = PASSIVES.find((p) => p.kind === 'colossus')?.id ?? -1;
    const TRANSCENDANCE = PASSIVES.find((p) => p.rule === 'transcendance')?.id ?? -1;
    const { client, socket } = setup(1);
    grant(socket, { nature: CARD.PASSIVE, refId: COLOSSE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
    ]);
    grant(socket, { nature: CARD.PASSIVE, refId: TRANSCENDANCE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
    ]);
    // ⚠️ Le HUD d'abord : `localMaxHp` doit voir la regle, pas seulement le
    // miroir de tir plus bas — les DEUX appels de `client.ts` sont en jeu.
    expect(client.localMaxHp).toBe(TRANSCENDANCE_MAX_HP);
    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    run(client, socket, 3, [
      {
        id: 1,
        x: 2000,
        y: 2000,
        hp: 100,
        aimX: 127,
        aimY: 0,
        pickupRadius: ORB_PICKUP_RADIUS,
        shield: 0,
      },
    ]);
    const base = weaponOf(BASE_WEAPON_ID);
    const tir = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
    // ⚠️ **`TRANSCENDANCE_MAX_HP` (1) est bien sous `COLOSSUS_HP_STEP` (10)** :
    // `Math.floor(1 / 10) === 0`, donc Colosse ne rend STRICTEMENT rien ici —
    // pas moins que d'habitude, RIEN. Comparer a `base.damage` tout court
    // (pas a `base.damage * 1.1`, la valeur du test jumeau sans
    // Transcendance) est ce qui ferait rougir un miroir branche sur
    // `PLAYER_MAX_HP`.
    expect(tir?.[6]).toBeCloseTo(base.damage, 6);
  });

  it('etape 10 : le miroir tire avec le VRAI tireur et son critique — comme le salon', () => {
    // ⚠️ Sans `by`, le critique serait tire de `hashRoll(tick, 0, i)` quand le
    // serveur tire `hashRoll(tick, p.id, i)` : le chiffre dore affiche ne
    // serait pas celui arbitre.
    const FEROCITE = PASSIVES.find((p) => p.kind === 'critDamage')?.id ?? -1;
    const { client, socket } = setup(1);
    grant(socket, { nature: CARD.PASSIVE, refId: FEROCITE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
    ]);
    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    run(client, socket, 3, [
      {
        id: 1,
        x: 2000,
        y: 2000,
        hp: 100,
        aimX: 127,
        aimY: 0,
        pickupRadius: ORB_PICKUP_RADIUS,
        shield: 0,
      },
    ]);
    const tir = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
    expect(tir?.[8]).toBe(1);
    expect(tir?.[9]).toEqual(critOf(client.loadoutOf(1)));
  });
});

/**
 * **Le ralentissement du Givre, mesure de bout en bout**, avec un VRAI
 * `GameClient` (le pendant du scenario Z2 de
 * `shared/horde.replication.test.ts`, qui mesure la meme chose sur un client
 * modele).
 *
 * Meme forme que `runClientDeathScenario` : une reference « serveur » qui pose
 * ses zones et les annonce, un client qui les recoit `zoneDelayTicks` plus
 * tard et doit revenir au `bornTick` pour rejouer.
 */
function runClientZoneScenario(params: {
  mapSeed: number;
  waveId: number;
  entities: number;
  zoneTicks: readonly number[];
  anchors: readonly number[];
  zoneDelayTicks: number;
  ticks: number;
  element: number;
  /**
   * Ticks auxquels le serveur re-arrose les points DEJA poses au premier
   * `zoneTicks`, sans bouger d'un pixel — le chemin du RAFRAICHISSEMENT.
   *
   * ⚠️ **Des points fixes, jamais les ancres.** Une ancre est une entite, et
   * une entite parcourt plus d'un `ZONE_RADIUS` en
   * `ZONE_REFRESH_INTERVAL_TICKS` ticks : arroser une ancre a nouveau CREE une
   * zone, elle n'en prolonge aucune. Sans point fixe, ce scenario ne
   * mettrait jamais en scene le cas qu'il pretend tester.
   */
  refreshTicks?: readonly number[];
}): {
  client: GameClient;
  reference: Horde;
  maxDrift: number;
  announced: number;
  /** Plus grand nombre de zones vivantes chez le client, et chez la reference. */
  zonesRecues: number;
  zonesServeur: number;
} {
  const {
    mapSeed,
    waveId,
    entities,
    zoneTicks,
    anchors,
    zoneDelayTicks,
    ticks,
    element,
    refreshTicks = [],
  } = params;

  const ref = makeReferenceServer(mapSeed, entities);
  const refZones = new ZoneField();
  const order: WaveOrder = {
    waveId,
    spawnTick: 0,
    seed: 0x51ee_d001,
    archetype: 0,
    formation: FORMATION.CLUSTER,
    anchorX: 1200,
    anchorY: 1200,
    count: entities,
  };
  ref.horde.spawn(order, ref.fields[0]);

  const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
  client.connect();
  const socket = latestSocket();
  socket.emit('message', { data: encodeWelcome(1, 0, mapSeed) });
  socket.emit('message', { data: encodeWaveOrder(order) });

  const pending: { kind: number; x: number; y: number; bornTick: number; by: number }[] = [];
  /** Centres poses au premier `zoneTicks`, re-arroses aux `refreshTicks`. */
  const points: { x: number; y: number }[] = [];
  let announced = 0;
  let inFlight = 0;
  let maxDrift = 0;
  let zonesRecues = 0;
  let zonesServeur = 0;

  for (let tick = 0; tick < ticks; tick++) {
    const xs = [0, 1, 2, 3].map((p) => Math.round(3000 + Math.cos(tick * 0.02 + p) * 1500));
    const ys = [0, 1, 2, 3].map((p) => Math.round(3000 + Math.sin(tick * 0.02 + p) * 1500));

    ref.playerHistory.record(tick, xs, ys);
    if (tick % STEPS_PER_FIELD === 0) {
      const seen = ref.playerHistory.delayed(tick);
      if (seen) {
        for (let f = 0; f < 4; f++) {
          ref.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
        }
        ref.horde.retarget(seen.x, seen.y);
      }
    }
    // Expirer avant d'avancer, une fois par tick — le contrat de `Room.step`.
    refZones.expire(tick);
    ref.horde.step(STEP, ref.fields, tick, refZones);

    // Le serveur pose APRES avoir fait avancer sa horde, comme `Room.step`.
    if (zoneTicks.includes(tick) || refreshTicks.includes(tick)) {
      if (refreshTicks.includes(tick)) {
        for (const point of points) {
          refZones.spawn(element, point.x, point.y, 1, tick);
        }
      } else {
        for (const idx of anchors) {
          const slot = ref.horde.slotOf(entityIdOf(waveId, idx));
          if (slot < 0) {
            continue;
          }
          const px = Math.round(ref.horde.x[slot] ?? 0);
          const py = Math.round(ref.horde.y[slot] ?? 0);
          refZones.spawn(element, px, py, 1, tick);
          if (tick === zoneTicks[0]) {
            points.push({ x: px, y: py });
          }
        }
      }
      for (let z = 0; z < refZones.count; z++) {
        if (refZones.bornTick[z] !== tick) {
          continue;
        }
        pending.push({
          kind: refZones.kind[z] ?? 0,
          x: refZones.x[z] ?? 0,
          y: refZones.y[z] ?? 0,
          bornTick: tick,
          by: refZones.by[z] ?? 0,
        });
        announced++;
        inFlight++;
      }
    }

    const players = xs.map((x, i) => ({
      id: i,
      x,
      y: ys[i] ?? 0,
      hp: 100,
      aimX: 0,
      aimY: 0,
      pickupRadius: ORB_PICKUP_RADIUS,
      shield: 0,
    }));
    socket.emit('message', { data: encodeSnapshot(tick, 0, 0, players) });

    for (let i = pending.length - 1; i >= 0; i--) {
      const zone = pending[i];
      if (zone && zone.bornTick + zoneDelayTicks === tick) {
        socket.emit('message', {
          data: encodeZone(zone.kind, zone.x, zone.y, zone.bornTick, zone.by),
        });
        pending.splice(i, 1);
        inFlight--;
      }
    }

    client.update(tick * STEP, STEP);
    zonesRecues = Math.max(zonesRecues, client.zones.count);
    zonesServeur = Math.max(zonesServeur, refZones.count);

    // Comme pour les morts : on ne mesure qu'une fois tout livre. Entre la
    // pose serveur et sa livraison, le client n'est pas ralenti — un ecart du
    // au transit, pas au rejeu.
    if (inFlight === 0) {
      const drift = measureDrift(ref.horde, client.horde, entities);
      if (drift > maxDrift) {
        maxDrift = drift;
      }
    }
  }

  return { client, reference: ref.horde, maxDrift, announced, zonesRecues, zonesServeur };
}

describe('GameClient — les zones de Givre datees par tick (etape 5a, tache 6)', () => {
  const WAVE_ID = 41;
  const ENTITIES = 300;
  // Hors des frontieres de rafraichissement du champ (`STEPS_PER_FIELD` = 3) :
  // sinon un `primeFieldForReplay` qui n'ecarterait pas `atTick` vers
  // `lastDue` passerait inapercu.
  const ZONE_TICKS = [100, 113, 127];
  const ANCHORS = [50, 150, 250];
  /**
   * Un tick d'arrosage des MEMES points, au-dela de
   * `ZONE_REFRESH_INTERVAL_TICKS` : c'est ce qui produit une prolongation, et
   * donc une re-annonce. Sous l'intervalle, rien n'est prolonge ni annonce.
   */
  const REFRESH_TICKS = [(ZONE_TICKS[0] ?? 0) + ZONE_REFRESH_INTERVAL_TICKS];

  it('une ZONE livree dans la portee de l anneau converge par rejeu : derive nulle, lateZones a zero', () => {
    const DELAY = 3;
    const result = runClientZoneScenario({
      mapSeed: 0xc1e2_5a06,
      waveId: WAVE_ID,
      entities: ENTITIES,
      zoneTicks: ZONE_TICKS,
      anchors: ANCHORS,
      zoneDelayTicks: DELAY,
      ticks: 240,
      element: ELEMENT.GIVRE,
      refreshTicks: REFRESH_TICKS,
    });

    process.stdout.write(
      `[tache 6] zone dans l'anneau (delai ${DELAY}) : derive maximale ` +
        `${result.maxDrift.toFixed(3)} px, ${result.announced} zones annoncees\n`,
    );

    // Le scenario ne prouve rien si rien n'a ete annonce ni recu — et le
    // client doit tenir EXACTEMENT la meme reserve que le serveur.
    expect(result.zonesServeur).toBeGreaterThan(0);
    expect(result.zonesRecues).toBe(result.zonesServeur);
    // ⚠️ Plus d'annonces que de zones : ce sont les RAFRAICHISSEMENTS. Le
    // client ne peut pas les deriver, donc ils voyagent — sans quoi
    // sa zone mourrait avant celle du serveur.
    expect(result.announced).toBeGreaterThan(result.zonesServeur);
    expect(result.client.lateZones).toBe(0);
    expect(result.maxDrift).toBeLessThan(1);
  });

  it('le ralentissement MORD : la meme run en Braise laisse la horde plus loin', () => {
    // ⚠️ La garde anti-fixture. « 0,000 px » ne distingue pas un rejeu exact
    // d'un ralentissement qui ne s'applique a personne — il faut comparer a un
    // element dont le `slowFactor` vaut 1.
    const commun = {
      mapSeed: 0xc1e2_5a07,
      waveId: WAVE_ID,
      entities: ENTITIES,
      zoneTicks: ZONE_TICKS,
      anchors: ANCHORS,
      zoneDelayTicks: 3,
      ticks: 240,
    };
    const givre = runClientZoneScenario({ ...commun, element: ELEMENT.GIVRE });
    const braise = runClientZoneScenario({ ...commun, element: ELEMENT.BRAISE });

    const ecart = measureDrift(braise.reference, givre.reference, ENTITIES);
    process.stdout.write(`[tache 6] le Givre mord : ${ecart.toFixed(3)} px d ecart au temoin\n`);
    expect(ecart).toBeGreaterThan(1);
  });

  it('une ZONE trop vieille pour l anneau est posee au present, comptee, sans planter', () => {
    // ⚠️ La degradation est ASSUMEE mais jamais silencieuse : appliquer au
    // present, COMPTER l'evenement, ne pas pretendre que c'est exact — meme
    // regle que `lateDeaths`.
    const DELAY = ROLLBACK_DEPTH_TICKS + 4;
    expect(DELAY).toBeGreaterThan(ROLLBACK_DEPTH_TICKS);
    const result = runClientZoneScenario({
      mapSeed: 0xc1e2_5a08,
      waveId: WAVE_ID,
      entities: ENTITIES,
      zoneTicks: ZONE_TICKS,
      anchors: ANCHORS,
      zoneDelayTicks: DELAY,
      ticks: 240,
      element: ELEMENT.GIVRE,
    });

    process.stdout.write(
      `[tache 6] zone hors anneau (delai ${DELAY} > ROLLBACK_DEPTH_TICKS=${ROLLBACK_DEPTH_TICKS}) : ` +
        `derive residuelle ${result.maxDrift.toFixed(3)} px, lateZones=${result.client.lateZones}\n`,
    );

    expect(result.client.lateZones).toBe(result.announced);
    expect(result.maxDrift).toBeGreaterThan(0);
    expect(result.zonesRecues).toBe(result.zonesServeur);
  });
});

describe('GameClient — zones et morts livrees ensemble (etape 5a, tache 6)', () => {
  it('une ZONE plus ANCIENNE qu une mort livree au meme tick ne fait pas perdre la mort', () => {
    // ⚠️ **L'ordre de drainage n'est pas interchangeable.** Les deux rejouent,
    // et un rejeu REECRIT l'anneau depuis son tick de depart. Deaths d'abord,
    // puis une zone plus ancienne : la restauration au `bornTick` rend un etat
    // d'AVANT la mort, et le rejeu ecrase l'anneau avec une horde ou l'entite
    // tuee est toujours vivante — la mort disparait. Les zones passent donc
    // AVANT (voir `GameClient#drainPendingZones`).
    const WAVE_ID = 42;
    const ENTITIES = 200;
    const ZONE_TICK = 102;
    const DEATH_TICK = 105;
    const LIVRAISON = 108;
    const mapSeed = 0xc1e2_5a09;

    const ref = makeReferenceServer(mapSeed, ENTITIES);
    const refZones = new ZoneField();
    const order: WaveOrder = {
      waveId: WAVE_ID,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 1200,
      anchorY: 1200,
      count: ENTITIES,
    };
    ref.horde.spawn(order, ref.fields[0]);
    const killedIds = Array.from({ length: 20 }, (_, k) => entityIdOf(WAVE_ID, k));

    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, mapSeed) });
    socket.emit('message', { data: encodeWaveOrder(order) });

    let annonce: { kind: number; x: number; y: number; by: number } | null = null;
    for (let tick = 0; tick < 160; tick++) {
      const xs = [0, 1, 2, 3].map((p) => Math.round(3000 + Math.cos(tick * 0.02 + p) * 1500));
      const ys = [0, 1, 2, 3].map((p) => Math.round(3000 + Math.sin(tick * 0.02 + p) * 1500));
      ref.playerHistory.record(tick, xs, ys);
      if (tick % STEPS_PER_FIELD === 0) {
        const seen = ref.playerHistory.delayed(tick);
        if (seen) {
          for (let f = 0; f < 4; f++) {
            ref.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
          }
          ref.horde.retarget(seen.x, seen.y);
        }
      }
      refZones.expire(tick);
      ref.horde.step(STEP, ref.fields, tick, refZones);

      if (tick === ZONE_TICK) {
        const slot = ref.horde.slotOf(entityIdOf(WAVE_ID, ENTITIES - 1));
        refZones.spawn(
          ELEMENT.GIVRE,
          Math.round(ref.horde.x[slot] ?? 0),
          Math.round(ref.horde.y[slot] ?? 0),
          1,
          tick,
        );
        annonce = { kind: ELEMENT.GIVRE, x: refZones.x[0] ?? 0, y: refZones.y[0] ?? 0, by: 1 };
      }
      if (tick === DEATH_TICK) {
        ref.horde.kill(killedIds);
      }

      const players = xs.map((x, i) => ({
        id: i,
        x,
        y: ys[i] ?? 0,
        hp: 100,
        aimX: 0,
        aimY: 0,
        pickupRadius: ORB_PICKUP_RADIUS,
        shield: 0,
      }));
      socket.emit('message', { data: encodeSnapshot(tick, 0, 0, players) });

      if (tick === LIVRAISON && annonce) {
        // ⚠️ Dans l'ordre du serveur : `DEATHS` part AVANT `ZONE` dans le meme
        // lot de diffusion (voir `Server#broadcast`). C'est precisement ce
        // qui rend le drainage inverse dangereux.
        socket.emit('message', { data: encodeDeaths(DEATH_TICK, killedIds) });
        socket.emit('message', {
          data: encodeZone(annonce.kind, annonce.x, annonce.y, ZONE_TICK, annonce.by),
        });
      }

      client.update(tick * STEP, STEP);
    }

    expect(annonce).not.toBeNull();
    expect(ref.horde.count).toBe(ENTITIES - killedIds.length);
    expect(client.lateDeaths).toBe(0);
    expect(client.lateZones).toBe(0);
    // La mort n'a pas ete perdue par le rejeu de la zone.
    expect(client.horde.count).toBe(ref.horde.count);
    expect(aliveWaveIndices(client.horde)).toEqual(aliveWaveIndices(ref.horde));
    expect(measureDrift(ref.horde, client.horde, ENTITIES)).toBeLessThan(1);
  });
});

describe('GameClient — une zone qui meurt PENDANT un rejeu (etape 5a, tache 6)', () => {
  /**
   * ⚠️ **`HordeHistory` ne sauvegarde QUE la horde, jamais les zones.** Un
   * rejeu qui repart d'un tick ou une zone vivait encore doit pouvoir la
   * retrouver — or une zone retiree du tableau est irrecuperable. Le client
   * expire donc `ROLLBACK_DEPTH_TICKS` ticks EN RETARD, et c'est
   * `ZoneField.slowsAt` (jamais la presence dans le tableau) qui decide si
   * elle agit.
   *
   * Sans cette marge, la mutation « le client expire a l'heure » ne fait
   * rougir AUCUN autre test de ce fichier : les zones des autres scenarios
   * meurent longtemps apres le dernier rejeu. Il faut donc un scenario ou la
   * fenetre de rejeu ENJAMBE la peremption d'une zone.
   */
  it('reste identique au serveur quand le rejeu enjambe la peremption d une zone', () => {
    const WAVE_ID = 43;
    const ENTITIES = 200;
    const mapSeed = 0xc1e2_5a0a;
    const SUIVI = entityIdOf(WAVE_ID, ENTITIES - 1);
    const order: WaveOrder = {
      waveId: WAVE_ID,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 1200,
      anchorY: 1200,
      count: ENTITIES,
    };
    const xsAt = (tick: number) =>
      [0, 1, 2, 3].map((p) => Math.round(3000 + Math.cos(tick * 0.02 + p) * 1500));
    const ysAt = (tick: number) =>
      [0, 1, 2, 3].map((p) => Math.round(3000 + Math.sin(tick * 0.02 + p) * 1500));

    /** Fait tourner une reference seule et rend la position de `SUIVI` au tick voulu. */
    function positionAu(tick: number): { x: number; y: number } {
      const ref = makeReferenceServer(mapSeed, ENTITIES);
      ref.horde.spawn(order, ref.fields[0]);
      for (let t = 0; t <= tick; t++) {
        ref.playerHistory.record(t, xsAt(t), ysAt(t));
        if (t % STEPS_PER_FIELD === 0) {
          const seen = ref.playerHistory.delayed(t);
          if (seen) {
            for (let f = 0; f < 4; f++) {
              ref.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
            }
            ref.horde.retarget(seen.x, seen.y);
          }
        }
        ref.horde.step(STEP, ref.fields, t);
      }
      const slot = ref.horde.slotOf(SUIVI);
      return { x: Math.round(ref.horde.x[slot] ?? 0), y: Math.round(ref.horde.y[slot] ?? 0) };
    }

    // La zone A doit couvrir la horde AU MOMENT de sa peremption : elle est
    // donc posee la ou la horde SERA, avec un `bornTick` retroactif calcule
    // depuis la constante de duree de vie — jamais un nombre recopie.
    const PASSAGE = 187;
    const ZONE_A_BORN = PASSAGE + 1 - ZONE_LIFETIME_TICKS;
    // Verifie que la fenetre est bien celle qu'on croit : la zone A vit encore
    // au tick `PASSAGE` et plus au suivant.
    expect(PASSAGE - ZONE_A_BORN).toBe(ZONE_LIFETIME_TICKS - 1);
    const P = positionAu(PASSAGE);

    // La zone B ne sert qu'a DECLENCHER un rejeu qui enjambe la peremption de
    // A. Posee tres loin, elle ne ralentit personne.
    const ZONE_B_BORN = PASSAGE - 1;
    const LIVRAISON_B = ZONE_B_BORN + 4;
    expect(LIVRAISON_B - ZONE_B_BORN).toBeLessThan(ROLLBACK_DEPTH_TICKS);

    const ref = makeReferenceServer(mapSeed, ENTITIES);
    const refZones = new ZoneField();
    ref.horde.spawn(order, ref.fields[0]);

    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, mapSeed) });
    socket.emit('message', { data: encodeWaveOrder(order) });

    let maxDrift = 0;
    let ralentiAuPassage = false;
    for (let tick = 0; tick <= LIVRAISON_B + 20; tick++) {
      const xs = xsAt(tick);
      const ys = ysAt(tick);
      ref.playerHistory.record(tick, xs, ys);
      if (tick % STEPS_PER_FIELD === 0) {
        const seen = ref.playerHistory.delayed(tick);
        if (seen) {
          for (let f = 0; f < 4; f++) {
            ref.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
          }
          ref.horde.retarget(seen.x, seen.y);
        }
      }
      refZones.expire(tick);
      if (tick === ZONE_A_BORN) {
        refZones.spawn(ELEMENT.GIVRE, P.x, P.y, 1, tick);
      }
      if (tick === ZONE_B_BORN) {
        refZones.spawn(ELEMENT.GIVRE, 5500, 5500, 1, tick);
      }
      ref.horde.step(STEP, ref.fields, tick, refZones);

      // Preuve que le scenario met bien quelque chose en scene : la zone A
      // couvre reellement `SUIVI` au tick ou elle expire.
      if (tick === PASSAGE) {
        const slot = ref.horde.slotOf(SUIVI);
        const dx = (ref.horde.x[slot] ?? 0) - P.x;
        const dy = (ref.horde.y[slot] ?? 0) - P.y;
        ralentiAuPassage = dx * dx + dy * dy < ZONE_RADIUS * ZONE_RADIUS;
      }

      const players = xs.map((x, i) => ({
        id: i,
        x,
        y: ys[i] ?? 0,
        hp: 100,
        aimX: 0,
        aimY: 0,
        pickupRadius: ORB_PICKUP_RADIUS,
        shield: 0,
      }));
      socket.emit('message', { data: encodeSnapshot(tick, 0, 0, players) });

      // La zone A est livree tot (elle doit vivre chez le client pendant tout
      // son age) ; la zone B, elle, arrive en retard et declenche le rejeu.
      if (tick === ZONE_A_BORN + 2) {
        socket.emit('message', { data: encodeZone(ELEMENT.GIVRE, P.x, P.y, ZONE_A_BORN, 1) });
      }
      if (tick === LIVRAISON_B) {
        socket.emit('message', { data: encodeZone(ELEMENT.GIVRE, 5500, 5500, ZONE_B_BORN, 1) });
      }

      client.update(tick * STEP, STEP);
      if (tick > LIVRAISON_B) {
        maxDrift = Math.max(maxDrift, measureDrift(ref.horde, client.horde, ENTITIES));
      }
    }

    process.stdout.write(
      `[tache 6] rejeu enjambant la peremption d une zone : derive ${maxDrift.toFixed(3)} px\n`,
    );

    expect(ralentiAuPassage).toBe(true);
    expect(client.lateZones).toBe(0);
    expect(maxDrift).toBeLessThan(0.001);
  });
});

/**
 * ---------------------------------------------------------------------------
 * Ce que le client RECOIT et ce qu'il APPROXIME.
 * ---------------------------------------------------------------------------
 *
 * Deux regimes :
 *
 * | Ce qui est montre | D'ou ca vient | Ce qui se passe si c'est faux |
 * | --- | --- | --- |
 * | le flash de reaction | ANNONCE (`REACTION`) | on dessine une mort qui n'a pas eu lieu |
 * | la barre de Synergie | ANNONCEE (`SNAPSHOT`) | on ment sur une ressource d'equipe |
 * | la teinte d'un ennemi | APPROXIMEE localement | rien — voir `GameClient#markLocally` |
 */

/** Fait naitre un unique monstre et rend sa position REELLE — voir la doc de `setupWithOneMonster`. */
function setupOneMonster(
  mapSeed: number,
  waveId: number,
  readAim: () => InputAxes = () => ({ x: 0, y: 0 }),
): { client: GameClient; socket: FakeSocket; monsterX: number; monsterY: number } {
  const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn(), undefined, readAim);
  client.connect();
  const socket = latestSocket();
  socket.emit('message', { data: encodeWelcome(1, 0, mapSeed) });
  socket.emit('message', {
    data: encodeWaveOrder({
      waveId,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 3000,
      anchorY: 3000,
      count: 1,
    }),
  });
  socket.emit('message', {
    data: encodeSnapshot(0, 0, 0, [
      { id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS, shield: 0 },
    ]),
  });
  client.update(0, 1 / TICK_HZ);
  if (client.horde.count !== 1) {
    throw new Error(`amorce du test : horde.count=${client.horde.count}, attendu 1`);
  }
  return { client, socket, monsterX: client.horde.x[0] ?? 0, monsterY: client.horde.y[0] ?? 0 };
}

describe('GameClient — la reaction annoncee (tache 9)', () => {
  const PAIR = packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fait naitre un flash a l endroit annonce, avec son couple d elements et son bit de Synergie', () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0) });

    socket.emit('message', { data: encodeReaction(PAIR, 1234, -567, 42, true) });

    expect(client.reactionFlashes.count).toBe(1);
    expect(client.reactionFlashes.x[0]).toBe(1234);
    expect(client.reactionFlashes.y[0]).toBe(-567);
    expect(client.reactionFlashes.pair[0]).toBe(PAIR);
    expect(client.reactionFlashes.charged[0]).toBe(1);
  });

  it('distingue une reaction SOLO d une reaction chargee — le bit vient du serveur, pas d un calcul local', () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0) });

    socket.emit('message', { data: encodeReaction(PAIR, 10, 10, 1, false) });

    expect(client.reactionFlashes.charged[0]).toBe(0);
  });

  it('ne tue personne : une reaction est un DESSIN cote client, les morts arrivent par DEATHS', () => {
    // ⚠️ La reaction TUE cote serveur (`REACTION_DAMAGE`), et c'est
    // precisement pourquoi elle est arbitree la-bas. Un client qui appliquerait
    // les degats ici prononcerait une mort que le serveur n'a pas prononcee.
    const { client, socket, monsterX, monsterY } = setupOneMonster(0xf1a5_0001, 90);
    const avant = client.horde.count;

    socket.emit('message', { data: encodeReaction(PAIR, monsterX, monsterY, 1, true) });
    client.update(1000, 1 / TICK_HZ);

    expect(client.horde.count).toBe(avant);
  });

  it('un flash de reaction expire apres REACTION_FLASH_LIFETIME_MS, jamais avant (deux bornes)', () => {
    const NAISSANCE = 5_000;
    vi.spyOn(performance, 'now').mockReturnValue(NAISSANCE);

    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0) });
    socket.emit('message', { data: encodeReaction(PAIR, 0, 0, 1, true) });

    expect(client.reactionFlashes.count).toBe(1);

    // Encore la juste avant l'echeance.
    client.update(NAISSANCE + REACTION_FLASH_LIFETIME_MS - 1, 1 / TICK_HZ);
    expect(client.reactionFlashes.count).toBe(1);

    // Disparu pile a l'echeance, pas une image plus tard.
    client.update(NAISSANCE + REACTION_FLASH_LIFETIME_MS, 1 / TICK_HZ);
    expect(client.reactionFlashes.count).toBe(0);
  });

  it(
    'dure plus longtemps qu un flash d impact : « l etat persistant est discret, ' +
      'la reaction est spectaculaire » (§6.6)',
    () => {
      // Un flash d'impact accompagne CHAQUE projectile qui touche — des
      // dizaines par seconde ; une reaction est rare et elle tue. Les deux
      // durees egales, les deux evenements se confondraient et le budget VFX
      // repartirait en bruit de fond.
      expect(REACTION_FLASH_LIFETIME_MS).toBeGreaterThan(HIT_FLASH_LIFETIME_MS);
    },
  );
});

describe('GameClient — la barre de Synergie (tache 9)', () => {
  it('reprend le total du dernier snapshot, dans le RenderState comme dans le getter', () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0) });
    socket.emit('message', {
      data: encodeSnapshot(0, 777, 13, [
        {
          id: 1,
          x: 10,
          y: 20,
          hp: 42,
          aimX: 0,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 0,
        },
      ]),
    });

    const state = client.update(0, 0);

    // ⚠️ **13, et surtout pas la meme valeur que l'xp.** Le snapshot porte les
    // deux nombres d'equipe cote a cote dans son en-tete : un test qui leur
    // donnerait la meme valeur passerait avec un decodeur qui les intervertit.
    expect(state.synergy).toBe(13);
    expect(state.xp).toBe(777);
    expect(client.synergy).toBe(13);
  });

  it('vaut zero tant qu aucun snapshot n est arrive', () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    latestSocket().emit('message', { data: encodeWelcome(1, 0, 0) });

    expect(client.synergy).toBe(0);
  });

  it('ne se DEDUIT pas des REACTION recues : le total fait foi, le client ne recompte rien', () => {
    // ⚠️ Le bit porte la COMPARAISON, le total voyage dans le `SNAPSHOT`. Un
    // client qui incrementerait sa propre barre a
    // chaque reaction chargee divergerait de l'autorite des la premiere
    // reaction manquee (connexion en cours de partie, plafond atteint).
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0) });
    socket.emit('message', {
      data: encodeSnapshot(0, 0, 4, [
        {
          id: 1,
          x: 0,
          y: 0,
          hp: 100,
          aimX: 0,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 0,
        },
      ]),
    });

    for (let i = 0; i < 5; i++) {
      socket.emit('message', {
        data: encodeReaction(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE), 0, 0, i, true),
      });
    }

    expect(client.synergy).toBe(4);
  });
});

/**
 * La teinte elementaire est **cosmetique et approximee** : voir la doc de
 * `GameClient#markLocally`, qui porte la regle en entier.
 *
 * ⚠️ **Les deux moities, toujours** : « aucun ennemi n'est jamais
 * teinte » et « tous les ennemis sont teints tout le temps » se ressemblent
 * beaucoup dans un test faible. Chaque cas positif ci-dessous a donc son
 * negatif.
 */
describe('GameClient — la teinte elementaire, cosmetique et approximee (tache 9)', () => {
  it('une zone annoncee teint les ennemis qu elle couvre, de SON element', () => {
    const { client, socket, monsterX, monsterY } = setupOneMonster(0xf1a5_0002, 91);
    expect(client.horde.markAt(0, 1)).toBe(ELEMENT.NEUTRE);

    socket.emit('message', { data: encodeZone(ELEMENT.GIVRE, monsterX, monsterY, 1, 2) });
    // Deux images : la premiere pose la zone (les zones se drainent en FIN de
    // tick), la seconde la balaie.
    client.update(1000, 1 / TICK_HZ);
    client.update(2000, 1 / TICK_HZ);

    expect(client.horde.markAt(0, client.hordeTick - 1)).toBe(ELEMENT.GIVRE);
  });

  /**
   * ⚠️ **`GameClient#markInZones` (le miroir cosmetique) doit decoder
   * `zones.kind`, jamais le lire brut.** Le serveur
   * envoie deja l'octet EMPAQUETE sur le fil ; un client qui marquerait avec
   * l'octet complet stockerait un `mark` different de `ELEMENT.GIVRE`, que ce
   * test attrape directement par egalite — pas besoin de lever pour le voir.
   * `kind !== element` : le decor empaquette une reaction non nulle.
   */
  it('une zone annoncee avec un type de reaction empaquete teint quand meme du bon element DECODE', () => {
    const { client, socket, monsterX, monsterY } = setupOneMonster(0xf1a5_0009, 96);
    const kind = packZoneKind(ELEMENT.GIVRE, 7);
    expect(kind).not.toBe(ELEMENT.GIVRE);

    socket.emit('message', { data: encodeZone(kind, monsterX, monsterY, 1, 2) });
    client.update(1000, 1 / TICK_HZ);
    client.update(2000, 1 / TICK_HZ);

    expect(client.horde.markAt(0, client.hordeTick - 1)).toBe(ELEMENT.GIVRE);
  });

  it('une zone LOIN des ennemis n en teint aucun', () => {
    const { client, socket, monsterX, monsterY } = setupOneMonster(0xf1a5_0003, 92);

    // 10 x `ZONE_RADIUS` : hors de portee, quoi qu'ait bouge le monstre.
    socket.emit('message', {
      data: encodeZone(ELEMENT.GIVRE, monsterX + 10 * ZONE_RADIUS, monsterY, 1, 2),
    });
    client.update(1000, 1 / TICK_HZ);
    client.update(2000, 1 / TICK_HZ);

    expect(client.horde.markAt(0, client.hordeTick - 1)).toBe(ELEMENT.NEUTRE);
  });

  it('un projectile ELEMENTAIRE du joueur local teint l ennemi qu il touche', () => {
    // Arme a dispersion etroite QUI TIRE : la seule qui touche a coup sur une
    // cible isolee. Choisie par ses proprietes, jamais par un identifiant en
    // dur — le catalogue est du contenu, il bouge.
    //
    // ⚠️ **`kind === 'tir'`** : un faisceau ne pose aucun projectile. Sans ce
    // filtre, ce cas pourrait choisir une arme qui ne tire rien et echouer
    // pour une raison sans rapport avec ce qu'il garde.
    const arme = WEAPONS.find(
      (w) => w.kind === 'tir' && w.element !== ELEMENT.NEUTRE && w.spreadRadians < 0.3,
    );
    if (!arme) {
      throw new Error('aucune arme elementaire a dispersion etroite dans le catalogue');
    }

    const { client, socket, monsterX, monsterY } = setupOneMonster(0xf1a5_0004, 93, () => ({
      x: 1,
      y: 0,
    }));

    // Le chemin REEL d'acquisition d'une arme : l'etalage puis son resultat.
    // Echeance a 0 pour ne rien geler — le gel bloquerait le tir.
    socket.emit('message', {
      data: encodeDraftOpen(0, [{ nature: CARD.WEAPON, refId: arme.id }]),
    });
    socket.emit('message', {
      data: encodeDraftResult(0, [{ playerId: 1, cardIndex: 0, outcome: OUTCOME.WON }]),
    });
    expect(client.loadoutOf(1).weaponIds).toContain(arme.id);

    const perTickTravel = arme.projectileSpeed / TICK_HZ;
    const offset = Math.round(perTickTravel * 3 + PROJECTILE_HIT_RADIUS);
    const PLAYER = { x: monsterX - offset, y: monsterY };

    let marque: number = ELEMENT.NEUTRE;
    for (let tick = 1; tick <= 40 && marque === ELEMENT.NEUTRE; tick++) {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [
          {
            id: 1,
            ...PLAYER,
            hp: 100,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });
      client.update(tick * (1000 / TICK_HZ), 1 / TICK_HZ);
      marque = client.horde.markAt(0, client.hordeTick - 1);
    }

    // L'element de CETTE arme, pas un element ecrit en dur : c'est la marque
    // du tir qu'on vient de choisir.
    expect(marque).toBe(arme.element);
  });

  it('une arme NEUTRE n efface pas la marque d un autre element', () => {
    // ⚠️ C'est le seul effet OBSERVABLE de la garde `element !== NEUTRE` du
    // rappel de collision : poser une marque neutre sur un ennemi non marque
    // ne se verrait pas (0xffffff est deja l'identite), mais l'EFFACEMENT
    // d'une marque de Braise par un coup de dague, si. Le serveur porte la
    // meme garde, au meme endroit (`resolveProjectileDamage`).
    const { client, socket, monsterX, monsterY } = setupOneMonster(0xf1a5_0005, 94, () => ({
      x: 1,
      y: 0,
    }));
    // L'arme de base est neutre : c'est elle, et elle seule, qui va toucher.
    expect(weaponOf(BASE_WEAPON_ID).element).toBe(ELEMENT.NEUTRE);

    client.horde.applyMark(0, ELEMENT.BRAISE, 2, client.hordeTick);
    const PLAYER = { x: monsterX - 20, y: monsterY };

    let touche = false;
    for (let tick = 1; tick <= 20 && !touche; tick++) {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [
          {
            id: 1,
            ...PLAYER,
            hp: 100,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });
      client.update(tick * (1000 / TICK_HZ), 1 / TICK_HZ);
      touche = client.hitFlashes.count > 0;
    }

    expect(touche).toBe(true);
    expect(client.horde.markAt(0, client.hordeTick - 1)).toBe(ELEMENT.BRAISE);
  });
});

/**
 * ⚠️ **Garde la mutation « retirer le `aliveAt` du balayage de zones »**, que
 * rien d'autre ne voit. Le client expire ses zones `ROLLBACK_DEPTH_TICKS`
 * ticks EN RETARD (pour rejouer), donc une zone perimee reste dans le
 * tableau. Sans `aliveAt`, elle continue d'y teindre, et l'ecart ne se voit
 * qu'a la toute fin de la teinte (`MARK_DURATION_TICKS` plus tard).
 *
 * Le decor doit donc tenir un ennemi DANS une zone pendant toute la vie de
 * celle-ci, puis observer les deux bornes de l'extinction. Le joueur est place
 * sur l'ennemi : au contact, la horde s'arrete (`Horde.stopped`), donc l'ennemi
 * ne quitte pas le disque — ce que la derniere assertion verifie plutot que de
 * le supposer.
 */
describe('GameClient — la teinte s eteint quand la ZONE meurt, pas quand le tableau se vide', () => {
  it('la teinte tient MARK_DURATION_TICKS apres le DERNIER tick de vie de la zone, pas huit de plus', () => {
    const { client, socket, monsterX, monsterY } = setupOneMonster(0xf1a5_0006, 95);
    const NAISSANCE = 1;
    const DERNIER_TICK_VIVANT = NAISSANCE + ZONE_LIFETIME_TICKS - 1;
    const EXTINCTION = DERNIER_TICK_VIVANT + MARK_DURATION_TICKS;

    socket.emit('message', {
      data: encodeZone(ELEMENT.GIVRE, monsterX, monsterY, NAISSANCE, 2),
    });

    let teinteAvant: number = ELEMENT.NEUTRE;
    let teinteApres: number = ELEMENT.BRAISE;
    for (let tick = 1; tick <= EXTINCTION + 4; tick++) {
      // Le joueur pose sur le monstre : il s'arrete au contact et reste dans
      // le disque.
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [
          {
            id: 1,
            x: monsterX,
            y: monsterY,
            hp: 100,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });
      client.update(tick * (1000 / TICK_HZ), 1 / TICK_HZ);
      if (tick === EXTINCTION - 1) {
        teinteAvant = client.horde.markAt(0, EXTINCTION - 1);
      }
      if (tick === EXTINCTION) {
        teinteApres = client.horde.markAt(0, EXTINCTION);
      }
    }

    // ⚠️ Le decor tient-il vraiment ? Un monstre qui aurait quitte le disque
    // avant la mort de la zone ferait passer la seconde assertion pour une
    // bonne raison et la premiere pour une mauvaise.
    const dx = (client.horde.x[0] ?? 0) - monsterX;
    const dy = (client.horde.y[0] ?? 0) - monsterY;
    expect(Math.hypot(dx, dy)).toBeLessThan(ZONE_RADIUS);

    expect(teinteAvant).toBe(ELEMENT.GIVRE);
    expect(teinteApres).toBe(ELEMENT.NEUTRE);
  });
});

/**
 * **La charge du boss, cote client.**
 *
 * ⚠️ **Une charge DEPLACE le boss** : comme le ralentissement du Givre, elle
 * est annoncee une fois, datee par tick, appliquee par rejeu. Ce decor est le
 * pendant client du scenario 11 de `shared/horde.replication.test.ts` : un
 * serveur de reference, un vrai `GameClient` derriere une socket, et la charge
 * livree avec du retard.
 */
describe('GameClient — la charge du boss datee par tick (etape 6a, tache 5 bis)', () => {
  const WAVE_ID = 43;
  const ENTITIES = 200;
  /**
   * Hors des frontieres de rafraichissement du champ (`STEPS_PER_FIELD` = 3) :
   * sinon un `primeFieldForReplay` qui n'ecarterait pas `atTick` vers
   * `lastDue` passerait inapercu.
   */
  const CHARGE_TICK = 100;
  const BOSS_INDEX = 77;

  function scenario(delayTicks: number): {
    client: GameClient;
    maxDrift: number;
    reference: Horde;
  } {
    const mapSeed = 0xc1e2_6a05;
    const ref = makeReferenceServer(mapSeed, ENTITIES);
    const order: WaveOrder = {
      waveId: WAVE_ID,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 1200,
      anchorY: 1200,
      count: ENTITIES,
    };
    ref.horde.spawn(order, ref.fields[0]);

    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, mapSeed) });
    socket.emit('message', { data: encodeWaveOrder(order) });

    const bossId = entityIdOf(WAVE_ID, BOSS_INDEX);
    let charge: BossCharge | null = null;
    let inFlight = false;
    let maxDrift = 0;

    for (let tick = 0; tick < 200; tick++) {
      const xs = [0, 1, 2, 3].map((p) => Math.round(3000 + Math.cos(tick * 0.02 + p) * 1500));
      const ys = [0, 1, 2, 3].map((p) => Math.round(3000 + Math.sin(tick * 0.02 + p) * 1500));

      ref.playerHistory.record(tick, xs, ys);
      if (tick % STEPS_PER_FIELD === 0) {
        const seen = ref.playerHistory.delayed(tick);
        if (seen) {
          for (let f = 0; f < 4; f++) {
            ref.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
          }
          ref.horde.retarget(seen.x, seen.y);
        }
      }
      ref.horde.step(STEP, ref.fields, tick, undefined, charge);

      // Le serveur annonce APRES avoir fait avancer sa horde, comme `Room.step`.
      if (tick === CHARGE_TICK) {
        const slot = ref.horde.slotOf(bossId);
        charge = makeBossCharge(
          bossId,
          ref.horde.x[slot] ?? 0,
          ref.horde.y[slot] ?? 0,
          xs[0] ?? 0,
          ys[0] ?? 0,
          tick,
        );
        inFlight = true;
      }

      const players = xs.map((x, i) => ({
        id: i,
        x,
        y: ys[i] ?? 0,
        hp: 100,
        aimX: 0,
        aimY: 0,
        pickupRadius: ORB_PICKUP_RADIUS,
        shield: 0,
      }));
      socket.emit('message', { data: encodeSnapshot(tick, 0, 0, players) });

      if (charge && tick === charge.windupTick + delayTicks) {
        socket.emit('message', { data: encodeBossCharge(charge) });
        inFlight = false;
      }

      client.update(tick * STEP, STEP);

      // Comme pour les zones : on ne mesure qu'une fois l'annonce livree. Entre
      // l'annonce serveur et sa reception, le client ne peut rien corriger.
      if (!inFlight) {
        const drift = measureDrift(ref.horde, client.horde, ENTITIES);
        if (drift > maxDrift) {
          maxDrift = drift;
        }
      }
    }

    return { client, maxDrift, reference: ref.horde };
  }

  /**
   * ⚠️ Le message arrive trois ticks apres
   * le `windupTick` ; le client restaure sa horde a ce tick, installe la charge
   * et rejoue. Zero, pas « petit ».
   */
  it('une charge livree dans la portee de l anneau converge par rejeu : derive nulle', () => {
    const DELAY = 3;
    const { client, maxDrift } = scenario(DELAY);

    process.stdout.write(
      `[tache 5 bis] charge dans l'anneau (delai ${DELAY}) : derive maximale ${maxDrift.toFixed(3)} px\n`,
    );

    expect(client.bossCharge).not.toBeNull();
    expect(client.lateCharges).toBe(0);
    expect(maxDrift).toBe(0);
  });

  /**
   * ⚠️ **Hors de l'anneau, on applique quand meme — et on COMPTE.** Meme
   * degradation assumee que pour une mort ou une zone trop vieille : une
   * degradation silencieuse est un piege.
   */
  it('une charge livree hors de l anneau est installee au present, et signalee', () => {
    const DELAY = ROLLBACK_DEPTH_TICKS + 4;
    const { client, maxDrift } = scenario(DELAY);

    process.stdout.write(
      `[tache 5 bis] charge hors anneau (delai ${DELAY} > ROLLBACK_DEPTH_TICKS=${ROLLBACK_DEPTH_TICKS}) : ` +
        `derive residuelle ${maxDrift.toFixed(3)} px, lateCharges=${client.lateCharges}\n`,
    );

    expect(client.lateCharges).toBe(1);
    expect(client.bossCharge).not.toBeNull();
  });

  /**
   * ⚠️ **C'est le RENDU que ca protege.** Le boss mort n'est plus dans la horde,
   * donc plus rien ne le deplace ; mais le rectangle d'annonce, lui,
   * continuerait de s'afficher au-dessus d'un boss qui n'existe plus.
   */
  it('oublie la charge quand le boss meurt en pleine traversee', () => {
    const { client } = scenario(3);
    const charge = client.bossCharge;
    expect(charge).not.toBeNull();

    latestSocket().emit('message', {
      data: encodeDeaths(client.hordeTick, [charge?.entityId ?? 0]),
    });
    client.update(0, STEP);

    expect(client.bossCharge).toBeNull();
  });

  /** Une mort qui ne concerne pas le boss laisse sa charge intacte. */
  it('garde la charge quand c est une autre entite qui meurt', () => {
    const { client } = scenario(3);
    expect(client.bossCharge).not.toBeNull();

    latestSocket().emit('message', {
      data: encodeDeaths(client.hordeTick, [entityIdOf(WAVE_ID, BOSS_INDEX + 1)]),
    });
    client.update(0, STEP);

    expect(client.bossCharge).not.toBeNull();
  });
});

/**
 * Le vote d'extraction, cote reception.
 *
 * ⚠️ **Le client ne DECIDE rien ici** : il expose ce qu'il
 * recoit et il envoie une intention. Le seul calcul qu'il fasse est celui du
 * chronometre, et il le fait au TICK.
 */
describe('GameClient — le vote d extraction (etape 6a, tache 10)', () => {
  /**
   * ⚠️ **Des nombres qui ne ressemblent a rien du jeu.** Ni
   * `PORTAL_WINDOW_TICKS` (600), ni `GOLD_PER_PALIER_BASE` (100), ni un
   * multiple de l'un ou de l'autre : une fixture egale a une constante de
   * production masquerait une constante codee en dur.
   */
  const ECHEANCE = 4_137;
  const MULTIPLICATEUR = 1.75;
  const CAGNOTTE = 8_413;

  function setup(localId = 2): { client: GameClient; socket: FakeSocket } {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(localId, 0, 0xd8a5_0002) });
    return { client, socket };
  }

  /**
   * Pose le tick de horde a `tick` en poussant un snapshot vide qui le porte.
   *
   * ⚠️ **Chaque appel doit sauter de plus d'un tick.** `GameClient` ne se
   * recale que si le snapshot le devance de plus de `HORDE_TICK_LAG_TOLERANCE`
   * (1) — un snapshot a `t + 1` ne bouge PAS le compteur, et un decor qui
   * avancerait d'un tick a la fois testerait un tick fige sans le dire.
   */
  function auTick(socket: FakeSocket, tick: number, gold = 0): void {
    socket.emit('message', { data: encodeSnapshot(tick, 0, 0, [], null, gold) });
  }

  it('ignore le portail tant qu aucune ouverture n est arrivee', () => {
    // ⚠️ **Le test qui rend zero, evite ici.** Un scenario qui fermerait un
    // vote jamais ouvert passerait tout seul : on assene donc l'etat de depart
    // avant tout, et chaque scenario ci-dessous part d'un portail REELLEMENT
    // ouvert.
    const { client, socket } = setup();
    auTick(socket, 900);

    expect(client.portalOpen).toBe(false);
    expect(client.portalVotes.size).toBe(0);
    expect(client.portalDecision).toBeNull();
  });

  it('ouvre le vote sur PORTAL_OPEN, avec son echeance ET le multiplicateur ANNONCE', () => {
    const { client, socket } = setup();
    auTick(socket, 900);
    // Le multiplicateur de depart vaut 1 cote salon : un client qui le coderait
    // en dur, ou qui compterait les portails vus (zero, pour qui se connecte en
    // cours de run), passerait un decor a 1 et echouerait ici.
    socket.emit('message', { data: encodePortalOpen(ECHEANCE, MULTIPLICATEUR) });

    expect(client.portalOpen).toBe(true);
    expect(client.portalDeadlineTick).toBe(ECHEANCE);
    expect(client.portalMultiplier).toBe(MULTIPLICATEUR);
  });

  it('expose les votes des autres, ET l abstention, telle quelle', () => {
    // ⚠️ **Le decor doit produire le cas qu'il pretend creer** : les TROIS
    // etats a la fois. Deux votants seulement, ou deux etats sur trois,
    // laisseraient passer un client qui confondrait « n'a pas vote » et
    // « reste » — c'est exactement ce que `NO_VOTE = 255` existe pour eviter.
    const { client, socket } = setup();
    auTick(socket, 900);
    socket.emit('message', { data: encodePortalOpen(ECHEANCE, MULTIPLICATEUR) });
    socket.emit('message', {
      data: encodeVotes([
        { playerId: 1, choice: VOTE_CHOICE.LEAVE },
        { playerId: 2, choice: VOTE_CHOICE.STAY },
        { playerId: 3, choice: NO_VOTE },
      ]),
    });

    expect(client.portalVotes.get(1)).toBe(VOTE_CHOICE.LEAVE);
    expect(client.portalVotes.get(2)).toBe(VOTE_CHOICE.STAY);
    // ⚠️ `toBe(NO_VOTE)`, pas `toBeUndefined()` : un client qui filtrerait les
    // abstentions rendrait `undefined` ici, et l'ecran ne pourrait plus
    // distinguer un silencieux d'un joueur absent du salon.
    expect(client.portalVotes.get(3)).toBe(NO_VOTE);
    expect(client.portalVotes.size).toBe(3);
  });

  it('remplace la table de votes a chaque VOTES, sans garder les voix perimees', () => {
    // Le vote est REVOCABLE : une diffusion qui fusionnerait au lieu de
    // remplacer laisserait une voix retiree affichee jusqu'a la fin.
    const { client, socket } = setup();
    auTick(socket, 900);
    socket.emit('message', { data: encodePortalOpen(ECHEANCE, MULTIPLICATEUR) });
    socket.emit('message', {
      data: encodeVotes([{ playerId: 1, choice: VOTE_CHOICE.LEAVE }]),
    });
    socket.emit('message', {
      data: encodeVotes([{ playerId: 1, choice: NO_VOTE }]),
    });

    expect(client.portalVotes.get(1)).toBe(NO_VOTE);
  });

  it('envoie un VOTE portant le choix, et n enregistre RIEN localement', () => {
    // ⚠️ **Le client PROPOSE, le serveur arbitre.** Un vote affiche des
    // le clic mentirait a chaque refus — portail ferme, joueur etranger au
    // vote — et le joueur croirait avoir vote.
    const { client, socket } = setup();
    auTick(socket, 900);
    socket.emit('message', { data: encodePortalOpen(ECHEANCE, MULTIPLICATEUR) });

    client.castVote(VOTE_CHOICE.LEAVE);

    const votes = socket.sent.map((f) => decode(f)).filter((m) => m.type === MSG.VOTE);
    expect(votes).toEqual([{ type: MSG.VOTE, choice: VOTE_CHOICE.LEAVE }]);
    expect(client.portalVotes.size).toBe(0);
  });

  it('envoie NO_VOTE quand on retire sa voix — le vote est revocable', () => {
    const { client, socket } = setup();
    auTick(socket, 900);
    socket.emit('message', { data: encodePortalOpen(ECHEANCE, MULTIPLICATEUR) });

    client.castVote(NO_VOTE);

    const votes = socket.sent.map((f) => decode(f)).filter((m) => m.type === MSG.VOTE);
    expect(votes).toEqual([{ type: MSG.VOTE, choice: NO_VOTE }]);
  });

  /**
   * ⚠️ **DATE PAR TICK, JAMAIS APPLIQUE A LA RECEPTION** : un ecran ferme a
   * l'arrivee du message se fermerait chez chacun a un tick different, celui
   * de sa propre latence.
   *
   * L'ecart du decor (huit ticks) n'est pas decoratif : c'est lui qui rend la
   * mutation « fermer a la reception » visible.
   */
  it('garde l ecran ouvert jusqu au TICK D EFFET du verdict, pas jusqu a sa reception', () => {
    const { client, socket } = setup();
    auTick(socket, 900);
    socket.emit('message', { data: encodePortalOpen(ECHEANCE, MULTIPLICATEUR) });

    const effet = 912;
    socket.emit('message', {
      data: encodePortalResult(effet, VOTE_CHOICE.STAY, CAGNOTTE),
    });

    // Le message est arrive, le tick d'effet n'est pas atteint : l'ecran tient.
    expect(client.hordeTick).toBe(900);
    expect(client.portalOpen).toBe(true);
    // Le verdict, lui, est deja lisible : c'est ce que l'ecran affiche pendant
    // ces quelques ticks.
    expect(client.portalDecision).toBe(VOTE_CHOICE.STAY);
    expect(client.portalGold).toBe(CAGNOTTE);

    // Un tick AVANT l'effet : toujours ouvert. C'est cette ligne qui tue la
    // mutation « fermer des reception ».
    auTick(socket, effet - 3);
    expect(client.hordeTick).toBe(effet - 3);
    expect(client.portalOpen).toBe(true);

    // Le tick d'effet lui-meme : ferme. C'est cette ligne-ci qui tue le
    // decalage d'un tick (`<=` au lieu de `<`).
    auTick(socket, effet);
    expect(client.hordeTick).toBe(effet);
    expect(client.portalOpen).toBe(false);
  });

  it('porte le verdict PARTIR et l or acquis', () => {
    // La moitie negative : un client qui ne lirait que « rester » afficherait
    // le mauvais verdict la ou il compte le plus.
    const { client, socket } = setup();
    auTick(socket, 900);
    socket.emit('message', { data: encodePortalOpen(ECHEANCE, MULTIPLICATEUR) });
    socket.emit('message', {
      data: encodePortalResult(909, VOTE_CHOICE.LEAVE, CAGNOTTE),
    });

    expect(client.portalDecision).toBe(VOTE_CHOICE.LEAVE);
    expect(client.portalGold).toBe(CAGNOTTE);
  });

  it('oublie les votes ET le verdict du palier precedent a l ouverture suivante', () => {
    // Comme les jetons du draft : sans cette remise a zero, chacun verrait son
    // vote deja pose avant d'avoir decide, et le verdict du palier precedent
    // resterait affiche par-dessus.
    const { client, socket } = setup();
    auTick(socket, 900);
    socket.emit('message', { data: encodePortalOpen(ECHEANCE, MULTIPLICATEUR) });
    socket.emit('message', {
      data: encodeVotes([{ playerId: 1, choice: VOTE_CHOICE.STAY }]),
    });
    socket.emit('message', { data: encodePortalResult(909, VOTE_CHOICE.STAY, CAGNOTTE) });
    auTick(socket, 909);
    expect(client.portalOpen).toBe(false);

    socket.emit('message', {
      data: encodePortalOpen(ECHEANCE + 600, MULTIPLICATEUR + 0.25),
    });

    expect(client.portalOpen).toBe(true);
    expect(client.portalVotes.size).toBe(0);
    expect(client.portalDecision).toBeNull();
    expect(client.portalMultiplier).toBe(MULTIPLICATEUR + 0.25);
  });

  /**
   * ⚠️ **L'or est une donnee d'EQUIPE, dans l'en-tete du snapshot** : il
   * se lit meme quand le bloc du joueur local est introuvable — un joueur mort,
   * ou un client dont le premier snapshot ne le porte pas encore. Le lire apres
   * le `return` du bloc joueur laisserait la cagnotte a zero tout ce temps-la,
   * c'est-a-dire precisement pendant que l'equipe la risque.
   */
  it('lit l or non securise de CHAQUE snapshot, meme sans bloc du joueur local', () => {
    const { client, socket } = setup(7);

    socket.emit('message', { data: encodeSnapshot(910, 0, 0, [], null, CAGNOTTE) });

    expect(client.localId).toBe(7);
    expect(client.gold).toBe(CAGNOTTE);
  });

  it('suit l or a la hausse comme a la baisse — la cagnotte n est pas acquise', () => {
    // ⚠️ La moitie negative porte le sens : un client qui ne ferait que
    // cumuler afficherait une cagnotte intacte apres un effacement d'equipe,
    // soit l'inverse exact de ce qui est en jeu.
    const { client, socket } = setup();

    auTick(socket, 910, CAGNOTTE);
    expect(client.gold).toBe(CAGNOTTE);

    auTick(socket, 920, 0);
    expect(client.gold).toBe(0);
  });
});

/**
 * ⚠️ **Le `describe` de ce fichier qui declenche reellement `'open'`** : les
 * autres passent directement a `emit('message', ...)`. C'est lui qui exerce
 * l'envoi du `HELLO` et le `setInterval` d'`INPUT` du gestionnaire `'open'`
 * de `connect()`.
 */
describe('GameClient — le HELLO envoye a l ouverture de la socket (tache 7)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Octets reconnaissables, jamais des zeros. */
  const JETON = new Uint8Array(TOKEN_BYTES);
  for (let i = 0; i < TOKEN_BYTES; i++) {
    JETON[i] = (i * 7 + 3) & 0xff;
  }

  it('est la PREMIERE trame envoyee, porte le jeton exact, et precede tout INPUT', () => {
    vi.useFakeTimers();
    const client = new GameClient(
      'ws://test',
      () => ({ x: 0, y: 0 }),
      vi.fn(),
      undefined,
      undefined,
      undefined,
      JETON,
    );
    client.connect();
    const socket = latestSocket();
    socket.emit('open', { data: new ArrayBuffer(0) });

    // ⚠️ **C'est CETTE assertion, juste ici, qui rougit sur la mutation qui
    // compte** (HELLO envoye depuis le callback periodique, apres le premier
    // INPUT) — pas une assertion plus bas apres une avance de temps.
    // `#sendInput` ne peut JAMAIS s'executer de facon synchrone dans ce code :
    // il ne part que par le timer enregistre a la fin du gestionnaire
    // 'open'. La seule facon de faire passer un INPUT avant le HELLO est donc
    // de retarder le HELLO hors du tour synchrone de 'open' — ce qui laisse
    // `sent` vide ici, avant que le moindre timer n'ait pu tourner. C'est
    // pour ca que ces deux assertions precoces (pas une avance de temps)
    // suffisent a garder l'ordre.
    expect(socket.sent.length).toBe(1);
    const msg = decode(socket.sent[0] as ArrayBuffer);
    expect(msg.type).toBe(MSG.HELLO);
    if (msg.type !== MSG.HELLO) {
      throw new Error('inaccessible : verifie juste au-dessus');
    }
    expect([...msg.token]).toEqual([...JETON]);

    // Pas pour l'ordre (deja garde plus haut, un tableau ne se reordonne pas
    // a posteriori) : verifie que l'envoi du HELLO n'a pas casse la SUITE du
    // gestionnaire 'open'. Si `ws.send(encodeHello(...))` avait leve, ou
    // empeche `setInterval` de s'enregistrer, aucun INPUT ne partirait
    // jamais et cette assertion resterait fausse pour toujours.
    vi.advanceTimersByTime(1000 / INPUT_HZ);
    expect(socket.sent.length).toBeGreaterThan(1);
  });

  /**
   * ⚠️ Sans ce test negatif, un code qui enverrait un HELLO vide ou bidon a
   * CHAQUE connexion passerait le test precedent (qui ne construit qu'avec un
   * jeton). Sans jeton (parametre a `null` par defaut), AUCUN envoi a
   * l'ouverture.
   */
  it('n envoie AUCUN HELLO quand aucun jeton n est fourni', () => {
    vi.useFakeTimers();
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('open', { data: new ArrayBuffer(0) });

    expect(socket.sent.length).toBe(0);

    vi.advanceTimersByTime(1000 / INPUT_HZ);
    expect(socket.sent.length).toBeGreaterThan(0);
    expect(decode(socket.sent[0] as ArrayBuffer).type).not.toBe(MSG.HELLO);
  });
});

describe('le sort du necromancien', () => {
  it('joue le sort la ou des squelettes naissent sur place, pas pour les petits du diviseur', () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 5000, 0xabc_def) });
    const ordre = (archetype: number, waveId: number) =>
      encodeWaveOrder({
        waveId,
        spawnTick: 5001,
        seed: waveId,
        archetype,
        formation: FORMATION.POINT,
        anchorX: 1200,
        anchorY: 1300,
        count: 2,
      });
    socket.emit('message', { data: ordre(archetypeIdOf(SPLIT_CHILD), 7) });
    expect(client.blastFlashes).toHaveLength(0);
    socket.emit('message', { data: ordre(archetypeIdOf(NECRO_CHILD), 8) });
    expect(client.blastFlashes).toEqual([
      expect.objectContaining({ x: 1200, y: 1300, kind: 'releve' }),
    ]);
  });
});

/**
 * L'onde et la frappe ne posent aucun projectile. Le
 * client en rejoue un miroir cosmetique depuis `#fireOne`, comme le faisceau
 * et le halo : les listes qu'il seme (`ondes`, `frappes`) nourrissent le
 * calque, et les ennemis franchis REAGISSENT (flash, chiffre, marque) — sans
 * quoi l'arme aurait l'air de ne rien faire.
 *
 * Le tireur est le joueur 2, un ALLIE : sa position et sa visee viennent du
 * snapshot, ce qui les fixe exactement (le joueur local, lui, est predit).
 */
describe('GameClient — le miroir de l onde et de la frappe (etape 12)', () => {
  const MS_PER_TICK = 1000 / TICK_HZ;
  const CANON_A_CHAUX = 14;
  const CANON_A_ARC = 10;

  function armerAllie(weaponId: number, offsetX: number) {
    const { client, socket, monsterX, monsterY } = setupOneMonster(0xf1a5_0012, 92);
    socket.emit('message', {
      // L'aspect explicite : `0` n'est pas un bonus propre de toutes les armes.
      data: encodeDraftOpen(600, [
        { nature: CARD.WEAPON, refId: weaponId, upgrade: weaponOf(weaponId).perks[0] },
      ]),
    });
    socket.emit('message', {
      data: encodeDraftResult(0, [{ playerId: 2, cardIndex: 0, outcome: OUTCOME.WON }]),
    });
    expect(client.loadoutOf(2).stacksOfWeapon(weaponId)).toBe(1);
    const tireur = { x: monsterX - offsetX, y: monsterY };
    let tick = 0;
    /** Une image d'un tick ; rend les flashs nes A CETTE image, de la teinte de l'arme. */
    const avancer = (): { x: number; y: number; shakes: number }[] => {
      tick++;
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [
          {
            id: 1,
            x: 0,
            y: 0,
            hp: 100,
            aimX: 0,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
          {
            id: 2,
            ...tireur,
            hp: 100,
            aimX: 1,
            aimY: 0,
            pickupRadius: ORB_PICKUP_RADIUS,
            shield: 0,
          },
        ]),
      });
      const now = tick * MS_PER_TICK;
      client.update(now, STEP);
      const tint = weaponOf(weaponId).look.tint;
      const nes = [];
      for (let i = 0; i < client.hitFlashes.count; i++) {
        if (client.hitFlashes.tint[i] === tint && client.hitFlashes.bornMs[i] === now) {
          nes.push({
            x: client.hitFlashes.x[i] ?? 0,
            y: client.hitFlashes.y[i] ?? 0,
            shakes: client.hitFlashes.shakes[i] ?? 0,
          });
        }
      }
      return nes;
    };
    return { client, tireur, avancer };
  }

  it('seme une onde au point de tir, et l ennemi franchi reagit UNE fois, sans secousse', () => {
    const arme = weaponOf(CANON_A_CHAUX);
    expect(arme.kind).toBe('onde');
    const { client, tireur, avancer } = armerAllie(CANON_A_CHAUX, 100);

    const flashs: { x: number; y: number; shakes: number }[] = [];
    let semee = false;
    let marquee = false;
    for (let i = 0; i < 20; i++) {
      flashs.push(...avancer());
      const onde = client.ondes[0];
      if (onde) {
        semee = true;
        // Au point de tir, a la quantification du snapshot pres.
        expect(Math.abs(onde.x - tireur.x)).toBeLessThan(1);
        expect(Math.abs(onde.y - tireur.y)).toBeLessThan(1);
        expect(onde.maxRadius).toBe(arme.blastRadius);
        expect(onde.tint).toBe(arme.look.tint);
        expect(onde.by).toBe(2);
      }
      marquee ||= client.horde.markAt(0, client.hordeTick - 1) === arme.element;
    }
    expect(semee).toBe(true);
    // Une onde de 220 px balaie l'ennemi a ~100 px : un flash, pas un par tick.
    expect(flashs).toHaveLength(1);
    expect(flashs[0]?.shakes).toBe(0);
    if (arme.element !== ELEMENT.NEUTRE) {
      expect(marquee).toBe(true);
    }
    // Eteinte en fin de course : la liste se purge.
    expect(client.ondes).toHaveLength(0);
  });

  it('seme les impacts d une frappe a portee, et ne frappe qu a l echeance, AVEC secousse', () => {
    const arme = weaponOf(CANON_A_ARC);
    expect(arme.kind).toBe('frappe');
    // L'ennemi pile au point vise : `position + visee x portee`.
    const { client, avancer } = armerAllie(CANON_A_ARC, beamRange(arme));

    let tir = -1;
    let frappe: { x: number; y: number; shakes: number }[] = [];
    let frappeAuTick = -1;
    for (let i = 0; i < 20 && frappeAuTick < 0; i++) {
      const nes = avancer();
      if (tir < 0 && client.frappes.length > 0) {
        tir = client.hordeTick;
        // L'ennemi, plus UN impact sur le point vise lui-meme (il en manque).
        expect(client.frappes).toHaveLength(2);
        for (const f of client.frappes) {
          expect(f.struckMs).toBe(-1);
          expect(f.radius).toBe(arme.blastRadius);
          expect(f.tint).toBe(arme.look.tint);
        }
      }
      if (nes.length > 0) {
        frappe = nes;
        frappeAuTick = client.hordeTick;
      }
    }
    expect(tir).toBeGreaterThanOrEqual(0);
    expect(frappeAuTick - tir).toBe(FRAPPE_DELAY_TICKS);
    expect(frappe).toHaveLength(2);
    expect(frappe.every((f) => f.shakes === 1)).toBe(true);
    // Frappes, les impacts restent le temps de l'eclair.
    expect(client.frappes.every((f) => f.struckMs >= 0)).toBe(true);
  });

  /**
   * L'ancre du client. L'orbite d'un allie tourne autour de sa position
   * au DERNIER SNAPSHOT — sans ancre, elle resterait autour du point de tir.
   */
  it('l orbite d un allie suit sa position de snapshot (l ancre)', () => {
    const CHAKRAM = 5;
    const { client, tireur, avancer } = armerAllie(CHAKRAM, 300);
    avancer();
    expect(client.projectiles.count).toBeGreaterThan(0);
    // L'allie se deplace loin de son point de tir.
    tireur.x += 400;
    for (let i = 0; i < 5; i++) {
      avancer();
    }
    let lames = 0;
    for (let i = 0; i < client.projectiles.count; i++) {
      if (client.projectiles.weaponAt(i) !== CHAKRAM) {
        continue;
      }
      lames++;
      const d = Math.hypot(
        (client.projectiles.x[i] ?? 0) - tireur.x,
        (client.projectiles.y[i] ?? 0) - tireur.y,
      );
      expect(d).toBeLessThan(ORBIT_RADIUS * (1 + ORBIT_BREATH) + 2);
    }
    expect(lames).toBeGreaterThan(0);
  });
});

describe('etape 11 : le client reconnait un coffre sans un octet de plus', () => {
  const ORDRE: WaveOrder = {
    waveId: 4242,
    spawnTick: 0,
    seed: 7,
    archetype: PORTEUR_ARCHETYPE,
    formation: FORMATION.POINT,
    anchorX: 4500,
    anchorY: 3000,
    count: 1,
  };
  const PORTEUR_ID = entityIdOf(4242, 0);

  function setup(): { client: GameClient; socket: FakeSocket } {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0x11_c0ff) });
    return { client, socket };
  }

  it('l ordre du porteur, puis sa mort, puis LEVEL_UP : ce LEVEL_UP est un coffre', () => {
    const { client, socket } = setup();
    socket.emit('message', { data: encodeWaveOrder(ORDRE) });
    socket.emit('message', { data: encodeDeaths(30, [PORTEUR_ID]) });
    socket.emit('message', { data: encodeLevelUp(31, 1) });
    expect(client.draftIsChest).toBe(true);
    // Le niveau affiche n'a pas bouge : un coffre n'est pas un niveau.
    expect(client.level).toBe(1);
  });

  it('un LEVEL_UP seul n est pas un coffre', () => {
    const { client, socket } = setup();
    socket.emit('message', { data: encodeLevelUp(31, 2) });
    expect(client.draftIsChest).toBe(false);
    expect(client.level).toBe(2);
  });

  it('un coffre du se consomme une fois : le LEVEL_UP suivant est un niveau', () => {
    const { client, socket } = setup();
    socket.emit('message', { data: encodeWaveOrder(ORDRE) });
    socket.emit('message', { data: encodeDeaths(30, [PORTEUR_ID]) });
    const second: WaveOrder = { ...ORDRE, waveId: 5000 };
    socket.emit('message', { data: encodeWaveOrder(second) });
    socket.emit('message', { data: encodeDeaths(40, [entityIdOf(5000, 0)]) });
    const drapeaux: boolean[] = [];
    for (const tick of [41, 42, 43]) {
      socket.emit('message', { data: encodeLevelUp(tick, 2) });
      drapeaux.push(client.draftIsChest);
    }
    expect(drapeaux).toEqual([true, true, false]);
  });

  it('une mort d identite inconnue, ou un porteur jamais annonce, ne fait pas de coffre', () => {
    const { client, socket } = setup();
    // Un client arrive apres l'ordre : il voit la mort, pas la naissance.
    socket.emit('message', { data: encodeDeaths(30, [PORTEUR_ID]) });
    socket.emit('message', { data: encodeLevelUp(31, 2) });
    expect(client.draftIsChest).toBe(false);
    // Et une mort ORDINAIRE apres l'annonce ne consomme pas le porteur.
    socket.emit('message', { data: encodeWaveOrder(ORDRE) });
    socket.emit('message', { data: encodeDeaths(32, [entityIdOf(77, 0)]) });
    socket.emit('message', { data: encodeLevelUp(33, 3) });
    expect(client.draftIsChest).toBe(false);
  });

  it('annonce : un compteur, et un bandeau de PORTEUR_BANNER_MS', () => {
    const horloge = vi.spyOn(performance, 'now').mockReturnValue(10_000);
    try {
      const { client, socket } = setup();
      expect(client.porteurCount).toBe(0);
      expect(client.porteurBannerOn).toBe(false);
      socket.emit('message', { data: encodeWaveOrder(ORDRE) });
      expect(client.porteurCount).toBe(1);
      expect(client.porteurBannerOn).toBe(true);
      horloge.mockReturnValue(10_000 + PORTEUR_BANNER_MS - 1);
      expect(client.porteurBannerOn).toBe(true);
      horloge.mockReturnValue(10_000 + PORTEUR_BANNER_MS);
      expect(client.porteurBannerOn).toBe(false);
    } finally {
      horloge.mockRestore();
    }
  });

  it('porteur : sa position tant qu il est dans la horde du client, null des sa mort recue', () => {
    const { client, socket } = setup();
    expect(client.porteur).toBeNull();
    socket.emit('message', { data: encodeWaveOrder(ORDRE) });
    // Un tick fait naitre l'ordre (les ordres s'appliquent en tete d'`#advanceHorde`).
    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, [
        {
          id: 1,
          x: 0,
          y: 0,
          hp: 100,
          aimX: 0,
          aimY: 0,
          pickupRadius: ORB_PICKUP_RADIUS,
          shield: 0,
        },
      ]),
    });
    client.update(0, STEP);
    const slot = client.horde.slotOf(PORTEUR_ID);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(client.porteur).toEqual({ x: client.horde.x[slot], y: client.horde.y[slot] });
    socket.emit('message', { data: encodeDeaths(1, [PORTEUR_ID]) });
    expect(client.porteur).toBeNull();
  });
});
