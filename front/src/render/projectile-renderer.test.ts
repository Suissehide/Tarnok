import { MAP_SIZE, REACTION_RADIUS } from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import { packElementPair } from '@shared/protocol';
import { describe, expect, it } from 'vitest';

import {
  FLASH_MAX_SCALE,
  IMPACT_TEXTURE_DIAMETER,
  ImpactFlashRenderer,
  OrbRenderer,
  ProjectileRenderer,
  REACTION_TEXTURE_DIAMETER,
  ReactionFlashRenderer,
  reactionFlashScale,
  reactionTint,
} from './projectile-renderer';

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

/**
 * Étape 5a, §9 : *« la reaction : flash court, large, genereux — c'est la que
 * passe le budget VFX »*, et la regle qui va avec : **l'etat persistant est
 * discret, la reaction est spectaculaire**.
 *
 * Cette regle n'est pas une intention, c'est une comparaison : le flash de
 * reaction doit etre visiblement plus grand que celui d'un impact ordinaire,
 * sans quoi les deux se confondent et le budget de particules repart en bruit
 * de fond. Elle se teste, et c'est ce que fait le premier cas ci-dessous.
 */
describe('reactionFlashScale — la taille du flash de reaction', () => {
  it('couvre EXACTEMENT 2 x REACTION_RADIUS a la fin de sa vie : ni plus, ni moins', () => {
    // La doc de `REACTION_RADIUS` (shared/constants.ts) l'exige mot pour mot :
    // « un rayon plus petit que le flash ferait mourir des ennemis hors du
    // dessin ; un rayon plus grand tuerait hors champ ».
    expect(
      reactionFlashScale(1, REACTION_TEXTURE_DIAMETER) * REACTION_TEXTURE_DIAMETER,
    ).toBeCloseTo(2 * REACTION_RADIUS, 6);
  });

  it('grandit en s eteignant : plus petit a la naissance qu a la fin', () => {
    expect(reactionFlashScale(0, REACTION_TEXTURE_DIAMETER)).toBeLessThan(
      reactionFlashScale(1, REACTION_TEXTURE_DIAMETER),
    );
  });

  it(
    'est SPECTACULAIRE devant le flash d impact : plus large a son maximum que celui-ci au sien ' +
      '(§6.6 — sinon les deux se confondent)',
    () => {
      const reaction = reactionFlashScale(1, REACTION_TEXTURE_DIAMETER) * REACTION_TEXTURE_DIAMETER;
      // Le flash d'impact est dessine sur une texture de 48 px (voir
      // `ImpactFlashRenderer.load`) et grandit jusqu'a `FLASH_MAX_SCALE`.
      const impact = IMPACT_TEXTURE_DIAMETER * FLASH_MAX_SCALE;
      expect(reaction).toBeGreaterThan(impact);
    },
  );

  it('ne divise pas par zero sur une texture degeneree', () => {
    expect(reactionFlashScale(1, 0)).toBe(1);
  });
});

/**
 * ⚠️ **Les deux moities, toujours** (R24/R25) : une fonction qui rendrait
 * toujours `0xffffff` passerait le cas « charge », et une qui rendrait
 * toujours la moyenne passerait le cas « solo ». Il faut les deux, et il faut
 * qu'ils DIFFERENT.
 */
describe('reactionTint — ce que la teinte du flash encode', () => {
  const CHOC_THERMIQUE = packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE);

  it('rend l identite 0xffffff quand la reaction a charge la Synergie (deux joueurs)', () => {
    // `0xffffff` est l'identite du produit que fait `tint` : la reaction
    // inter-joueurs est donc, litteralement, la plus lumineuse que ce
    // renderer puisse dessiner (§6.5 — « le coeur du projet »).
    expect(reactionTint(CHOC_THERMIQUE, true)).toBe(0xffffff);
  });

  it('rend une teinte DIFFERENTE, tiree des deux elements, pour une reaction solo', () => {
    const solo = reactionTint(CHOC_THERMIQUE, false);

    expect(solo).not.toBe(0xffffff);
    // Entre les deux teintes d'element, canal par canal : ni l'une ni l'autre.
    expect(solo).not.toBe(elementOf(ELEMENT.BRAISE).tint);
    expect(solo).not.toBe(elementOf(ELEMENT.GIVRE).tint);
  });

  it('est insensible a l ordre des elements du couple, comme packElementPair', () => {
    // `packElementPair` est canonique (voir sa doc) : un choc declenche par du
    // Givre sur une marque de Braise et l'inverse sont la MEME reaction, et
    // deux clients ne doivent pas en dessiner deux flashs differents.
    expect(reactionTint(packElementPair(ELEMENT.GIVRE, ELEMENT.BRAISE), false)).toBe(
      reactionTint(CHOC_THERMIQUE, false),
    );
  });

  it('rend l identite pour un couple neutre — aucune table par couple a maintenir', () => {
    expect(reactionTint(packElementPair(ELEMENT.NEUTRE, ELEMENT.NEUTRE), false)).toBe(0xffffff);
  });
});

describe('ReactionFlashRenderer — ce que le §6.6 exige du conteneur', () => {
  it('fusionne en ADDITIF, comme les zones', () => {
    expect(new ReactionFlashRenderer().blendMode).toBe('add');
  });

  it('pose des bornes explicites couvrant la carte entiere, marge comprise', () => {
    expect(new ReactionFlashRenderer().boundsArea).toMatchObject({
      x: -256,
      y: -256,
      width: MAP_SIZE + 512,
      height: MAP_SIZE + 512,
    });
  });
});
