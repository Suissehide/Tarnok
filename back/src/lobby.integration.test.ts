import type { AddressInfo } from 'node:net';
import { CLASSES, DEFAULT_CLASS_ID } from '@shared/classes';
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
    invite.ws.send(encodePick(BASE_WEAPON_ID, DEFAULT_CLASS_ID)); // refusee : deja tenue par tous
    invite.ws.send(encodePick(arme, DEFAULT_CLASS_ID));
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

  // Review Focus n1 : un classId inconnu, hors catalogue, ou invalide — le
  // client peut envoyer n'importe quoi, le choix n'est simplement pas
  // enregistre, exactement comme une arme hors liste.
  it('un classId hors catalogue n est PAS enregistre, et le joueur garde la classe par defaut', async () => {
    const res = await app.inject({ method: 'POST', url: '/rooms' });
    const salon = res.json<{ code: string }>().code;
    const { ws, recus } = await entre(salon);
    await jusqua(() => dernierLobby(recus));

    // Trois formes d'invalide : au-dela du catalogue, la sentinelle des
    // armes employee par erreur, et un nombre quelconque hors catalogue.
    for (const mauvais of [CLASSES.length, 255, 200]) {
      ws.send(encodePick(NO_WEAPON, mauvais));
    }
    // Sentinelle : une arme valide, envoyee avec une classe TOUJOURS hors
    // catalogue, pour attendre que le salon ait bien traite les messages
    // precedents sans deviner un delai arbitraire.
    const arme = startingWeapons()[0] as number;
    ws.send(encodePick(arme, 200));
    await jusqua(() => (dernierLobby(recus)?.players[0]?.weaponId === arme ? true : undefined));

    expect(dernierLobby(recus)?.players[0]?.classId).toBe(DEFAULT_CLASS_ID);
  });

  // Les deux choix d'un meme PICK s'enregistrent INDEPENDAMMENT : une arme
  // refusee ne doit pas faire perdre une classe valide envoyee dans le meme
  // message (ni l'inverse). BASE_WEAPON_ID est exclue de startingWeapons(),
  // donc toujours refusee, quel que soit l'etat du salon.
  it('une arme refusee n empeche pas l enregistrement d une classe valide dans le meme message', async () => {
    const res = await app.inject({ method: 'POST', url: '/rooms' });
    const salon = res.json<{ code: string }>().code;
    const { ws, recus } = await entre(salon);
    await jusqua(() => dernierLobby(recus));

    const voulue = CLASSES[1]?.id ?? 1;
    ws.send(encodePick(BASE_WEAPON_ID, voulue));
    await jusqua(() => (dernierLobby(recus)?.players[0]?.classId === voulue ? true : undefined));

    expect(dernierLobby(recus)?.players[0]?.weaponId).toBe(NO_WEAPON);
    expect(dernierLobby(recus)?.players[0]?.classId).toBe(voulue);
  });

  it('un classId valide est enregistre et rediffuse a tout le salon', async () => {
    const res = await app.inject({ method: 'POST', url: '/rooms' });
    const salon = res.json<{ code: string }>().code;
    const hote = await entre(salon);
    await jusqua(() => dernierLobby(hote.recus));
    const invite = await entre(salon);
    await jusqua(() => (dernierLobby(hote.recus)?.players.length === 2 ? true : undefined));

    const voulue = CLASSES[2]?.id ?? 2;
    invite.ws.send(encodePick(NO_WEAPON, voulue));
    await jusqua(() =>
      dernierLobby(hote.recus)?.players[1]?.classId === voulue ? true : undefined,
    );

    // Rediffuse a TOUT le salon, pas seulement a l'auteur du choix.
    expect(dernierLobby(hote.recus)?.players[1]?.classId).toBe(voulue);
    expect(dernierLobby(invite.recus)?.players[1]?.classId).toBe(voulue);
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
