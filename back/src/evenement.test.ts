import { FLOWFIELD_CELL, MAP_SIZE, TICK_HZ } from '@shared/constants';
import {
  CONVOI_ESCORT_RADIUS,
  EVENT_DURATION_TICKS,
  EVENT_KIND,
  EVENT_OUTCOME,
  FORGE_RADIUS,
  SCEAU_RADIUS,
} from '@shared/evenements';
import { FlowField } from '@shared/flowfield';
import { applyObstacles, generateObstacles } from '@shared/worldmap';
import { describe, expect, it } from 'vitest';

import {
  CONVOI_CONTACT_RADIUS,
  CONVOI_DISTANCE,
  CONVOI_HP,
  CONVOI_HP_SOLO,
  CONVOI_SPEED,
  EVENT_SPAWN_DISTANCE,
  type EventHorde,
  type EventPlan,
  type EventPlayer,
  EventRun,
  FORGE_HOLD_TICKS,
  FORGE_HOLD_TICKS_SOLO,
  placeEvent,
  SCEAUX_HOLD_TICKS,
  SCEAUX_SPACING,
} from './evenement';

const DT = 1 / TICK_HZ;

/** Une carte sans un mur : la geometrie seule. */
const ouvert = (): FlowField => new FlowField(MAP_SIZE, FLOWFIELD_CELL);

/** Une graine du genre voulu, a angle varie. */
function graine(genre: number, k: number): number {
  const s = (Math.imul(k + 1, 0x9e37_79b9) >>> 0) % 0xffff_fff0;
  return s - (s % 3) + genre;
}

function joueur(x: number, y: number, extra: Partial<EventPlayer> = {}): EventPlayer {
  return { x, y, hp: 100, moveX: 0, moveY: 0, ...extra };
}

function horde(points: readonly { x: number; y: number }[]): EventHorde {
  return {
    count: points.length,
    x: Float32Array.from(points.map((p) => p.x)),
    y: Float32Array.from(points.map((p) => p.y)),
  };
}
const PERSONNE = horde([]);

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** Une VRAIE carte generee (ile d'herbe dans l'eau) : `generateObstacles` + `applyObstacles`. */
function carteReelle(mapSeed: number): FlowField {
  const sonde = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
  const masque = generateObstacles(mapSeed, sonde.cols, sonde.rows);
  const champ = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
  applyObstacles(champ, masque);
  return champ;
}

/**
 * La cellule libre la plus proche de `(x, y)` en marchant vers le centre de
 * la carte, cellule par cellule — deterministe, bornee a `cols + rows` pas.
 * Sert a poser une EQUIPE de test sur la terre la plus proche d'un coin (qui,
 * lui, est toujours de l'eau sur une vraie carte).
 */
