import type { FlowField } from './flowfield';
import { makeRandom } from './random';

/**
 * La carte : une ile d'herbe dans l'eau, quelques plateaux a falaises, des
 * bosquets, des rochers et des buissons — regeneree a l'identique de chaque
 * cote depuis `mapSeed`.
 *
 * Le client **regenere** la carte depuis la graine, il ne la recoit pas : une
 * carte de 6000 px a 64 px par cellule fait 8836 cellules, et les envoyer
 * couterait plus cher que tout le reste du protocole reuni.
 *
 * Le champ de flux ne concorde entre serveur et client que si les deux murent
 * exactement les memes cellules — c'est la condition du §5.1 de la spec. Et
 * depuis la carte en tuiles, les JOUEURS aussi butent sur ces cellules
 * (`moveOnMap`) : le serveur et la prediction doivent lire le meme masque.
 *
 * ⚠️ **L'ordre des tirages EST la carte.** Toute etape ajoutee ou deplacee
 * change toutes les cartes ; les deux cotes executent ce meme code, donc
 * rien ne diverge, mais une graine ne designe plus la meme ile.
 */

/** Le sol d'une cellule. Une cellule de falaise est le pied d'un plateau. */
export const TERRAIN = { WATER: 0, GRASS: 1, PLATEAU: 2, CLIFF: 3 } as const;

/** Ce qui pousse dessus. Arbres et rochers bloquent, les buissons non. */
export const DECO = { NONE: 0, TREE: 1, ROCK: 2, BUSH: 3 } as const;

export interface WorldMap {
  cols: number;
  rows: number;
  terrain: Uint8Array;
  deco: Uint8Array;
  /** 1 = infranchissable, pour la horde (champ de flux) comme pour les joueurs. */
  blocked: Uint8Array;
}

/** Rayon, en cellules, de la zone laissee libre au centre. */
const SPAWN_CLEARANCE = 4;

/** Toujours au moins `COAST_MIN` cellules d'eau au bord de la carte. */
const COAST_MIN = 3;
/**
 * Le rivage : un carre arrondi (super-ellipse d'exposant 4) de rayon
 * `COAST_RADIUS` en part de la demi-carte, ronge par le bruit jusqu'a
 * `COAST_NOISE` de plus. Plus de bruit, des baies plus profondes.
 */
const COAST_RADIUS = 0.92;
const COAST_NOISE = 0.24;
/** Pas du bruit du rivage, en cellules : plus grand, des caps plus larges. */
const COAST_LATTICE = 7;

const PLATEAU_TRIES = 60;
const PLATEAU_MAX = 6;
const TREE_CLUSTERS = 14;
const TREES_PER_CLUSTER = 10;
const ROCKS = 36;
const BUSHES = 160;

