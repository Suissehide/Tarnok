import { describe, expect, it } from 'vitest';

import { FLOWFIELD_CELL, MAP_SIZE } from './constants';
import { FORMATION, formationPositions, type ObstacleField, type WaveOrder } from './waves';

function order(overrides: Partial<WaveOrder> = {}): WaveOrder {
  return {
    waveId: 1,
    spawnTick: 100,
    seed: 0xabc_def,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: 3000,
    anchorY: 3000,
    count: 200,
    ...overrides,
  };
}

function positionsOf(o: WaveOrder): { x: Float32Array; y: Float32Array } {
  const x = new Float32Array(o.count);
  const y = new Float32Array(o.count);
  formationPositions(o, x, y);
  return { x, y };
}

describe('formationPositions', () => {
  it('rend exactement les memes positions pour la meme graine', () => {
    const a = positionsOf(order());
    const b = positionsOf(order());

    expect([...a.x]).toEqual([...b.x]);
    expect([...a.y]).toEqual([...b.y]);
  });

  it('rend des positions differentes pour une graine differente', () => {
    const a = positionsOf(order({ seed: 1 }));
    const b = positionsOf(order({ seed: 2 }));

    expect([...a.x]).not.toEqual([...b.x]);
  });

  it('remplit toutes les entites demandees', () => {
    const { x } = positionsOf(order({ count: 500 }));

    // Une position non ecrite resterait a 0, tres loin de l'ancre.
    for (let i = 0; i < 500; i++) {
      expect(Math.abs((x[i] ?? 0) - 3000)).toBeLessThan(2000);
    }
  });

  it('groupe RING sur un anneau autour de l ancre', () => {
    const { x, y } = positionsOf(order({ formation: FORMATION.RING, count: 100 }));

    const rayons: number[] = [];
    for (let i = 0; i < 100; i++) {
      rayons.push(Math.hypot((x[i] ?? 0) - 3000, (y[i] ?? 0) - 3000));
    }
    const min = Math.min(...rayons);
    const max = Math.max(...rayons);

    // Un anneau, pas un disque : le rayon varie peu.
    expect(min).toBeGreaterThan(100);
    expect(max - min).toBeLessThan(120);
  });

  it('rend CLUSTER plus dense que SCATTER', () => {
    const scatter = positionsOf(order({ formation: FORMATION.SCATTER, count: 300 }));
    const cluster = positionsOf(order({ formation: FORMATION.CLUSTER, count: 300 }));

    expect(meanNearestNeighbour(cluster)).toBeLessThan(meanNearestNeighbour(scatter));
  });

  it('borne toutes les positions a la carte', () => {
    const { x, y } = positionsOf(order({ anchorX: 20, anchorY: 20, count: 300 }));

    for (let i = 0; i < 300; i++) {
      expect(x[i]).toBeGreaterThanOrEqual(0);
      expect(y[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('ne laisse aucune position depasser MAP_SIZE', () => {
    const { x, y } = positionsOf(
      order({ anchorX: MAP_SIZE - 20, anchorY: MAP_SIZE - 20, count: 300 }),
    );

    for (let i = 0; i < 300; i++) {
      expect(x[i]).toBeLessThanOrEqual(MAP_SIZE);
      expect(y[i]).toBeLessThanOrEqual(MAP_SIZE);
    }
  });
});

function makeObstacleField(
  cols: number,
  rows: number,
  cellSize: number,
  blockedCells: ReadonlyArray<readonly [number, number]>,
): ObstacleField {
  const blocked = new Uint8Array(cols * rows);
  for (const [cx, cy] of blockedCells) {
    blocked[cy * cols + cx] = 1;
  }
  return { cols, rows, cellSize, blocked };
}

describe('formationPositions, evitement des murs (tache 18)', () => {
  const cellSize = FLOWFIELD_CELL;
  const cols = Math.ceil(MAP_SIZE / cellSize);
  const rows = cols;
  const anchorCol = Math.floor(cols / 2);
  const anchorRow = Math.floor(rows / 2);

  // Un pate de mur de 7x7 cellules centre exactement sur l'ancre : assez
  // large pour que plusieurs positions SCATTER, calculees sans connaissance de
  // l'obstacle, y tombent directement (verifie plus bas par la premiere
  // assertion — un test qui ne le verifierait pas pourrait passer alors que
  // la mitigation est absente).
  const blockedCells: [number, number][] = [];
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      blockedCells.push([anchorCol + dx, anchorRow + dy]);
    }
  }
  const obstacles = makeObstacleField(cols, rows, cellSize, blockedCells);
  const anchorX = (anchorCol + 0.5) * cellSize;
  const anchorY = (anchorRow + 0.5) * cellSize;

  function cellOf(x: number, y: number): number {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(x / cellSize)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(y / cellSize)));
    return cy * cols + cx;
  }

  it('une vague ancree en plein mur ne fait naitre aucune entite a l interieur d un obstacle', () => {
    const o = order({ formation: FORMATION.SCATTER, count: 400, anchorX, anchorY });

    // Sans le masque, une partie des positions calculees tombe dans le pate
    // de murs : sinon ce test ne prouverait rien (l'ancre serait, par
    // accident, deja loin de tout obstacle).
    const rawX = new Float32Array(o.count);
    const rawY = new Float32Array(o.count);
    formationPositions(o, rawX, rawY);
    let rawInWall = 0;
    for (let i = 0; i < o.count; i++) {
      if (obstacles.blocked[cellOf(rawX[i] ?? 0, rawY[i] ?? 0)] === 1) {
        rawInWall++;
      }
    }
    expect(rawInWall).toBeGreaterThan(0);

    const x = new Float32Array(o.count);
    const y = new Float32Array(o.count);
    formationPositions(o, x, y, obstacles);

    for (let i = 0; i < o.count; i++) {
      expect(obstacles.blocked[cellOf(x[i] ?? 0, y[i] ?? 0)]).toBe(0);
    }
  });

  it('le decalage est deterministe : deux appels identiques rendent les memes positions nudgees', () => {
    const o = order({ formation: FORMATION.CLUSTER, count: 150, anchorX, anchorY });
    const ax = new Float32Array(o.count);
    const ay = new Float32Array(o.count);
    const bx = new Float32Array(o.count);
    const by = new Float32Array(o.count);

    formationPositions(o, ax, ay, obstacles);
    formationPositions(o, bx, by, obstacles);

    expect([...ax]).toEqual([...bx]);
    expect([...ay]).toEqual([...by]);
  });
});

/** Distance moyenne au plus proche voisin — une mesure de densite. */
function meanNearestNeighbour(p: { x: Float32Array; y: Float32Array }): number {
  let total = 0;
  for (let i = 0; i < p.x.length; i++) {
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < p.x.length; j++) {
      if (i === j) {
        continue;
      }
      const d = Math.hypot((p.x[i] ?? 0) - (p.x[j] ?? 0), (p.y[i] ?? 0) - (p.y[j] ?? 0));
      if (d < best) {
        best = d;
      }
    }
    total += best;
  }
  return total / p.x.length;
}
