// Etape 17b : le banc salon ↔ client. Un VRAI `Room` branche sur un VRAI
// `GameClient` par une fausse socket qui reproduit l'ordre des messages de
// `Session#broadcast` (back/src/server.ts), avec une latence de N ticks.
//
// ⚠️ **Le seul test du front qui importe `back/src/room`** (decision de Leo,
// spec 17b §3) : `Room` est sans E/S ni base (`back/src/room.ts`), et c'est le
// seul moyen de comparer le client a l'ordre REEL de `Room#step` plutot qu'a
// une reference qui recopierait celui du client.
import { archetypeIdOf, NECRO_CHILD, SPLIT_CHILD } from '@shared/archetypes';
import { FLOWFIELD_HZ, MAX_ENTITIES, MAX_PER_WAVE, TICK_HZ } from '@shared/constants';
import { Horde } from '@shared/horde';
import {
  decode,
  encodeAbilityUsed,
  encodeBossCharge,
  encodeDeaths,
  encodeDraftIntents,
  encodeDraftOpen,
  encodeDraftResult,
  encodeEvent,
  encodeLevelUp,
  encodePickups,
  encodePortalOpen,
  encodePortalResult,
  encodePresence,
  encodeReaction,
  encodeResync,
  encodeRunOver,
  encodeVotes,
  encodeWaveOrder,
  encodeWelcome,
  encodeZone,
  MSG,
  VOTE_CHOICE,
} from '@shared/protocol';
import type { WaveOrder } from '@shared/waves';
import { beforeEach, expect, it, vi } from 'vitest';

import { Room } from '../../../back/src/room';
import { GameClient } from './client';

type FakeEvent = { data?: ArrayBuffer; code?: number };

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readonly #listeners = new Map<string, ((e: FakeEvent) => void)[]>();
  binaryType = '';
  readyState = 0;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (e: FakeEvent) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), cb]);
  }
  send(): void {
    // Le banc n'ecoute pas les entrees du client : le salon recoit les siennes.
  }
  close(): void {
    // Rien a fermer.
  }
  emit(type: string, e: FakeEvent): void {
    if (type === 'open') {
      this.readyState = FakeSocket.OPEN;
    }
    for (const cb of this.#listeners.get(type) ?? []) {
      cb(e);
    }
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

const STEP = 1 / TICK_HZ;
const STEPS_PER_FIELD = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
const CHILD_ARCHETYPES = new Set([archetypeIdOf(SPLIT_CHILD), archetypeIdOf(NECRO_CHILD)]);

/**
 * Les messages d'un tick, dans l'ordre EXACT de `Session#broadcast`
 * (back/src/server.ts) : a recopier si `#broadcast` change. `resync` : la
 * socket du client attend son `RESYNC` (etape 18 : apres tous les drains,
 * avant le snapshot du meme tick).
 */
function drainLikeServer(room: Room, orders: WaveOrder[], resync: boolean): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const o of room.drainWaveOrders()) {
    orders.push(o);
    out.push(encodeWaveOrder(o));
  }
  for (const b of room.drainDeaths()) {
    out.push(encodeDeaths(b.tick, b.ids));
  }
  for (const u of room.drainAbilities()) {
    out.push(encodeAbilityUsed(u.tick, u.playerId, u.verb, u.x, u.y, u.targetId));
  }
  for (const z of room.drainZones()) {
    out.push(encodeZone(z.kind, z.x, z.y, z.bornTick, z.by));
  }
  for (const c of room.drainBossCharges()) {
    out.push(encodeBossCharge(c));
  }
  for (const r of room.drainReactions()) {
    out.push(encodeReaction(r.pair, r.x, r.y, r.tick, r.synergyCharge));
  }
  for (const b of room.drainPickups()) {
    out.push(encodePickups(b.tick, b.ids));
  }
  for (const ev of room.drainEvents()) {
    out.push(encodeEvent(ev));
  }
  for (const l of room.drainLevelUps()) {
    out.push(encodeLevelUp(l.tick, l.level));
  }
  for (const o of room.drainDraftOpens()) {
    out.push(encodeDraftOpen(o.deadlineTick, o.cards));
  }
  const intents = room.draftIntents();
  if (intents.size > 0) {
    out.push(
      encodeDraftIntents([...intents].map(([playerId, cardIndex]) => ({ playerId, cardIndex }))),
    );
  }
  for (const r of room.drainDraftResults()) {
    out.push(encodeDraftResult(r.deadlineTick, r.outcomes));
  }
  for (const o of room.drainPortalOpens()) {
    out.push(encodePortalOpen(o.deadlineTick, o.multiplier));
  }
  const votes = room.portalVotes();
  if (votes.size > 0) {
    out.push(encodeVotes([...votes].map(([playerId, choice]) => ({ playerId, choice }))));
  }
  for (const r of room.drainPortalResults()) {
    out.push(encodePortalResult(r.effectTick, r.decision, r.gold));
  }
  const fin = room.drainRunOver();
  if (fin) {
    out.push(encodeRunOver(fin.tick, fin.survivedTicks, fin.level, fin.kills));
  }
  if (resync) {
    out.push(encodeResync(room.resyncState()));
  }
  room.snapshot({ push: (m) => out.push(m) });
  return out;
}

