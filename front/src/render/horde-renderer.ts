import { MAP_SIZE, PROJECTILE_HIT_RADIUS } from '@shared/constants';
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

/** Une planche empaquetee (course ou attaque) : ses images, dans l'ordre du cycle. */
interface AtlasClip {
  frames: number;
  rects: { x: number; y: number; w: number; h: number }[];
}

/**
 * Boite englobante du contenu NON TRANSPARENT d'un archetype, en pixels de
 * cellule native — publiee par `tools/build_monster_atlas.py` (tache 17.1),
 * union sur TOUTES les images (course + attaque) pour donner une echelle
 * unique qui ne varie pas d'une image d'animation a l'autre. Voir
 * `contentSizePx`.
 */
interface ContentBounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface AtlasManifest {
  image: string;
  size: number;
  archetypes: {
    id: number;
    name: string;
    cell: number;
    bounds: ContentBounds;
    clips: { run: AtlasClip; attack: AtlasClip };
  }[];
}

/** Images par seconde de l'animation, comme le pack (§12.2 de l'orientation). */
const ANIM_FPS = 10;

/**
 * Hauteur d'une bande de tri. Voir `#depthSort`.
 *
 * ⚠️ **Valait 64 px, et c'etait la cause du clignotement de z-index** remonte a
 * la verification manuelle de l'etape 3. Le commentaire d'origine justifiait ce
 * chiffre par « a l'interieur d'une bande, l'ordre est indifferent — c'est la
 * hauteur d'un demi-sprite ». C'est faux, et exactement a l'envers : sur un
 * demi-sprite de haut, deux entites se **recouvrent presque totalement**, donc
 * savoir laquelle passe devant est on ne peut plus visible. L'ordre intra-bande
 * suit l'ordre du tableau, qui n'a aucun rapport avec `y` — et il change des
 * qu'une des deux franchit une frontiere de bande.
 *
 * Mesure, 300 entites sur 40 images, en comptant les inversions d'ordre de
 * dessin que **rien dans les `y` ne justifie** :
 *
 * | Bande | Inversions injustifiees |
 * | --- | --- |
 * | 64 px | 1,99 % des paires |
 * | 16 px | 1,00 % |
 * | 8 px | 0,60 % |
 * | 4 px | 0,34 % |
 * | **2 px** | **0,15 %** |
 *
 * Le residuel a 2 px ne concerne que des entites separees de moins de deux
 * pixels en `y`, ou la profondeur est de toute facon ambigue.
 *
 * ⚠️ Deux fausses pistes ecartees par la mesure, pour qu'on ne les reprenne pas :
 * la corruption du tri par un `bandOf` hors bornes (il est garde depuis
 * toujours), et l'instabilite de l'ordre du tableau apres compaction — un
 * departage stable par identite a ete essaye et ne change **rien**
 * (31 228 inversions contre 31 698). Le coupable est la largeur de bande, seule.
 *
 * Le cout ne bouge pas : le tri par comptage est en `O(entites + bandes)`, et
 * passer de 94 a 3 001 bandes ajoute deux parcours de tableau typé par image.
 */
export const DEPTH_BAND = 2;

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

