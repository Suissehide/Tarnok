import { describe, expect, it } from 'vitest';

import { PROJECTILE_HIT_RADIUS, TICK_HZ } from './constants';
import { WEAPONS, weaponOf } from './weapons';

describe('WEAPONS', () => {
  it('indexe chaque arme a sa position dans le tableau', () => {
    WEAPONS.forEach((w, i) => {
      expect(w.id).toBe(i);
    });
  });

  it('compte exactement trois armes', () => {
    expect(WEAPONS.length).toBe(3);
  });

  it('donne des valeurs strictement positives a chaque arme', () => {
    for (const w of WEAPONS) {
      expect(w.cooldownTicks).toBeGreaterThan(0);
      expect(w.damage).toBeGreaterThan(0);
      expect(w.projectileSpeed).toBeGreaterThan(0);
      expect(w.projectileLifeTicks).toBeGreaterThan(0);
      expect(w.projectileCount).toBeGreaterThan(0);
      expect(w.spreadRadians).toBeGreaterThan(0);
    }
  });

  it('place l arme neutre de base en premiere position', () => {
    expect(WEAPONS[0]?.name).toBe('dague');
  });

  it('cable au moins une arme a plusieurs projectiles, pour prouver que la forme tient', () => {
    expect(WEAPONS.some((w) => w.projectileCount > 1)).toBe(true);
  });

  it('reste sous le rayon anti-tunnel : aucun projectile ne peut sauter par-dessus une cible en un tick', () => {
    // Si `projectileSpeed / TICK_HZ` depasse `PROJECTILE_HIT_RADIUS`, le
    // projectile peut parcourir en un seul pas une distance superieure au
    // rayon de collision : il traverse sa cible sans jamais la toucher
    // (« tunneling »). Rien ne le signalerait a l'execution — le projectile
    // continue sa route, l'ennemi reste vivant, aucune exception. Ce test
    // transforme cette contrainte de prose (voir le commentaire de
    // `PROJECTILE_HIT_RADIUS` dans `shared/constants.ts`) en echec de suite
    // le jour ou une arme plus rapide est ajoutee.
    for (const w of WEAPONS) {
      expect(w.projectileSpeed / TICK_HZ).toBeLessThanOrEqual(PROJECTILE_HIT_RADIUS);
    }
  });
});

describe('weaponOf', () => {
  it('rend l arme portant cet identifiant', () => {
    expect(weaponOf(0)?.name).toBe(WEAPONS[0]?.name);
  });

  it('leve sur un identifiant inconnu plutot que de rendre undefined', () => {
    expect(() => weaponOf(99)).toThrow(/inconnu/i);
  });
});
