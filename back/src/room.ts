import {
  FLOWFIELD_CELL,
  FLOWFIELD_HZ,
  MAP_SIZE,
  MAX_ENTITIES,
  MAX_PLAYERS,
  PLAYER_MAX_HP,
  PLAYER_SPEED,
  TICK_HZ,
} from '@shared/constants';
import { FlowField } from '@shared/flowfield';
import { Horde } from '@shared/horde';
import { PlayerHistory } from '@shared/player-history';
import { encodeSnapshot, type PlayerSnapshot } from '@shared/protocol';
import type { WaveOrder } from '@shared/waves';
import { applyObstacles, generateObstacles } from '@shared/worldmap';

import { WaveDirector } from './wave-director';

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
  /**
   * Nombre de vagues tronquees par `Horde.spawn` depuis le dernier drainage —
   * la horde a atteint sa capacite et une partie de la vague n'est jamais
   * apparue. Attendu a l'etape 2 (rien ne meurt encore, §11 de la spec), mais
   * doit rester visible dans le HUD (§4.6) plutot que silencieux : une
   * troncature muette est un piege pour l'etape 3.
   */
  truncatedSpawns: number;
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
  /** Graine de la carte d'obstacles, tiree a la creation du salon. */
  readonly mapSeed: number = (Math.random() * 0xffff_ffff) >>> 0;
  readonly horde = new Horde(MAX_ENTITIES);
  readonly #players = new Map<number, PlayerState>();
  readonly #fields: FlowField[];
  readonly #history = new PlayerHistory();
  readonly #director: WaveDirector;
  #pendingOrders: WaveOrder[] = [];
  #tick = 0;
  /** Tick des positions ayant servi au dernier calcul des champs. Voir `fieldInputTick`. */
  #fieldInputTick = 0;
  #metrics: RoomMetrics = { bytesSent: 0, encodeMicros: 0, snapshots: 0, truncatedSpawns: 0 };
  /** Reutilise d'un snapshot a l'autre : pas d'allocation par tick. */
  readonly #scratch: PlayerSnapshot[] = [];

  constructor() {
    const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    const mask = generateObstacles(this.mapSeed, probe.cols, probe.rows);
    this.#fields = Array.from({ length: MAX_PLAYERS }, () => {
      const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
      applyObstacles(f, mask);
      return f;
    });
    this.#director = new WaveDirector(this.mapSeed ^ 0x5bf0_3a17);
  }

  /** Ordres de vague a diffuser. Le serveur les vide a chaque tick. */
  drainWaveOrders(): WaveOrder[] {
    const orders = this.#pendingOrders;
    this.#pendingOrders = [];
    return orders;
  }

  get tick(): number {
    return this.#tick;
  }

  /**
   * Tick dont proviennent les positions ayant servi au dernier calcul des
   * champs. Doit rester en retard de `FIELD_INPUT_DELAY_TICKS` sur le tick
   * courant : c'est ce retard, que le serveur s'impose a lui-meme, qui rend son
   * champ reproductible par le client.
   */
  get fieldInputTick(): number {
    return this.#fieldInputTick;
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

    // Arrondies, comme sur le fil (constat C1.4) : le client ne connaitra
    // jamais que la version quantifiee en int16 du protocole (`encodeSnapshot`
    // arrondit deja). Si le serveur alimentait son propre flowfield avec des
    // positions flottantes, les deux cotes enracineraient leur BFS dans des
    // cellules differentes une fois par cellule et par axe — le serveur doit
    // s'imposer l'arrondi comme il s'impose deja le retard.
    const xs: number[] = [];
    const ys: number[] = [];
    for (const p of this.#players.values()) {
      xs.push(Math.round(p.x));
      ys.push(Math.round(p.y));
    }
    this.#history.record(this.#tick, xs, ys);

    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    if (this.#tick % stepsPerField === 0) {
      // ⚠️ Les positions **retardees**, pas les courantes. Le serveur s'impose
      // le retard qu'il inflige au client : c'est ce qui rend les deux champs
      // identiques (§5 de la spec de l'etape 2).
      const seen = this.#history.delayed(this.#tick);
      if (seen) {
        this.#fieldInputTick = seen.tick;
        for (let f = 0; f < seen.x.length && f < this.#fields.length; f++) {
          this.#fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
        }
        this.horde.retarget(seen.x, seen.y);
      }
    }

    const order = this.#director.due(this.#tick, xs, ys);
    if (order) {
      const before = this.horde.count;
      this.horde.spawn(order);
      // Rend visible une troncature silencieuse : voir `RoomMetrics.truncatedSpawns`.
      if (this.horde.count - before < order.count) {
        this.#metrics.truncatedSpawns++;
      }
      this.#pendingOrders.push(order);
    }

    this.horde.step(dt, this.#fields);
  }

  snapshot(out: Outbox): void {
    this.#scratch.length = 0;
    for (const p of this.#players.values()) {
      // ⚠️ hp n'existe pas encore cote serveur (tache 9) : on cable le
      // transport avec une valeur fixe plutot que d'inventer une
      // comptabilite de degats ici.
      this.#scratch.push({ id: p.id, x: p.x, y: p.y, hp: PLAYER_MAX_HP });
    }

    // ⚠️ xp n'existe pas non plus (tache 9) : 0 tant que rien ne le fait
    // vivre. C'est un champ d'equipe (§2 de la spec d'orientation), pas un
    // champ par joueur : il vit dans l'en-tete du snapshot, pas dans `#scratch`.
    const started = performance.now();
    const buf = encodeSnapshot(this.#tick, 0, this.#scratch);
    this.#metrics.encodeMicros += (performance.now() - started) * 1000;
    this.#metrics.bytesSent += buf.byteLength;
    this.#metrics.snapshots++;

    out.push(buf);
  }

  /** Rend les compteurs accumules et les remet a zero. */
  drainMetrics(): RoomMetrics {
    const drained = this.#metrics;
    this.#metrics = { bytesSent: 0, encodeMicros: 0, snapshots: 0, truncatedSpawns: 0 };
    return drained;
  }
}
