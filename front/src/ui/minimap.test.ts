// @vitest-environment jsdom
import { MAP_SIZE } from '@shared/constants';
import { describe, expect, it } from 'vitest';

import { playerColor } from './draft';
import { Minimap, toMinimap } from './minimap';

describe('mini-carte', () => {
  it('convertit le monde en pixels entiers bornes au cadre', () => {
    expect(toMinimap(0, 6000, 150)).toBe(0);
    expect(toMinimap(3000, 6000, 150)).toBe(75);
    expect(toMinimap(39.9, 6000, 150)).toBe(0); // jamais de demi-pixel
    expect(toMinimap(6000, 6000, 150)).toBe(149); // bord exact : dans le cadre
    expect(toMinimap(-50, 6000, 150)).toBe(0);
    expect(toMinimap(9000, 6000, 150)).toBe(149);
  });

  it('dessine le joueur local en dernier, plus gros, avec contour blanc', () => {
    const calls: { style: string; x: number; y: number; w: number; h: number }[] = [];
    const ctx = {
      fillStyle: '',
      fillRect(x: number, y: number, w: number, h: number) {
        calls.push({ style: this.fillStyle, x, y, w, h });
      },
    };
    const canvas = {
      width: 100,
      height: 100,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
    const map = new Minimap(canvas);

    map.draw({
      localId: 1,
      players: [
        { id: 1, x: MAP_SIZE / 2, y: MAP_SIZE / 2, hp: 10 },
        { id: 2, x: 0, y: 0, hp: 10 },
      ],
      enemies: { count: 2, x: new Float32Array([10, 20]), y: new Float32Array([10, 20]) },
      boss: null,
      pings: [],
      blinkOn: true,
    });

    // fond + 2 ennemis + 1 allie + contour + local
    expect(calls).toHaveLength(6);
    expect(calls.filter((c) => c.w === 1)).toHaveLength(2);
    const [outline, local] = calls.slice(-2);
    expect(outline).toEqual({ style: '#ffffff', x: 47, y: 47, w: 7, h: 7 });
    expect(local).toEqual({ style: playerColor(1), x: 48, y: 48, w: 5, h: 5 });
    expect(calls[3]?.w).toBe(3); // l allie, plus petit
  });

  it('reste muet sans contexte 2D (jsdom)', () => {
    const map = new Minimap(document.createElement('canvas'));
    expect(() =>
      map.draw({
        localId: null,
        players: [],
        enemies: { count: 0, x: new Float32Array(), y: new Float32Array() },
        boss: null,
        pings: [],
        blinkOn: true,
      }),
    ).not.toThrow();
  });

  it('un ping clignote : un carre de 5 px de la couleur du joueur, seulement sur la phase allumee', () => {
    const calls: { style: string; x: number; y: number; w: number; h: number }[] = [];
    const ctx = {
      fillStyle: '',
      fillRect(x: number, y: number, w: number, h: number) {
        calls.push({ style: this.fillStyle, x, y, w, h });
      },
    };
    const canvas = {
      width: 100,
      height: 100,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
    const map = new Minimap(canvas);
    const base = {
      localId: 1,
      players: [],
      enemies: { count: 0, x: new Float32Array(0), y: new Float32Array(0) },
      boss: null,
      pings: [{ playerId: 3, x: MAP_SIZE / 2, y: MAP_SIZE / 2 }],
    };
    map.draw({ ...base, blinkOn: true });
    expect(calls.filter((c) => c.style === playerColor(3) && c.w === 5)).toHaveLength(1);
    calls.length = 0;
    map.draw({ ...base, blinkOn: false });
    expect(calls.filter((c) => c.style === playerColor(3) && c.w === 5)).toHaveLength(0);
  });
});
