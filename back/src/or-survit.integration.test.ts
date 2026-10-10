import type { AddressInfo } from 'node:net';
import { TICK_HZ } from '@shared/constants';
import {
  decode,
  encodeHello,
  encodeInput,
  encodeVote,
  type Message,
  MSG,
  type SnapshotMessage,
  VOTE_CHOICE,
} from '@shared/protocol';
import { BASE_WEAPON_ID, weaponOf } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { findAccountIdByToken, goldOf, prisma, textToToken } from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

/**
 * **La tache 8 de l'etape 7a, le livrable : l'or survit a la fermeture du
 * navigateur.**
 *
 * ⚠️ **Ce fichier ne refait PAS ce que `credit.integration.test.ts` fait deja.**
 * Ce fichier-la prouve que le SERVEUR ECRIT (en relisant la base directement
 * par `goldOf`). Celui-ci prouve que l'or SURVIT : qu'une SECONDE connexion,
 * qui ne partage aucun etat avec la premiere -- ni socket, ni objet JS, ni
 * process memoire -- et qui ne presente que le jeton, retrouve le nouveau
 * solde via la meme route HTTP qu'un navigateur reel appellerait au
 * rechargement. Verifier que la base contient 1200 prouverait l'ecriture ;
 * verifier qu'une requete `GET /accounts/me` neuve, apres fermeture de la
 * socket, lit 1200 prouve la survie -- c'est la phrase du §13 rendue
 * executable, et la seule chose que ce fichier ajoute.
 *
 * ⚠️ **Harnais duplique, pas importe** (ruling P3) : aucun fichier
 * d'integration de ce depot n'en importe un autre, chacun porte sa propre
 * copie -- voir `credit.integration.test.ts` et `portal.integration.test.ts`.
 */

const ROOM_SEED = 0x6a11_0008;
const DT = 1 / TICK_HZ;

const DISTANCE_BOSS = 100;
const DAGUE = weaponOf(BASE_WEAPON_ID);
const PORTEE_DAGUE = (DAGUE.projectileSpeed * DAGUE.projectileLifeTicks) / TICK_HZ;
if (DISTANCE_BOSS >= PORTEE_DAGUE) {
  throw new Error('le boss doit etre tenu a portee de la dague');
}

const TICKS_PAR_RESPIRATION = 60;
const RESPIRATION_MS = 20;

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  accountId: string;
  received: Message[];
  lastSnapshot: SnapshotMessage | null;
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

