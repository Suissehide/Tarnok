import { MAP_SIZE } from '@shared/constants';
import { dropsCoin } from '@shared/horde';
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
 * qu'un joueur touche est RAMASSEE — meme predicat que le serveur. Depuis la
 * tache 7 de l'etape 7b, ce n'est plus `ORB_PICKUP_RADIUS` pour tout le
 * monde : chaque joueur a SON rayon (base plus ses achats d'aimant), transporte
 * par le `SNAPSHOT` (voir `PickupTarget.pickupRadius`). Ce qu'on voit ensuite
 * est un vol, qui decore un ramassage deja acquis. Voir `orbFlightFraction`.
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
export const ORB_DIAMETER_PX = 24;

/** Echelle d'une particule d'orbe : la texture couvre exactement `ORB_DIAMETER_PX`. */
export const ORB_SCALE = ORB_DIAMETER_PX / ORB_TEXTURE_DIAMETER;

/**
 * Teinte de l'orbe. Portee par la PARTICULE et non cuite dans la texture
 * depuis la tache 17 — meme raison que `makeZoneAtlas` et `makeRingAtlas` :
 * en blanc, `tint` rend exactement la couleur demandee.
 */
//
// ⚠️ **Cyan vif, plus vert** : sur l'herbe de la carte en tuiles, un orbe vert
// disparaissait dans le sol (retour de playtest). Le contraste vient des tons
// cuits en gris (`ORB_SHADES`), que la teinte decline en bleus.
export const ORB_TINT = 0x3ad8ff;

/**
 * La pulsation de l'orbe, EN TAILLE : son echelle respire entre
 * `1 - ORB_PULSE` et `1 + ORB_PULSE` fois `ORB_SCALE`. Elle reste OPAQUE — une
 * pulsation d'opacite eteignait l'orbe dans l'herbe, une pulsation de taille
 * l'allume (retour de playtest : *« plus de contraste et pulsation »*), et
 * reste DOUCE — ample et rapide, elle fatiguait l'oeil (retour suivant).
 */
export const ORB_PULSE = 0.07;
/** Periode de la pulsation, en ms. */
export const ORB_PULSE_MS = 1600;

/**
 * Diametre de la PIECE dans le monde, en pixels — etape 6a, tache 14 : *« les
 * monstres ne droppent pas d'or »*.
 *
 * ⚠️ **Plus grande que l'orbe, et c'est la seule chose que sa taille dit** :
 * une piece tombe quatre fois moins souvent (`COIN_DROP_ONE_IN` contre
 * `ORB_DROP_ONE_IN`), donc elle a le droit d'occuper la place que la rarete lui
 * paie. Une piece de la taille d'une orbe serait un objet de plus a trier dans
 * un tas ; c'en est un qu'on doit repérer.
 *
 * ⚠️ **Toujours DIFFERENT de `ORB_TEXTURE_DIAMETER`** (64) — le piege des
 * taches 13 et 15 de l'etape 5a : a l'egalite, l'echelle vaudrait 1 et toute
 * mutation d'echelle deviendrait indistinguable de son absence. **Et different
 * d'`ORB_DIAMETER_PX`**, sans quoi dessiner les deux a la meme echelle
 * passerait le test.
 */
export const COIN_DIAMETER_PX = 20;

/** Echelle d'une particule de piece : la texture couvre exactement `COIN_DIAMETER_PX`. */
export const COIN_SCALE = COIN_DIAMETER_PX / ORB_TEXTURE_DIAMETER;

/**
 * Teinte de la piece, portee par la PARTICULE comme celle de l'orbe : la
 * texture est cuite en niveaux de gris, `tint` la dore.
 *
 * L'or de `UI Elements/Icons/Icon_03` du pack, **redessine en code** : aucun
 * asset n'entre dans ce depot (licence Pixel Frog, depot public), et l'atlas
 * des monstres est deja a 9,33 Mpx sur 16,78 — une icone d'interface n'y a rien
 * a faire. C'est la sixieme texture procedurale du jeu.
 */
export const COIN_TINT = 0xf5c542;

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
const CULL_MARGIN = (ORB_DIAMETER_PX * (1 + ORB_PULSE)) / 2;

/** Opacite de la face de la piece : pleine, mais sous le lisere qui la borde. */
const COIN_FACE_ALPHA = 0.72;
/** Epaisseur du lisere, en fraction du rayon. */
const COIN_RIM_WIDTH = 0.14;
/** Rayon du cerne grave, en fraction du rayon. */
const COIN_ENGRAVING_RADIUS = 0.56;
/** Epaisseur du cerne grave, en fraction du rayon. */
const COIN_ENGRAVING_WIDTH = 0.1;
/** Opacite du cerne : sous la face, sinon il ne se lirait pas comme un creux. */
const COIN_ENGRAVING_ALPHA = 0.34;

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
 * Le contour sombre des objets au sol, en part du rayon de la case : sur
 * l'herbe de la carte en tuiles, un orbe ou une piece sans contour se perdait
 * dans le sol (retour de playtest). NOIR, donc insensible a `tint` — une
 * multiplication garde le noir noir.
 */
export const DROP_OUTLINE = 0.16;
const OUTLINE_RGBA = 'rgba(20, 16, 18, 1)';

/** Le cerne : un anneau noir plein sur le bord de la case. */
function drawOutline(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.strokeStyle = OUTLINE_RGBA;
  ctx.lineWidth = r * DROP_OUTLINE;
  ctx.beginPath();
  ctx.arc(cx, cy, r * (1 - DROP_OUTLINE / 2), 0, Math.PI * 2);
  ctx.stroke();
}

/**
 * Les trois tons de la bille, en GRIS (la teinte les colore) : le corps, le
 * reflet du haut gauche, le reflet blanc — une lumiere venue d'en haut a
 * gauche, comme tout le pack.
 */
export const ORB_SHADES = [0.62, 0.92, 1] as const;

/**
 * L'orbe d'experience : une BILLE contrastee. Retours de playtest : *« plus
 * de contraste »*, puis *« garde le cote rond »*. Le relief vient de trois
 * tons poses en disques decales, sans une couleur de plus.
 *
 * Dans l'ordre : une ombre douce dessous (noire, donc insensible a la
 * teinte), le corps, le reflet, l'eclat blanc, et un contour noir epais qui
 * s'arrete au bord de la case.
 */
function drawOrb(ctx: CanvasRenderingContext2D, cx: number, cy: number, outer: number): void {
  const r = outer * (1 - DROP_OUTLINE);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.92, r * 0.7, r * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  const disque = (x: number, y: number, rr: number, shade: number): void => {
    const v = Math.round(255 * shade);
    ctx.fillStyle = `rgba(${v}, ${v}, ${v}, 1)`;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fill();
  };
  disque(cx, cy, r, ORB_SHADES[0]);
  disque(cx - r * 0.18, cy - r * 0.18, r * 0.62, ORB_SHADES[1]);
  disque(cx - r * 0.38, cy - r * 0.38, r * 0.2, ORB_SHADES[2]);
  drawOutline(ctx, cx, cy, outer);
}

/**
 * L'atlas des objets au sol : l'orbe en case 0, la PIECE en case 1.
 *
 * ⚠️ **UNE seule source de texture, donc UN seul `ParticleContainer`.** Un
 * conteneur de particules ne porte qu'une texture source ; deux textures
 * independantes auraient demande deux calques, deux reservoirs et deux passes
 * de culling pour des objets qui tombent au meme endroit et se ramassent au
 * meme rayon. C'est exactement ce que `ProjectileRenderer` fait deja avec ses
 * neuf armes.
 */
export function dropCellRect(index: number): { x: number; y: number; w: number; h: number } {
  return {
    x: index * ORB_TEXTURE_DIAMETER,
    y: 0,
    w: ORB_TEXTURE_DIAMETER,
    h: ORB_TEXTURE_DIAMETER,
  };
}

/** Les deux cases de l'atlas : l'orbe, puis la piece. */
export const DROP_ORB_CELL = 0;
export const DROP_COIN_CELL = 1;
/** Le nombre de cases de l'atlas — ce que `loaded` compte. */
export const DROP_CELL_COUNT = 2;

/**
 * Piece BLANCHE — un disque plein, un anneau creux grave dedans, un lisere qui
 * s'arrete net au bord.
 *
 * **Redessinee en code d'apres `UI Elements/Icons/Icon_03`** du pack : aucun
 * asset n'entre dans ce depot, et l'atlas des monstres est plein. Ce qui est
 * repris du dessin d'origine, c'est ce qui le rend lisible a quinze pixels —
 * une face pleine, un cerne grave, un bord franc — pas ses pixels.
 *
 * ⚠️ **En NIVEAUX DE GRIS, comme l'orbe et pour la meme raison** : `tint`
 * multiplie, donc une piece cuite en or ne pourrait plus etre teintee et
 * `COIN_TINT` ne servirait a rien. Le contraste interne, lui, est cuit — c'est
 * ce qui distingue une piece frappee d'un simple disque.
 *
 * ⚠️ **Le profil est DIFFERENT de celui de l'orbe, et il doit le rester** : les
 * deux objets se croisent au sol, ils ne doivent pas se confondre a la seule
 * teinte. L'orbe est creuse au milieu (deux traits concentriques), la piece est
 * pleine et gravee.
 */
function drawCoin(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  // La face pleine, jusqu'au lisere.
  ctx.fillStyle = `rgba(255, 255, 255, ${COIN_FACE_ALPHA})`;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  // Le lisere : un anneau opaque qui s'arrete net au bord de la case.
  ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
  ctx.lineWidth = r * COIN_RIM_WIDTH;
  ctx.beginPath();
  ctx.arc(cx, cy, r * (1 - COIN_RIM_WIDTH / 2), 0, Math.PI * 2);
  ctx.stroke();
  // Le cerne grave : c'est lui qui fait lire une piece FRAPPEE plutot qu'un
  // jeton. Plus sombre que la face, donc dessine en soustrayant de l'opacite.
  ctx.strokeStyle = `rgba(255, 255, 255, ${COIN_ENGRAVING_ALPHA})`;
  ctx.lineWidth = r * COIN_ENGRAVING_WIDTH;
  ctx.beginPath();
  ctx.arc(cx, cy, r * COIN_ENGRAVING_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
}

/** L'icone d'or du HUD : la piece au sol est LA MEME, recollee au chargement. */
const COIN_ICON = '/tinyswords/UI%20Elements/UI%20Elements/Icons/Icon_03.png';

/** Cuit les deux cases cote a cote : l'orbe a gauche, la piece a droite. */
function makeDropAtlas(): { atlas: Texture; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  canvas.width = ORB_TEXTURE_DIAMETER * 2;
  canvas.height = ORB_TEXTURE_DIAMETER;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  const r = ORB_TEXTURE_DIAMETER / 2;
  drawOrb(ctx, r, r, r);
  drawCoin(ctx, ORB_TEXTURE_DIAMETER + r, r, r * (1 - DROP_OUTLINE));
  drawOutline(ctx, ORB_TEXTURE_DIAMETER + r, r, r);
  return { atlas: Texture.from(canvas), canvas };
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
    // `vertex` : la pulsation de l'orbe est une ECHELLE qui bouge a chaque image.
    dynamicProperties: { position: true, color: true, rotation: false, uvs: false, vertex: true },
  });
  readonly #pool: Particle[] = [];
  /**
   * Les deux cases de l'atlas : l'orbe et la piece.
   *
   * ⚠️ **UN tableau, jamais deux champs nullables.** Deux textures separement
   * nullables donneraient deux gardes qui se couvrent l'une l'autre — le motif
   * que ce depot a solde seize fois. `loaded` ne lit qu'une chose.
   */
  #cells: Texture[] = [];
  /** `COIN_TINT` sur la piece procedurale ; blanc une fois l'icone du HUD recollee. */
  #coinTint = COIN_TINT;

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
    return this.#cells.length === DROP_CELL_COUNT;
  }

  load(): void {
    const { atlas, canvas } = makeDropAtlas();
    this.adoptTexture(atlas);
    // La piece du HUD remplace la procedurale des qu'elle est la. Lue a
    // l'execution depuis le pack, comme les cadres (`ui/skin.ts`) : rien
    // n'entre dans le depot. Sans elle, la piece grise doree reste.
    const icon = new Image();
    icon.addEventListener('load', () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }
      const cell = dropCellRect(DROP_COIN_CELL);
      ctx.clearRect(cell.x, cell.y, cell.w, cell.h);
      ctx.imageSmoothingEnabled = false;
      const inset = (cell.w * DROP_OUTLINE) / 2;
      ctx.drawImage(icon, cell.x + inset, cell.y + inset, cell.w - 2 * inset, cell.h - 2 * inset);
      drawOutline(ctx, cell.x + cell.w / 2, cell.y + cell.h / 2, cell.w / 2);
      atlas.source.update();
      this.#coinTint = 0xffffff;
    });
    icon.src = COIN_ICON;
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
  adoptTexture(atlas: Texture): void {
    this.#cells = [DROP_ORB_CELL, DROP_COIN_CELL].map((cell) => {
      const rect = dropCellRect(cell);
      return new Texture({
        source: atlas.source,
        frame: new Rectangle(rect.x, rect.y, rect.w, rect.h),
      });
    });
  }

  /**
   * La case, l'echelle et la teinte d'un objet au sol, DEDUITES de son
   * identite (etape 6a, tache 14).
   *
   * ⚠️ **Rien n'est transmis pour ca.** `dropsCoin` vit dans `shared/`, donc le
   * dessin d'une piece ne coute pas un octet — exactement le modele de
   * `dropsOrb`, qui fait deja exister l'orbe des deux cotes sans l'annoncer.
   */
  #kindOf(entityId: number): { texture: Texture | undefined; scale: number; tint: number } {
    return dropsCoin(entityId)
      ? { texture: this.#cells[DROP_COIN_CELL], scale: COIN_SCALE, tint: this.#coinTint }
      : { texture: this.#cells[DROP_ORB_CELL], scale: ORB_SCALE, tint: ORB_TINT };
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
    const fallback = this.#cells[DROP_ORB_CELL];
    if (!fallback) {
      return;
    }
    this.#ensurePool(orbs.count + flights.count, fallback);

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
      const kind = this.#kindOf(orbs.id[i] ?? 0);
      if (!kind.texture) {
        break;
      }
      particle.x = x;
      particle.y = y;
      particle.texture = kind.texture;
      particle.tint = kind.tint;
      particle.alpha = 1;
      // La pulsation, EN TAILLE et seulement pour l'orbe, dephasee par orbe
      // (son tick de naissance) : un signal de ramassage vivant au sol. La
      // piece reste immobile — elle est rare, elle n'a pas besoin d'appeler.
      const souffle = dropsCoin(orbs.id[i] ?? 0)
        ? 1
        : 1 +
          ORB_PULSE *
            Math.sin((timeMs / ORB_PULSE_MS) * Math.PI * 2 + (orbs.bornTick[i] ?? 0) * 0.7);
      particle.scaleX = kind.scale * souffle;
      particle.scaleY = kind.scale * souffle;
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
      const kind = this.#kindOf(flights.dropId[i] ?? 0);
      if (!kind.texture) {
        break;
      }
      particle.x = x;
      particle.y = y;
      particle.texture = kind.texture;
      particle.scaleX = kind.scale;
      particle.scaleY = kind.scale;
      particle.tint = kind.tint;
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