interface Etat {
  ids: number[];
  x: number[];
  y: number[];
}

function etatDe(horde: Horde): Etat {
  const etat: Etat = { ids: [], x: [], y: [] };
  for (let i = 0; i < horde.count; i++) {
    etat.ids.push(horde.entityIdAt(i));
    etat.x.push(horde.x[i] ?? 0);
    etat.y.push(horde.y[i] ?? 0);
  }
  return etat;
}

interface Banc {
  /** Ecart regle maximal, par identite, en pixels. */
  drift: number;
  /** Identites absentes du client ou en trop, cumulees sur toute la partie. */
  lost: Set<number>;
  orders: WaveOrder[];
  deaths: number;
  stalls: number;
  frozenSeen: boolean;
  portalStay: boolean;
  /**
   * Fix 1, point 1 : nombre de fois ou la comparaison reglee a VRAIMENT
   * tourne (anneau et reference presents). Une mesure manquante sautait la
   * comparaison en silence (`continue`) ; un scenario a 0 mesure passerait
   * sans rien avoir compare. Voir `exigeMesures`.
   */
  measured: number;
}

interface Options {
  mapSeed: number;
  players: number[];
  ticks: number;
  latency: number;
  aim: boolean;
  level?: number;
  classes?: Record<number, number>;
  /**
   * Avant chaque `room.step` (tick a venir : `room.tick + 1`). `send` : un
   * message envoye HORS diffusion (`PRESENCE`, etape 18), qui part avant
   * celle du tick a venir.
   */
  before?: (
    room: Room,
    nextTick: number,
    players: number[],
    send: (m: ArrayBuffer) => void,
  ) => void;
  /**
   * Etape 18 : la page du client se recharge et rejoint juste avant ce tick —
   * un client NEUF, `WELCOME` puis le `RESYNC` de la diffusion de ce tick.
   * Latence 0 seulement.
   */
  resyncAt?: number;
  /** Vrai : la diffusion de ce tick part avec celle du suivant (hoquet d'une image). */
  stall?: (tick: number, msgs: ArrayBuffer[]) => boolean;
  /**
   * Fix 1, point 2 : rattrapage du serveur (back/src/server.ts l.139-158,
   * `MAX_CATCH_UP_STEPS` pas de `Room#step` par callback, l'accumulateur de
   * diffusion plafonne a 1 pas). Toutes les `every` images, `k` pas de
   * `Room#step` partagent UN SEUL cycle de diffusion — meme drain-tout que
   * `#broadcast` (tous les lots accumules, un seul snapshot, celui du
   * DERNIER tick). `k` doit tenir dans les 5 pas de rattrapage de
   * `GameClient#update` (`front/src/net/client.ts`).
   */
  catchUp?: { every: number; k: number };
}

/**
 * Fait tourner le salon et le client ensemble, une image par tick (ou par
 * groupe de `catchUp.k` tics, fix 1 point 2). L'ecart se mesure « regle » :
 * au tick `room.tick − latency`, tout ce que le salon a diffuse pour ce tick
 * est arrive, et l'anneau du client (`hordeAt`) doit egaler l'etat que le
 * salon avait a la fin de ce tick, entite par entite.
 *
 * Une entite que le salon porte deja mais dont l'ordre est date du tick
 * SUIVANT (les petits, `spawnTick = T + 1`, inseres a la fin de `T`,
 * `#afterDeaths`/`#spawnAt`, back/src/room.ts ~l.2842-2884) n'est pas encore
 * nee pour le client : elle ne compte pas comme manquante tant que le client
 * ne la tient pas encore. Si le client la tient DEJA (fix 1 point 3, corrige
 * au round 2 : a latence nulle, le client peut suivre exactement le meme
 * "insere en fin de T" que le salon), les deux cotes sont d'accord : c'est
 * une naissance ordinaire, comptee et mesuree comme les autres.
 */
