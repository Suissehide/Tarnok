import { MAP_SIZE, REACTION_RADIUS } from '@shared/constants';
import { elementOf } from '@shared/elements';
import type { Projectiles } from '@shared/projectiles';
import { unpackElementPair } from '@shared/protocol';
import {
  type ProjectileLook,
  type ProjectileShape,
  projectileAlpha,
  projectileTrailPx,
  WEAPONS,
  type Weapon,
  weaponOf,
} from '@shared/weapons';
import { Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

import {
  HIT_FLASH_LIFETIME_MS,
  type HitFlashes,
  REACTION_FLASH_LIFETIME_MS,
  type ReactionFlashes,
} from '../net/client';

/**
 * Rendu des projectiles et des flashs d'impact et de reaction.
 *
 * ⚠️ **Les orbes ont quitte ce module a la tache 17**, pour `orb-renderer.ts`.
 * Elles y partageaient `makeGlowTexture` avec les flashs alors qu'elles disent
 * l'inverse d'eux : un flash s'evanouit, un objet a ramasser a un contour. Ce
 * partage etait exactement ce qui gardait l'orbe floue.
 *
 * Quatre `ParticleContainer`s (les projectiles en comptent deux depuis la tache
 * 12 : leurs trainees et leurs tetes), meme discipline que `HordeRenderer` :
 * bornes explicites (`boundsArea`, voir sa doc — un `ParticleContainer` ne les
 * calcule jamais lui-meme), un reservoir de `Particle` reutilise, aucune
 * allocation en regime etabli dans `draw()`.
 *
 * Pas de tri en profondeur par bande ici, contrairement a la horde :
 * projectiles et flashs sont de petits points, sans la hauteur de
 * sprite qui rend l'ordre visible sur la vue ecrasee du §4.5 — l'ordre entre
 * particules d'un meme calque ne se voit pas a l'oeil.
 *
 * Textures procedurales (canvas 2D), pas un asset Tiny Swords : aucun atlas
 * dedie a ces elements n'existe encore sur MinIO (seul `derived/monsters.json`
 * existe a ce jour), et en ajouter un au depot risquerait la contrainte de
 * licence (§4 du brief). Depuis la tache 12, les projectiles ne sont plus un
 * simple disque : leur atlas est CUIT au chargement, une case par arme, a
 * partir de `Weapon.look` — mais toujours au vol, et il peut etre remplace par
 * de l'art reel sans toucher a l'API de ces classes.
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
 * Cote d'une case de l'atlas des projectiles, en pixels.
 *
 * Ce n'est PAS la taille a l'ecran — c'est la finesse du dessin, que
 * `Weapon.look.diameterPx` ramene ensuite a la taille reelle. Meme role que
 * `ZONE_TEXTURE_DIAMETER` pour les zones.
 */
export const PROJECTILE_CELL_PX = 32;

/** Cases par ligne dans l'atlas. 4 x 4 = 16 cases pour neuf armes aujourd'hui. */
const PROJECTILE_ATLAS_COLS = 4;

/** Cote de l'atlas, en pixels : une puissance de deux qui contient la grille. */
export const PROJECTILE_ATLAS_PX = PROJECTILE_CELL_PX * PROJECTILE_ATLAS_COLS;

/**
 * Part du rayon d'une case occupee par le corps PLEIN du projectile ; le reste
 * est la place laissee au halo.
 *
 * ⚠️ **Fixe, et volontairement pas un champ de `ProjectileLook`.** Deux armes
 * de meme `diameterPx` doivent occuper la meme place a l'ecran quel que soit
 * leur halo : sans cette fraction commune, `glow` deviendrait un second
 * reglage de taille cache derriere un reglage de lumiere, et le joueur ne
 * pourrait plus comparer deux projectiles.
 */
const PROJECTILE_SHAPE_FRACTION = 0.62;

/**
 * Marge de culling des projectiles, DERIVEE du catalogue : la plus grande
 * empreinte qu'une arme puisse laisser a l'ecran (sa trainee plus son corps).
 *
 * ⚠️ **Le rendu d'avant la tache 12 n'en avait aucune** : un projectile dont
 * le centre venait de quitter le cadre disparaissait d'un coup. Avec une
 * trainee, ce qui disparait n'est plus un point mais un trait de plusieurs
 * dizaines de pixels — et il faut donc continuer a le dessiner tant qu'un
 * bout de lui peut encore etre dans le cadre. Derivee et non choisie, comme
 * `zoneScale` : ajouter une arme a longue trainee elargit la marge toute
 * seule.
 */
export const PROJECTILE_CULL_MARGIN = WEAPONS.reduce(
  (max, w) => Math.max(max, projectileTrailPx(w) + w.look.diameterPx),
  0,
);

/**
 * Rectangle de la case `index` dans l'atlas.
 *
 * Leve hors de la grille : un atlas trop petit pour le catalogue ferait
 * silencieusement dessiner toutes les armes suivantes avec la texture d'une
 * autre — exactement le defaut que la tache 12 vient corriger.
 */
export function projectileCellRect(index: number): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const capacity = PROJECTILE_ATLAS_COLS * PROJECTILE_ATLAS_COLS;
  if (index < 0 || index >= capacity) {
    throw new Error(`case de projectile hors atlas : ${index} (capacite ${capacity})`);
  }
  return {
    x: (index % PROJECTILE_ATLAS_COLS) * PROJECTILE_CELL_PX,
    y: Math.floor(index / PROJECTILE_ATLAS_COLS) * PROJECTILE_CELL_PX,
    w: PROJECTILE_CELL_PX,
    h: PROJECTILE_CELL_PX,
  };
}

