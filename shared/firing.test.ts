import { describe, expect, it } from 'vitest';

import { COLOSSUS_HP_STEP } from './constants';
import { armedWeapon, shotDamage, weaponUpgrades } from './firing';
import { Loadout } from './loadout';
import { PASSIVES, type PassiveKind } from './passives';
import {
  DAMAGE_PER_UPGRADE,
  effectRadius,
  salvoCount,
  UPGRADE,
  WEAPONS,
  type Weapon,
  weaponOf,
} from './weapons';

function genre(kind: PassiveKind): number {
  const p = PASSIVES.find((x) => x.kind === kind);
  if (!p) {
    throw new Error(`fixture : aucun passif de genre ${kind}`);
  }
  return p.id;
}

function avec(kind: PassiveKind, cartes: number, ...armes: number[]): Loadout {
  const l = new Loadout();
  for (const a of armes) {
    l.addWeapon(a);
  }
  for (let i = 0; i < cartes; i++) {
    l.addPassive(genre(kind));
  }
  return l;
}

function arme(test: (w: Weapon) => boolean, quoi: string): Weapon {
  const w = WEAPONS.find(test);
  if (!w) {
    throw new Error(`fixture : aucune arme ${quoi}`);
  }
  return w;
}

const TIR = arme((w) => w.kind === 'tir' && w.perks.includes(UPGRADE.SALVO), 'de tir a salve');
const HALO = arme((w) => w.kind === 'halo', 'halo');

describe('etape 10 : crans de l arme + crans des passifs (weaponUpgrades)', () => {
  it('Volee ajoute un cran de salve par carte a une arme de TIR', () => {
    const l = avec('salvo', 2, TIR.id);
    expect(weaponUpgrades(l, TIR)(UPGRADE.SALVO)).toBe(2);
    // Et se cumule aux cartes « salve » de l'arme elle-meme.
    l.addWeapon(TIR.id, UPGRADE.SALVO);
    expect(weaponUpgrades(l, TIR)(UPGRADE.SALVO)).toBe(3);
  });

  it('Volee ne touche PAS un halo', () => {
    const l = avec('salvo', 3, HALO.id);
    expect(weaponUpgrades(l, HALO)(UPGRADE.SALVO)).toBe(0);
  });

  it('Ampleur ajoute un cran de zone par carte a TOUTES les armes', () => {
    const l = avec('zone', 2, TIR.id, HALO.id);
    expect(weaponUpgrades(l, TIR)(UPGRADE.ZONE)).toBe(2);
    expect(weaponUpgrades(l, HALO)(UPGRADE.ZONE)).toBe(2);
    // Et rien d'autre.
    expect(weaponUpgrades(l, HALO)(UPGRADE.PIERCE)).toBe(0);
  });

  it('armedWeapon applique ces crans : salve elargie, cercle elargi', () => {
    expect(armedWeapon(avec('salvo', 1, TIR.id), TIR.id).projectileCount).toBe(salvoCount(TIR, 2));
    expect(armedWeapon(avec('zone', 1, HALO.id), HALO.id).blastRadius).toBeCloseTo(
      effectRadius(HALO, 2),
      6,
    );
  });

  it('sans rien d ameliore, armedWeapon rend l entree du catalogue elle-meme', () => {
    const l = avec('salvo', 0, TIR.id);
    expect(armedWeapon(l, TIR.id)).toBe(weaponOf(TIR.id));
  });
});

describe('etape 10 : la formule de degats partagee (shotDamage)', () => {
  it('somme passifs, compte et cartes « degats » comme le faisaient les deux copies', () => {
    const l = avec('damage', 2, TIR.id);
    l.addWeapon(TIR.id, UPGRADE.DAMAGE);
    const passif = l.bonus('damage');
    expect(passif).toBeGreaterThan(0);
    expect(shotDamage(TIR, l, 0.1, 100)).toBeCloseTo(
      TIR.damage * (1 + passif + 0.1 + DAMAGE_PER_UPGRADE),
      6,
    );
  });
});

describe('etape 10 : Colosse, +1 % de degats par tranche de 10 PV max', () => {
  it.each([
    [0, 100, 1],
    [1, 100, 1.1],
    [1, 120, 1.12],
    [1, 129, 1.12],
    [2, 100, 1.2],
  ])('%i carte(s) a %i PV max : x%f', (cartes, maxHp, facteur) => {
    const l = avec('colossus', cartes, TIR.id);
    expect(COLOSSUS_HP_STEP).toBe(10);
    expect(shotDamage(TIR, l, 0, maxHp)).toBeCloseTo(TIR.damage * facteur, 6);
  });

  it('se MULTIPLIE aux autres bonus de degats, il ne s y ajoute pas', () => {
    const l = avec('damage', 1, TIR.id);
    l.addPassive(genre('colossus'));
    expect(shotDamage(TIR, l, 0, 100)).toBeCloseTo(TIR.damage * (1 + l.bonus('damage')) * 1.1, 6);
  });
});
