import { describe, expect, it } from 'vitest';

import { hordeClock } from './frame';

describe('hordeClock — l animation de la horde suit la vitesse du monde', () => {
  it('avance avec l horloge murale quand le monde tourne', () => {
    const client = { motionScale: 1 };
    const t0 = hordeClock(client, 1000);
    expect(hordeClock(client, 1500) - t0).toBe(500);
  });

  it('s arrete pendant le gel du choix, et reprend sans sauter', () => {
    const client = { motionScale: 1 };
    hordeClock(client, 0);
    const avant = hordeClock(client, 100);
    client.motionScale = 0;
    expect(hordeClock(client, 5000)).toBe(avant);
    client.motionScale = 0.5;
    expect(hordeClock(client, 5200)).toBe(avant + 100);
  });

  it('sans motionScale, suit l horloge murale', () => {
    const client = {};
    const t0 = hordeClock(client, 10);
    expect(hordeClock(client, 40) - t0).toBe(30);
  });
});
