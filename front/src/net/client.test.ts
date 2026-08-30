import { CARD } from '@shared/cards';
import {
  FLOWFIELD_CELL,
  FLOWFIELD_HZ,
  LEVEL_RESUME_TICKS,
  MAP_SIZE,
  MARK_DURATION_TICKS,
  ORB_LIFETIME_TICKS,
  PLAYER_SPEED,
  PROJECTILE_HIT_RADIUS,
  ROLLBACK_DEPTH_TICKS,
  TICK_HZ,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
  ZONE_REFRESH_INTERVAL_TICKS,
} from '@shared/constants';
import { ELEMENT } from '@shared/elements';
import { FlowField } from '@shared/flowfield';
import { entityIdOf, Horde } from '@shared/horde';
import { passiveOf } from '@shared/passives';
import { PlayerHistory } from '@shared/player-history';
import {
  decode,
  encodeDeaths,
  encodeDraftIntents,
  encodeDraftOpen,
  encodeDraftResult,
  encodeLevelUp,
  encodePickups,
  encodeReaction,
  encodeRunOver,
  encodeSnapshot,
  encodeWaveOrder,
  encodeWelcome,
  encodeZone,
  MSG,
  OUTCOME,
  packElementPair,
} from '@shared/protocol';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { BASE_WEAPON_ID, cooldownWithBonus, WEAPONS, weaponOf } from '@shared/weapons';
import { applyObstacles, generateObstacles } from '@shared/worldmap';
import { ZoneField } from '@shared/zones';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GameClient,
  HIT_FLASH_LIFETIME_MS,
  type InputAxes,
  type ObstacleMap,
  REACTION_FLASH_LIFETIME_MS,
} from './client';

/**
 * Faux `WebSocket` : ni connexion reseau ni serveur, juste de quoi capturer
 * les ecouteurs et simuler l'arrivee de messages. `GameClient` n'importe pas
 * `WebSocket` explicitement — il lit le symbole global — donc le remplacer
 * globalement suffit a l'isoler du reseau.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
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

  /** Trames poussees par le client — le chemin SORTANT (`DRAFT_TOKEN`, tache 9). */
  readonly sent: ArrayBuffer[] = [];

  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    // Rien a fermer.
  }

  emit(type: string, event: { data: ArrayBuffer }): void {
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
    // Sans l'alignement, `hordeTick` serait reste proche de zero alors que
    // `order.spawnTick` est un tick serveur absolu et eleve : la soustraction
    // `tick - spawnTick` serait massivement negative, `missed` clampe a zero
    // en permanence, et le rattrapage ne s'executerait jamais — exactement la
    // regression que ce test verrouille.
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
      // pendant les pas manques (tache 6).
      client.zones,
    );
    expect(client.horde.count).toBe(10);
  });
});

describe('GameClient — livre le masque d obstacles au rendu (tache 28)', () => {
  it('livre au rendu exactement le meme masque et la meme geometrie que ceux appliques aux champs de flux', () => {
    // Mutation testee : que le WELCOME livre a `onMapReady` un masque
    // regenere a part (autre graine, ou memes `cols`/`rows` mais decale
    // d'une cellule) plutot que CELUI qui vient d'alimenter `#fields`
    // ci-dessus dans `client.ts` fait echouer ce test — les deux tableaux
    // divergeraient presque partout, pas seulement sur une cellule.
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

    // Reconstruit independamment, avec la meme sonde `FlowField` que celle
    // que `client.ts` utilise pour connaitre `cols`/`rows` avant de tirer le
    // masque — voir `makeReferenceServer` plus bas, meme discipline.
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
        data: encodeSnapshot(0, 777, 0, [{ id: 1, x: 10, y: 20, hp: 42, aimX: 0, aimY: 0 }]),
      });

      const state = client.update(0, 0);

      expect(state.players.find((p) => p.id === 1)).toMatchObject({ hp: 42 });
    },
  );

  it("reprend l'experience d'equipe du dernier snapshot, au niveau du RenderState", () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();

    socket.emit('message', { data: encodeWelcome(1, 0, 0) });
    socket.emit('message', {
      data: encodeSnapshot(0, 777, 0, [{ id: 1, x: 10, y: 20, hp: 42, aimX: 0, aimY: 0 }]),
    });

    const state = client.update(0, 0);

    expect(state.xp).toBe(777);
  });
});

const STEP = 1 / TICK_HZ;
const STEPS_PER_FIELD = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));