function banc(opts: Options): Banc {
  const players = [...opts.players];
  const room = new Room(opts.mapSeed);
  for (const id of players) {
    room.join(id, undefined, undefined, opts.classes?.[id]);
  }
  if (opts.level) {
    room.debugSetLevel(opts.level);
  }
  const brancher = (welcomeTick: number): { client: GameClient; socket: FakeSocket } => {
    const c = new GameClient('ws://banc', () => ({ x: 0, y: 0 }), vi.fn());
    c.connect();
    const s = FakeSocket.instances[FakeSocket.instances.length - 1] as FakeSocket;
    s.emit('open', {});
    s.emit('message', { data: encodeWelcome(players[0] ?? 1, welcomeTick, room.mapSeed) });
    return { client: c, socket: s };
  };
  // Le client simule le tick 1 juste apres le salon : a latence nulle, chaque
  // message arrive avant que le client simule son tick.
  let { client, socket } = brancher(1);

  const out: Banc = {
    drift: 0,
    lost: new Set(),
    orders: [],
    deaths: 0,
    stalls: 0,
    frozenSeen: false,
    portalStay: false,
    measured: 0,
  };
  const spawnTickOf = new Map<number, number>();
  const queue: { at: number; data: ArrayBuffer }[] = [];
  const past = new Map<number, Etat>();
  const scratch = new Horde(MAX_ENTITIES);
  let seq = 1;
  while (room.tick < opts.ticks) {
    // Rattrapage du serveur (fix 1, point 2) : un groupe de `steps` pas
    // partage UN SEUL cycle de diffusion plus bas, comme `#broadcast`.
    const voulu = opts.catchUp && (room.tick + 1) % opts.catchUp.every === 0 ? opts.catchUp.k : 1;
    const steps = Math.min(voulu, opts.ticks - room.tick);
    const horsDiffusion: ArrayBuffer[] = [];
    let resync = false;
    for (let s = 0; s < steps; s++) {
      const next = room.tick + 1;
      let k = 0;
      for (const id of players.filter((i) => room.positionOf(i))) {
        const a = next * 0.01 + k++ * 2;
        const mx = Math.round(Math.cos(a) * 127);
        const my = Math.round(Math.sin(a) * 127);
        room.applyInput(id, seq, mx, my, opts.aim ? mx : 0, opts.aim ? my : 0);
        // Personne ne meurt : le banc mesure la horde, pas la survie.
        room.debugSetHp(id, room.maxHpOf(id));
      }
      seq++;
      if (next === opts.resyncAt) {
        ({ client, socket } = brancher(room.tick));
      }
      opts.before?.(room, next, players, (m) => horsDiffusion.push(m));
      room.step(STEP);
      resync ||= room.tick === opts.resyncAt;
      past.set(room.tick, etatDe(room.horde));
      past.delete(room.tick - 12);
    }
    const msgs = [...horsDiffusion, ...drainLikeServer(room, out.orders, resync)];
    for (const o of out.orders) {
      spawnTickOf.set(o.waveId, o.spawnTick);
    }
    for (const m of msgs) {
      const d = decode(m);
      if (d.type === MSG.DEATHS) {
        out.deaths += d.ids.length;
      }
      if (d.type === MSG.PORTAL_RESULT && d.decision === VOTE_CHOICE.STAY) {
        out.portalStay = true;
      }
    }
    const stall = opts.stall?.(room.tick, msgs) ?? false;
    if (stall) {
      out.stalls++;
    }
    for (const data of msgs) {
      queue.push({ at: room.tick + opts.latency + (stall ? 1 : 0), data });
    }
    // Tri stable : a date egale, l'ordre d'emission.
    queue.sort((a, b) => a.at - b.at);
    while ((queue[0]?.at ?? Number.POSITIVE_INFINITY) <= room.tick) {
      socket.emit('message', { data: queue.shift()?.data });
    }
    // Le `RESYNC` de `T` pose la horde de `T` : pas de pas client cette image.
    if (!resync) {
      client.update(room.tick * STEP * 1000, steps * STEP);
    }
    expect(client.hordeTick - 1).toBe(room.tick);
    out.frozenSeen ||= client.isFrozen;

    const t = room.tick - opts.latency - (stall ? 1 : 0);
    const ref = past.get(t);
    if (!ref || !client.hordeAt(t, scratch)) {
      continue;
    }
    out.measured++;
    const slots = new Map<number, number>();
    for (let i = 0; i < scratch.count; i++) {
      slots.set(scratch.entityIdAt(i), i);
    }
    const attendus = new Set<number>();
    ref.ids.forEach((id, i) => {
      const enAvance = (spawnTickOf.get(Math.floor(id / MAX_PER_WAVE)) ?? 0) > t;
      const j = slots.get(id);
      if (enAvance && j === undefined) {
        // Le salon la porte deja (inseree en fin de `T`) mais le client ne
        // la tient pas encore : excusee, pas encore nee cote client.
        return;
      }
      // Soit une naissance ordinaire, soit une naissance en avance que le
      // client tient DEJA (fix 1 point 3, corrige au round 2) : les deux
      // cotes sont d'accord, comptee et mesuree normalement.
      attendus.add(id);
      if (j === undefined) {
        out.lost.add(id);
        return;
      }
      const d = Math.hypot(
        (ref.x[i] ?? 0) - (scratch.x[j] ?? 0),
        (ref.y[i] ?? 0) - (scratch.y[j] ?? 0),
      );
      out.drift = Math.max(out.drift, d);
    });
    // En trop : ni attendue, ni au salon.
    const auSalon = new Set(ref.ids);
    for (const id of slots.keys()) {
      if (!attendus.has(id) && !auSalon.has(id)) {
        out.lost.add(id);
      }
    }
  }
  return out;
}

