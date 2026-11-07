import type { AddressInfo } from 'node:net';
import { CARD } from '@shared/cards';
import { TICK_HZ } from '@shared/constants';
import {
  CLOSE_CODES,
  decode,
  encodeDraftToken,
  encodeHello,
  encodeInput,
  encodePing,
  encodeStart,
  encodeVote,
  type Message,
  MSG,
  type ResyncMessage,
  type SnapshotMessage,
  VOTE_CHOICE,
} from '@shared/protocol';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { BASE_WEAPON_ID, WEAPONS, weaponOf } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, findAccountIdByToken, goldOf, prisma } from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

/**
 * Le livrable de l'etape 18 (§7 de la spec), sur vraies sockets : **une socket
 * qui tombe en run laisse un slot reserve le temps de la grace ; le meme compte
 * qui revient reprend sa place, son build, la horde au pixel pres, l'etalage
 * ouvert ; un absent ne bouge pas et n'est pas vise ; apres la grace c'est un
 * joueur neuf ; pendant la grace le salon est plein ; l'absent est credite a
 * l'extraction ; la fenetre de ping n'est pas heritee ; le dernier qui tombe
 * ne ferme pas le salon ; le `SNAPSHOT` garde sa taille.**
 *
 * Harnais copie d'`evenement.integration.test.ts` (`waitingRoom: true`,
 * `START` de l'hote, `envelopper` pour dater) et de
 * `credit.integration.test.ts` (`voteExtraction`), par convention, pas importe.
 */

const ROOM_SEED = 0x18_0018;
const DT = 1 / TICK_HZ;
/** 22 octets d'en-tete + 4 joueurs x 11 : ecrit NU, jamais recalcule (etape 16). */
const SNAPSHOT_A_QUATRE = 66;
const DISTANCE_BOSS = 100;
const DAGUE = weaponOf(BASE_WEAPON_ID);
const PORTEE_DAGUE = (DAGUE.projectileSpeed * DAGUE.projectileLifeTicks) / TICK_HZ;
if (DISTANCE_BOSS >= PORTEE_DAGUE) {
  throw new Error('le boss doit etre tenu a portee de la dague');
}
const TICKS_PAR_RESPIRATION = 60;
const RESPIRATION_MS = 20;
/** Une arme draftable, qui n'est pas la dague : la carte que l'absent garde. */
const ARME = WEAPONS.find((w) => w.id !== BASE_WEAPON_ID && w.kind === 'tir')?.id ?? 1;

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  token: Uint8Array;
  accountId: string;
  playerId: number;
  /** Tout ce qui est arrive sur CETTE socket, hors snapshots. */
  received: Message[];
  /** TOUT, snapshots compris, dans l'ordre d'arrivee : l'ordre RESYNC / SNAPSHOT en depend. */
  flux: Message[];
  lastSnapshot: SnapshotMessage | null;
  /** Les tailles BRUTES des snapshots recus. */
  snapshotBytes: Set<number>;
  /** La taille BRUTE du dernier `RESYNC` recu, `-1` sans. */
  resyncBytes: number;
  seq: number;
}

let app: App;
let port: number;
const openSockets: WebSocket[] = [];

async function demarrer(graceMs?: number): Promise<void> {
  app = await buildServer({ roomSeed: ROOM_SEED, waitingRoom: true, graceMs });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
}

