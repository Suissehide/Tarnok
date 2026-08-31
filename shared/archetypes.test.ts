import { describe, expect, it } from 'vitest';

import {
  ARCHETYPES,
  archetypeOf,
  BOSS_ARCHETYPE,
  BOSS_BODY_SCALE,
  BOSS_HP_BASE,
  BOSS_HP_MULTIPLE,
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
      // ⚠️ **Le boss est la SEULE exception, et elle est nommee.** Ecrire
      // `.filter((a) => a.hp !== BOSS_HP_BASE)` laisserait passer deux boss ;
      // comparer a l'identifiant dit qu'il n'y en a qu'un, ce que le §1.1 de la
      // spec de l'etape 6a exige pour que la vie du boss ait le droit de
      // voyager.
      const attendues = a.id === BOSS_ARCHETYPE ? [BOSS_HP_BASE] : [LIGHT_HP, HEAVY_HP];
      expect(attendues).toContain(a.hp);
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

/**
 * L'archetype de boss (etape 6a, tache 3).
 *
 * ⚠️ **Ce que ces tests gardent n'est PAS « le boss a beaucoup de PV »** — ca,
 * n'importe quel nombre le satisferait. Ils gardent trois regles de conception
 * que le reste du jeu suppose sans jamais les verifier : qu'il n'y en ait
 * qu'UN, qu'il ne soit JAMAIS tire comme une vague ordinaire, et que son corps
 * ait son propre facteur au lieu de relever le plafond commun.
 */
describe("l'archetype de boss (etape 6a)", () => {
  /**
   * ⚠️ **LA regle du §1.1 de la spec, ecrite en test.** La vie du boss n'a le
   * droit de voyager dans le snapshot QUE parce qu'il est un : *« si un jour un
   * palier fait apparaitre dix boss, ce n'est plus un boss, c'est de la
   * pietaille d'elite — et sa vie redevient serveur seul »*. Ce compte est ce
   * qui fera rougir la tache 4 le jour ou quelqu'un ajoutera un second boss au
   * bestiaire en croyant faire du contenu.
   */
  it("n'existe qu'en UN exemplaire dans tout le bestiaire", () => {
    expect(ARCHETYPES.filter((a) => a.hp === BOSS_HP_BASE)).toHaveLength(1);
    expect(archetypeOf(BOSS_ARCHETYPE).hp).toBe(BOSS_HP_BASE);
  });

  /**
   * Le §4 de la spec : *« plusieurs centaines de fois ceux de la pietaille
   * lourde »*. Le rapport est DERIVE de `HEAVY_HP`, jamais un 6 000 recopie —
   * retoucher la pietaille lourde deplacerait sinon le boss sans que rien ne le
   * dise.
   */
  it('encaisse plusieurs centaines de fois la pietaille lourde, comme le §4 le demande', () => {
    expect(BOSS_HP_BASE).toBe(HEAVY_HP * BOSS_HP_MULTIPLE);
    expect(BOSS_HP_MULTIPLE).toBeGreaterThanOrEqual(100);
    expect(BOSS_HP_MULTIPLE).toBeLessThan(1000);
  });

  /**
   * ⚠️ **Le piege de la fixture qui masque, dans son autre sens.** Le
   * generateur ne tire QUE dans `STEP2_ARCHETYPES` pour ses vagues ordinaires
   * (`back/src/wave-director.ts`) : si le boss s'y glissait, une vague de 200
   * boss tomberait toutes les six secondes et le §1.1 serait viole sans qu'un
   * seul test du salon ne bouge.
   */
  it("n'est jamais tirable comme une vague ordinaire", () => {
    expect(STEP2_ARCHETYPES).not.toContain(BOSS_ARCHETYPE);
    expect(BOSS_ARCHETYPE).toBeGreaterThanOrEqual(FOOTSOLDIER_COUNT);
  });

  /**
   * **Les deux moities**, et elles ne se couvrent pas : « le boss deborde »
   * passe tout seul avec un `bodyScale` de 3 pour tout le monde — les vingt
   * archetypes grossiraient d'un coup, ce que le plafond de `BODY_SCALE`
   * refuse justement. « La pietaille reste a 1 » passe tout seul avec un
   * `bodyScale` constant.
   */
  it('a son PROPRE facteur de corps, et il ne deborde sur personne', () => {
    expect(archetypeOf(BOSS_ARCHETYPE).bodyScale).toBe(BOSS_BODY_SCALE);
    expect(BOSS_BODY_SCALE).toBeGreaterThan(1);
    for (const a of ARCHETYPES) {
      if (a.id === BOSS_ARCHETYPE) {
        continue;
      }
      expect(a.bodyScale).toBe(1);
    }
  });
});
