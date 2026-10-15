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

/**
 * Un tirage DETERMINISTE tire de trois entiers, dans `[0, 1)`.
 *
 * ⚠️ **Sans etat, et c'est tout l'interet.** `makeRandom` rend une SUITE : il
 * faut la tenir, la faire avancer au meme rythme des deux cotes, et le docbloc
 * ci-dessus interdit deja de l'appeler par tick pour cette raison. Ce que les
 * coups critiques demandent est l'inverse — une reponse qui ne depend QUE de
 * ce que les deux cotes savent deja (le tick du tir, le tireur, le rang du
 * projectile dans sa salve) et qui se recalcule a l'identique n'importe quand,
 * dans n'importe quel ordre.
 *
 * Meme melange que `makeRandom` (xorshift32), applique une fois : les trois
 * entrees sont combinees par des grands nombres impairs avant d'y entrer, pour
 * que deux triplets voisins ne rendent pas deux valeurs voisines — un
 * `a + b + c` nu aurait fait criter toute une salve ensemble.
 */
export function hashRoll(a: number, b: number, c: number): number {
  let state =
    (Math.imul(a | 0, 0x9e37_79b9) ^
      Math.imul(b | 0, 0x85eb_ca6b) ^
      Math.imul(c | 0, 0xc2b2_ae35)) >>>
    0;
  state = state || 0x9e37_79b9;
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state / 0x1_0000_0000;
}
