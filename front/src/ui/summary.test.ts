import { VOTE_CHOICE } from '@shared/protocol';
import { describe, expect, it } from 'vitest';

import { summaryTone } from './summary';

describe('summaryTone : deux fins, un ecran', () => {
  it('un depart vote est une extraction, et l or acquis est celui du portail', () => {
    expect(summaryTone(VOTE_CHOICE.LEAVE, 900, 300)).toEqual({
      victory: true,
      title: 'Extraction réussie',
      gold: 900,
    });
  });

  it('sans depart (aucun portail, ou « rester » puis effacement), c est une defaite', () => {
    expect(summaryTone(null, 0, 0).victory).toBe(false);
    const reste = summaryTone(VOTE_CHOICE.STAY, 900, 12);
    expect(reste.victory).toBe(false);
    expect(reste.gold).toBe(12);
  });
});
