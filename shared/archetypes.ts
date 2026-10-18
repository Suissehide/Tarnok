import { PLAYER_SPEED } from './constants';

/**
 * Le bestiaire, et son regime de replication.
 *
 * La taille des sprites du pack tombe pile sur la distinction : les 192 px
 * n'ont qu'un `Walk`, les gros ont `Windup` / `Attack` / `Recovery`, ce qui
 * est un vocabulaire de boss.
 *
 * - **Pietaille** (192 px) : repliquee par le generateur, rendue en batch.
 * - **Elite** (256 px et plus) : recensee ici pour que l'ajouter soit du
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
   * Reserve de points de vie de depart.
   *
   * **Les deux cotes derivent la meme valeur sans un octet de plus** :
   * l'archetype voyage deja dans l'ordre de vague. Seul le serveur soustrait
   * les degats — le client apprend qui meurt par `DEATHS`.
   */
  hp: number;
  /**
   * Fraction des degats recus que l'armure absorbe, de 0 a
   * `MAX_ARMOR` — un coup de `brut` retire `brut x (1 - armor)`.
   *
   * ⚠️ **Zero est une entree de la table, pas un cas particulier.** Toute la
   * pietaille legere porte `0`, et elle passe par exactement le meme calcul
   * que le boss : aucun site d'application n'a de branche `if (armor > 0)`.
   *
   * ⚠️ **Lue au SEUL endroit ou un ennemi perd des PV** (`appliquerDegats`,
   * back/src/combat.ts) : deux formules d'armure divergeraient.
   *
   * ⚠️ **Bornee a la LECTURE de la table, par `capArmor`** — voir `MAX_ARMOR`.
   *
   * Ne voyage pas : seul le serveur soustrait des degats.
   */
  armor: number;
  /**
   * De combien le CORPS dessine deborde la hitbox de tir, **pour cet
   * archetype** — `1` pour la plupart, davantage pour le boss, le colosse et
   * le porteur.
   *
   * ⚠️ **Ce n'est PAS `BODY_SCALE`, et les deux se multiplient.**
   * `front/src/render/horde-renderer.ts` porte un facteur COMMUN
   * (`BODY_SCALE = 1,25`), plafonne par un test : au-dela, la hitbox mentirait
   * trop. Un archetype plus gros apporte SON facteur au lieu de relever le
   * plafond commun.
   *
   * ⚠️ **Rendu** : l'atlas de `tools/` n'embarque que la pietaille et le
   * troll ; ranger les six elites le sature (voir
   * `tools/build_monster_atlas.py`), et `HordeRenderer.draw` saute en silence
   * un archetype sans textures. `SOURCES` porte des trous explicites pour que
   * son index reste l'identifiant d'archetype, et `HordeRenderer.adoptAtlas`
   * lit l'`id` du manifeste, jamais la position. Faire tourner un pool
   * d'elites demandera de rouvrir `ATLAS_SIZE`.
   */
  bodyScale: number;
  /**
   * La hitbox de tir par rapport a celle de la pietaille
   * (`PROJECTILE_HIT_RADIUS x hitScale`) — egale a `bodyScale`, sauf pour le
   * boss (`BOSS_HIT_SCALE`).
   *
   * La touche du boss couvre le dessin entier, massue comprise : un tir qui
   * touche visiblement le troll doit le toucher.
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
 * arme 0) : elle meurt en un coup. Voir `palierHp` (`shared/paliers.ts`) pour
 * le piege d'arrondi que cette egalite cree.
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
 * pour reagir : il faut donc que la reserve VARIE par archetype.
 */
export const HEAVY_HP = 20;

/**
 * Nom de l'archetype de boss : le troll, la plus grosse cellule du pack
 * (384 px) et la plus LENTE (65 px/s). « Lourd et lent », pousse a son terme.
 */
const BOSS_NAME = 'troll';

