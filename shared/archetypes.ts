import { PLAYER_SPEED } from './constants';

/**
 * Le bestiaire, et son regime de replication.
 *
 * La taille des sprites du pack tombe pile sur la distinction du §3.3 de
 * l'orientation, ce qui n'est pas un hasard : les 192 px n'ont qu'un `Walk`,
 * les gros ont `Windup` / `Attack` / `Recovery`, ce qui est un vocabulaire de
 * boss.
 *
 * - **Pietaille** (192 px) : repliquee par le generateur, rendue en batch.
 * - **Elite** (256 px et plus) : repliquee comme entite, rendue en `Sprite`.
 *   Hors perimetre de l'etape 2, recensee ici pour que l'ajouter soit du
 *   contenu et pas de l'architecture.
 */
export interface Archetype {
  id: number;
  name: string;
  /** Chemin de la planche dans le pack, relatif a `Monsters/`. */
  sheet: string;
  /** Nombre d'images du cycle de deplacement. */
  frames: number;
  /** Cote de la cellule, en pixels. */
  cell: number;
  /** Vitesse de deplacement, en pixels monde par seconde. */
  speed: number;
  /**
   * Reserve de points de vie de depart (etape 5a, §3.2 de la spec).
   *
   * **Les deux cotes derivent la meme valeur sans un octet de plus** :
   * l'archetype voyage deja dans l'ordre de vague de 19 octets, donc
   * `Horde.spawn` la pose identiquement sur le serveur et sur chaque client.
   * Seul le serveur soustrait les degats — le client n'a jamais besoin de
   * connaitre les PV, il apprend qui meurt par `DEATHS` (§2 de la spec).
   */
  hp: number;
  /**
   * Fraction des degats recus que l'armure absorbe, de 0 a
   * `MAX_ARMOR` — un coup de `brut` retire `brut x (1 - armor)`.
   *
   * ⚠️ **Zero est une entree de la table, pas un cas particulier.** Toute la
   * pietaille legere porte `0`, et elle passe par exactement le meme calcul
   * que le boss : c'est le role que `ELEMENT.NEUTRE` joue pour les elements et
   * `blastRadius: 0` pour les armes. Aucun site d'application n'a de branche
   * `if (armor > 0)` a maintenir.
   *
   * ⚠️ **Lue au SEUL endroit ou un ennemi perd des PV** (`appliquerDegats`,
   * back/src/combat.ts). Deux formules d'armure divergeraient, et le jour ou
   * elles divergent c'est un test qui manque, pas un bug qui se voit.
   *
   * ⚠️ **Bornee a la LECTURE de la table, par `capArmor`** — voir `MAX_ARMOR`.
   * Une borne posee au site d'application laisserait une valeur aberrante
   * vivre dans la donnee et n'echouer que la ou personne ne regarde.
   *
   * ⚠️ **Ne voyage pas, et n'a pas a voyager.** Seul le serveur soustrait des
   * degats (voir `hp` ci-dessus) : le client apprend les morts par `DEATHS`.
   * Rien de nouveau sur le fil.
   */
  armor: number;
  /**
   * De combien le CORPS dessine deborde la hitbox de tir, **pour cet
   * archetype** — `1` pour toute la pietaille, davantage pour le boss
   * (etape 6a, tache 3).
   *
   * ⚠️ **Ce n'est PAS `BODY_SCALE`, et les deux se multiplient.**
   * `front/src/render/horde-renderer.ts` porte un facteur COMMUN
   * (`BODY_SCALE = 1,25`), borne par un test qui dit qu'au-dela la hitbox ment
   * plus que le rendu des projectiles ne la fait deja mentir. Ce plafond garde
   * la pietaille et doit continuer de la garder : le boss ne le releve pas, il
   * apporte SON facteur. Relever le plafond commun aurait agrandi les vingt
   * archetypes pour n'en vouloir qu'un.
   *
   * ⚠️ **Ce que le facteur du boss coute, dit franchement** : sa hitbox de tir
   * reste celle de tout le monde (`PROJECTILE_HIT_RADIUS` ne varie pas par
   * archetype), donc un tir qui touche visiblement son flanc peut passer au
   * travers. C'est le prix de la lisibilite du §4 de la spec — *« nettement
   * plus grand que la pietaille, c'est ce qui le rend lisible dans la
   * melee »* — et **c'est une question laissee ouverte a la verification
   * manuelle** (tache 12) : si le boss se tire comme un mur invisible, la
   * reponse est une hitbox par archetype, pas un facteur plus petit.
   *
   * ⚠️ **Cote rendu — RESOLU a la tache 5, et il faut dire jusqu'ou.** L'atlas
   * de `tools/` n'embarquait que les quatorze pietailles (`SOURCES`), et
   * `HordeRenderer.draw` saute silencieusement un archetype sans textures : le
   * boss etait donc simule, touche, marque et tue, mais pas DESSINE. La tache 5
   * y a ajoute le troll — **lui seul**. Ranger les six elites sature l'atlas
   * (16,2 Mpx de contenu pour 16,8 Mpx disponibles ; mesure dans
   * `tools/build_monster_atlas.py`), et les cinq autres n'apparaissent jamais
   * en jeu. `SOURCES` porte desormais des trous explicites pour que son index
   * reste l'identifiant d'archetype, et le manifeste publie un `id` que
   * `HordeRenderer.adoptAtlas` lit — jamais la position dans le tableau. Le
   * jour ou l'etape 6b fera tourner un pool d'elites, c'est `ATLAS_SIZE` qu'il
   * faudra rouvrir.
   */
  bodyScale: number;
  /**
   * La hitbox de tir par rapport a celle de la pietaille
   * (`PROJECTILE_HIT_RADIUS x hitScale`) — egale a `bodyScale`, sauf pour le
   * boss (`BOSS_HIT_SCALE`).
   *
   * ⚠️ **Retour de playtest (etape 12) : « la hitbox du boss est trop
   * petite ».** A 96 px (`bodyScale` x 32), elle ne couvrait pas la boite
   * dessinee (240 px de diametre, massue comprise) : des tirs qui touchaient
   * visiblement le troll passaient au travers. La touche couvre desormais le
   * dessin entier.
   */
  hitScale: number;
  /** Son ROLE dans la horde (`ROLES`) : ce qui le rend unique a l'ecran. */
  role: Role;
  /** Multiplie l'effectif d'une vague de cet archetype (`ROLES`). */
  countFactor: number;
  /** Son COMPORTEMENT propre, en plus de son role (`Behavior`). */
  behavior: Behavior;
}

