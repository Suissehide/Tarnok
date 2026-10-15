import { PING_INTENTS, PING_LIFE_TICKS } from '@shared/ping';
import { type Container, Graphics } from 'pixi.js';

import type { ActivePing } from '../net/client';

/** Un ping a dessiner a cette image. */
export interface LivePing {
  playerId: number;
  intent: number;
  x: number;
  y: number;
  /** Opacite, `1` puis s'efface sur le dernier quart de sa vie. */
  alpha: number;
  /** Rayon de l'onde, en pixels monde. */
  wave: number;
}

const WAVE_MIN = 18;
const WAVE_MAX = 90;

/**
 * Les pings vivants au tick de horde `tick`. Le tick, jamais l'horloge murale :
 * pendant le gel de l'etalage il n'avance pas, et un ping recu juste avant ne
 * doit pas s'eteindre pendant que personne ne peut le lire.
 */
export function livePings(pings: ReadonlyMap<number, ActivePing>, tick: number): LivePing[] {
  const out: LivePing[] = [];
  for (const p of pings.values()) {
    const age = tick - p.tick;
    if (age < 0 || age >= PING_LIFE_TICKS) {
      continue;
    }
    const t = age / PING_LIFE_TICKS;
    const restant = 1 - t;
    out.push({
      playerId: p.playerId,
      intent: p.intent,
      x: p.x,
      y: p.y,
      alpha: restant > 0.25 ? 1 : restant / 0.25,
      wave: WAVE_MIN + ((age % 30) / 30) * (WAVE_MAX - WAVE_MIN),
    });
  }
  return out;
}

export interface EdgeArrow {
  x: number;
  y: number;
  /** Direction centre -> cible, en radians (`atan2`, y vers le bas). */
  angle: number;
}

/**
 * Ou poser la fleche d'une cible hors champ, en coordonnees ECRAN. `null` si la
 * cible est dans le rectangle de la vue reduit de `margin` : elle se voit deja.
 * Sinon, le point ou le segment centre -> cible sort de ce rectangle.
 */
export function edgeArrow(
  w: number,
  h: number,
  tx: number,
  ty: number,
  margin: number,
): EdgeArrow | null {
  const cx = w / 2;
  const cy = h / 2;
  const hw = cx - margin;
  const hh = cy - margin;
  const dx = tx - cx;
  const dy = ty - cy;
  if (Math.abs(dx) <= hw && Math.abs(dy) <= hh) {
    return null;
  }
  const k = Math.min(
    dx === 0 ? Infinity : hw / Math.abs(dx),
    dy === 0 ? Infinity : hh / Math.abs(dy),
  );
  return { x: cx + dx * k, y: cy + dy * k, angle: Math.atan2(dy, dx) };
}

/** Taille d'une fleche d'allie : `1` pres, `0.5` au-dela de 4000 px monde. */
export function allyArrowScale(distance: number): number {
  return Math.max(0.5, 1 - distance / 8000);
}

const MARGIN = 28;
const DANGER = PING_INTENTS.indexOf('danger');
const BOSS = PING_INTENTS.indexOf('boss');
const JE_PRENDS = PING_INTENTS.indexOf('jePrends');

/** L'icone d'une intention, centree sur (x, y). Une forme par intention, lisible sans texte. */
function intentIcon(
  g: Graphics,
  intent: number,
  x: number,
  y: number,
  r: number,
  color: number,
  alpha: number,
): void {
  if (intent === DANGER) {
    g.poly([x, y - r, x + r, y + r * 0.8, x - r, y + r * 0.8]).fill({ color: 0xff4a3a, alpha });
    g.poly([x, y - r, x + r, y + r * 0.8, x - r, y + r * 0.8]).stroke({ color, width: 2, alpha });
  } else if (intent === BOSS) {
    g.poly([x, y - r, x + r, y, x, y + r, x - r, y]).fill({ color, alpha });
  } else if (intent === JE_PRENDS) {
    g.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6).fill({ color, alpha });
  } else {
    g.circle(x, y, r).fill({ color, alpha });
  }
}

/**
 * Le calque des pings (etape 9) : un `Graphics` dans le MONDE pour les
 * marqueurs, un autre en coordonnees ECRAN pour les fleches de bord.
 */
export class PingRenderer {
  readonly #world = new Graphics();
  readonly #screen = new Graphics();
  #ready = false;

  constructor(private readonly colorOf: (playerId: number) => number) {}

  attach(parent: Container): void {
    parent.addChild(this.#world);
  }

  /** Le calque ecran se pose sur `app.stage`, au-dessus du monde (voir `Stage.init`). */
  attachScreen(parent: Container): void {
    parent.addChild(this.#screen);
  }

  get loaded(): boolean {
    return this.#ready;
  }

  load(): void {
    this.#ready = true;
  }

  draw(
    pings: readonly LivePing[],
    allies: readonly { id: number; x: number; y: number; distance: number }[],
    toScreen: (x: number, y: number) => { x: number; y: number },
    w: number,
    h: number,
  ): void {
    const g = this.#world;
    const s = this.#screen;
    g.clear();
    s.clear();
    for (const p of pings) {
      const color = this.colorOf(p.playerId);
      g.circle(p.x, p.y, p.wave).stroke({ color, width: 3, alpha: p.alpha * (1 - p.wave / 120) });
      intentIcon(g, p.intent, p.x, p.y - 34, 12, color, p.alpha);
      g.moveTo(p.x, p.y - 22)
        .lineTo(p.x, p.y)
        .stroke({ color, width: 2, alpha: p.alpha });
      const sp = toScreen(p.x, p.y);
      const a = edgeArrow(w, h, sp.x, sp.y, MARGIN);
      if (a) {
        drawArrow(s, a, 1.2, color, p.alpha);
        intentIcon(
          s,
          p.intent,
          a.x - Math.cos(a.angle) * 26,
          a.y - Math.sin(a.angle) * 26,
          9,
          color,
          p.alpha,
        );
      }
    }
    for (const ally of allies) {
      const sp = toScreen(ally.x, ally.y);
      const a = edgeArrow(w, h, sp.x, sp.y, MARGIN);
      if (a) {
        drawArrow(s, a, allyArrowScale(ally.distance), this.colorOf(ally.id), 0.85);
      }
    }
  }
}

function drawArrow(g: Graphics, a: EdgeArrow, scale: number, color: number, alpha: number): void {
  const L = 16 * scale;
  const c = Math.cos(a.angle);
  const s = Math.sin(a.angle);
  // Un triangle dont la pointe est sur le bord, vers la cible.
  g.poly([
    a.x,
    a.y,
    a.x - L * c + L * 0.6 * s,
    a.y - L * s - L * 0.6 * c,
    a.x - L * c - L * 0.6 * s,
    a.y - L * s + L * 0.6 * c,
  ]).fill({ color, alpha });
}
