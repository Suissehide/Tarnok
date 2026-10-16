import { ARCHETYPES, KAMIKAZE_RADIUS, SHAMAN_AURA_RADIUS } from '@shared/archetypes';
import {
  CONVOI_ESCORT_RADIUS,
  CONVOI_RADIUS,
  EVENT_KIND,
  FORGE_RADIUS,
  SCEAU_RADIUS,
} from '@shared/evenements';
import { Horde } from '@shared/horde';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { Rectangle } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import { BLAST_FLASH_MS, type EventView, RAISE_FLASH_MS } from '../net/client';
import { behaviorShapes, eventShapes, PORTEUR_RING_RADIUS } from './behavior-renderer';

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

  it('joue le sort de transformation la ou un mort se releve, plus longtemps qu une explosion', () => {
    const view = new Rectangle(0, 0, 800, 600);
    const releve = [{ x: 50, y: 60, bornMs: 0, kind: 'releve' as const }];
    expect(behaviorShapes(new Horde(1), releve, view, BLAST_FLASH_MS)[0]?.kind).toBe('releve');
    expect(behaviorShapes(new Horde(1), releve, view, RAISE_FLASH_MS)).toEqual([]);
  });
});

describe('etape 11 : l or du porteur', () => {
  const view = new Rectangle(0, 0, 800, 600);

  it('un anneau et un coffre par porteur dans le cadre, aucun hors du cadre', () => {
    const horde = hordeAt([
      { x: 100, y: 100, behavior: 'porteur' },
      { x: 9000, y: 9000, behavior: 'porteur' },
    ]);
    expect(behaviorShapes(horde, [], view, 0)).toEqual([
      { kind: 'coffre', x: 100, y: 100, radius: PORTEUR_RING_RADIUS, alpha: 1 },
    ]);
  });

  it('en permanence : a l arret comme en fuite', () => {
    const horde = hordeAt([{ x: 100, y: 100, behavior: 'porteur' }]);
    horde.fleeing[0] = 1;
    expect(behaviorShapes(horde, [], view, 0).map((s) => s.kind)).toEqual(['coffre']);
  });

  it('un voleur ordinaire n a pas de coffre, et son butin ne sort toujours qu en fuite', () => {
    const horde = hordeAt([{ x: 100, y: 100, behavior: 'voleur' }]);
    expect(behaviorShapes(horde, [], view, 0)).toEqual([]);
    horde.fleeing[0] = 1;
    expect(behaviorShapes(horde, [], view, 0).map((s) => s.kind)).toEqual(['butin']);
  });
});

describe('etape 14 : les formes d un evenement', () => {
  const view = new Rectangle(0, 0, 800, 600);
  const base = { progress: 0.5, secondsLeft: 30, cart: null, cartHp: 0 };

  it('un sceau par point dans le cadre, OCCUPE si un joueur vivant s y tient, rien hors cadre', () => {
    const sceaux: EventView = {
      ...base,
      kind: EVENT_KIND.SCEAUX,
      points: [
        { x: 100, y: 100 },
        { x: 500, y: 100 },
        { x: 9000, y: 9000 },
      ],
    };
    const joueurs = [
      { x: 100 + SCEAU_RADIUS, y: 100, hp: 50 },
      { x: 500, y: 100, hp: 0 },
    ];
    expect(eventShapes(sceaux, joueurs, view)).toEqual([
      { kind: 'sceau', x: 100, y: 100, radius: SCEAU_RADIUS, occupied: true, progress: 0.5 },
      { kind: 'sceau', x: 500, y: 100, radius: SCEAU_RADIUS, occupied: false, progress: 0.5 },
    ]);
  });

  it('la forge : sa zone et son anneau', () => {
    const forge: EventView = { ...base, kind: EVENT_KIND.FORGE, points: [{ x: 300, y: 300 }] };
    expect(eventShapes(forge, [{ x: 300, y: 300, hp: 10 }], view)).toEqual([
      { kind: 'forge', x: 300, y: 300, radius: FORGE_RADIUS, occupied: false, progress: 0.5 },
    ]);
  });

  it('le convoi : l arrivee et le chariot a sa position INTERPOLEE, jamais le depart', () => {
    const convoi: EventView = {
      ...base,
      kind: EVENT_KIND.CONVOI,
      points: [
        { x: 50, y: 50 },
        { x: 700, y: 400 },
      ],
      cart: { x: 200, y: 210 },
      cartHp: 0.75,
    };
    expect(eventShapes(convoi, [], view)).toEqual([
      { kind: 'arrivee', x: 700, y: 400, radius: CONVOI_RADIUS },
      { kind: 'chariot', x: 200, y: 210, radius: CONVOI_ESCORT_RADIUS, hp: 0.75 },
    ]);
  });

  it('rien sans evenement', () => {
    expect(eventShapes(null, [], view)).toEqual([]);
  });
});
