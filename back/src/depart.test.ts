import { TICK_HZ } from '@shared/constants';
import { BASE_WEAPON_ID, salvoCount, startingWeapons, weaponOf } from '@shared/weapons';
import { describe, expect, it } from 'vitest';

import { Room } from './room';

/**
 * Une seule arme au depart : l'arme choisie en salle d'attente REMPLACE la
 * dague, elle ne s'y ajoute pas (`PlayerState.keepsBase`).
 *
 * Paire discriminante : sans arme de depart, la dague tire ; avec, seule
 * l'arme choisie tire. Le premier tick suffit — toute arme tire des que
 * possible (`lastFireTick` a `-Infinity`).
 */
const tireUnTick = (startWeapon?: number): number => {
  const room = new Room(1);
  room.join(1, undefined, startWeapon);
  room.applyInput(1, 1, 0, 0, 127, 0);
  room.step(1 / TICK_HZ);
  return room.projectileCount;
};

describe('une seule arme au depart', () => {
  const arme = startingWeapons()[0] as number;

  it('sans arme de depart, la dague tire', () => {
    expect(tireUnTick()).toBe(salvoCount(weaponOf(BASE_WEAPON_ID), 1));
  });

  it('avec une arme de depart, elle seule tire : la dague ne s ajoute pas', () => {
    expect(tireUnTick(arme)).toBe(salvoCount(weaponOf(arme), 1));
  });
});
