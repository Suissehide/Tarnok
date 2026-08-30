import { describe, expect, it } from 'vitest';

import {
  ARCHETYPES,
  archetypeOf,
  FOOTSOLDIER_COUNT,
  HEAVY_HP,
  LIGHT_HP,
  STEP2_ARCHETYPES,
} from './archetypes';
import { weaponOf } from './weapons';

describe('ARCHETYPES', () => {
  it('indexe chaque archetype a sa position dans le tableau', () => {
    ARCHETYPES.forEach((a, i) => {
      expect(a.id).toBe(i);
    });
  });

  it('tient sur un octet, puisque le protocole encode l archetype en u8', () => {
    expect(ARCHETYPES.length).toBeLessThanOrEqual(256);
  });

  it('donne une planche et un nombre d images a chaque archetype', () => {
    for (const a of ARCHETYPES) {
      expect(a.sheet).toMatch(/\.png$/);
      expect(a.frames).toBeGreaterThan(0);
      expect(a.cell).toBeGreaterThan(0);
      expect(a.speed).toBeGreaterThan(0);
    }
  });

  it('cable les quatre premiers pour l etape 2', () => {
    expect(ARCHETYPES.slice(0, 4).map((a) => a.name)).toEqual([
      'skull',
      'gnoll',
      'spider',
      'torch-goblin',
    ]);
  });

  it("n'a que des cellules de 192 px en pietaille — c'est ce qui tient dans l'atlas", () => {
    for (let i = 0; i < FOOTSOLDIER_COUNT; i++) {
      expect(archetypeOf(i).cell).toBe(192);
    }
  });
});

describe('la reserve de points de vie (etape 5a)', () => {
  /**
   * ⚠️ **C'est la porte du §3.3 de la spec, ecrite en test.** Si la pietaille
   * legere n'a pas EXACTEMENT les degats de la dague, elle ne meurt plus en un
   * coup et le rythme de mise a mort de l'etape 3 change — ce que la spec
   * refuse comme point de depart. Les deux nombres sont lies, pas coincidents :
   * cette assertion est ce qui les tient ensemble si la dague est retouchee.
   */
  it('la pietaille legere meurt en UN coup de dague : LIGHT_HP vaut les degats de l arme de base', () => {
    expect(LIGHT_HP).toBe(weaponOf(0).damage);
  });

  it('la pietaille lourde survit a trois coups de dague et meurt au quatrieme', () => {
    const degats = weaponOf(0).damage;
    expect(HEAVY_HP).toBeGreaterThan(degats * 3);
    expect(HEAVY_HP).toBeLessThanOrEqual(degats * 4);
  });

  it('donne une reserve strictement positive a chaque archetype', () => {
    for (const a of ARCHETYPES) {
      expect(a.hp).toBeGreaterThan(0);
    }
  });

  /**
   * Le plan demande QUATRE lourds parmi les vingt. Compte, plutot que de faire
   * confiance a la liste de noms : une faute de frappe dans `HEAVY_NAMES`
   * (`'gnol'` pour `'gnoll'`) ne leve rien, elle rend simplement l'archetype
   * leger — et toute la pietaille lourde disparaitrait en silence.
   */
  it('compte exactement quatre pietailles lourdes, et rien d autre entre les deux valeurs', () => {
    const lourds = ARCHETYPES.filter((a) => a.hp === HEAVY_HP);
    expect(lourds).toHaveLength(4);
    for (const a of ARCHETYPES) {
      expect([LIGHT_HP, HEAVY_HP]).toContain(a.hp);
    }
  });

  it('ne place aucune pietaille lourde parmi les elites : elles sont hors perimetre', () => {
    for (const a of ARCHETYPES.filter((x) => x.hp === HEAVY_HP)) {
      expect(a.id).toBeLessThan(FOOTSOLDIER_COUNT);
    }
  });

  /**
   * ⚠️ **Le piege de la fixture qui masque, pris a l'avance.** `WaveDirector`
   * ne tire que dans `STEP2_ARCHETYPES` : quatre lourds choisis EN DEHORS de
   * ces quatre-la n'apparaitraient jamais en jeu, la porte du §3.3 mesurerait
   * un rythme de mise a mort rigoureusement inchange, et on en conclurait a
   * tort que donner des PV ne coute rien. Le registre de l'etape 4 compte
   * quatre mutations survivantes pour cette raison exacte — « compter le cas
   * qu'on croit creer, pas le supposer ».
   */
  it('au moins une pietaille lourde est tirable par le generateur de vagues', () => {
    const tirables = STEP2_ARCHETYPES.map((id) => archetypeOf(id));
    expect(tirables.some((a) => a.hp === HEAVY_HP)).toBe(true);
  });
});

describe('archetypeOf', () => {
  it('leve sur un identifiant inconnu plutot que de rendre undefined', () => {
    expect(() => archetypeOf(250)).toThrow(/inconnu/i);
  });
});
