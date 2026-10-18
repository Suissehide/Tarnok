/**
 * La rarete d'une carte de l'etalage.
 *
 * ⚠️ **Deux familles, pas quatre.** COMMUNE et RARE MULTIPLIENT une carte
 * ordinaire ; EPIQUE et LEGENDAIRE sont des cartes de REGLE, exclusives a leur
 * palier (`Passive.tier`) et appliquees une seule fois. L'index EST
 * l'identifiant, et c'est l'octet du fil (`DRAFT_CARD_BYTES`, inchange).
 */
export const RARITY = {
  COMMUNE: 0,
  RARE: 1,
  EPIQUE: 2,
  LEGENDAIRE: 3,
} as const;

/**
 * Combien de fois une carte s'applique, par rarete.
 *
 * ⚠️ **1 pour les deux paliers hauts, et ce n'est pas un oubli** : le triple
 * d'une regle serait du decor.
 */
export const RARITY_MULTIPLIERS: readonly number[] = [1, 2, 1, 1];

/**
 * Le poids de chaque rarete au tirage, en pourcents (72 / 20 / 6 / 2).
 *
 * ⚠️ **Un reglage de playtest, pas un invariant.**
 */
export const RARITY_WEIGHTS: readonly number[] = [72, 20, 6, 2];

/**
 * Le plancher de rarete d'un COFFRE : toutes ses cartes sont au moins rares.
 * Le tirage RENORMALISE au-dessus du plancher (20/28 rare, 6/28 epique, 2/28
 * legendaire) : un `Math.max(plancher, tirage)` laisserait la legendaire a 2 %
 * et oterait au coffre sa raison d'etre un evenement.
 */
export const CHEST_RARITY_FLOOR: number = RARITY.RARE;

/**
 * Ramene une rarete lue sur le fil dans la table : absente ou inconnue, la
 * carte est commune. Un octet ne peut pas mentir plus loin que ca.
 */
export function normalizeRarity(rarity: number | undefined): number {
  const r = rarity ?? RARITY.COMMUNE;
  return RARITY_MULTIPLIERS[r] === undefined ? RARITY.COMMUNE : r;
}

/** Le multiplicateur d'une rarete, `1` pour tout ce qui n'est pas dans la table. */
export function multiplierOf(rarity: number | undefined): number {
  return RARITY_MULTIPLIERS[normalizeRarity(rarity)] ?? 1;
}

/**
 * Tire une rarete selon `RARITY_WEIGHTS`. `rng` est injecte, comme pour
 * `drawSpread` : `shared/` n'appelle jamais `Math.random`.
 *
 * `floor` : ne tire que parmi les raretes `>= floor`, a leurs poids relatifs.
 * Un seul `rng()` par tirage, quel que soit le plancher.
 */
export function rollRarity(rng: () => number, floor: number = RARITY.COMMUNE): number {
  let total = 0;
  for (let r = floor; r < RARITY_WEIGHTS.length; r++) {
    total += RARITY_WEIGHTS[r] ?? 0;
  }
  let roll = rng() * total;
  for (let r = floor; r < RARITY_WEIGHTS.length; r++) {
    roll -= RARITY_WEIGHTS[r] ?? 0;
    if (roll < 0) {
      return r;
    }
  }
  return RARITY_WEIGHTS.length - 1;
}
