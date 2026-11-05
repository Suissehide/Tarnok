import { FLOWFIELD_CELL, MAP_SIZE, TICK_HZ } from '@shared/constants';
import {
  CONVOI_ESCORT_RADIUS,
  EVENT_DURATION_TICKS,
  EVENT_KIND,
  EVENT_KIND_COUNT,
  EVENT_OUTCOME,
  FORGE_RADIUS,
  NOIR_LIGHT_RADIUS,
  RELIQUE_ALTAR_RADIUS,
  SCEAU_RADIUS,
  SIEGE_DEFEND_RADIUS,
} from '@shared/evenements';
import { FlowField } from '@shared/flowfield';
import { applyObstacles, generateObstacles } from '@shared/worldmap';
import { describe, expect, it } from 'vitest';

import {
  CHASSE_PREY,
  CHASSE_PREY_SOLO,
  CHASSE_SPACING,
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
  NOIR_DRAIN_PER_SEC,
  NOIR_HOLD_TICKS,
  placeEvent,
  RELIQUE_DISTANCE,
  RELIQUE_PICKUP_RADIUS,
  SCEAUX_HOLD_TICKS,
  SCEAUX_SPACING,
  SIEGE_CONTACT_RADIUS,
  SIEGE_HOLD_TICKS,
  SIEGE_HP,
  SIEGE_HP_SOLO,
} from './evenement';

const DT = 1 / TICK_HZ;

/** Une carte sans un mur : la geometrie seule. */
const ouvert = (): FlowField => new FlowField(MAP_SIZE, FLOWFIELD_CELL);

/** Une graine du genre voulu, a angle varie : le genre est `graine % EVENT_KIND_COUNT`. */
function graine(genre: number, k: number): number {
  const s = (Math.imul(k + 1, 0x9e37_79b9) >>> 0) % 0xffff_fff0;
  return s - (s % EVENT_KIND_COUNT) + genre;
}

/** Des vivants avec leur identifiant (1, 2, ...) : `placeEvent` les lit depuis l'etape 16. */
const ids = (pts: readonly { x: number; y: number }[]): { id: number; x: number; y: number }[] =>
  pts.map((p, k) => ({ id: k + 1, x: p.x, y: p.y }));

function joueur(x: number, y: number, extra: Partial<EventPlayer> = {}): EventPlayer {
  return { id: 1, x, y, hp: 100, moveX: 0, moveY: 0, ...extra };
}

