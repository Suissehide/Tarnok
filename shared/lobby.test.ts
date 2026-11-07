import { describe, expect, it } from 'vitest';

import { NAME_MAX_CHARS } from './constants';
import {
  cleanName,
  decode,
  encodeLobby,
  encodeName,
  encodePick,
  encodeReplay,
  encodeStart,
  LOBBY_ENTRY_BYTES,
  LOBBY_HEADER_BYTES,
  MSG,
  NAME_MAX_BYTES,
  NO_SHOT_BONUS,
  NO_WEAPON,
} from './protocol';
import { BASE_WEAPON_ID, startingWeapons, WEAPONS } from './weapons';

describe('salle d attente', () => {
  it('LOBBY, PICK et START font l aller-retour', () => {
    const players = [
      { playerId: 1, weaponId: 3, classId: 1 },
      { playerId: 2, weaponId: NO_WEAPON, classId: 0 },
    ];
    // Les bonus de compte (etape 18 bis) et le pseudo sont toujours decodes :
    // zero et vide quand l'encodage ne les porte pas.
    expect(decode(encodeLobby(2, players))).toEqual({
      type: MSG.LOBBY,
      you: 2,
      players: players.map((p) => ({ ...p, bonuses: NO_SHOT_BONUS, name: '' })),
    });
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
    // L'en-tete + 2 entrees (arme, classe, bonus de compte) : CALCULE, pas devine.
    expect(buf.byteLength).toBe(LOBBY_HEADER_BYTES + 2 * LOBBY_ENTRY_BYTES);
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

  it('LOBBY porte le pseudo de chaque joueur, en octets UTF-8, et sans nom l entree reste fixe', () => {
    const players = [
      { playerId: 1, weaponId: NO_WEAPON, classId: 0, name: 'Léo' },
      { playerId: 2, weaponId: 1, classId: 1 },
      { playerId: 3, weaponId: 2, classId: 2, name: 'Zoé 🐉' },
    ];
    const buf = encodeLobby(1, players);
    // « Léo » fait 4 octets (le e accentue en pese 2), « Zoé 🐉 » 9 : `len` compte des OCTETS.
    expect(buf.byteLength).toBe(LOBBY_HEADER_BYTES + 3 * LOBBY_ENTRY_BYTES + 4 + 9);
    expect(decode(buf)).toMatchObject({
      players: [{ name: 'Léo' }, { name: '' }, { name: 'Zoé 🐉' }],
    });
  });

  it('refuse un LOBBY tronque au milieu d un pseudo', () => {
    const buf = encodeLobby(1, [{ playerId: 1, weaponId: 1, classId: 0, name: 'Léo' }]);
    expect(() => decode(buf.slice(0, buf.byteLength - 1))).toThrow(/tronque/);
  });

  it('NAME fait l aller-retour, avec et sans nom, accents compris', () => {
    expect(decode(encodeName('Léo'))).toEqual({ type: MSG.NAME, name: 'Léo' });
    expect(encodeName('Léo').byteLength).toBe(2 + 4);
    expect(decode(encodeName(''))).toEqual({ type: MSG.NAME, name: '' });
    expect(encodeName('').byteLength).toBe(2);
  });

  it('NAME : 64 octets au plus sur le fil, a l encodage comme au decodage', () => {
    expect(encodeName('🐉'.repeat(NAME_MAX_CHARS)).byteLength).toBe(2 + NAME_MAX_BYTES);
    expect(() => encodeName('a'.repeat(NAME_MAX_BYTES + 1))).toThrow(/octets/);
    const faux = new Uint8Array(2 + NAME_MAX_BYTES + 1);
    faux[0] = MSG.NAME;
    faux[1] = NAME_MAX_BYTES + 1;
    expect(() => decode(faux.buffer)).toThrow(/octets/);
    expect(() => decode(encodeName('abc').slice(0, 4))).toThrow(/tronque/);
  });

  it('cleanName : trim, controles retires, 16 points de code, vide = pas de nom', () => {
    expect(cleanName('  Léo\u0000\n ')).toBe('Léo');
    expect(cleanName('a'.repeat(30))).toBe('a'.repeat(NAME_MAX_CHARS));
    expect([...cleanName('🐉'.repeat(30))]).toHaveLength(NAME_MAX_CHARS);
    expect(cleanName(' \t ')).toBe('');
  });

  it('REPLAY fait l aller-retour sur un octet', () => {
    expect(encodeReplay().byteLength).toBe(1);
    expect(decode(encodeReplay())).toEqual({ type: MSG.REPLAY });
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
