/** Simulation serveur, en pas par seconde. */
export const TICK_HZ = 30;

/**
 * Diffusion serveur -> clients. 30 Hz pour que le tampon d'interpolation de
 * 60 ms contienne plus d'un intervalle : a 20 Hz il n'en contenait que 1,2, et
 * la moindre gigue le vidait. La bande passante le permet (moins d'1 ko/s par
 * joueur).
 */
export const SNAPSHOT_HZ = 30;

/** Entrees client -> serveur. */
export const INPUT_HZ = 30;

/**
 * Retard du tampon d'interpolation client. 60 ms garde le decalage visuel d'un
 * allie vers 15 px ; tenable seulement parce que la diffusion est a 30 Hz.
 */
export const INTERP_DELAY_MS = 60;

/**
 * Retard, en ticks, applique aux positions de joueurs qui alimentent le
 * flowfield — **des deux cotes**.
 *
 * Le serveur s'impose le retard qu'il inflige au client. Sans ca, les deux
 * cotes calculent leur champ a partir d'entrees differentes, et une erreur de
 * direction ne se rattrape pas : elle s'accumule a chaque pas. Imperceptible :
 * le champ n'est recalcule qu'a 10 Hz.
 */
export const FIELD_INPUT_DELAY_TICKS = 3;

/**
 * Rayon de detection d'un coup entre un projectile et une entite : la largeur
 * de la zone de contact autour de la trajectoire.
 *
 * ⚠️ Ce n'est pas lui qui empeche le « tunneling » a haute vitesse, c'est la
 * geometrie de `Projectiles.collide`, qui teste la distance au SEGMENT parcouru
 * pendant le tick. Le contraindre a depasser `projectileSpeed / TICK_HZ` ne
 * protegerait que les cibles pile sur l'axe de tir. Voir le test de
 * reproduction dans `shared/projectiles.test.ts`.
 */
export const PROJECTILE_HIT_RADIUS = 32;

/** Plafond d'entites vivantes par salon. */
export const MAX_ENTITIES = 4000;

/** Identites reservees par vague. Voir `entityIdOf`. */
export const MAX_PER_WAVE = 4096;

/**
 * Constante de temps de la reconciliation client, en millisecondes. Quand le
 * serveur contredit la prediction locale, on ne teleporte pas : l'ecart
 * s'eteint exponentiellement (5 % au bout d'environ 100 ms). Pas de rejeu
 * d'entrees.
 */
export const RECONCILE_TAU_MS = 33;

/**
 * Cote de la carte, en pixels monde. Le cout du flowfield est en O(cellules).
 *
 * Contrainte dure : les positions passent en int16 sur le fil, donc la carte
 * ne peut pas depasser 32767.
 */
export const MAP_SIZE = 6000;

export const MAX_PLAYERS = 4;

/**
 * Points de vie de DEPART d'un joueur : le passif « vitalite » l'augmente, et
 * `PlayerState.maxHp` porte le total courant (encode en `u16` dans le
 * snapshot pour que ce total ne soit borne par aucun detail de transport).
 */
export const PLAYER_MAX_HP = 100;

/** Vitesse d'un joueur, en pixels monde par seconde. */
export const PLAYER_SPEED = 260;

/** Cote d'une cellule de flowfield, en pixels monde. */
export const FLOWFIELD_CELL = 64;

/** Recalcul du flowfield, en passes par seconde. */
export const FLOWFIELD_HZ = 10;

/**
 * Rayon en deca duquel deux entites se repoussent (`Horde`, recherche de
 * voisins par grille). Sert aussi de rayon de chevauchement a
 * `#applyDeoverlap` : une seule notion de distance personnelle.
 *
 * ⚠️ Doit rester inferieur ou egal a la moitie de `SEPARATION_CELL` : c'est ce
 * qui garantit qu'un voisin en interaction est dans la cellule courante ou
 * l'une des huit adjacentes. Les augmenter separement casse la recherche de
 * voisins sans qu'aucun test unitaire ne le voie.
 */
export const SEPARATION_RADIUS = 28;

/** Cote d'une cellule de la grille de recherche de voisins. */
export const SEPARATION_CELL = 56;

/**
 * Cadence, en ticks, a laquelle CHAQUE ENTITE recalcule sa trajectoire
 * (direction du champ melangee a la repulsion). Le reste du temps, l'entite
 * conserve sa vitesse et avance.
 *
 * 9 (300 ms) divise par neuf le nombre d'entites qui cherchent leurs voisins
 * a chaque tick (mesure : `npm run bench:sep -w back`), et empeche par
 * construction l'oscillation gauche-droite du sprite : une vitesse tenue ne
 * peut pas se renverser d'un tick a l'autre. C'est un reglage de reactivite,
 * pas de securite : le saut maximal par tick est borne par la vitesse propre
 * de l'archetype (voir `STEERING_REPULSION_WEIGHT`).
 */
