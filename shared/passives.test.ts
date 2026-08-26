import { describe, expect, it } from 'vitest';

import { PASSIVES, passiveOf } from './passives';

describe('PASSIVES', () => {
  it('indexe chaque passif a sa position dans le tableau', () => {
    PASSIVES.forEach((p, i) => {
      expect(p.id).toBe(i);
    });
  });

  it('compte entre quatre et six passifs', () => {
    expect(PASSIVES.length).toBeGreaterThanOrEqual(4);
    expect(PASSIVES.length).toBeLessThanOrEqual(6);
  });

  it('donne un nom et une magnitude strictement positive a chaque passif', () => {
    for (const p of PASSIVES) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.magnitude).toBeGreaterThan(0);
    }
  });
});

describe('passiveOf', () => {
  it('rend le passif portant cet identifiant', () => {
    // Un id non nul : `passiveOf(0)` seul ne distinguerait pas une
    // implementation qui renverrait toujours PASSIVES[0] d'une qui indexe
    // correctement.
    expect(passiveOf(2)?.name).toBe(PASSIVES[2]?.name);
    expect(passiveOf(2)?.name).not.toBe(PASSIVES[0]?.name);
  });

  it('leve sur un identifiant inconnu plutot que de rendre undefined', () => {
    expect(() => passiveOf(99)).toThrow(/inconnu/i);
  });
});
