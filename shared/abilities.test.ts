import { describe, expect, it } from 'vitest';

import { ABILITY_COOLDOWN_TICKS, VERB_IDS } from './abilities';
import { CLASSES } from './classes';

describe('etape 8 tache 3 : les reglages des verbes', () => {
  it('chaque verbe du catalogue a un identifiant ET une recharge', () => {
    for (const c of CLASSES) {
      expect(VERB_IDS[c.verb], c.verb).toBeTypeOf('number');
      expect(ABILITY_COOLDOWN_TICKS[c.verb], c.verb).toBeGreaterThan(0);
    }
  });

  it('les identifiants de verbe sont deux a deux distincts', () => {
    const ids = Object.values(VERB_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('aucune recharge n est nulle — un verbe gratuit se spammerait a 30 Hz', () => {
    for (const [verbe, ticks] of Object.entries(ABILITY_COOLDOWN_TICKS)) {
      expect(ticks, verbe).toBeGreaterThan(1);
    }
  });
});