export const STEERING_RECOMPUTE_TICKS = 9;

/**
 * Poids SANS DIMENSION de la repulsion dans le melange de directions :
 * `direction = normaliser(direction_du_champ + poussee * POIDS)`, puis
 * `vitesse = direction * vitesse_propre_de_l_archetype`.
 *
 * Melanger des DIRECTIONS puis remettre a l'echelle rend la propulsion
 * impossible : la vitesse resultante ne depasse jamais `archetypeOf(...).speed`,
 * quel que soit le nombre de voisins. Voir le test « aucun deplacement ne
 * depasse la vitesse propre... » de `shared/horde.test.ts`.
 *
 * ⚠️ Trop haut (4), la repulsion domine le champ et la horde se stabilise a
 * distance du joueur SANS JAMAIS ARRIVER. A 0,5 le champ domine ; seule, cette
 * valeur fait converger la horde en TAS — c'est `DEOVERLAP_MAX_PX`, pas ce
 * poids, qui defait l'empilement.
 */
export const STEERING_REPULSION_WEIGHT = 0.5;

/**
 * Deplacement maximal, en pixels, qu'une correction de position peut infliger
 * a UNE entite en UN tick pour defaire un chevauchement (`Horde` —
 * `#applyDeoverlap`). Le pilotage devie pour eviter un chevauchement mais ne
 * le resout jamais ; cette correction de POSITION ramene deux entites qui se
 * chevauchent vers `SEPARATION_RADIUS`.
 *
 * ⚠️ **La borne interdit la propulsion, ce n'est pas un reglage a monter.**
 * Elle s'AJOUTE au deplacement deja borne par la vitesse propre
 * (`#advanceByVelocity`) et doit rester petite devant lui pour ne jamais se
 * lire, a l'ecran, comme une propulsion.
 *
 * Avec le poids de 0,5 ci-dessus, 4 transforme le tas en anneau autour du
 * joueur (mesure : `npm run bench:sep -w back`).
 */
export const DEOVERLAP_MAX_PX = 4;

/**
 * Profondeur de l'historique de horde, en ticks, pour le rejeu.
 *
 * ⚠️ Doit rester **superieure a la latence maximale attendue**, exprimee en
 * ticks (8 ticks = 266 ms). Au-dela, une mort est appliquee au present et
 * **signalee** — jamais appliquee en silence.
 */
export const ROLLBACK_DEPTH_TICKS = 8;

/**
 * Degats infliges par un contact avec un ennemi, par intervalle. La duree de
 * survie au contact depend de son rapport a `PLAYER_MAX_HP` et
 * `CONTACT_INTERVAL_TICKS`.
 */
export const CONTACT_DAMAGE = 8;

/**
 * Intervalle minimum, en ticks, entre deux touches de contact pour un MEME
 * joueur — une invulnerabilite courte apres chaque touche, pas par paire
 * joueur/monstre.
 *
 * ⚠️ Sans elle, un joueur plante dans la horde perdrait `CONTACT_DAMAGE` a
 * CHAQUE tick et mourrait en moins d'une demi-seconde au lieu de plusieurs
 * secondes.
 */
export const CONTACT_INTERVAL_TICKS = 15;

/**
 * Rayon de contact entre un joueur et un monstre, en pixels monde. Hitbox
 * genereuse en faveur du joueur : un monstre doit visiblement recouper son
 * sprite, pas l'effleurer.
 */
export const CONTACT_RADIUS = 34;

/*
 * ⚠️ Les orbes n'ont volontairement PAS de duree de vie : l'xp ne doit pas
 * disparaitre, et une duree « tres longue » finirait par mordre dans une run
 * longue. Ce qui borne la reserve d'orbes est sa CAPACITE, et elle se compte :
 * `OrbField.truncatedOrbs` / `Room.orbesTronquees`.
 */

/** Rayon de ramassage d'un orbe, en pixels monde. Arbitre par le serveur — jamais derive cote client. */
export const ORB_PICKUP_RADIUS = 90;

/**
 * Une mort sur combien laisse un orbe.
 *
 * ⚠️ **C'est le levier du NOMBRE D'OBJETS AU SOL, pas de la progression.**
 * Monter `XP_PER_ORB` seul ne change pas ce nombre. A 4, trois morts sur
 * quatre ne laissent rien.
 *
 * ⚠️ **Le tirage est ARITHMETIQUE, jamais aleatoire** (`dropsOrb`, dans
 * `shared/horde.ts`) : le client DERIVE l'existence de l'orbe du seul message
 * `DEATHS` (voir `DerivedOrbs`). Un `Math.random` d'un cote ferait apparaitre
 * chez l'un des orbes que l'autre n'a pas.
 *
 * ⚠️ **Doit diviser `MAX_PER_WAVE`** (4096), sinon le taux reel n'est plus
 * `1/n` : les identites sont `waveId * MAX_PER_WAVE + index`, et le reste
 * modulo `n` ne suit l'index que si `n` divise le pas de vague.
 */
