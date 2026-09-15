import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import { MAX_PLAYERS, SNAPSHOT_HZ, TICK_HZ } from '@shared/constants';
import {
  decode,
  encodeBossCharge,
  encodeDeaths,
  encodeDraftIntents,
  encodeDraftOpen,
  encodeDraftResult,
  encodeLevelUp,
  encodePickups,
  encodePortalOpen,
  encodePortalResult,
  encodeReaction,
  encodeRunOver,
  encodeVotes,
  encodeWaveOrder,
  encodeWelcome,
  encodeZone,
  MSG,
} from '@shared/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import { type WebSocket, WebSocketServer } from 'ws';

import { FixedStepAccumulator } from './loop';
import type { Outbox, Room } from './room';
import { RoomRegistry } from './rooms';

const STEP_MS = 1000 / TICK_HZ;
const BROADCAST_MS = 1000 / SNAPSHOT_HZ;

/**
 * Plafond de rattrapage. Voir `FixedStepAccumulator` : sans lui, une pause du
 * process rejoue des centaines de pas d'un coup.
 */
const MAX_CATCH_UP_STEPS = 5;

/** Periode du HUD de debug serveur (§4.6 : un HUD, pas des logs). */
const METRICS_PERIOD_MS = 5000;

/** Codes de fermeture applicatifs, dans la plage privee 4000-4999. */
const CLOSE_UNKNOWN_ROOM = 4004;
const CLOSE_ROOM_FULL = 4003;
const CLOSE_BAD_FRAME = 4002;

/**
 * Un salon en cours d'execution : la simulation, ses sockets, et sa boucle.
 *
 * Toute la connaissance du reseau est ici. `room.ts` n'en sait rien et n'en
 * saura jamais rien : c'est ce qui rendra le passage a un salon par
 * `worker_threads` mecanique.
 */
class Session {
  readonly #clients = new Map<number, WebSocket>();
  readonly #outbox: Outbox & { buffers: ArrayBuffer[] };
  readonly #timer: NodeJS.Timeout;
  /** Octets reellement pousses sur le fil : l'encodage est mutualise, pas l'envoi. */
  #wireBytes = 0;

