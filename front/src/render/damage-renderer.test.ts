import { MAP_SIZE } from '@shared/constants';
import { ELEMENT } from '@shared/elements';
import { Container, type Particle, type ParticleContainer, Texture, TextureSource } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import { DAMAGE_NUMBER_LIFETIME_MS, DamageNumbers } from '../net/client';
import {
  CRIT_SCALE,
  CRIT_TINT,
  DAMAGE_FULL,
  DAMAGE_RISE_PX,
  DAMAGE_TINT,
  DAMAGE_TINTS,
  DamageNumberRenderer,
  DIGIT_CELL_PX,
  DIGITS_MAX,
  damageFade,
  damageRise,
  digitsOf,
} from './damage-renderer';

/** Capacite du reservoir de chiffres, recopiee : `net/client.ts` ne l'exporte pas. */
const CAPACITE = 128;

/**
 * **Les chiffres de degats.**
 *
 * ⚠️ `draw` n'est atteignable que parce que `adoptAtlas` existe : `load()` cuit
 * son atlas sur un canevas 2D que l'environnement de test n'a pas. Meme
 * decoupage que les trois renderers de `projectile-renderer.ts`.
 */
function dessine(nombres: DamageNumbers, nowMs: number): Particle[] {
  const renderer = new DamageNumberRenderer();
  renderer.adoptAtlas(
    new Texture({
      source: new TextureSource({ width: DIGIT_CELL_PX * 10, height: DIGIT_CELL_PX }),
    }),
  );
  const world = new Container();
  renderer.attach(world);
  renderer.draw(nombres, nowMs);
  const container = world.children[0] as ParticleContainer;
  return [...(container.particleChildren as Particle[])];
}

function unNombre(montant: number, crit = false, element: number = ELEMENT.NEUTRE): DamageNumbers {
  const n = new DamageNumbers(CAPACITE);
  n.spawn(500, 400, montant, crit, element, 0);
  return n;
}

describe('digitsOf — le nombre en chiffres', () => {
  it('rend un quad par chiffre, du plus fort au plus faible', () => {
    expect(digitsOf(407)).toEqual([4, 0, 7]);
    expect(digitsOf(5)).toEqual([5]);
  });

  it('arrondit : le rendu n invente pas de virgule', () => {
    expect(digitsOf(12.4)).toEqual([1, 2]);
    expect(digitsOf(12.6)).toEqual([1, 3]);
  });

  it('ne depasse JAMAIS la largeur annoncee, meme sur un nombre absurde', () => {
    // ⚠️ C'est la borne du reservoir : `draw` dimensionne sur
    // `count x DIGITS_MAX`, donc un nombre plus long dessinerait dans le vide.
    expect(digitsOf(1_234_567).length).toBe(DIGITS_MAX);
  });
});

