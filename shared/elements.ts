/**
 * Le catalogue des elements (§4 de la spec de l'etape 5a).
 *
 * Meme motif que `archetypes.ts`, `weapons.ts` et `passives.ts` : une table
 * pilotee par la donnee, l'index dans le tableau **est** l'identifiant, rien a
 * synchroniser entre serveur et clients. Les deux elements restants du §6.3
 * de l'orientation (Chaux, Vif-argent) seront des lignes de plus dans
 * `ELEMENT_DEFS`, pas de l'architecture — c'est tout l'objet du decoupage
 * 5a / 5b.
 *
 * ⚠️ **`NEUTRE` est une entree de la table, pas un cas particulier.** Il
 * occupe l'index 0 et n'a aucun effet : `burnPerTick` a zero, `slowFactor` a
 * un, et une teinte de 0xffffff qui est l'identite du produit dans un batch
 * Pixi. Un ennemi non marque, une arme neutre et une zone neutre passent donc
 * par exactement le meme chemin que les autres, sans branche `if (element ===
 * NEUTRE)` a maintenir a chaque site d'appel — c'est le role que
 * `BASE_WEAPON_ID` joue deja pour les armes.
 */

import { CHAUX_ARMOR_REDUCTION } from './constants';

export interface Element {
  id: number;
  name: string;
  /** Teinte du sprite et du quad, en 0xRRGGBB. */
  tint: number;
  /** Degats par tick tant que la marque tient. 0 : aucun. */
  burnPerTick: number;
  /** Facteur de vitesse applique a l'ennemi marque. 1 : aucun. */
  slowFactor: number;
  /**
   * Facteur multiplicatif applique aux degats qu'un ennemi subit **pendant
   * qu'il se tient dans une zone de cet element**. 1 : aucune amplification.
   *
   * ⚠️ **Une propriete de la ZONE, jamais de la marque.** C'est
   * `ZoneField.ampAt` qui le lit, a partir de la position de l'ennemi frappe,
   * jamais `Horde.markAt`. Un element marque ce qu'il touche ; celui-ci
   * amplifie ce qui PIETINE, et les deux questions n'ont pas le meme domaine.
   *
   * ⚠️ **1 pour trois elements sur quatre, et c'est volontaire.** La Poix
   * (tache 4) est la premiere ligne a depasser 1. La valeur neutre joue ici
   * le role que `TINT_IDENTITE` joue pour la teinte et `slowFactor: 1` pour
   * le deplacement : elle evite une branche `if (element === POIX)` au site
   * d'application, qui est precisement ce que cette table existe pour ne pas
   * avoir a maintenir.
   */
  damageAmp: number;
  /**
   * Armure SOUSTRAITE (jamais multipliee) a qui se tient dans une zone
   * portant cet element, INDEPENDAMMENT de toute reaction specifique (0 :
   * aucun effet). La Chaux (tache 1 de l'etape 5c) est la premiere ligne a
   * en porter — jusque-la, seule `ReactionDef.zoneArmorReduction`
   * (Supraconduction) rabotait l'armure.
   *
   * ⚠️ **Lu par `zoneArmorReductionTotal` (`shared/reactions.ts`), jamais
   * seul.** Le nibble d'element d'une zone de reaction porte celui du
   * DECLENCHEUR (`ReactionTrigger.element`), qui varie selon l'ordre
   * d'arrivee des deux elements d'un couple — lire ce champ seul au site
   * d'application rendrait l'effet dependant de cet ordre, exactement le
   * piege que ce champ partage avec `slowFactor` (voir `zoneSlowFactor`).
   */
  armorReduction: number;
  /**
   * Signe applique a la direction du champ de deplacement pour qui se tient
   * dans une zone portant cet element : `+1` aucun effet, `-1` la zone
   * inverse la direction (fuite plutot que poursuite). La Chaux (tache 1 de
   * l'etape 5c) est la seule ligne a ne pas valoir `+1`.
   *
   * ⚠️ **Meme piege que `armorReduction` juste au-dessus, meme remede.** Lu
   * par `zoneFieldSign` (`shared/reactions.ts`), jamais seul : le nibble
   * d'element d'une zone de reaction porte celui du DECLENCHEUR, qui varie
   * selon l'ordre d'arrivee.
   *
   * ⚠️ **N'ecrit jamais `Horde#targetField`.** `Horde#retarget` le
   * recalcule a chaque tick depuis les positions des joueurs : toute
   * ecriture y serait ecrasee au tick suivant. La fuite est une
   * SUBSTITUTION du vecteur de direction au moment ou `Horde` le lit, pas
   * une decision de ciblage.
   */
  fieldSign: number;
}

