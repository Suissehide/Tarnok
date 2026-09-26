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

  it('n amplifie AUCUN degat SAUF la Poix : `damageAmp` vaut 1 partout ailleurs (tache 4)', () => {
    // ⚠️ **La valeur neutre, et elle doit etre LUE.** `ZoneField.ampAt`
    // multiplie les degats par ce champ : un element qui l'oublierait
    // (`undefined`) rendrait `NaN` et effacerait les PV de tout ce qui pietine
    // sa zone. La Poix est la PREMIERE ligne a depasser 1 — exclue NOMMEMENT
    // ici plutot que par un `!==` generique, pour forcer a relire ce test le
    // jour ou une seconde ligne amplifiera.
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
    expect(elementOf(ELEMENT.FOUDRE).name).toBe('foudre');
    expect(elementOf(ELEMENT.POIX).name).toBe('poix');
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
   * ⚠️ **CORRIGEE a la tache 9 de l'etape 5b.** Avant cette tache, ce test
   * exigeait `burnPerTick > 0 || slowFactor < 1` — vrai pour un catalogue de
   * trois elements (Neutre, Braise, Givre), et deja faux pour la Poix (tache
   * 4) des son introduction : elle n'agit ni par brulure ni par
   * ralentissement, elle amplifie (`damageAmp`, `ZoneField.ampAt`). La garde
   * traitait donc la Poix — et la Foudre, meme raison — comme des exceptions
   * NOMMEES a une regle qui affirmait implicitement *« tout element a un
   * effet de MARQUE »*, alors que l'invariant reel du catalogue a toujours
   * ete plus large : *« tout element a AU MOINS UN effet »*, la marque
   * (`burnPerTick`/`slowFactor`) n'en etant qu'une famille parmi celles que
   * `ELEMENT_DEFS` porte — la zone (`damageAmp`) en est une autre. Une garde
   * qu'il faut reouvrir a chaque element ajoute n'est pas une garde, c'est une
   * liste qui attend le prochain oubli.
   *
   * La regle ci-dessous compte donc `damageAmp > 1` parmi les effets valables
   * — ce qui retire la Poix de toute exception, sa ligne le satisfaisant
   * directement (tache 4). **Seule la Foudre reste une exception NOMMEE, et
   * pour une raison structurelle qu'aucun elargissement de predicat ne peut
   * lever** : `chainTargets` (`shared/chain.ts`) ne se derive pas d'un CHAMP
   * de `Element` mais d'un point d'impact reconnu par identifiant
   * (`ELEMENT.FOUDRE`, voir `resolveProjectileDamage`, `back/src/combat.ts`)
   * — le docbloc de `ELEMENT_DEFS` explique pourquoi lui donner un champ ici
   * n'aurait rien generalise. C'est `shared/chain.test.ts` qui garde que
   * cet effet-la n'est pas mort.
   */
  it('est le SEUL sans effet : tout autre element porte au moins un effet (marque, zone, ou une exception nommee)', () => {
    // La Foudre : seul cas ou l'effet vit hors de cette table (voir
    // le docbloc ci-dessus). Pas une dette bornee a une tache — une
    // consequence structurelle de la forme de `chainTargets`, permanente.
    const EFFET_HORS_TABLE = new Set<number>([ELEMENT.FOUDRE]);
    for (const e of ELEMENTS) {
      if (e.id === ELEMENT.NEUTRE || EFFET_HORS_TABLE.has(e.id)) {
        continue;
      }
      expect(
        e.burnPerTick > 0 || e.slowFactor < 1 || e.damageAmp > 1,
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

/**
 * ⚠️ **Sans ce bloc, `burnPerTick`/`slowFactor` de la Foudre ne sont
 * consultes par AUCUNE assertion nommee.** La table generique (« reste dans
 * le domaine des effets ») ne verifie qu'un intervalle large (`>= 0`,
 * `]0, 1]`), et la Foudre y reste a l'interieur meme si on lui pretait par
 * erreur une combustion ou un ralentissement — une mutation qui resterait
 * verte sans ces deux assertions dediees.
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
 * intervalle large (`]0, 1]`) — une mutation qui preterait un ralentissement
 * a la Poix y resterait sans qu'aucune assertion nommee ne rougisse.
 *
 * ⚠️ **`slowFactor: 1` est un ECART ASSUME avec le §6.3 de l'orientation**
 * (« englue, ralentit, amplifie »), pas un oubli : le docbloc de la ligne
 * `poix` dans `ELEMENT_DEFS` (`shared/elements.ts`) porte la raison de jeu
 * complete (le Givre ralentit deja ; deux ralentissements seraient du
 * contenu mort). Ce test-ci GARDE la decision, il ne la justifie pas.
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
   * ⚠️ **`ARMEMENT_DIFFERE` a existe ici, et a ete supprime a la tache 9 de
   * l'etape 5b.** Le plan de l'etape 5b construisait le catalogue avant les
   * armes qui le portent (Foudre a la tache 2, Poix a la tache 4) : la dette
   * etait explicite et bornee, une exemption NOMMEE le temps que la tache 9
   * cable au moins deux armes a chacune (`shared/weapons.ts`,
   * `bobine-tesla`/`canon-a-arc` pour la Foudre, `seringue-a-poix`/
   * `chaudron-a-poix` pour la Poix). La garde ci-dessous porte a nouveau sur
   * la table ENTIERE, sans exception : un element sans arme, present ou
   * futur, la fait a nouveau rougir.
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
