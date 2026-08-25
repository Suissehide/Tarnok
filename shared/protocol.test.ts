import { describe, expect, it } from 'vitest';

import { PLAYER_MAX_HP } from './constants';
import {
  DEATH_ID_BYTES,
  DEATHS_HEADER_BYTES,
  decode,
  decodeDeaths,
  decodeInput,
  decodePickups,
  decodeSnapshot,
  decodeWaveOrder,
  decodeWelcome,
  encodeDeaths,
  encodeInput,
  encodePickups,
  encodeSnapshot,
  encodeWaveOrder,
  encodeWelcome,
  MSG,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_BYTES,
} from './protocol';

describe('encodeInput / decodeInput', () => {
  it("rend exactement l'entree encodee", () => {
    const decoded = decodeInput(encodeInput(1234, -100, 27));

    expect(decoded).toEqual({ type: MSG.INPUT, seq: 1234, moveX: -100, moveY: 27 });
  });

  it('borne les axes a -127..127 au lieu de deborder sur un octet signe', () => {
    const decoded = decodeInput(encodeInput(0, 500, -500));

    expect(decoded.moveX).toBe(127);
    expect(decoded.moveY).toBe(-127);
  });

  it('fait le tour du compteur de sequence sur 16 bits', () => {
    expect(decodeInput(encodeInput(65535, 0, 0)).seq).toBe(65535);
  });

  it('leve sur un buffer tronque plutot que de rendre une entree fantaisiste', () => {
    const truncated = encodeInput(1, 1, 1).slice(0, 3);

    expect(() => decodeInput(truncated)).toThrow(/tronqu/i);
  });
});

describe('encodeSnapshot / decodeSnapshot', () => {
  it('rend les positions arrondies a l entier, avec les pv et l experience', () => {
    const buf = encodeSnapshot(42, [
      { id: 1, x: 100.4, y: 200.6, hp: 80, xp: 350 },
      { id: 2, x: -3.2, y: 5999.9, hp: 42, xp: 12000 },
    ]);

    expect(decodeSnapshot(buf)).toEqual({
      type: MSG.SNAPSHOT,
      tick: 42,
      players: [
        { id: 1, x: 100, y: 201, hp: 80, xp: 350 },
        { id: 2, x: -3, y: 6000, hp: 42, xp: 12000 },
      ],
    });
  });

  it('encode un salon vide sans joueur', () => {
    expect(decodeSnapshot(encodeSnapshot(0, [])).players).toEqual([]);
  });

  it('tient un numero de tick sur 32 bits', () => {
    expect(decodeSnapshot(encodeSnapshot(4_294_967_295, [])).tick).toBe(4_294_967_295);
  });

  it('tient exactement SNAPSHOT_HEADER_BYTES + n * SNAPSHOT_PLAYER_BYTES octets', () => {
    const buf = encodeSnapshot(1, [
      { id: 1, x: 0, y: 0, hp: 1, xp: 0 },
      { id: 2, x: 0, y: 0, hp: 1, xp: 0 },
      { id: 3, x: 0, y: 0, hp: 1, xp: 0 },
    ]);

    expect(buf.byteLength).toBe(SNAPSHOT_HEADER_BYTES + 3 * SNAPSHOT_PLAYER_BYTES);
    expect(SNAPSHOT_PLAYER_BYTES).toBe(8);
  });

  it('tient les pv sur un octet et l experience sur deux (bornes u8 / u16)', () => {
    const buf = encodeSnapshot(1, [{ id: 1, x: 0, y: 0, hp: 255, xp: 65_535 }]);

    expect(decodeSnapshot(buf).players[0]).toEqual({ id: 1, x: 0, y: 0, hp: 255, xp: 65_535 });
  });

  it('PLAYER_MAX_HP tient dans un octet (u8)', () => {
    expect(PLAYER_MAX_HP).toBeLessThanOrEqual(255);
  });

  it("leve quand l'en-tete annonce plus de joueurs que le buffer n'en contient", () => {
    const truncated = encodeSnapshot(1, [
      { id: 1, x: 0, y: 0, hp: 1, xp: 0 },
      { id: 2, x: 0, y: 0, hp: 1, xp: 0 },
    ]).slice(0, 9);

    expect(() => decodeSnapshot(truncated)).toThrow(/tronqu/i);
  });
});

