import { describe, expect, it } from 'vitest';

import { makeRandom } from './random';
import {
  CHEST_RARITY_FLOOR,
  EVENT_RARITY_FLOOR,
  multiplierOf,
  normalizeRarity,
  RARITY,
  RARITY_MULTIPLIERS,
  RARITY_WEIGHTS,
  rollRarity,
} from './rarity';

describe('etape 10 : la rarete', () => {
  /**
   * ⚠️ **Refait a l'etape 13** : la table est passee de trois a quatre
   * paliers (epique s'intercale), les valeurs exactes ci-dessous ont change en
   * consequence — voir le describe `etape 13` plus bas pour le detail des
   * poids et multiplicateurs.
   */
  it('quatre raretes, dans l ordre du fil, x1 x2 x1 x1, a 72 / 20 / 6 / 2', () => {
    expect(RARITY).toEqual({ COMMUNE: 0, RARE: 1, EPIQUE: 2, LEGENDAIRE: 3 });
    expect(RARITY_MULTIPLIERS).toEqual([1, 2, 1, 1]);
    expect(RARITY_WEIGHTS).toEqual([72, 20, 6, 2]);
  });

  it('sur un rng scripte, chaque rarete sort', () => {
    expect(rollRarity(() => 0)).toBe(RARITY.COMMUNE);
    expect(rollRarity(() => 0.5)).toBe(RARITY.COMMUNE);
    expect(rollRarity(() => 0.9)).toBe(RARITY.RARE);
    expect(rollRarity(() => 0.99)).toBe(RARITY.LEGENDAIRE);
    expect(rollRarity(() => 0.999_999)).toBe(RARITY.LEGENDAIRE);
  });

  /** ⚠️ Poids refaits a l'etape 13 (72 / 20 / 6 / 2) : voir plus bas. */
  it('suit les poids sur un grand nombre de tirages', () => {
    const rng = makeRandom(0x10_0a_0001);
    const vus = [0, 0, 0, 0];
    const N = 50_000;
    for (let i = 0; i < N; i++) {
      const r = rollRarity(rng);
      vus[r] = (vus[r] ?? 0) + 1;
    }
    expect((vus[0] ?? 0) / N).toBeCloseTo(0.72, 1);
    expect((vus[1] ?? 0) / N).toBeCloseTo(0.2, 1);
    expect((vus[2] ?? 0) / N).toBeGreaterThan(0.04);
    expect((vus[2] ?? 0) / N).toBeLessThan(0.08);
  });

  /**
   * ⚠️ **3 n'est plus hors table depuis l'etape 13** (c'est LEGENDAIRE) : le
   * sonde hors-table passe a 200 pour rester vraiment hors table, et le
   * multiplicateur de LEGENDAIRE tombe a 1 (etait 3).
   */
  it('une rarete absente ou hors table se lit commune, x1', () => {
    expect(normalizeRarity(undefined)).toBe(RARITY.COMMUNE);
    expect(normalizeRarity(200)).toBe(RARITY.COMMUNE);
    expect(normalizeRarity(-1)).toBe(RARITY.COMMUNE);
    expect(normalizeRarity(RARITY.RARE)).toBe(RARITY.RARE);
    expect(multiplierOf(undefined)).toBe(1);
    expect(multiplierOf(200)).toBe(1);
    expect(multiplierOf(RARITY.RARE)).toBe(2);
    expect(multiplierOf(RARITY.LEGENDAIRE)).toBe(1);
  });
});

describe('etape 11 : le plancher de rarete', () => {
  it('le coffre est au plancher rare', () => {
    expect(CHEST_RARITY_FLOOR).toBe(RARITY.RARE);
  });

  /**
   * ⚠️ **Suite REFAITE a l'etape 13** (graine 0x110a0001, 40 tirages) : les
   * poids sont passes de {82, 15, 3} a {72, 20, 6, 2}, donc la suite tiree a
   * change — ce n'est PAS un oubli. Ce test garde seulement que le tirage
   * reste reproductible (meme graine, meme rng, meme code -> meme suite),
   * pas que cette suite particuliere est intemporelle.
   */
  it('sans plancher, le rng donne une suite reproductible (relevee a l etape 13)', () => {
    const r = makeRandom(0x11_0a_0001);
    expect(Array.from({ length: 40 }, () => rollRarity(r))).toEqual([
      0, 0, 0, 0, 1, 0, 3, 0, 1, 0, 2, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 1, 1, 0, 0, 0, 0,
    ]);
  });

  /**
   * ⚠️ **Frontieres refaites a l'etape 13** : au plancher rare, le tirage
   * renormalise desormais sur TROIS paliers (rare/epique/legendaire =
   * 20/6/2 = 28), pas deux comme avant l'epique. Frontieres : rare en
   * dessous de 20/28 ≈ 0,7143, epique en dessous de 26/28 ≈ 0,9286,
   * legendaire au-dela.
   */
  it('au plancher rare, sur un rng scripte : rare, puis epique, puis legendaire', () => {
    expect(rollRarity(() => 0, RARITY.RARE)).toBe(RARITY.RARE);
    expect(rollRarity(() => 0.7, RARITY.RARE)).toBe(RARITY.RARE);
    expect(rollRarity(() => 0.72, RARITY.RARE)).toBe(RARITY.EPIQUE);
    expect(rollRarity(() => 0.93, RARITY.RARE)).toBe(RARITY.LEGENDAIRE);
    expect(rollRarity(() => 0.999_999, RARITY.RARE)).toBe(RARITY.LEGENDAIRE);
  });

  /** ⚠️ Refait a l'etape 13 : le plancher renormalise desormais sur {20, 6, 2} = 28. */
  it('au plancher rare, jamais commune, epique et legendaire visibles', () => {
    const rng = makeRandom(0x11_0a_0002);
    const vus = [0, 0, 0, 0];
    const N = 50_000;
    for (let i = 0; i < N; i++) {
      const r = rollRarity(rng, CHEST_RARITY_FLOOR);
      vus[r] = (vus[r] ?? 0) + 1;
    }
    expect(vus[RARITY.COMMUNE]).toBe(0);
    expect((vus[RARITY.RARE] ?? 0) / N).toBeCloseTo(20 / 28, 1);
    expect((vus[RARITY.EPIQUE] ?? 0) / N).toBeCloseTo(6 / 28, 1);
    expect((vus[RARITY.LEGENDAIRE] ?? 0) / N).toBeCloseTo(2 / 28, 1);
  });
});

