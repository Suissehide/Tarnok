import { describe, expect, it } from 'vitest';

import { ELEMENT, ELEMENTS, elementOf } from './elements';
import { WEAPONS } from './weapons';

describe('ELEMENTS', () => {
  it('indexe chaque element a sa position dans le tableau', () => {
    ELEMENTS.forEach((e, i) => {
      expect(e.id).toBe(i);
    });
  });

  it('compte le neutre et les deux elements de l etape 5a, et pas plus que les six du §6.3', () => {
    expect(ELEMENTS.length).toBeGreaterThanOrEqual(3);
    expect(ELEMENTS.length).toBeLessThanOrEqual(7);
  });

  it('donne un nom non vide et distinct a chaque element', () => {
    for (const e of ELEMENTS) {
      expect(e.name.length).toBeGreaterThan(0);
    }
    expect(new Set(ELEMENTS.map((e) => e.name)).size).toBe(ELEMENTS.length);
  });

  /**
   * ⚠️ Deux elements de meme teinte rendraient l'encodage visuel du §9 muet :
   * le joueur lit l'etat d'un ennemi a la couleur de son sprite et rien
   * d'autre — il n'y a **aucune barre de PV** (§3.4) et pas d'anneau bicolore
   * (§11). Les teintes sont donc une donnee de jeu, pas de la decoration.
   */
  it('donne une teinte distincte a chaque element, dans le domaine 0xRRGGBB', () => {
    for (const e of ELEMENTS) {
      expect(Number.isInteger(e.tint)).toBe(true);
      expect(e.tint).toBeGreaterThanOrEqual(0);
      expect(e.tint).toBeLessThanOrEqual(0xffffff);
    }
    expect(new Set(ELEMENTS.map((e) => e.tint)).size).toBe(ELEMENTS.length);
  });

  it('reste dans le domaine des effets : degats positifs ou nuls, facteur de vitesse dans ]0, 1]', () => {
    for (const e of ELEMENTS) {
      expect(e.burnPerTick).toBeGreaterThanOrEqual(0);
      expect(e.slowFactor).toBeGreaterThan(0);
      expect(e.slowFactor).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * `ELEMENT` recopie des positions de `ELEMENT_DEFS`. Le dossier a deja paye ce
 * motif une fois (`CARD_WEAPON` dans `loadout.ts`, garde par un test
 * d'egalite) : **une constante recopiee sans garde derive en silence.** Sans
 * ces trois assertions, inserer un element au milieu de la table teinterait
 * les ennemis de la mauvaise couleur et les brulerait quand meme, sans qu'un
 * seul test rougisse.
 */
describe('ELEMENT (les identifiants nommes)', () => {
  it('pointe chaque cle sur l element du meme nom', () => {
    expect(elementOf(ELEMENT.NEUTRE).name).toBe('neutre');
    expect(elementOf(ELEMENT.BRAISE).name).toBe('braise');
    expect(elementOf(ELEMENT.GIVRE).name).toBe('givre');
  });

  it('couvre toute la table : aucun element n est sans nom d identifiant', () => {
    expect(new Set(Object.values(ELEMENT)).size).toBe(ELEMENTS.length);
  });
});

describe('le neutre est une entree de la table, pas un cas particulier', () => {
  it('occupe l index 0', () => {
    expect(ELEMENT.NEUTRE).toBe(0);
    expect(ELEMENTS[0]?.name).toBe('neutre');
  });

  /**
   * ⚠️ **0xffffff n'est pas une couleur choisie, c'est l'identite du produit**
   * que fait `Sprite.tint`. C'est ce qui permet au rendu de teinter TOUT
   * ennemi sans jamais tester son element : un ennemi non marque ressort
   * inchange. Une autre valeur ici colorerait toute la horde.
   */
  it("teinte a l'identite du produit, donc teinter un ennemi neutre ne le change pas", () => {
    expect(elementOf(ELEMENT.NEUTRE).tint).toBe(0xffffff);
  });

  it('n a aucun effet : ni combustion, ni ralentissement', () => {
    const neutre = elementOf(ELEMENT.NEUTRE);
    expect(neutre.burnPerTick).toBe(0);
    expect(neutre.slowFactor).toBe(1);
  });

  /**
   * L'autre moitie de l'affirmation, et la seule qui garde le catalogue
   * FUTUR : un element ajoute a l'etape 5b sans effet serait une entree morte
   * — une arme pourrait le porter, une zone l'afficher, et rien n'arriverait
   * jamais a l'ennemi marque.
   */
  it('est le SEUL sans effet : tout autre element brule ou ralentit', () => {
    for (const e of ELEMENTS) {
      if (e.id === ELEMENT.NEUTRE) {
        continue;
      }
      expect(e.burnPerTick > 0 || e.slowFactor < 1, `element « ${e.name} »`).toBe(true);
    }
  });
});

describe('les deux elements de l etape 5a', () => {
  it('la braise brule et ne ralentit pas', () => {
    const braise = elementOf(ELEMENT.BRAISE);
    expect(braise.burnPerTick).toBeGreaterThan(0);
    expect(braise.slowFactor).toBe(1);
  });

  it('le givre ralentit et ne brule pas', () => {
    const givre = elementOf(ELEMENT.GIVRE);
    expect(givre.burnPerTick).toBe(0);
    expect(givre.slowFactor).toBeLessThan(1);
  });

  /**
   * §4.1 : *« Braise : degats sur la duree. Givre : ralentit. »* Les deux
   * effets doivent etre PORTES PAR DES ELEMENTS DIFFERENTS — un catalogue ou
   * le meme element ferait les deux rendrait la reaction du §6.1 illisible :
   * on ne verrait plus lequel des deux etats l'a declenchee.
   */
  it('ne fait porter les deux effets par le meme element a aucun element', () => {
    for (const e of ELEMENTS) {
      expect(e.burnPerTick > 0 && e.slowFactor < 1).toBe(false);
    }
  });
});

describe('elementOf', () => {
  it('rend l element portant cet identifiant', () => {
    // Un id non nul : `elementOf(0)` seul ne distinguerait pas une
    // implementation qui renverrait toujours ELEMENTS[0].
    expect(elementOf(2)?.name).toBe(ELEMENTS[2]?.name);
    expect(elementOf(2)?.name).not.toBe(ELEMENTS[0]?.name);
  });

  it('leve sur un identifiant inconnu plutot que de rendre undefined', () => {
    expect(() => elementOf(99)).toThrow(/inconnu/i);
  });
});

/**
 * Le catalogue des elements et celui des armes se referencent : rien ne les
 * tient ensemble a la compilation, `Weapon.element` n'est qu'un `number`.
 */
describe('le catalogue des elements et celui des armes', () => {
  /**
   * ⚠️ **Un element sans arme est du contenu mort** : il vit dans la table, il
   * a une teinte et un effet, et aucun joueur ne peut l'appliquer. Personne ne
   * s'en apercevrait — pas d'erreur, pas de test rouge, juste une reaction qui
   * n'arrive jamais. C'est le pendant exact de la reference morte gardee par
   * `assertWeaponElements`.
   */
  it('cable au moins une arme a chaque element du catalogue', () => {
    for (const e of ELEMENTS) {
      const armes = WEAPONS.filter((w) => w.element === e.id);
      expect(armes.length, `aucune arme ne porte l element « ${e.name} »`).toBeGreaterThanOrEqual(
        1,
      );
    }
  });

  it('ne fait referencer par aucune arme un element hors du catalogue', () => {
    for (const w of WEAPONS) {
      expect(() => elementOf(w.element), `arme « ${w.name} »`).not.toThrow();
    }
  });
});
