import type { AddressInfo } from 'node:net';
import { PLAYER_MAX_HP } from '@shared/constants';
import {
  decode,
  encodeHello,
  encodeInput,
  type Message,
  MSG,
  REACTION_BYTES,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_BYTES,
  ZONE_BYTES,
} from '@shared/protocol';
import { priceOf, SHOP_ITEMS } from '@shared/shop';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

// Import en espace de noms, pas nomme : meme discipline que
// `bonus.integration.test.ts` et `handshake.integration.test.ts` — un import
// nomme serait copie a la liaison, et une eventuelle espionne (`spyOn`) ne
// mordrait pas sur le lien que `server.ts` importe.
import * as comptes from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

/**
 * **Le livrable de l'etape 7b.** Un joueur depense son or, et sa run
 * suivante en est changee.
 *
 * ⚠️ **Ce fichier duplique son propre harnais**, comme tous les fichiers
 * d'integration de ce depot (voir `bonus.integration.test.ts` et
 * `draft.integration.test.ts`) : aucun fichier d'integration n'en importe un
 * autre.
 */

const ROOM_SEED = 0x07_6b_0009;

/** Monstres poses autour de chaque joueur a chaque renouvellement. */
const RING_SIZE = 10;
/** Rayon de l'anneau — doit rester sous le rayon de ramassage des orbes. */
const RING_RADIUS = 80;

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  /** Tout ce qui est arrive sur CETTE socket, decode, hors snapshots. */
  received: Message[];
  /** Taille BRUTE (octets du fil), par type de message — pas la valeur decodee. */
  rawSizesByType: Map<number, number[]>;
  seq: number;
}

let app: App;
let port: number;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  await comptes.prisma.account.deleteMany();
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

/** Frappe un compte neuf, sans aucun achat. */
async function compteNeuf(): Promise<{ token: Uint8Array; accountId: string }> {
  const { id, token } = await comptes.createAccount();
  return { token, accountId: id };
}

/**
 * Connecte une socket de jeu avec un jeton DEJA frappe, et enregistre
 * desormais tout ce qui arrive : les messages decodes (hors snapshots) ET la
 * taille BRUTE de chaque frame, par type — c'est cette seconde table que le
 * test du §3.5 (DRAFT_OPEN) interroge, parce qu'une valeur decodee ne dit
 * rien de ce qui a vraiment voyage sur le fil.
 */
async function connectAvecJeton(code: string, token: Uint8Array): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  openSockets.push(ws);

  // ⚠️ L'ecoute de 'open' est posee ICI, avant tout `await` : sur localhost
  // la socket peut s'ouvrir avant la fin d'un aller-retour Prisma, et un
  // listener pose apres l'aurait ratee (meme piege que
  // `credit.integration.test.ts`).
  const ouverte = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const received: Message[] = [];
  const rawSizesByType = new Map<number, number[]>();
  const client: Client = { ws, playerId: 0, received, rawSizesByType, seq: 0 };

  // ⚠️ L'ecoute de 'message' est posee AVANT l'envoi du HELLO, sinon le
  // WELCOME peut arriver avant qu'on ecoute.
  ws.on('message', (data: ArrayBuffer) => {
    const type = new DataView(data).getUint8(0);
    const liste = rawSizesByType.get(type);
    if (liste) {
      liste.push(data.byteLength);
    } else {
      rawSizesByType.set(type, [data.byteLength]);
    }

    const msg = decode(data);
    if (msg.type === MSG.WELCOME) {
      client.playerId = msg.playerId;
    }
    if (msg.type !== MSG.SNAPSHOT) {
      received.push(msg);
    }
  });

  await ouverte;
  ws.send(encodeHello(token));

  await attendre(() => (client.playerId !== 0 ? client.playerId : null), 'WELCOME', 3000);
  return client;
}

/** Les tailles brutes observees pour un type de message donne. */
function tailleParType(client: Client, type: number): number[] {
  return client.rawSizesByType.get(type) ?? [];
}

/**
 * Pose une entite a une position choisie, hors du generateur de vagues —
 * meme technique que `draft.integration.test.ts`.
 */
function spawnMonsterAt(room: Room, waveId: number, x: number, y: number): void {
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
}

