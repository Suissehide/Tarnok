import { describe, expect, it } from 'vitest';

import { GOLD_PER_PALIER_BASE, PALIER_COUNT_SCALE, PALIER_HP_SCALE } from './constants';
import { hpScale, palierGold, waveCountScale } from './paliers';

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
