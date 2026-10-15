import { WIPE_GOLD_KEPT } from '@shared/constants';
import { VOTE_CHOICE } from '@shared/protocol';
import { describe, expect, it } from 'vitest';

import { summaryTone } from './summary';

describe('summaryTone : deux fins, un ecran', () => {
  it('un depart vote est une extraction, et l or acquis est celui du portail', () => {
    expect(summaryTone(VOTE_CHOICE.LEAVE, 900, 300)).toEqual({
      victory: true,
      title: 'Extraction réussie',
      goldLabel: 'Or sécurisé',
      gold: 900,
    });
  });

  it('sans depart (aucun portail, ou « rester » puis effacement), c est une defaite', () => {
    expect(summaryTone(null, 0, 0).victory).toBe(false);
    const reste = summaryTone(VOTE_CHOICE.STAY, 900, 12);
    expect(reste.victory).toBe(false);
  });

  it('a la defaite, l ecran dit l or PERDU, pas une cagnotte securisee', () => {
    // `RUN_OVER` arrive AVANT le snapshot qui porte l'or efface : `gold` est
    // encore la cagnotte entiere.
    const perdu = 1200 - Math.round(1200 * WIPE_GOLD_KEPT);
    expect(summaryTone(null, 0, 1200)).toMatchObject({ goldLabel: 'Or perdu', gold: perdu });
    expect(summaryTone(VOTE_CHOICE.STAY, 900, 1200)).toMatchObject({
      goldLabel: 'Or perdu',
      gold: perdu,
    });
  });
});
