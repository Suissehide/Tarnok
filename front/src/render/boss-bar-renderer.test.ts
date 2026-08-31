import { archetypeOf, BOSS_ARCHETYPE } from '@shared/archetypes';
import { PROJECTILE_HIT_RADIUS } from '@shared/constants';
import { entityIdOf, Horde } from '@shared/horde';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { Container, type Particle, type ParticleContainer, Texture, TextureSource } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import type { BossVitals } from '../net/client';
import {
  BOSS_BAR_BORDER_PX,
  BOSS_BAR_HEIGHT_PX,
  BOSS_BAR_OFFSET_PX,
  BOSS_BAR_TEXTURE_SIZE,
  BOSS_BAR_WIDTH_PX,
  BOSS_BODY_SIZE_PX,
  BossBarRenderer,
  bossBarLayout,
  bossHpFraction,
} from './boss-bar-renderer';
import { BODY_SCALE } from './horde-renderer';

/**
 * La barre de vie du boss (etape 6a, tache 5).
 *
 * > *« Prevois une petite barre d'hp au dessus des boss. »*
 *
 * Trois choses a garder, et elles sont independantes : la FRACTION (ce que la
 * barre dit), le PLACEMENT (ou elle se pose, et quand elle ne se pose pas), et
 * le CABLAGE (ce que `draw` met vraiment sur les deux quads).
 */

const BOSS_ID = entityIdOf(7, 0);

/**
 * Une horde d'un seul boss, a une position RECONNAISSABLE et surtout dissymetrique :
 * `x` et `y` differents, pour qu'une confusion d'axe se voie.
 */
function hordeAvecBoss(x = 2100, y = 3300): Horde {
  const horde = new Horde(4);
  const order: WaveOrder = {
    waveId: 7,
    spawnTick: 0,
    seed: 1,
    archetype: BOSS_ARCHETYPE,
    formation: FORMATION.SCATTER,
    anchorX: x,
    anchorY: y,
    count: 1,
  };
  horde.spawn(order);
  // `formationPositions` disperse autour de l'ancre : on repose la position
  // exactement, pour que le test compare a un nombre qu'il connait.
  horde.x[0] = x;
  horde.y[0] = y;
  return horde;
}

describe('bossHpFraction — ce que la barre dit', () => {
  it('rend 1 a pleine vie et 0 a zero', () => {
    expect(bossHpFraction(6000, 6000)).toBe(1);
    expect(bossHpFraction(0, 6000)).toBe(0);
  });

  it('rend la proportion entre les deux', () => {
    expect(bossHpFraction(1500, 6000)).toBeCloseTo(0.25, 10);
    expect(bossHpFraction(4200, 6000)).toBeCloseTo(0.7, 10);
  });

  /**
   * ⚠️ **Le maximum nul n'est pas une politesse defensive** : un client qui se
   * connecte au tick ou le boss tombe a zero voit son PREMIER snapshot a 0 PV,
   * et `trackBoss` en fait alors un maximum nul faute de mieux. Sans la
   * branche, `0 / 0` rend `NaN` — un quad de largeur indefinie, pas une barre
   * vide. `toBe(0)` et non `toBeCloseTo` : `NaN` passe un `toBeCloseTo(0)`
   * dans certains moteurs d'assertion, pas une egalite stricte.
   */
  it('rend 0 plutot que NaN quand le maximum est nul', () => {
    expect(bossHpFraction(0, 0)).toBe(0);
    expect(bossHpFraction(10, 0)).toBe(0);
  });

  it('borne a 1 un boss qui depasserait le maximum connu de ce client', () => {
    expect(bossHpFraction(9000, 6000)).toBe(1);
  });

  it('borne a 0 des PV negatifs', () => {
    expect(bossHpFraction(-40, 6000)).toBe(0);
  });
});

