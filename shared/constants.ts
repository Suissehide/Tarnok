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
 * ⚠️ Ce n'est plus qu'une valeur de DEPART : le passif « vitalite » l'augmente
 * de 20 par carte prise, et `PlayerState.maxHp` porte le total courant. Le
 * snapshot encode `hp` en `u16` depuis la tache 8 de l'etape 4, precisement
 * pour que ce total ne soit borne par aucun detail de transport.
 */
export const PLAYER_MAX_HP = 100;

/** Vitesse d'un joueur, en pixels monde par seconde. */
export const PLAYER_SPEED = 260;

/** Cote d'une cellule de flowfield, en pixels monde. §4.2 : « environ 64 px ». */
export const FLOWFIELD_CELL = 64;

/** Recalcul du flowfield, en passes par seconde. §3.5 : 5 a 10 Hz. */
export const FLOWFIELD_HZ = 10;

/**
 * Rayon en deca duquel deux entites se repoussent, dans le calcul de
 * repulsion de la tache 19 (`Horde` — recherche de voisins par grille).
 *
 * ⚠️ Doit rester inferieur ou egal a la moitie de `SEPARATION_CELL` : c'est ce
 * qui garantit qu'un voisin en interaction est forcement dans la cellule
 * courante ou l'une des huit adjacentes. Les augmenter separement casse la
 * recherche de voisins sans qu'aucun test unitaire ne le voie.
 *
 * Reutilise tel quel par `#applyDeoverlap` (tache 22) comme rayon de
 * chevauchement : la meme notion de « personnelle » que la repulsion de
 * pilotage decide deja, pas une seconde distance a maintenir en phase avec
 * la premiere.
 */
export const SEPARATION_RADIUS = 28;

/** Cote d'une cellule de la grille de recherche de voisins (tache 19). */
export const SEPARATION_CELL = 56;

/**
 * Cadence a laquelle CHAQUE ENTITE recalcule sa trajectoire (direction du champ
 * melangee a la repulsion, tache 21), en ticks — tache 19. Le reste du temps,
 * l'entite CONSERVE sa vitesse et se contente d'avancer : c'est ce qui remplace
 * la force de separation appliquee a chaque pas (§3.3 de la spec, quatre
 * principes mesures, voir le rapport de la tache 19).
 *
 * 9 (300 ms a `TICK_HZ`) est la valeur mesuree : elle divise par neuf le nombre
 * d'entites qui executent la recherche de voisins a chaque tick — coeur du
 * gain de 4,53 a 0,74 ms mesure a 4000 entites (`npm run bench:sep -w back`) —
 * tout en genant l'oscillation gauche-droite du sprite PAR CONSTRUCTION : une
 * vitesse tenue ne peut plus se renverser d'un tick a l'autre.
 *
 * Depuis la tache 21, ce choix ne conditionne plus le SAUT MAXIMAL par tick :
 * celui-ci est devenu intrinseque a la vitesse propre de l'archetype (voir
 * `STEERING_REPULSION_WEIGHT`), quelle que soit la cadence de recalcul. `K`
 * reste un reglage de reactivite — a quelle vitesse un monstre reagit a une
 * horde qui se densifie — pas de securite.
 */
export const STEERING_RECOMPUTE_TICKS = 9;

/**
 * Poids SANS DIMENSION de la repulsion dans le melange de directions (tache
 * 21) : `direction = normaliser(direction_du_champ + poussee * POIDS)`, puis
 * `vitesse = direction * vitesse_propre_de_l_archetype`.
 *
 * Remplace `STEERING_REPULSION_STRENGTH` (tache 19), une raideur en px/s qui
 * s'AJOUTAIT a la vitesse et pouvait donc la faire largement depasser la
 * vitesse propre du monstre — de la PROPULSION. Melanger des DIRECTIONS puis
 * remettre a l'echelle de la vitesse propre rend ce depassement structurellement
 * impossible : la borne n'est plus une constante a regler, elle est
 * INTRINSEQUE (la vitesse resultante ne peut jamais depasser `archetypeOf(...).speed`,
 * qu'il y ait 0 ou 1000 voisins). Voir le test « aucun deplacement ne depasse
 * la vitesse propre... » de `shared/horde.test.ts`.
 *
 * ⚠️ **4 s'est revele trop haut (tache 22).** A cette valeur, la repulsion
 * domine le champ 4 contre 1 : mesure sur 800 entites dispersees autour du
 * joueur pendant 10 s, 289 sur 800 s'eloignaient de leur cible a tout
 * instant et la horde se stabilisait a 209 px de rayon SANS JAMAIS ARRIVER —
 * « ils s'arretent de bouger », « si je ne bouge plus, plus aucun monstre ne
 * bouge ». **0,5** est la valeur qui laisse le champ dominer : approche a 58 %
 * de la vitesse propre au lieu de 41 %, et le nombre de fuyards tombe de 289 a
 * 155. Seule, cette valeur fait converger la horde vers un TAS (462 sur 800 a
 * moins de 34 px les uns des autres, empiles) — c'est `DEOVERLAP_MAX_PX`,
 * PAS ce poids, qui defait cet empilement. Voir le rapport de la tache 22.
 */