export const ORB_DROP_ONE_IN = 4;

/**
 * Une mort sur combien laisse une PIECE.
 *
 * ⚠️ **Bien plus rare que `ORB_DROP_ONE_IN`, volontairement.** A une sur
 * seize, la piece reste un evenement : un palier tient ~200 morts, donc ~12
 * pieces contre les 100 d'or du boss.
 *
 * Une piece vaut UN or, sans constante de valeur : rarete et valeur
 * decriraient sinon la meme grandeur a deux endroits.
 *
 * ⚠️ **Doit diviser `MAX_PER_WAVE`**, pour la meme raison que
 * `ORB_DROP_ONE_IN`.
 */
export const COIN_DROP_ONE_IN = 16;

/**
 * Reste que doit valoir une identite pour laisser une piece.
 *
 * ⚠️ **NON NUL, et surtout PAS un multiple de `ORB_DROP_ONE_IN`.** A zero,
 * toute piece tomberait aussi sur une orbe, au meme pixel. A 2, les deux
 * ensembles sont DISJOINTS — un cadavre laisse une orbe, une piece, ou rien.
 *
 * ⚠️ **C'est ce qui rend la nature d'un ramassage LISIBLE dans son
 * identite.** Le serveur annonce `PICKUPS` avec des identites nues ;
 * `dropsOrb` et `dropsCoin` etant disjoints, chaque cote sait si l'objet
 * valait de l'experience ou de l'or **sans un octet de plus**.
 */
export const COIN_DROP_RESIDUE = 2;

/**
 * Experience gagnee par orbe ramasse, avant multiplication par la courbe de
 * niveau.
 *
 * ⚠️ **DERIVEE du taux de chute** : l'experience par MORT vaut
 * `XP_PER_ORB / ORB_DROP_ONE_IN`, soit 1. Rarefier les orbes sans relever
 * leur valeur repousserait le premier draft. Le rythme des niveaux ne depend
 * donc pas du taux de chute ; seule la granularite change.
 */
export const XP_PER_ORB = ORB_DROP_ONE_IN;

/**
 * Duree du gel, en ticks, a chaque montee de niveau.
 *
 * Ne sert plus qu'aux tests. ⚠️ Ne pas la reutiliser pour le gel du draft :
 * celui-ci est une fenetre (`DRAFT_WINDOW_TICKS`) qui se referme des que tout
 * le monde a choisi, pas une duree fixe.
 */
export const LEVEL_FREEZE_TICKS = 60;

/**
 * Duree de reprise progressive apres le gel, en ticks (1 s), pendant laquelle
 * le mouvement (joueurs, horde, projectiles) est ralenti d'un facteur
 * croissant de 0 a 1.
 *
 * ⚠️ Sans elle, un monstre colle au joueur au moment du gel le touche des la
 * reprise, sans lui laisser le temps de reagir.
 */
export const LEVEL_RESUME_TICKS = 30;

/**
 * Base de la courbe d'experience : le seuil pour passer du niveau `n` a
 * `n + 1` vaut `LEVEL_XP_BASE * n * playerCount`. Sans le facteur
 * `playerCount`, une equipe de quatre gelerait quatre fois plus souvent
 * qu'un joueur seul.
 *
 * ⚠️ Doit rester assez petite pour qu'un SEUL seuil tienne sur les 16 bits de
 * `SnapshotMessage.xp` : `xp` est remis a l'excedent apres chaque niveau
 * (voir `Room.#gainXp`), et le plus grand seuil pratique reste tres loin de
 * 65535.
 */
export const LEVEL_XP_BASE = 10;

/**
 * Nombre de slots d'armes d'un joueur.
 *
 * ⚠️ Les slots sont TOUS draftes. L'arme neutre de base (`WEAPONS[0]`) tire
 * toujours mais ne consomme pas de slot : la modifier sans lire
 * `Room#fireWeapons` casserait cette exception.
 *
 * ⚠️ Le nombre n'est pas un invariant : `Loadout.canTake` le fait respecter,
 * en un seul endroit. Aucun test ni banc ne doit l'ecrire en dur — les
 * arsenaux d'epreuve se derivent de cette constante, sans quoi ils levent
 * « slots d'armes pleins » au prochain reglage.
 */
export const WEAPON_SLOTS = 4;

/**
 * Duree de la fenetre de draft, en ticks (20 s).
 *
 * ⚠️ Plafond valable seulement a PLUSIEURS joueurs : en solo, la fenetre se
 * referme des que l'unique joueur a clique.
 */
export const DRAFT_WINDOW_TICKS = 600;

