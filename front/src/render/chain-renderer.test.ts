// @vitest-environment jsdom
import { CHAIN_JUMPS, CHAIN_RADIUS, MARK_DURATION_TICKS } from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import { Horde } from '@shared/horde';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { Container } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';

import {
  CHAIN_LINE_ALPHA,
  CHAIN_LINE_WIDTH_PX,
  type ChainPolyline,
  ChainRenderer,
  selectChains,
} from './chain-renderer';

/**
 * Etape 5b, tache 3 : la polyligne de la chaine de Foudre, cote client.
 *
 * Deux choses se gardent ici, comme sur `mark-renderer.test.ts` (son plus
 * proche voisin) :
 * 1. **quoi** dessiner — `selectChains`, PURE, testable sans Pixi ;
 * 2. **que le calque s'en serve reellement** — `ChainRenderer.draw`, atteint
 *    via des espions sur ses methodes `Graphics`, meme raisonnement que
 *    `zone-renderer.test.ts` sur `adoptTexture` : un corps de `draw` qui ne
 *    serait garde par AUCUNE assertion est exactement la dette que ce fichier
 *    (et `frame.test.ts`, en amont) doit fermer.
 */

const TICK = 200;

/**
 * Une horde dont les positions sont POSEES, pas simulees — meme helper que
 * `mark-renderer.test.ts`, meme raison : ce fichier parle de geometrie a
 * quelques pixels pres, et `spawn` disperse au hasard de la formation.
 */
function hordeAt(points: readonly { x: number; y: number }[]): Horde {
  const horde = new Horde(Math.max(4, points.length));
  const order: WaveOrder = {
    waveId: 1,
    spawnTick: 0,
    seed: 3,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: 3000,
    anchorY: 3000,
    count: points.length,
  };
  horde.spawn(order);
  points.forEach((p, i) => {
    horde.x[i] = p.x;
    horde.y[i] = p.y;
  });
  return horde;
}

describe('selectChains — quelles chaines se dessinent, au tick courant', () => {
  it('un ennemi marque Foudre origine une chaine qui saute vers ses voisins, DANS L ORDRE', () => {
    // 100 px de saut en saut : dans CHAIN_RADIUS (150), pas deux sauts d un
    // coup (200 > 150) — la chaine ne peut que suivre la ligne.
    expect(100).toBeLessThan(CHAIN_RADIUS);
    const horde = hordeAt([
      { x: 1000, y: 1000 }, // l origine, marquee Foudre
      { x: 1000, y: 1100 }, // premier saut
      { x: 1000, y: 1200 }, // second saut
    ]);
    horde.applyMark(0, ELEMENT.FOUDRE, 1, TICK);

    const chains = selectChains(horde, TICK);

    expect(chains).toEqual<ChainPolyline[]>([
      {
        points: [
          { x: 1000, y: 1000 },
          { x: 1000, y: 1100 },
          { x: 1000, y: 1200 },
        ],
      },
    ]);
  });

  /**
   * ⚠️ **Le decor n est PAS creux : la horde est peuplee, l ennemi EST
   * marque Foudre — et pourtant aucune chaine ne se dessine**, parce que rien
   * n est a portee. Sans ce test, `selectChains` pourrait rendre `[]` pour
   * n importe quelle raison, y compris une horde vide passee par erreur —
   * le « test qui renvoie zero » cite par le brief de cette tache.
   */
  it('un ennemi marque Foudre SANS voisin a portee ne produit aucune chaine (et le decor n est pas creux)', () => {
    const horde = hordeAt([{ x: 1000, y: 1000 }]);
    horde.applyMark(0, ELEMENT.FOUDRE, 1, TICK);
    expect(horde.count).toBe(1); // le decor est peuple

    expect(selectChains(horde, TICK)).toEqual([]);
  });

  it('un ennemi marque d un AUTRE element, ou pas marque du tout, ne produit aucune chaine', () => {
    // Meme geometrie que le premier test (des voisins a portee), pour que ce
    // qui manque soit bien la marque Foudre et rien d autre.
    const horde = hordeAt([
      { x: 1000, y: 1000 },
      { x: 1000, y: 1100 },
    ]);
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);
    // horde[1] reste NEUTRE : pas d appel a applyMark.

    expect(selectChains(horde, TICK)).toEqual([]);
  });

  it('garde la chaine jusqu au dernier tick de la marque, et pas un de plus', () => {
    // Meme borne, meme predicat DERIVE (`markAt`, jamais `horde.mark`) que
    // `selectMarkedRings` — c est `markUntil` qui decide, des deux cotes du
    // fil.
    const horde = hordeAt([
      { x: 1000, y: 1000 },
      { x: 1000, y: 1100 },
    ]);
    horde.applyMark(0, ELEMENT.FOUDRE, 1, TICK);

    expect(selectChains(horde, TICK + MARK_DURATION_TICKS - 1)).not.toEqual([]);
    expect(selectChains(horde, TICK + MARK_DURATION_TICKS)).toEqual([]);
  });

  it('plusieurs ennemis marques Foudre, hors de portee l un de l autre, produisent DEUX chaines separees', () => {
    const horde = hordeAt([
      { x: 0, y: 0 },
      { x: 0, y: 100 }, // voisin du premier
      { x: 5000, y: 5000 }, // loin de tout : seconde origine
      { x: 5000, y: 5100 }, // voisin du second
    ]);
    horde.applyMark(0, ELEMENT.FOUDRE, 1, TICK);
    horde.applyMark(2, ELEMENT.FOUDRE, 2, TICK);

    const chains = selectChains(horde, TICK);

    expect(chains).toHaveLength(2);
    expect(chains).toContainEqual({
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 100 },
      ],
    });
    expect(chains).toContainEqual({
      points: [
        { x: 5000, y: 5000 },
        { x: 5000, y: 5100 },
      ],
    });
  });

  it('ne saute jamais plus loin que CHAIN_JUMPS cibles', () => {
    expect(CHAIN_JUMPS).toBe(3);
    const horde = hordeAt([
      { x: 0, y: 0 }, // origine
      { x: 0, y: 100 },
      { x: 0, y: 200 },
      { x: 0, y: 300 },
      { x: 0, y: 400 }, // geometriquement a portee du precedent, mais hors CHAIN_JUMPS
    ]);
    horde.applyMark(0, ELEMENT.FOUDRE, 1, TICK);

    const [chain] = selectChains(horde, TICK);

    // Le point d impact + CHAIN_JUMPS sauts, jamais un cinquieme point.
    expect(chain?.points).toHaveLength(1 + CHAIN_JUMPS);
    expect(chain?.points.at(-1)).toEqual({ x: 0, y: 300 });
  });
});

