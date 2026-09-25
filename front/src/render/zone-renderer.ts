import { MAP_SIZE, ZONE_RADIUS } from '@shared/constants';
import { elementOf } from '@shared/elements';
import { zoneElement } from '@shared/protocol';
import type { ZoneField } from '@shared/zones';
import { type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

/**
 * Rendu des zones au sol (§9 de la spec de l'etape 5a, premiere ligne de la
 * hierarchie du §6.6 de l'orientation) : *« grand quad teinte, additif,
 * quelques dizaines de quads »*.
 *
 * Un `ParticleContainer` de plus, meme discipline que les trois de
 * `projectile-renderer.ts` : bornes explicites, reservoir de `Particle`
 * reutilise, aucune allocation en regime etabli.
 *
 * ⚠️ **C'est le calque le plus BAS des entites** (voir l'ordre d'attache dans
 * `Stage.init`) : une zone est du terrain teinte, pas un effet qui passe
 * devant les monstres qu'elle couvre.
 *
 * ⚠️ **Tache 16 : le quad teinte gagne un BORD** — *« rends les zones au sol
 * plus nettes, en anneau de different alpha si besoin »*. Un aplat diffus ne
 * dit ni ou il commence ni ou il finit, et la frontiere d'une zone est une
 * **regle de jeu** : elle decide qui est marque, qui est ralenti, et ou deux
 * zones reagissent. Le disque garde exactement le rayon de la regle
 * (`zoneScale`, derive de `ZONE_RADIUS`) et le rend enfin lisible.
 *
 * ⚠️ **Une zone reste un CERCLE en coordonnees monde**, contrairement a
 * l'anneau de marque que la tache 15 vient d'aplatir en ellipse. La difference
 * n'est pas esthetique : le rayon de l'anneau ne decide de rien, celui de la
 * zone decide de tout, et il est compare en distance EUCLIDIENNE des deux
 * cotes du fil (`markInZones`, `reactions`). Une ellipse mentirait sur la
 * regle. C'est la camera seule qui l'ecrase de `VERTICAL_SQUASH`, uniformement
 * avec le reste du monde.
 */

/** Marge des bornes explicites, meme raisonnement que `HordeRenderer.BOUNDS_MARGIN`. */
const BOUNDS_MARGIN = 256;

/**
 * Cote de la texture de zone, en pixels.
 *
 * Ce n'est PAS la taille a l'ecran : c'est la finesse du disque dessine, que
 * `zoneScale` ramene ensuite au vrai `ZONE_RADIUS`. Une puissance de deux,
 * assez grande pour qu'un disque de 140 px de diametre monde ne soit pas
 * pixelise a l'agrandissement.
 */
export const ZONE_TEXTURE_DIAMETER = 128;

/**
 * Opacite du BORD d'une zone. **Constante, et c'est un choix**, pas un oubli.
 *
 * ⚠️ **Le §6.6 est categorique : l'etat persistant est DISCRET.** Une zone vit
 * `ZONE_LIFETIME_TICKS` (3 s) et plusieurs se recouvrent des qu'un joueur
 * arrose : a pleine opacite, quelques dizaines de disques additifs suffisent a
 * blanchir l'ecran et plus rien ne se lit — ni la horde, ni le flash de
 * reaction, qui est precisement ce que le budget VFX doit rendre visible.
 *
 * ⚠️ **Elle monte de 0,22 a 0,34 a la tache 16, et le budget d'encre ne bouge
 * PAS.** C'est une redistribution, pas une hausse. L'ancien profil etait un
 * aplat plein jusqu'a 0,65 de rayon puis un fondu jusqu'au bord : son opacite
 * moyenne, ponderee par la surface, valait **0,69** de la valeur de cette
 * constante. Le nouveau — un lavis mince a `ZONE_FILL_RATIO` et un lisere au
 * bord — vaut **0,44**. A 0,34, la zone pose donc autant d'encre au total
 * qu'a 0,22 auparavant : elle blanchit l'ecran ni plus ni moins vite, mais on
 * lit ou elle s'arrete.
 *
 * ⚠️ **Pas de fondu de fin de vie, DELIBEREMENT.** Un fondu ferait une SECONDE
 * garde d'expiration a cote de `ZoneField.aliveAt` : les deux se couvriraient
 * l'une l'autre, et supprimer la bonne (celle qui decide vraiment) ne ferait
 * rougir aucun test. Une seule chose decide qu'une zone se dessine — `aliveAt`,
 * dans `selectZones` — et c'est ce que le test peut donc verifier.
 */
export const ZONE_ALPHA = 0.34;

/**
 * Opacite de l'INTERIEUR de la zone, en fraction de celle du bord (tache 16) :
 * *« rends les zones au sol plus nettes, en anneau de different alpha si
 * besoin »*.
 *
 * Franchement en dessous de 1 : c'est ce qui fait qu'on lit un BORD et non un
 * aplat. Un disque uniformement diffus ne dit ni ou il commence ni ou il finit,
 * et sa frontiere est une **regle de jeu** — c'est elle qui decide qui est
 * marque (`markInZones`), qui est ralenti (`Horde#computeSlow`) et ou deux
 * zones reagissent (§5.2).
 */
export const ZONE_FILL_RATIO = 0.32;

/**
 * Debut de la montee vers le lisere, en fraction du rayon : en deça, la zone
 * est un lavis uniforme a `ZONE_FILL_RATIO`.
 */
const ZONE_RIM_INNER = 0.88;

/**
 * Debut du plateau opaque du lisere. L'ecart avec `ZONE_RIM_INNER` est la
 * rampe ; au-dela, l'opacite ne bouge plus jusqu'au bord, ou le disque
 * s'arrete NET.
 */
const ZONE_RIM_PEAK = 0.94;

/**
 * Marge de culling : un demi-diametre de zone, pour qu'un disque dont le
 * centre vient de sortir du cadre continue de teindre le bord de l'ecran au
 * lieu de disparaitre d'un coup.
 */
const CULL_MARGIN = ZONE_RADIUS;

/**
 * Ce que `selectZones` a besoin de connaitre de la vue — structurellement un
 * `Rectangle` de Pixi, ecrit comme une interface pour que le test n'ait pas a
 * en construire un.
 */
export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Facteur d'echelle d'une particule de zone : la texture dessinee doit couvrir
 * EXACTEMENT `2 x ZONE_RADIUS` pixels monde.
 *
 * ⚠️ **Derive de `ZONE_RADIUS`, jamais reglee a la main.** C'est la lecon de
 * `spriteScale` (tache 16, etape 3) : un sprite dessine a une taille choisie a
 * cote d'un rayon choisi a cote finit par mentir sur ce qu'il represente. Ici
 * le mensonge serait pire qu'esthetique — le disque dit au joueur ou ses
 * ennemis sont marques et ralentis, et c'est `ZONE_RADIUS` qui le decide
 * reellement (`markInZones`, `Horde#computeSlow`).
 */
export function zoneScale(textureDiameterPx: number): number {
  if (textureDiameterPx <= 0) {
    return 1;
  }
  return (2 * ZONE_RADIUS) / textureDiameterPx;
}

/**
 * Choisit les zones a dessiner au tick `tick` : celles qui sont VIVANTES et
 * dans le cadre. Ecrit leurs creneaux dans `out` et rend leur nombre — pure,
 * sans allocation, testable sans Pixi ni canevas, meme motif que `sortByDepth`
 * dans `horde-renderer.ts`.
 *
 * ⚠️ **`aliveAt`, et surtout pas `zones.count`.** Le client garde
 * volontairement ses zones mortes `ROLLBACK_DEPTH_TICKS` ticks de plus dans le
 * tableau, pour pouvoir rejouer un tick ou elles vivaient encore (voir
 * `GameClient#advanceHorde` et la doc de `ZoneField.aliveAt`). Dessiner tout ce
 * que le tableau contient laisserait donc chaque zone visible ~0,27 s de trop,
 * partout, en permanence — et personne ne saurait dire pourquoi les disques
 * du client survivent a ceux du serveur.
 */
export function selectZones(
  zones: ZoneField,
  tick: number,
  view: ViewBounds,
  out: Int32Array,
): number {
  const minX = view.x - CULL_MARGIN;
  const maxX = view.x + view.width + CULL_MARGIN;
  const minY = view.y - CULL_MARGIN;
  const maxY = view.y + view.height + CULL_MARGIN;

  let count = 0;
  for (let i = 0; i < zones.count && count < out.length; i++) {
    if (!zones.aliveAt(i, tick)) {
      continue;
    }
    const x = zones.x[i] ?? 0;
    const y = zones.y[i] ?? 0;
    if (x < minX || x > maxX || y < minY || y > maxY) {
      continue;
    }
    out[count] = i;
    count++;
  }
  return count;
}

/**
 * Disque BLANC a BORD LISIBLE, dessine une fois puis teinte par particule.
 *
 * ⚠️ **Blanc, parce que `Sprite.tint` MULTIPLIE.** Une texture deja coloree
 * rendrait la teinte de l'element approximative et differente d'un element a
 * l'autre ; en blanc, `tint` rend exactement `Element.tint`, et
 * `ELEMENT.NEUTRE` (0xffffff) rend exactement la texture — aucun cas
 * particulier a tester, ici comme sur les sprites de la horde.
 *
 * ⚠️ **Le profil de la tache 9 mentait sur une regle de jeu.** Il etait plein
 * jusqu'a 0,65 de rayon puis s'eteignait en fondu jusqu'au bord : on ne
 * pouvait lire nulle part ou la zone S'ARRETE. Or sa frontiere n'est pas
 * decorative — c'est elle qui decide qui est marque (`markInZones`), qui est
 * ralenti (`Horde#computeSlow`) et ou deux zones reagissent (§5.2). Un disque
 * uniformement diffus rend cette frontiere invisible, et l'oeil la place la ou
 * le fondu devient faible, donc **plus pres du centre qu'elle n'est**.
 *
 * Le nouveau profil (tache 16 : *« plus nettes, en anneau de different alpha si
 * besoin »*) est un lavis mince a `ZONE_FILL_RATIO`, une rampe courte, puis un
 * lisere opaque **qui va jusqu'au bord de la texture et s'arrete net** — le
 * `ctx.arc` de rayon `r` fait la coupure. Comme `zoneScale` place ce meme bord
 * exactement a `ZONE_RADIUS`, **le bord qu'on voit est le rayon qui decide**.
 *
 * Tous les arrets sont ecrits en `rgba(...)`, y compris les opaques : c'est ce
 * qui permet au test de lire le profil sans avoir a comprendre deux notations.
 */
function makeZoneTexture(diameter: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = diameter;
  canvas.height = diameter;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  const r = diameter / 2;
  const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, `rgba(255, 255, 255, ${ZONE_FILL_RATIO})`);
  gradient.addColorStop(ZONE_RIM_INNER, `rgba(255, 255, 255, ${ZONE_FILL_RATIO})`);
  gradient.addColorStop(ZONE_RIM_PEAK, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 1)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  return Texture.from(canvas);
}

