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
 * Rayon de detection d'un coup entre un projectile et une entite (§5.2) : la
 * largeur de la zone de contact autour de la trajectoire, pas une garantie de
 * non-traversee a elle seule.
 *
 * Ce qui empeche le « tunneling » a haute vitesse, c'est la GEOMETRIE de
 * `Projectiles.collide` — elle teste la distance de l'entite au SEGMENT
 * parcouru pendant le tick, pas seulement au point d'arrivee — et non la
 * valeur de cette constante. Une premiere version la contraignait a rester
 * superieure a `projectileSpeed / TICK_HZ` pour l'arme la plus rapide ; ce
 * raisonnement etait faux : il ne protegeait que les cibles pile sur l'axe
 * de tir, et manquait en silence toute cible qui coupait la trajectoire sur
 * le cote au milieu du pas — un defaut qui s'aggravait avec la vitesse,
 * c'est-a-dire exactement la ou la contrainte pretendait proteger. Voir le
 * test de reproduction dans `shared/projectiles.test.ts`.
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

/**
 * Degats infliges par un contact avec un ennemi, par intervalle (§3.4 /
 * §6.3). Ce qui borne la duree de survie au contact permanent n'est PAS
 * cette valeur seule mais son rapport a `PLAYER_MAX_HP` et
 * `CONTACT_INTERVAL_TICKS` — voir la doc de ce dernier.
 */
export const CONTACT_DAMAGE = 8;

/**
 * Intervalle minimum, en ticks, entre deux touches de contact pour un MEME
 * joueur — une invulnerabilite courte apres chaque touche, pas par paire
 * joueur/monstre.
 *
 * ⚠️ Sans elle, un joueur plante dans la horde perdrait `CONTACT_DAMAGE` a
 * CHAQUE tick (30 fois par seconde a `TICK_HZ`) et mourrait en
 * `PLAYER_MAX_HP / CONTACT_DAMAGE` ticks — moins d'une demi-seconde — au lieu
 * d'environ `PLAYER_MAX_HP / CONTACT_DAMAGE` INTERVALLES de 15 ticks, soit
 * plusieurs secondes. C'est cette constante qui separe les deux regimes.
 */
export const CONTACT_INTERVAL_TICKS = 15;

/**
 * Rayon de contact entre un joueur et un monstre, en pixels monde.
 *
 * §3.4 : hitbox GENEREUSE, l'arbitrage penche en faveur du joueur — un
 * monstre doit visiblement recouper le sprite du joueur, pas seulement
 * l'effleurer au pixel pres.
 */
export const CONTACT_RADIUS = 34;

/**
 * Duree de vie d'un orbe non ramasse, en ticks (20 s a `TICK_HZ`).
 *
 * ⚠️ Doit se calculer IDENTIQUEMENT des deux cotes a partir du seul
 * `tick - bornTick` (§6.1) : aucune horloge murale ne doit jamais entrer
 * dans ce calcul, sous peine de faire disparaitre l'orbe a des instants
 * differents pour le serveur (qui arbitre le ramassage) et pour un client
 * (qui l'affiche).
 */
export const ORB_LIFETIME_TICKS = 600;

/** Rayon de ramassage d'un orbe, en pixels monde. Arbitre par le serveur (§6.1) — jamais derive cote client. */
export const ORB_PICKUP_RADIUS = 90;

/** Experience gagnee par orbe ramasse, avant multiplication par la courbe de niveau. */
export const XP_PER_ORB = 1;

/**
 * Duree du gel, en ticks, a chaque montee de niveau — « le monde et le
 * chronometre se figent » (§6.2).
 *
 * ⚠️ Cette etape la fixe a 2 s, juste assez pour que le message `LEVEL_UP`
 * soit lisible avant la reprise ; l'etape 4 la portera a 20 s plafonnees pour
 * laisser le temps de l'etalage de cartes (§7.4 de l'orientation) — ne pas
 * confondre les deux regimes en reutilisant cette valeur ailleurs.
 */
export const LEVEL_FREEZE_TICKS = 60;

/**
 * Duree de reprise progressive apres le gel, en ticks (1 s), pendant
 * laquelle le mouvement (joueurs, horde, projectiles) est ralenti d'un
 * facteur croissant de 0 a 1.
 *
 * ⚠️ Sans elle, un monstre reste colle au joueur au moment du gel et le
 * touche des la reprise, sans lui laisser le temps de reagir — le §6.2 cite
 * *Swarm* pour cette meme raison.
 */
export const LEVEL_RESUME_TICKS = 30;

/**
 * Base de la courbe d'experience : le seuil pour passer du niveau `n` a
 * `n + 1` vaut `LEVEL_XP_BASE * n * playerCount`.
 *
 * ⚠️ **Absente du tableau « Coherence des constantes » du plan** — la tache 9
 * l'a ajoutee : §5 de la spec d'orientation exige que « la courbe
 * d'experience [soit] multipliee par N » des cette etape, « sans quoi une
 * equipe de quatre joueurs gele quatre fois plus souvent qu'un joueur seul »
 * (§7.4), et rien dans le plan de l'etape 3 ne fournit de formule. Sans effet
 * visible en solo (N=1, seul mode verifiable cette etape).
 *
 * Doit rester assez petite pour qu'un SEUL seuil (pas le cumul de la run)
 * tienne sur les 16 bits de `SnapshotMessage.xp` : `xp` est remis a
 * l'excedent apres chaque niveau plutot que cumule sur toute la run (voir
 * `Room.#gainXp`), donc le plus grand seuil pratique — quelques centaines a
 * quatre joueurs et niveau dix — reste tres loin de 65535.
 */
export const LEVEL_XP_BASE = 10;
