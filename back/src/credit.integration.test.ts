import type { AddressInfo } from 'node:net';
import { TICK_HZ, WIPE_GOLD_KEPT } from '@shared/constants';
import {
  decode,
  encodeHello,
  encodeInput,
  encodeVote,
  type Message,
  MSG,
  REACTION_BYTES,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_BYTES,
  type SnapshotMessage,
  VOTE_CHOICE,
  ZONE_BYTES,
} from '@shared/protocol';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { BASE_WEAPON_ID, weaponOf } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, creditAccounts, findAccountIdByToken, goldOf, prisma } from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

/**
 * **La tache 6 de l'etape 7a : le drain de `RUN_OVER` verse la cagnotte sur
 * les comptes des joueurs encore connectes.**
 *
 * ⚠️ **Ce fichier duplique son propre harnais, comme tous les fichiers
 * d'integration de ce depot** (voir `portal.integration.test.ts`) : le
 * boucle-boss-puis-vote d'ici est une copie volontaire, pas un import.
 *
 * ⚠️ **La cagnotte est posee a la main (`room.debugSetGold`).** Ce fichier
 * mesure le CREDIT, jamais la facon de gagner de l'or — c'est l'etape 6a qui
 * la couvre, et portal.integration.test.ts la mesure deja.
 */

const ROOM_SEED = 0x6a11_0006;
const PLAYER_COUNT = 4;
const DT = 1 / TICK_HZ;

const DISTANCE_BOSS = 100;
const DAGUE = weaponOf(BASE_WEAPON_ID);
const PORTEE_DAGUE = (DAGUE.projectileSpeed * DAGUE.projectileLifeTicks) / TICK_HZ;
if (DISTANCE_BOSS >= PORTEE_DAGUE) {
  throw new Error('le boss doit etre tenu a portee de la dague');
}

const TICKS_PAR_RESPIRATION = 60;
const RESPIRATION_MS = 20;

/**
 * Juste sous le plafond d'un `bigint` Postgres (2^63 - 1 =
 * 9 223 372 036 854 775 807). Pre-crediter un compte a cette valeur puis lui
 * verser encore 1000 d'or fait DEBORDER la colonne pour de vrai : Postgres
 * leve, sans mock et sans toucher a aucun conteneur -- voir le test « base
 * injoignable ».
 */