describe('etape 13 : quatre paliers', () => {
  it('epique s intercale, legendaire monte a 3', () => {
    expect(RARITY.EPIQUE).toBe(2);
    expect(RARITY.LEGENDAIRE).toBe(3);
  });

  /**
   * ⚠️ Les deux paliers hauts valent 1 : une carte de REGLE ne se multiplie
   * jamais. C'est la table qui le dit, plus un cas particulier dans `cards.ts`.
   */
  it('seule la rare multiplie', () => {
    expect(RARITY_MULTIPLIERS).toEqual([1, 2, 1, 1]);
    expect(multiplierOf(RARITY.EPIQUE)).toBe(1);
    expect(multiplierOf(RARITY.LEGENDAIRE)).toBe(1);
  });

  it('les poids couvrent les quatre paliers et somment a 100', () => {
    expect(RARITY_WEIGHTS).toHaveLength(4);
    expect(RARITY_WEIGHTS.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('normalise ramene un octet hors table a commune, 3 compris desormais', () => {
    expect(normalizeRarity(3)).toBe(RARITY.LEGENDAIRE);
    expect(normalizeRarity(4)).toBe(RARITY.COMMUNE);
    expect(normalizeRarity(undefined)).toBe(RARITY.COMMUNE);
  });

  it('tire les quatre paliers a leurs poids', () => {
    const rng = makeRandom(0x13_0a_0001);
    const vus = [0, 0, 0, 0];
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const r = rollRarity(rng);
      vus[r] = (vus[r] ?? 0) + 1;
    }
    expect((vus[RARITY.COMMUNE] ?? 0) / N).toBeCloseTo(0.72, 2);
    expect((vus[RARITY.RARE] ?? 0) / N).toBeCloseTo(0.2, 2);
    expect((vus[RARITY.EPIQUE] ?? 0) / N).toBeCloseTo(0.06, 2);
    expect((vus[RARITY.LEGENDAIRE] ?? 0) / N).toBeCloseTo(0.02, 2);
  });

  /** Le plancher du coffre (etape 11) renormalise sur {20, 6, 2} = 28. */
  it('au plancher du coffre : 71 % rare, 21 % epique, 7 % legendaire', () => {
    const rng = makeRandom(0x13_0a_0002);
    const vus = [0, 0, 0, 0];
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const r = rollRarity(rng, CHEST_RARITY_FLOOR);
      vus[r] = (vus[r] ?? 0) + 1;
    }
    expect(vus[RARITY.COMMUNE]).toBe(0);
    expect((vus[RARITY.RARE] ?? 0) / N).toBeCloseTo(20 / 28, 2);
    expect((vus[RARITY.EPIQUE] ?? 0) / N).toBeCloseTo(6 / 28, 2);
    expect((vus[RARITY.LEGENDAIRE] ?? 0) / N).toBeCloseTo(2 / 28, 2);
  });
});

describe('etape 14 : le plancher d un evenement', () => {
  it('est epique', () => {
    expect(EVENT_RARITY_FLOOR).toBe(RARITY.EPIQUE);
  });

  /** {6, 2} renormalise : epique sous 6/8 = 0,75, legendaire au-dela. */
  it('frontiere : epique sous 0,75, legendaire au-dela', () => {
    expect(rollRarity(() => 0, EVENT_RARITY_FLOOR)).toBe(RARITY.EPIQUE);
    expect(rollRarity(() => 0.74, EVENT_RARITY_FLOOR)).toBe(RARITY.EPIQUE);
    expect(rollRarity(() => 0.76, EVENT_RARITY_FLOOR)).toBe(RARITY.LEGENDAIRE);
    expect(rollRarity(() => 0.999_999, EVENT_RARITY_FLOOR)).toBe(RARITY.LEGENDAIRE);
  });

  it('ne rend qu epique ou legendaire, a 75 / 25, sur 50 000 tirages', () => {
    const rng = makeRandom(0x14_0a_0001);
    const vus = [0, 0, 0, 0];
    const N = 50_000;
    for (let i = 0; i < N; i++) {
      const r = rollRarity(rng, EVENT_RARITY_FLOOR);
      vus[r] = (vus[r] ?? 0) + 1;
    }
    expect(vus[RARITY.COMMUNE]).toBe(0);
    expect(vus[RARITY.RARE]).toBe(0);
    expect((vus[RARITY.EPIQUE] ?? 0) / N).toBeCloseTo(0.75, 1);
    expect((vus[RARITY.LEGENDAIRE] ?? 0) / N).toBeCloseTo(0.25, 1);
  });

  it('consomme UN seul rng() par tirage, comme tout plancher', () => {
    let appels = 0;
    rollRarity(() => {
      appels++;
      return 0.5;
    }, EVENT_RARITY_FLOOR);
    expect(appels).toBe(1);
  });
});
