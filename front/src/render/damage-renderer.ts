import { MAP_SIZE } from '@shared/constants';
import { ELEMENT } from '@shared/elements';
import { type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

import { DAMAGE_NUMBER_LIFETIME_MS, type DamageNumbers } from '../net/client';

/**
 * Rendu des chiffres de degats (etape 8) — *« il faut afficher les degats sur
 * les monstres avec des chiffres »*.
 *
 * ⚠️ **Un ATLAS DE CHIFFRES, pas des objets `Text`.** Un `Text` de Pixi cuit sa
 * propre texture a chaque contenu different : a plusieurs dizaines d'impacts
 * par seconde, chacun avec un nombre different, c'est une texture creee et
 * jetee par coup. Dix cases cuites une fois au chargement — le meme choix que
 * l'atlas des projectiles, des zones et des orbes — rendent le meme dessin
 * pour un seul lot de quads.
 *
 * ⚠️ **Le cout est BORNE par le nombre de chiffres, pas par la horde** :
 * `DAMAGE_NUMBER_CAPACITY` (128) chiffres de quatre caracteres au pire font
 * 512 quads, contre 4 096 pour les projectiles seuls. Le test de ce fichier le
 * mesure plutot que de l'esperer, comme la trainee l'a ete a la tache 12.
 */

/** Marge des bornes explicites, meme raisonnement que `HordeRenderer.BOUNDS_MARGIN`. */
const BOUNDS_MARGIN = 256;

/** Cote d'une case de l'atlas, en pixels : la finesse du dessin, pas la taille a l'ecran. */
export const DIGIT_CELL_PX = 32;

/** Le plus de chiffres qu'un nombre puisse occuper a l'ecran. */
export const DIGITS_MAX = 4;

/** Hauteur d'un chiffre a l'ecran, en pixels monde. */
export const DIGIT_HEIGHT_PX = 20;

/** Part de la hauteur dont deux chiffres voisins sont ecartes. */
const DIGIT_ADVANCE = 0.58;

/** De combien un chiffre MONTE sur sa vie, en pixels monde. */
export const DAMAGE_RISE_PX = 46;

/** Ce qu'un coup critique ajoute a la taille du nombre. */
export const CRIT_SCALE = 1.6;

/**
 * Degats au-dela desquels un chiffre ne grossit plus.
 *
 * ⚠️ **C'est ce qui fait SENTIR la progression** (*« que l'on sente la
 * progression »*) : un 3 de lance-flammes et un 40 de grenade ne doivent pas
 * s'ecrire de la meme taille, sinon la seule chose que le joueur lit est le
 * nombre lui-meme — alors que ce qu'il veut savoir, c'est si ca monte.
 *
 * ⚠️ **Un PLAFOND, pas une echelle.** Au-dela, un coup empile par vingt cartes
 * ecrirait des chiffres plus hauts que les monstres. 60 laisse de la marge
 * au-dessus de la plus grosse arme du catalogue (40) sans la saturer d'emblee.
 */
export const DAMAGE_FULL = 60;

/** Les bornes de taille d'un chiffre, en fraction de `DIGIT_HEIGHT_PX`. */
export const DAMAGE_SCALE_MIN = 0.78;
export const DAMAGE_SCALE_MAX = 1.35;

/**
 * La taille d'un chiffre pour `amount` degats, de `DAMAGE_SCALE_MIN` (une
 * piqure) a `DAMAGE_SCALE_MAX` (un coup qui compte).
 *
 * ⚠️ **En racine, pas lineaire** : de 1 a 10 degats, l'ecart se VOIT ; de 50 a
 * 60, il n'apprend plus rien. La racine donne ses marches la ou le catalogue
 * est dense.
 */
export function damageScale(amount: number): number {
  const part = Math.min(1, Math.max(0, amount / DAMAGE_FULL));
  return DAMAGE_SCALE_MIN + (DAMAGE_SCALE_MAX - DAMAGE_SCALE_MIN) * Math.sqrt(part);
}

/**
 * La teinte d'un chiffre, par element qui porte le coup (etape 8) — *« rouge
 * et gros en crit, jaune en poison »*.
 *
 * ⚠️ **Ce ne sont PAS les teintes d'`ELEMENTS`, et c'est delibere.** Celles-la
 * disent la matiere AU SOL, sur de l'herbe, a `ZONE_ALPHA` : la Poix y est un
 * brun presque noir et la Chaux un blanc crayeux, deux couleurs qu'un chiffre
 * de vingt pixels ne porterait pas. Ici la contrainte est inverse — se lire
 * par-dessus n'importe quoi, en un dixieme de seconde — donc chaque element a
 * une couleur VIVE qui lui ressemble sans etre la sienne : le poison tire au
 * jaune acide, le givre au cyan clair, la foudre au jaune franc.
 *
 * ⚠️ **Le cerne noir cuit dans l'atlas fait le reste** : c'est lui qui permet
 * a un jaune de rester lisible sur de l'herbe claire comme sur un sprite
 * sombre.
 */
export const DAMAGE_TINTS: Record<number, number> = {
  [ELEMENT.NEUTRE]: 0xffffff,
  [ELEMENT.BRAISE]: 0xff8c1a,
  [ELEMENT.GIVRE]: 0x5fd8ff,
  [ELEMENT.FOUDRE]: 0xffe34a,
  [ELEMENT.POIX]: 0xaee034,
  [ELEMENT.CHAUX]: 0xf4ecc8,
  [ELEMENT.VIF_ARGENT]: 0xc9bcff,
};

/** Teinte d'un coup ordinaire sans element : le repli de `DAMAGE_TINTS`. */
export const DAMAGE_TINT = 0xffffff;

/**
 * Teinte d'un coup CRITIQUE : rouge, et elle l'emporte sur l'element.
 *
 * ⚠️ **Un critique ne dit pas la meme chose qu'un element.** L'element dit ce
 * que le coup PREPARE pour l'equipe (la marque, la reaction a venir) ; le
 * critique dit que celui-la, a l'instant, a fait mal. Melanger les deux —
 * un critique de Givre en cyan clair — ferait perdre le seul evenement rare
 * des deux.
 */
export const CRIT_TINT = 0xff2b2b;

/** La teinte d'un chiffre : le rouge du critique, sinon celle de son element. */
export function damageTint(element: number, crit: boolean): number {
  return crit ? CRIT_TINT : (DAMAGE_TINTS[element] ?? DAMAGE_TINT);
}

/**
 * Le noir du cerne — la MEME valeur que les orbes, les pieces et les
 * projectiles : un chiffre sans contour se perd sur l'herbe claire comme sur
 * un sprite sombre, et il doit se lire sur les deux.
 */
const OUTLINE_RGBA = 'rgba(20, 16, 18, 1)';

/**
 * Cuit l'atlas : une case par chiffre, blanc cerne de noir.
 *
 * Blanc pour la meme raison que la trainee et les zones : `Particle.tint`
 * multiplie, donc une case blanche rend exactement la teinte demandee — ici le
 * dore d'un critique ou le blanc d'un coup ordinaire.
 */
function makeDigitAtlas(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = DIGIT_CELL_PX * 10;
  canvas.height = DIGIT_CELL_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  ctx.font = `bold ${Math.round(DIGIT_CELL_PX * 0.82)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (let d = 0; d < 10; d++) {
    const cx = d * DIGIT_CELL_PX + DIGIT_CELL_PX / 2;
    const cy = DIGIT_CELL_PX / 2;
    // Le cerne d'abord, en trait epais : c'est lui qui detache le chiffre de
    // tout ce qui peut passer dessous.
    ctx.strokeStyle = OUTLINE_RGBA;
    ctx.lineWidth = DIGIT_CELL_PX * 0.22;
    ctx.strokeText(String(d), cx, cy);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(d), cx, cy);
  }
  return Texture.from(canvas);
}

/**
 * La hauteur dont un chiffre d'age relatif `t` est monte, en pixels monde.
 *
 * ⚠️ **Il RALENTIT en montant** (`1 - (1 - t)²`) : un chiffre a vitesse
 * constante glisse comme un curseur, celui-ci part franchement puis se pose,
 * donc l'oeil a le temps de le lire a la fin plutot qu'au debut.
 */
export function damageRise(t: number): number {
  const amorti = 1 - (1 - t) * (1 - t);
  return DAMAGE_RISE_PX * amorti;
}

/**
 * L'opacite d'un chiffre d'age relatif `t`.
 *
 * ⚠️ **Pleine sur la premiere moitie de sa vie**, puis elle s'eteint : un
 * fondu qui commence des la naissance rend illisible le seul moment ou le
 * joueur regarde encore l'endroit du coup.
 */
export function damageFade(t: number): number {
  return t < 0.5 ? 1 : 1 - (t - 0.5) * 2;
}

/** Les chiffres d'un nombre, du plus fort au plus faible. Jamais plus de `DIGITS_MAX`. */
export function digitsOf(amount: number): number[] {
  const entier = Math.max(0, Math.round(amount));
  const texte = String(entier).slice(0, DIGITS_MAX);
  return [...texte].map((c) => Number(c));
}

export class DamageNumberRenderer {
  readonly #container = new ParticleContainer({
    // `uvs` : le reservoir est REUTILISE, et un creneau peut porter un 7 a
    // cette image et un 2 a la suivante — meme raison que les tetes de
    // projectile. `vertex` : un critique s'ecrit plus gros. `color` : la
    // teinte du critique et le fondu.
    dynamicProperties: { position: true, vertex: true, color: true, uvs: true, rotation: false },
  });
  readonly #pool: Particle[] = [];
  #cells: Texture[] = [];

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

  get loaded(): boolean {
    return this.#cells.length > 0;
  }

  load(): void {
    this.adoptAtlas(makeDigitAtlas());
  }

  /**
   * Decoupe l'atlas. Separe de `load` pour la meme raison que partout ailleurs
   * (tache 9 bis) : `load` a besoin d'un canevas 2D que l'environnement de
   * test n'a pas, et sans ce point d'entree `draw` retournerait a son premier
   * `if` sans qu'aucune assertion ne puisse l'atteindre.
   */
  adoptAtlas(atlas: Texture): void {
    this.#cells = Array.from(
      { length: 10 },
      (_, d) =>
        new Texture({
          source: atlas.source,
          frame: new Rectangle(d * DIGIT_CELL_PX, 0, DIGIT_CELL_PX, DIGIT_CELL_PX),
        }),
    );
  }

  /** `nowMs` doit etre la MEME horloge murale que celle passee a `DamageNumbers.spawn`. */
  draw(numbers: DamageNumbers, nowMs: number): void {
    const fallback = this.#cells[0];
    if (!fallback) {
      return;
    }
    this.#ensurePool(numbers.count * DIGITS_MAX, fallback);

    const children = this.#container.particleChildren;
    children.length = 0;
    let used = 0;
    for (let i = 0; i < numbers.count; i++) {
      const age = nowMs - (numbers.bornMs[i] ?? 0);
      const t = Math.min(1, Math.max(0, age / DAMAGE_NUMBER_LIFETIME_MS));
      const crit = (numbers.crit[i] ?? 0) === 1;
      const montant = numbers.amount[i] ?? 0;
      const chiffres = digitsOf(montant);
      // La taille dit DEUX choses : ce que le coup pese (`damageScale`) et
      // s'il etait critique. Les deux se multiplient — un gros coup critique
      // doit etre le plus gros de tous.
      const taille = damageScale(montant) * (crit ? CRIT_SCALE : 1);
      const echelle = (taille * DIGIT_HEIGHT_PX) / DIGIT_CELL_PX;
      const pas = DIGIT_HEIGHT_PX * DIGIT_ADVANCE * taille;
      // Centre sur le monstre : le nombre est pose autour de son axe, pas a
      // droite de lui.
      const gauche = (-(chiffres.length - 1) * pas) / 2;
      const x = numbers.x[i] ?? 0;
      const y = (numbers.y[i] ?? 0) - damageRise(t);

      for (let k = 0; k < chiffres.length; k++) {
        const particle = this.#pool[used];
        if (!particle) {
          break;
        }
        particle.texture = this.#cells[chiffres[k] ?? 0] ?? fallback;
        particle.x = x + gauche + k * pas;
        particle.y = y;
        particle.scaleX = echelle;
        particle.scaleY = echelle;
        particle.tint = damageTint(numbers.element[i] ?? 0, crit);
        particle.alpha = damageFade(t);
        children.push(particle);
        used++;
      }
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