/**
 * Teinte sans effet : 0xffffff est le neutre du produit composante par
 * composante que fait `Sprite.tint`. La poser sur un ennemi non marque rend le
 * sprite inchange, donc le rendu n'a jamais a tester l'element avant de
 * teinter (§9 de la spec : la teinte est *« gratuite dans le batch Pixi »*,
 * une branche par entite ne l'est pas).
 */
const TINT_IDENTITE = 0xffffff;

/**
 * L'index dans le tableau **est** l'identifiant, comme pour `ARCHETYPES` et
 * `WEAPONS`. Les noms restent en minuscules sans accent, comme partout dans
 * `shared/`.
 */
const ELEMENT_DEFS: readonly Omit<Element, 'id'>[] = [
  {
    // Aucun effet, par construction (voir le docbloc du module).
    name: 'neutre',
    tint: TINT_IDENTITE,
    burnPerTick: 0,
    slowFactor: 1,
    damageAmp: 1,
    armorReduction: 0,
    fieldSign: 1,
  },
  {
    // Braise : degats sur la duree, aucun ralentissement (§4.1).
    //
    // 0,1 degat par tick, soit 3 degats par seconde a 30 Hz. Sur une marque
    // entiere (`MARK_DURATION_TICKS`, 60 ticks au depart du plan) : 6 degats,
    // donc plus que `LIGHT_HP` (5) et moins d'un tiers de `HEAVY_HP` (20). La
    // braise seule acheve la pietaille legere et entame la lourde sans jamais
    // la tuer — c'est la reaction qui tue, pas l'etat persistant (§9).
    //
    // Repere : la dague fait 5 degats toutes les 7 ticks, soit ~21 degats par
    // seconde. La combustion pese donc environ un septieme de l'arme de base.
    //
    // ⚠️ Valeur de depart, a regler a l'oeil comme `MARK_DURATION_TICKS`
    // (tache 11) : les deux se multiplient, les regler separement n'a pas de
    // sens.
    name: 'braise',
    tint: 0xff7a3c,
    burnPerTick: 0.1,
    slowFactor: 1,
    damageAmp: 1,
    armorReduction: 0,
    fieldSign: 1,
  },
  {
    // Givre : ralentit, aucun degat (§4.1). Le gel sur accumulation du §6.3
    // est hors perimetre (§11) — il demanderait un compteur d'application par
    // entite, donc une seconde donnee par entite.
    //
    // 0,6 : la pietaille legere la plus lente du bestiaire (80 px/s) tombe a
    // 48 px/s, la plus rapide (130) a 78. Assez pour se voir sans figer la
    // horde, qui doit continuer d'arriver au contact.
    name: 'givre',
    tint: 0x7ad8ff,
    burnPerTick: 0,
    slowFactor: 0.6,
    damageAmp: 1,
    armorReduction: 0,
    fieldSign: 1,
  },
  {
    // Foudre : chaque impact saute vers quelques ennemis proches (§4 de la
    // spec de l'etape 5b) — ni une brulure ni un ralentissement, donc les
    // deux champs qui portent les effets de `braise` et `givre` restent a
    // leur valeur neutre ici. L'effet lui-meme vit dans `shared/chain.ts`
    // (`chainTargets`), pas dans cette table : contrairement a `burnPerTick`
    // et `slowFactor`, qui se lisent generiquement au site d'application
    // (`markAt`, `Horde#computeSlow`), la chaine ne se derive pas d'une
    // marque portee par l'entite — elle se derive d'un POINT D'IMPACT, donc
    // le code qui la declenche doit de toute facon savoir qu'il tient une
    // Foudre (`ELEMENT.FOUDRE`) avant d'appeler `chainTargets`. Ajouter un
    // champ ici pour ce seul element n'aurait donc rien generalise.
    //
    // damageAmp: 1, comme les trois autres lignes — la Foudre n'amplifie
    // rien par elle-meme, elle multiplie les CIBLES, pas le degat de chacune.
    name: 'foudre',
    tint: 0xf3e94b,
    burnPerTick: 0,
    slowFactor: 1,
    damageAmp: 1,
    armorReduction: 0,
    fieldSign: 1,
  },
  {
    // Poix : amplifie les degats recus par qui pietine sa flaque, ni
    // brulure ni ralentissement (tache 4 de l'etape 5b).
    //
    // ⚠️ **ECART ASSUME avec le §6.3 de l'orientation**, qui dit *« englue,
    // ralentit, amplifie »*. `slowFactor` reste a 1 : le Givre ralentit deja,
    // et deux elements dont l'effet PRINCIPAL est le meme ralentissement
    // seraient du contenu mort — personne ne draftant l'un pour ce que
    // l'autre fait deja, et l'un des deux strictement meilleur que l'autre.
    // Le Givre garde le controle, la Poix devient le multiplicateur de
    // degats : les deux se draftent ENSEMBLE au lieu de se remplacer — c'est
    // exactement ce que fait Verglas (Givre + Poix, §6.3) d'un couple plutot
    // que d'un doublon. **Si quelqu'un corrige cet ecart au §6.3, qu'il lise
    // d'abord ce paragraphe.**
    //
    // 1,5 : au contact d'une dague (`damage: 5`) sur de la pietaille lourde
    // (`HEAVY_HP` 20, `HEAVY_ARMOR` 0,15 — voir `shared/archetypes.ts`), la
    // Poix fait tomber le compte de coups a mort de 5 a 4 : hors zone,
    // 20 / (5 x 0,85) = 4,7 (5 coups) ; dedans, 20 / (5 x 1,5 x 0,85) = 3,1
    // (4 coups). Un coup de moins a tuer, pas un coup qui tue seul — c'est
    // toujours la reaction qui execute (§9), la Poix ne fait qu'accelerer.
    //
    // ⚠️ Valeur de depart, a regler a l'oeil comme `burnPerTick` de la
    // Braise et `slowFactor` du Givre (tache 11).
    name: 'poix',
    tint: 0x3d2b1f,
    burnPerTick: 0,
    slowFactor: 1,
    damageAmp: 1.5,
    armorReduction: 0,
    fieldSign: 1,
  },
  {
    // Chaux (tache 1 de l'etape 5c) : deux moities, ni brulure ni
    // ralentissement ni amplification — §2 de la spec de l'etape 5c.
    //
    // ⚠️ **Premiere ligne a porter `armorReduction` PAR ELLE-MEME** : jusque
    // la, seule `ReactionDef.zoneArmorReduction` (Supraconduction) rabotait
    // l'armure — une propriete de la REACTION, jamais de l'element seul.
    // `CHAUX_ARMOR_REDUCTION` (`shared/constants.ts`) reste sous
    // `SUPRACONDUCTION_ARMOR_REDUCTION` : un element seul mord moins fort
    // qu'une reaction a deux elements.
    //
    // ⚠️ **Et la seule ligne a porter `fieldSign: -1` — « il fuit »,
    // decision de jeu assumee au §2 de la spec de l'etape 5c contre deux
    // autres formes derivables (errer, se tromper de joueur). La direction
    // du champ est SUBSTITUEE, jamais ecrite dans `Horde#targetField` (qui
    // se recalcule a chaque tick depuis les positions des joueurs) — voir
    // `Horde#recomputeSteering`.
    //
    // ⚠️ Valeurs de depart, a regler a l'oeil comme le reste du catalogue
    // elementaire.
    name: 'chaux',
    // ⚠️ **Craie, et plus vert-jaune (etape 8), signale en jouant : *« on voit
    // pas les chaux et vif-argent »*.** 0xb4d94a etait un vert-jaune pose sur
    // une carte d'HERBE VERTE, et une zone se dessine a `ZONE_ALPHA` (0,34) :
    // la teinte arrivait a l'ecran a un tiers de sa force, sur un fond de meme
    // famille — elle disparaissait. Ce qui se lit sur du vert, c'est un ecart
    // de VALEUR, pas un ecart de nuance : le blanc crayeux en a un, et il dit
    // la chaux vive mieux que le vert-jaune.
    tint: 0xe8dcc0,
    burnPerTick: 0,
    slowFactor: 1,
    damageAmp: 1,
    armorReduction: CHAUX_ARMOR_REDUCTION,
    fieldSign: -1,
  },
  {
    // Vif-argent (tache 2 de l'etape 5c) : ni brulure, ni ralentissement, ni
    // amplification, ni reduction d'armure, ni inversion de champ — tous les
    // effets de CETTE table a leur neutre.
    //
    // ⚠️ **Son effet REEL — la liaison — ne vit PAS dans cette table.**
    // Meme cas STRUCTUREL que la Foudre (voir son docbloc plus haut) : la
    // liaison se derive d'une PAIRE de positions et d'une zone annoncee
    // (`linkedNeighbours`, `shared/links.ts`), jamais d'un champ QUE PORTE
    // L'ELEMENT lui-meme. Un appelant doit de toute facon savoir qu'il tient
    // du Vif-argent (`ELEMENT.VIF_ARGENT`) avant d'appeler `linkedNeighbours`
    // — ajouter un champ ici pour ce seul element n'aurait donc rien
    // generalise, exactement le raisonnement de la Foudre. Voir
    // `shared/elements.test.ts` (`EFFET_HORS_TABLE`) pour la garde et le
    // rapport de la tache 2 pour la decision ecrite (exempter, pas
    // elargir).
    //
    // ⚠️ Valeurs de depart, a regler a l'oeil comme le reste du catalogue
    // elementaire.
    name: 'vif-argent',
    // ⚠️ **Lilas metallique, et plus gris clair (etape 8), meme raison que la
    // chaux juste au-dessus** : 0xc9c9e8 etait un gris a peine bleute, donc a
    // `ZONE_ALPHA` il devenait un voile que l'herbe avalait. Le lilas garde le
    // metal (il reste desature a cote des deux violets du catalogue d'armes)
    // mais porte assez de couleur pour exister a un tiers d'opacite.
    tint: 0xb9b4ff,
    burnPerTick: 0,
    slowFactor: 1,
    damageAmp: 1,
    armorReduction: 0,
    fieldSign: 1,
  },
];

export const ELEMENTS: readonly Element[] = ELEMENT_DEFS.map((e, id) => ({ ...e, id }));

/**
 * Les identifiants, nommes.
 *
 * ⚠️ **Ces nombres recopient des positions de `ELEMENT_DEFS`**, et une
 * constante recopiee sans garde derive en silence — le dossier en a deja un
 * exemple (`CARD_WEAPON` dans `loadout.ts`, garde par un test d'egalite).
 * `elements.test.ts` verifie donc que chaque cle pointe bien sur l'element du
 * meme nom : inserer une ligne dans `ELEMENT_DEFS` sans decaler cette table
 * fait rougir immediatement, au lieu de teinter les ennemis en bleu et de les
 * bruler quand meme.
 */
export const ELEMENT = {
  NEUTRE: 0,
  BRAISE: 1,
  GIVRE: 2,
  FOUDRE: 3,
  POIX: 4,
  CHAUX: 5,
  VIF_ARGENT: 6,
} as const;

export function elementOf(id: number): Element {
  const found = ELEMENTS[id];
  if (!found) {
    throw new Error(`element inconnu : ${id}`);
  }
  return found;
}