/** `#rrggbb`, pour un `fillStyle` de canevas. */
function cssTint(tint: number): string {
  return `#${tint.toString(16).padStart(6, '0')}`;
}

/** `rgba(...)`, meme teinte a l'opacite demandee. */
function cssTintAlpha(tint: number, alpha: number): string {
  const r = (tint >> 16) & 0xff;
  const g = (tint >> 8) & 0xff;
  const b = tint & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Le dessin d'une forme, centre sur `(0, 0)` et **pointant vers +x**, de
 * « rayon » `r`. `draw` fait tourner la particule de `Projectiles.headingAt`,
 * donc +x est toujours l'avant.
 *
 * ⚠️ **La table est un `Record<ProjectileShape, …>`, et c'est la garde.** Le
 * compilateur refuse une forme du catalogue sans dessin : aucun test n'a besoin
 * de le verifier, et un test qui le ferait serait une seconde garde derriere
 * celle-ci.
 */
const SHAPE_PAINTERS: Record<ProjectileShape, (ctx: CanvasRenderingContext2D, r: number) => void> =
  {
    /** Losange allonge : un fer de lame. */
    lame: (ctx, r) => {
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.lineTo(-0.2 * r, -0.42 * r);
      ctx.lineTo(-r, 0);
      ctx.lineTo(-0.2 * r, 0.42 * r);
      ctx.closePath();
      ctx.fill();
    },
    /** Chevron : une pointe de fleche a ailerons. */
    fleche: (ctx, r) => {
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.lineTo(-r, -0.62 * r);
      ctx.lineTo(-0.4 * r, 0);
      ctx.lineTo(-r, 0.62 * r);
      ctx.closePath();
      ctx.fill();
    },
    /** Goutte pointue vers l'avant, dos arrondi. */
    petale: (ctx, r) => {
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.quadraticCurveTo(-0.1 * r, -0.75 * r, -r, 0);
      ctx.quadraticCurveTo(-0.1 * r, 0.75 * r, r, 0);
      ctx.closePath();
      ctx.fill();
    },
    /** Langue de feu : large a l'avant, effilee vers l'ARRIERE. */
    flamme: (ctx, r) => {
      ctx.beginPath();
      ctx.moveTo(-r, 0);
      ctx.quadraticCurveTo(0.1 * r, -0.85 * r, r, 0);
      ctx.quadraticCurveTo(0.1 * r, 0.85 * r, -r, 0);
      ctx.closePath();
      ctx.fill();
    },
    /** Disque plein. */
    sphere: (ctx, r) => {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
    },
    /** Couronne : la seule forme creuse du catalogue. */
    anneau: (ctx, r) => {
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2);
      ctx.arc(0, 0, r * 0.44, 0, Math.PI * 2, true);
      ctx.fill('evenodd');
    },
    /** Trait tres fin, deux fois plus long que large. */
    aiguille: (ctx, r) => {
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.lineTo(-r, -0.16 * r);
      ctx.lineTo(-r, 0.16 * r);
      ctx.closePath();
      ctx.fill();
    },
    /** Petit carre : de la mitraille, pas un trait. */
    grain: (ctx, r) => {
      ctx.fillRect(-0.62 * r, -0.62 * r, 1.24 * r, 1.24 * r);
    },
    /** Etoile a quatre branches, allongee dans l'axe du vol. */
    eclat: (ctx, r) => {
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.lineTo(0.22 * r, -0.28 * r);
      ctx.lineTo(0, -0.72 * r);
      ctx.lineTo(-0.22 * r, -0.28 * r);
      ctx.lineTo(-r, 0);
      ctx.lineTo(-0.22 * r, 0.28 * r);
      ctx.lineTo(0, 0.72 * r);
      ctx.lineTo(0.22 * r, 0.28 * r);
      ctx.closePath();
      ctx.fill();
    },
  };