/**
 * PV du boss au palier 0 **et pour UN joueur** — avant `hpScale` et avant la
 * multiplication par le nombre de joueurs, toutes deux faites par `bossHp`
 * (`shared/paliers.ts`).
 *
 * ⚠️ **PAR JOUEUR, et le nom le dit** : meme forme que le seuil d'experience
 * (`LEVEL_XP_BASE * niveau * joueurs`), donc cette constante est la part d'UN
 * joueur, celle qui se multiplie. A quatre joueurs, le boss vaut 300 fois la
 * pietaille lourde (6 000 PV) ; en solo, 75 fois.
 *
 * Reglee au banc `back/bench/boss.bench.ts` (4 joueurs, palier 0) : le combat
 * doit durer entre 30 et 90 s. La mesure tombe haut dans la bande ; si le
 * combat parait long en jeu, c'est cette constante qui baisse, pas la
 * formule. Le banc donne des PV d'office a ses joueurs immobiles
 * (`CARTES_DE_VITALITE`) : ce que vaut ce combat pour une equipe qui bouge
 * reste a juger en jeu.
 *
 * ⚠️ **C'est un multiple de `HEAVY_HP`, ecrit comme tel**, pour que le
 * rapport suive la pietaille lourde si elle change. Un test garde
 * `BOSS_HP_MULTIPLE * MAX_PLAYERS`.
 */
export const BOSS_HP_MULTIPLE = 75;
export const BOSS_HP_PER_PLAYER = HEAVY_HP * BOSS_HP_MULTIPLE;

/**
 * Facteur de corps du boss — voir `Archetype.bodyScale`.
 *
 * 3 : le corps de la pietaille est dessine a 80 px de diametre
 * (`2 x PROJECTILE_HIT_RADIUS x BODY_SCALE`), le boss a 240 px. Reglage de
 * sensation : il doit etre nettement plus grand que la pietaille.
 */
export const BOSS_BODY_SCALE = 3;

/**
 * La hitbox de tir du boss, en multiple de `PROJECTILE_HIT_RADIUS` : 3,75, soit
 * 120 px de rayon — la demi-boite DESSINEE du troll (`BODY_SCALE` 1,25 x
 * `BOSS_BODY_SCALE` 3, 240 px de diametre a l'ecran). Voir
 * `Archetype.hitScale`.
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
 * ⚠️ **Au site de LECTURE, pas au site d'APPLICATION** : une valeur
 * aberrante ne doit pas vivre dans `ARCHETYPES`, ou d'autres la liraient
 * (interface, banc).
 *
 * Aucune valeur de production ne l'atteint : c'est `capArmor` lui-meme qui
 * est teste, pas son usage.
 */
export const MAX_ARMOR = 0.9;

/**
 * Armure de la pietaille lourde.
 *
 * Une AUGMENTATION de durabilite (cinq coups de dague au lieu de quatre) :
 * c'est ce qui donne quelque chose a mordre a la Supraconduction.
 *
 * ⚠️ **0,15 et pas davantage, a cause de `REACTION_DAMAGE`.** La relation
 * `REACTION_DAMAGE x (1 - HEAVY_ARMOR) > HEAVY_HP` doit tenir pour que le Choc
 * thermique tue la pietaille lourde d'un coup : elle tient a 0,15, se joue a
 * la virgule a 0,20 et tombe a 0,25. `combat.test.ts` la garde.
 */
export const HEAVY_ARMOR = 0.15;

