import { describe, expect, it } from 'vitest';

import { ARCHETYPES, BOSS_HP_PER_PLAYER, HEAVY_HP, LIGHT_HP } from './archetypes';
import {
  GOLD_PER_PALIER_BASE,
  MAX_PLAYERS,
  PALIER_COUNT_SCALE,
  PALIER_HP_SCALE,
} from './constants';
import { bossHp, hpScale, palierGold, palierHp, waveCountScale } from './paliers';
import { weaponOf } from './weapons';

/**
 * Le test de ces formules a DEUX MOITIES, et elles ne sont pas
 * interchangeables :
 *
 * - **croissance stricte** sur dix paliers — sans elle, une constante passe ;
 * - **valeur de base exacte a `k = 0`** — sans elle, une formule qui s'emballe
 *   passe.
 *
 * Ce depot a trouve **neuf decors** qui ne separaient pas deux cas qu'ils
 * pretendaient distinguer. Les deux moities sont donc ecrites en PREDICATS
 * plutot qu'en assertions inline, et le premier test ci-dessous les eprouve
 * l'une contre l'autre sur deux contre-exemples : c'est ce qui prouve qu'aucune
 * des deux n'est decorative.
 */

/** Nombre de paliers sur lesquels la croissance est verifiee (§7 de la spec : « simuler dix paliers »). */
const PALIERS = 10;

function croitStrictement(f: (k: number) => number): boolean {
  for (let k = 0; k < PALIERS; k++) {
    if (!(f(k + 1) > f(k))) {
      return false;
    }
  }
  return true;
}

function vautSaBase(f: (k: number) => number, base: number): boolean {
  return f(0) === base;
}

describe('les deux moities du test de formule', () => {
  /**
   * ⚠️ **Compter le cas qu'on croit creer.** Une constante et une formule qui
   * double a chaque palier : chacune passe UNE moitie et rate l'autre. Si ce
   * test tombait — parce qu'une moitie a ete affaiblie, par exemple en
   * remplacant `>` par `>=` — les trois tests suivants continueraient de
   * passer sans plus rien garder.
   */
  it('ne disent pas la meme chose : une constante et une formule emballee le prouvent', () => {
    const constante = (): number => 1;
    const emballee = (k: number): number => 2 ** (k + 1);

    expect(vautSaBase(constante, 1)).toBe(true);
    expect(croitStrictement(constante)).toBe(false);

    expect(croitStrictement(emballee)).toBe(true);
    expect(vautSaBase(emballee, 1)).toBe(false);
  });
});

describe('waveCountScale', () => {
  it('vaut exactement 1 au premier palier', () => {
    expect(vautSaBase(waveCountScale, 1)).toBe(true);
  });

  it('croit strictement sur dix paliers', () => {
    expect(croitStrictement(waveCountScale)).toBe(true);
  });
});

describe('hpScale', () => {
  it('vaut exactement 1 au premier palier', () => {
    expect(vautSaBase(hpScale, 1)).toBe(true);
  });

  it('croit strictement sur dix paliers', () => {
    expect(croitStrictement(hpScale)).toBe(true);
  });
});

describe('palierGold', () => {
  it('vaut exactement la base au premier palier', () => {
    expect(vautSaBase(palierGold, GOLD_PER_PALIER_BASE)).toBe(true);
  });

  /**
   * ⚠️ **C'est ici que l'arrondi de `palierGold` se garde.** Avec une base
   * trop petite (1, par exemple), deux paliers voisins rendraient le meme
   * montant arrondi et la recompense cesserait de croitre sans qu'aucune
   * formule n'ait change. Cette assertion couple donc `GOLD_PER_PALIER_BASE`
   * a la forme de la fonction, ce qu'aucun commentaire ne saurait faire.
   */
  it('croit strictement sur dix paliers, arrondi compris', () => {
    expect(croitStrictement(palierGold)).toBe(true);
  });
});

