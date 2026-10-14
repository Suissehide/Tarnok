import { describe, expect, it } from 'vitest';

import { FlowField } from './flowfield';
import {
  applyObstacles,
  DECO,
  generateObstacles,
  generateWorld,
  moveOnMap,
  PLAYER_BODY_RADIUS,
  TERRAIN,
} from './worldmap';

describe('generateObstacles', () => {
  it('rend exactement la meme carte pour la meme graine', () => {
    const a = generateObstacles(4242, 40, 40);
    const b = generateObstacles(4242, 40, 40);

    expect([...a]).toEqual([...b]);
  });

  it('rend des cartes differentes pour des graines differentes', () => {
    const a = generateObstacles(1, 40, 40);
    const b = generateObstacles(2, 40, 40);

    expect([...a]).not.toEqual([...b]);
  });

  it('mure une part raisonnable de la carte', () => {
    const mask = generateObstacles(7, 60, 60);
    const blocked = mask.reduce((n, v) => n + v, 0);
    const ratio = blocked / mask.length;

    // L'eau autour de l'ile en fait la plus grosse part : assez pour que
    // contourner ait un sens, jamais au point d'enfermer la horde.
    expect(ratio).toBeGreaterThan(0.15);
    expect(ratio).toBeLessThan(0.5);
  });

  it('laisse toute la zone d apparition libre, pas seulement son centre', () => {
    const cols = 40;
    const rows = 40;
    // Plusieurs graines : avec une seule, le test passerait par chance meme si
    // la protection de la zone etait supprimee.
    for (const seed of [11, 12, 13, 101, 999]) {
      const mask = generateObstacles(seed, cols, rows);
      // Bornes: centre (20) +/- SPAWN_CLEARANCE (4) = [16, 24]
      for (let cy = 16; cy <= 24; cy++) {
        for (let cx = 16; cx <= 24; cx++) {
          expect(mask[cy * cols + cx]).toBe(0);
        }
      }
    }
  });
});

describe('applyObstacles', () => {
  it('reporte le masque dans le champ', () => {
    const field = new FlowField(400, 100);
    const mask = new Uint8Array(field.cols * field.rows);
    mask[5] = 1;

    applyObstacles(field, mask);

    expect(field.blocked[5]).toBe(1);
  });

  it('efface les obstacles precedents', () => {
    const field = new FlowField(400, 100);
    field.block(1, 1);
    const vide = new Uint8Array(field.cols * field.rows);

    applyObstacles(field, vide);

    expect(field.blocked[1 * field.cols + 1]).toBe(0);
  });

  it('efface au-dela d un masque plus court que le champ', () => {
    const field = new FlowField(400, 100);
    field.block(1, 1);
    const dernier = field.cols * field.rows - 1;
    expect(field.blocked[dernier]).toBe(0);
    field.blocked[dernier] = 1;

    // Masque volontairement tronque : sans le `fill(0)`, la queue du champ
    // garderait ses obstacles precedents.
    applyObstacles(field, new Uint8Array(2));

    expect(field.blocked[dernier]).toBe(0);
  });

  it('donne le meme champ a deux instances qui partagent le masque', () => {
    const mask = generateObstacles(303, 60, 60);
    const a = new FlowField(3840, 64);
    const b = new FlowField(3840, 64);
    applyObstacles(a, mask);
    applyObstacles(b, mask);

    a.update(1000, 1000);
    b.update(1000, 1000);

    expect([...a.dirX]).toEqual([...b.dirX]);
  });
});

