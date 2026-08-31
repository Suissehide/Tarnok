import { LIGHT_HP } from './archetypes';
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
 * Reserve de depart d'une entite au palier `k`, a partir des PV de son
 * archetype — **la seule porte par laquelle `hpScale` entre dans le jeu**.
 *
 * ⚠️ **LA PIETAILLE LEGERE NE MONTE PAS EN PV, ET C'EST LA DECISION DE CETTE
 * FONCTION.** Le §4.1 de l'orientation la definit comme de la *« chair a
 * canon »* : faire grossir sa reserve contredit ce qu'elle EST. La difficulte
 * passe pour elle par le NOMBRE (`waveCountScale`) et par la PART DE LOURDS
 * (`HEAVY_WAVE_SHARE`, `back/src/wave-director.ts`) — deux leviers deja en
 * place, dont le second est celui que la porte du §3.3 de l'etape 5a designe
 * explicitement comme *« le vrai levier de difficulte »*.
 *
 * ⚠️ **Ce qui a impose ce choix est une MESURE, pas une preference.** La tache
 * 2 de l'etape 6a a mesure et signale le defaut plutot que de le cacher : la
 * durabilite est un ESCALIER la ou `hpScale` est une courbe lisse, et sa
 * premiere marche est un DOUBLEMENT.
 *
 * | Palier | PV de la pietaille legere | Coups de dague |
 * | --- | --- | --- |
 * | 0 | 5,00 | **1** |
 * | 1 | 5,60 | **2** — x2 de durabilite pour +12 % de PV |
 * | 2 | 6,27 | 2 |
 * | 3 | 7,02 | 2 |
 *
 * Effet mesure au banc `back/bench/niveau2.bench.ts` — 40 graines, budget de
 * 100 s, un joueur passif :
 *
 * | Etat du code | Mediane | Maximum | Echecs |
 * | --- | --- | --- | --- |
 * | avec la montee des PV sur toute la pietaille | 40,9 s | 64,2 s | **1/40** |
 * | **avec cette exemption** | **41,3 s** | **63,5 s** | **0/40** |
 * | + le boss REEL de la tache 3 (etat d'aujourd'hui) | 40,8 s | 60,0 s | 3/40 |
 *
 * ⚠️ **La troisieme ligne n'annule pas la deuxieme : ce n'est pas la meme
 * cause, et les confondre serait la pire lecture de ce tableau.** La marche de
 * durabilite est bien soldee — c'est ce que dit le passage de 1/40 a 0/40, a
 * boss constant. Le 3/40 vient d'ailleurs : depuis que le boss porte
 * `BOSS_HP_BASE`, il apparait a **30 s sur toutes les graines** (vague 5), un
 * joueur SEUL vise la menace la plus proche — donc lui — et verse toute sa
 * production dans 6 000 PV qu'il ne percera jamais. Il cesse de tuer, donc de
 * ramasser des orbes, et la horde l'emporte 20 a 30 s plus tard. Quatre joueurs
 * le tuent en 87 s (`bench/boss.bench.ts`) ; un joueur, jamais.
 *
 * ⚠️ **Et une part en revient au DECOR, il faut le dire aussi** : le releve
 * vise aveuglement la menace la plus proche. Un joueur reel qui laisserait le
 * boss de cote pour continuer a moissonner la horde garderait ses orbes. Ce
 * chiffre est donc un PIRE CAS de comportement, pas une impossibilite.
 *
 * **C'est un resultat, pas un incident, et il est laisse OUVERT** : ce jeu vise
 * quatre joueurs, et rien dans la spec ne dit ce que doit valoir une run solo
 * au palier 0. Le test de `room.test.ts` garde une graine fixe, donc il ne
 * devient pas intermittent — mais la question « un boss doit-il tomber dans une
 * run solo ? » appartient a la verification manuelle (tache 12).
 *
 * ⚠️ **La cause tient a une decision de l'etape 5a**, et il faut la nommer :
 * `LIGHT_HP` vaut EXACTEMENT les degats de la dague, choisi pour preserver le
 * rythme de l'etape 3 a l'identique. C'est ce qui place le systeme PILE sur
 * une frontiere, la ou toute augmentation la franchit.
 *
 * ⚠️ **C'est R9 a l'envers.** A l'etape 4, l'arrondi AVALAIT l'empilement des
 * passifs — deux cartes de cadence ne changeaient rien. Ici il AMPLIFIE
 * l'echelle de palier. Meme cause : *quand une grandeur continue se consomme
 * en unites discretes, se tenir pile sur une frontiere rend le systeme
 * maximalement fragile.*
 *
 * **Les deux autres candidats, et pourquoi ils perdent** : decaler `LIGHT_HP`
 * sous la frontiere ne fait que REPOUSSER la marche (a 4 PV elle arrive au
 * palier 3) tout en cassant l'egalite que `archetypes.test.ts` garde entre
 * `LIGHT_HP` et les degats de la dague ; accepter l'escalier laisse le palier
 * 1 deux fois plus dur que le palier 0, ce que ni la formule ni le §9.2 ne
 * promettent.
 *
 * ⚠️ **Ce que ce choix coute, dit franchement** : au-dela du palier ~10, une
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