/** Une horde de test ; `vivantes` : les identites encore presentes (`slotOf >= 0`). */
function horde(
  points: readonly { x: number; y: number }[],
  vivantes: ReadonlySet<number> = new Set(),
): EventHorde {
  return {
    count: points.length,
    x: Float32Array.from(points.map((p) => p.x)),
    y: Float32Array.from(points.map((p) => p.y)),
    slotOf: (id: number) => (vivantes.has(id) ? 0 : -1),
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

const equipe = [
  { id: 1, x: 2900, y: 3000 },
  { id: 2, x: 3100, y: 3000 },
];

describe('etape 14 : placeEvent', () => {
  it('le genre est graine % 7, sans tirage : la meme graine rend le meme plan', () => {
    for (let s = 0; s < 700; s++) {
      const plan = placeEvent(s, equipe, ouvert());
      expect(plan.kind).toBe(s % EVENT_KIND_COUNT);
      expect(placeEvent(s, equipe, ouvert())).toEqual(plan);
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
      placeEvent(graine(EVENT_KIND.SCEAUX, 1), ids([{ x: 3000, y: 3000 }]), ouvert()).points,
    ).toHaveLength(1);
    for (const n of [2, 3, 4]) {
      const vivants = ids(Array.from({ length: n }, () => ({ x: 3000, y: 3000 })));
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
        const vivants = ids(Array.from({ length: n }, () => centre));
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
        const plan = placeEvent(graine(EVENT_KIND.CONVOI, k), ids([centre]), ouvert());
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
        ids([
          { x: 30, y: 30 },
          { x: 60, y: 10 },
        ]),
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
          const vivants = ids(Array.from({ length: n }, () => centre));
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
    for (const p of placeEvent(graine(EVENT_KIND.SCEAUX, 3), ids([]), ouvert()).points) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe('etape 16 : placeEvent — siege, relique, chasse, noir', () => {
  const centre = { x: 3000, y: 3000 };

  it('le siege : un totem, a EVENT_SPAWN_DISTANCE du centre des vivants, comme la forge', () => {
    for (let k = 0; k < 100; k++) {
      const s = graine(EVENT_KIND.SIEGE, k);
      const plan = placeEvent(s, equipe, ouvert());
      expect(plan.points).toHaveLength(1);
      expect(plan.carrier).toBe(0);
      const t = plan.points[0] ?? { x: 0, y: 0 };
      expect(Math.abs(dist(t, centre) - EVENT_SPAWN_DISTANCE)).toBeLessThanOrEqual(1);
      expect(Number.isInteger(t.x) && Number.isInteger(t.y)).toBe(true);
    }
  });

  it('la relique : la relique au site, l autel a RELIQUE_DISTANCE vers le centre de la carte', () => {
    for (const c of [centre, { x: 50, y: 50 }, { x: 5950, y: 120 }]) {
      for (let k = 0; k < 100; k++) {
        const plan = placeEvent(graine(EVENT_KIND.RELIQUE, k), ids([c]), ouvert());
        const [s, e] = plan.points;
        if (!s || !e) {
          throw new Error('la relique a deux points');
        }
        expect(Math.abs(dist(s, e) - RELIQUE_DISTANCE)).toBeLessThanOrEqual(1);
        const milieu = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
        expect(dist(e, milieu)).toBeLessThan(dist(s, milieu) + 1);
        expect(plan.carrier).toBe(0);
      }
    }
  });

  it('la chasse : 3 lieux a CHASSE_SPACING (rayon 693 px), 2 en solo (600 px)', () => {
    for (const [vivants, n] of [
      [equipe, CHASSE_PREY],
      [ids([centre]), CHASSE_PREY_SOLO],
    ] as const) {
      for (let k = 0; k < 50; k++) {
        const plan = placeEvent(graine(EVENT_KIND.CHASSE, k), vivants, ouvert());
        expect(plan.points).toHaveLength(n);
        for (let i = 0; i < n; i++) {
          const a = plan.points[i] ?? { x: 0, y: 0 };
          const b = plan.points[(i + 1) % n] ?? { x: 0, y: 0 };
          expect(Math.abs(dist(a, b) - CHASSE_SPACING)).toBeLessThanOrEqual(2);
        }
      }
    }
    // Les rayons de la spec, ecrits nus.
    expect(Math.round(CHASSE_SPACING / (2 * Math.sin(Math.PI / 3)))).toBe(693);
    expect(Math.round(CHASSE_SPACING / (2 * Math.sin(Math.PI / 2)))).toBe(600);
  });

  it('le noir : aucun point, le porteur de lanterne derive de la graine, sans tirage', () => {
    const quatre = ids([centre, centre, centre, centre]);
    const vus = new Set<number>();
    for (let k = 0; k < 400; k++) {
      const s = graine(EVENT_KIND.NOIR, k);
      const plan = placeEvent(s, quatre, ouvert());
      expect(plan.points).toEqual([]);
      const attendu = quatre[Math.floor(((s >>> 8) / 0x100_0000) * quatre.length)]?.id;
      expect(plan.carrier).toBe(attendu);
      vus.add(plan.carrier);
    }
    // Chaque joueur porte la lanterne un jour : la fraction couvre [0, 1).
    expect([...vus].sort()).toEqual([1, 2, 3, 4]);
    // Seul : le seul vivant ; personne : 0, jamais d'indice hors tableau.
    expect(placeEvent(graine(EVENT_KIND.NOIR, 1), [{ id: 3, x: 1, y: 1 }], ouvert()).carrier).toBe(
      3,
    );
    expect(placeEvent(graine(EVENT_KIND.NOIR, 1), [], ouvert()).carrier).toBe(0);
  });

  it('les trois genres de l etape 14 ne portent pas de porteur', () => {
    for (const genre of [EVENT_KIND.SCEAUX, EVENT_KIND.FORGE, EVENT_KIND.CONVOI]) {
      expect(placeEvent(graine(genre, 2), equipe, ouvert()).carrier).toBe(0);
    }
  });

  /**
   * ⚠️ **La lecon de l'etape 14** : sur un champ ouvert tout passe ; sur une
   * VRAIE ile (cotes en eau), un site pres d'un coin tombe a l'eau si
   * `poserGroupe` ne recentre pas. Memes cartes et memes centres que le test
   * des sceaux.
   */
  it('sur une VRAIE carte : totem, relique, autel et proies sur la terre, dans la carte, entiers ; proies jamais collees', () => {
    const bruts = [
      { x: 100, y: 100 },
      { x: MAP_SIZE - 100, y: 100 },
      { x: 100, y: MAP_SIZE - 100 },
      { x: MAP_SIZE - 100, y: MAP_SIZE - 100 },
      { x: MAP_SIZE / 2, y: MAP_SIZE / 2 },
      { x: 2000, y: 2000 },
    ];
    for (let mapSeed = 1; mapSeed <= 4; mapSeed++) {
      const champ = carteReelle(mapSeed);
      for (const c of bruts.map((b) => terreProche(champ, b.x, b.y))) {
        for (const n of [1, 2, 4]) {
          const vivants = ids(Array.from({ length: n }, () => c));
          for (const genre of [EVENT_KIND.SIEGE, EVENT_KIND.RELIQUE, EVENT_KIND.CHASSE]) {
            for (let k = 0; k < 60; k++) {
              const plan = placeEvent(graine(genre, k), vivants, champ);
              for (const p of plan.points) {
                expect(p.x).toBeGreaterThanOrEqual(0);
                expect(p.x).toBeLessThanOrEqual(MAP_SIZE);
                expect(p.y).toBeGreaterThanOrEqual(0);
                expect(p.y).toBeLessThanOrEqual(MAP_SIZE);
                expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
                expect(champ.blocked[champ.indexAt(p.x, p.y)]).toBe(0);
              }
              if (genre === EVENT_KIND.CHASSE) {
                for (let i = 0; i < plan.points.length; i++) {
                  for (let j = i + 1; j < plan.points.length; j++) {
                    const a = plan.points[i] ?? { x: 0, y: 0 };
                    const b = plan.points[j] ?? { x: 0, y: 0 };
                    expect(dist(a, b)).toBeGreaterThan(2 * SCEAU_RADIUS);
                  }
                }
              }
            }
          }
        }
      }
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
    carrier: 0,
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
  const duo: EventPlan = { kind: EVENT_KIND.FORGE, points: [forge], solo: false, carrier: 0 };
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
  const plan: EventPlan = { kind: EVENT_KIND.CONVOI, points: [S, E], solo: false, carrier: 0 };

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

describe('etape 16 : EventRun — le siege', () => {
  const T = { x: 2000, y: 2000 };
  const plan: EventPlan = { kind: EVENT_KIND.SIEGE, points: [T], solo: false, carrier: 0 };

  it('un defenseur a 150 px fait monter ; personne suspend sans redescendre', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 90, [joueur(T.x + SIEGE_DEFEND_RADIUS, T.y)]);
    expect(run.progress).toBeCloseTo(90 / SIEGE_HOLD_TICKS, 6);
    pas(run, 90, [joueur(T.x + SIEGE_DEFEND_RADIUS + 1, T.y), joueur(T.x, T.y, { hp: 0 })]);
    expect(run.progress).toBeCloseTo(90 / SIEGE_HOLD_TICKS, 6);
  });

  it('cinq ennemis colles coutent 40 PV par 15 ticks, cinquante pas plus ; juste hors de 45 px rien', () => {
    expect(SIEGE_CONTACT_RADIUS).toBe(45);
    const cinq = new EventRun(plan, ouvert());
    pas(cinq, 15, [], horde(Array.from({ length: 5 }, () => T)));
    expect(cinq.cartHp).toBe(SIEGE_HP - 40);
    const cinquante = new EventRun(plan, ouvert());
    pas(cinquante, 15, [], horde(Array.from({ length: 50 }, () => T)));
    expect(cinquante.cartHp).toBe(SIEGE_HP - 40);
    const loin = new EventRun(plan, ouvert());
    pas(loin, 15, [], horde([{ x: T.x + SIEGE_CONTACT_RADIUS + 1, y: T.y }]));
    expect(loin.cartHp).toBe(SIEGE_HP);
  });

  it('detruit a 0 PV : 600 PV sous cinq ennemis au 225e tick ; 1 200 en solo', () => {
    const run = new EventRun(plan, ouvert());
    const cinq = horde(Array.from({ length: 5 }, () => T));
    expect(pas(run, 224, [], cinq)).toBeNull();
    expect(run.step([], cinq, DT)).toBe(EVENT_OUTCOME.DETRUIT);
    const seul = new EventRun({ ...plan, solo: true }, ouvert());
    expect(seul.cartHpMax).toBe(SIEGE_HP_SOLO);
    expect(pas(seul, 225, [], cinq)).toBeNull();
    expect(seul.cartHp).toBe(SIEGE_HP_SOLO - 600);
  });

  it('reussi a 1 350 ticks tenus ; wireState porte les PV du totem et zero position', () => {
    const run = new EventRun(plan, ouvert());
    expect(pas(run, SIEGE_HOLD_TICKS - 1, [joueur(T.x, T.y)])).toBeNull();
    expect(run.step([joueur(T.x, T.y)], PERSONNE, DT)).toBe(EVENT_OUTCOME.REUSSI);
    const etat = new EventRun(plan, ouvert());
    pas(etat, 15, [], horde([T]));
    expect(etat.wireState()).toEqual({
      progress: 0,
      cartX: 0,
      cartY: 0,
      cartHp: Math.ceil((255 * (SIEGE_HP - 8)) / SIEGE_HP),
    });
  });
});

describe('etape 16 : EventRun — la relique', () => {
  const S = { x: 1000, y: 3000 };
  const E = { x: 2500, y: 3000 };
  const plan: EventPlan = { kind: EVENT_KIND.RELIQUE, points: [S, E], solo: false, carrier: 0 };

  it('ramassage a 48 px par le PREMIER vivant dans l ordre ; un mort ne ramasse pas', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 1, [joueur(S.x + RELIQUE_PICKUP_RADIUS + 1, S.y, { id: 2 })]);
    expect(run.carrier).toBe(0);
    pas(run, 1, [
      joueur(S.x, S.y, { id: 3, hp: 0 }),
      joueur(S.x + RELIQUE_PICKUP_RADIUS, S.y, { id: 2 }),
      joueur(S.x, S.y, { id: 4 }),
    ]);
    expect(run.carrier).toBe(2);
  });

  it('elle suit son porteur, arrondie ; sa mort la laisse au sol a sa derniere position ; un autre la reprend', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 1, [joueur(S.x, S.y, { id: 1 })]);
    pas(run, 1, [joueur(1300.4, 3010.6, { id: 1 })]);
    expect(run.cart).toEqual({ x: 1300, y: 3011 });
    pas(run, 1, [joueur(1400, 3000, { id: 1, hp: 0 }), joueur(5000, 5000, { id: 2 })]);
    expect(run.carrier).toBe(0);
    expect(run.cart).toEqual({ x: 1300, y: 3011 });
    pas(run, 1, [joueur(1300, 3011 + RELIQUE_PICKUP_RADIUS, { id: 2 })]);
    expect(run.carrier).toBe(2);
  });

  it('un porteur absent (parti) la lache aussi', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 1, [joueur(S.x, S.y, { id: 1 })]);
    pas(run, 1, [joueur(5000, 5000, { id: 2 })]);
    expect(run.carrier).toBe(0);
  });

  it('livree a 80 px de l autel : reussi ; la progression suit la relique comme le chariot', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 1, [joueur(S.x, S.y)]);
    pas(run, 1, [joueur(S.x + 750, S.y)]);
    expect(run.progress).toBeCloseTo(0.5, 5);
    expect(pas(run, 1, [joueur(E.x - RELIQUE_ALTAR_RADIUS - 1, E.y)])).toBeNull();
    expect(run.step([joueur(E.x - RELIQUE_ALTAR_RADIUS, E.y)], PERSONNE, DT)).toBe(
      EVENT_OUTCOME.REUSSI,
    );
  });

  it('la chute du porteur n est pas un echec : seules 60 s sans livraison le sont', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 1, [joueur(S.x, S.y)]);
    expect(pas(run, EVENT_DURATION_TICKS - 2, [joueur(S.x, S.y, { hp: 0 })])).toBeNull();
    expect(run.step([], PERSONNE, DT)).toBe(EVENT_OUTCOME.EXPIRE);
  });

  it('speedFactorOf : 0,6 pour le porteur (0,8 seul), 1 pour les autres, et 1 hors relique', () => {
    const run = new EventRun(plan, ouvert());
    expect(run.speedFactorOf(1)).toBe(1);
    pas(run, 1, [joueur(S.x, S.y, { id: 1 })]);
    expect(run.speedFactorOf(1)).toBe(0.6);
    expect(run.speedFactorOf(2)).toBe(1);
    expect(run.speedFactorOf(0)).toBe(1);
    const seul = new EventRun({ ...plan, solo: true }, ouvert());
    pas(seul, 1, [joueur(S.x, S.y, { id: 1 })]);
    expect(seul.speedFactorOf(1)).toBe(0.8);
    const forge = new EventRun(
      { kind: EVENT_KIND.FORGE, points: [S], solo: false, carrier: 0 },
      ouvert(),
    );
    pas(forge, 1, [joueur(S.x, S.y, { id: 1 })]);
    expect(forge.speedFactorOf(1)).toBe(1);
    expect(forge.holdsFire(1)).toBe(false);
  });

  it('holdsFire vrai pour le seul porteur ; takeCarrierChanged vrai UNE fois par transition', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 1, []);
    expect(run.takeCarrierChanged()).toBe(false);
    pas(run, 1, [joueur(S.x, S.y, { id: 1 })]);
    expect(run.holdsFire(1)).toBe(true);
    expect(run.holdsFire(2)).toBe(false);
    expect(run.takeCarrierChanged()).toBe(true);
    expect(run.takeCarrierChanged()).toBe(false);
    pas(run, 1, [joueur(S.x, S.y, { id: 1 })]);
    expect(run.takeCarrierChanged()).toBe(false);
    pas(run, 1, [joueur(S.x, S.y, { id: 1, hp: 0 })]);
    expect(run.holdsFire(1)).toBe(false);
    expect(run.takeCarrierChanged()).toBe(true);
  });

  it('wireState : la relique en x, y et l id du porteur dans l octet d etat (0 au sol)', () => {
    const run = new EventRun(plan, ouvert());
    expect(run.wireState()).toEqual({ progress: 0, cartX: S.x, cartY: S.y, cartHp: 0 });
    pas(run, 1, [joueur(S.x + 10, S.y, { id: 3 })]);
    expect(run.wireState()).toMatchObject({ cartX: S.x + 10, cartY: S.y, cartHp: 3 });
  });
});