/**
 * Duree de gel choisie par ces tests.
 *
 * ⚠️ Ce n'est plus une constante du jeu. Depuis l'etape 4, le gel dure jusqu'a
 * ce que tout le monde ait pose son jeton — en solo, jusqu'au clic — et **seul
 * le serveur en connait la fin**, qu'il annonce par `DRAFT_RESULT` de phase 0.
 * Un test qui la deduirait d'une constante testerait un contrat qui n'existe
 * plus.
 *
 * ⚠️ **137, et surtout pas 60.** 60 etait `LEVEL_FREEZE_TICKS`, l'ancienne
 * duree fixe. Tant que ces tests gelaient pendant 60 ticks, un client qui
 * recalculait `msg.tick + 60 - 1` au lieu d'attendre le message se comportait
 * exactement pareil — mutation appliquee, 80 tests verts. Une duree arbitraire,
 * egale a aucune constante du jeu, est ce qui rend le contrat verifiable.
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
  // `ref.fields[0]` : tache 18, evite de faire naitre une entite en plein mur
  // — exactement ce que fait `Room.step` cote serveur. Sans ca, cette
  // reference desaccorde son propre modele du serveur, puisque `GameClient`,
  // lui, applique deja cet evitement via `spawnCatchingUp`.
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
    // Arrondies, comme sur le fil (constat C1.4, voir `Room.step`) : le
    // client ne connait jamais que la version quantifiee en int16 du
    // protocole. Si la reference alimentait son propre flowfield avec des
    // positions flottantes non arrondies, les deux cotes enracineraient leur
    // BFS dans des cellules differentes a chaque frontiere de cellule, et la
    // derive resultante n'aurait plus rien a voir avec le rejeu des morts —
    // piege reel, trouve par mesure a l'ecriture de ce fichier (voir le
    // rapport de la tache 10).
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

    const players = xs.map((x, i) => ({ id: i, x, y: ys[i] ?? 0, hp: 100, aimX: 0, aimY: 0 }));
    socket.emit('message', { data: encodeSnapshot(tick, 0, 0, players) });

    // Livraison retardee au client : latence reseau simulee, comme l'exige la
    // tache 10.
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
      // passerait inapercu, exactement le piege documente a la tache 8.
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
      // Piege trouve par mutation en ecrivant ce fichier (voir le rapport de
      // la tache 10) : les deux tests precedents ne mettent jamais plus d'un
      // lot en attente a la fois, donc rien n'y distingue `#drainPendingDeaths`
      // qui viderait la file en entier de sa mutation qui n'en traiterait
      // qu'UN par tick — les deux versions les faisaient passer. Un retard
      // reseau variable peut pourtant tres bien faire arriver, au meme tick
      // local, les morts decidees a deux ticks serveur differents.
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

describe('GameClient — orbes derivees des morts (tache 10)', () => {
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

    const killedIds = [entityIdOf(WAVE_ID, 0), entityIdOf(WAVE_ID, 1)];
    const DEATH_TICK = 10;
    const DELAY = 2;

    for (let tick = 0; tick < DEATH_TICK + DELAY + 5; tick++) {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [{ id: 1, x: 3000, y: 3000, hp: 100, aimX: 0, aimY: 0 }]),
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

  it(
    'un orbe non ramasse expire apres ORB_LIFETIME_TICKS : encore present juste avant, ' +
      'disparu pile a l echeance (verifie aux deux bornes)',
    () => {
      // Meme raisonnement que l'expiration des projectiles (§6.1) : un seul
      // cote de la fenetre ne prouve rien, un decalage d'un cran passerait
      // inapercu. Ce test verifie les deux bornes dans la MEME execution.
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
      // `bornTick` de l'orbe = DEATH_TICK (voir `#applyDeaths` : les orbes
      // sont dates au tick de la mort, jamais a celui de sa livraison).
      const JUST_BEFORE = DEATH_TICK + ORB_LIFETIME_TICKS - 1;
      const AT_LIFETIME = DEATH_TICK + ORB_LIFETIME_TICKS;
      const END = AT_LIFETIME + 5;

      let sawJustBefore = false;
      let sawAtLifetime = false;

      for (let tick = 0; tick < END; tick++) {
        socket.emit('message', {
          data: encodeSnapshot(tick, 0, 0, [
            { id: 1, x: 3000, y: 3000, hp: 100, aimX: 0, aimY: 0 },
          ]),
        });
        if (tick === DEATH_TICK + DELAY) {
          socket.emit('message', { data: encodeDeaths(DEATH_TICK, [killedId]) });
        }
        client.update(tick * STEP, STEP);

        // Borne basse : encore la juste avant l'echeance.
        if (tick === JUST_BEFORE) {
          expect(client.orbs.count).toBe(1);
          sawJustBefore = true;
        }
        // Borne haute : disparu pile a l'echeance, pas un tick plus tard.
        if (tick === AT_LIFETIME) {
          expect(client.orbs.count).toBe(0);
          sawAtLifetime = true;
        }
      }

      // Garde-fou sur le scenario lui-meme : si ces deux ticks n'ont jamais
      // ete visites, les assertions ci-dessus n'ont jamais tourne et le test
      // passerait pour la mauvaise raison.
      expect(sawJustBefore).toBe(true);
      expect(sawAtLifetime).toBe(true);
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
      // test, gel et reprise compris.
      anchorX: 500,
      anchorY: 500,
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
        data: encodeSnapshot(tick, 0, 0, [{ id: 1, x: 3000, y: 3000, hp: 100, aimX: 0, aimY: 0 }]),
      });
      // Envoye bien avant que le gel ne prenne effet : si le client gelait a
      // la reception, tout mouvement s'arreterait des ce tick au lieu de
      // FREEZE_START.
      if (tick === 20) {
        socket.emit('message', { data: encodeLevelUp(FREEZE_START, 2) });
      }
      // ⚠️ C'est le SERVEUR qui annonce la fin du gel : le client ne peut plus
      // la deduire (etape 4). Sans ce message, il resterait gele pour toujours
      // — et c'est bien le comportement voulu.
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
        data: encodeSnapshot(0, 0, 0, [{ id: 1, x: 500, y: 500, hp: 100, aimX: 0, aimY: 0 }]),
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
      // prochain snapshot — c'est exactement le rubber-band rapporte.
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
    // l'apprendre depuis l'etape 4.
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
      data: encodeSnapshot(0, 0, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
    });
    client.update(0, 0);

    expect(onRunOver).not.toHaveBeenCalled();
  });
});

/**
 * Tir automatique cote client (tache 11, visee revue tache 13) — miroir
 * cosmetique de `Room#fireWeapons`/`resolveProjectileDamage` (back/src/room.ts,
 * back/src/combat.ts). Voir le commentaire de `GameClient#advanceHorde` :
 * jamais d'arbitrage de degats ici, seulement de quoi dessiner une salve et
 * un flash d'impact.
 *
 * ⚠️ Depuis la tache 13, la visee vient de `readAim`, plus d'un ciblage
 * automatique sur la horde : chaque test doit donc fournir une direction, pas
 * seulement une position de joueur a portee.
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
      data: encodeSnapshot(0, 0, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
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
      // moins un tick de vol au projectile avant l'impact, quelle que soit la
      // vitesse de l'arme (reglee tache 14 — voir le rapport). Un decalage
      // fixe trop petit ferait toucher des le meme tick que celui du tir : la
      // boucle observerait `hitFlashes` avant d'avoir jamais vu
      // `projectiles.count > 0`, et `firedAtTick` resterait a -1 comme
      // constate lors du reglage de cette tache. Le monstre fonce droit sur
      // le joueur (auto-cible du flowfield) — la meme ligne que celle visee
      // par la salve (visee AIM_RIGHT, droit sur le monstre).
      const weapon = weaponOf(0);
      const perTickTravel = weapon.projectileSpeed / TICK_HZ;
      const offset = Math.round(perTickTravel * 3 + PROJECTILE_HIT_RADIUS);
      const PLAYER = { x: monsterX - offset, y: monsterY };

      let firedAtTick = -1;
      for (let tick = 1; tick <= 40; tick++) {
        socket.emit('message', {
          data: encodeSnapshot(tick, 0, 0, [{ id: 1, ...PLAYER, hp: 100, aimX: 0, aimY: 0 }]),
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
    // ⚠️ C'est LA regle centrale de la tache 13 : curseur pile sur le joueur,
    // ou souris jamais bougee, `(0, 0)` ne tire pas — deterministe des deux
    // cotes. Contrairement a l'ancien ciblage automatique, la proximite du
    // monstre n'entre plus en jeu : c'est uniquement `readAim` qui gate ici.
    const { client, socket, monsterX, monsterY } = setupWithOneMonster(0xc1e2_0014, 74, () => ({
      x: 0,
      y: 0,
    }));
    const PLAYER = { x: monsterX - 50, y: monsterY };
    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');

    for (let tick = 1; tick <= 20; tick++) {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [{ id: 1, ...PLAYER, hp: 100, aimX: 0, aimY: 0 }]),
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
        data: encodeSnapshot(tick, 0, 0, [{ id: 1, ...PLAYER, hp: 0, aimX: 0, aimY: 0 }]),
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
        data: encodeSnapshot(tick, 0, 0, [{ id: 1, ...PLAYER, hp: 100, aimX: 0, aimY: 0 }]),
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
    // l'arme (7 ticks, tache 14) ne permette une seconde salve — la fenetre
    // de 220 ms testee ci-dessous ne peut donc contenir qu'un seul flash.
    const PLAYER = { x: monsterX - 20, y: monsterY };

    let hitNowMs = -1;
    for (let tick = 1; tick <= 20 && hitNowMs < 0; tick++) {
      socket.emit('message', {
        data: encodeSnapshot(tick, 0, 0, [{ id: 1, ...PLAYER, hp: 100, aimX: 0, aimY: 0 }]),
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

describe('GameClient — proprietes du tir que le code affirme (tache 11/13)', () => {
  const MS_PER_TICK = 1000 / TICK_HZ;
  const AIM_RIGHT: InputAxes = { x: 1, y: 0 };

  it('tire depuis la position PREDITE du joueur local, pas depuis celle du dernier snapshot', () => {
    // ⚠️ Ce test existe parce que la mutation « jeter la prediction locale »
    // (`const x = p.x` au lieu de `local ? local.simX : p.x`) laissait les
    // dix-huit tests de ce fichier verts. Le commentaire de `#fireWeapons`
    // affirme pourtant que le joueur local tire depuis sa position simulee,
    // « plus a jour que le dernier snapshot recu ».
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
      data: encodeSnapshot(0, 0, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
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
          { id: 1, x: SNAPSHOT_X, y: monsterY, hp: 100, aimX: 0, aimY: 0 },
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
      // ⚠️ C'est le coeur de la discipline de la tache 13 : la direction part
      // sur le fil quantifiee sur un octet signe. Si `#localAim` utilisait le
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
        data: encodeSnapshot(0, 0, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
      });
      // Le spy est pose AVANT le tout premier `update()` : c'est celui-la qui
      // tire (cooldown jamais entame), et le rater ferait attendre la
      // prochaine fenetre de cooldown (7 ticks) pour rien.
      const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
      client.update(0, STEP);
      for (let tick = 1; tick <= 5 && spy.mock.calls.length === 0; tick++) {
        socket.emit('message', {
          data: encodeSnapshot(tick, 0, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
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
    // ⚠️ Discipline de la tache 13 : le joueur local tire avec `#localAim`
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
      data: encodeSnapshot(0, 0, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
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
        data: encodeSnapshot(tick, 0, 0, [{ id: 1, ...PLAYER, hp: 100, aimX: -127, aimY: 0 }]),
      });
      client.update(tick * MS_PER_TICK, STEP);
    }

    expect(spy).toHaveBeenCalled();
    const [, , , , dirX] = spy.mock.calls[0] ?? [];
    expect(dirX).toBeGreaterThan(0);
  });

  it('ne tire pas pendant le gel, et retire des la reprise', () => {
    // ⚠️ Ce test existe parce que remplacer la garde `tick > #freezeUntilTick`
    // par `if (true)` laissait les dix-huit tests verts : aucun n'exercait gel
    // et tir ensemble. Les deux moities comptent — verifier seulement que le
    // tir s'arrete laisserait passer un gel permanent.
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
      data: encodeSnapshot(0, 0, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
    });
    client.update(0, STEP);
    expect(client.horde.count).toBe(1);

    const monsterX = client.horde.x[0] ?? 0;
    const monsterY = client.horde.y[0] ?? 0;
    const PLAYER = { x: monsterX - 50, y: monsterY };
    const snapshot = (tick: number): ArrayBuffer =>
      encodeSnapshot(tick, 0, 0, [{ id: 1, ...PLAYER, hp: 100, aimX: 0, aimY: 0 }]);

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
 * Le draft, cote client (tache 9 de l'etape 4).
 *
 * Deux dettes inscrites au registre par les taches 7 et 8 se soldent ici, et
 * elles portent la moitie de ce bloc :
 *
 * - `#fireWeapons` tirait `weaponOf(0)` et rien d'autre, avec un compteur de
 *   recharge unique par joueur — la copie de ce que `Room` faisait AVANT la
 *   tache 7. Aucun projectile d'arme draftee ne s'affichait ;
 * - la prediction locale avancait a `PLAYER_SPEED` en dur, alors que le
 *   serveur y ajoute `bonus('speed')` — la premiere carte « fougue » faisait
 *   decrocher la prediction a chaque tick.
 *
 * Les deux se soldent par la meme chose : un `Loadout` par joueur, alimente
 * par `DRAFT_RESULT`.
 */
