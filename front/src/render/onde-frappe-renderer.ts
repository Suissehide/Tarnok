import { TICK_HZ } from '@shared/constants';
import { GUARD_PULSE_TICKS } from '@shared/weapons';
import { type Container, Graphics } from 'pixi.js';

import {
  FRAPPE_BOLT_MS,
  FRAPPE_DELAY_MS,
  type FrappeTrace,
  type GuardTrace,
  type OndeTrace,
} from '../net/client';
import type { BeamAnchor } from './chain-renderer';

/** Braises qui montent dans une aura : un nombre fixe, donc un cout borne. */
export const AURA_EMBERS = 12;
/** La periode d'une pulsation, en ms : la vague qui court au bord de l'aura la suit. */
const AURA_PULSE_MS = (GUARD_PULSE_TICKS / TICK_HZ) * 1000;

/**
 * Les deux familles sans projectile de l'etape 12 (§3.4, §5) : l'ONDE, un
 * anneau qui s'agrandit depuis le tireur, et la FRAPPE, un avertissement au
 * sol puis un eclair qui tombe du ciel.
 *
 * Meme discipline que `ChainRenderer` : un seul `Graphics`, ne lit QUE les
 * listes que `GameClient` a semees (jamais la horde), donc un cout borne par
 * leur capacite (`ONDE_TRACE_CAPACITY`, `FRAPPE_TRACE_CAPACITY`). Les degats
 * sont deja arbitres ; ce calque n'amortit que l'horloge murale.
 */

/** Epaisseur de l'anneau a sa naissance, puis a sa portee maximale, en px monde. */
export const ONDE_WIDTH_START_PX = 14;
export const ONDE_WIDTH_END_PX = 3;
/** Largeur de la bande translucide qui suit le front de l'onde, en px monde. */
export const ONDE_WAKE_PX = 48;
/** Fraction de la course a partir de laquelle l'onde s'eteint. */
const ONDE_FADE_FROM = 0.7;

/** L'avertissement part de ce multiple du rayon d'impact et se resserre jusqu'a lui. */
export const FRAPPE_WARN_START = 2.2;
/** Hauteur d'ou tombe l'eclair, en px monde : au-dela du haut de l'ecran. */
export const FRAPPE_BOLT_HEIGHT_PX = 560;
/** Segments du zigzag de l'eclair. */
export const FRAPPE_BOLT_SEGMENTS = 9;
/** Ecart lateral maximal du zigzag, en px monde. */
const FRAPPE_BOLT_JITTER_PX = 22;
/** Etincelles par impact : un nombre fixe, donc un cout borne. */
export const FRAPPE_SPARKS = 8;

