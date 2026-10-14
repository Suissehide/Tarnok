import { ARCHETYPES, KAMIKAZE_RADIUS, SHAMAN_AURA_RADIUS } from '@shared/archetypes';
import { Horde } from '@shared/horde';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { Rectangle } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import { BLAST_FLASH_MS } from '../net/client';
import { behaviorShapes } from './behavior-renderer';

const idOf = (behavior: string): number => ARCHETYPES.findIndex((a) => a.behavior === behavior);

/** Des monstres POSES (meme recette que `mark-renderer.test`) : un archetype par point. */
function hordeAt(points: readonly { x: number; y: number; behavior: string }[]): Horde {
  const horde = new Horde(8);
  const order: WaveOrder = {
    waveId: 1,
    spawnTick: 0,
    seed: 3,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: 3000,
    anchorY: 3000,
    count: points.length,
  };
  horde.spawn(order);
  points.forEach((p, i) => {
    horde.x[i] = p.x;
    horde.y[i] = p.y;
    horde.archetype[i] = idOf(p.behavior);
  });
  return horde;
}

describe('behaviorShapes', () => {
  it('cerne les kamikazes et les chamans de leur vrai rayon, ignore les autres et le hors-champ', () => {
    const horde = hordeAt([
      { x: 100, y: 100, behavior: 'kamikaze' },
      { x: 200, y: 200, behavior: 'chaman' },
      { x: 300, y: 300, behavior: 'aucun' },
      { x: 9000, y: 9000, behavior: 'kamikaze' },
    ]);
    const shapes = behaviorShapes(horde, [], new Rectangle(0, 0, 800, 600), 0);
    expect(shapes).toEqual([
      { kind: 'kamikaze', x: 100, y: 100, radius: KAMIKAZE_RADIUS, alpha: 1 },
      { kind: 'chaman', x: 200, y: 200, radius: SHAMAN_AURA_RADIUS, alpha: 1 },
    ]);
  });

  it('fait vivre une explosion BLAST_FLASH_MS, en s eteignant', () => {
    const blasts = [{ x: 5, y: 5, bornMs: 1000 }];
    const view = new Rectangle(0, 0, 800, 600);
    const tot = behaviorShapes(new Horde(1), blasts, view, 1000);
    const tard = behaviorShapes(new Horde(1), blasts, view, 1000 + BLAST_FLASH_MS * 0.9);
    expect(tot[0]?.alpha).toBe(1);
    expect(tard[0]?.alpha).toBeLessThan(0.2);
    expect(behaviorShapes(new Horde(1), blasts, view, 1000 + BLAST_FLASH_MS)).toEqual([]);
  });
});