/**
 * PV de la pietaille legere. **Egal a `damage` de la dague** (`shared/weapons.ts`,
 * arme 0) : elle meurt donc en un coup, exactement comme avant que les PV
 * n'existent, et le rythme de mise a mort de l'etape 3 est preserve a
 * l'identique. C'est le point de depart de la porte du §3.3 de la spec.
 *
 * ⚠️ Si la dague change de degats, cette valeur doit suivre — le test
 * `archetypes.test.ts` les compare.
 */
export const LIGHT_HP = 5;

/**
 * PV de la pietaille lourde : quatre coups de dague **avant l'armure**, cinq
 * depuis `HEAVY_ARMOR` (20 / (5 x 0,85) = 4,7).
 *
 * Un ennemi qui meurt en un coup ne porte jamais d'element assez longtemps
 * pour reagir (§3.3) : il faut donc que la reserve VARIE par archetype, et
 * c'est la premiere fois que choisir un archetype veut dire autre chose qu'un
 * sprite et une vitesse.
 */
export const HEAVY_HP = 20;

/**
 * Nom de l'archetype de boss. **Le troll, et le depot le disait deja.**
 *
 * La doc des elites, ci-dessous, annonce depuis l'etape 2 que *« c'est l'etape
 * 6 qui leur donnera une reserve digne d'un boss »*, et l'en-tete de ce module
 * que les gros du pack ont `Windup`/`Attack`/`Recovery`, *« ce qui est un
 * vocabulaire de boss »*. L'etape 6a tient cette promesse sur UN d'entre eux
 * plutot que d'inventer un vingt-et-unieme archetype : le pool tournant est
 * l'etape 6b.
 *
 * Le troll parmi les six : la plus grosse cellule du pack (384 px) et la plus
 * LENTE (65 px/s). « Lourd et lent » est deja la lecture que `HEAVY_NAMES`
 * revendique — le boss la pousse a son terme.
 */
const BOSS_NAME = 'troll';

