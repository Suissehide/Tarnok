import { describe, expect, it } from 'vitest';

import { type CueSnapshot, cuesBetween } from './audio';

const calme: CueSnapshot = {
  kills: 0,
  hits: 0,
  reactions: 0,
  xp: 0,
  level: 1,
  gold: 0,
  hp: 100,
  bossCharging: false,
  abilityCooldown: 0,
  pings: 0,
  lastPingIntent: -1,
};

describe('cuesBetween — le son se deduit de ce qui change', () => {
  it('rien a la premiere image, rien sans changement', () => {
    expect(cuesBetween(null, calme)).toEqual([]);
    expect(cuesBetween(calme, calme)).toEqual([]);
  });

  it('chaque compteur qui monte joue son effet', () => {
    expect(cuesBetween(calme, { ...calme, kills: 1, hits: 3 })).toEqual(['kill']);
    expect(cuesBetween(calme, { ...calme, hits: 1 })).toEqual(['hit']);
    expect(cuesBetween(calme, { ...calme, xp: 2 })).toEqual(['xp']);
    expect(cuesBetween(calme, { ...calme, gold: 5 })).toEqual(['coin']);
    expect(cuesBetween(calme, { ...calme, reactions: 1 })).toEqual(['reaction']);
  });

  it('la montee de niveau remplace le ramassage d xp, meme si l xp retombe', () => {
    expect(cuesBetween({ ...calme, xp: 19 }, { ...calme, level: 2, xp: 0 })).toEqual(['levelup']);
  });

  it('une blessure sonne, la mort non (le bilan s en charge)', () => {
    expect(cuesBetween(calme, { ...calme, hp: 80 })).toEqual(['hurt']);
    expect(cuesBetween(calme, { ...calme, hp: 0 })).toEqual([]);
  });

  it('la charge du boss sonne a son depart, pas pendant', () => {
    expect(cuesBetween(calme, { ...calme, bossCharging: true })).toEqual(['charge']);
    const enCharge = { ...calme, bossCharging: true };
    expect(cuesBetween(enCharge, enCharge)).toEqual([]);
  });

  it('le verbe sonne quand sa recharge repart, pas quand elle s ecoule', () => {
    expect(cuesBetween(calme, { ...calme, abilityCooldown: 180 })).toEqual(['ability']);
    expect(
      cuesBetween({ ...calme, abilityCooldown: 180 }, { ...calme, abilityCooldown: 179 }),
    ).toEqual([]);
  });

  it('un ping recu joue le son de SON intention', () => {
    expect(cuesBetween(calme, { ...calme, pings: 1, lastPingIntent: 1 })).toEqual(['ping-danger']);
    expect(cuesBetween(calme, { ...calme, pings: 2, lastPingIntent: 3 })).toEqual([
      'ping-jePrends',
    ]);
    expect(cuesBetween({ ...calme, pings: 2 }, { ...calme, pings: 2, lastPingIntent: 0 })).toEqual(
      [],
    );
  });
});
