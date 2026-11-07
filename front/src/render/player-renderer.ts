import { AnimatedSprite, Assets, type Container, Graphics, Rectangle, Texture } from 'pixi.js';

/**
 * Les joueurs dessines avec les unites du pack (`Units/<Couleur> Units/`) :
 * une unite par CLASSE, une couleur par JOUEUR, et deux animations, a l'arret
 * et en course.
 *
 * ⚠️ **Rien n'est cuit** : les planches sont lues a l'execution sous
 * `ASSETS_BASE`. Tant qu'une planche n'est pas la, le joueur garde son carre
 * de couleur — jamais un trou a l'ecran.
 *
 * ⚠️ **Le fantome.** Chaque joueur a une copie translucide dans un calque
 * AU-DESSUS de tout le decor (`ghosts`). La ou rien ne le cache, elle se pose
 * sur son original et ne change rien ; derriere un arbre, elle est la seule a
 * se voir — le joueur passe en transparence derriere l'objet, sans test de
 * recouvrement par image.
 *
 * ⚠️ **Le socle.** Un cercle a la couleur du joueur, pose a ses pieds et
 * classe juste SOUS son sprite dans le calque trie — donc par-dessus la
 * horde. C'est le seul repere qui tienne quand vingt monstres se collent au
 * groupe : on retrouve les quatre couleurs au premier coup d'oeil.
 */

/** L'unite du pack de chaque classe, par identifiant : 0 Amorce, 1 Rempart, 2 Appat, 3 Relais. */
export const UNIT_OF_CLASS = ['Archer', 'Warrior', 'Lancer', 'Monk'] as const;
type Unit = (typeof UNIT_OF_CLASS)[number];

/** La couleur du pack de chaque joueur, dans l'ordre de `PLAYER_COLORS`. */
export const UNIT_COLORS = ['Yellow', 'Blue', 'Red', 'Purple'] as const;

const SHEETS: Record<Unit, { idle: string; run: string; frame: number }> = {
  Archer: { idle: 'Archer/Archer_Idle.png', run: 'Archer/Archer_Run.png', frame: 192 },
  Warrior: { idle: 'Warrior/Warrior_Idle.png', run: 'Warrior/Warrior_Run.png', frame: 192 },
  Lancer: { idle: 'Lancer/Lancer_Idle.png', run: 'Lancer/Lancer_Run.png', frame: 320 },
  Monk: { idle: 'Monk/Idle.png', run: 'Monk/Run.png', frame: 192 },
};

/**
 * Echelle d'une unite : un peu plus petite que les monstres.
 *
 * ⚠️ **Une demi-echelle, pas 0,6** : les planches font 192 px (320 pour le
 * Lancier) et sont rendues en `nearest`. A 0,5, un texel vaut exactement un
 * pixel d'ecran sur un ecran dense (DPR 2) et un demi sur un ecran simple —
 * une rangee sur deux, uniformement. A 0,6, c'etait 1,2 : une rangee sur cinq
 * doublee, et un contour qui rampe a chaque pas.
 */
export const UNIT_SCALE = 0.5;
/** Opacite du fantome : assez pour se voir derriere un arbre, pas assez pour doubler le trait. */
export const GHOST_ALPHA = 0.35;
/** Rayon du socle, en px monde : un peu plus large que l'unite, jamais autant qu'un monstre. */
export const BASE_RADIUS_PX = 22;
/**
 * Le socle d'un joueur en grace (etape 18) : le gris du totem (etape 16). La
 * meme lecture qu'un mort — « il est la, il ne joue pas » — sans bandeau.
 */
export const ABSENT_BASE = 0x8a8f99;
const NO_ABSENT: ReadonlySet<number> = new Set();

/**
 * Le socle, PUR : sa couleur et son opacite selon l'etat du joueur. Un absent
 * est gris, mort ou pas (l'absence se lit meme au sol), a l'opacite du mort.
 */
export function baseStyle(
  color: number,
  absent: boolean,
  dead: boolean,
  local: boolean,
): { color: number; alpha: number } {
  if (absent) {
    return { color: ABSENT_BASE, alpha: 0.25 };
  }
  return { color, alpha: dead ? 0.25 : local ? 1 : 0.7 };
}

