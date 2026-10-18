import { describe, expect, it } from 'vitest';

import { ELEMENT, ELEMENTS, elementOf } from './elements';
import { WEAPONS } from './weapons';

describe('ELEMENTS', () => {
  it('indexe chaque element a sa position dans le tableau', () => {
    ELEMENTS.forEach((e, i) => {
      expect(e.id).toBe(i);
    });
  });

  it('reste dans le domaine des effets : reduction d armure positive ou nulle, signe de champ +1 ou -1', () => {
    // Un intervalle large, complementaire aux tests NOMMES de la Chaux
    // ci-dessous.
    for (const e of ELEMENTS) {
      expect(e.armorReduction, e.name).toBeGreaterThanOrEqual(0);
      expect(e.fieldSign === 1 || e.fieldSign === -1, e.name).toBe(true);
    }
  });

  it('compte le neutre et les deux elements de l etape 5a, et pas plus que les six du §6.3', () => {
    expect(ELEMENTS.length).toBeGreaterThanOrEqual(3);
    expect(ELEMENTS.length).toBeLessThanOrEqual(7);
  });

  it('n amplifie AUCUN degat SAUF la Poix : `damageAmp` vaut 1 partout ailleurs (tache 4)', () => {
    // ⚠️ **La valeur neutre, et elle doit etre LUE.** `ZoneField.ampAt`
    // multiplie les degats par ce champ : un element qui l'oublierait
    // (`undefined`) rendrait `NaN` et effacerait les PV de tout ce qui pietine
    // sa zone. La Poix est exclue NOMMEMENT plutot que par un `!==` generique,
    // pour forcer a relire ce test le jour ou une seconde ligne amplifiera.
    const AMPLIFIENT = new Set<number>([ELEMENT.POIX]);
    for (const e of ELEMENTS) {
      if (AMPLIFIENT.has(e.id)) {
        expect(e.damageAmp, e.name).toBeGreaterThan(1);
        continue;
      }
      expect(e.damageAmp, e.name).toBe(1);
    }
  });

  it('donne un nom non vide et distinct a chaque element', () => {
    for (const e of ELEMENTS) {
      expect(e.name.length).toBeGreaterThan(0);
    }
    expect(new Set(ELEMENTS.map((e) => e.name)).size).toBe(ELEMENTS.length);
  });

  /**
   * ⚠️ Deux elements de meme teinte rendraient l'encodage visuel muet : le
   * joueur lit l'etat d'un ennemi a la couleur de son sprite et rien d'autre
   * (**aucune barre de PV**, pas d'anneau bicolore). Les teintes sont une
   * donnee de jeu, pas de la decoration.
   */
  it('donne une teinte distincte a chaque element, dans le domaine 0xRRGGBB', () => {
    for (const e of ELEMENTS) {
      expect(Number.isInteger(e.tint)).toBe(true);
      expect(e.tint).toBeGreaterThanOrEqual(0);
      expect(e.tint).toBeLessThanOrEqual(0xffffff);
    }
    expect(new Set(ELEMENTS.map((e) => e.tint)).size).toBe(ELEMENTS.length);
  });

  it('reste dans le domaine des effets : degats positifs ou nuls, facteur de vitesse dans ]0, 1], amplification au moins neutre', () => {
    for (const e of ELEMENTS) {
      expect(e.burnPerTick).toBeGreaterThanOrEqual(0);
      expect(e.slowFactor).toBeGreaterThan(0);
      expect(e.slowFactor).toBeLessThanOrEqual(1);
      expect(e.damageAmp).toBeGreaterThanOrEqual(1);
    }
  });
});

/**
 * `ELEMENT` recopie des positions de `ELEMENT_DEFS` : **une constante
 * recopiee sans garde derive en silence.** Sans
 * ces trois assertions, inserer un element au milieu de la table teinterait
 * les ennemis de la mauvaise couleur et les brulerait quand meme, sans qu'un
 * seul test rougisse.
 */
