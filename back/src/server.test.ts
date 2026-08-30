import type { AddressInfo } from 'node:net';
import { CARD } from '@shared/cards';
import { SNAPSHOT_HZ } from '@shared/constants';
import { ELEMENT } from '@shared/elements';
import {
  decode,
  encodeInput,
  type Message,
  MSG,
  packElementPair,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_BYTES,
  type SnapshotMessage,
} from '@shared/protocol';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { WEAPONS } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { Room } from './room';
import { buildServer } from './server';

type App = Awaited<ReturnType<typeof buildServer>>;

let app: App;
let port: number;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
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

  const welcome = await nextMessage(ws, (m) => m.type === MSG.WELCOME);
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

/**
 * Pose une entite a une position choisie, hors du generateur de vagues — meme
 * technique que `spawnMonsterAt` dans `room.test.ts` et `combat.test.ts`.
 */
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
   * Le livrable de l'etape 0, sans navigateur.
   *
   * La verification a deux onglets est trompeuse : un onglet en arriere-plan a
   * son `requestAnimationFrame` suspendu, donc il ne redessine pas — et une
   * capture d'ecran montre alors une image perimee qu'on prend pour un bug de
   * replication. Ce test-la ne depend d'aucun rendu.
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
   * La formulation testable de « sans position sur le fil ».
   *
   * Bien meilleure qu'une inspection de code : elle survit aux
   * refactorisations. Si quelqu'un ajoute un jour des positions de monstres
   * dans le snapshot, ce test le voit tout de suite.
   *
   * Deux pieges evites par construction :
   * - Comparer deux fenetres l'une a l'autre ne prouve rien si aucune vague
   *   n'est sortie pendant l'une d'elles (WaveDirector n'en emet qu'une
   *   toutes les 6 s) : on attend un premier WAVE_ORDER, preuve observable
   *   que des centaines d'entites existent deja, avant de commencer a
   *   mesurer.
   * - Comparer a la fenetre precedente ne verrait pas une regression ou des
   *   positions de monstres seraient presentes des le debut et de taille
   *   stable : on compare a une valeur absolue, deduite du format de trame.
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
    // temporisation aveugle : on attend le premier WAVE_ORDER (periode de
    // 6 s, delai genereux ci-dessous).
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

    // Marge x5 : elle absorbe un ordre de vague occasionnel (19 octets, rare
    // sur une fenetre de 3 s), la gigue de cadence et l'en-tete WebSocket,
    // tout en restant deux ordres de grandeur sous ce que couterait la
    // replication de la horde (des centaines d'entites x 5 octets x 30
    // fois par seconde).
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
   * ⚠️ **La diffusion de `REACTION` n'etait couverte par AUCUN test** —
   * mutation appliquee, elle survivait, exactement comme les deux lignes de
   * `Session` que la tache 6 de l'etape 4 avait laissees nues (dette « S1/S3 »
   * du registre). La supprimer laisserait toute la suite verte, et la reaction
   * n'arriverait simplement jamais chez personne.
   *
   * Le salon est pilote depuis le test (`app.rooms`, decore par
   * `buildServer`), mais la PREUVE ne passe que par la socket : c'est le
   * message decode qui est interroge, jamais `room.drainReactions()`.
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
      // declenche : deux joueurs differents, donc une charge (§7). Le bit
      // traverse la socket jusqu'ici — la regle de la tache 8 est bien celle
      // que le client recoit, pas seulement celle que `Room` calcule.
      expect(msg.synergyCharge).toBe(true);
    } finally {
      clearInterval(pilote);
    }
  }, 15_000);
});
