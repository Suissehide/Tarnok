import { TICK_HZ } from '@shared/constants';
import { describe, expect, it } from 'vitest';

import { FixedStepAccumulator } from './loop';

/**
 * Pas de test volontairement rond. Le vrai pas du jeu est 1000/30, qui n'est pas
 * representable exactement en binaire : l'utiliser ici ferait porter les
 * assertions sur des bornes a l'ulp pres, et ce n'est pas ce qu'on teste.
 */
const STEP = 10;

describe('FixedStepAccumulator', () => {
  it('ne rend aucun pas tant que le pas n est pas ecoule', () => {
    const acc = new FixedStepAccumulator(STEP, 5, 0);

    expect(acc.advance(9)).toBe(0);
  });

  it('rend un pas quand exactement un pas s est ecoule', () => {
    const acc = new FixedStepAccumulator(STEP, 5, 0);

    expect(acc.advance(10)).toBe(1);
  });

  it('garde le reste au lieu de le perdre', () => {
    const acc = new FixedStepAccumulator(STEP, 5, 0);

    expect(acc.advance(25)).toBe(2);
    // Il restait un demi-pas ; un demi-pas de plus en fait un entier.
    expect(acc.advance(30)).toBe(1);
  });

  it('plafonne le rattrapage apres une pause du process', () => {
    const acc = new FixedStepAccumulator(STEP, 5, 0);

    expect(acc.advance(10_000)).toBe(5);
  });

  it('abandonne le retard au lieu de le rejouer au tick suivant', () => {
    const acc = new FixedStepAccumulator(STEP, 5, 0);
    acc.advance(10_000);

    // Sans remise a zero de l'accumulateur, ces ~995 pas de retard
    // ressortiraient 5 par 5 pendant des secondes et tout le monde se
    // teleporterait. Le pas suivant doit etre un pas normal.
    expect(acc.advance(10_010)).toBe(1);
  });

  it('ne rend pas de pas si le temps recule', () => {
    const acc = new FixedStepAccumulator(STEP, 5, 1000);

    expect(acc.advance(500)).toBe(0);
  });

  it('tient la cadence reelle du jeu sur une seconde de temps simule', () => {
    const realStep = 1000 / TICK_HZ;
    const acc = new FixedStepAccumulator(realStep, 5, 0);

    let steps = 0;
    // On l'interroge deux fois plus vite que le pas, comme le fera le serveur.
    for (let i = 1; i <= TICK_HZ * 2; i++) {
      steps += acc.advance((i * 1000) / (TICK_HZ * 2));
    }
    // Une seconde pile vaut exactement TICK_HZ pas, ce qui met l'accumulateur
    // sur une borne a l'ulp pres. On l'interroge un demi-milliseconde plus loin,
    // ou le compte est sans ambiguite : 30 pas valent 1000 ms, 31 en valent 1033.
    steps += acc.advance(1000.5);

    expect(steps).toBe(TICK_HZ);
  });
});
