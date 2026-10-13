import { describe, expect, it } from 'vitest';

import { decode, encodeLobby, encodePick, encodeStart, MSG, NO_WEAPON } from './protocol';
import { BASE_WEAPON_ID, startingWeapons, WEAPONS } from './weapons';

describe('salle d attente', () => {
  it('LOBBY, PICK et START font l aller-retour', () => {
    const players = [
      { playerId: 1, weaponId: 3, classId: 1 },
      { playerId: 2, weaponId: NO_WEAPON, classId: 0 },
    ];
    expect(decode(encodeLobby(2, players))).toEqual({ type: MSG.LOBBY, you: 2, players });
    expect(decode(encodePick(7, 2))).toEqual({ type: MSG.PICK, weaponId: 7, classId: 2 });
    expect(decode(encodeStart())).toEqual({ type: MSG.START });
  });

  it('PICK porte la classe en plus de l arme, et fait l aller-retour', () => {
    const buf = encodePick(WEAPONS[1]?.id ?? 1, 2);
    expect(buf.byteLength).toBe(3); // nombre NU : largeur de fil
    const msg = decode(buf);
    expect(msg?.type).toBe(MSG.PICK);
    expect(msg).toMatchObject({ weaponId: WEAPONS[1]?.id ?? 1, classId: 2 });
  });

  it('LOBBY porte la classe de chaque joueur', () => {
    const buf = encodeLobby(1, [
      { playerId: 1, weaponId: NO_WEAPON, classId: 0 },
      { playerId: 2, weaponId: WEAPONS[1]?.id ?? 1, classId: 3 },
    ]);
    // 3 d'en-tete + 2 entrees x 3 octets : CALCULE, pas devine.
    expect(buf.byteLength).toBe(9);
    const msg = decode(buf);
    expect(msg?.type).toBe(MSG.LOBBY);
    expect(msg).toMatchObject({
      players: [
        { playerId: 1, weaponId: NO_WEAPON, classId: 0 },
        { playerId: 2, weaponId: WEAPONS[1]?.id ?? 1, classId: 3 },
      ],
    });
  });

  it('refuse un LOBBY tronque', () => {
    const court = encodeLobby(1, [{ playerId: 1, weaponId: 1, classId: 0 }]).slice(0, 4);
    expect(() => decode(court)).toThrow(/tronque/);
  });

  it('refuse un LOBBY tronque d un octet', () => {
    const buf = encodeLobby(1, [{ playerId: 1, weaponId: NO_WEAPON, classId: 0 }]);
    expect(() => decode(buf.slice(0, buf.byteLength - 1))).toThrow(/tronque/);
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
