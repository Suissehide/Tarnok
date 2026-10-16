import type { AddressInfo } from 'node:net';
import { PORTEUR_ARCHETYPE } from '@shared/archetypes';
import { entityIdOf } from '@shared/horde';
import {
  decode,
  encodeDraftToken,
  encodeHello,
  encodeInput,
  type Message,
  MSG,
} from '@shared/protocol';
import { RARITY } from '@shared/rarity';
import { FORMATION } from '@shared/waves';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, prisma } from './accounts';
import { buildServer } from './server';

/**
 * Le livrable de l'etape 11 (§1 de la spec) : **sur deux vraies sockets,
 * l'ordre du porteur arrive aux deux clients, sa mort leur ouvre un
 * `DRAFT_OPEN` dont chaque carte est au moins rare, et chaque client sait que
 * cet etalage est un coffre sans un octet de plus.**
 *
 * ⚠️ **Le seul cas de file reel est force** (ecart n° 5 du plan) : pendant un
 * etalage le monde est gele, donc le porteur ne meurt jamais derriere un
 * etalage ouvert. `room.step` est enveloppe : au tick ou le porteur quitte la
 * horde, un niveau devient du AU MEME TICK (`debugOweLevels`). Le coffre doit
 * passer d'abord, le niveau ensuite.
 *
 * ⚠️ **« Son `GameClient` dit `draftIsChest` »** est rejoue par
 * `drapeauxDeCoffre`, la regle exacte de `GameClient` (ecart n° 4) : le back
 * n'importe pas le front. `client.test.ts` couvre le `GameClient` lui-meme.
 *
 * ⚠️ **La pietaille est retiree HORS du lot de morts** a chaque tick : ni XP
 * (donc aucun niveau parasite), ni joueur submerge. Le decor mesure le coffre.
 */

