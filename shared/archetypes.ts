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
}

/**
 * Les cellules font toutes 192 px en pietaille : c'est ce qui permet un
 * rangement par etageres quasi optimal dans l'atlas (§9.2 de la spec).
 */
const PIETAILLE: readonly Omit<Archetype, 'id'>[] = [
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
const ELITES: readonly Omit<Archetype, 'id'>[] = [
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
export const PIETAILLE_COUNT = PIETAILLE.length;

export const ARCHETYPES: readonly Archetype[] = [...PIETAILLE, ...ELITES].map((a, id) => ({
  ...a,
  id,
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