export const STEERING_REPULSION_WEIGHT = 0.5;

/**
 * Deplacement maximal, en pixels, qu'une correction de position peut
 * infliger a UNE SEULE entite en UN SEUL tick pour defaire un chevauchement
 * avec un voisin (tache 22, `Horde` — `#applyDeoverlap`).
 *
 * A `STEERING_REPULSION_WEIGHT = 0,5`, le pilotage seul fait converger 462
 * entites sur 800 a moins de `CONTACT_RADIUS` les unes des autres — un TAS,
 * pas une horde, chacune sur 8 px² : « quand ils se contournent, souvent ils
 * reculent » n'etait qu'une moitie du symptome, l'autre etant que le
 * pilotage DEVIE pour eviter un chevauchement mais ne le RESOUT jamais. Cette
 * borne est ce qui manquait : une correction de POSITION, pas de vitesse,
 * qui rapproche deux entites qui se chevauchent de leur distance de confort
 * (`SEPARATION_RADIUS`) sans jamais depasser ces quelques pixels par tick.
 *
 * ⚠️ **La borne interdit la propulsion, elle n'est pas un reglage a monter.**
 * Une piste ecartee par la mesure (propager l'arret de voisin en voisin pour
 * former un mur) figeait les 800 entites a 300 px de rayon median — l'arret
 * se propageait a travers toute la horde. Une borne trop large romprait le
 * meme invariant que `STEERING_REPULSION_WEIGHT` : `#advanceByVelocity`
 * garantit deja qu'aucune entite ne se deplace plus vite que sa propre
 * vitesse en un tick, et cette correction s'AJOUTE a ce deplacement — elle
 * doit donc rester petite devant lui pour ne jamais lire, a l'ecran, comme
 * une propulsion.
 *
 * 4 est la valeur mesuree (`npm run bench:sep -w back`) : combinee au poids
 * de 0,5 ci-dessus, elle fait passer le nombre d'entites a moins de
 * `CONTACT_RADIUS` de 462 (empilees) a 51 (un ANNEAU autour du joueur), le
 * rayon median de 33 a 116 px, et les fuyards de 155 a 23 — pour un saut
 * maximal observe de 7,2 px (la vitesse propre plus cette borne), jamais plus.
 */
export const DEOVERLAP_MAX_PX = 4;

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

/*
 * ⚠️ **`ORB_LIFETIME_TICKS` a ete SUPPRIME** (etape 6a, tache 15, sur retour de
 * jeu : *« l'xp ne doit pas disparaitre »*). Un orbe non ramasse vivait 600
 * ticks (20 s) puis s'evaporait, des deux cotes, par derivation de `bornTick`.
 *
 * ⚠️ **Supprime, pas rallonge.** Une duree « tres longue » aurait fallu la
 * choisir, la documenter, et elle aurait fini par mordre dans une run longue —
 * c'est-a-dire mentir exactement la ou on croit ne plus la voir. Ce qui borne
 * la reserve d'orbes est desormais sa CAPACITE, et elle se compte :
 * `OrbField.truncatedOrbs` / `Room.orbesTronquees`.
 */

/** Rayon de ramassage d'un orbe, en pixels monde. Arbitre par le serveur (§6.1) — jamais derive cote client. */
export const ORB_PICKUP_RADIUS = 90;

