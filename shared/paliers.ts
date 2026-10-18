import { BOSS_HP_PER_PLAYER, LIGHT_HP } from './archetypes';
import { GOLD_PER_PALIER_BASE, PALIER_COUNT_SCALE, PALIER_HP_SCALE } from './constants';
import { GOLD_MAX } from './protocol';

/**
 * Les formules de difficulte par palier.
 *
 * ⚠️ **Des fonctions PURES, aucune classe.** Le palier courant est une donnee
 * du SALON (`Room`), pas un etat de la formule : un test doit pouvoir demander
 * le palier 10 sans jouer les neuf precedents.
 *
 * ⚠️ **`k` commence a ZERO** — le premier palier d'une run vaut `k = 0`, et
 * les trois formules y rendent leur valeur de base. Une convention 1-based
 * ferait demarrer la run avec la difficulte du deuxieme palier, en silence.
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
 * Reserve de depart d'une entite au palier `k`, a partir des PV de son
 * archetype — **la seule porte par laquelle `hpScale` entre dans le jeu**.
 *
 * ⚠️ **LA PIETAILLE LEGERE NE MONTE PAS EN PV.** C'est de la chair a canon :
 * sa difficulte passe par le NOMBRE (`waveCountScale`) et par la PART DE
 * LOURDS (`HEAVY_WAVE_SHARE`, `back/src/wave-director.ts`).
 *
 * La raison est un piege d'arrondi : `LIGHT_HP` vaut EXACTEMENT les degats de
 * la dague (`archetypes.test.ts` garde l'egalite), donc le systeme est PILE sur
 * une frontiere. La durabilite se compte en coups, un ESCALIER la ou `hpScale`
 * est une courbe lisse : +12 % de PV au palier 1 donnerait deux coups de dague
 * au lieu d'un, une durabilite doublee (mesure par
 * `back/bench/niveau2.bench.ts`). Baisser `LIGHT_HP` ne ferait que repousser
 * la marche de quelques paliers.
 *
 * ⚠️ **Ce que ce choix coute** : au-dela du palier ~10, une
 * horde de pietaille legere reste tuable d'un coup de dague quel que soit le
 * palier. C'est voulu — elle n'est pas censee etre le mur — mais ca reporte
 * TOUTE la montee en durabilite sur les lourds et sur le boss. Si un playtest
 * trouve les paliers hauts trop mous, le levier a bouger est
 * `HEAVY_WAVE_SHARE`, pas cette fonction.
 *
 * ⚠️ **Le seuil est `<=`, pas `===`.** Les elites de `archetypes.ts` portent
 * `LIGHT_HP` en attendant mieux ; le jour ou un archetype naitrait sous
 * `LIGHT_HP`, il serait de la chair a canon a plus forte raison, et une
 * egalite stricte le ferait basculer du cote des lourds en silence.
 */
export function palierHp(baseHp: number, k: number): number {
  return baseHp <= LIGHT_HP ? baseHp : baseHp * hpScale(k);
}

/**
 * Reserve de depart du boss du palier `k` pour `playerCount` joueurs :
 * `BOSS_HP_PER_PLAYER x 1,12^k x max(1, joueurs)`.
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
 * la fonction est PURE et publique, et `bossHp(0, 0)` doit rendre des PV, pas
 * zero. Un test l'appelle a zero.
 *
 * ⚠️ **Passe par `palierHp`, jamais par `hpScale` en direct**, pour que le
 * boss suive toute regle d'echelle que `palierHp` porte.
 *
 * ⚠️ **Les PV sont FIGES A L'APPARITION** : `Room` n'appelle cette fonction
 * qu'une fois, a la naissance du boss. Un joueur qui rejoint ou part pendant
 * le combat ne change pas la reserve d'un boss deja la.
 */
export function bossHp(k: number, playerCount: number): number {
  return palierHp(BOSS_HP_PER_PLAYER, k) * Math.max(1, playerCount);
}

/**
 * Or verse a l'equipe quand le boss du palier `k` tombe.
 *
 * ⚠️ **Indexe sur `hpScale`, pas sur une pente a soi.** Le boss du palier `k`
 * a `1,12^k` fois les PV de celui du palier 0 : recompenser au meme rythme
 * garde constant l'or par unite d'effort, et laisse le MULTIPLICATEUR
 * d'extraction etre la seule raison de rester. Une pente independante ici
 * ferait se compenser deux courbes sans qu'on sache laquelle regler.
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
