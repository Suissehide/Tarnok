import type { AddressInfo } from 'node:net';
import { applicationsOf } from '@shared/cards';
import { ORB_PICKUP_RADIUS, SPREAD_BONUS } from '@shared/constants';
import { PASSIVES } from '@shared/passives';
import {
  decode,
  encodeDraftToken,
  encodeHello,
  encodeInput,
  type Message,
  MSG,
  OUTCOME,
  type SnapshotMessage,
  type WireOutcome,
} from '@shared/protocol';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { WEAPONS } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, prisma } from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

/**
 * **Quatre clients reels, sur des sockets reelles**, qui montent de niveau,
 * draftent et entrent en conflit. La resolution est un seul moment : le
 * perdant recoit sa carte de remplacement dans le MEME `DRAFT_RESULT`.
 *
 * ⚠️ **Pourquoi headless et pas quatre onglets.** `requestAnimationFrame` est
 * suspendu dans un onglet en arriere-plan : trois onglets sur quatre ne
 * dessineraient rien, et une capture montrerait une image perimee qu'on
 * prendrait pour un defaut de replication.
 *
 * ⚠️ **Pourquoi la vraie socket et pas un `Room` pilote en direct.** C'est le
 * seul test qui couvre la diffusion de `DRAFT_OPEN` dans `Session#broadcast`
 * et la reception de `DRAFT_TOKEN` dans `Session#onFrame` : il ne connait
 * l'etalage que par ce que la socket lui livre, et ne pose ses jetons que par
 * ce qu'elle transporte.
 *
 * ⚠️ **Pourquoi les monstres sont poses a la main.** Attendre le generateur de
 * vagues est lent ET intermittent (taille variable, monstres qui doivent
 * traverser `ANCHOR_RADIUS`). Un anneau autour de chaque joueur amene le
 * premier etalage en quelques secondes et sans hasard ; c'est pour ca que
 * `buildServer` decore l'app de son registre.
 */

/** Graine imposee au salon : ce test ne doit rien devoir au hasard. */
const ROOM_SEED = 0x7a5c_0d11;

/** Monstres poses autour de chaque joueur a chaque renouvellement. */
const RING_SIZE = 10;

/**
 * Rayon de l'anneau, en pixels monde.
 *
 * ⚠️ **Doit rester sous `ORB_PICKUP_RADIUS`.** Un orbe naît a la position du
 * monstre qui vient de mourir : pose l'anneau plus loin que le rayon de
 * ramassage et les orbes tombent hors de portee, l'experience ne monte
 * jamais, et le test expire sans jamais dire pourquoi. Le garde ci-dessous
 * rend cette dependance bruyante plutot que tacite.
 */
const RING_RADIUS = 80;
if (RING_RADIUS >= ORB_PICKUP_RADIUS) {
  throw new Error("l'anneau doit rester dans le rayon de ramassage des orbes");
}

/** Quatre joueurs : c'est le nombre que le livrable exige. */
const PLAYER_COUNT = 4;

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  /** Tout ce qui est arrive sur CETTE socket, hors snapshots. */
  received: Message[];
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

/**
 * Ouvre une socket de jeu, attend le WELCOME, et enregistre desormais tout ce
 * qui arrive.
 *
 * ⚠️ L'enregistrement est **permanent**, pas une attente ponctuelle : la
 * fenetre de draft dure vingt secondes, pendant lesquelles `DRAFT_INTENTS` et
 * `DRAFT_RESULT` peuvent arriver a n'importe quel moment. Un `once('message')`
 * pose apres coup manquerait ce qui est deja passe.
 */
