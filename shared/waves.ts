import { MAP_SIZE } from './constants';
import { makeRandom } from './random';

/**
 * Un ordre de vague : la seule chose que le serveur decide et diffuse pour la
 * horde. 19 octets sur le fil (18 de charge utile + 1 octet de type), une
 * fois par vague, contre ~150 ko/s si l'on repliquait les positions (§2.1 de
 * la spec de l'etape 2).
 */
export interface WaveOrder {
  waveId: number;
  spawnTick: number;
  seed: number;
  archetype: number;
  formation: number;
  anchorX: number;
  anchorY: number;
  count: number;
}

export const FORMATION = {
  SCATTER: 0,
  RING: 1,
  COLUMN: 2,
  CLUSTER: 3,
  ENCIRCLE: 4,
  POINT: 5,
} as const;

export type FormationId = (typeof FORMATION)[keyof typeof FORMATION];

/**
 * Rayon du cercle d'encerclement (tache 18 de l'etape 6a).
 *
 * ⚠️ **C'est une constante PARTAGEE, et c'est tout l'interet.** L'ordre de
 * vague fait 19 octets (18 de charge utile + 1 de type) et n'a pas de champ de
 * rayon ; lui en ajouter un couterait un octet ET romprait un nombre que trois
 * documents citent — c'est le livrable de l'etape 2. Une formation dont le
 * rayon est une constante lue des deux cotes du fil ne coute rien : le serveur
 * et chaque client appellent deja `formationPositions`.
 *
 * La valeur reprend celle de l'ancien `ANCHOR_RADIUS` du directeur (1800 px),
 * qui posait l'ancre a cette distance du joueur : la horde nait aussi loin
 * qu'avant, mais tout autour au lieu d'un seul cote.
 */
export const ENCIRCLE_RADIUS = 1800;

/**
 * Bruit sur le rayon d'encerclement, en pixels (±`ENCIRCLE_JITTER / 2`) : sans
 * lui, la vague nait sur un cercle parfait et arrive au contact toute en meme
 * temps, en un anneau d'un seul rang.
 */
const ENCIRCLE_JITTER = 240;

/**
 * Part du pas angulaire dont un secteur peut bouger. Strictement en dessous de
 * 1 : deux entites voisines ne peuvent pas echanger leur secteur, donc l'ecart
 * angulaire maximal reste borne — c'est ce qui distingue un ENCERCLEMENT d'un
 * anneau tire au hasard, ou rien n'interdit a toute la vague de tomber du meme
 * cote.
 */
const ENCIRCLE_ANGLE_JITTER = 0.8;

const SCATTER_RADIUS = 900;
const RING_RADIUS = 700;
const RING_JITTER = 90;
const COLUMN_LENGTH = 1400;
const COLUMN_WIDTH = 160;
const CLUSTER_COUNT = 5;
const CLUSTER_SPREAD = 800;
const CLUSTER_RADIUS = 170;
/** POINT : une poignee de petits nes sur place (diviseur, necromancien). */
const POINT_RADIUS = 40;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function clampInt(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Ce que `formationPositions` doit connaitre d'un champ pour eviter d'y faire
 * naitre une entite. Une interface structurelle plutot qu'un import du type
 * `FlowField` : n'importe quel objet qui porte ces quatre champs — un
 * `FlowField` en particulier, sans conversion — convient, et `shared/waves.ts`
 * n'a pas besoin de connaitre le reste de sa classe.
 */
export interface ObstacleField {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly blocked: Uint8Array;
}

/**
 * Decale, DETERMINISTIQUEMENT, une position tombee dans une cellule muree vers
 * la cellule libre la plus proche — tache 18.
 *
 * ⚠️ Jamais un tirage, jamais une boucle dont le nombre d'iterations pourrait
 * differer d'un cote a l'autre (§ contraintes de determinisme de `shared/`) :
 * l'expansion se fait en anneaux carres de rayon croissant, dans un ordre de
 * balayage FIXE (lignes du haut vers le bas, colonnes de gauche a droite dans
 * chaque ligne). Meme masque, meme position de depart => meme resultat, sur
 * le serveur comme sur chaque client.
 *
 * Ecrit directement dans `outX`/`outY` : cette fonction ne s'execute qu'a
 * l'apparition d'une vague, jamais par tick, mais un objet ou un tableau
 * intermediaire par entite reste un gaspillage evitable pour zero benefice.
 */
export function nudgeOutOfObstacle(
  obstacles: ObstacleField,
  x: number,
  y: number,
  outX: Float32Array,
  outY: Float32Array,
  i: number,
): void {
  const { cols, rows, cellSize, blocked } = obstacles;
  const cx = clampInt(Math.floor(x / cellSize), 0, cols - 1);
  const cy = clampInt(Math.floor(y / cellSize), 0, rows - 1);

  if (blocked[cy * cols + cx] !== 1) {
    outX[i] = x;
    outY[i] = y;
    return;
  }

  const maxRadius = Math.max(cols, rows);
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      const ny = cy + dy;
      if (ny < 0 || ny >= rows) {
        continue;
      }
      // Seul le CONTOUR de l'anneau de rayon r nous interesse : l'interieur a
      // deja ete balaye par les rayons plus petits.
      const onHorizontalEdge = Math.abs(dy) === r;
      for (let dx = -r; dx <= r; dx++) {
        if (!onHorizontalEdge && Math.abs(dx) !== r) {
          continue;
        }
        const nx = cx + dx;
        if (nx < 0 || nx >= cols) {
          continue;
        }
        if (blocked[ny * cols + nx] === 0) {
          outX[i] = (nx + 0.5) * cellSize;
          outY[i] = (ny + 0.5) * cellSize;
          return;
        }
      }
    }
  }

  // Carte entierement muree : cas degenere qui ne devrait jamais survenir en
  // pratique (BLOCKED_RATIO = 0.06, voir shared/worldmap.ts). On degrade sans
  // planter plutot que de boucler indefiniment ou de lever une exception.
  outX[i] = x;
  outY[i] = y;
}

