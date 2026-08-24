import { describe, expect, it } from 'vitest';

import { FlowField } from './flowfield';

describe('FlowField, dimensions', () => {
  it('couvre la carte entiere, meme si le cote n est pas un multiple de la cellule', () => {
    const field = new FlowField(250, 100);

    expect(field.cols).toBe(3);
    expect(field.rows).toBe(3);
  });
});

describe('FlowField, sans obstacle', () => {
  it('pointe vers la cible', () => {
    const field = new FlowField(900, 100);
    field.update(850, 450);

    const i = field.indexAt(50, 450);

    expect(field.dirX[i]).toBeGreaterThan(0.9);
    expect(field.dirY[i]).toBeCloseTo(0, 5);
  });

  it('ne pointe nulle part depuis la cellule de la cible', () => {
    const field = new FlowField(900, 100);
    field.update(450, 450);

    const i = field.indexAt(450, 450);

    expect(field.dirX[i]).toBe(0);
    expect(field.dirY[i]).toBe(0);
  });

  it('rend des directions normalisees', () => {
    const field = new FlowField(900, 100);
    field.update(850, 850);

    for (let i = 0; i < field.dirX.length; i++) {
      const len = Math.hypot(field.dirX[i] ?? 0, field.dirY[i] ?? 0);
      // 0 pour la cellule de la cible, 1 partout ailleurs : jamais entre les deux.
      expect(len === 0 || Math.abs(len - 1) < 1e-5).toBe(true);
    }
  });

  it('fait converger un agent qui suit le gradient', () => {
    const field = new FlowField(900, 60);
    field.update(800, 800);

    let x = 50;
    let y = 50;
    for (let step = 0; step < 400; step++) {
      const i = field.indexAt(x, y);
      x += (field.dirX[i] ?? 0) * 10;
      y += (field.dirY[i] ?? 0) * 10;
    }

    expect(Math.hypot(800 - x, 800 - y)).toBeLessThan(100);
  });
});

describe('FlowField, avec obstacles', () => {
  it('contourne un mur au lieu de le traverser', () => {
    const field = new FlowField(300, 100);
    field.block(1, 1);
    field.update(250, 150);

    const i = field.indexAt(50, 150);

    // Tout droit vers l'est, c'est le mur. Le champ doit devier.
    expect(field.dirY[i]).not.toBe(0);
  });

  it('laisse une cellule muree sans direction', () => {
    const field = new FlowField(300, 100);
    field.block(1, 1);
    field.update(250, 150);

    const i = field.indexAt(150, 150);

    expect(field.dirX[i]).toBe(0);
    expect(field.dirY[i]).toBe(0);
  });

  it('laisse sans direction une zone entierement muree', () => {
    const field = new FlowField(300, 100);
    // On isole le coin (0,0) derriere trois murs.
    field.block(1, 0);
    field.block(0, 1);
    field.block(1, 1);
    field.update(250, 150);

    const i = field.indexAt(50, 50);

    expect(field.dirX[i]).toBe(0);
    expect(field.dirY[i]).toBe(0);
  });
});

describe('FlowField.indexAt', () => {
  it('borne les positions hors carte au lieu de sortir du tableau', () => {
    const field = new FlowField(300, 100);

    expect(field.indexAt(-5000, -5000)).toBe(0);
    expect(field.indexAt(99999, 99999)).toBe(field.cols * field.rows - 1);
  });
});

describe('FlowField.update', () => {
  it('efface le champ precedent au lieu de le cumuler', () => {
    const field = new FlowField(900, 100);
    field.update(850, 450);
    const before = field.dirX[field.indexAt(50, 450)];
    field.update(50, 450);
    const after = field.dirX[field.indexAt(850, 450)];

    expect(before).toBeGreaterThan(0.9);
    expect(after).toBeLessThan(-0.9);
  });

  it('incremente revision a chaque recalcul, pour detecter un rafraichissement', () => {
    const field = new FlowField(900, 100);

    expect(field.revision).toBe(0);
    field.update(450, 450);
    expect(field.revision).toBe(1);
    field.update(450, 450);
    expect(field.revision).toBe(2);
  });
});