/**
 * Une mort sur combien laisse un orbe — etape 5a, tache 17, sur retour de jeu :
 * *« moins d'xp qui tombe ou plus par niveau »*.
 *
 * ⚠️ **C'est le NOMBRE D'OBJETS AU SOL que l'auteur decrit, pas la courbe de
 * progression.** Monter `XP_PER_ORB` seul ne change pas ce nombre : il change
 * combien d'orbes il faut pour un niveau. Le levier du ressenti est ici, et
 * lui seul — a 4, trois morts sur quatre ne laissent plus rien.
 *
 * ⚠️ **Le tirage est ARITHMETIQUE, jamais aleatoire** (`dropsOrb`, dans
 * `shared/horde.ts`) : le serveur arbitre le ramassage mais le client DERIVE
 * l'existence de l'orbe du seul message `DEATHS` (voir `DerivedOrbs`). Un
 * `Math.random` d'un cote ferait apparaitre chez l'un des orbes que l'autre
 * n'a pas — et `shared/` l'interdit pour cette raison exacte.
 *
 * ⚠️ **Doit diviser `MAX_PER_WAVE`** (4096), sinon le taux reel n'est plus
 * `1/n` : les identites sont `waveId * MAX_PER_WAVE + index`, et le reste
 * modulo `n` ne suit l'index que si `n` divise le pas de vague.
 */
export const ORB_DROP_ONE_IN = 4;

/**
 * Experience gagnee par orbe ramasse, avant multiplication par la courbe de
 * niveau.
 *
 * ⚠️ **DERIVEE du taux de chute, et c'est tout l'interet.** L'experience par
 * MORT vaut `XP_PER_ORB / ORB_DROP_ONE_IN`, soit 1 — exactement ce qu'elle
 * valait avant la tache 17. Rarefier les orbes sans relever leur valeur
 * repousserait le premier draft, l'inverse de ce que l'auteur demande ; ecrire
 * cette derivation rend ce contresens impossible plutot que de compter sur un
 * commentaire pour le rappeler.
 *
 * ⚠️ **Ce qui a change, ce n'est donc PAS le rythme des niveaux** — c'est la
 * granularite : un orbe vaut desormais 40 % du premier seuil
 * (`LEVEL_XP_BASE` = 10) au lieu de 10 %. C'est ce que « chacun compte » veut
 * dire, et c'est **mesure** — un joueur passif, le meme geste que le test
 * « un joueur passif atteint le niveau 2 », sur les memes 40 graines de carte :
 *
 * | | Niveau 2, mediane | Maximum | Echecs | Orbes au sol, au pic |
 * | --- | --- | --- | --- | --- |
 * | avant la tache 17 | 43,2 s | 56,0 s | 0/40 | **86** |
 * | apres | 44,3 s | 55,5 s | 0/40 | **25** |
 *
 * Le premier draft ne bouge pas ; ce qui traine au sol est divise par 3,4.
 */
export const XP_PER_ORB = ORB_DROP_ONE_IN;

/**
 * Duree du gel, en ticks, a chaque montee de niveau — « le monde et le
 * chronometre se figent » (§6.2).
 *
 * Valeur de l'etape 3. ⚠️ Ce commentaire annoncait a tort que l'etape 4
 * porterait cette meme constante a 20 s : la decision finalement retenue
 * (voir le journal de l'etape 4, ruling R2) est de la SUPPRIMER en tache 6 et
 * de la remplacer par un mecanisme different — une fenetre `DRAFT_WINDOW_TICKS`
 * qui se referme des que tout le monde a pose un jeton, et non plus une duree
 * fixe. Ne pas reutiliser cette constante pour le gel du draft.
 *
 * Encore vivante a ce stade de l'etape 4 : six lectures dans `back/` et
 * `front/` en dependent, retirees toutes ensemble en tache 6 seulement.
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
 * Ajoutee en tache 9, absente du plan d'origine — enregistree depuis au
 * tableau « Coherence des constantes ». La multiplication par `playerCount`
 * est la exigee des cette etape (et non differee a l'etape 4) par le §5 de la
 * spec d'orientation : « la courbe d'experience est multipliee par N », «
 * sans ca une equipe de quatre joueurs gele quatre fois plus souvent qu'un
 * joueur seul » (§7.4). Sans effet visible en solo (N=1, seul mode
 * verifiable cette etape) — la formule existe pour que l'etape 4 n'ait pas a
 * la rouvrir.
 *
 * ⚠️ Doit rester assez petite pour qu'un SEUL seuil (pas le cumul de la run)
 * tienne sur les 16 bits de `SnapshotMessage.xp` : `xp` est remis a
 * l'excedent apres chaque niveau plutot que cumule sur toute la run (voir
 * `Room.#gainXp`), donc le plus grand seuil pratique — quelques centaines a
 * quatre joueurs et niveau dix — reste tres loin de 65535.
 */
