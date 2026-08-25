import { describe, expect, it } from 'vitest';

import { Horde } from './horde';
import { nearestTarget } from './targeting';
import { FORMATION, type WaveOrder } from './waves';

/**
 * Fait apparaitre une seule entite, avec un `waveId` choisi explicitement
 * pour controler son identifiant — `entityIdOf(waveId, 0) = waveId * 4096`.
 * Plusieurs appels successifs ajoutent des entites dans l'ordre d'appel,
 * ce qui permet de construire deux hordes portant les memes identites mais
 * dans un ordre de creneau different.
 */
function addOne(horde: Horde, waveId: number, x: number, y: number): void {
  const order: WaveOrder = {
    waveId,
    spawnTick: 0,
    seed: 1,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: x,
    anchorY: y,
    count: 1,
  };
  horde.spawn(order);
  const slot = horde.count - 1;
  horde.x[slot] = x;
  horde.y[slot] = y;
}

describe('nearestTarget', () => {
  it('designe l ennemi le plus proche', () => {
    const horde = new Horde(10);
    addOne(horde, 1, 100, 0); // loin
    addOne(horde, 2, 10, 0); // proche
    addOne(horde, 3, 50, 0); // milieu

    const id = nearestTarget(horde, 0, 0, 1000);

    expect(id).toBe(2 * 4096);
  });

  it('rend -1 quand rien n est a portee', () => {
    const horde = new Horde(10);
    addOne(horde, 1, 500, 0);

    const id = nearestTarget(horde, 0, 0, 100);

    expect(id).toBe(-1);
  });

  it('departage une egalite par le plus petit identifiant', () => {
    // Sans ce departage, le resultat dependrait de l'ordre du tableau — et
    // deux clients compactent leurs tableaux differemment apres des morts.
    // Deux ennemis a distance EXACTEMENT egale : c'est toujours le plus petit
    // identifiant qui gagne, quel que soit son ordre dans le tableau.
    const a = new Horde(10);
    addOne(a, 1, 100, 0); // petit id, en premier
    addOne(a, 2, -100, 0); // grand id, en second

    const b = new Horde(10);
    addOne(b, 2, -100, 0); // grand id, en premier
    addOne(b, 1, 100, 0); // petit id, en second

    expect(nearestTarget(a, 0, 0, 1000)).toBe(1 * 4096);
    expect(nearestTarget(b, 0, 0, 1000)).toBe(1 * 4096);
  });

  it('ne depend pas de l ordre des entites dans le tableau', () => {
    const a = new Horde(10);
    addOne(a, 1, 900, 0); // loin
    addOne(a, 2, 20, 0); // proche
    addOne(a, 3, 300, 0); // milieu

    const b = new Horde(10);
    addOne(b, 3, 300, 0); // milieu
    addOne(b, 1, 900, 0); // loin
    addOne(b, 2, 20, 0); // proche

    expect(nearestTarget(a, 0, 0, 1000)).toBe(2 * 4096);
    expect(nearestTarget(b, 0, 0, 1000)).toBe(2 * 4096);
  });
});