/** (Re)dessine le cercle du socle a cette couleur. */
function paintBase(g: Graphics, color: number): Graphics {
  // Un cercle, pas une ellipse : c'est la camera qui decide de l'ecrasement
  // (`VERTICAL_SQUASH`), uniformement pour tout le monde.
  return g
    .clear()
    .circle(0, 0, BASE_RADIUS_PX)
    .fill({ color, alpha: 0.22 })
    .circle(0, 0, BASE_RADIUS_PX)
    .stroke({ color, width: 2.5, alpha: 0.9 });
}
/** Un deplacement plus petit, d'une image a l'autre, ne compte pas comme une course. */
const RUN_EPSILON_PX = 0.4;
/** Le joueur court encore ce long apres son dernier pas : pas de clignotement. */
const RUN_HOLD_MS = 120;

/** Les deux planches et la taille d'image de `playerId` jouant `classId`. */
export function unitSheets(
  playerId: number,
  classId: number,
): { idle: string; run: string; frame: number } {
  const unit = UNIT_OF_CLASS[classId] ?? UNIT_OF_CLASS[0];
  const color = UNIT_COLORS[(playerId - 1 + UNIT_COLORS.length) % UNIT_COLORS.length];
  const base = `Units/${color}%20Units/`;
  const s = SHEETS[unit];
  return { idle: base + s.idle, run: base + s.run, frame: s.frame };
}

interface Body {
  key: string;
  body: AnimatedSprite | null;
  ghost: AnimatedSprite | null;
  /** Le socle a la couleur du joueur : ce qui le distingue de la horde. */
  base: Graphics;
  /** La couleur du joueur, et celle que le socle porte en ce moment (gris en grace). */
  color: number;
  baseColor: number;
  fallback: Graphics;
  lastX: number;
  lastY: number;
  lastMoveMs: number;
  facing: 1 | -1;
  running: boolean;
  /** Distance du centre aux pieds, en px monde : le tri en profondeur se fait aux pieds. */
  feet: number;
  idle: Texture[];
  run: Texture[];
}

const sheetCache = new Map<string, Promise<Texture[]>>();

/** Decoupe une planche horizontale en images carrees de `frame` px (memoisee par URL). */
export function framesOf(url: string, frame: number): Promise<Texture[]> {
  let p = sheetCache.get(url);
  if (!p) {
    p = Assets.load<Texture>(url).then((sheet) => {
      sheet.source.scaleMode = 'nearest';
      const n = Math.max(1, Math.floor(sheet.width / frame));
      return Array.from(
        { length: n },
        (_, i) =>
          new Texture({ source: sheet.source, frame: new Rectangle(i * frame, 0, frame, frame) }),
      );
    });
    sheetCache.set(url, p);
  }
  return p;
}

export class PlayerRenderer {
  readonly #bodies = new Map<number, Body>();

  constructor(
    private readonly assetsBase: string,
    /** Le calque trie par profondeur, partage avec les arbres. */
    private readonly depth: Container,
    /** Le calque des fantomes, au-dessus de tout le decor. */
    private readonly ghosts: Container,
    private readonly fallbackColor: (playerId: number) => number,
  ) {}