export const LEVEL_XP_BASE = 10;

/**
 * Nombre de slots d'armes d'un joueur (§6.1).
 *
 * ⚠️ Les quatre sont TOUS draftes — aucun n'est attribue d'avance. L'arme
 * neutre de base (`WEAPONS[0]`) tire toujours mais ne consomme pas de slot :
 * la modifier sans lire `Room#fireWeapons` casserait cette exception.
 *
 * ⚠️ **Passe de 5 a 4 a la tache 19, sur retour de jeu.** Le nombre n'est pas
 * un invariant : c'est `Loadout.canTake` qui le fait respecter, en un seul
 * endroit. Aucun test ni aucun banc ne doit donc ecrire « cinq » en dur — les
 * arsenaux d'epreuve se derivent de cette constante, sans quoi ils levent
 * « slots d'armes pleins » au prochain reglage. Le depot a deja paye l'erreur
 * inverse avec `WAVE1_MIN_COUNT`.
 */
export const WEAPON_SLOTS = 4;

/**
 * Nombre de slots de passifs d'un joueur (§6.1).
 *
 * ⚠️ Borne le nombre de passifs DISTINCTS possedes, pas le nombre de cartes
 * prises : un passif deja possede s'empile dans son slot existant sans en
 * consommer un nouveau (modele Risk of Rain, §3.3). L'extension a 6 slots par
 * evenements de run est hors perimetre de cette etape.
 */
export const PASSIVE_SLOTS = 3;

/**
 * Duree de la fenetre de draft, en ticks (20 s a `TICK_HZ`).
 *
 * ⚠️ Plafond du §7.4 valable seulement a PLUSIEURS joueurs : en solo, la
 * fenetre se referme des que l'unique joueur a clique, pas apres ce delai.
 */
export const DRAFT_WINDOW_TICKS = 600;

/**
 * Cartes supplementaires dans l'etalage, au-dela du nombre de joueurs
 * (§7.2 point 1) : un etalage a N joueurs compte `N + SPREAD_BONUS` cartes.
 *
 * ⚠️ Contrainte non evidente : l'etalage doit rester STRICTEMENT plus grand
 * que le nombre de joueurs, sinon le **remplacement d'un perdant** peut n'avoir
 * plus rien a offrir. A 4 joueurs et 7 cartes (`SPREAD_BONUS = 3`), quatre
 * prises laissent trois cartes : la borne tient.
 *
 * Cette contrainte a d'abord ete justifiee par la repioche, qui n'existe plus.
 * **Elle reste vraie, pour une autre raison** — c'est le §4.4 qui l'exige
 * maintenant, pas le §7.2 point 4.
 */
export const SPREAD_BONUS = 3;

