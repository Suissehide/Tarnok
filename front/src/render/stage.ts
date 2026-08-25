import { MAP_SIZE, TICK_HZ } from '@shared/constants';
import type { Horde } from '@shared/horde';
import type { Projectiles } from '@shared/projectiles';
import { Application, Container, Graphics, Rectangle } from 'pixi.js';

import type { DerivedOrbs, HitFlashes, RenderState, RunOverSummary } from '../net/client';
import { ASSETS_BASE } from '../ui/config';
import { HordeRenderer } from './horde-renderer';
import { ImpactFlashRenderer, OrbRenderer, ProjectileRenderer } from './projectile-renderer';

/**
 * La scene du jeu : la carte, la horde, et un carre par joueur.
 *
 * Les joueurs restent quatre `Graphics` — a cette echelle, un objet par
 * entite ne coute rien, et rien ne justifierait le batching. La horde, elle,
 * est deleguee a `HordeRenderer` : c'est la ou vit le `ParticleContainer` et
 * l'atlas de la tache 11-12, la decision d'y passer etant venue d'une mesure
 * (etape 1), pas d'une intuition. `Stage` ne fait qu'orchestrer les deux :
 * ordre d'affichage, camera commune, et le rectangle de vue qui sert de
 * culling a la horde (`viewRect`).
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
  readonly #orbs = new OrbRenderer();
  readonly #projectiles = new ProjectileRenderer();
  readonly #impactFlashes = new ImpactFlashRenderer();

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
    // sous la horde. Les orbes (ramassage au sol) passent avant la horde ;
    // les projectiles et les flashs d'impact passent apres, pour rester
    // visibles par-dessus les monstres qu'ils visent.
    this.#orbs.attach(this.#world);
    this.#horde.attach(this.#world);
    this.#projectiles.attach(this.#world);
    this.#impactFlashes.attach(this.#world);

    // Textures procedurales (canevas 2D) : aucun fetch reseau, ne peut pas
    // echouer comme le chargement de l'atlas ci-dessous — pas de try/catch
    // necessaire ici.
    this.#orbs.load();
    this.#projectiles.load();
    this.#impactFlashes.load();

    // Constat I4 : sans ce try/catch, un atlas absent (404 sur le manifeste,
    // deploiement ou l'atlas n'a pas ete depose sur MinIO) fait echouer cette
    // promesse. `main.ts` fait `await stage.init(...)` au niveau module ; une
    // rejection y arrete l'evaluation du module AVANT que les gestionnaires de
    // clic ne soient installes — lobby mort, sans le moindre message. Mieux
    // vaut demarrer sans horde visible que bloquer tout le jeu pour un asset
    // manquant. `HordeRenderer.draw` sait deja ne rien faire tant que
    // `#loaded` est faux.
    try {
      await this.#horde.load();
    } catch (cause) {
      console.error(
        "atlas de la horde indisponible, la horde ne sera pas dessinee. L'a-t-on deploye sur MinIO ? (voir docs/plans/2026-08-24-etape-2-resultats.md §5.1)",
        cause,
      );
    }
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

  /**
   * Force un rendu immediat, sans attendre le ticker.
   *
   * Le ticker Pixi passe par `requestAnimationFrame`, suspendu dans un onglet
   * en arriere-plan : la scene peut etre a jour en memoire (apres `draw` /
   * `drawHorde`) sans que le canevas ne le reflete jamais. Utile a la poignee
   * de debogage `__tarnok` (developpement uniquement), mais reste publique et
   * anodine — elle ne fuit pas l'`Application` Pixi complete.
   */
  renderNow(): void {
    this.#app.renderer.render(this.#app.stage);
  }

  /**
   * Convertit un point ECRAN (par exemple la position du curseur, relative au
   * canevas) en coordonnees MONDE, via la MEME camera que celle qui positionne
   * `#world` dans `#centerOn` — jamais une reconstruction approximative a
   * cote. C'est la regle de la tache 13 : le curseur vit en coordonnees
   * ecran, la visee est une direction monde, et faire cette conversion
   * ailleurs qu'ici ferait deriver la visee des que la camera bouge.
   *
   * `VERTICAL_SQUASH` n'affecte que l'axe Y (§4.5 : vue de dessus ecrasee),
   * d'ou la division qui n'apparait que sur `y`.
   */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: screenX - this.#world.x,
      y: (screenY - this.#world.y) / VERTICAL_SQUASH,
    };
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

  drawOrbs(orbs: DerivedOrbs, timeMs: number): void {
    this.#orbs.draw(orbs, this.viewRect(), timeMs);
  }

  drawProjectiles(projectiles: Projectiles): void {
    this.#projectiles.draw(projectiles, this.viewRect());
  }

  /** `nowMs` doit etre la meme horloge murale que celle passee a `GameClient` (voir `ImpactFlashRenderer`). */
  drawImpactFlashes(flashes: HitFlashes, nowMs: number): void {
    this.#impactFlashes.draw(flashes, nowMs);
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

/**
 * Contenu du HUD (§4.6 : un HUD, pas des logs), separe de son ecriture DOM
 * dans `main.ts` — cette fonction est PURE, sans Pixi ni `document`, pour
 * rester testable sans navigateur : c'est elle qui porte « le HUD reflete
 * les points de vie et l'experience du snapshot ».
 */
export interface HudInfo {
  hp: number;
  xp: number;
  level: number;
  timer: string;
}

/**
 * `level` et `hordeTick` ne sont pas dans `RenderState` : le niveau vient de
 * `GameClient.level` (derive des `LEVEL_UP`, pas de l'xp seul — voir sa
 * doc), et le tick de `GameClient.hordeTick`. Le HUD lit donc les deux
 * directement sur le client, en plus de `state`.
 */
export function hudInfo(state: RenderState, level: number, hordeTick: number): HudInfo {
  const me = state.players.find((p) => p.id === state.localId);
  return {
    hp: me?.hp ?? 0,
    xp: state.xp,
    level,
    timer: formatTimer(hordeTick),
  };
}

/** `ticks` -> `m:ss`, a `TICK_HZ` pas par seconde. Utilise par le HUD et par `formatSummary`. */
export function formatTimer(ticks: number): string {
  const totalSeconds = Math.max(0, Math.floor(ticks / TICK_HZ));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Contenu de l'ecran de bilan, tel que porte par `RUN_OVER` (§7) — pure, meme raison que `hudInfo`. */
export interface SummaryInfo {
  time: string;
  level: number;
  kills: number;
}

export function formatSummary(summary: RunOverSummary): SummaryInfo {
  return {
    time: formatTimer(summary.survivedTicks),
    level: summary.level,
    kills: summary.kills,
  };
}