describe('la table du §3 de la spec', () => {
  /**
   * ⚠️ **Les seuls nombres ecrits en clair de ce fichier, et c'est delibere.**
   * Ce ne sont pas des constantes recopiees : ce sont les valeurs que la SPEC
   * annonce (`x1,75` et `x1,76` au palier 5), donc un contrat envers le
   * document. Le jour ou `PALIER_COUNT_SCALE` ou `PALIER_HP_SCALE` bougent, ce
   * test doit rougir — et la table de la spec doit bouger avec.
   *
   * Ce qu'il attrape et que les deux moities ne voient pas : **l'echange des
   * deux constantes**. `waveCountScale` batie sur `PALIER_HP_SCALE`
   * (`1 + 1,12 k`) croit et vaut bien 1 au palier 0 ; les quatre tests
   * ci-dessus la laisseraient passer.
   */
  it('rend les valeurs annoncees au palier 5', () => {
    expect(waveCountScale(5)).toBeCloseTo(1.75, 10);
    expect(hpScale(5)).toBeCloseTo(1.76, 2);
  });

  it('utilise bien deux pentes distinctes, une par grandeur', () => {
    expect(PALIER_COUNT_SCALE).not.toBe(PALIER_HP_SCALE);
  });
});

/**
 * `palierHp` — la porte par laquelle `hpScale` entre dans le jeu, et la
 * decision de l'etape 0 de la tache 3 : **la chair a canon ne monte pas**.
 *
 * ⚠️ **DEUX MOITIES, et elles ne se couvrent pas.** « La legere ne monte
 * jamais » passe toute seule avec `return baseHp` — la difficulte
 * disparaitrait alors du jeu entier sans qu'un test ne bouge. « La lourde suit
 * `hpScale` » passe toute seule avec `baseHp * hpScale(k)` — l'escalier de
 * durabilite reviendrait intact. Il faut les deux, et le troisieme test les
 * eprouve l'une contre l'autre sur ces deux contre-exemples exacts.
 */
describe('palierHp — la chair a canon ne monte pas', () => {
  /** La dague, arme 0 : c'est SON degat qui definit la frontiere, jamais un 5 recopie. */
  const DEGATS_DAGUE = weaponOf(0).damage;

  it('laisse la pietaille legere a sa reserve de depart sur dix paliers', () => {
    for (let k = 0; k <= PALIERS; k++) {
      expect(palierHp(LIGHT_HP, k)).toBe(LIGHT_HP);
    }
  });

  it('fait monter la pietaille lourde exactement a hpScale', () => {
    for (let k = 0; k <= PALIERS; k++) {
      expect(palierHp(HEAVY_HP, k)).toBeCloseTo(HEAVY_HP * hpScale(k), 10);
    }
    expect(croitStrictement((k) => palierHp(HEAVY_HP, k))).toBe(true);
  });

  it('ne dit pas la meme chose des deux : les deux raccourcis ratent chacun une moitie', () => {
    const rienNeMonte = (base: number, _k: number): number => base;
    const toutMonte = (base: number, k: number): number => base * hpScale(k);

    // Le raccourci « rien ne monte » satisfait la legere et trahit la lourde.
    expect(rienNeMonte(LIGHT_HP, 5)).toBe(palierHp(LIGHT_HP, 5));
    expect(rienNeMonte(HEAVY_HP, 5)).not.toBe(palierHp(HEAVY_HP, 5));

    // Le raccourci « tout monte » satisfait la lourde et trahit la legere.
    expect(toutMonte(HEAVY_HP, 5)).toBeCloseTo(palierHp(HEAVY_HP, 5), 10);
    expect(toutMonte(LIGHT_HP, 5)).not.toBe(palierHp(LIGHT_HP, 5));
  });

  /**
   * ⚠️ **LA raison d'etre de cette fonction, ecrite en test.** La durabilite
   * se compte en COUPS, pas en points de vie : un point de plus que les degats
   * de la dague double le nombre de coups. Ce test dit que la pietaille legere
   * reste a UN coup a tous les paliers — c'est la frontiere de R9 a l'envers,
   * et rien d'autre ne la garde.
   */
  it('garde la pietaille legere a UN coup de dague, a tous les paliers', () => {
    for (let k = 0; k <= PALIERS; k++) {
      expect(Math.ceil(palierHp(LIGHT_HP, k) / DEGATS_DAGUE)).toBe(1);
    }
    // Et sans l'exemption, la marche est bien la des le palier 1 : le defaut
    // que la tache 2 a mesure existe, ce test ne le suppose pas.
    expect(Math.ceil((LIGHT_HP * hpScale(1)) / DEGATS_DAGUE)).toBe(2);
  });

  it('vaut exactement la reserve de depart au palier 0, quel que soit l archetype', () => {
    for (const a of ARCHETYPES) {
      expect(palierHp(a.hp, 0)).toBe(a.hp);
    }
  });
});

