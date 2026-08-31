import { MAP_SIZE } from '@shared/constants';
import { type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

import {
  type DerivedOrbs,
  ORB_FLIGHT_LIFETIME_MS,
  type OrbFlights,
  type PickupTarget,
} from '../net/client';

/**
 * Rendu des orbes d'experience (`DerivedOrbs` et `OrbFlights`,
 * `net/client.ts`) — taches 17 puis 20 de l'etape 5a, sur retour de jeu :
 *
 * > *« L'xp plus nette aussi, legerement attiree par le joueur s'il passe a
 * > cote. Moins d'xp qui tombe ou plus par niveau. »*
 *
 * > *« L'aimantation est plus proche du joueur et attire l'xp jusqu'a lui,
 * > meme s'il l'eloigne. »*
 *
 * ⚠️ **La tache 20 a REMPLACE l'aimantation, elle ne l'a pas reglee.** Il n'y
 * a plus de rayon d'aimant ni d'attraction fonction de la distance : une orbe
 * qu'un joueur touche est RAMASSEE — meme predicat que le serveur, meme rayon
 * `ORB_PICKUP_RADIUS` — et ce qu'on voit ensuite est un vol, qui decore un
 * ramassage deja acquis. Voir `orbFlightFraction`.
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
 * six fois plus grand : la dessiner a ce rayon-la remplirait l'ecran de
 * disques et mentirait sur ce qu'elle est — un objet, pas une aire d'effet.
 *
 * 16 jusqu'a la tache 17, puis 22 (trois morts sur quatre ne laissant plus
 * rien, ce qui restait devait se lire de plus loin), puis **14 a la tache 21**
 * — l'auteur a joue et les a trouvees trop grosses au sol. La capture de la
 * tache 20 a rendu l'orbe mobile et donc lisible par son mouvement : elle n'a
 * plus besoin de sa taille pour se signaler.
 *
 * ⚠️ **Toujours DIFFERENT de `ORB_TEXTURE_DIAMETER`, et il faut que ca le
 * reste** — voir la doc de cette constante-la : c'est le piege de la tache 13,
 * ou l'echelle valait 1 et rendait toute mutation de l'echelle indistinguable
 * de son absence.
 */
export const ORB_DIAMETER_PX = 14;

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
 * Marge de culling : la moitie de ce que l'orbe couvre a l'ecran, meme regle
 * que `ZoneRenderer.CULL_MARGIN` et `MarkRingRenderer.CULL_MARGIN`. Une orbe
 * dont le centre vient de sortir du cadre en montre encore la moitie.
 *
 * ⚠️ **Elle valait `ORB_MAGNET_RADIUS` (180 px) jusqu'a la tache 20**, parce
 * qu'une orbe pouvait alors etre dessinee tres loin de sa vraie position. Ce
 * n'est plus le cas : une orbe au sol est dessinee exactement ou elle est, et
 * une orbe en vol est cullee sur sa position DESSINEE, pas sur son point de
 * depart.
 */
const CULL_MARGIN = ORB_DIAMETER_PX / 2;

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
 * Quelle FRACTION du chemin vers son ramasseur une orbe capturee a parcourue,
 * a l'ecran, `elapsedMs` apres sa capture — tache 20.
 *
 * ## La surete a change de place ; elle n'a pas disparu
 *
 * A la tache 17, l'attraction etait une fonction pure de la DISTANCE, et sa
 * FORME portait toute la surete : 1 a `ORB_PICKUP_RADIUS`, donc a l'instant du
 * ramassage l'orbe etait dessinee sur le joueur — ecart nul par construction —
 * et 0 au-dela, donc une orbe non ramassee restait exactement ou le serveur la
 * croyait. Le prix de cette surete, c'est qu'elle ne SUIVAIT personne : un
 * joueur qui s'eloignait la voyait revenir a sa place.
 *
 * ⚠️ **Ici, la surete est dans le DECLENCHEMENT, plus dans la courbe.** Un vol
 * n'existe que la ou le predicat de ramassage du serveur est deja vrai
 * (`DerivedOrbs.capture`, `ORB_PICKUP_RADIUS` inchange) : l'experience est
 * acquise avant la premiere image du vol. Une animation qui ne peut pas se
 * declencher a tort peut se permettre de coller au joueur — elle ne promet
 * rien qui puisse ne pas arriver. C'est exactement ce qu'une capture naive,
 * declenchee a un rayon a elle, n'aurait pas pu dire.
 *
 * ⚠️ **Elle vaut exactement 1 a l'echeance, et c'est ce qui fait qu'elle
 * ARRIVE.** La position dessinee est interpolee vers la position COURANTE de
 * la cible (voir `OrbRenderer.draw`), donc a la fraction 1 l'orbe est sur le
 * joueur, ou qu'il soit alle entre-temps. Une loi de VITESSE, elle, ne
 * rattraperait un fuyard qu'a condition d'etre reglee au-dessus de la sienne :
 * un second reglage a garder d'accord avec `PLAYER_SPEED` et avec chaque carte
 * « fougue » draftee. Il n'y en a pas.
 *
 * Courbe en S (`smoothstep`) plutot que le carre de la tache 17 : le carre
 * accelerait jusqu'au bout et l'orbe percutait le joueur ; ici elle se decolle
 * sans a-coup et se pose. Aux 11/12 du vol — la derniere image dessinee a
 * 60 Hz avant qu'`OrbFlights.expire` ne retire le vol — elle a deja couvert
 * plus de 97 % du chemin.
 */
export function orbFlightFraction(elapsedMs: number): number {
  if (elapsedMs <= 0) {
    return 0;
  }
  if (elapsedMs >= ORB_FLIGHT_LIFETIME_MS) {
    return 1;
  }
  const t = elapsedMs / ORB_FLIGHT_LIFETIME_MS;
  return t * t * (3 - 2 * t);
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
 * Rendu batché des orbes : celles qui attendent au sol (`DerivedOrbs`) et
 * celles qui ont ete capturees et volent vers leur ramasseur (`OrbFlights`) —
 * **un seul calque, une seule texture, un seul reservoir**, parce que c'est le
 * meme objet a deux instants de sa vie.
 *
 * ⚠️ **Le seul calque dont une partie des positions dessinees n'existe dans
 * aucun modele** (tache 20) : une orbe en vol est placee par une interpolation
 * entre son point de capture et la position courante de sa cible. Voir
 * `orbFlightFraction` pour ce qui rend cette invention sans consequence.
 */
export class OrbRenderer {
  readonly #container = new ParticleContainer({
    // `position` : une orbe en vol change de place a chaque image (tache 20).
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
   * `if (!texture)` et **tout son corps** — echelle, teinte, vols, culling —
   * reste hors de portee de la suite. Voir `adoptAtlas` (tache 9 bis) et
   * `adoptTextures` (tache 12).
   */
  adoptTexture(texture: Texture): void {
    this.#texture = texture;
  }

  /**
   * Les orbes au sol, les orbes en vol, et `players` : les positions DESSINEES
   * des joueurs, telles que `composeFrame` les lit dans `RenderState`. Ce sont
   * elles que l'oeil compare a l'orbe, donc les seules vers lesquelles un vol
   * puisse aller — et ce sont les memes que celles sur lesquelles la capture a
   * ete decidee, un cran plus tot dans la meme image (`GameClient.update`).
   */
  draw(
    orbs: DerivedOrbs,
    flights: OrbFlights,
    players: readonly PickupTarget[],
    view: Rectangle,
    timeMs: number,
  ): void {
    const texture = this.#texture;
    if (!texture) {
      return;
    }
    this.#ensurePool(orbs.count + flights.count, texture);

    const minX = view.x - CULL_MARGIN;
    const maxX = view.x + view.width + CULL_MARGIN;
    const minY = view.y - CULL_MARGIN;
    const maxY = view.y + view.height + CULL_MARGIN;

    const children = this.#container.particleChildren;
    children.length = 0;
    let used = 0;

    // Les orbes au sol : dessinees exactement ou elles sont. Depuis la tache
    // 20, plus aucune ne glisse — celle qu'un joueur touche a quitte cette
    // reserve pour `flights`, a l'instant meme ou le serveur l'a ramassee.
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

    // Les orbes capturees : elles rejoignent leur ramasseur.
    for (let i = 0; i < flights.count; i++) {
      const fromX = flights.fromX[i] ?? 0;
      const fromY = flights.fromY[i] ?? 0;
      // ⚠️ **La position COURANTE de la cible, pas celle de la capture.**
      // C'est toute la difference entre suivre un joueur et viser l'endroit ou
      // il etait : sans cette relecture a chaque image, un joueur qui s'eloigne
      // verrait l'orbe s'arreter dans son dos.
      const target = this.#targetOf(flights.targetId[i] ?? 0, players);
      // Le joueur vise a quitte l'ecran des allies (deconnexion, ou snapshot
      // qui ne le porte plus) : il n'y a plus de destination, donc plus rien a
      // dessiner. Le vol s'eteindra tout seul a son echeance.
      if (!target) {
        continue;
      }
      const f = orbFlightFraction(timeMs - (flights.bornMs[i] ?? 0));
      const x = fromX + (target.x - fromX) * f;
      const y = fromY + (target.y - fromY) * f;
      if (x < minX || x > maxX || y < minY || y > maxY) {
        continue;
      }
      const particle = this.#pool[used];
      if (!particle) {
        break;
      }
      particle.x = x;
      particle.y = y;
      particle.scaleX = ORB_SCALE;
      particle.scaleY = ORB_SCALE;
      particle.tint = ORB_TINT;
      // Pleine opacite, sans pulsation : la pulsation est un appel — « je suis
      // la, viens me prendre ». Une orbe deja ramassee n'appelle plus.
      particle.alpha = 1;
      children.push(particle);
      used++;
    }
    this.#container.update();
  }

  /** Le joueur vise par un vol, ou `undefined` s'il n'est plus dessine. */
  #targetOf(id: number, players: readonly PickupTarget[]): PickupTarget | undefined {
    for (const p of players) {
      if (p.id === id) {
        return p;
      }
    }
    return undefined;
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
