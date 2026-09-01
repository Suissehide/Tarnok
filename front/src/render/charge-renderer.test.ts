import { type BossCharge, makeBossCharge } from '@shared/boss';
import { entityIdOf } from '@shared/horde';
import { Container, type Particle, type ParticleContainer, Texture, TextureSource } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import {
  CHARGE_ALPHA,
  CHARGE_FILL_RATIO,
  CHARGE_TEXTURE_SIZE,
  ChargeRenderer,
  chargeAlphaAt,
  chargeQuad,
} from './charge-renderer';

/**
 * Le rectangle d'annonce de la charge du boss (etape 6a, tache 5 bis).
 *
 * ⚠️ **Ce calque ne fait PAS tourner le boss, et aucun test ne doit lui
 * demander de le faire.** Decision de l'auteur : *« pas besoin de faire tourner
 * le boss, l'animation d'attaque le fait deja tourner »*. La rotation qu'on
 * teste ici est celle du COULOIR — l'orientation du rectangle — jamais celle du
 * sprite.
 *
 * Deux choses a garder, independantes : ce que `chargeQuad` DIT (ou, comment,
 * a quelle opacite) et ce que `draw` POSE vraiment sur le quad.
 */

const BOSS_ID = entityIdOf(7, 0);

/** Une charge vers l'est, annoncee au tick 100 depuis (1000, 2000). */
function charge(): BossCharge {
  return makeBossCharge(BOSS_ID, 1000, 2000, 5000, 2000, 100);
}

describe('chargeAlphaAt — l opacite MONTE pendant le chargement', () => {
  it('ne dessine rien avant l annonce ni apres la fin', () => {
    const c = charge();
    expect(chargeAlphaAt(c, c.windupTick - 1)).toBe(0);
    expect(chargeAlphaAt(c, c.endTick + 1)).toBe(0);
  });

  /**
   * ⚠️ **La montee EST le compte a rebours.** C'est la seule chose que le
   * joueur lise pour savoir combien de temps il lui reste : une opacite
   * constante annoncerait qu'il se passe quelque chose sans dire quand.
   */
  it('monte strictement du tick d annonce au tick de depart', () => {
    const c = charge();
    let precedent = -1;
    for (let t = c.windupTick; t <= c.startTick; t++) {
      const a = chargeAlphaAt(c, t);
      expect(a, `tick ${t}`).toBeGreaterThan(precedent);
      precedent = a;
    }
    expect(precedent).toBe(CHARGE_ALPHA);
  });

  it('part de zero et atteint exactement CHARGE_ALPHA au depart', () => {
    const c = charge();
    expect(chargeAlphaAt(c, c.windupTick)).toBe(0);
    expect(chargeAlphaAt(c, c.startTick)).toBe(CHARGE_ALPHA);
  });

  it('reste plein pendant toute la traversee', () => {
    const c = charge();
    for (let t = c.startTick; t <= c.endTick; t++) {
      expect(chargeAlphaAt(c, t), `tick ${t}`).toBe(CHARGE_ALPHA);
    }
  });
});

describe('chargeQuad — ou le couloir se pose, et quand il ne se pose pas', () => {
  it('rend null quand aucune charge n est en cours', () => {
    expect(chargeQuad(null, 100)).toBeNull();
  });

  it('rend null hors de la fenetre de la charge', () => {
    const c = charge();
    expect(chargeQuad(c, c.windupTick - 1)).toBeNull();
    expect(chargeQuad(c, c.endTick + 1)).toBeNull();
  });

  /**
   * ⚠️ **Le rectangle part de l'ORIGINE annoncee et n'en bouge plus.** C'est le
   * boss qui le traverse : un couloir qui suivrait le boss ne dirait plus rien
   * de ce qui reste a parcourir.
   */
  it('se pose a l origine du couloir, jamais sur la position courante du boss', () => {
    const c = charge();
    const debut = chargeQuad(c, c.windupTick + 5);
    const fin = chargeQuad(c, c.endTick);

    expect(debut?.x).toBe(c.x);
    expect(debut?.y).toBe(c.y);
    expect(fin?.x).toBe(c.x);
    expect(fin?.y).toBe(c.y);
  });

  it('oriente le rectangle dans la direction de la charge', () => {
    const est = chargeQuad(makeBossCharge(BOSS_ID, 0, 0, 100, 0, 0), 5);
    const sud = chargeQuad(makeBossCharge(BOSS_ID, 0, 0, 0, 100, 0), 5);

    expect(est?.rotation).toBeCloseTo(0, 4);
    expect(sud?.rotation).toBeCloseTo(Math.PI / 2, 4);
  });

  it('porte la longueur et la largeur de la charge, pas des constantes a lui', () => {
    const c = charge();
    const quad = chargeQuad(c, c.startTick);

    expect(quad?.length).toBe(c.length);
    expect(quad?.width).toBe(c.width);
  });
});

/**
 * **Le corps de `draw`, atteint.** Sans `adoptTexture`, `draw` retournerait a
 * son premier garde dans toute la suite et tout son corps pourrait etre retire
 * sans qu'une assertion ne bouge — c'est litteralement ce que `ZoneRenderer.draw`
 * a fait pendant 237 tests verts dans ce depot.
 */
