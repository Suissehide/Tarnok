import type { AddressInfo } from 'node:net';
import { EVENT_KIND, EVENT_OUTCOME, EVENT_STATE_PERIOD_TICKS } from '@shared/evenements';
import { entityIdOf } from '@shared/horde';
import {
  decode,
  type EventStateMessage,
  encodeHello,
  encodeInput,
  type Message,
  MSG,
} from '@shared/protocol';
import { EVENT_RARITY_FLOOR } from '@shared/rarity';
import { FORMATION } from '@shared/waves';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, prisma } from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

/**
 * Le livrable de l'etape 14 (§1 de la spec) : **sur deux vraies sockets, les
 * deux clients recoivent le meme `EVENT_START`, puis des `EVENT_STATE` a 5 Hz
 * qui montent quand les joueurs remplissent l'objectif et s'arretent quand il
 * s'acheve ; un `EVENT_END` reussi est suivi d'un `LEVEL_UP` et d'un
 * `DRAFT_OPEN` dont chaque carte est au moins epique, et chaque client sait
 * que c'est un etalage d'evenement. Le `SNAPSHOT` garde sa taille.**
 *
 * ⚠️ **« Son `GameClient` dit `draftIsEvent` »** est rejoue par
 * `drapeauxDEvenement`, la regle exacte de `GameClient` (ecart n° 11) : le
 * back n'importe pas le front. `front/src/net/evenement.test.ts` couvre le
 * `GameClient` lui-meme.
 */

const ROOM_SEED = 0x14_e0_e0e0;
/** 22 octets d'en-tete + 2 joueurs x 11 (le bouclier des pactes) : ecrit NU, jamais recalcule. */
const SNAPSHOT_A_DEUX = 44;
/** Une graine du genre voulu : le genre est `graine % 3`. */
const graine = (genre: number): number => 3 * 0x4_6a2b + genre;

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  /** Tout ce qui est arrive sur CETTE socket, hors snapshots. */
  received: Message[];
  /** Les tailles BRUTES des snapshots recus. */
  snapshotBytes: Set<number>;
  /** Les tailles BRUTES des messages d'evenement, par type. */
  eventBytes: Map<number, Set<number>>;
  seq: number;
}

let app: App;
let port: number;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  await prisma.account.deleteMany();
  app = await buildServer({ roomSeed: ROOM_SEED });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const ws of openSockets.splice(0)) {
    ws.close();
  }
  await app.close();
});

async function createRoomCode(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/rooms' });
  return res.json<{ code: string }>().code;
}

async function connect(code: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  openSockets.push(ws);
  // L'ecoute de 'open' AVANT tout `await` (voir `draft.integration.test.ts`).
  const ouverte = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const client: Client = {
    ws,
    playerId: 0,
    received: [],
    snapshotBytes: new Set(),
    eventBytes: new Map(),
    seq: 0,
  };
  ws.on('message', (data: ArrayBuffer) => {
    const msg = decode(data);
    if (msg.type === MSG.WELCOME) {
      client.playerId = msg.playerId;
    }
    if (msg.type === MSG.SNAPSHOT) {
      client.snapshotBytes.add(data.byteLength);
      return;
    }
    if (
      msg.type === MSG.EVENT_START ||
      msg.type === MSG.EVENT_STATE ||
      msg.type === MSG.EVENT_END
    ) {
      const tailles = client.eventBytes.get(msg.type) ?? new Set<number>();
      tailles.add(data.byteLength);
      client.eventBytes.set(msg.type, tailles);
    }
    client.received.push(msg);
  });
  const { token } = await createAccount();
  await ouverte;
  ws.send(encodeHello(token));
  await waitFor(() => (client.playerId !== 0 ? client.playerId : null), 'WELCOME', 3000);
  return client;
}

