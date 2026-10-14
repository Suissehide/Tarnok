import { FIELD_INPUT_DELAY_TICKS, MAX_PLAYERS } from './constants';

/**
 * Historique court des positions de joueurs, pour alimenter le flowfield.
 *
 * **C'est la piece qui empeche les hordes de diverger.** Le flowfield se
 * calcule a partir des positions des joueurs ; le serveur les connait a
 * l'instant present, le client ne connait celles des autres qu'avec du retard.
 * Deux entrees differentes donnent deux champs differents — et une erreur de
 * *direction* ne se rattrape pas, elle s'accumule a chaque pas.
 *
 * La parade : les deux cotes lisent les positions du tick `T - K`. Le serveur
 * s'impose le retard qu'il inflige au client, et les entrees redeviennent
 * identiques. Voir §5 de la spec de l'etape 2.
 */

/** Profondeur d'historique : de quoi couvrir le retard et un peu de gigue. */
const DEPTH = 16;

export interface PlayerPositions {
  /** Tick dont proviennent ces positions. Peut etre anterieur au tick demande. */
  tick: number;
  x: number[];
  y: number[];
  /**
   * L'identifiant du joueur de chaque rang (etape 8, tache 6). Un leurre
   * remplace son lanceur dans l'entree du champ, et il le retrouve par cet
   * identifiant — jamais par un indice, qui bouge quand un joueur part
   * (`shared/decoys.ts`).
   */
  ids: number[];
}

export class PlayerHistory {
  readonly #ticks = new Int32Array(DEPTH).fill(-1);
  readonly #x = new Float32Array(DEPTH * MAX_PLAYERS);
  readonly #y = new Float32Array(DEPTH * MAX_PLAYERS);
  readonly #counts = new Uint8Array(DEPTH);
  readonly #ids = new Uint8Array(DEPTH * MAX_PLAYERS);

  /**
   * `ids` est optionnel pour les appelants qui n'ont aucun leurre a resoudre
   * (les tests de horde) : absent, chaque rang porte l'identifiant `0`, qu'aucun
   * joueur n'a — un leurre n'y trouve donc personne, sans rien corrompre.
   */
  record(
    tick: number,
    xs: readonly number[],
    ys: readonly number[],
    ids: readonly number[] = [],
  ): void {
    const slot = ((tick % DEPTH) + DEPTH) % DEPTH;
    const count = Math.min(xs.length, MAX_PLAYERS);
    this.#ticks[slot] = tick;
    this.#counts[slot] = count;
    for (let p = 0; p < count; p++) {
      this.#x[slot * MAX_PLAYERS + p] = xs[p] ?? 0;
      this.#y[slot * MAX_PLAYERS + p] = ys[p] ?? 0;
      this.#ids[slot * MAX_PLAYERS + p] = ids[p] ?? 0;
    }
  }

  /**
   * Positions du tick `tick - FIELD_INPUT_DELAY_TICKS`.
   *
   * Rend `null` tant que l'historique n'est pas assez profond — au demarrage.
   *
   * Si le tick vise n'a jamais ete enregistre, s'accroche au plus recent
   * disponible **anterieur** a lui. C'est le cas reel de degradation : le client
   * n'enregistre qu'a la reception d'un snapshot, donc son historique a un trou
   * a l'extremite recente des que le reseau hoquette. Mieux vaut une horde qui
   * poursuit une position un peu perimee qu'une horde qui s'arrete.
   */
  delayed(tick: number): PlayerPositions | null {
    const wanted = tick - FIELD_INPUT_DELAY_TICKS;
    const exact = this.#at(wanted);
    if (exact) {
      return exact;
    }

    let bestTick = -1;
    for (let slot = 0; slot < DEPTH; slot++) {
      const t = this.#ticks[slot] ?? -1;
      if (t >= 0 && t <= wanted && t > bestTick) {
        bestTick = t;
      }
    }
    if (bestTick >= 0) {
      return this.#at(bestTick);
    }

    return null;
  }

  #at(tick: number): PlayerPositions | null {
    if (tick < 0) {
      return null;
    }
    const slot = ((tick % DEPTH) + DEPTH) % DEPTH;
    if (this.#ticks[slot] !== tick) {
      return null;
    }
    const count = this.#counts[slot] ?? 0;
    const x: number[] = [];
    const y: number[] = [];
    const ids: number[] = [];
    for (let p = 0; p < count; p++) {
      x.push(this.#x[slot * MAX_PLAYERS + p] ?? 0);
      y.push(this.#y[slot * MAX_PLAYERS + p] ?? 0);
      ids.push(this.#ids[slot * MAX_PLAYERS + p] ?? 0);
    }
    return { tick, x, y, ids };
  }
}
