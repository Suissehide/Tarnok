import type { AddressInfo } from 'node:net';
import { applyCardToLoadout, CARD } from '@shared/cards';
import {
  ORB_PICKUP_RADIUS,
  PLAYER_MAX_HP,
  SHIELD_POOL,
  SPREAD_BONUS,
  TRANSCENDANCE_MAX_HP,
} from '@shared/constants';
import { Loadout, maxHpOf } from '@shared/loadout';
import { passiveOf } from '@shared/passives';
import {
  type DraftOpenMessage,
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, prisma } from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

/**
 * Le livrable de l'etape 13 : **sur vraies sockets, un emplacement legendaire
 * ne propose que des cartes de regle, et les deux clients du meme salon
 * voient le meme etalage ; Transcendance ramene les PV max a 1 des deux
 * cotes (salon arbitre ET miroir decode par le client) sans qu'un octet de
 * plus ne parte sur le fil ; le bouclier qu'elle ouvre encaisse un coup que
 * les PV seuls n'encaisseraient pas, et le suivant tue une fois la reserve
 * vide ; et Fournaise baisse les PV max sans achever un joueur deja blesse.**
 *
 * ⚠️ **La rarete est FORCEE par `vi.mock`, pas par un crochet de production**
 * — meme motif que `rarete.integration.test.ts` (etape 10). Vitest moque par
 * chemin RESOLU : `@shared/rarity` ici et `./rarity` dans `shared/cards.ts`
 * designent le meme fichier, donc le `drawSpread` du salon tire LEGENDAIRE a
 * chaque emplacement. Le premier test le VERIFIE sur le fil avant tout le
 * reste — un mock qui n'atteindrait pas le serveur ferait passer des
 * communes pour le livrable.
 */
vi.mock('@shared/rarity', async (importOriginal) => {
  const reel = await importOriginal<typeof import('@shared/rarity')>();
  return { ...reel, rollRarity: () => reel.RARITY.LEGENDAIRE };
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
  /**
   * Tout ce qui est arrive sur CETTE socket, snapshots compris —
   * contrairement a `rarete.integration.test.ts` : le point 2 du livrable lit
   * le `shield` d'un `SNAPSHOT` decode, pas seulement les messages de draft.
   */
  received: Message[];
  /** La taille BRUTE de chaque `SNAPSHOT` recu, en octets, dans le MEME ordre que les `SnapshotMessage` de `received`. */
  snapshotBytes: number[];
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

/** Poignee de main complete : connexion, `HELLO`, `WELCOME` — meme motif que `rarete.integration.test.ts`. */
async function connect(code: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  openSockets.push(ws);
  // L'ecoute de 'open' AVANT tout `await` (voir `draft.integration.test.ts`).
  const ouverte = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const client: Client = { ws, playerId: 0, received: [], snapshotBytes: [], seq: 0 };
  ws.on('message', (data: ArrayBuffer) => {
    const msg = decode(data);
    if (msg.type === MSG.WELCOME) {
      client.playerId = msg.playerId;
    }
    if (msg.type === MSG.SNAPSHOT) {
      client.snapshotBytes.push(data.byteLength);
    }
    client.received.push(msg);
  });
  const { token } = await createAccount();
  await ouverte;
  ws.send(encodeHello(token));
  await waitFor(() => (client.playerId !== 0 ? client.playerId : null), 'WELCOME', 3000);
  return client;
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

/**
 * Un anneau de monstres renouvele, et la visee sur le plus proche, PAR LA
 * SOCKET — meme motif que `rarete.integration.test.ts` : c'est ce qui fait
 * monter l'equipe d'un niveau sans tricher sur le chemin reseau.
 */
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

/** Le premier `SNAPSHOT` qui porte CE joueur — generalise `firstSnapshot` de `rarete.integration.test.ts` au cas a plusieurs clients. */
function firstSnapshotOf(client: Client): Promise<SnapshotMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('aucun snapshot en 3000 ms'));
    }, 3000);
    function cleanup(): void {
      clearTimeout(timer);
      client.ws.off('message', onMessage);
    }
    function onMessage(data: ArrayBuffer): void {
      const msg = decode(data);
      if (msg.type === MSG.SNAPSHOT && msg.players.some((p) => p.id === client.playerId)) {
        cleanup();
        resolve(msg);
      }
    }
    client.ws.on('message', onMessage);
  });
}

/**
 * Connecte `joueurs` clients au MEME salon et fait monter l'EQUIPE d'un
 * niveau — assez pour declencher UN `DRAFT_OPEN`, diffuse a tout le monde.
 *
 * ⚠️ **Un seul des clients combat.** L'experience est une donnee d'EQUIPE
 * (§5 de la spec de l'etape 4) : le `DRAFT_OPEN` qui en resulte atteint tout
 * le monde, meneur compris, et c'est exactement ce que le point 1 du livrable
 * verifie (« les deux clients voient le meme etalage »).
 */
