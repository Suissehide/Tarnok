import type { AddressInfo } from 'node:net';
import { MAP_SIZE } from '@shared/constants';
import { PING_INTENTS } from '@shared/ping';
import { decode, encodeHello, encodePing, encodeStart, type Message, MSG } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import * as accounts from './accounts';
import { buildServer } from './server';

/**
 * **Le ping de A arrive chez A et chez B**, avec la
 * bonne intention et la bonne position, et le salon coupe le spam. Vraies
 * sockets, observe a travers le DECODAGE uniquement.
 */

type App = Awaited<ReturnType<typeof buildServer>>;
type PingShown = Extract<Message, { type: typeof MSG.PING_SHOWN }>;

let app: App;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  await accounts.prisma.account.deleteMany();
  app = await buildServer({ roomSeed: 1, waitingRoom: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    ws.close();
  }
  await app.close();
});

async function entre(code: string): Promise<{ ws: WebSocket; recus: Message[] }> {
  const { token } = await accounts.createAccount();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  sockets.push(ws);
  const recus: Message[] = [];
  ws.on('message', (data: ArrayBuffer) => recus.push(decode(data)));
  await new Promise((res) => ws.once('open', res));
  ws.send(encodeHello(token));
  return { ws, recus };
}

async function jusqua<T>(lire: () => T | undefined): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const v = lire();
    if (v !== undefined) {
      return v;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('rien recu');
}

const pings = (recus: Message[]): PingShown[] =>
  recus.filter((m): m is PingShown => m.type === MSG.PING_SHOWN);

/** Deux joueurs dans un salon lance : l'hote (id 1) et l'invite (id 2). */
async function partieADeux() {
  const res = await app.inject({ method: 'POST', url: '/rooms' });
  const salon = res.json<{ code: string }>().code;
  const hote = await entre(salon);
  await jusqua(() => hote.recus.find((m) => m.type === MSG.LOBBY));
  const invite = await entre(salon);
  await jusqua(() => invite.recus.find((m) => m.type === MSG.LOBBY));
  hote.ws.send(encodeStart());
  await jusqua(() => invite.recus.find((m) => m.type === MSG.WELCOME));
  return { salon, hote, invite };
}

describe('etape 9 : le salon arbitre et diffuse les pings', () => {
  it('le ping de l invite arrive chez les deux, intention et position intactes', async () => {
    const { hote, invite } = await partieADeux();
    invite.ws.send(encodePing(PING_INTENTS.indexOf('danger'), 1200, 3400));
    const chezHote = await jusqua(() => pings(hote.recus)[0]);
    const chezInvite = await jusqua(() => pings(invite.recus)[0]);
    const attendu = { type: MSG.PING_SHOWN, playerId: 2, intent: 1, x: 1200, y: 3400 };
    expect(chezHote).toEqual(attendu);
    expect(chezInvite).toEqual(attendu);
  });

  it('le quatrieme ping en moins de deux secondes est coupe, puis ca repasse', async () => {
    const { hote, invite } = await partieADeux();
    for (let i = 0; i < 4; i++) {
      invite.ws.send(encodePing(0, 100 + i, 100));
    }
    // Sentinelle : un ping de l'HOTE, dont le compteur est independant. Quand il
    // est arrive, les quatre de l'invite ont ete traites (une seule socket par
    // joueur, ordre garanti par TCP — mais deux sockets ne le sont pas entre
    // elles : on attend donc aussi le troisieme de l'invite).
    hote.ws.send(encodePing(0, 9, 9));
    await jusqua(() => (pings(hote.recus).some((p) => p.playerId === 1) ? true : undefined));
    await jusqua(() =>
      pings(hote.recus).filter((p) => p.playerId === 2).length >= 3 ? true : undefined,
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(
      pings(hote.recus)
        .filter((p) => p.playerId === 2)
        .map((p) => p.x),
    ).toEqual([100, 101, 102]);

    // Passe la fenetre (2 s de ticks de salon), le meme joueur repasse.
    await new Promise((r) => setTimeout(r, 2100));
    invite.ws.send(encodePing(0, 555, 100));
    await jusqua(() => pings(hote.recus).find((p) => p.x === 555));
  }, 10_000);

  it('une intention inconnue n arrive jamais', async () => {
    const { hote, invite } = await partieADeux();
    invite.ws.send(encodePing(PING_INTENTS.length, 10, 10));
    invite.ws.send(encodePing(0, 77, 77)); // sentinelle, valide
    await jusqua(() => pings(hote.recus).find((p) => p.x === 77));
    expect(pings(hote.recus)).toHaveLength(1);
  });

  it('une position hors carte arrive bornee', async () => {
    const { hote, invite } = await partieADeux();
    invite.ws.send(encodePing(0, -500, MAP_SIZE + 3000));
    const p = await jusqua(() => pings(hote.recus)[0]);
    expect({ x: p.x, y: p.y }).toEqual({ x: 0, y: MAP_SIZE });
  });

  it('rien ne passe en salle d attente', async () => {
    const res = await app.inject({ method: 'POST', url: '/rooms' });
    const salon = res.json<{ code: string }>().code;
    const hote = await entre(salon);
    await jusqua(() => hote.recus.find((m) => m.type === MSG.LOBBY));
    hote.ws.send(encodePing(0, 10, 10));
    await new Promise((r) => setTimeout(r, 200));
    expect(pings(hote.recus)).toHaveLength(0);
  });

  it('un joueur qui revient sur le meme id ne recupere pas la fenetre du precedent', async () => {
    const { salon, hote, invite } = await partieADeux();
    for (let i = 0; i < 3; i++) {
      invite.ws.send(encodePing(0, 200 + i, 10));
    }
    await jusqua(() =>
      pings(hote.recus).filter((p) => p.playerId === 2).length === 3 ? true : undefined,
    );
    invite.ws.close();
    await new Promise((r) => setTimeout(r, 150));
    const retour = await entre(salon);
    await jusqua(() => retour.recus.find((m) => m.type === MSG.WELCOME));
    retour.ws.send(encodePing(0, 999, 10));
    const p = await jusqua(() => pings(hote.recus).find((q) => q.x === 999));
    expect(p.playerId).toBe(2);
  });
});