/**
 * Cartes supplementaires dans l'etalage, au-dela du nombre de joueurs : un
 * etalage a N joueurs compte `N + SPREAD_BONUS` cartes.
 *
 * ⚠️ L'etalage doit rester STRICTEMENT plus grand que le nombre de joueurs,
 * sinon le **remplacement d'un perdant** peut n'avoir plus rien a offrir.
 */
export const SPREAD_BONUS = 3;

/**
 * Capacite de la file de projectiles d'un salon.
 *
 * Un joueur entretient au plus `salvoCount(arme, exemplaires) *
 * ceil(projectileLifeTicks / cooldownTicks)` projectiles par arme. Les armes
 * s'empilent et chaque exemplaire elargit la salve : c'est le nombre
 * d'EXEMPLAIRES qui commande, pas `WEAPON_SLOTS`, et il n'a pas de plafond.
 * 2048 couvre une cinquantaine d'exemplaires par arme a quatre joueurs. Toute
 * acceleration des cadences du catalogue doit faire reverifier cette marge.
 *
 * Ce plafond coute de la memoire (~100 ko par salon), jamais du temps : c'est
 * le nombre de projectiles VIVANTS qui coute.
 *
 * ⚠️ Vit dans `shared/` : le client dimensionne son propre reservoir sur la
 * meme valeur. Quand elle est atteinte, `Projectiles.truncatedProjectiles`
 * compte ce qui n'est pas parti — une salve perdue en silence est une carte
 * payee pour rien.
 */
export const PROJECTILE_CAPACITY = 2048;

/**
 * Duree d'une marque elementaire sur un ennemi, en ticks (2 s).
 *
 * ⚠️ **L'expiration est DERIVEE, jamais annoncee**, comme celle des zones :
 * `Horde.markUntil` porte le tick d'expiration, et `Horde.markAt` le compare
 * au tick courant. Aucun message de disparition.
 *
 * ⚠️ **Reglage de jeu, pas un invariant** : trop court, aucune reaction n'a le
 * temps d'avoir lieu ; trop long, tout reagit tout le temps. **Aucun test ne
 * doit ecrire 60 en dur** : les assertions se derivent de cette constante.
 */
export const MARK_DURATION_TICKS = 60;

/**
 * Duree de vie d'une zone au sol, en ticks (3 s).
 *
 * ⚠️ **Derivee des deux cotes depuis `bornTick`, jamais annoncee.** La zone
 * est annoncee A LA CREATION (le client ne peut pas savoir ou finit un
 * projectile serveur), mais sa MORT ne coute rien sur le fil : les deux cotes
 * comparent `tick - bornTick` a cette constante. Une expiration calculee
 * autrement d'un cote ferait diverger les deux.
 */
export const ZONE_LIFETIME_TICKS = 90;

/**
 * Intervalle minimal entre deux prolongations d'une meme zone.
 *
 * ⚠️ **Regle de JEU, et seul moyen de n'avoir qu'une verite.** La fusion fait
 * repartir le `bornTick` d'une zone existante ; ce rafraichissement DOIT etre
 * annonce, sinon la zone du client meurt avant celle du serveur et le
 * ralentissement du Givre — donc le DEPLACEMENT — diverge. Mais annoncer
 * chaque fusion ferait suivre au trafic la cadence des armes (jusqu'a
 * `TICK_HZ` messages par seconde et par zone, mesure par le banc `zones`).
 *
 * **L'annonce EST la verite** : une zone n'est prolongee — donc annoncee —
 * qu'au plus une fois par intervalle, et le serveur ne prolonge pas non plus
 * entre deux annonces. Le trafic ne depend plus que du NOMBRE de zones.
 *
 * ⚠️ **La demi-vie, et pas plus** : une zone arrosee sans relache doit
 * survivre, ce qui exige un intervalle inferieur a `ZONE_LIFETIME_TICKS`.
 * Derivee, jamais recopiee.
 */
export const ZONE_REFRESH_INTERVAL_TICKS = Math.floor(ZONE_LIFETIME_TICKS / 2);

/**
 * Part des tirs qui portent un COUP CRITIQUE, de 0 a 1.
 *
 * ⚠️ **Le tirage n'est PAS une suite aleatoire**, c'est une fonction du tir :
 * `hashRoll(tick, tireur, rang dans la salve)` (voir `shared/random.ts`). Le
 * client peut annoncer le critique AU MOMENT du tir et le serveur arbitrer le
 * meme, sans qu'un octet ne transite ni qu'un generateur a etat doive avancer
 * au meme rythme des deux cotes.
 *
 * 12 % : assez rare pour que le chiffre dore se remarque, assez frequent pour
 * qu'on le voie dans la premiere minute.
 */
export const CRIT_CHANCE = 0.12;

/**
 * Ce qu'un coup critique multiplie. Deux, pas plus : au-dela, le hasard
 * deviendrait le premier facteur de la mise a mort, devant le choix d'arme et
 * le placement.
 */
export const CRIT_MULTIPLIER = 2;

