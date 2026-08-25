import { MAP_SIZE } from '@shared/constants';
import type { Projectiles } from '@shared/projectiles';
import { type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

import { type DerivedOrbs, HIT_FLASH_LIFETIME_MS, type HitFlashes } from '../net/client';

/**
 * Rendu des projectiles, des orbes et des flashs d'impact.
 *
 * Trois `ParticleContainer`s independants, meme discipline que
 * `HordeRenderer` : bornes explicites (`boundsArea`, voir sa doc — un
 * `ParticleContainer` ne les calcule jamais lui-meme), un reservoir de
 * `Particle` reutilise, aucune allocation en regime etabli dans `draw()`.
 *
 * Pas de tri en profondeur par bande ici, contrairement a la horde :
 * projectiles, orbes et flashs sont de petits points, sans la hauteur de
 * sprite qui rend l'ordre visible sur la vue ecrasee du §4.5 — l'ordre entre
 * particules d'un meme calque ne se voit pas a l'oeil.
 *
 * Textures procedurales (canvas 2D), pas un asset Tiny Swords : aucun atlas
 * dedie a ces elements n'existe encore sur MinIO (seul `derived/monsters.json`
 * existe a ce jour). Fabriquer un atlas ici sortirait du perimetre de cette
 * tache et risquerait la contrainte de licence (§4 du brief) ; un disque
 * radieux dessine au vol suffit pour un premier passage de rendu et peut
 * etre remplace par de l'art reel sans toucher a l'API de ces classes.
 */

/** Marge des bornes explicites, meme raisonnement que `HordeRenderer.BOUNDS_MARGIN`. */
const BOUNDS_MARGIN = 256;

function mapBoundsArea(): Rectangle {
  return new Rectangle(
    -BOUNDS_MARGIN,
    -BOUNDS_MARGIN,
    MAP_SIZE + 2 * BOUNDS_MARGIN,
    MAP_SIZE + 2 * BOUNDS_MARGIN,
  );
}

/**
 * Un disque radieux dessine une seule fois sur un canevas 2D, puis reutilise
 * comme texture unique de tout un `ParticleContainer` — exactement le « un
 * seul atlas pour tout ce qui est massif » du §4.3, degenere au cas le plus
 * simple : un seul quad.
 */
function makeGlowTexture(diameter: number, color: string): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = diameter;
  canvas.height = diameter;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  const r = diameter / 2;
  const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(0.35, color);
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  return Texture.from(canvas);
}

/** Rendu batché des projectiles (`shared/projectiles.ts`). */
export class ProjectileRenderer {
  readonly #container = new ParticleContainer({
    // Seule la position bouge d'une image a l'autre ; le reste (teinte,
    // rotation) ne change jamais une fois la texture choisie.
    dynamicProperties: { position: true, rotation: false, uvs: false, color: false },
  });
  readonly #pool: Particle[] = [];
  #texture: Texture | null = null;

  constructor() {
    // Bornes explicites couvrant la carte entiere : voir la doc de fichier.
    this.#container.boundsArea = mapBoundsArea();
  }

  /** Expose pour le test : lit ce que `HordeRenderer` pose aussi dans son constructeur. */
  get boundsArea(): Rectangle {
    return this.#container.boundsArea as Rectangle;
  }

  attach(parent: Container): void {
    parent.addChild(this.#container);
  }

  /**
   * Construit la texture procedurale. A appeler apres l'init de
   * l'`Application` — jamais dans le constructeur : `document` (canevas 2D)
   * n'existe que dans un navigateur, et ce renderer doit rester
   * construisible (et son `boundsArea` lisible) sans lui, comme l'exige le
   * test unitaire de ce fichier.
   */
  load(): void {
    this.#texture = makeGlowTexture(20, '#f2c14e');
  }

  draw(projectiles: Projectiles, view: Rectangle): void {
    const texture = this.#texture;
    if (!texture) {
      return;
    }
    this.#ensurePool(projectiles.count, texture);

    const minX = view.x;
    const maxX = view.x + view.width;
    const minY = view.y;
    const maxY = view.y + view.height;

    const children = this.#container.particleChildren;
    children.length = 0;
    let used = 0;
    for (let i = 0; i < projectiles.count; i++) {
      const x = projectiles.x[i] ?? 0;
      const y = projectiles.y[i] ?? 0;
      if (x < minX || x > maxX || y < minY || y > maxY) {
        continue;
      }
      const particle = this.#pool[used];
      if (!particle) {
        break;
      }
      particle.x = x;
      particle.y = y;
      children.push(particle);
      used++;
    }
    this.#container.update();
  }

  destroy(): void {
    this.#container.destroy();
  }

  #ensurePool(needed: number, texture: Texture): void {
    while (this.#pool.length < needed) {
      this.#pool.push(new Particle({ texture, anchorX: 0.5, anchorY: 0.5 }));
    }
  }
}