/**
 * `bossHp` — la formule de la tache 3 bis, et **elle a TROIS moities**, dont
 * aucune ne couvre les deux autres :
 *
 * - **valeur de base exacte** a `k = 0` et un joueur — sans elle, une formule
 *   qui s'emballe passe ;
 * - **croissance stricte** en `k` a effectif constant — sans elle, une
 *   constante passe ;
 * - **proportionnalite au nombre de joueurs** — sans elle, `palierHp` toute
 *   seule passe, et c'est exactement le defaut que cette tache corrige : un
 *   joueur seul recevait le boss de quatre.
 *
 * Le dernier test les eprouve l'une contre l'autre sur le contre-exemple exact
 * qui a motive la tache — la formule d'AVANT.
 */
describe('bossHp — le boss suit le palier ET le nombre de joueurs', () => {
  it('vaut exactement la reserve d un joueur au palier 0', () => {
    expect(bossHp(0, 1)).toBe(BOSS_HP_PER_PLAYER);
  });

  it('croit strictement sur dix paliers, a effectif constant', () => {
    for (let joueurs = 1; joueurs <= MAX_PLAYERS; joueurs++) {
      expect(croitStrictement((k) => bossHp(k, joueurs))).toBe(true);
    }
  });

  /**
   * ⚠️ **LA MEME FORME QUE LE SEUIL D'EXPERIENCE** (`LEVEL_XP_BASE * niveau *
   * joueurs`) : une PROPORTIONNALITE, pas une racine ni un palier. C'est ce
   * rapport exact que le test assene, a tous les paliers, parce que c'est lui
   * qui est promis au §4 de la spec.
   */
  it('multiplie exactement par le nombre de joueurs, a tous les paliers', () => {
    for (let k = 0; k <= PALIERS; k++) {
      for (let joueurs = 1; joueurs <= MAX_PLAYERS; joueurs++) {
        expect(bossHp(k, joueurs)).toBeCloseTo(bossHp(k, 1) * joueurs, 6);
      }
    }
  });

  /**
   * ⚠️ **Le plancher `max(1, ...)` est un chemin TESTE, pas une garde morte.**
   * `WaveDirector.due` n'emet rien quand le salon est vide, donc l'appelant
   * reel ne passe jamais zero — mais cette fonction est pure et publique, et
   * un `bossHp(0, 0)` doit rendre un boss, pas un boss a zero PV.
   */
  it('rend le boss d un joueur quand on ne lui en donne aucun', () => {
    expect(bossHp(0, 0)).toBe(bossHp(0, 1));
    expect(bossHp(3, -5)).toBe(bossHp(3, 1));
  });

  /**
   * ⚠️ **Le contre-exemple est la formule d'AVANT la tache 3 bis**, celle qui
   * a coute 3 graines sur 40 en solo : elle passe les deux premieres moities
   * et rate la troisieme. Sans ce test, affaiblir la proportionnalite ne
   * ferait rougir personne.
   */
  it('ne dit pas la meme chose que palierHp seule : la formule d avant le prouve', () => {
    const sansLesJoueurs = (k: number, _joueurs: number): number => palierHp(BOSS_HP_PER_PLAYER, k);

    expect(sansLesJoueurs(0, 1)).toBe(bossHp(0, 1));
    expect(croitStrictement((k) => sansLesJoueurs(k, MAX_PLAYERS))).toBe(true);
    expect(sansLesJoueurs(0, MAX_PLAYERS)).not.toBe(bossHp(0, MAX_PLAYERS));
  });

  /**
   * ⚠️ **Le boss n'est PAS exempte de la montee en PV**, lui — c'est la
   * pietaille legere qui l'est (`palierHp`). Le dire ici, sinon un jour
   * quelqu'un elargira l'exemption sans voir qu'elle avale le seul ennemi qui
   * porte la difficulte d'un palier.
   */
  it('monte bien avec le palier, exactement comme la pietaille lourde', () => {
    for (let k = 0; k <= PALIERS; k++) {
      expect(bossHp(k, 1) / bossHp(0, 1)).toBeCloseTo(hpScale(k), 10);
    }
  });
});