/**
 * Rayon de Contagion, en pixels monde : la marque d'un ennemi qui meurt saute
 * au vivant le plus proche DANS ce rayon (strict), mesure depuis la position
 * du mort. Molette de playtest.
 */
export const CONTAGION_RADIUS = 220;

/** Colosse : un bonus de degats par tranche ENTIERE de ce nombre de PV max. */
export const COLOSSUS_HP_STEP = 10;

/**
 * Rayon d'une zone au sol, en pixels monde.
 *
 * ⚠️ **Superieur a `SEPARATION_RADIUS` (28)** : sinon une zone ne couvrirait
 * jamais deux ennemis a la fois, et le recouvrement ne se verrait jamais.
 *
 * ⚠️ **Levier de cout de premier ordre** : le recouvrement de zones est en
 * O(zones²) et le marquage en O(zones × entites).
 *
 * Sert aussi de rayon de FUSION a la pose : deux zones du meme element
 * finissent a plus de `ZONE_RADIUS` l'une de l'autre, ce qui borne leur
 * nombre par la surface couverte.
 */
export const ZONE_RADIUS = 70;

/**
 * Capacite de la reserve de zones au sol d'un salon — second rideau derriere
 * la regle de fusion de `ZoneField.spawn`, qui est la vraie borne : elle rend
 * le compte fonction de la SURFACE couverte, pas de la cadence ni du nombre
 * d'exemplaires. 128 couvre largement ce que quatre joueurs peuvent teindre
 * en `ZONE_LIFETIME_TICKS`.
 *
 * ⚠️ Vit dans `shared/`, meme raison que `PROJECTILE_CAPACITY`. Quand elle est
 * atteinte, `ZoneField.truncatedZones` compte ce qui n'a pas ete pose.
 */
export const ZONE_CAPACITY = 128;

/**
 * Plafond du compteur de Synergie de l'equipe.
 *
 * ⚠️ **Une donnee d'EQUIPE** : elle voyage dans l'en-tete du `SNAPSHOT`, pas
 * dans le bloc de chaque joueur (voir `SnapshotMessage.synergy`). Tient dans
 * le `u16` du snapshot, ce que `protocol.test.ts` verifie.
 *
 * La barre se charge et ne se depense jamais : le plafond est voulu.
 */
export const SYNERGY_MAX = 20;

/**
 * Rayon du Choc thermique, en pixels monde. Il doit couvrir VISIBLEMENT ce
 * qu'il tue : plus petit que le flash, des ennemis mourraient hors du dessin ;
 * plus grand, hors champ.
 *
 * ⚠️ **Vit dans `shared/` bien que la reaction soit arbitree par le SERVEUR
 * seul** : le client ne s'en sert que pour dimensionner le flash, jamais pour
 * decider qui meurt (les morts arrivent par `DEATHS`).
 */
export const REACTION_RADIUS = 90;

/**
 * Degats bruts d'un Choc thermique sur chaque ennemi dans `REACTION_RADIUS`.
 * Plus que `HEAVY_HP` (20) : la reaction tue la pietaille lourde d'un coup, la
 * ou la Braise seule ne fait qu'entamer sa reserve. L'etat persistant est
 * discret, la reaction spectaculaire.
 *
 * ⚠️ **Reglage de jeu, pas un invariant** : **aucun test ne doit ecrire 25 en
 * dur** — les assertions se derivent de cette constante, ou la comparent a
 * `HEAVY_HP`.
 */
export const REACTION_DAMAGE = 25;

/**
 * Nombre de vagues ordinaires avant que le directeur ne demande le boss du
 * palier.
 *
 * ⚠️ **Ce n'est PAS la duree d'un palier.** Le palier se termine a la mort du
 * boss, jamais a un tick : une equipe qui peine y reste plus longtemps. Les
 * vagues continuent pendant le combat de boss, donc le nombre de vagues d'un
 * palier n'est PAS fixe et le palier ne se derive pas du `waveId` — voir
 * `shared/paliers.ts`.
 */
export const WAVES_PER_PALIER = 4;

/**
 * Le vote d'extraction (le portail) s'ouvre toutes les `PORTAL_EVERY_WAVES`
 * vagues, boss compris — plus a la mort de chaque boss. A une vague toutes
 * les 6 s, vingt vagues font deux minutes. Reglage de depart.
 */
export const PORTAL_EVERY_WAVES = 20;

/**
 * Pente de la montee du nombre d'ennemis par vague : `x (1 + 0,15 k)` au
 * palier `k`.
 *
 * ⚠️ **C'est la duree de vie du jeu** : trop plate, la run n'a pas de fin ;
 * trop raide, le palier 8 est un mur.
 *
 * ⚠️ **Multiplie un compte deja plafonne par `waveCountBounds`**, dont le
 * `Math.min(..., MAX_ENTITIES)` s'applique AVANT cette echelle : ce n'est donc
 * pas lui qui protege du debordement, mais la marge entre le regime etabli et
 * `MAX_ENTITIES`, que `back/src/wave-director.test.ts` mesure.
 */
