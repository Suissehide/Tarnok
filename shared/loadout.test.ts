import { describe, expect, it } from 'vitest';

import { PASSIVE_SLOTS, WEAPON_MAX_LEVEL, WEAPON_SLOTS } from './constants';
import { Loadout } from './loadout';
import { PASSIVES } from './passives';

/**
 * ⚠️ Les identifiants d'epreuve evitent volontairement `0`.
 *
 * La tache 1 de cette etape a livre un test que la mutation « rendre toujours
 * `PASSIVES[0]` » traversait sans echouer, parce qu'il ne verifiait que
 * l'identifiant 0. Une valeur par defaut, un premier indice ou un joueur unique
 * rendent une implementation fausse invisible.
 */
const ARME_A = 1;
const ARME_B = 2;
const PASSIF_A = 1;

describe('Loadout — les armes', () => {
  it('refuse la meme arme deux fois : l exclusivite du §6.2 est binaire', () => {
    const l = new Loadout();
    l.addWeapon(ARME_A);
    expect(() => l.addWeapon(ARME_A)).toThrow();
    expect(l.weaponSlotsUsed).toBe(1);
  });

  it('refuse une arme au-dela de WEAPON_SLOTS', () => {
    const l = new Loadout();
    for (let i = 0; i < WEAPON_SLOTS; i++) {
      l.addWeapon(i + 1);
    }
    expect(l.weaponSlotsUsed).toBe(WEAPON_SLOTS);
    expect(() => l.addWeapon(WEAPON_SLOTS + 1)).toThrow();
  });

  it('conserve l ordre d acquisition', () => {
    const l = new Loadout();
    l.addWeapon(ARME_B);
    l.addWeapon(ARME_A);
    expect([...l.weaponIds]).toEqual([ARME_B, ARME_A]);
  });

  it('monte une arme en niveau, et refuse au-dela du maximum', () => {
    const l = new Loadout();
    l.addWeapon(ARME_A);
    expect(l.levelOf(ARME_A)).toBe(1);
    for (let n = 1; n < WEAPON_MAX_LEVEL; n++) {
      l.levelUpWeapon(ARME_A);
    }
    expect(l.levelOf(ARME_A)).toBe(WEAPON_MAX_LEVEL);
    expect(() => l.levelUpWeapon(ARME_A)).toThrow();
  });

  it('refuse de monter une arme non possedee', () => {
    const l = new Loadout();
    expect(l.levelOf(ARME_A)).toBe(0);
    expect(() => l.levelUpWeapon(ARME_A)).toThrow();
  });
});

describe('Loadout — les passifs empilent', () => {
  it('empile : deux cartes du meme passif doublent le bonus', () => {
    const p = PASSIVES[PASSIF_A];
    if (!p) {
      throw new Error('fixture : passif absent');
    }
    const l = new Loadout();

    l.addPassive(PASSIF_A);
    expect(l.stacksOf(PASSIF_A)).toBe(1);
    const unique = l.bonus(p.kind);

    l.addPassive(PASSIF_A);
    expect(l.stacksOf(PASSIF_A)).toBe(2);
    expect(l.bonus(p.kind)).toBeCloseTo(unique * 2, 6);
  });

  it('un passif DEJA possede ne consomme pas un second slot', () => {
    // ⚠️ C'est le test qui porte le modele Risk of Rain. Une implementation
    // qui compte un slot par CARTE remplirait l'inventaire en trois cartes,
    // la ou le design attend qu'on empile le meme passif des dizaines de fois.
    const l = new Loadout();
    for (let i = 0; i < 12; i++) {
      l.addPassive(PASSIF_A);
    }
    expect(l.passiveSlotsUsed).toBe(1);
    expect(l.stacksOf(PASSIF_A)).toBe(12);
  });

  it('refuse un NOUVEAU passif au-dela de PASSIVE_SLOTS', () => {
    const l = new Loadout();
    for (let i = 0; i < PASSIVE_SLOTS; i++) {
      l.addPassive(i + 1);
    }
    expect(l.passiveSlotsUsed).toBe(PASSIVE_SLOTS);
    expect(() => l.addPassive(PASSIVE_SLOTS + 1)).toThrow();
    // ... mais empiler un DEJA possede reste permis, slots pleins ou non.
    expect(() => l.addPassive(1)).not.toThrow();
    expect(l.stacksOf(1)).toBe(2);
  });

  it('ne melange pas les bonus de deux kinds differents', () => {
    const a = PASSIVES[PASSIF_A];
    const b = PASSIVES.find((x) => x.kind !== a?.kind);
    if (!a || !b) {
      throw new Error('fixture : deux kinds distincts requis');
    }
    const l = new Loadout();
    l.addPassive(a.id);
    expect(l.bonus(a.kind)).toBeCloseTo(a.magnitude, 6);
    expect(l.bonus(b.kind)).toBe(0);
  });

  it('rend zero pour un kind dont aucun passif n est possede', () => {
    const l = new Loadout();
    expect(l.bonus('damage')).toBe(0);
  });
});
