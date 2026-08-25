import { STEP2_ARCHETYPES } from '@shared/archetypes';
import { MAX_ENTITIES, TICK_HZ } from '@shared/constants';
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

/**
 * Bornes de la toute premiere vague — voir `waveCountBounds`.
 *
 * ⚠️ **Reglage mesure, tache 14.** L'etape 2 partait directement a
 * `MIN_COUNT..MAX_COUNT` (120 a 320), soit ~37 apparitions/s en moyenne des
 * la premiere vague : le banc `back/bench/_probe.ts` (jete, voir le rapport
 * de la tache) mesurait un joueur passif mort en ~20 s, avant meme d'avoir pu
 * observer une deuxieme vague dans de bonnes conditions. Cible : que la
 * premiere vague reste tenable par un tireur solo pendant que la horde met
 * plusieurs secondes a traverser `ANCHOR_RADIUS` et entrer a portee — voir le
 * rapport pour la mesure apres reglage.
 */
const WAVE1_MIN_COUNT = 16;
const WAVE1_MAX_COUNT = 28;

/**
 * Bornes en regime etabli — inchangees depuis l'etape 2 (120 a 320) : c'est le
 * palier « submerge » vise par le §7.4 de l'orientation, pas une valeur remise
 * en cause par cette tache. Ce qui change, c'est le CHEMIN pour y arriver.
 */
const STEADY_MIN_COUNT = 120;
const STEADY_MAX_COUNT = 320;

/**
 * Nombre de vagues sur lesquelles les bornes interpolent lineairement entre la
 * premiere vague et le regime etabli. A `PERIOD_TICKS` (6 s), 20 vagues font
 * 120 s : assez pour laisser une impression de montee en puissance sensible,
 * pas assez pour que « progressif » se lise comme « jamais ».
 */
const RAMP_WAVES = 20;

/** Distance a laquelle une vague apparait autour d'un joueur. */
const ANCHOR_RADIUS = 1800;

const FORMATION_POOL = [FORMATION.SCATTER, FORMATION.RING, FORMATION.COLUMN, FORMATION.CLUSTER];

/**
 * Bornes `[min, max]` du nombre d'entites d'une vague, en fonction de son
 * NUMERO (1-based) — pure, sans tirage, pour rester testable independamment
 * du hasard : `WaveDirector.due` s'en sert ensuite pour tirer `count` dedans.
 *
 * ⚠️ **Monotone et bornee, pas une formule figee.** `waveNumber` croissant ne
 * peut jamais faire BAISSER les bornes, et elles ne depassent jamais
 * `MAX_ENTITIES` (le plafond dur du salon, §3 de la spec) — c'est cette forme
 * que le test verrouille, pas les valeurs de `WAVE1_*` / `STEADY_*` /
 * `RAMP_WAVES`, qui resteront a retoucher au fil des sessions de jeu.
 */
export function waveCountBounds(waveNumber: number): { min: number; max: number } {
  const t = RAMP_WAVES > 1 ? Math.min(1, Math.max(0, (waveNumber - 1) / (RAMP_WAVES - 1))) : 1;
  const min = Math.round(WAVE1_MIN_COUNT + t * (STEADY_MIN_COUNT - WAVE1_MIN_COUNT));
  const max = Math.round(WAVE1_MAX_COUNT + t * (STEADY_MAX_COUNT - WAVE1_MAX_COUNT));
  return { min: Math.min(min, MAX_ENTITIES), max: Math.min(max, MAX_ENTITIES) };
}

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

    const waveNumber = this.#nextWaveId;
    const { min, max } = waveCountBounds(waveNumber);

    const order: WaveOrder = {
      waveId: this.#nextWaveId++,
      spawnTick: tick,
      seed: (this.#rng() * 0xffff_ffff) >>> 0,
      archetype: STEP2_ARCHETYPES[Math.floor(this.#rng() * STEP2_ARCHETYPES.length)] ?? 0,
      formation: FORMATION_POOL[Math.floor(this.#rng() * FORMATION_POOL.length)] ?? 0,
      anchorX: Math.round((playerX[target] ?? 0) + Math.cos(angle) * radius),
      anchorY: Math.round((playerY[target] ?? 0) + Math.sin(angle) * radius),
      count: Math.round(min + this.#rng() * (max - min)),
    };
    return order;
  }
}