/**
 * Echelle de dessin d'un monstre, DERIVEE de `PROJECTILE_HIT_RADIUS` — jamais
 * l'inverse.
 *
 * Tache 16 : un sprite se dessinait a 192 px (la cellule native de l'atlas,
 * dessinee 1:1) pour une hitbox de tir de 64 px de diametre — trois fois trop
 * grand, on tirait sur le corps et le projectile passait au travers. Ecrire
 * une echelle reglee a la main a cote d'une hitbox reglee a la main est
 * exactement ce qui a produit ce defaut ; le tableau « Coherence des
 * constantes » du plan existe pour l'empecher.
 *
 * ⚠️ Tache 17.1 : la tache 16 appelait cette fonction avec la CELLULE (192 px)
 * — mais une cellule de Tiny Swords est en grande partie vide, la creature
 * n'en occupe qu'une fraction. Ramener le CADRE a la hitbox rend alors le
 * CORPS bien plus petit qu'elle, exactement l'inverse du but (« les monstres
 * sont minuscules » remonte en jeu). Cette fonction reste correcte et
 * inchangee — c'est `sizePx` qui doit desormais etre la taille du CONTENU
 * (`contentSizePx`), jamais celle de la cellule. Voir le site d'appel dans
 * `load()`.
 *
 * La relation choisie est la plus simple qui se laisse enoncer sans ajouter
 * un second reglage a cote du premier : la largeur dessinee du CONTENU EGALE
 * le diametre de la hitbox de tir. Un facteur de generosite supplementaire
 * (« un peu plus grand pour que ca se voie ») retomberait dans le meme piege
 * — un nombre choisi au ressenti, non derive de la hitbox qu'il est cense
 * representer.
 *
 * Prend la taille en parametre plutot qu'une constante figee : les plus gros
 * archetypes de `shared/archetypes.ts` (ours, panda, tortue, minotaure,
 * troll) ont une cellule de 256 a 384 px, pas 192 — la meme formule doit les
 * ramener au meme diametre a l'ecran, puisque `PROJECTILE_HIT_RADIUS` ne
 * varie pas par archetype.
 */
export function spriteScale(sizePx: number, hitRadiusPx: number): number {
  if (sizePx <= 0) {
    return 1;
  }
  return (2 * hitRadiusPx) / sizePx;
}

/** Applique `spriteScale` a une taille par archetype — un facteur par archetype. */
export function archetypeScales(
  sizesPx: readonly number[],
  hitRadiusPx: number,
): Float32Array<ArrayBuffer> {
  const out = new Float32Array(sizesPx.length);
  for (let i = 0; i < sizesPx.length; i++) {
    out[i] = spriteScale(sizesPx[i] ?? 0, hitRadiusPx);
  }
  return out;
}

/**
 * Taille de reference d'un contenu d'atlas, pour `spriteScale` (tache 17.1) :
 * la plus GRANDE des deux dimensions de sa boite englobante.
 *
 * Pas la largeur ni la hauteur seules : une silhouette allongee dans un sens
 * (un lezard qui court, tres large et peu haut) ne doit pas recevoir une
 * echelle calculee sur sa dimension la plus petite, ce qui la ferait deborder
 * du diametre de la hitbox precisement dans le sens ou elle s'etend le plus.
 */
export function contentSizePx(bounds: { readonly w: number; readonly h: number }): number {
  return Math.max(bounds.w, bounds.h);
}

/**
 * Choix du clip anime a dessiner (tache 17.2) : RENDU PUR, deduit de l'etat
 * d'arret DEJA simule (`horde.stopped`, `shared/horde.ts`) — jamais recalcule
 * ici a partir d'une distance, jamais transmis sur le fil. Isolee pour se
 * tester sans le reseau/canevas qu'exige `load()`, meme raison que
 * `spriteScale`/`facingScaleX` plus haut.
 */
export function selectClip<T>(stopped: boolean, run: T, attack: T): T {
  return stopped ? attack : run;
}

/**
 * En dessous de ce deplacement horizontal (en px, entre deux images
 * consecutives), `dx` est trop proche de zero pour trancher un sens sans
 * bruit : un deplacement quasi vertical, ou une entite immobile entre deux
 * pas de simulation (le rendu tourne a la cadence de l'ecran, la simulation a
 * `TICK_HZ` — la plupart des images ne changent aucune position). Voir
 * `facingScaleX`.
 */
export const FACING_DEAD_ZONE_PX = 0.05;

