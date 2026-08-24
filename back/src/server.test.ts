import type { AddressInfo } from 'node:net';
import { decode, encodeInput, type Message, MSG, type SnapshotMessage } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { buildServer } from './server';

type App = Awaited<ReturnType<typeof buildServer>>;

let app: App;
let port: number;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  app = await buildServer();
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

/** Ouvre une socket de jeu et attend le WELCOME. */
async function connect(code: string): Promise<{ ws: WebSocket; playerId: number }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  openSockets.push(ws);

  const welcome = await nextMessage(ws, (m) => m.type === MSG.WELCOME);
  if (welcome.type !== MSG.WELCOME) {
    throw new Error('WELCOME attendu');
  }
  return { ws, playerId: welcome.playerId };
}

function nextMessage(ws: WebSocket, match: (m: Message) => boolean): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('aucun message correspondant en 3 s'));
    }, 3000);

    function cleanup(): void {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    }
    function onMessage(data: ArrayBuffer): void {
      const msg = decode(data);
      if (match(msg)) {
        cleanup();
        resolve(msg);
      }
    }
    function onClose(): void {
      cleanup();
      reject(new Error('socket fermee avant le message attendu'));
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

function nextSnapshot(
  ws: WebSocket,
  match: (s: SnapshotMessage) => boolean,
): Promise<SnapshotMessage> {
  return nextMessage(ws, (m) => m.type === MSG.SNAPSHOT && match(m)) as Promise<SnapshotMessage>;
}

describe('GET /health', () => {
  it('repond ok, ce dont le healthcheck compose a besoin', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('POST /rooms', () => {
  it('rend un code de salon de quatre lettres', async () => {
    const res = await app.inject({ method: 'POST', url: '/rooms' });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ code: string }>().code).toMatch(/^[A-Z]{4}$/);
  });
});

describe('la socket de jeu', () => {
  it('attribue un identifiant distinct a chaque joueur du salon', async () => {
    const code = await createRoomCode();
    const a = await connect(code);
    const b = await connect(code);

    expect(a.playerId).not.toBe(b.playerId);
  });

  it('diffuse a chacun un snapshot contenant les deux joueurs', async () => {
    const code = await createRoomCode();
    const a = await connect(code);
    await connect(code);

    const snap = await nextSnapshot(a.ws, (s) => s.players.length === 2);

    expect(snap.players).toHaveLength(2);
  });

  it("c'est le serveur qui deplace le joueur, pas le client", async () => {
    const code = await createRoomCode();
    const { ws, playerId } = await connect(code);

    const before = (await nextSnapshot(ws, (s) => s.players.length === 1)).players.find(
      (p) => p.id === playerId,
    );
    if (!before) {
      throw new Error('joueur absent du snapshot');
    }

    // Plein gaz vers la droite, repete : le serveur applique la derniere entree
    // recue a chacun de ses pas.
    for (let seq = 1; seq <= 20; seq++) {
      ws.send(encodeInput(seq, 127, 0));
      await new Promise((r) => setTimeout(r, 10));
    }

    const after = await nextSnapshot(ws, (s) => {
      const me = s.players.find((p) => p.id === playerId);
      return me !== undefined && me.x > before.x;
    });

    const me = after.players.find((p) => p.id === playerId);
    expect(me?.x).toBeGreaterThan(before.x);
    expect(me?.y).toBe(before.y);
  });

  it('retire du snapshot un joueur qui se deconnecte', async () => {
    const code = await createRoomCode();
    const a = await connect(code);
    const b = await connect(code);
    await nextSnapshot(a.ws, (s) => s.players.length === 2);

    b.ws.close();

    const snap = await nextSnapshot(a.ws, (s) => s.players.length === 1);
    expect(snap.players.map((p) => p.id)).toEqual([a.playerId]);
  });

  it('ferme la socket sur un code de salon inconnu', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=ZZZZ`);
    openSockets.push(ws);

    const code = await new Promise<number>((resolve) => {
      ws.on('close', resolve);
    });

    expect(code).toBe(4004);
  });
});