  constructor(
    readonly code: string,
    readonly room: Room,
    private readonly onEmpty: (code: string) => void,
  ) {
    const buffers: ArrayBuffer[] = [];
    this.#outbox = { buffers, push: (msg) => buffers.push(msg) };

    const start = performance.now();
    const sim = new FixedStepAccumulator(STEP_MS, MAX_CATCH_UP_STEPS, start);
    // Un seul pas de rattrapage pour la diffusion : reenvoyer trois snapshots
    // d'affilee apres un a-coup n'aide personne, ils seraient tous perimes.
    const broadcast = new FixedStepAccumulator(BROADCAST_MS, 1, start);

    this.#timer = setInterval(() => {
      const now = performance.now();
      const steps = sim.advance(now);
      for (let i = 0; i < steps; i++) {
        this.room.step(STEP_MS / 1000);
      }
      if (broadcast.advance(now) > 0) {
        this.#broadcast();
      }
    }, STEP_MS / 2);
  }

  get playerCount(): number {
    return this.#clients.size;
  }

  /** Rend l'identifiant attribue, ou null si le salon est plein. */
  add(ws: WebSocket): number | null {
    const id = this.#freeId();
    if (id === null || !this.room.join(id)) {
      return null;
    }
    this.#clients.set(id, ws);

    ws.binaryType = 'arraybuffer';
    ws.send(encodeWelcome(id, this.room.tick, this.room.mapSeed));
    ws.on('message', (data: ArrayBuffer) => {
      this.#onFrame(id, ws, data);
    });
    ws.on('close', () => {
      this.remove(id);
    });
    ws.on('error', () => {
      this.remove(id);
    });

    return id;
  }

  remove(id: number): void {
    this.#clients.delete(id);
    this.room.leave(id);
    if (this.#clients.size === 0) {
      this.onEmpty(this.code);
    }
  }

  stop(): void {
    clearInterval(this.#timer);
    for (const ws of this.#clients.values()) {
      ws.close();
    }
    this.#clients.clear();
  }

  /** Rend les compteurs du salon et les remet a zero. */
  drainMetrics(): {
    salon: string;
    joueurs: number;
    'ko/s emis': number;
    'ko/s par joueur': number;
    'us encodage / snapshot': number;
    'vagues tronquees': number;
  } {
    const room = this.room.drainMetrics();
    const wireBytes = this.#wireBytes;
    this.#wireBytes = 0;
    const seconds = METRICS_PERIOD_MS / 1000;
    const players = Math.max(1, this.#clients.size);

    return {
      salon: this.code,
      joueurs: this.#clients.size,
      'ko/s emis': round2(wireBytes / 1024 / seconds),
      'ko/s par joueur': round2(wireBytes / players / 1024 / seconds),
      'us encodage / snapshot': round2(room.encodeMicros / Math.max(1, room.snapshots)),
      // La horde sature a 4 000 entites tant que rien ne meurt (§11 de la
      // spec, differe a l'etape 3) : ce compteur rend cette saturation
      // visible dans le HUD plutot que silencieuse, comme le veut le §4.6.
      'vagues tronquees': room.truncatedSpawns,
    };
  }

  #onFrame(id: number, ws: WebSocket, data: ArrayBuffer): void {
    let msg: ReturnType<typeof decode>;
    try {
      msg = decode(data);
    } catch {
      // Une trame illisible ferme cette socket-la, jamais le salon : un client
      // buggue ne doit pas pouvoir couper la partie des autres.
      ws.close(CLOSE_BAD_FRAME, 'trame illisible');
      return;
    }
    if (msg.type === MSG.INPUT) {
      this.room.applyInput(id, msg.seq, msg.moveX, msg.moveY, msg.aimX, msg.aimY);
      return;
    }
    if (msg.type === MSG.DRAFT_TOKEN) {
      // Le serveur arbitre : un geste refuse n'est simplement pas enregistre,
      // et le client le verra a la prochaine diffusion des intentions. Aucun
      // client ne decide de quoi que ce soit ici (§7.2).
      this.room.setDraftToken(id, msg.cardIndex);
      return;
    }
    if (msg.type === MSG.VOTE) {
      // Meme discipline que le jeton : le client PROPOSE, le salon arbitre. Un
      // vote refuse — portail ferme, choix inconnu — n'est simplement pas
      // enregistre, et le client le verra a la prochaine diffusion des votes.
      this.room.setVote(id, msg.choice);
    }
  }

  /**
   * Diffuse `buf` a chaque client ouvert, et compte les octets reellement
   * pousses sur le fil — `#wireBytes` ne doit compter que ce qui part
   * vraiment, jamais ce qui est simplement encode.
   */
  #send(buf: ArrayBuffer): void {
    for (const ws of this.#clients.values()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buf);
        this.#wireBytes += buf.byteLength;
      }
    }
  }

  #broadcast(): void {
    // Les ordres de vague, les morts, les ramassages, les montees de niveau
    // et la fin de run partent tous avant le snapshot DU MEME TICK : un
    // client doit connaitre l'evenement avant de voir l'etat qui en decoule
    // (§3.1 / §6.1 / §6.2 de la spec).
    for (const order of this.room.drainWaveOrders()) {
      this.#send(encodeWaveOrder(order));
    }
    for (const batch of this.room.drainDeaths()) {
      this.#send(encodeDeaths(batch.tick, batch.ids));
    }
    for (const zone of this.room.drainZones()) {
      this.#send(encodeZone(zone.element, zone.x, zone.y, zone.bornTick, zone.by));
    }
    // Une seule fois par charge, et rien ensuite : la progression du boss le
    // long de son couloir se DERIVE des ticks que ce message porte (§4 de la
    // spec). Avant le snapshot du meme tick, comme tout evenement : un client
    // doit connaitre la charge avant de voir la position qui en decoule.
    for (const charge of this.room.drainBossCharges()) {
      this.#send(encodeBossCharge(charge));
    }
    // Apres les morts : le flash annonce ce que le lot DEATHS du meme tick a
    // deja emporte. `pair` est deja canonicalise par `packElementPair` cote
    // salon — deux clients doivent dessiner le meme flash pour Braise+Givre et
    // pour Givre+Braise.
    for (const reaction of this.room.drainReactions()) {
      this.#send(
        encodeReaction(
          reaction.pair,
          reaction.x,
          reaction.y,
          reaction.tick,
          reaction.synergyCharge,
        ),
      );
    }
    for (const batch of this.room.drainPickups()) {
      this.#send(encodePickups(batch.tick, batch.ids));
    }
    for (const levelUp of this.room.drainLevelUps()) {
      this.#send(encodeLevelUp(levelUp.tick, levelUp.level));
    }
    const runOver = this.room.drainRunOver();
    if (runOver) {
      this.#send(encodeRunOver(runOver.tick, runOver.survivedTicks, runOver.level, runOver.kills));
    }

    for (const open of this.room.drainDraftOpens()) {
      this.#send(encodeDraftOpen(open.deadlineTick, open.cards));
    }
    const intents = this.room.draftIntents();
    if (intents.size > 0) {
      this.#send(
        encodeDraftIntents([...intents].map(([playerId, cardIndex]) => ({ playerId, cardIndex }))),
      );
    }
    for (const res of this.room.drainDraftResults()) {
      this.#send(encodeDraftResult(res.deadlineTick, res.outcomes));
    }

    // Le portail, dans le meme ordre que le draft : l'ouverture, les votes en
    // continu, puis le verdict — et tout cela AVANT le snapshot du meme tick.
    //
    // ⚠️ **Rien de tout ceci n'annonce un gel**, a la difference de
    // `DRAFT_OPEN` : le monde continue de tourner pendant le vote (§6 de la
    // spec de l'etape 6a). Le snapshot qui suit, ce tick-ci et les six cents
    // suivants, montre une horde qui avance.
    for (const deadlineTick of this.room.drainPortalOpens()) {
      this.#send(encodePortalOpen(deadlineTick));
    }
    const votes = this.room.portalVotes();
    if (votes.size > 0) {
      // ⚠️ **La visibilite EST la mecanique** (§6, et §7.2 de l'etape 4 pour
      // les jetons) : on ne negocie pas un choix qu'on ne voit pas. Les
      // silencieux en font partie — `NO_VOTE` circule ici pour qu'on voie qui
      // n'a pas encore tranche.
      this.#send(encodeVotes([...votes].map(([playerId, choice]) => ({ playerId, choice }))));
    }
    for (const res of this.room.drainPortalResults()) {
      this.#send(encodePortalResult(res.effectTick, res.decision, res.gold));
    }

    this.#outbox.buffers.length = 0;
    this.room.snapshot(this.#outbox);
    for (const buf of this.#outbox.buffers) {
      this.#send(buf);
    }
  }

  /** Le plus petit identifiant libre : les places se reutilisent. */
  #freeId(): number | null {
    for (let id = 1; id <= MAX_PLAYERS; id++) {
      if (!this.#clients.has(id)) {
        return id;
      }
    }
    return null;
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Le registre de salons est **decore sur l'instance Fastify**, pas seulement
 * referme dans les routes.
 *
 * ⚠️ C'est ce qui rend testable ce qui passe par la vraie socket. Le livrable
 * du §13 (quatre clients headless) doit poser ses monstres lui-meme plutot
 * que d'attendre le generateur de vagues — premiere vague au tick 180, de
 * taille variable : lent ET intermittent. Sans acces au `Room`, un test qui
 * n'a que des sockets n'a aucun moyen de le faire, et deux lignes de
 * `Session` (la diffusion de `DRAFT_OPEN`, la reception de `DRAFT_TOKEN`)
 * restaient sans aucune couverture — verifie par mutation.
 *
 * Fastify decore d'ordinaire pour ce motif exact ; les routes ci-dessous
 * continuent de refermer `registry`.
 */
