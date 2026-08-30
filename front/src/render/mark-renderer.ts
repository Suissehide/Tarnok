import { MAP_SIZE, PROJECTILE_HIT_RADIUS } from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import type { Horde } from '@shared/horde';
import { type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

import { BODY_SCALE } from './horde-renderer';
import type { ViewBounds } from './zone-renderer';

/**
 * L'anneau au sol sous un ennemi MARQUE (tache 13 de l'etape 5a).
 *
 * > *« Je ne vois pas la marque sur les ennemis, fais un anneau sous leurs
 * > pieds plutot que changer leur couleur. »*
 *
 * ⚠️ **Ceci REMPLACE la teinte de sprite, ça ne s'y ajoute pas.** La deuxieme
 * ligne de la hierarchie du §6.6 de l'orientation — *« un element sur un
 * ennemi : teinte du sprite, gratuite dans le batch Pixi, cout 0 »* — a ete
 * ecartee par la verification manuelle : gratuite, oui, mais **invisible**. Un
 * crane de Tiny Swords est deja sombre et bariole ; le multiplier par 0xff7a3c
 * ne change presque rien a ce qu'on lit a l'ecran. `markTint`, le `color: true`
 * du conteneur de horde et le `tick` que `HordeRenderer.draw` recevait sont
 * partis avec elle.
 *
 * ⚠️ **L'ecart au §6.6 COUTE, et il est mesure.** Le §6.6 reservait l'anneau au
 * cas « deux elements avant reaction », precisement parce qu'un anneau par
 * ennemi marque coute **un quad par ennemi marque**. Ce que la mesure a montre
 * (banc de trajectoire, meme decor que `bench/steering.bench.ts`, horde
 * convergeant sur un joueur pendant 600 ticks) :
 *
 * | Entites | Rayon median de la horde | Dans un cadre 1920x1080 |
 * | --- | --- | --- |
 * | 1 500 | 230 px | **1 500** |
 * | 4 000 | 368 px | **4 000** |
 *
 * **Le culling hors camera ne borne RIEN dans le cas qui compte** : la horde
 * converge sur le joueur, donc elle tient tout entiere dans le plus petit
 * ecran. Il reste utile (une vague encore en marche depuis le bord de carte ne
 * coute rien), mais l'esperer suffisant aurait donne 4 000 quads.
 *
 * **La borne est donc la SURFACE VISIBLE, pas l'effectif de la horde** : au
 * plus un anneau par cellule d'une grille au pas de l'anneau (voir `ringGrid`).
 * C'est le meme deplacement que la regle de fusion de la tache 4, qui a rendu
 * le nombre de zones fonction de la surface couverte et non de la cadence de
 * tir.
 *
 * | Ecran | Cellules au plus | Quads au pire, 4 000 ennemis tous marques |
 * | --- | --- | --- |
 * | 1920x1080 | 34 x 24 | **816** |
 * | 2560x1440 | 44 x 31 | **1 364** |
 * | 3840x2160 | 64 x 45 | **2 880** |
 *
 * Le compte ne bouge plus quand la horde grossit : de 1 500 a 4 000 entites, il
 * est le meme.
 *
 * Meme discipline de conteneur que `zone-renderer.ts`, son voisin de calque :
 * un `ParticleContainer` additif, des bornes explicites, un reservoir de
 * `Particle` reutilise, aucune allocation en regime etabli.
 */

/** Marge des bornes explicites, meme raisonnement que `ZoneRenderer`. */
const BOUNDS_MARGIN = 256;

/**
 * Diametre de l'anneau dans le monde : **le diametre de la hitbox de tir**.
 *
 * ⚠️ **Derive, jamais regle a la main** — c'est la lecon de `spriteScale`
 * (tache 16, etape 3) et de `zoneScale`. L'anneau dit deux choses d'un coup :
 * *cet ennemi porte une marque*, et *voila le cercle qu'un projectile touche*.
 * Le corps dessine, lui, fait `BODY_SCALE` fois plus large (80 px depuis la
 * tache 14) : l'anneau est donc visiblement plus etroit que la silhouette, ce
 * qui le fait lire comme une base au sol et non comme une aureole.
 */
export const MARK_RING_DIAMETER_PX = 2 * PROJECTILE_HIT_RADIUS;

/**
 * De combien l'anneau descend sous la position de l'ennemi, pour se poser
 * **sous ses pieds**.
 *
 * ⚠️ **C'est la tache 14 qui rend ce decalage necessaire, et c'est pour ca
 * qu'elle est passee avant celle-ci.** Tant que l'ancre du sprite valait 0,75,
 * les pieds etaient SUR la position et un anneau pose a `horde.y` tombait juste.
 * Depuis que le corps est centre sur la position (`BODY_ANCHOR_Y = 0,5`, comme
 * tous les rayons de collision), les pieds sont a une demi-hauteur de corps en
 * dessous — soit `PROJECTILE_HIT_RADIUS * BODY_SCALE`, puisque `spriteScale`
 * ramene la plus grande dimension du contenu a `2 * PROJECTILE_HIT_RADIUS *
 * BODY_SCALE`.
 *
 * **L'approximation, dite plutot que cachee** : c'est exact pour un contenu
 * plus HAUT que large (`contentSizePx` rend alors la hauteur), et l'anneau
 * descend de quelques pixels de trop pour une silhouette plus large que haute.
 * C'est le bon sens d'erreur : un anneau un peu bas reste une base, un anneau
 * un peu haut ceinture le ventre. Le decalage entre le centre de la CELLULE
 * d'atlas et celui du contenu n'est pas repris ici non plus — c'est une
 * approximation deja assumee par la tache 14, pas une nouvelle.
 */
export const MARK_RING_FOOT_OFFSET_PX = PROJECTILE_HIT_RADIUS * BODY_SCALE;

/**
 * Opacite de l'anneau. **Bien plus haute que `ZONE_ALPHA` (0,22), et c'est le
 * point de la tache** : *« je ne vois pas la marque »*.
 *
 * Les deux ne jouent pas le meme role et ne couvrent pas la meme surface. Une
 * zone est un aplat de 140 px de diametre dont plusieurs se recouvrent des
 * qu'un joueur arrose — a pleine opacite, l'ecran blanchit et le flash de
 * reaction ne se lit plus (voir `ZONE_ALPHA`). Un anneau est un trait fin de
 * 64 px de diametre, au plus un par cellule de grille : sa surface totale reste
 * une petite fraction de l'ecran meme au pire cas, et il doit se detacher du
 * sol teinte par la zone qui l'a pose.
 */
export const MARK_RING_ALPHA = 0.85;

/**
 * Cote de la texture d'anneau, en pixels. Ce n'est PAS la taille a l'ecran :
 * c'est la finesse du trait dessine, que `MARK_RING_SCALE` ramene ensuite a
 * `MARK_RING_DIAMETER_PX`. Meme role que `ZONE_TEXTURE_DIAMETER`.
 *
 * ⚠️ **DIFFERENT de `MARK_RING_DIAMETER_PX`, et il faut que ça le reste.** Les
 * deux valaient 64 dans la premiere version, ce qui rendait `MARK_RING_SCALE`
 * egal a 1 : *toute* mutation de l'echelle devenait indistinguable de l'absence
 * d'echelle. C'est la « fixture qui masque » du depot, sept fois rencontree,
 * cette fois-ci dans une constante de production. Le double dessine deux fois
 * plus fin que ce qu'on affiche, ce qui est aussi ce qu'on veut a
 * l'agrandissement — meme raison que `ZONE_TEXTURE_DIAMETER`.
 */
export const MARK_RING_TEXTURE_DIAMETER = 128;

/**
 * Facteur d'echelle d'une particule d'anneau : la texture doit couvrir
 * exactement `MARK_RING_DIAMETER_PX` pixels monde.
 *
 * Une constante et non une fonction, contrairement a `zoneScale`/`spriteScale` :
 * les deux termes sont des constantes de ce module, donc il n'existe pas de
 * diviseur degenere a garder. Une garde `<= 0` ici serait morte — le depot en
 * a deja supprime cinq.
 */
export const MARK_RING_SCALE = MARK_RING_DIAMETER_PX / MARK_RING_TEXTURE_DIAMETER;

/**
 * Cote d'une cellule de la grille d'occupation : **le diametre de l'anneau**.
 *
 * ⚠️ **C'est LA borne de coût de ce fichier**, et elle n'est pas un reglage.
 * Deux anneaux dans la meme cellule se recouvrent presque entierement : le
 * second n'ajoute aucune information, seulement un quad. Au pas du diametre, la
 * grille garde exactement ce que l'oeil peut encore separer.
 */
const MARK_RING_CELL_PX = MARK_RING_DIAMETER_PX;

/**
 * Marge de culling : de quoi garder l'anneau d'un ennemi dont la position vient
 * de sortir du cadre mais dont l'anneau — pose PLUS BAS que lui — mord encore
 * dedans. Derivee du decalage et du rayon, jamais choisie.
 */
const CULL_MARGIN = MARK_RING_FOOT_OFFSET_PX + MARK_RING_DIAMETER_PX / 2;

/**
 * La grille d'occupation couvrant une vue : ses dimensions, et la cellule du
 * MONDE ou elle commence.
 *
 * ⚠️ **Ancree sur l'origine du MONDE, pas sur le coin de la vue.** Une grille
 * calee sur la camera changerait de decoupage a chaque image des que le joueur
 * bouge, donc changerait l'ennemi retenu dans chaque cellule : la nappe
 * d'anneaux scintillerait sans qu'aucun ennemi ne change d'etat. Ancree sur le
 * monde, le decoupage est immobile et seul un ennemi qui traverse une frontiere
 * de cellule peut faire changer le tirage.
 */
export interface RingGrid {
  readonly cols: number;
  readonly rows: number;
  /** Colonne MONDE de la premiere colonne de la grille. */
  readonly col0: number;
  /** Ligne MONDE de la premiere ligne de la grille. */
  readonly row0: number;
}

export function ringGrid(view: ViewBounds): RingGrid {
  const col0 = Math.floor((view.x - CULL_MARGIN) / MARK_RING_CELL_PX);
  const row0 = Math.floor((view.y - CULL_MARGIN) / MARK_RING_CELL_PX);
  const col1 = Math.floor((view.x + view.width + CULL_MARGIN) / MARK_RING_CELL_PX);
  const row1 = Math.floor((view.y + view.height + CULL_MARGIN) / MARK_RING_CELL_PX);
  return { cols: col1 - col0 + 1, rows: row1 - row0 + 1, col0, row0 };
}

/**
 * Le nombre de quads que ce calque peut poser au pire, pour cette vue. C'est
 * la borne, et elle ne depend que de la SURFACE VISIBLE — jamais de l'effectif
 * de la horde ni du nombre d'ennemis marques.
 */
export function ringGridCells(grid: RingGrid): number {
  return grid.cols * grid.rows;
}

/**
 * Choisit les ennemis qui recoivent un anneau : MARQUES, dans le cadre, et au
 * plus un par cellule de `grid`. Ecrit leurs creneaux dans `out` et rend leur
 * nombre — pure, sans allocation, testable sans Pixi ni canevas, meme motif que
 * `selectZones` et `sortByDepth`.
 *
 * ⚠️ **`markAt`, jamais `horde.mark` directement** : une marque EXPIRE, et son
 * expiration est DERIVEE du seul `markUntil` (voir `Horde.markAt`). Lire le
 * tableau laisserait des anneaux allumes bien apres la fin de leur marque.
 *
 * ⚠️ **La branche `=== NEUTRE` est ASSUMEE ici, alors que le §6.6 l'interdisait
 * pour la teinte de sprite.** Elle etait interdite la-bas parce qu'un test par
 * entite pour une teinte qui ne change rien est un cout pur ; ici c'est
 * l'inverse : c'est elle qui fait qu'un ennemi non marque ne coute AUCUN quad,
 * et donc que ce calque reste proportionnel aux marques et non a la horde.
 *
 * `occupancy` et `out` doivent tous deux tenir `ringGridCells(grid)` entrees —
 * `MarkRingRenderer#ensureBuffers` est le seul endroit qui les dimensionne, et
 * il le fait depuis cette meme grille. Aucun indice calcule ici ne peut sortir
 * de `[0, cols * rows)` : `col0`/`row0` sont les cellules des bornes de culling
 * elles-memes, et `cols`/`rows` en comptent exactement l'etendue.
 */
export function selectMarkedRings(
  horde: Horde,
  tick: number,
  view: ViewBounds,
  grid: RingGrid,
  occupancy: Uint8Array,
  out: Int32Array,
): number {
  const minX = view.x - CULL_MARGIN;
  const maxX = view.x + view.width + CULL_MARGIN;
  const minY = view.y - CULL_MARGIN;
  const maxY = view.y + view.height + CULL_MARGIN;
  occupancy.fill(0, 0, ringGridCells(grid));

  let count = 0;
  for (let i = 0; i < horde.count; i++) {
    if (horde.markAt(i, tick) === ELEMENT.NEUTRE) {
      continue;
    }
    const x = horde.x[i] ?? 0;
    const y = horde.y[i] ?? 0;
    if (x < minX || x > maxX || y < minY || y > maxY) {
      continue;
    }
    const cell =
      (Math.floor(y / MARK_RING_CELL_PX) - grid.row0) * grid.cols +
      (Math.floor(x / MARK_RING_CELL_PX) - grid.col0);
    if (occupancy[cell] === 1) {
      continue;
    }
    occupancy[cell] = 1;
    out[count] = i;
    count++;
  }
  return count;
}

/**
 * Anneau BLANC a bords doux, dessine une fois puis teinte par particule.
 *
 * ⚠️ **Blanc, parce que `Particle.tint` MULTIPLIE** — meme raison que
 * `makeZoneTexture` et `makeStreakTexture` : en blanc, `tint` rend exactement
 * `Element.tint`, sans qu'un element soit plus fidele qu'un autre.
 *
 * Le profil est un CREUX puis une crete : transparent au centre (sinon c'est un
 * disque, et l'ennemi disparait dessous), opaque sur le trait, estompe vers
 * l'exterieur pour ne pas lire comme un cerceau de metal.
 */
function makeRingTexture(diameter: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = diameter;
  canvas.height = diameter;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  const r = diameter / 2;
  /** Bord interieur du trait, en fraction du rayon. */
  const INNER_FRACTION = 0.6;
  /** Crete du trait — au-dela, il s'estompe jusqu'au bord. */
  const PEAK_FRACTION = 0.82;
  const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
  gradient.addColorStop(INNER_FRACTION, 'rgba(255, 255, 255, 0)');
  gradient.addColorStop(PEAK_FRACTION, '#ffffff');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  return Texture.from(canvas);
}

export class MarkRingRenderer {
  readonly #container = new ParticleContainer({
    // Additif, comme les zones : l'anneau se pose SUR le sol deja teinte par la
    // zone qui l'a marque, et doit s'y ajouter au lieu de la masquer.
    blendMode: 'add',
    // `color` : la teinte change par anneau (l'element) et le reservoir est
    // REUTILISE — le creneau 3 peut porter une Braise a cette image et un Givre
    // a la suivante. Meme raison, mot pour mot, que sur le conteneur des zones.
    dynamicProperties: { position: true, color: true, rotation: false, uvs: false },
  });
  readonly #pool: Particle[] = [];
  /** Creneaux retenus par `selectMarkedRings`. Dimensionne sur la grille — voir `#ensureBuffers`. */
  #selected = new Int32Array(0);
  /** Une cellule prise ou libre. Meme dimensionnement que `#selected`. */
  #occupancy = new Uint8Array(0);
  #texture: Texture | null = null;

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

  /** Expose pour le test : « additif » est une exigence du §6.6, pas un detail. */
  get blendMode(): string {
    return this.#container.blendMode;
  }

  /** Vrai des que `load` a pose sa texture — c'est ce que `Stage.layersLoaded` lit. */
  get loaded(): boolean {
    return this.#texture !== null;
  }

  /** Texture procedurale — hors du constructeur, meme raison que les autres renderers. */
  load(): void {
    this.adoptTexture(makeRingTexture(MARK_RING_TEXTURE_DIAMETER));
  }

  /**
   * Rend le calque capable de dessiner a partir d'une texture deja cuite.
   *
   * ⚠️ **Separe de `load` PARCE QUE `load` a besoin d'un canevas 2D** que ni
   * node ni jsdom ne fournissent — exactement la raison de `adoptAtlas`
   * (tache 9 bis) et de `adoptTextures` (tache 12). Sans ce point d'accroche,
   * `draw` retournerait a son premier `if (!texture)` dans toute la suite, et
   * tout son corps pourrait etre retire sans qu'une assertion ne bouge.
   */
  adoptTexture(texture: Texture): void {
    this.#texture = texture;
  }

  attach(parent: Container): void {
    parent.addChild(this.#container);
  }

  /**
   * `tick` est le tick de horde du client (`GameClient.hordeTick`), **jamais
   * l'horloge murale** : c'est lui qui decide qu'une marque a expire, avec le
   * meme predicat que le serveur (§5.3 — l'expiration est DERIVEE).
   */
  draw(horde: Horde, tick: number, view: ViewBounds): void {
    const texture = this.#texture;
    if (!texture) {
      return;
    }
    const grid = ringGrid(view);
    this.#ensureBuffers(ringGridCells(grid));

    const count = selectMarkedRings(horde, tick, view, grid, this.#occupancy, this.#selected);
    this.#ensurePool(count, texture);

    const children = this.#container.particleChildren;
    children.length = 0;
    for (let n = 0; n < count; n++) {
      const i = this.#selected[n] ?? 0;
      const particle = this.#pool[n];
      if (!particle) {
        break;
      }
      particle.x = horde.x[i] ?? 0;
      // SOUS LES PIEDS, pas sur la position : voir `MARK_RING_FOOT_OFFSET_PX`.
      particle.y = (horde.y[i] ?? 0) + MARK_RING_FOOT_OFFSET_PX;
      particle.scaleX = MARK_RING_SCALE;
      particle.scaleY = MARK_RING_SCALE;
      // Second `markAt` sur le meme creneau : deux lectures de tableau et une
      // comparaison, contre un tampon d'elements de plus a dimensionner et a
      // tenir en phase avec `#selected`.
      particle.tint = elementOf(horde.markAt(i, tick)).tint;
      particle.alpha = MARK_RING_ALPHA;
      children.push(particle);
    }
    this.#container.update();
  }

  destroy(): void {
    this.#container.destroy();
  }

  /**
   * Dimensionne les tampons sur le nombre de CELLULES de la vue, qui est la
   * borne du nombre d'anneaux. Ne fait que grandir : la vue ne change qu'au
   * redimensionnement de la fenetre.
   */
  #ensureBuffers(cells: number): void {
    if (this.#selected.length >= cells) {
      return;
    }
    this.#selected = new Int32Array(cells);
    this.#occupancy = new Uint8Array(cells);
  }

  /**
   * Le reservoir grandit sur ce que l'image demande VRAIMENT, pas sur la borne :
   * une nappe d'ennemis tous marques est le cas rare, et allouer d'emblee un
   * quad par cellule paierait le pire cas a chaque partie. Meme discipline que
   * `HordeRenderer#ensurePool`.
   */
  #ensurePool(needed: number, texture: Texture): void {
    while (this.#pool.length < needed) {
      this.#pool.push(new Particle({ texture, anchorX: 0.5, anchorY: 0.5 }));
    }
  }
}
