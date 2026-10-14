import {
  ABILITY_ZONE_RADIUS,
  type AbilityUsed,
  DECOY_LIFETIME_TICKS,
  REMPART_LIFETIME_TICKS,
  VERB_IDS,
} from '@shared/abilities';
import { TICK_HZ } from '@shared/constants';
import { type Container, Graphics } from 'pixi.js';

/**
 * Ce que les verbes laissent voir dans le monde (etape 8) : la zone d'un
 * Rempart, le leurre d'un Appat, l'eclair d'arrivee d'un Relais. L'Amorce n'a
 * rien ici — sa zone arrive par `ZONE` et se dessine avec les autres.
 *
 * ⚠️ **Lecture seule, derivee de l'annonce et du tick** : rien de ce calque
 * n'arbitre quoi que ce soit. La protection d'un Rempart ou l'attraction d'un
 * leurre sont decidees par le salon et le miroir ; on ne fait que montrer OU,
 * et COMBIEN DE TEMPS ENCORE.
 */
export type AbilityShapeKind = 'rempart' | 'leurre' | 'relais';

export interface AbilityShape {
  kind: AbilityShapeKind;
  x: number;
  y: number;
  /** Rayon dessine, en pixels monde. */
  radius: number;
  /** Opacite, dans [0, 1] : elle baisse a l'approche de la fin. */
  alpha: number;
}

/** Duree de l'eclair d'arrivee d'un Relais : un instant, pas un etat. */
export const RELAIS_FLASH_TICKS = Math.round(0.5 * TICK_HZ);

/** Rayon du marqueur de leurre : lisible sans masquer les monstres qu'il attire. */
const DECOY_RADIUS = 36;

/**
 * Les formes a dessiner au tick `tick`, pure. Une annonce dont l'effet est fini
 * ne rend rien. L'opacite tient pleine jusqu'aux derniers 25 % de vie, puis
 * descend — jamais a zero tant que l'effet agit, pour qu'on lise sa fin.
 */
export function abilityShapes(events: readonly AbilityUsed[], tick: number): AbilityShape[] {
  const out: AbilityShape[] = [];
  for (const e of events) {
    const age = tick - e.tick;
    if (age < 0) {
      continue;
    }
    if (e.verb === VERB_IDS.rempart && age < REMPART_LIFETIME_TICKS) {
      out.push({
        kind: 'rempart',
        x: e.x,
        y: e.y,
        radius: ABILITY_ZONE_RADIUS,
        alpha: fin(age, REMPART_LIFETIME_TICKS),
      });
    } else if (e.verb === VERB_IDS.appat && age < DECOY_LIFETIME_TICKS) {
      out.push({
        kind: 'leurre',
        x: e.x,
        y: e.y,
        radius: DECOY_RADIUS,
        alpha: fin(age, DECOY_LIFETIME_TICKS),
      });
    } else if (e.verb === VERB_IDS.relais && age < RELAIS_FLASH_TICKS) {
      const t = age / RELAIS_FLASH_TICKS;
      out.push({ kind: 'relais', x: e.x, y: e.y, radius: 30 + t * 110, alpha: 1 - t });
    }
  }
  return out;
}

function fin(age: number, life: number): number {
  const restant = 1 - age / life;
  return restant > 0.25 ? 1 : 0.35 + (restant / 0.25) * 0.65;
}

/**
 * Le calque : un seul `Graphics`, retrace a chaque image. Les verbes sont
 * rares (une recharge de plusieurs secondes par joueur) : quelques formes au
 * plus, rien qui justifie un `ParticleContainer`.
 */
export class AbilityRenderer {
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

  draw(events: readonly AbilityUsed[], tick: number, timeMs: number): void {
    const g = this.#graphics;
    g.clear();
    for (const s of abilityShapes(events, tick)) {
      if (s.kind === 'rempart') {
        // Un dome bleu : aplat leger, bord net, et un second anneau qui
        // respire pour dire « ca protege encore ».
        const souffle = 1 + 0.03 * Math.sin(timeMs / 180);
        g.circle(s.x, s.y, s.radius).fill({ color: 0x5ab4ff, alpha: 0.12 * s.alpha });
        g.circle(s.x, s.y, s.radius).stroke({ color: 0x8fd0ff, width: 4, alpha: 0.9 * s.alpha });
        g.circle(s.x, s.y, s.radius * 0.82 * souffle).stroke({
          color: 0x8fd0ff,
          width: 2,
          alpha: 0.5 * s.alpha,
        });
      } else if (s.kind === 'leurre') {
        // Une cible qui pulse : c'est vers elle que la horde marche.
        const pulse = 1 + 0.15 * Math.sin(timeMs / 120);
        g.circle(s.x, s.y, s.radius * pulse).stroke({
          color: 0xffb347,
          width: 3,
          alpha: s.alpha,
        });
        g.circle(s.x, s.y, s.radius * 0.45).fill({ color: 0xffb347, alpha: 0.8 * s.alpha });
        g.moveTo(s.x - s.radius * 1.3, s.y)
          .lineTo(s.x + s.radius * 1.3, s.y)
          .moveTo(s.x, s.y - s.radius * 1.3)
          .lineTo(s.x, s.y + s.radius * 1.3)
          .stroke({ color: 0xffb347, width: 2, alpha: 0.7 * s.alpha });
      } else {
        // L'arrivee d'un Relais : un anneau blanc qui s'ouvre et s'eteint.
        g.circle(s.x, s.y, s.radius).stroke({ color: 0xffffff, width: 5, alpha: s.alpha });
      }
    }
  }
}
