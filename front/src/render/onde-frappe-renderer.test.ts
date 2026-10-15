// @vitest-environment jsdom
import { Container } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';

import {
  FRAPPE_BOLT_MS,
  FRAPPE_TRACE_CAPACITY,
  type FrappeTrace,
  ONDE_TRACE_CAPACITY,
  type OndeTrace,
} from '../net/client';
import {
  FRAPPE_BOLT_HEIGHT_PX,
  FRAPPE_BOLT_SEGMENTS,
  FRAPPE_WARN_START,
  ONDE_WIDTH_END_PX,
  ONDE_WIDTH_START_PX,
  OndeFrappeRenderer,
} from './onde-frappe-renderer';

/**
 * Le calque de l'etape 12 : il trace CE QU'ON LUI DONNE (les listes semees
 * par `GameClient`), rien avant `load()`, et un cout borne par la capacite
 * des listes — jamais par la horde, qu'il ne lit pas.
 */

const NOW = 10_000;

function onde(over: Partial<OndeTrace> = {}): OndeTrace {
  return {
    x: 500,
    y: 600,
    bornTick: 0,
    speed: 400,
    maxRadius: 200,
    damage: 10,
    element: 0,
    by: 1,
    tint: 0xcbbf9a,
    bornMs: NOW,
    ...over,
  };
}

function frappe(over: Partial<FrappeTrace> = {}): FrappeTrace {
  return {
    x: 300,
    y: 400,
    radius: 35,
    damage: 20,
    element: 0,
    by: 1,
    dueTick: 9,
    tint: 0x00e5ff,
    bornMs: NOW,
    struckMs: -1,
    ...over,
  };
}

function loaded(): OndeFrappeRenderer {
  const r = new OndeFrappeRenderer();
  r.load();
  return r;
}

describe('OndeFrappeRenderer — protocole de calque', () => {
  it('loaded vaut faux avant load(), vrai apres', () => {
    const r = new OndeFrappeRenderer();
    expect(r.loaded).toBe(false);
    r.load();
    expect(r.loaded).toBe(true);
  });

  it('attache son Graphics au parent', () => {
    const r = new OndeFrappeRenderer();
    const parent = new Container();
    r.attach(parent);
    expect(parent.children).toEqual([r.graphics]);
  });

  it('ne trace rien tant que load() n a pas ete appele', () => {
    const r = new OndeFrappeRenderer();
    const circle = vi.spyOn(r.graphics, 'circle');
    const lineTo = vi.spyOn(r.graphics, 'lineTo');
    r.draw([onde()], [frappe(), frappe({ struckMs: NOW })], NOW + 50);
    expect(circle).not.toHaveBeenCalled();
    expect(lineTo).not.toHaveBeenCalled();
  });
});

describe('OndeFrappeRenderer — l onde', () => {
  it('trace l anneau au rayon interpole a l horloge murale, centre sur le tir', () => {
    const r = loaded();
    const circle = vi.spyOn(r.graphics, 'circle');
    // 400 px/s pendant 250 ms : 100 px, entre deux ticks.
    r.draw([onde()], [], NOW + 250);
    const rayons = circle.mock.calls.map((c) => c[2]);
    expect(rayons).toContain(100);
    for (const c of circle.mock.calls) {
      expect([c[0], c[1]]).toEqual([500, 600]);
    }
  });

  it('s affine en s eloignant : epais au depart, fin a la portee', () => {
    const r = loaded();
    const stroke = vi.spyOn(r.graphics, 'stroke');
    r.draw([onde()], [], NOW + 1);
    const tot = stroke.mock.calls.map((c) => (c[0] as { width: number }).width);
    stroke.mockClear();
    r.draw([onde()], [], NOW + 450);
    const tard = stroke.mock.calls.map((c) => (c[0] as { width: number }).width);
    // Le second trait est le front (le premier, le sillage translucide).
    expect(tot[1]).toBeCloseTo(ONDE_WIDTH_START_PX, 0);
    expect(tard[1]).toBeLessThan(tot[1] ?? 0);
    expect(tard[1]).toBeGreaterThanOrEqual(ONDE_WIDTH_END_PX);
  });

  it('s eteint en fin de course : plus rien a sa portee maximale', () => {
    const r = loaded();
    const circle = vi.spyOn(r.graphics, 'circle');
    r.draw([onde()], [], NOW + 2000);
    expect(circle).not.toHaveBeenCalled();
  });
});