async function waitFor<T>(probe: () => T | null, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`${what} : rien en ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 8));
  }
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retire de la horde tout ce qui n'est pas dans `garder`, HORS du lot de morts. */
function viderSauf(room: Room, garder: ReadonlySet<number>): void {
  const ids: number[] = [];
  for (let i = 0; i < room.horde.count; i++) {
    const id = room.horde.entityIdAt(i);
    if (!garder.has(id)) {
      ids.push(id);
    }
  }
  if (ids.length > 0) {
    room.horde.kill(ids);
  }
}

/** Enveloppe `room.step` : `apres` s'execute a la fin de chaque tick du serveur. */
function envelopper(room: Room, apres: () => void): void {
  const pas = room.step.bind(room);
  room.step = (dt: number): void => {
    pas(dt);
    apres();
  };
}

/**
 * La regle de `GameClient` (etape 14, §6.5), rejouee sur les messages
 * DECODES, dans l'ordre d'arrivee : un drapeau « evenement ? » par `LEVEL_UP`.
 * Aucun coffre ici : la horde est retiree hors du lot de morts.
 */
function drapeauxDEvenement(recus: readonly Message[]): boolean[] {
  let dus = 0;
  const out: boolean[] = [];
  for (const m of recus) {
    if (m.type === MSG.EVENT_END && m.outcome === EVENT_OUTCOME.REUSSI) {
      dus++;
    } else if (m.type === MSG.LEVEL_UP) {
      out.push(dus > 0);
      if (dus > 0) {
        dus--;
      }
    }
  }
  return out;
}

const etats = (c: Client): EventStateMessage[] =>
  c.received.filter((m): m is EventStateMessage => m.type === MSG.EVENT_STATE);

async function salonADeux(): Promise<{ room: Room; a: Client; b: Client }> {
  const code = await createRoomCode();
  const room = app.rooms.get(code);
  if (!room) {
    throw new Error('le registre de salons doit etre accessible depuis l app');
  }
  const a = await connect(code);
  const b = await connect(code);
  // A un seul joueur, le snapshot fait 33 octets : on ne mesure qu'a deux.
  a.snapshotBytes.clear();
  b.snapshotBytes.clear();
  return { room, a, b };
}

describe('etape 14 : les evenements bonus, sur vraies sockets (le livrable)', () => {
  it('les sceaux : meme depart chez les deux, etats a 5 Hz, reussite, puis un etalage tout epique nomme evenement', async () => {
    const { room, a, b } = await salonADeux();
    let debut = -1;
    let fin = -1;
    envelopper(room, () => {
      viderSauf(room, new Set());
      const sceaux = room.eventPoints;
      const [s0, s1] = sceaux ?? [];
      if (s0 && s1) {
        room.debugPlace(a.playerId, s0.x, s0.y);
        room.debugPlace(b.playerId, s1.x, s1.y);
      } else if (debut >= 0 && fin < 0) {
        fin = room.tick;
      }
    });
    room.debugStartEvent(graine(EVENT_KIND.SCEAUX));
    debut = room.tick;

    // ---- 1. La reussite, chez les deux --------------------------------------
    await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.EVENT_END) ?? null,
          `EVENT_END (joueur ${c.playerId})`,
          40_000,
        ),
      ),
    );
    // ---- 2. Puis l'etalage ---------------------------------------------------
    const opens = await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.DRAFT_OPEN) ?? null,
          `DRAFT_OPEN (joueur ${c.playerId})`,
          5_000,
        ),
      ),
    );

    // ---- 3. Le meme depart, en 13 octets (deux sceaux) -----------------------
    const departs = [a, b].map((c) => c.received.find((m) => m.type === MSG.EVENT_START));
    expect(departs[0]).toEqual(departs[1]);
    expect(departs[0]).toMatchObject({ type: MSG.EVENT_START, kind: EVENT_KIND.SCEAUX });
    for (const c of [a, b]) {
      expect([...(c.eventBytes.get(MSG.EVENT_START) ?? [])]).toEqual([13]);
      expect([...(c.eventBytes.get(MSG.EVENT_STATE) ?? [])]).toEqual([7]);
      expect([...(c.eventBytes.get(MSG.EVENT_END) ?? [])]).toEqual([2]);
    }

    // ---- 4. Les etats : 5 Hz de jeu, qui montent, et rien apres la fin -------
    expect(fin).toBeGreaterThan(debut);
    expect(etats(a)).toHaveLength(etats(b).length);
    expect(
      Math.abs(etats(a).length - (fin - debut) / EVENT_STATE_PERIOD_TICKS),
    ).toBeLessThanOrEqual(1);
    const progres = etats(a).map((e) => e.progress);
    expect(progres).toEqual([...progres].sort((x, y) => x - y));
    expect(progres.at(-1)).toBeGreaterThan(0);
    for (const c of [a, b]) {
      const types = c.received.map((m) => m.type);
      const iFin = types.indexOf(MSG.EVENT_END);
      expect(c.received[iFin]).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.REUSSI });
      expect(types.lastIndexOf(MSG.EVENT_STATE)).toBeLessThan(iFin);
      // Dans l'ordre : la fin, le LEVEL_UP, l'etalage.
      expect(types.indexOf(MSG.LEVEL_UP)).toBeGreaterThan(iFin);
      expect(types.indexOf(MSG.DRAFT_OPEN)).toBeGreaterThan(types.indexOf(MSG.LEVEL_UP));
    }

    // ---- 5. L'etalage : min(2 + 3, 6) cartes, toutes au moins epiques -------
    for (const open of opens) {
      if (open.type !== MSG.DRAFT_OPEN) {
        throw new Error('DRAFT_OPEN attendu');
      }
      expect(open.cards).toHaveLength(5);
      for (const carte of open.cards) {
        expect(carte.rarity).toBeGreaterThanOrEqual(EVENT_RARITY_FLOOR);
      }
    }

    // ---- 6. Chacun sait que c'est un etalage d'evenement, sans un octet ------
    expect(drapeauxDEvenement(a.received)).toEqual([true]);
    expect(drapeauxDEvenement(b.received)).toEqual([true]);

    // ---- 7. Rien de plus par tick --------------------------------------------
    expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
    expect([...b.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
  }, 60_000);

  /**
   * La forge se lit sur l'ENTREE (§3.2). Le decor repose A sur la forge a
   * chaque tick : l'entree de mouvement envoyee PAR LA SOCKET est donc la
   * seule chose qui change — et elle suffit a suspendre, sans remise a zero.
   */
  it('la forge : immobile elle monte, une entree de mouvement la suspend sans la remettre a zero', async () => {
    const { room, a, b } = await salonADeux();
    envelopper(room, () => {
      viderSauf(room, new Set());
      const forge = room.eventPoints?.[0];
      if (forge) {
        room.debugPlace(a.playerId, forge.x, forge.y);
      }
    });
    room.debugStartEvent(graine(EVENT_KIND.FORGE));

    // 1. Immobile : ca monte.
    await waitFor(
      () => (etats(a).filter((e) => e.progress > 0).length >= 2 ? true : null),
      'la forge monte',
      5_000,
    );
    // 2. A bouge, par la socket.
    const bouge = setInterval(() => {
      a.seq++;
      a.ws.send(encodeInput(a.seq, 127, 0, 0, 0));
    }, 10);
    let gele = -1;
    try {
      await dormir(600);
      gele = etats(a).at(-1)?.progress ?? -1;
      const n = etats(a).length;
      await dormir(1_000);
      const pendant = etats(a).slice(n);
      expect(pendant.length).toBeGreaterThanOrEqual(3);
      for (const e of pendant) {
        expect(e.progress).toBe(gele);
      }
      // Suspendu, pas remis a zero.
      expect(gele).toBeGreaterThan(0);
    } finally {
      clearInterval(bouge);
    }
    // 3. Immobile de nouveau : ca repart d'ou c'etait.
    a.seq++;
    a.ws.send(encodeInput(a.seq, 0, 0, 0, 0));
    await waitFor(
      () => ((etats(a).at(-1)?.progress ?? 0) > gele ? true : null),
      'la forge repart',
      5_000,
    );
    expect(etats(b).length).toBeGreaterThan(0);
  }, 30_000);

  it('le convoi : sans escorte et sous cinq ennemis, il est detruit — aucun etalage', async () => {
    const { room, a, b } = await salonADeux();
    room.debugStartEvent(graine(EVENT_KIND.CONVOI));
    const depart = room.eventPoints?.[0];
    if (!depart) {
      throw new Error('le convoi a un depart');
    }
    // Cinq frappeurs, reposes sur le chariot a chaque tick ; tout le reste retire.
    // Les joueurs sont a ~1 200 px : personne n'escorte, le chariot attend.
    // ⚠️ `waveId` est un `Uint16Array` cote horde (`shared/horde.ts` l.499) :
    // 990 014 (le brief) deborde et se tronque silencieusement a 6 974, ce qui
    // desaccorde `frappeurs` de l'identite reellement posee et vide la horde
    // au premier `viderSauf`. 61 014 reste sous 65 536.
    room.horde.spawn({
      waveId: 61_014,
      spawnTick: room.tick,
      seed: 1,
      archetype: 0,
      formation: FORMATION.SCATTER,
      anchorX: depart.x,
      anchorY: depart.y,
      count: 5,
    });
    const frappeurs = new Set(Array.from({ length: 5 }, (_, k) => entityIdOf(61_014, k)));
    envelopper(room, () => {
      viderSauf(room, frappeurs);
      for (let i = 0; i < room.horde.count; i++) {
        room.horde.x[i] = depart.x;
        room.horde.y[i] = depart.y;
      }
    });

    const fins = await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.EVENT_END) ?? null,
          `EVENT_END (joueur ${c.playerId})`,
          15_000,
        ),
      ),
    );
    for (const f of fins) {
      expect(f).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.DETRUIT });
    }
    // Les PV du chariot descendent, le chariot n'a pas bouge.
    const pv = etats(a).map((e) => e.cartHp);
    expect(pv[0]).toBe(255);
    expect(pv).toEqual([...pv].sort((x, y) => y - x));
    for (const e of etats(a)) {
      expect({ x: e.cartX, y: e.cartY }).toEqual(depart);
    }
    // Un evenement rate ne doit rien : aucun etalage.
    await dormir(1_000);
    for (const c of [a, b]) {
      expect(c.received.some((m) => m.type === MSG.LEVEL_UP)).toBe(false);
      expect(c.received.some((m) => m.type === MSG.DRAFT_OPEN)).toBe(false);
      expect([...(c.eventBytes.get(MSG.EVENT_START) ?? [])]).toEqual([13]);
    }
    expect(drapeauxDEvenement(a.received)).toEqual([]);
    expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
    expect([...b.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
  }, 30_000);
});
