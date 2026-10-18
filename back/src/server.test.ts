import type { AddressInfo } from 'node:net';
import { CARD } from '@shared/cards';
import {
  EXTRACT_MULTIPLIER_STEP,
  PORTAL_WINDOW_TICKS,
  SNAPSHOT_HZ,
  TICK_HZ,
} from '@shared/constants';
import { ELEMENT } from '@shared/elements';
import { EVENT_KIND, EVENT_OUTCOME } from '@shared/evenements';
import {
  decode,
  encodeAbility,
  encodeHello,
  encodeInput,
  encodeVote,
  type Message,
  MSG,
  NO_VOTE,
  packElementPair,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_BYTES,
  type SnapshotMessage,
  VOTE_CHOICE,
} from '@shared/protocol';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { WEAPONS } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, prisma } from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

type App = Awaited<ReturnType<typeof buildServer>>;

let app: App;
let port: number;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  await prisma.account.deleteMany();
  app = await buildServer();
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

/** Ouvre une socket de jeu et attend le WELCOME. */
async function connect(code: string): Promise<{ ws: WebSocket; playerId: number }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  openSockets.push(ws);

  // `nextMessage` installe son listener de facon synchrone : la promesse est
  // donc deja a l'ecoute avant que le HELLO ne parte.
  const welcomePromise = nextMessage(ws, (m) => m.type === MSG.WELCOME);

  // ⚠️ L'ecoute de 'open' est posee avant tout `await` : sur localhost la
  // socket peut s'ouvrir avant la fin de `createAccount()`, et l'evenement
  // serait manque.
  const ouverte = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  // Toute socket de jeu presente son jeton AVANT d'obtenir un slot : chaque
  // client a donc son propre compte.
  const { token } = await createAccount();
  await ouverte;
  ws.send(encodeHello(token));

  const welcome = await welcomePromise;
  if (welcome.type !== MSG.WELCOME) {
    throw new Error('WELCOME attendu');
  }
  return { ws, playerId: welcome.playerId };
}