/**
 * PV du boss au palier 0 **et pour UN joueur** — avant `hpScale` et avant la
 * multiplication par le nombre de joueurs, toutes deux faites par `bossHp`
 * (`shared/paliers.ts`).
 *
 * ⚠️ **PAR JOUEUR, et le nom le dit — tache 3 bis.** Le §4 de la spec veut des
 * PV *« croissant en 1,12^k ET avec le nombre de joueurs — meme forme que le
 * seuil d'experience »*, et ce seuil vaut `LEVEL_XP_BASE * niveau * joueurs`.
 * La meme forme impose que cette constante-ci soit la part d'UN joueur : c'est
 * elle qui se multiplie. Elle a donc ete divisee par quatre en meme temps
 * qu'elle changeait de nom (300 -> 75 fois `HEAVY_HP`), **pour que le boss que
 * la tache 3 a mesure ne bouge pas d'un point** : 75 x 4 joueurs = 300, soit
 * exactement les 6 000 PV du releve ci-dessous. Le verdict de la porte reste
 * donc valide sans etre rejoue de complaisance — c'est la MEME configuration.
 *
 * ⚠️ **Renommee plutot que redefinie en silence.** `BOSS_HP_BASE` valait 6 000
 * et vaudrait 1 500 : garder le nom aurait laisse chaque lecture existante dire
 * autre chose que ce qu'elle disait — le motif « la fixture qui masque »,
 * neuf fois dans ce depot. Le renommage force chaque appelant a se relire.
 *
 * ⚠️ **CE QUE CA COUTE, dit en face : en solo le boss ne vaut plus « plusieurs
 * centaines de fois la pietaille lourde », mais 75 fois.** Le §4 de la spec
 * ecrit les deux phrases cote a cote — *« plusieurs centaines de fois »* ET
 * *« croissant avec le nombre de joueurs »* — et elles ne peuvent etre vraies
 * ensemble qu'a effectif plein. C'est a effectif plein que la formulation de la
 * spec se lit, parce que c'est l'equipe de quatre que ce jeu vise et que c'est
 * elle que la porte a mesuree.
 *
 * ⚠️ **MESURE, tache 3, et c'est LA porte du §7 de la spec.** Le plan disait
 * de cette valeur qu'elle etait *« le seul chiffre de ce document qui soit un
 * trou »*, et engageait ses trois issues d'avance : 30 a 90 s pour tuer le
 * boss au palier 0 avec quatre joueurs, on garde ; moins de 15 s, on monte
 * cette valeur (pas la formule) ; plus de 3 min, on la baisse et on rouvre
 * `PALIER_HP_SCALE`.
 *
 * **Releve au banc `back/bench/boss.bench.ts`** (4 joueurs, palier 0, 8 graines
 * de carte, deux decors) :
 *
 * | Decor | Mediane | Min | Max |
 * | --- | --- | --- | --- |
 * | duel (boss seul, horde balayee, arme de base) | **70,1 s** | 70,1 | 70,1 |
 * | **melee (pipeline reel — LA PORTE)** | **86,9 s** | 46,0 | 126,5 |
 *
 * **VERDICT : 86,9 s, dans la bande 30-90 s -> ON GARDE.** L'issue etait
 * engagee avant la mesure et elle est appliquee telle quelle.
 *
 * ⚠️ **Le chiffre est HAUT dans sa bande, et il faut le dire.** 86,9 s laisse
 * 3 s de marge sous la borne de 90 : c'est le genre d'ecart que l'etape 5a a
 * refuse pour `HEAVY_WAVE_SHARE` (0,25 rejete a 1,2 point de sa borne). La
 * difference est qu'ici l'issue etait **ecrite d'avance** — la retoucher apres
 * avoir vu le nombre serait exactement ce que « engager les issues AVANT la
 * mesure » interdit. Si la verification manuelle (tache 12) trouve le combat
 * long, c'est cette constante qui baisse, pas la formule.
 *
 * ⚠️ **Le duel a 70,1 s est le PLANCHER, et il ne varie pas d'une graine a
 * l'autre** : sans horde il n'y a plus d'orbe, donc plus de montee de niveau,
 * donc l'arme de base seule — 6 000 / 70,1 = 85,6 degats/s, soit exactement
 * quatre dagues. C'est la validation du decor : le banc sait tuer un boss, et
 * son chiffre s'explique par un calcul independant. Les 6 000 PV du duel sont
 * ceux de QUATRE joueurs : depuis la tache 3 bis le banc les compose lui-meme
 * par `bossHp`, au lieu de lire cette constante et de mesurer un quart de boss.
 *
 * ⚠️ **Deux resultats a ne pas perdre, tires de ce meme banc :**
 * - une graine sur huit (0x88888888) ne tue **jamais** le boss en 300 s : la
 *   horde y atteint 950 entites de moyenne et absorbe tous les tirs. Ce n'est
 *   pas le boss qui est trop dur, c'est le decor qui sature ;
 * - avec des joueurs MORTELS et immobiles, la run est perdue avant la mort du
 *   boss sur **8 graines sur 8**. Le banc leur donne donc des points de vie
 *   d'office et le declare (voir `CARTES_DE_VITALITE`). Un vrai joueur se
 *   deplace ; **savoir ce que vaut ce combat pour une equipe qui bouge reste
 *   ouvert**, et c'est la tache 12 qui y repondra.
 *
 * ⚠️ **C'est un multiple de `HEAVY_HP`, ecrit comme tel.** Le §4 de la spec dit
 * *« plusieurs centaines de fois ceux de la pietaille lourde »* : ecrire le
 * produit garde ce rapport lisible, et le fait bouger tout seul le jour ou la
 * pietaille lourde est retouchee — c'est exactement ce que `LIGHT_HP` ne fait
 * PAS vis-a-vis de la dague, et ce qui a coute la marche de durabilite que
 * l'etape 0 de cette tache vient de solder. Le rapport annonce par la spec se
 * lit desormais sur `BOSS_HP_MULTIPLE * MAX_PLAYERS`, et un test le garde.
 */
export const BOSS_HP_MULTIPLE = 75;
export const BOSS_HP_PER_PLAYER = HEAVY_HP * BOSS_HP_MULTIPLE;

