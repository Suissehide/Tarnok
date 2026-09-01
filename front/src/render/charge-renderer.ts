import { type BossCharge, chargeHoldsAt } from '@shared/boss';
import { MAP_SIZE } from '@shared/constants';
import { type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

/**
 * Le rectangle d'annonce de la charge du boss (etape 6a, tache 5 bis).
 *
 * > *« Le troll charge une attaque lineaire, donc un long rectangle, et son
 * > animation le fait tourner, donc il spin rapidement a travers ce rectangle
 * > en avancant. »*
 *
 * ⚠️ **CE FICHIER NE FAIT PAS TOURNER LE BOSS, ET IL NE DOIT PAS.** Decision de
 * l'auteur : *« pas besoin de faire tourner le boss, l'animation d'attaque le
 * fait deja tourner »*. Le clip `attack` du troll fait **six images**, et ce
 * sont elles qui montrent la rotation ; `selectClip` (voir
 * `horde-renderer.ts`) bascule dessus des qu'une entite est marquee arretee, ce
 * que `Horde#applyCharge` fait pendant toute la charge. **Le boss qui charge est
 * une entite qui joue son clip d'attaque** — le rendu de la horde n'a rien
 * appris pour ca, et une premiere version du plan qui demandait un angle par
 * particule s'inquietait pour rien : ce qui tourne est dessine, pas calcule.
 *
 * Il ne reste donc qu'une chose a ecrire : **le rectangle, et son opacite qui
 * monte**.
 *
 * ⚠️ **Un seul quad, jamais de reservoir ni de culling.** Il n'y a qu'un boss
 * vivant (§1.1 de la spec) donc au plus un couloir — le meme nombre qui autorise
 * `BossBarRenderer` a ne rien borner, et pour la meme raison.
 */

/** Marge des bornes explicites, meme raisonnement que `ZoneRenderer`/`BossBarRenderer`. */
const BOUNDS_MARGIN = 256;

/**
 * Cote de la texture carree, en pixels.
 *
 * Ce n'est PAS la taille a l'ecran : `chargeQuad` etire ce carre a la longueur
 * et a la largeur reelles du couloir. **Different de toutes les tailles
 * affichees, et il faut que ca le reste** — meme avertissement que
 * `BOSS_BAR_TEXTURE_SIZE` et `MARK_RING_TEXTURE_DIAMETER` : quand une constante
 * de production vaut sa valeur d'affichage, l'echelle calculee devient
 * indistinguable de l'absence d'echelle et toute mutation y survit. 64 ne vaut
 * ni 900 (longueur) ni 192 (largeur).
 */
export const CHARGE_TEXTURE_SIZE = 64;

/**
 * Opacite du BORD du couloir, une fois le chargement termine.
 *
 * Meme valeur que `ZONE_ALPHA`, et ce n'est pas une coincidence : les deux sont
 * des aplats additifs poses au sol, et le §6.6 de l'orientation est categorique
 * sur le fait que l'etat persistant reste DISCRET. Le couloir est plus grand
 * qu'une zone, donc il pose deja plus d'encre a opacite egale.
 */
export const CHARGE_ALPHA = 0.34;

/**
 * Opacite de l'INTERIEUR, en fraction de celle du bord.
 *
 * Franchement en dessous de 1 : c'est ce qui fait qu'on lit un BORD et non un
 * aplat, et **le bord d'un couloir est une regle de jeu** — c'est lui qui dit ou
 * il faut etre pour ne pas etre touche (`resolveChargeHit` compare une distance
 * a `charge.width / 2`). Meme raisonnement, mot pour mot, que
 * `ZONE_FILL_RATIO`.
 */
export const CHARGE_FILL_RATIO = 0.32;

/** Debut de la montee vers le lisere, en fraction de la demi-largeur. */
const CHARGE_RIM_INNER = 0.86;

/** Debut du plateau opaque du lisere ; au-dela, l'opacite ne bouge plus jusqu'au bord. */
const CHARGE_RIM_PEAK = 0.93;

/**
 * Rouge du couloir. *« Un long rectangle legerement rouge »* (§4 de la spec) —
 * la meme famille chaude que le remplissage de la barre du boss, parce que les
 * deux disent la meme chose : ceci appartient au boss.
 */
const CHARGE_TINT = 0xc23b22;

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
 * Hors de la charge, `0` : c'est ce qui fait disparaitre le couloir sans qu'un
 * second predicat d'expiration ait a exister a cote de `chargeHoldsAt` — le
 * piege des « deux gardes qui se couvrent », seize fois dans ce depot.
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

/**
 * Bande BLANCHE degradee dans la largeur : un lavis mince au centre, un lisere
 * aux deux bords.
 *
 * Blanche, parce que `Particle.tint` MULTIPLIE — meme raison que
 * `makeZoneTexture` et `makeBarTexture`. Le degrade porte sur `y` (la largeur du
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

export class ChargeRenderer {
  readonly #container = new ParticleContainer({
    // Additif, comme les zones : le couloir passe sur du terrain deja teinte et
    // doit s'y ajouter au lieu de le masquer.
    blendMode: 'add',
    // `rotation` : VRAI, et c'est le seul calque du jeu qui en a besoin — le
    // couloir pointe ou le boss va. `vertex` : la taille du quad vient de la
    // charge annoncee, qui peut differer d'un boss a l'autre (etape 6b).
    // `color` : la teinte ne change jamais, mais l'ALPHA monte a chaque image
    // pendant le chargement, et Pixi le range avec la couleur.
    dynamicProperties: { position: true, color: true, rotation: true, vertex: true, uvs: false },
  });
  /**
   * Le quad du couloir, construit une fois : il n'y a jamais qu'un boss.
   *
   * ⚠️ **UN seul champ nullable, pas deux.** Une texture et une particule
   * separement nullables donneraient deux gardes qui se couvrent l'une l'autre —
   * le motif que ce depot a solde seize fois, plusieurs fois par une suppression
   * de code. Voir `BossBarRenderer#bar`, qui porte le meme avertissement.
   */
  #quad: Particle | null = null;

  constructor() {
    this.#container.boundsArea = new Rectangle(
      -BOUNDS_MARGIN,
      -BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
    );
  }

  /** Expose pour le test, comme sur les autres calques. */
  get boundsArea(): Rectangle {
    return this.#container.boundsArea as Rectangle;
  }

  /** Expose pour le test : « additif » est une exigence du §6.6, pas un detail. */
  get blendMode(): string {
    return this.#container.blendMode;
  }

  /** Vrai des que `load`/`adoptTexture` a cuit son quad — ce que `Stage.layersLoaded` lit. */
  get loaded(): boolean {
    return this.#quad !== null;
  }

  load(): void {
    this.adoptTexture(makeCorridorTexture(CHARGE_TEXTURE_SIZE));
  }

  /**
   * ⚠️ **Separe de `load` PARCE QUE `load` a besoin d'un canevas 2D** que node
   * ne fournit pas — exactement la raison de `adoptTexture` sur `ZoneRenderer`
   * et `BossBarRenderer`. Sans ce point d'accroche, `draw` retournerait a son
   * premier garde dans toute la suite, et **tout son corps pourrait etre retire
   * sans qu'une assertion ne bouge** : c'est litteralement ce que
   * `ZoneRenderer.draw` a fait pendant 237 tests verts.
   */
  adoptTexture(texture: Texture): void {
    // Ancre a GAUCHE, centree en hauteur : le couloir PART de l'origine annoncee
    // et s'etend dans la direction de la charge. Une ancre centree ferait
    // demarrer le rectangle une demi-longueur DERRIERE le boss.
    this.#quad = new Particle({ texture, anchorX: 0, anchorY: 0.5, tint: CHARGE_TINT });
  }

  attach(parent: Container): void {
    parent.addChild(this.#container);
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

    const layout = chargeQuad(charge, tick);
    if (quad && layout) {
      quad.x = layout.x;
      quad.y = layout.y;
      quad.rotation = layout.rotation;
      quad.scaleX = layout.length / CHARGE_TEXTURE_SIZE;
      quad.scaleY = layout.width / CHARGE_TEXTURE_SIZE;
      quad.alpha = layout.alpha;
      children.push(quad);
    }

    this.#container.update();
  }

  destroy(): void {
    this.#container.destroy();
  }
}
