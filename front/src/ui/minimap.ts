import { MAP_SIZE } from '@shared/constants';
import { DECO, TERRAIN } from '@shared/worldmap';

import type { ObstacleMap } from '../net/client';
import { playerColor } from './draft';

/**
 * La mini-carte du HUD, coin bas droit.
 *
 * En `<canvas>` 2D et pas en Pixi, comme tout le reste du HUD : c'est de
 * l'interface, pas du monde (voir l'en-tete de `hud.ts`).
 *
 * ⚠️ **`draw` doit rester bon marche.** La horde compte des milliers
 * d'entites : un `fillRect` par point, aucune allocation par entite, et les
 * obstacles — fixes pour la partie — sont pre-rendus UNE fois a
 * `setObstacles`, puis recopies d'un seul `drawImage`. L'appelant cadence
 * l'appel (ex. 10 Hz), ce module ne s'en occupe pas.
 */

const BG = '#2f3a2a';
const OBSTACLE_RGB = [0x55, 0x64, 0x4b] as const;
/** Les couleurs du sol par `TERRAIN` ; l'herbe (absente) garde le fond. */
const TERRAIN_RGB: Partial<Record<number, readonly [number, number, number]>> = {
  [TERRAIN.WATER]: [0x47, 0xab, 0xa9],
  [TERRAIN.PLATEAU]: [0x6f, 0x86, 0x4a],
  [TERRAIN.CLIFF]: [0x5d, 0x73, 0x7e],
};
const ENEMY = '#e04040';
const BOSS = '#ff2020';
const OUTLINE = '#ffffff';

export interface MinimapView {
  localId: number | null;
  players: readonly { id: number; x: number; y: number; hp: number }[];
  enemies: { readonly count: number; readonly x: Float32Array; readonly y: Float32Array };
  boss: { x: number; y: number } | null;
}

/**
 * Coordonnee monde -> pixel ENTIER de la mini-carte, sur un axe.
 *
 * Par axe, et pas en couple `(x, y)` : rendre un tableau ou un objet
 * allouerait a chaque ennemi. Bornee a `[0, size - 1]` : une entite au bord
 * exact du monde (ou un peu hors, extrapolation) reste dessinee dans le cadre.
 */
export function toMinimap(v: number, worldSize: number, size: number): number {
  const p = Math.floor((v / worldSize) * size);
  return p < 0 ? 0 : p >= size ? size - 1 : p;
}

export class Minimap {
  private readonly ctx: CanvasRenderingContext2D | null;
  private obstacles: HTMLCanvasElement | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    // null sous jsdom (pas de contexte 2D) : draw devient alors sans effet.
    this.ctx = canvas.getContext('2d');
  }

  /**
   * Pre-rend le masque a raison d'UN pixel par cellule ; `draw` l'etire a la
   * taille de la mini-carte sans lissage. Le cout est donc proportionnel au
   * nombre de cellules, une seule fois, et jamais par image.
   */
  setObstacles(map: ObstacleMap): void {
    const off = document.createElement('canvas');
    off.width = map.cols;
    off.height = map.rows;
    const octx = off.getContext('2d');
    if (!octx) {
      return;
    }
    const img = octx.createImageData(map.cols, map.rows);
    for (let i = 0; i < map.mask.length; i++) {
      // Le sol d'abord (eau, herbe, plateau, falaise), puis ce qui bloque
      // dessus. Une cellule libre d'herbe garde le fond (`BG`).
      const rgb =
        TERRAIN_RGB[map.world.terrain[i] ?? 0] ?? (map.mask[i] === 1 ? OBSTACLE_RGB : null);
      const deco = map.world.deco[i] === DECO.TREE || map.world.deco[i] === DECO.ROCK;
      const color = deco ? OBSTACLE_RGB : rgb;
      if (!color) {
        continue;
      }
      const o = i * 4;
      img.data[o] = color[0];
      img.data[o + 1] = color[1];
      img.data[o + 2] = color[2];
      img.data[o + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    this.obstacles = off;
  }

  draw(view: MinimapView): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    if (this.obstacles) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.obstacles, 0, 0, w, h);
    }

    // Ennemis : 1 px, la masse compte plus que l'individu.
    ctx.fillStyle = ENEMY;
    const { count, x, y } = view.enemies;
    for (let i = 0; i < count; i++) {
      ctx.fillRect(toMinimap(x[i] ?? 0, MAP_SIZE, w), toMinimap(y[i] ?? 0, MAP_SIZE, h), 1, 1);
    }

    if (view.boss) {
      const bx = toMinimap(view.boss.x, MAP_SIZE, w);
      const by = toMinimap(view.boss.y, MAP_SIZE, h);
      ctx.fillStyle = BOSS;
      ctx.fillRect(bx - 2, by - 2, 5, 5);
    }

    // Allies d'abord, joueur local en DERNIER : il ne doit jamais etre
    // masque par un allie au meme endroit.
    let local: MinimapView['players'][number] | null = null;
    for (const p of view.players) {
      if (p.id === view.localId) {
        local = p;
        continue;
      }
      ctx.fillStyle = playerColor(p.id);
      ctx.fillRect(toMinimap(p.x, MAP_SIZE, w) - 1, toMinimap(p.y, MAP_SIZE, h) - 1, 3, 3);
    }
    if (local) {
      const lx = toMinimap(local.x, MAP_SIZE, w);
      const ly = toMinimap(local.y, MAP_SIZE, h);
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(lx - 3, ly - 3, 7, 7);
      ctx.fillStyle = playerColor(local.id);
      ctx.fillRect(lx - 2, ly - 2, 5, 5);
    }
  }
}