/**
 * Fait monter l'equipe de niveau : un anneau de monstres autour de chaque
 * joueur, renouvele quand la horde se vide, chaque joueur visant en continu
 * le monstre le plus proche de lui.
 *
 * ⚠️ **La visee passe par la socket.** Sans `aimX`/`aimY` poses, l'arme ne
 * tire jamais, l'experience ne monte jamais, et l'appelant attend sans
 * jamais savoir pourquoi — piege deja paye dans
 * `draft.integration.test.ts`.
 *
 * Rend la fonction qui arrete le pilote.
 */
function startCombatDriver(
  room: Room,
  positions: Map<number, { x: number; y: number }>,
  clients: readonly Client[],
): () => void {
  let waveId = 9000;

  const refill = (): void => {
    for (const pos of positions.values()) {
      for (let i = 0; i < RING_SIZE; i++) {
        const angle = (i / RING_SIZE) * Math.PI * 2;
        spawnMonsterAt(
          room,
          waveId++,
          pos.x + Math.cos(angle) * RING_RADIUS,
          pos.y + Math.sin(angle) * RING_RADIUS,
        );
      }
    }
  };

  const timer = setInterval(() => {
    if (room.horde.count === 0) {
      refill();
    }
    for (const client of clients) {
      const pos = positions.get(client.playerId);
      if (!pos) {
        continue;
      }
      let bestDist2 = Number.POSITIVE_INFINITY;
      let bestSlot = -1;
      for (let i = 0; i < room.horde.count; i++) {
        const dx = (room.horde.x[i] ?? 0) - pos.x;
        const dy = (room.horde.y[i] ?? 0) - pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestSlot = i;
        }
      }
      if (bestSlot < 0) {
        continue;
      }
      const dx = (room.horde.x[bestSlot] ?? 0) - pos.x;
      const dy = (room.horde.y[bestSlot] ?? 0) - pos.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) {
        continue;
      }
      client.seq++;
      client.ws.send(
        encodeInput(client.seq, 0, 0, Math.round((dx / len) * 127), Math.round((dy / len) * 127)),
      );
    }
  }, 10);

  refill();
  return () => {
    clearInterval(timer);
  };
}

/** Le premier snapshot ou tous les joueurs attendus sont la. */
function fullSnapshot(
  ws: WebSocket,
  expectedCount: number,
): Promise<Map<number, { x: number; y: number }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`aucun snapshot a ${expectedCount} joueurs en 3000 ms`));
    }, 3000);
    function cleanup(): void {
      clearTimeout(timer);
      ws.off('message', onMessage);
    }
    function onMessage(data: ArrayBuffer): void {
      const msg = decode(data);
      if (msg.type === MSG.SNAPSHOT && msg.players.length === expectedCount) {
        cleanup();
        resolve(new Map(msg.players.map((p) => [p.id, { x: p.x, y: p.y }])));
      }
    }
    ws.on('message', onMessage);
  });
}

