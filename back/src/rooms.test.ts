import { describe, expect, it } from 'vitest';

import { ROOM_CODE_ALPHABET, RoomRegistry } from './rooms';

describe('RoomRegistry.create', () => {
  it('rend un code de quatre lettres pris dans l alphabet des codes', () => {
    const { code } = new RoomRegistry().create();

    expect(code).toHaveLength(4);
    for (const letter of code) {
      expect(ROOM_CODE_ALPHABET).toContain(letter);
    }
  });

  it("n'utilise ni I ni O, qu'on lit pour 1 et 0 quand on dicte un code", () => {
    expect(ROOM_CODE_ALPHABET).not.toContain('I');
    expect(ROOM_CODE_ALPHABET).not.toContain('O');
  });

  it('ne rend jamais deux fois le meme code', () => {
    const registry = new RoomRegistry();
    const codes = new Set<string>();
    for (let i = 0; i < 500; i++) {
      codes.add(registry.create().code);
    }

    expect(codes.size).toBe(500);
  });
});

describe('RoomRegistry.get', () => {
  it('retrouve le salon cree', () => {
    const registry = new RoomRegistry();
    const { code, room } = registry.create();

    expect(registry.get(code)).toBe(room);
  });

  it('accepte un code saisi en minuscules', () => {
    const registry = new RoomRegistry();
    const { code, room } = registry.create();

    expect(registry.get(code.toLowerCase())).toBe(room);
  });

  it('rend undefined sur un code inconnu au lieu de creer un salon', () => {
    const registry = new RoomRegistry();

    expect(registry.get('ZZZZ')).toBeUndefined();
    expect(registry.size).toBe(0);
  });
});

describe('RoomRegistry.delete', () => {
  it('retire le salon', () => {
    const registry = new RoomRegistry();
    const { code } = registry.create();

    registry.delete(code);

    expect(registry.get(code)).toBeUndefined();
    expect(registry.size).toBe(0);
  });
});
