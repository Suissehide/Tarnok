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
 *
 * Aucun de `draw()`, `#depthSort()` ou `#ensurePool()` n'alloue en regime
 * etabli : reservoir de particules, tableaux de comptage et tableau
 * d'indices sont tous poses une fois puis reutilises. C'est le meme §4.3 qui
 * le justifie — a soixante images par seconde, un objet jete par image est un
 * objet jete soixante fois par seconde.
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

/**
 * Nombre de bandes couvrant la carte, calcule une fois pour toutes : `y` est
 * borne a `[0, MAP_SIZE]` par la simulation (`shared/horde.ts`,
 * `shared/separation.ts`), donc ce nombre ne varie jamais en cours de partie.
 *
 * Exporte pour le test (tache 15) : `bandOf` et `sortByDepth` se verifient
 * directement sans passer par `draw()`, qui exige un atlas charge (reseau,
 * indisponible en test).
 */
export const BAND_COUNT = Math.floor(MAP_SIZE / DEPTH_BAND) + 1;

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

/**
 * Bande de tri d'une ordonnee, bornee a `[0, BAND_COUNT - 1]`.
 *
 * `y` est deja cense rester dans `[0, MAP_SIZE]` (voir `BAND_COUNT`), mais un
 * indice hors bornes silencieux dans un tableau type (lecture `undefined`,
 * ecriture ignoree) corromprait le tri sans jamais lever d'erreur. Le clamp
 * est le prix, negligeable, de ne jamais avoir a s'en inquieter.
 *
 * Exportee (tache 15) : c'est la seule garde entre une position hors carte
 * et une ecriture hors bornes dans `sortByDepth`, donc elle merite un test
 * direct plutot qu'une confiance aveugle dans son appelant.
 */
export function bandOf(y: number): number {
  const band = Math.floor(y / DEPTH_BAND);
  if (band < 0) {
    return 0;
  }
  if (band >= BAND_COUNT) {
    return BAND_COUNT - 1;
  }
  return band;
}

/**
 * Tri en profondeur par comptage, pur : deux passes lineaires sur `visible`,
 * sans allocation, ecrivant dans les tampons fournis par l'appelant.
 *
 * Extrait de `HordeRenderer#depthSort` (tache 15) pour etre teste directement
 * sans dependre du chargement de l'atlas (reseau/canevas absents en test) —
 * la classe elle-meme se contente d'appeler cette fonction avec ses propres
 * tampons prives, comportement inchange.
 */
export function sortByDepth(
  y: Float32Array,
  visible: Int32Array,
  visibleCount: number,
  bandCounts: Uint32Array,
  bandOffsets: Uint32Array,
  sorted: Int32Array,
): void {
  bandCounts.fill(0);

  // Passe 1 : combien d'entites dans chaque bande.
  for (let n = 0; n < visibleCount; n++) {
    const i = visible[n] ?? 0;
    const band = bandOf(y[i] ?? 0);
    bandCounts[band] = (bandCounts[band] ?? 0) + 1;
  }

  // Sommes prefixees : offset de depart de chaque bande dans `sorted`.
  bandOffsets[0] = 0;
  for (let b = 0; b < BAND_COUNT; b++) {
    bandOffsets[b + 1] = (bandOffsets[b] ?? 0) + (bandCounts[b] ?? 0);
  }

  // Passe 2 : place chaque entite a son offset. `bandCounts` est reutilise
  // comme curseur d'ecriture par bande — les sommes prefixees ci-dessus n'en
  // ont plus besoin, ca evite un troisieme tableau.
  bandCounts.fill(0);
  for (let n = 0; n < visibleCount; n++) {
    const i = visible[n] ?? 0;
    const band = bandOf(y[i] ?? 0);
    const cursor = (bandOffsets[band] ?? 0) + (bandCounts[band] ?? 0);
    sorted[cursor] = i;
    bandCounts[band] = (bandCounts[band] ?? 0) + 1;
  }
}

