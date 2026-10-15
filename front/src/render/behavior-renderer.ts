import {
  archetypeOf,
  KAMIKAZE_RADIUS,
  NECRO_RADIUS,
  SHAMAN_AURA_RADIUS,
  SHOT_RADIUS,
} from '@shared/archetypes';
import type { EnemyShot } from '@shared/enemy-shots';
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
  kind: 'kamikaze' | 'chaman' | 'necro' | 'bouclier' | 'butin' | 'explosion';
  x: number;
  y: number;
  radius: number;
  /** De 0 a 1 : l'opacite (l'explosion s'eteint). */
  alpha: number;
  /** Le bouclier : son cap, en radians. */
  angle?: number;
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
    const enFuite = behavior === 'voleur' && horde.fleeing[i] === 1;
    if (
      behavior !== 'kamikaze' &&
      behavior !== 'chaman' &&
      behavior !== 'necro' &&
      behavior !== 'bouclier' &&
      !enFuite
    ) {
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
    if (behavior === 'kamikaze') {
      out.push({ kind: 'kamikaze', x, y, radius: KAMIKAZE_RADIUS, alpha: 1 });
    } else if (behavior === 'chaman') {
      out.push({ kind: 'chaman', x, y, radius: SHAMAN_AURA_RADIUS, alpha: 1 });
    } else if (behavior === 'necro') {
      out.push({ kind: 'necro', x, y, radius: NECRO_RADIUS, alpha: 1 });
    } else if (behavior === 'bouclier') {
      const angle = Math.atan2(horde.vy[i] ?? 0, horde.vx[i] ?? 0);
      out.push({ kind: 'bouclier', x, y, radius: 30, alpha: 1, angle });
    } else {
      out.push({ kind: 'butin', x, y: y - 42, radius: 7, alpha: 1 });
    }
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

  draw(
    horde: Horde,
    blasts: readonly BlastFlash[],
    shots: readonly EnemyShot[],
    view: Rectangle,
    nowMs: number,
  ): void {
    const g = this.#graphics;
    g.clear();
    // Les tirs ennemis : une bille rouge cerclee de noir, lisible sur l'herbe.
    for (const t of shots) {
      g.circle(t.x, t.y, SHOT_RADIUS).fill(0xff4a3d).stroke({ color: 0x1a0f0a, width: 2 });
    }
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
      } else if (s.kind === 'necro') {
        // Le rayon ou les morts se relevent : vert d'outre-tombe.
        g.circle(s.x, s.y, s.radius).fill({ color: 0x5bd16a, alpha: 0.06 });
        g.circle(s.x, s.y, s.radius).stroke({ color: 0x7cf08a, width: 2, alpha: 0.4 });
      } else if (s.kind === 'bouclier') {
        // L'arc du bouclier, devant lui : c'est le cote ou les tirs ricochent.
        const a = s.angle ?? 0;
        g.arc(s.x, s.y, s.radius, a - 0.9, a + 0.9).stroke({
          color: 0xd9e3f0,
          width: 5,
          alpha: 0.85,
        });
      } else if (s.kind === 'butin') {
        // Le voleur en fuite porte l'or vole : une piece au-dessus de la tete.
        g.circle(s.x, s.y, s.radius).fill(0xffd34d).stroke({ color: 0x1a0f0a, width: 2 });
      } else {
        g.circle(s.x, s.y, s.radius).fill({ color: 0xffa21f, alpha: 0.55 * s.alpha });
        g.circle(s.x, s.y, s.radius).stroke({ color: 0xfff0b0, width: 5, alpha: s.alpha });
      }
    }
  }
}
