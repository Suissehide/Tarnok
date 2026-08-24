import { MAP_SIZE } from '@shared/constants';
import type { Horde } from '@shared/horde';
import { Assets, type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

/**
 * Rendu batché de la pietaille.
 *
 * Un seul `ParticleContainer`, un seul atlas. Le §4.3 de l'orientation est
 * categorique : « le GPU se moque de 1 500 quads ; ce qui tue, c'est le cout
 * JavaScript par objet et par transform ». Le banc de l'etape 1 a chiffre
 * l'ecart avec des objets `Sprite` : x6.
 *
 * `uvs` en propriete dynamique permet l'animation ; `color` donnera gratuitement
 * la teinte elementaire du §6.6 a l'etape 5, sans rien reecrire ici.
 */

interface AtlasManifest {
  image: string;
  size: number;
  archetypes: {
    id: number;
    name: string;
    cell: number;
    frames: number;
    rects: { x: number; y: number; w: number; h: number }[];
  }[];
}

/** Images par seconde de l'animation, comme le pack (§12.2 de l'orientation). */
const ANIM_FPS = 10;

/** Hauteur d'une bande de tri. Voir `#depthSort`. */
const DEPTH_BAND = 64;

/** Marge autour de la vue, pour qu'une entite n'apparaisse pas en plein ecran. */
const CULL_MARGIN = 128;

/**
 * Marge des bornes explicites du `ParticleContainer`, pour absorber les
 * sprites qui depassent leur point d'ancrage (pieds, §12.3 de l'orientation).
 * Un `ParticleContainer` ne calcule pas ses bornes automatiquement — sans
 * `boundsArea`, son getter de bornes renvoie un rectangle vide statique, et le
 * culling comme toute extraction se comportent mal.
 */
const BOUNDS_MARGIN = 256;

export class HordeRenderer {
  readonly #container = new ParticleContainer({
    dynamicProperties: { position: true, uvs: true, color: false, rotation: false },
  });
  /** Réservoir de particules réutilisées : aucune allocation en régime établi. */
  readonly #pool: Particle[] = [];
  /** `#frames[archetype][image]`. */
  #frames: Texture[][] = [];
  #loaded = false;

  constructor(private readonly assetsBase: string) {
    // Bornes explicites couvrant la carte entiere : voir le commentaire de
    // `BOUNDS_MARGIN`.
    this.#container.boundsArea = new Rectangle(
      -BOUNDS_MARGIN,
      -BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
    );
  }

  async load(): Promise<void> {
    const manifest = (await fetch(`${this.assetsBase}/derived/monsters.json`).then((r) =>
      r.json(),
    )) as AtlasManifest;
    // `Texture.from` est synchrone : elle ne telecharge rien. Il faut passer
    // par `Assets.load` pour recuperer l'atlas depuis son URL.
    const atlas = await Assets.load<Texture>(`${this.assetsBase}/derived/${manifest.image}`);

    this.#frames = manifest.archetypes.map((a) =>
      a.rects.map(
        (r) =>
          new Texture({
            source: atlas.source,
            frame: new Rectangle(r.x, r.y, r.w, r.h),
          }),
      ),
    );
    this.#loaded = true;
  }

  attach(parent: Container): void {
    parent.addChild(this.#container);
  }

  /**
   * Dessine les entites visibles.
   *
   * Le client **simule** toute la horde mais ne **dessine** que ce que la
   * camera voit. Le §4.5 rappelle pourquoi la vue de dessus rend ce filtrage
   * trivial : la fenetre visible est un rectangle aligne sur les axes du monde.
   */
  draw(horde: Horde, view: Rectangle, timeMs: number): void {
    if (!this.#loaded) {
      return;
    }

    const minX = view.x - CULL_MARGIN;
    const maxX = view.x + view.width + CULL_MARGIN;
    const minY = view.y - CULL_MARGIN;
    const maxY = view.y + view.height + CULL_MARGIN;
    const animStep = Math.floor((timeMs / 1000) * ANIM_FPS);

    const visible: number[] = [];
    for (let i = 0; i < horde.count; i++) {
      const x = horde.x[i] ?? 0;
      const y = horde.y[i] ?? 0;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        visible.push(i);
      }
    }

    this.#depthSort(horde, visible);
    this.#ensurePool(visible.length);

    const children = this.#container.particleChildren;
    children.length = 0;

    for (let n = 0; n < visible.length; n++) {
      const i = visible[n] ?? 0;
      const particle = this.#pool[n];
      const frames = this.#frames[horde.archetype[i] ?? 0];
      if (!particle || !frames || frames.length === 0) {
        continue;
      }

      particle.x = horde.x[i] ?? 0;
      particle.y = horde.y[i] ?? 0;
      // La phase decale le cycle : sans elle, mille cranes marchent au pas, et
      // ca se voit immediatement.
      particle.texture = frames[(animStep + (horde.animPhase[i] ?? 0)) % frames.length] as Texture;
      children.push(particle);
    }

    this.#container.update();
  }

  destroy(): void {
    this.#container.destroy();
  }

  /**
   * Tri en profondeur par **compartiments**, pas par `sort()` global.
   *
   * Un `ParticleContainer` dessine dans l'ordre du tableau. Le §4.5 tranche
   * deja : a 1 500 entites, c'est la difference entre un tri complet par image
   * et un rangement en compartiments. A l'interieur d'une bande de 64 px,
   * l'ordre est indifferent — c'est la hauteur d'un demi-sprite.
   */
  #depthSort(horde: Horde, visible: number[]): void {
    const bands = new Map<number, number[]>();
    for (const i of visible) {
      const band = Math.floor((horde.y[i] ?? 0) / DEPTH_BAND);
      const bucket = bands.get(band);
      if (bucket) {
        bucket.push(i);
      } else {
        bands.set(band, [i]);
      }
    }

    visible.length = 0;
    for (const band of [...bands.keys()].sort((a, b) => a - b)) {
      for (const i of bands.get(band) ?? []) {
        visible.push(i);
      }
    }
  }

  #ensurePool(needed: number): void {
    const first = this.#frames[0]?.[0];
    if (!first) {
      return;
    }
    while (this.#pool.length < needed) {
      this.#pool.push(new Particle({ texture: first, anchorX: 0.5, anchorY: 0.75 }));
    }
  }
}
