import { DECO, TERRAIN, type WorldMap } from '@shared/worldmap';
import { AnimatedSprite, Assets, Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';

/**
 * La carte en tuiles du pack Tiny Swords (`Terrain/Tileset`) : l'eau, l'ecume
 * animee au rivage, l'herbe, les plateaux et leurs falaises, puis les arbres,
 * rochers et buissons.
 *
 * ⚠️ **Rien n'est cuit ni ecrit** : les planches sont lues a l'execution sous
 * `ASSETS_BASE`, comme les cadres de l'interface — la licence interdit d'en
 * faire entrer un derive dans le depot.
 *
 * ⚠️ **Le dessin suit `WorldMap`, jamais l'inverse.** La carte vient de
 * `generateWorld` (la meme que celle du serveur) ; ce fichier ne decide d'aucun
 * obstacle, il habille ceux qui existent.
 */

/** La taille d'une tuile du pack, egale a `FLOWFIELD_CELL` : une cellule, une tuile. */
const TILE = 64;
/** La couleur de `Water Background color.png`. */
export const WATER_COLOR = 0x47aba9;

/** Ou lire une tuile : la planche, et la case dans la planche. */
export interface TileRef {
  sheet: 'tileset';
  sx: number;
  sy: number;
  /** Coin haut-gauche dans le monde. */
  x: number;
  y: number;
  /**
   * Miroirs horizontal et vertical, seulement sur une tuile de milieu, sans
   * bord a respecter. ⚠️ Jamais de quart de tour : les traits de l'herbe sont
   * couches a l'horizontale (eclairage du pack), et un quart de tour les
   * redresse — la tuile se voit. Les deux miroirs gardent leur sens.
   */
  flipX: boolean;
  flipY: boolean;
  /** Luminosite, dans `[SHADE_MIN, 1]` : des plaques, pas un damier. */
  shade: number;
  /** La planche de couleur (`Tilemap_color<n>.png`), 1 pour le fond. */
  color: number;
  /** Opacite : 1 pour le fond, moins pour une plaque d'une autre couleur posee dessus. */
  alpha: number;
}

/**
 * Les biomes : l'ile se partage en grandes regions, une teinte du pack chacune
 * (`Tilemap_color1` a `5`). Un Voronoi sur des centres semes en grille
 * secouee, ses frontieres tordues par le bruit et fondues sur `BIOME_BLEND`
 * cellules. Deux regions voisines n'ont jamais la meme teinte.
 *
 * La disposition depend de la carte (hachage de `terrain`) : chaque partie a
 * la sienne, et chaque client dessine la meme.
 */
export const BIOME_COLORS = [1, 2, 3, 4, 5] as const;
/** Ecart entre deux centres de biome, en cellules. */
const BIOME_SPACING = 30;
/** Largeur du fondu a la frontiere, en cellules. */
const BIOME_BLEND = 4;
/** Amplitude de la torsion des frontieres, en cellules. */
const BIOME_WOBBLE = 7;

/** Un sel stable par carte : FNV-1a sur le sol. */
function worldSalt(world: WorldMap): number {
  let h = 2166136261;
  for (const v of world.terrain) {
    h = Math.imul(h ^ v, 16777619) >>> 0;
  }
  return h % 100_000;
}

/**
 * L'opacite de chaque calque de teinte, par cellule : `[0]` le fond (tout a
 * 1), `[c - 1]` la teinte `c`. Les calques s'empilent 1 a 5 ; l'opacite du
 * calque `k` vaut `w_k / (w_1 + ... + w_k)`, ce qui rend a chaque teinte
 * exactement son poids `w_k` une fois tout empile — le fond ne transparait
 * jamais a une frontiere.
 */
export function biomeLayers(world: WorldMap): Float32Array[] {
  const { cols, rows } = world;
  const salt = worldSalt(world);
  const gcols = Math.ceil(cols / BIOME_SPACING) + 2;
  const grows = Math.ceil(rows / BIOME_SPACING) + 2;
  const centres: { x: number; y: number; color: number }[] = [];
  for (let gy = 0; gy < grows; gy++) {
    for (let gx = 0; gx < gcols; gx++) {
      const h = hash(gx, gy, salt);
      const x = (gx - 1 + 0.2 + 0.6 * ((h & 0xffff) / 0xffff)) * BIOME_SPACING;
      const y = (gy - 1 + 0.2 + (0.6 * (h >>> 16)) / 0xffff) * BIOME_SPACING;
      // La premiere teinte, a partir d'un tirage, que n'a aucun voisin deja
      // pose (gauche, et les trois du dessus) : cinq teintes, quatre interdits.
      const taken = new Set(
        [
          [gx - 1, gy],
          [gx - 1, gy - 1],
          [gx, gy - 1],
          [gx + 1, gy - 1],
        ].map(([nx = 0, ny = 0]) =>
          nx >= 0 && ny >= 0 && nx < gcols ? centres[ny * gcols + nx]?.color : undefined,
        ),
      );
      const start = hash(gx, gy, salt + 1) % BIOME_COLORS.length;
      let color = 1;
      for (let k = 0; k < BIOME_COLORS.length; k++) {
        const c = BIOME_COLORS[(start + k) % BIOME_COLORS.length] ?? 1;
        if (!taken.has(c)) {
          color = c;
          break;
        }
      }
      centres.push({ x, y, color });
    }
  }

  const layers = BIOME_COLORS.map(() => new Float32Array(cols * rows));
  const nearest = new Float64Array(BIOME_COLORS.length);
  const w = new Float64Array(BIOME_COLORS.length);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const px = cx + BIOME_WOBBLE * (2 * valueNoise(cx, cy, 9, salt + 2) - 1);
      const py = cy + BIOME_WOBBLE * (2 * valueNoise(cx, cy, 9, salt + 3) - 1);
      nearest.fill(Infinity);
      for (const c of centres) {
        const d = Math.hypot(c.x - px, c.y - py);
        if (d < (nearest[c.color - 1] ?? Infinity)) {
          nearest[c.color - 1] = d;
        }
      }
      const d1 = Math.min(...nearest);
      let sum = 0;
      for (let k = 0; k < w.length; k++) {
        w[k] = 1 - smoothstep(0, BIOME_BLEND, (nearest[k] ?? Infinity) - d1);
        sum += w[k] ?? 0;
      }
      const i = cy * cols + cx;
      let below = 0;
      for (let k = 0; k < w.length; k++) {
        const wk = (w[k] ?? 0) / sum;
        below += wk;
        const layer = layers[k];
        if (layer) {
          layer[i] = k === 0 ? 1 : below > 0 ? wk / below : 0;
        }
      }
    }
  }
  return layers;
}

