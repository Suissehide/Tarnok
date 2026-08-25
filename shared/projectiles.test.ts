import { describe, expect, it } from 'vitest';

import { PROJECTILE_HIT_RADIUS } from './constants';
import { Horde } from './horde';
import { Projectiles } from './projectiles';
import { FORMATION, type WaveOrder } from './waves';
import type { Weapon } from './weapons';

/**
 * Fait apparaitre une seule entite, avec un `waveId` choisi explicitement
 * pour controler son identifiant — meme technique que `targeting.test.ts`.
 */
function addOne(horde: Horde, waveId: number, x: number, y: number): number {
  const order: WaveOrder = {
    waveId,
    spawnTick: 0,
    seed: 1,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: x,
    anchorY: y,
    count: 1,
  };
  horde.spawn(order);
  const slot = horde.count - 1;
  horde.x[slot] = x;
  horde.y[slot] = y;
  return horde.entityIdAt(slot);
}

/** Une arme a projectile unique, tirant droit sur la cible. */
const SINGLE: Weapon = {
  id: 0,
  name: 'test-simple',
  cooldownTicks: 5,
  damage: 7,
  projectileSpeed: 100,
  projectileLifeTicks: 5,
  projectileCount: 1,
  spreadRadians: 0,
};

/** Une arme a plusieurs projectiles, pour verifier la symetrie de la dispersion. */
const SPREAD: Weapon = {
  id: 1,
  name: 'test-eventail',
  cooldownTicks: 10,
  damage: 3,
  projectileSpeed: 100,
  projectileLifeTicks: 10,
  projectileCount: 3,
  spreadRadians: Math.PI / 2,
};

describe('Projectiles.fireSalvo', () => {
  it('une salve produit projectileCount projectiles', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0);
    const projectiles = new Projectiles(50);

    projectiles.fireSalvo(SPREAD, 0, 0, 0, targetId, horde);

    expect(projectiles.count).toBe(SPREAD.projectileCount);
  });

  it('ne tire pas quand la cible n est plus dans la horde donnee', () => {
    const horde = new Horde(10);
    const projectiles = new Projectiles(50);

    // Identifiant qui ne correspond a aucune entite vivante.
    projectiles.fireSalvo(SINGLE, 0, 0, 0, 999_999, horde);

    expect(projectiles.count).toBe(0);
  });

  it('la dispersion est symetrique autour de la direction visee', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0); // cible plein est : angle de base 0
    const projectiles = new Projectiles(50);

    projectiles.fireSalvo(SPREAD, 0, 0, 0, targetId, horde);
    // Un pas suffit a rendre la direction de chaque projectile observable :
    // sa position s'eloigne de l'origine (0,0) dans sa propre direction.
    projectiles.step(1);

    const angles: number[] = [];
    for (let i = 0; i < projectiles.count; i++) {
      angles.push(Math.atan2(projectiles.y[i] ?? 0, projectiles.x[i] ?? 0));
    }
    angles.sort((a, b) => a - b);

    expect(angles.length).toBe(3);
    // Symetrique autour de 0 : le plus petit et le plus grand sont opposes,
    // et celui du milieu vise droit sur la cible.
    expect(angles[0]).toBeCloseTo(-(angles[2] ?? 0), 5);
    expect(angles[1]).toBeCloseTo(0, 5);
    expect(Math.abs(angles[0] ?? 0)).toBeCloseTo(SPREAD.spreadRadians / 2, 5);
  });
});

describe('Projectiles.step — duree de vie', () => {
  it('un projectile est encore vivant a life - 1 pas, et expire au pas life', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0);
    const projectiles = new Projectiles(50);
    projectiles.fireSalvo(SINGLE, 0, 0, 0, targetId, horde);

    for (let i = 0; i < SINGLE.projectileLifeTicks - 1; i++) {
      projectiles.step(1 / 30);
    }
    expect(projectiles.count).toBe(1);

    projectiles.step(1 / 30);
    expect(projectiles.count).toBe(0);
  });
});

