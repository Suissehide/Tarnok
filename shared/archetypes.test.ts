import { describe, expect, it } from 'vitest';

import {
  ARCHETYPES,
  archetypeIdOf,
  archetypeOf,
  BOSS_ARCHETYPE,
  BOSS_ARMOR,
  BOSS_BODY_SCALE,
  BOSS_HP_MULTIPLE,
  BOSS_HP_PER_PLAYER,
  capArmor,
  FOOTSOLDIER_COUNT,
  HEAVY_ARMOR,
  HEAVY_HP,
  LIGHT_HP,
  MAX_ARMOR,
  PORTEUR_ARCHETYPE,
  PORTEUR_BODY_SCALE,
  PORTEUR_HP,
  PORTEUR_HP_MULTIPLE,
  PORTEUR_NAME,
  PORTEUR_SPEED_FACTOR,
  ROLE_ORDER,
  ROLES,
  type Role,
  STEP2_ARCHETYPES,
} from './archetypes';
import { MAX_PLAYERS, PLAYER_SPEED, REACTION_DAMAGE } from './constants';
import { bossHp } from './paliers';
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
  it('donne a chaque pietaille les PV de son role, le boss et le porteur seuls faisant exception', () => {
    // Quatre brutes a `HEAVY_HP`, comme les quatre lourdes d'avant.
    expect(ARCHETYPES.filter((a) => a.hp === HEAVY_HP)).toHaveLength(4);
    for (const a of ARCHETYPES) {
      // ⚠️ **Deux exceptions, et elles sont nommees** (le porteur depuis
      // l'etape 11) : comparer a l'identifiant dit qu'il n'y en a pas d'autre.
      const attendu =
        a.id === BOSS_ARCHETYPE
          ? BOSS_HP_PER_PLAYER
          : a.id === PORTEUR_ARCHETYPE
            ? PORTEUR_HP
            : ROLES[a.role].hp;
      expect(a.hp, a.name).toBe(attendu);
    }
  });

  /**
   * Retour de playtest : *« il faudrait que les types de monstres soient
   * uniques »*. Le contrat des roles, ordonne : la nuee est la plus rapide et
   * la plus nombreuse, le colosse le plus lent, le plus resistant et le plus
   * rare — et chaque role compte au moins un archetype tirable.
   */
  it('ordonne les roles : nuee, troupe, brute, colosse, du plus vif au plus lourd', () => {
    const tirables = STEP2_ARCHETYPES.map(archetypeOf);
    const de = (r: Role) => tirables.filter((a) => a.role === r);
    for (const r of ROLE_ORDER) {
      expect(de(r).length, r).toBeGreaterThan(0);
    }
    for (let k = 1; k < ROLE_ORDER.length; k++) {
      const vif = ROLE_ORDER[k - 1] as Role;
      const lourd = ROLE_ORDER[k] as Role;
      // Chaque archetype du role plus vif court plus vite que TOUS ceux du suivant.
      expect(Math.min(...de(vif).map((a) => a.speed))).toBeGreaterThanOrEqual(
        Math.max(...de(lourd).map((a) => a.speed)),
      );
      expect(ROLES[vif].hp).toBeLessThan(ROLES[lourd].hp);
      expect(ROLES[vif].countFactor).toBeGreaterThan(ROLES[lourd].countFactor);
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
    expect(ARCHETYPES.filter((a) => a.hp === BOSS_HP_PER_PLAYER)).toHaveLength(1);
    expect(archetypeOf(BOSS_ARCHETYPE).hp).toBe(BOSS_HP_PER_PLAYER);
  });

  /**
   * Le §4 de la spec : *« plusieurs centaines de fois ceux de la pietaille
   * lourde »*. Le rapport est DERIVE de `HEAVY_HP`, jamais un 6 000 recopie —
   * retoucher la pietaille lourde deplacerait sinon le boss sans que rien ne le
   * dise.
   *
   * ⚠️ **Le rapport se lit A EFFECTIF PLEIN depuis la tache 3 bis**, et c'est
   * la seule lecture qui rende vraies ensemble les deux phrases du §4 —
   * *« plusieurs centaines de fois »* ET *« croissant avec le nombre de
   * joueurs »*. En solo le boss vaut 75 fois la pietaille lourde ; a quatre,
   * 300. C'est l'equipe de quatre que ce jeu vise et que la porte du §7 a
   * mesuree.
   */
  it('encaisse plusieurs centaines de fois la pietaille lourde a effectif plein, comme le §4 le demande', () => {
    expect(BOSS_HP_PER_PLAYER).toBe(HEAVY_HP * BOSS_HP_MULTIPLE);
    expect(BOSS_HP_MULTIPLE * MAX_PLAYERS).toBeGreaterThanOrEqual(100);
    expect(BOSS_HP_MULTIPLE * MAX_PLAYERS).toBeLessThan(1000);
    // Et le boss d'une equipe pleine EST ce multiple-la : sans cette ligne, le
    // rapport garde ci-dessus ne serait plus celui d'aucun boss reel.
    expect(bossHp(0, MAX_PLAYERS)).toBe(HEAVY_HP * BOSS_HP_MULTIPLE * MAX_PLAYERS);
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
  it('a son PROPRE facteur de corps, plus gros que tout le bestiaire', () => {
    expect(archetypeOf(BOSS_ARCHETYPE).bodyScale).toBe(BOSS_BODY_SCALE);
    expect(BOSS_BODY_SCALE).toBeGreaterThan(1);
    for (const a of ARCHETYPES) {
      if (a.id === BOSS_ARCHETYPE) {
        continue;
      }
      // Le porteur (etape 11) a SON facteur, lui aussi — sous celui du boss.
      const attendu = a.id === PORTEUR_ARCHETYPE ? PORTEUR_BODY_SCALE : ROLES[a.role].bodyScale;
      expect(a.bodyScale, a.name).toBe(attendu);
      expect(a.bodyScale).toBeLessThan(BOSS_BODY_SCALE);
    }
  });
});

describe("l'armure (etape 5b, tache 1)", () => {
  it('donne ZERO a la pietaille legere — une entree de la table, pas un cas particulier', () => {
    // ⚠️ **Le `0` doit etre LU, pas saute.** Si la legere n'avait pas de ligne
    // dans la table, `appliquerDegats` aurait besoin d'une branche
    // `if (armor !== undefined)` — exactement ce que `ELEMENT.NEUTRE` et
    // `blastRadius: 0` existent pour eviter.
    for (const a of ARCHETYPES) {
      if (a.hp === LIGHT_HP) {
        expect(a.armor, a.name).toBe(0);
      }
    }
    // Non-vacuite : il y a bien de la pietaille legere dans la table.
    expect(ARCHETYPES.filter((a) => a.hp === LIGHT_HP).length).toBeGreaterThan(0);
  });

  it('donne a chacun l armure de son role : brutes et colosses blindes, le boss a part', () => {
    const armures = ARCHETYPES.filter((a) => a.armor > 0);
    // Le compte, pas seulement la presence : une armure posee sur tout le
    // bestiaire passerait sinon.
    expect(armures.length).toBe(
      ARCHETYPES.filter((a) => a.id !== BOSS_ARCHETYPE && ROLES[a.role].armor > 0).length + 1,
    );
    for (const a of ARCHETYPES.filter((x) => x.id !== BOSS_ARCHETYPE)) {
      expect(a.armor, a.name).toBe(ROLES[a.role].armor);
    }
    expect(ROLES.brute.armor).toBe(HEAVY_ARMOR);
    expect(archetypeOf(BOSS_ARCHETYPE).armor).toBe(BOSS_ARMOR);
  });

  it('le Choc thermique tue encore la pietaille lourde MALGRE son armure', () => {
    // ⚠️ **La relation que `HEAVY_ARMOR` doit respecter, et qui se perdrait en
    // silence.** Le docbloc de `REACTION_DAMAGE` engage *« 25, c'est plus que
    // `HEAVY_HP` (20), donc la reaction tue la pietaille lourde d'un coup »* ;
    // le choc passant par `appliquerDegats`, c'est le produit qu'il faut
    // comparer. A 0,25 d'armure il vaudrait 18,75 et le Choc thermique
    // cesserait de nettoyer la lourde — sans qu'aucun test ne bouge si celui-ci
    // n'existait pas.
    expect(REACTION_DAMAGE * (1 - HEAVY_ARMOR)).toBeGreaterThan(HEAVY_HP);
  });

  it('ne laisse AUCUN archetype depasser le plafond : un coup retire toujours quelque chose', () => {
    // Le plancher de degats du jeu entier, lu a l'envers : `armor <= 0,9` veut
    // dire « au moins un dixieme du brut arrive toujours aux PV ».
    expect(MAX_ARMOR).toBeLessThan(1);
    for (const a of ARCHETYPES) {
      expect(a.armor, a.name).toBeLessThanOrEqual(MAX_ARMOR);
      expect(a.armor, a.name).toBeGreaterThanOrEqual(0);
    }
  });

  it('capArmor rabat une valeur aberrante sur le plafond et laisse le reste intact', () => {
    // ⚠️ **0,97 et 0,12 ne sont AUCUNE constante de production**, et c'est le
    // point : une valeur de decor egale a une valeur de production rend la
    // borne inverifiable (`GEL_TICKS` valait `LEVEL_FREEZE_TICKS`, et 80 tests
    // passaient sur une derivation fausse).
    expect(capArmor(0.97)).toBe(MAX_ARMOR);
    expect(capArmor(1)).toBe(MAX_ARMOR);
    expect(capArmor(0.12)).toBe(0.12);
    // La borne est LARGE : une armure pile au plafond est legale.
    expect(capArmor(MAX_ARMOR)).toBe(MAX_ARMOR);
  });
});

describe('etape 11 : le porteur de coffre', () => {
  const PORTEUR = archetypeOf(PORTEUR_ARCHETYPE);
  const VOLEUR = archetypeOf(archetypeIdOf('thief'));

  it('vient APRES le troll : aucun identifiant existant ne bouge', () => {
    expect(PORTEUR.name).toBe(PORTEUR_NAME);
    expect(PORTEUR_ARCHETYPE).toBe(BOSS_ARCHETYPE + 1);
    expect(ARCHETYPES[PORTEUR_ARCHETYPE - 1]?.name).toBe('troll');
    expect(ARCHETYPES).toHaveLength(PORTEUR_ARCHETYPE + 1);
  });

  it('a son propre comportement, et n est jamais tire au hasard', () => {
    expect(PORTEUR.behavior).toBe('porteur');
    expect(STEP2_ARCHETYPES).not.toContain(PORTEUR_ARCHETYPE);
    // Le voleur ordinaire ne change pas.
    expect(VOLEUR.behavior).toBe('voleur');
    expect(VOLEUR.id).toBe(8);
  });

  it('PV = HEAVY_HP x PORTEUR_HP_MULTIPLE, armure nulle, role troupe', () => {
    expect(PORTEUR_HP).toBe(HEAVY_HP * PORTEUR_HP_MULTIPLE);
    expect(PORTEUR.hp).toBe(200);
    expect(PORTEUR.armor).toBe(0);
    expect(PORTEUR.role).toBe('troupe');
    expect(PORTEUR.countFactor).toBe(1);
  });

  it('un peu moins vite qu un joueur : round(PLAYER_SPEED x 0,9) = 234 px/s', () => {
    expect(PORTEUR.speed).toBe(Math.round(PLAYER_SPEED * PORTEUR_SPEED_FACTOR));
    expect(PORTEUR.speed).toBe(234);
    expect(PORTEUR.speed).toBeLessThan(PLAYER_SPEED);
  });

  it('porte la planche du voleur, 1,6 fois plus grand', () => {
    expect(PORTEUR.sheet).toBe(VOLEUR.sheet);
    expect(PORTEUR.frames).toBe(VOLEUR.frames);
    expect(PORTEUR.cell).toBe(VOLEUR.cell);
    expect(PORTEUR.bodyScale).toBe(PORTEUR_BODY_SCALE);
    expect(VOLEUR.bodyScale).toBe(1);
  });
});
