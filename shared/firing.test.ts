import { describe, expect, it } from 'vitest';

import { COLOSSUS_HP_STEP, CRIT_CHANCE, CRIT_MULTIPLIER } from './constants';
import {
  aimPoint,
  armedWeapon,
  critOf,
  fireCooldown,
  lastFireAfterCarry,
  shotDamage,
  weaponUpgrades,
} from './firing';
import { Loadout } from './loadout';
import { PASSIVES, type PassiveKind } from './passives';
import {
  cooldownWithBonus,
  DAMAGE_PER_UPGRADE,
  effectRadius,
  FIRE_RATE_PER_UPGRADE,
  salvoCount,
  UPGRADE,
  upgradesFor,
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
  it('somme passifs et compte, puis MULTIPLIE par les cartes « degats » de l arme', () => {
    const l = avec('damage', 2, TIR.id);
    l.addWeapon(TIR.id, UPGRADE.DAMAGE);
    const passif = l.bonus('damage');
    expect(passif).toBeGreaterThan(0);
    expect(shotDamage(TIR, l, 0.1, 100)).toBeCloseTo(
      TIR.damage * (1 + passif + 0.1) * (1 + DAMAGE_PER_UPGRADE),
      6,
    );
  });

  /**
   * ⚠️ **Etape 15 : les cartes « degats » se COMPOSENT.** Additive, la
   * formule d'avant (`1 + n x 0,25`) passe le test a une carte ci-dessus ; a
   * quatre cartes elle rend x2, la composee x2,44. C'est cet ecart que ce test
   * garde — et la raison : la huitieme carte additive ne valait plus que
   * +7 % relatifs, les chiffres de fin de run restaient petits.
   */
  it('quatre cartes « degats » font (1 + DAMAGE_PER_UPGRADE)^4, pas 1 + 4 x DAMAGE_PER_UPGRADE', () => {
    const l = avec('damage', 0, TIR.id);
    for (let i = 0; i < 4; i++) {
      l.addWeapon(TIR.id, UPGRADE.DAMAGE);
    }
    const composee = (1 + DAMAGE_PER_UPGRADE) ** 4;
    const additive = 1 + 4 * DAMAGE_PER_UPGRADE;
    expect(composee).not.toBeCloseTo(additive, 2);
    expect(shotDamage(TIR, l, 0, 100)).toBeCloseTo(TIR.damage * composee, 6);
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

describe('etape 10 : le critique du tireur (critOf)', () => {
  it('sans carte : la chance et le multiplicateur de base', () => {
    expect(critOf(new Loadout())).toEqual({ chance: CRIT_CHANCE, multiplier: CRIT_MULTIPLIER });
  });

  it('Precision ajoute 4 points par carte, et s arrete a 100 %', () => {
    expect(critOf(avec('critChance', 1)).chance).toBeCloseTo(CRIT_CHANCE + 0.04, 9);
    expect(critOf(avec('critChance', 30)).chance).toBe(1);
  });

  it('Ferocite ajoute 0,3 au multiplicateur par carte, sans plafond', () => {
    expect(critOf(avec('critDamage', 2)).multiplier).toBeCloseTo(CRIT_MULTIPLIER + 0.6, 9);
    expect(critOf(avec('critDamage', 50)).multiplier).toBeCloseTo(CRIT_MULTIPLIER + 15, 9);
  });
});

describe('etape 12 : le point vise (aimPoint)', () => {
  it('pose le point a la distance demandee, quelle que soit la norme de la visee', () => {
    const p = aimPoint(10, 20, 127, 0, 100);
    expect(p.x).toBeCloseTo(110);
    expect(p.y).toBeCloseTo(20);
    const d = aimPoint(0, 0, 90, -90, 50);
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(50);
  });

  it('rend le tireur sur une visee nulle', () => {
    expect(aimPoint(3, 4, 0, 0, 100)).toEqual({ x: 3, y: 4 });
  });
});

describe('etape 16 : la recharge et la reprise apres un port de relique', () => {
  /** L'expression ecrite dans `Room#fireOne` et `GameClient#fireOne` avant l'etape. */
  function ancienne(l: Loadout, w: number, compte: number): number {
    return cooldownWithBonus(
      armedWeapon(l, w).cooldownTicks,
      l.bonus('fireRate') + compte + FIRE_RATE_PER_UPGRADE * l.upgradesOf(w, UPGRADE.FIRE_RATE),
    );
  }

  it('fireCooldown rend ce que Room#fireOne calculait, armes, cartes de cadence, aspects et compte', () => {
    for (const w of WEAPONS) {
      for (const cartes of [0, 1, 3]) {
        for (const compte of [0, 0.1]) {
          const l = avec('fireRate', cartes, w.id);
          if (upgradesFor(w).includes(UPGRADE.FIRE_RATE)) {
            l.addWeapon(w.id, UPGRADE.FIRE_RATE);
            l.addWeapon(w.id, UPGRADE.FIRE_RATE);
          }
          expect(fireCooldown(l, w.id, compte)).toBe(ancienne(l, w.id, compte));
        }
      }
    }
  });

  it('lastFireAfterCarry : recharge faite au depart, la premiere salve a `from`, puis tous les `cooldown`', () => {
    // Derniere salve a 100, recharge 4, porte de 101 a 150 : libre a 151.
    expect(lastFireAfterCarry(100, 151, 151, 4)).toBe(100); // rien de tire avant 151
    expect(lastFireAfterCarry(100, 151, 152, 4)).toBe(151);
    expect(lastFireAfterCarry(100, 151, 155, 4)).toBe(151);
    expect(lastFireAfterCarry(100, 151, 156, 4)).toBe(155);
    expect(lastFireAfterCarry(100, 151, 158, 4)).toBe(155);
  });

  it('lastFireAfterCarry : recharge PAS faite a `from` — la premiere salve attend last + cooldown', () => {
    // Port court : derniere salve a 100, recharge 36 (grenade), libre a 105.
    expect(lastFireAfterCarry(100, 105, 120, 36)).toBe(100);
    expect(lastFireAfterCarry(100, 105, 137, 36)).toBe(136);
  });

  it('lastFireAfterCarry : jamais tire (-Infinity), la premiere salve est `from`', () => {
    expect(lastFireAfterCarry(Number.NEGATIVE_INFINITY, 40, 41, 4)).toBe(40);
    expect(lastFireAfterCarry(Number.NEGATIVE_INFINITY, 40, 40, 4)).toBe(Number.NEGATIVE_INFINITY);
  });
});