/**
 * Remplit `outX` / `outY` avec les positions d'apparition de la vague.
 *
 * Fonction pure de `(seed, count, formation, ancre)` : c'est elle qui garantit
 * que deux clients font apparaitre la meme vague au meme endroit sans qu'un
 * seul octet de position ne transite.
 *
 * `obstacles`, si fourni, evite de faire naitre une entite en plein mur (tache
 * 18) : 185 des 489 entites d'une horde mesuree y naissaient directement,
 * faute de ce controle — `retarget`/`step` ne les en sortaient jamais, puisqu'une
 * cellule muree ne portait alors aucune direction (voir `shared/flowfield.ts`).
 */
export function formationPositions(
  order: WaveOrder,
  outX: Float32Array,
  outY: Float32Array,
  obstacles?: ObstacleField,
): void {
  const rng = makeRandom(order.seed);
  const { count, anchorX, anchorY } = order;

  // Precalcul des parametres constants selon la formation
  let heading = 0;
  const clusterCentres: Array<{ cx: number; cy: number }> = [];

  if (order.formation === FORMATION.COLUMN) {
    // L'orientation vient de la graine : deux vagues successives au meme
    // endroit ne se superposent pas.
    heading = makeRandom(order.seed ^ 0x5f37_1d2b)() * Math.PI * 2;
  } else if (order.formation === FORMATION.CLUSTER) {
    // Grappes denses : c'est ce qui fabrique la sensation de masse (§4.1),
    // pas le compteur. Precalcul des centres pour eviter de recreer le generateur
    // a chaque iteration.
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      const clusterRng = makeRandom(order.seed + c * 0x9e37_79b9);
      const cx = (clusterRng() - 0.5) * CLUSTER_SPREAD;
      const cy = (clusterRng() - 0.5) * CLUSTER_SPREAD;
      clusterCentres.push({ cx, cy });
    }
  }

  for (let i = 0; i < count; i++) {
    let dx = 0;
    let dy = 0;

    switch (order.formation) {
      case FORMATION.ENCIRCLE: {
        // ⚠️ **L'ancre est ICI la position du joueur**, pas un point de cote :
        // c'est le directeur qui le garantit (voir `WaveDirector.due`). La
        // vague nait donc tout autour de lui, a `ENCIRCLE_RADIUS`.
        //
        // Les secteurs sont REGULIERS, pas tires : `count` entites se
        // partagent le tour, chacune dans son secteur, avec un bruit borne a
        // une fraction du pas. Un angle tire uniformement (ce que fait RING)
        // laisserait, a 14 entites, une chance tres reelle que la vague entiere
        // tombe du meme cote — c'est-a-dire le pack qu'on cherche a supprimer.
        const step = (Math.PI * 2) / Math.max(1, count);
        const angle = i * step + (rng() - 0.5) * step * ENCIRCLE_ANGLE_JITTER;
        const radius = ENCIRCLE_RADIUS + (rng() - 0.5) * ENCIRCLE_JITTER;
        dx = Math.cos(angle) * radius;
        dy = Math.sin(angle) * radius;
        break;
      }
      case FORMATION.RING: {
        const angle = rng() * Math.PI * 2;
        const radius = RING_RADIUS + (rng() - 0.5) * RING_JITTER;
        dx = Math.cos(angle) * radius;
        dy = Math.sin(angle) * radius;
        break;
      }
      case FORMATION.COLUMN: {
        const along = (rng() - 0.5) * COLUMN_LENGTH;
        const across = (rng() - 0.5) * COLUMN_WIDTH;
        dx = Math.cos(heading) * along - Math.sin(heading) * across;
        dy = Math.sin(heading) * along + Math.cos(heading) * across;
        break;
      }
      case FORMATION.POINT: {
        const angle = rng() * Math.PI * 2;
        const radius = Math.sqrt(rng()) * POINT_RADIUS;
        dx = Math.cos(angle) * radius;
        dy = Math.sin(angle) * radius;
        break;
      }
      case FORMATION.CLUSTER: {
        const cluster = i % CLUSTER_COUNT;
        const centre = clusterCentres[cluster];
        if (centre) {
          const { cx, cy } = centre;
          const angle = rng() * Math.PI * 2;
          const radius = Math.sqrt(rng()) * CLUSTER_RADIUS;
          dx = cx + Math.cos(angle) * radius;
          dy = cy + Math.sin(angle) * radius;
        }
        break;
      }
      default: {
        // SCATTER. `sqrt` donne une densite uniforme dans le disque ; sans lui
        // tout s'agglutine au centre.
        const angle = rng() * Math.PI * 2;
        const radius = Math.sqrt(rng()) * SCATTER_RADIUS;
        dx = Math.cos(angle) * radius;
        dy = Math.sin(angle) * radius;
        break;
      }
    }

    const px = clamp(anchorX + dx, 0, MAP_SIZE);
    const py = clamp(anchorY + dy, 0, MAP_SIZE);

    if (obstacles) {
      nudgeOutOfObstacle(obstacles, px, py, outX, outY, i);
    } else {
      outX[i] = px;
      outY[i] = py;
    }
  }
}