export class HordeRenderer {
  readonly #container = new ParticleContainer({
    dynamicProperties: { position: true, uvs: true, color: false, rotation: false },
  });
  /** Réservoir de particules réutilisées : aucune allocation en régime établi. */
  readonly #pool: Particle[] = [];
  /** `#frames[archetype][image]`. */
  #frames: Texture[][] = [];
  #loaded = false;

  /**
   * Tampons du tri par comptage (`#depthSort`), dimensionnes au premier appel
   * sur la capacite de la horde puis jamais realloues — voir `#ensureSortBuffers`.
   */
  #visible = new Int32Array(0);
  #sorted = new Int32Array(0);
  /** `#bandCounts[b]` : nombre d'entites visibles dans la bande `b`. Remis a zero et reecrit a chaque image, jamais realloue — `BAND_COUNT` est constant. */
  readonly #bandCounts = new Uint32Array(BAND_COUNT);
  /** Sommes prefixees : offset de depart de chaque bande dans `#sorted`. */
  readonly #bandOffsets = new Uint32Array(BAND_COUNT + 1);

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

    this.#ensureSortBuffers(horde.capacity);

    const minX = view.x - CULL_MARGIN;
    const maxX = view.x + view.width + CULL_MARGIN;
    const minY = view.y - CULL_MARGIN;
    const maxY = view.y + view.height + CULL_MARGIN;
    const animStep = Math.floor((timeMs / 1000) * ANIM_FPS);

    // Tableau reutilise : on ecrit dans `#visible` sans jamais le reallouer,
    // `visibleCount` en est la longueur logique.
    const visible = this.#visible;
    let visibleCount = 0;
    for (let i = 0; i < horde.count; i++) {
      const x = horde.x[i] ?? 0;
      const y = horde.y[i] ?? 0;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        visible[visibleCount] = i;
        visibleCount++;
      }
    }

    const sorted = this.#depthSort(horde, visible, visibleCount);
    this.#ensurePool(visibleCount);

    const children = this.#container.particleChildren;
    children.length = 0;

    for (let n = 0; n < visibleCount; n++) {
      const i = sorted[n] ?? 0;
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
   * Tri en profondeur par **compartiments**, pas par `sort()` global — et par
   * **comptage**, pas par une `Map`.
   *
   * Un `ParticleContainer` dessine dans l'ordre du tableau. Le §4.5 tranche
   * deja : a 1 500 entites, c'est la difference entre un tri complet par image
   * et un rangement en compartiments. A l'interieur d'une bande de 64 px,
   * l'ordre est indifferent — c'est la hauteur d'un demi-sprite ; **entre**
   * bandes, l'ordre croissant en `y` doit etre respecte, sans quoi une entite
   * basse passerait derriere une entite haute.
   *
   * Le tri par comptage est lineaire et n'alloue rien : deux passes sur
   * `visible`, en s'appuyant sur des tampons de taille fixe (`#bandCounts`,
   * `#bandOffsets`, `#sorted`) reutilises d'une image a l'autre. Le §4.3 est
   * categorique sur ce point precis — le cout qui tue n'est pas le GPU, c'est
   * l'objet JavaScript alloue puis jete a chaque image ; une `Map` et ses
   * tableaux de bande, recrees soixante fois par seconde, sont exactement ce
   * cout-la.
   */
  #depthSort(horde: Horde, visible: Int32Array, visibleCount: number): Int32Array {
    sortByDepth(horde.y, visible, visibleCount, this.#bandCounts, this.#bandOffsets, this.#sorted);
    return this.#sorted;
  }

  /**
   * Dimensionne les tampons du tri sur la capacite de la horde — au pire cas
   * toutes les entites sont visibles a la fois. Ne fait que grandir, jamais
   * retrecir, et ne realloue pas si la capacite n'a pas change : en pratique,
   * une seule fois, a la premiere image.
   */
  #ensureSortBuffers(capacity: number): void {
    if (this.#visible.length >= capacity) {
      return;
    }
    this.#visible = new Int32Array(capacity);
    this.#sorted = new Int32Array(capacity);
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