/**
 * Facteur de corps du boss — voir `Archetype.bodyScale`.
 *
 * ⚠️ **Le sien, pas celui de la pietaille.** `BODY_SCALE` vaut 1,25 et est
 * PLAFONNE par un test de `front/src/render/horde-renderer.test.ts` qui dit
 * qu'au-dela la hitbox ment plus que le rendu des projectiles ne la fait deja
 * mentir. Ce plafond garde la pietaille et continue de la garder : le boss ne
 * le releve pas.
 *
 * 3 : le corps de la pietaille est dessine a 80 px de diametre
 * (`2 x PROJECTILE_HIT_RADIUS x BODY_SCALE`) ; le boss est donc dessine a
 * 240 px. Le §4 de la spec ne demande rien de plus precis que *« nettement
 * plus grand »* — c'est un reglage de sensation, a juger a la tache 12.
 */
export const BOSS_BODY_SCALE = 3;

/**
 * La hitbox de tir du boss, en multiple de `PROJECTILE_HIT_RADIUS` : 3,75, soit
 * 120 px de rayon — la demi-boite DESSINEE du troll (`BODY_SCALE` 1,25 x
 * `BOSS_BODY_SCALE` 3, 240 px de diametre a l'ecran). Retour de playtest :
 * a 96 px la hitbox restait « trop petite » ; un tir qui touche le dessin, massue
 * comprise, doit toucher le boss. Voir `Archetype.hitScale`.
 */
export const BOSS_HIT_SCALE = 3.75;

/**
 * Plafond d'armure, applique a la LECTURE de la table (`capArmor`).
 *
 * ⚠️ **C'est le PLANCHER de degats, ecrit a l'envers.** Une armure de 1
 * rendrait les degats nuls, donc l'ennemi immortel — et un ennemi immortel se
 * lit comme un bug, jamais comme un reglage. A 0,9, un coup retire toujours au
 * moins un dixieme de son brut, quelle que soit la ligne de la table.
 *
 * ⚠️ **Au site de LECTURE, pas au site d'APPLICATION.** Un `Math.max` dans
 * `appliquerDegats` donnerait le meme resultat en jeu tout en laissant la
 * valeur aberrante vivre dans `ARCHETYPES` — visible nulle part, et fausse
 * partout ou quelqu'un lit la table plutot que de frapper (l'interface, un
 * banc, un futur ecran de bestiaire).
 *
 * ⚠️ **Aucune valeur de production ne l'atteint aujourd'hui**, et il faut le
 * dire : la mutation « la table cesse d'appeler `capArmor` » survit donc a
 * toute la suite. C'est `capArmor` lui-meme qui est teste, pas son usage —
 * meme franchise que le `slot < 0` de `resolveProjectileDamage`.
 */
export const MAX_ARMOR = 0.9;

/**
 * Armure de la pietaille lourde.
 *
 * ⚠️ **CE QUE CA COUTE, dit en face : la lourde ne meurt plus en quatre coups
 * de dague, mais en cinq.** 20 PV / (5 x 0,85) = 4,7. Le docbloc de `HEAVY_HP`
 * le dit desormais. L'armure est une AUGMENTATION de durabilite, pas une
 * redistribution : c'est ce qui donne quelque chose a mordre a la
 * Supraconduction (etape 5b, tache 7), dont l'effet est precisement de retirer
 * de l'armure. Une armure compensee par des PV en moins serait un no-op le
 * jour de sa naissance.
 *
 * ⚠️ **0,15 et pas davantage, et c'est `REACTION_DAMAGE` qui le decide.** Le
 * docbloc de cette constante (`shared/constants.ts`) engage une relation de
 * jeu : *« 25, c'est plus que `HEAVY_HP` (20), donc la reaction tue la
 * pietaille lourde d'un coup »*. L'armure s'applique AUSSI au Choc thermique
 * (il passe par `appliquerDegats` comme tout le reste), donc la relation
 * devient `REACTION_DAMAGE x (1 - HEAVY_ARMOR) > HEAVY_HP` : elle tient a 0,15
 * (21,25), se joue a la virgule pres a 0,20 (20,0 exactement) et TOMBE a 0,25
 * (18,75) — le Choc thermique cesserait alors de nettoyer la pietaille lourde,
 * en silence. `combat.test.ts` garde desormais la relation complete, et plus
 * la simple comparaison des deux constantes nues.
 */
export const HEAVY_ARMOR = 0.15;

/**
 * Armure du boss.
 *
 * ⚠️ **INVALIDE LA PORTE DU §7 DE L'ETAPE 6a, et ca ne doit pas passer en
 * silence.** Le releve du banc `boss.bench.ts` donnait 86,9 s pour tuer le
 * boss a quatre joueurs au palier 0, dans la bande engagee de 30-90 s. Une
 * armure de 0,4 multiplie sa durabilite effective par 1/(1-0,4) = 1,67 : le
 * meme combat demanderait ~145 s, hors bande. **Aucune valeur strictement
 * positive ne garde ce chiffre dans sa bande** — la porte etait deja haute
 * dedans (3 s de marge). Deux issues possibles, aucune tranchee ici :
 * remesurer et rouvrir la bande a la tache 12, ou compenser exactement en
 * ramenant `BOSS_HP_MULTIPLE` de 75 a 45 (45 / (1 - 0,4) = 75, entier), ce qui
 * preserverait la mesure au point pres mais ferait de l'armure du boss un
 * no-op le jour de sa naissance. Le choix appartient a la revue, pas a la
 * tache 1.
 *
 * ⚠️ **0,5 a ete EVITE volontairement.** A 0,5, `brut x (1 - armor)` et
 * `brut x armor` donnent le meme nombre : tout test d'arithmetique ecrit sur
 * le boss passerait avec la formule inversee. C'est exactement « le decor qui
 * masque », dix fois dans ce depot.
 */
