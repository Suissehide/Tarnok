import { describe, expect, it } from 'vitest';

import { ARCHETYPES, BOSS_HP_PER_PLAYER, HEAVY_HP, LIGHT_HP } from './archetypes';
import {
  EXTRACT_MULTIPLIER_STEP,
  GOLD_PER_PALIER_BASE,
  LEVEL_HP_SCALE,
  MAX_PLAYERS,
  PALIER_COUNT_SCALE,
  PALIER_HP_SCALE,
} from './constants';
import {
  bossHp,
  extractGold,
  hpScale,
  levelHpScale,
  monsterHp,
  palierGold,
  waveCountScale,
} from './paliers';
import { decodeSnapshot, encodeSnapshot, GOLD_MAX } from './protocol';
import { weaponOf } from './weapons';

/**
 * Le test de ces formules a DEUX MOITIES, et elles ne sont pas
 * interchangeables :
 *
 * - **croissance stricte** sur dix paliers — sans elle, une constante passe ;
 * - **valeur de base exacte a `k = 0`** — sans elle, une formule qui s'emballe
 *   passe.
 *
 * Les deux moities sont ecrites en PREDICATS, et le premier test ci-dessous
 * les eprouve l'une contre l'autre sur deux contre-exemples : c'est ce qui
 * prouve qu'aucune des deux n'est decorative.
 */

/** Nombre de paliers sur lesquels la croissance est verifiee. */
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
   * Ce ne sont pas des constantes recopiees mais les valeurs visees (`x1,75`
   * et `x1,76` au palier 5) : retoucher `PALIER_COUNT_SCALE` ou
   * `PALIER_HP_SCALE` doit faire rougir ce test.
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
 * `levelHpScale` et `monsterHp` — la porte par laquelle le NIVEAU d'equipe
 * entre dans les PV de la horde (etape 15) : **tout le monde monte**, la chair
 * a canon comprise.
 *
 * ⚠️ Le niveau est 1-based (`Room#level`), contrairement au palier : la base
 * se lit a `niveau = 1`, et `croitStrictement` (ecrit pour `k` a partir de 0)
 * s'applique a `k + 1`.
 */
describe('levelHpScale / monsterHp — tout le monde monte avec le niveau', () => {
  /** La dague, arme 0 : c'est SON degat qui definit la frontiere, jamais un 5 recopie. */
  const DEGATS_DAGUE = weaponOf(0).damage;

  it('vaut exactement 1 au niveau 1, et jamais moins en dessous', () => {
    expect(levelHpScale(1)).toBe(1);
    expect(levelHpScale(0)).toBe(1);
    expect(levelHpScale(-3)).toBe(1);
  });

  it('croit strictement sur dix niveaux, a la pente LEVEL_HP_SCALE', () => {
    expect(croitStrictement((k) => levelHpScale(k + 1))).toBe(true);
    expect(levelHpScale(6)).toBeCloseTo(LEVEL_HP_SCALE ** 5, 10);
  });

  it('vaut exactement la reserve de depart au niveau 1, quel que soit l archetype', () => {
    for (const a of ARCHETYPES) {
      expect(monsterHp(a.hp, 1)).toBe(a.hp);
    }
  });

  /**
   * ⚠️ **LA moitie qui distingue l'etape 15 de l'etape 6a** : avant, la
   * pietaille legere etait exemptee (`return baseHp`). Si l'exemption
   * revenait, la difficulte reposerait de nouveau sur le seul nombre — ce que
   * Leo a demande de quitter.
   */
  it('fait monter la pietaille LEGERE comme la lourde : aucune exemption', () => {
    for (let k = 0; k < PALIERS; k++) {
      const niveau = k + 2;
      expect(monsterHp(LIGHT_HP, niveau)).toBeCloseTo(LIGHT_HP * levelHpScale(niveau), 10);
      expect(monsterHp(LIGHT_HP, niveau)).toBeGreaterThan(LIGHT_HP);
      expect(monsterHp(HEAVY_HP, niveau)).toBeCloseTo(HEAVY_HP * levelHpScale(niveau), 10);
    }
  });

  /**
   * ⚠️ **Le piege d'arrondi, desamorce par la MARGE et non par l'exemption.**
   * La durabilite se compte en COUPS : des que la legere depasse les degats
   * de la dague, il en faut deux. `LIGHT_HP` est sous la dague, donc la
   * premiere marche n'arrive pas au niveau 2 mais quelques niveaux plus loin —
   * et une seule carte « degats » (x1,25) la repousse d'autant. Ce test garde
   * les deux faits : la marche existe (c'est la pression voulue), et elle
   * n'est pas immediate.
   */
  it('laisse la pietaille legere a UN coup de dague aux niveaux 1 a 3, puis la marche vient', () => {
    for (let niveau = 1; niveau <= 3; niveau++) {
      expect(Math.ceil(monsterHp(LIGHT_HP, niveau) / DEGATS_DAGUE)).toBe(1);
    }
    expect(Math.ceil(monsterHp(LIGHT_HP, 30) / DEGATS_DAGUE)).toBeGreaterThan(1);
  });
});

/**
 * `bossHp` a **TROIS moities**, dont aucune ne couvre les deux autres :
 *
 * - **valeur de base exacte** au niveau 1 et un joueur — sans elle, une
 *   formule qui s'emballe passe ;
 * - **croissance stricte** en niveau a effectif constant — sans elle, une
 *   constante passe ;
 * - **proportionnalite au nombre de joueurs** — sans elle, `monsterHp` toute
 *   seule passe, et un joueur seul recevrait le boss de quatre.
 *
 * Le dernier test les eprouve l'une contre l'autre sur ce contre-exemple.
 */
