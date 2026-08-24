import { archetypeOf } from './archetypes';
import { MAP_SIZE, MAX_ENTITIES, MAX_PER_WAVE } from './constants';
import type { FlowField } from './flowfield';
import { formationPositions, type WaveOrder } from './waves';

/**
 * L'identite est **arithmetique**, pas negociee.
 *
 * Aucun aller-retour, aucun octet : deux clients qui recoivent le meme ordre de
 * vague ne *peuvent pas* fabriquer des identifiants differents. C'est ce qui
 * rendra sensé, a l'etape 3, un message « l'entite 4211 est morte » — il n'y a
 * pas de table de correspondance a synchroniser, donc pas de table a
 * desynchroniser.
 */
export function entityIdOf(waveId: number, index: number): number {
  return waveId * MAX_PER_WAVE + index;
}

/**
 * L'etat de la horde, en tableaux typés.
 *
 * Jamais un objet par ennemi (§4.4 de l'orientation) : a 1 500 entites, le cout
 * des indirections et de la pression memoire depasse celui de tout le pas de
 * simulation.
 *
 * Le serveur et chaque client executent ce meme code. Ce qui doit etre
 * identique — l'ensemble des identites, les archetypes — l'est par arithmetique
 * entiere. Les positions, elles, ont le droit de deriver de quelques pixels
 * (§2.2 de la spec).
 *
 * ⚠️ **La capacite doit etre identique sur le serveur et sur chaque client.**
 * `spawn` tronque quand elle est atteinte ; deux simulations qui tronquent a des
 * endroits differents n'ont plus le meme ensemble d'entites, et rien ne le
 * signalerait — ni erreur, ni test rouge, juste des ennemis qui different d'un
 * poste a l'autre. La valeur par defaut du constructeur est la pour que le cas
 * nominal soit correct sans que personne n'ait a y penser.
 */
export class Horde {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly archetype: Uint8Array;
  readonly waveId: Uint16Array;
  readonly indexInWave: Uint16Array;
  /** Decalage du cycle d'animation. Purement cosmetique, hors contrat. */
  readonly animPhase: Uint8Array;
  /** Index du champ suivi : le joueur le plus proche. */
  readonly targetField: Uint8Array;

  #count = 0;

  constructor(readonly capacity: number = MAX_ENTITIES) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.archetype = new Uint8Array(capacity);
    this.waveId = new Uint16Array(capacity);
    this.indexInWave = new Uint16Array(capacity);
    this.animPhase = new Uint8Array(capacity);
    this.targetField = new Uint8Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  entityIdAt(slot: number): number {
    return entityIdOf(this.waveId[slot] ?? 0, this.indexInWave[slot] ?? 0);
  }

  /** Fait apparaitre une vague. Tronque plutot que de deborder. */
  spawn(order: WaveOrder): void {
    const room = this.capacity - this.#count;
    const count = Math.min(order.count, room, MAX_PER_WAVE);
    if (count <= 0) {
      return;
    }

    const px = new Float32Array(count);
    const py = new Float32Array(count);
    formationPositions({ ...order, count }, px, py);

    const frames = archetypeOf(order.archetype).frames;

    for (let i = 0; i < count; i++) {
      const slot = this.#count + i;
      this.x[slot] = px[i] ?? 0;
      this.y[slot] = py[i] ?? 0;
      this.archetype[slot] = order.archetype;
      this.waveId[slot] = order.waveId;
      this.indexInWave[slot] = i;
      // La phase se derive de l'index, pas d'un tirage : elle doit etre la meme
      // partout pour qu'une capture d'ecran de debug soit comparable.
      this.animPhase[slot] = (i * 7 + order.waveId * 3) % frames;
    }

    this.#count += count;
  }

  /**
   * Reaffecte chaque entite au joueur le plus proche.
   *
   * Appele a la cadence du flowfield (10 Hz), pas a chaque tick : changer de
   * cible chaque tick fait vibrer les trajectoires.
   */
  retarget(playerX: readonly number[], playerY: readonly number[]): void {
    for (let i = 0; i < this.#count; i++) {
      const ex = this.x[i] ?? 0;
      const ey = this.y[i] ?? 0;
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let p = 0; p < playerX.length; p++) {
        const dx = (playerX[p] ?? 0) - ex;
        const dy = (playerY[p] ?? 0) - ey;
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      this.targetField[i] = best;
    }
  }

  /** Un pas de simulation. `dt` est fixe : 1 / TICK_HZ. */
  step(dt: number, fields: readonly FlowField[]): void {
    for (let i = 0; i < this.#count; i++) {
      const field = fields[this.targetField[i] ?? 0];
      if (!field) {
        continue;
      }
      const speed = archetypeOf(this.archetype[i] ?? 0).speed * dt;
      const ex = this.x[i] ?? 0;
      const ey = this.y[i] ?? 0;
      const cell = field.indexAt(ex, ey);
      this.x[i] = clamp(ex + (field.dirX[cell] ?? 0) * speed, 0, MAP_SIZE);
      this.y[i] = clamp(ey + (field.dirY[cell] ?? 0) * speed, 0, MAP_SIZE);
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