const ROOM_SEED = 0x11_c0_ff3e;
/** 22 octets d'en-tete + 2 joueurs x 10 : ecrit NU, jamais recalcule (voir l'etape 10). */
const SNAPSHOT_A_DEUX = 42;

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  /** Tout ce qui est arrive sur CETTE socket, hors snapshots. */
  received: Message[];
  /** Les tailles BRUTES des snapshots recus. */
  snapshotBytes: Set<number>;
  /** La taille BRUTE de chaque ordre de porteur recu. */
  porteurOrderBytes: number[];
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
    porteurOrderBytes: [],
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
    if (msg.type === MSG.WAVE_ORDER && msg.archetype === PORTEUR_ARCHETYPE) {
      client.porteurOrderBytes.push(data.byteLength);
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

/**
 * La regle de `GameClient` (etape 11, §4.3), rejouee sur les messages DECODES,
 * dans l'ordre d'arrivee : un drapeau « coffre ? » par `LEVEL_UP`.
 */
function drapeauxDeCoffre(recus: readonly Message[]): boolean[] {
  let porteur: number | null = null;
  let dus = 0;
  const out: boolean[] = [];
  for (const m of recus) {
    if (m.type === MSG.WAVE_ORDER && m.archetype === PORTEUR_ARCHETYPE) {
      porteur = entityIdOf(m.waveId, 0);
    } else if (m.type === MSG.DEATHS && porteur !== null && m.ids.includes(porteur)) {
      dus++;
      porteur = null;
    } else if (m.type === MSG.LEVEL_UP) {
      out.push(dus > 0);
      if (dus > 0) {
        dus--;
      }
    }
  }
  return out;
}

describe('etape 11 : le porteur de coffre, sur vraies sockets (le livrable)', () => {
  it('l ordre arrive aux deux ; sa mort ouvre, AVANT le niveau du meme tick, un etalage tout rare ; zero octet de plus', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('le registre de salons doit etre accessible depuis l app');
    }
    const a = await connect(code);
    const b = await connect(code);
    // A un seul joueur, le snapshot fait 32 octets : on ne mesure qu'a deux.
    a.snapshotBytes.clear();
    b.snapshotBytes.clear();

    let porteurId: number | null = null;
    let dette = false;
    const pas = room.step.bind(room);
    room.step = (dt: number): void => {
      pas(dt);
      const autres: number[] = [];
      for (let i = 0; i < room.horde.count; i++) {
        const id = room.horde.entityIdAt(i);
        if ((room.horde.archetype[i] ?? 0) !== PORTEUR_ARCHETYPE) {
          autres.push(id);
        } else if (porteurId === null) {
          // Il vient de naitre a ~1 500 px : on le pose a 60 px du joueur A,
          // presque mort, pour que le test ne dure pas une battue entiere.
          porteurId = id;
          const pos = room.positionOf(a.playerId);
          room.horde.x[i] = (pos?.x ?? 0) + 60;
          room.horde.y[i] = pos?.y ?? 0;
          room.horde.hp[i] = 0.001;
        }
      }
      if (autres.length > 0) {
        room.horde.kill(autres);
      }
      // Il vient de tomber dans le lot de CE tick : un niveau devient du au
      // meme tick, avant que rien ne s'ouvre.
      if (porteurId !== null && !dette && room.horde.slotOf(porteurId) < 0) {
        dette = true;
        room.debugOweLevels(1);
      }
    };

    // A vise le porteur, PAR LA SOCKET, tant qu'il vit.
    const visee = setInterval(() => {
      if (porteurId === null) {
        return;
      }
      const s = room.horde.slotOf(porteurId);
      const pos = room.positionOf(a.playerId);
      if (s < 0 || !pos) {
        return;
      }
      const dx = (room.horde.x[s] ?? 0) - pos.x;
      const dy = (room.horde.y[s] ?? 0) - pos.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) {
        return;
      }
      a.seq++;
      a.ws.send(
        encodeInput(a.seq, 0, 0, Math.round((dx / len) * 127), Math.round((dy / len) * 127)),
      );
    }, 10);

    try {
      // ---- 1. L'ordre du porteur arrive aux DEUX, en 19 octets -------------
      const ordres = await Promise.all(
        [a, b].map((c) =>
          waitFor(
            () =>
              c.received.find(
                (m) => m.type === MSG.WAVE_ORDER && m.archetype === PORTEUR_ARCHETYPE,
              ) ?? null,
            `ordre du porteur (joueur ${c.playerId})`,
            30_000,
          ),
        ),
      );
      const [oa, ob] = ordres;
      if (oa?.type !== MSG.WAVE_ORDER || ob?.type !== MSG.WAVE_ORDER) {
        throw new Error('WAVE_ORDER attendu');
      }
      expect(ob.waveId).toBe(oa.waveId);
      expect(oa.formation).toBe(FORMATION.POINT);
      expect(oa.count).toBe(1);
      // ⚠️ Nu : la taille d'un ordre de vague ordinaire, rien de plus.
      expect(a.porteurOrderBytes).toEqual([19]);
      expect(b.porteurOrderBytes).toEqual([19]);

      // ---- 2. Il tombe : un DRAFT_OPEN tout rare chez les deux --------------
      const coffres = await Promise.all(
        [a, b].map((c) =>
          waitFor(
            () => c.received.find((m) => m.type === MSG.DRAFT_OPEN) ?? null,
            `DRAFT_OPEN du coffre (joueur ${c.playerId})`,
            20_000,
          ),
        ),
      );
      for (const open of coffres) {
        if (open.type !== MSG.DRAFT_OPEN) {
          throw new Error('DRAFT_OPEN attendu');
        }
        expect(open.cards.length).toBeGreaterThanOrEqual(2);
        for (const carte of open.cards) {
          expect(carte.rarity).toBeGreaterThanOrEqual(RARITY.RARE);
        }
      }
      // Dans l'ordre : la mort du porteur, puis LEVEL_UP, puis DRAFT_OPEN.
      for (const c of [a, b]) {
        const mort = c.received.findIndex(
          (m) => m.type === MSG.DEATHS && porteurId !== null && m.ids.includes(porteurId),
        );
        const up = c.received.findIndex((m) => m.type === MSG.LEVEL_UP);
        const open = c.received.findIndex((m) => m.type === MSG.DRAFT_OPEN);
        expect(mort).toBeGreaterThanOrEqual(0);
        expect(up).toBeGreaterThan(mort);
        expect(open).toBeGreaterThan(up);
      }

      // ---- 3. Le niveau attendait : jetons poses, il s'ouvre ensuite --------
      a.ws.send(encodeDraftToken(0));
      b.ws.send(encodeDraftToken(1));
      await Promise.all(
        [a, b].map((c) =>
          waitFor(
            () => (c.received.filter((m) => m.type === MSG.DRAFT_OPEN).length >= 2 ? true : null),
            `DRAFT_OPEN du niveau (joueur ${c.playerId})`,
            10_000,
          ),
        ),
      );

      // ---- 4. Chacun sait lequel etait le coffre, sans un octet -------------
      expect(drapeauxDeCoffre(a.received)).toEqual([true, false]);
      expect(drapeauxDeCoffre(b.received)).toEqual([true, false]);

      // ---- 5. Rien de plus par tick ----------------------------------------
      expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
      expect([...b.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
    } finally {
      clearInterval(visee);
    }
  }, 60_000);
});