beforeEach(async () => {
  await prisma.account.deleteMany();
  await demarrer();
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

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function attendre<T>(
  probe: () => T | null | Promise<T | null>,
  quoi: string,
  timeoutMs = 3000,
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
    await dormir(8);
  }
}

/** Ouvre une socket et presente `token` (un compte neuf a defaut). N'attend rien. */
async function entre(code: string, token?: Uint8Array): Promise<Client> {
  const jeton = token ?? (await createAccount()).token;
  const accountId = await findAccountIdByToken(jeton);
  if (accountId === null) {
    throw new Error('jeton inconnu');
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  openSockets.push(ws);
  const ouverte = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const client: Client = {
    ws,
    token: jeton,
    accountId,
    playerId: 0,
    received: [],
    flux: [],
    lastSnapshot: null,
    snapshotBytes: new Set(),
    resyncBytes: -1,
    seq: 0,
  };
  ws.on('message', (data: ArrayBuffer) => {
    const msg = decode(data);
    client.flux.push(msg);
    if (msg.type === MSG.WELCOME) {
      client.playerId = msg.playerId;
    }
    if (msg.type === MSG.SNAPSHOT) {
      client.lastSnapshot = msg;
      client.snapshotBytes.add(data.byteLength);
      return;
    }
    if (msg.type === MSG.RESYNC) {
      client.resyncBytes = data.byteLength;
    }
    client.received.push(msg);
  });
  await ouverte;
  ws.send(encodeHello(jeton));
  return client;
}

const welcome = (c: Client): Promise<number> =>
  attendre(() => (c.playerId !== 0 ? c.playerId : null), 'WELCOME');

/** Le meme jeton refait `HELLO` : la reprise. */
async function reconnect(code: string, token: Uint8Array): Promise<Client> {
  const c = await entre(code, token);
  await welcome(c);
  return c;
}

const resyncDe = (c: Client): Promise<ResyncMessage> =>
  attendre(
    () => c.received.find((m): m is ResyncMessage => m.type === MSG.RESYNC) ?? null,
    'RESYNC',
  );

const presence = (c: Client, playerId: number, present: boolean): Promise<Message> =>
  attendre(
    () =>
      c.received.find(
        (m) => m.type === MSG.PRESENCE && m.playerId === playerId && m.present === present,
      ) ?? null,
    `PRESENCE(${playerId}, ${present})`,
  );

/** `n` joueurs en salle d'attente, puis l'hote lance : tous ont leur WELCOME. */
async function lancer(n: number): Promise<{ code: string; clients: Client[]; room: Room }> {
  const code = await createRoomCode();
  const clients: Client[] = [];
  for (let i = 0; i < n; i++) {
    const c = await entre(code);
    clients.push(c);
    await attendre(
      () => c.received.find((m) => m.type === MSG.LOBBY && m.players.length === i + 1) ?? null,
      `LOBBY a ${i + 1}`,
    );
  }
  clients[0]?.ws.send(encodeStart());
  for (const c of clients) {
    await welcome(c);
  }
  const room = app.rooms.get(code);
  if (!room) {
    throw new Error('salon introuvable');
  }
  return { code, clients, room };
}

const fermeture = (ws: WebSocket): Promise<number> =>
  new Promise((res) => ws.once('close', (code: number) => res(code)));

/** Enveloppe `room.step` : `apres` s'execute a la fin de chaque tick du serveur. */
function envelopper(room: Room, apres: () => void): void {
  const pas = room.step.bind(room);
  room.step = (dt: number): void => {
    pas(dt);
    apres();
  };
}

function envoyer(c: Client, moveX: number, moveY: number, aimX: number, aimY: number): void {
  c.seq++;
  c.ws.send(encodeInput(c.seq, moveX, moveY, aimX, aimY));
}

async function snapshotFrais(c: Client): Promise<SnapshotMessage> {
  const avant = c.lastSnapshot?.tick ?? -1;
  return attendre(
    () => {
      const s = c.lastSnapshot;
      return s && s.tick > avant ? s : null;
    },
    'un SNAPSHOT frais',
    5000,
  );
}

function positionDuFil(c: Client): { x: number; y: number } {
  const moi = c.lastSnapshot?.players.find((p) => p.id === c.playerId);
  if (!moi) {
    throw new Error(`le joueur ${c.playerId} est absent du dernier snapshot`);
  }
  return { x: moi.x, y: moi.y };
}

async function immobiliser(c: Client): Promise<{ x: number; y: number }> {
  envoyer(c, 0, 0, 0, 0);
  for (let i = 0; i < 100; i++) {
    await snapshotFrais(c);
    const a = positionDuFil(c);
    await snapshotFrais(c);
    const b = positionDuFil(c);
    if (a.x === b.x && a.y === b.y) {
      return b;
    }
  }
  throw new Error('le joueur ne s arrete pas');
}

/** Retire de la horde tout sauf les identites `garder`, HORS du lot de morts. */
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
      await dormir(RESPIRATION_MS);
    }
  }
  await dormir(RESPIRATION_MS);
  if (!pret()) {
    throw new Error(`${quoi} : rien en ${maxTicks} ticks`);
  }
}

