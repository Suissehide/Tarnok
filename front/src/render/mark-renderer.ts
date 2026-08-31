import { MAP_SIZE, PROJECTILE_HIT_RADIUS } from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import type { Horde } from '@shared/horde';
import { type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

import { BODY_SCALE } from './horde-renderer';
import type { ViewBounds } from './zone-renderer';

/**
 * L'anneau au sol sous un ennemi MARQUE (taches 13 et 15 de l'etape 5a).
 *
 * > *« Je ne vois pas la marque sur les ennemis, fais un anneau sous leurs
 * > pieds plutot que changer leur couleur. »* (tache 13)
 *
 * > *« Les cercles doivent etre des ellipses sous les pieds, plus nettes et
 * > fines. Parfois ils disparaissent lors des superpositions ou collision ? »*
 * > (tache 15)
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
 * ## La disparition signalee n'etait pas un defaut, c'etait la borne
 *
 * La tache 13 dedoublonnait **par cellule de grille** — au plus un anneau par
 * cellule au pas du diametre — pour que le compte suive la SURFACE VISIBLE et
 * non l'effectif de la horde. Deux ennemis dans la meme cellule partageaient
 * donc un anneau, et c'est exactement l'artefact que l'auteur a vu en jouant.
 *
 * **La tache 15 rend un anneau par ennemi marque, et la grille saute.** Le cout
 * redevient donc O(marques), remesure ci-dessous.
 *
 * ## Le cout, remesure sans la deduplication
 *
 * | Calque | Quads au pire cas | Borne |
 * | --- | --- | --- |
 * | horde (`HordeRenderer`) | **4 000** | `MAX_ENTITIES`, un sprite par ennemi visible |
 * | anneaux (ce fichier) | **4 000** | `horde.capacity`, un anneau par ennemi marque visible |
 *
 * **Il n'y a pas de nouveau plafond, parce qu'il y en a deja un et c'est le
 * meme** : `horde.capacity` (= `MAX_ENTITIES` cote client). Le calque des
 * anneaux double au pire ce que la horde dessine deja — **du meme ordre de
 * grandeur, pas d'un ordre au-dessus** — et il ne peut pas le depasser : un
 * ennemi porte au plus une marque.
 *
 * ⚠️ **Et si un plafond redevenait necessaire, ce ne serait PAS une grille.**
 * Un plafond qui degrade par ordre de creneau se voit comme une disparition
 * aleatoire — c'est ce que l'auteur vient de signaler. Il faudrait garder les
 * plus proches du joueur et compter ce qui est jete, comme
 * `Projectiles.truncated` le fait.
 *
 * Le culling hors camera reste, et il ne borne toujours rien dans le cas qui
 * compte (la horde converge sur le joueur, donc elle tient tout entiere dans le
 * plus petit ecran) : il evite seulement de payer une vague encore en marche
 * depuis le bord de carte.
 *
 * Meme discipline de conteneur que `zone-renderer.ts`, son voisin de calque :
 * un `ParticleContainer` additif, des bornes explicites, un reservoir de
 * `Particle` reutilise, aucune allocation en regime etabli.
 */

/** Marge des bornes explicites, meme raisonnement que `ZoneRenderer`. */
const BOUNDS_MARGIN = 256;

/**
 * **Largeur** de l'anneau dans le monde : le diametre de la hitbox de tir.
 *
 * ⚠️ **Derive, jamais regle a la main** — c'est la lecon de `spriteScale`
 * (tache 16, etape 3) et de `zoneScale`. Le corps dessine, lui, fait
 * `BODY_SCALE` fois plus large (80 px depuis la tache 14) : l'anneau est donc
 * visiblement plus etroit que la silhouette, ce qui le fait lire comme une base
 * au sol et non comme une aureole.
 *
 * ⚠️ **La LARGEUR seule, depuis la tache 15.** L'anneau est desormais une
 * ellipse (`MARK_RING_SQUASH`) : sa hauteur ne dit plus le rayon de la hitbox,
 * et n'a jamais eu a le dire. Un disque pose a plat au sol se projette en
 * ellipse — sa largeur est le diametre vrai, sa hauteur est la projection.
 */
export const MARK_RING_DIAMETER_PX = 2 * PROJECTILE_HIT_RADIUS;

/**
 * Aplatissement vertical de l'anneau, en coordonnees MONDE (tache 15) :
 * *« les cercles doivent etre des ellipses sous les pieds »*.
 *
 * Vue de dessus, un disque pose au sol ne se projette pas en cercle. L'anneau
 * garde sa largeur — qui dit le diametre de la hitbox — et perd de la hauteur.
 *
 * ⚠️ **NE PAS y recopier le `VERTICAL_SQUASH` (0,82) de `stage.ts` : la camera
 * l'applique DEJA.** Le monde entier est dessine avec `scale.set(1, 0,82)`,
 * donc un anneau circulaire en coordonnees monde arrivait deja a l'ecran comme
 * une ellipse de rapport 0,82 — et c'est justement ce que l'auteur trouvait
 * trop rond. Ce facteur-ci se COMPOSE avec celui-la : a l'ecran, l'anneau lit
 * 0,55 x 0,82 ≈ **0,45**. Recopier 0,82 ici l'appliquerait deux fois.
 */
export const MARK_RING_SQUASH = 0.55;

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
 * Opacite de l'anneau. **Bien plus haute que `ZONE_ALPHA`, et c'est le point de
 * la tache 13** : *« je ne vois pas la marque »*.
 *
 * Les deux ne jouent pas le meme role et ne couvrent pas la meme surface. Une
 * zone est un aplat de 140 px de diametre dont plusieurs se recouvrent des
 * qu'un joueur arrose (voir `ZONE_ALPHA`). Un anneau est un TRAIT — et depuis
 * la tache 15 un trait fin (`MARK_RING_STROKE_INNER`), qui ne couvre qu'une
 * mince couronne de l'ellipse : meme un par ennemi, la surface d'encre totale
 * reste une petite fraction de celle qu'un aplat poserait.
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
 * d'echelle. C'est la « fixture qui masque » du depot, cette fois-ci dans une
 * constante de production. Le double dessine deux fois plus fin que ce qu'on
 * affiche, ce qui est aussi ce qu'on veut a l'agrandissement — et la tache 15
 * en a besoin pour de bon : un trait de 0,22 rayon sur une texture de 64 ne
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
 * diviseur degenere a garder. Une garde `<= 0` ici serait morte — le depot en
 * a deja supprime cinq.
 */
export const MARK_RING_SCALE = MARK_RING_DIAMETER_PX / MARK_RING_TEXTURE_DIAMETER;

/**
 * Bord INTERIEUR du trait, en fraction du rayon : en deça, la texture est
 * transparente. **C'est la finesse du trait** (tache 15 : *« plus nettes et
 * fines »*) — la couronne dessinee occupe `1 - MARK_RING_STROKE_INNER` de
 * rayon, contre 0,40 a la tache 13.
 */
const MARK_RING_STROKE_INNER = 0.78;

/**
 * Debut du plateau opaque. L'ecart avec `MARK_RING_STROKE_INNER` est la
 * **rampe** : c'est elle qui fait la nettete. La tache 13 montait sur 0,22 de
 * rayon — un degrade, pas un trait.
 */
const MARK_RING_STROKE_PEAK = 0.86;

/** Fin du plateau opaque ; au-dela, le trait s'eteint jusqu'au bord. */
const MARK_RING_STROKE_FADE = 0.94;

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
 * ⚠️ **Un anneau par ennemi marque, depuis la tache 15.** La tache 13
 * dedoublonnait par cellule de grille ; l'auteur en a vu l'artefact —
 * *« parfois ils disparaissent lors des superpositions »*. Le compte suit
 * desormais les marques, et il est borne par `out.length`, que
 * `MarkRingRenderer#ensureBuffers` dimensionne sur `horde.capacity`.
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
 * Anneau BLANC, dessine une fois puis teinte par particule.
 *
 * ⚠️ **Blanc, parce que `Particle.tint` MULTIPLIE** — meme raison que
 * `makeZoneTexture` et `makeStreakTexture` : en blanc, `tint` rend exactement
 * `Element.tint`, sans qu'un element soit plus fidele qu'un autre.
 *
 * Le profil est un CREUX puis un PLATEAU : transparent au centre (sinon c'est
 * un disque, et l'ennemi disparait dessous), puis une rampe courte jusqu'a
 * l'opacite pleine, tenue sur une mince couronne, puis eteinte au bord.
 *
 * ⚠️ **La tache 13 posait un degrade, pas un trait** — creux jusqu'a 0,60,
 * crete a 0,82, extinction sur 0,18 : une bande de 0,40 de rayon dont l'opacite
 * variait partout. C'est ce que l'auteur a lu comme un cercle mou. La tache 15
 * la reduit a 0,22 avec une rampe de 0,08 : *« plus nettes et fines »*.
 *
 * Tous les arrets sont ecrits en `rgba(...)`, y compris les opaques : c'est ce
 * qui permet au test de lire le profil sans avoir a comprendre deux notations.
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
  const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
  gradient.addColorStop(MARK_RING_STROKE_INNER, 'rgba(255, 255, 255, 0)');
  gradient.addColorStop(MARK_RING_STROKE_PEAK, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(MARK_RING_STROKE_FADE, 'rgba(255, 255, 255, 1)');
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
  /** Creneaux retenus par `selectMarkedRings`. Dimensionne sur `horde.capacity` — voir `#ensureBuffers`. */
  #selected = new Int32Array(0);
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
   * ⚠️ **Separe de `load` PARCE QUE `load` a besoin d'un canevas 2D** que node
   * ne fournit pas — exactement la raison de `adoptAtlas` (tache 9 bis) et de
   * `adoptTextures` (tache 12). Sans ce point d'accroche, `draw` retournerait a
   * son premier `if (!texture)` dans toute la suite, et tout son corps pourrait
   * etre retire sans qu'une assertion ne bouge.
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
    this.#ensureBuffers(horde.capacity);

    const count = selectMarkedRings(horde, tick, view, this.#selected);
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
      // ELLIPSE, pas cercle : voir `MARK_RING_SQUASH`.
      particle.scaleY = MARK_RING_SCALE * MARK_RING_SQUASH;
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
   * Dimensionne le tampon de selection sur la capacite de la horde, qui est la
   * borne du nombre d'anneaux depuis la tache 15 : un ennemi porte au plus une
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
  #ensurePool(needed: number, texture: Texture): void {
    while (this.#pool.length < needed) {
      this.#pool.push(new Particle({ texture, anchorX: 0.5, anchorY: 0.5 }));
    }
  }
}