export const BOSS_ARMOR = 0.4;

/**
 * Borne l'armure lue dans la table. Voir `MAX_ARMOR`.
 *
 * Exportee pour etre testee DIRECTEMENT : elle est le plancher de degats du
 * jeu entier, et une borne que seule la donnee actuelle rend inoffensive doit
 * etre gardee par un test qui, lui, lui donne une valeur aberrante.
 */
export function capArmor(raw: number): number {
  return Math.min(MAX_ARMOR, raw);
}

/**
 * Les ROLES de la horde (retour de playtest : *« il faudrait que les types de
 * monstres soient uniques — certains plus lents et plus tanky, moins
 * nombreux, des hordes de petits plus rapides »*). Un role fixe les PV,
 * l'armure, la taille de vague et le moment ou il apparait ; la VITESSE reste
 * propre a chaque archetype (`FOOTSOLDIERS`), dans la fourchette du role.
 *
 * - **nuee** : fragile et tres rapide, en grandes hordes ;
 * - **troupe** : la pietaille de reference (`LIGHT_HP`) ;
 * - **brute** : lente et blindee (`HEAVY_HP`, `HEAVY_ARMOR`), peu nombreuse ;
 * - **colosse** : tres lent, tres resistant, plus gros, quelques-uns par vague.
 *
 * ⚠️ **Troupe et brute gardent les valeurs d'avant** (5 et 20 PV) : le rythme
 * du debut de partie, mesure aux bancs, ne bouge presque pas ; ce sont la
 * nuee et le colosse qui elargissent l'eventail. Reglages de depart.
 */
export type Role = 'nuee' | 'troupe' | 'brute' | 'colosse';

/**
 * Les comportements (retour de playtest : *« des ennemis qui avancent par
 * bond », « des kamikazes », « un chaman »*). Chacun se DERIVE de ce que le
 * serveur et les clients calculent deja a l'identique — le tick, l'identite,
 * les morts annoncees — donc aucun ne coute un octet sur le fil.
 *
 * - `bond` : avance par bonds, une ruee puis une pause (`leapFactor`) ;
 * - `kamikaze` : explose a sa mort, et se fait exploser au contact ;
 * - `chaman` : les monstres dans son aura encaissent moitie moins ;
 * - `aucun` : marche droit vers sa cible.
 * - `porteur` : le porteur de coffre (etape 11) — attend loin de l'equipe,
 *   fuit le joueur le plus proche a `PORTEUR_FLEE_RADIUS`.
 */
export type Behavior =
  | 'aucun'
  | 'bond'
  | 'kamikaze'
  | 'chaman'
  | 'tir'
  | 'voleur'
  | 'diviseur'
  | 'bouclier'
  | 'necro'
  | 'gardien'
  | 'porteur';

/** La periode d'un bond, en ticks : une ruee puis une pause. */
export const LEAP_PERIOD_TICKS = 27;
/** La duree de la ruee, en ticks. */
export const LEAP_DASH_TICKS = 9;
/** La vitesse pendant la ruee, et pendant la pause, en part de la vitesse de l'archetype. */
export const LEAP_DASH_SPEED = 2.3;
export const LEAP_PAUSE_SPEED = 0.1;

/**
 * Le facteur de vitesse d'un bondisseur au tick `tick`. **Pur et deterministe**
 * : le tick absolu et l'identite, rien d'autre — le serveur et chaque client
 * le derivent a l'identique, et le rejeu le retrouve. Dephase par entite, pour
 * que la nuee ne bondisse pas d'un seul bloc.
 */
/**
 * Le tireur s'arrete a `SHOOTER_RANGE` du joueur (au lieu du contact) et tire
 * tous les `SHOOTER_PERIOD_TICKS`, phase par identite — voir `EnemyShots`.
 */
export const SHOOTER_RANGE = 300;
export const SHOOTER_PERIOD_TICKS = 54;
export const SHOT_SPEED = 260;
export const SHOT_LIFETIME_S = 1.6;
export const SHOT_RADIUS = 7;
export const SHOT_DAMAGE = 7;

/** Le voleur prend cette part de l'or non securise au contact, puis fuit. */
export const THIEF_STEAL_SHARE = 0.15;
/** Sa fuite va plus vite que sa course : il faut le rattraper. */
export const THIEF_FLEE_SPEED = 1.3;

