import { STEP2_ARCHETYPES } from '@shared/archetypes';
import { TICK_HZ } from '@shared/constants';
import { makeRandom } from '@shared/random';
import { FORMATION, type WaveOrder } from '@shared/waves';

/**
 * Decide quand une vague sort, et avec quels parametres.
 *
 * Les vagues sont **pilotees par la donnee, pas par du script** (§9.1 de
 * l'orientation). A l'etape 2, la « donnee » se reduit a des bornes tirees ;
 * l'etape 3 lui donnera de vraies definitions typees.
 *
 * Le directeur ne vit que sur le serveur : c'est lui qui decide, les clients
 * obeissent.
 */

const PERIOD_TICKS = TICK_HZ * 6;
const MIN_COUNT = 120;
const MAX_COUNT = 320;
/** Distance a laquelle une vague apparait autour d'un joueur. */
const ANCHOR_RADIUS = 1800;

const FORMATION_POOL = [FORMATION.SCATTER, FORMATION.RING, FORMATION.COLUMN, FORMATION.CLUSTER];

export class WaveDirector {
  #nextWaveId = 1;
  readonly #rng: () => number;

  constructor(seed: number) {
    this.#rng = makeRandom(seed);
  }

  /** Rend un ordre si une vague est due a ce tick, sinon null. */
  due(tick: number, playerX: readonly number[], playerY: readonly number[]): WaveOrder | null {
    if (tick === 0 || tick % PERIOD_TICKS !== 0 || playerX.length === 0) {
      return null;
    }

    // Ancrage autour d'un joueur : le §8 de l'orientation veut que la densite
    // se calcule par grappe de joueurs proches, pas globalement.
    const target = Math.floor(this.#rng() * playerX.length);
    const angle = this.#rng() * Math.PI * 2;
    const radius = ANCHOR_RADIUS * (0.6 + this.#rng() * 0.4);

    const order: WaveOrder = {
      waveId: this.#nextWaveId++,
      spawnTick: tick,
      seed: (this.#rng() * 0xffff_ffff) >>> 0,
      archetype: STEP2_ARCHETYPES[Math.floor(this.#rng() * STEP2_ARCHETYPES.length)] ?? 0,
      formation: FORMATION_POOL[Math.floor(this.#rng() * FORMATION_POOL.length)] ?? 0,
      anchorX: Math.round((playerX[target] ?? 0) + Math.cos(angle) * radius),
      anchorY: Math.round((playerY[target] ?? 0) + Math.sin(angle) * radius),
      count: Math.round(MIN_COUNT + this.#rng() * (MAX_COUNT - MIN_COUNT)),
    };
    return order;
  }
}
