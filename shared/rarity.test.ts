import { describe, expect, it } from 'vitest';

import { makeRandom } from './random';
import {
  CHEST_RARITY_FLOOR,
  multiplierOf,
  normalizeRarity,
  RARITY,
  RARITY_MULTIPLIERS,
  RARITY_WEIGHTS,
  rollRarity,
} from './rarity';

describe('etape 10 : la rarete', () => {
  it('trois raretes, dans l ordre du fil, x1 x2 x3, a 82 / 15 / 3', () => {
    expect(RARITY).toEqual({ COMMUNE: 0, RARE: 1, LEGENDAIRE: 2 });
    expect(RARITY_MULTIPLIERS).toEqual([1, 2, 3]);
    expect(RARITY_WEIGHTS).toEqual([82, 15, 3]);
  });

  it('sur un rng scripte, chaque rarete sort', () => {
    expect(rollRarity(() => 0)).toBe(RARITY.COMMUNE);
    expect(rollRarity(() => 0.5)).toBe(RARITY.COMMUNE);
    expect(rollRarity(() => 0.9)).toBe(RARITY.RARE);
    expect(rollRarity(() => 0.99)).toBe(RARITY.LEGENDAIRE);
    expect(rollRarity(() => 0.999_999)).toBe(RARITY.LEGENDAIRE);
  });

  it('suit les poids sur un grand nombre de tirages', () => {
    const rng = makeRandom(0x10_0a_0001);
    const vus = [0, 0, 0];
    const N = 50_000;
    for (let i = 0; i < N; i++) {
      const r = rollRarity(rng);
      vus[r] = (vus[r] ?? 0) + 1;
    }
    expect((vus[0] ?? 0) / N).toBeCloseTo(0.82, 1);
    expect((vus[1] ?? 0) / N).toBeCloseTo(0.15, 1);
    expect((vus[2] ?? 0) / N).toBeGreaterThan(0.02);
    expect((vus[2] ?? 0) / N).toBeLessThan(0.04);
  });

  it('une rarete absente ou hors table se lit commune, x1', () => {
    expect(normalizeRarity(undefined)).toBe(RARITY.COMMUNE);
    expect(normalizeRarity(3)).toBe(RARITY.COMMUNE);
    expect(normalizeRarity(200)).toBe(RARITY.COMMUNE);
    expect(normalizeRarity(-1)).toBe(RARITY.COMMUNE);
    expect(normalizeRarity(RARITY.RARE)).toBe(RARITY.RARE);
    expect(multiplierOf(undefined)).toBe(1);
    expect(multiplierOf(200)).toBe(1);
    expect(multiplierOf(RARITY.RARE)).toBe(2);
    expect(multiplierOf(RARITY.LEGENDAIRE)).toBe(3);
  });
});

describe('etape 11 : le plancher de rarete', () => {
  it('le coffre est au plancher rare', () => {
    expect(CHEST_RARITY_FLOOR).toBe(RARITY.RARE);
  });

  /**
   * ⚠️ **La suite RELEVEE sur main avant l'etape** (graine 0x110a0001, 40
   * tirages) : sans plancher, une montee de niveau ne doit voir AUCUNE
   * difference — ni de rarete, ni de consommation du `rng`.
   */
  it('sans plancher, le meme rng rend la meme suite qu avant l etape', () => {
    const r = makeRandom(0x11_0a_0001);
    expect(Array.from({ length: 40 }, () => rollRarity(r))).toEqual([
      0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 1, 0, 0, 0, 0, 0,
    ]);
  });

  it('au plancher rare, sur un rng scripte : 15/18 rare, 3/18 legendaire', () => {
    expect(rollRarity(() => 0, RARITY.RARE)).toBe(RARITY.RARE);
    // 0,83 x 18 = 14,94 < 15 : encore rare ; 0,84 x 18 = 15,12 : legendaire.
    expect(rollRarity(() => 0.83, RARITY.RARE)).toBe(RARITY.RARE);
    expect(rollRarity(() => 0.84, RARITY.RARE)).toBe(RARITY.LEGENDAIRE);
    expect(rollRarity(() => 0.999_999, RARITY.RARE)).toBe(RARITY.LEGENDAIRE);
  });

  it('au plancher rare, jamais commune, et encore legendaire ~17 % du temps', () => {
    const rng = makeRandom(0x11_0a_0002);
    const vus = [0, 0, 0];
    const N = 50_000;
    for (let i = 0; i < N; i++) {
      const r = rollRarity(rng, CHEST_RARITY_FLOOR);
      vus[r] = (vus[r] ?? 0) + 1;
    }
    expect(vus[RARITY.COMMUNE]).toBe(0);
    expect((vus[RARITY.LEGENDAIRE] ?? 0) / N).toBeCloseTo(3 / 18, 1);
    expect((vus[RARITY.RARE] ?? 0) / N).toBeCloseTo(15 / 18, 1);
  });
});
