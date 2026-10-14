import {
  type AbilityUsed,
  DECOY_LIFETIME_TICKS,
  REMPART_LIFETIME_TICKS,
  VERB_IDS,
} from '@shared/abilities';
import { describe, expect, it } from 'vitest';

import { abilityShapes, RELAIS_FLASH_TICKS } from './ability-renderer';

const annonce = (verb: number, tick = 100): AbilityUsed => ({
  tick,
  playerId: 1,
  verb,
  x: 500,
  y: 600,
  targetId: 0,
});

describe('le calque des verbes', () => {
  it('chaque verbe visible rend sa forme, au point annonce', () => {
    const formes = abilityShapes(
      [annonce(VERB_IDS.rempart), annonce(VERB_IDS.appat), annonce(VERB_IDS.relais)],
      100,
    );
    expect(formes.map((f) => f.kind)).toEqual(['rempart', 'leurre', 'relais']);
    for (const f of formes) {
      expect([f.x, f.y]).toEqual([500, 600]);
    }
  });

  it('l Amorce ne rend rien ici : sa zone arrive par ZONE', () => {
    expect(abilityShapes([annonce(VERB_IDS.amorce)], 100)).toEqual([]);
  });

  it('chaque forme vit exactement la duree de son effet', () => {
    const r = annonce(VERB_IDS.rempart);
    expect(abilityShapes([r], 100 + REMPART_LIFETIME_TICKS - 1)).toHaveLength(1);
    expect(abilityShapes([r], 100 + REMPART_LIFETIME_TICKS)).toHaveLength(0);
    const l = annonce(VERB_IDS.appat);
    expect(abilityShapes([l], 100 + DECOY_LIFETIME_TICKS - 1)).toHaveLength(1);
    expect(abilityShapes([l], 100 + DECOY_LIFETIME_TICKS)).toHaveLength(0);
    const e = annonce(VERB_IDS.relais);
    expect(abilityShapes([e], 100 + RELAIS_FLASH_TICKS)).toHaveLength(0);
  });

  it('l opacite baisse a l approche de la fin, sans s eteindre tant que l effet agit', () => {
    const r = annonce(VERB_IDS.rempart);
    const debut = abilityShapes([r], 100)[0]?.alpha ?? 0;
    const fin = abilityShapes([r], 100 + REMPART_LIFETIME_TICKS - 1)[0]?.alpha ?? 0;
    expect(debut).toBe(1);
    expect(fin).toBeLessThan(debut);
    expect(fin).toBeGreaterThan(0);
  });
});