export const PALIER_COUNT_SCALE = 0.15;

/**
 * Base de la montee des points de vie : `x 1,12^k` au palier `k`. Si le boss
 * du palier 0 tient trop longtemps, c'est `BOSS_HP_PER_PLAYER` qui baisse
 * **et** cette valeur qui se rouvre.
 *
 * ⚠️ **Exponentielle, la seule des trois formules a l'etre** : 3,1 a `k = 10`,
 * 9,6 a `k = 20`. La run doit finir par s'arreter, mais toute retouche se
 * juge loin, pas au palier 1.
 */
export const PALIER_HP_SCALE = 1.12;

/**
 * Or verse a l'equipe quand le boss du palier 0 tombe ; les paliers suivants
 * en recoivent davantage (`palierGold`, `shared/paliers.ts`).
 *
 * Valeur de depart. 100 laisse `palierGold` strictement croissante malgre son
 * arrondi — a base 1, deux paliers voisins rendraient le meme montant.
 */
export const GOLD_PER_PALIER_BASE = 100;

/**
 * Part de l'or non securise que l'equipe CONSERVE quand elle est effacee —
 * une **fraction de 0 a 1**, appliquee a toute la cagnotte. `0` : tout est
 * perdu.
 *
 * ⚠️ **Nommee plutot qu'ecrite en dur parce que c'est le principal risque de
 * design** : perdre vingt-cinq minutes d'or est un motif d'arret de jeu, et la
 * valeur doit pouvoir bouger apres playtest. Un plancher de 10 a 20 % se
 * regle ici seul.
 *
 * ⚠️ **« Le bonus de palier toujours paye » ne se ramene PAS a une
 * fraction** : il separe l'or en deux natures, donc un second compteur dans
 * `Room`. La perte passe par **une seule ligne**, celle de
 * `Room#checkRunOver` : c'est la qu'une seconde bourse se brancherait.
 *
 * ⚠️ **Une fraction, pas un montant** : un montant conserve rendrait la
 * punition derisoire en fin de run et totale au palier 0.
 */
export const WIPE_GOLD_KEPT = 0;

/**
 * Duree de la fenetre du vote d'extraction, en ticks (20 s).
 *
 * ⚠️ **Le meme nombre que `DRAFT_WINDOW_TICKS`, et deux constantes quand
 * meme** : celle du draft est un PLAFOND sur un choix sans enjeu temporel, que
 * le solo court-circuite ; celle-ci est l'enjeu lui-meme — la vague suivante
 * approche pendant qu'on decide.
 *
 * ⚠️ **Elle ne gele RIEN** : le monde continue de tourner. Voir `Room#step`.
 */
export const PORTAL_WINDOW_TICKS = 600;

/**
 * Ce que « rester » ajoute au multiplicateur d'extraction, a chaque portail
 * refuse. Le multiplicateur part de 1 : la premiere extraction ne majore rien.
 *
 * Lineaire, reglage de playtest : quatre paliers de plus doublent la mise.
 * Elle peut rester plate parce que `palierGold` croit deja en `1,12^k` ; une
 * pente exponentielle ici multiplierait deux courbes et rendrait le reglage
 * illisible.
 *
 * ⚠️ **Ne borne rien a lui seul** : c'est `GOLD_MAX`, la borne du fil, qui
 * arrete l'or acquis (`extractGold`, `shared/paliers.ts`).
 */
export const EXTRACT_MULTIPLIER_STEP = 0.25;

/**
 * Nombre de cibles que touche une chaine de Foudre depuis un point d'impact
 * (`chainTargets`, `shared/chain.ts`). Valeur de depart, a regler a l'oeil
 * avec `CHAIN_RADIUS` (les deux se multiplient) : assez pour depasser la
 * seule cible touchee, trop peu pour nettoyer une vague a lui seul.
 *
 * ⚠️ **Un plafond, pas une promesse** : `chainTargets` peut rendre MOINS de
 * cibles si la horde n'en offre pas assez dans `CHAIN_RADIUS` — jamais plus.
 */
export const CHAIN_JUMPS = 3;

/**
 * Rayon de recherche d'une chaine de Foudre, en pixels monde, depuis le point
 * d'impact. Valeur de depart, a regler a l'oeil. Au-dessus de `ZONE_RADIUS`
 * et de `REACTION_RADIUS` pour que la chaine se distingue du Choc thermique.
 *
 * Ne pose rien au sol : il ne fait que trier la horde par distance
 * (`chainTargets`), en O(horde.count) par appel.
 */
export const CHAIN_RADIUS = 150;