describe('encodeDeaths / decodeDeaths', () => {
  it("rend le tick et les identites, triees dans l'ordre canonique", () => {
    const decoded = decodeDeaths(encodeDeaths(7, [42, 3, 17]));

    expect(decoded).toEqual({ type: MSG.DEATHS, tick: 7, ids: [3, 17, 42] });
  });

  it('tient exactement DEATHS_HEADER_BYTES + n * DEATH_ID_BYTES octets', () => {
    const buf = encodeDeaths(1, [1, 2, 3]);

    expect(buf.byteLength).toBe(DEATHS_HEADER_BYTES + 3 * DEATH_ID_BYTES);
    expect(DEATHS_HEADER_BYTES).toBe(7);
    expect(DEATH_ID_BYTES).toBe(4);
  });

  it('encode un lot vide sans identite morte', () => {
    const buf = encodeDeaths(1, []);

    expect(buf.byteLength).toBe(DEATHS_HEADER_BYTES);
    expect(decodeDeaths(buf).ids).toEqual([]);
  });

  it('tient un compte sur 16 bits, jusqu a 65 535 identites', () => {
    const ids = Array.from({ length: 65_535 }, (_, i) => i);
    const buf = encodeDeaths(1, ids);

    expect(buf.byteLength).toBe(DEATHS_HEADER_BYTES + 65_535 * DEATH_ID_BYTES);
    expect(decodeDeaths(buf).ids).toHaveLength(65_535);
  });

  it('ne grossit pas avec le nombre d entites vivantes, seulement avec les morts', () => {
    const dix = encodeDeaths(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const une = encodeDeaths(1, [1]);

    expect(dix.byteLength - une.byteLength).toBe(9 * 4);
  });

  it('leve sur un buffer tronque plutot que de rendre des identites fantaisistes', () => {
    const truncated = encodeDeaths(1, [1, 2, 3]).slice(0, DEATHS_HEADER_BYTES + 2);

    expect(() => decodeDeaths(truncated)).toThrow(/tronqu/i);
  });
});

describe('encodePickups / decodePickups', () => {
  it("rend le tick et les identites, triees dans l'ordre canonique", () => {
    const decoded = decodePickups(encodePickups(9, [30, 10, 20]));

    expect(decoded).toEqual({ type: MSG.PICKUPS, tick: 9, ids: [10, 20, 30] });
  });

  it('tient exactement DEATHS_HEADER_BYTES + n * DEATH_ID_BYTES octets, comme DEATHS', () => {
    const buf = encodePickups(1, [1, 2, 3]);

    expect(buf.byteLength).toBe(DEATHS_HEADER_BYTES + 3 * DEATH_ID_BYTES);
  });

  it('encode un lot vide sans ramassage', () => {
    expect(decodePickups(encodePickups(1, [])).ids).toEqual([]);
  });

  it('leve sur un buffer tronque', () => {
    const truncated = encodePickups(1, [1, 2, 3]).slice(0, DEATHS_HEADER_BYTES + 2);

    expect(() => decodePickups(truncated)).toThrow(/tronqu/i);
  });

  it("ne se confond jamais avec DEATHS bien que l'encodage soit factorise", () => {
    const deaths = encodeDeaths(5, [1, 2]);
    const pickups = encodePickups(5, [1, 2]);

    expect(new DataView(deaths).getUint8(0)).toBe(MSG.DEATHS);
    expect(new DataView(pickups).getUint8(0)).toBe(MSG.PICKUPS);
    expect(decode(pickups).type).toBe(MSG.PICKUPS);
    expect(decode(deaths).type).toBe(MSG.DEATHS);
  });
});

describe('encodeWelcome / decodeWelcome', () => {
  it("rend l'identifiant attribue, le tick courant et la graine de carte", () => {
    expect(decodeWelcome(encodeWelcome(3, 900, 0xdead_beef))).toEqual({
      type: MSG.WELCOME,
      playerId: 3,
      tick: 900,
      mapSeed: 0xdead_beef,
    });
  });
});

describe('encodeWaveOrder / decodeWaveOrder', () => {
  const order = {
    waveId: 7,
    spawnTick: 1234,
    seed: 0x1234_5678,
    archetype: 2,
    formation: 3,
    anchorX: -1200,
    anchorY: 5900,
    count: 1000,
  };

  it("rend exactement l'ordre encode", () => {
    expect(decodeWaveOrder(encodeWaveOrder(order))).toEqual({
      type: MSG.WAVE_ORDER,
      ...order,
    });
  });

  it('tient en 19 octets : 1 de type et 18 de charge utile', () => {
    expect(encodeWaveOrder(order).byteLength).toBe(19);
  });

  it('ne grossit pas avec le nombre d entites — c est tout le sujet du §3.3', () => {
    const petite = encodeWaveOrder({ ...order, count: 10 });
    const enorme = encodeWaveOrder({ ...order, count: 4000 });

    expect(enorme.byteLength).toBe(petite.byteLength);
  });

  it('leve sur un buffer tronque', () => {
    const tronque = encodeWaveOrder(order).slice(0, 12);

    expect(() => decodeWaveOrder(tronque)).toThrow(/tronqu/i);
  });
});

describe('decode', () => {
  it('aiguille sur le premier octet', () => {
    expect(decode(encodeInput(7, 1, 0))).toMatchObject({ type: MSG.INPUT, seq: 7 });
    expect(decode(encodeSnapshot(8, []))).toMatchObject({ type: MSG.SNAPSHOT, tick: 8 });
    expect(decode(encodeWelcome(1, 9, 0))).toMatchObject({ type: MSG.WELCOME, playerId: 1 });
  });

  it('aiguille aussi sur les morts et les ramassages', () => {
    expect(decode(encodeDeaths(1, [1, 2]))).toMatchObject({ type: MSG.DEATHS, tick: 1 });
    expect(decode(encodePickups(1, [1, 2]))).toMatchObject({ type: MSG.PICKUPS, tick: 1 });
  });

  it('aiguille aussi sur un ordre de vague', () => {
    const buf = encodeWaveOrder({
      waveId: 1,
      spawnTick: 2,
      seed: 3,
      archetype: 0,
      formation: 0,
      anchorX: 0,
      anchorY: 0,
      count: 5,
    });

    expect(decode(buf)).toMatchObject({ type: MSG.WAVE_ORDER, waveId: 1 });
  });

  it('leve sur un type de message inconnu', () => {
    expect(() => decode(new Uint8Array([200]).buffer)).toThrow(/inconnu/i);
  });

  it('leve sur un buffer vide', () => {
    expect(() => decode(new ArrayBuffer(0))).toThrow(/tronqu/i);
  });
});