/**
 * Fix 1, point 1 : une mesure manquante ne doit jamais se taire. Plancher
 * justifie : `ticks − latency − 1` tics tentent la comparaison (les tout
 * premiers, `t ≤ 0`, ne la tentent jamais) ; un hoquet decale `t` d'un cran
 * de plus pour son image (`r.stalls`) ; un rattrapage du serveur ne tente
 * la comparaison qu'UNE fois par groupe de `k` tics au lieu de `k` (fix 1,
 * point 2) — `k − 1` tentatives perdues par groupe declenche.
 */
function exigeMesures(r: Banc, opts: Options): void {
  const groupes = opts.catchUp ? Math.floor(opts.ticks / opts.catchUp.every) : 0;
  const perduAuRattrapage = opts.catchUp ? groupes * (opts.catchUp.k - 1) : 0;
  const plancher = opts.ticks - opts.latency - 1 - r.stalls - perduAuRattrapage;
  expect(r.measured).toBeGreaterThanOrEqual(plancher);
}

function rapport(nom: string, r: Banc): void {
  process.stdout.write(
    `[etape 17b] ${nom} : ecart regle ${r.drift.toFixed(3)} px, ${r.lost.size} perdues, ` +
      `${r.orders.length} ordres, ${r.deaths} morts, ${r.stalls} hoquets, ${r.measured} mesures\n`,
  );
}

const LATENCE =
  'latence %i : 1 200 ticks de vagues, de morts, de diviseurs et de necromanciens — 0,000 px, 0 perte';

function latence(latency: number): void {
  const opts: Options = {
    mapSeed: 0xd1a6_0005,
    players: [1, 2],
    ticks: 1200,
    latency,
    aim: true,
    level: 6,
  };
  const r = banc(opts);
  rapport(`latence ${latency}`, r);
  // Ce que le scenario doit contenir, sans quoi « 0,000 px » ne dirait rien.
  const directeur = r.orders.filter((o) => !CHILD_ARCHETYPES.has(o.archetype));
  expect(directeur.filter((o) => o.spawnTick % STEPS_PER_FIELD === 0).length).toBeGreaterThan(3);
  expect(r.orders.some((o) => o.archetype === archetypeIdOf(SPLIT_CHILD))).toBe(true);
  expect(r.orders.some((o) => o.archetype === archetypeIdOf(NECRO_CHILD))).toBe(true);
  expect(r.deaths).toBeGreaterThan(0);
  exigeMesures(r, opts);
  expect(r.drift).toBeLessThan(0.0005);
  expect(r.lost.size).toBe(0);
}

it.each([0, 1, 2, 3])(LATENCE, latence);

it('hoquet d une image sur les ticks qui emettent des petits — 0,000 px, 0 perte', () => {
  const opts: Options = {
    mapSeed: 0xd1a6_0002,
    players: [1, 2],
    ticks: 1500,
    latency: 0,
    aim: true,
    level: 6,
    // Un tick qui emet un petit (`spawnTick = T + 1`) sans vague du directeur :
    // snapshot, morts et ordre partent une image en retard.
    stall: (tick, msgs) => {
      const ordres = msgs.map((m) => decode(m)).filter((m) => m.type === MSG.WAVE_ORDER);
      return (
        ordres.some((o) => CHILD_ARCHETYPES.has(o.archetype) && o.spawnTick === tick + 1) &&
        !ordres.some((o) => o.spawnTick === tick)
      );
    },
  };
  const r = banc(opts);
  rapport('hoquet', r);
  expect(r.stalls).toBeGreaterThan(0);
  exigeMesures(r, opts);
  expect(r.drift).toBeLessThan(0.0005);
  expect(r.lost.size).toBe(0);
});

