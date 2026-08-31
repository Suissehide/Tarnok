import { MAP_SIZE, ORB_PICKUP_RADIUS } from '@shared/constants';
import { type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

import type { DerivedOrbs } from '../net/client';

/**
 * Rendu des orbes d'experience (`DerivedOrbs`, `net/client.ts`) — tache 17 de
 * l'etape 5a, sur retour de jeu :
 *
 * > *« L'xp plus nette aussi, legerement attiree par le joueur s'il passe a
 * > cote. Moins d'xp qui tombe ou plus par niveau. »*
 *
 * ⚠️ **Un module a part depuis cette tache**, comme `zone-renderer.ts` et
 * `mark-renderer.ts` avant lui. L'orbe vivait dans `projectile-renderer.ts` et
 * y partageait `makeGlowTexture` avec les flashs — or les deux disent l'inverse
 * l'un de l'autre : un flash doit s'evanouir sans bord, un objet a ramasser
 * doit avoir un contour. **C'est ce partage qui la gardait floue.**
 *
 * Meme discipline de conteneur que ses deux voisins : un `ParticleContainer`,
 * des bornes explicites, un reservoir de `Particle` reutilise, aucune
 * allocation en regime etabli.
 */

/** Marge des bornes explicites, meme raisonnement que `ZoneRenderer`. */
const BOUNDS_MARGIN = 256;

/**
 * Cote de la texture d'orbe, en pixels.
 *
 * ⚠️ **DIFFERENT de `ORB_DIAMETER_PX`, et il faut que ça le reste** — c'est la
 * lecon de `MARK_RING_TEXTURE_DIAMETER` (tache 15), la « fixture qui masque »
 * logee dans une constante de production. Jusqu'a la tache 17, l'orbe etait
 * une texture de 16 px dessinee sans aucune echelle : `scaleX` valait 1 par
 * defaut, et toute mutation de l'echelle etait indistinguable de son absence.
 *
 * Ce n'est PAS la taille a l'ecran : c'est la finesse du dessin, que
 * `ORB_SCALE` ramene ensuite a `ORB_DIAMETER_PX`. Meme role que
 * `ZONE_TEXTURE_DIAMETER`.
 */
export const ORB_TEXTURE_DIAMETER = 64;

/**
 * Diametre de l'orbe dans le monde, en pixels.
 *
 * ⚠️ **Un choix visuel, PAS une regle de jeu** — et c'est ce qui le distingue
 * de `ZONE_RADIUS` ou de `MARK_RING_DIAMETER_PX`, tous deux derives de ce qui
 * decide reellement. Ce que l'orbe touche, c'est `ORB_PICKUP_RADIUS` (90 px),
 * quatre fois plus grand : la dessiner a ce rayon-la remplirait l'ecran de
 * disques et mentirait sur ce qu'elle est — un objet, pas une aire d'effet.
 *
 * Passe de 16 a 22 a la tache 17 : trois morts sur quatre ne laissent plus
 * rien (`ORB_DROP_ONE_IN`), donc ce qui reste doit se lire de plus loin.
 */
export const ORB_DIAMETER_PX = 22;

/** Echelle d'une particule d'orbe : la texture couvre exactement `ORB_DIAMETER_PX`. */
export const ORB_SCALE = ORB_DIAMETER_PX / ORB_TEXTURE_DIAMETER;

/**
 * Teinte de l'orbe. Portee par la PARTICULE et non cuite dans la texture
 * depuis la tache 17 — meme raison que `makeZoneTexture` et `makeRingTexture` :
 * en blanc, `tint` rend exactement la couleur demandee.
 */
export const ORB_TINT = 0x7fd858;

/** Creux de la pulsation ; la crete vaut 1. Voir `draw`. */
export const ORB_ALPHA_MIN = 0.75;

/**
 * Distance a laquelle l'orbe COMMENCE a etre attiree par un joueur — tache 17 :
 * *« legerement attiree par le joueur s'il passe a cote »*.
 *
 * ⚠️ **Derivee de `ORB_PICKUP_RADIUS`, et strictement plus grande que lui.**
 * Egale, l'aimantation serait invisible : le serveur ramasse des que le joueur
 * entre dans ce rayon, donc l'orbe n'aurait pas une image pour glisser. Le
 * double laisse `ORB_PICKUP_RADIUS` de course a l'attraction, exactement la
 * distance qu'un joueur parcourt en un tiers de seconde (`PLAYER_SPEED`).
 */
export const ORB_MAGNET_RADIUS = 2 * ORB_PICKUP_RADIUS;

/** Fin du coeur plein, en fraction du rayon de la texture. */
const ORB_CORE_EDGE = 0.42;
/** Debut du creux : l'ecart avec `ORB_CORE_EDGE` est la rampe qui rend le coeur net. */
const ORB_GAP_INNER = 0.5;
/** Opacite du creux entre le coeur et le lisere — c'est lui qui fait lire DEUX traits, pas un halo. */
const ORB_GAP_ALPHA = 0.2;
/** Debut de la montee vers le lisere exterieur. */
const ORB_RIM_INNER = 0.78;
/** Debut du plateau opaque du lisere ; au-dela, l'orbe s'arrete NET au bord de la texture. */
const ORB_RIM_PEAK = 0.86;

/**
 * Ce que l'orbe a besoin de connaitre d'un joueur pour se laisser attirer :
 * une position, rien de plus.
 *
 * **Jumelle structurelle de `PickupPoint`** (`back/src/combat.ts`), et
 * volontairement : c'est le meme point que le serveur compare a
 * `ORB_PICKUP_RADIUS` pour decider du ramassage. Une interface plutot que
 * `PlayerSnapshot`, pour que le test n'ait pas a fabriquer un snapshot entier.
 */
export interface MagnetPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Quelle FRACTION du chemin vers le joueur l'orbe a deja parcourue, a l'ecran,
 * quand ce joueur est a `distance` d'elle — tache 17, etape 2.
 *
 * ## Le mouvement est COSMETIQUE, et c'est un choix, pas un oubli
 *
 * Le plan laissait deux issues ouvertes : animer l'orbe cote client seul, ou
 * la simuler des deux cotes. **La premiere est retenue**, et le risque qu'elle
 * porte — *« le ramassage se declenche la ou l'orbe n'est plus dessinee »* —
 * est **annule par la forme de cette courbe**, pas par la chance :
 *
 * - a `ORB_MAGNET_RADIUS` et au-dela, la fraction vaut 0 : l'orbe est dessinee
 *   exactement ou le serveur la croit ;
 * - a `ORB_PICKUP_RADIUS` et en deça, elle vaut 1 : l'orbe est dessinee
 *   exactement SUR le joueur.
 *
 * Or `ORB_PICKUP_RADIUS` est precisement la distance a laquelle le serveur
 * ramasse. **A l'instant du ramassage, l'orbe est donc dessinee sur le joueur
 * qui la ramasse — ecart nul.** L'orbe ne disparait jamais ailleurs que la ou
 * l'oeil l'attend, et l'issue 2 (simuler des deux cotes) n'a rien a corriger.
 *
 * ⚠️ **Ce que cette borne ne couvre pas, dit plutot que cache** : le client
 * dessine ses coequipiers avec `INTERP_DELAY_MS` de retard et se predit
 * lui-meme, donc la position qu'il compare n'est pas au pixel celle du
 * serveur. L'ecart residuel est celui de la reconciliation, pas de
 * l'aimantation — au pire `PLAYER_SPEED * INTERP_DELAY_MS`, soit une quinzaine
 * de pixels sur un ALLIE, et il existait deja avant cette tache.
 *
 * La courbe est un carre plutot qu'une droite : l'orbe fremit d'abord, puis
 * part d'un coup. Une attraction lineaire lit comme une derive, pas comme un
 * aimant.
 */
export function orbPullFraction(distance: number): number {
  if (distance <= ORB_PICKUP_RADIUS) {
    return 1;
  }
  if (distance >= ORB_MAGNET_RADIUS) {
    return 0;
  }
  const t = (ORB_MAGNET_RADIUS - distance) / (ORB_MAGNET_RADIUS - ORB_PICKUP_RADIUS);
  return t * t;
}

/**
 * Orbe BLANCHE a bord net, dessinee une fois puis teintee par particule —
 * tache 17, etape 1 : *« l'xp plus nette »*, meme traitement que les zones
 * (tache 16) et les anneaux de marque (tache 15).
 *
 * ⚠️ **Le profil precedent etait un halo, et un halo n'a pas de bord.** Blanc
 * au centre, vert a 0,35 de rayon, transparent au bord : aucune frontiere a
 * lire, l'orbe se fondait dans le sol et dans les flashs — qui utilisaient la
 * MEME fonction (`makeGlowTexture`) alors qu'ils disent l'inverse d'elle. Un
 * flash doit s'evanouir ; un objet a ramasser doit avoir un contour.
 *
 * Le nouveau profil est un coeur plein, un creux, puis un lisere opaque **qui
 * va jusqu'au bord de la texture et s'arrete net** — le `ctx.arc` de rayon `r`
 * fait la coupure, comme pour la zone. Deux traits concentriques se lisent a
 * 22 px la ou un degre unique se lit comme une tache.
 *
 * Tous les arrets sont ecrits en `rgba(...)`, y compris les opaques : c'est ce
 * qui permet au test de lire le profil sans avoir a comprendre deux notations.
 */
function makeOrbTexture(diameter: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = diameter;
  canvas.height = diameter;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  const r = diameter / 2;
  const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(ORB_CORE_EDGE, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(ORB_GAP_INNER, `rgba(255, 255, 255, ${ORB_GAP_ALPHA})`);
  gradient.addColorStop(ORB_RIM_INNER, `rgba(255, 255, 255, ${ORB_GAP_ALPHA})`);
  gradient.addColorStop(ORB_RIM_PEAK, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 1)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  return Texture.from(canvas);
}

/**
 * Rendu batché des orbes derivés (`DerivedOrbs`, `net/client.ts`).
 *
 * ⚠️ **Le seul calque dont la position dessinee n'est pas la position du
 * modele** (tache 17) : une orbe a portee glisse vers le joueur. Voir
 * `orbPullFraction` pour ce qui rend ce mensonge sans consequence.
 */
export class OrbRenderer {
  readonly #container = new ParticleContainer({
    // `position` : l'aimantation deplace l'orbe a chaque image (tache 17).
    // `color` : la pulsation fait bouger l'opacite, et le reservoir est
    // reutilise d'une image a l'autre.
    dynamicProperties: { position: true, color: true, rotation: false, uvs: false },
  });
  readonly #pool: Particle[] = [];
  #texture: Texture | null = null;

  constructor() {
    this.#container.boundsArea = new Rectangle(
      -BOUNDS_MARGIN,
      -BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
    );
  }

  get boundsArea(): Rectangle {
    return this.#container.boundsArea as Rectangle;
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

  load(): void {
    this.adoptTexture(makeOrbTexture(ORB_TEXTURE_DIAMETER));
  }

  /**
   * Rend le calque capable de dessiner a partir d'une texture deja cuite.
   *
   * ⚠️ **Ajoute a la tache 17, pour la meme raison qu'a la tache 16 sur
   * `ZoneRenderer`** : `load()` cuit sa texture sur un canevas 2D que node ne
   * fournit pas, donc sans ce point d'accroche `draw` retourne a son premier
   * `if (!texture)` et **tout son corps** — echelle, teinte, aimantation,
   * culling — reste hors de portee de la suite. Voir `adoptAtlas` (tache 9
   * bis) et `adoptTextures` (tache 12).
   */
  adoptTexture(texture: Texture): void {
    this.#texture = texture;
  }

  /**
   * `players` sont les positions DESSINEES des joueurs, telles que
   * `composeFrame` les lit dans `RenderState` : ce sont elles que l'oeil
   * compare a l'orbe, donc les seules dont l'aimantation puisse partir.
   */
  draw(orbs: DerivedOrbs, players: readonly MagnetPoint[], view: Rectangle, timeMs: number): void {
    const texture = this.#texture;
    if (!texture) {
      return;
    }
    this.#ensurePool(orbs.count, texture);

    // ⚠️ **Une marge, depuis la tache 17.** Sans elle, une orbe dont la
    // position VRAIE vient de sortir du cadre serait ecartee alors que sa
    // position DESSINEE — tiree vers un joueur qui, lui, est a l'ecran — y
    // serait encore : elle disparaitrait en pleine aimantation.
    const minX = view.x - ORB_MAGNET_RADIUS;
    const maxX = view.x + view.width + ORB_MAGNET_RADIUS;
    const minY = view.y - ORB_MAGNET_RADIUS;
    const maxY = view.y + view.height + ORB_MAGNET_RADIUS;

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
      // Le joueur le PLUS PROCHE, jamais le premier de la liste : c'est lui
      // que le serveur verra entrer dans `ORB_PICKUP_RADIUS` en premier
      // (`OrbField.resolvePickups` s'arrete au premier joueur a portee).
      let best2 = Number.POSITIVE_INFINITY;
      let bestX = 0;
      let bestY = 0;
      for (const p of players) {
        const dx = p.x - x;
        const dy = p.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < best2) {
          best2 = d2;
          bestX = p.x;
          bestY = p.y;
        }
      }
      // Aucune garde `players.length > 0` : sans joueur, `best2` reste
      // `Infinity`, donc la fraction vaut deja 0 et l'orbe est dessinee ou
      // elle est. Une seconde garde ici se couvrirait avec la premiere borne
      // de `orbPullFraction` — le depot en a deja supprime quinze.
      const pull = orbPullFraction(Math.sqrt(best2));
      particle.x = x + (bestX - x) * pull;
      particle.y = y + (bestY - y) * pull;
      particle.scaleX = ORB_SCALE;
      particle.scaleY = ORB_SCALE;
      particle.tint = ORB_TINT;
      // Pulsation douce, dephasee par orbe (via son tick de naissance) : un
      // signal de ramassage vivant au sol, sans jamais devenir le flash
      // « genereux » reserve a l'impact — le §4.3 les distingue explicitement.
      // Resserree a la tache 17 : une orbe qui s'efface a moitie n'est plus
      // « nette ».
      const phase = (orbs.bornTick[i] ?? 0) * 0.7;
      const creux = (1 - ORB_ALPHA_MIN) / 2;
      particle.alpha = 1 - creux + creux * Math.sin(timeMs / 260 + phase);
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
