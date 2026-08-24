import { describe, expect, it } from 'vitest';

import { SEPARATION_RADIUS, TICK_HZ } from './constants';
import { Horde } from './horde';
import { SeparationGrid } from './separation';
import { FORMATION, type WaveOrder } from './waves';

const DT = 1 / TICK_HZ;

function hordeAt(positions: readonly (readonly [number, number])[]): Horde {
  const horde = new Horde(100);
  const order: WaveOrder = {
    waveId: 1,
    spawnTick: 0,
    seed: 1,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: 3000,
    anchorY: 3000,
    count: positions.length,
  };
  horde.spawn(order);
  positions.forEach(([x, y], i) => {
    horde.x[i] = x;
    horde.y[i] = y;
  });
  return horde;
}

describe('SeparationGrid.apply', () => {
  it('ecarte deux entites qui se chevauchent', () => {
    const horde = hordeAt([
      [3000, 3000],
      [3010, 3000],
    ]);
    const grid = new SeparationGrid(100);
    const avant = Math.abs((horde.x[1] ?? 0) - (horde.x[0] ?? 0));

    grid.apply(horde, DT);

    expect(Math.abs((horde.x[1] ?? 0) - (horde.x[0] ?? 0))).toBeGreaterThan(avant);
  });

  it('ne touche pas deux entites plus eloignees que le rayon', () => {
    const loin = SEPARATION_RADIUS * 3;
    const horde = hordeAt([
      [3000, 3000],
      [3000 + loin, 3000],
    ]);
    const grid = new SeparationGrid(100);

    grid.apply(horde, DT);

    expect(horde.x[0]).toBe(3000);
    expect(horde.x[1]).toBe(3000 + loin);
  });

  it('repousse symetriquement : les deux bougent autant, en sens oppose', () => {
    const horde = hordeAt([
      [3000, 3000],
      [3010, 3000],
    ]);
    const grid = new SeparationGrid(100);

    grid.apply(horde, DT);

    const gauche = 3000 - (horde.x[0] ?? 0);
    const droite = (horde.x[1] ?? 0) - 3010;
    expect(gauche).toBeCloseTo(droite, 5);
    expect(gauche).toBeGreaterThan(0);
  });

  it('ne depend pas de l ordre des entites dans le tableau', () => {
    // C'est LA propriete qui porte le determinisme : deux clients compactent
    // leurs tableaux differemment apres des morts, donc la meme configuration
    // spatiale peut leur arriver dans un ordre different.
    const a = hordeAt([
      [3000, 3000],
      [3010, 3000],
      [3005, 3012],
    ]);
    const b = hordeAt([
      [3005, 3012],
      [3010, 3000],
      [3000, 3000],
    ]);
    const grid = new SeparationGrid(100);

    grid.apply(a, DT);
    grid.apply(b, DT);

    // L'entite qui etait a (3000, 3000) doit finir au meme endroit des deux
    // cotes, quel que soit son indice.
    expect(a.x[0]).toBeCloseTo(b.x[2] ?? 0, 5);
    expect(a.y[0]).toBeCloseTo(b.y[2] ?? 0, 5);
  });

  it('est deterministe : deux applications identiques donnent le meme resultat', () => {
    const a = hordeAt([
      [3000, 3000],
      [3010, 3002],
      [3004, 3011],
      [2995, 3006],
    ]);
    const b = hordeAt([
      [3000, 3000],
      [3010, 3002],
      [3004, 3011],
      [2995, 3006],
    ]);
    const grid = new SeparationGrid(100);

    grid.apply(a, DT);
    grid.apply(b, DT);

    expect([...a.x.slice(0, 4)]).toEqual([...b.x.slice(0, 4)]);
  });

  it('n alloue pas a chaque appel', () => {
    // On ne mesure pas la memoire : on verifie que la grille est reutilisable
    // sans se degrader, ce qui attraperait une reallocation par appel.
    const horde = hordeAt([
      [3000, 3000],
      [3010, 3000],
    ]);
    const grid = new SeparationGrid(100);

    expect(() => {
      for (let i = 0; i < 1000; i++) {
        grid.apply(horde, DT);
      }
    }).not.toThrow();
  });
});