it.each([
  'depart',
  'arrivee',
  'leurre',
  'absence',
  'resync',
] as const)('gel d etalage avec un(e) %s — 0,000 px, 0 perte', (mode) => {
  let leurre = false;
  const opts: Options = {
    mapSeed: 0xd1a6_0007,
    players: [1, 2],
    ticks: 1400,
    latency: 0,
    aim: false,
    // La classe 2 (Appat) pose un leurre.
    classes: { 1: 2 },
    // Etape 18 : `absence`, le joueur 2 tombe pendant le gel et reste en grace
    // (`PRESENCE` hors diffusion) ; `resync`, idem, puis la page du client se
    // recharge pendant le gel et repart de l'etat complet (absents et
    // historique compris).
    resyncAt: mode === 'resync' ? 450 : undefined,
    before: (room, next, players, send) => {
      if (next === 400 && mode === 'leurre') {
        const p = room.positionOf(1);
        leurre = !!p && room.useAbility(1, p.x + 300, p.y) !== null;
      }
      if (next === 401) {
        room.debugOweLevels(1);
      }
      if (next === 450 && mode === 'depart') {
        room.leave(2);
      }
      if (next === 450 && mode === 'arrivee') {
        room.join(3);
        players.push(3);
      }
      if ((next === 450 && mode === 'absence') || (next === 430 && mode === 'resync')) {
        room.setAbsent(2, true);
        send(encodePresence(2, false));
      }
    },
  };
  const r = banc(opts);
  rapport(`gel d etalage, ${mode}`, r);
  expect(r.frozenSeen).toBe(true);
  if (mode === 'leurre') {
    expect(leurre).toBe(true);
  }
  exigeMesures(r, opts);
  expect(r.drift).toBeLessThan(0.0005);
  expect(r.lost.size).toBe(0);
});

const PORTAIL = 'portail traverse, « rester », latence %i — 0,000 px, 0 perte';

function portail(latency: number): void {
  const opts: Options = {
    mapSeed: 4242,
    players: [1, 2],
    ticks: 4200,
    latency,
    // Sans tir : ni niveau ni etalage, le portail tombe a la vingtieme vague.
    aim: false,
    before: (room) => {
      if (room.portalOpen) {
        room.setVote(1, VOTE_CHOICE.STAY);
        room.setVote(2, VOTE_CHOICE.STAY);
      }
    },
  };
  const r = banc(opts);
  rapport(`portail, latence ${latency}`, r);
  expect(r.portalStay).toBe(true);
  exigeMesures(r, opts);
  expect(r.drift).toBeLessThan(0.0005);
  expect(r.lost.size).toBe(0);
}

it.each([0, 2])(PORTAIL, portail);

it.fails('rattrapage du serveur : 3 pas groupes toutes les 50 images, latence 1 — 0,000 px, 0 perte', () => {
  // Fix 1, point 2 : le serveur reel peut faire jusqu'a 5 pas de
  // `Room#step` par callback alors que l'accumulateur de diffusion
  // plafonne a 1 (back/src/server.ts l.139-158) — un seul `#broadcast`
  // draine alors plusieurs tics, entrelaces par type de message, et
  // n'envoie que le DERNIER snapshot. `catchUp` reproduit cet entrelacement
  // avec `drainLikeServer` (meme drain-tout) au lieu d'un par tick.
  const opts: Options = {
    mapSeed: 0xd1a6_0005,
    players: [1, 2],
    ticks: 1200,
    latency: 1,
    aim: true,
    level: 6,
    catchUp: { every: 50, k: 3 },
  };
  const r = banc(opts);
  rapport('rattrapage du serveur', r);
  // Ce que le scenario doit contenir, sans quoi « 0,000 px » ne dirait rien.
  const directeur = r.orders.filter((o) => !CHILD_ARCHETYPES.has(o.archetype));
  expect(directeur.filter((o) => o.spawnTick % STEPS_PER_FIELD === 0).length).toBeGreaterThan(3);
  expect(r.orders.some((o) => o.archetype === archetypeIdOf(SPLIT_CHILD))).toBe(true);
  expect(r.orders.some((o) => o.archetype === archetypeIdOf(NECRO_CHILD))).toBe(true);
  expect(r.deaths).toBeGreaterThan(0);
  exigeMesures(r, opts);
  expect(r.drift).toBeLessThan(0.0005);
  expect(r.lost.size).toBe(0);
});