describe('etape 16 : EventRun — la chasse', () => {
  const plan: EventPlan = {
    kind: EVENT_KIND.CHASSE,
    points: [
      { x: 1000, y: 1000 },
      { x: 2200, y: 1000 },
      { x: 1600, y: 2000 },
    ],
    solo: false,
    carrier: 0,
  };
  const proies = [101, 102, 103];

  it('reussie quand toutes les proies ont slotOf < 0, progression tombees / nees', () => {
    const run = new EventRun(plan, ouvert(), proies);
    expect(pas(run, 10, [], horde([], new Set(proies)))).toBeNull();
    expect(run.progress).toBe(0);
    expect(pas(run, 1, [], horde([], new Set([102, 103])))).toBeNull();
    expect(run.progress).toBeCloseTo(1 / 3, 6);
    expect(run.wireState()).toEqual({ progress: 85, cartX: 0, cartY: 0, cartHp: 0 });
    expect(run.step([], horde([], new Set()), DT)).toBe(EVENT_OUTCOME.REUSSI);
  });

  it('expiree a 60 s si une proie survit', () => {
    const run = new EventRun(plan, ouvert(), proies);
    const une = horde([], new Set([101]));
    expect(pas(run, EVENT_DURATION_TICKS - 1, [], une)).toBeNull();
    expect(run.step([], une, DT)).toBe(EVENT_OUTCOME.EXPIRE);
  });
});