async function connect(code: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  openSockets.push(ws);

  // ⚠️ L'ecoute de 'open' est posee ICI, avant tout `await` : sur
  // localhost la socket peut s'ouvrir plus vite qu'une volee Prisma, et un
  // `once('open', ...)` pose apres `createAccount()` manquerait l'evenement
  // deja passe, bloquant `connect` jusqu'au timeout du test.
  const ouverte = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const received: Message[] = [];
  const client: Client = { ws, playerId: 0, received, seq: 0 };

  ws.on('message', (data: ArrayBuffer) => {
    const msg = decode(data);
    if (msg.type === MSG.WELCOME) {
      client.playerId = msg.playerId;
    }
    // Les snapshots arrivent a 15 Hz pendant toute la manche : les garder
    // noierait les quelques messages de draft qu'on interroge.
    if (msg.type !== MSG.SNAPSHOT) {
      received.push(msg);
    }
  });

  // Toute socket de jeu presente son jeton AVANT d'obtenir un slot : chaque
  // client de ce harnais a donc son propre compte.
  const { token } = await createAccount();
  await ouverte;
  ws.send(encodeHello(token));

  await waitFor(() => (client.playerId !== 0 ? client.playerId : null), 'WELCOME', 3000);
  return client;
}

/**
 * Attend qu'une condition observable devienne vraie, en scrutant l'etat deja
 * accumule. Rend ce que la condition a produit.
 */
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

/** Le premier snapshot ou les quatre joueurs sont la — il porte leurs positions. */
function fullSnapshot(ws: WebSocket): Promise<SnapshotMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('aucun snapshot a quatre joueurs en 3000 ms'));
    }, 3000);
    function cleanup(): void {
      clearTimeout(timer);
      ws.off('message', onMessage);
    }
    function onMessage(data: ArrayBuffer): void {
      const msg = decode(data);
      if (msg.type === MSG.SNAPSHOT && msg.players.length === PLAYER_COUNT) {
        cleanup();
        resolve(msg);
      }
    }
    ws.on('message', onMessage);
  });
}

/**
 * Pose une entite a une position choisie, hors du generateur de vagues — meme
 * technique que `spawnMonsterAt` dans `room.test.ts` et `combat.test.ts`.
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
 * Fait monter l'equipe d'un niveau : un anneau de monstres autour de chaque
 * joueur, renouvele quand la horde se vide, et chaque joueur qui vise en
 * continu le monstre le plus proche de lui.
 *
 * ⚠️ **La visee passe par la socket**, comme le reste : la proximite d'un
 * monstre ne declenche rien, sans `aimX`/`aimY` l'arme ne tire jamais et
 * l'experience ne monte pas.
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

/** Les issues d'un joueur donne, dans un message `DRAFT_RESULT`. */
function outcomesOf(outcomes: readonly WireOutcome[], playerId: number): WireOutcome[] {
  return outcomes.filter((o) => o.playerId === playerId);
}

