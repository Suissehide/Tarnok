import { BOSS_HP_PER_PLAYER } from './archetypes';
import {
  GOLD_PER_PALIER_BASE,
  LEVEL_HP_SCALE,
  PALIER_COUNT_SCALE,
  PALIER_HP_SCALE,
} from './constants';
import { GOLD_MAX } from './protocol';

/**
 * Les formules de difficulte : celles du palier (le nombre, l'or) et celle du
 * niveau d'equipe (les PV des monstres).
 *
 * ⚠️ **Des fonctions PURES, aucune classe.** Le palier courant et le niveau
 * sont des donnees du SALON (`Room`), pas un etat de la formule : un test doit
 * pouvoir demander le palier 10 ou le niveau 20 sans jouer les precedents.
 *
 * ⚠️ **`k` commence a ZERO** — le premier palier d'une run vaut `k = 0`, et
 * les formules de palier y rendent leur valeur de base. Une convention 1-based
 * ferait demarrer la run avec la difficulte du deuxieme palier, en silence.
 * **Le niveau, lui, commence a UN** (`Room#level`), et les formules de niveau
 * rendent leur base a `niveau = 1`.
 *
 * ⚠️ **Le palier ne se derive PAS du `waveId`** : le palier se termine a la
 * mort du boss, pas a un tick, et les vagues ne s'arretent pas pendant le
 * combat de boss. Le nombre de vagues
 * d'un palier est donc variable, et deux runs a la meme vague 12 peuvent etre
 * a des paliers differents. C'est le SALON qui compte, personne d'autre.
 */

/**
 * Multiplicateur du nombre d'ennemis par vague au palier `k` : `1 + 0,15 k`.
 *
 * Lineaire, la ou les PV sont exponentiels : le cout de simulation croit avec
 * la horde, et `MAX_ENTITIES` est une limite dure. Une croissance
 * exponentielle ferait exploser le budget de tick bien avant la difficulte.
 */
export function waveCountScale(k: number): number {
  return 1 + PALIER_COUNT_SCALE * k;
}

/**
 * Multiplicateur de l'or du palier `k` : `1,12^k`. Depuis l'etape 15, ne sert
 * plus qu'a `palierGold` — les PV suivent `levelHpScale`.
 */
export function hpScale(k: number): number {
  return PALIER_HP_SCALE ** k;
}

/**
 * Multiplicateur des points de vie des monstres au niveau d'equipe `niveau`
 * (1-based) : `1,10^(niveau - 1)`. Vaut 1 au niveau 1, et jamais moins.
 *
 * ⚠️ **S'applique a la reserve de DEPART, a l'apparition** — jamais aux degats
 * subis. Multiplier les degats reviendrait a faire baisser les PV, l'inverse
 * exact de l'intention.
 *
 * ⚠️ **C'est AUSSI l'echelle des degats FIXES infliges a la horde** :
 * reactions, brulures de zone, collisions de verglas, explosion de kamikaze
 * (`Room#step`). Une reaction a 25 PV fixes ne tuerait plus une brute des le
 * niveau 3 ; indexee sur cette echelle, elle en tue une a tout niveau. C'est
 * une regle, pas une statistique : les sources fixes restent une PART des
 * PV d'un monstre.
 */
export function levelHpScale(niveau: number): number {
  return LEVEL_HP_SCALE ** Math.max(0, niveau - 1);
}

/**
 * Reserve de depart d'une entite au niveau `niveau`, a partir des PV de son
 * archetype — **la seule porte par laquelle `levelHpScale` entre dans le jeu**.
 *
 * ⚠️ **TOUT LE MONDE MONTE, la pietaille legere comprise** (etape 15). Avant,
 * elle etait exemptee a cause d'un piege d'arrondi : `LIGHT_HP` valait
 * EXACTEMENT les degats de la dague, et la premiere marche doublait sa
 * durabilite. Le piege est desamorce autrement : `LIGHT_HP` est passe SOUS la
 * dague (4 contre 5), ce qui laisse trois niveaux de marge avant la premiere
 * marche sans carte de degats — et une seule carte « degats » la repousse.
 * La marche existe toujours, c'est la pression voulue : la horde grossit, le
 * joueur doit choisir des degats.
 */