describe('etape 7b : le livrable — depenser change la run suivante', () => {
  /**
   * ⚠️ **La seconde run est tout le test.** Verifier que la base contient
   * l'achat prouverait l'ecriture ; verifier qu'une run OUVERTE APRES l'achat
   * donne un joueur plus resistant prouve que l'achat a changé le jeu. C'est
   * la difference entre tester l'implementation et tester le livrable.
   */
  it('un joueur achete, rejoue, et sa run est differente', async () => {
    const v = SHOP_ITEMS.find((i) => i.bonusKind === 'maxHp');
    if (!v) {
      throw new Error('aucun article de vitalite');
    }
    const { token, accountId } = await compteNeuf();

    // 1. Une premiere run, sans aucun achat.
    const code1 = await createRoomCode();
    const room1 = app.rooms.get(code1);
    if (!room1) {
      throw new Error('salon introuvable');
    }
    const c1 = await connectAvecJeton(code1, token);
    await attendre(() => (room1.playerCount === 1 ? true : null), 'run 1', 3000);
    expect(room1.maxHpOf(c1.playerId)).toBe(PLAYER_MAX_HP);
    c1.ws.close();
    await attendre(() => (room1.playerCount === 0 ? true : null), 'fermeture', 3000);

    // 2. L'achat, par la route HTTP — le vrai chemin du joueur.
    await comptes.creditAccounts([accountId], BigInt(priceOf(v, 1)));
    const achat = await app.inject({
      method: 'POST',
      url: '/accounts/me/purchases',
      headers: { authorization: `Bearer ${comptes.tokenToText(token)}` },
      payload: { itemId: v.id },
    });
    expect(achat.statusCode).toBe(200);

    // 3. Une seconde run, et elle est differente.
    const code2 = await createRoomCode();
    const room2 = app.rooms.get(code2);
    if (!room2) {
      throw new Error('salon introuvable');
    }
    const c2 = await connectAvecJeton(code2, token);
    await attendre(() => (room2.playerCount === 1 ? true : null), 'run 2', 3000);
    // ⚠️ **Pas de `?? 0` ici.** Si `perLevel` disparaissait de l'article
    // `vitalite`, l'attendu redeviendrait `PLAYER_MAX_HP` — exactement la
    // valeur de la run 1 — et la paire discriminante s'effondrerait en
    // silence (ronde de correction 2). On leve explicitement plutot que de
    // laisser un `undefined` se replier sur 0.
    if (v.perLevel === undefined) {
      throw new Error(`l article ${v.id} n a pas de perLevel`);
    }
    expect(room2.maxHpOf(c2.playerId)).toBe(PLAYER_MAX_HP + v.perLevel);
  });

  it('le SNAPSHOT fait 62 octets a quatre joueurs, et ZONE/REACTION/DRAFT_OPEN ne bougent pas', async () => {
    // ⚠️ **Nombres nus, par doctrine du depot** : ce sont des largeurs de fil,
    // pas des reglages de jeu. Verifiees contre le depot (amendement du
    // controleur) : 22 + 4 * 10 = 62.
    expect(SNAPSHOT_HEADER_BYTES + 4 * SNAPSHOT_PLAYER_BYTES).toBe(62);
    expect(ZONE_BYTES).toBe(11);
    expect(REACTION_BYTES).toBe(11);

    // ⚠️ **`DRAFT_OPEN` est le message que le grisage aurait pu faire grossir**,
    // si on avait choisi d'envoyer un masque d'eligibilite au lieu de laisser
    // le client griser depuis son propre ensemble. Mesure sa taille REELLE sur
    // de VRAIES ouvertures de draft, sur de VRAIES sockets — pas seulement ses
    // constantes : c'est le seul moyen de prouver que la decision du §3.5 de
    // la spec a tenu. Deux joueurs reels, meme combat pilote que
    // `draft.integration.test.ts`.
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const a = await connectAvecJeton(code, (await compteNeuf()).token);
    const b = await connectAvecJeton(code, (await compteNeuf()).token);
    await attendre(() => (room.playerCount === 2 ? true : null), 'deux connexions', 3000);

    const positions = await fullSnapshot(a.ws, 2);
    const stopDriver = startCombatDriver(room, positions, [a, b]);
    try {
      await attendre(
        () => (a.received.some((m) => m.type === MSG.DRAFT_OPEN) ? true : null),
        'premier DRAFT_OPEN',
        20_000,
      );
    } finally {
      stopDriver();
    }

    const taillesDraft = [...tailleParType(a, MSG.DRAFT_OPEN), ...tailleParType(b, MSG.DRAFT_OPEN)];
    expect(taillesDraft.length).toBeGreaterThan(0);
    // ⚠️ **Un `Set(...).size === 1` ne verifie que la COHERENCE interne de la
    // mesure, jamais sa VALEUR** (ronde de correction 2) : un `DRAFT_OPEN`
    // qui aurait grossi d'un masque d'eligibilite serait uniforme lui aussi,
    // donc passerait cette assertion tout en ayant grossi. C'est pour ca que
    // le nombre ci-dessous est NU, jamais recalcule a partir des memes
    // constantes que l'encodeur — calculer la taille attendue AVEC
    // `DRAFT_OPEN_HEADER_BYTES`/`DRAFT_CARD_BYTES` passerait tout aussi bien
    // si ces constantes mentaient ensemble.
    //
    // D'ou vient ce 26 : ce decor connecte exactement DEUX joueurs, donc
    // l'etalage compte `2 + SPREAD_BONUS` cartes (`SPREAD_BONUS = 3`, voir
    // `shared/constants.ts`) soit 5 cartes. `DRAFT_OPEN` pese
    // `DRAFT_OPEN_HEADER_BYTES + cartes * DRAFT_CARD_BYTES` (6 + 5 * 4 = 26,
    // voir `shared/protocol.ts`). **A quatre joueurs ce serait 6 + 7 * 4 =
    // 34** : si tu changes le nombre de joueurs de ce decor, RECALCULE ce
    // nombre a la main plutot que de « reparer » la valeur a l'aveugle.
    expect(taillesDraft.every((t) => t === 26)).toBe(true);
  }, 30_000);
});
