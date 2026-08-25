import { MAP_SIZE } from '@shared/constants';
import { describe, expect, it } from 'vitest';

import { ImpactFlashRenderer, OrbRenderer, ProjectileRenderer } from './projectile-renderer';

/**
 * Verifie que les trois renderers posent des bornes explicites des la
 * construction — sans jamais appeler `load()`, qui a besoin d'un canevas 2D
 * (donc d'un navigateur) que l'environnement de test (`vitest`, `node`) n'a
 * pas. C'est precisement pour ca que `mapBoundsArea()` est appliquee dans le
 * CONSTRUCTEUR de chaque classe plutot que dans `load()` : un `ParticleContainer`
 * ne calcule jamais ses propres bornes (voir le spike de l'etape 2, rappele
 * dans `horde-renderer.ts`), et sans ce test rien ne l'aurait attrape si un
 * futur refactor deplacait l'affectation.
 */
describe('rendu des projectiles/orbes/flashs — bornes explicites du ParticleContainer', () => {
  const expected = {
    x: -256,
    y: -256,
    width: MAP_SIZE + 512,
    height: MAP_SIZE + 512,
  };

  it('ProjectileRenderer pose des bornes couvrant la carte entiere, marge comprise', () => {
    const renderer = new ProjectileRenderer();
    expect(renderer.boundsArea).toMatchObject(expected);
  });

  it('OrbRenderer pose des bornes couvrant la carte entiere, marge comprise', () => {
    const renderer = new OrbRenderer();
    expect(renderer.boundsArea).toMatchObject(expected);
  });

  it('ImpactFlashRenderer pose des bornes couvrant la carte entiere, marge comprise', () => {
    const renderer = new ImpactFlashRenderer();
    expect(renderer.boundsArea).toMatchObject(expected);
  });
});
