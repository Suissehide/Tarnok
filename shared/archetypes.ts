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
 * PV de la pietaille lourde : quatre coups de dague.
 *
 * Un ennemi qui meurt en un coup ne porte jamais d'element assez longtemps
 * pour reagir (§3.3) : il faut donc que la reserve VARIE par archetype, et
 * c'est la premiere fois que choisir un archetype veut dire autre chose qu'un
 * sprite et une vitesse.
 */
export const HEAVY_HP = 20;

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
  return HEAVY_NAMES.includes(name) ? HEAVY_HP : LIGHT_HP;
}

/**
 * Les cellules font toutes 192 px en pietaille : c'est ce qui permet un
 * rangement par etageres quasi optimal dans l'atlas (§9.2 de la spec).
 */
const FOOTSOLDIERS: readonly Omit<Archetype, 'id' | 'hp'>[] = [
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
const ELITES: readonly Omit<Archetype, 'id' | 'hp'>[] = [
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
 * ⚠️ **Les elites prennent `LIGHT_HP` faute de mieux.** Elles ne sont
 * recensees ici que pour que les ajouter soit du contenu (§3.3 de la spec
 * d'orientation) : le generateur ne les tire jamais, et c'est l'etape 6 qui
 * leur donnera une reserve digne d'un boss. Leur laisser 5 PV est un
 * placeholder assume, pas un reglage.
 */
export const ARCHETYPES: readonly Archetype[] = [...FOOTSOLDIERS, ...ELITES].map((a, id) => ({
  ...a,
  id,
  hp: hpOf(a.name),
}));

/** Les quatre cables a l'etape 2, choisis pour leurs silhouettes distinctes. */
export const STEP2_ARCHETYPES = [0, 1, 2, 3] as const;

export function archetypeOf(id: number): Archetype {
  const found = ARCHETYPES[id];
  if (!found) {
    throw new Error(`archetype inconnu : ${id}`);
  }
  return found;
}
