/**
 * La rarete d'une carte de l'etalage (etape 10, §2 de la spec).
 *
 * Une carte rare vaut DEUX cartes, une legendaire TROIS — et rien de plus :
 * aucune regle d'empilement nouvelle, `applyCardToLoadout` applique la carte
 * autant de fois que son multiplicateur. L'index EST l'identifiant, et c'est
 * l'octet du fil (`DRAFT_CARD_BYTES`).
 */
export const RARITY = {
  COMMUNE: 0,
  RARE: 1,
  LEGENDAIRE: 2,
} as const;

/** Combien de fois une carte s'applique, par rarete. */
export const RARITY_MULTIPLIERS: readonly number[] = [1, 2, 3];

/**
 * Le poids de chaque rarete au tirage, en pourcents (82 / 15 / 3).
 *
 * ⚠️ **Un reglage de playtest, pas un invariant** : les legendaires doivent
 * etre assez rares pour faire evenement, assez frequentes pour etre vues.
 */
export const RARITY_WEIGHTS: readonly number[] = [82, 15, 3];

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
 */
export function rollRarity(rng: () => number): number {
  const total = RARITY_WEIGHTS.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let r = 0; r < RARITY_WEIGHTS.length; r++) {
    roll -= RARITY_WEIGHTS[r] ?? 0;
    if (roll < 0) {
      return r;
    }
  }
  return RARITY_WEIGHTS.length - 1;
}
