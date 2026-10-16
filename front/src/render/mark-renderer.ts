import { MAP_SIZE, PROJECTILE_HIT_RADIUS } from '@shared/constants';
import { ELEMENT, ELEMENTS, elementOf } from '@shared/elements';
import type { Horde } from '@shared/horde';
import { type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

import { BODY_SCALE } from './horde-renderer';
import {
  lookFlicker,
  lookOf,
  lookPulse,
  slotSeed,
  strokeLook,
  type ViewBounds,
} from './zone-renderer';

/**
 * L'anneau au sol sous un ennemi MARQUE : une ellipse fine sous ses pieds.
 *
 * ⚠️ **Ceci REMPLACE la teinte de sprite.** Teinter le sprite est gratuit dans
 * le batch Pixi, mais **invisible** : un crane de Tiny Swords est deja sombre
 * et bariole, le multiplier par 0xff7a3c ne change presque rien a l'ecran.
 *
 * ## Un anneau par ennemi marque, sans deduplication
 *
 * Dedoublonner par cellule de grille (deux ennemis proches partageant un
 * anneau) fait disparaitre des anneaux dans les melees. Le cout est donc
 * O(marques), borne par `horde.capacity` (= `MAX_ENTITIES` cote client) : au
 * pire autant de quads que la horde elle-meme, jamais plus, puisqu'un ennemi
 * porte au plus une marque.
 *
 * ⚠️ **Si un plafond redevenait necessaire, ce ne serait PAS une grille.** Un
 * plafond qui degrade par ordre de creneau se voit comme une disparition
 * aleatoire. Il faudrait garder les plus proches du joueur et compter ce qui
 * est jete, comme `Projectiles.truncated`.
 *
 * Le culling hors camera ne borne rien dans le cas qui compte (la horde
 * converge sur le joueur) : il evite seulement de payer une vague encore en
 * marche depuis le bord de carte.
 *
 * Meme discipline de conteneur que `zone-renderer.ts` : un
 * `ParticleContainer` additif, des bornes explicites, un reservoir de
 * `Particle` reutilise, aucune allocation en regime etabli.
 *
 * ⚠️ **Une silhouette par element, la meme qu'au sol** (`lookOf`) : flammes,
 * hexagone, dents, flaque, pointilles, anneaux ouverts. L'atlas est un seul
 * canevas, une case par element, et la particule change de case par `uvs` —
 * toujours UN conteneur, toujours un quad par ennemi marque. L'animation se
 * limite a la respiration et au scintillement : **pas de rotation ici**, parce
 * que la particule est aplatie (`MARK_RING_SQUASH`) et que Pixi tourne APRES
 * l'echelle — l'ellipse elle-meme pivoterait, et l'anneau ne serait plus pose
 * au sol. Les deux restent des produits par quad, sans branche par element.
 */

/** Marge des bornes explicites, meme raisonnement que `ZoneRenderer`. */
const BOUNDS_MARGIN = 256;

/**
 * **Largeur** de l'anneau dans le monde : le diametre de la hitbox de tir.
 *
 * ⚠️ **Derive, jamais regle a la main**, comme `spriteScale` et `zoneScale`.
 * Le corps dessine, lui, fait `BODY_SCALE` fois plus large : l'anneau est donc
 * visiblement plus etroit que la silhouette, ce qui le fait lire comme une base
 * au sol et non comme une aureole.
 *
 * ⚠️ **La LARGEUR seule.** L'anneau est une ellipse (`MARK_RING_SQUASH`) : sa
 * hauteur ne dit pas le rayon de la hitbox,
 * et n'a jamais eu a le dire. Un disque pose a plat au sol se projette en
 * ellipse — sa largeur est le diametre vrai, sa hauteur est la projection.
 */
export const MARK_RING_DIAMETER_PX = 2 * PROJECTILE_HIT_RADIUS;

/**
 * Aplatissement vertical de l'anneau, en coordonnees MONDE.
 *
 * Vue de dessus, un disque pose au sol ne se projette pas en cercle. L'anneau
 * garde sa largeur — qui dit le diametre de la hitbox — et perd de la hauteur.
 *
 * ⚠️ **NE PAS y recopier le `VERTICAL_SQUASH` (0,82) de `stage.ts` : la camera
 * l'applique DEJA.** Le monde entier est dessine avec `scale.set(1, 0,82)`,
 * donc un anneau circulaire en coordonnees monde arrive a l'ecran comme une
 * ellipse de rapport 0,82, encore trop ronde. Ce facteur-ci se COMPOSE avec celui-la : a l'ecran, l'anneau lit
 * 0,55 x 0,82 ≈ **0,45**. Recopier 0,82 ici l'appliquerait deux fois.
 */
export const MARK_RING_SQUASH = 0.55;

/**
 * De combien l'anneau descend sous la position de l'ennemi, pour se poser
 * **sous ses pieds**.
 *
 * ⚠️ Le corps est centre sur la position (`BODY_ANCHOR_Y = 0,5`, comme tous
 * les rayons de collision) : les pieds sont a une demi-hauteur de corps en
 * dessous — soit `PROJECTILE_HIT_RADIUS * BODY_SCALE`, puisque `spriteScale`
 * ramene la plus grande dimension du contenu a `2 * PROJECTILE_HIT_RADIUS *
 * BODY_SCALE`.
 *
 * **L'approximation** : c'est exact pour un contenu
 * plus HAUT que large (`contentSizePx` rend alors la hauteur), et l'anneau
 * descend de quelques pixels de trop pour une silhouette plus large que haute.
 * C'est le bon sens d'erreur : un anneau un peu bas reste une base, un anneau
 * un peu haut ceinture le ventre. Le decalage entre le centre de la CELLULE
 * d'atlas et celui du contenu n'est pas repris ici non plus.
 */
export const MARK_RING_FOOT_OFFSET_PX = PROJECTILE_HIT_RADIUS * BODY_SCALE;

/**
 * Opacite de l'anneau. **Bien plus haute que `ZONE_ALPHA`** : la marque doit
 * se voir.
 *
 * Les deux ne jouent pas le meme role et ne couvrent pas la meme surface. Une
 * zone est un aplat de 140 px de diametre dont plusieurs se recouvrent des
 * qu'un joueur arrose (voir `ZONE_ALPHA`). Un anneau est un TRAIT fin
 * (`MARK_RING_STROKE`), qui ne couvre qu'une
 * mince couronne de l'ellipse : meme un par ennemi, la surface d'encre totale
 * reste une petite fraction de celle qu'un aplat poserait.
 */
export const MARK_RING_ALPHA = 0.85;

/**
 * Cote de la texture d'anneau, en pixels. Ce n'est PAS la taille a l'ecran :
 * c'est la finesse du trait dessine, que `MARK_RING_SCALE` ramene ensuite a
 * `MARK_RING_DIAMETER_PX`. Meme role que `ZONE_TEXTURE_DIAMETER`.
 *
 * ⚠️ **DIFFERENT de `MARK_RING_DIAMETER_PX`, et il faut que ça le reste.** A
 * egalite, `MARK_RING_SCALE` vaudrait 1 et *toute* mutation de l'echelle
 * deviendrait indistinguable de l'absence d'echelle. Le double dessine deux
 * fois plus fin que ce qu'on affiche, ce qu'il faut au trait fin : un trait de 0,22 rayon sur une texture de 64 ne
 * ferait que 7 px de large, avec une rampe de 2 px.
 */
export const MARK_RING_TEXTURE_DIAMETER = 128;

/**
 * Facteur d'echelle HORIZONTAL d'une particule d'anneau : la texture doit
 * couvrir exactement `MARK_RING_DIAMETER_PX` pixels monde en largeur. La
 * verticale y ajoute `MARK_RING_SQUASH`.
 *
 * Une constante et non une fonction, contrairement a `zoneScale`/`spriteScale` :
 * les deux termes sont des constantes de ce module, donc il n'existe pas de
 * diviseur degenere a garder. Une garde `<= 0` ici serait morte.
 */
export const MARK_RING_SCALE = MARK_RING_DIAMETER_PX / MARK_RING_TEXTURE_DIAMETER;

/**
 * Epaisseur du trait, en fraction du rayon de la case. Sans rampe : un trait
 * de canevas est net par construction.
 */
const MARK_RING_STROKE = 0.16;

/** Bord exterieur de l'encre, en fraction du rayon : le trait s'arrete avant le bord du quad. */
const MARK_RING_OUTER = 0.94;

/**
 * Marge de culling : de quoi garder l'anneau d'un ennemi dont la position vient
 * de sortir du cadre mais dont l'anneau — pose PLUS BAS que lui — mord encore
 * dedans. Derivee du decalage et de la demi-largeur, jamais choisie ; la
 * demi-largeur majore la demi-hauteur puisque `MARK_RING_SQUASH < 1`.
 */
const CULL_MARGIN = MARK_RING_FOOT_OFFSET_PX + MARK_RING_DIAMETER_PX / 2;

/**
 * Choisit les ennemis qui recoivent un anneau : MARQUES et dans le cadre.
 * Ecrit leurs creneaux dans `out` et rend leur nombre — pure, sans allocation,
 * testable sans Pixi ni canevas, meme motif que `selectZones` et `sortByDepth`.
 *
 * ⚠️ **Un anneau par ennemi marque**, sans deduplication (voir l'en-tete). Le
 * compte est borne par `out.length`, que
 * `MarkRingRenderer#ensureBuffers` dimensionne sur `horde.capacity`.
 *
 * ⚠️ **`markAt`, jamais `horde.mark` directement** : une marque EXPIRE, et son
 * expiration est DERIVEE du seul `markUntil` (voir `Horde.markAt`). Lire le
 * tableau laisserait des anneaux allumes bien apres la fin de leur marque.
 *
 * ⚠️ **La branche `=== NEUTRE` est voulue** : c'est elle qui fait qu'un ennemi non marque ne coute AUCUN quad,
 * et donc que ce calque reste proportionnel aux marques et non a la horde.
 */
export function selectMarkedRings(
  horde: Horde,
  tick: number,
  view: ViewBounds,
  out: Int32Array,
): number {
  const minX = view.x - CULL_MARGIN;
  const maxX = view.x + view.width + CULL_MARGIN;
  const minY = view.y - CULL_MARGIN;
  const maxY = view.y + view.height + CULL_MARGIN;

  let count = 0;
  for (let i = 0; i < horde.count && count < out.length; i++) {
    if (horde.markAt(i, tick) === ELEMENT.NEUTRE) {
      continue;
    }
    const x = horde.x[i] ?? 0;
    const y = horde.y[i] ?? 0;
    if (x < minX || x > maxX || y < minY || y > maxY) {
      continue;
    }
    out[count] = i;
    count++;
  }
  return count;
}

/**
 * Atlas BLANC des anneaux, une case par element, cuit une fois puis teinte par
 * particule.
 *
 * ⚠️ **Blanc, parce que `Particle.tint` MULTIPLIE** : en blanc, `tint` rend exactement
 * `Element.tint`, sans qu'un element soit plus fidele qu'un autre.
 *
 * Chaque case est un TRAIT seul, sans lavis : un disque plein masquerait
 * l'ennemi qu'il designe. Trait fin : `MARK_RING_STROKE` du rayon, son bord exterieur a
 * `MARK_RING_OUTER` pour ne pas baver jusqu'au coin du quad.
 */
function makeRingAtlas(cell: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = cell * ELEMENTS.length;
  canvas.height = cell;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  const half = cell / 2;
  const lineWidth = half * MARK_RING_STROKE;
  const radius = half * MARK_RING_OUTER - lineWidth / 2;
  for (const element of ELEMENTS) {
    strokeLook(ctx, lookOf(element.id), element.id * cell + half, half, radius, lineWidth, 1);
  }
  return Texture.from(canvas);
}

export class MarkRingRenderer {
  readonly #container = new ParticleContainer({
    // Additif, comme les zones : l'anneau se pose SUR le sol deja teinte par la
    // zone qui l'a marque, et doit s'y ajouter au lieu de la masquer.
    blendMode: 'add',
    // `color` (teinte et scintillement), `uvs` (la case de l'element) et
    // `vertex` (la respiration) : le reservoir est REUTILISE — le creneau 3
    // peut porter une Braise a cette image et un Givre a la suivante.
    dynamicProperties: { position: true, color: true, rotation: false, uvs: true, vertex: true },
  });
  readonly #pool: Particle[] = [];
  /** Creneaux retenus par `selectMarkedRings`. Dimensionne sur `horde.capacity` — voir `#ensureBuffers`. */
  #selected = new Int32Array(0);
  /** Une case par element, indexee par l'element. Voir `ZoneRenderer#cells`. */
  #cells: Texture[] = [];

  constructor() {
    this.#container.boundsArea = new Rectangle(
      -BOUNDS_MARGIN,
      -BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
    );
  }

  /** Expose pour le test, comme sur `ZoneRenderer`. */
  get boundsArea(): Rectangle {
    return this.#container.boundsArea as Rectangle;
  }

  /** Expose pour le test : « additif » est une exigence, pas un detail. */
  get blendMode(): string {
    return this.#container.blendMode;
  }

  /** Vrai des que `load` a pose sa texture — c'est ce que `Stage.layersLoaded` lit. */
  get loaded(): boolean {
    return this.#cells.length === ELEMENTS.length;
  }

  /** Texture procedurale — hors du constructeur, meme raison que les autres renderers. */
  load(): void {
    this.adoptTexture(makeRingAtlas(MARK_RING_TEXTURE_DIAMETER));
  }

  /**
   * Rend le calque capable de dessiner a partir d'une texture deja cuite.
   *
   * ⚠️ **Separe de `load` PARCE QUE `load` a besoin d'un canevas 2D** que node
   * ne fournit pas. Sans ce point d'accroche, `draw` retournerait a
   * son premier `if (!texture)` dans toute la suite, et tout son corps pourrait
   * etre retire sans qu'une assertion ne bouge.
   */
  adoptTexture(atlas: Texture): void {
    const cell = MARK_RING_TEXTURE_DIAMETER;
    this.#cells = ELEMENTS.map(
      (e) =>
        new Texture({ source: atlas.source, frame: new Rectangle(e.id * cell, 0, cell, cell) }),
    );
  }

  attach(parent: Container): void {
    parent.addChild(this.#container);
  }

  /**
   * `tick` est le tick de horde du client (`GameClient.hordeTick`), **jamais
   * l'horloge murale** : c'est lui qui decide qu'une marque a expire, avec le
   * meme predicat que le serveur (l'expiration est DERIVEE).
   *
   * `timeMs` est l'horloge murale, pour l'animation seule (respiration,
   * scintillement) — elle ne decide de rien.
   */
  draw(horde: Horde, tick: number, view: ViewBounds, timeMs: number): void {
    if (!this.loaded) {
      return;
    }
    this.#ensureBuffers(horde.capacity);

    const count = selectMarkedRings(horde, tick, view, this.#selected);
    this.#ensurePool(count);
    const seconds = timeMs / 1000;

    const children = this.#container.particleChildren;
    children.length = 0;
    for (let n = 0; n < count; n++) {
      const i = this.#selected[n] ?? 0;
      const particle = this.#pool[n];
      if (!particle) {
        break;
      }
      // Second `markAt` sur le meme creneau : deux lectures de tableau et une
      // comparaison, contre un tampon d'elements de plus a dimensionner et a
      // tenir en phase avec `#selected`.
      const element = horde.markAt(i, tick);
      const look = lookOf(element);
      const seed = slotSeed(i);
      particle.texture = this.#cells[element] ?? particle.texture;
      particle.x = horde.x[i] ?? 0;
      // SOUS LES PIEDS, pas sur la position : voir `MARK_RING_FOOT_OFFSET_PX`.
      particle.y = (horde.y[i] ?? 0) + MARK_RING_FOOT_OFFSET_PX;
      // La respiration multiplie les DEUX axes : le rapport `MARK_RING_SQUASH`
      // ne bouge pas, l'ellipse reste posee au sol.
      const s = MARK_RING_SCALE * lookPulse(look, seconds, seed);
      particle.scaleX = s;
      // ELLIPSE, pas cercle : voir `MARK_RING_SQUASH`.
      particle.scaleY = s * MARK_RING_SQUASH;
      particle.tint = elementOf(element).tint;
      particle.alpha = MARK_RING_ALPHA * lookFlicker(look, seconds, seed);
      children.push(particle);
    }
    this.#container.update();
  }

  destroy(): void {
    this.#container.destroy();
  }

  /**
   * Dimensionne le tampon de selection sur la capacite de la horde, qui est la
   * borne du nombre d'anneaux : un ennemi porte au plus une
   * marque, donc au plus un anneau. Ne fait que grandir — la capacite est fixee
   * a la construction de la `Horde`.
   */
  #ensureBuffers(capacity: number): void {
    if (this.#selected.length >= capacity) {
      return;
    }
    this.#selected = new Int32Array(capacity);
  }

  /**
   * Le reservoir grandit sur ce que l'image demande VRAIMENT, pas sur la borne :
   * une horde entiere marquee est le cas rare, et allouer d'emblee un quad par
   * creneau paierait le pire cas a chaque partie. Meme discipline que
   * `HordeRenderer#ensurePool`.
   */
  #ensurePool(needed: number): void {
    const texture = this.#cells[0] as Texture;
    while (this.#pool.length < needed) {
      this.#pool.push(new Particle({ texture, anchorX: 0.5, anchorY: 0.5 }));
    }
  }
}
