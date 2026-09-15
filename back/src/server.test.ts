import type { AddressInfo } from 'node:net';
import { CARD } from '@shared/cards';
import {
  EXTRACT_MULTIPLIER_STEP,
  PORTAL_WINDOW_TICKS,
  SNAPSHOT_HZ,
  TICK_HZ,
} from '@shared/constants';
import { ELEMENT } from '@shared/elements';
import {
  decode,
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

/**
 * Etape 6a, tache 5 bis — **la charge du boss sur le fil**.
 *
 * ⚠️ **La diffusion de `BOSS_CHARGE` n'etait couverte par AUCUN test** :
 * mutation appliquee sur le disque, la boucle d'emission retiree, toute la
 * suite restait verte — exactement comme `REACTION` avant la tache 7, et comme
 * les deux lignes de `Session` du registre de dettes. La supprimer laisserait le
 * boss traverser son couloir chez le serveur et nulle part ailleurs.
 *
 * La PREUVE ne passe que par la socket : c'est le message decode qui est
 * interroge, jamais `room.drainBossCharges()`.
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
    // serveur : atteindre un boss demande quatre vagues, soit une trentaine de
    // secondes d'horloge murale. `Room.step` est public et le tick n'est qu'un
    // compteur — l'avancer ici fait apparaitre le boss en quelques
    // millisecondes, et c'est bien le SERVEUR qui diffuse ce qu'il en tire.
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
 * Etape 6a, tache 9 — **le portail sur le fil**.
 *
 * ⚠️ **La ligne de diffusion est l'angle mort de ce depot** : `REACTION` et
 * `BOSS_CHARGE` sont toutes deux passees sans test, et la dette « S1/S3 » du
 * registre disait deja la meme chose du draft. Trois lignes naissent ici —
 * l'ouverture, les votes, le verdict — et une quatrieme recoit le vote. Les
 * quatre sont mutees sur le disque a l'ecriture de ce test, et les quatre font
 * rougir ce fichier.
 *
 * La PREUVE ne passe que par la socket : ce sont les messages decodes qui sont
 * interroges, jamais `room.drainPortalOpens()`.
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

    // ⚠️ **Le salon est avance DEPUIS LE TEST**, en plus de la boucle du
    // serveur : atteindre un boss demande quatre vagues, soit une trentaine de
    // secondes d'horloge murale. Meme technique qu'a la tache 5 bis.
    for (let t = 0; t < 120 * TICK_HZ && room.bossEntityId === null; t++) {
      room.step(1 / TICK_HZ);
      balayer();
    }
    const bossId = room.bossEntityId;
    expect(bossId).not.toBeNull();

    // ⚠️ **Rendre la main au serveur, sinon l'ordre teste plus bas n'existe
    // pas.** Les boucles ci-dessus bloquent la boucle d'evenements : sans
    // cette pause, AUCUNE diffusion n'aurait lieu tant que le boss est vivant,
    // et « l'ouverture precede le snapshot sans boss » se lirait d'une suite
    // de messages ou aucun snapshot n'aurait jamais porte de boss.
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

    // --- 1. L'ouverture arrive, datee.
    const open = await nextMessage(ws, (m) => m.type === MSG.PORTAL_OPEN, 10_000);
    if (open.type !== MSG.PORTAL_OPEN) {
      throw new Error('PORTAL_OPEN attendu');
    }
    expect(open.deadlineTick).toBe(tickMort + PORTAL_WINDOW_TICKS);
    // ⚠️ **Le multiplicateur traverse la SOCKET, pas seulement l'encodeur**
    // (tache 10) : c'est ici que se verifie que `#broadcast` lit bien
    // l'evenement du salon et pas une valeur inventee. Premier portail de la
    // run, donc 1 — ce que le second portail annonce est garde dans
    // `room.test.ts`, la ou une run peut en enchainer deux.
    expect(open.multiplier).toBe(room.extractMultiplier);
    expect(open.multiplier).toBe(1);

    // --- 2. Les votes partent en continu, silencieux compris.
    const votes = await nextMessage(ws, (m) => m.type === MSG.VOTES, 10_000);
    if (votes.type !== MSG.VOTES) {
      throw new Error('VOTES attendu');
    }
    // ⚠️ **On ne negocie pas un choix qu'on ne voit pas** (§6) : le silence
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

    // --- 4. L'ORDRE : l'evenement precede l'etat qui en decoule.
    //
    // ⚠️ **C'est la seule assertion du depot qui garde la POSITION du bloc du
    // portail dans `#broadcast`.** Le dernier snapshot a porter un boss, puis
    // l'ouverture, puis le premier snapshot sans boss : deplacer le bloc apres
    // l'envoi du snapshot inverse les deux dernieres lignes, et rien d'autre
    // ne s'en apercevrait. Un client doit connaitre l'evenement avant de voir
    // l'etat qui en decoule (§3.1 / §6.1 / §6.2).
    const indexOuverture = recus.findIndex((m) => m.type === MSG.PORTAL_OPEN);
    const dernierAvecBoss = recus.reduce(
      (acc, m, i) => (m.type === MSG.SNAPSHOT && m.boss !== null ? i : acc),
      -1,
    );
    const premierSansBoss = recus.findIndex(
      (m, i) => i > dernierAvecBoss && m.type === MSG.SNAPSHOT && m.boss === null,
    );
    expect(dernierAvecBoss).toBeGreaterThanOrEqual(0);
    expect(premierSansBoss).toBeGreaterThan(dernierAvecBoss);
    expect(indexOuverture).toBeGreaterThan(dernierAvecBoss);
    expect(indexOuverture).toBeLessThan(premierSansBoss);
  }, 40_000);

  /**
   * ⚠️ **Ce test existe parce qu'une mutation a SURVECU** (tache 10). Le test
   * ci-dessus assene `open.multiplier === 1`, et c'est exactement ce que le
   * premier portail d'une run vaut : remplacer `encodePortalOpen(deadline,
   * open.multiplier)` par `encodePortalOpen(deadline, 1)` dans `#broadcast` le
   * laissait ENTIEREMENT VERT. Le decor masquait la ligne qu'il pretendait
   * garder — le motif « decor qui masque », dix fois dans ce depot.
   *
   * La seule facon de le tuer est d'ouvrir un SECOND portail, donc de rester
   * une fois, donc de tuer deux boss sur une vraie socket. C'est long, et c'est
   * le prix de la seule ligne du serveur qui porte ce chiffre.
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
     * salon. Meme technique que le test ci-dessus : le salon est avance DEPUIS
     * LE TEST, sinon quatre vagues coutent une trentaine de secondes
     * d'horloge murale.
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
