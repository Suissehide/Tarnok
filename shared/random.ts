/**
 * Generateur pseudo-aleatoire deterministe, partage serveur/client.
 *
 * C'est lui qui transforme la graine d'un ordre de vague en positions de
 * formation, identiquement des deux cotes. Sans determinisme ici, deux clients
 * font apparaitre la meme vague a des endroits differents et tout le §3.3 de
 * l'orientation s'effondre.
 *
 * ⚠️ A n'utiliser qu'a **l'apparition**, jamais par tick : un tirage par tick
 * ferait dependre l'etat du nombre de pas executes, et la moindre difference de
 * cadence divergerait sans retour.
 */
export function makeRandom(seed: number): () => number {
  // xorshift32 a un point fixe en zero : une graine nulle rendrait 0 a
  // l'infini et toutes les formations s'effondreraient sur un point.
  let state = seed >>> 0 || 0x9e37_79b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** Tirage uniforme dans [min, max). */
export function randomRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}