/**
 * Le porteur de coffre (etape 11, §3.1 de la spec) : une elite d'UN
 * exemplaire, que le directeur demande une fois par palier et que le hasard
 * ne tire jamais (il n'est pas dans `STEP2_ARCHETYPES`). Un voleur agrandi,
 * avec SA regle de fuite (`Horde.retarget`) : il n'en partage que les textures.
 */
export const PORTEUR_NAME = 'porteur';
/** Ses PV, en multiple de `HEAVY_HP` comme le boss : 200 au palier 0, puis `palierHp`. */
export const PORTEUR_HP_MULTIPLE = 10;
export const PORTEUR_HP = HEAVY_HP * PORTEUR_HP_MULTIPLE;
/**
 * Il fuit si le joueur le plus proche — positions RETARDEES, celles du
 * flowfield — est a cette distance ou moins. Hors du rayon, il attend.
 *
 * ⚠️ **Le reglage du §8 de la spec** : la plupart des armes portent au-dela
 * de 400 px ; un tireur qui s'arrete a 450 px le crible pendant qu'il attend.
 * Si c'est trop facile au playtest, c'est ce nombre (ou les PV) qu'on monte.
 */
export const PORTEUR_FLEE_RADIUS = 400;
/** Sa vitesse en part de `PLAYER_SPEED` : un peu moins vite qu'un joueur. */
export const PORTEUR_SPEED_FACTOR = 0.9;
/**
 * Dessine 1,6 fois plus gros qu'un voleur ordinaire — et TOUCHE 1,6 fois plus
 * large : `shared/projectiles.ts` multiplie la hitbox par `bodyScale`.
 */
export const PORTEUR_BODY_SCALE = 1.6;

/** Le diviseur laisse ce nombre de petits a sa mort. */
export const SPLIT_COUNT = 3;
export const SPLIT_CHILD = 'spider';
/** Le porte-bouclier arrete cette part d'un tir qui le prend de face. */
export const SHIELD_BLOCK = 0.8;
/** Le necromancien releve les morts a ce rayon, au plus `NECRO_RAISE_MAX` toutes les `NECRO_COOLDOWN_TICKS`. */
export const NECRO_RADIUS = 220;
export const NECRO_RAISE_MAX = 3;
export const NECRO_COOLDOWN_TICKS = 60;
export const NECRO_CHILD = 'skull';
/**
 * Le gardien prend SA place sur un anneau autour de son joueur (angle tire de
 * son identite), puis la tient : a plusieurs, ils font un mur que le joueur ne
 * traverse pas (`pushOutOfGuards`).
 */
export const GUARD_RING_RADIUS = 95;
export const GUARD_BODY = 30;
/** Au-dela de cette distance de sa place, il suit le flowfield (le decor). */
export const GUARD_HOMING_RANGE = 260;

/** Le rayon de l'explosion d'un kamikaze, en px monde : c'est aussi le cercle d'alerte dessine. */
export const KAMIKAZE_RADIUS = 110;
/** Ce que l'explosion retire a un JOUEUR dans le rayon (avant son armure). */
export const KAMIKAZE_PLAYER_DAMAGE = 22;
/** Ce que l'explosion retire a un MONSTRE dans le rayon : elle ne distingue pas les camps. */
export const KAMIKAZE_MONSTER_DAMAGE = 30;
/** Le rayon de l'aura d'un chaman, en px monde. */
export const SHAMAN_AURA_RADIUS = 200;
/** La part des degats que l'aura retire, combinee a l'armure (1 - (1 - a)(1 - r)). */
export const SHAMAN_AURA_REDUCTION = 0.5;

export function leapFactor(entityId: number, tick: number): number {
  const phase = (entityId * 7) % LEAP_PERIOD_TICKS;
  return (tick + phase) % LEAP_PERIOD_TICKS < LEAP_DASH_TICKS ? LEAP_DASH_SPEED : LEAP_PAUSE_SPEED;
}

export interface RoleDef {
  hp: number;
  armor: number;
  /** Multiplie l'effectif tire pour la vague. */
  countFactor: number;
  /** Le corps (et la hitbox) par rapport a la pietaille. Voir `Archetype.bodyScale`. */
  bodyScale: number;
  /** Premiere vague (1-based) ou le role peut etre tire. */
  firstWave: number;
  /** Poids du role au tirage, une fois ouvert. */
  weight: number;
}

/** Les PV de la nuee : un coup de dague, comme la troupe, mais plus nombreuse et plus vive. */
export const SWARM_HP = 3;
/** Les PV du colosse : trois brutes. */
export const COLOSSUS_HP = 60;

export const ROLES: Readonly<Record<Role, RoleDef>> = {
  nuee: { hp: SWARM_HP, armor: 0, countFactor: 1.8, bodyScale: 1, firstWave: 1, weight: 0.35 },
  troupe: { hp: LIGHT_HP, armor: 0, countFactor: 1, bodyScale: 1, firstWave: 1, weight: 0.45 },
  brute: {
    hp: HEAVY_HP,
    armor: HEAVY_ARMOR,
    countFactor: 0.45,
    bodyScale: 1,
    firstWave: 6,
    weight: 0.2,
  },
  colosse: {
    hp: COLOSSUS_HP,
    armor: 0.3,
    countFactor: 0.15,
    bodyScale: 1.35,
    firstWave: 10,
    weight: 0.12,
  },
};