/**
 * Peint une case de l'atlas : halo, corps teinte, coeur blanc.
 *
 * ⚠️ **La teinte est CUITE dans la case, pas posee par `Particle.tint`.**
 * `tint` multiplie composante par composante : il ne sait pas garder un coeur
 * blanc plus clair que le corps colore, alors que c'est exactement ce qui
 * faisait qu'on suivait l'ancien `makeBoltTexture` des yeux en vol (tache 16,
 * etape 3 : *« le projectile EST une tache floue »*, corrige en un disque
 * net). Cuire la couleur rend les trois strates possibles ; l'atlas ne coute
 * rien de plus, il est dessine une fois au chargement.
 *
 * La trainee, elle, fait l'inverse — texture blanche teintee par particule
 * (voir `makeStreakTexture`) : elle n'a qu'une strate, donc `tint` suffit.
 */
function paintProjectileCell(
  ctx: CanvasRenderingContext2D,
  look: ProjectileLook,
  cx: number,
  cy: number,
): void {
  const r = PROJECTILE_CELL_PX / 2;
  const body = r * PROJECTILE_SHAPE_FRACTION;

  ctx.save();
  ctx.translate(cx, cy);

  if (look.glow > 0) {
    const halo = ctx.createRadialGradient(0, 0, body * 0.35, 0, 0, r);
    halo.addColorStop(0, cssTintAlpha(look.tint, look.glow));
    halo.addColorStop(1, cssTintAlpha(look.tint, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const paint = SHAPE_PAINTERS[look.shape];
  ctx.fillStyle = cssTint(look.tint);
  paint(ctx, body);
  // Coeur blanc, la meme forme reduite : c'est lui qui donne au projectile son
  // point chaud et le rend suivable a dix pixels de cote.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  paint(ctx, body * 0.42);

  ctx.restore();
}

/**
 * Cuit l'atlas des projectiles : une case par arme, `look` compris.
 *
 * Un seul canevas, donc une seule `TextureSource`, donc **un seul appel de
 * dessin** pour les neuf apparences : le `ParticleContainer` de Pixi lie la
 * source de son PREMIER enfant et dessine tout le lot avec (voir
 * `GlParticleContainerAdaptor`). Neuf conteneurs auraient donne neuf lots.
 */
function makeProjectileAtlas(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = PROJECTILE_ATLAS_PX;
  canvas.height = PROJECTILE_ATLAS_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  for (const weapon of WEAPONS) {
    const cell = projectileCellRect(weapon.id);
    paintProjectileCell(ctx, weapon.look, cell.x + cell.w / 2, cell.y + cell.h / 2);
  }
  return Texture.from(canvas);
}

/** Longueur de la texture de trainee, en pixels. Ramenee par `draw` a `projectileTrailPx`. */
export const STREAK_LENGTH_PX = 64;
/** Epaisseur de la texture de trainee, en pixels. Ramenee par `draw` au calibre de l'arme. */
export const STREAK_THICKNESS_PX = 16;

/**
 * La trainee : un degrade BLANC, opaque a droite (la tete) et transparent a
 * gauche (la queue), adouci sur les bords.
 *
 * Blanche pour la meme raison que `makeZoneTexture` : `Particle.tint`
 * multiplie, donc une texture blanche rend exactement `look.tint`.
 */
function makeStreakTexture(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = STREAK_LENGTH_PX;
  canvas.height = STREAK_THICKNESS_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }

  const along = ctx.createLinearGradient(0, 0, STREAK_LENGTH_PX, 0);
  along.addColorStop(0, 'rgba(255, 255, 255, 0)');
  along.addColorStop(1, 'rgba(255, 255, 255, 1)');
  ctx.fillStyle = along;
  ctx.fillRect(0, 0, STREAK_LENGTH_PX, STREAK_THICKNESS_PX);

  // Adoucissement transversal : sans lui la trainee est un ruban a bords nets,
  // qui lit comme une barre et non comme une trace.
  const across = ctx.createLinearGradient(0, 0, 0, STREAK_THICKNESS_PX);
  across.addColorStop(0, 'rgba(255, 255, 255, 0)');
  across.addColorStop(0.5, 'rgba(255, 255, 255, 1)');
  across.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, STREAK_LENGTH_PX, STREAK_THICKNESS_PX);

  return Texture.from(canvas);
}

/**
 * Epaisseur de la trainee, en fraction du calibre du projectile. Plus fine que
 * le corps : une trainee aussi large que la tete masquerait la tete.
 */
const TRAIL_THICKNESS_FRACTION = 0.6;

/**
 * Opacite de la trainee, relative a celle du projectile.
 *
 * ⚠️ **Le §6.6 vaut ici aussi.** La trainee est additive, et il y en a une par
 * projectile : a pleine opacite, une salve de lance-flammes suffit a blanchir
 * la zone de contact — exactement ce que `ZONE_ALPHA` evite pour les zones.
 */
export const TRAIL_ALPHA = 0.4;

/**
 * Ce que le conteneur reteleverse vraiment a chaque image — voir
 * `ProjectileRenderer.dynamicHeadChannels`.
 */
function dynamicChannelsOf(container: ParticleContainer): {
  uvs: boolean;
  rotation: boolean;
  vertex: boolean;
  color: boolean;
} {
  const props = container._properties;
  return {
    uvs: props.uvs?.dynamic === true,
    rotation: props.rotation?.dynamic === true,
    vertex: props.vertex?.dynamic === true,
    color: props.color?.dynamic === true,
  };
}

/**
 * Rendu batché des projectiles (`shared/projectiles.ts`) : **une apparence par
 * arme** (etape 5a, tache 12).
 *
 * ⚠️ **Deux quads par projectile, jamais plus — c'est la borne, et elle est
 * de CONSTRUCTION.** La trainee est un seul quad etire dans l'axe du vol, pas
 * une file de segments : a `PROJECTILE_CAPACITY` (1024) projectiles, ce
 * renderer pose au pire **2 048 quads**. Une trainee a six segments en aurait
 * pose 6 144, et rien dans le code ne l'aurait rappele — le §4.3 de
 * l'orientation dit que *« le danger est le VFX, pas les sprites »*, et la
 * tache 4 de cette etape a deja montre ce que « quelques dizaines » devient
 * quand personne ne compte (368 zones mesurees). Le compte est mesure par
 * `projectile-renderer.test.ts`, et il ne depend PAS de la longueur des
 * trainees.
 *
 * Deux `ParticleContainer`s : les trainees dessous (additives, une seule
 * texture blanche teintee par particule), les tetes dessus (l'atlas, une case
 * par arme). Un `ParticleContainer` ne porte qu'une texture source et qu'un
 * mode de fusion — les separer n'est pas un choix.
 */
export class ProjectileRenderer {
  readonly #trails = new ParticleContainer({
    // Additif, comme les zones et le flash de reaction (§6.6) : deux trainees
    // qui se croisent s'additionnent au lieu de se masquer.
    blendMode: 'add',
    // `rotation` : la trainee est orientee dans l'axe du vol. `vertex` : elle
    // est etiree a la longueur de l'arme. `color` : teinte de l'arme et fondu
    // de fin de vie. `uvs` : une seule texture, rien a rafraichir.
    dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: false },
  });
  readonly #heads = new ParticleContainer({
    // `uvs` : le reservoir est REUTILISE, et le creneau 3 peut porter une
    // dague a cette image et une grenade a la suivante — a `false`, la case
    // d'atlas televersee une fois ne changerait plus jamais et toutes les
    // armes finiraient dessinees avec la premiere rencontree. C'est la meme
    // raison qui fait `color: true` sur le conteneur de la horde.
    dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: true },
  });
  /** Le calque, vu du monde : trainees puis tetes. Voir `attach`. */
  readonly #group = new Container();
  readonly #headPool: Particle[] = [];
  readonly #trailPool: Particle[] = [];
  /** Une case d'atlas par arme, indexee par `Weapon.id`. Vide tant que rien n'est adopte. */
  #cells: Texture[] = [];
  #streak: Texture | null = null;

  constructor() {
    // Bornes explicites couvrant la carte entiere : voir la doc de fichier.
    this.#heads.boundsArea = mapBoundsArea();
    this.#trails.boundsArea = mapBoundsArea();
  }

  /** Expose pour le test : lit ce que `HordeRenderer` pose aussi dans son constructeur. */
  get boundsArea(): Rectangle {
    return this.#heads.boundsArea as Rectangle;
  }

  /** Idem pour le calque des trainees, qui est un conteneur a part entiere. */
  get trailBoundsArea(): Rectangle {
    return this.#trails.boundsArea as Rectangle;
  }

  /** Expose pour le test : « additif » est une exigence du §6.6, pas un detail. */
  get trailBlendMode(): string {
    return this.#trails.blendMode;
  }

  /**
   * Les canaux vraiment reteleverses au GPU a chaque image, **lus sur le
   * conteneur** et jamais sur l'objet passe au constructeur : c'est Pixi qui
   * traduit `dynamicProperties` en descripteurs, et seule cette traduction dit
   * ce qui sera reellement rafraichi.
   *
   * ⚠️ **Meme motif que `HordeRenderer.dynamicTint`, et pour la meme raison :
   * la mutation survit sans lui.** Elle a d'abord survecu ici — passer
   * `uvs: false` sur les tetes laisse 212 tests verts, parce que `draw` pose
   * bien `head.texture` sur l'objet JS et que le test le relit. Seul le
   * televersement change : le reservoir de particules etant REUTILISE, la case
   * d'atlas du premier occupant d'un creneau y resterait pour toujours et les
   * neuf armes finiraient dessinees avec la meme forme — exactement le defaut
   * que cette tache corrige.
   */
  get dynamicHeadChannels(): { uvs: boolean; rotation: boolean; vertex: boolean; color: boolean } {
    return dynamicChannelsOf(this.#heads);
  }

  /** Idem pour les trainees, qui n'ont qu'une texture donc pas d'`uvs` a suivre. */
  get dynamicTrailChannels(): { rotation: boolean; vertex: boolean; color: boolean } {
    const { rotation, vertex, color } = dynamicChannelsOf(this.#trails);
    return { rotation, vertex, color };
  }

  /**
   * Attache **un seul** enfant au monde, comme tous les autres calques.
   *
   * ⚠️ **Un groupe, pas deux enfants poses cote a cote dans le monde.** Le
   * §6.6 compte six calques et `stage.test.ts` le verifie en comptant les
   * enfants du monde ; y verser deux conteneurs ferait de « un renderer, un
   * calque » une regle a exceptions. Le groupe garantit en plus que la trainee
   * reste immediatement SOUS sa tete — l'ordre est interne, personne ne peut
   * l'inverser en reordonnant `Stage.#layers`.
   */
  attach(parent: Container): void {
    this.#group.addChild(this.#trails);
    this.#group.addChild(this.#heads);
    parent.addChild(this.#group);
  }

  /**
   * Vrai des que `load` a pose ses textures. Expose pour le test, comme
   * `boundsArea` : c'est ce qui permet a `stage.test.ts` de verifier que
   * `Stage.composeWorld` charge CHAQUE calque — retirer un `load` y etait
   * indetectable jusqu'a la tache 9 bis.
   */
  get loaded(): boolean {
    return this.#streak !== null;
  }

  /**
   * Cuit les textures procedurales. A appeler apres l'init de l'`Application`
   * — jamais dans le constructeur : `document` (canevas 2D) n'existe que dans
   * un navigateur, et ce renderer doit rester construisible (et son
   * `boundsArea` lisible) sans lui, comme l'exige le test unitaire de ce
   * fichier.
   */
  load(): void {
    this.adoptTextures(makeProjectileAtlas(), makeStreakTexture());
  }

  /**
   * Decoupe l'atlas et rend le renderer capable de dessiner.
   *
   * ⚠️ **Separe de `load` PARCE QUE `load` a besoin d'un canevas 2D**, que
   * l'environnement de test n'a pas — exactement la raison de
   * `HordeRenderer.adoptAtlas` (tache 9 bis). Tant que les deux ne faisaient
   * qu'un, `draw` retournait au premier `if (!texture)` en test et **tout son
   * corps pouvait etre retire sans qu'une assertion ne bouge.**
   */
  adoptTextures(atlas: Texture, streak: Texture): void {
    this.#cells = WEAPONS.map((w) => {
      const cell = projectileCellRect(w.id);
      return new Texture({
        source: atlas.source,
        frame: new Rectangle(cell.x, cell.y, cell.w, cell.h),
      });
    });
    this.#streak = streak;
  }

  draw(projectiles: Projectiles, view: Rectangle): void {
    const streak = this.#streak;
    const fallback = this.#cells[0];
    if (!streak || !fallback) {
      return;
    }
    this.#ensurePools(projectiles.count, fallback, streak);

    const minX = view.x - PROJECTILE_CULL_MARGIN;
    const maxX = view.x + view.width + PROJECTILE_CULL_MARGIN;
    const minY = view.y - PROJECTILE_CULL_MARGIN;
    const maxY = view.y + view.height + PROJECTILE_CULL_MARGIN;

    const heads = this.#heads.particleChildren;
    const trails = this.#trails.particleChildren;
    heads.length = 0;
    trails.length = 0;
    let used = 0;
    for (let i = 0; i < projectiles.count; i++) {
      const x = projectiles.x[i] ?? 0;
      const y = projectiles.y[i] ?? 0;
      if (x < minX || x > maxX || y < minY || y > maxY) {
        continue;
      }
      const head = this.#headPool[used];
      const trail = this.#trailPool[used];
      if (!head || !trail) {
        break;
      }

      const weapon: Weapon = weaponOf(projectiles.weaponAt(i));
      const look = weapon.look;
      // Le fondu, DERIVE de `projectileLifeTicks` : le lance-flammes (10
      // ticks) s'eteint sur les trois quarts de sa course, l'arc-lourd (40)
      // file net. Voir `projectileAlpha`.
      const alpha = projectileAlpha(weapon.projectileLifeTicks, projectiles.ticksRemainingAt(i));
      const heading = projectiles.headingAt(i);

      head.texture = this.#cells[weapon.id] ?? fallback;
      head.x = x;
      head.y = y;
      head.rotation = heading;
      head.scaleX = look.diameterPx / PROJECTILE_CELL_PX;
      head.scaleY = head.scaleX;
      head.alpha = alpha;

      // Ancree a droite (`anchorX: 1`) : le quad s'etend donc vers -x local,
      // c'est-a-dire DERRIERE le projectile une fois tourne de `heading`.
      trail.x = x;
      trail.y = y;
      trail.rotation = heading;
      trail.scaleX = projectileTrailPx(weapon) / STREAK_LENGTH_PX;
      trail.scaleY = (look.diameterPx * TRAIL_THICKNESS_FRACTION) / STREAK_THICKNESS_PX;
      trail.tint = look.tint;
      trail.alpha = alpha * TRAIL_ALPHA;

      heads.push(head);
      trails.push(trail);
      used++;
    }
    this.#heads.update();
    this.#trails.update();
  }

  /** Les trois noeuds, et pas seulement le groupe : `attach` peut n'avoir jamais eu lieu. */
  destroy(): void {
    this.#trails.destroy();
    this.#heads.destroy();
    this.#group.destroy();
  }

  #ensurePools(needed: number, head: Texture, streak: Texture): void {
    while (this.#headPool.length < needed) {
      this.#headPool.push(new Particle({ texture: head, anchorX: 0.5, anchorY: 0.5 }));
    }
    while (this.#trailPool.length < needed) {
      this.#trailPool.push(new Particle({ texture: streak, anchorX: 1, anchorY: 0.5 }));
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