async function rejoindreEtMonterDUnNiveau(
  joueurs: number,
): Promise<{ room: Room; clients: Client[] }> {
  const code = await createRoomCode();
  const room = app.rooms.get(code);
  if (!room) {
    throw new Error('le registre de salons doit etre accessible depuis l app');
  }
  const clients: Client[] = [];
  for (let i = 0; i < joueurs; i++) {
    clients.push(await connect(code));
  }
  const meneur = clients[0];
  if (!meneur) {
    throw new Error('au moins un joueur est requis');
  }
  const snap = await firstSnapshotOf(meneur);
  const moi = snap.players.find((p) => p.id === meneur.playerId);
  if (!moi) {
    throw new Error('le meneur est absent de son propre snapshot');
  }
  const stop = startCombatDriver(room, { x: moi.x, y: moi.y }, meneur);
  await waitFor(
    () => (clients.every((c) => c.received.some((m) => m.type === MSG.DRAFT_OPEN)) ? true : null),
    'DRAFT_OPEN (equipe)',
    20_000,
  );
  stop();
  // ⚠️ **Sans ca, la horde de l'anneau continue d'approcher et de taper au
  // contact APRES la fenetre de draft** : chaque touche remet
  // `shieldCalmTicks` a zero (voir `hurtPlayer`), et un test qui attend la
  // regeneration du bouclier (`prendreLaCarte`) n'arrive jamais a
  // `SHIELD_CALM_TICKS`. Loin du centre de la carte, aucun monstre existant
  // n'a le temps de retraverser la distance pendant la fenetre d'un test.
  for (const [i, c] of clients.entries()) {
    room.debugPlace(c.playerId, 100 + i * 200, 100);
  }
  return { room, clients };
}

/**
 * Monte l'equipe d'un niveau SEUL, prend la carte legendaire `nomCarte` dans
 * l'etalage force, et attend sa resolution.
 *
 * `avant`, si fourni, s'execute juste AVANT la pose du jeton — assez tot pour
 * que `Room#grantCard` lise l'etat qu'il vient de poser (Fournaise : un
 * joueur deja blesse, pour prouver qu'un malus de PV max ne l'acheve pas).
 *
 * ⚠️ **Transcendance seulement : attend le bouclier PLEIN avant de rendre la
 * main.** `Room#grantCard` « ouvre la reserve, ne la remplit pas » (voir son
 * docbloc) : `shield` reste a 0 jusqu'a `SHIELD_CALM_TICKS` sans degat puis
 * `SHIELD_REGEN_PER_SEC` jusqu'au plafond. Un test qui frapperait tout de
 * suite ne prouverait rien sur l'absorption — l'attente se fait sur LE FIL
 * (le dernier `SNAPSHOT` recu par le client), pas sur l'etat interne du
 * salon : c'est la seule maniere de rester fidele a « sur vraies sockets ».
 */
async function prendreLaCarte(
  nomCarte: string,
  avant?: (room: Room) => void,
): Promise<{ ws: WebSocket; room: Room; messages: Message[]; snapshotBytes: number[] }> {
  const { room, clients } = await rejoindreEtMonterDUnNiveau(1);
  const a = clients[0];
  if (!a) {
    throw new Error('aucun client');
  }
  const open = a.received.find((m): m is DraftOpenMessage => m.type === MSG.DRAFT_OPEN);
  if (!open) {
    throw new Error('DRAFT_OPEN attendu');
  }
  const index = open.cards.findIndex(
    (c) => c.nature === CARD.PASSIVE && passiveOf(c.refId).name === nomCarte,
  );
  if (index < 0) {
    throw new Error(`carte "${nomCarte}" absente de l'etalage force legendaire`);
  }
  avant?.(room);
  a.ws.send(encodeDraftToken(index));
  await waitFor(
    () => (a.received.some((m) => m.type === MSG.DRAFT_RESULT) ? true : null),
    'DRAFT_RESULT',
    5000,
  );
  if (nomCarte === 'transcendance') {
    // ⚠️ **L'attente porte sur l'etat ARBITRE, pas sur le fil arrondi.**
    // `Math.min` plafonne `shield` EXACTEMENT a `SHIELD_POOL` une fois la
    // reserve atteinte, sans jamais le depasser ; le `u8` du fil, lui,
    // ARRONDIT (`Math.round` dans `encodeSnapshot`) et peut annoncer « plein »
    // un cran flottant trop tot (59,93 arrondi affiche deja 60). Guetter le
    // fil directement ferait sortir cette attente avant que la reserve ne
    // soit VRAIMENT pleine cote salon — exactement le defaut observe en
    // ecrivant ce test.
    await waitFor(
      () => (room.shieldOf(a.playerId) >= SHIELD_POOL ? true : null),
      'bouclier plein',
      10_000,
    );
    // Un `SNAPSHOT` FRAIS, pose APRES ce plafond : c'est lui que les
    // assertions liront, pour que « plein » soit aussi confirme sur le fil.
    const avant = a.received.length;
    await waitFor(
      () => (a.received.slice(avant).some((m) => m.type === MSG.SNAPSHOT) ? true : null),
      'snapshot frais apres plafond',
      2000,
    );
  }
  return { ws: a.ws, room, messages: a.received, snapshotBytes: a.snapshotBytes };
}