/**
 * ⚠️ **Le decalage se DERIVE de la taille dessinee, jamais d'un nombre ecrit a
 * la main** (plan, tache 5, etape 2). Ces deux assertions sont les deux moities
 * de cette exigence, et aucune ne suffit :
 * - la premiere dit que la barre est bien AU-DESSUS du corps, pas dessus ;
 * - la seconde dit qu'elle suit la taille du BOSS et pas celle de la pietaille.
 *   Sans elle, un decalage derive de `PROJECTILE_HIT_RADIUS * BODY_SCALE`
 *   (la demi-hauteur d'un monstre ordinaire) passerait la premiere sans
 *   jamais degager la tete d'un corps trois fois plus grand.
 */
describe('BOSS_BAR_OFFSET_PX — derive de la taille DESSINEE du boss', () => {
  it('pose le bas de la barre au-dessus du haut du corps', () => {
    const basDeLaBarre = BOSS_BAR_OFFSET_PX - BOSS_BAR_HEIGHT_PX / 2 - BOSS_BAR_BORDER_PX;
    // `BODY_ANCHOR_Y` vaut 0,5 depuis l'etape 5a : le corps est CENTRE sur la
    // position, donc son bord haut est a une demi-taille dessinee au-dessus.
    expect(basDeLaBarre).toBeGreaterThanOrEqual(BOSS_BODY_SIZE_PX / 2);
  });

  it('suit la taille du BOSS, pas celle d une pietaille', () => {
    const demiCorpsDePietaille = PROJECTILE_HIT_RADIUS * BODY_SCALE;
    const facteur = archetypeOf(BOSS_ARCHETYPE).bodyScale;
    expect(facteur).toBeGreaterThan(1);
    expect(BOSS_BAR_OFFSET_PX).toBeGreaterThan(demiCorpsDePietaille * facteur);
  });
});

/**
 * ⚠️ **La forme de la barre n'etait gardee par RIEN, et une mutation l'a
 * montre** : `BOSS_BAR_WIDTH_PX = 80` (une longueur ecrite a la main) survivait
 * a toute la suite, parce que chaque assertion de `draw` compare une echelle a
 * cette meme constante — elle se recopiait des deux cotes. Ce bloc garde donc
 * la PROPRIETE, pas la valeur : la barre appartient a la creature.
 *
 * Les deux moities, encore : « assez large pour etre celle d'un boss » sans
 * « pas plus large que son corps » autoriserait un bandeau qui deborde de lui
 * et se lirait comme de l'interface ; l'inverse autoriserait une barre de la
 * taille d'une pietaille, invisible au-dessus d'un corps de 240 px.
 */
describe('la barre a la forme d une petite barre posee sur la creature', () => {
  it('ne deborde pas du corps auquel elle appartient', () => {
    expect(BOSS_BAR_WIDTH_PX).toBeLessThanOrEqual(BOSS_BODY_SIZE_PX);
  });

  it('est plus large que le corps d une pietaille — c est la barre d un BOSS', () => {
    const corpsDePietaille = 2 * PROJECTILE_HIT_RADIUS * BODY_SCALE;
    expect(BOSS_BAR_WIDTH_PX).toBeGreaterThan(corpsDePietaille);
  });

  /**
   * *« Une PETITE barre »* : c'est l'epaisseur qui le dit. Un trait, pas un
   * bandeau — au plus un huitieme de sa longueur.
   */
  it('est un trait, pas un bandeau', () => {
    expect(BOSS_BAR_HEIGHT_PX * 8).toBeLessThanOrEqual(BOSS_BAR_WIDTH_PX);
    expect(BOSS_BAR_HEIGHT_PX).toBeGreaterThan(0);
  });
});

