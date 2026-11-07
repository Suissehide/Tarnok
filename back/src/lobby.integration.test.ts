import type { AddressInfo } from 'node:net';
import { VERB_IDS } from '@shared/abilities';
import { CLASSES, classOf, DEFAULT_CLASS_ID } from '@shared/classes';
import { NAME_MAX_CHARS } from '@shared/constants';
import {
  decode,
  encodeHello,
  encodeName,
  encodePick,
  encodeStart,
  type Message,
  MSG,
  NO_WEAPON,
} from '@shared/protocol';
import { BONUS_ZERO, bonusesOf, priceOf, SHOP_ITEMS } from '@shared/shop';
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

/** Une socket authentifiee (un compte neuf, ou `jeton`), et la file de tout ce qu'elle recoit. */
async function entre(
  code: string,
  jeton?: Uint8Array,
): Promise<{ ws: WebSocket; recus: Message[] }> {
  const token = jeton ?? (await accounts.createAccount()).token;
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
    // Sans choix, la dague, dans un slot comme les autres.
    expect(room?.loadoutOf(1)?.weaponIds).toEqual([BASE_WEAPON_ID]);
  });

  /**
   * Le `START` attend `START_GRACE_MS` : un `PICK` parti au meme instant que
   * le lancement arrive encore en salle d'attente et compte. Apres la
   * fenetre, la run est lancee et le `PICK` tombe dans la branche run, ignore.
   */
  it('un PICK juste apres le START compte encore, un PICK apres le WELCOME non', async () => {
    const res = await app.inject({ method: 'POST', url: '/rooms' });
    const salon = res.json<{ code: string }>().code;
    const hote = await entre(salon);
    await jusqua(() => dernierLobby(hote.recus));

    const [tot, tard] = startingWeapons() as [number, number];
    hote.ws.send(encodeStart());
    hote.ws.send(encodePick(tot, DEFAULT_CLASS_ID));
    await jusqua(() => hote.recus.find((m) => m.type === MSG.WELCOME));
    hote.ws.send(encodePick(tard, DEFAULT_CLASS_ID));
    await new Promise((r) => setTimeout(r, 100));

    expect(app.rooms.get(salon)?.loadoutOf(1)?.weaponIds).toEqual([tot]);
  });

  // Un classId inconnu, hors catalogue, ou invalide — le
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

  /**
   * `#start` doit lire le `classId` de l'entree de salon (verifie cote
   * TRANSPORT par les tests ci-dessus) et le passer a `Room#join`. Un cablage
   * parfait cote salon qui n'atteindrait pas la partie serait vert et mort.
   */
  it('la classe choisie au salon donne le verbe de CETTE classe une fois la partie lancee', async () => {
    const res = await app.inject({ method: 'POST', url: '/rooms' });
    const salon = res.json<{ code: string }>().code;
    const hote = await entre(salon);
    await jusqua(() => dernierLobby(hote.recus));

    const voulue = CLASSES[2]?.id ?? 2; // Appat
    hote.ws.send(encodePick(NO_WEAPON, voulue));
    await jusqua(() =>
      dernierLobby(hote.recus)?.players[0]?.classId === voulue ? true : undefined,
    );

    hote.ws.send(encodeStart());
    await jusqua(() => hote.recus.find((m) => m.type === MSG.WELCOME));

    const room = app.rooms.get(salon);
    const classe = classOf(voulue);
    if (!classe) {
      throw new Error('classe inconnue');
    }
    expect(room?.useAbility(1, 1, 0)?.verb).toBe(VERB_IDS[classe.verb]);
  });
});

describe('les bonus de compte de chaque joueur voyagent dans LOBBY', () => {
  it('un achat de puissance se lit dans l entree LOBBY de son auteur, zero chez l autre', async () => {
    const puissance = SHOP_ITEMS.find((i) => i.bonusKind === 'damage');
    if (!puissance) {
      throw new Error('aucun article de puissance');
    }
    const { id: accountId, token } = await accounts.createAccount();
    await accounts.creditAccounts([accountId], BigInt(priceOf(puissance, 1)));
    expect(await accounts.buyItem(accountId, puissance.id)).toBe('ok');
    const attendu = bonusesOf(new Map([[puissance.id, 1]]));

    const code = (await app.inject({ method: 'POST', url: '/rooms' })).json<{ code: string }>()
      .code;
    const hote = await entre(code, token);
    await entre(code);
    // L'ordre des slots suit la fin des HELLO, pas leur depart : on lit par `you`.
    const lobby = await jusqua(() => {
      const l = dernierLobby(hote.recus);
      return l?.players.length === 2 ? l : undefined;
    });
    const sien = lobby.players.find((p) => p.playerId === lobby.you);
    const autre = lobby.players.find((p) => p.playerId !== lobby.you);
    expect(sien?.bonuses).toEqual({
      fireRate: attendu.fireRate,
      damage: attendu.damage,
      maxHp: attendu.maxHp,
    });
    expect(autre?.bonuses).toEqual({
      fireRate: BONUS_ZERO.fireRate,
      damage: BONUS_ZERO.damage,
      maxHp: BONUS_ZERO.maxHp,
    });
  });
});

describe('le pseudo (NAME) dans LOBBY', () => {
  async function deux(): Promise<{
    salon: string;
    hote: Awaited<ReturnType<typeof entre>>;
    invite: Awaited<ReturnType<typeof entre>>;
  }> {
    const res = await app.inject({ method: 'POST', url: '/rooms' });
    const salon = res.json<{ code: string }>().code;
    const hote = await entre(salon);
    await jusqua(() => dernierLobby(hote.recus));
    const invite = await entre(salon);
    await jusqua(() => (dernierLobby(hote.recus)?.players.length === 2 ? true : undefined));
    return { salon, hote, invite };
  }

  it('un NAME se relit dans l entree LOBBY de son auteur, chez l autre joueur aussi', async () => {
    const { hote, invite } = await deux();
    invite.ws.send(encodeName('  Zoé '));
    await jusqua(() => (dernierLobby(hote.recus).players[1]?.name === 'Zoé' ? true : undefined));
    expect(dernierLobby(invite.recus).players.map((p) => p.name)).toEqual(['', 'Zoé']);
  });

  it('un nom trop long est tronque a NAME_MAX_CHARS, les controles retires', async () => {
    const { hote, invite } = await deux();
    invite.ws.send(encodeName(`\u0007${'é'.repeat(NAME_MAX_CHARS + 4)}`));
    await jusqua(() => (dernierLobby(hote.recus).players[1]?.name ? true : undefined));
    expect(dernierLobby(hote.recus).players[1]?.name).toBe('é'.repeat(NAME_MAX_CHARS));
  });

  it('un nom vide efface le pseudo : plus de nom dans LOBBY', async () => {
    const { hote, invite } = await deux();
    invite.ws.send(encodeName('Zoé'));
    await jusqua(() => (dernierLobby(hote.recus).players[1]?.name === 'Zoé' ? true : undefined));
    invite.ws.send(encodeName(' \t '));
    await jusqua(() => (dernierLobby(hote.recus).players[1]?.name === '' ? true : undefined));
    expect(dernierLobby(hote.recus).players[1]?.name).toBe('');
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