/**
 * Degats par tick d'une zone de Surchauffe (Braise + Foudre) — INDEPENDANT de
 * la marque.
 *
 * ⚠️ **Ne peut PAS se lire au site d'application comme
 * `Element.burnPerTick`.** Le champ porte l'element du DECLENCHEUR (Braise OU
 * Foudre selon l'ordre d'arrivee, voir `ReactionTrigger.element` dans
 * `back/src/combat.ts`) ; s'il porte Foudre, son `burnPerTick` est nul. Cette
 * constante est donc lue par `zoneBurnPerTick` (`shared/reactions.ts`) a
 * partir du nibble de reaction du `kind` empaquete, jamais de l'element.
 *
 * 3x le taux de la Braise : un facteur de deux se perdrait a cote des degats
 * des projectiles et des reactions. Valeur de depart, a regler a l'oeil.
 */
export const SURCHAUFFE_BURN_PER_TICK = 0.3;

/**
 * Duree de vie d'une zone de Surchauffe, en ticks : 1,5x la duree generique,
 * derivee de `ZONE_LIFETIME_TICKS`, jamais recopiee. `ZoneField.aliveAt` /
 * `expire` (`shared/zones.ts`) la lisent via `zoneLifetimeTicks`
 * (`shared/reactions.ts`) : les deux cotes en derivent la meme peremption a
 * partir du meme octet. Valeur de depart, a regler a l'oeil.
 */
export const SURCHAUFFE_ZONE_LIFETIME_TICKS = Math.round(ZONE_LIFETIME_TICKS * 1.5);

/**
 * Plafond DUR de sauts pour Court-circuit (Foudre + Poix) — une borne de COUT,
 * pas une regle de jeu, contrairement a `CHAIN_JUMPS`.
 *
 * ⚠️ Chaque saut construit sa liste de candidats en `O(horde.count)` : sans
 * plafond, `jumps = horde.count` rend l'appel `O(horde.count²)`, et un seul
 * Court-circuit sur 1 000 ennemis fait sauter le budget de tick du banc
 * `zones`. 64 ramene le pire cas a `O(64 x N)`.
 *
 * En jeu, ce plafond ne coupe presque jamais rien : `chainTargets` s'arrete
 * des qu'aucun poisse ne reste a portee de `CHAIN_RADIUS` (voir
 * `chainWhilePoisoned` dans `back/src/combat.ts`).
 */
export const COURT_CIRCUIT_MAX_JUMPS = 64;

/**
 * Armure retiree (SOUSTRAITE, jamais multipliee) a qui se tient dans le champ
 * de la Supraconduction (Givre + Foudre) — lue par `zoneArmorReduction`
 * (`shared/reactions.ts`), combinee par `armureA` (`back/src/combat.ts`).
 *
 * ⚠️ **0,15 vaut `HEAVY_ARMOR`, volontairement** : la pietaille lourde y perd
 * toute son armure, le boss seulement une partie (0,4 -> 0,25).
 *
 * ⚠️ **Bornee a ZERO au site de lecture (`armureA`), jamais ici** : une armure
 * negative amplifierait les degats.
 *
 * Valeur de depart, a regler a l'oeil.
 */
export const SUPRACONDUCTION_ARMOR_REDUCTION = 0.15;

/**
 * Facteur de conservation de la vitesse tenue dans une zone de Verglas
 * (Givre + Poix). `1` : aucun effet (toutes les autres reactions) ; `< 1` :
 * au lieu de recalculer sa trajectoire depuis le champ, l'ennemi GARDE sa
 * vitesse precedente, amortie de ce facteur. Lu par
 * `Horde#recomputeSteering` (`shared/horde.ts`), des deux cotes du fil.
 *
 * ⚠️ **Le derapage se replique pour zero octet** : l'appartenance a la zone se
 * derive (`ZoneField.slowsAt`) et la vitesse tenue est connue des deux cotes.
 *
 * 0,9 par recalcul (`STEERING_RECOMPUTE_TICKS`) : environ 0,35 sur la vie
 * d'une zone, de quoi se voir glisser sans figer l'ennemi. Valeur de depart.
 */
export const VERGLAS_INERTIA_DAMPING = 0.9;

/**
 * Degats par tick entre deux ennemis qui se tiennent tous deux dans une zone
 * de Verglas a moins de `SEPARATION_RADIUS` l'un de l'autre. `0` : aucun
 * effet. Lu par `zoneCollisionDamage` (`shared/reactions.ts`), applique par
 * `resolveVerglasCollisions` (`back/src/combat.ts`).
 *
 * Un DEGAT, donc lu par le SERVEUR seul : aucune contrainte de replication,
 * les morts voyagent deja par `DEATHS`.
 *
 * 0,2 : une pietaille legere (`LIGHT_HP`) prise dans un carambolage meurt en
 * 25 ticks de contact. Valeur de depart.
 */
export const VERGLAS_COLLISION_DAMAGE_PER_TICK = 0.2;

