import type { AddressInfo } from 'node:net';
import { applicationsOf, applyCardToLoadout, CARD, type Card } from '@shared/cards';
import { ORB_PICKUP_RADIUS, SPREAD_BONUS } from '@shared/constants';
import { Loadout } from '@shared/loadout';
import {
  decode,
  encodeDraftToken,
  encodeHello,
  encodeInput,
  type Message,
  MSG,
  OUTCOME,
  type SnapshotMessage,
} from '@shared/protocol';
import { RARITY } from '@shared/rarity';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { BASE_WEAPON_ID } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, prisma } from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

/**
 * Le livrable de l'etape 10 (§1 et §6 de la spec) : **sur vraies sockets, une
 * carte rare prise donne exactement deux exemplaires dans l'inventaire
 * arbitre par le salon, et le client en tient le meme miroir ; aucun octet de
 * plus par tick.**
 *
 * ⚠️ **La rarete est FORCEE par `vi.mock`, pas par un crochet de production.**
 * Vitest moque par chemin RESOLU : `@shared/rarity` ici et `./rarity` dans
 * `shared/cards.ts` designent le meme fichier, donc le `drawSpread` du salon
 * tire rare a chaque emplacement. Le test le VERIFIE sur le fil avant tout le
 * reste — un mock qui n'atteindrait pas le serveur ferait passer le reste pour
 * une commune.
 *
 * ⚠️ **« Le miroir decode par le client »** est reconstitue exactement comme
 * `GameClient#applyDraftOutcomes` le fait : les cartes du `DRAFT_OPEN` DECODE,
 * les issues du `DRAFT_RESULT` DECODE, `applyCardToLoadout`. Le `GameClient`
 * lui-meme est couvert par `front/src/net/client.test.ts`.
 *
 * Un seul joueur : en solo, la fenetre se ferme au jeton pose, sans attendre
 * les vingt secondes de l'echeance.
 */
vi.mock('@shared/rarity', async (importOriginal) => {
  const reel = await importOriginal<typeof import('@shared/rarity')>();
  return { ...reel, rollRarity: () => reel.RARITY.RARE };
});

/** Graine imposee au salon : ce test ne doit rien devoir au hasard. */
const ROOM_SEED = 0x0a7e_7e10;
const RING_SIZE = 10;
/** Sous `ORB_PICKUP_RADIUS`, sinon l'experience ne monte jamais (voir `draft.integration.test.ts`). */
const RING_RADIUS = 80;
if (RING_RADIUS >= ORB_PICKUP_RADIUS) {
  throw new Error("l'anneau doit rester dans le rayon de ramassage des orbes");
}

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  /** Tout ce qui est arrive sur CETTE socket, hors snapshots. */
  received: Message[];
  /** La taille BRUTE de chaque `DRAFT_OPEN` recu, en octets. */
  draftOpenBytes: number[];
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
  const client: Client = { ws, playerId: 0, received: [], draftOpenBytes: [], seq: 0 };
  ws.on('message', (data: ArrayBuffer) => {
    const msg = decode(data);
    if (msg.type === MSG.WELCOME) {
      client.playerId = msg.playerId;
    }
    if (msg.type === MSG.DRAFT_OPEN) {
      client.draftOpenBytes.push(data.byteLength);
    }
    if (msg.type !== MSG.SNAPSHOT) {
      client.received.push(msg);
    }
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

function firstSnapshot(ws: WebSocket): Promise<SnapshotMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('aucun snapshot en 3000 ms'));
    }, 3000);
    function cleanup(): void {
      clearTimeout(timer);
      ws.off('message', onMessage);
    }
    function onMessage(data: ArrayBuffer): void {
      const msg = decode(data);
      if (msg.type === MSG.SNAPSHOT && msg.players.length === 1) {
        cleanup();
        resolve(msg);
      }
    }
    ws.on('message', onMessage);
  });
}

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

