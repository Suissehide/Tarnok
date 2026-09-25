/**
 * Le catalogue des elements (§4 de la spec de l'etape 5a).
 *
 * Meme motif que `archetypes.ts`, `weapons.ts` et `passives.ts` : une table
 * pilotee par la donnee, l'index dans le tableau **est** l'identifiant, rien a
 * synchroniser entre serveur et clients. Les quatre elements restants du §6.3
 * de l'orientation seront des lignes de plus dans `ELEMENT_DEFS`, pas de
 * l'architecture — c'est tout l'objet du decoupage 5a / 5b.
 *
 * ⚠️ **`NEUTRE` est une entree de la table, pas un cas particulier.** Il
 * occupe l'index 0 et n'a aucun effet : `burnPerTick` a zero, `slowFactor` a
 * un, et une teinte de 0xffffff qui est l'identite du produit dans un batch
 * Pixi. Un ennemi non marque, une arme neutre et une zone neutre passent donc
 * par exactement le meme chemin que les autres, sans branche `if (element ===
 * NEUTRE)` a maintenir a chaque site d'appel — c'est le role que
 * `BASE_WEAPON_ID` joue deja pour les armes.
 */

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
   * ⚠️ **1 partout aujourd'hui, et c'est volontaire.** La Poix (tache 4) sera
   * la premiere ligne a depasser 1. La valeur neutre joue ici le role que
   * `TINT_IDENTITE` joue pour la teinte et `slowFactor: 1` pour le
   * deplacement : elle evite une branche `if (element === POIX)` au site
   * d'application, qui est precisement ce que cette table existe pour ne pas
   * avoir a maintenir.
   */
  damageAmp: number;
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
} as const;

export function elementOf(id: number): Element {
  const found = ELEMENTS[id];
  if (!found) {
    throw new Error(`element inconnu : ${id}`);
  }
  return found;
}