/** Rendu batché des orbes derivés (`DerivedOrbs`, `net/client.ts`). */
export class OrbRenderer {
  readonly #container = new ParticleContainer({
    // La pulsation (voir `draw`) fait bouger l'opacite chaque image.
    dynamicProperties: { position: true, color: true, rotation: false, uvs: false },
  });
  readonly #pool: Particle[] = [];
  #texture: Texture | null = null;

  constructor() {
    this.#container.boundsArea = mapBoundsArea();
  }

  get boundsArea(): Rectangle {
    return this.#container.boundsArea as Rectangle;
  }

  attach(parent: Container): void {
    parent.addChild(this.#container);
  }

  load(): void {
    this.#texture = makeGlowTexture(16, '#7fd858');
  }

  draw(orbs: DerivedOrbs, view: Rectangle, timeMs: number): void {
    const texture = this.#texture;
    if (!texture) {
      return;
    }
    this.#ensurePool(orbs.count, texture);

    const minX = view.x;
    const maxX = view.x + view.width;
    const minY = view.y;
    const maxY = view.y + view.height;

    const children = this.#container.particleChildren;
    children.length = 0;
    let used = 0;
    for (let i = 0; i < orbs.count; i++) {
      const x = orbs.x[i] ?? 0;
      const y = orbs.y[i] ?? 0;
      if (x < minX || x > maxX || y < minY || y > maxY) {
        continue;
      }
      const particle = this.#pool[used];
      if (!particle) {
        break;
      }
      particle.x = x;
      particle.y = y;
      // Pulsation douce, dephasee par orbe (via son tick de naissance) : un
      // signal de ramassage vivant au sol, sans jamais devenir le flash
      // « genereux » reserve a l'impact — le §4.3 les distingue explicitement.
      const phase = (orbs.bornTick[i] ?? 0) * 0.7;
      particle.alpha = 0.6 + 0.4 * Math.sin(timeMs / 260 + phase);
      children.push(particle);
      used++;
    }
    this.#container.update();
  }

  destroy(): void {
    this.#container.destroy();
  }

  #ensurePool(needed: number, texture: Texture): void {
    while (this.#pool.length < needed) {
      this.#pool.push(new Particle({ texture, anchorX: 0.5, anchorY: 0.5 }));
    }
  }
}

/** Echelle du flash a sa naissance (t=0) et juste avant de s'eteindre (t=1). Grandit en s'effacant. */
const FLASH_MIN_SCALE = 0.6;
const FLASH_MAX_SCALE = 2.4;

/**
 * Rendu batché des flashs d'impact (`HitFlashes`, `net/client.ts`).
 *
 * §4.3 : « le budget VFX passe dans un flash court, large et genereux, pas
 * dans un halo permanent ». Traduit ici en deux courbes sur la duree de vie
 * du flash (`t` de 0 a 1) : l'echelle GRANDIT (large) pendant que l'opacite
 * S'ETEINT (court) — l'effet inverse (un point qui reste allume) lirait
 * comme un halo continu, exactement ce que le §4.3 exclut.
 */
export class ImpactFlashRenderer {
  readonly #container = new ParticleContainer({
    dynamicProperties: { position: true, vertex: true, color: true, rotation: false, uvs: false },
  });
  readonly #pool: Particle[] = [];
  #texture: Texture | null = null;

  constructor() {
    this.#container.boundsArea = mapBoundsArea();
  }

  get boundsArea(): Rectangle {
    return this.#container.boundsArea as Rectangle;
  }

  attach(parent: Container): void {
    parent.addChild(this.#container);
  }

  load(): void {
    this.#texture = makeGlowTexture(48, '#ffe9b0');
  }

  /** `nowMs` doit etre la MEME horloge murale que celle passee a `HitFlashes.spawn`. */
  draw(flashes: HitFlashes, nowMs: number): void {
    const texture = this.#texture;
    if (!texture) {
      return;
    }
    this.#ensurePool(flashes.count, texture);

    const children = this.#container.particleChildren;
    children.length = 0;
    for (let i = 0; i < flashes.count; i++) {
      const particle = this.#pool[i];
      if (!particle) {
        break;
      }
      const age = nowMs - (flashes.bornMs[i] ?? 0);
      const t = Math.min(1, Math.max(0, age / HIT_FLASH_LIFETIME_MS));
      const scale = FLASH_MIN_SCALE + (FLASH_MAX_SCALE - FLASH_MIN_SCALE) * t;

      particle.x = flashes.x[i] ?? 0;
      particle.y = flashes.y[i] ?? 0;
      particle.scaleX = scale;
      particle.scaleY = scale;
      particle.alpha = 1 - t;
      children.push(particle);
    }
    this.#container.update();
  }

  destroy(): void {
    this.#container.destroy();
  }

  #ensurePool(needed: number, texture: Texture): void {
    while (this.#pool.length < needed) {
      this.#pool.push(new Particle({ texture, anchorX: 0.5, anchorY: 0.5 }));
    }
  }
}