describe('bossBarLayout — ou la barre se pose, et quand elle ne se pose pas', () => {
  it('rend null quand aucun boss n est en jeu', () => {
    expect(bossBarLayout(hordeAvecBoss(), null)).toBeNull();
  });

  /**
   * ⚠️ **C'est ainsi que la barre DISPARAIT** (plan, tache 5, etape 2) : le
   * client apprend la mort du boss par `DEATHS`, comme pour tout le monde, et
   * `Horde.kill` retire le creneau. Le snapshot peut encore porter le boss le
   * temps d'un tick de decalage — c'est la horde qui fait foi.
   */
  it('rend null quand le boss n est plus dans la horde (mort apprise par DEATHS)', () => {
    const horde = hordeAvecBoss();
    const boss: BossVitals = { id: BOSS_ID, hp: 900, maxHp: 6000 };
    expect(bossBarLayout(horde, boss)).not.toBeNull();

    horde.kill([BOSS_ID]);
    expect(bossBarLayout(horde, boss)).toBeNull();
  });

  it('rend null pour une identite que la horde ne porte pas', () => {
    expect(bossBarLayout(hordeAvecBoss(), { id: entityIdOf(99, 3), hp: 10, maxHp: 20 })).toBeNull();
  });

  it('centre la barre sur le boss et la monte du decalage derive', () => {
    const horde = hordeAvecBoss(2100, 3300);
    const layout = bossBarLayout(horde, { id: BOSS_ID, hp: 1500, maxHp: 6000 });

    expect(layout).not.toBeNull();
    expect(layout?.x).toBe(2100);
    // AU-DESSUS : l'ordonnee decroit vers le haut de l'ecran.
    expect(layout?.y).toBe(3300 - BOSS_BAR_OFFSET_PX);
    expect(layout?.fraction).toBeCloseTo(0.25, 10);
  });

  /**
   * La barre SUIT le boss : elle est posee a chaque image depuis la position
   * courante, jamais memorisee. Une implementation qui la figerait a la
   * premiere image passerait toutes les assertions ci-dessus.
   */
  it('suit le boss quand il se deplace', () => {
    const horde = hordeAvecBoss(2100, 3300);
    const boss: BossVitals = { id: BOSS_ID, hp: 6000, maxHp: 6000 };
    const avant = bossBarLayout(horde, boss);

    horde.x[0] = 2500;
    horde.y[0] = 3000;
    const apres = bossBarLayout(horde, boss);

    expect(avant?.x).toBe(2100);
    expect(apres?.x).toBe(2500);
    expect(apres?.y).toBe(3000 - BOSS_BAR_OFFSET_PX);
  });
});

/**
 * **Le corps de `draw`, atteint.** Sans `adoptTexture`, `draw` retournerait a
 * son premier `if (!texture)` dans toute la suite et tout son corps pourrait
 * etre retire sans qu'une assertion ne bouge — c'est litteralement ce que
 * `ZoneRenderer.draw` a fait pendant 237 tests verts dans ce depot.
 */
function quadsDessines(horde: Horde, boss: BossVitals | null): Particle[] {
  const renderer = new BossBarRenderer();
  renderer.adoptTexture(new Texture({ source: new TextureSource({ width: 16, height: 16 }) }));
  const world = new Container();
  renderer.attach(world);
  renderer.draw(horde, boss);
  const container = world.children[0] as ParticleContainer;
  return [...(container.particleChildren as Particle[])];
}