describe('generateWorld — l ile', () => {
  const COLS = 94;
  const ROWS = 94;

  it('le bord de la carte est de l eau, le centre de l herbe', () => {
    for (const seed of [1, 2, 3, 77, 4242]) {
      const w = generateWorld(seed, COLS, ROWS);
      for (let c = 0; c < COLS; c++) {
        expect(w.terrain[c]).toBe(TERRAIN.WATER);
        expect(w.terrain[(ROWS - 1) * COLS + c]).toBe(TERRAIN.WATER);
      }
      expect(w.terrain[47 * COLS + 47]).toBe(TERRAIN.GRASS);
    }
  });

  it('chaque cellule libre est atteignable depuis le centre : aucune poche', () => {
    for (const seed of [1, 2, 3, 77, 4242]) {
      const w = generateWorld(seed, COLS, ROWS);
      const seen = new Uint8Array(COLS * ROWS);
      const queue = [47 * COLS + 47];
      seen[queue[0] ?? 0] = 1;
      for (const i of queue) {
        const cx = i % COLS;
        const cy = (i - cx) / COLS;
        for (const [nx, ny] of [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ] as const) {
          const j = ny * COLS + nx;
          if (nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS && !seen[j] && !w.blocked[j]) {
            seen[j] = 1;
            queue.push(j);
          }
        }
      }
      const libres = w.blocked.reduce((n, b) => n + (b === 0 ? 1 : 0), 0);
      expect(queue.length).toBe(libres);
    }
  });

  it('pose des plateaux avec leur falaise, des arbres et des rochers, et ils bloquent', () => {
    const w = generateWorld(7, COLS, ROWS);
    const compte = (pred: (i: number) => boolean): number =>
      Array.from(w.terrain.keys()).filter(pred).length;
    expect(compte((i) => w.terrain[i] === TERRAIN.PLATEAU)).toBeGreaterThan(0);
    expect(compte((i) => w.terrain[i] === TERRAIN.CLIFF)).toBeGreaterThan(0);
    expect(compte((i) => w.deco[i] === DECO.TREE)).toBeGreaterThan(0);
    expect(compte((i) => w.deco[i] === DECO.ROCK)).toBeGreaterThan(0);
    for (let i = 0; i < w.blocked.length; i++) {
      if (w.terrain[i] !== TERRAIN.GRASS || w.deco[i] === DECO.TREE || w.deco[i] === DECO.ROCK) {
        expect(w.blocked[i]).toBe(1);
      }
    }
    // Les buissons ne bloquent pas.
    const buisson = Array.from(w.deco.keys()).find((i) => w.deco[i] === DECO.BUSH);
    expect(buisson).toBeDefined();
  });

  it('generateObstacles rend le masque de generateWorld', () => {
    expect([...generateObstacles(9, COLS, ROWS)]).toEqual([
      ...generateWorld(9, COLS, ROWS).blocked,
    ]);
  });
});

describe('moveOnMap — les joueurs butent sur le decor', () => {
  // Une carte de 4 x 1 cellules de 100 px : la troisieme est un mur.
  const mask = new Uint8Array([0, 0, 1, 0]);
  const move = (x: number, y: number, dx: number, dy: number): { x: number; y: number } =>
    moveOnMap(x, y, dx, dy, mask, 4, 1, 100, 400);

  it('avance librement sur une cellule libre', () => {
    expect(move(50, 50, 30, 0)).toEqual({ x: 80, y: 50 });
  });

  it('s arrete avant le mur, a son rayon de corps pres', () => {
    expect(move(200 - PLAYER_BODY_RADIUS - 5, 50, 10, 0).x).toBe(200 - PLAYER_BODY_RADIUS - 5);
  });

  it('glisse sur l autre axe quand un seul est bloque', () => {
    const glisse = moveOnMap(
      170,
      50,
      20,
      10,
      new Uint8Array([0, 0, 1, 0, 0, 0, 0, 0]),
      4,
      2,
      100,
      400,
    );
    expect(glisse).toEqual({ x: 170, y: 60 });
  });

  it('un joueur deja DANS un mur peut en sortir', () => {
    expect(move(250, 50, 60, 0)).toEqual({ x: 310, y: 50 });
  });

  it('reste dans la carte', () => {
    expect(move(390, 50, 50, 0).x).toBe(400);
  });
});