  draw(
    players: readonly { id: number; x: number; y: number; hp?: number }[],
    classOf: (playerId: number) => number,
    localId: number | null,
    nowMs: number,
    /** Les joueurs en grace (etape 18, `RenderState.absent`) : socle gris. */
    absent: ReadonlySet<number> = NO_ABSENT,
  ): void {
    const seen = new Set<number>();
    for (const p of players) {
      seen.add(p.id);
      const b = this.#bodyFor(p.id, classOf(p.id), p.x, p.y);
      const dx = p.x - b.lastX;
      const dy = p.y - b.lastY;
      if (Math.hypot(dx, dy) > RUN_EPSILON_PX) {
        b.lastMoveMs = nowMs;
        if (Math.abs(dx) > RUN_EPSILON_PX / 2) {
          b.facing = dx < 0 ? -1 : 1;
        }
      }
      b.lastX = p.x;
      b.lastY = p.y;
      const running = nowMs - b.lastMoveMs < RUN_HOLD_MS;
      // Un mort reste dans le snapshot : on le voit, mais en ombre.
      const dead = (p.hp ?? 1) <= 0;
      const alpha = dead ? 0.35 : p.id === localId ? 1 : 0.9;
      // Les arbres sont tries par leur pied (`terrain-renderer`) : le joueur
      // aussi, sinon il passe derriere un tronc 46 px trop tot.
      const depth = p.y + b.feet;

      b.base.position.set(p.x, p.y);
      // Juste SOUS son propre sprite dans le calque trie, donc au-dessus de la
      // horde : c'est tout l'interet du socle, se voir au milieu des monstres.
      b.base.zIndex = depth - 1;
      const socle = baseStyle(b.color, absent.has(p.id), dead, p.id === localId);
      if (socle.color !== b.baseColor) {
        b.baseColor = socle.color;
        paintBase(b.base, socle.color);
      }
      b.base.alpha = socle.alpha;
      b.fallback.position.set(p.x, p.y);
      b.fallback.zIndex = depth;
      b.fallback.visible = b.body === null;
      for (const [s, a] of [
        [b.body, alpha],
        [b.ghost, GHOST_ALPHA * alpha],
      ] as const) {
        if (!s) {
          continue;
        }
        if (running !== b.running) {
          s.textures = running ? b.run : b.idle;
          s.play();
        }
        s.position.set(p.x, p.y);
        s.zIndex = depth;
        s.scale.set(UNIT_SCALE * b.facing, UNIT_SCALE);
        s.alpha = a;
      }
      if (b.body && b.ghost && b.ghost.currentFrame !== b.body.currentFrame) {
        b.ghost.gotoAndPlay(b.body.currentFrame);
      }
      b.running = running;
    }
    for (const [id, b] of this.#bodies) {
      if (!seen.has(id)) {
        b.body?.destroy();
        b.ghost?.destroy();
        b.base.destroy();
        b.fallback.destroy();
        this.#bodies.delete(id);
      }
    }
  }

  #bodyFor(id: number, classId: number, x: number, y: number): Body {
    const sheets = unitSheets(id, classId);
    const key = sheets.idle;
    const existing = this.#bodies.get(id);
    if (existing && existing.key === key) {
      return existing;
    }
    if (existing) {
      // La classe a change (salon) : on repart d'une unite neuve.
      existing.body?.destroy();
      existing.ghost?.destroy();
      existing.base.destroy();
      existing.fallback.destroy();
    }
    const color = this.fallbackColor(id);
    const baseRing = paintBase(new Graphics(), color);
    const fallback = new Graphics().rect(-18, -18, 36, 36).fill(color);
    this.depth.addChild(baseRing, fallback);
    const b: Body = {
      key,
      body: null,
      ghost: null,
      base: baseRing,
      color,
      baseColor: color,
      fallback,
      lastX: x,
      lastY: y,
      lastMoveMs: Number.NEGATIVE_INFINITY,
      facing: 1,
      running: false,
      // L'ancre est a 0,6 de la hauteur : les pieds sont 0,4 image plus bas.
      feet: 0.4 * sheets.frame * UNIT_SCALE,
      idle: [],
      run: [],
    };
    this.#bodies.set(id, b);
    const base = `${this.assetsBase}/`;
    Promise.all([
      framesOf(base + sheets.idle, sheets.frame),
      framesOf(base + sheets.run, sheets.frame),
    ])
      .then(([idle, run]) => {
        if (this.#bodies.get(id) !== b) {
          return;
        }
        b.idle = idle;
        b.run = run;
        const make = (layer: Container): AnimatedSprite => {
          const s = new AnimatedSprite(idle);
          // Les pieds de l'unite sous le centre du joueur.
          s.anchor.set(0.5, 0.6);
          s.animationSpeed = 0.15;
          s.play();
          layer.addChild(s);
          return s;
        };
        b.body = make(this.depth);
        b.ghost = make(this.ghosts);
        b.running = false;
      })
      .catch((cause: unknown) => {
        console.error('planches des unites indisponibles, le joueur reste un carre', cause);
      });
    return b;
  }
}