describe('BossBarRenderer.draw — ce que les deux quads portent vraiment', () => {
  it('ne dessine rien sans boss', () => {
    expect(quadsDessines(hordeAvecBoss(), null)).toHaveLength(0);
  });

  it('ne dessine rien quand le boss a quitte la horde', () => {
    const horde = hordeAvecBoss();
    horde.kill([BOSS_ID]);
    expect(quadsDessines(horde, { id: BOSS_ID, hp: 900, maxHp: 6000 })).toHaveLength(0);
  });

  it('dessine un socle et un remplissage', () => {
    const quads = quadsDessines(hordeAvecBoss(), { id: BOSS_ID, hp: 3000, maxHp: 6000 });
    expect(quads).toHaveLength(2);
  });

  it('pose le socle centre sur la barre, a la largeur pleine plus son lisere', () => {
    const [socle] = quadsDessines(hordeAvecBoss(2100, 3300), {
      id: BOSS_ID,
      hp: 3000,
      maxHp: 6000,
    });

    expect(socle?.anchorX).toBe(0.5);
    expect(socle?.x).toBe(2100);
    expect(socle?.y).toBe(3300 - BOSS_BAR_OFFSET_PX);
    expect(socle?.scaleX).toBeCloseTo(
      (BOSS_BAR_WIDTH_PX + 2 * BOSS_BAR_BORDER_PX) / BOSS_BAR_TEXTURE_SIZE,
      6,
    );
  });

  /**
   * ⚠️ **Ancre a GAUCHE, et c'est la moitie qui compte.** Un remplissage ancre
   * au centre retrecirait des DEUX cotes : la barre se viderait vers son milieu
   * au lieu de se vider vers la droite, et un boss a 50 % afficherait un
   * batonnet flottant au centre de son socle.
   */
  it('ancre le remplissage au bord gauche du socle', () => {
    const [, remplissage] = quadsDessines(hordeAvecBoss(2100, 3300), {
      id: BOSS_ID,
      hp: 3000,
      maxHp: 6000,
    });

    expect(remplissage?.anchorX).toBe(0);
    expect(remplissage?.x).toBe(2100 - BOSS_BAR_WIDTH_PX / 2);
  });

  /**
   * **Les deux moities de « la barre se vide ».** La largeur a mi-vie seule
   * passerait si `draw` posait une largeur constante egale a la moitie ; la
   * pleine vie seule passerait si la fraction etait ignoree.
   */
  it('donne au remplissage la largeur de la fraction de PV', () => {
    const plein = quadsDessines(hordeAvecBoss(), { id: BOSS_ID, hp: 6000, maxHp: 6000 })[1];
    const moitie = quadsDessines(hordeAvecBoss(), { id: BOSS_ID, hp: 3000, maxHp: 6000 })[1];
    const vide = quadsDessines(hordeAvecBoss(), { id: BOSS_ID, hp: 0, maxHp: 6000 })[1];

    expect(plein?.scaleX).toBeCloseTo(BOSS_BAR_WIDTH_PX / BOSS_BAR_TEXTURE_SIZE, 6);
    expect(moitie?.scaleX).toBeCloseTo(BOSS_BAR_WIDTH_PX / 2 / BOSS_BAR_TEXTURE_SIZE, 6);
    expect(vide?.scaleX).toBe(0);
  });

  /**
   * ⚠️ **La hauteur ne suit PAS la fraction.** Un `scaleY` mis a l'echelle de la
   * fraction ferait maigrir la barre au lieu de la raccourcir — et resterait
   * invisible tant qu'on ne regarde que `scaleX`.
   */
  it('garde la meme epaisseur quelle que soit la vie restante', () => {
    const plein = quadsDessines(hordeAvecBoss(), { id: BOSS_ID, hp: 6000, maxHp: 6000 })[1];
    const presqueMort = quadsDessines(hordeAvecBoss(), { id: BOSS_ID, hp: 60, maxHp: 6000 })[1];
    const attendue = BOSS_BAR_HEIGHT_PX / BOSS_BAR_TEXTURE_SIZE;

    expect(plein?.scaleY).toBeCloseTo(attendue, 6);
    expect(presqueMort?.scaleY).toBeCloseTo(attendue, 6);
  });

  /**
   * Le calque est REUTILISE d'une image a l'autre : les deux quads sont
   * construits une fois. Une image sans boss doit vider la liste, pas laisser
   * la barre de l'image precedente.
   */
  it('efface la barre a l image suivante quand le boss disparait', () => {
    const renderer = new BossBarRenderer();
    renderer.adoptTexture(new Texture({ source: new TextureSource({ width: 16, height: 16 }) }));
    const world = new Container();
    renderer.attach(world);
    const container = world.children[0] as ParticleContainer;
    const horde = hordeAvecBoss();

    renderer.draw(horde, { id: BOSS_ID, hp: 3000, maxHp: 6000 });
    expect(container.particleChildren).toHaveLength(2);

    renderer.draw(horde, null);
    expect(container.particleChildren).toHaveLength(0);
  });
});
