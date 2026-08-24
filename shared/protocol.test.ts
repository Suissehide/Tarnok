import { describe, expect, it } from 'vitest';

import {
  decode,
  decodeInput,
  decodeSnapshot,
  decodeWaveOrder,
  decodeWelcome,
  encodeInput,
  encodeSnapshot,
  encodeWaveOrder,
  encodeWelcome,
  MSG,
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
  it('rend les positions arrondies a l entier', () => {
    const buf = encodeSnapshot(42, [
      { id: 1, x: 100.4, y: 200.6 },
      { id: 2, x: -3.2, y: 5999.9 },
    ]);

    expect(decodeSnapshot(buf)).toEqual({
      type: MSG.SNAPSHOT,
      tick: 42,
      players: [
        { id: 1, x: 100, y: 201 },
        { id: 2, x: -3, y: 6000 },
      ],
    });
  });

  it('encode un salon vide sans joueur', () => {
    expect(decodeSnapshot(encodeSnapshot(0, [])).players).toEqual([]);
  });

  it('tient un numero de tick sur 32 bits', () => {
    expect(decodeSnapshot(encodeSnapshot(4_294_967_295, [])).tick).toBe(4_294_967_295);
  });

  it("leve quand l'en-tete annonce plus de joueurs que le buffer n'en contient", () => {
    const truncated = encodeSnapshot(1, [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 0, y: 0 },
    ]).slice(0, 9);

    expect(() => decodeSnapshot(truncated)).toThrow(/tronqu/i);
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