export function generateWorld(mapSeed: number, cols: number, rows: number): WorldMap {
  const rng = makeRandom(mapSeed);
  const n = cols * rows;
  const terrain = new Uint8Array(n);
  const deco = new Uint8Array(n);
  const centreX = Math.floor(cols / 2);
  const centreY = Math.floor(rows / 2);
  const at = (cx: number, cy: number): number => cy * cols + cx;
  const inside = (cx: number, cy: number): boolean => cx >= 0 && cy >= 0 && cx < cols && cy < rows;
  const nearSpawn = (cx: number, cy: number, margin: number): boolean =>
    Math.abs(cx - centreX) <= SPAWN_CLEARANCE + margin &&
    Math.abs(cy - centreY) <= SPAWN_CLEARANCE + margin;

  // 1. Le rivage : un bruit de valeur grossier (un tirage par noeud du
  // reseau, TOUS tires, dans l'ordre), interpole, decide de la largeur d'eau.
  const lcols = Math.ceil(cols / COAST_LATTICE) + 1;
  const lrows = Math.ceil(rows / COAST_LATTICE) + 1;
  const lattice = Array.from({ length: lcols * lrows }, () => rng());
  const noise = (cx: number, cy: number): number => {
    const fx = cx / COAST_LATTICE;
    const fy = cy / COAST_LATTICE;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const v = (x: number, y: number): number => lattice[y * lcols + x] ?? 0;
    const top = v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx;
    const bottom = v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  };
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const edge = Math.min(cx, cy, cols - 1 - cx, rows - 1 - cy);
      const nx = Math.abs(cx - centreX) / (cols / 2);
      const ny = Math.abs(cy - centreY) / (rows / 2);
      const r = (nx ** 4 + ny ** 4) ** 0.25;
      const water = edge < COAST_MIN || r > COAST_RADIUS - noise(cx, cy) * COAST_NOISE;
      terrain[at(cx, cy)] = water ? TERRAIN.WATER : TERRAIN.GRASS;
    }
  }

  // 2. Les plateaux : un dessus de `w x h`, et une rangee de falaise dessous.
  // Entoures de deux cellules d'herbe libre, loin du centre : jamais colles
  // a l'eau ni entre eux, donc jamais de poche fermee entre deux falaises.
  let plateaux = 0;
  for (let t = 0; t < PLATEAU_TRIES; t++) {
    const w = 3 + Math.floor(rng() * 4);
    const h = 2 + Math.floor(rng() * 3);
    const x0 = Math.floor(rng() * cols);
    const y0 = Math.floor(rng() * rows);
    if (plateaux >= PLATEAU_MAX) {
      continue;
    }
    let ok = true;
    for (let cy = y0 - 2; cy <= y0 + h + 2 && ok; cy++) {
      for (let cx = x0 - 2; cx < x0 + w + 2 && ok; cx++) {
        ok = inside(cx, cy) && terrain[at(cx, cy)] === TERRAIN.GRASS && !nearSpawn(cx, cy, 4);
      }
    }
    if (!ok) {
      continue;
    }
    for (let cy = y0; cy < y0 + h; cy++) {
      for (let cx = x0; cx < x0 + w; cx++) {
        terrain[at(cx, cy)] = TERRAIN.PLATEAU;
      }
    }
    for (let cx = x0; cx < x0 + w; cx++) {
      terrain[at(cx, y0 + h)] = TERRAIN.CLIFF;
    }
    plateaux++;
  }

  // Une cellule ou poser un arbre ou un rocher : de l'herbe, nue, sans eau ni
  // relief autour (le decor ne colle pas aux bords), hors de l'apparition.
  const freeGround = (cx: number, cy: number): boolean => {
    if (!inside(cx, cy) || nearSpawn(cx, cy, 1) || deco[at(cx, cy)] !== DECO.NONE) {
      return false;
    }
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!inside(cx + dx, cy + dy) || terrain[at(cx + dx, cy + dy)] !== TERRAIN.GRASS) {
          return false;
        }
      }
    }
    return true;
  };

  // 3. Les bosquets, puis les rochers, puis les buissons. Chaque tentative
  // tire ses nombres meme quand elle echoue : le flux ne depend pas du sol.
  for (let c = 0; c < TREE_CLUSTERS; c++) {
    const ox = Math.floor(rng() * cols);
    const oy = Math.floor(rng() * rows);
    for (let k = 0; k < TREES_PER_CLUSTER; k++) {
      const cx = ox + Math.floor(rng() * 7) - 3;
      const cy = oy + Math.floor(rng() * 7) - 3;
      if (freeGround(cx, cy)) {
        deco[at(cx, cy)] = DECO.TREE;
      }
    }
  }
  for (let k = 0; k < ROCKS; k++) {
    const cx = Math.floor(rng() * cols);
    const cy = Math.floor(rng() * rows);
    if (freeGround(cx, cy)) {
      deco[at(cx, cy)] = DECO.ROCK;
    }
  }
  for (let k = 0; k < BUSHES; k++) {
    const cx = Math.floor(rng() * cols);
    const cy = Math.floor(rng() * rows);
    if (inside(cx, cy) && terrain[at(cx, cy)] === TERRAIN.GRASS && deco[at(cx, cy)] === DECO.NONE) {
      deco[at(cx, cy)] = DECO.BUSH;
    }
  }

  const blocked = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    blocked[i] =
      terrain[i] !== TERRAIN.GRASS || deco[i] === DECO.TREE || deco[i] === DECO.ROCK ? 1 : 0;
  }

  // 4. Aucune poche : toute cellule libre que le centre n'atteint pas est
  // muree. Un bosquet qui enferme trois cellules ne doit pas y faire naitre
  // une vague que personne ne peut aller chercher.
  const seen = new Uint8Array(n);
  const queue = [at(centreX, centreY)];
  seen[at(centreX, centreY)] = 1;
  // `for...of` lit la file pendant qu'elle grandit : un parcours en largeur.
  for (const i of queue) {
    const cx = i % cols;
    const cy = (i - cx) / cols;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (inside(nx, ny) && !seen[at(nx, ny)] && !blocked[at(nx, ny)]) {
        seen[at(nx, ny)] = 1;
        queue.push(at(nx, ny));
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (!seen[i]) {
      blocked[i] = 1;
    }
  }

  return { cols, rows, terrain, deco, blocked };
}