const smoothstep = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** La tuile de milieu d'un bloc d'autotuile 4 x 4 : la seule qu'on peut retourner. */
const MIDDLE = 64;
/** La plaque la plus sombre : assez pour casser la repetition, pas pour se voir. */
export const SHADE_MIN = 0.9;
/** Taille des plaques de luminosite, en cellules. */
const SHADE_LATTICE = 6;

/** Un entier pseudo-aleatoire stable par cellule (hachage, pas de tirage). */
function hash(cx: number, cy: number, salt: number): number {
  let h = (cx * 374761393 + cy * 668265263 + salt * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Bruit de valeur lisse dans `[0, 1]`, a l'echelle de `lattice` cellules. */
function valueNoise(cx: number, cy: number, lattice = SHADE_LATTICE, salt = 7): number {
  const fx = cx / lattice;
  const fy = cy / lattice;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const v = (x: number, y: number): number => hash(x, y, salt) / 0xffff_ffff;
  const top = v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx;
  const bottom = v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * La variation d'une tuile, sans rien ajouter au pack : deux miroirs au
 * hasard sur les tuiles de MILIEU (l'herbe n'a pas de sens, les
 * bords si), et une luminosite qui varie en larges plaques. Stable par
 * cellule : la meme ile se dessine pareil a chaque image et chez chacun.
 */
function vary(
  sx: number,
  sy: number,
  cx: number,
  cy: number,
): Pick<TileRef, 'flipX' | 'flipY' | 'shade' | 'color' | 'alpha'> {
  // Le milieu de l'herbe (colonne 1) ou du dessus des plateaux (colonne 5 + 1).
  const middle = (sx === MIDDLE || sx === 5 * TILE + MIDDLE) && sy === MIDDLE;
  const h = hash(cx, cy, 1);
  return {
    flipX: middle && (h & 1) === 1,
    flipY: middle && ((h >>> 1) & 1) === 1,
    shade: SHADE_MIN + (1 - SHADE_MIN) * valueNoise(cx, cy),
    color: 1,
    alpha: 1,
  };
}

/**
 * L'index 0-3 d'un bord dans un bloc d'autotuile 4 x 4 du pack : 0 debut,
 * 1 milieu, 2 fin, 3 isole (la bande d'une tuile de large).
 */
function edge(before: boolean, after: boolean): number {
  if (before && after) {
    return 1;
  }
  if (after) {
    return 0;
  }
  return before ? 2 : 3;
}

/**
 * Les tuiles du sol, dans l'ordre de dessin : l'herbe d'abord (sous tout ce qui
 * n'est pas de l'eau, plateaux compris — leurs bords ont des coins
 * transparents), puis le dessus des plateaux, puis les falaises.
 *
 * Disposition de `Tilemap_color*.png` (9 x 6 tuiles de 64) : l'herbe plate est
 * le bloc 4 x 4 en (0, 0), le dessus des plateaux le bloc 4 x 4 en (5, 0), la
 * paroi de falaise la rangee 5 a partir de la colonne 5.
 */
export function groundTiles(world: WorldMap): TileRef[] {
  const { cols, rows, terrain } = world;
  const t = (cx: number, cy: number): number =>
    cx < 0 || cy < 0 || cx >= cols || cy >= rows ? TERRAIN.WATER : (terrain[cy * cols + cx] ?? 0);
  const land = (cx: number, cy: number): boolean => t(cx, cy) !== TERRAIN.WATER;
  const top = (cx: number, cy: number): boolean => t(cx, cy) === TERRAIN.PLATEAU;
  const cliff = (cx: number, cy: number): boolean => t(cx, cy) === TERRAIN.CLIFF;

  const grass: TileRef[] = [];
  const raised: TileRef[] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (!land(cx, cy)) {
        continue;
      }
      const x = cx * TILE;
      const y = cy * TILE;
      const gx = edge(land(cx - 1, cy), land(cx + 1, cy)) * TILE;
      const gy = edge(land(cx, cy - 1), land(cx, cy + 1)) * TILE;
      grass.push({
        sheet: 'tileset',
        sx: gx,
        sy: gy,
        x,
        y,
        ...vary(gx, gy, cx, cy),
      });
      if (top(cx, cy)) {
        const px = (5 + edge(top(cx - 1, cy), top(cx + 1, cy))) * TILE;
        const py = edge(top(cx, cy - 1), top(cx, cy + 1)) * TILE;
        raised.push({
          sheet: 'tileset',
          sx: px,
          sy: py,
          x,
          y,
          ...vary(px, py, cx, cy),
        });
      } else if (cliff(cx, cy)) {
        raised.push({
          sheet: 'tileset',
          sx: (5 + edge(cliff(cx - 1, cy), cliff(cx + 1, cy))) * TILE,
          sy: 5 * TILE,
          x,
          y,
          flipX: false,
          flipY: false,
          shade: 1,
          color: 1,
          alpha: 1,
        });
      }
    }
  }
  // Les biomes, poses sur l'herbe de la meme case.
  const layers = biomeLayers(world);
  const tinted = grass.flatMap((tile) => {
    const i = (tile.y / TILE) * cols + tile.x / TILE;
    return BIOME_COLORS.slice(1).flatMap((color) => {
      const alpha = layers[color - 1]?.[i] ?? 0;
      return alpha > 0 ? [{ ...tile, color, alpha }] : [];
    });
  });
  // Un plateau (dessus et falaise) prend D'UN BLOC la teinte qui domine en son
  // centre : pas de fondu sur un relief, et jamais une frontiere qui le coupe.
  const colorAt = plateauColors(world, layers);
  for (const tile of raised) {
    tile.color = colorAt.get((tile.y / TILE) * cols + tile.x / TILE) ?? 1;
  }
  return [...grass, ...tinted, ...raised];
}

/** La teinte la plus visible d'une cellule, une fois les calques empiles. */
function dominantColor(layers: Float32Array[], i: number): number {
  let best = 1;
  let bestWeight = -1;
  let above = 1;
  for (let k = layers.length - 1; k >= 0; k--) {
    const a = layers[k]?.[i] ?? 0;
    if (a * above > bestWeight) {
      bestWeight = a * above;
      best = k + 1;
    }
    above *= 1 - a;
  }
  return best;
}

/** La teinte de chaque cellule de relief, par plateau (4-connexe, dessus et falaise). */
function plateauColors(world: WorldMap, layers: Float32Array[]): Map<number, number> {
  const { cols, rows, terrain } = world;
  const raised = (i: number): boolean =>
    terrain[i] === TERRAIN.PLATEAU || terrain[i] === TERRAIN.CLIFF;
  const out = new Map<number, number>();
  for (let start = 0; start < cols * rows; start++) {
    if (!raised(start) || out.has(start)) {
      continue;
    }
    const cells = [start];
    out.set(start, 1);
    // `for...of` revisite les cases poussees en cours de route : c'est le parcours en largeur.
    for (const i of cells) {
      const cx = i % cols;
      for (const j of [i - cols, i + cols, cx > 0 ? i - 1 : -1, cx < cols - 1 ? i + 1 : -1]) {
        if (j >= 0 && j < cols * rows && raised(j) && !out.has(j)) {
          out.set(j, 1);
          cells.push(j);
        }
      }
    }
    const mx = Math.round(cells.reduce((s, i) => s + (i % cols), 0) / cells.length);
    const my = Math.round(cells.reduce((s, i) => s + Math.floor(i / cols), 0) / cells.length);
    const color = dominantColor(layers, my * cols + mx);
    for (const i of cells) {
      out.set(i, color);
    }
  }
  return out;
}

/**
 * Les petits details du pack (`Deco/`), semes en PETITES PLAQUES plutot que
 * partout : un bruit a grain fin choisit quelques taches d'herbe, et seules
 * elles recoivent des details, serres. Surtout des touffes et des cailloux
 * (`04` a `11`) ; plus rarement champignons, citrouilles et os ; tres
 * rarement un panneau (`16`, `17`) ou un epouvantail (`18`). Sans effet sur le
 * jeu : rien ne bloque, rien ne voyage, chaque client en seme les memes.
 */
export interface Detail {
  x: number;
  y: number;
  /** Le numero de `Deco/<nn>.png`, de 1 a 18. */
  kind: number;
}

/** Taille des taches, en cellules : petit, pour des bouquets et pas des champs. */
const DETAIL_LATTICE = 3;
/** Seuil du bruit au-dela duquel une cellule fait partie d'une tache. */
const DETAIL_PATCH = 0.78;
/** Dans une tache, part des cellules qui recoivent un detail. */
export const DETAIL_DENSITY = 0.6;
/** Les details courants : touffes, buissons et cailloux. */
const COMMON = [4, 5, 6, 7, 8, 9, 10, 11];
/** Les rares : champignons, citrouilles, os. */
const RARE = [1, 2, 3, 12, 13, 14, 15];
/** Part des rares parmi les details d'une tache. */
const RARE_SHARE = 0.12;
/** Les grands (panneaux, epouvantail) : quelques-uns par ile, hors des taches. */
const TALL_DENSITY = 0.0012;

export function detailCells(world: WorldMap): Detail[] {
  const out: Detail[] = [];
  for (let cy = 0; cy < world.rows; cy++) {
    for (let cx = 0; cx < world.cols; cx++) {
      const i = cy * world.cols + cx;
      if (world.terrain[i] !== TERRAIN.GRASS || world.deco[i] !== DECO.NONE || world.blocked[i]) {
        continue;
      }
      const roll = hash(cx, cy, 11) / 0xffff_ffff;
      const pick = hash(cx, cy, 12);
      const ox = ((pick >>> 8) % 33) - 16;
      const oy = ((pick >>> 16) % 33) - 16;
      const x = cx * TILE + TILE / 2 + ox;
      const y = cy * TILE + TILE / 2 + oy;
      if (roll < TALL_DENSITY) {
        out.push({ x, y, kind: 16 + (pick % 3) });
        continue;
      }
      if (valueNoise(cx, cy, DETAIL_LATTICE, 13) < DETAIL_PATCH || roll > DETAIL_DENSITY) {
        continue;
      }
      const set = (pick >>> 24) / 255 < RARE_SHARE ? RARE : COMMON;
      out.push({ x, y, kind: set[pick % set.length] ?? 4 });
    }
  }
  return out;
}

/** Les cellules de terre qui touchent l'eau : l'ecume y deborde du rivage. */
export function coastCells(world: WorldMap): { x: number; y: number }[] {
  const { cols, rows, terrain } = world;
  const water = (cx: number, cy: number): boolean =>
    cx < 0 || cy < 0 || cx >= cols || cy >= rows || terrain[cy * cols + cx] === TERRAIN.WATER;
  const out: { x: number; y: number }[] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (water(cx, cy)) {
        continue;
      }
      if (water(cx - 1, cy) || water(cx + 1, cy) || water(cx, cy - 1) || water(cx, cy + 1)) {
        out.push({ x: cx * TILE + TILE / 2, y: cy * TILE + TILE / 2 });
      }
    }
  }
  return out;
}

