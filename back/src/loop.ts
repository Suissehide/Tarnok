/**
 * Accumulateur de pas fixes.
 *
 * On ne fait pas avancer un salon avec un `setInterval` naif : l'ordonnanceur de
 * Node ne garantit aucun delai, et un salon dont le pas depend de la ponctualite
 * du timer derive. On accumule le temps reel et on consomme des pas entiers.
 *
 * Le plafond de rattrapage n'est pas cosmetique. Sans lui, une pause du process
 * — un GC, une machine qui se met en veille — declenche une avalanche de
 * centaines de pas d'un coup et teleporte tout le monde. Au plafond, on
 * abandonne le retard : mieux vaut un saut assume qu'une rafale.
 */
export class FixedStepAccumulator {
  #accumulated = 0;
  #last: number;

  constructor(
    private readonly stepMs: number,
    private readonly maxCatchUpSteps: number,
    now: number,
  ) {
    this.#last = now;
  }

  /** Rend le nombre de pas a executer pour l'instant `now`. */
  advance(now: number): number {
    // Une horloge qui recule (ajustement systeme) ne doit pas creer de dette
    // negative qui gelerait le salon jusqu'a ce qu'elle se resorbe.
    const elapsed = Math.max(0, now - this.#last);
    this.#last = now;
    this.#accumulated += elapsed;

    let steps = 0;
    while (this.#accumulated >= this.stepMs && steps < this.maxCatchUpSteps) {
      this.#accumulated -= this.stepMs;
      steps++;
    }
    if (steps === this.maxCatchUpSteps) {
      this.#accumulated = 0;
    }
    return steps;
  }
}
