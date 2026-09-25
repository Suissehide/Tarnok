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
 * Les quatre archetypes de pietaille lourde, par nom.
 *
 * **Le choix est du contenu, pas un role** : ce sont les quatre pietailles les
 * plus LENTES du pack (80 a 90 px/s), parce que « lourd et lent » se lit sans
 * explication a l'ecran — la vitesse est le seul autre attribut visible.
 *
 * ⚠️ **`gnoll` est dans `STEP2_ARCHETYPES`, et ce n'est pas un hasard.** Le
 * generateur de vagues ne tire que dans ces quatre-la : une pietaille lourde
 * qui n'y figurerait pas n'apparaitrait JAMAIS, la porte du §3.3 mesurerait un
 * rythme de mise a mort inchange, et la mesure ne prouverait rien. Un test
 * garde cette intersection.
 */
const HEAVY_NAMES: readonly string[] = ['gnoll', 'snake', 'bomb-fish', 'hex-shaman'];

function hpOf(name: string): number {
  if (name === BOSS_NAME) {
    return BOSS_HP_PER_PLAYER;
  }
  return HEAVY_NAMES.includes(name) ? HEAVY_HP : LIGHT_HP;
}

/** `1` pour tout le monde : seul le boss deborde sa hitbox. Voir `Archetype.bodyScale`. */
function bodyScaleOf(name: string): number {
  return name === BOSS_NAME ? BOSS_BODY_SCALE : 1;
}

/**
 * `0` pour la pietaille legere, `HEAVY_ARMOR` pour les quatre lourdes,
 * `BOSS_ARMOR` pour le boss. Meme forme que `hpOf` : l'armure suit la meme
 * partition du bestiaire que les points de vie, et la faire suivre une autre
 * demanderait une seconde liste de noms a tenir synchronisee.
 *
 * ⚠️ **Les cinq elites hors boss prennent `0`**, comme elles prennent
 * `LIGHT_HP` : le generateur ne les tire jamais (voir `ELITES`), et leur
 * donner une armure inventee serait un chiffre que personne ne peut mesurer.
 */
function armorOf(name: string): number {
  if (name === BOSS_NAME) {
    return BOSS_ARMOR;
  }
  return HEAVY_NAMES.includes(name) ? HEAVY_ARMOR : 0;
}

/**
 * Les cellules font toutes 192 px en pietaille : c'est ce qui permet un
 * rangement par etageres quasi optimal dans l'atlas (§9.2 de la spec).
 */
const FOOTSOLDIERS: readonly Omit<Archetype, 'id' | 'hp' | 'armor' | 'bodyScale'>[] = [
  { name: 'skull', sheet: 'Skull/Skull_Run.png', frames: 6, cell: 192, speed: 95 },
  { name: 'gnoll', sheet: 'Gnoll/Gnoll_Walk.png', frames: 8, cell: 192, speed: 85 },
  { name: 'spider', sheet: 'Spider/Spider_Run.png', frames: 5, cell: 192, speed: 115 },
  {
    name: 'torch-goblin',
    sheet: 'Torch Goblin/Torch Goblin_Run.png',
    frames: 6,
    cell: 192,
    speed: 100,
  },
  { name: 'lizard', sheet: 'Lizard/Lizard_Run.png', frames: 6, cell: 192, speed: 105 },
  { name: 'snake', sheet: 'Snake/Snake_Run.png', frames: 8, cell: 192, speed: 90 },
  { name: 'gnome', sheet: 'Gnome/Gnome_Run.png', frames: 6, cell: 192, speed: 95 },
  {
    name: 'slingshot-gnome',
    sheet: 'Slingshot Gnome/Slingshot Gnome_Run.png',
    frames: 6,
    cell: 192,
    speed: 90,
  },
  { name: 'thief', sheet: 'Thief/Thief_Run.png', frames: 6, cell: 192, speed: 120 },
  { name: 'giant-bat', sheet: 'Giant Bat/Giant Bat_Move.png', frames: 4, cell: 192, speed: 130 },
  { name: 'bomb-fish', sheet: 'Bomb Fish/Bomb Fish_Run.png', frames: 6, cell: 192, speed: 80 },
  { name: 'hex-shaman', sheet: 'Hex Shaman/Hex Shaman_Run.png', frames: 4, cell: 192, speed: 85 },
  {
    name: 'paddle-shark',
    sheet: 'Paddle Shark/Paddle Shark_Run.png',
    frames: 6,
    cell: 192,
    speed: 100,
  },
  {
    name: 'harpoon-shark',
    sheet: 'Harpoon Shark/Harpoon Shark_Run.png',
    frames: 6,
    cell: 192,
    speed: 95,
  },
];

/** Hors perimetre de l'etape 2 : regime de replication different (§3.3). */
const ELITES: readonly Omit<Archetype, 'id' | 'hp' | 'armor' | 'bodyScale'>[] = [
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
export const ARCHETYPES: readonly Archetype[] = [...FOOTSOLDIERS, ...ELITES].map((a, id) => ({
  ...a,
  id,
  hp: hpOf(a.name),
  armor: capArmor(armorOf(a.name)),
  bodyScale: bodyScaleOf(a.name),
}));

/** Les quatre cables a l'etape 2, choisis pour leurs silhouettes distinctes. */
export const STEP2_ARCHETYPES = [0, 1, 2, 3] as const;

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
