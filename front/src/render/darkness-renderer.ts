import { EVENT_KIND, lightRadius } from '@shared/evenements';
import { type Container, Graphics, type Rectangle } from 'pixi.js';

import type { EventView } from '../net/client';

/**
 * Le noir (etape 16, §9.4) : un voile sombre sur le monde, troue d'un cercle
 * de lumiere autour du porteur de lanterne. UN `Graphics`, en coordonnees
 * MONDE (le cercle subit l'ecrasement vertical comme toute forme au sol) :
 * ni filtre, ni masque, ni `RenderTexture` — `cut()` est le trou de Pixi 8.
 * Une douzaine de primitives par image, le cout du chariot.
 *
 * ⚠️ **Pas un brouillard de guerre** : la horde reste dans la memoire du
 * client. Cooperatif, sans enjeu : assume (spec §12).
 */

export const NOIR_DARK_ALPHA = 0.9;
/** Le bord doux : quatre anneaux sur 80 px. A 0, un seul trou net (le repli de la spec §12). */
export const NOIR_FEATHER_PX = 80;
/** Le voile monte de 0 a `NOIR_DARK_ALPHA` en 800 ms depuis la reception d'`EVENT_START`. */
export const NOIR_FADE_MS = 800;
const NOIR_COLOR = 0x05040a;
/** Le voile deborde le cadre : la secousse de camera ne doit jamais en montrer le bord. */
const MARGE = 200;

/**
 * Le trou de lumiere, PUR : le porteur de lanterne DESSINE (predit si c'est
 * soi) et le rayon solo ou non. `null` : pas d'obscurite (hors noir, ou
 * porteur pas encore connu). `radius: 0` : tout noir (porteur introuvable ou
 * mort, jusqu'a l'`EVENT_END` du meme envoi).
 */
export function darknessHole(
  event: EventView | null,
  players: readonly { id: number; x: number; y: number; hp: number }[],
): { x: number; y: number; radius: number } | null {
  if (event === null || event.kind !== EVENT_KIND.NOIR || event.carrierId === 0) {
    return null;
  }
  const p = players.find((j) => j.id === event.carrierId);
  if (!p || p.hp <= 0) {
    return { x: 0, y: 0, radius: 0 };
  }
  return { x: p.x, y: p.y, radius: lightRadius(event.solo) };
}

/** L'opacite du voile a `nowMs`, en fondu depuis `startedAtMs`. */
export function darknessAlpha(startedAtMs: number, nowMs: number): number {
  return NOIR_DARK_ALPHA * Math.min(1, Math.max(0, (nowMs - startedAtMs) / NOIR_FADE_MS));
}

export class DarknessRenderer {
  readonly #g = new Graphics();
  #ready = false;

  attach(parent: Container): void {
    parent.addChild(this.#g);
  }

  get loaded(): boolean {
    return this.#ready;
  }

  load(): void {
    this.#ready = true;
  }

  draw(
    event: EventView | null,
    players: readonly { id: number; x: number; y: number; hp: number }[],
    view: Rectangle,
    nowMs: number,
  ): void {
    const g = this.#g;
    g.clear();
    const trou = darknessHole(event, players);
    if (trou === null || event === null) {
      return;
    }
    const a = darknessAlpha(event.startedAtMs, nowMs);
    if (a <= 0) {
      return;
    }
    g.rect(view.x - MARGE, view.y - MARGE, view.width + 2 * MARGE, view.height + 2 * MARGE).fill({
      color: NOIR_COLOR,
      alpha: a,
    });
    if (trou.radius <= 0) {
      return;
    }
    const { x, y, radius: r } = trou;
    g.circle(x, y, r + NOIR_FEATHER_PX).cut();
    // Quatre anneaux, de plus en plus sombres vers le DEHORS : un bord doux
    // (ecart au §9.4 de la spec, dont la boucle assombrissait le dedans).
    for (let k = 0; k < 4; k++) {
      g.circle(x, y, r + ((k + 1) * NOIR_FEATHER_PX) / 4).fill({
        color: NOIR_COLOR,
        alpha: (a * (k + 1)) / 5,
      });
      g.circle(x, y, r + (k * NOIR_FEATHER_PX) / 4).cut();
    }
  }
}