const PRES_DU_PLAFOND_BIGINT = 9_223_372_036_854_775_000n;

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  /** Le compte frappe pour ce client — c'est lui que les assertions lisent. */
  accountId: string;
  received: Message[];
  lastSnapshot: SnapshotMessage | null;
  /** Taille BRUTE (`ArrayBuffer.byteLength`) de chaque message, par type. */
  rawByType: Map<number, number[]>;
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
    rawByType: new Map(),
    seq: 0,
  };

  // ⚠️ L'ecoute de 'message' est posee AVANT l'envoi du HELLO, sinon le
  // WELCOME peut arriver avant qu'on ecoute.
  ws.on('message', (data: ArrayBuffer) => {
    const msg = decode(data);
    const parType = client.rawByType.get(msg.type) ?? [];
    parType.push(data.byteLength);
    client.rawByType.set(msg.type, parType);

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

/** Frappe un compte puis connecte une socket de jeu avec son jeton. */
async function connect(code: string): Promise<Client> {
  const { token } = await createAccount();
  return connectAvecJeton(code, token);
}

/** Les quatre clients connectes, dans l'ordre de leurs identifiants. */
async function quatreClients(code: string): Promise<Client[]> {
  const clients: Client[] = [];
  for (let i = 0; i < PLAYER_COUNT; i++) {
    clients.push(await connect(code));
  }
  expect(new Set(clients.map((c) => c.playerId)).size).toBe(clients.length);
  return clients;
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

function hpDuFil(client: Client): number {
  const moi = client.lastSnapshot?.players.find((p) => p.id === client.playerId);
  if (!moi) {
    throw new Error(`le joueur ${client.playerId} est absent du dernier snapshot`);
  }
  return moi.hp;
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

/** Retire de la horde tout sauf les identites `garder` — copie de portal.integration.test.ts. */
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

/** Pose une entite increvable a une position choisie, hors generateur de vagues. */
function poseCible(room: Room, waveId: number, x: number, y: number): number {
  const order: WaveOrder = {
    waveId,
    spawnTick: room.tick,
    seed: 1,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: x,
    anchorY: y,
    count: 1,
  };
  room.horde.spawn(order);
  const slot = room.horde.count - 1;
  room.horde.x[slot] = x;
  room.horde.y[slot] = y;
  room.horde.hp[slot] = 1e6;
  return room.horde.entityIdAt(slot);
}

/** Epingle une entite a un point, immobile et increvable. */
function epingler(room: Room, id: number, x: number, y: number): void {
  const slot = room.horde.slotOf(id);
  if (slot < 0) {
    return;
  }
  room.horde.x[slot] = x;
  room.horde.y[slot] = y;
  room.horde.vx[slot] = 0;
  room.horde.vy[slot] = 0;
  room.horde.hp[slot] = 1e6;
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
 * Copie de `tuerLeBoss` dans `portal.integration.test.ts` : ce fichier n'a
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
  // ⚠️ **Le portail ne suit plus la mort du boss** (retour de playtest) : il
  // s'ouvre toutes les `PORTAL_EVERY_WAVES` vagues. On avance, horde videe,
  // jusqu'a lui — l'or du boss, lui, est deja dans la cagnotte.
  await avancerJusqua(
    room,
    () => room.portalOpen,
    "l'ouverture du portail",
    300 * TICK_HZ,
    () => {
      viderSauf(room, []);
    },
  );
  expect(room.portalOpen).toBe(true);
}

/**
 * Attend que le credit (fonction du drain de `RUN_OVER`, lance en « fire and
 * forget » par `Session`) ait eu le temps de s'ecrire, ou abandonne apres
 * `timeoutMs` en rendant la derniere valeur lue.
 *
 * ⚠️ **C'est une attente de CHANGEMENT, pas d'une valeur precise** : cette
 * fonction ne connait pas le montant attendu, seulement le solde d'AVANT. Le
 * test du wipe (ou le montant credite peut etre `0n`, `WIPE_GOLD_KEPT` valant
 * 0 aujourd'hui) epuise alors tout le delai sans jamais voir de changement —
 * et c'est correct : rendre la DERNIERE valeur lue, dans ce cas, rend la
 * valeur de depart inchangee, qui est la bonne reponse.
 *
 * ponytail: ceiling connu — un montant credite qui vaut ZERO par coincidence
 * (et non par `WIPE_GOLD_KEPT`) resterait indetectable d'un credit absent.
 * Sans consequence ici : aucun test de ce fichier n'est dans ce cas, et le
 * jour ou il le serait, cette fonction devrait observer le message RUN_OVER
 * ou un compteur d'ecriture plutot que le solde lui-meme.
 */
async function attendreCreditOuAbandon(
  accountId: string,
  avant: bigint,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    let valeur: bigint;
    try {
      valeur = await goldOf(accountId);
    } catch {
      // Base injoignable (test dedie) : rien a observer, on rend la main.
      return;
    }
    if (valeur !== avant) {
      return;
    }
    await respirer(15);
  } while (Date.now() < deadline);
}

/**
 * Fait tuer le boss courant par `clients[0]`, ouvre le portail, puis fait
 * voter TOUS les `clients` donnes pour l'extraction — une majorite de
 * departs, quel que soit l'effectif passe (y compris un seul joueur).
 *
 * Attend ensuite que le `RUN_OVER` qui en resulte soit arrive sur chaque
 * client, et laisse au credit fixe-forget de `Session` le temps de s'ecrire.
 *
 * ⚠️ **La cagnotte posee par l'appelant est REIMPOSEE juste avant le vote.**
 * Tuer le boss pour ouvrir le portail est un EFFET DE BORD de ce harnais, pas
 * la mecanique testee -- et c'est `Room#step` qui verse le bonus de palier,
 * au tick de la mort du boss, PAS `#endRun` : `#endRun` dit lui-meme
 * explicitement « l'or n'est pas touche ici ». Sans cette remise a niveau,
 * le credit mesure plus loin serait celui de `debugSetGold(...)` MAJORE d'un
 * bonus de boss que le test n'a jamais demande.
 */
async function voteExtraction(clients: readonly Client[], room: Room): Promise<void> {
  const tireur = clients[0];
  if (!tireur) {
    throw new Error('au moins un client attendu');
  }

  const avant = new Map<string, bigint>();
  for (const c of clients) {
    try {
      avant.set(c.accountId, await goldOf(c.accountId));
    } catch {
      avant.set(c.accountId, 0n);
    }
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

/**
 * Epingle un bourreau increvable sur chaque joueur et attend l'effacement de
 * l'equipe entiere — copie du decor de la moitie negative de
 * `portal.integration.test.ts`.
 */
async function tueToutLeMonde(clients: readonly Client[], room: Room): Promise<void> {
  const avant = new Map<string, bigint>();
  for (const c of clients) {
    try {
      avant.set(c.accountId, await goldOf(c.accountId));
    } catch {
      avant.set(c.accountId, 0n);
    }
  }

  for (const client of clients) {
    await immobiliser(client);
  }
  const bourreaux = new Map<number, { id: number; x: number; y: number }>();
  for (const client of clients) {
    const pos = positionDuFil(client);
    bourreaux.set(client.playerId, {
      id: poseCible(room, 9000 + client.playerId, pos.x, pos.y),
      x: pos.x,
      y: pos.y,
    });
  }

  await avancerJusqua(
    room,
    () => clients.every((c) => hpDuFil(c) === 0),
    "l'effacement de l'equipe",
    120 * TICK_HZ,
    () => {
      for (const bourreau of bourreaux.values()) {
        epingler(room, bourreau.id, bourreau.x, bourreau.y);
      }
      viderSauf(
        room,
        [...bourreaux.values()].map((b) => b.id),
      );
    },
  );

  for (const c of clients) {
    await attendre(() => (finDeRun(c) ? true : null), `RUN_OVER pour ${c.playerId}`, 15_000);
  }

  await Promise.all(
    clients.map((c) => attendreCreditOuAbandon(c.accountId, avant.get(c.accountId) ?? 0n, 2000)),
  );
}

/**
 * Attend quelques `SNAPSHOT` de plus sur `clients[0]`.
 *
 * ⚠️ **Purge d'abord l'historique deja recu.** `quatreClients` connecte les
 * quatre sockets l'une apres l'autre ; la premiere a donc deja pu recevoir
 * des `SNAPSHOT` a 1, 2 ou 3 joueurs avant que la quatrieme ne rejoigne --
 * des tailles plus petites que celle qu'on verifie plus bas, et qui n'ont
 * rien a voir avec « un octet de plus par tick ». Sans cette purge, ce test
 * rougirait pour une raison etrangere a ce qu'il garde.
 */
async function attendreQuelquesTicks(clients: readonly Client[]): Promise<void> {
  const [premier] = clients;
  if (!premier) {
    throw new Error('au moins un client attendu');
  }
  premier.rawByType.delete(MSG.SNAPSHOT);
  await attendre(
    () => ((premier.rawByType.get(MSG.SNAPSHOT)?.length ?? 0) >= 5 ? true : null),
    'quelques SNAPSHOT',
    5000,
  );
}

function tailleParType(client: Client, type: number): number[] {
  return client.rawByType.get(type) ?? [];
}

describe('etape 7a tache 6 : la fin de run credite les comptes connectes', () => {
  /**
   * Le coeur du §4.1 : **la totalite de la cagnotte, a CHACUN**. La mutation
   * « part egale » (`gold / clients.size`) doit rougir ici, et elle rougit sur
   * les quatre comptes a la fois.
   */
  it('quatre joueurs, une extraction : quatre comptes credites de la cagnotte ENTIERE', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const clients = await quatreClients(code);

    room.debugSetGold(1200);
    await voteExtraction(clients, room);

    for (const c of clients) {
      const compteId = c.accountId;
      expect(await goldOf(compteId)).toBe(1200n);
    }
  }, 120_000);

  /**
   * **RONDE 1 : titre et docbloc corriges.** §4.3 : la FRACTION que `Room`
   * applique a un wipe (`gold * WIPE_GOLD_KEPT`) arrive bien jusqu'au compte.
   * L'assertion est DERIVEE de `WIPE_GOLD_KEPT`, jamais un `0` ecrit en dur —
   * doctrine du docbloc de `REACTION_DAMAGE`. Le jour ou la constante passe a
   * 0.15, ce test suit sans etre touche.
   *
   * ⚠️ **Ce test ne garde PAS « extraction et wipe passent par le MEME chemin
   * jusqu'a Prisma »** -- c'est faux aujourd'hui, et l'ancien titre le
   * pretendait. `WIPE_GOLD_KEPT` vaut 0 : `Session#creditAccounts` calcule
   * `montant = 0n` et rend la main a son garde `if (montant === 0n) return`,
   * SANS jamais appeler `creditAccounts` (la fonction Prisma). Ce que ce test
   * garde reellement, c'est que `Room` calcule la bonne fraction ET que
   * `Session#creditAccounts` ne la recalcule pas, ne la court-circuite pas et
   * n'ecrit rien de plus que cette fraction -- le wipe et l'extraction
   * APPELLENT la meme methode `Session#creditAccounts`, ce qui est vrai, mais
   * elle n'y EXECUTE pas le meme code au-dela du premier garde.
   *
   * ⚠️ **MODIFICATION DU COORDINATEUR (ruling P8) : les comptes partent avec
   * un solde NON NUL.** `WIPE_GOLD_KEPT` vaut 0 aujourd'hui : assener que le
   * solde final vaut 0 sur un compte NEUF serait vrai meme si le credit ne
   * marchait pas du tout — un chemin entierement casse passerait ce test. Un
   * solde de depart distingue « on a credite 0 » de « on a credite la
   * cagnotte » : un bug qui verserait la cagnotte entiere au lieu de sa
   * fraction se verrait (1 500 au lieu de 500).
   */
  it('un wipe applique gold x WIPE_GOLD_KEPT avant de crediter', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const clients = await quatreClients(code);

    const DEPART = 500n;
    for (const c of clients) {
      await creditAccounts([c.accountId], DEPART);
    }

    room.debugSetGold(1000);
    await tueToutLeMonde(clients, room);

    const attendu = DEPART + BigInt(Math.round(1000 * WIPE_GOLD_KEPT));
    for (const c of clients) {
      expect(await goldOf(c.accountId)).toBe(attendu);
    }
  }, 120_000);

  it('un joueur deconnecte avant la fin de run n est pas credite', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const clients = await quatreClients(code);
    const parti = clients[3];
    if (!parti) {
      throw new Error('quatre clients attendus');
    }
    parti.ws.close();
    await attendre(() => (room.playerCount === 3 ? true : null), 'depart', 3000);

    room.debugSetGold(400);
    await voteExtraction(clients.slice(0, 3), room);

    expect(await goldOf(parti.accountId)).toBe(0n);
    for (const c of clients.slice(0, 3)) {
      expect(await goldOf(c.accountId)).toBe(400n);
    }
  }, 120_000);

  /**
   * **RONDE 3 : la lecture finale SONDE, elle ne lit plus une seule fois.**
   * Review Focus n°5 : deux salons qui finissent sur le MEME compte, et dont
   * les deux credits sont EN VOL EN MEME TEMPS -- c'est ce qui discrimine un
   * `increment` atomique d'un lire-modifier-ecrire (`findUnique` puis
   * `update`), qui en perdrait un des deux avec une forte probabilite.
   *
   * ⚠️ **RONDE 1 : la version d'avant ne discriminait rien.** Elle attendait
   * chaque `voteExtraction` avant de lancer le second salon : les deux
   * credits etaient donc toujours SEQUENTIELS, jamais en concurrence reelle.
   * Un lire-modifier-ecrire aussi aurait rendu `800n` dans cette version.
   * Corrige en montant les deux salons et les deux sockets D'ABORD, puis en
   * lancant les deux `voteExtraction` ENSEMBLE sous un seul `Promise.all`.
   *
   * ⚠️ **RONDE 3 : ce correctif a rendu le MOMENT DE LA LECTURE incertain, et
   * une lecture unique juste apres le `Promise.all` rougissait par flake
   * (mesure : 5/6 puis 6/6 sur deux lancements consecutifs, avec zero ligne
   * de code touchee entre les deux).** L'ecriture Prisma de chaque salon part
   * du timer de tick de sa `Session`, en temps reel ; elle peut donc suivre
   * de quelques millisecondes le retour du `Promise.all`, qui n'attend que
   * l'arrivee de `RUN_OVER`, pas celle du credit. `updateMany` + `increment`
   * est pourtant atomique en SQL -- aucun des deux credits ne peut se perdre
   * pour de vrai. Le defaut n'etait donc PAS une perte d'ecriture, mais une
   * lecture trop tot. Le correctif SONDE `goldOf` jusqu'a `800n`, avec une
   * echeance genereuse, plutot que de lire une seule fois :
   *
   * - un `increment` atomique finit toujours par atteindre `800n` -- la
   *   sonde reussit, tot ou tard, jamais par chance ;
   * - un lire-modifier-ecrire plafonne a `300n` ou `500n` et n'atteint
   *   JAMAIS `800n` -- la sonde EXPIRE, et le test rougit pour la bonne
   *   raison (une echeance epuisee), jamais pour une mauvaise (une valeur
   *   lue trop tot). Verifie par mutation : voir le rapport de la ronde 3.
   */
  it('deux salons qui finissent sur le meme compte EN PARALLELE donnent la SOMME', async () => {
    const { id, token } = await createAccount();

    const code1 = await createRoomCode();
    const room1 = app.rooms.get(code1);
    if (!room1) {
      throw new Error('salon introuvable');
    }
    const c1 = await connectAvecJeton(code1, token);

    const code2 = await createRoomCode();
    const room2 = app.rooms.get(code2);
    if (!room2) {
      throw new Error('salon introuvable');
    }
    const c2 = await connectAvecJeton(code2, token);

    room1.debugSetGold(300);
    room2.debugSetGold(500);

    // Les deux ecritures Prisma sont reellement en vol ensemble : un
    // lire-modifier-ecrire en perdrait une avec une forte probabilite,
    // l'increment atomique rend la somme quel que soit l'ordre d'arrivee.
    await Promise.all([voteExtraction([c1], room1), voteExtraction([c2], room2)]);

    // Sonde jusqu'a la somme plutot que de lire une seule fois : voir le
    // docbloc ci-dessus (ronde 3) pour pourquoi une lecture immediate pouvait
    // rougir pour la mauvaise raison.
    const somme = await attendre(
      async () => {
        const v = await goldOf(id);
        return v === 800n ? v : null;
      },
      'la somme des deux credits (800n)',
      8000,
    );
    expect(somme).toBe(800n);
  }, 120_000);

  /**
   * **RONDE 1 : reecrit apres relecture — la panne n'avait jamais lieu, et
   * les deux assertions etaient tautologiques.**
   *
   * ⚠️ **`prisma.$disconnect()` ne rend pas la base injoignable.** Prisma
   * reconnecte paresseusement au premier appel suivant ; mesure a l'appui,
   * aucun `[credit] ECHEC definitif` ne partait sur stderr -- les trois
   * tentatives ne tournaient jamais. Et meme en admettant une panne,
   * `expect(c.received.some(m => m.type === MSG.RUN_OVER)).toBe(true)` ne
   * pouvait structurellement pas rougir : `voteExtraction` leve DEJA si
   * `RUN_OVER` n'arrive pas (son `attendre(..., 15_000)` interne) -- cette
   * assertion ne faisait que reasserter ce que l'appel precedent avait deja
   * garanti.
   *
   * **Le correctif provoque une vraie erreur Postgres, sans mock et sans
   * toucher a aucun conteneur : il fait DEBORDER la colonne `bigint`.** La
   * marge entre `PRES_DU_PLAFOND_BIGINT` et le plafond (2^63 - 1) est de
   * SEULEMENT 807 -- `room.debugSetGold(1000)`, ci-dessous, doit donc rester
   * au-dessus de 807 pour que l'`increment` sorte reellement du domaine d'un
   * `bigint` Postgres. Il leve alors pour de vrai, a chacune des trois
   * tentatives, et la troisieme journalise. C'est ce que ce test assene
   * desormais, avec un espion sur `console.error` : ni l'absence de
   * `RUN_OVER` (deja garanti ailleurs) ni sa presence, mais le journal ET la
   * survie des sockets.
   */
  it('une base qui refuse le credit (debordement bigint) ne tue ni la run ni le salon', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const clients = await quatreClients(code);
    for (const c of clients) {
      await creditAccounts([c.accountId], PRES_DU_PLAFOND_BIGINT);
    }
    room.debugSetGold(1000);

    const erreur = vi.spyOn(console, 'error').mockImplementation(() => {
      // Avale la sortie : ce test ASSENE le journal via `erreur`, il n'a
      // pas besoin de le voir aussi sur stderr.
    });
    try {
      await voteExtraction(clients, room);

      // Les trois tentatives ont toutes echoue sur le debordement, et la
      // troisieme a journalie -- UNE fois, pas trois : `#creditAccounts`
      // rend la main des le premier `console.error`.
      expect(erreur).toHaveBeenCalledTimes(1);
      expect(erreur.mock.calls[0]?.[0]).toMatch(/^\[credit\] ECHEC definitif/);

      // Et rien n'est tombe : l'echec du credit n'a pas emporte le salon.
      for (const c of clients) {
        expect(c.ws.readyState).toBe(WebSocket.OPEN);
      }

      // Le debordement n'a rien ecrit : le solde pre-credite est inchange.
      for (const c of clients) {
        expect(await goldOf(c.accountId)).toBe(PRES_DU_PLAFOND_BIGINT);
      }
    } finally {
      erreur.mockRestore();
    }
  }, 120_000);

  /**
   * **RONDE 1 : docbloc corrige.** Ce test mesure UNE chose, au niveau
   * socket comme aux etapes 5b et 5c : zero octet de plus par tick sur
   * `SNAPSHOT` (et les tailles figees de `ZONE`/`REACTION` en sanity-check).
   *
   * ⚠️ **Il ne mesure PAS « envoye une fois par connexion ».** `HELLO` part
   * du CLIENT vers le serveur ; rien ici ne le recoit ni ne le compte, et
   * l'ancien docbloc le pretendait sans que le code ne le verifie. La
   * propriete « un seul HELLO accepte par socket » est deja le Review Focus
   * n°2 du plan, et elle est deja gardee par `handshake.integration.test.ts`
   * (deux HELLO sur la meme socket). La repeter ici, sans la mesurer
   * vraiment, serait l'assertion creuse que ce depot cherche a eliminer.
   */
  it('aucun octet de plus par tick : SNAPSHOT, ZONE et REACTION ne bougent pas', async () => {
    const code = await createRoomCode();
    const clients = await quatreClients(code);
    await attendreQuelquesTicks(clients);

    const snap = tailleParType(clients[0] as Client, MSG.SNAPSHOT);
    expect(new Set(snap).size).toBe(1);
    expect(snap[0]).toBe(SNAPSHOT_HEADER_BYTES + 4 * SNAPSHOT_PLAYER_BYTES);
    expect(SNAPSHOT_HEADER_BYTES).toBe(22);
    // ⚠️ **L'etape 13 a paye un octet, assume.** `SNAPSHOT_PLAYER_BYTES` passe
    // de 10 a 11 : un `shield u8` dans l'enregistrement joueur, pour la carte
    // Transcendance (PV max contre bouclier) — un bouclier arbitre serveur,
    // qu'un client ne peut pas rederiver de son cote. Cout mesure : +0,12 ko/s
    // par client (62 -> 66 octets, 30 fois/s) et +0,47 ko/s d'egress serveur
    // pour un salon de quatre, soit environ 11 % du relevé de l'etape 3
    // (1,09 ko/s par joueur). La garde reste vivante : elle interdit toujours
    // qu'un octet s'ajoute sans qu'on en assume le cout, elle n'a fait
    // qu'absorber celui-ci.
    expect(SNAPSHOT_PLAYER_BYTES).toBe(11);
    expect(ZONE_BYTES).toBe(11);
    expect(REACTION_BYTES).toBe(11);
  });
});
