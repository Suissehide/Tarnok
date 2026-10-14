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

/** Echelle d'une unite : un peu plus petite que les monstres (retour de playtest : 0,95 trop grand). */
export const UNIT_SCALE = 0.6;
/** Opacite du fantome : assez pour se voir derriere un arbre, pas assez pour doubler le trait. */
export const GHOST_ALPHA = 0.35;
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
  fallback: Graphics;
  lastX: number;
  lastY: number;
  lastMoveMs: number;
  facing: 1 | -1;
  running: boolean;
  idle: Texture[];
  run: Texture[];
}

const sheetCache = new Map<string, Promise<Texture[]>>();

function framesOf(url: string, frame: number): Promise<Texture[]> {
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
    players: readonly { id: number; x: number; y: number }[],
    classOf: (playerId: number) => number,
    localId: number | null,
    nowMs: number,
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
      const alpha = p.id === localId ? 1 : 0.9;

      b.fallback.position.set(p.x, p.y);
      b.fallback.zIndex = p.y;
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
        s.zIndex = p.y;
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
      existing.fallback.destroy();
    }
    const fallback = new Graphics().rect(-18, -18, 36, 36).fill(this.fallbackColor(id));
    this.depth.addChild(fallback);
    const b: Body = {
      key,
      body: null,
      ghost: null,
      fallback,
      lastX: x,
      lastY: y,
      lastMoveMs: Number.NEGATIVE_INFINITY,
      facing: 1,
      running: false,
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
