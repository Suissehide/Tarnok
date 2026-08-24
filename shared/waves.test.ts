import { describe, expect, it } from 'vitest';

import { MAP_SIZE } from './constants';
import { FORMATION, formationPositions, type WaveOrder } from './waves';

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