function quadsDessines(c: BossCharge | null, tick: number): Particle[] {
  const renderer = new ChargeRenderer();
  renderer.adoptTexture(new Texture({ source: new TextureSource({ width: 16, height: 16 }) }));
  const world = new Container();
  renderer.attach(world);
  renderer.draw(c, tick);
  const container = world.children[0] as ParticleContainer;
  return [...(container.particleChildren as Particle[])];
}

describe('ChargeRenderer.draw — ce que le quad porte vraiment', () => {
  it('ne dessine rien sans charge', () => {
    expect(quadsDessines(null, 100)).toHaveLength(0);
  });

  it('ne dessine rien une fois la charge finie', () => {
    const c = charge();
    expect(quadsDessines(c, c.endTick + 1)).toHaveLength(0);
  });

  it('dessine un seul quad pendant la charge', () => {
    const c = charge();
    expect(quadsDessines(c, c.startTick)).toHaveLength(1);
  });

  it('pose le quad a l origine du couloir, ancre a gauche pour partir de la', () => {
    const c = charge();
    const [quad] = quadsDessines(c, c.startTick);

    expect(quad?.anchorX).toBe(0);
    expect(quad?.anchorY).toBe(0.5);
    expect(quad?.x).toBe(c.x);
    expect(quad?.y).toBe(c.y);
  });

  /**
   * ⚠️ **L'echelle, pas la texture.** `CHARGE_TEXTURE_SIZE` (64) ne vaut ni la
   * longueur (900) ni la largeur (192) : une mutation qui poserait `scaleX = 1`
   * — le couloir ne suit plus sa longueur — rougit donc ici. C'est le meme
   * piege que `ZONE_TEXTURE_DIAMETER` a paye a l'etape 5a.
   */
  it('etire le quad a la longueur ET a la largeur du couloir', () => {
    const c = charge();
    const [quad] = quadsDessines(c, c.startTick);

    expect(quad?.scaleX).toBeCloseTo(c.length / CHARGE_TEXTURE_SIZE, 6);
    expect(quad?.scaleY).toBeCloseTo(c.width / CHARGE_TEXTURE_SIZE, 6);
  });

  it('oriente le quad dans la direction de la charge', () => {
    const c = makeBossCharge(BOSS_ID, 0, 0, 0, 100, 0);
    const [quad] = quadsDessines(c, c.startTick);

    expect(quad?.rotation).toBeCloseTo(Math.PI / 2, 4);
  });

  /**
   * **Les deux moities de « l'opacite monte ».** Le plein seul passerait avec
   * une opacite constante ; le debut seul passerait avec une opacite toujours
   * nulle.
   */
  it('fait monter l opacite du quad pendant le chargement', () => {
    const c = charge();
    const tot = quadsDessines(c, c.windupTick + 5)[0]?.alpha ?? 0;
    const tard = quadsDessines(c, c.startTick - 1)[0]?.alpha ?? 0;
    const plein = quadsDessines(c, c.startTick + 1)[0]?.alpha ?? 0;

    expect(tot).toBeGreaterThan(0);
    expect(tard).toBeGreaterThan(tot);
    expect(plein).toBe(CHARGE_ALPHA);
  });

  /**
   * Le calque est REUTILISE d'une image a l'autre : le quad est construit une
   * fois. Une image sans charge doit vider la liste, pas laisser le couloir de
   * l'image precedente.
   */
  it('efface le couloir a l image suivante quand la charge est finie', () => {
    const renderer = new ChargeRenderer();
    renderer.adoptTexture(new Texture({ source: new TextureSource({ width: 16, height: 16 }) }));
    const world = new Container();
    renderer.attach(world);
    const container = world.children[0] as ParticleContainer;
    const c = charge();

    renderer.draw(c, c.startTick);
    expect(container.particleChildren).toHaveLength(1);

    renderer.draw(c, c.endTick + 1);
    expect(container.particleChildren).toHaveLength(0);
  });

  it('est additif, comme les zones : le couloir s ajoute au terrain qu il couvre', () => {
    expect(new ChargeRenderer().blendMode).toBe('add');
  });
});

/**
 * ⚠️ **Le bord d'un couloir est une REGLE DE JEU** : c'est lui qui dit ou il
 * faut etre pour ne pas etre touche. Un aplat uniforme ne dit ni ou il commence
 * ni ou il finit — meme raisonnement, mot pour mot, que `ZONE_FILL_RATIO`.
 */
describe('le couloir se lit : un lisere, pas un aplat', () => {
  it('garde l interieur franchement plus discret que le bord', () => {
    expect(CHARGE_FILL_RATIO).toBeGreaterThan(0);
    expect(CHARGE_FILL_RATIO).toBeLessThan(0.5);
  });

  /**
   * *« Legerement rouge »* (§4 de la spec) : le §6.6 de l'orientation est
   * categorique sur le fait que l'etat persistant reste DISCRET, et ce
   * rectangle est le plus grand aplat du jeu.
   */
  it('reste discret : le couloir ne blanchit pas l ecran', () => {
    expect(CHARGE_ALPHA).toBeGreaterThan(0);
    expect(CHARGE_ALPHA).toBeLessThan(0.5);
  });
});
