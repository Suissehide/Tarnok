import { describe, expect, it } from 'vitest';

import { type LoadingState, loadingProgress, TIPS, tipFor } from './loading';

const depart: LoadingState = {
  launched: false,
  mapReady: false,
  assetsLoaded: 0,
  assetsTotal: 10,
  terrainReady: false,
  firstSnapshot: false,
};

describe('loadingProgress — l ecran de chargement (maquette 03)', () => {
  it('avance par etapes, sans jamais reculer, jusqu a la fin', () => {
    const etapes: LoadingState[] = [
      depart,
      { ...depart, launched: true },
      { ...depart, launched: true, mapReady: true },
      { ...depart, launched: true, mapReady: true, assetsLoaded: 5 },
      { ...depart, launched: true, mapReady: true, assetsLoaded: 10 },
      { ...depart, launched: true, mapReady: true, assetsLoaded: 10, terrainReady: true },
      {
        ...depart,
        launched: true,
        mapReady: true,
        assetsLoaded: 10,
        terrainReady: true,
        firstSnapshot: true,
      },
    ];
    const ratios = etapes.map((e) => loadingProgress(e).ratio);
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeGreaterThan(ratios[i - 1] ?? 0);
    }
    expect(ratios.at(-1)).toBe(1);
    expect(etapes.slice(0, -1).every((e) => !loadingProgress(e).done)).toBe(true);
    expect(loadingProgress(etapes.at(-1) ?? depart).done).toBe(true);
  });

  it('ne finit pas tant que le joueur ne s est pas vu, terrain pret ou pas', () => {
    expect(loadingProgress({ ...depart, mapReady: true, terrainReady: true }).done).toBe(false);
    expect(loadingProgress({ ...depart, mapReady: true, firstSnapshot: true }).done).toBe(false);
  });

  it('chaque etape a un libelle, et la jauge reste dans [0, 1]', () => {
    const v = loadingProgress({ ...depart, mapReady: true, assetsLoaded: 99 });
    expect(v.ratio).toBeLessThanOrEqual(1);
    expect(v.label.length).toBeGreaterThan(0);
  });
});

describe('tipFor — un conseil par salon', () => {
  it('rend toujours un conseil de la liste, le meme pour le meme salon', () => {
    expect(TIPS).toContain(tipFor('ABCD'));
    expect(tipFor('ABCD')).toBe(tipFor('ABCD'));
    const vus = new Set(['ABCD', 'WXYZ', 'QRST', 'MNOP', 'EFGH', 'IJKL'].map(tipFor));
    expect(vus.size).toBeGreaterThan(1);
  });
});