const PATHS = {
  tilesets: BIOME_COLORS.map((i) => `Terrain/Tileset/Tilemap_color${i}.png`),
  foam: 'Terrain/Tileset/Water%20Foam.png',
  trees: [1, 2, 3, 4].map((i) => `Terrain/Resources/Wood/Trees/Tree${i}.png`),
  rocks: [1, 2, 3, 4].map((i) => `Terrain/Decorations/Rocks/Rock${i}.png`),
  bushes: [1, 2, 3, 4].map((i) => `Terrain/Decorations/Bushes/Bushe${i}.png`),
  details: Array.from({ length: 18 }, (_, i) => `Deco/${String(i + 1).padStart(2, '0')}.png`),
};

/** Toutes les planches du terrain, chemins relatifs a `ASSETS_BASE`. */
export function terrainSheets(): string[] {
  return [
    ...PATHS.tilesets,
    PATHS.foam,
    ...PATHS.trees,
    ...PATHS.rocks,
    ...PATHS.bushes,
    ...PATHS.details,
  ];
}

/**
 * Precharge des planches dans le cache d'`Assets` — appele en salle d'attente,
 * pour que `buildTerrain` (et les unites) les trouvent deja la au depart.
 * `onProgress` recoit le nombre charge sur le total, a chaque planche ; une
 * planche absente compte quand meme, l'echec se dira au moment de dessiner.
 */
