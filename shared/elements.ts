/**
 * Le catalogue des elements. Comme `archetypes.ts`, `weapons.ts` et
 * `passives.ts` : l'index dans le tableau **est** l'identifiant, rien a
 * synchroniser entre serveur et clients.
 *
 * ⚠️ **`NEUTRE` est une entree de la table, pas un cas particulier.** Il
 * occupe l'index 0 et n'a aucun effet : `burnPerTick` a zero, `slowFactor` a
 * un, et une teinte de 0xffffff qui est l'identite du produit dans un batch
 * Pixi. Un ennemi non marque, une arme neutre et une zone neutre passent donc
 * par exactement le meme chemin que les autres, sans branche `if (element ===
 * NEUTRE)` a maintenir a chaque site d'appel.
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
   * Seule la Poix depasse 1 ; la valeur neutre evite une branche
   * `if (element === POIX)` au site d'application.
   */
  damageAmp: number;
  /**
   * Armure SOUSTRAITE (jamais multipliee) a qui se tient dans une zone
   * portant cet element, INDEPENDAMMENT de toute reaction specifique (0 :
   * aucun effet). S'ajoute a `ReactionDef.zoneArmorReduction`
   * (Supraconduction).
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
   * inverse la direction (fuite plutot que poursuite). La Chaux est la seule
   * ligne a ne pas valoir `+1`.
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
 * teinter (la teinte est gratuite dans le batch Pixi, une branche par entite
 * ne l'est pas).
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
    // Braise : degats sur la duree, aucun ralentissement.
    //
    // 0,1 degat par tick, soit 3 degats par seconde a 30 Hz. La braise seule
    // acheve la pietaille legere et entame la lourde sans la tuer : c'est la
    // reaction qui tue, pas l'etat persistant.
    //
    // ⚠️ Se regle avec `MARK_DURATION_TICKS` : les deux se multiplient.
    name: 'braise',
    tint: 0xff7a3c,
    burnPerTick: 0.1,
    slowFactor: 1,
    damageAmp: 1,
    armorReduction: 0,
    fieldSign: 1,
  },
  {
    // Givre : ralentit, aucun degat. Assez pour se voir sans figer la horde,
    // qui doit continuer d'arriver au contact.
    name: 'givre',
    tint: 0x7ad8ff,
    burnPerTick: 0,
    slowFactor: 0.6,
    damageAmp: 1,
    armorReduction: 0,
    fieldSign: 1,
  },
  {
    // Foudre : chaque impact saute vers quelques ennemis proches. L'effet vit
    // dans `shared/chain.ts` (`chainTargets`), pas dans cette table : la
    // chaine se derive d'un POINT D'IMPACT, pas d'une marque portee par
    // l'entite, donc l'appelant sait de toute facon qu'il tient une Foudre.
    // Elle multiplie les CIBLES, pas le degat de chacune.
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
    // brulure ni ralentissement.
    //
    // ⚠️ **Elle ne ralentit PAS, volontairement** : le Givre ralentit deja, et
    // deux elements au meme effet principal seraient du contenu mort. Le
    // Givre garde le controle, la Poix amplifie : les deux se draftent
    // ENSEMBLE (Verglas) au lieu de se remplacer.
    //
    // 1,5 : un coup de moins pour tuer de la pietaille lourde a la dague, pas
    // un coup qui tue seul — c'est la reaction qui execute.
    name: 'poix',
    tint: 0x3d2b1f,
    burnPerTick: 0,
    slowFactor: 1,
    damageAmp: 1.5,
    armorReduction: 0,
    fieldSign: 1,
  },
  {
    // Chaux : rabote l'armure et fait fuir, ni brulure ni ralentissement ni
    // amplification.
    //
    // `CHAUX_ARMOR_REDUCTION` (`shared/constants.ts`) reste sous
    // `SUPRACONDUCTION_ARMOR_REDUCTION` : un element seul mord moins fort
    // qu'une reaction a deux elements.
    //
    // `fieldSign: -1` : « il fuit ». La direction du champ est SUBSTITUEE,
    // jamais ecrite dans `Horde#targetField` (voir `fieldSign`).
    name: 'chaux',
    // ⚠️ **Craie, pas vert-jaune** : une zone se dessine a `ZONE_ALPHA`, a un
    // tiers de sa force, sur de l'herbe verte. Ce qui s'y lit, c'est un ecart
    // de VALEUR, pas de nuance.
    tint: 0xe8dcc0,
    burnPerTick: 0,
    slowFactor: 1,
    damageAmp: 1,
    armorReduction: CHAUX_ARMOR_REDUCTION,
    fieldSign: -1,
  },
  {
    // Vif-argent : tous les effets de CETTE table a leur neutre.
    //
    // ⚠️ **Son effet REEL — la liaison — ne vit PAS dans cette table**, comme
    // la Foudre : elle se derive d'une PAIRE de positions et d'une zone
    // annoncee (`linkedNeighbours`, `shared/links.ts`). Garde :
    // `EFFET_HORS_TABLE` dans `shared/elements.test.ts`.
    name: 'vif-argent',
    // Lilas metallique, meme raison que la chaux : un gris se perdait dans
    // l'herbe a `ZONE_ALPHA`.
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
 * ⚠️ **Ces nombres recopient des positions de `ELEMENT_DEFS`** :
 * `elements.test.ts` verifie que chaque cle pointe sur l'element du meme nom.
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