describe('ChainRenderer.draw — le calque dessine ce que selectChains a decide', () => {
  /** Un decor a une chaine, reutilise par les tests de cablage ci-dessous. */
  function decor(): Horde {
    const horde = hordeAt([
      { x: 1000, y: 1000 },
      { x: 1000, y: 1100 },
      { x: 1000, y: 1200 },
    ]);
    horde.applyMark(0, ELEMENT.FOUDRE, 1, TICK);
    return horde;
  }

  it('loaded vaut faux avant load(), vrai apres', () => {
    const renderer = new ChainRenderer();
    expect(renderer.loaded).toBe(false);

    renderer.load();

    expect(renderer.loaded).toBe(true);
  });

  it('attache son Graphics au parent', () => {
    const renderer = new ChainRenderer();
    const parent = new Container();

    renderer.attach(parent);

    expect(parent.children).toEqual([renderer.graphics]);
  });

  /**
   * ⚠️ **Le corps de `draw` ne doit PAS tourner avant `load()`** — meme
   * garde que `ZoneRenderer`/`MarkRingRenderer` sur leur texture, adaptee ici
   * a l absence de texture : rien de procedural a cuire, mais `Stage` doit
   * quand meme pouvoir compter ce calque comme « pas encore charge ».
   */
  it('ne trace rien tant que load() n a pas ete appele', () => {
    const renderer = new ChainRenderer();
    const moveTo = vi.spyOn(renderer.graphics, 'moveTo');
    const lineTo = vi.spyOn(renderer.graphics, 'lineTo');
    const stroke = vi.spyOn(renderer.graphics, 'stroke');

    renderer.draw(decor(), TICK);

    expect(moveTo).not.toHaveBeenCalled();
    expect(lineTo).not.toHaveBeenCalled();
    expect(stroke).not.toHaveBeenCalled();
  });

  it('trace la polyligne DANS L ORDRE DES SAUTS : le point d impact, puis chaque saut', () => {
    const renderer = new ChainRenderer();
    renderer.load();
    const moveTo = vi.spyOn(renderer.graphics, 'moveTo');
    const lineTo = vi.spyOn(renderer.graphics, 'lineTo');

    renderer.draw(decor(), TICK);

    expect(moveTo).toHaveBeenCalledTimes(1);
    expect(moveTo).toHaveBeenNthCalledWith(1, 1000, 1000);
    expect(lineTo).toHaveBeenCalledTimes(2);
    expect(lineTo).toHaveBeenNthCalledWith(1, 1000, 1100);
    expect(lineTo).toHaveBeenNthCalledWith(2, 1000, 1200);
  });

  it('trace au trait de l element Foudre, a l epaisseur et l opacite du module', () => {
    const renderer = new ChainRenderer();
    renderer.load();
    const stroke = vi.spyOn(renderer.graphics, 'stroke');

    renderer.draw(decor(), TICK);

    expect(stroke).toHaveBeenCalledWith({
      color: elementOf(ELEMENT.FOUDRE).tint,
      width: CHAIN_LINE_WIDTH_PX,
      alpha: CHAIN_LINE_ALPHA,
    });
  });

  it('efface le trait precedent avant de redessiner, meme quand plus rien n est marque', () => {
    const renderer = new ChainRenderer();
    renderer.load();
    const clear = vi.spyOn(renderer.graphics, 'clear');

    // Un tick largement au-dela de la marque : plus rien a dessiner.
    renderer.draw(decor(), TICK + MARK_DURATION_TICKS);

    expect(clear).toHaveBeenCalledTimes(1);
  });
});