export function preloadSheets(
  assetsBase: string,
  sheets: readonly string[],
  onProgress: (loaded: number, total: number) => void = () => undefined,
): Promise<void> {
  let loaded = 0;
  onProgress(0, sheets.length);
  return Promise.all(
    sheets.map((p) =>
      Assets.load(`${assetsBase}/${p}`)
        .catch(() => undefined)
        .then(() => {
          loaded++;
          onProgress(loaded, sheets.length);
        }),
    ),
  ).then(() => undefined);
}

/** Coupe une bande horizontale d'animation en images de `w x h`. */
function frames(sheet: Texture, w: number, h: number): Texture[] {
  const n = Math.floor(sheet.width / w);
  return Array.from(
    { length: n },
    (_, i) =>
      new Texture({
        source: sheet.source,
        frame: new Rectangle(i * w, 0, w, h),
      }),
  );
}

/** Une variante stable par cellule : le meme arbre au meme endroit a chaque partie. */
const variant = (i: number, n: number): number => ((i * 2654435761) >>> 0) % n;

/**
 * Le terrain en deux parts : `ground`, a poser sous tous les calques du monde
 * (eau, ecume, sol, buissons, rochers, petits details), et `tall`, les objets
 * hauts (arbres, panneaux, epouvantail) a trier avec les joueurs par la
 * hauteur de leurs pieds (`zIndex`). Rejette si une planche manque :
 * l'appelant garde alors l'ancien dessin des obstacles.
 */