function nextMessage(
  ws: WebSocket,
  match: (m: Message) => boolean,
  timeoutMs = 3000,
): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`aucun message correspondant en ${timeoutMs} ms`));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    }
    function onMessage(data: ArrayBuffer): void {
      const msg = decode(data);
      if (match(msg)) {
        cleanup();
        resolve(msg);
      }
    }
    function onClose(): void {
      cleanup();
      reject(new Error('socket fermee avant le message attendu'));
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

function nextSnapshot(
  ws: WebSocket,
  match: (s: SnapshotMessage) => boolean,
): Promise<SnapshotMessage> {
  return nextMessage(ws, (m) => m.type === MSG.SNAPSHOT && match(m)) as Promise<SnapshotMessage>;
}

/** Pose une entite a une position choisie, hors du generateur de vagues. */
function spawnMonsterAt(room: Room, waveId: number, x: number, y: number): number {
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
  return room.horde.entityIdAt(slot);
}

describe('GET /health', () => {
  it('repond ok, ce dont le healthcheck compose a besoin', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('POST /rooms', () => {
  it('rend un code de salon de quatre lettres', async () => {
    const res = await app.inject({ method: 'POST', url: '/rooms' });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ code: string }>().code).toMatch(/^[A-Z]{4}$/);
  });
});

describe('la socket de jeu', () => {
  it('attribue un identifiant distinct a chaque joueur du salon', async () => {
    const code = await createRoomCode();
    const a = await connect(code);
    const b = await connect(code);

    expect(a.playerId).not.toBe(b.playerId);
  });

  it('diffuse a chacun un snapshot contenant les deux joueurs', async () => {
    const code = await createRoomCode();
    const a = await connect(code);
    await connect(code);

    const snap = await nextSnapshot(a.ws, (s) => s.players.length === 2);

    expect(snap.players).toHaveLength(2);
  });

  it("c'est le serveur qui deplace le joueur, pas le client", async () => {
    const code = await createRoomCode();
    const { ws, playerId } = await connect(code);

    const before = (await nextSnapshot(ws, (s) => s.players.length === 1)).players.find(
      (p) => p.id === playerId,
    );
    if (!before) {
      throw new Error('joueur absent du snapshot');
    }

    // Plein gaz vers la droite, repete : le serveur applique la derniere entree
    // recue a chacun de ses pas.
    for (let seq = 1; seq <= 20; seq++) {
      ws.send(encodeInput(seq, 127, 0, 0, 0));
      await new Promise((r) => setTimeout(r, 10));
    }

    const after = await nextSnapshot(ws, (s) => {
      const me = s.players.find((p) => p.id === playerId);
      return me !== undefined && me.x > before.x;
    });

    const me = after.players.find((p) => p.id === playerId);
    expect(me?.x).toBeGreaterThan(before.x);
    expect(me?.y).toBe(before.y);
  });

  it('retire du snapshot un joueur qui se deconnecte', async () => {
    const code = await createRoomCode();
    const a = await connect(code);
    const b = await connect(code);
    await nextSnapshot(a.ws, (s) => s.players.length === 2);

    b.ws.close();

    const snap = await nextSnapshot(a.ws, (s) => s.players.length === 1);
    expect(snap.players.map((p) => p.id)).toEqual([a.playerId]);
  });

  /**
   * La replication entre deux joueurs, sans navigateur : a deux onglets, celui
   * en arriere-plan suspend son `requestAnimationFrame` et montre une image
   * perimee qu'on prend pour un bug de replication.
   */
  it('montre a chaque joueur le deplacement de l autre, arbitre par le serveur', async () => {
    const code = await createRoomCode();
    const mover = await connect(code);
    const watcher = await connect(code);

    const start = (await nextSnapshot(watcher.ws, (s) => s.players.length === 2)).players.find(
      (p) => p.id === mover.playerId,
    );
    if (!start) {
      throw new Error('le joueur qui bouge est absent du snapshot');
    }

    for (let seq = 1; seq <= 20; seq++) {
      mover.ws.send(encodeInput(seq, 127, 0, 0, 0));
      await new Promise((r) => setTimeout(r, 10));
    }

    // C'est bien l'observateur, sur sa propre socket, qui voit l'autre bouger.
    const seen = await nextSnapshot(watcher.ws, (s) => {
      const other = s.players.find((p) => p.id === mover.playerId);
      return other !== undefined && other.x > start.x + 20;
    });

    const other = seen.players.find((p) => p.id === mover.playerId);
    expect(other?.x).toBeGreaterThan(start.x + 20);
    expect(other?.y).toBe(start.y);
  });

  it('ferme la socket sur un code de salon inconnu', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=ZZZZ`);
    openSockets.push(ws);

    const code = await new Promise<number>((resolve) => {
      ws.on('close', resolve);
    });

    expect(code).toBe(4004);
  });

  /**
   * « Aucune position de monstre sur le fil », sous forme testable.
   *
   * Deux pieges evites :
   * - on attend un premier WAVE_ORDER avant de mesurer, preuve qu'une horde
   *   existe deja (une vague toutes les 6 s seulement) ;
   * - on compare a une valeur absolue deduite du format de trame, pas a une
   *   fenetre precedente, qui ne verrait pas des positions presentes des le
   *   debut.
   */
  it('ne fait pas grossir le trafic avec le nombre d ennemis', async () => {
    const code = await createRoomCode();
    const { ws } = await connect(code);

    let bytesReceived = 0;
    let entitiesSpawned = 0;
    ws.on('message', (data: ArrayBuffer) => {
      bytesReceived += data.byteLength;
      const msg = decode(data);
      if (msg.type === MSG.WAVE_ORDER) {
        entitiesSpawned += msg.count;
      }
    });

    // Preuve qu'une horde existe avant de mesurer, plutot qu'une
    // temporisation aveugle.
    await nextMessage(ws, (m) => m.type === MSG.WAVE_ORDER, 10_000);

    // On ne mesure qu'a partir d'ici : la horde est deja apparue, mais son
    // volume ne doit toujours pas se voir sur le fil.
    bytesReceived = 0;
    const windowMs = 3000;
    await new Promise((r) => setTimeout(r, windowMs));

    // Ce que doit peser le trafic, si et seulement si aucune position de
    // monstre ne transite : un en-tete de snapshot plus un joueur, a
    // SNAPSHOT_HZ.
    const expectedBytesPerSecond = (SNAPSHOT_HEADER_BYTES + SNAPSHOT_PLAYER_BYTES) * SNAPSHOT_HZ;
    const expectedBytes = expectedBytesPerSecond * (windowMs / 1000);

    // Marge x5 : elle absorbe un ordre de vague occasionnel, la gigue de
    // cadence et l'en-tete WebSocket, en restant deux ordres de grandeur sous
    // ce que couterait la replication de la horde.
    const maxBytes = expectedBytes * 5;

    process.stdout.write(
      `horde apparue : ${entitiesSpawned} entites -- trafic mesure sur ${windowMs} ms : ` +
        `${bytesReceived} octets (attendu ~${expectedBytes.toFixed(0)}, plafond ${maxBytes.toFixed(0)})\n`,
    );

    expect(entitiesSpawned).toBeGreaterThan(0);
    expect(
      bytesReceived,
      `trafic de ${bytesReceived} octets sur ${windowMs} ms, attendu au plus ` +
        `${maxBytes.toFixed(0)} octets (base ${expectedBytes.toFixed(0)} x 5) alors que la horde ` +
        `compte deja ${entitiesSpawned} entites`,
    ).toBeLessThan(maxBytes);
  }, 20_000);
});

describe('la reaction sur le fil (etape 5a, tache 7)', () => {
  /**
   * ⚠️ **Seul test qui garde la diffusion de `REACTION`** : sans lui, la
   * supprimer laisserait la suite verte.
   *
   * Le salon est pilote depuis le test (`app.rooms`), mais la PREUVE ne passe
   * que par la socket, jamais par `room.drainReactions()`.
   */
  it('diffuse la reaction aux clients, avec un couple canonicalise', async () => {
    const ARME_GIVRE = WEAPONS.find((w) => w.element === ELEMENT.GIVRE)?.id ?? -1;
    expect(ARME_GIVRE).toBeGreaterThanOrEqual(0);

    const code = await createRoomCode();
    const { ws, playerId } = await connect(code);
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    room.grantCard(playerId, { nature: CARD.WEAPON, refId: ARME_GIVRE });

    // La position du joueur vient du SNAPSHOT, pas d'un champ prive : le test
    // ne connait le monde que par ce que la socket lui livre.
    const snap = await nextSnapshot(ws, (m) => m.players.length > 0);
    const moi = snap.players[0];
    const cibleX = (moi?.x ?? 0) + 100;
    const cibleY = moi?.y ?? 0;
    const cible = spawnMonsterAt(room, 900, cibleX, cibleY);

    let seq = 0;
    const pilote = setInterval(() => {
      const slot = room.horde.slotOf(cible);
      if (slot >= 0) {
        // Increvable, immobile, et marque de Braise par un AUTRE joueur : le
        // decor tient tant que la reaction n'a pas eu lieu.
        room.horde.hp[slot] = 1e6;
        room.horde.x[slot] = cibleX;
        room.horde.y[slot] = cibleY;
        room.horde.applyMark(slot, ELEMENT.BRAISE, playerId + 1, room.tick);
      }
      seq = (seq + 1) & 0xffff;
      ws.send(encodeInput(seq, 0, 0, 127, 0));
    }, 20);

    try {
      const msg = await nextMessage(ws, (m) => m.type === MSG.REACTION, 10_000);
      if (msg.type !== MSG.REACTION) {
        throw new Error('REACTION attendu');
      }
      expect(msg.pair).toBe(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE));
      // ⚠️ La marque est posee par `playerId + 1`, et c'est `playerId` qui
      // declenche : deux joueurs differents, donc une charge. Le bit doit
      // traverser la socket, pas seulement etre calcule par `Room`.
      expect(msg.synergyCharge).toBe(true);
    } finally {
      clearInterval(pilote);
    }
  }, 15_000);
});

/**
 * ⚠️ **Seul test qui garde la diffusion de `BOSS_CHARGE`** : sans lui, retirer
 * la boucle d'emission laisserait la suite verte, et le boss chargerait chez le
 * serveur et nulle part ailleurs.
 *
 * La PREUVE ne passe que par la socket, jamais par `room.drainBossCharges()`.
 */
describe('la charge du boss sur le fil (etape 6a, tache 5 bis)', () => {
  it('diffuse la charge aux clients, une fois, avec ses trois ticks', async () => {
    const code = await createRoomCode();
    const { ws } = await connect(code);
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }

    // ⚠️ **Le salon est avance DEPUIS LE TEST**, en plus de la boucle du
    // serveur : atteindre un boss prend une trentaine de secondes d'horloge
    // murale. C'est toujours le SERVEUR qui diffuse ce qu'il en tire.
    const balayer = (): void => {
      const ids: number[] = [];
      for (let i = 0; i < room.horde.count; i++) {
        const id = room.horde.entityIdAt(i);
        if (id !== room.bossEntityId) {
          ids.push(id);
        }
      }
      if (ids.length > 0) {
        room.horde.kill(ids);
      }
    };
    for (let t = 0; t < 120 * TICK_HZ && room.bossEntityId === null; t++) {
      room.step(1 / TICK_HZ);
      balayer();
    }
    expect(room.bossEntityId).not.toBeNull();
    for (let t = 0; t < 4 * TICK_HZ && room.bossCharge === null; t++) {
      balayer();
      room.step(1 / TICK_HZ);
    }
    expect(room.bossCharge).not.toBeNull();

    const msg = await nextMessage(ws, (m) => m.type === MSG.BOSS_CHARGE, 10_000);
    if (msg.type !== MSG.BOSS_CHARGE) {
      throw new Error('BOSS_CHARGE attendu');
    }
    expect(msg.entityId).toBe(room.bossEntityId);
    // Les trois ticks voyagent : c'est d'eux, et d'eux seuls, que le client
    // derive la progression du boss le long du couloir.
    expect(msg.windupTick).toBeLessThan(msg.startTick);
    expect(msg.startTick).toBeLessThan(msg.endTick);
    expect(msg.length).toBeGreaterThan(0);
    expect(msg.width).toBeGreaterThan(0);
  }, 20_000);
});

/**
 * **Le portail sur le fil.**
 *
 * ⚠️ Garde les quatre lignes de diffusion du portail (ouverture, votes,
 * verdict, reception du vote) : en retirer une fait rougir ce fichier.
 *
 * La PREUVE ne passe que par la socket, jamais par `room.drainPortalOpens()`.
 */
describe('le portail sur le fil (etape 6a, tache 9)', () => {
  it('diffuse l ouverture AVANT le snapshot qui en decoule, les votes, puis le verdict', async () => {
    const code = await createRoomCode();
    const { ws, playerId } = await connect(code);
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }

    // Tout ce qui arrive, DANS L'ORDRE : c'est l'ordre lui-meme qu'on
    // interroge a la fin.
    const recus: Message[] = [];
    ws.on('message', (data: ArrayBuffer) => {
      recus.push(decode(data));
    });

    /** Ne laisse vivre que le boss : on mesure une diffusion, pas une melee. */
    const balayer = (): void => {
      const ids: number[] = [];
      for (let i = 0; i < room.horde.count; i++) {
        const id = room.horde.entityIdAt(i);
        if (id !== room.bossEntityId) {
          ids.push(id);
        }
      }
      if (ids.length > 0) {
        room.horde.kill(ids);
      }
    };

    // ⚠️ **Le salon est avance DEPUIS LE TEST** (voir la charge du boss).
    for (let t = 0; t < 120 * TICK_HZ && room.bossEntityId === null; t++) {
      room.step(1 / TICK_HZ);
      balayer();
    }
    const bossId = room.bossEntityId;
    expect(bossId).not.toBeNull();

    // ⚠️ **Rendre la main au serveur, sinon l'ordre teste plus bas n'existe
    // pas** : les boucles ci-dessus bloquent la boucle d'evenements, et sans
    // cette pause aucun snapshot ne porterait jamais le boss.
    await new Promise((r) => setTimeout(r, 120));
    expect(recus.some((m) => m.type === MSG.SNAPSHOT && m.boss !== null)).toBe(true);

    // Le boss tombe par le chemin de mort normal du salon : sa reserve est
    // ramenee a un coup, il est tenu a portee, et le joueur vise.
    const avant = room.palier;
    const slot = room.horde.slotOf(bossId ?? -1);
    room.horde.hp[slot] = 1;
    const moi = await nextSnapshot(ws, (m) => m.players.length > 0);
    const pos = moi.players.find((p) => p.id === playerId) ?? { x: 0, y: 0 };
    for (let t = 0; t < 30 * TICK_HZ && room.palier === avant; t++) {
      const s = room.horde.slotOf(bossId ?? -1);
      if (s >= 0) {
        room.horde.x[s] = pos.x + 100;
        room.horde.y[s] = pos.y;
      }
      balayer();
      room.applyInput(playerId, 20_000 + room.tick, 0, 0, 127, 0);
      room.step(1 / TICK_HZ);
    }
    expect(room.palier).toBe(avant + 1);
    const tickMort = room.tick;

    // ⚠️ **Le portail ne suit pas la mort du boss** : il s'ouvre toutes les
    // `PORTAL_EVERY_WAVES` vagues. On avance jusqu'a lui, horde videe.
    for (let t = 0; t < 300 * TICK_HZ && !room.portalOpen; t++) {
      room.step(1 / TICK_HZ);
      room.horde.kill(Array.from({ length: room.horde.count }, (_, i) => room.horde.entityIdAt(i)));
    }
    expect(room.portalOpen).toBe(true);

    // --- 1. L'ouverture arrive, datee.
    const open = await nextMessage(ws, (m) => m.type === MSG.PORTAL_OPEN, 10_000);
    if (open.type !== MSG.PORTAL_OPEN) {
      throw new Error('PORTAL_OPEN attendu');
    }
    expect(open.deadlineTick).toBeGreaterThanOrEqual(tickMort + PORTAL_WINDOW_TICKS);
    // ⚠️ **Le multiplicateur traverse la SOCKET, pas seulement l'encodeur.**
    // Premier portail de la run, donc 1 : le second est garde par le test
    // suivant.
    expect(open.multiplier).toBe(room.extractMultiplier);
    expect(open.multiplier).toBe(1);

    // --- 2. Les votes partent en continu, silencieux compris.
    const votes = await nextMessage(ws, (m) => m.type === MSG.VOTES, 10_000);
    if (votes.type !== MSG.VOTES) {
      throw new Error('VOTES attendu');
    }
    // ⚠️ **On ne negocie pas un choix qu'on ne voit pas** : le silence
    // circule, sinon personne ne sait qui n'a pas encore tranche.
    expect(votes.votes).toEqual([{ playerId, choice: NO_VOTE }]);

    // --- 3. Le vote remonte par la socket, et le verdict redescend par elle.
    ws.send(encodeVote(VOTE_CHOICE.LEAVE));
    const verdict = await nextMessage(ws, (m) => m.type === MSG.PORTAL_RESULT, 10_000);
    if (verdict.type !== MSG.PORTAL_RESULT) {
      throw new Error('PORTAL_RESULT attendu');
    }
    expect(verdict.decision).toBe(VOTE_CHOICE.LEAVE);
    expect(verdict.effectTick).toBeGreaterThanOrEqual(tickMort);
    // L'or ACQUIS, celui-la meme que le salon garde.
    expect(verdict.gold).toBe(room.gold);
    expect(verdict.gold).toBeGreaterThan(0);

    // ⚠️ **Partir termine la run, et la fin arrive APRES le verdict** : sinon
    // l'ecran de fin s'ouvre sans la decision et dit « L'equipe est tombee » a
    // une equipe qui vient de partir. Il part dans le MEME envoi que le
    // verdict : on le lit dans `recus`.
    for (let i = 0; i < 100 && !recus.some((m) => m.type === MSG.RUN_OVER); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const indexVerdict = recus.findIndex((m) => m.type === MSG.PORTAL_RESULT);
    const indexFin = recus.findIndex((m) => m.type === MSG.RUN_OVER);
    expect(indexVerdict).toBeGreaterThanOrEqual(0);
    expect(indexFin).toBeGreaterThan(indexVerdict);

    // --- 4. L'ORDRE : l'evenement precede l'etat qui en decoule.
    //
    // ⚠️ **Seule assertion qui garde la POSITION du bloc du portail dans
    // `#broadcast`** : l'ouverture part AVANT le premier snapshot date de son
    // tick ou d'apres.
    const tickOuverture = open.deadlineTick - PORTAL_WINDOW_TICKS;
    const indexOuverture = recus.findIndex((m) => m.type === MSG.PORTAL_OPEN);
    const premierApres = recus.findIndex((m) => m.type === MSG.SNAPSHOT && m.tick >= tickOuverture);
    expect(indexOuverture).toBeGreaterThanOrEqual(0);
    expect(premierApres).toBeGreaterThan(indexOuverture);
  }, 40_000);

  /**
   * ⚠️ Au premier portail le multiplicateur vaut 1 : un
   * `encodePortalOpen(deadline, 1)` code en dur dans `#broadcast` passerait le
   * test ci-dessus. Seul un SECOND portail le distingue, d'ou deux boss sur
   * une vraie socket. C'est long, mais c'est la seule ligne du serveur qui
   * porte ce chiffre.
   */
  it('annonce le multiplicateur MAJORE au portail SUIVANT, sur le fil', async () => {
    const code = await createRoomCode();
    const { ws, playerId } = await connect(code);
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }

    /** Ne laisse vivre que le boss : on mesure une diffusion, pas une melee. */
    const balayer = (): void => {
      const ids: number[] = [];
      for (let i = 0; i < room.horde.count; i++) {
        const id = room.horde.entityIdAt(i);
        if (id !== room.bossEntityId) {
          ids.push(id);
        }
      }
      if (ids.length > 0) {
        room.horde.kill(ids);
      }
    };

    /**
     * Amene un boss, puis le fait tomber par le chemin de mort normal du
     * salon, en avancant le salon DEPUIS LE TEST.
     */
    const tuerLeBoss = async (): Promise<void> => {
      for (let t = 0; t < 180 * TICK_HZ && room.bossEntityId === null; t++) {
        room.step(1 / TICK_HZ);
        balayer();
      }
      const bossId = room.bossEntityId;
      expect(bossId).not.toBeNull();

      // Rendre la main a la boucle du serveur, sinon rien n'est jamais diffuse.
      await new Promise((r) => setTimeout(r, 60));

      const avant = room.palier;
      const slot = room.horde.slotOf(bossId ?? -1);
      room.horde.hp[slot] = 1;
      const moi = await nextSnapshot(ws, (m) => m.players.length > 0);
      const pos = moi.players.find((p) => p.id === playerId) ?? { x: 0, y: 0 };
      for (let t = 0; t < 30 * TICK_HZ && room.palier === avant; t++) {
        const s = room.horde.slotOf(bossId ?? -1);
        if (s >= 0) {
          room.horde.x[s] = pos.x + 100;
          room.horde.y[s] = pos.y;
        }
        balayer();
        room.applyInput(playerId, 20_000 + room.tick, 0, 0, 127, 0);
        room.step(1 / TICK_HZ);
      }
      expect(room.palier).toBe(avant + 1);
      // Puis jusqu'au portail, qui a son propre rythme (`PORTAL_EVERY_WAVES`).
      for (let t = 0; t < 300 * TICK_HZ && !room.portalOpen; t++) {
        room.step(1 / TICK_HZ);
        room.horde.kill(
          Array.from({ length: room.horde.count }, (_, i) => room.horde.entityIdAt(i)),
        );
      }
      expect(room.portalOpen).toBe(true);
    };

    // --- Premier palier : le multiplicateur de depart.
    await tuerLeBoss();
    const premier = await nextMessage(ws, (m) => m.type === MSG.PORTAL_OPEN, 10_000);
    expect(premier).toMatchObject({ multiplier: 1 });

    // --- RESTER : la cagnotte n'est pas acquise, la mise monte.
    ws.send(encodeVote(VOTE_CHOICE.STAY));
    const verdict = await nextMessage(ws, (m) => m.type === MSG.PORTAL_RESULT, 10_000);
    expect(verdict).toMatchObject({ decision: VOTE_CHOICE.STAY });
    expect(room.extractMultiplier).toBe(1 + EXTRACT_MULTIPLIER_STEP);

    // --- Second palier : c'est CE chiffre-la que rien d'autre ne garde.
    await tuerLeBoss();
    const second = await nextMessage(ws, (m) => m.type === MSG.PORTAL_OPEN, 10_000);
    expect(second).toMatchObject({ multiplier: 1 + EXTRACT_MULTIPLIER_STEP });
    // Et la majoration se VOIT : sans elle, les deux annonces seraient egales.
    expect(second).not.toMatchObject({ multiplier: 1 });
  }, 60_000);
});

