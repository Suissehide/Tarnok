import { archetypeOf, HEAVY_HP, STEP2_ARCHETYPES } from '@shared/archetypes';
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
 *
 * ⚠️ **Baisse a l'etape 5a (16-28 -> 10-18), decision de l'auteur :** *« on
 * fera moins d'ennemi au debut, le temps d'obtenir des armes. »* La premiere
 * arme arrive au premier draft, donc au premier niveau, donc apres ~10 orbes
 * en solo — et la premiere vague tombe au tick 180 (6 s).
 *
 * ⚠️ **Moins d'ennemis, c'est moins d'orbes, et le seuil de niveau ne bouge
 * pas.** Un debut trop maigre repousserait la premiere arme au lieu de
 * l'avancer — l'inverse exact de l'intention. Le test « un joueur passif
 * atteint le niveau 2 » de `room.test.ts` est la garde ; mesure apres la
 * baisse, la montee reste bien dans son budget de 100 s.
 */
const WAVE1_MIN_COUNT = 10;
const WAVE1_MAX_COUNT = 18;

/**
 * Bornes en regime etabli — inchangees depuis l'etape 2 (120 a 320) : c'est le
 * palier « submerge » vise par le §7.4 de l'orientation, pas une valeur remise
 * en cause par cette tache. Ce qui change, c'est le CHEMIN pour y arriver.
 */
const STEADY_MIN_COUNT = 120;
const STEADY_MAX_COUNT = 320;

/**
 * Nombre de vagues sur lesquelles les bornes interpolent lineairement entre la
 * premiere vague et le regime etabli. A `PERIOD_TICKS` (6 s), 30 vagues font
 * 180 s : assez pour laisser une impression de montee en puissance sensible,
 * pas assez pour que « progressif » se lise comme « jamais ».
 *
 * ⚠️ **Monte de 20 a 30 a l'etape 5a**, meme decision d'auteur que `WAVE1_*`.
 * Les deux leviers ne font pas la meme chose : baisser `WAVE1_*` rend les
 * PREMIERES vagues plus petites, allonger la rampe laisse plus de temps avant
 * le regime etabli. Il faut les deux pour que « le temps d'obtenir des armes »
 * couvre plus qu'une minute.
 *
 * `STEADY_*` n'est PAS touche : c'est ce que les bancs mesurent, et le §4.1 de
 * l'orientation y tient.
 */
const RAMP_WAVES = 30;

/** Distance a laquelle une vague apparait autour d'un joueur. */
const ANCHOR_RADIUS = 1800;

const FORMATION_POOL = [FORMATION.SCATTER, FORMATION.RING, FORMATION.COLUMN, FORMATION.CLUSTER];

/**
 * Les archetypes tirables, separes par reserve de PV (etape 5a).
 *
 * ⚠️ **C'est le levier de difficulte de l'etape 5a, et il vit ICI.** Le §3.3
 * de la spec engage l'issue d'avance : si le rythme de mise a mort chute de
 * plus de 20 %, *« on reequilibre la proportion de lourds dans les vagues,
 * pas les PV, parce que c'est le generateur qui porte la difficulte »*.
 */
const HEAVY_POOL = STEP2_ARCHETYPES.filter((id) => archetypeOf(id).hp === HEAVY_HP);
const LIGHT_POOL = STEP2_ARCHETYPES.filter((id) => archetypeOf(id).hp !== HEAVY_HP);

/**
 * Part des vagues faites de pietaille lourde.
 *
 * ⚠️ **Reglage MESURE, porte du §3.3 — pas une valeur d'intuition.** Le §12 de
 * la spec le dit : *« la proportion de pietaille lourde dans les vagues est le
 * vrai levier de difficulte de cette etape, et elle n'a pas de valeur de
 * depart defendable avant la mesure »*. La voici, au banc
 * `bench/kills.bench.ts` (4 joueurs, 60 s, 12 graines) :
 *
 * | Part de vagues lourdes | Morts/s | Ecart |
 * | --- | --- | --- |
 * | 0 (toute la pietaille legere) | 6,96 | reference — le rythme de l'etape 3 |
 * | 0,08 | 6,77 | -2,7 % |
 * | **0,20 (retenue)** | **6,07** | **-12,8 %** |
 * | 0,25 (= tirage uniforme sur les quatre archetypes) | 5,65 | -18,8 % |
 *
 * 0,25 tient encore dans la bande de ±20 % de la spec, mais a 1,2 point de la
 * borne : trop pres pour une mesure a quelques pour cent de bruit. 0,20 garde
 * une marge, et une vague sur cinq faite de lourds suffit largement a ce que
 * le §3.3 demande — des ennemis qui vivent assez longtemps pour porter une
 * marque elementaire.
 *
 * Une vague entiere est lourde ou legere : l'archetype est un champ de
 * `WaveOrder`, un seul pour toute la vague (§3.1 de l'etape 2). Cette part
 * est donc une part de VAGUES, pas d'entites — a nombre d'entites egal en
 * moyenne, les deux coincident.
 */
const HEAVY_WAVE_SHARE = 0.2;

/**
 * Premiere vague qui PEUT etre lourde. Avant elle, la part de lourds vaut zero.
 *
 * ⚠️ **Trouve par la mesure, pas prevu par le plan.** Avec des vagues lourdes
 * des la premiere, un joueur solo IMMOBILE perdait sa run avant le niveau 2
 * dans 3 essais sur 20 (1 sur 20 des une part de 0,08) : quatre coups de dague
 * par ennemi, la horde s'accumule plus vite qu'elle ne tombe, et le test
 * « un joueur passif atteint le niveau 2 » de `room.test.ts` devenait
 * intermittent a 15 %. *Un test intermittent est pire qu'un test absent : on
 * finit par l'ignorer.*
 *
 * A partir de la vague 6 (36 s), 40 essais sur 40 atteignent le niveau 2,
 * mediane 41,3 s et maximum 50,1 s — contre 36,8 / 44,5 avant cette etape,
 * pour un budget de test de 100 s.
 *
 * C'est la meme intention que `WAVE1_*` et `RAMP_WAVES` : *« moins d'ennemi au
 * debut, le temps d'obtenir des armes »*. Une pietaille lourde est un probleme
 * d'arme, pas un probleme de nombre — la dague seule met treize secondes a
 * nettoyer une vague lourde.
 */
const HEAVY_FIRST_WAVE = 6;

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

/**
 * Tire l'archetype d'une vague : lourde avec la probabilite
 * `HEAVY_WAVE_SHARE`, legere sinon.
 *
 * Deux tirages plutot qu'un, toujours dans le meme ordre : le directeur reste
 * une fonction pure de sa graine, ce que le test de determinisme verifie.
 */
function pickArchetype(rng: () => number, waveNumber: number): number {
  const lourde =
    rng() < HEAVY_WAVE_SHARE && HEAVY_POOL.length > 0 && waveNumber >= HEAVY_FIRST_WAVE;
  const pool = lourde ? HEAVY_POOL : LIGHT_POOL;
  return pool[Math.floor(rng() * pool.length)] ?? 0;
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
      archetype: pickArchetype(this.#rng, waveNumber),
      formation: FORMATION_POOL[Math.floor(this.#rng() * FORMATION_POOL.length)] ?? 0,
      anchorX: Math.round((playerX[target] ?? 0) + Math.cos(angle) * radius),
      anchorY: Math.round((playerY[target] ?? 0) + Math.sin(angle) * radius),
      count: Math.round(min + this.#rng() * (max - min)),
    };
    return order;
  }
}
