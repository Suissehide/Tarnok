import { MAP_SIZE } from '@shared/constants';
import type { Horde } from '@shared/horde';
import { Application, Container, Graphics, Rectangle } from 'pixi.js';

import type { RenderState } from '../net/client';
import { ASSETS_BASE } from '../ui/config';
import { HordeRenderer } from './horde-renderer';

/**
 * Rendu de l'etape 0 : un carre par joueur, une caméra par client.
 *
 * On ne parle pas encore de `ParticleContainer` ni d'atlas : c'est le sujet de
 * l'etape 1, et la decision d'y passer doit venir d'une mesure, pas d'une
 * intuition. Ici, quatre `Graphics` suffisent et ne prejugent de rien.
 */

/** Un anneau colore par joueur : avec quatre cameras, il faut savoir qui est qui (§6.6). */
const PLAYER_COLORS = [0xe0a45e, 0x6fa8dc, 0x93c47d, 0xc27ba0];

const PLAYER_RADIUS = 18;

/** §4.5 : vue de dessus, tres legerement ecrasee. Pas d'isometrique. */
const VERTICAL_SQUASH = 0.82;

export class Stage {
  readonly #app = new Application();
  readonly #world = new Container();
  readonly #sprites = new Map<number, Graphics>();
  // Corrigé par rapport au brief : `readonly` assigné dans `init()` ne
  // compile pas sous `strictPropertyInitialization`. Initialisation directe.
  #horde = new HordeRenderer(ASSETS_BASE);

  async init(parent: HTMLElement): Promise<void> {
    await this.#app.init({
      resizeTo: parent,
      background: 0x14110f,
      antialias: true,
      // Un bullet heaven passe son temps a bouger : la resolution native evite
      // le flou sur ecran dense sans rien couter a ce stade.
      resolution: window.devicePixelRatio,
      autoDensity: true,
    });
    parent.appendChild(this.#app.canvas);

    this.#world.scale.set(1, VERTICAL_SQUASH);
    this.#app.stage.addChild(this.#world);
    this.#world.addChild(mapBorder());

    // Ordre d'affichage : apres la grille, avant les carres des joueurs
    // (ajoutes plus tard via `#spriteFor`), sinon les joueurs disparaissent
    // sous la horde.
    this.#horde.attach(this.#world);
    await this.#horde.load();
  }

  get canvas(): HTMLCanvasElement {
    return this.#app.canvas;
  }

  /** Branche la boucle de rendu. `frame` rend l'etat a dessiner. */
  run(frame: (now: number, dt: number) => RenderState): void {
    this.#app.ticker.add((ticker) => {
      this.draw(frame(performance.now(), ticker.deltaMS / 1000));
    });
  }

  draw(state: RenderState): void {
    const seen = new Set<number>();

    for (const player of state.players) {
      seen.add(player.id);
      const sprite = this.#spriteFor(player.id);
      sprite.x = player.x;
      sprite.y = player.y;
      sprite.alpha = player.id === state.localId ? 1 : 0.85;
    }

    for (const [id, sprite] of this.#sprites) {
      if (!seen.has(id)) {
        sprite.destroy();
        this.#sprites.delete(id);
      }
    }

    this.#centerOn(state);
  }

  /** Rectangle du monde actuellement visible, pour le culling. */
  viewRect(): Rectangle {
    return new Rectangle(
      -this.#world.x,
      -this.#world.y / VERTICAL_SQUASH,
      this.#app.screen.width,
      this.#app.screen.height / VERTICAL_SQUASH,
    );
  }

  drawHorde(horde: Horde, timeMs: number): void {
    this.#horde.draw(horde, this.viewRect(), timeMs);
  }

  destroy(): void {
    this.#app.destroy(true, { children: true });
  }

  #spriteFor(id: number): Graphics {
    const existing = this.#sprites.get(id);
    if (existing) {
      return existing;
    }

    const color = PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length] ?? 0xffffff;
    const g = new Graphics()
      .rect(-PLAYER_RADIUS, -PLAYER_RADIUS, PLAYER_RADIUS * 2, PLAYER_RADIUS * 2)
      .fill(color)
      .circle(0, PLAYER_RADIUS + 6, PLAYER_RADIUS)
      .stroke({ color, width: 2, alpha: 0.6 });

    this.#world.addChild(g);
    this.#sprites.set(id, g);
    return g;
  }

  /** Une camera par joueur (§14) : chacun est centre sur son propre carre. */
  #centerOn(state: RenderState): void {
    const me = state.players.find((p) => p.id === state.localId);
    if (!me) {
      return;
    }
    this.#world.x = this.#app.screen.width / 2 - me.x;
    this.#world.y = this.#app.screen.height / 2 - me.y * VERTICAL_SQUASH;
  }
}

function mapBorder(): Graphics {
  const grid = new Graphics();
  const step = 500;
  for (let v = 0; v <= MAP_SIZE; v += step) {
    grid.moveTo(v, 0).lineTo(v, MAP_SIZE);
    grid.moveTo(0, v).lineTo(MAP_SIZE, v);
  }
  grid.stroke({ color: 0x2a2420, width: 2 });
  grid.rect(0, 0, MAP_SIZE, MAP_SIZE).stroke({ color: 0x4a3f36, width: 6 });
  return grid;
}