describe('etape 8 tache 3, ronde de correction 1 : ABILITY_USED part une seule fois', () => {
  /**
   * ⚠️ `useAbility` met l'annonce en file (`Room#drainAbilities`) ET la rend a
   * l'appelant ; si le gestionnaire de `MSG.ABILITY` envoyait AUSSI ce retour,
   * chaque verbe partirait deux fois. Ce test compte les `ABILITY_USED`
   * reellement recus sur le fil.
   */
  it('un verbe accepte ne produit qu UNE seule annonce ABILITY_USED sur le fil', async () => {
    const code = await createRoomCode();
    const { ws } = await connect(code);

    const recus: Message[] = [];
    ws.on('message', (data: ArrayBuffer) => recus.push(decode(data)));

    ws.send(encodeAbility(0, 1, 0));

    // Largement plus qu'un cycle de diffusion (33 ms a 30 Hz) : un envoi en
    // double, l'un immediat et l'autre draine au tick suivant, aurait tout le
    // temps d'arriver dans cette fenetre.
    await new Promise((r) => setTimeout(r, 300));

    const used = recus.filter((m) => m.type === MSG.ABILITY_USED);
    expect(used).toHaveLength(1);
  });

  /**
   * ⚠️ Un Relais derive sa cible du MEME tick que celui ou le serveur a
   * tranche si l'allie etait vivant : si `ABILITY_USED` et `DEATHS` partaient
   * dans un ordre non garanti, deux clients pourraient deriver l'un un allie
   * vivant, l'autre un mort.
   *
   * Une mort REELLE (pipeline de combat, pas `horde.kill`) et une acceptation
   * de verbe sont produites dans le MEME bloc synchrone, sans `await` : le
   * minuteur du salon ne peut pas s'intercaler, ce qui rend l'ordre mesure
   * reproductible.
   */
  it('DEATHS part avant ABILITY_USED quand les deux sont prets au meme tick', async () => {
    const code = await createRoomCode();
    const { ws, playerId } = await connect(code);
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }

    const premier = await nextSnapshot(ws, () => true);
    const moi = premier.players.find((p) => p.id === playerId);
    if (!moi) {
      throw new Error('joueur absent du snapshot');
    }

    const recus: Message[] = [];
    ws.on('message', (data: ArrayBuffer) => recus.push(decode(data)));

    // A portee de l'arme de base mais hors de CONTACT_RADIUS : seul le
    // projectile tue. L'arme ne tire JAMAIS sans visee (`Room.join` laisse
    // `aimX`/`aimY` a 0), d'ou une visee a chaque tick.
    const monstre = spawnMonsterAt(room, 888_000, moi.x + 100, moi.y);
    let seq = 1;
    for (let t = 0; t < 30 * TICK_HZ && room.horde.slotOf(monstre) >= 0; t++) {
      const slot = room.horde.slotOf(monstre);
      if (slot >= 0) {
        const dx = (room.horde.x[slot] ?? 0) - moi.x;
        const dy = (room.horde.y[slot] ?? 0) - moi.y;
        const len = Math.hypot(dx, dy) || 1;
        room.applyInput(playerId, seq++, 0, 0, (dx / len) * 127, (dy / len) * 127);
      }
      room.step(1 / TICK_HZ);
    }
    // La mort REELLE a mis une annonce DEATHS en file avant la ligne suivante.
    expect(room.horde.slotOf(monstre)).toBe(-1);
    // Meme tick, meme bloc synchrone : aucun `await` ne separe la mort
    // ci-dessus de l'acceptation ci-dessous.
    const annonce = room.useAbility(playerId, 1, 0);
    expect(annonce).not.toBeNull();
    expect(annonce?.tick).toBe(room.tick);

    await nextMessage(ws, (m) => m.type === MSG.ABILITY_USED, 5000);
    const iDeaths = recus.findIndex((m) => m.type === MSG.DEATHS);
    const iUsed = recus.findIndex((m) => m.type === MSG.ABILITY_USED);
    expect(iDeaths).toBeGreaterThanOrEqual(0);
    expect(iUsed).toBeGreaterThanOrEqual(0);
    expect(iDeaths).toBeLessThan(iUsed);
  }, 15_000);
});

