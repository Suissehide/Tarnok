import { archetypeOf, KAMIKAZE_RADIUS, SHAMAN_AURA_RADIUS } from '@shared/archetypes';
import type { Horde } from '@shared/horde';
import { type Container, Graphics, type Rectangle } from 'pixi.js';

import { BLAST_FLASH_MS, type BlastFlash } from '../net/client';

/**
 * Ce que les comportements montrent au sol (retour de playtest : *« des
 * monstres uniques »*) : le cercle d'alerte d'un kamikaze — exactement le
 * rayon de son explosion —, l'aura d'un chaman, et les explosions elles-memes.
 * Tout est DERIVE de la horde et des morts deja recues : aucun octet de plus.
 */

export interface BehaviorShape {
  kind: 'kamikaze' | 'chaman' | 'explosion';
  x: number;
  y: number;
  radius: number;
  /** De 0 a 1 : l'opacite (l'explosion s'eteint). */
  alpha: number;
}

/**
 * Les formes a dessiner, dans le cadre `view` (et sa marge). PURE : la horde,
 * les explosions, l'horloge — c'est elle que les tests lisent.
 */
export function behaviorShapes(
  horde: Horde,
  blasts: readonly BlastFlash[],
  view: Rectangle,
  nowMs: number,
): BehaviorShape[] {
  const out: BehaviorShape[] = [];
  const marge = SHAMAN_AURA_RADIUS;
  for (let i = 0; i < horde.count; i++) {
    const behavior = archetypeOf(horde.archetype[i] ?? 0).behavior;
    if (behavior !== 'kamikaze' && behavior !== 'chaman') {
      continue;
    }
    const x = horde.x[i] ?? 0;
    const y = horde.y[i] ?? 0;
    if (
      x < view.x - marge ||
      x > view.x + view.width + marge ||
      y < view.y - marge ||
      y > view.y + view.height + marge
    ) {
      continue;
    }
    out.push(
      behavior === 'kamikaze'
        ? { kind: 'kamikaze', x, y, radius: KAMIKAZE_RADIUS, alpha: 1 }
        : { kind: 'chaman', x, y, radius: SHAMAN_AURA_RADIUS, alpha: 1 },
    );
  }
  for (const b of blasts) {
    const t = (nowMs - b.bornMs) / BLAST_FLASH_MS;
    if (t < 0 || t >= 1) {
      continue;
    }
    out.push({
      kind: 'explosion',
      x: b.x,
      y: b.y,
      radius: KAMIKAZE_RADIUS * (0.5 + 0.6 * t),
      alpha: 1 - t,
    });
  }
  return out;
}

export class BehaviorRenderer {
  readonly #graphics = new Graphics();
  #ready = false;

  attach(parent: Container): void {
    parent.addChild(this.#graphics);
  }

  get loaded(): boolean {
    return this.#ready;
  }

  load(): void {
    this.#ready = true;
  }

  draw(horde: Horde, blasts: readonly BlastFlash[], view: Rectangle, nowMs: number): void {
    const g = this.#graphics;
    g.clear();
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 140);
    for (const s of behaviorShapes(horde, blasts, view, nowMs)) {
      if (s.kind === 'kamikaze') {
        // Le rayon EXACT de l'explosion, rouge et qui bat : on sait ou ne pas etre.
        g.circle(s.x, s.y, s.radius).fill({ color: 0xff3b2f, alpha: 0.07 + 0.05 * pulse });
        g.circle(s.x, s.y, s.radius).stroke({
          color: 0xff3b2f,
          width: 3,
          alpha: 0.5 + 0.4 * pulse,
        });
      } else if (s.kind === 'chaman') {
        // L'aura : un voile violet calme, qui dit « tuez-moi d'abord ».
        g.circle(s.x, s.y, s.radius).fill({ color: 0xa66bff, alpha: 0.08 });
        g.circle(s.x, s.y, s.radius).stroke({ color: 0xc9a2ff, width: 2, alpha: 0.45 });
      } else {
        g.circle(s.x, s.y, s.radius).fill({ color: 0xffa21f, alpha: 0.55 * s.alpha });
        g.circle(s.x, s.y, s.radius).stroke({ color: 0xfff0b0, width: 5, alpha: s.alpha });
      }
    }
  }
}