/**
 * Au-dessus de ce deplacement horizontal, `dx` est trop grand pour etre le
 * deplacement REEL d'une entite d'une image a l'autre — c'est le signe qu'un
 * creneau a change d'identite, pas qu'un monstre a bondi.
 *
 * `Horde.#removeAt` compacte par permutation avec la derniere entite vivante
 * (voir `shared/horde.ts`) : un creneau peut donc porter une entite
 * differente d'une image a l'autre, avec une position sans rapport. Le pas le
 * plus rapide qu'un VRAI monstre puisse franchir en un tick est borne par
 * `archetypeOf(...).speed` (95 a 130 px/s dans `shared/archetypes.ts`) plus
 * la repulsion de separation au pire cas de recouvrement
 * (`SEPARATION_STRENGTH = 1200 px/s` dans `shared/constants.ts`) : soit, a
 * `TICK_HZ = 30`, environ 4,3 + 40 = 44 px par tick. Ce seuil double cette
 * borne avec une marge confortable, tout en restant tres inferieur a la
 * distance separant deux points choisis sans rapport sur une carte de
 * `MAP_SIZE = 6000` px — c'est cet ecart d'ordre de grandeur qui rend le
 * departage fiable, pas une precision au pixel pres.
 */
export const FACING_MAX_STEP_PX = 96;

/**
 * Signe de `scaleX` d'un sprite de monstre, DEDUIT du seul deplacement
 * horizontal observe depuis la derniere image (`dx = x - xPrecedent`).
 *
 * ⚠️ Rendu pur : aucun champ nouveau dans `Horde`, aucun octet de plus sur le
 * fil (voir la doc de `HordeRenderer#draw`). Tout ce qu'il faut est deja dans
 * `horde.x`, que le client possede a chaque image.
 *
 * Deux gardes (voir leurs constantes) : sous `FACING_DEAD_ZONE_PX`, `dx` ne
 * permet pas de trancher un sens ; au-dessus de `FACING_MAX_STEP_PX`, `dx` ne
 * peut pas etre un vrai deplacement. Dans les deux cas, on conserve `previous`
 * plutot que de papillotter ou de suivre un saut de compaction.
 */
export function facingScaleX(dx: number, previous: 1 | -1): 1 | -1 {
  const magnitude = Math.abs(dx);
  if (magnitude < FACING_DEAD_ZONE_PX || magnitude > FACING_MAX_STEP_PX) {
    return previous;
  }
  return dx > 0 ? 1 : -1;
}

