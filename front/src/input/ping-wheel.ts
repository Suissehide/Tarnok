import { PING_INTENTS } from '@shared/ping';

/** Rayon, en pixels ecran, sous lequel un relachement compte comme un clic bref. */
export const PING_DEADZONE_PX = 24;

const VIENS = PING_INTENTS.indexOf('viens');
const DANGER = PING_INTENTS.indexOf('danger');
const BOSS = PING_INTENTS.indexOf('boss');
const JE_PRENDS = PING_INTENTS.indexOf('jePrends');

/**
 * Le secteur vise par le vecteur centre -> curseur, en coordonnees ECRAN (y vers
 * le bas). Quatre secteurs de 90 degres ; une diagonale exacte tombe sur l'axe
 * vertical. Dans la zone morte : un clic bref, donc « viens » (§2 de la spec).
 */
export function pingSectorAt(dx: number, dy: number): number {
  if (Math.hypot(dx, dy) < PING_DEADZONE_PX) {
    return VIENS;
  }
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? JE_PRENDS : BOSS;
  }
  return dy < 0 ? DANGER : VIENS;
}

export interface PingWheelOptions {
  element: HTMLElement;
  canOpen: () => boolean;
  toWorld: (sx: number, sy: number) => { x: number; y: number };
  onPing: (intent: number, x: number, y: number) => void;
  events?: EventTarget;
}

/**
 * La roue de ping : clic droit maintenu, glisser, relacher (§2 de la spec de
 * l'etape 9). Le ping part a la position MONDE de l'ouverture — on vise d'abord,
 * on choisit ensuite. Toute fermeture autre qu'un relachement n'envoie rien.
 */
export class PingWheel {
  readonly #opts: PingWheelOptions;
  #center: { sx: number; sy: number; x: number; y: number } | null = null;

  constructor(opts: PingWheelOptions) {
    this.#opts = opts;
    const events = opts.events ?? window;
    events.addEventListener('pointerdown', (e) => this.#down(e as MouseEvent));
    events.addEventListener('pointerup', (e) => this.#up(e as MouseEvent));
    events.addEventListener('blur', () => this.#close());
  }

  get isOpen(): boolean {
    return this.#center !== null;
  }

  update(): void {
    if (this.#center && !this.#opts.canOpen()) {
      this.#close();
    }
  }

  #down(e: MouseEvent): void {
    if (e.button !== 2 || !this.#opts.canOpen()) {
      return;
    }
    const world = this.#opts.toWorld(e.clientX, e.clientY);
    this.#center = { sx: e.clientX, sy: e.clientY, x: world.x, y: world.y };
    const el = this.#opts.element;
    el.style.left = `${e.clientX}px`;
    el.style.top = `${e.clientY}px`;
    el.classList.remove('hidden');
  }

  #up(e: MouseEvent): void {
    const c = this.#center;
    if (e.button !== 2 || !c) {
      return;
    }
    this.#close();
    this.#opts.onPing(pingSectorAt(e.clientX - c.sx, e.clientY - c.sy), c.x, c.y);
  }

  #close(): void {
    this.#center = null;
    this.#opts.element.classList.add('hidden');
  }
}
