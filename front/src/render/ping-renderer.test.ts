import { EVENT_KIND } from '@shared/evenements';
import { PING_LIFE_TICKS } from '@shared/ping';
import { Container, type Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import type { ActivePing, EventView } from '../net/client';
import { COIN_TINT } from './orb-renderer';
import { allyArrowScale, edgeArrow, livePings, PingRenderer } from './ping-renderer';

const ping = (playerId: number, tick: number): ActivePing => ({
  playerId,
  intent: 0,
  x: 10,
  y: 20,
  tick,
});

describe('livePings : la vie d un ping se compte en ticks de horde', () => {
  it('vivant de sa reception a PING_LIFE_TICKS exclus', () => {
    const m = new Map([[2, ping(2, 100)]]);
    expect(livePings(m, 100)).toHaveLength(1);
    expect(livePings(m, 100 + PING_LIFE_TICKS - 1)).toHaveLength(1);
    expect(livePings(m, 100 + PING_LIFE_TICKS)).toHaveLength(0);
  });

  /**
   * ⚠️ Ce test verifie seulement que `livePings` est une fonction PURE du
   * tick qu'on lui passe : appele deux fois avec le meme tick, meme resultat.
   * `livePings` ne connait rien du gel — c'est l'appelant qui, en lui passant
   * `GameClient#pingClock` plutot que `hordeTick`, fait qu'un tick immobile
   * correspond au gel de niveau (revue finale, etape 9).
   */
  it('un tick immobile donne le meme resultat (c est pingClock, pas livePings, qui fige pendant le gel)', () => {
    const m = new Map([[2, ping(2, 100)]]);
    const a = livePings(m, 130);
    const b = livePings(m, 130);
    expect(a).toEqual(b);
    expect(a[0]?.alpha).toBe(1);
  });

  it('l onde s elargit, et le ping s efface dans son dernier quart', () => {
    const m = new Map([[2, ping(2, 0)]]);
    // L'onde repart toutes les 30 ticks : on la compare a l'interieur d'un cycle.
    const debut = livePings(m, 0)[0];
    const plusTard = livePings(m, 15)[0];
    const milieu = livePings(m, PING_LIFE_TICKS / 2)[0];
    const fin = livePings(m, PING_LIFE_TICKS - 1)[0];
    expect(debut?.wave).toBeLessThan(plusTard?.wave ?? 0);
    expect(milieu?.alpha).toBe(1);
    expect(fin?.alpha).toBeLessThan(0.2);
  });

  it('un ping date du futur (annonce arrivee avant le tick local) ne s affiche pas encore', () => {
    expect(livePings(new Map([[2, ping(2, 50)]]), 49)).toHaveLength(0);
  });
});

describe('edgeArrow : une fleche collee au bord, vers la cible', () => {
  const W = 800;
  const H = 600;
  const M = 30;

  it('cible dans le champ : pas de fleche', () => {
    expect(edgeArrow(W, H, 400, 300, M)).toBeNull();
    expect(edgeArrow(W, H, W - M, H - M, M)).toBeNull();
  });

  it('cible loin a droite : sur le bord droit, a la hauteur du centre, angle 0', () => {
    expect(edgeArrow(W, H, 5000, 300, M)).toEqual({ x: W - M, y: 300, angle: 0 });
  });

  it('cible loin en haut : sur le bord haut, angle -pi/2', () => {
    const a = edgeArrow(W, H, 400, -5000, M);
    expect(a?.x).toBeCloseTo(400);
    expect(a?.y).toBeCloseTo(M);
    expect(a?.angle).toBeCloseTo(-Math.PI / 2);
  });

  it('cible en diagonale : le point reste dans le rectangle marge comprise', () => {
    const a = edgeArrow(W, H, -3000, 4000, M);
    expect(a).not.toBeNull();
    expect(a?.x).toBeGreaterThanOrEqual(M - 1e-9);
    expect(a?.x).toBeLessThanOrEqual(W - M + 1e-9);
    expect(a?.y).toBeGreaterThanOrEqual(M - 1e-9);
    expect(a?.y).toBeLessThanOrEqual(H - M + 1e-9);
    expect(Math.atan2(4000 - 300, -3000 - 400)).toBeCloseTo(a?.angle ?? 0);
  });
});

describe('allyArrowScale : la fleche d un allie retrecit avec la distance', () => {
  it('pleine pres, plancher loin, decroissante entre les deux', () => {
    expect(allyArrowScale(0)).toBe(1);
    expect(allyArrowScale(100_000)).toBe(0.5);
    expect(allyArrowScale(1000)).toBeGreaterThan(allyArrowScale(2000));
  });
});

describe('etape 11 : la fleche du porteur', () => {
  /** Les remplissages OR poses sur le calque ECRAN par un `draw` sans ping ni allie. */
  function remplissagesOr(porteur: { x: number; y: number } | null): number {
    const r = new PingRenderer(() => 0xffffff);
    const ecran = new Container();
    r.attachScreen(ecran);
    r.draw([], [], (x, y) => ({ x, y }), 800, 600, porteur);
    const g = ecran.children[0] as Graphics;
    return g.context.instructions.filter(
      (i) =>
        i.action === 'fill' && (i.data as { style: { color: number } }).style.color === COIN_TINT,
    ).length;
  }

  it('une fleche or, au bord, pour un porteur hors champ', () => {
    expect(remplissagesOr({ x: 5000, y: 300 })).toBeGreaterThan(0);
  });

  it('rien pour un porteur dans le champ, rien sans porteur', () => {
    expect(remplissagesOr({ x: 400, y: 300 })).toBe(0);
    expect(remplissagesOr(null)).toBe(0);
  });
});

describe('etape 14 : les fleches d un evenement', () => {
  /** Les remplissages OR du calque ECRAN par un `draw` sans ping, sans allie ni porteur. */
  function flechesOr(event: EventView | null): number {
    const r = new PingRenderer(() => 0xffffff);
    const ecran = new Container();
    r.attachScreen(ecran);
    r.draw([], [], (x, y) => ({ x, y }), 800, 600, null, event);
    const g = ecran.children[0] as Graphics;
    return g.context.instructions.filter(
      (i) =>
        i.action === 'fill' && (i.data as { style: { color: number } }).style.color === COIN_TINT,
    ).length;
  }
  const base = { progress: 0, secondsLeft: 60, cart: null, cartHp: 1 };

  it('une fleche or par sceau HORS champ, aucune pour un sceau dans le champ', () => {
    expect(
      flechesOr({
        ...base,
        kind: EVENT_KIND.SCEAUX,
        points: [
          { x: 5000, y: 300 },
          { x: -900, y: 300 },
          { x: 400, y: 300 },
        ],
      }),
    ).toBe(2);
  });

  it('la forge hors champ : une fleche', () => {
    expect(flechesOr({ ...base, kind: EVENT_KIND.FORGE, points: [{ x: 400, y: 4000 }] })).toBe(1);
  });

  it('le convoi : une fleche vers le CHARIOT hors champ, jamais vers l arrivee', () => {
    const convoi = {
      ...base,
      kind: EVENT_KIND.CONVOI,
      points: [
        { x: 400, y: 300 },
        { x: 5000, y: 300 },
      ],
    };
    expect(flechesOr({ ...convoi, cart: { x: 400, y: 300 } })).toBe(0);
    expect(flechesOr({ ...convoi, cart: { x: 5000, y: 5000 } })).toBe(1);
  });

  it('rien sans evenement', () => {
    expect(flechesOr(null)).toBe(0);
  });
});
