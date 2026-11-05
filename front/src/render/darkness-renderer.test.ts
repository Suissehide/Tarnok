import { EVENT_KIND, NOIR_LIGHT_RADIUS, NOIR_LIGHT_RADIUS_SOLO } from '@shared/evenements';
import { Container, type Graphics, Rectangle } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import type { EventView } from '../net/client';
import {
  DarknessRenderer,
  darknessAlpha,
  darknessHole,
  NOIR_DARK_ALPHA,
  NOIR_FADE_MS,
} from './darkness-renderer';

const noir: EventView = {
  kind: EVENT_KIND.NOIR,
  points: [],
  progress: 0,
  secondsLeft: 60,
  cart: null,
  cartHp: 0,
  solo: false,
  carrierId: 2,
  relic: null,
  startedAtMs: 1000,
  targets: [],
};
const joueurs = [
  { id: 1, x: 10, y: 20, hp: 100 },
  { id: 2, x: 400, y: 300, hp: 100 },
];

describe('etape 16 : darknessHole', () => {
  it('centre sur le porteur de lanterne DESSINE, rayon 350 (500 seul)', () => {
    expect(darknessHole(noir, joueurs)).toEqual({ x: 400, y: 300, radius: NOIR_LIGHT_RADIUS });
    expect(darknessHole({ ...noir, solo: true }, joueurs)).toEqual({
      x: 400,
      y: 300,
      radius: NOIR_LIGHT_RADIUS_SOLO,
    });
  });

  it('null hors noir, et tant que le porteur n est pas connu (premier etat pas recu)', () => {
    expect(darknessHole(null, joueurs)).toBeNull();
    expect(darknessHole({ ...noir, kind: EVENT_KIND.SIEGE }, joueurs)).toBeNull();
    expect(darknessHole({ ...noir, carrierId: 0 }, joueurs)).toBeNull();
  });

  it('porteur introuvable ou mort : tout noir, sans trou', () => {
    expect(darknessHole({ ...noir, carrierId: 3 }, joueurs)?.radius).toBe(0);
    expect(darknessHole(noir, [{ id: 2, x: 400, y: 300, hp: 0 }])?.radius).toBe(0);
  });

  it('le fondu : 0 au depart, NOIR_DARK_ALPHA apres NOIR_FADE_MS', () => {
    expect(darknessAlpha(1000, 1000)).toBe(0);
    expect(darknessAlpha(1000, 1000 + NOIR_FADE_MS / 2)).toBeCloseTo(NOIR_DARK_ALPHA / 2, 6);
    expect(darknessAlpha(1000, 1000 + NOIR_FADE_MS * 3)).toBe(NOIR_DARK_ALPHA);
  });
});

describe('etape 16 : DarknessRenderer — le cout d une image', () => {
  function dessine(event: EventView | null, nowMs: number): Graphics {
    const r = new DarknessRenderer();
    const monde = new Container();
    r.attach(monde);
    r.load();
    r.draw(event, joueurs, new Rectangle(0, 0, 800, 600), nowMs);
    return monde.children[0] as Graphics;
  }
  const remplissages = (g: Graphics): number[] =>
    g.context.instructions
      .filter((i) => i.action === 'fill')
      .map((i) => (i.data as { style: { alpha: number } }).style.alpha);

  it('cinq remplissages : le voile, puis quatre anneaux de plus en plus sombres vers le dehors', () => {
    const g = dessine(noir, 1000 + NOIR_FADE_MS);
    const alphas = remplissages(g);
    expect(alphas).toHaveLength(5);
    expect(alphas[0]).toBeCloseTo(NOIR_DARK_ALPHA, 6);
    expect(alphas.slice(1).map((a) => a / NOIR_DARK_ALPHA)).toEqual([
      expect.closeTo(0.2, 6),
      expect.closeTo(0.4, 6),
      expect.closeTo(0.6, 6),
      expect.closeTo(0.8, 6),
    ]);
    // Ni filtre, ni masque. `Graphics.mask` par defaut est `undefined` en
    // Pixi 8, pas `null` : le brief le supposait `null` (ecart, repli au
    // meme patron que `filters` juste au-dessus).
    expect(g.filters ?? []).toHaveLength(0);
    expect(g.mask ?? null).toBeNull();
  });

  it('rien hors noir ; rien avant le premier etat ; un seul voile sans porteur', () => {
    expect(remplissages(dessine(null, 5000))).toEqual([]);
    expect(remplissages(dessine({ ...noir, carrierId: 0 }, 5000))).toEqual([]);
    expect(remplissages(dessine({ ...noir, carrierId: 3 }, 5000))).toHaveLength(1);
  });
});