/**
 * Capacite de la file de projectiles d'un salon.
 *
 * ⚠️ **Mesuree, puis relevee quand l'empilement a leve la borne.**
 *
 * Un joueur entretient au plus `salvoCount(arme, exemplaires) *
 * ceil(projectileLifeTicks / cooldownTicks)` projectiles par arme. Tant qu'une
 * arme ne se prenait qu'une fois, quatre joueurs aux slots pleins tenaient une
 * centaine de projectiles simultanes et 256 laissait un large facteur de marge.
 *
 * Depuis que les armes s'empilent, chaque exemplaire elargit la salve d'un
 * projectile et **le plafond de `WEAPON_SLOTS` armes ne borne plus rien** :
 * c'est le nombre d'EXEMPLAIRES qui commande, et lui n'a pas de plafond.
 *
 * ⚠️ **Remesure a la tache 19**, quand `WEAPON_SLOTS` est passe de 5 a 4 : les
 * chiffres du tableau precedent avaient ete releves a cinq slots et sont
 * devenus faux d'un cinquieme. Quatre joueurs, arsenal plein, sans horde (donc
 * sans collision pour vider le reservoir) :
 *
 * | Exemplaires par arme | Cartes d'armes | A quatre joueurs |
 * | --- | --- | --- |
 * | 1 | 4 | 68 |
 * | 4 | 16 | 128 |
 * | 8 | 32 | 208 |
 * | 16 | 64 | 368 |
 * | 32 | 128 | 688 |
 * | 48 | 192 | **1008** |
 *
 * 1024 couvre donc une cinquantaine d'exemplaires par arme (a 56, le reservoir
 * tronque). Ce n'est qu'un plafond : il coute de la memoire (huit tableaux
 * types, ~50 ko par salon), jamais du temps — c'est le nombre de projectiles
 * VIVANTS qui coute, pas la capacite.
 *
 * ⚠️ Vit dans `shared/` et pas dans `back/src/room.ts` : le client dimensionne
 * son propre reservoir sur la meme valeur, et deux copies divergeraient. Quand
 * elle est atteinte, `Projectiles.truncatedProjectiles` compte ce qui n'est pas
 * parti — une salve qui disparait en silence est une carte payee pour rien.
 */
export const PROJECTILE_CAPACITY = 1024;

/**
 * Duree d'une marque elementaire sur un ennemi, en ticks (2 s a `TICK_HZ`) —
 * etape 5a, §4.3 de la spec.
 *
 * ⚠️ **L'expiration est DERIVEE, jamais annoncee**, exactement comme celle des
 * zones (`ZONE_LIFETIME_TICKS`) : `Horde.markUntil` porte le tick d'expiration,
 * et `Horde.markAt` le compare au tick courant. Aucune horloge murale, aucun
 * message de disparition — un `MARK_EXPIRED` doublerait le trafic pour une
 * information que les deux cotes calculent deja.
 *
 * ⚠️ **C'est un REGLAGE DE JEU, pas un invariant.** Trop court, aucune
 * reaction n'a le temps d'avoir lieu ; trop long, tout reagit tout le temps.
 * La valeur se juge a l'oeil (§12 de la spec, tache 11 du plan), donc **aucun
 * test ne doit ecrire 60 en dur** : les assertions se derivent de cette
 * constante. Le depot vient de payer l'erreur inverse — deux tests de
 * troncature de vague se fiaient a `WAVE1_MIN_COUNT = 16` et sont devenus
 * intermittents des qu'il est passe a 10.
 */
export const MARK_DURATION_TICKS = 60;

/**
 * Duree de vie d'une zone au sol, en ticks (3 s a `TICK_HZ`) — etape 5a,
 * §5.1 de la spec.
 *
 * ⚠️ **Derivee des deux cotes depuis `bornTick`, jamais annoncee** — le modele
 * que les orbes ont porte jusqu'a l'etape 6a, ou leur peremption a disparu
 * (tache 15) et ou celle-ci est restee la seule. La zone est annoncee A LA
 * CREATION (§5.3 : le
 * client ne peut pas savoir ou finit un projectile serveur, les siens etant
 * cosmetiques depuis l'etape 3), mais sa MORT ne coute rien sur le fil : les
 * deux cotes comparent `tick - bornTick` a cette constante et obtiennent la
 * meme reponse. Une expiration calculee autrement d'un cote ferait disparaitre
 * un quad plus tot chez l'un — visible, et le debut d'une divergence.
 */
export const ZONE_LIFETIME_TICKS = 90;