describe('bossHp — le boss suit le niveau ET le nombre de joueurs', () => {
  it('vaut exactement la reserve d un joueur au niveau 1', () => {
    expect(bossHp(1, 1)).toBe(BOSS_HP_PER_PLAYER);
  });

  it('croit strictement sur dix niveaux, a effectif constant', () => {
    for (let joueurs = 1; joueurs <= MAX_PLAYERS; joueurs++) {
      expect(croitStrictement((k) => bossHp(k + 1, joueurs))).toBe(true);
    }
  });

  /**
   * ⚠️ **LA MEME FORME QUE LE SEUIL D'EXPERIENCE** (`LEVEL_XP_BASE * niveau *
   * joueurs`) : une PROPORTIONNALITE, pas une racine ni un palier, assenee a
   * tous les niveaux.
   */
  it('multiplie exactement par le nombre de joueurs, a tous les niveaux', () => {
    for (let niveau = 1; niveau <= PALIERS; niveau++) {
      for (let joueurs = 1; joueurs <= MAX_PLAYERS; joueurs++) {
        expect(bossHp(niveau, joueurs)).toBeCloseTo(bossHp(niveau, 1) * joueurs, 6);
      }
    }
  });

  /**
   * ⚠️ **Le plancher `max(1, ...)` est un chemin TESTE, pas une garde morte.**
   * `WaveDirector.due` n'emet rien quand le salon est vide, donc l'appelant
   * reel ne passe jamais zero — mais cette fonction est pure et publique, et
   * un `bossHp(1, 0)` doit rendre un boss, pas un boss a zero PV.
   */
  it('rend le boss d un joueur quand on ne lui en donne aucun', () => {
    expect(bossHp(1, 0)).toBe(bossHp(1, 1));
    expect(bossHp(4, -5)).toBe(bossHp(4, 1));
  });

  /**
   * ⚠️ **Le contre-exemple ignore le nombre de joueurs** : il passe les deux
   * premieres moities et rate la troisieme. Sans ce test, affaiblir la
   * proportionnalite ne ferait rougir personne.
   */
  it('ne dit pas la meme chose que monsterHp seule : la formule d avant le prouve', () => {
    const sansLesJoueurs = (niveau: number, _joueurs: number): number =>
      monsterHp(BOSS_HP_PER_PLAYER, niveau);

    expect(sansLesJoueurs(1, 1)).toBe(bossHp(1, 1));
    expect(croitStrictement((k) => sansLesJoueurs(k + 1, MAX_PLAYERS))).toBe(true);
    expect(sansLesJoueurs(1, MAX_PLAYERS)).not.toBe(bossHp(1, MAX_PLAYERS));
  });

  it('monte avec le niveau, exactement comme la pietaille', () => {
    for (let niveau = 1; niveau <= PALIERS; niveau++) {
      expect(bossHp(niveau, 1) / bossHp(1, 1)).toBeCloseTo(levelHpScale(niveau), 10);
    }
  });
});

describe("extractGold : l'or acquis en partant (etape 6a, tache 9)", () => {
  it('ne majore rien a la premiere extraction : le multiplicateur part de 1', () => {
    expect(extractGold(1234, 1)).toBe(1234);
  });

  it('majore de ce que « rester » a ajoute, et le pas n est pas plat', () => {
    // ⚠️ **La fixture doit produire un ecart.** A pas nul, la ligne ci-dessus
    // et celle-ci rendraient le meme nombre et « le multiplicateur majore »
    // se lirait d'un multiplicateur qui ne fait rien.
    expect(EXTRACT_MULTIPLIER_STEP).toBeGreaterThan(0);
    expect(extractGold(1000, 1 + EXTRACT_MULTIPLIER_STEP)).toBeGreaterThan(extractGold(1000, 1));
    expect(extractGold(1000, 1 + EXTRACT_MULTIPLIER_STEP)).toBe(
      Math.round(1000 * (1 + EXTRACT_MULTIPLIER_STEP)),
    );
  });

  it('rend un ENTIER : un multiplicateur fractionnaire ne laisse pas de virgule', () => {
    // Sans l'arrondi ici, l'encodeur arrondirait seul : deux arrondis pour un
    // seul nombre, donc `Room#gold` et le fil qui divergent d'une unite.
    const or = extractGold(101, 1.25);
    expect(Number.isInteger(or)).toBe(true);
    expect(or).toBe(126);
  });

  /**
   * ⚠️ **La borne est celle du FIL, et c'est la seule chose qui la garde.**
   * `GOLD_MAX` est le plafond du `u32` que `SNAPSHOT` et `PORTAL_RESULT`
   * transportent : sans le `Math.min`, le salon garderait un nombre que le fil
   * borne, et le serveur dirait une chose pendant que tous ses clients en
   * afficheraient une autre — sans qu'aucune erreur ne se produise nulle part.
   */
  it("borne l'or acquis a ce que le fil sait porter, et les deux se relisent pareil", () => {
    const enorme = GOLD_MAX * 4;
    expect(extractGold(enorme, 2)).toBe(GOLD_MAX);

    const acquis = extractGold(enorme, 2);
    expect(decodeSnapshot(encodeSnapshot(1, 0, 0, [], null, acquis)).gold).toBe(acquis);

    // Et la borne n'est pas atteinte par accident : sous le plafond, elle ne
    // touche a rien.
    expect(extractGold(GOLD_MAX / 4, 2)).toBe(Math.round(GOLD_MAX / 2));
  });
});