describe('GameClient — le draft recu et ses effets (tache 9)', () => {
  const MS_PER_TICK = 1000 / TICK_HZ;
  /** Une visee non nulle : sans elle, aucune des deux cotes ne tire (tache 13). */
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
  ): { client: GameClient; socket: FakeSocket } {
    const client = new GameClient('ws://test', readInput, vi.fn(), undefined, readAim);
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
    // ⚠️ Le §7.2 est categorique : le client ne DECIDE rien. Ce que l'ecran
    // montre vient de `DRAFT_INTENTS`, jamais du geste local — un jeton
    // affiche des le clic mentirait a chaque refus, et le joueur croirait
    // viser une carte que le serveur ne lui accorde pas.
    //
    // ⚠️ **Il n'y a plus de carte reservee.** Le seul refus qui subsiste vient
    // de l'inventaire (`Loadout.canTake` : des slots d'armes pleins refusent
    // une arme NOUVELLE) — et le client, lui, n'en sait rien : c'est
    // precisement pour ca qu'il ne doit rien afficher de facon optimiste.
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

    expect([...client.loadoutOf(2).weaponIds]).toEqual([GRENADE]);
    expect([...client.loadoutOf(1).weaponIds]).toEqual([]);
  });

  it('une carte perdue au conflit ne donne rien, la meme carte gagnee la donne', () => {
    // ⚠️ Les trois issues ne se valent pas : `LOST` (1) est le joueur qui
    // visait une carte qu'un AUTRE a eue. Les traiter comme les deux autres
    // donnerait la carte contestee a tous ses pretendants — l'exclusivite du
    // §6.2 s'effondre, et le conflit n'a plus d'enjeu.
    const { client, socket } = setup(1);

    grant(socket, { nature: CARD.WEAPON, refId: GRENADE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.LOST },
      { playerId: 2, cardIndex: 0, outcome: OUTCOME.WON },
    ]);

    expect([...client.loadoutOf(1).weaponIds]).toEqual([]);
    expect([...client.loadoutOf(2).weaponIds]).toEqual([GRENADE]);
  });

  it('une attribution d office donne la carte comme une victoire', () => {
    // Le joueur absent du §4.4 : il n'a pose aucun jeton, le serveur a tranche
    // pour lui. `AUTO` (2) attribue tout autant que `WON` (0) — un client qui
    // ne retiendrait que `WON` laisserait invisible tout l'arsenal d'un joueur
    // en arriere-plan, cas explicitement decrit comme frequent.
    const { client, socket } = setup(1);

    grant(socket, { nature: CARD.PASSIVE, refId: FOUGUE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.AUTO },
    ]);

    expect(client.loadoutOf(1).stacksOf(FOUGUE)).toBe(1);
  });

  it('un nouvel etalage efface les jetons du precedent', () => {
    // ⚠️ Le pendant client du defaut signale par l'auteur en jouant.
    //
    // **Il a fallu la bonne entree pour que ce test prouve quelque chose.** Une
    // premiere version enchainait `DRAFT_RESULT` puis `DRAFT_OPEN` : le
    // resultat vide deja les intentions, donc neutraliser la remise a zero de
    // `DRAFT_OPEN` ne cassait rien — la garde serveur et la garde client se
    // couvraient l'une l'autre, quatrieme occurrence de ce motif dans cette
    // etape.
    //
    // L'entree qui les separe est un `DRAFT_INTENTS` **perime**, arrivant apres
    // le resultat. C'est exactement ce que le serveur emettait avant sa
    // correction, et le client est un decodeur du FIL : ce qu'il fait d'une
    // trame ne doit pas dependre de ce que `back/` emet ce mois-ci.
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

    // Le meme passif revient — les passifs ne sont JAMAIS exclus (§3.4), donc
    // c'est le cas courant, pas un cas tordu.
    socket.emit('message', {
      data: encodeDraftOpen(900, [{ nature: CARD.PASSIVE, refId: FOUGUE }]),
    });
    expect(client.draftIntents.size).toBe(0);
  });

  it('l etalage survit a la fermeture : c est la revelation qui en a besoin', () => {
    // ⚠️ **Defaut trouve au balayage pre-vol de la tache 10.** Le client vidait
    // `#draftCards` dans la branche `phase === 0` — c'est-a-dire a l'instant
    // PRECIS ou l'ecran doit jouer la revelation du §4.2 : « la carte
    // finalement obtenue s'illumine pour confirmer ». Les issues designent les
    // cartes par leur INDICE ; l'etalage vide, l'ecran n'avait rien a
    // illuminer et la revelation etait indessinable.
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
    expect(gagnee).toEqual({ nature: CARD.WEAPON, refId: GRENADE });

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
    // et le gel est date. On ne se sert PLUS de « l'etalage est vide » comme
    // preuve — l'etalage survit desormais a la fermeture, pour que l'ecran
    // puisse jouer la revelation du §4.2 sur des cartes qui existent encore.
    expect(client.draftSettled).toBe(true);
    expect(client.draftDeadlineTick).toBe(42);
    expect(client.draftOutcomes).toHaveLength(1);
    expect(client.loadoutOf(2).stacksOfWeapon(INCONNUE)).toBe(0);
  });

  it('l arme draftee tire — pour son porteur comme pour son allie', () => {
    // ⚠️ **La dette de la tache 7.** `#fireWeapons` tirait `weaponOf(0)` et
    // rien d'autre : aucune arme draftee n'apparaissait a l'ecran, ni la
    // sienne ni celle des autres. Deux armes DISTINCTES ici, une par joueur,
    // parce que l'espion ne voit que l'arme — pas qui tire.
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
      { id: 1, x: 2000, y: 2000, hp: 100, aimX: 127, aimY: 0 },
      { id: 2, x: 2200, y: 2000, hp: 100, aimX: 127, aimY: 0 },
    ]);

    const tirees = new Set(spy.mock.calls.map((c) => c[0].id));
    expect(tirees.has(BASE_WEAPON_ID)).toBe(true);
    expect(tirees.has(GRENADE)).toBe(true);
    expect(tirees.has(ARC_LOURD)).toBe(true);
  });

  it('chaque arme a SA recharge : la grenade ne bride pas la dague, et tire quand meme', () => {
    // ⚠️ **Le vrai enjeu de la dette.** Avec un compteur unique par joueur,
    // l'une des deux armes disparait selon l'ordre du parcours : la lente si
    // la rapide passe d'abord, la rapide sinon. Compter les DEUX est ce qui
    // ferme les deux cas d'un coup.
    const { client, socket } = setup(1);
    grant(socket, { nature: CARD.WEAPON, refId: GRENADE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
    ]);

    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    const TICKS = 70;
    run(client, socket, TICKS, [{ id: 1, x: 2000, y: 2000, hp: 100, aimX: 127, aimY: 0 }]);

    const dague = spy.mock.calls.filter((c) => c[0].id === BASE_WEAPON_ID).length;
    const grenade = spy.mock.calls.filter((c) => c[0].id === GRENADE).length;

    // La dague (7 ticks) tire a sa propre cadence, pas a celle de la grenade
    // (75 ticks) : sur 70 ticks, dix salves — une seule si elle etait bridee.
    expect(dague).toBe(Math.floor((TICKS - 1) / weaponOf(BASE_WEAPON_ID).cooldownTicks) + 1);
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
    // ⚠️ L'eventail tire DEJA cinq projectiles : sur une arme a projectile
    // unique, un miroir qui rendrait `stacks` au lieu de la vraie formule
    // donnerait les memes nombres.
    const EVENTAIL = 1;
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
      run(client, socket, 3, [{ id: 1, x: 2000, y: 2000, hp: 100, aimX: 127, aimY: 0 }]);
      const salve = spy.mock.calls.find((c) => c[0].id === EVENTAIL);
      const neutre = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
      if (!salve || !neutre) {
        throw new Error('salve manquante');
      }
      // L'arme neutre vit hors des slots : jamais empilee, jamais elargie.
      expect(neutre[7]).toBe(weaponOf(BASE_WEAPON_ID).projectileCount);
      return salve[7] ?? 0;
    }

    expect(projectilesDeLaSalve(1)).toBe(eventail.projectileCount);
    expect(projectilesDeLaSalve(2)).toBe(eventail.projectileCount + 1);
    expect(projectilesDeLaSalve(3)).toBe(eventail.projectileCount + 2);
  });

  it('les passifs de cadence empiles accelerent le tir AFFICHE', () => {
    // Le serveur applique `cooldownWithBonus` a chaque tir (tache 8) ; le
    // client doit lire LA MEME fonction, pas la cadence brute du catalogue.
    // Trois cartes : `round(7 * 0.76) = 5`, un pas visible malgre l'arrondi
    // qui avale les deux premieres (R9 du registre).
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
    run(client, socket, TICKS, [{ id: 1, x: 2000, y: 2000, hp: 100, aimX: 127, aimY: 0 }]);

    const base = weaponOf(BASE_WEAPON_ID);
    const attendue = cooldownWithBonus(base.cooldownTicks, passiveOf(CADENCE).magnitude * CARTES);
    expect(attendue).toBeLessThan(base.cooldownTicks);
    const salves = spy.mock.calls.filter((c) => c[0].id === BASE_WEAPON_ID).length;
    expect(salves).toBe(Math.floor((TICKS - 1) / attendue) + 1);
  });

  it('les passifs de degats empiles voyagent avec le projectile affiche', () => {
    // Inerte sur l'issue — la piétaille n'a pas de reserve de PV et le serveur
    // arbitre seul (§5.4) — mais pas silencieux pour autant : le nombre porte
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
    run(client, socket, 3, [{ id: 1, x: 2000, y: 2000, hp: 100, aimX: 127, aimY: 0 }]);

    const base = weaponOf(BASE_WEAPON_ID);
    const attendu = base.damage * (1 + passiveOf(PUISSANCE).magnitude * CARTES);
    expect(attendu).toBeGreaterThan(base.damage);
    const tir = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
    expect(tir?.[6]).toBeCloseTo(attendu, 6);
  });

  it('la prediction locale avance a la vitesse de l inventaire, pas a PLAYER_SPEED', () => {
    // ⚠️ **La dette de la tache 8.** `Room.step` avance le joueur a
    // `PLAYER_SPEED + bonus('speed')`. Une prediction cablee sur la constante
    // prend du retard a CHAQUE tick, et chaque snapshot la ramene en arriere :
    // le joueur voit une reconciliation permanente. Mesure sur la position
    // PREDITE (un flottant), jamais sur celle du snapshot — elle y est
    // arrondie a l'entier, et un pas sous-pixel s'y lirait zero.
    const CARTES = 2;
    let entree: InputAxes = { x: 0, y: 0 };
    const { client, socket } = setup(1, () => entree);

    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, [{ id: 1, x: 2000, y: 2000, hp: 100, aimX: 0, aimY: 0 }]),
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
});