/**
 * Armure du boss.
 *
 * ⚠️ **Elle multiplie la durabilite effective du boss par 1/(1-0,4) = 1,67**,
 * ce qui le sort de la bande de 30-90 s mesuree par `boss.bench.ts` (voir
 * `BOSS_HP_MULTIPLE`). Deux issues ouvertes : remesurer et rouvrir la bande,
 * ou ramener `BOSS_HP_MULTIPLE` a 45 (45 / (1 - 0,4) = 75), ce qui ferait de
 * l'armure un no-op.
 *
 * ⚠️ **0,5 a ete EVITE volontairement.** A 0,5, `brut x (1 - armor)` et
 * `brut x armor` donnent le meme nombre : tout test d'arithmetique ecrit sur
 * le boss passerait avec la formule inversee.
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
 * Les ROLES de la horde, pour que chaque type de monstre soit unique. Un role
 * fixe les PV, l'armure, la taille de vague et le moment ou il apparait ; la
 * VITESSE reste propre a chaque archetype (`FOOTSOLDIERS`), dans la
 * fourchette du role.
 *
 * - **nuee** : fragile et tres rapide, en grandes hordes ;
 * - **troupe** : la pietaille de reference (`LIGHT_HP`) ;
 * - **brute** : lente et blindee (`HEAVY_HP`, `HEAVY_ARMOR`), peu nombreuse ;
 * - **colosse** : tres lent, tres resistant, plus gros, quelques-uns par vague.
 *
 * Troupe et brute portent `LIGHT_HP` et `HEAVY_HP` ; nuee et colosse
 * elargissent l'eventail. Reglages de depart.
 */
export type Role = 'nuee' | 'troupe' | 'brute' | 'colosse';

/**
 * Les comportements. Chacun se DERIVE de ce que le
 * serveur et les clients calculent deja a l'identique — le tick, l'identite,
 * les morts annoncees — donc aucun ne coute un octet sur le fil.
 *
 * - `bond` : avance par bonds, une ruee puis une pause (`leapFactor`) ;
 * - `kamikaze` : explose a sa mort, et se fait exploser au contact ;
 * - `chaman` : les monstres dans son aura encaissent moitie moins ;
 * - `aucun` : marche droit vers sa cible.
 * - `porteur` : le porteur de coffre — attend loin de l'equipe,
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
 * Le porteur de coffre : une elite d'UN
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
 * ⚠️ **Le reglage de difficulte du porteur** : la plupart des armes portent
 * au-dela de 400 px ; un tireur qui s'arrete a 450 px le crible pendant qu'il
 * attend.
 * Si c'est trop facile au playtest, c'est ce nombre (ou les PV) qu'on monte.
 */
export const PORTEUR_FLEE_RADIUS = 400;
/** Sa vitesse en part de `PLAYER_SPEED` : un peu moins vite qu'un joueur. */
export const PORTEUR_SPEED_FACTOR = 0.9;
/**
 * Dessine 1,6 fois plus gros qu'un voleur ordinaire — et TOUCHE 1,6 fois plus
 * large : hors boss, `hitScale` vaut `bodyScale`.
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

/**
 * Le facteur de vitesse d'un bondisseur au tick `tick`. **Pur et deterministe**
 * : le tick absolu et l'identite, rien d'autre — le serveur et chaque client
 * le derivent a l'identique, et le rejeu le retrouve. Dephase par entite, pour
 * que la nuee ne bondisse pas d'un seul bloc.
 */
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
 * rangement par etageres quasi optimal dans l'atlas.
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

/** Les elites : jamais tirees par le generateur, sauf le boss. */
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
 * Le porteur de coffre : la planche, le cycle et la cellule du
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
 * ⚠️ **Les elites prennent `LIGHT_HP` faute de mieux — SAUF le boss.** Le
 * generateur ne les tire jamais : elles ne sont recensees que pour que les
 * ajouter soit du contenu.
 */
export const ARCHETYPES: readonly Archetype[] = [
  ...FOOTSOLDIERS,
  // Les elites ne sont jamais tirees (le boss mis a part) : role neutre.
  ...ELITES.map((e) => ({ ...e, role: 'troupe' as Role })),
  // Le porteur, en DERNIER.
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
 * role (`ROLES`).
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
 * insere avant lui, sans qu'un test ne bouge.
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
 * Identifiant du porteur de coffre, **derive du nom** comme
 * `BOSS_ARCHETYPE` : un `20` en dur pointerait sur un autre monstre le jour
 * ou un archetype serait insere avant lui.
 */
export const PORTEUR_ARCHETYPE: number = archetypeIdOf(PORTEUR_NAME);
