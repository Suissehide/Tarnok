import { describe, expect, it } from 'vitest';

import { TICK_HZ } from './constants';
import { Horde } from './horde';
import {
  FRAPPE_DELAY_TICKS,
  FRAPPE_SEARCH_RADIUS,
  frappeDueTick,
  frappeIsDue,
  frappeTargets,
  type Onde,
  ondeBand,
  ondeIsAlive,
  ondeRadiusAt,
  ondeStrikes,
} from './onde-frappe';
import { FORMATION } from './waves';

/** Une entite unique a une position choisie — meme motif que `chain.test.ts`. */
function spawnAt(horde: Horde, waveId: number, x: number, y: number): number {
  const slot = horde.count;
  horde.spawn({
    waveId,
    spawnTick: 0,
    seed: 0x1234,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: 1000,
    anchorY: 1000,
    count: 1,
  });
  horde.x[slot] = x;
  horde.y[slot] = y;
  return horde.entityIdAt(slot);
}

describe('Onde — un anneau qui s agrandit', () => {
  // 30 px par tick a 30 Hz : des bandes aux bornes rondes.
  const ONDE: Onde = {
    x: 0,
    y: 0,
    bornTick: 100,
    speed: 30 * TICK_HZ,
    maxRadius: 100,
    damage: 10,
    element: 0,
    by: 1,
  };

  it('grandit a sa vitesse depuis zero, puis plafonne au rayon max', () => {
    expect(ondeRadiusAt(ONDE, 90)).toBe(0);
    expect(ondeRadiusAt(ONDE, 100)).toBe(0);
    expect(ondeRadiusAt(ONDE, 101)).toBe(30);
    expect(ondeRadiusAt(ONDE, 103)).toBe(90);
    expect(ondeRadiusAt(ONDE, 104)).toBe(100);
    expect(ondeRadiusAt(ONDE, 500)).toBe(100);
  });

  it('frappe chaque distance UNE fois sur toute sa vie, sans ensemble a tenir', () => {
    for (const d of [0, 1, 29.9, 30, 30.1, 60, 99, 100]) {
      let coups = 0;
      for (let tick = 95; tick < 120; tick++) {
        if (ondeStrikes(ONDE, tick, d)) {
          coups++;
        }
      }
      expect(coups, `distance ${d}`).toBe(1);
    }
    // Au-dela du rayon max : jamais.
    for (let tick = 95; tick < 120; tick++) {
      expect(ondeStrikes(ONDE, tick, 100.5)).toBe(false);
    }
  });

  it('balaie la bande (precedent, courant] : la borne haute frappe, la basse non', () => {
    expect(ondeBand(ONDE, 102)).toEqual({ inner: 30, outer: 60 });
    expect(ondeStrikes(ONDE, 102, 60)).toBe(true);
    expect(ondeStrikes(ONDE, 102, 30)).toBe(false);
  });

  it('vit de sa naissance au tick ou elle atteint son rayon max, compris', () => {
    expect(ondeIsAlive(ONDE, 99)).toBe(false);
    expect(ondeIsAlive(ONDE, 100)).toBe(true);
    expect(ondeIsAlive(ONDE, 104)).toBe(true);
    expect(ondeIsAlive(ONDE, 105)).toBe(false);
  });

  it('ne vit pas eternellement a vitesse nulle', () => {
    const plate = { ...ONDE, speed: 0 };
    expect(ondeStrikes(plate, 100, 50)).toBe(true);
    expect(ondeIsAlive(plate, 101)).toBe(false);
  });
});

describe('frappeTargets — ou tombent les eclairs', () => {
  it('rend les n plus proches du point, dans le rayon de recherche, du plus proche au plus loin', () => {
    const horde = new Horde();
    spawnAt(horde, 1, 50, 0);
    spawnAt(horde, 2, 10, 0);
    spawnAt(horde, 3, 0, 30);
    spawnAt(horde, 4, 120, 0);
    expect(frappeTargets(horde, 0, 0, 3)).toEqual([
      { x: 10, y: 0 },
      { x: 0, y: 30 },
      { x: 50, y: 0 },
    ]);
  });

  it('ignore ce qui est hors du rayon de recherche', () => {
    const horde = new Horde();
    spawnAt(horde, 1, FRAPPE_SEARCH_RADIUS + 1, 0);
    spawnAt(horde, 2, FRAPPE_SEARCH_RADIUS, 0);
    expect(frappeTargets(horde, 0, 0, 1)).toEqual([{ x: FRAPPE_SEARCH_RADIUS, y: 0 }]);
  });

  it('a distance egale, departage par le plus petit identifiant, pas par l ordre du tableau', () => {
    const horde = new Horde();
    const a = spawnAt(horde, 2, 40, 0);
    const b = spawnAt(horde, 1, -40, 0);
    expect(a).not.toBe(b);
    const premier = a < b ? { x: 40, y: 0 } : { x: -40, y: 0 };
    expect(frappeTargets(horde, 0, 0, 1)).toEqual([premier]);
  });

  it('complete par UN impact sur le point vise quand il manque des cibles', () => {
    const horde = new Horde();
    spawnAt(horde, 1, 20, 0);
    // Deux manquent : un seul impact de plus, jamais deux.
    expect(frappeTargets(horde, 0, 0, 3)).toEqual([
      { x: 20, y: 0 },
      { x: 0, y: 0 },
    ]);
  });

  it('tombe sur le point vise quand personne n est a portee', () => {
    expect(frappeTargets(new Horde(), 7, 8, 3)).toEqual([{ x: 7, y: 8 }]);
  });
});

describe('frappe — l echeance', () => {
  it('frappe FRAPPE_DELAY_TICKS apres le tir, pas avant', () => {
    const impact = {
      x: 0,
      y: 0,
      radius: 35,
      damage: 10,
      element: 0,
      by: 1,
      dueTick: frappeDueTick(200),
    };
    expect(impact.dueTick).toBe(200 + FRAPPE_DELAY_TICKS);
    expect(frappeIsDue(impact, 200 + FRAPPE_DELAY_TICKS - 1)).toBe(false);
    expect(frappeIsDue(impact, 200 + FRAPPE_DELAY_TICKS)).toBe(true);
    // Un tick saute ne le laisse pas en attente pour toujours.
    expect(frappeIsDue(impact, 200 + FRAPPE_DELAY_TICKS + 5)).toBe(true);
  });
});
