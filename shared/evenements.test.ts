import { describe, expect, it } from 'vitest';

import { CarrierClock } from './evenements';

/**
 * La datation du porteur (etape 16, §8.1) : l'octet d'`EVENT_STATE` attend le
 * `SNAPSHOT` qui le suit dans le meme envoi ; le changement vaut a partir du
 * tick D + 1, D etant le tick de ce snapshot.
 */
describe('etape 16 : CarrierClock', () => {
  it('un octet seul ne change rien ; date par le SNAPSHOT D, il vaut a partir de D + 1', () => {
    const c = new CarrierClock();
    c.heard(2);
    expect(c.at(1_000)).toBe(0);
    expect(c.dated(500)).toEqual({ from: 501, released: 0 });
    expect(c.at(500)).toBe(0);
    expect(c.at(501)).toBe(2);
    expect(c.carrier).toBe(2);
    expect(c.fromTick).toBe(501);
  });

  it('un SNAPSHOT sans octet en attente ne date rien', () => {
    const c = new CarrierClock();
    expect(c.dated(10)).toBeNull();
    c.heard(0);
    expect(c.dated(11)).toBeNull();
  });

  it('la chute : l ancien porteur est rendu (le client le recale), at() suit la date', () => {
    const c = new CarrierClock();
    c.heard(3);
    c.dated(100);
    c.heard(0);
    expect(c.dated(160)).toEqual({ from: 161, released: 3 });
    expect(c.at(160)).toBe(3);
    expect(c.at(161)).toBe(0);
  });

  it('les etats de cadence repetent le porteur : rien a dater', () => {
    const c = new CarrierClock();
    c.heard(1);
    c.dated(10);
    c.heard(1);
    expect(c.dated(16)).toBeNull();
    expect(c.fromTick).toBe(11);
  });

  /**
   * Sous rattrapage (plusieurs pas pour un envoi) : ramasse puis lachee dans
   * le meme envoi. Le dernier octet egal au porteur courant EFFACE l'attente.
   */
  it('ramasse puis lachee dans le meme envoi : rien a dater', () => {
    const c = new CarrierClock();
    c.heard(2);
    c.heard(0);
    expect(c.dated(40)).toBeNull();
    expect(c.at(41)).toBe(0);
  });

  it('porte, lachee puis reprise par le meme dans le meme envoi : l attente s efface, rien a dater', () => {
    const c = new CarrierClock();
    c.heard(1);
    c.dated(10);
    c.heard(0);
    c.heard(1);
    expect(c.dated(20)).toBeNull();
    expect(c.at(21)).toBe(1);
  });

  it('passage de A a B dans le meme envoi : B date, A rendu comme ancien porteur', () => {
    const c = new CarrierClock();
    c.heard(1);
    c.dated(10);
    c.heard(0);
    c.heard(2);
    expect(c.dated(30)).toEqual({ from: 31, released: 1 });
    expect(c.at(30)).toBe(1);
    expect(c.at(31)).toBe(2);
  });
});