describe('DamageNumberRenderer.draw — ce que le joueur lit', () => {
  it('pose un quad par chiffre, centre sur le monstre', () => {
    const quads = dessine(unNombre(42), 0);
    expect(quads).toHaveLength(2);
    // Centre : les deux chiffres encadrent l'abscisse du monstre.
    const xs = quads.map((q) => q.x);
    expect(Math.min(...xs)).toBeLessThan(500);
    expect(Math.max(...xs)).toBeGreaterThan(500);
    expect(((xs[0] ?? 0) + (xs[1] ?? 0)) / 2).toBeCloseTo(500, 6);
  });

  it('prend la case du bon chiffre dans l atlas', () => {
    const quads = dessine(unNombre(17), 0);
    expect(quads.map((q) => q.texture.frame.x)).toEqual([1 * DIGIT_CELL_PX, 7 * DIGIT_CELL_PX]);
  });

  it('MONTE avec le temps, et ralentit en montant', () => {
    const naissance = dessine(unNombre(9), 0)[0];
    const moitie = dessine(unNombre(9), DAMAGE_NUMBER_LIFETIME_MS / 2)[0];
    const fin = dessine(unNombre(9), DAMAGE_NUMBER_LIFETIME_MS)[0];
    if (!naissance || !moitie || !fin) {
      throw new Error('chiffre manquant');
    }
    expect(moitie.y).toBeLessThan(naissance.y);
    expect(fin.y).toBeLessThan(moitie.y);
    expect(naissance.y - fin.y).toBeCloseTo(DAMAGE_RISE_PX, 6);
    // Amorti : la premiere moitie du temps couvre PLUS de la moitie du chemin.
    expect(naissance.y - moitie.y).toBeGreaterThan(DAMAGE_RISE_PX / 2);
  });

  it('monte de la hauteur annoncee, et pas davantage', () => {
    expect(damageRise(0)).toBe(0);
    expect(damageRise(1)).toBeCloseTo(DAMAGE_RISE_PX, 6);
    // Amorti : a mi-vie, plus de la moitie du chemin est faite.
    expect(damageRise(0.5)).toBeGreaterThan(DAMAGE_RISE_PX / 2);
  });

  it('reste LISIBLE la premiere moitie de sa vie, puis s efface', () => {
    expect(damageFade(0)).toBe(1);
    expect(damageFade(0.5)).toBe(1);
    expect(damageFade(1)).toBeCloseTo(0, 6);
    expect(dessine(unNombre(9), DAMAGE_NUMBER_LIFETIME_MS * 0.4)[0]?.alpha).toBe(1);
  });

  it('ecrit un CRITIQUE plus gros et ROUGE', () => {
    // A montant EGAL : sans ca, l'ecart de taille pourrait venir du montant
    // (voir `damageScale`) et non du critique.
    const normal = dessine(unNombre(20), 0)[0];
    const critique = dessine(unNombre(20, true), 0)[0];
    if (!normal || !critique) {
      throw new Error('chiffre manquant');
    }
    expect(critique.scaleX / normal.scaleX).toBeCloseTo(CRIT_SCALE, 6);
    expect(normal.tint).toBe(DAMAGE_TINT);
    expect(critique.tint).toBe(CRIT_TINT);
  });

  it('teinte le chiffre par l ELEMENT qui a porte le coup', () => {
    const poison = dessine(unNombre(10, false, ELEMENT.POIX), 0)[0];
    const givre = dessine(unNombre(10, false, ELEMENT.GIVRE), 0)[0];
    const neutre = dessine(unNombre(10, false, ELEMENT.NEUTRE), 0)[0];

    expect(poison?.tint).toBe(DAMAGE_TINTS[ELEMENT.POIX]);
    expect(givre?.tint).toBe(DAMAGE_TINTS[ELEMENT.GIVRE]);
    expect(neutre?.tint).toBe(DAMAGE_TINT);
    // Les sept teintes sont DISTINCTES : sans ca, « teinte par element »
    // serait vrai sans rien distinguer.
    expect(new Set(Object.values(DAMAGE_TINTS)).size).toBe(Object.keys(DAMAGE_TINTS).length);
  });

  it('laisse le CRITIQUE l emporter sur l element', () => {
    // Le critique est l'evenement rare : il ne doit pas se diluer dans sept
    // couleurs d'element.
    const critGivre = dessine(unNombre(10, true, ELEMENT.GIVRE), 0)[0];
    expect(critGivre?.tint).toBe(CRIT_TINT);
  });

  it('ecrit PLUS GROS un coup qui pese, et plafonne', () => {
    const petit = dessine(unNombre(2), 0)[0];
    const moyen = dessine(unNombre(20), 0)[0];
    const gros = dessine(unNombre(DAMAGE_FULL), 0)[0];
    const absurde = dessine(unNombre(DAMAGE_FULL * 100), 0)[0];
    if (!petit || !moyen || !gros || !absurde) {
      throw new Error('chiffre manquant');
    }
    expect(moyen.scaleX).toBeGreaterThan(petit.scaleX);
    expect(gros.scaleX).toBeGreaterThan(moyen.scaleX);
    // ⚠️ Le plafond : un coup empile par vingt cartes n'ecrit pas des chiffres
    // plus hauts que les monstres.
    expect(absurde.scaleX).toBeCloseTo(gros.scaleX, 6);
  });

  /**
   * ⚠️ **Le poste de cout de ce calque** : il est borne par le nombre de CHIFFRES vivants, jamais par la
   * horde.
   */
  it('ne pose jamais plus de quatre quads par chiffre, a capacite pleine', () => {
    const n = new DamageNumbers(CAPACITE);
    for (let i = 0; i < CAPACITE; i++) {
      n.spawn(0, 0, 9999, false, ELEMENT.NEUTRE, 0);
    }
    const quads = dessine(n, 0);
    process.stdout.write(
      `[etape 8] pire cas : ${n.count} chiffres -> ${quads.length} quads ` +
        `(${quads.length / n.count} par chiffre)\n`,
    );
    expect(quads).toHaveLength(CAPACITE * DIGITS_MAX);
  });

  it('pose des bornes explicites couvrant la carte entiere, marge comprise', () => {
    expect(new DamageNumberRenderer().boundsArea).toMatchObject({
      x: -256,
      y: -256,
      width: MAP_SIZE + 512,
      height: MAP_SIZE + 512,
    });
  });

  it('ne dessine rien tant que l atlas n est pas adopte', () => {
    // La moitie basse : sans elle, un `draw` qui dessinerait avec une texture
    // vide passerait inapercu.
    const renderer = new DamageNumberRenderer();
    expect(renderer.loaded).toBe(false);
    const world = new Container();
    renderer.attach(world);
    renderer.draw(unNombre(5), 0);
    expect((world.children[0] as ParticleContainer).particleChildren).toHaveLength(0);
  });
});

describe('DamageNumbers — le reservoir', () => {
  it('arrondit et plancher a UN : un coup qui touche ne montre jamais zero', () => {
    const n = new DamageNumbers(4);
    n.spawn(0, 0, 0.2, false, ELEMENT.NEUTRE, 0);
    expect(n.amount[0]).toBe(1);
  });

  it('expire au bout de sa vie, et compacte tout avec lui', () => {
    const n = new DamageNumbers(4);
    n.spawn(1, 1, 10, true, ELEMENT.BRAISE, 0);
    n.spawn(2, 2, 20, false, ELEMENT.GIVRE, 100);
    n.expire(DAMAGE_NUMBER_LIFETIME_MS);
    expect(n.count).toBe(1);
    // ⚠️ Le survivant garde SES valeurs : un champ oublie dans la compaction
    // ferait porter au second le montant du premier.
    expect(n.amount[0]).toBe(20);
    expect(n.crit[0]).toBe(0);
    expect(n.element[0]).toBe(ELEMENT.GIVRE);
    expect(n.x[0]).toBe(2);
  });

  it('ignore silencieusement un debordement, comme les flashs', () => {
    const n = new DamageNumbers(1);
    n.spawn(0, 0, 10, false, ELEMENT.NEUTRE, 0);
    n.spawn(0, 0, 20, false, ELEMENT.NEUTRE, 0);
    expect(n.count).toBe(1);
  });
});