/** Amene le boss puis le fait tomber, et avance jusqu'a l'ouverture du portail (copie de `credit`). */
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

/** Fait voter « partir » tous les `clients` donnes, attend `RUN_OVER` chez chacun. */
async function voteExtraction(clients: readonly Client[], room: Room): Promise<void> {
  const tireur = clients[0];
  if (!tireur) {
    throw new Error('au moins un client attendu');
  }
  const cagnotte = room.gold;
  await tuerLeBoss(room, tireur);
  room.debugSetGold(cagnotte);
  for (const c of clients) {
    c.ws.send(encodeVote(VOTE_CHOICE.LEAVE));
  }
  for (const c of clients) {
    await attendre(
      () => c.received.find((m) => m.type === MSG.RUN_OVER) ?? null,
      `RUN_OVER pour ${c.playerId}`,
      15_000,
    );
  }
}

/** Le credit est « fire and forget » : on attend que le solde bouge. */
async function attendreCredit(accountId: string, attendu: bigint): Promise<bigint> {
  return attendre(
    async () => {
      const v = await goldOf(accountId);
      return v === attendu ? v : null;
    },
    `le credit de ${accountId}`,
    5000,
  ).catch(() => goldOf(accountId));
}

describe('etape 18 : la reconnexion avec etat complet', () => {
  it('1. revenir en moins de la grace rend le meme slot et le meme build', async () => {
    const { code, clients, room } = await lancer(2);
    const [j1, j2] = clients;
    if (!j1 || !j2) {
      throw new Error('deux joueurs attendus');
    }
    room.grantCard(2, { nature: CARD.WEAPON, refId: ARME });
    const avant = room.loadoutOf(2);
    j2.ws.close();
    await presence(j1, 2, false);
    expect(room.isAbsent(2)).toBe(true);
    await dormir(300);

    const retour = await reconnect(code, j2.token);
    expect(retour.playerId).toBe(2);
    const resync = await resyncDe(retour);
    const bloc = resync.players.find((p) => p.id === 2);
    expect(bloc?.absent).toBe(false);
    expect(bloc?.weapons.map((w) => w.weaponId)).toEqual([BASE_WEAPON_ID, ARME]);
    expect(room.loadoutOf(2)).toBe(avant);
    expect(room.isAbsent(2)).toBe(false);
    await presence(j1, 2, true);
  });

  it('2. la horde est identique au pixel : memes identites, x/y/vx/vy bit a bit', async () => {
    const { code, clients, room } = await lancer(2);
    const [j1, j2] = clients;
    if (!j1 || !j2) {
      throw new Error('deux joueurs attendus');
    }
    // Une horde peuplee, en plus du directeur : trois vagues a cote des joueurs.
    const p = room.positionOf(1) ?? { x: 3000, y: 3000 };
    for (let w = 0; w < 3; w++) {
      const order: WaveOrder = {
        waveId: 900 + w,
        spawnTick: room.tick,
        seed: 7 + w,
        archetype: 0,
        formation: FORMATION.CLUSTER,
        anchorX: p.x + 600 + w * 150,
        anchorY: p.y - 400 + w * 300,
        count: 200,
      };
      room.horde.spawn(order);
    }
    // Une copie de la horde a chaque tick, par `saveState` — c'est l'anneau du
    // client. On garde les derniers ticks, cle = tick.
    const copies = new Map<
      number,
      { ids: number[]; x: Float32Array; y: Float32Array; vx: Float32Array; vy: Float32Array }
    >();
    envelopper(room, () => {
      const n = room.horde.count;
      const ids: number[] = [];
      for (let i = 0; i < n; i++) {
        ids.push(room.horde.entityIdAt(i));
      }
      copies.set(room.tick, {
        ids,
        x: room.horde.x.slice(0, n),
        y: room.horde.y.slice(0, n),
        vx: room.horde.vx.slice(0, n),
        vy: room.horde.vy.slice(0, n),
      });
      copies.delete(room.tick - 200);
    });
    await dormir(500);

    j2.ws.close();
    await presence(j1, 2, false);
    const retour = await reconnect(code, j2.token);
    const resync = await resyncDe(retour);
    const copie = copies.get(resync.tick);
    expect(copie).toBeDefined();
    if (!copie) {
      return;
    }
    const n = resync.horde.count;
    expect(n).toBeGreaterThan(500);
    expect(n).toBe(copie.ids.length);
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      ids.push((resync.horde.waveId[i] ?? 0) * 4096 + (resync.horde.indexInWave[i] ?? 0));
    }
    expect(ids).toEqual(copie.ids);
    expect(resync.horde.x).toEqual(copie.x);
    expect(resync.horde.y).toEqual(copie.y);
    expect(resync.horde.vx).toEqual(copie.vx);
    expect(resync.horde.vy).toEqual(copie.vy);
    // §3.3 : pris apres les drains et AVANT le snapshot du meme tick — le
    // premier SNAPSHOT qui suit porte le tick du RESYNC, et rien de date <= T
    // n'arrive apres lui (une vague deja dans l'instantane renaitrait).
    const iResync = retour.flux.indexOf(resync);
    const snap = await attendre(
      () =>
        retour.flux.slice(iResync).find((m): m is SnapshotMessage => m.type === MSG.SNAPSHOT) ??
        null,
      'le SNAPSHOT qui suit le RESYNC',
    );
    expect(snap.tick).toBe(resync.tick);
    for (const m of retour.flux.slice(iResync + 1)) {
      if (m.type === MSG.WAVE_ORDER) {
        expect(m.spawnTick).toBeGreaterThan(resync.tick);
      }
      if (m.type === MSG.DEATHS) {
        expect(m.tick).toBeGreaterThan(resync.tick);
      }
    }
    // `process.stderr.write`, pas `console.info` : Vitest capture `console.*`
    // (voir `test/setup-db.ts`). C'est la mesure que la spec attend (§2, §3.4).
    process.stderr.write(
      `[etape 18] RESYNC : ${retour.resyncBytes} octets pour ${n} entites, ${resync.orbs.length} orbes, ${resync.zones.length} zones (tick ${resync.tick})\n`,
    );
  });

  it('3. l etalage ouvert est recu : memes cartes, meme echeance, et le jeton se pose', async () => {
    const { code, clients, room } = await lancer(2);
    const [j1, j2] = clients;
    if (!j1 || !j2) {
      throw new Error('deux joueurs attendus');
    }
    room.debugOweLevels(1);
    const open = await attendre(
      () => j1.received.find((m) => m.type === MSG.DRAFT_OPEN) ?? null,
      'DRAFT_OPEN',
    );
    if (open.type !== MSG.DRAFT_OPEN) {
      throw new Error('DRAFT_OPEN attendu');
    }
    j2.ws.close();
    await presence(j1, 2, false);
    const retour = await reconnect(code, j2.token);
    const resync = await resyncDe(retour);
    expect(resync.draft).not.toBeNull();
    expect(resync.draft?.kind).toBe('level');
    expect(resync.draft?.deadlineTick).toBe(open.deadlineTick);
    expect(resync.draft?.cards).toEqual(open.cards);
    retour.ws.send(encodeDraftToken(0));
    await attendre(
      () =>
        retour.received.find(
          (m) =>
            m.type === MSG.DRAFT_INTENTS &&
            m.intents.some((i) => i.playerId === 2 && i.cardIndex === 0),
        ) ?? null,
      'DRAFT_INTENTS avec le jeton de 2',
    );
  });

  it('4. absent, il ne bouge pas et n est pas vise', async () => {
    const { clients, room } = await lancer(2);
    const j2 = clients[1];
    if (!j2) {
      throw new Error('deux joueurs attendus');
    }
    for (let i = 0; i < 10; i++) {
      envoyer(j2, 127, 0, 127, 0);
      await dormir(33);
    }
    const enMarche = room.positionOf(2);
    j2.ws.close();
    await attendre(() => (room.isAbsent(2) ? true : null), 'absent');
    const arret = room.positionOf(2);
    expect(arret).not.toBeNull();
    const tick = room.tick;
    await attendre(() => (room.tick >= tick + 20 ? true : null), '20 ticks', 3000);
    expect(room.positionOf(2)).toEqual(arret);
    expect(enMarche).not.toEqual(room.positionOf(1));
    expect(room.horde.aimX).toHaveLength(1);
  });

  it('5. apres la grace, c est un nouveau joueur : meme slot, build neuf', async () => {
    await app.close();
    await demarrer(300);
    const { code, clients, room } = await lancer(2);
    const j2 = clients[1];
    if (!j2) {
      throw new Error('deux joueurs attendus');
    }
    room.grantCard(2, { nature: CARD.WEAPON, refId: ARME });
    const avant = room.loadoutOf(2);
    j2.ws.close();
    await dormir(600);
    expect(room.playerCount).toBe(1);
    const retour = await reconnect(code, j2.token);
    expect(retour.playerId).toBe(2);
    const apres = room.loadoutOf(2);
    expect(apres).not.toBe(avant);
    expect(apres?.weaponIds).toEqual([BASE_WEAPON_ID]);
  });

  it('6. pendant la grace, le salon est plein', async () => {
    const { code, clients } = await lancer(4);
    clients[3]?.ws.close();
    await presence(clients[0] as Client, 4, false);
    const cinquieme = await entre(code);
    expect(await fermeture(cinquieme.ws)).toBe(CLOSE_CODES.ROOM_FULL);
  });

  it('7. le compte absent est credite a l extraction', async () => {
    const { clients, room } = await lancer(4);
    const j4 = clients[3];
    if (!j4) {
      throw new Error('quatre joueurs attendus');
    }
    j4.ws.close();
    await presence(clients[0] as Client, 4, false);
    room.debugSetGold(400);
    await voteExtraction(clients.slice(0, 3), room);
    expect(await attendreCredit(j4.accountId, 400n)).toBe(400n);
    for (const c of clients.slice(0, 3)) {
      expect(await attendreCredit(c.accountId, 400n)).toBe(400n);
    }
  }, 120_000);

  it('8. la fenetre de ping n est pas heritee par le revenant', async () => {
    const { code, clients } = await lancer(2);
    const [j1, j2] = clients;
    if (!j1 || !j2) {
      throw new Error('deux joueurs attendus');
    }
    const pings = (): number =>
      j1.received.filter((m) => m.type === MSG.PING_SHOWN && m.playerId === 2).length;
    for (let i = 0; i < 3; i++) {
      j2.ws.send(encodePing(0, 200 + i, 10));
    }
    await attendre(() => (pings() === 3 ? true : null), 'trois pings');
    j2.ws.close();
    await presence(j1, 2, false);
    const retour = await reconnect(code, j2.token);
    retour.ws.send(encodePing(0, 999, 10));
    const quatrieme = await attendre(
      () => j1.received.find((m) => m.type === MSG.PING_SHOWN && m.x === 999) ?? null,
      'le quatrieme ping',
    );
    expect(quatrieme).toMatchObject({ playerId: 2 });
  });

  it('9. le dernier joueur qui tombe ne ferme pas le salon', async () => {
    const { code, clients, room } = await lancer(1);
    const j1 = clients[0];
    if (!j1) {
      throw new Error('un joueur attendu');
    }
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME });
    j1.ws.close();
    await attendre(() => (room.isAbsent(1) ? true : null), 'absent');
    const tick = room.tick;
    await dormir(300);
    expect(app.rooms.get(code)).toBe(room);
    expect(room.tick).toBeGreaterThan(tick);
    const retour = await reconnect(code, j1.token);
    expect(retour.playerId).toBe(1);
    const resync = await resyncDe(retour);
    expect(resync.players.find((p) => p.id === 1)?.weapons.map((w) => w.weaponId)).toEqual([
      BASE_WEAPON_ID,
      ARME,
    ]);
  });

  it('10. le SNAPSHOT garde sa taille : 66 octets a quatre', async () => {
    const { clients } = await lancer(4);
    const j4 = clients[3];
    if (!j4) {
      throw new Error('quatre joueurs attendus');
    }
    await snapshotFrais(j4);
    await snapshotFrais(j4);
    expect([...j4.snapshotBytes]).toEqual([SNAPSHOT_A_QUATRE]);
    clients[2]?.ws.close();
    await presence(j4, 3, false);
    await snapshotFrais(j4);
    expect([...j4.snapshotBytes]).toEqual([SNAPSHOT_A_QUATRE]);
  });
});