/** Attend `probe` (sync ou async), ou leve au bout de `timeoutMs`. */
async function attendre<T>(
  probe: () => T | null | Promise<T | null>,
  quoi: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`${quoi} : rien en ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 8));
  }
}

/** Connecte une socket de jeu avec un jeton DEJA frappe. */
async function connectAvecJeton(code: string, token: Uint8Array): Promise<Client> {
  const accountId = await findAccountIdByToken(token);
  if (accountId === null) {
    throw new Error('jeton inconnu');
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  openSockets.push(ws);

  // ⚠️ L'ecoute de 'open' est posee ICI, avant tout `await` : sur localhost
  // la socket peut s'ouvrir avant la fin d'un aller-retour Prisma, et un
  // listener pose apres l'aurait ratee (455 s perdues a la tache 5).
  const ouverte = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const client: Client = {
    ws,
    playerId: 0,
    accountId,
    received: [],
    lastSnapshot: null,
    seq: 0,
  };

  // ⚠️ L'ecoute de 'message' est posee AVANT l'envoi du HELLO, sinon le
  // WELCOME peut arriver avant qu'on ecoute.
  ws.on('message', (data: ArrayBuffer) => {
    const msg = decode(data);
    if (msg.type === MSG.WELCOME) {
      client.playerId = msg.playerId;
      return;
    }
    if (msg.type === MSG.SNAPSHOT) {
      client.lastSnapshot = msg;
      return;
    }
    client.received.push(msg);
  });

  await ouverte;
  ws.send(encodeHello(token));

  await attendre(() => (client.playerId !== 0 ? client.playerId : null), 'WELCOME', 3000);
  return client;
}

function respirer(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

function finDeRun(client: Client): Message | undefined {
  return client.received.find((m) => m.type === MSG.RUN_OVER);
}

function envoyer(client: Client, moveX: number, moveY: number, aimX: number, aimY: number): void {
  client.seq++;
  client.ws.send(encodeInput(client.seq, moveX, moveY, aimX, aimY));
}

async function snapshotFrais(client: Client): Promise<SnapshotMessage> {
  const avant = client.lastSnapshot?.tick ?? -1;
  return attendre(
    () => {
      const s = client.lastSnapshot;
      return s && s.tick > avant ? s : null;
    },
    'un SNAPSHOT frais',
    5000,
  );
}

function positionDuFil(client: Client): { x: number; y: number } {
  const moi = client.lastSnapshot?.players.find((p) => p.id === client.playerId);
  if (!moi) {
    throw new Error(`le joueur ${client.playerId} est absent du dernier snapshot`);
  }
  return { x: moi.x, y: moi.y };
}

/** Coupe le deplacement, et rend la position une fois qu'elle a cesse de bouger. */
async function immobiliser(client: Client): Promise<{ x: number; y: number }> {
  envoyer(client, 0, 0, 0, 0);
  for (let i = 0; i < 100; i++) {
    await snapshotFrais(client);
    const a = positionDuFil(client);
    await snapshotFrais(client);
    const b = positionDuFil(client);
    if (a.x === b.x && a.y === b.y) {
      return b;
    }
  }
  throw new Error('le joueur ne s arrete pas');
}

/** Retire de la horde tout sauf les identites `garder` — copie de credit.integration.test.ts. */
function viderSauf(room: Room, garder: readonly (number | null)[]): void {
  const ids: number[] = [];
  for (let i = 0; i < room.horde.count; i++) {
    const id = room.horde.entityIdAt(i);
    if (!garder.includes(id)) {
      ids.push(id);
    }
  }
  if (ids.length > 0) {
    room.horde.kill(ids);
  }
}

/** Avance le salon depuis le test, en rendant la main a la boucle du serveur par respirations. */
async function avancerJusqua(
  room: Room,
  pret: () => boolean,
  quoi: string,
  maxTicks: number,
  parTick: () => void,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (pret()) {
      return;
    }
    parTick();
    room.step(DT);
    if (i % TICKS_PAR_RESPIRATION === TICKS_PAR_RESPIRATION - 1) {
      await respirer(RESPIRATION_MS);
    }
  }
  await respirer(RESPIRATION_MS);
  if (!pret()) {
    throw new Error(`${quoi} : rien en ${maxTicks} ticks`);
  }
}

/**
 * Amene le boss du palier courant puis le fait tomber, en ouvrant le portail.
 * Copie de `tuerLeBoss` dans `credit.integration.test.ts` : ce fichier n'a
 * besoin de rien de plus que l'OUVERTURE du portail, jamais la precision du
 * tick de mort.
 */
async function tuerLeBoss(room: Room, tireur: Client): Promise<void> {
  const k = room.palier;
  await avancerJusqua(
    room,
    () => room.bossEntityId !== null,
    "l'apparition du boss",
    150 * TICK_HZ,
    () => {
      viderSauf(room, [room.bossEntityId]);
    },
  );
  const bossId = room.bossEntityId;
  if (bossId === null) {
    throw new Error('le boss doit etre en jeu');
  }

  const ancre = await immobiliser(tireur);
  const slot = room.horde.slotOf(bossId);
  expect(slot).toBeGreaterThanOrEqual(0);
  room.horde.hp[slot] = 1;

  envoyer(tireur, 0, 0, 127, 0);
  await attendre(
    () =>
      (tireur.lastSnapshot?.players.find((p) => p.id === tireur.playerId)?.aimX ?? 0) > 0
        ? true
        : null,
    'la visee du tueur revenue dans le SNAPSHOT',
    5000,
  );

  await avancerJusqua(
    room,
    () => room.palier === k + 1,
    'la mort du boss',
    60 * TICK_HZ,
    () => {
      const s = room.horde.slotOf(bossId);
      if (s >= 0) {
        room.horde.x[s] = ancre.x + DISTANCE_BOSS;
        room.horde.y[s] = ancre.y;
      }
      viderSauf(room, [bossId]);
    },
  );
  expect(room.palier).toBe(k + 1);
  expect(room.portalOpen).toBe(true);
}

/**
 * Attend que le credit (fonction du drain de `RUN_OVER`, lance en « fire and
 * forget » par `Session`) ait eu le temps de s'ecrire, ou abandonne apres
 * `timeoutMs` en rendant la derniere valeur lue. Copie de
 * `credit.integration.test.ts` -- voir son docbloc pour le ceiling connu.
 */
async function attendreCreditOuAbandon(
  accountId: string,
  avant: bigint,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    const valeur = await goldOf(accountId);
    if (valeur !== avant) {
      return;
    }
    await respirer(15);
  } while (Date.now() < deadline);
}

/**
 * Fait tuer le boss courant par `clients[0]`, ouvre le portail, puis fait
 * voter TOUS les `clients` donnes pour l'extraction. Copie de
 * `voteExtraction` dans `credit.integration.test.ts`.
 *
 * ⚠️ **La cagnotte posee par l'appelant est REIMPOSEE juste avant le vote.**
 * Tuer le boss pour ouvrir le portail paie AUSSI le bonus d'or du palier --
 * c'est `Room#step` qui l'ajoute, au tick de la mort du boss
 * (`this.#gold += palierGold(...)`), PAS `#endRun` : `#endRun` dit lui-meme
 * explicitement « l'or n'est pas touche ici ». Un piege de decor trouve a la
 * tache 6. Sans cette remise a niveau, le credit mesure plus loin serait
 * celui de `debugSetGold(...)` MAJORE d'un bonus que ce fichier n'a jamais
 * demande, et les montants attendus (1200, 700) ne tomberaient pas juste.
 */
async function voteExtraction(clients: readonly Client[], room: Room): Promise<void> {
  const tireur = clients[0];
  if (!tireur) {
    throw new Error('au moins un client attendu');
  }

  const avant = new Map<string, bigint>();
  for (const c of clients) {
    avant.set(c.accountId, await goldOf(c.accountId));
  }

  const cagnotte = room.gold;
  await tuerLeBoss(room, tireur);
  room.debugSetGold(cagnotte);

  for (const c of clients) {
    c.ws.send(encodeVote(VOTE_CHOICE.LEAVE));
  }

  for (const c of clients) {
    await attendre(() => (finDeRun(c) ? true : null), `RUN_OVER pour ${c.playerId}`, 15_000);
  }

  await Promise.all(
    clients.map((c) => attendreCreditOuAbandon(c.accountId, avant.get(c.accountId) ?? 0n, 2000)),
  );
}

describe('etape 7a : le livrable du §13 — l or survit a la fermeture du navigateur', () => {
  /**
   * ⚠️ **La seconde connexion est tout le test.** Verifier que la base
   * contient 1200 prouverait que le serveur a ecrit ; verifier qu'un client
   * qui REVIENT -- une requete HTTP neuve, sans socket, sans objet JS
   * partage avec la premiere connexion -- lit 1200 prouve que l'or survit.
   * C'est la difference entre tester l'implementation et tester le
   * livrable.
   */
  it('un joueur s extrait, ferme tout, revient, et retrouve son or', async () => {
    // 1. Un compte, comme le ferait un premier chargement du navigateur.
    const frappe = await app.inject({ method: 'POST', url: '/accounts' });
    const { token } = frappe.json<{ token: string }>();

    const avant = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(avant.json<{ gold: string }>().gold).toBe('0');

    // 2. Une run, et une extraction.
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const client = await connectAvecJeton(code, textToToken(token));
    room.debugSetGold(1200);
    await voteExtraction([client], room);

    // 3. « Fermer le navigateur » : la socket part, et plus rien ne la relie
    //    au serveur. Seul le jeton subsiste -- comme dans un localStorage.
    client.ws.close();
    await attendre(() => (room.playerCount === 0 ? true : null), 'fermeture', 3000);

    // 4. Revenir. Une requete neuve, aucun etat partage avec la precedente.
    const apres = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(apres.statusCode).toBe(200);
    expect(apres.json<{ gold: string }>().gold).toBe('1200');
  }, 120_000);

  /**
   * Le pendant negatif : la survie de l'or n'est pas une fuite vers
   * N'IMPORTE QUEL jeton. Un compte qui n'a jamais joue cette run reste a 0
   * meme apres que l'autre s'est extrait avec de l'or.
   */
  it('et un AUTRE jeton ne voit rien de cet or', async () => {
    const mien = (await app.inject({ method: 'POST', url: '/accounts' })).json<{
      token: string;
    }>();
    const autre = (await app.inject({ method: 'POST', url: '/accounts' })).json<{
      token: string;
    }>();

    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const client = await connectAvecJeton(code, textToToken(mien.token));
    room.debugSetGold(700);
    await voteExtraction([client], room);

    const vu = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${autre.token}` },
    });
    expect(vu.json<{ gold: string }>().gold).toBe('0');
  }, 120_000);
});