describe('etape 16 : EventRun — le noir', () => {
  const plan: EventPlan = { kind: EVENT_KIND.NOIR, points: [], solo: false, carrier: 2 };

  it('detruit a la mort du porteur de lanterne, ou a son depart', () => {
    const run = new EventRun(plan, ouvert());
    expect(pas(run, 10, [joueur(0, 0, { id: 2 })])).toBeNull();
    expect(run.step([joueur(0, 0, { id: 2, hp: 0 })], PERSONNE, DT)).toBe(EVENT_OUTCOME.DETRUIT);
    const parti = new EventRun(plan, ouvert());
    expect(parti.step([joueur(0, 0, { id: 1 })], PERSONNE, DT)).toBe(EVENT_OUTCOME.DETRUIT);
  });

  it('reussi a 1 200 ticks : il ne peut pas expirer ; progression elapsed / 1 200', () => {
    const run = new EventRun(plan, ouvert());
    expect(pas(run, NOIR_HOLD_TICKS / 2, [joueur(0, 0, { id: 2 })])).toBeNull();
    expect(run.progress).toBeCloseTo(0.5, 6);
    expect(run.wireState()).toEqual({ progress: 127, cartX: 0, cartY: 0, cartHp: 2 });
    expect(pas(run, NOIR_HOLD_TICKS / 2, [joueur(0, 0, { id: 2 })])).toBe(EVENT_OUTCOME.REUSSI);
  });

  it('inDark : a 351 px de la lanterne oui, a 350 non ; jamais en solo, jamais hors noir', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 1, [joueur(1000, 1000, { id: 2 })]);
    expect(run.inDark({ x: 1000 + NOIR_LIGHT_RADIUS + 1, y: 1000 })).toBe(true);
    expect(run.inDark({ x: 1000 + NOIR_LIGHT_RADIUS, y: 1000 })).toBe(false);
    expect(run.inDark({ x: 1000, y: 1000 })).toBe(false);
    const seul = new EventRun({ ...plan, solo: true }, ouvert());
    pas(seul, 1, [joueur(1000, 1000, { id: 2 })]);
    expect(seul.inDark({ x: 4000, y: 4000 })).toBe(false);
    const siege = new EventRun(
      { kind: EVENT_KIND.SIEGE, points: [{ x: 0, y: 0 }], solo: false, carrier: 0 },
      ouvert(),
    );
    expect(siege.inDark({ x: 4000, y: 4000 })).toBe(false);
  });

  it('NOIR_DRAIN_PER_SEC vaut 2 : 50 s pour tuer 100 PV, plus que les 40 s de l evenement', () => {
    expect(NOIR_DRAIN_PER_SEC).toBe(2);
    expect(100 / NOIR_DRAIN_PER_SEC).toBeGreaterThan(NOIR_HOLD_TICKS / TICK_HZ);
  });
});
