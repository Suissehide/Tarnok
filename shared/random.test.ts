import { describe, expect, it } from 'vitest';

import { makeRandom } from './random';

describe('makeRandom', () => {
  it('rend la meme suite pour la meme graine', () => {
    const a = makeRandom(12345);
    const b = makeRandom(12345);
    const suiteA = [a(), a(), a(), a(), a()];
    const suiteB = [b(), b(), b(), b(), b()];

    expect(suiteA).toEqual(suiteB);
  });

  it('rend des suites differentes pour des graines differentes', () => {
    const a = makeRandom(1);
    const b = makeRandom(2);

    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
  });

  it('reste dans [0, 1)', () => {
    const rng = makeRandom(999);
    for (let i = 0; i < 10_000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('ne se bloque pas sur zero', () => {
    // xorshift a un point fixe en 0 : une graine nulle rendrait 0 a l'infini
    // et toutes les formations s'effondreraient sur un point.
    const rng = makeRandom(0);
    const values = new Set([rng(), rng(), rng(), rng()]);

    expect(values.size).toBeGreaterThan(1);
  });
});