/**
 * Intervalle minimal entre deux prolongations d'une meme zone — etape 5a,
 * §5.1 bis de la spec, tache 10.
 *
 * ⚠️ **C'est une regle de JEU, pas un reglage de trafic, et c'est le seul
 * moyen de n'avoir qu'une verite.** La fusion fait repartir le `bornTick`
 * d'une zone existante ; ce rafraichissement DOIT etre annonce, sinon la zone
 * du client meurt avant celle du serveur et le ralentissement du Givre — donc
 * le DEPLACEMENT — diverge. Mais annoncer chaque fusion fait suivre au trafic
 * la cadence des armes, exactement le couplage que la regle de pose venait de
 * supprimer pour le COMPTE : chaque zone arrosee a chaque tick vaut
 * `TICK_HZ` messages par seconde, soit **9,67 ko/s par client a 30 zones**
 * (banc `zones`), contre 1,22 ko/s de trafic TOTAL a l'etape 4.
 *
 * **La parade : l'annonce EST la verite.** Une zone n'est prolongee — donc
 * annoncee — qu'au plus une fois par intervalle, et **entre deux annonces le
 * serveur ne prolonge pas non plus**. Les deux cotes lisent alors exactement
 * le meme `bornTick`, sans divergence possible, et le trafic redevient
 * fonction du seul NOMBRE de zones, que la fusion borne deja par la surface.
 *
 * ⚠️ **La demi-vie, et pas moins.** Une zone entretenue doit survivre : avec
 * un intervalle superieur a `ZONE_LIFETIME_TICKS`, une zone arrosee sans
 * relache mourrait quand meme, et « un joueur qui arrose le meme endroit
 * entretient une zone » deviendrait faux. La demi-vie laisse une marge d'une
 * demi-vie entiere entre la derniere prolongation possible et la peremption.
 *
 * ⚠️ **Derive, jamais recopiee** : un `45` en dur ici cesserait de suivre
 * `ZONE_LIFETIME_TICKS` a son premier reglage a l'oeil (tache 11).
 */
export const ZONE_REFRESH_INTERVAL_TICKS = Math.floor(ZONE_LIFETIME_TICKS / 2);

/**
 * Rayon d'une zone au sol, en pixels monde — etape 5a, §5.1.
 *
 * ⚠️ **Superieur a `SEPARATION_RADIUS` (28), et ce n'est pas un reglage de
 * sensation.** Sous cette borne, une zone ne couvrirait jamais deux ennemis a
 * la fois — la horde se tient a une distance de confort de 28 px — et le
 * recouvrement du §5.2 ne se verrait jamais.
 *
 * ⚠️ **C'est un levier de cout de premier ordre** : le recouvrement de zones
 * est en O(zones²) et le marquage en O(zones × entites). Ce n'est pas le seul
 * (voir `ZoneField.spawn` : la cadence des armes elementaires en etait un au
 * moins aussi gros, jusqu'a ce que la regle de pose l'annule).
 *
 * Il sert aussi de rayon de FUSION a la pose : deux zones du meme element
 * finissent donc toujours a plus de `ZONE_RADIUS` l'une de l'autre, ce qui
 * borne leur nombre par la surface couverte.
 */
export const ZONE_RADIUS = 70;

/**
 * Capacite de la reserve de zones au sol d'un salon — second rideau derriere
 * la regle de fusion de `ZoneField.spawn` (§5.1 bis).
 *
 * La borne PREMIERE est la regle de pose, pas ce plafond : sans elle, « un
 * projectile = une zone » portait 90 zones a quatre joueurs a un exemplaire
 * par arme, **209 a quatre exemplaires et 368 a huit** (l'empilement de
 * l'etape 4 elargissant chaque salve), contre « quelques dizaines » budgetees
 * au §6.6 de l'orientation. La fusion rend le compte fonction de la SURFACE
 * couverte, pas de la cadence ni du nombre d'exemplaires ; 128 couvre
 * largement ce que quatre joueurs peuvent teindre en `ZONE_LIFETIME_TICKS`.
 *
 * ⚠️ Vit dans `shared/` et pas dans `back/`, meme raison que
 * `PROJECTILE_CAPACITY` : le client dimensionne sa propre reserve sur cette
 * valeur, et deux copies divergeraient. Quand elle est atteinte,
 * `ZoneField.truncatedZones` compte ce qui n'a pas ete pose — une zone qui ne
 * se pose pas est un effet que le joueur a paye et qui ne se voit pas.
 */
export const ZONE_CAPACITY = 128;