/** Un anneau de monstres renouvele, et la visee sur le plus proche, PAR LA SOCKET. */
function startCombatDriver(room: Room, pos: { x: number; y: number }, client: Client): () => void {
  let waveId = 9000;
  const refill = (): void => {
    for (let i = 0; i < RING_SIZE; i++) {
      const angle = (i / RING_SIZE) * Math.PI * 2;
      spawnMonsterAt(
        room,
        waveId++,
        pos.x + Math.cos(angle) * RING_RADIUS,
        pos.y + Math.sin(angle) * RING_RADIUS,
      );
    }
  };
  const timer = setInterval(() => {
    if (room.horde.count === 0) {
      refill();
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
      return;
    }
    const dx = (room.horde.x[bestSlot] ?? 0) - pos.x;
    const dy = (room.horde.y[bestSlot] ?? 0) - pos.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) {
      return;
    }
    client.seq++;
    client.ws.send(
      encodeInput(client.seq, 0, 0, Math.round((dx / len) * 127), Math.round((dy / len) * 127)),
    );
  }, 10);
  refill();
  return () => {
    clearInterval(timer);
  };
}

/** Exemplaires possedes de la chose que porte cette carte. */
function possede(l: Loadout, c: Card): number {
  return c.nature === CARD.PASSIVE ? l.stacksOf(c.refId) : l.stacksOfWeapon(c.refId);
}

describe('etape 10 : une carte rare vaut deux cartes, sur vraies sockets (le livrable)', () => {
  it('la rare prise donne 2 exemplaires au salon ET au miroir decode, un octet par carte et rien par tick', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('le registre de salons doit etre accessible depuis l app');
    }
    const a = await connect(code);
    const snap = await firstSnapshot(a.ws);
    const moi = snap.players.find((p) => p.id === a.playerId);
    if (!moi) {
      throw new Error('le joueur est absent du snapshot');
    }

    const stop = startCombatDriver(room, { x: moi.x, y: moi.y }, a);
    const open = await waitFor(
      () => a.received.find((m) => m.type === MSG.DRAFT_OPEN) ?? null,
      'DRAFT_OPEN',
      20_000,
    );
    stop();
    if (open.type !== MSG.DRAFT_OPEN) {
      throw new Error('DRAFT_OPEN attendu');
    }

    // ---- 1. La rarete forcee a bien atteint le salon, et le fil ----------
    expect(open.cards).toHaveLength(1 + SPREAD_BONUS);
    expect(open.cards.every((c) => c.rarity === RARITY.RARE)).toBe(true);

    // ---- 2. Un octet par carte, et rien d'autre : 6 + 4 x 4 = 22 ---------
    // ⚠️ Nu, jamais recalcule avec `DRAFT_CARD_BYTES` : une constante qui
    // mentirait mentirait aux deux cotes de l'egalite.
    expect(a.draftOpenBytes[0]).toBe(22);

    // ---- 3. On prend une carte que le joueur ne possede PAS ---------------
    const serveur = room.loadoutOf(a.playerId);
    if (!serveur) {
      throw new Error('inventaire du salon absent');
    }
    const index = open.cards.findIndex((c) => possede(serveur, c) === 0);
    const carte = open.cards[index];
    if (!carte) {
      throw new Error('aucune carte nouvelle dans l etalage');
    }
    expect(applicationsOf(carte)).toBe(2);
    a.ws.send(encodeDraftToken(index));

    const result = await waitFor(
      () => a.received.find((m) => m.type === MSG.DRAFT_RESULT) ?? null,
      'DRAFT_RESULT',
      5000,
    );
    if (result.type !== MSG.DRAFT_RESULT) {
      throw new Error('DRAFT_RESULT attendu');
    }
    const issue = result.outcomes.find((o) => o.playerId === a.playerId);
    expect(issue?.cardIndex).toBe(index);
    expect(issue?.outcome).toBe(OUTCOME.WON);

    // ---- 4. Le salon : exactement deux exemplaires ------------------------
    expect(possede(serveur, carte)).toBe(2);
    if (carte.nature === CARD.WEAPON) {
      // Une arme : l'acquisition, plus UN cran de son aspect.
      expect(serveur.upgradesOf(carte.refId, carte.upgrade ?? -1)).toBe(1);
      expect(serveur.weaponSlotsUsed).toBe(2);
    }

    // ---- 5. Le miroir decode : le meme chemin que `#applyDraftOutcomes` ---
    const miroir = new Loadout();
    miroir.addWeapon(BASE_WEAPON_ID);
    for (const o of result.outcomes) {
      if (o.outcome === OUTCOME.LOST) {
        continue;
      }
      const c = open.cards[o.cardIndex];
      if (c) {
        applyCardToLoadout(miroir, c);
      }
    }
    expect(possede(miroir, carte)).toBe(2);
    if (carte.nature === CARD.WEAPON) {
      expect(miroir.upgradesOf(carte.refId, carte.upgrade ?? -1)).toBe(1);
    }
  }, 60_000);
});
