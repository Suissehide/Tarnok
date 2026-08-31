import { GOLD_PER_PALIER_BASE, PALIER_COUNT_SCALE, PALIER_HP_SCALE } from './constants';

/**
 * Les trois formules de difficulte du §9.2 de l'orientation, reprises au §3 de
 * la spec de l'etape 6a.
 *
 * ⚠️ **Trois fonctions PURES, aucune classe, et c'est le point.** Le palier
 * courant est une donnee du SALON (`Room`), pas un etat de la formule : deux
 * salons au meme palier doivent lire les memes nombres sans partager quoi que
 * ce soit, et un test doit pouvoir demander le palier 10 sans avoir a jouer
 * les neuf precedents. C'est exactement ce que `waveCountBounds` fait deja
 * pour le numero de vague.
 *
 * ⚠️ **`k` commence a ZERO** — le premier palier d'une run vaut `k = 0`, et
 * les trois formules y rendent leur valeur de base. Une convention 1-based
 * ferait demarrer la run avec la difficulte du deuxieme palier, en silence.
 *
 * ⚠️ **Le palier ne se derive PAS du `waveId`.** L'intuition est forte — quatre
 * vagues par palier, donc `k = floor((waveId - 1) / 5)` — et elle est FAUSSE :
 * le palier se termine a la mort du boss, pas a un tick (§2 de la spec), et
 * les vagues ne s'arretent pas pendant le combat de boss. Le nombre de vagues
 * d'un palier est donc variable, et deux runs a la meme vague 12 peuvent etre
 * a des paliers differents. C'est le SALON qui compte, personne d'autre.
 */

/**
 * Multiplicateur du nombre d'ennemis par vague au palier `k` : `1 + 0,15 k`.
 *
 * Lineaire, la ou les PV sont exponentiels : la horde grossit, mais son cout
 * de simulation aussi, et le §7 de la spec fait de `MAX_ENTITIES` une porte.
 * Une croissance exponentielle des deux cotes ferait diverger le budget de
 * tick bien avant la difficulte.
 */
export function waveCountScale(k: number): number {
  return 1 + PALIER_COUNT_SCALE * k;
}

/**
 * Multiplicateur des points de vie au palier `k` : `1,12^k`.
 *
 * ⚠️ **S'applique a la reserve de DEPART, a l'apparition** — jamais aux degats
 * subis. Multiplier les degats reviendrait a faire baisser les PV, l'inverse
 * exact de l'intention, et le resultat serait le meme pour la pietaille qui
 * meurt d'un coup.
 */
export function hpScale(k: number): number {
  return PALIER_HP_SCALE ** k;
}

/**
 * Or verse a l'equipe quand le boss du palier `k` tombe.
 *
 * ⚠️ **Indexe sur `hpScale`, pas sur une pente a soi.** Le boss du palier `k`
 * a `1,12^k` fois les PV de celui du palier 0 : recompenser au meme rythme
 * garde constant l'or par unite d'effort, et laisse le MULTIPLICATEUR
 * d'extraction (§5 de la spec, tache 6) etre la seule raison de rester. Une
 * troisieme pente independante ici rendrait ce reglage illisible : deux
 * courbes se compenseraient sans qu'on sache laquelle regler.
 *
 * Arrondi : l'or est un compteur affiche, pas une grandeur physique. C'est
 * l'arrondi qui contraint `GOLD_PER_PALIER_BASE` a rester assez grand pour que
 * deux paliers voisins ne rendent jamais le meme montant — le test de
 * croissance stricte le garde.
 */
export function palierGold(k: number): number {
  return Math.round(GOLD_PER_PALIER_BASE * hpScale(k));
}
