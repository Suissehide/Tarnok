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
    // ⚠️ Meme discipline que le test « reste dans le domaine des effets »
    // plus bas pour `burnPerTick`/`slowFactor`/`damageAmp` : un intervalle
    // large, complementaire aux tests NOMMES de la Chaux ci-dessous.
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
   *
   * ⚠️ **ETENDUE a la tache 1 de l'etape 5c : `armorReduction > 0` et
   * `fieldSign < 0` rejoignent la liste des effets valables.** La Chaux
   * n'agit ni par la marque ni par l'amplification de zone — sans cet
   * elargissement, elle serait a tort une seconde exception NOMMEE, alors
   * que ses deux effets vivent bel et bien dans cette table (voir son
   * docbloc dans `ELEMENT_DEFS`).
   *
   * ⚠️ **Le Vif-argent (tache 2 de l'etape 5c) REJOINT `EFFET_HORS_TABLE`,
   * il n'elargit PAS le predicat.** La question a ete posee explicitement :
   * a la tache 9 de l'etape 5b, elargir a valu mieux qu'exempter — pour la
   * Poix, dont l'effet REEL (`damageAmp`) etait deja un champ de cette
   * table, simplement absent de ce predicat-la. Le Vif-argent n'est pas dans
   * ce cas : sa liaison se derive d'une PAIRE de positions et d'une zone
   * annoncee (`linkedNeighbours`, `shared/links.ts`), jamais d'un champ que
   * `Element` porterait pour lui seul — structurellement identique a la
   * Foudre (`chainTargets` se derive d'un point d'impact, pas d'un champ).
   * Un appelant doit de toute facon savoir qu'il tient du Vif-argent
   * (`ELEMENT.VIF_ARGENT`) avant d'appeler `linkedNeighbours`, exactement
   * comme il doit savoir qu'il tient de la Foudre avant d'appeler
   * `chainTargets` — ajouter un champ ici n'aurait rien generalise.
   * Elargir le predicat aurait donc invente un champ SANS AUTRE LECTEUR que
   * ce test, ce qui n'est pas generaliser, c'est deplacer la meme exception
   * d'un endroit a un autre.
   */
  it('est le SEUL sans effet : tout autre element porte au moins un effet (marque, zone, ou une exception nommee)', () => {
    // La Foudre et le Vif-argent : les deux cas ou l'effet vit hors de
    // cette table (voir le docbloc ci-dessus). Pas une dette bornee a une
    // tache — une consequence structurelle de la forme de `chainTargets` et
    // de `linkedNeighbours`, permanente pour les deux.
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

/**
 * ⚠️ Meme raison que les deux blocs precedents (Foudre, Poix) : la table
 * generique ne verifie que des intervalles larges — une mutation qui
 * preterait une brulure, un ralentissement ou une amplification a la Chaux
 * y resterait sans qu'aucune assertion nommee ne rougisse. Ses deux VRAIS
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
 * generique ne verifie que des intervalles larges — une mutation qui
 * preterait une brulure, un ralentissement, une amplification, une
 * reduction d'armure ou une inversion de champ au Vif-argent y resterait
 * sans qu'aucune assertion nommee ne rougisse. Son VRAI effet — la liaison
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
   * ⚠️ **`ARMEMENT_DIFFERE` a deja existe ici, une premiere fois, et a ete
   * supprime a la tache 9 de l'etape 5b** (Foudre tache 2, Poix tache 4,
   * armes cablees toutes les deux a la tache 9). Meme motif, une seconde
   * fois, pour la meme raison : le plan de l'etape 5c construit le
   * catalogue avant les armes qui le portent — la Chaux nait a cette
   * tache-ci (la 1), `shared/weapons.ts` ne lui cable au moins deux armes
   * qu'a la tache 8.
   *
   * ⚠️ **Une dette EXPLICITE et BORNEE, pas une exemption permanente.**
   * Sans `ARME_DIFFEREE`, ce test rougirait entre la tache 1 et la tache 8
   * — pas d'une vraie regression, d'un ORDRE de taches assume. **Doit
   * redevenir vide a la fin de la tache 8** : si la Chaux OU le Vif-argent y
   * restent apres, ce test cesse de garder quoi que ce soit pour eux. La
   * garde reste intacte pour les cinq autres elements — l'exception
   * BORNE, elle ne desarme pas.
   *
   * ⚠️ **Le Vif-argent (tache 2) rejoint la Chaux ici, meme raison, meme
   * echeance.** `shared/weapons.ts` ne cable au moins deux armes a chacun
   * des deux nouveaux elements qu'a la tache 8 — la ligne de table nait
   * avant l'arme qui la porte, comme pour la Foudre et la Poix a l'etape 5b.
   */
  const ARME_DIFFEREE = new Set<number>([ELEMENT.CHAUX, ELEMENT.VIF_ARGENT]);

  it('cable au moins une arme a chaque element du catalogue, sauf armement differe assume (Chaux, Vif-argent, tache 8)', () => {
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
