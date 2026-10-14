import { describe, expect, it } from 'vitest';

import {
  CREEP_MAX,
  easeBar,
  FUNNY_LINE_MS,
  FUNNY_LINES,
  funnyLine,
  type LoadingState,
  loadingProgress,
  TIPS,
  tipFor,
} from './loading';

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

describe('easeBar — la jauge affichee avance sans sauter', () => {
  it('rattrape la valeur reelle en douceur, sans la depasser d un coup', () => {
    const apres = easeBar(0, 0.5, 50);
    expect(apres).toBeGreaterThan(0);
    expect(apres).toBeLessThan(0.5);
    let v = 0;
    for (let t = 0; t < 2000; t += 50) {
      v = easeBar(v, 0.5, 50);
    }
    expect(v).toBeGreaterThanOrEqual(0.49);
  });

  it('grignote pendant qu une etape attend, sans depasser target + CREEP_MAX', () => {
    let v = 0.3;
    const debut = v;
    for (let t = 0; t < 60_000; t += 50) {
      v = easeBar(v, 0.3, 50);
    }
    expect(v).toBeGreaterThan(debut);
    expect(v).toBeLessThanOrEqual(0.3 + CREEP_MAX + 1e-9);
  });

  it('ne recule jamais, meme si la cible baisse, et ne passe jamais 1', () => {
    expect(easeBar(0.6, 0.2, 50)).toBeGreaterThanOrEqual(0.6);
    let v = 0.9;
    for (let t = 0; t < 5000; t += 50) {
      v = easeBar(v, 1, 50);
    }
    expect(v).toBeLessThanOrEqual(1);
    expect(v).toBeGreaterThan(0.995);
  });
});

describe('funnyLine — les phrases de l attente', () => {
  it('change de phrase toutes les FUNNY_LINE_MS, dans la liste', () => {
    expect(FUNNY_LINES.length).toBeGreaterThan(5);
    expect(funnyLine(0, 0)).toBe(FUNNY_LINES[0]);
    expect(funnyLine(FUNNY_LINE_MS - 1, 0)).toBe(FUNNY_LINES[0]);
    expect(funnyLine(FUNNY_LINE_MS, 0)).toBe(FUNNY_LINES[1]);
    expect(FUNNY_LINES).toContain(funnyLine(123_456, 7));
  });

  it('chaque phrase commence par un verbe a l infinitif', () => {
    for (const ligne of FUNNY_LINES) {
      const verbe = ligne.split(' ')[0] ?? '';
      expect(verbe, ligne).toMatch(/(er|ir|re)$/);
    }
  });
});