/**
 * Plafond du compteur de Synergie de l'equipe (§7 de l'etape 5a).
 *
 * ⚠️ **Une donnee d'EQUIPE, un seul nombre**, comme l'experience : il voyage
 * dans l'en-tete du `SNAPSHOT`, pas dans le bloc de chaque joueur (voir
 * `SnapshotMessage.synergy`).
 *
 * ⚠️ **Tient tres largement dans le `u16` du snapshot** — 20 contre 65 535 —
 * et `protocol.test.ts` le verifie plutot que de le supposer. C'est la lecon
 * de l'etape 4 : `hp` etait encode sur un octet, le passif « vitalite » a
 * pousse un joueur a 260 PV, et il se repliait en silence a 4 PV au decodage.
 * Un champ elargi par une carte de contenu ne doit jamais se decouvrir en jeu.
 *
 * La barre se CHARGE a cette etape et ne se depense jamais : l'ultime d'equipe
 * du §6.5 de l'orientation est hors perimetre. Le plafond n'est donc pas un
 * oubli, c'est le comportement voulu.
 */
export const SYNERGY_MAX = 20;

/**
 * Rayon du Choc thermique, en pixels monde — etape 5a, §6.1 de la spec.
 *
 * Vaut `ORB_PICKUP_RADIUS` (90) par choix du plan : le flash du §9 est
 * « court, large, genereux », et il doit couvrir VISIBLEMENT ce qu'il tue. Un
 * rayon plus petit que le flash ferait mourir des ennemis hors du dessin ; un
 * rayon plus grand tuerait hors champ.
 *
 * ⚠️ **Vit dans `shared/` bien que la reaction soit arbitree par le SERVEUR
 * seul.** Le client ne s'en sert que pour dimensionner le flash (tache 9), et
 * jamais pour decider qui meurt : les morts arrivent par `DEATHS`, comme
 * depuis l'etape 3. Deux copies du nombre feraient un flash decale de ce qu'il
 * est cense montrer.
 */
export const REACTION_RADIUS = 90;

/**
 * Degats bruts d'un Choc thermique sur chaque ennemi dans `REACTION_RADIUS` —
 * etape 5a, §6.1 : *« degats bruts massifs sur une cible, et sur les ennemis
 * dans un rayon court »*.
 *
 * ⚠️ **Ni la spec ni le plan ne donnaient de valeur** (constat de la tache 7) :
 * les deux decrivent l'effet, aucun ne le chiffre. 25 est choisi ici pour que
 * « massif » veuille dire quelque chose — c'est plus que `HEAVY_HP` (20), donc
 * la reaction tue la pietaille lourde d'un coup, la ou la Braise seule ne fait
 * qu'entamer sa reserve (6 degats sur une marque entiere). C'est la difference
 * que le §9 demande a l'oeil de lire : *« l'etat persistant est discret, la
 * reaction est spectaculaire »*.
 *
 * ⚠️ **C'est un REGLAGE DE JEU, pas un invariant**, exactement comme
 * `MARK_DURATION_TICKS` : il se juge en jeu (tache 11), et **aucun test ne
 * doit ecrire 25 en dur** — les assertions se derivent de cette constante, ou
 * la comparent a `HEAVY_HP`.
 */
export const REACTION_DAMAGE = 25;

/**
 * Nombre de vagues ordinaires avant que le directeur ne demande le boss du
 * palier — §9.1 de l'orientation, « 4 vagues + 1 boss ≈ 5 min ».
 *
 * ⚠️ **Ce n'est PAS la duree d'un palier, et c'est volontaire.** Une vague
 * tombe toutes les `PERIOD_TICKS` (6 s), donc quatre vagues font 24 s : le
 * reste des cinq minutes, c'est le TEMPS DE TUER LE BOSS. Le palier se termine
 * a sa mort, jamais a un tick (§2 de la spec de l'etape 6a) — une equipe qui
 * peine y reste plus longtemps, une equipe qui domine avance.
 *
 * ⚠️ **Corollaire : le nombre de vagues d'un palier n'est PAS fixe**, il vaut
 * `WAVES_PER_PALIER` plus toutes celles tombees pendant le combat de boss
 * (les vagues ne s'arretent pas, §2). Le palier ne se derive donc pas du
 * `waveId` — voir `shared/paliers.ts`.
 */
export const WAVES_PER_PALIER = 4;