describe('ELEMENT (les identifiants nommes)', () => {
  it('pointe chaque cle sur l element du meme nom', () => {
    expect(elementOf(ELEMENT.NEUTRE).name).toBe('neutre');
    expect(elementOf(ELEMENT.BRAISE).name).toBe('braise');
    expect(elementOf(ELEMENT.GIVRE).name).toBe('givre');
    expect(elementOf(ELEMENT.FOUDRE).name).toBe('foudre');
    expect(elementOf(ELEMENT.POIX).name).toBe('poix');
    expect(elementOf(ELEMENT.CHAUX).name).toBe('chaux');
    expect(elementOf(ELEMENT.VIF_ARGENT).name).toBe('vif-argent');
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
   * FUTUR : un element ajoute sans AUCUN effet serait une entree morte — une
   * arme pourrait le porter, une zone l'afficher, et rien n'arriverait jamais
   * a l'ennemi marque ni a qui pietine sa zone.
   *
   * L'invariant est *« tout element a AU MOINS UN effet »*, et chaque champ
   * d'effet de `ELEMENT_DEFS` compte : la marque (`burnPerTick`,
   * `slowFactor`), la zone (`damageAmp`), l'armure (`armorReduction`) et le
   * champ (`fieldSign`). Une garde qu'il faudrait rouvrir a chaque element
   * ajoute ne serait qu'une liste qui attend le prochain oubli.
   *
   * ⚠️ **La Foudre et le Vif-argent restent des exceptions NOMMEES, pour une
   * raison structurelle** : leur effet ne se derive d'aucun CHAMP de
   * `Element`. `chainTargets` (`shared/chain.ts`) part d'un point d'impact
   * reconnu par identifiant (`resolveProjectileDamage`,
   * `back/src/combat.ts`) ; `linkedNeighbours` (`shared/links.ts`) d'une
   * paire de positions et d'une zone annoncee. Un appelant doit de toute
   * facon savoir quel element il tient : un champ ici n'aurait aucun autre
   * lecteur que ce test, il deplacerait l'exception sans la generaliser.
   * Ces effets sont gardes par `shared/chain.test.ts` et
   * `shared/links.test.ts`.
   */
  it('est le SEUL sans effet : tout autre element porte au moins un effet (marque, zone, ou une exception nommee)', () => {
    // La Foudre et le Vif-argent : l'effet vit hors de cette table (voir le
    // docbloc ci-dessus).
    const EFFET_HORS_TABLE = new Set<number>([ELEMENT.FOUDRE, ELEMENT.VIF_ARGENT]);
    for (const e of ELEMENTS) {
      if (e.id === ELEMENT.NEUTRE || EFFET_HORS_TABLE.has(e.id)) {
        continue;
      }
      expect(
        e.burnPerTick > 0 ||
          e.slowFactor < 1 ||
          e.damageAmp > 1 ||
          e.armorReduction > 0 ||
          e.fieldSign < 0,
        `element « ${e.name} »`,
      ).toBe(true);
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
   * Brulure et ralentissement doivent etre PORTES PAR DES ELEMENTS
   * DIFFERENTS : un element qui ferait les deux rendrait la reaction illisible :
   * on ne verrait plus lequel des deux etats l'a declenchee.
   */
  it('ne fait porter les deux effets par le meme element a aucun element', () => {
    for (const e of ELEMENTS) {
      expect(e.burnPerTick > 0 && e.slowFactor < 1).toBe(false);
    }
  });
});

/**
 * ⚠️ **Sans ce bloc, `burnPerTick`/`slowFactor` de la Foudre ne sont
 * consultes par AUCUNE assertion nommee.** La table generique (« reste dans
 * le domaine des effets ») ne verifie qu'un intervalle large (`>= 0`,
 * `]0, 1]`), et la Foudre y resterait meme si on lui pretait par erreur une
 * combustion ou un ralentissement.
 */
describe('la foudre (tache 2)', () => {
  it('ne brule pas et ne ralentit pas : son effet est la chaine, pas une marque', () => {
    const foudre = elementOf(ELEMENT.FOUDRE);
    expect(foudre.burnPerTick).toBe(0);
    expect(foudre.slowFactor).toBe(1);
  });
});

/**
 * ⚠️ Meme raison que le bloc precedent, portee sur la Poix : la table
 * generique (« reste dans le domaine des effets ») ne verifie qu'un
 * intervalle large (`]0, 1]`) : un ralentissement prete a la Poix y resterait.
 *
 * ⚠️ **`slowFactor: 1` est voulu, pas un oubli** : le Givre ralentit deja,
 * deux ralentissements seraient du contenu mort (voir la ligne `poix` dans
 * `ELEMENT_DEFS`, `shared/elements.ts`).
 */
describe('la poix (tache 4)', () => {
  it('ne brule pas et ne ralentit pas : le Givre ralentit deja, la Poix amplifie', () => {
    const poix = elementOf(ELEMENT.POIX);
    expect(poix.burnPerTick).toBe(0);
    expect(poix.slowFactor).toBe(1);
  });

  it('amplifie strictement les degats recus : `damageAmp` depasse 1', () => {
    expect(elementOf(ELEMENT.POIX).damageAmp).toBeGreaterThan(1);
  });
});

/**
 * ⚠️ Meme raison que les deux blocs precedents (Foudre, Poix) : la table
 * generique ne verifie que des intervalles larges, une brulure, un
 * ralentissement ou une amplification pretes a la Chaux y resteraient. Ses deux VRAIS
 * effets (`armorReduction`, `fieldSign`) sont eux aussi assenes ici, pas
 * seulement bornes par le test « domaine des effets ».
 */
describe('la chaux (tache 1 de l etape 5c)', () => {
  it('ne brule pas, ne ralentit pas, n amplifie pas : ses effets sont ailleurs', () => {
    const chaux = elementOf(ELEMENT.CHAUX);
    expect(chaux.burnPerTick).toBe(0);
    expect(chaux.slowFactor).toBe(1);
    expect(chaux.damageAmp).toBe(1);
  });

  it('reduit strictement l armure : premiere ligne a le faire PAR ELLE-MEME, sans reaction', () => {
    expect(elementOf(ELEMENT.CHAUX).armorReduction).toBeGreaterThan(0);
  });

  it('inverse le signe du champ : c est elle, et elle seule, qui fait fuir', () => {
    for (const e of ELEMENTS) {
      if (e.id === ELEMENT.CHAUX) {
        expect(e.fieldSign, e.name).toBe(-1);
        continue;
      }
      expect(e.fieldSign, e.name).toBe(1);
    }
  });
});

/**
 * ⚠️ Meme raison que les blocs Foudre/Poix/Chaux precedents : la table
 * generique ne verifie que des intervalles larges, ou un effet de table
 * prete par erreur au Vif-argent resterait. Son VRAI effet — la liaison
 * — est garde par `shared/links.test.ts`, pas ici : ce fichier ne garde que
 * ce que la table elle-meme porte, et la table du Vif-argent est
 * entierement neutre (voir `EFFET_HORS_TABLE` plus haut).
 */
describe('le vif-argent (tache 2 de l etape 5c)', () => {
  it('ne brule pas, ne ralentit pas, n amplifie pas, ne reduit pas l armure, ne fait pas fuir : ses effets de table sont tous neutres', () => {
    const vifArgent = elementOf(ELEMENT.VIF_ARGENT);
    expect(vifArgent.burnPerTick).toBe(0);
    expect(vifArgent.slowFactor).toBe(1);
    expect(vifArgent.damageAmp).toBe(1);
    expect(vifArgent.armorReduction).toBe(0);
    expect(vifArgent.fieldSign).toBe(1);
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
   *
   * `ARME_DIFFEREE` est VIDE : la garde couvre tous les elements du
   * catalogue. Il reste comme point d'extension, pour un element qui
   * naitrait avant ses armes.
   */
  const ARME_DIFFEREE = new Set<number>([]);

  it('cable au moins une arme a chaque element du catalogue', () => {
    for (const e of ELEMENTS) {
      if (ARME_DIFFEREE.has(e.id)) {
        continue;
      }
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
