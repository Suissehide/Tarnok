import { ROLLBACK_DEPTH_TICKS } from './constants';
import type { Horde, HordeState } from './horde';

/**
 * Anneau d'etats de horde, pour le rejeu du §3.2.
 *
 * Une mort arrive en retard : le tick present a deja avance quand le message
 * traverse le reseau. Comme les entites sont couplees par la separation
 * (tache 1), l'appliquer au present plutot qu'a son tick d'origine deplace
 * des dizaines de voisines et l'ecart ne s'eteint plus — mesure a l'etape 2,
 * l'equivalent croit sans borne jusqu'a 694 px en dix secondes. La parade :
 * revenir au tick de la mort, l'appliquer, rejouer jusqu'au present.
 *
 * `ROLLBACK_DEPTH_TICKS` borne la memoire necessaire : au-dela, une mort est
 * trop vieille pour etre rejouee et doit etre signalee plutot qu'appliquee en
 * silence (voir la doc de la constante).
 *
 * Tous les tampons sont alloues une fois, au constructeur, a la capacite de
 * la `Horde` qu'ils accompagnent — `Horde.capacity` est fixe, donc un etat qui
 * ne l'egalerait pas ne pourrait pas recevoir une copie complete. `record` ne
 * fait ensuite que des `.set()` dans ces tampons : **aucune allocation par
 * tick**, pour la meme raison que `FlowField` pre-alloue sa file et que la
 * grille de voisins de `Horde` (tache 19) pre-alloue son curseur — un
 * ramasse-miettes visible dans les mesures de la tache 0.
 */
export class HordeHistory {
  readonly #ticks: Int32Array;
  readonly #states: HordeState[];

  constructor(capacity: number) {
    this.#ticks = new Int32Array(ROLLBACK_DEPTH_TICKS).fill(-1);
    this.#states = Array.from({ length: ROLLBACK_DEPTH_TICKS }, () => ({
      count: 0,
      x: new Float32Array(capacity),
      y: new Float32Array(capacity),
      vx: new Float32Array(capacity),
      vy: new Float32Array(capacity),
      archetype: new Uint8Array(capacity),
      waveId: new Uint16Array(capacity),
      indexInWave: new Uint16Array(capacity),
      animPhase: new Uint8Array(capacity),
      targetField: new Uint8Array(capacity),
      stopped: new Uint8Array(capacity),
      fleeing: new Uint8Array(capacity),
      aimX: [],
      aimY: [],
      hp: new Float32Array(capacity),
      mark: new Uint8Array(capacity),
      markBy: new Uint8Array(capacity),
      markUntil: new Float64Array(capacity),
    }));
  }

  /** Enregistre l'etat courant de `horde` au tick `tick`, ecrasant le plus vieux si besoin. */
  record(tick: number, horde: Horde): void {
    const state = this.#states[this.#slotOf(tick)];
    if (!state) {
      // Ne peut pas arriver : #states a exactement ROLLBACK_DEPTH_TICKS
      // creneaux et #slotOf rend toujours un indice dans cette plage.
      return;
    }
    this.#ticks[this.#slotOf(tick)] = tick;
    horde.saveState(state);
  }

  /**
   * Restaure `horde` a l'etat enregistre pour `tick`.
   *
   * Rend `false`, sans toucher a `horde`, si ce tick precis n'est pas tenu —
   * trop vieux (hors de `ROLLBACK_DEPTH_TICKS`) ou jamais enregistre.
   */
  restore(tick: number, horde: Horde): boolean {
    const slot = this.#slotOf(tick);
    if (this.#ticks[slot] !== tick) {
      return false;
    }
    const state = this.#states[slot];
    if (!state) {
      return false;
    }
    horde.restoreState(state);
    return true;
  }

  /** Le plus vieux tick actuellement tenu par l'anneau, ou -1 s'il est vide. */
  oldestTick(): number {
    let oldest = -1;
    for (let slot = 0; slot < ROLLBACK_DEPTH_TICKS; slot++) {
      const t = this.#ticks[slot] ?? -1;
      if (t >= 0 && (oldest < 0 || t < oldest)) {
        oldest = t;
      }
    }
    return oldest;
  }

  #slotOf(tick: number): number {
    return ((tick % ROLLBACK_DEPTH_TICKS) + ROLLBACK_DEPTH_TICKS) % ROLLBACK_DEPTH_TICKS;
  }
}
