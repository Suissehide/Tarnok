import { type BossCharge, chargeHoldsAt } from '@shared/boss';
import { MAP_SIZE } from '@shared/constants';
import { Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

/**
 * Le rectangle d'annonce de la charge du boss : **le rectangle avec son
 * opacite qui monte**, et **les fleches qui disent son sens**.
 *
 * ⚠️ **CE FICHIER NE FAIT PAS TOURNER LE BOSS, ET IL NE DOIT PAS.** Le clip
 * `attack` du troll (six images) montre deja la rotation : `selectClip`
 * (`horde-renderer.ts`) bascule dessus des qu'une entite est arretee, ce que
 * `Horde#applyCharge` fait pendant toute la charge. Ce qui tourne est dessine,
 * pas calcule.
 *
 * ⚠️ **Le clip ne part qu'au dash, et ce n'est pas ici** : `stopped` vaut 1
 * pendant toute la charge, c'est `HordeRenderer` (`clipFrameIndex`,
 * `chargeWindsUpAt`) qui fige la premiere image tant que le coup n'est pas
 * parti.
 *
 * ⚠️ **Un seul quad de couloir, jamais de reservoir ni de culling.** Il n'y a
 * qu'un boss vivant donc au plus un couloir, comme pour `BossBarRenderer`. Les
 * fleches, elles, se comptent depuis la LONGUEUR du couloir.
 */

/** Marge des bornes explicites, meme raisonnement que `ZoneRenderer`/`BossBarRenderer`. */
const BOUNDS_MARGIN = 256;

/**
 * Cote de la texture carree, en pixels.
 *
 * Ce n'est PAS la taille a l'ecran : `chargeQuad` etire ce carre a la longueur
 * et a la largeur reelles du couloir. **Different de toutes les tailles
 * affichees, et il faut que ca le reste** : quand une constante
 * de production vaut sa valeur d'affichage, l'echelle calculee devient
 * indistinguable de l'absence d'echelle et toute mutation y survit. 64 ne vaut
 * ni 900 (longueur) ni 192 (largeur).
 */
export const CHARGE_TEXTURE_SIZE = 64;

/**
 * Opacite du BORD du couloir, une fois le chargement termine.
 *
 * Meme valeur que `ZONE_ALPHA`, et ce n'est pas une coincidence : les deux sont
 * des aplats additifs poses au sol, et un etat persistant reste DISCRET. Le
 * couloir est plus grand
 * qu'une zone, donc il pose deja plus d'encre a opacite egale.
 */
export const CHARGE_ALPHA = 0.34;

/**
 * Opacite de l'INTERIEUR, en fraction de celle du bord.
 *
 * Franchement en dessous de 1 : c'est ce qui fait qu'on lit un BORD et non un
 * aplat, et **le bord d'un couloir est une regle de jeu** — c'est lui qui dit ou
 * il faut etre pour ne pas etre touche (`resolveChargeHit` compare une distance
 * a `charge.width / 2`). Meme raisonnement que `ZONE_FILL_RATIO`.
 */
export const CHARGE_FILL_RATIO = 0.32;

/**
 * Debut de la montee vers le lisere, en fraction de la demi-largeur.
 *
 * ⚠️ **Un lisere FIN** : 6 % de la demi-largeur (11 px sur 96), assez pour
 * dire ou passe la frontiere sans la transformer en surface. Plus epais, il
 * se lit comme un second aplat et le couloir parait plein.
 */
export const CHARGE_RIM_INNER = 0.94;

/**
 * Debut du plateau opaque du lisere ; au-dela, l'opacite ne bouge plus jusqu'au
 * bord.
 *
 * ⚠️ **Il reste au-dessus de `CHARGE_RIM_INNER`, et l'ecart entre les deux EST
 * le degrade.** A egalite, le lisere deviendrait une marche franche et la
 * texture crenelerait des que le couloir tourne.
 */
export const CHARGE_RIM_PEAK = 0.97;

/**
 * Rouge du couloir, leger — la meme famille chaude que le remplissage de la barre du boss, parce que les
 * deux disent la meme chose : ceci appartient au boss.
 */
const CHARGE_TINT = 0xc23b22;

/**
 * Cote de la texture d'une fleche, en pixels.
 *
 * Meme avertissement que `CHARGE_TEXTURE_SIZE` : 32 ne vaut ni la largeur
 * affichee d'une fleche (96 px, voir `CHARGE_ARROW_WIDTH_RATIO`) ni le cote
 * de la texture du couloir.
 */
export const CHARGE_ARROW_TEXTURE_SIZE = 32;

/**
 * Distance entre deux fleches le long du couloir, en pixels monde.
 *
 * ⚠️ **C'est un ESPACEMENT, pas un compte.** Un « cinq fleches » en dur
 * mentirait au premier couloir d'une autre longueur : les fleches seraient serrees sur un couloir court et clairsemees
 * sur un couloir long. 180 px donne cinq fleches sur les 900 px du troll.
 */
export const CHARGE_ARROW_SPACING_PX = 180;

/**
 * Largeur d'une fleche, en fraction de la largeur du couloir.
 *
 * ⚠️ **DERIVEE de la largeur du couloir, jamais un nombre a cote.** Une taille
 * absolue cesserait de tenir dans le couloir des qu'un boss en annonce un plus
 * etroit. La moitie : la fleche se lit au centre sans venir toucher le lisere
 * dont elle n'a pas a brouiller la lecture — et ce lisere est une regle de jeu.
 */
export const CHARGE_ARROW_WIDTH_RATIO = 0.5;

/**
 * Opacite d'une fleche, en multiple de celle du couloir.
 *
 * ⚠️ **Un MULTIPLE de l'opacite du couloir, donc les fleches montent avec le
 * compte a rebours.** Une opacite fixe leur ferait dire « la charge est
 * imminente » des la premiere image de chargement, et le seul compte a rebours
 * du jeu se contredirait lui-meme. Au-dessus de 1 parce qu'une fleche est un
 * trait fin pose sur un aplat deja teinte : a opacite egale elle s'y noierait.
 */
export const CHARGE_ARROW_ALPHA_RATIO = 1.8;

/** Ou poser le couloir, comment l'orienter, et a quelle opacite — le resultat de `chargeQuad`. */
export interface ChargeQuad {
  /** Abscisse de l'ORIGINE du couloir (son bord d'entree), en coordonnees monde. */
  x: number;
  y: number;
  /** Angle du couloir, en radians. */
  rotation: number;
  /** Longueur, en pixels monde. */
  length: number;
  /** Largeur, en pixels monde. */
  width: number;
  /** Opacite, dans `[0, CHARGE_ALPHA]`. */
  alpha: number;
}

/**
 * Opacite du couloir au tick `tick` : elle **monte** pendant le chargement, puis
 * reste pleine pendant la traversee.
 *
 * ⚠️ **La montee EST le compte a rebours.** C'est la seule chose que le joueur
 * lise pour savoir combien de temps il lui reste avant le depart : un rectangle
 * d'opacite constante annoncerait qu'il se passe quelque chose sans dire quand.
 *
 * ⚠️ **Elle se derive du TICK, jamais de l'horloge murale** — contrairement aux
 * flashs d'impact et de reaction, qui sont en horloge murale parce qu'ils
 * n'annoncent rien. Ici le dessin doit tomber au meme instant que le
 * deplacement qu'il annonce, et ce deplacement est date par tick des deux cotes.
 *
 * Hors de la charge, `0` : c'est ce qui fait disparaitre le couloir sans
 * second predicat d'expiration a cote de `chargeHoldsAt`.
 */
export function chargeAlphaAt(charge: BossCharge, tick: number): number {
  if (!chargeHoldsAt(charge, tick)) {
    return 0;
  }
  const windup = charge.startTick - charge.windupTick;
  if (windup <= 0 || tick >= charge.startTick) {
    return CHARGE_ALPHA;
  }
  return (CHARGE_ALPHA * (tick - charge.windupTick)) / windup;
}

/**
 * Ou dessiner le couloir au tick `tick`, ou `null` quand il n'y a rien a
 * dessiner. PURE, sans Pixi : c'est ce qui la rend testable sans canevas, meme
 * motif que `bossBarLayout` et `selectMarkedRings`.
 *
 * ⚠️ **Le rectangle est celui de la charge, jamais celui du boss.** Il part de
 * l'ORIGINE annoncee et ne bouge plus : le boss, lui, le traverse. Un couloir
 * qui suivrait le boss ne dirait plus rien de ce qui reste a parcourir.
 */
export function chargeQuad(charge: BossCharge | null, tick: number): ChargeQuad | null {
  if (charge === null) {
    return null;
  }
  const alpha = chargeAlphaAt(charge, tick);
  if (alpha <= 0) {
    return null;
  }
  return {
    x: charge.x,
    y: charge.y,
    rotation: Math.atan2(charge.dirY, charge.dirX),
    length: charge.length,
    width: charge.width,
    alpha,
  };
}

/** Une fleche du couloir — le resultat de `chargeArrows`. */
export interface ChargeArrow {
  /** Centre de la fleche, en coordonnees monde. */
  x: number;
  y: number;
  /** Angle de la fleche : celui du couloir, donc celui de la charge. */
  rotation: number;
  /** Cote affiche, en pixels monde. */
  size: number;
  /** Opacite, bornee a 1. */
  alpha: number;
}

/**
 * Les fleches posees au CENTRE du couloir, qui disent le sens de la charge.
 *
 * ⚠️ **Un couloir sans direction se lit comme une zone, pas comme une charge.**
 * Le rectangle dit *ou* ; il ne dit pas *vers ou*, et les deux bouts se
 * ressemblent — le joueur qui se met a l'abri « derriere » le boss se met en
 * fait devant lui.
 *
 * PURE, sans Pixi, exactement comme `chargeQuad` : elle se teste sans canevas.
 *
 * ⚠️ **Elles vivent sur le meme compte a rebours que le couloir** — l'opacite
 * sort de `chargeAlphaAt`, elle n'est pas recalculee ici. Deux montees
 * independantes finiraient par se contredire, et c'est le couloir qui dit le
 * temps qui reste.
 */
export function chargeArrows(charge: BossCharge | null, tick: number): ChargeArrow[] {
  const layout = chargeQuad(charge, tick);
  if (layout === null) {
    return [];
  }
  // Au moins UNE fleche : un couloir plus court que l'espacement doit quand
  // meme dire son sens. `round` plutot que `floor`, pour que 900/180 rende
  // cinq fleches et non quatre.
  const count = Math.max(1, Math.round(layout.length / CHARGE_ARROW_SPACING_PX));
  // Reparties sur des intervalles EGAUX, decalees d'un demi-intervalle : les
  // fleches restent ainsi a l'interieur du couloir au lieu d'en chevaucher les
  // deux extremites.
  const step = layout.length / count;
  const cos = Math.cos(layout.rotation);
  const sin = Math.sin(layout.rotation);
  const out: ChargeArrow[] = [];
  for (let i = 0; i < count; i++) {
    const along = (i + 0.5) * step;
    out.push({
      x: layout.x + cos * along,
      y: layout.y + sin * along,
      rotation: layout.rotation,
      size: layout.width * CHARGE_ARROW_WIDTH_RATIO,
      alpha: Math.min(1, layout.alpha * CHARGE_ARROW_ALPHA_RATIO),
    });
  }
  return out;
}

/**
 * Bande BLANCHE degradee dans la largeur : un lavis mince au centre, un lisere
 * aux deux bords.
 *
 * Blanche, parce que `Particle.tint` MULTIPLIE. Le degrade porte sur `y` (la largeur du
 * couloir) et jamais sur `x` : la longueur, elle, est uniforme — le couloir ne
 * s'estompe pas vers son extremite, puisque le boss ira jusqu'au bout.
 */
function makeCorridorTexture(size: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  const half = size / 2;
  for (let row = 0; row < size; row++) {
    // Distance au centre de la bande, en fraction de la demi-largeur.
    const d = Math.abs(row + 0.5 - half) / half;
    let a = CHARGE_FILL_RATIO;
    if (d >= CHARGE_RIM_PEAK) {
      a = 1;
    } else if (d > CHARGE_RIM_INNER) {
      const t = (d - CHARGE_RIM_INNER) / (CHARGE_RIM_PEAK - CHARGE_RIM_INNER);
      a = CHARGE_FILL_RATIO + (1 - CHARGE_FILL_RATIO) * t;
    }
    ctx.fillStyle = `rgba(255, 255, 255, ${a})`;
    ctx.fillRect(0, row, size, 1);
  }
  return Texture.from(canvas);
}

/**
 * Chevron BLANC pointant vers `+x`, la direction que `Particle.rotation`
 * fera tourner — meme convention que le couloir, dont la longueur est aussi
 * l'axe `x` de sa texture.
 *
 * Blanc, parce que `Particle.tint` MULTIPLIE : la teinte rouge est posee une
 * fois sur la particule, jamais cuite dans le dessin.
 *
 * Un chevron, pas un triangle plein : le couloir en porte cinq et un triangle
 * plein a cette taille masquerait le terrain qu'un aplat additif doit laisser
 * lire.
 */
function makeArrowTexture(size: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  const half = size / 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
  ctx.lineWidth = Math.max(1, size / 8);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(size * 0.22, size * 0.16);
  ctx.lineTo(size * 0.78, half);
  ctx.lineTo(size * 0.22, size * 0.84);
  ctx.stroke();
  return Texture.from(canvas);
}

export class ChargeRenderer {
  readonly #container = new ParticleContainer({
    // Additif, comme les zones : le couloir passe sur du terrain deja teinte et
    // doit s'y ajouter au lieu de le masquer.
    blendMode: 'add',
    // `rotation` : VRAI, et c'est le seul calque du jeu qui en a besoin — le
    // couloir pointe ou le boss va. `vertex` : la taille du quad vient de la
    // charge annoncee, qui peut differer d'un boss a l'autre.
    // `color` : la teinte ne change jamais, mais l'ALPHA monte a chaque image
    // pendant le chargement, et Pixi le range avec la couleur.
    dynamicProperties: { position: true, color: true, rotation: true, vertex: true, uvs: false },
  });
  /**
   * Le quad du couloir, construit une fois : il n'y a jamais qu'un boss.
   *
   * ⚠️ **UN seul champ nullable, pas deux** : deux champs separement
   * nullables donneraient deux gardes qui se couvrent l'une l'autre.
   */
  #quad: Particle | null = null;
  /**
   * Les fleches du couloir, reutilisees d'une image a l'autre.
   *
   * ⚠️ **Un tableau, jamais un second champ nullable** : `#quad` reste le SEUL
   * nullable du calque. Vide tant qu'`adoptTexture` n'a pas
   * cuit ses chevrons, et `loaded` continue de ne lire que `#quad`.
   */
  readonly #arrows: Particle[] = [];
  /**
   * Le calque des fleches. **Un second `ParticleContainer` n'est pas un choix**
   * : un `ParticleContainer` ne porte qu'UNE texture source, et le chevron n'est
   * pas la bande du couloir.
   */
  readonly #arrowLayer = new ParticleContainer({
    blendMode: 'add',
    dynamicProperties: { position: true, color: true, rotation: true, vertex: true, uvs: false },
  });
  /**
   * Le couloir et ses fleches sont UN calque du monde, pas deux.
   *
   * ⚠️ **Ce noeud existe pour que `Stage` continue de compter ses calques.**
   * `stage.test.ts` garde le nombre de calques attaches : si le couloir en
   * occupait deux, ce compte cesserait de nommer ce qu'il compte. Les deux conteneurs sont ici, dans leur ordre
   * d'affichage, et le monde n'en voit qu'un.
   */
  readonly #root = new Container();

  constructor() {
    const bounds = new Rectangle(
      -BOUNDS_MARGIN,
      -BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
    );
    this.#container.boundsArea = bounds;
    this.#arrowLayer.boundsArea = bounds;
    this.#root.addChild(this.#container);
    // APRES le couloir : les fleches se posent dessus, jamais dessous — c'est
    // le meme aplat additif, et une fleche sous son propre couloir ne se lirait
    // plus une fois l'opacite pleine.
    this.#root.addChild(this.#arrowLayer);
  }

  /** Expose pour le test, comme sur les autres calques. */
  get boundsArea(): Rectangle {
    return this.#container.boundsArea as Rectangle;
  }

  /** Expose pour le test : « additif » est une exigence, pas un detail. */
  get blendMode(): string {
    return this.#container.blendMode;
  }

  /** Vrai des que `load`/`adoptTexture` a cuit son quad — ce que `Stage.layersLoaded` lit. */
  get loaded(): boolean {
    return this.#quad !== null;
  }

  load(): void {
    this.adoptTexture(
      makeCorridorTexture(CHARGE_TEXTURE_SIZE),
      makeArrowTexture(CHARGE_ARROW_TEXTURE_SIZE),
    );
  }

  /**
   * ⚠️ **Separe de `load` PARCE QUE `load` a besoin d'un canevas 2D** que node
   * ne fournit pas. Sans ce point d'accroche, `draw` ne passerait jamais sa
   * garde en test, et **tout son corps pourrait etre retire sans qu'une
   * assertion ne bouge**.
   */
  adoptTexture(texture: Texture, arrow: Texture): void {
    // Ancre a GAUCHE, centree en hauteur : le couloir PART de l'origine annoncee
    // et s'etend dans la direction de la charge. Une ancre centree ferait
    // demarrer le rectangle une demi-longueur DERRIERE le boss.
    this.#quad = new Particle({ texture, anchorX: 0, anchorY: 0.5, tint: CHARGE_TINT });
    // Une premiere fleche suffit a retenir la texture : `#ensureArrows` clone la
    // sienne pour agrandir le reservoir. C'est ce qui evite un second champ
    // nullable a cote de `#quad`.
    this.#arrows.length = 0;
    this.#arrows.push(this.#newArrow(arrow));
  }

  #newArrow(texture: Texture): Particle {
    // Ancree en son CENTRE, contrairement au couloir : une fleche est posee sur
    // un point du couloir, elle n'en part pas.
    return new Particle({ texture, anchorX: 0.5, anchorY: 0.5, tint: CHARGE_TINT });
  }

  /**
   * Agrandit le reservoir de fleches jusqu'a `n`. Il ne retrecit jamais : un
   * couloir plus court en dessine simplement moins.
   */
  #ensureArrows(n: number): void {
    const texture = this.#arrows[0]?.texture;
    if (!texture) {
      return;
    }
    while (this.#arrows.length < n) {
      this.#arrows.push(this.#newArrow(texture));
    }
  }

  attach(parent: Container): void {
    parent.addChild(this.#root);
  }

  /**
   * `tick` est le tick de horde du client (`GameClient.hordeTick`) : c'est lui
   * qui fait monter l'opacite et qui fait disparaitre le couloir, avec exactement
   * le meme predicat que celui qui deplace le boss (`chargeHoldsAt`).
   */
  draw(charge: BossCharge | null, tick: number): void {
    const quad = this.#quad;
    const children = this.#container.particleChildren;
    children.length = 0;

    const arrowChildren = this.#arrowLayer.particleChildren;
    arrowChildren.length = 0;

    const layout = chargeQuad(charge, tick);
    if (quad && layout) {
      quad.x = layout.x;
      quad.y = layout.y;
      quad.rotation = layout.rotation;
      quad.scaleX = layout.length / CHARGE_TEXTURE_SIZE;
      quad.scaleY = layout.width / CHARGE_TEXTURE_SIZE;
      quad.alpha = layout.alpha;
      children.push(quad);

      const arrows = chargeArrows(charge, tick);
      this.#ensureArrows(arrows.length);
      for (let i = 0; i < arrows.length; i++) {
        const a = arrows[i];
        const particle = this.#arrows[i];
        if (!a || !particle) {
          continue;
        }
        particle.x = a.x;
        particle.y = a.y;
        particle.rotation = a.rotation;
        particle.scaleX = a.size / CHARGE_ARROW_TEXTURE_SIZE;
        particle.scaleY = a.size / CHARGE_ARROW_TEXTURE_SIZE;
        particle.alpha = a.alpha;
        arrowChildren.push(particle);
      }
    }

    this.#container.update();
    this.#arrowLayer.update();
  }

  destroy(): void {
    this.#root.destroy({ children: true });
  }
}
