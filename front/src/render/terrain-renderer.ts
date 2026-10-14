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
      grass.push({
        sheet: 'tileset',
        sx: edge(land(cx - 1, cy), land(cx + 1, cy)) * TILE,
        sy: edge(land(cx, cy - 1), land(cx, cy + 1)) * TILE,
        x,
        y,
      });
      if (top(cx, cy)) {
        raised.push({
          sheet: 'tileset',
          sx: (5 + edge(top(cx - 1, cy), top(cx + 1, cy))) * TILE,
          sy: edge(top(cx, cy - 1), top(cx, cy + 1)) * TILE,
          x,
          y,
        });
      } else if (cliff(cx, cy)) {
        raised.push({
          sheet: 'tileset',
          sx: (5 + edge(cliff(cx - 1, cy), cliff(cx + 1, cy))) * TILE,
          sy: 5 * TILE,
          x,
          y,
        });
      }
    }
  }
  return [...grass, ...raised];
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
  tileset: 'Terrain/Tileset/Tilemap_color1.png',
  foam: 'Terrain/Tileset/Water%20Foam.png',
  trees: [1, 2, 3, 4].map((i) => `Terrain/Resources/Wood/Trees/Tree${i}.png`),
  rocks: [1, 2, 3, 4].map((i) => `Terrain/Decorations/Rocks/Rock${i}.png`),
  bushes: [1, 2, 3, 4].map((i) => `Terrain/Decorations/Bushes/Bushe${i}.png`),
};

/** Coupe une bande horizontale d'animation en images de `w x h`. */
function frames(sheet: Texture, w: number, h: number): Texture[] {
  const n = Math.floor(sheet.width / w);
  return Array.from(
    { length: n },
    (_, i) => new Texture({ source: sheet.source, frame: new Rectangle(i * w, 0, w, h) }),
  );
}

/** Une variante stable par cellule : le meme arbre au meme endroit a chaque partie. */
const variant = (i: number, n: number): number => ((i * 2654435761) >>> 0) % n;

/**
 * Construit le terrain dans un `Container` a poser sous tous les calques du
 * monde. Rejette si une planche manque : l'appelant garde alors l'ancien
 * dessin des obstacles (`Stage.drawObstacles`).
 */
export async function buildTerrain(world: WorldMap, assetsBase: string): Promise<Container> {
  const load = (p: string): Promise<Texture> => Assets.load<Texture>(`${assetsBase}/${p}`);
  const [tileset, foam, trees, rocks, bushes] = await Promise.all([
    load(PATHS.tileset),
    load(PATHS.foam),
    Promise.all(PATHS.trees.map(load)),
    Promise.all(PATHS.rocks.map(load)),
    Promise.all(PATHS.bushes.map(load)),
  ]);
  for (const tex of [tileset, foam, ...trees, ...rocks, ...bushes]) {
    tex.source.scaleMode = 'nearest';
  }

  const root = new Container();
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

  const cut = new Map<string, Texture>();
  for (const tile of groundTiles(world)) {
    const key = `${tile.sx},${tile.sy}`;
    let tex = cut.get(key);
    if (!tex) {
      tex = new Texture({
        source: tileset.source,
        frame: new Rectangle(tile.sx, tile.sy, TILE, TILE),
      });
      cut.set(key, tex);
    }
    const s = new Sprite(tex);
    s.position.set(tile.x, tile.y);
    root.addChild(s);
  }

  // Le decor, du haut vers le bas de la carte : un arbre plus bas passe devant.
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
      // Le pied du tronc au bas de la cellule.
      s.anchor.set(0.5, 0.85);
      s.position.set(x, y + TILE / 2);
      s.animationSpeed = 0.1;
      s.gotoAndPlay(variant(i + 1, set.length));
      root.addChild(s);
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
  return root;
}