/**
 * Armure retiree (SOUSTRAITE) a qui se tient dans une zone portant l'element
 * Chaux LUI-MEME, hors de toute reaction. Lue par `Element.armorReduction`
 * (`shared/elements.ts`), combinee par `zoneArmorReductionTotal`
 * (`shared/reactions.ts`).
 *
 * ⚠️ **Sous `SUPRACONDUCTION_ARMOR_REDUCTION`, volontairement** : un element
 * seul mord moins qu'une reaction a deux elements. `shared/reactions.test.ts`
 * s'appuie sur cet ecart ; le garder au-dessus romprait ce test.
 *
 * Valeur de depart, a regler a l'oeil.
 */
export const CHAUX_ARMOR_REDUCTION = 0.1;

/**
 * Rayon de liaison du Vif-argent, en pixels monde : deux ennemis DANS LA MEME
 * zone de Vif-argent et a moins de cette distance sont LIES. Lu par
 * `linkedNeighbours` (`shared/links.ts`).
 *
 * ⚠️ **Sous le DIAMETRE d'une zone (`2 x ZONE_RADIUS`)** : deux points d'un
 * meme disque sont au plus a ce diametre l'un de l'autre, donc un rayon plus
 * grand lierait TOUTE paire qui partage une zone et rendrait la condition de
 * distance morte.
 *
 * ⚠️ **Au-dessus de `SEPARATION_RADIUS` (28)** : sinon il ne lierait jamais
 * deux ennemis voisins, qui se tiennent a cette distance de confort.
 *
 * Valeur de depart, a regler a l'oeil.
 */
export const LINK_RADIUS = 80;

/**
 * Majoration de `PROJECTILE_HIT_RADIUS` pour un ennemi dans une zone de
 * Vif-argent : l'« attraction des projectiles » rendue comme un rayon de
 * touche elargi, cote SERVEUR seul.
 *
 * ⚠️ **Un effet de DEGAT, jamais de trajectoire.** Lue par
 * `ZoneField.hitRadiusBonusAt` (`shared/zones.ts`) puis par
 * `Projectiles.collide` (`shared/projectiles.ts`) — jamais par
 * `#emit`/`fireSalvoDirected`, qui ignorent la horde et les zones. Voir le
 * docbloc de `shared/projectiles.ts`. Le joueur le lit comme de l'attraction
 * sans qu'aucun projectile ne devie.
 *
 * 16 : la moitie de `PROJECTILE_HIT_RADIUS`. Valeur de depart.
 */
export const VIF_ARGENT_HIT_RADIUS_BONUS = 16;

/**
 * Degats par tick d'une zone de Fournee (Braise + Chaux) — INDEPENDANT de la
 * marque, meme raison que `SURCHAUFFE_BURN_PER_TICK` (lu par `zoneBurnPerTick`
 * a partir du nibble de reaction). Le double de Surchauffe : Fournee est la
 * zone la plus chaude du catalogue. Valeur de depart.
 */
export const FOURNEE_BURN_PER_TICK = SURCHAUFFE_BURN_PER_TICK * 2;

/**
 * Degats bruts instantanes d'Eclat de gel (Givre + Chaux) sur la SEULE cible
 * qui declenche la reaction, lu par la branche dediee de `applyReactions`
 * (`back/src/combat.ts`).
 *
 * ⚠️ **Jamais par `damageInRadius`** : avec `ReactionDef.radius: 0`, son test
 * strict `dx x dx + dy x dy < radius x radius` n'est vrai pour personne, pas
 * meme au centre. La cible se resout par `Horde.slotOf(t.entityId)`.
 *
 * Deux fois `REACTION_DAMAGE` : concentre sur UNE cible, l'effet doit mordre
 * plus fort par coup que le Choc thermique. Valeur de depart.
 */
export const ECLAT_DE_GEL_DAMAGE = REACTION_DAMAGE * 2;

/**
 * La reserve de bouclier de Transcendance, en points.
 *
 * ⚠️ **FIXE, elle n'echelle pas sur les PV max** : c'est ce qui rend le
 * `shield u8` du snapshot honnete, et ce qui empeche Vitalite de la gonfler.
 *
 * Molette de playtest. Repere : le contact coute 16 PV/s, la reserve tient
 * moins de quatre secondes dans la horde.
 */
export const SHIELD_POOL = 60;
/** Ticks sans degat avant que le bouclier reprenne. Molette de playtest. */
export const SHIELD_CALM_TICKS = 90;
/** Points rendus par seconde une fois le calme atteint. Molette de playtest. */
export const SHIELD_REGEN_PER_SEC = 20;

/**
 * Le plafond de PV que Transcendance impose, a la place de `PLAYER_MAX_HP`
 * plus les cartes et les achats.
 *
 * ⚠️ **`1`, pas `0`** : la regle serveur classe mort a `hp <= 0` — `0` tuerait
 * le porteur a l'instant ou la carte s'applique.
 */
export const TRANSCENDANCE_MAX_HP = 1;