/** L'ordre fixe des roles, pour un tirage deterministe. */
export const ROLE_ORDER: readonly Role[] = ['nuee', 'troupe', 'brute', 'colosse'];

function hpOf(name: string, role: Role): number {
  if (name === PORTEUR_NAME) {
    return PORTEUR_HP;
  }
  return name === BOSS_NAME ? BOSS_HP_PER_PLAYER : ROLES[role].hp;
}

/** Le facteur de corps du role ; le boss et le porteur debordent davantage. Voir `Archetype.bodyScale`. */
function bodyScaleOf(name: string, role: Role): number {
  if (name === PORTEUR_NAME) {
    return PORTEUR_BODY_SCALE;
  }
  return name === BOSS_NAME ? BOSS_BODY_SCALE : ROLES[role].bodyScale;
}

/** L'armure du role ; celle du boss a part. Meme forme que `hpOf`. */
function armorOf(name: string, role: Role): number {
  return name === BOSS_NAME ? BOSS_ARMOR : ROLES[role].armor;
}

/**
 * Les cellules font toutes 192 px en pietaille : c'est ce qui permet un
 * rangement par etageres quasi optimal dans l'atlas (§9.2 de la spec).
 */
const FOOTSOLDIERS: readonly (Omit<
  Archetype,
  'id' | 'hp' | 'armor' | 'bodyScale' | 'hitScale' | 'countFactor' | 'behavior'
> & { behavior?: Behavior })[] = [
  { name: 'skull', sheet: 'Skull/Skull_Run.png', frames: 6, cell: 192, speed: 100, role: 'troupe' },
  {
    name: 'gnoll',
    sheet: 'Gnoll/Gnoll_Walk.png',
    frames: 8,
    cell: 192,
    speed: 78,
    role: 'brute',
    behavior: 'tir',
  },
  {
    name: 'spider',
    sheet: 'Spider/Spider_Run.png',
    frames: 5,
    cell: 192,
    speed: 145,
    role: 'nuee',
    behavior: 'bond',
  },
  {
    name: 'torch-goblin',
    sheet: 'Torch Goblin/Torch Goblin_Run.png',
    frames: 6,
    cell: 192,
    speed: 105,
    role: 'troupe',
    behavior: 'necro',
  },
  {
    name: 'lizard',
    sheet: 'Lizard/Lizard_Run.png',
    frames: 6,
    cell: 192,
    speed: 55,
    role: 'colosse',
    behavior: 'gardien',
  },
  {
    name: 'snake',
    sheet: 'Snake/Snake_Run.png',
    frames: 8,
    cell: 192,
    speed: 72,
    role: 'brute',
    behavior: 'diviseur',
  },
  { name: 'gnome', sheet: 'Gnome/Gnome_Run.png', frames: 6, cell: 192, speed: 135, role: 'nuee' },
  {
    name: 'slingshot-gnome',
    sheet: 'Slingshot Gnome/Slingshot Gnome_Run.png',
    frames: 6,
    cell: 192,
    speed: 95,
    role: 'troupe',
    behavior: 'tir',
  },
  {
    name: 'thief',
    sheet: 'Thief/Thief_Run.png',
    frames: 6,
    cell: 192,
    speed: 150,
    role: 'nuee',
    behavior: 'voleur',
  },
  {
    name: 'giant-bat',
    sheet: 'Giant Bat/Giant Bat_Move.png',
    frames: 4,
    cell: 192,
    speed: 160,
    role: 'nuee',
    behavior: 'bond',
  },
  {
    name: 'bomb-fish',
    sheet: 'Bomb Fish/Bomb Fish_Run.png',
    frames: 6,
    cell: 192,
    speed: 70,
    role: 'brute',
    behavior: 'kamikaze',
  },
  {
    name: 'hex-shaman',
    sheet: 'Hex Shaman/Hex Shaman_Run.png',
    frames: 4,
    cell: 192,
    speed: 50,
    role: 'colosse',
    behavior: 'chaman',
  },
  {
    name: 'paddle-shark',
    sheet: 'Paddle Shark/Paddle Shark_Run.png',
    frames: 6,
    cell: 192,
    speed: 100,
    role: 'troupe',
    behavior: 'bouclier',
  },
  {
    name: 'harpoon-shark',
    sheet: 'Harpoon Shark/Harpoon Shark_Run.png',
    frames: 6,
    cell: 192,
    speed: 80,
    role: 'brute',
    behavior: 'tir',
  },
];

/** Hors perimetre de l'etape 2 : regime de replication different (§3.3). */
const ELITES: readonly Omit<
  Archetype,
  'id' | 'hp' | 'armor' | 'bodyScale' | 'hitScale' | 'countFactor' | 'role' | 'behavior'