export function monsterHp(baseHp: number, niveau: number): number {
  return baseHp * levelHpScale(niveau);
}

/**
 * Reserve de depart du boss au niveau `niveau` pour `playerCount` joueurs :
 * `BOSS_HP_PER_PLAYER x 1,10^(niveau - 1) x max(1, joueurs)`.
 *
 * ⚠️ **LA MEME FORME QUE LE SEUIL D'EXPERIENCE** (`Room#xpToNextLevel`,
 * `LEVEL_XP_BASE * niveau * Math.max(1, joueurs)`) : une equipe de quatre
 * fond le boss quatre fois plus vite. Une seconde convention (racine,
 * plafond) rendrait les deux formules illisibles l'une par l'autre.
 *
 * Elle ne rend pas une run solo gagnable au palier 0 : pour un joueur seul,
 * le cout d'un boss tient surtout a sa PRESENCE (un corps de plus qui capte
 * le tir automatique), pas a sa reserve. Voir `back/bench/niveau2.bench.ts`.
 *
 * ⚠️ **`max(1, ...)`** : l'appelant reel a toujours au moins un joueur, mais
 * la fonction est PURE et publique, et `bossHp(1, 0)` doit rendre des PV, pas
 * zero. Un test l'appelle a zero.
 *
 * ⚠️ **Passe par `monsterHp`, jamais par `levelHpScale` en direct**, pour que
 * le boss suive toute regle d'echelle que `monsterHp` porte.
 *
 * ⚠️ **Les PV sont FIGES A L'APPARITION** : `Room` n'appelle cette fonction
 * qu'une fois, a la naissance du boss. Un joueur qui rejoint ou part pendant
 * le combat, ou un niveau monte pendant, ne change pas la reserve d'un boss
 * deja la.
 */
export function bossHp(niveau: number, playerCount: number): number {
  return monsterHp(BOSS_HP_PER_PLAYER, niveau) * Math.max(1, playerCount);
}

/**
 * Or verse a l'equipe quand le boss du palier `k` tombe.
 *
 * ⚠️ **Indexe sur `hpScale`, la pente du palier.** Le boss qui tombe au palier
 * `k` a coute plus d'efforts que celui du palier 0 (plus de vagues, plus
 * d'ennemis) : recompenser a un rythme exponentiel garde l'extraction
 * attrayante loin dans la run, et laisse le MULTIPLICATEUR d'extraction etre
 * la seule raison de rester.
 *
 * Arrondi : l'or est un compteur affiche, pas une grandeur physique. C'est
 * l'arrondi qui contraint `GOLD_PER_PALIER_BASE` a rester assez grand pour que
 * deux paliers voisins ne rendent jamais le meme montant — le test de
 * croissance stricte le garde.
 */
export function palierGold(k: number): number {
  return Math.round(GOLD_PER_PALIER_BASE * hpScale(k));
}

/**
 * L'or **acquis** quand l'equipe part : la cagnotte non securisee, majoree du
 * multiplicateur d'extraction.
 *
 * ⚠️ **Bornee par `GOLD_MAX`, la borne du FIL.** `encodeSnapshot` et
 * `encodePortalResult` bornent deja de leur cote ; si le salon ne bornait pas
 * le sien, une cagnotte assez grosse ferait dire au serveur un nombre et au
 * client un autre. Le test le verifie en faisant passer le resultat par
 * l'encodeur.
 *
 * ⚠️ **Arrondie** : l'or est un `u32` sur le fil, et un multiplicateur
 * fractionnaire rendrait sinon une cagnotte a virgule que l'encodeur
 * arrondirait seul — deux arrondis pour un seul nombre, donc deux verites.
 */
export function extractGold(gold: number, multiplier: number): number {
  return Math.min(GOLD_MAX, Math.round(gold * multiplier));
}