export async function buildTerrain(
  world: WorldMap,
  assetsBase: string,
): Promise<{ ground: Container; tall: Container[] }> {
  const load = (p: string): Promise<Texture> => Assets.load<Texture>(`${assetsBase}/${p}`);
  const [tilesets, foam, trees, rocks, bushes, details] = await Promise.all([
    Promise.all(PATHS.tilesets.map(load)),
    load(PATHS.foam),
    Promise.all(PATHS.trees.map(load)),
    Promise.all(PATHS.rocks.map(load)),
    Promise.all(PATHS.bushes.map(load)),
    Promise.all(PATHS.details.map(load)),
  ]);
  for (const tex of [...tilesets, foam, ...trees, ...rocks, ...bushes, ...details]) {
    tex.source.scaleMode = 'nearest';
  }

  const root = new Container();
  const tall: Container[] = [];
  const size = Math.max(world.cols, world.rows) * TILE;
  // L'eau deborde largement : la camera peut montrer au-dela du bord.
  root.addChild(new Graphics().rect(-size, -size, 3 * size, 3 * size).fill(WATER_COLOR));

  const foamFrames = frames(foam, 192, 192);
  for (const [i, c] of coastCells(world).entries()) {
    const s = new AnimatedSprite(foamFrames);
    s.anchor.set(0.5);
    s.position.set(c.x, c.y);
    s.animationSpeed = 0.12;
    s.gotoAndPlay(variant(i, foamFrames.length));
    root.addChild(s);
  }

  // Les biomes : chaque teinte dans son conteneur, a pleine opacite, sous un
  // MASQUE lisse — une image d'un pixel par cellule (`biomeLayers`) etiree en
  // filtrage lineaire. La transition se fait DANS les tuiles, en degrade, la
  // ou une opacite par tuile faisait des marches.
  const overlays = new Map<number, Container>();
  const masks: Sprite[] = [];
  const layers = biomeLayers(world);
  for (const color of BIOME_COLORS.slice(1)) {
    const weights = layers[color - 1];
    const layer = new Container();
    const canvas = document.createElement('canvas');
    canvas.width = world.cols;
    canvas.height = world.rows;
    const g = canvas.getContext('2d');
    if (g) {
      const img = g.createImageData(world.cols, world.rows);
      for (let cy = 0; cy < world.rows; cy++) {
        for (let cx = 0; cx < world.cols; cx++) {
          const o = (cy * world.cols + cx) * 4;
          img.data[o] = 255;
          img.data[o + 1] = 255;
          img.data[o + 2] = 255;
          img.data[o + 3] = Math.round(255 * (weights?.[cy * world.cols + cx] ?? 0));
        }
      }
      g.putImageData(img, 0, 0);
    }
    const tex = Texture.from(canvas);
    tex.source.scaleMode = 'linear';
    const mask = new Sprite(tex);
    // Un pixel par cellule, son centre au centre de la cellule.
    mask.scale.set(TILE);
    layer.mask = mask;
    masks.push(mask);
    overlays.set(color, layer);
  }

  const cut = new Map<string, Texture>();
  let raisedStart = false;
  for (const tile of groundTiles(world)) {
    // Les plateaux passent par-dessus toutes les plaques de l'herbe.
    if (!raisedStart && tile.sx >= 5 * TILE) {
      raisedStart = true;
      for (const layer of overlays.values()) {
        root.addChild(layer);
      }
      for (const m of masks) {
        root.addChild(m);
      }
    }
    const key = `${tile.color},${tile.sx},${tile.sy}`;
    let tex = cut.get(key);
    if (!tex) {
      const sheet = tilesets[tile.color - 1] ?? tilesets[0];
      if (!sheet) {
        continue;
      }
      tex = new Texture({
        source: sheet.source,
        frame: new Rectangle(tile.sx, tile.sy, TILE, TILE),
      });
      cut.set(key, tex);
    }
    const s = new Sprite(tex);
    // Centre de la tuile comme pivot : un miroir reste dans sa case.
    s.anchor.set(0.5);
    s.position.set(tile.x + TILE / 2, tile.y + TILE / 2);
    s.scale.set(tile.flipX ? -1 : 1, tile.flipY ? -1 : 1);
    const v = Math.round(255 * tile.shade);
    s.tint = (v << 16) | (v << 8) | v;
    // L'herbe teintee va sous son masque ; le fond et le relief (deja dans
    // la teinte de son plateau) se posent tels quels.
    const layer = tile.color !== 1 && tile.sx < 5 * TILE ? overlays.get(tile.color) : undefined;
    (layer ?? root).addChild(s);
  }
  if (!raisedStart) {
    for (const layer of overlays.values()) {
      root.addChild(layer);
    }
    for (const m of masks) {
      root.addChild(m);
    }
  }

  // Les details : les petits au sol, les grands tries avec les joueurs.
  for (const d of detailCells(world)) {
    const tex = details[d.kind - 1];
    if (!tex) {
      continue;
    }
    const s = new Sprite(tex);
    // Le pied du detail sur son point.
    s.anchor.set(0.5, d.kind >= 16 ? 0.85 : 0.6);
    s.position.set(d.x, d.y);
    if (d.kind >= 16) {
      s.zIndex = d.y;
      tall.push(s);
    } else {
      root.addChild(s);
    }
  }

  const treeFrames = trees.map((t) => frames(t, 192, t.height));
  const bushFrames = bushes.map((t) => frames(t, 128, 128));
  for (let i = 0; i < world.deco.length; i++) {
    const d = world.deco[i];
    if (d === DECO.NONE) {
      continue;
    }
    const cx = i % world.cols;
    const cy = (i - cx) / world.cols;
    const x = cx * TILE + TILE / 2;
    const y = cy * TILE + TILE / 2;
    if (d === DECO.TREE) {
      const set = treeFrames[variant(i, treeFrames.length)] ?? [];
      const s = new AnimatedSprite(set);
      // Le pied du tronc au bas de la cellule ; trie avec les joueurs.
      s.anchor.set(0.5, 0.85);
      s.position.set(x, y + TILE / 2);
      s.zIndex = y + TILE / 2;
      s.animationSpeed = 0.1;
      s.gotoAndPlay(variant(i + 1, set.length));
      tall.push(s);
    } else if (d === DECO.ROCK) {
      const s = new Sprite(rocks[variant(i, rocks.length)]);
      s.anchor.set(0.5);
      s.position.set(x, y);
      root.addChild(s);
    } else {
      const set = bushFrames[variant(i, bushFrames.length)] ?? [];
      const s = new AnimatedSprite(set);
      s.anchor.set(0.5);
      s.position.set(x, y);
      s.animationSpeed = 0.1;
      s.gotoAndPlay(variant(i + 1, set.length));
      root.addChild(s);
    }
  }
  return { ground: root, tall };
}
