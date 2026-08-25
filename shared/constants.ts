/** Simulation serveur, en pas par seconde. §3.5 : 20 Hz reste possible si la sensation tient. */
export const TICK_HZ = 30;

/**
 * Diffusion serveur -> clients.
 *
 * 30 Hz et non les 15-20 du §3.5 de l'orientation. L'ecart est **paye par la
 * mesure** : le banc de l'etape 1 donne 0,47 ko/s par joueur contre 5-15
 * estimes au §3.3. Il fallait cette cadence pour qu'un tampon d'interpolation
 * de 60 ms contienne plus d'un intervalle — a 20 Hz il n'en contenait que 1,2,
 * et la moindre gigue le vidait.
 */
export const SNAPSHOT_HZ = 30;

/** Entrees client -> serveur. */
export const INPUT_HZ = 30;

/**
 * Retard du tampon d'interpolation client.
 *
 * 60 ms plutot que 100 : ca ramene le decalage visuel du corps d'un allie de
 * 26 a 15 px. Tenable seulement parce que la diffusion est passee a 30 Hz.
 */
export const INTERP_DELAY_MS = 60;

/**
 * Retard, en ticks, applique aux positions de joueurs qui alimentent le
 * flowfield — **des deux cotes**.
 *
 * Le serveur s'impose le retard qu'il inflige au client. Sans ca, les deux
 * cotes calculent leur champ a partir d'entrees differentes, les directions
 * divergent, et une erreur de direction ne se rattrape pas : elle s'accumule a
 * chaque pas. Voir §5 de la spec de l'etape 2.
 *
 * Ne coute rien de perceptible : le champ n'est deja recalcule qu'a 10 Hz, soit
 * une granularite de 100 ms.
 */
export const FIELD_INPUT_DELAY_TICKS = 3;

/**
 * Retard, en ticks, applique a l'etat de horde que lit l'auto-visee (§5.3 de
 * la spec).
 *
 * Egal a `FIELD_INPUT_DELAY_TICKS`, et pas recopie : viser dans un etat plus
 * frais que celui du flowfield ferait designer des cibles differentes d'un
 * poste a l'autre, exactement comme deux flowfields calcules sur des entrees
 * differentes divergent. Deux constantes distinctes seraient deux passes a
 * garder d'accord — les decoupler serait recreer, pour l'auto-visee, le bug
 * que `FIELD_INPUT_DELAY_TICKS` existe pour eviter au flowfield.
 */
export const TARGETING_DELAY_TICKS = FIELD_INPUT_DELAY_TICKS;

/**
 * Rayon de collision entre un projectile et une entite (§5.2).
 *
 * ⚠️ Doit rester superieur a la distance parcourue par le projectile le plus
 * rapide en un seul tick — `projectileSpeed / TICK_HZ` — sous peine de
 * traversees sans collision (« tunneling ») a haute vitesse. L'arme la plus
 * rapide du plan (900 px/s) parcourt ~30 px par tick a 30 Hz ; ce rayon lui
 * laisse une marge.
 */
export const PROJECTILE_HIT_RADIUS = 32;

/** Plafond d'entites vivantes par salon. */
export const MAX_ENTITIES = 4000;

/** Identites reservees par vague. Voir `entityIdOf`. */
export const MAX_PER_WAVE = 4096;

/**
 * Constante de temps de la reconciliation client, en millisecondes.
 *
 * Quand le serveur contredit la prediction locale, on ne teleporte pas : on
 * laisse l'ecart s'eteindre exponentiellement. A 33 ms, il est retombe a 5 %
 * apres une centaine de millisecondes — le « ~100 ms » du plan.
 *
 * Reconciliation naive, volontairement : le rejeu d'entrees appartient a
 * l'etape 2.
 */
export const RECONCILE_TAU_MS = 33;

/**
 * Cote de la carte, en pixels monde. Provisoire : le §15.2 de la spec dit que ce
 * chiffre se tranche avec le resultat du banc de l'etape 1, parce que le cout du
 * flowfield est en O(cellules).
 *
 * Contrainte dure : les positions passent en int16 sur le fil (§3.6), donc la
 * carte ne peut pas depasser 32767.
 */
export const MAP_SIZE = 6000;

export const MAX_PLAYERS = 4;

/**
 * Points de vie maximum d'un joueur.
 *
 * ⚠️ Doit tenir sur un octet (`SNAPSHOT_PLAYER_BYTES` encode `hp` en `u8`) :
 * ne jamais depasser 255.
 */
export const PLAYER_MAX_HP = 100;

/** Vitesse d'un joueur, en pixels monde par seconde. */
export const PLAYER_SPEED = 260;

/** Cote d'une cellule de flowfield, en pixels monde. §4.2 : « environ 64 px ». */
export const FLOWFIELD_CELL = 64;

/** Recalcul du flowfield, en passes par seconde. §3.5 : 5 a 10 Hz. */
export const FLOWFIELD_HZ = 10;

/**
 * Rayon en deca duquel deux entites se repoussent.
 *
 * ⚠️ Doit rester inferieur ou egal a la moitie de `SEPARATION_CELL` : c'est ce
 * qui garantit qu'un voisin en interaction est forcement dans la cellule
 * courante ou l'une des huit adjacentes. Les augmenter separement casse la
 * recherche de voisins sans qu'aucun test unitaire ne le voie.
 */
export const SEPARATION_RADIUS = 28;

/** Cote d'une cellule de la grille de separation. */
export const SEPARATION_CELL = 56;

/**
 * Raideur de la repulsion, en pixels monde par seconde, multipliee par la
 * fraction de recouvrement `(R - d) / R`.
 *
 * ⚠️ **Ce n'est pas un reglage de sensation.** Cette constante fixe la densite
 * d'equilibre de la horde, et le cout de la separation croit avec le CARRE de
 * cette densite. A 120 px/s la repulsion perd contre le flowfield : l'equilibre
 * n'est jamais atteint et le banc de la tache 0 franchit la porte du §3.3 pour
 * cette seule raison. A 1200 px/s la horde se stabilise a ~4 voisins par entite
 * au lieu de ~29, et le rejeu passe de 3,8 ms a 1,3 ms.
 *
 * La baisser est un choix de performance avant d'etre un choix de sensation.
 */
export const SEPARATION_STRENGTH = 1200;

/**
 * Profondeur de l'historique de horde, en ticks, pour le rejeu du §3.2.
 *
 * ⚠️ Doit rester **superieure a la latence maximale attendue**, exprimee en
 * ticks. Huit ticks valent 266 ms a 30 Hz. Au-dela, une mort est appliquee au
 * present et **signalee** — jamais appliquee en silence.
 */
export const ROLLBACK_DEPTH_TICKS = 8;