/**
 * Pente de la montee du nombre d'ennemis par vague : `x (1 + 0,15 k)` au
 * palier `k` (§9.2 de l'orientation, §3 de la spec de l'etape 6a).
 *
 * ⚠️ **Ce n'est pas un reglage de sensation, c'est la duree de vie du jeu.**
 * Une table s'epuise en trois soirees ; une formule ne s'epuise pas mais peut
 * diverger. **Les deux sens comptent** : trop plate, la run n'a pas de fin ;
 * trop raide, le palier 8 est un mur.
 *
 * ⚠️ **Multiplie un compte deja plafonne par `waveCountBounds`**, dont le
 * `Math.min(..., MAX_ENTITIES)` s'applique AVANT cette echelle : ce n'est donc
 * pas lui qui protege du debordement. Ce qui protege, c'est que le regime
 * etabli (320) reste tres loin de `MAX_ENTITIES` (4000) — la marge tient
 * jusqu'au palier 76, et `back/src/wave-director.test.ts` le mesure au lieu de
 * l'esperer.
 */
export const PALIER_COUNT_SCALE = 0.15;

/**
 * Base de la montee des points de vie : `x 1,12^k` au palier `k` (§9.2).
 *
 * ⚠️ **Divise le rythme de mise a mort, deja a -12,8 % depuis l'etape 5a.**
 * C'est ce que la porte du §7 de la spec mesure a la tache 3 : si le boss du
 * palier 0 tient plus de trois minutes, c'est `BOSS_HP_PER_PLAYER` qui baisse **et**
 * cette valeur qui se rouvre.
 *
 * ⚠️ **Exponentielle, la seule des trois formules a l'etre.** A `k = 10` elle
 * vaut deja 3,1 ; a `k = 20`, 9,6. C'est voulu — la run doit finir par
 * s'arreter — mais ca veut dire que toute retouche de cette valeur se juge
 * loin, pas au palier 1.
 */
export const PALIER_HP_SCALE = 1.12;

/**
 * Or verse a l'equipe quand le boss du palier 0 tombe ; les paliers suivants
 * en recoivent davantage (`palierGold`, `shared/paliers.ts`).
 *
 * ⚠️ **Valeur de depart, pas une mesure.** Le plan la donne « a regler » : il
 * n'y a rien a quoi la comparer tant que l'etape 7 n'a pas donne un prix a
 * l'or. 100 est choisi pour etre lisible a l'ecran et pour laisser
 * `palierGold` strictement croissante malgre son arrondi — a base 1, deux
 * paliers voisins rendraient le meme montant.
 */
export const GOLD_PER_PALIER_BASE = 100;

/**
 * Part de l'or non securise que l'equipe CONSERVE quand elle est effacee —
 * une **fraction de 0 a 1**, appliquee a la totalite de la cagnotte.
 * `0` : tout est perdu.
 *
 * ⚠️ **LE parametre du §9.3 de l'orientation, et il est nomme plutot
 * qu'ecrit en dur pour cette raison exacte.** Le §9.3 appelle cette ligne
 * *« le principal risque de design de tout le document »* : perdre vingt-cinq
 * minutes d'or sans rien est un motif d'arret de jeu. La decision de l'auteur
 * est **100 % perdu, et on juge en jeu** (§5 de la spec de l'etape 6a) — donc
 * la valeur peut bouger apres le premier playtest, et un `0` en dur dans une
 * branche de `Room` transformerait un reglage en chantier.
 *
 * Les deux alternatives que le §9.3 demande de pouvoir essayer **sans
 * refonte**, et ce qu'elles coutent ici :
 *
 * | Alternative | Ce qu'il faut changer |
 * | --- | --- |
 * | un plancher de 10 a 20 % | **cette valeur seule** : `0.15` |
 * | le bonus de palier toujours paye | pas une valeur : deux bourses |
 *
 * ⚠️ **La seconde ne se ramene PAS a une fraction, et il faut le dire plutot
 * que de laisser croire que cette constante couvre les deux.** « Le bonus de
 * palier toujours paye » separe l'or en deux natures — celui des boss, acquis
 * d'office, et le reste, non securise — donc un second compteur dans `Room`.
 * Ce que cette constante garantit, c'est que la perte passe par **une seule
 * ligne**, celle de `Room#checkRunOver` : c'est la, et nulle part ailleurs,
 * qu'une seconde bourse viendrait se brancher.
 *
 * ⚠️ **Une fraction, pas un montant.** Un montant conserve (« on garde 200 »)
 * rendrait la punition derisoire en fin de run et totale au palier 0 —
 * l'inverse exact de ce que le §9.3 craint.
 */
export const WIPE_GOLD_KEPT = 0;
