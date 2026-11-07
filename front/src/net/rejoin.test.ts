import { RECONNECT_GRACE_MS } from '@shared/constants';
import { CLOSE_CODES } from '@shared/protocol';
import { describe, expect, it } from 'vitest';

import {
  DEFINITIVE_CLOSE_CODES,
  forgetRejoin,
  REJOIN_KEY,
  REPLAY_KEY,
  readRejoin,
  readReplay,
  rememberRejoin,
  shouldRejoin,
  writeReplay,
} from './rejoin';

function memoire(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const casse = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> => ({
  getItem: () => {
    throw new Error('stockage indisponible');
  },
  setItem: () => {
    throw new Error('stockage indisponible');
  },
  removeItem: () => {
    throw new Error('stockage indisponible');
  },
});

describe('etape 18 : rejoindre ou pas', () => {
  it('les six codes definitifs rendent faux, meme en run', () => {
    expect(DEFINITIVE_CLOSE_CODES.size).toBe(6);
    for (const code of [
      CLOSE_CODES.UNKNOWN_ROOM,
      CLOSE_CODES.ROOM_FULL,
      CLOSE_CODES.UNKNOWN_TOKEN,
      CLOSE_CODES.ROOM_CLOSED,
      CLOSE_CODES.NO_HELLO,
      CLOSE_CODES.BAD_FRAME,
    ]) {
      expect(shouldRejoin(code, true, false)).toBe(false);
    }
  });

  it('1006 (anormale) et sans code, en run, rendent vrai ; hors run ou volontaire, faux', () => {
    expect(shouldRejoin(1006, true, false)).toBe(true);
    expect(shouldRejoin(undefined, true, false)).toBe(true);
    expect(shouldRejoin(1006, false, false)).toBe(false);
    expect(shouldRejoin(1006, true, true)).toBe(false);
    // Une erreur interne n est pas un refus : on retente.
    expect(shouldRejoin(CLOSE_CODES.INTERNAL_ERROR, true, false)).toBe(true);
  });
});

describe('etape 18 : le mot dans le stockage', () => {
  it('rend le code sous la fenetre, et le garde', () => {
    const s = memoire();
    rememberRejoin(s, 'ABCD', 1000);
    expect(readRejoin(s, 1000 + RECONNECT_GRACE_MS - 1)).toBe('ABCD');
    expect(s.data.has(REJOIN_KEY)).toBe(true);
  });

  it('au-dela de RECONNECT_GRACE_MS : null, et efface', () => {
    const s = memoire();
    rememberRejoin(s, 'ABCD', 1000);
    expect(readRejoin(s, 1000 + RECONNECT_GRACE_MS)).toBeNull();
    expect(s.data.has(REJOIN_KEY)).toBe(false);
  });

  it('vide ou mal forme : null, et efface', () => {
    const s = memoire();
    expect(readRejoin(s, 0)).toBeNull();
    s.setItem(REJOIN_KEY, '{"code":4}');
    expect(readRejoin(s, 0)).toBeNull();
    expect(s.data.has(REJOIN_KEY)).toBe(false);
    s.setItem(REJOIN_KEY, 'pas du json');
    expect(readRejoin(s, 0)).toBeNull();
  });

  it('forgetRejoin efface', () => {
    const s = memoire();
    rememberRejoin(s, 'ABCD', 1000);
    forgetRejoin(s);
    expect(readRejoin(s, 1000)).toBeNull();
  });

  it('un stockage qui leve ne casse rien', () => {
    const s = casse();
    expect(() => rememberRejoin(s, 'ABCD', 0)).not.toThrow();
    expect(readRejoin(s, 0)).toBeNull();
    expect(() => forgetRejoin(s)).not.toThrow();
  });
});

describe('rejouer ensemble : le mot dans le stockage', () => {
  it('rend le code une fois, puis plus rien', () => {
    const s = memoire();
    expect(readReplay(s)).toBeNull();
    writeReplay(s, 'ABCD');
    expect(s.data.get(REPLAY_KEY)).toBe('ABCD');
    expect(readReplay(s)).toBe('ABCD');
    expect(readReplay(s)).toBeNull();
    expect(s.data.has(REPLAY_KEY)).toBe(false);
  });

  it('un stockage qui leve ne casse rien', () => {
    const s = casse();
    expect(() => writeReplay(s, 'ABCD')).not.toThrow();
    expect(readReplay(s)).toBeNull();
  });
});