export class ZoneRenderer {
  readonly #container = new ParticleContainer({
    // ⚠️ **Additif, comme le §6.6 l'exige.** Deux zones qui se recouvrent
    // s'ADDITIONNENT — et leur recouvrement est precisement ce qui declenche
    // une reaction (§5.2). En melange normal, la seconde masquerait la
    // premiere et la frontiere commune, la seule chose qu'il faille voir,
    // serait invisible.
    blendMode: 'add',
    // La teinte change par zone (l'element) mais jamais d'une image a l'autre
    // pour une meme zone ; `position` suffirait donc en theorie. `color` reste
    // dynamique parce que le reservoir de particules est REUTILISE : le
    // creneau 3 peut porter une zone de Braise a cette image et une de Givre a
    // la suivante.
    dynamicProperties: { position: true, color: true, rotation: false, uvs: false },
  });
  readonly #pool: Particle[] = [];
  /** Tampon des creneaux retenus par `selectZones`, dimensionne une fois. Voir `#ensureBuffers`. */
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

  /** Expose pour le test, comme les trois renderers de `projectile-renderer.ts`. */
  get boundsArea(): Rectangle {
    return this.#container.boundsArea as Rectangle;
  }

  /** Expose pour le test : « additif » est une exigence du §6.6, pas un detail. */
  get blendMode(): string {
    return this.#container.blendMode;
  }

  attach(parent: Container): void {
    parent.addChild(this.#container);
  }

  /**
   * Vrai des que `load` a pose sa texture. Expose pour le test, comme
   * `boundsArea` : c'est ce qui permet a `stage.test.ts` de verifier que
   * `Stage.composeWorld` charge CHAQUE calque — retirer un `load` y etait
   * indetectable jusqu'a la tache 9 bis.
   */
  get loaded(): boolean {
    return this.#texture !== null;
  }

  /** Texture procedurale — hors du constructeur, meme raison que les autres renderers. */
  load(): void {
    this.adoptTexture(makeZoneTexture(ZONE_TEXTURE_DIAMETER));
  }

  /**
   * Rend le calque capable de dessiner a partir d'une texture deja cuite.
   *
   * ⚠️ **Ajoute a la tache 16 parce que TOUT le corps de `draw` etait garde par
   * rien.** Deux mutations l'ont montre, appliquees avant d'ecrire une ligne de
   * test : `particle.scaleX = 1` (le disque ne suit plus `zoneScale`, donc plus
   * `ZONE_RADIUS`) et la suppression de `particle.alpha` — **toutes deux vertes
   * a 237 tests**. `zoneScale` etait teste, mais rien ne verifiait que `draw`
   * s'en servait : le motif exact des dix-sept assertions creuses du depot, le
   * test met en scene la bonne intention et rate la ligne qu'il nomme.
   *
   * Meme point d'accroche que `MarkRingRenderer.adoptTexture`, `adoptAtlas`
   * (tache 9 bis) et `adoptTextures` (tache 12), et pour la meme raison :
   * `load()` cuit sa texture sur un canevas 2D que l'environnement de test ne
   * fournit pas, donc `draw` retournerait a son premier `if (!texture)`.
   */
  adoptTexture(texture: Texture): void {
    this.#texture = texture;
  }

  /**
   * `tick` est le tick de horde du client (`GameClient.hordeTick`) : c'est lui
   * qui decide quelles zones sont encore vivantes, avec exactement le meme
   * predicat que le serveur (§5.3 — l'expiration est DERIVEE, jamais annoncee).
   */
  draw(zones: ZoneField, tick: number, view: ViewBounds): void {
    const texture = this.#texture;
    if (!texture) {
      return;
    }
    this.#ensureBuffers(zones.capacity, texture);

    const count = selectZones(zones, tick, view, this.#selected);
    const scale = zoneScale(ZONE_TEXTURE_DIAMETER);

    const children = this.#container.particleChildren;
    children.length = 0;
    for (let n = 0; n < count; n++) {
      const i = this.#selected[n] ?? 0;
      const particle = this.#pool[n];
      if (!particle) {
        break;
      }
      particle.x = zones.x[i] ?? 0;
      particle.y = zones.y[i] ?? 0;
      particle.scaleX = scale;
      particle.scaleY = scale;
      // Teinte de l'element, sans jamais tester lequel : `ELEMENT.NEUTRE`
      // porte 0xffffff, l'identite du produit (voir `shared/elements.ts`).
      particle.tint = elementOf(zoneElement(zones.kind[i] ?? 0)).tint;
      particle.alpha = ZONE_ALPHA;
      children.push(particle);
    }
    this.#container.update();
  }

  destroy(): void {
    this.#container.destroy();
  }

  /**
   * Dimensionne le tampon de selection et le reservoir sur la capacite du
   * champ de zones (`ZONE_CAPACITY`) : au pire cas toutes les zones sont
   * vivantes et visibles a la fois. Ne grandit jamais deux fois — la capacite
   * est une constante partagee.
   */
  #ensureBuffers(capacity: number, texture: Texture): void {
    if (this.#selected.length < capacity) {
      this.#selected = new Int32Array(capacity);
    }
    while (this.#pool.length < capacity) {
      this.#pool.push(new Particle({ texture, anchorX: 0.5, anchorY: 0.5 }));
    }
  }
}
