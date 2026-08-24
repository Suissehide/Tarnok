import { describe, expect, it } from 'vitest';

import { SEPARATION_CELL, SEPARATION_RADIUS, TICK_HZ } from './constants';
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
    // ⚠️ L'ecart est choisi STRICTEMENT entre le rayon (28) et la cellule (56).
    //
    // La premiere version de ce test les placait a 84 px. A cette distance la
    // paire tombe a deux cellules d'ecart, donc la recherche sur les neuf
    // cellules voisines ne l'examine meme pas : le test passait par le
    // decoupage de la grille, sans jamais atteindre la comparaison de rayon
    // qu'il pretend couvrir. Verifie en supprimant `d2 > r2` de la production —
    // les cinq tests passaient toujours.
    //
    // A 42 px la paire EST examinee, et seule la comparaison de rayon la rejette.
    const ecart = (SEPARATION_RADIUS + SEPARATION_CELL) / 2;
    const horde = hordeAt([
      [3000, 3000],
      [3000 + ecart, 3000],
    ]);
    const grid = new SeparationGrid(100);

    grid.apply(horde, DT);

    expect(horde.x[0]).toBe(3000);
    expect(horde.x[1]).toBe(3000 + ecart);
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

  // ⚠️ Il n'y a PAS de test « n'alloue pas a chaque appel ». La premiere version
  // de ce plan en contenait un — mille appels enveloppes dans `not.toThrow()`,
  // avec un commentaire affirmant qu'il « attraperait une reallocation par
  // appel ». Il ne l'attrapait pas : verifie en reintroduisant le
  // `this.#cellStart.slice()` par appel, les six tests passaient toujours.
  //
  // L'absence d'allocation est une propriete de PERFORMANCE, et un test unitaire
  // ne sait pas l'observer sans exposer les tableaux prives — c'est-a-dire sans
  // ajouter du code de test dans une classe de production. Son gardien est le
  // banc (`npm run bench:sep -w back`), ou une allocation par appel se verrait
  // dans l'ecart entre mediane et p95.
  //
  // Un test qui ne teste rien est pire que pas de test : il fabrique de la
  // confiance. On le supprime plutot que de le maquiller.
});
