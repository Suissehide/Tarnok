import type { AddressInfo } from 'node:net';
import {
  decode,
  encodeHello,
  encodePick,
  encodeStart,
  type Message,
  MSG,
  NO_WEAPON,
} from '@shared/protocol';
import { BASE_WEAPON_ID, startingWeapons } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import * as accounts from './accounts';
import { buildServer, partsFortune } from './server';

type App = Awaited<ReturnType<typeof buildServer>>;

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

/** Une socket authentifiee, et la file de tout ce qu'elle recoit. */
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
  for (let i = 0; i < 100; i++) {
    const v = lire();
    if (v !== undefined) {
      return v;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('rien recu');
}

const dernierLobby = (recus: Message[]) =>
  recus.filter((m) => m.type === MSG.LOBBY).at(-1) as Extract<Message, { type: typeof MSG.LOBBY }>;

describe('salle d attente', () => {
  it('liste, choix, et seul l hote lance — avec l arme choisie', async () => {
    const res = await app.inject({ method: 'POST', url: '/rooms' });
    const salon = res.json<{ code: string }>().code;

    const hote = await entre(salon);
    await jusqua(() => dernierLobby(hote.recus));
    const invite = await entre(salon);
    await jusqua(() => (dernierLobby(hote.recus)?.players.length === 2 ? true : undefined));
    expect(dernierLobby(invite.recus).you).toBe(2);

    const arme = startingWeapons()[0] as number;
    invite.ws.send(encodePick(BASE_WEAPON_ID)); // refusee : deja tenue par tous
    invite.ws.send(encodePick(arme));
    await jusqua(() => (dernierLobby(hote.recus).players[1]?.weaponId === arme ? true : undefined));
    expect(dernierLobby(hote.recus).players[0]?.weaponId).toBe(NO_WEAPON);

    // L'invite ne peut pas lancer.
    invite.ws.send(encodeStart());
    await new Promise((r) => setTimeout(r, 100));
    expect(hote.recus.some((m) => m.type === MSG.WELCOME)).toBe(false);

    hote.ws.send(encodeStart());
    await jusqua(() => invite.recus.find((m) => m.type === MSG.WELCOME));
    const room = app.rooms.get(salon);
    expect(room?.loadoutOf(2)?.weaponIds).toEqual([arme]);
    expect(room?.loadoutOf(1)?.weaponIds).toEqual([]);
  });
});

describe('Fortune : la cagnotte majoree par compte', () => {
  it('majore chacun de son bonus, regroupe par montant, credite un compte une fois', () => {
    const parts = partsFortune(1000n, [
      ['a', 0.15],
      ['b', 0],
      ['a', 0.15], // second onglet du meme compte
      ['c', 0],
    ]);
    expect(parts).toEqual(
      new Map([
        [1150n, ['a']],
        [1000n, ['b', 'c']],
      ]),
    );
  });
});