describe('OndeFrappeRenderer — la frappe', () => {
  it('avertit pendant le delai : un cercle qui se resserre vers le rayon d impact', () => {
    const r = loaded();
    const circle = vi.spyOn(r.graphics, 'circle');
    r.draw([], [frappe()], NOW);
    const debut = Math.max(...circle.mock.calls.map((c) => c[2]));
    circle.mockClear();
    r.draw([], [frappe()], NOW + 10_000);
    const fin = Math.max(...circle.mock.calls.map((c) => c[2]));
    expect(debut).toBeCloseTo(35 * FRAPPE_WARN_START, 6);
    expect(fin).toBeCloseTo(35, 6);
  });

  it('a l echeance, un eclair tombe du haut jusqu au point d impact', () => {
    const r = loaded();
    const moveTo = vi.spyOn(r.graphics, 'moveTo');
    const lineTo = vi.spyOn(r.graphics, 'lineTo');
    r.draw([], [frappe({ struckMs: NOW })], NOW + 60);
    expect(moveTo.mock.calls[0]).toEqual([300, 400 - FRAPPE_BOLT_HEIGHT_PX]);
    // Deux couches (halo, coeur), chacune jusqu'au sol.
    expect(lineTo).toHaveBeenCalledTimes(2 * FRAPPE_BOLT_SEGMENTS);
    expect(lineTo.mock.calls[FRAPPE_BOLT_SEGMENTS - 1]).toEqual([300, 400]);
  });

  it('l eclair est deterministe : meme impact, meme zigzag', () => {
    const a = loaded();
    const b = loaded();
    const la = vi.spyOn(a.graphics, 'lineTo');
    const lb = vi.spyOn(b.graphics, 'lineTo');
    a.draw([], [frappe({ struckMs: NOW })], NOW + 60);
    b.draw([], [frappe({ struckMs: NOW })], NOW + 60);
    expect(la.mock.calls).toEqual(lb.mock.calls);
  });

  it('l eclair s eteint au bout de FRAPPE_BOLT_MS', () => {
    const r = loaded();
    const lineTo = vi.spyOn(r.graphics, 'lineTo');
    r.draw([], [frappe({ struckMs: NOW })], NOW + FRAPPE_BOLT_MS);
    expect(lineTo).not.toHaveBeenCalled();
  });
});

describe('OndeFrappeRenderer — cout borne par la capacite', () => {
  it('trace en proportion des listes pleines, independamment de toute horde', () => {
    const r = loaded();
    const circle = vi.spyOn(r.graphics, 'circle');
    const ondes = Array.from({ length: ONDE_TRACE_CAPACITY }, () => onde());
    const frappes = Array.from({ length: FRAPPE_TRACE_CAPACITY }, () => frappe());
    r.draw(ondes, frappes, NOW + 100);
    // Trois cercles par onde, trois par avertissement : rien d'autre.
    expect(circle).toHaveBeenCalledTimes(3 * ONDE_TRACE_CAPACITY + 3 * FRAPPE_TRACE_CAPACITY);
  });
});

describe('OndeFrappeRenderer — l aura de l homoncule (etape 12)', () => {
  const guard = {
    x: 0,
    y: 0,
    bornTick: 0,
    lifeTicks: 96,
    radius: 90,
    damage: 6,
    element: 0,
    by: 3,
    tint: 0xd7dcf5,
    bornMs: 1000,
  };

  it('se centre sur son invocateur DESSINE, pas sur le point de pose', () => {
    const renderer = new OndeFrappeRenderer();
    renderer.load();
    const circle = vi.spyOn(renderer.graphics, 'circle');

    renderer.draw([], [], 1200, [guard], [{ id: 3, x: 500, y: 400 }]);

    expect(circle).toHaveBeenCalledWith(500, 400, 90);
    expect(circle).not.toHaveBeenCalledWith(0, 0, 90);
  });

  it('ne dessine qu une aura par invocateur, meme quand deux homoncules se chevauchent', () => {
    const renderer = new OndeFrappeRenderer();
    renderer.load();
    const circle = vi.spyOn(renderer.graphics, 'circle');

    renderer.draw([], [], 1200, [guard, { ...guard, bornTick: 30 }], [{ id: 3, x: 500, y: 400 }]);

    const disques = circle.mock.calls.filter((c) => c[0] === 500 && c[1] === 400 && c[2] === 90);
    // Le disque et le liseré blanc : deux appels pour UNE aura.
    expect(disques).toHaveLength(2);
  });
});