describe('etape 14 : les evenements sur le fil', () => {
  /**
   * ⚠️ **La garantie du §6.4** : un client doit lire l'`EVENT_END` reussi
   * AVANT le `LEVEL_UP` qui ouvre l'etalage, sans quoi il nommerait l'etalage
   * « Niveau » — meme quand les deux partent dans le MEME envoi. Tout se joue
   * dans un bloc SYNCHRONE : le minuteur du salon ne peut pas s'intercaler, et
   * le `#broadcast` suivant draine depart, etats, fin et `LEVEL_UP` ensemble.
   */
  it('EVENT_START, puis les etats, puis EVENT_END reussi, puis LEVEL_UP, dans le meme envoi', async () => {
    const code = await createRoomCode();
    const { ws, playerId } = await connect(code);
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const recus: Message[] = [];
    ws.on('message', (data: ArrayBuffer) => {
      const m = decode(data);
      if (m.type !== MSG.SNAPSHOT) {
        recus.push(m);
      }
    });

    room.debugStartEvent(3 * 0x4_6a2b + EVENT_KIND.FORGE);
    const forge = room.eventPoints?.[0];
    if (!forge) {
      throw new Error('forge attendue');
    }
    room.debugPlace(playerId, forge.x, forge.y);
    for (let t = 0; t < 2000 && room.eventPoints !== null; t++) {
      const ids: number[] = [];
      for (let i = 0; i < room.horde.count; i++) {
        ids.push(room.horde.entityIdAt(i));
      }
      if (ids.length > 0) {
        room.horde.kill(ids);
      }
      room.step(1 / TICK_HZ);
      room.debugRevive(playerId);
    }
    expect(room.eventPoints).toBeNull();
    // L'etalage s'ouvre au tick suivant : LEVEL_UP en file avec la fin.
    room.step(1 / TICK_HZ);

    await nextMessage(ws, (m) => m.type === MSG.DRAFT_OPEN, 5000);
    const types = recus.map((m) => m.type);
    const iDebut = types.indexOf(MSG.EVENT_START);
    const iEtat = types.indexOf(MSG.EVENT_STATE);
    const iFin = types.indexOf(MSG.EVENT_END);
    const iUp = types.indexOf(MSG.LEVEL_UP);
    expect(iDebut).toBeGreaterThanOrEqual(0);
    expect(iEtat).toBeGreaterThan(iDebut);
    expect(iFin).toBeGreaterThan(iEtat);
    expect(recus[iFin]).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.REUSSI });
    expect(iUp).toBeGreaterThan(iFin);
    expect(types.lastIndexOf(MSG.EVENT_STATE)).toBeLessThan(iFin);
  }, 15_000);
});
