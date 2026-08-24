import { MAP_SIZE, MAX_PLAYERS, PLAYER_SPEED } from '@shared/constants';
import { encodeSnapshot, type PlayerSnapshot } from '@shared/protocol';

/**
 * Le salon ne connait pas le reseau.
 *
 * Il recoit des entrees, avance d'un pas fixe, et ecrit ses sorties dans une
 * outbox que l'appelant vide. C'est ce qui rendra le passage en `worker_threads`
 * (un salon par worker, §3 de la spec) mecanique au lieu d'etre une reecriture —
 * et c'est verifie par une regle Biome sur ce fichier, pas seulement par la
 * discipline.
 */
export interface Outbox {
  push(msg: ArrayBuffer): void;
}

export interface PlayerState {
  id: number;
  x: number;
  y: number;
  /** Axe de deplacement normalise, dans [-1, 1]. */
  moveX: number;
  moveY: number;
  /** Derniere sequence d'entree appliquee, sur 16 bits. */
  lastSeq: number;
}

export interface RoomMetrics {
  /** Octets pousses dans l'outbox depuis le dernier drainage. */
  bytesSent: number;
  /** Micro-secondes passees a encoder depuis le dernier drainage. */
  encodeMicros: number;
  /** Nombre de snapshots encodes depuis le dernier drainage. */
  snapshots: number;
}

/**
 * Positions de depart, autour du centre de la carte. Distinctes pour que quatre
 * joueurs ne se superposent pas a la connexion.
 */
const SPAWN_OFFSETS: readonly (readonly [number, number])[] = [
  [-120, -120],
  [120, -120],
  [-120, 120],
  [120, 120],
];

/** Un axe d'entree tient sur un octet signe : on le ramene dans [-1, 1]. */
const AXIS_SCALE = 1 / 127;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Compare deux sequences sur 16 bits en tenant compte du rebouclage.
 *
 * Une comparaison naive `a > b` rejetterait toutes les entrees pendant un demi
 * tour de compteur des que `seq` repasse par zero — soit toutes les 36 minutes a
 * 30 Hz. Le cout de s'en occuper maintenant est de trois lignes.
 */
function isNewer(a: number, b: number): boolean {
  return a !== b && ((a - b) & 0xffff) < 0x8000;
}

export class Room {
  /**
   * Graine de la carte d'obstacles, tiree a la creation du salon.
   *
   * PROVISOIRE : cette ligne n'existe que pour que le protocole compile des la
   * tache 5. La tache 9 la remplace par une initialisation dans le
   * constructeur — ne pas ajouter une seconde declaration a ce moment-la.
   */
  readonly mapSeed: number = (Math.random() * 0xffff_ffff) >>> 0;
  readonly #players = new Map<number, PlayerState>();
  #tick = 0;
  #metrics: RoomMetrics = { bytesSent: 0, encodeMicros: 0, snapshots: 0 };
  /** Reutilise d'un snapshot a l'autre : pas d'allocation par tick. */
  readonly #scratch: PlayerSnapshot[] = [];

  get tick(): number {
    return this.#tick;
  }

  get playerCount(): number {
    return this.#players.size;
  }

  get metrics(): Readonly<RoomMetrics> {
    return this.#metrics;
  }

  /** Rend false si le salon est plein. */
  join(id: number): boolean {
    if (this.#players.has(id)) {
      return true;
    }
    if (this.#players.size >= MAX_PLAYERS) {
      return false;
    }
    const offset = SPAWN_OFFSETS[this.#players.size] ?? [0, 0];
    this.#players.set(id, {
      id,
      x: MAP_SIZE / 2 + offset[0],
      y: MAP_SIZE / 2 + offset[1],
      moveX: 0,
      moveY: 0,
      lastSeq: 0,
    });
    return true;
  }

  leave(id: number): void {
    this.#players.delete(id);
  }

  /**
   * Une entree d'un joueur absent est ignoree sans bruit : a la deconnexion, des
   * trames peuvent encore arriver apres le `leave`, et ce n'est pas une erreur.
   */
  applyInput(id: number, seq: number, moveX: number, moveY: number): void {
    const p = this.#players.get(id);
    if (!p || !isNewer(seq, p.lastSeq)) {
      return;
    }
    p.lastSeq = seq;

    let nx = clamp(moveX, -127, 127) * AXIS_SCALE;
    let ny = clamp(moveY, -127, 127) * AXIS_SCALE;
    // On normalise au-dela du cercle unite, jamais en deca : sans ca on avance
    // 41 % plus vite en diagonale, ce qui se sent immediatement a la manette.
    const len = Math.hypot(nx, ny);
    if (len > 1) {
      nx /= len;
      ny /= len;
    }
    p.moveX = nx;
    p.moveY = ny;
  }

  /** Un pas de simulation. dt est fixe : 1 / TICK_HZ. */
  step(dt: number): void {
    this.#tick++;
    for (const p of this.#players.values()) {
      p.x = clamp(p.x + p.moveX * PLAYER_SPEED * dt, 0, MAP_SIZE);
      p.y = clamp(p.y + p.moveY * PLAYER_SPEED * dt, 0, MAP_SIZE);
    }
  }

  snapshot(out: Outbox): void {
    this.#scratch.length = 0;
    for (const p of this.#players.values()) {
      this.#scratch.push({ id: p.id, x: p.x, y: p.y });
    }

    const started = performance.now();
    const buf = encodeSnapshot(this.#tick, this.#scratch);
    this.#metrics.encodeMicros += (performance.now() - started) * 1000;
    this.#metrics.bytesSent += buf.byteLength;
    this.#metrics.snapshots++;

    out.push(buf);
  }

  /** Rend les compteurs accumules et les remet a zero. */
  drainMetrics(): RoomMetrics {
    const drained = this.#metrics;
    this.#metrics = { bytesSent: 0, encodeMicros: 0, snapshots: 0 };
    return drained;
  }
}
