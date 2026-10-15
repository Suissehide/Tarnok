import { describe, expect, it } from 'vitest';

import { MAP_SIZE, TICK_HZ } from './constants';
import { clampToMap, PING_BURST, PING_INTENTS, PING_LIFE_TICKS, PING_WINDOW_TICKS } from './ping';

describe('etape 9 : le modele du ping', () => {
  it('quatre intentions, dans l ordre du fil', () => {
    expect(PING_INTENTS).toEqual(['viens', 'danger', 'boss', 'jePrends']);
  });

  it('les durees sont exprimees en ticks de TICK_HZ', () => {
    expect(PING_LIFE_TICKS).toBe(4 * TICK_HZ);
    expect(PING_WINDOW_TICKS).toBe(2 * TICK_HZ);
    expect(PING_BURST).toBe(3);
  });

  it('clampToMap borne a [0, MAP_SIZE] et arrondit', () => {
    expect(clampToMap(-40)).toBe(0);
    expect(clampToMap(MAP_SIZE + 900)).toBe(MAP_SIZE);
    expect(clampToMap(1234.6)).toBe(1235);
  });
});
