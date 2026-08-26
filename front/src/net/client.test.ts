import {
  FLOWFIELD_CELL,
  FLOWFIELD_HZ,
  LEVEL_FREEZE_TICKS,
  LEVEL_RESUME_TICKS,
  MAP_SIZE,
  ORB_LIFETIME_TICKS,
  PROJECTILE_HIT_RADIUS,
  ROLLBACK_DEPTH_TICKS,
  TICK_HZ,
} from '@shared/constants';
import { FlowField } from '@shared/flowfield';
import { entityIdOf, Horde } from '@shared/horde';
import { PlayerHistory } from '@shared/player-history';
import {
  encodeDeaths,
  encodeLevelUp,
  encodePickups,
  encodeRunOver,
  encodeSnapshot,
  encodeWaveOrder,
  encodeWelcome,
} from '@shared/protocol';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { weaponOf } from '@shared/weapons';
import { applyObstacles, generateObstacles } from '@shared/worldmap';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GameClient, HIT_FLASH_LIFETIME_MS, type InputAxes } from './client';

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

  send(): void {
    // Rien a envoyer : ce test n'exerce pas le chemin sortant.
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
    );
    expect(client.horde.count).toBe(10);
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
        data: encodeSnapshot(0, 777, [{ id: 1, x: 10, y: 20, hp: 42, aimX: 0, aimY: 0 }]),
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
      data: encodeSnapshot(0, 777, [{ id: 1, x: 10, y: 20, hp: 42, aimX: 0, aimY: 0 }]),
    });

    const state = client.update(0, 0);

    expect(state.xp).toBe(777);
  });
});

const STEP = 1 / TICK_HZ;
const STEPS_PER_FIELD = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));

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
    socket.emit('message', { data: encodeSnapshot(tick, 0, players) });

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
        data: encodeSnapshot(tick, 0, [{ id: 1, x: 3000, y: 3000, hp: 100, aimX: 0, aimY: 0 }]),
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
          data: encodeSnapshot(tick, 0, [{ id: 1, x: 3000, y: 3000, hp: 100, aimX: 0, aimY: 0 }]),
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
    const FREEZE_END = FREEZE_START + LEVEL_FREEZE_TICKS - 1;
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
        data: encodeSnapshot(tick, 0, [{ id: 1, x: 3000, y: 3000, hp: 100, aimX: 0, aimY: 0 }]),
      });
      // Envoye bien avant que le gel ne prenne effet : si le client gelait a
      // la reception, tout mouvement s'arreterait des ce tick au lieu de
      // FREEZE_START.
      if (tick === 20) {
        socket.emit('message', { data: encodeLevelUp(FREEZE_START, 2) });
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
        data: encodeSnapshot(0, 0, [{ id: 1, x: 500, y: 500, hp: 100, aimX: 0, aimY: 0 }]),
      });

      const FREEZE_START = 10;
      const FREEZE_END = FREEZE_START + LEVEL_FREEZE_TICKS - 1;
      const RESUME_END = FREEZE_END + LEVEL_RESUME_TICKS;
      const END = RESUME_END + 30;
      socket.emit('message', { data: encodeLevelUp(FREEZE_START, 2) });

      let duringFreezeTravel = 0;
      let afterResumeTravel = 0;
      let prevX: number | null = null;

      for (let tick = 0; tick < END; tick++) {
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
    const FREEZE_END = FREEZE_START + LEVEL_FREEZE_TICKS - 1;
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

    for (let tick = FREEZE_START + 5; tick < RESUME_END - 5; tick++) {
      client.update(tick * STEP, STEP);
    }
    expect(client.isFrozen).toBe(true);

    // Bien apres RESUME_END : redevenu faux.
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
      data: encodeSnapshot(0, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
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
      data: encodeSnapshot(0, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
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
          data: encodeSnapshot(tick, 0, [{ id: 1, ...PLAYER, hp: 100, aimX: 0, aimY: 0 }]),
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
        data: encodeSnapshot(tick, 0, [{ id: 1, ...PLAYER, hp: 100, aimX: 0, aimY: 0 }]),
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
        data: encodeSnapshot(tick, 0, [{ id: 1, ...PLAYER, hp: 0, aimX: 0, aimY: 0 }]),
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
        data: encodeSnapshot(tick, 0, [{ id: 1, ...PLAYER, hp: 100, aimX: 0, aimY: 0 }]),
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
        data: encodeSnapshot(tick, 0, [{ id: 1, ...PLAYER, hp: 100, aimX: 0, aimY: 0 }]),
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
      data: encodeSnapshot(0, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
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
        data: encodeSnapshot(tick, 0, [
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
        data: encodeSnapshot(0, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
      });
      // Le spy est pose AVANT le tout premier `update()` : c'est celui-la qui
      // tire (cooldown jamais entame), et le rater ferait attendre la
      // prochaine fenetre de cooldown (7 ticks) pour rien.
      const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
      client.update(0, STEP);
      for (let tick = 1; tick <= 5 && spy.mock.calls.length === 0; tick++) {
        socket.emit('message', {
          data: encodeSnapshot(tick, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
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
      data: encodeSnapshot(0, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
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
        data: encodeSnapshot(tick, 0, [{ id: 1, ...PLAYER, hp: 100, aimX: -127, aimY: 0 }]),
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
      data: encodeSnapshot(0, 0, [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }]),
    });
    client.update(0, STEP);
    expect(client.horde.count).toBe(1);

    const monsterX = client.horde.x[0] ?? 0;
    const monsterY = client.horde.y[0] ?? 0;
    const PLAYER = { x: monsterX - 50, y: monsterY };
    const snapshot = (tick: number): ArrayBuffer =>
      encodeSnapshot(tick, 0, [{ id: 1, ...PLAYER, hp: 100, aimX: 0, aimY: 0 }]);

    // Le gel prend effet au tick 2 : le message part avant, comme le fait le
    // serveur, et c'est le tick DATE qui compte.
    const FREEZE_START = 2;
    socket.emit('message', { data: encodeLevelUp(FREEZE_START, 2) });

    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    // Fenetre de gel strict : `#advanceHorde` ne tire pas tant que
    // `tick <= #freezeUntilTick`.
    const FREEZE_END = FREEZE_START + LEVEL_FREEZE_TICKS - 1;
    for (let tick = FREEZE_START; tick <= FREEZE_END; tick++) {
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