declare module 'fastify' {
  interface FastifyInstance {
    rooms: RoomRegistry;
  }
}

export interface ServerOptions {
  /**
   * Graine imposee a TOUS les salons crees par ce serveur. Absente en
   * production : `Room` en tire une au hasard. Voir `RoomRegistry.create`.
   */
  roomSeed?: number;
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: process.env.CORS_ORIGIN ?? true });

  const registry = new RoomRegistry();
  app.decorate('rooms', registry);
  const sessions = new Map<string, Session>();

  const closeSession = (code: string): void => {
    sessions.get(code)?.stop();
    sessions.delete(code);
    registry.delete(code);
  };

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/rooms', async (_req, reply) => {
    const { code, room } = registry.create(options.roomSeed);
    sessions.set(code, new Session(code, room, closeSession));
    return reply.code(201).send({ code });
  });

  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const code = (url.searchParams.get('room') ?? '').toUpperCase();

    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = sessions.get(code);
      if (!session) {
        ws.close(CLOSE_UNKNOWN_ROOM, 'salon inconnu');
        return;
      }
      if (session.add(ws) === null) {
        ws.close(CLOSE_ROOM_FULL, 'salon plein');
      }
    });
  });

  // §4.6 : la metrique qui a plafonne Riot n'est ni le CPU ni la RAM, c'est
  // l'overhead reseau. Elle existe des la premiere version, sinon elle
  // n'existera jamais.
  //
  // Debrayable par TARNOK_METRICS=off : les bancs de l'etape 1 montent
  // cinquante salons, et cinquante lignes de tableau toutes les cinq secondes
  // noieraient le resultat qu'on cherche a lire.
  const metricsEnabled = process.env.TARNOK_METRICS !== 'off';
  const metricsTimer = setInterval(() => {
    if (!metricsEnabled) {
      return;
    }
    const rows = [...sessions.values()]
      .filter((s) => s.playerCount > 0)
      .map((s) => s.drainMetrics());
    if (rows.length > 0) {
      console.table(rows);
    }
  }, METRICS_PERIOD_MS);
  metricsTimer.unref();

  app.addHook('onClose', async () => {
    clearInterval(metricsTimer);
    for (const session of sessions.values()) {
      session.stop();
    }
    sessions.clear();
    wss.close();
  });

  return app;
}

async function start(): Promise<void> {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });
  console.log(`tarnok back a l'ecoute sur http://${host}:${port}`);
}

const entry = process.argv[1];
if (entry && pathToFileURL(entry).href === import.meta.url) {
  await start();
}