/** Les cartes GAGNEES par le seul joueur du salon, reconstituees du `DRAFT_OPEN` et du `DRAFT_RESULT` decodes. */
function cartesGagnees(messages: Message[]) {
  const open = messages.find((m): m is DraftOpenMessage => m.type === MSG.DRAFT_OPEN);
  const result = messages.find((m) => m.type === MSG.DRAFT_RESULT);
  if (!open || !result || result.type !== MSG.DRAFT_RESULT) {
    throw new Error('DRAFT_OPEN ou DRAFT_RESULT absent des messages');
  }
  const gagnees = [];
  for (const o of result.outcomes) {
    const carte = open.cards[o.cardIndex];
    if (carte && o.outcome !== OUTCOME.LOST) {
      gagnees.push(carte);
    }
  }
  return gagnees;
}

describe('etape 13 : le livrable, sur vraies sockets', () => {
  it('un emplacement legendaire ne propose QUE des cartes de regle, et les deux clients voient le meme etalage', async () => {
    const { clients } = await rejoindreEtMonterDUnNiveau(2);
    const [a, b] = clients;
    if (!a || !b) {
      throw new Error('deux clients attendus');
    }
    const ouvertureA = a.received.find((m): m is DraftOpenMessage => m.type === MSG.DRAFT_OPEN);
    const ouvertureB = b.received.find((m): m is DraftOpenMessage => m.type === MSG.DRAFT_OPEN);
    expect(ouvertureA).toBeDefined();
    expect(ouvertureB).toBeDefined();

    // ---- Le meme etalage, bout a bout, sur les DEUX sockets -------------
    expect(ouvertureB).toEqual(ouvertureA);

    // ⚠️ `wanted = joueurs + SPREAD_BONUS` (ici 2 + 3 = 5) depasse le
    // catalogue legendaire (3 cartes, etape 13) : la "descente de palier"
    // documentee dans `shared/cards.ts` (`drawSpread`) sert alors les
    // emplacements restants en EPIQUE plutot que de rendre un etalage trop
    // court. Les deux paliers sont des cartes de REGLE (`shared/rarity.ts`) :
    // c'est cette propriete-la que le livrable doit montrer, pas une
    // rarete LEGENDAIRE partout — impossible dans ce salon des que
    // `wanted` depasse 3.
    for (const carte of ouvertureA?.cards ?? []) {
      expect([RARITY.EPIQUE, RARITY.LEGENDAIRE]).toContain(carte.rarity);
      expect(carte.nature).toBe(CARD.PASSIVE);
      expect(passiveOf(carte.refId).tier).toBeDefined();
    }
    expect(ouvertureA?.cards).toHaveLength(2 + SPREAD_BONUS);
    a.ws.close();
    b.ws.close();
  }, 30_000);

  it('Transcendance ramene les PV max a 1 des deux cotes, sans octet de plus', async () => {
    const { room, messages, snapshotBytes } = await prendreLaCarte('transcendance');

    // ---- 1. Le salon ARBITRE : le plafond force a 1 ----------------------
    expect(room.maxHpOf(1)).toBe(TRANSCENDANCE_MAX_HP);

    // ---- 2. Le miroir du CLIENT, reconstitue comme `GameClient` le fait --
    const miroir = new Loadout();
    for (const c of cartesGagnees(messages)) {
      applyCardToLoadout(miroir, c);
    }
    expect(maxHpOf(miroir, 0)).toBe(TRANSCENDANCE_MAX_HP);

    // ---- 3. Le bouclier plein, et RIEN de plus que les 11 octets --------
    // (`SNAPSHOT_PLAYER_BYTES`, etape 13, tache 5) attendus par joueur :
    // 22 (en-tete) + 11 x 1 joueur = 33, NU — jamais recalcule avec
    // `SNAPSHOT_PLAYER_BYTES` lui-meme (meme piege documente dans
    // `rarete.integration.test.ts`).
    const dernier = [...messages]
      .reverse()
      .find((m): m is SnapshotMessage => m.type === MSG.SNAPSHOT);
    expect(dernier?.players.find((p) => p.id === 1)?.shield).toBe(SHIELD_POOL);
    expect(snapshotBytes.at(-1)).toBe(33);
  }, 20_000);

  it('le bouclier encaisse un coup mortel pour les PV seuls, puis le suivant tue', async () => {
    const { room } = await prendreLaCarte('transcendance');
    room.debugHurt(1, SHIELD_POOL - 10);
    expect(room.hpOf(1)).toBe(TRANSCENDANCE_MAX_HP);
    expect(room.shieldOf(1)).toBe(10);
    room.debugHurt(1, 50);
    expect(room.hpOf(1)).toBe(0);
  }, 20_000);

  it('Fournaise baisse les PV max sans tuer un joueur blesse', async () => {
    const { room } = await prendreLaCarte('fournaise', (r) => r.debugSetHp(1, 30));
    expect(room.maxHpOf(1)).toBe(PLAYER_MAX_HP - 40);
    expect(room.hpOf(1)).toBeGreaterThan(0);
  }, 20_000);
});