>[] = [
  {
    name: 'spear-goblin',
    sheet: 'Spear Goblin/Spear Goblin_Run.png',
    frames: 6,
    cell: 256,
    speed: 110,
  },
  { name: 'bear', sheet: 'Bear/Bear_Run.png', frames: 5, cell: 256, speed: 105 },
  { name: 'panda', sheet: 'Panda/Panda_Run.png', frames: 6, cell: 256, speed: 100 },
  { name: 'turtle', sheet: 'Turtle/Turtle_Walk.png', frames: 7, cell: 320, speed: 60 },
  { name: 'minotaur', sheet: 'Minotaur/Minotaur_Walk.png', frames: 8, cell: 320, speed: 80 },
  { name: 'troll', sheet: 'Troll/Troll_Walk.png', frames: 10, cell: 384, speed: 65 },
];

/**
 * Le porteur de coffre (etape 11) : la planche, le cycle et la cellule du
 * voleur (`thief`), sa vitesse a lui. Range APRES le troll, pour qu'aucun
 * identifiant existant ne bouge — le fil, l'atlas et les tests en dependent.
 */
const PORTEUR: Omit<Archetype, 'id' | 'hp' | 'armor' | 'bodyScale' | 'hitScale' | 'countFactor'> = {
  name: PORTEUR_NAME,
  sheet: 'Thief/Thief_Run.png',
  frames: 6,
  cell: 192,
  speed: Math.round(PLAYER_SPEED * PORTEUR_SPEED_FACTOR),
  role: 'troupe',
  behavior: 'porteur',
};

/** Nombre d'archetypes de pietaille. Les elites viennent apres, dans le tableau. */
export const FOOTSOLDIER_COUNT = FOOTSOLDIERS.length;

/**
 * ⚠️ **Les elites prennent `LIGHT_HP` faute de mieux — SAUF le boss.** Elles ne
 * sont recensees ici que pour que les ajouter soit du contenu (§3.3 de la spec
 * d'orientation) : le generateur ne les tire jamais. La promesse de ce
 * paragraphe — *« c'est l'etape 6 qui leur donnera une reserve digne d'un
 * boss »* — est tenue par `BOSS_NAME` a l'etape 6a, sur une seule d'entre
 * elles. Les cinq autres gardent leur placeholder de 5 PV, assume, jusqu'a
 * l'etape 6b et son pool tournant.
 */
export const ARCHETYPES: readonly Archetype[] = [
  ...FOOTSOLDIERS,
  // Les elites ne sont jamais tirees (le boss mis a part) : role neutre.
  ...ELITES.map((e) => ({ ...e, role: 'troupe' as Role })),
  // Etape 11 : le porteur, en DERNIER.
  PORTEUR,
].map((a, id) => ({
  ...a,
  id,
  hp: hpOf(a.name, a.role),
  armor: capArmor(armorOf(a.name, a.role)),
  bodyScale: bodyScaleOf(a.name, a.role),
  hitScale: a.name === BOSS_NAME ? BOSS_HIT_SCALE : bodyScaleOf(a.name, a.role),
  countFactor: ROLES[a.role].countFactor,
  behavior: ('behavior' in a ? (a.behavior as Behavior | undefined) : undefined) ?? 'aucun',
}));

/**
 * Les archetypes que le generateur tire : TOUTE la pietaille, chacun dans son
 * role (`ROLES`). Ce n'etait que quatre a l'etape 2 ; le playtest a demande
 * des monstres « uniques ».
 */
export const STEP2_ARCHETYPES: readonly number[] = Array.from(
  { length: FOOTSOLDIERS.length },
  (_, i) => i,
);

/**
 * Identifiant de l'archetype de boss, **derive du nom, jamais ecrit en
 * chiffre**.
 *
 * Un `19` en dur pointerait sur un autre monstre le jour ou un archetype est
 * insere avant lui — et le generateur ferait apparaitre une tortue a 6 000 PV
 * sans qu'un test ne bouge, puisque tout ce qui suit ne connait qu'un numero.
 */
export const BOSS_ARCHETYPE: number =
  ARCHETYPES.find((a) => a.name === BOSS_NAME)?.id ??
  (() => {
    throw new Error(`archetype de boss introuvable : ${BOSS_NAME}`);
  })();

export function archetypeOf(id: number): Archetype {
  const found = ARCHETYPES[id];
  if (!found) {
    throw new Error(`archetype inconnu : ${id}`);
  }
  return found;
}

/** L'identifiant d'un archetype par son nom (les petits du diviseur, du necromancien). */
export function archetypeIdOf(name: string): number {
  const id = ARCHETYPES.findIndex((a) => a.name === name);
  if (id < 0) {
    throw new Error(`archetype inconnu : ${name}`);
  }
  return id;
}

/**
 * Identifiant du porteur de coffre (etape 11), **derive du nom** comme
 * `BOSS_ARCHETYPE` : un `20` en dur pointerait sur un autre monstre le jour
 * ou un archetype serait insere avant lui.
 */
export const PORTEUR_ARCHETYPE: number = archetypeIdOf(PORTEUR_NAME);
