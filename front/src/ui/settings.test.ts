import { describe, expect, it } from 'vitest';

import { CONTROLS, DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings';

/** Un stockage en memoire, a la place de `localStorage`. */
function memoire(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  } as unknown as Storage;
}

describe('les options gardees dans le navigateur', () => {
  it('rend les valeurs par defaut sans rien de garde', () => {
    expect(loadSettings(memoire())).toEqual(DEFAULT_SETTINGS);
  });

  it('relit ce qui a ete garde', () => {
    const s = memoire();
    const gardees = { combosOpen: true, minimap: false, master: 30, music: 0, sfx: 100 };
    expect(saveSettings(gardees, s)).toBe(true);
    expect(loadSettings(s)).toEqual(gardees);
  });

  it('ignore un contenu abime ou d un mauvais type, valeur par valeur', () => {
    const s = memoire();
    s.setItem('tarnok.settings', '{pas du json');
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
    s.setItem('tarnok.settings', JSON.stringify({ combosOpen: 'oui', minimap: false }));
    expect(loadSettings(s)).toEqual({ ...DEFAULT_SETTINGS, minimap: false });
  });

  it('borne un volume a [0, 100] et ignore une valeur qui n en est pas une', () => {
    const s = memoire();
    s.setItem('tarnok.settings', JSON.stringify({ master: 250, music: -4, sfx: 'fort' }));
    expect(loadSettings(s)).toMatchObject({ master: 100, music: 0, sfx: DEFAULT_SETTINGS.sfx });
  });

  it('survit a un stockage qui leve ou qui manque', () => {
    const casse = {
      getItem: () => {
        throw new Error('bloque');
      },
      setItem: () => {
        throw new Error('bloque');
      },
    };
    expect(loadSettings(casse)).toEqual(DEFAULT_SETTINGS);
    expect(saveSettings(DEFAULT_SETTINGS, casse)).toBe(false);
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(saveSettings(DEFAULT_SETTINGS, null)).toBe(false);
  });

  it('liste les touches du jeu', () => {
    expect(CONTROLS.map((c) => c.keys)).toContain('Espace');
  });
});
