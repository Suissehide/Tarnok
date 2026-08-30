import { MAP_SIZE, REACTION_RADIUS } from '@shared/constants';
import { elementOf } from '@shared/elements';
import type { Projectiles } from '@shared/projectiles';
import { unpackElementPair } from '@shared/protocol';
import { type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

import {
  type DerivedOrbs,
  HIT_FLASH_LIFETIME_MS,
  type HitFlashes,
  REACTION_FLASH_LIFETIME_MS,
  type ReactionFlashes,
} from '../net/client';

/**
 * Rendu des projectiles, des orbes et des flashs d'impact et de reaction.
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

/**
 * Disque NET pour le tir, distinct de `makeGlowTexture` (tache 16, etape 3 :
 * « le projectile EST une tache floue »).
 *
 * `makeGlowTexture` etale son degrade sur les 100 % du rayon — exactement ce
 * qui produit l'effet flou, voulu pour un halo (flash d'impact, orbe) mais
 * pas pour un projectile qu'on doit pouvoir suivre des yeux en vol. Ici, le
 * coeur est plein de `0` a `CORE_FRACTION`, la couleur reste PLEINE (pas de
 * degrade) jusqu'a `EDGE_FRACTION`, et seule la derniere tranche
 * (`EDGE_FRACTION` a `1`) s'estompe — juste assez pour lisser le contour d'un
 * disque aussi petit sans le rendre crenele, jamais pour le flouter.
 */
function makeBoltTexture(diameter: number, color: string): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = diameter;
  canvas.height = diameter;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  const r = diameter / 2;
  const CORE_FRACTION = 0.5;
  const EDGE_FRACTION = 0.8;
  const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(CORE_FRACTION, color);
  gradient.addColorStop(EDGE_FRACTION, color);
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
    this.#texture = makeBoltTexture(20, '#f2c14e');
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
/**
 * Exportee (etape 5a) pour que le test puisse confronter la taille du flash
 * d'IMPACT a celle du flash de REACTION : *« l'etat persistant est discret, la
 * reaction est spectaculaire »* (§6.6) n'est une regle que si l'ecart entre
 * les deux est verifiable.
 */
export const FLASH_MAX_SCALE = 2.4;

/** Cote de la texture du flash d'impact, en pixels. Exportee pour la meme raison. */
export const IMPACT_TEXTURE_DIAMETER = 48;

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
    this.#texture = makeGlowTexture(IMPACT_TEXTURE_DIAMETER, '#ffe9b0');
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

/**
 * Cote de la texture du flash de reaction, en pixels — comme
 * `ZONE_TEXTURE_DIAMETER`, c'est la finesse du disque, pas sa taille a
 * l'ecran : `reactionFlashScale` la ramene a `REACTION_RADIUS`.
 */
export const REACTION_TEXTURE_DIAMETER = 64;

/**
 * Part de sa taille finale qu'un flash de reaction occupe a sa naissance.
 *
 * Il GRANDIT en s'eteignant, comme le flash d'impact — mais il part de plus
 * loin et arrive plus haut : c'est la difference entre « court » et
 * « spectaculaire » du §6.6.
 */
const REACTION_FLASH_MIN_FRACTION = 0.45;

/**
 * Echelle du flash de reaction a l'age relatif `t` (0 a sa naissance, 1 juste
 * avant qu'il s'eteigne), pour une texture de `textureDiameterPx` de cote.
 *
 * ⚠️ **A `t = 1`, le disque dessine fait EXACTEMENT `2 x REACTION_RADIUS`
 * pixels monde.** Ce n'est pas une coquetterie : la doc de `REACTION_RADIUS`
 * (shared/constants.ts) le demande explicitement — *« le flash doit couvrir
 * VISIBLEMENT ce qu'il tue. Un rayon plus petit que le flash ferait mourir des
 * ennemis hors du dessin ; un rayon plus grand tuerait hors champ »*. La
 * constante vit dans `shared/` pour que ce fichier la lise plutot que d'en
 * recopier une seconde.
 *
 * ⚠️ **Ne pas « ameliorer » le flash en l'agrandissant.** Le rendre plus large
 * que `REACTION_RADIUS` promettrait au joueur des morts qui n'auront pas lieu ;
 * plus etroit, il tuerait hors du dessin. C'est la meme discipline que
 * `spriteScale` et `zoneScale` : la taille dessinee est DERIVEE de la portee
 * reelle, jamais reglee a cote d'elle.
 */
export function reactionFlashScale(t: number, textureDiameterPx: number): number {
  if (textureDiameterPx <= 0) {
    return 1;
  }
  const full = (2 * REACTION_RADIUS) / textureDiameterPx;
  return full * (REACTION_FLASH_MIN_FRACTION + (1 - REACTION_FLASH_MIN_FRACTION) * t);
}

/**
 * Teinte d'un flash de reaction, a partir du couple d'elements empaquete par
 * `packElementPair` et du bit de Synergie.
 *
 * | Reaction | Teinte |
 * | --- | --- |
 * | declenchee par DEUX joueurs (`charged`) | `0xffffff` — la texture blanche, telle quelle |
 * | declenchee en solo | la moyenne des teintes des deux elements |
 *
 * ⚠️ **La teinte est le seul encodage de « le coeur du projet » DANS LE
 * MONDE.** Le §6.5 de l'orientation fait de la reaction inter-joueurs la
 * mecanique centrale ; la jauge du HUD en montre le total, mais un chiffre
 * dans un coin d'ecran ne dit pas *quel* moment vient de compter. `0xffffff`
 * est l'identite du produit que fait `tint` (voir `shared/elements.ts`) : la
 * reaction chargee est donc, litteralement, la plus lumineuse que ce renderer
 * puisse dessiner — sans jamais changer sa TAILLE, qui reste asservie a
 * `REACTION_RADIUS` (voir `reactionFlashScale`).
 *
 * ⚠️ **Aucune table par couple d'elements.** Les quatorze reactions restantes
 * du §6.4 (etape 5b) prendront leur teinte ici sans une ligne de plus : c'est
 * le meme pari que `ELEMENT_DEFS`, ou l'index EST l'identifiant.
 */
export function reactionTint(pair: number, charged: boolean): number {
  if (charged) {
    return 0xffffff;
  }
  const [a, b] = unpackElementPair(pair);
  const ta = elementOf(a).tint;
  const tb = elementOf(b).tint;
  const r = (((ta >> 16) & 0xff) + ((tb >> 16) & 0xff)) >> 1;
  const g = (((ta >> 8) & 0xff) + ((tb >> 8) & 0xff)) >> 1;
  const bl = ((ta & 0xff) + (tb & 0xff)) >> 1;
  return (r << 16) | (g << 8) | bl;
}

/**
 * Rendu batche des flashs de reaction (`ReactionFlashes`, `net/client.ts`).
 *
 * ⚠️ **C'est ICI que passe le budget VFX** (§6.6) : la reaction est le seul
 * evenement de cette etape qui soit a la fois rare, arbitre serveur et
 * mortel. Le flash d'impact, lui, accompagne chaque projectile qui touche —
 * il doit donc rester bref et petit, sans quoi les deux se confondent et la
 * hierarchie *« etat persistant discret, reaction spectaculaire »* s'effondre
 * dans un bruit de fond continu.
 *
 * Un conteneur separe de `ImpactFlashRenderer` plutot qu'un drapeau dans le
 * meme : les deux n'ont ni la meme texture, ni la meme duree, ni la meme
 * courbe d'echelle, et un `ParticleContainer` ne porte qu'une texture.
 */
export class ReactionFlashRenderer {
  readonly #container = new ParticleContainer({
    // Additif comme les zones (§6.6) : deux reactions voisines s'additionnent
    // au lieu de se masquer, et le flash reste lisible par-dessus le sol
    // teinte des zones qui l'ont produit.
    blendMode: 'add',
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

  /** Expose pour le test : « additif » est une exigence du §6.6, pas un detail. */
  get blendMode(): string {
    return this.#container.blendMode;
  }

  attach(parent: Container): void {
    parent.addChild(this.#container);
  }

  /**
   * Texture BLANCHE, pas doree comme celle du flash d'impact : c'est
   * `reactionTint` qui la colore, et `tint` multiplie — une texture deja
   * coloree rendrait la teinte du couple d'elements fausse (meme raison que
   * `makeZoneTexture`).
   */
  load(): void {
    this.#texture = makeGlowTexture(REACTION_TEXTURE_DIAMETER, '#ffffff');
  }

  /** `nowMs` doit etre la MEME horloge murale que celle passee a `ReactionFlashes.spawn`. */
  draw(flashes: ReactionFlashes, nowMs: number): void {
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
      const t = Math.min(1, Math.max(0, age / REACTION_FLASH_LIFETIME_MS));
      const scale = reactionFlashScale(t, REACTION_TEXTURE_DIAMETER);

      particle.x = flashes.x[i] ?? 0;
      particle.y = flashes.y[i] ?? 0;
      particle.scaleX = scale;
      particle.scaleY = scale;
      particle.tint = reactionTint(flashes.pair[i] ?? 0, (flashes.charged[i] ?? 0) === 1);
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