/** Hachage deterministe dans `[0, 1)` : un eclair garde sa forme d'une image a l'autre. */
function hash01(a: number, b: number): number {
  const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export class OndeFrappeRenderer {
  readonly #graphics = new Graphics();
  /** Rien a cuire : le booleen sert le protocole de `Stage.layersLoaded`, comme `ChainRenderer`. */
  #ready = false;

  attach(parent: Container): void {
    parent.addChild(this.#graphics);
  }

  /** Expose pour le test. */
  get graphics(): Graphics {
    return this.#graphics;
  }

  get loaded(): boolean {
    return this.#ready;
  }

  load(): void {
    this.#ready = true;
  }

  draw(
    ondes: readonly OndeTrace[],
    frappes: readonly FrappeTrace[],
    nowMs: number,
    guards: readonly GuardTrace[] = [],
    players: readonly BeamAnchor[] = [],
  ): void {
    this.#graphics.clear();
    if (!this.#ready) {
      return;
    }
    // Une aura par invocateur : deux homoncules qui se chevauchent (cadence
    // empilee) dessineraient deux fois le meme disque, plus opaque.
    for (let i = 0; i < guards.length; i++) {
      const guard = guards[i];
      if (!guard || guards.findIndex((g) => g.by === guard.by) !== i) {
        continue;
      }
      const owner = players.find((p) => p.id === guard.by);
      this.#drawAura(guard, owner ?? guard, nowMs);
    }
    for (const onde of ondes) {
      this.#drawOnde(onde, nowMs);
    }
    for (const frappe of frappes) {
      if (frappe.struckMs < 0) {
        this.#drawWarning(frappe, nowMs);
      } else {
        this.#drawBolt(frappe, nowMs);
      }
    }
  }

  /**
   * Le rayon est interpole a l'horloge murale (`bornMs`), pas pris au tick :
   * une onde a 460 px/s saute de 15 px par tick, ce qui se voit a 60 Hz. Le
   * plafond `maxRadius` reste celui que le serveur arbitre.
   */
  #drawOnde(onde: OndeTrace, nowMs: number): void {
    const elapsed = Math.max(0, nowMs - onde.bornMs) / 1000;
    const r = onde.speed > 0 ? Math.min(onde.maxRadius, onde.speed * elapsed) : onde.maxRadius;
    const k = onde.maxRadius > 0 ? r / onde.maxRadius : 1;
    const fade = 1 - clamp01((k - ONDE_FADE_FROM) / (1 - ONDE_FADE_FROM));
    if (fade <= 0 || r <= 0) {
      return;
    }
    const g = this.#graphics;
    // La bande parcourue : un sillage translucide juste derriere le front.
    const wake = Math.min(r, ONDE_WAKE_PX);
    g.circle(onde.x, onde.y, r - wake / 2).stroke({
      color: onde.tint,
      width: wake,
      alpha: 0.12 * fade,
    });
    // Le front : epais au depart, il s'affine en s'eloignant.
    const w = ONDE_WIDTH_START_PX + (ONDE_WIDTH_END_PX - ONDE_WIDTH_START_PX) * k;
    g.circle(onde.x, onde.y, r).stroke({ color: onde.tint, width: w, alpha: 0.85 * fade });
    g.circle(onde.x, onde.y, r).stroke({
      color: 0xffffff,
      width: Math.max(1, w * 0.3),
      alpha: 0.55 * fade,
    });
  }

  /**
   * L'aura de l'homoncule (etape 12) : un disque de mercure qui SUIT son
   * invocateur (`center`, sa position dessinee), un bord qui miroite, une
   * vague qui court du dedans vers le bord a chaque pulsation, des braises qui
   * montent, et l'homoncule lui-meme — une goutte qui tourne dans l'aura.
   */
  #drawAura(guard: GuardTrace, center: { x: number; y: number }, nowMs: number): void {
    const g = this.#graphics;
    const r = guard.radius;
    const t = Math.max(0, nowMs - guard.bornMs) / 1000;
    const cx = center.x;
    const cy = center.y;
    const tint = guard.tint;

    g.circle(cx, cy, r).fill({ color: tint, alpha: 0.07 });
    // Le bord qui miroite : un cercle module par une sinusoide qui tourne.
    const n = 48;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2;
      const rr = r * (1 + 0.035 * Math.sin(6 * a + t * 4));
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      if (k === 0) {
        g.moveTo(px, py);
      } else {
        g.lineTo(px, py);
      }
    }
    g.stroke({ color: tint, width: 3, alpha: 0.55 });
    g.circle(cx, cy, r).stroke({ color: 0xffffff, width: 1, alpha: 0.25 });
    // La pulsation : un anneau qui part des deux tiers et meurt au bord.
    const phase = ((nowMs - guard.bornMs) % AURA_PULSE_MS) / AURA_PULSE_MS;
    g.circle(cx, cy, r * (0.65 + 0.35 * phase)).stroke({
      color: tint,
      width: 6 * (1 - phase) + 1,
      alpha: 0.35 * (1 - phase),
    });
    // Les braises : chacune nait a un point fixe de l'aura et monte en s'eteignant.
    for (let e = 0; e < AURA_EMBERS; e++) {
      const a = hash01(e, guard.by + 1) * Math.PI * 2;
      const d = r * Math.sqrt(hash01(guard.by + 3, e)) * 0.95;
      const cycle = (t * 0.9 + hash01(e + 5, guard.by)) % 1;
      const ex = cx + Math.cos(a) * d;
      const ey = cy + Math.sin(a) * d - cycle * 26;
      g.circle(ex, ey, 1.8 * (1 - cycle) + 0.4).fill({
        color: e % 3 === 0 ? 0xffffff : tint,
        alpha: 0.8 * (1 - cycle),
      });
    }
    // L'homoncule : une goutte de mercure qui tourne, avec sa trainee.
    for (let s = 3; s >= 0; s--) {
      const a = t * 2.4 - s * 0.16;
      const hx = cx + Math.cos(a) * r * 0.6;
      const hy = cy + Math.sin(a) * r * 0.6 + Math.sin(t * 6) * 2;
      g.circle(hx, hy, 7 - s * 1.4).fill({ color: tint, alpha: s === 0 ? 0.95 : 0.25 });
      if (s === 0) {
        g.circle(hx - 2, hy - 2.5, 2.4).fill({ color: 0xffffff, alpha: 0.9 });
      }
    }
  }

  /** Pendant le delai : un cercle qui se resserre sur le rayon d'impact, et un point au centre. */
  #drawWarning(frappe: FrappeTrace, nowMs: number): void {
    const g = this.#graphics;
    const t = clamp01((nowMs - frappe.bornMs) / FRAPPE_DELAY_MS);
    const ring = frappe.radius * (FRAPPE_WARN_START - (FRAPPE_WARN_START - 1) * t);
    g.circle(frappe.x, frappe.y, frappe.radius).fill({
      color: frappe.tint,
      alpha: 0.06 + 0.12 * t,
    });
    g.circle(frappe.x, frappe.y, ring).stroke({
      color: frappe.tint,
      width: 2 + t,
      alpha: 0.35 + 0.5 * t,
    });
    g.circle(frappe.x, frappe.y, 2.5 + 1.5 * t).fill({ color: 0xffffff, alpha: 0.5 + 0.4 * t });
  }

  /**
   * L'eclair : un zigzag deterministe (graine = l'impact) qui descend du haut
   * en ~40 ms, en deux couches (halo teinte, coeur blanc), puis s'eteint ; des
   * etincelles fusent de l'impact. Le flash et la secousse, eux, sont ceux de
   * `hitFlashes`, semes au meme instant.
   */
  #drawBolt(frappe: FrappeTrace, nowMs: number): void {
    const u = clamp01((nowMs - frappe.struckMs) / FRAPPE_BOLT_MS);
    const fade = 1 - u;
    if (fade <= 0) {
      return;
    }
    const g = this.#graphics;
    const seed = frappe.x * 0.37 + frappe.y * 0.11 + frappe.dueTick;
    const reach = Math.min(1, u / 0.18);
    const shown = Math.max(1, Math.round(FRAPPE_BOLT_SEGMENTS * reach));
    const top = frappe.y - FRAPPE_BOLT_HEIGHT_PX;
    const pointX = (s: number): number =>
      s === 0 || s === FRAPPE_BOLT_SEGMENTS
        ? frappe.x
        : frappe.x + (hash01(seed, s) - 0.5) * 2 * FRAPPE_BOLT_JITTER_PX;
    const pointY = (s: number): number => top + (FRAPPE_BOLT_HEIGHT_PX * s) / FRAPPE_BOLT_SEGMENTS;
    const trace = (): void => {
      g.moveTo(pointX(0), pointY(0));
      for (let s = 1; s <= shown; s++) {
        g.lineTo(pointX(s), pointY(s));
      }
    };
    trace();
    g.stroke({ color: frappe.tint, width: 10, alpha: 0.35 * fade, cap: 'round', join: 'round' });
    trace();
    g.stroke({ color: 0xffffff, width: 3, alpha: 0.95 * fade, cap: 'round', join: 'round' });

    g.circle(frappe.x, frappe.y, frappe.radius * 0.5).fill({
      color: frappe.tint,
      alpha: 0.4 * fade,
    });
    for (let s = 0; s < FRAPPE_SPARKS; s++) {
      const a = hash01(s, seed) * Math.PI * 2;
      const d = frappe.radius * (0.4 + 0.8 * hash01(seed + 1, s)) * u;
      const r = 2.2 * fade;
      if (r > 0.3) {
        g.circle(frappe.x + Math.cos(a) * d, frappe.y + Math.sin(a) * d, r).fill({
          color: s % 3 === 0 ? 0xffffff : frappe.tint,
          alpha: 0.9 * fade,
        });
      }
    }
  }

  destroy(): void {
    this.#graphics.destroy();
  }
}