describe('quatre clients reels draftent (livrable du §13)', () => {
  it('un conflit a lieu, un seul le gagne, les perdants sont servis dans le meme lot, l absent aussi', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('le registre de salons doit etre accessible depuis l app');
    }

    const clients: Client[] = [];
    for (let i = 0; i < PLAYER_COUNT; i++) {
      clients.push(await connect(code));
    }
    const [a, b, c, d] = clients;
    if (!a || !b || !c || !d) {
      throw new Error('quatre clients attendus');
    }
    expect(new Set(clients.map((x) => x.playerId)).size).toBe(PLAYER_COUNT);

    // Les positions viennent du fil, pas d'une constante du serveur : les
    // joueurs n'envoient aucun deplacement, elles ne bougeront plus.
    const snap = await fullSnapshot(a.ws);
    const positions = new Map(snap.players.map((p) => [p.id, { x: p.x, y: p.y }]));

    const startedAt = Date.now();
    const stopDriver = startCombatDriver(room, positions, clients);

    // ---- 1. L'etalage s'ouvre, et il s'ouvre SUR LA SOCKET ----------------
    //
    // ⚠️ Si `Session#broadcast` cesse de diffuser `DRAFT_OPEN`, c'est ici que
    // le test rougit.
    const opens = await Promise.all(
      clients.map((client) =>
        waitFor(
          () => client.received.find((m) => m.type === MSG.DRAFT_OPEN) ?? null,
          `DRAFT_OPEN pour le joueur ${client.playerId}`,
          20_000,
        ),
      ),
    );
    stopDriver();
    process.stdout.write(
      `premier etalage au tick ${room.tick} (${((Date.now() - startedAt) / 1000).toFixed(1)} s ` +
        `d'horloge) ; echeance de la fenetre au tick ${
          opens[0]?.type === MSG.DRAFT_OPEN ? opens[0].deadlineTick : -1
        }\n`,
    );

    const spread = opens[0];
    if (!spread || spread.type !== MSG.DRAFT_OPEN) {
      throw new Error('DRAFT_OPEN attendu');
    }
    // `joueurs + SPREAD_BONUS` cartes, les memes pour tous.
    expect(spread.cards).toHaveLength(PLAYER_COUNT + SPREAD_BONUS);
    for (const open of opens) {
      expect(open).toEqual(spread);
    }
    // Aucune carte n'est reservee : l'etalage ne doit contenir que des natures
    // connues, et aucune carte en double (deux cartes identiques rendraient
    // un conflit illisible).
    expect(spread.cards.every((card) => card.nature === 0 || card.nature === 1)).toBe(true);
    expect(new Set(spread.cards.map((c) => `${c.nature}:${c.refId}`)).size).toBe(
      spread.cards.length,
    );

    // ---- 2. Trois joueurs se disputent la meme carte, le quatrieme se tait -
    //
    // ⚠️ Si `Session#onFrame` ignore `DRAFT_TOKEN`, `DRAFT_INTENTS` n'est
    // jamais diffuse et l'attente ci-dessous expire ; a defaut, l'absence de
    // `LOST` plus bas le dirait.
    const CONTESTED = 0;
    for (const client of [a, b, c]) {
      client.ws.send(encodeDraftToken(CONTESTED));
    }

    // La preuve que le serveur a bien recu les trois gestes : il rediffuse les
    // intentions, et les trois pointent la meme carte.
    const intents = await waitFor(
      () =>
        a.received.find(
          (m) =>
            m.type === MSG.DRAFT_INTENTS &&
            m.intents.length === 3 &&
            m.intents.every((i) => i.cardIndex === CONTESTED),
        ) ?? null,
      'DRAFT_INTENTS portant les trois jetons sur la carte disputee',
      5000,
    );
    if (intents.type !== MSG.DRAFT_INTENTS) {
      throw new Error('DRAFT_INTENTS attendu');
    }
    expect(new Set(intents.intents.map((i) => i.playerId))).toEqual(
      new Set([a.playerId, b.playerId, c.playerId]),
    );
    expect(intents.intents.some((i) => i.playerId === d.playerId)).toBe(false);

    // ---- 3. La resolution : le conflit, et l'attribution d'office ---------
    //
    // Le joueur `d` ne pose rien : la fenetre va jusqu'a son echeance
    // (`DRAFT_WINDOW_TICKS`, 20 s) : un joueur absent ne bloque jamais, et
    // c'est le cout d'horloge de ce test.
    const first = await waitFor(
      () => a.received.find((m) => m.type === MSG.DRAFT_RESULT) ?? null,
      'DRAFT_RESULT',
      30_000,
    );
    if (first.type !== MSG.DRAFT_RESULT) {
      throw new Error('DRAFT_RESULT attendu');
    }
    // `deadlineTick` porte la fin du gel : le client ne peut plus la deduire.
    expect(first.deadlineTick).toBeGreaterThan(0);
    const won = first.outcomes.filter((o) => o.outcome === OUTCOME.WON);
    const lost = first.outcomes.filter((o) => o.outcome === OUTCOME.LOST);

    // ⚠️ **L'assertion centrale.** Un draft sans conflit ne prouve rien : on
    // COMPTE les perdants, on ne les suppose pas. Elle vient AVANT les autres
    // pour que ce soit elle qui parle quand la mise en scene se degrade en
    // silence.
    expect(
      lost.length,
      "aucun conflit n'a eu lieu : trois jetons sur la meme carte devaient faire deux perdants",
    ).toBe(2);
    // Un seul joueur obtient la carte contestee.
    expect(won).toHaveLength(1);
    expect(won[0]?.cardIndex).toBe(CONTESTED);
    for (const l of lost) {
      expect(l.cardIndex).toBe(CONTESTED);
    }
    const winnerId = won[0]?.playerId ?? 0;
    expect([a.playerId, b.playerId, c.playerId]).toContain(winnerId);

    // Le silencieux est servi d'office, et jamais au detriment d'un present :
    // sa carte n'est pas celle que les trois autres se disputaient.
    const forSilent = outcomesOf(first.outcomes, d.playerId);
    expect(forSilent).toHaveLength(1);
    expect(forSilent[0]?.outcome).toBe(OUTCOME.AUTO);
    expect(forSilent[0]?.cardIndex).not.toBe(CONTESTED);

    // Les quatre joueurs sont tranches au meme message : personne n'attend.
    expect(new Set(first.outcomes.map((o) => o.playerId)).size).toBe(PLAYER_COUNT);

    // ---- 4. Les perdants sont servis DANS LE MEME LOT ---------------------
    //
    // Le perdant ne rechoisit pas : ses deux issues, le `LOST` de la carte
    // disputee et l'`AUTO` de celle qui la remplace, arrivent ensemble.
    const losers = lost.map((l) => l.playerId);
    for (const id of losers) {
      const siennes = outcomesOf(first.outcomes, id);
      expect(siennes, `le joueur ${id} n a pas recu ses DEUX issues`).toHaveLength(2);
      expect(siennes.filter((o) => o.outcome === OUTCOME.LOST)).toHaveLength(1);
      const remplacement = siennes.find((o) => o.outcome === OUTCOME.AUTO);
      expect(remplacement, `le perdant ${id} repart les mains vides`).toBeDefined();
      expect(remplacement?.cardIndex).not.toBe(CONTESTED);
    }

    // ⚠️ **Deux perdants, donc deux remplacements a separer.** Avec un seul,
    // rien ne pourrait entrer en collision et le garde qui marque une carte
    // comme prise passerait inapercu. On les COMPTE, on ne les suppose pas.
    const remplacements = first.outcomes.filter(
      (o) => o.outcome === OUTCOME.AUTO && losers.includes(o.playerId),
    );
    expect(remplacements).toHaveLength(2);
    expect(new Set(remplacements.map((o) => o.cardIndex)).size).toBe(2);

    // Et AUCUN second message : la resolution est un seul moment. On laisse
    // passer une seconde pleine de ticks avant de le dire.
    await new Promise((r) => setTimeout(r, 1000));
    expect(
      a.received.filter((m) => m.type === MSG.DRAFT_RESULT),
      'un second DRAFT_RESULT est arrive : la repioche est de retour',
    ).toHaveLength(1);

    const granted = new Map<number, number>();
    for (const o of first.outcomes) {
      if (o.outcome !== OUTCOME.LOST) {
        granted.set(o.playerId, o.cardIndex);
      }
    }

    // Les quatre joueurs ont chacun une carte, et jamais la meme.
    expect(granted.size).toBe(PLAYER_COUNT);
    expect(new Set(granted.values()).size).toBe(PLAYER_COUNT);

    // Et cote serveur, la carte a vraiment atterri dans l'inventaire : sans
    // ca, on aurait verifie un message et pas un effet.
    for (const client of clients) {
      const loadout = room.loadoutOf(client.playerId);
      // ⚠️ Des CARTES, pas des slots : une carte de l'arme de depart s'empile
      // sans ouvrir de slot, et compter les slots la rendrait invisible.
      const cartes =
        WEAPONS.reduce((n, w) => n + (loadout?.stacksOfWeapon(w.id) ?? 0), 0) +
        PASSIVES.reduce((n, p) => n + (loadout?.stacksOf(p.id) ?? 0), 0);
      // L'arme du depart, plus la carte gagnee autant de fois que sa rarete
      // le dit : une rare compte deux exemplaires.
      const carte = spread.cards[granted.get(client.playerId) ?? -1];
      if (!carte) {
        throw new Error(`aucune carte attribuee au joueur ${client.playerId}`);
      }
      expect(cartes, `l inventaire du joueur ${client.playerId} est reste vide`).toBe(
        1 + applicationsOf(carte),
      );
    }
  }, 90_000);
});
