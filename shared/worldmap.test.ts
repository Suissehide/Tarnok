import { describe, expect, it } from 'vitest';

import { FlowField } from './flowfield';
import { applyObstacles, generateObstacles } from './worldmap';

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

    // Assez pour que contourner ait un sens, pas au point d'enfermer la horde.
    expect(ratio).toBeGreaterThan(0.02);
    expect(ratio).toBeLessThan(0.15);
  });

  it('laisse le centre libre : c est la que les joueurs apparaissent', () => {
    const cols = 40;
    const mask = generateObstacles(11, cols, 40);
    const centre = Math.floor(20) * cols + Math.floor(20);

    expect(mask[centre]).toBe(0);
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