describe('Projectiles.collide', () => {
  it('detecte un ennemi sur la trajectoire du projectile', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0);
    const projectiles = new Projectiles(50);
    projectiles.fireSalvo(SINGLE, 0, 0, 0, targetId, horde);

    // Le projectile part de (0,0) vers (100,0) a 100 px/s. Un pas d'une
    // seconde l'amene en (100,0), pile sur la cible — qui n'a pas bouge.
    projectiles.step(1);

    const hits: { entityId: number; damage: number }[] = [];
    projectiles.collide(horde, (entityId, damage) => hits.push({ entityId, damage }));

    expect(hits).toEqual([{ entityId: targetId, damage: SINGLE.damage }]);
    expect(projectiles.count).toBe(0); // le projectile est consomme par le coup
  });

  it('ne declenche rien pour un ennemi qui passe pres de la trajectoire sans la toucher', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 1000, 0);
    const projectiles = new Projectiles(50);
    projectiles.fireSalvo(SINGLE, 0, 0, 0, targetId, horde);
    projectiles.step(1); // le projectile est en (100, 0)

    // Un second ennemi, hors du rayon de collision mais pas loin, place APRES
    // le tir pour ne pas influencer le ciblage.
    addOne(horde, 2, 100, PROJECTILE_HIT_RADIUS + 10);

    const hits: { entityId: number; damage: number }[] = [];
    projectiles.collide(horde, (entityId, damage) => hits.push({ entityId, damage }));

    expect(hits).toEqual([]);
    expect(projectiles.count).toBe(1); // ni touche, ni consomme
  });
});

describe('Projectiles — derivation', () => {
  it('tire aux memes ticks des deux cotes, sans qu aucun evenement ne transite', () => {
    // Deux instances INDEPENDANTES (aucun tableau partage), memes armes, meme
    // tick de depart, memes positions : elles doivent produire exactement les
    // memes salves. C'est ce qui permet de ne rien envoyer sur le fil (§5.2).
    function buildSide(): { horde: Horde; projectiles: Projectiles; targetId: number } {
      const horde = new Horde(20);
      const targetId = addOne(horde, 1, 2000, 300);
      return { horde, projectiles: new Projectiles(200), targetId };
    }

    const a = buildSide();
    const b = buildSide();
    const dt = 1 / 30;
    // 33 : ni multiple de SINGLE.cooldownTicks (5) ni de SPREAD.cooldownTicks
    // (10) — les deux dernieres salves sont donc encore vivantes a la fin de
    // la boucle, et la comparaison finale porte reellement sur des
    // projectiles actifs plutot que sur deux tableaux vides.
    const TICKS = 33;

    for (let tick = 0; tick < TICKS; tick++) {
      // Un tireur qui se deplace, pour exercer une position variable.
      const shooterX = tick * 5;
      const shooterY = Math.sin(tick * 0.3) * 20;

      // Deux armes independantes, chacune sur sa propre cadence — choisies
      // deterministement par le tick, donc par construction identiques des
      // deux cotes.
      if (tick % SINGLE.cooldownTicks === 0) {
        a.projectiles.fireSalvo(SINGLE, tick, shooterX, shooterY, a.targetId, a.horde);
        b.projectiles.fireSalvo(SINGLE, tick, shooterX, shooterY, b.targetId, b.horde);
      }
      if (tick % SPREAD.cooldownTicks === 0) {
        a.projectiles.fireSalvo(SPREAD, tick, shooterX, shooterY, a.targetId, a.horde);
        b.projectiles.fireSalvo(SPREAD, tick, shooterX, shooterY, b.targetId, b.horde);
      }

      a.projectiles.step(dt);
      b.projectiles.step(dt);
    }

    // Le scenario n'a de valeur que si les deux cotes portent vraiment des
    // projectiles a comparer — sinon la boucle ci-dessous ne verifie rien.
    expect(a.projectiles.count).toBeGreaterThan(0);
    expect(b.projectiles.count).toBe(a.projectiles.count);
    for (let i = 0; i < a.projectiles.count; i++) {
      expect(b.projectiles.x[i]).toBeCloseTo(a.projectiles.x[i] ?? 0, 6);
      expect(b.projectiles.y[i]).toBeCloseTo(a.projectiles.y[i] ?? 0, 6);
    }
  });
});
