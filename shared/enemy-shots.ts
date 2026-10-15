import {
  archetypeOf,
  SHOOTER_PERIOD_TICKS,
  SHOT_LIFETIME_S,
  SHOT_RADIUS,
  SHOT_SPEED,
} from './archetypes';
import type { Horde } from './horde';

/**
 * Les tirs des monstres `tir`. **Zero octet sur le fil** : un tireur arrete
 * (`stopped`, decide par `retarget` a la meme cadence des deux cotes) tire au
 * tick ou `(tick + phase) % SHOOTER_PERIOD_TICKS === 0`, vers la position
 * RETARDEE de son joueur cible (`Horde.aimX`/`aimY`, posees par `retarget`). Serveur et
 * client derivent donc les memes tirs ; seul le serveur blesse.
 *
 * ⚠️ **Le client n'avance les tirs qu'au tick PRESENT, jamais pendant un
 * rejeu** (`HordeHistory`) : chaque tick ne passe qu'une fois ici, donc pas
 * d'historique a garder. Un tir parti d'un monstre que le rejeu fait mourir
 * plus tot reste a l'ecran — derive visuelle seulement, le serveur tranche.
 *
 * ponytail: un objet par tir (quelques dizaines au pire) ; tableaux types si
 * le profil le demande un jour.
 */
export interface EnemyShot {
  x: number;
  y: number;
  ux: number;
  uy: number;
  /** Secondes de vol restantes (echelle de temps de la horde). */
  life: number;
  /** L'archetype du tireur : le rendu en tire son projectile (os, gland, harpon). */
  archetype: number;
}

export function shotPhase(entityId: number): number {
  return (entityId * 13) % SHOOTER_PERIOD_TICKS;
}

export class EnemyShots {
  shots: EnemyShot[] = [];

  /** Un tick : les tireurs a leur temps tirent, puis tout avance de `dt` (deja mis a l'echelle). */
  step(horde: Horde, tick: number, dt: number): void {
    for (let i = 0; i < horde.count; i++) {
      if (
        horde.stopped[i] !== 1 ||
        archetypeOf(horde.archetype[i] ?? 0).behavior !== 'tir' ||
        (tick + shotPhase(horde.entityIdAt(i))) % SHOOTER_PERIOD_TICKS !== 0
      ) {
        continue;
      }
      const cible = horde.targetField[i] ?? 0;
      const vx = (horde.aimX[cible] ?? 0) - (horde.x[i] ?? 0);
      const vy = (horde.aimY[cible] ?? 0) - (horde.y[i] ?? 0);
      const n = Math.hypot(vx, vy);
      if (n === 0) {
        continue;
      }
      this.shots.push({
        x: horde.x[i] ?? 0,
        y: horde.y[i] ?? 0,
        ux: vx / n,
        uy: vy / n,
        life: SHOT_LIFETIME_S,
        archetype: horde.archetype[i] ?? 0,
      });
    }
    for (const s of this.shots) {
      s.x += s.ux * SHOT_SPEED * dt;
      s.y += s.uy * SHOT_SPEED * dt;
      s.life -= dt;
    }
    this.shots = this.shots.filter((s) => s.life > 0);
  }

  /**
   * Retire les tirs qui touchent un joueur (`radius` = rayon du joueur) et rend,
   * par joueur, le nombre de tirs recus. Le serveur en tire des degats ; le
   * client s'en sert pour effacer le tir a l'impact.
   */
  hits(players: readonly { x: number; y: number }[], radius: number): number[] {
    const counts = players.map(() => 0);
    const r = radius + SHOT_RADIUS;
    this.shots = this.shots.filter((s) => {
      const p = players.findIndex((pl) => (pl.x - s.x) ** 2 + (pl.y - s.y) ** 2 <= r * r);
      if (p < 0) {
        return true;
      }
      counts[p] = (counts[p] ?? 0) + 1;
      return false;
    });
    return counts;
  }
}