/**
 * Etape 5a, tache 6 — **le ralentissement du Givre, mesure de bout en bout**,
 * avec un VRAI `GameClient` cette fois (le pendant du scenario Z2 de
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
   * `zoneTicks`, sans bouger d'un pixel — le chemin du RAFRAICHISSEMENT
   * (§5.1 bis).
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

  const pending: { element: number; x: number; y: number; bornTick: number; by: number }[] = [];
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
          element: refZones.element[z] ?? 0,
          x: refZones.x[z] ?? 0,
          y: refZones.y[z] ?? 0,
          bornTick: tick,
          by: refZones.by[z] ?? 0,
        });
        announced++;
        inFlight++;
      }
    }

    const players = xs.map((x, i) => ({ id: i, x, y: ys[i] ?? 0, hp: 100, aimX: 0, aimY: 0 }));
    socket.emit('message', { data: encodeSnapshot(tick, 0, 0, players) });

    for (let i = pending.length - 1; i >= 0; i--) {
      const zone = pending[i];
      if (zone && zone.bornTick + zoneDelayTicks === tick) {
        socket.emit('message', {
          data: encodeZone(zone.element, zone.x, zone.y, zone.bornTick, zone.by),
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
  // Hors des frontieres de rafraichissement du champ (`STEPS_PER_FIELD` = 3),
  // pour la meme raison qu'a la tache 8 : sinon un `primeFieldForReplay` qui
  // n'ecarterait pas `atTick` vers `lastDue` passerait inapercu.
  const ZONE_TICKS = [100, 113, 127];
  const ANCHORS = [50, 150, 250];
  /**
   * Un tick d'arrosage des MEMES points, au-dela de
   * `ZONE_REFRESH_INTERVAL_TICKS` : c'est ce qui produit une prolongation, et
   * donc une re-annonce. Sous l'intervalle, la parade de l'etape 3 bis ne
   * prolonge pas — et n'annonce rien.
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

    // Le scenario ne prouve rien si rien n'a ete annonce ni recu.
    // Le scenario ne prouve rien si rien n'a ete annonce ni recu — et le
    // client doit tenir EXACTEMENT la meme reserve que le serveur.
    expect(result.zonesServeur).toBeGreaterThan(0);
    expect(result.zonesRecues).toBe(result.zonesServeur);
    // ⚠️ Plus d'annonces que de zones : ce sont les RAFRAICHISSEMENTS (§5.1
    // bis). Le client ne peut pas les deriver, donc ils voyagent — sans quoi
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
    // regle que `lateDeaths` a l'etape 3.
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

    let annonce: { element: number; x: number; y: number; by: number } | null = null;
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
        annonce = { element: ELEMENT.GIVRE, x: refZones.x[0] ?? 0, y: refZones.y[0] ?? 0, by: 1 };
      }
      if (tick === DEATH_TICK) {
        ref.horde.kill(killedIds);
      }

      const players = xs.map((x, i) => ({ id: i, x, y: ys[i] ?? 0, hp: 100, aimX: 0, aimY: 0 }));
      socket.emit('message', { data: encodeSnapshot(tick, 0, 0, players) });

      if (tick === LIVRAISON && annonce) {
        // ⚠️ Dans l'ordre du serveur : `DEATHS` part AVANT `ZONE` dans le meme
        // lot de diffusion (voir `Server#broadcast`). C'est precisement ce
        // qui rend le drainage inverse dangereux.
        socket.emit('message', { data: encodeDeaths(DEATH_TICK, killedIds) });
        socket.emit('message', {
          data: encodeZone(annonce.element, annonce.x, annonce.y, ZONE_TICK, annonce.by),
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

      const players = xs.map((x, i) => ({ id: i, x, y: ys[i] ?? 0, hp: 100, aimX: 0, aimY: 0 }));
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
 * Étape 5a, tache 9 : ce que le client RECOIT et ce qu'il APPROXIME.
 * ---------------------------------------------------------------------------
 *
 * Deux regimes, et toute la tache tient dans leur difference :
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
    data: encodeSnapshot(0, 0, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
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
    // les degats ici prononcerait une mort que le serveur n'a pas prononcee —
    // exactement ce que `#applyDeaths` et le §3.2 interdisent au rejeu.
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
      data: encodeSnapshot(0, 777, 13, [{ id: 1, x: 10, y: 20, hp: 42, aimX: 0, aimY: 0 }]),
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
    // ⚠️ Le §7 est explicite : le bit porte la COMPARAISON, le total voyage
    // dans le `SNAPSHOT`. Un client qui incrementerait sa propre barre a
    // chaque reaction chargee divergerait de l'autorite des la premiere
    // reaction manquee (connexion en cours de partie, plafond atteint).
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0) });
    socket.emit('message', {
      data: encodeSnapshot(0, 0, 4, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
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
 * La teinte elementaire (§9, deuxieme ligne) est **cosmetique et approximee** :
 * voir la doc de `GameClient#markLocally`, qui porte la regle en entier.
 *
 * ⚠️ **Les deux moities, toujours** (R24/R25) : « aucun ennemi n'est jamais
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
    // Arme a projectile UNIQUE et dispersion etroite : la seule qui touche a
    // coup sur une cible isolee. Choisie par ses proprietes, jamais par un
    // identifiant en dur — le catalogue est du contenu, il bouge.
    const arme = WEAPONS.find((w) => w.element === ELEMENT.GIVRE && w.projectileCount === 1);
    if (!arme) {
      throw new Error('aucune arme elementaire a projectile unique dans le catalogue');
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
        data: encodeSnapshot(tick, 0, 0, [{ id: 1, ...PLAYER, hp: 100, aimX: 0, aimY: 0 }]),
      });
      client.update(tick * (1000 / TICK_HZ), 1 / TICK_HZ);
      marque = client.horde.markAt(0, client.hordeTick - 1);
    }

    expect(marque).toBe(ELEMENT.GIVRE);
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
        data: encodeSnapshot(tick, 0, 0, [{ id: 1, ...PLAYER, hp: 100, aimX: 0, aimY: 0 }]),
      });
      client.update(tick * (1000 / TICK_HZ), 1 / TICK_HZ);
      touche = client.hitFlashes.count > 0;
    }

    expect(touche).toBe(true);
    expect(client.horde.markAt(0, client.hordeTick - 1)).toBe(ELEMENT.BRAISE);
  });
});

/**
 * ⚠️ **Ce test existe parce qu'une mutation a SURVECU** : retirer le
 * `aliveAt` du balayage de zones du client laissait toute la suite verte.
 *
 * La raison est une garde qui en masque une autre — le motif le plus cher de
 * ce depot. Le client expire ses zones `ROLLBACK_DEPTH_TICKS` ticks EN RETARD
 * (il en a besoin pour rejouer), donc une zone perimee reste dans le tableau
 * huit ticks de plus. Sans `aliveAt`, elle continue d'y teindre pendant ces
 * huit ticks — et comme une marque dure `MARK_DURATION_TICKS` (60), l'ecart ne
 * se voit qu'a la toute fin de la teinte, huit ticks plus tard que prevu.
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
          { id: 1, x: monsterX, y: monsterY, hp: 100, aimX: 0, aimY: 0 },
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
