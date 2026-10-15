import { MAP_SIZE, REACTION_RADIUS, TICK_HZ } from '@shared/constants';
import { elementOf } from '@shared/elements';
import type { Projectiles } from '@shared/projectiles';
import { unpackElementPair } from '@shared/protocol';
import {
  type ProjectileLook,
  type ProjectileShape,
  type ProjectileTrail,
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

/**
 * Stades d'usure d'un projectile : intact, fissure, en miettes.
 *
 * ⚠️ **C'est ce qui remplace le FONDU** (etape 8, demande de l'auteur :
 * *« evite le fade, fais plutot se desagreger »*). Un projectile qui perd son
 * opacite devient un fantome puis rien ; un projectile qui s'effrite perd des
 * morceaux et reste un OBJET jusqu'a sa derniere image — c'est la difference
 * entre « le dessin s'eteint » et « la chose se casse ».
 *
 * ⚠️ **Trois, et pas huit.** Chaque stade est une case d'atlas de plus pour
 * CHAQUE arme : dix-sept armes x trois stades font 51 cases, soit une grille
 * de 8 x 8 et un canevas de 256 px — toujours cuit une seule fois au
 * chargement. A huit stades il aurait fallu 136 cases pour une difference
 * qu'on ne verrait pas : a dix pixels a l'ecran, « entier / fissure / en
 * miettes » est deja une lecture fine.
 *
 * ⚠️ **Le RYTHME n'est pas ici**, il reste derive de `projectileLifeTicks` par
 * `projectileAlpha` — voir `projectileWear`. Une arme a courte portee s'effrite
 * tot, l'arc-lourd ne s'effrite jamais : c'est la meme regle qu'avant, lue
 * autrement.
 */
export const PROJECTILE_WEAR_STAGES = 3;

/**
 * Cases par ligne dans l'atlas.
 *
 * ⚠️ **DERIVEE de `WEAPONS.length`, jamais un plafond fixe** (tache 8 de
 * l'etape 5c) : un `4` code en dur suffisait a treize armes et a plante au
 * chargement reel (`Stage.composeWorld`) a dix-sept — la Chaux et le
 * Vif-argent l'ont depasse. Un `8` fixe n'aurait fait que reculer la meme
 * classe de defaut a soixante-cinq armes. Meme discipline que
 * `PROJECTILE_CULL_MARGIN` juste en dessous : le catalogue est une constante
 * au chargement, le canevas ne se cuit qu'une fois, et racine carree de
 * dix-sept armes fait toujours une grille minuscule (5 x 5 = 25 cases, 160 px
 * de cote).
 */
const PROJECTILE_ATLAS_COLS = Math.ceil(Math.sqrt(WEAPONS.length * PROJECTILE_WEAR_STAGES));

/** Cote de l'atlas, en pixels : juste assez grand pour contenir la grille. */
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
 *
 * Exportee depuis l'etape 8 : c'est avec elle que le test mesure qu'aucune
 * forme ne DEBORDE de sa case (voir `SHAPE_PAINTERS`).
 */
export const PROJECTILE_SHAPE_FRACTION = 0.62;

/**
 * Le noir du cerne — la MEME valeur que celle des orbes et des pieces
 * (`orb-renderer.ts`), pas un noir pur : un projectile cerne de `#000` lirait
 * comme un trou dans le decor.
 */
const OUTLINE_RGBA = 'rgba(20, 16, 18, 1)';

/**
 * De combien la silhouette noire du dessous deborde la silhouette coloree.
 *
 * ⚠️ **C'est l'epaisseur du cerne, et elle est MULTIPLICATIVE** : un cerne en
 * pixels absolus aurait avale la Fronde a mercure (7 px) tout en disparaissant
 * sur le Canon a chaux (29 px). En fraction, les dix-sept portent le meme
 * cerne a l'oeil.
 */
export const SHAPE_OUTLINE_DILATION = 1.2;

/**
 * Jusqu'ou porte le halo, en fraction du rayon de la case.
 *
 * ⚠️ **Court, et c'est ce qui le garde dans sa case** : le halo est dessine
 * AVANT la silhouette et deborderait dans la case voisine comme n'importe quel
 * trace. A 0,86, il reste sous le bord meme a `glow` plein.
 */
const HALO_REACH = 0.86;

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
/**
 * La case de l'arme `weaponId` a son stade d'usure `wear` — l'ORDRE est « une
 * arme, ses trois stades a la suite », pour qu'une arme ajoutee au catalogue
 * ne deplace jamais les stades des precedentes.
 */
export function projectileCellIndex(weaponId: number, wear: number): number {
  return weaponId * PROJECTILE_WEAR_STAGES + wear;
}

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
 *
 * ⚠️ **Ce que le compilateur ne voit PAS, c'est l'encre qui sort de la case**
 * (etape 8, ou le catalogue est passe de neuf a dix-sept dessins). Les cases
 * sont JOINTIVES dans l'atlas : un trace qui depasse son rayon ne bave pas
 * dans le vide, il bave dans la case de l'arme voisine, et deux armes
 * finissent dessinees avec un bout l'une de l'autre. C'est pourquoi la table
 * est exportee — `projectile-renderer.test.ts` rejoue chaque peintre sur un
 * contexte mouchard et mesure son empreinte reelle, bord de trait compris.
 */
export const SHAPE_PAINTERS: Record<
  ProjectileShape,
  (ctx: CanvasRenderingContext2D, r: number) => void
> = {
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
  /**
   * Zigzag : un arc electrique, le seul dessin TRACE du catalogue.
   *
   * ⚠️ **Il prend `fillStyle` pour en faire son `strokeStyle`**, et c'est la
   * seule facon de garder l'API d'un peintre (le caller choisit la couleur,
   * ici comme pour les huit autres) tout en dessinant une ligne brisee : un
   * zigzag rempli demanderait deux cotes decales a la main, donc douze
   * sommets pour ce que trois segments disent.
   */
  arc: (ctx, r) => {
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = r * 0.34;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(0.3 * r, 0.42 * r);
    ctx.lineTo(-0.15 * r, -0.3 * r);
    ctx.lineTo(-r, 0.22 * r);
    ctx.stroke();
  },
  /** Hampe a garde : une pointe, un fut mince, deux ailettes au tiers arriere. */
  javelot: (ctx, r) => {
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(0.35 * r, -0.26 * r);
    ctx.lineTo(-0.25 * r, -0.1 * r);
    ctx.lineTo(-0.25 * r, -0.4 * r);
    ctx.lineTo(-0.45 * r, -0.4 * r);
    ctx.lineTo(-0.45 * r, -0.1 * r);
    ctx.lineTo(-r, -0.07 * r);
    ctx.lineTo(-r, 0.07 * r);
    ctx.lineTo(-0.45 * r, 0.1 * r);
    ctx.lineTo(-0.45 * r, 0.4 * r);
    ctx.lineTo(-0.25 * r, 0.4 * r);
    ctx.lineTo(-0.25 * r, 0.1 * r);
    ctx.lineTo(0.35 * r, 0.26 * r);
    ctx.closePath();
    ctx.fill();
  },
  /** Tetard : tete ronde a l'AVANT, queue effilee derriere. L'inverse de `petale`. */
  goutte: (ctx, r) => {
    ctx.beginPath();
    ctx.arc(0.3 * r, 0, 0.6 * r, -Math.PI / 2, Math.PI / 2);
    ctx.quadraticCurveTo(-0.4 * r, 0.3 * r, -r, 0);
    ctx.quadraticCurveTo(-0.4 * r, -0.3 * r, 0.3 * r, -0.6 * r);
    ctx.closePath();
    ctx.fill();
  },
  /**
   * Motte informe : huit rayons inegaux, ECRITS et jamais tires au hasard.
   * Une forme aleatoire changerait a chaque cuisson d'atlas, donc d'une
   * partie a l'autre — et la case est cuite une fois pour toutes.
   */
  masse: (ctx, r) => {
    // ⚠️ **Onze rayons, et pas huit.** A huit sommets regulierement espaces,
    // des rayons tous entre 0,7 et 1 rendaient un LOSANGE net (constate sur la
    // planche) : l'oeil recompose l'octogone avant de voir l'irregularite.
    // Onze sommets, et un creux franc entre chaque bosse, font enfin une motte.
    const rayons = [1, 0.72, 0.95, 0.62, 0.88, 0.66, 0.9, 0.6, 0.98, 0.7, 0.82];
    ctx.beginPath();
    for (let i = 0; i < rayons.length; i++) {
      const a = (i / rayons.length) * Math.PI * 2;
      const f = rayons[i] ?? 1;
      const x = Math.cos(a) * r * f;
      const y = Math.sin(a) * r * f;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    ctx.fill();
  },
  /** Trois lobes qui se recouvrent : de la poudre en vol, pas un corps solide. */
  bouffee: (ctx, r) => {
    // ⚠️ **Un `moveTo` AVANT chaque disque**, sinon le canevas relie la fin
    // d'un arc au debut du suivant par un segment, et ce segment taille deux
    // coins sombres dans la bouffee — exactement ce que la planche montrait.
    const lobes: readonly [number, number, number][] = [
      [0.34 * r, 0, 0.6 * r],
      [-0.3 * r, -0.34 * r, 0.5 * r],
      [-0.3 * r, 0.34 * r, 0.5 * r],
    ];
    ctx.beginPath();
    for (const [cx, cy, lobe] of lobes) {
      ctx.moveTo(cx + lobe, cy);
      ctx.arc(cx, cy, lobe, 0, Math.PI * 2);
    }
    ctx.fill();
  },
  /** Capsule : nez arrondi, flancs droits, culot plat. */
  obus: (ctx, r) => {
    ctx.beginPath();
    ctx.moveTo(-0.9 * r, -0.5 * r);
    ctx.lineTo(0.2 * r, -0.5 * r);
    ctx.quadraticCurveTo(r, -0.36 * r, r, 0);
    ctx.quadraticCurveTo(r, 0.36 * r, 0.2 * r, 0.5 * r);
    ctx.lineTo(-0.9 * r, 0.5 * r);
    ctx.closePath();
    ctx.fill();
  },
  /** Aiguille a ardillons : plus fine qu'`aiguille`, mais barbelee a l'arriere. */
  dard: (ctx, r) => {
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(-0.3 * r, -0.14 * r);
    ctx.lineTo(-0.55 * r, -0.45 * r);
    ctx.lineTo(-0.72 * r, -0.12 * r);
    ctx.lineTo(-r, -0.09 * r);
    ctx.lineTo(-r, 0.09 * r);
    ctx.lineTo(-0.72 * r, 0.12 * r);
    ctx.lineTo(-0.55 * r, 0.45 * r);
    ctx.lineTo(-0.3 * r, 0.14 * r);
    ctx.closePath();
    ctx.fill();
  },
  /** Lame a garde : un fer en feuille, une croisiere, un pommeau. */
  glaive: (ctx, r) => {
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.quadraticCurveTo(0.1 * r, -0.34 * r, -0.4 * r, -0.22 * r);
    ctx.lineTo(-0.4 * r, -0.52 * r);
    ctx.lineTo(-0.56 * r, -0.52 * r);
    ctx.lineTo(-0.56 * r, -0.2 * r);
    ctx.lineTo(-r, -0.1 * r);
    ctx.lineTo(-r, 0.1 * r);
    ctx.lineTo(-0.56 * r, 0.2 * r);
    ctx.lineTo(-0.56 * r, 0.52 * r);
    ctx.lineTo(-0.4 * r, 0.52 * r);
    ctx.lineTo(-0.4 * r, 0.22 * r);
    ctx.quadraticCurveTo(0.1 * r, 0.34 * r, r, 0);
    ctx.closePath();
    ctx.fill();
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
  wear = 0,
): void {
  const r = PROJECTILE_CELL_PX / 2;
  const body = r * PROJECTILE_SHAPE_FRACTION;

  ctx.save();
  ctx.translate(cx, cy);

  if (look.glow > 0) {
    // ⚠️ **Un halo COURT et a marches, pas un degrade continu jusqu'au bord de
    // la case** (etape 8). Le degre d'origine partait a 0,35 du corps et
    // mourait au bord : sur l'herbe claire, dix-sept armes rendaient dix-sept
    // nuages mous, et la silhouette cernee qu'on venait de dessiner se noyait
    // dedans. Deux paliers francs et une portee courte donnent une lueur qui
    // RESSEMBLE au reste du jeu — la meme logique que le cerne.
    const halo = ctx.createRadialGradient(0, 0, body * 0.9, 0, 0, r * HALO_REACH);
    halo.addColorStop(0, cssTintAlpha(look.tint, look.glow));
    halo.addColorStop(0.55, cssTintAlpha(look.tint, look.glow * 0.5));
    halo.addColorStop(0.56, cssTintAlpha(look.tint, look.glow * 0.22));
    halo.addColorStop(1, cssTintAlpha(look.tint, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, r * HALO_REACH, 0, Math.PI * 2);
    ctx.fill();
  }

  // ⚠️ **Le corps sur son propre calque, et c'est l'usure qui l'exige.**
  // `erodeCell` travaille en `destination-out` : peint directement ici, il
  // aurait mordu le HALO avec le corps — constate sur la planche, ou les
  // morsures decoupaient des encoches franches dans la lueur et lisaient
  // comme un defaut d'affichage, pas comme une casse. Ce qui se brise, c'est
  // l'objet ; sa lumiere, elle, ne s'ecaille pas.
  const layer = document.createElement('canvas');
  layer.width = PROJECTILE_CELL_PX;
  layer.height = PROJECTILE_CELL_PX;
  const bodyCtx = layer.getContext('2d');
  if (!bodyCtx) {
    throw new Error('canvas 2d indisponible');
  }
  bodyCtx.translate(r, r);
  paintProjectileBody(bodyCtx, look, body);
  erodeCell(bodyCtx, wear);
  ctx.drawImage(layer, -r, -r);

  ctx.restore();
}

/** Le corps seul — cerne, teinte, coeur — centre sur l'origine du contexte. */
function paintProjectileBody(
  ctx: CanvasRenderingContext2D,
  look: ProjectileLook,
  body: number,
): void {
  const paint = SHAPE_PAINTERS[look.shape];
  // Le cerne noir, exactement comme les orbes et les pieces (etape 8 : *« des
  // projectiles dans le theme du jeu »*) — c'est lui qui pose un projectile
  // SUR le decor au lieu de le laisser flotter dedans, et c'est la meme
  // signature graphique que le reste du jeu.
  //
  // ⚠️ **La meme forme DILATEE, et pas un `stroke`.** Les peintres remplissent
  // eux-memes (`arc` TRACE meme sa ligne brisee) : leur demander un contour
  // aurait voulu dire leur retirer leur `fill`, donc un mode a declarer forme
  // par forme. Redessiner la silhouette un cran plus grosse en noir juste
  // en-dessous donne le meme cerne pour les dix-sept, tracees comprises.
  ctx.fillStyle = OUTLINE_RGBA;
  ctx.strokeStyle = OUTLINE_RGBA;
  paint(ctx, body * SHAPE_OUTLINE_DILATION);
  ctx.fillStyle = cssTint(look.tint);
  paint(ctx, body);
  // Coeur blanc, la meme forme reduite : c'est lui qui donne au projectile son
  // point chaud et le rend suivable a dix pixels de cote.
  //
  // ⚠️ **0,32 et plus 0,42 (etape 8)** : sur les formes rondes — grenade,
  // chakram, bouffee — un coeur a 0,42 faisait une pupille, et les trois
  // lisaient comme des cibles plutot que comme des projectiles.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  paint(ctx, body * 0.32);
}

/**
 * Ronge la case : `wear` morsures rondes prises dans le dessin, en
 * `destination-out`.
 *
 * ⚠️ **Les morsures sont ECRITES, jamais tirees au hasard** — meme raison que
 * les rayons de `masse` et les points de `etincelles` : la case est cuite une
 * fois pour toutes, un tirage la ferait changer d'une partie a l'autre pour
 * rien. Elles mordent depuis l'ARRIERE et les flancs (x negatifs surtout) :
 * c'est la pointe qui perce, donc c'est elle qui doit survivre le plus
 * longtemps.
 *
 * ⚠️ **Sur le calque du CORPS, jamais sur la case entiere ni sur l'atlas.**
 * `destination-out` ne connait ni les cases ni les couches : applique a la
 * case, il mordait le halo avec le corps (encoches franches dans la lueur, vu
 * sur la planche) ; applique a l'atlas, il mordrait les cases voisines. Meme
 * precaution que `softenAcross` pour les trainees. Le calque est centre sur
 * l'origine, comme les peintres de forme.
 */
function erodeCell(ctx: CanvasRenderingContext2D, stage: number): void {
  const bites: readonly (readonly [number, number, number])[] = [
    [-0.34, -0.3, 0.26],
    [-0.12, 0.34, 0.2],
    [-0.46, 0.08, 0.22],
    [0.1, -0.36, 0.22],
    [0.3, 0.22, 0.2],
    [-0.02, 0.02, 0.18],
  ];
  const r = PROJECTILE_CELL_PX / 2;
  const count = stage * 3;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000000';
  for (let i = 0; i < count && i < bites.length; i++) {
    const bite = bites[i];
    if (!bite) {
      break;
    }
    const [bx, by, br] = bite;
    ctx.beginPath();
    ctx.arc(bx * PROJECTILE_CELL_PX, by * PROJECTILE_CELL_PX, br * r, 0, Math.PI * 2);
    ctx.fill();
  }
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
    for (let wear = 0; wear < PROJECTILE_WEAR_STAGES; wear++) {
      const cell = projectileCellRect(projectileCellIndex(weapon.id, wear));
      paintProjectileCell(ctx, weapon.look, cell.x + cell.w / 2, cell.y + cell.h / 2, wear);
    }
  }
  return Texture.from(canvas);
}

/** Longueur de la texture de trainee, en pixels. Ramenee par `draw` a `projectileTrailPx`. */
export const STREAK_LENGTH_PX = 64;
/** Epaisseur de la texture de trainee, en pixels. Ramenee par `draw` au calibre de l'arme. */
export const STREAK_THICKNESS_PX = 16;

/**
 * Le dessin d'un profil de trainee, dans une case de `STREAK_LENGTH_PX` par
 * `STREAK_THICKNESS_PX` : la TETE est a droite (x = longueur), la queue a
 * gauche. Toujours en BLANC, pour la meme raison que `makeZoneAtlas` :
 * `Particle.tint` multiplie, donc une texture blanche rend exactement
 * `look.tint`.
 *
 * ⚠️ **La table est un `Record<ProjectileTrail, …>`, et c'est la garde** —
 * meme discipline que `SHAPE_PAINTERS` : le compilateur refuse un profil du
 * catalogue sans dessin.
 */
const STREAK_PAINTERS: Record<ProjectileTrail, (ctx: CanvasRenderingContext2D) => void> = {
  /** Un trait qui s'effile : le profil d'origine, celui de ce qui file droit. */
  lisse: (ctx) => {
    const along = ctx.createLinearGradient(0, 0, STREAK_LENGTH_PX, 0);
    along.addColorStop(0, 'rgba(255, 255, 255, 0)');
    along.addColorStop(1, 'rgba(255, 255, 255, 1)');
    ctx.fillStyle = along;
    ctx.fillRect(0, 0, STREAK_LENGTH_PX, STREAK_THICKNESS_PX);
    softenAcross(ctx);
  },
  /**
   * Des bouffees qui GROSSISSENT vers la queue en s'eteignant : ce qui brule
   * ou englue laisse derriere lui quelque chose qui s'etale, pas un trait.
   *
   * Pas de `softenAcross` : des disques degrades sont deja ronds, et le masque
   * transversal les couperait en lentilles.
   */
  fumee: (ctx) => {
    const half = STREAK_THICKNESS_PX / 2;
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const x = STREAK_LENGTH_PX * t;
      // Gros et pale a la queue (t = 0), serre et franc a la tete (t = 1).
      const r = half * (1 - 0.55 * t);
      const a = 0.15 + 0.85 * t;
      const puff = ctx.createRadialGradient(x, half, 0, x, half, r);
      puff.addColorStop(0, `rgba(255, 255, 255, ${a})`);
      puff.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = puff;
      ctx.beginPath();
      ctx.arc(x, half, r, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  /** Une file de segments detaches : ce qui est jete par poignees. */
  tirets: (ctx) => {
    const dash = STREAK_LENGTH_PX / 9;
    const along = ctx.createLinearGradient(0, 0, STREAK_LENGTH_PX, 0);
    along.addColorStop(0, 'rgba(255, 255, 255, 0)');
    along.addColorStop(1, 'rgba(255, 255, 255, 1)');
    ctx.fillStyle = along;
    for (let i = 0; i < 5; i++) {
      ctx.fillRect(i * 2 * dash, 0, dash, STREAK_THICKNESS_PX);
    }
    softenAcross(ctx);
  },
  /**
   * Un trait pale crible de points chauds : ce qui crepite.
   *
   * ⚠️ **Les points sont ECRITS, jamais tires au hasard** — meme raison que
   * les rayons de la forme `masse` : la case est cuite une fois pour toutes,
   * un tirage la ferait changer d'une partie a l'autre pour rien.
   */
  etincelles: (ctx) => {
    const along = ctx.createLinearGradient(0, 0, STREAK_LENGTH_PX, 0);
    along.addColorStop(0, 'rgba(255, 255, 255, 0)');
    along.addColorStop(1, 'rgba(255, 255, 255, 0.55)');
    ctx.fillStyle = along;
    ctx.fillRect(0, 0, STREAK_LENGTH_PX, STREAK_THICKNESS_PX);
    softenAcross(ctx);

    const half = STREAK_THICKNESS_PX / 2;
    const dots: readonly [number, number][] = [
      [0.22, -0.55],
      [0.38, 0.6],
      [0.52, -0.25],
      [0.66, 0.4],
      [0.78, -0.6],
      [0.88, 0.2],
      [0.96, -0.15],
    ];
    for (const [t, offset] of dots) {
      ctx.fillStyle = `rgba(255, 255, 255, ${0.35 + 0.65 * t})`;
      ctx.beginPath();
      ctx.arc(STREAK_LENGTH_PX * t, half + half * offset, half * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  },
};

/**
 * Adoucissement transversal : sans lui une trainee pleine est un ruban a
 * bords nets, qui lit comme une barre et non comme une trace.
 *
 * Travaille en `destination-in` sur TOUTE la case — c'est pourquoi chaque
 * profil est peint sur son propre canevas avant d'etre recopie dans l'atlas
 * (voir `makeStreakAtlas`) : applique a l'atlas entier, il effacerait les
 * bandes voisines.
 */
function softenAcross(ctx: CanvasRenderingContext2D): void {
  const across = ctx.createLinearGradient(0, 0, 0, STREAK_THICKNESS_PX);
  across.addColorStop(0, 'rgba(255, 255, 255, 0)');
  across.addColorStop(0.5, 'rgba(255, 255, 255, 1)');
  across.addColorStop(1, 'rgba(255, 255, 255, 0)');
  const before = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, STREAK_LENGTH_PX, STREAK_THICKNESS_PX);
  ctx.globalCompositeOperation = before;
}

/**
 * L'ordre des bandes de l'atlas des trainees : celui des cles de
 * `STREAK_PAINTERS`, donc rien a synchroniser a la main. Ajouter un profil
 * ajoute une bande.
 */
export const TRAIL_PROFILES = Object.keys(STREAK_PAINTERS) as ProjectileTrail[];

/** Rectangle de la bande d'un profil dans l'atlas des trainees. */
export function streakCellRect(profile: ProjectileTrail): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const row = TRAIL_PROFILES.indexOf(profile);
  if (row < 0) {
    throw new Error(`profil de trainee inconnu : ${profile}`);
  }
  return { x: 0, y: row * STREAK_THICKNESS_PX, w: STREAK_LENGTH_PX, h: STREAK_THICKNESS_PX };
}

/**
 * Cuit l'atlas des trainees : une bande par profil (etape 8).
 *
 * ⚠️ **UN atlas, pas quatre textures.** Un `ParticleContainer` ne lie que la
 * source de son PREMIER enfant et dessine tout le lot avec (voir
 * `GlParticleContainerAdaptor`) : quatre textures distinctes auraient voulu
 * dire quatre conteneurs, donc quatre lots pour ce qui tient en un. Meme
 * raisonnement, et meme forme, que `makeProjectileAtlas` au-dessus.
 */
function makeStreakAtlas(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = STREAK_LENGTH_PX;
  canvas.height = STREAK_THICKNESS_PX * TRAIL_PROFILES.length;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  for (const profile of TRAIL_PROFILES) {
    // Chaque profil sur SON canevas, puis recopie : `softenAcross` travaille
    // en `destination-in`, qui ne connait pas les bandes.
    const band = document.createElement('canvas');
    band.width = STREAK_LENGTH_PX;
    band.height = STREAK_THICKNESS_PX;
    const bandCtx = band.getContext('2d');
    if (!bandCtx) {
      throw new Error('canvas 2d indisponible');
    }
    STREAK_PAINTERS[profile](bandCtx);
    ctx.drawImage(band, 0, streakCellRect(profile).y);
  }
  return Texture.from(canvas);
}

/**
 * Epaisseur de la trainee, en fraction du calibre du projectile. Plus fine que
 * le corps : une trainee aussi large que la tete masquerait la tete.
 *
 * ⚠️ **0,85 depuis l'etape 8, contre 0,6.** La trainee porte desormais une
 * MATIERE (`STREAK_PAINTERS` : des bouffees, des tirets, des etincelles), et a
 * 0,6 d'un calibre de dix pixels elle faisait six pixels d'epaisseur — ou
 * aucune de ces matieres ne se distingue d'un trait uni. Elle reste strictement
 * plus fine que la tete, ce que le test garde arme par arme.
 */
const TRAIL_THICKNESS_FRACTION = 0.85;

/**
 * Duree du « pop » de naissance, en ticks de vol, et sur-echelle a t = 0.
 *
 * ⚠️ **Le pop se compte en TICKS, comme le fondu et la trainee** (etape 8) :
 * `ProjectileRenderer.draw` ne recoit aucune horloge, et il n'en a pas besoin
 * — `Projectiles.ticksRemainingAt` est deja un compte a rebours par
 * projectile. Un pop en millisecondes aurait demande une horloge murale au
 * calque, donc un second temps a cote de celui de la simulation.
 *
 * Trois ticks (100 ms) a x1,6 : assez pour que le depart du tir CLAQUE, trop
 * court pour qu'on lise un projectile plus gros qu'il n'est. Le reste de sa
 * course, il fait exactement son `diameterPx` — c'est ce qui garde la
 * comparaison entre deux armes honnete (voir `PROJECTILE_SHAPE_FRACTION`).
 *
 * ⚠️ **x1,4 sur 2 ticks d'abord, releve apres coup.** 66 ms sur un projectile
 * de dix pixels ne se voyait pas — le pop existait dans le test et nulle part
 * sur l'ecran. C'est le meme constat qui a fait monter les calibres du
 * catalogue d'un cran : a cette taille, une courbe timide est une courbe
 * absente.
 */
export const POP_TICKS = 3;
export const POP_SCALE = 1.6;

/**
 * Sur-echelle de la tete a `ageTicks` ticks de vol : `POP_SCALE` au depart,
 * `1` des `POP_TICKS` ecoules, lineaire entre les deux.
 *
 * Exportee pour que le test confronte le depart au regime etabli : « la tete
 * fait son calibre » et « la tete claque au depart » ne sont la meme chose
 * qu'a `POP_SCALE = 1`.
 */
export function projectilePop(ageTicks: number): number {
  if (ageTicks >= POP_TICKS || ageTicks < 0) {
    return 1;
  }
  return POP_SCALE + (1 - POP_SCALE) * (ageTicks / POP_TICKS);
}

/**
 * Le stade d'usure d'un projectile, de `0` (intact) a
 * `PROJECTILE_WEAR_STAGES - 1` (en miettes).
 *
 * ⚠️ **DERIVE de `projectileAlpha`, et c'est tout l'interet.** L'ancien fondu
 * portait deja la regle *« plus la portee est courte, plus tot il commence a
 * disparaitre »*, calee arme par arme sur `projectileLifeTicks` — le
 * lance-flammes sur les trois quarts de sa course, l'arc-lourd jamais. En
 * lisant cette meme courbe comme une EROSION au lieu d'une opacite, le rythme
 * ne bouge pas d'un tick et il n'y a toujours qu'une seule regle a maintenir :
 * une seconde courbe a cote aurait fini par la contredire, comme ce depot l'a
 * deja vu trois fois.
 *
 * L'arc-lourd reste donc intact de bout en bout (`projectileAlpha` vaut 1 sur
 * toute sa vie), et c'est voulu : *« il file net »*.
 */
export function projectileWear(lifeTicks: number, ticksRemaining: number): number {
  const reste = projectileAlpha(lifeTicks, ticksRemaining);
  const stade = Math.floor((1 - reste) * PROJECTILE_WEAR_STAGES);
  return Math.min(PROJECTILE_WEAR_STAGES - 1, Math.max(0, stade));
}

/**
 * Rotation propre de la tete a `ageTicks` ticks de vol, en radians, pour une
 * arme qui tourne de `spinTurns` tours par seconde.
 *
 * ⚠️ **S'AJOUTE au cap, elle ne le remplace pas.** Un chakram tourne sur
 * lui-meme TOUT EN allant vers sa cible ; poser la rotation seule ferait d'une
 * arme qui tourne une arme qui ne vise plus. La trainee, elle, ne tourne
 * jamais : elle dessine le chemin parcouru, qui n'a aucune raison de pivoter.
 */
export function projectileSpin(spinTurns: number, ageTicks: number): number {
  return (spinTurns * 2 * Math.PI * ageTicks) / TICK_HZ;
}

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
 * une file de segments : a `PROJECTILE_CAPACITY` (2048) projectiles, ce
 * renderer pose au pire **4 096 quads**. Une trainee a six segments en aurait
 * pose 12 288, et rien dans le code ne l'aurait rappele — le §4.3 de
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
    // de fin de vie.
    //
    // ⚠️ **`uvs` est passe a `true` a l'etape 8**, quand la trainee a cesse
    // d'etre une texture unique pour devenir une bande d'atlas par profil
    // (`STREAK_PAINTERS`) : c'est exactement la raison deja ecrite sur les
    // tetes juste en dessous — le reservoir est REUTILISE, et le creneau qui
    // porte un lance-flammes (profil `fumee`) a cette image peut porter une
    // dague (profil `lisse`) a la suivante. A `false`, la bande televersee une
    // fois ne changerait plus jamais et toutes les armes finiraient avec la
    // premiere rencontree.
    dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: true },
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
  /**
   * La bande de trainee de chaque arme, indexee par `Weapon.id` elle aussi.
   *
   * ⚠️ **Resolue UNE FOIS a l'adoption, pas a chaque image.** Le profil d'une
   * arme (`look.trail`) est une constante du catalogue : le chercher dans
   * `draw` mettrait une recherche de chaine dans la boucle des 2 048
   * projectiles pour un resultat qui ne change jamais.
   */
  #streaks: Texture[] = [];

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
    return this.#streaks.length > 0;
  }

  /**
   * Cuit les textures procedurales. A appeler apres l'init de l'`Application`
   * — jamais dans le constructeur : `document` (canevas 2D) n'existe que dans
   * un navigateur, et ce renderer doit rester construisible (et son
   * `boundsArea` lisible) sans lui, comme l'exige le test unitaire de ce
   * fichier.
   */
  load(): void {
    this.adoptTextures(makeProjectileAtlas(), makeStreakAtlas());
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
    // Une case par arme ET PAR STADE d'usure (etape 8) : `#cells` est indexe
    // par `projectileCellIndex`, jamais par `Weapon.id` seul.
    this.#cells = WEAPONS.flatMap((w) =>
      Array.from({ length: PROJECTILE_WEAR_STAGES }, (_, wear) => {
        const cell = projectileCellRect(projectileCellIndex(w.id, wear));
        return new Texture({
          source: atlas.source,
          frame: new Rectangle(cell.x, cell.y, cell.w, cell.h),
        });
      }),
    );
    // Une bande par PROFIL, decoupee une seule fois, puis indexee par arme :
    // deux armes du meme profil partagent la meme `Texture` (voir `#streaks`).
    const bands = new Map<ProjectileTrail, Texture>();
    for (const profile of TRAIL_PROFILES) {
      const cell = streakCellRect(profile);
      bands.set(
        profile,
        new Texture({
          source: streak.source,
          frame: new Rectangle(cell.x, cell.y, cell.w, cell.h),
        }),
      );
    }
    this.#streaks = WEAPONS.map((w) => {
      const band = bands.get(w.look.trail);
      if (!band) {
        throw new Error(`arme « ${w.name} » : profil de trainee inconnu (${w.look.trail})`);
      }
      return band;
    });
  }

  draw(projectiles: Projectiles, view: Rectangle): void {
    const streak = this.#streaks[0];
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
      const remaining = projectiles.ticksRemainingAt(i);
      const alpha = projectileAlpha(weapon.projectileLifeTicks, remaining);
      const heading = projectiles.headingAt(i);
      // Le stade d'usure, lu sur la MEME courbe que l'ancien fondu — voir
      // `projectileWear`.
      const wear = projectileWear(weapon.projectileLifeTicks, remaining);
      // L'age du projectile, en ticks de vol : la vie de l'arme moins ce qui
      // en reste. C'est le seul temps dont ce calque dispose, et il suffit aux
      // trois courbes (fondu, pop, rotation) — voir `POP_TICKS`.
      const age = weapon.projectileLifeTicks - remaining;

      head.texture = this.#cells[projectileCellIndex(weapon.id, wear)] ?? fallback;
      head.x = x;
      head.y = y;
      head.rotation = heading + projectileSpin(look.spinTurns, age);
      // Le calibre (carte d'arme) grossit le projectile : `scaleAt` vaut 1
      // sans lui. Le rayon de touche suit, cote simulation.
      const size = look.diameterPx * projectiles.scaleAt(i);
      head.scaleX = (size * projectilePop(age)) / PROJECTILE_CELL_PX;
      head.scaleY = head.scaleX;
      // ⚠️ **PLEINE opacite jusqu'a la derniere image.** Ce qui dit la fin de
      // course, c'est la case rongee (`wear`), pas un fondu : un projectile qui
      // s'eteint devient un fantome, un projectile qui s'effrite reste un
      // objet. La trainee, elle, garde son fondu juste en dessous — c'est une
      // TRACE, et une trace s'efface.
      head.alpha = 1;

      // Ancree a droite (`anchorX: 1`) : le quad s'etend donc vers -x local,
      // c'est-a-dire DERRIERE le projectile une fois tourne de `heading`.
      trail.texture = this.#streaks[weapon.id] ?? streak;
      trail.x = x;
      trail.y = y;
      trail.rotation = heading;
      trail.scaleX = (projectileTrailPx(weapon) * alpha) / STREAK_LENGTH_PX;
      trail.scaleY = (size * TRAIL_THICKNESS_FRACTION) / STREAK_THICKNESS_PX;
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
 * Le flash d'impact : un coeur blanc, un BORD CHAUD, puis rien (etape 8).
 *
 * ⚠️ **Blanc, et plus dore comme jusqu'a l'etape 6a.** `Particle.tint`
 * multiplie composante par composante : une texture deja doree aurait rendu
 * fausse la teinte de l'arme que `HitFlashes.tint` porte desormais — c'est la
 * meme raison qui fait la trainee blanche (`STREAK_PAINTERS`) et l'atlas des
 * zones blanc.
 *
 * ⚠️ **Le bord est ce qui fait lire « eclat » et pas « halo ».** Un simple
 * degre du centre vers le vide (`makeGlowTexture`) grossit en s'eteignant
 * comme une tache floue ; une crete d'opacite aux trois quarts du rayon donne
 * au meme quad une onde qui part — le §4.3 demande *« un flash court, large et
 * genereux »*, et c'est le bord qui en dit la largeur. Un second quad
 * (anneau separe) aurait dit la meme chose en doublant le cout d'un effet qui
 * accompagne CHAQUE coup, des dizaines par seconde.
 */
function makeBurstTexture(diameter: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = diameter;
  canvas.height = diameter;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  const r = diameter / 2;
  const burst = ctx.createRadialGradient(r, r, 0, r, r, r);
  burst.addColorStop(0, 'rgba(255, 255, 255, 1)');
  burst.addColorStop(0.42, 'rgba(255, 255, 255, 0.42)');
  // La crete : le bord chaud de l'onde.
  burst.addColorStop(0.68, 'rgba(255, 255, 255, 0.78)');
  burst.addColorStop(0.82, 'rgba(255, 255, 255, 0.22)');
  burst.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = burst;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  return Texture.from(canvas);
}

/**
 * Degats au-dela desquels un impact ne grossit plus : il a deja toute sa
 * gerbe et tout son flash.
 *
 * ⚠️ **PLAFOND, pas echelle.** La Grenade (40 degats) frappe huit fois plus
 * fort que le Lance-flammes (3) ; un flash huit fois plus large aurait blanchi
 * l'ecran et pietine la hierarchie du §6.6, ou le spectaculaire appartient a
 * la REACTION. 20 degats suffisent a separer les trois familles du catalogue
 * (les arroseuses a 3-7, le milieu a 10-16, les lourdes au-dela).
 */
export const IMPACT_POWER_FULL = 20;

/**
 * De 0 (un coup d'epingle) a 1 (un coup qui pese) — la place d'un coup de
 * `power` degats dans l'echelle du catalogue.
 */
export function impactPower(power: number): number {
  if (power <= 0) {
    return 0;
  }
  return Math.min(1, power / IMPACT_POWER_FULL);
}

/**
 * Nombre d'eclats projetes par impact.
 *
 * ⚠️ **C'est LA borne de cet effet, et elle est multiplicative.**
 * `HIT_FLASH_CAPACITY` vaut 128 : a six eclats, ce calque pose au pire
 * **768 quads** — contre 4 096 pour les projectiles eux-memes. Le §4.3 dit que
 * *« le danger est le VFX, pas les sprites »*, et la tache 4 a deja montre ce
 * que « quelques dizaines » devient quand personne ne compte : le compte est
 * donc mesure par `projectile-renderer.test.ts`, pas espere.
 *
 * Six, et pas douze : un impact accompagne CHAQUE projectile qui touche, des
 * dizaines par seconde. Ce qui doit rester spectaculaire, c'est la reaction
 * (§6.6).
 */
export const SPARKS_PER_FLASH = 6;

/** Le plancher : meme le plus petit coup projette deux eclats, sinon il ne dit rien. */
export const SPARKS_MIN = 2;

/**
 * Combien d'eclats un coup de `power` degats projette, de `SPARKS_MIN` a
 * `SPARKS_PER_FLASH`.
 *
 * ⚠️ **C'est l'un des deux canaux qui font qu'un coup de dague et un coup de
 * grenade ne se ressemblent pas** (etape 8 : *« varie les tailles et impact
 * des projectiles, on dirait qu'ils font tous pareil »*). L'autre est la taille
 * du flash. La BORNE, elle, ne bouge pas : le reservoir reste dimensionne a
 * `SPARKS_PER_FLASH`, donc le pire cas mesure par le test est inchange.
 */
export function sparkCount(power: number): number {
  return SPARKS_MIN + Math.round((SPARKS_PER_FLASH - SPARKS_MIN) * impactPower(power));
}

/** Cote de la texture d'un eclat, en pixels. */
export const SPARK_TEXTURE_PX = 16;

/**
 * Distance qu'un eclat parcourt depuis le point d'impact, en pixels monde,
 * pour un coup SANS souffle. Un coup a souffle projette ses eclats jusqu'au
 * bord de ce qu'il tue — voir `sparkTravel`.
 */
export const SPARK_TRAVEL_PX = 26;

/**
 * Jusqu'ou volent les eclats d'un impact de rayon `radiusPx`.
 *
 * ⚠️ **Asservi au souffle REEL quand il y en a un**, comme la taille du flash
 * lui-meme : les eclats d'une grenade dessinent le bord de ce qui vient de
 * mourir. Un coup sans souffle garde la gerbe courte de `SPARK_TRAVEL_PX` —
 * c'est elle qui dit « ca a touche », pas « ca a explose ».
 */
export function sparkTravel(radiusPx: number): number {
  return radiusPx > 0 ? radiusPx : SPARK_TRAVEL_PX;
}

/**
 * La direction du k-ieme eclat d'un flash ne a `bornMs`, en radians.
 *
 * ⚠️ **Deterministe, et SANS etat.** Pas de `Math.random` : un eclat tire au
 * hasard a chaque image sauterait d'une position a l'autre d'une image sur
 * l'autre, puisque ce calque ne garde AUCUN etat entre deux `draw` — il
 * rederive tout de `HitFlashes`, qui ne porte que x, y, teinte, rayon et
 * naissance. L'angle d'or ecarte les six eclats au maximum, et la naissance du
 * flash fait tourner la gerbe pour que deux impacts voisins ne se ressemblent
 * pas.
 */
export function sparkAngle(bornMs: number, k: number): number {
  const GOLDEN = 2.399963229728653;
  return k * GOLDEN + (bornMs % 1000) * 0.0063;
}

/**
 * Un eclat : un losange blanc cerne de noir, oriente vers +x comme les
 * projectiles — c'est `draw` qui le tourne dans le sens de son vol.
 *
 * Blanc pour la meme raison que la trainee : `Particle.tint` multiplie, donc
 * il prend exactement la teinte de l'arme qui a touche.
 */
function makeSparkTexture(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = SPARK_TEXTURE_PX;
  canvas.height = SPARK_TEXTURE_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  const r = SPARK_TEXTURE_PX / 2;
  ctx.translate(r, r);
  // Le meme cerne que les projectiles, les orbes et les pieces : un eclat sans
  // contour se dissout dans l'herbe claire.
  ctx.fillStyle = OUTLINE_RGBA;
  SHAPE_PAINTERS.lame(ctx, r * 0.9);
  ctx.fillStyle = '#ffffff';
  SHAPE_PAINTERS.lame(ctx, r * 0.62);
  return Texture.from(canvas);
}

/**
 * Echelle du flash d'impact a l'age relatif `t`, pour un coup de rayon
 * `radiusPx` et une texture de `textureDiameterPx` de cote.
 *
 * ⚠️ **Deux regimes, et un seul d'entre eux est libre.** Un coup SANS souffle
 * (seize armes sur dix-sept) garde la courbe d'origine, choisie a l'oeil :
 * rien de reel ne lui dicte sa taille, il ne tue que ce qu'il percute. Un coup
 * AVEC souffle, lui, est asservi : a `t = 1` le disque fait exactement
 * `2 x radiusPx` pixels monde, donc le joueur voit la surface qui vient
 * reellement d'etre frappee. C'est mot pour mot la discipline de
 * `reactionFlashScale`, et pour la meme raison.
 */
export function impactFlashScale(
  t: number,
  radiusPx: number,
  textureDiameterPx: number,
  power = IMPACT_POWER_FULL,
): number {
  if (textureDiameterPx <= 0) {
    return 1;
  }
  if (radiusPx <= 0) {
    // Un coup faible ne monte pas jusqu'au plafond : c'est la que « dix-sept
    // armes, dix-sept impacts » se joue pour les seize armes sans souffle.
    const max = FLASH_MIN_SCALE + (FLASH_MAX_SCALE - FLASH_MIN_SCALE) * impactPower(power);
    return FLASH_MIN_SCALE + (max - FLASH_MIN_SCALE) * t;
  }
  const full = (2 * radiusPx) / textureDiameterPx;
  return full * (0.45 + 0.55 * t);
}

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
  /**
   * Les eclats, au-DESSUS du flash et dans leur propre conteneur : ils n'ont
   * ni la meme texture ni la meme rotation, et un `ParticleContainer` ne porte
   * qu'une texture source. Additif, comme les zones et la reaction (§6.6) :
   * deux gerbes qui se croisent s'additionnent au lieu de se masquer.
   */
  readonly #sparks = new ParticleContainer({
    blendMode: 'add',
    dynamicProperties: { position: true, vertex: true, color: true, rotation: true, uvs: false },
  });
  /** Le calque, vu du monde : flash puis eclats. Voir `attach`. */
  readonly #group = new Container();
  readonly #pool: Particle[] = [];
  readonly #sparkPool: Particle[] = [];
  #texture: Texture | null = null;
  #sparkTexture: Texture | null = null;

  constructor() {
    this.#container.boundsArea = mapBoundsArea();
    this.#sparks.boundsArea = mapBoundsArea();
  }

  get boundsArea(): Rectangle {
    return this.#container.boundsArea as Rectangle;
  }

  /** Idem pour le calque des eclats, qui est un conteneur a part entiere. */
  get sparkBoundsArea(): Rectangle {
    return this.#sparks.boundsArea as Rectangle;
  }

  /** Expose pour le test : « additif » est une exigence du §6.6, pas un detail. */
  get sparkBlendMode(): string {
    return this.#sparks.blendMode;
  }

  /**
   * ⚠️ **Un groupe, pas deux enfants poses cote a cote dans le monde** — meme
   * raison que `ProjectileRenderer.attach` : `stage.test.ts` compte les
   * enfants du monde, et « un renderer, un calque » ne doit pas devenir une
   * regle a exceptions.
   */
  attach(parent: Container): void {
    this.#group.addChild(this.#container);
    this.#group.addChild(this.#sparks);
    parent.addChild(this.#group);
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
    this.adoptTexture(makeBurstTexture(IMPACT_TEXTURE_DIAMETER), makeSparkTexture());
  }

  /**
   * Rend le renderer capable de dessiner sans canevas 2D.
   *
   * ⚠️ **Separe de `load` pour la meme raison que `ProjectileRenderer.adoptTextures`
   * (tache 9 bis)** : tant que les deux ne faisaient qu'un, `draw` retournait
   * au premier `if (!texture)` en test et **tout son corps pouvait etre retire
   * sans qu'une assertion ne bouge** — ce qui etait encore vrai de la teinte
   * du flash a l'etape 8, la ligne meme que cette etape ajoute.
   */
  adoptTexture(texture: Texture, spark: Texture): void {
    this.#texture = texture;
    this.#sparkTexture = spark;
  }

  /** `nowMs` doit etre la MEME horloge murale que celle passee a `HitFlashes.spawn`. */
  draw(flashes: HitFlashes, nowMs: number): void {
    const texture = this.#texture;
    const sparkTexture = this.#sparkTexture;
    if (!texture || !sparkTexture) {
      return;
    }
    this.#ensurePool(flashes.count, texture, sparkTexture);

    const children = this.#container.particleChildren;
    const sparks = this.#sparks.particleChildren;
    children.length = 0;
    sparks.length = 0;
    for (let i = 0; i < flashes.count; i++) {
      const particle = this.#pool[i];
      if (!particle) {
        break;
      }
      const x = flashes.x[i] ?? 0;
      const y = flashes.y[i] ?? 0;
      const tint = flashes.tint[i] || 0xffffff;
      const born = flashes.bornMs[i] ?? 0;
      const radius = flashes.radius[i] ?? 0;
      const power = flashes.power[i] ?? 0;
      const age = nowMs - born;
      const t = Math.min(1, Math.max(0, age / HIT_FLASH_LIFETIME_MS));
      const scale = impactFlashScale(t, radius, IMPACT_TEXTURE_DIAMETER, power);

      // La gerbe : six eclats qui partent du point d'impact, ralentissent et
      // s'eteignent. Tout est REDERIVE de (naissance, age) — ce calque ne garde
      // aucun etat entre deux images, donc rien a faire expirer ici.
      const travel = sparkTravel(radius);
      // Depart franc, arrivee amortie : `1 - (1 - t)²` est la meme detente que
      // partout ailleurs dans ce fichier, et elle evite a six eclats de glisser
      // a vitesse constante comme des curseurs.
      const course = 1 - (1 - t) * (1 - t);
      const eclats = sparkCount(power);
      for (let k = 0; k < eclats; k++) {
        const spark = this.#sparkPool[i * SPARKS_PER_FLASH + k];
        if (!spark) {
          break;
        }
        const angle = sparkAngle(born, k);
        spark.x = x + Math.cos(angle) * travel * course;
        spark.y = y + Math.sin(angle) * travel * course;
        spark.rotation = angle;
        // Il retrecit en volant : un eclat de taille constante lirait comme un
        // projectile de plus, pas comme un debris.
        // Il retrecit en volant, et il part d'autant plus gros que le coup
        // pesait : le troisieme canal de « dix-sept armes, dix-sept impacts ».
        spark.scaleX = (1 - 0.6 * t) * (0.7 + 0.5 * impactPower(power)) * (radius > 0 ? 1.6 : 1);
        spark.scaleY = spark.scaleX;
        spark.tint = tint;
        spark.alpha = (1 - t) * (1 - t);
        sparks.push(spark);
      }

      particle.x = x;
      particle.y = y;
      particle.scaleX = scale;
      particle.scaleY = scale;
      // La teinte de l'arme qui a touche, recopiee a la naissance du flash —
      // voir `HitFlashes.tint`. (Relue ici depuis `tint`, pose plus haut.)
      //
      // ⚠️ **`||` et pas `??`, et c'est la seule faute que ce calque puisse
      // commettre en silence.** `tint` multiplie : un creneau laisse a zero
      // (un `Uint32Array` neuf, ou un flash ne par un chemin qui oublierait la
      // teinte) rendrait un flash NOIR, c'est-a-dire invisible, et rien a
      // l'ecran ne dirait qu'il a eu lieu. Le blanc est l'identite du produit,
      // donc la texture telle quelle : le flash reste visible, seule sa
      // couleur est perdue.
      particle.tint = tint;
      particle.alpha = 1 - t;
      children.push(particle);
    }
    this.#container.update();
    this.#sparks.update();
  }

  /** Les trois noeuds, et pas seulement le groupe : `attach` peut n'avoir jamais eu lieu. */
  destroy(): void {
    this.#container.destroy();
    this.#sparks.destroy();
    this.#group.destroy();
  }

  #ensurePool(needed: number, texture: Texture, spark: Texture): void {
    while (this.#pool.length < needed) {
      this.#pool.push(new Particle({ texture, anchorX: 0.5, anchorY: 0.5 }));
    }
    while (this.#sparkPool.length < needed * SPARKS_PER_FLASH) {
      this.#sparkPool.push(new Particle({ texture: spark, anchorX: 0.5, anchorY: 0.5 }));
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
   * `makeZoneAtlas`).
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