/** Le masque d'obstacles seul — ce que lisent le champ de flux et les vagues. */
export function generateObstacles(mapSeed: number, cols: number, rows: number): Uint8Array {
  return generateWorld(mapSeed, cols, rows).blocked;
}

/** Reporte un masque d'obstacles dans un champ, en effacant le precedent. */
export function applyObstacles(field: FlowField, mask: Uint8Array): void {
  field.blocked.fill(0);
  field.blocked.set(mask);
}

/**
 * Le rayon de collision d'un joueur contre le decor, en px monde. Le centre du
 * joueur s'arrete a ce rayon d'une cellule bloquee : le personnage ne mord pas
 * dans l'eau ni dans le tronc.
 */
export const PLAYER_BODY_RADIUS = 20;

/**
 * Avance un joueur de `(dx, dy)` sur la carte, axe par axe : bloque sur un axe,
 * il glisse encore sur l'autre — le long d'une falaise plutot que colle a elle.
 *
 * ⚠️ **Appelee des DEUX cotes** — `Room.step` et `PredictedPlayer.predict`. Une
 * regle de collision differente d'un cote ferait reconcilier le joueur a
 * chaque snapshot contre un mur que sa prediction traverse.
 *
 * Un joueur DEJA dans une cellule bloquee (une teleportation, une carte
 * changee) se deplace librement jusqu'a en sortir : jamais d'enfermement.
 */
export function moveOnMap(
  x: number,
  y: number,
  dx: number,
  dy: number,
  mask: Uint8Array,
  cols: number,
  rows: number,
  cellSize: number,
  mapSize: number,
): { x: number; y: number } {
  const blockedAt = (px: number, py: number): boolean => {
    const cx = Math.floor(px / cellSize);
    const cy = Math.floor(py / cellSize);
    return cx >= 0 && cy >= 0 && cx < cols && cy < rows && mask[cy * cols + cx] === 1;
  };
  const clampMap = (v: number): number => (v < 0 ? 0 : v > mapSize ? mapSize : v);
  if (blockedAt(x, y)) {
    return { x: clampMap(x + dx), y: clampMap(y + dy) };
  }
  let nx = x;
  let ny = y;
  if (dx !== 0) {
    const tx = clampMap(x + dx);
    if (!blockedAt(tx + Math.sign(dx) * PLAYER_BODY_RADIUS, ny)) {
      nx = tx;
    }
  }
  if (dy !== 0) {
    const ty = clampMap(y + dy);
    if (!blockedAt(nx, ty + Math.sign(dy) * PLAYER_BODY_RADIUS)) {
      ny = ty;
    }
  }
  return { x: nx, y: ny };
}
