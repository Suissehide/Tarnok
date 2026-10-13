import { describe, expect, it } from 'vitest';

import { decode, encodeLobby, encodePick, encodeStart, MSG, NO_WEAPON } from './protocol';
import { BASE_WEAPON_ID, startingWeapons, WEAPONS } from './weapons';

describe('salle d attente', () => {
  it('LOBBY, PICK et START font l aller-retour', () => {
    const players = [
      { playerId: 1, weaponId: 3 },
      { playerId: 2, weaponId: NO_WEAPON },
    ];
    expect(decode(encodeLobby(2, players))).toEqual({ type: MSG.LOBBY, you: 2, players });
    expect(decode(encodePick(7))).toEqual({ type: MSG.PICK, weaponId: 7 });
    expect(decode(encodeStart())).toEqual({ type: MSG.START });
  });

  it('refuse un LOBBY tronque', () => {
    const court = encodeLobby(1, [{ playerId: 1, weaponId: 1 }]).slice(0, 4);
    expect(() => decode(court)).toThrow(/tronque/);
  });

  it('les identifiants de message restent deux a deux distincts', () => {
    const ids = Object.values(MSG);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('startingWeapons propose toutes les armes sauf l arme neutre', () => {
    const libres = startingWeapons();
    expect(libres).not.toContain(BASE_WEAPON_ID);
    expect(libres).toHaveLength(WEAPONS.length - 1);
  });
});