export class HordeRenderer {
  readonly #container = new ParticleContainer({
    // `vertex` : necessaire pour que `scaleX`/`scaleY` (mise a l'echelle
    // depuis la hitbox, orientation gauche/droite) soient reteleversees a
    // chaque image — voir `spriteScale` et `facingScaleX`. Le conteneur des
    // flashs d'impact (`projectile-renderer.ts`) fait deja ce meme choix pour
    // la meme raison.
    dynamicProperties: { position: true, uvs: true, vertex: true, color: false, rotation: false },
  });
  /** Réservoir de particules réutilisées : aucune allocation en régime établi. */
  readonly #pool: Particle[] = [];
  /**
   * `#runFrames[archetype][image]` / `#attackFrames[archetype][image]` —
   * tache 17.2 : deux clips par archetype, choisis par `selectClip` selon
   * `horde.stopped`. Auparavant un seul `#frames` (course uniquement) :
   * l'atlas n'embarquait pas l'attaque.
   */
  #runFrames: Texture[][] = [];
  #attackFrames: Texture[][] = [];
  /** `#scale[archetype]` : voir `spriteScale`/`contentSizePx`, calculee une fois dans `load()`. */
  #scale = new Float32Array(0);
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
  /**
   * `#prevX[slot]` : abscisse tenue par ce creneau a l'image precedente, et
   * `#facing[slot]` (-1 ou 1) : le sens qui en a ete deduit. Tous deux
   * dimensionnes sur `horde.capacity` et jamais realloues, meme discipline
   * que `#visible`/`#sorted` — voir `#ensureSortBuffers`.
   *
   * Purement cosmetique : aucune des deux valeurs ne sort jamais de ce
   * fichier, ni ne participe a la simulation (tache 16, etape 2).
   */
  #prevX = new Float32Array(0);
  #facing = new Int8Array(0);

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

    const texturesOf = (clip: AtlasClip): Texture[] =>
      clip.rects.map(
        (r) =>
          new Texture({
            source: atlas.source,
            frame: new Rectangle(r.x, r.y, r.w, r.h),
          }),
      );
    this.#runFrames = manifest.archetypes.map((a) => texturesOf(a.clips.run));
    this.#attackFrames = manifest.archetypes.map((a) => texturesOf(a.clips.attack));
    // Un facteur d'echelle par archetype, DERIVE de `PROJECTILE_HIT_RADIUS` —
    // voir `spriteScale`. Tache 17.1 : a partir du CONTENU non transparent
    // (`contentSizePx`), pas de la cellule — une cellule de Tiny Swords est en
    // grande partie vide, et la rapporter a la hitbox rendait le corps de la
    // creature bien plus petit qu'elle. Les archetypes n'ont pas tous la meme
    // cellule native (192 a 384 px, `shared/archetypes.ts`), la hitbox de
    // tir, elle, ne varie pas : chacun doit donc recevoir SON propre facteur.
    this.#scale = archetypeScales(
      manifest.archetypes.map((a) => contentSizePx(a.bounds)),
      PROJECTILE_HIT_RADIUS,
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

      // Orientation (tache 16, etape 2) : deduite ici, sur TOUTE la horde et
      // pas seulement les entites visibles, dans cette meme passe deja en
      // O(horde.count) — pas de second parcours pour un cout de rendu qui ne
      // doit pas grandir. Une entite hors-vue garde ainsi un sens a jour des
      // qu'elle revient dans le cadre, au lieu d'un sens fige perime.
      const previousFacing: 1 | -1 = (this.#facing[i] ?? 0) === -1 ? -1 : 1;
      this.#facing[i] = facingScaleX(x - (this.#prevX[i] ?? 0), previousFacing);
      this.#prevX[i] = x;

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
      const archetype = horde.archetype[i] ?? 0;
      // Tache 17.2 : le clip est du rendu pur, deduit de l'etat d'arret DEJA
      // simule (`horde.stopped`) — voir `selectClip`. Jamais recalcule ici a
      // partir d'une distance : ce calcul-la vit dans `Horde.retarget`
      // (`shared/horde.ts`), pour rester identique des deux cotes.
      const stopped = (horde.stopped[i] ?? 0) === 1;
      const frames = selectClip(stopped, this.#runFrames[archetype], this.#attackFrames[archetype]);
      if (!particle || !frames || frames.length === 0) {
        continue;
      }

      particle.x = horde.x[i] ?? 0;
      particle.y = horde.y[i] ?? 0;
      // La phase decale le cycle : sans elle, mille cranes marchent au pas, et
      // ca se voit immediatement.
      particle.texture = frames[(animStep + (horde.animPhase[i] ?? 0)) % frames.length] as Texture;
      // Taille DERIVEE de la hitbox de tir (`spriteScale`), retournee vers la
      // gauche quand l'entite s'y deplace (`facingScaleX`) : l'atlas dessine
      // ses cycles de course vers la droite (verifie sur les feuilles source),
      // donc `scaleX` negatif est la seule des deux mises a l'echelle a
      // changer de signe.
      const scale = this.#scale[archetype] ?? 1;
      particle.scaleX = scale * (this.#facing[i] === -1 ? -1 : 1);
      particle.scaleY = scale;
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
   * et un rangement en compartiments. A l'interieur d'une bande, l'ordre suit
   * le tableau et n'a donc aucun rapport avec `y` — c'est pourquoi la bande
   * doit rester **etroite** (voir `DEPTH_BAND`) ; **entre** bandes, l'ordre
   * croissant en `y` est respecte, sans quoi une entite basse passerait
   * derriere une entite haute.
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
    // Memes garanties que les deux tableaux ci-dessus (ne grandit jamais que
    // vers le haut, jamais realloue hors de cette fonction) : voir la doc de
    // `#prevX`/`#facing`.
    this.#prevX = new Float32Array(capacity);
    this.#facing = new Int8Array(capacity);
  }

  #ensurePool(needed: number): void {
    const first = this.#runFrames[0]?.[0];
    if (!first) {
      return;
    }
    while (this.#pool.length < needed) {
      this.#pool.push(new Particle({ texture: first, anchorX: 0.5, anchorY: 0.75 }));
    }
  }
}