function terreProche(champ: FlowField, x: number, y: number): { x: number; y: number } {
  const pasX = x < MAP_SIZE / 2 ? 1 : -1;
  const pasY = y < MAP_SIZE / 2 ? 1 : -1;
  let cx = Math.floor(x / FLOWFIELD_CELL);
  let cy = Math.floor(y / FLOWFIELD_CELL);
  for (let i = 0; i < champ.cols + champ.rows; i++) {
    if (champ.blocked[cy * champ.cols + cx] === 0) {
      return { x: (cx + 0.5) * FLOWFIELD_CELL, y: (cy + 0.5) * FLOWFIELD_CELL };
    }
    cx = Math.max(0, Math.min(champ.cols - 1, cx + pasX));
    cy = Math.max(0, Math.min(champ.rows - 1, cy + pasY));
  }
  return { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
}

/** Fait `n` pas ; rend la premiere issue, ou `null`. */
function pas(
  run: EventRun,
  n: number,
  joueurs: readonly EventPlayer[],
  h = PERSONNE,
): number | null {
  for (let i = 0; i < n; i++) {
    const issue = run.step(joueurs, h, DT);
    if (issue !== null) {
      return issue;
    }
  }
  return null;
}

describe('etape 14 : placeEvent', () => {
  const equipe = [
    { x: 2900, y: 3000 },
    { x: 3100, y: 3000 },
  ];

  it('le genre est graine % 3', () => {
    for (let s = 0; s < 300; s++) {
      expect(placeEvent(s, equipe, ouvert()).kind).toBe(s % 3);
    }
  });

  it('le site est a EVENT_SPAWN_DISTANCE du CENTRE des vivants, dans la direction de la graine', () => {
    for (let k = 0; k < 200; k++) {
      const s = graine(EVENT_KIND.FORGE, k);
      const plan = placeEvent(s, equipe, ouvert());
      const theta = ((s >>> 8) / 0x100_0000) * Math.PI * 2;
      const site = plan.points[0] ?? { x: 0, y: 0 };
      expect(plan.points).toHaveLength(1);
      expect(
        Math.abs(site.x - (3000 + Math.cos(theta) * EVENT_SPAWN_DISTANCE)),
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(site.y - (3000 + Math.sin(theta) * EVENT_SPAWN_DISTANCE)),
      ).toBeLessThanOrEqual(0.5);
      expect(Number.isInteger(site.x) && Number.isInteger(site.y)).toBe(true);
    }
  });

  it('les sceaux : un en solo, N a SCEAUX_SPACING de leurs voisins pour N = 2, 3, 4', () => {
    expect(
      placeEvent(graine(EVENT_KIND.SCEAUX, 1), [{ x: 3000, y: 3000 }], ouvert()).points,
    ).toHaveLength(1);
    for (const n of [2, 3, 4]) {
      const vivants = Array.from({ length: n }, () => ({ x: 3000, y: 3000 }));
      for (let k = 0; k < 50; k++) {
        const plan = placeEvent(graine(EVENT_KIND.SCEAUX, k), vivants, ouvert());
        expect(plan.points).toHaveLength(n);
        expect(plan.solo).toBe(false);
        for (let i = 0; i < n; i++) {
          const a = plan.points[i] ?? { x: 0, y: 0 };
          const b = plan.points[(i + 1) % n] ?? { x: 0, y: 0 };
          expect(Math.abs(dist(a, b) - SCEAUX_SPACING)).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('pres d un coin : deux sceaux ne se touchent jamais, l anneau tient dans la carte', () => {
    const coins = [
      { x: 30, y: 30 },
      { x: MAP_SIZE - 30, y: 30 },
      { x: 30, y: MAP_SIZE - 30 },
      { x: MAP_SIZE - 30, y: MAP_SIZE - 30 },
      { x: 600, y: 600 },
      { x: 1000, y: 300 },
    ];
    for (const centre of coins) {
      for (const n of [2, 3, 4]) {
        const vivants = Array.from({ length: n }, () => centre);
        for (let k = 0; k < 200; k++) {
          const plan = placeEvent(graine(EVENT_KIND.SCEAUX, k), vivants, ouvert());
          expect(plan.points).toHaveLength(n);
          for (const p of plan.points) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(MAP_SIZE);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThanOrEqual(MAP_SIZE);
          }
          for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
              const a = plan.points[i] ?? { x: 0, y: 0 };
              const b = plan.points[j] ?? { x: 0, y: 0 };
              expect(dist(a, b)).toBeGreaterThan(2 * SCEAU_RADIUS);
            }
          }
        }
      }
    }
  });

  it('le convoi : depart au site, arrivee a CONVOI_DISTANCE vers le centre de la carte, et dans la carte', () => {
    for (const centre of [
      { x: 3000, y: 3000 },
      { x: 50, y: 50 },
      { x: 5950, y: 120 },
    ]) {
      for (let k = 0; k < 100; k++) {
        const plan = placeEvent(graine(EVENT_KIND.CONVOI, k), [centre], ouvert());
        const [s, e] = plan.points;
        if (!s || !e) {
          throw new Error('le convoi a deux points');
        }
        expect(Math.abs(dist(s, e) - CONVOI_DISTANCE)).toBeLessThanOrEqual(1);
        // Vers le centre : E est plus pres du milieu de la carte que S.
        expect(dist(e, { x: MAP_SIZE / 2, y: MAP_SIZE / 2 })).toBeLessThan(
          dist(s, { x: MAP_SIZE / 2, y: MAP_SIZE / 2 }) + 1,
        );
      }
    }
  });

  it('pres d un coin : chaque point dans la carte, entier (il voyage en int16)', () => {
    for (let s = 0; s < 300; s++) {
      for (const p of placeEvent(
        s,
        [
          { x: 30, y: 30 },
          { x: 60, y: 10 },
        ],
        ouvert(),
      ).points) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(MAP_SIZE);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(MAP_SIZE);
        expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
      }
    }
  });

  it('un site mure est sorti du mur, dans une cellule libre toute proche', () => {
    const s = graine(EVENT_KIND.FORGE, 7);
    const libre = placeEvent(s, equipe, ouvert()).points[0] ?? { x: 0, y: 0 };
    const mure = ouvert();
    mure.block(Math.floor(libre.x / FLOWFIELD_CELL), Math.floor(libre.y / FLOWFIELD_CELL));
    const sorti = placeEvent(s, equipe, mure).points[0] ?? { x: 0, y: 0 };
    expect(mure.blocked[mure.indexAt(sorti.x, sorti.y)]).toBe(0);
    expect(dist(sorti, libre)).toBeLessThanOrEqual(3 * FLOWFIELD_CELL);
  });

  it('sur une VRAIE carte (ile generee, cotes et coins en eau) : les sceaux restent sur la terre, jamais colles', () => {
    const coinsBruts = [
      { x: 100, y: 100 },
      { x: MAP_SIZE - 100, y: 100 },
      { x: 100, y: MAP_SIZE - 100 },
      { x: MAP_SIZE - 100, y: MAP_SIZE - 100 },
    ];
    const interieurBrut = [
      { x: MAP_SIZE / 2, y: MAP_SIZE / 2 },
      { x: 2000, y: 2000 },
    ];
    for (let mapSeed = 1; mapSeed <= 4; mapSeed++) {
      const champ = carteReelle(mapSeed);
      const centres = [...coinsBruts, ...interieurBrut].map((c) => terreProche(champ, c.x, c.y));
      for (const centre of centres) {
        for (const n of [1, 2, 3, 4]) {
          const vivants = Array.from({ length: n }, () => centre);
          for (let k = 0; k < 150; k++) {
            const plan = placeEvent(graine(EVENT_KIND.SCEAUX, k), vivants, champ);
            expect(plan.points).toHaveLength(n);
            for (const p of plan.points) {
              const cx = Math.floor(p.x / FLOWFIELD_CELL);
              const cy = Math.floor(p.y / FLOWFIELD_CELL);
              expect(champ.blocked[cy * champ.cols + cx]).toBe(0);
            }
            for (let i = 0; i < n; i++) {
              for (let j = i + 1; j < n; j++) {
                const a = plan.points[i] ?? { x: 0, y: 0 };
                const b = plan.points[j] ?? { x: 0, y: 0 };
                expect(dist(a, b)).toBeGreaterThan(2 * SCEAU_RADIUS);
              }
            }
          }
        }
      }
    }
  });

  it('sans vivant, le plan reste defini (jamais NaN) — le salon ne l appelle pas, mais rien ne casse', () => {
    for (const p of placeEvent(graine(EVENT_KIND.SCEAUX, 3), [], ouvert()).points) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe('etape 14 : EventRun — les trois sceaux', () => {
  const plan: EventPlan = {
    kind: EVENT_KIND.SCEAUX,
    points: [
      { x: 1000, y: 1000 },
      { x: 1800, y: 1000 },
    ],
    solo: false,
  };

  it('tous tenus, ca avance ; un vide SUSPEND sans remettre a zero', () => {
    const run = new EventRun(plan, ouvert());
    const a = joueur(1000, 1000 + SCEAU_RADIUS);
    const b = joueur(1800, 1000);
    expect(pas(run, SCEAUX_HOLD_TICKS / 2, [a, b])).toBeNull();
    expect(run.progress).toBeCloseTo(0.5, 5);
    // B quitte son sceau : rien ne bouge, rien ne redescend.
    expect(pas(run, 100, [a, joueur(2500, 1000)])).toBeNull();
    expect(run.progress).toBeCloseTo(0.5, 5);
    expect(pas(run, SCEAUX_HOLD_TICKS / 2, [a, b])).toBe(EVENT_OUTCOME.REUSSI);
    expect(run.progress).toBe(1);
  });

  it('un mort n occupe pas ; deux joueurs dans le meme sceau n en valent qu un', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 60, [joueur(1000, 1000), joueur(1800, 1000, { hp: 0 })]);
    pas(run, 60, [joueur(1000, 1000), joueur(1010, 1000)]);
    expect(run.progress).toBe(0);
  });

  it('s eteint a EVENT_DURATION_TICKS ticks, pas un de moins', () => {
    const run = new EventRun(plan, ouvert());
    expect(pas(run, EVENT_DURATION_TICKS - 1, [])).toBeNull();
    expect(run.step([], PERSONNE, DT)).toBe(EVENT_OUTCOME.EXPIRE);
  });

  it('wireState : progression floor(255 x fraction), zeros hors convoi', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, SCEAUX_HOLD_TICKS / 2, [joueur(1000, 1000), joueur(1800, 1000)]);
    expect(run.wireState()).toEqual({ progress: 127, cartX: 0, cartY: 0, cartHp: 0 });
  });
});

describe('etape 14 : EventRun — la forge', () => {
  const forge = { x: 2000, y: 2000 };
  const duo: EventPlan = { kind: EVENT_KIND.FORGE, points: [forge], solo: false };
  const solo: EventPlan = { ...duo, solo: true };

  it('immobile dans le rayon : 30 s a plusieurs, 15 s seul', () => {
    expect(
      pas(new EventRun(duo, ouvert()), FORGE_HOLD_TICKS - 1, [joueur(2000, 2000 + FORGE_RADIUS)]),
    ).toBeNull();
    const run = new EventRun(duo, ouvert());
    expect(pas(run, FORGE_HOLD_TICKS, [joueur(2000, 2000)])).toBe(EVENT_OUTCOME.REUSSI);
    expect(pas(new EventRun(solo, ouvert()), FORGE_HOLD_TICKS_SOLO, [joueur(2000, 2000)])).toBe(
      EVENT_OUTCOME.REUSSI,
    );
  });

  it('immobile se lit sur l ENTREE : moveX 0,2 suspend, une derive de stick sous 20 px/s non', () => {
    const run = new EventRun(duo, ouvert());
    pas(run, 90, [joueur(2000, 2000, { moveX: 0.2 })]);
    expect(run.progress).toBe(0);
    pas(run, 90, [joueur(2000, 2000, { moveX: 0.07 })]);
    expect(run.progress).toBeCloseTo(90 / FORGE_HOLD_TICKS, 5);
  });

  it('pousse sans entree (un gardien, la horde), il canalise encore', () => {
    const run = new EventRun(duo, ouvert());
    for (let i = 0; i < 60; i++) {
      run.step([joueur(2000 + (i % 40), 2000)], PERSONNE, DT);
    }
    expect(run.progress).toBeCloseTo(60 / FORGE_HOLD_TICKS, 5);
  });

  it('hors du rayon, ou mort, rien', () => {
    const run = new EventRun(duo, ouvert());
    pas(run, 60, [joueur(2000 + FORGE_RADIUS + 1, 2000), joueur(2000, 2000, { hp: 0 })]);
    expect(run.progress).toBe(0);
  });
});

describe('etape 14 : EventRun — le convoi', () => {
  const S = { x: 1000, y: 3000 };
  const E = { x: 1000 + CONVOI_DISTANCE, y: 3000 };
  const plan: EventPlan = { kind: EVENT_KIND.CONVOI, points: [S, E], solo: false };

  it('sans escorte il attend ; escorte, il avance de CONVOI_SPEED px/s', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 30, [joueur(S.x, S.y + CONVOI_ESCORT_RADIUS + 1)]);
    expect(run.cart).toEqual(S);
    pas(run, 30, [joueur(S.x, S.y + 100)]);
    // Le champ melange ses cellules voisines : le pas fait 2 px, la route n'est pas une regle.
    expect(dist(run.cart, S)).toBeCloseTo(CONVOI_SPEED, 0);
    expect(run.cart.x).toBeGreaterThan(S.x);
  });

  it('escorte jusqu au bout : reussi a l arrivee, progression 1', () => {
    const run = new EventRun(plan, ouvert());
    let issue: number | null = null;
    for (let t = 0; t < EVENT_DURATION_TICKS && issue === null; t++) {
      issue = run.step([joueur(run.cart.x, run.cart.y)], PERSONNE, DT);
    }
    expect(issue).toBe(EVENT_OUTCOME.REUSSI);
    expect(run.progress).toBe(1);
    // 1 500 px a 60 px/s : 25 s au mieux ; le melange du champ peut allonger un peu la route.
    expect(run.elapsed).toBeLessThanOrEqual(30 * TICK_HZ);
  });

  /**
   * ⚠️ **Un mur EN TRAVERS** : la ligne droite le traverse, `moveOnMap` seul
   * collerait le chariot contre lui. Le champ de flux le fait contourner, et
   * `moveOnMap` l'empeche d'y entrer.
   */
  it('contourne un mur en travers de la route, sans jamais y entrer', () => {
    const terrain = ouvert();
    for (let cx = 27; cx <= 28; cx++) {
      for (let cy = 39; cy <= 54; cy++) {
        terrain.block(cx, cy);
      }
    }
    const run = new EventRun(plan, terrain);
    let issue: number | null = null;
    for (let t = 0; t < EVENT_DURATION_TICKS && issue === null; t++) {
      issue = run.step([joueur(run.cart.x, run.cart.y)], PERSONNE, DT);
      expect(terrain.blocked[terrain.indexAt(run.cart.x, run.cart.y)]).toBe(0);
    }
    expect(issue).toBe(EVENT_OUTCOME.REUSSI);
  });

  it('cinq ennemis colles ou cinquante coutent pareil : 5 x 8 PV toutes les 15 ticks', () => {
    const cinq = new EventRun(plan, ouvert());
    pas(cinq, 15, [], horde(Array.from({ length: 5 }, () => S)));
    const cinquante = new EventRun(plan, ouvert());
    pas(cinquante, 15, [], horde(Array.from({ length: 50 }, () => S)));
    const un = new EventRun(plan, ouvert());
    pas(un, 15, [], horde([{ x: S.x + CONVOI_CONTACT_RADIUS, y: S.y }]));
    expect(cinq.cartHp).toBe(CONVOI_HP - 40);
    expect(cinquante.cartHp).toBe(CONVOI_HP - 40);
    expect(un.cartHp).toBe(CONVOI_HP - 8);
    // Juste hors de portee : rien.
    const loin = new EventRun(plan, ouvert());
    pas(loin, 15, [], horde([{ x: S.x + CONVOI_CONTACT_RADIUS + 1, y: S.y }]));
    expect(loin.cartHp).toBe(CONVOI_HP);
  });

  it('detruit a 0 PV : 400 PV sous cinq ennemis, au 150e tick', () => {
    const run = new EventRun(plan, ouvert());
    const cinq = horde(Array.from({ length: 5 }, () => S));
    expect(pas(run, 149, [], cinq)).toBeNull();
    expect(run.step([], cinq, DT)).toBe(EVENT_OUTCOME.DETRUIT);
    expect(run.cartHp).toBe(0);
  });

  it('en solo : CONVOI_HP_SOLO PV, meme vitesse', () => {
    const run = new EventRun({ ...plan, solo: true }, ouvert());
    expect(run.cartHpMax).toBe(CONVOI_HP_SOLO);
    expect(pas(run, 150, [], horde(Array.from({ length: 5 }, () => S)))).toBeNull();
    expect(run.cartHp).toBe(CONVOI_HP_SOLO - 400);
  });

  it('wireState : la position arrondie et les PV en ceil(255 x pv / pvMax)', () => {
    const run = new EventRun(plan, ouvert());
    expect(run.wireState()).toEqual({ progress: 0, cartX: S.x, cartY: S.y, cartHp: 255 });
    pas(run, 15, [], horde([S]));
    expect(run.wireState().cartHp).toBe(Math.ceil((255 * (CONVOI_HP - 8)) / CONVOI_HP));
  });
});
