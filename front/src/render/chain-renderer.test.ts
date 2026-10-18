// @vitest-environment jsdom
import { ELEMENT, elementOf } from '@shared/elements';
import { Container } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';

import { CHAIN_FLASH_LIFETIME_MS, ChainFlashes } from '../net/client';
import { CHAIN_LINE_ALPHA, CHAIN_LINE_WIDTH_PX, ChainRenderer } from './chain-renderer';

/**
 * La chaine de Foudre est un FLASH fige dans `ChainFlashes` par
 * `GameClient#seedChainFlash`, jamais rederive de la horde : ce fichier ne
 * construit aucune `Horde`. Le calcul du chemin est teste dans
 * `net/client.test.ts`.
 *
 * Ce qui se garde ICI :
 * 1. **quoi** dessiner — chaque flash vivant, dans l'ordre de ses points ;
 * 2. **comment** il s'eteint — l'opacite decroit avec l'age ;
 * 3. **le pire cas, mesure** — borne par la capacite du reservoir, jamais
 *    par la horde.
 */

const NOW = 10_000;

/** Un point de chaine, pour construire des decors lisibles. */
function pt(x: number, y: number): { x: number; y: number } {
  return { x, y };
}

describe('ChainRenderer.draw — le calque dessine ce que ChainFlashes a fige', () => {
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
   * ⚠️ **Le corps de `draw` ne doit PAS tourner avant `load()`** : rien a
   * cuire, mais `Stage` doit pouvoir compter ce calque comme « pas encore
   * charge ».
   */
  it('ne trace rien tant que load() n a pas ete appele', () => {
    const flashes = new ChainFlashes(4);
    flashes.spawn([pt(0, 0), pt(0, 100)], NOW);
    const renderer = new ChainRenderer();
    const moveTo = vi.spyOn(renderer.graphics, 'moveTo');
    const lineTo = vi.spyOn(renderer.graphics, 'lineTo');
    const stroke = vi.spyOn(renderer.graphics, 'stroke');

    renderer.draw(flashes, NOW);

    expect(moveTo).not.toHaveBeenCalled();
    expect(lineTo).not.toHaveBeenCalled();
    expect(stroke).not.toHaveBeenCalled();
  });

  it('trace la polyligne DANS L ORDRE DES SAUTS : le point d impact, puis chaque saut', () => {
    const flashes = new ChainFlashes(4);
    flashes.spawn([pt(1000, 1000), pt(1000, 1100), pt(1000, 1200)], NOW);
    const renderer = new ChainRenderer();
    renderer.load();
    const moveTo = vi.spyOn(renderer.graphics, 'moveTo');
    const lineTo = vi.spyOn(renderer.graphics, 'lineTo');

    renderer.draw(flashes, NOW);

    expect(moveTo).toHaveBeenCalledTimes(1);
    expect(moveTo).toHaveBeenNthCalledWith(1, 1000, 1000);
    expect(lineTo).toHaveBeenCalledTimes(2);
    expect(lineTo).toHaveBeenNthCalledWith(1, 1000, 1100);
    expect(lineTo).toHaveBeenNthCalledWith(2, 1000, 1200);
  });

  it('trace au trait de l element Foudre, a l epaisseur du module, a pleine opacite a la naissance', () => {
    const flashes = new ChainFlashes(4);
    flashes.spawn([pt(0, 0), pt(0, 100)], NOW);
    const renderer = new ChainRenderer();
    renderer.load();
    const stroke = vi.spyOn(renderer.graphics, 'stroke');

    // nowMs === bornMs : age nul, opacite maximale.
    renderer.draw(flashes, NOW);

    expect(stroke).toHaveBeenCalledTimes(1);
    expect(stroke).toHaveBeenCalledWith({
      color: elementOf(ELEMENT.FOUDRE).tint,
      width: CHAIN_LINE_WIDTH_PX,
      alpha: CHAIN_LINE_ALPHA,
    });
  });

  /**
   * ⚠️ **S'ETEINT avec l'age, comme `ImpactFlashRenderer`.** Un trait qui
   * resterait a pleine opacite jusqu'a sa disparition nette lirait comme un
   * clignotement, pas comme un evenement qui s'estompe — la mutation qui
   * retirerait ce calcul (`alpha` fige a `CHAIN_LINE_ALPHA`) doit rougir ici.
   */
  it('s eteint progressivement : opacite moitie a la moitie de la duree de vie', () => {
    const flashes = new ChainFlashes(4);
    flashes.spawn([pt(0, 0), pt(0, 100)], NOW);
    const renderer = new ChainRenderer();
    renderer.load();
    const stroke = vi.spyOn(renderer.graphics, 'stroke');

    renderer.draw(flashes, NOW + CHAIN_FLASH_LIFETIME_MS / 2);

    expect(stroke).toHaveBeenCalledWith(expect.objectContaining({ alpha: CHAIN_LINE_ALPHA / 2 }));
  });

  /**
   * ⚠️ **Deux flashs d ages differents recoivent des opacites differentes**
   * — c est pour ca qu il faut un `stroke` PAR flash, jamais un seul commun a
   * la fin : un `stroke` partage appliquerait l opacite du DERNIER flash a
   * tous les traits deja traces.
   */
  it('deux flashs d ages differents recoivent chacun leur PROPRE stroke, avec leur PROPRE opacite', () => {
    const flashes = new ChainFlashes(4);
    flashes.spawn([pt(0, 0), pt(0, 100)], NOW); // vient de naitre
    flashes.spawn([pt(5000, 5000), pt(5000, 5100)], NOW - CHAIN_FLASH_LIFETIME_MS / 2); // a moitie eteint
    expect(flashes.count).toBe(2);
    const renderer = new ChainRenderer();
    renderer.load();
    const stroke = vi.spyOn(renderer.graphics, 'stroke');

    renderer.draw(flashes, NOW);

    expect(stroke).toHaveBeenCalledTimes(2);
    expect(stroke).toHaveBeenNthCalledWith(1, expect.objectContaining({ alpha: CHAIN_LINE_ALPHA }));
    expect(stroke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ alpha: CHAIN_LINE_ALPHA / 2 }),
    );
  });

  /**
   * ⚠️ **`ChainFlashes.spawn` refuse un chemin de moins de deux points.**
   * Inatteignable depuis `GameClient#seedChainFlash` (qui garde deja
   * `path.length === 0` avant d'appeler `spawn`), mais `ChainFlashes` est une
   * classe exportee, appelable directement — comme ce fichier le fait — donc
   * sa propre garde doit tenir seule, sans dependre de l'appelant.
   */
  it('ChainFlashes.spawn ignore un chemin de moins de deux points : rien a relier', () => {
    const flashes = new ChainFlashes(4);

    flashes.spawn([], NOW);
    flashes.spawn([pt(0, 0)], NOW);

    expect(flashes.count).toBe(0);
  });

  it('n affiche plus rien pour un flash retire par ChainFlashes.expire', () => {
    const flashes = new ChainFlashes(4);
    flashes.spawn([pt(0, 0), pt(0, 100)], NOW);
    flashes.expire(NOW + CHAIN_FLASH_LIFETIME_MS);
    expect(flashes.count).toBe(0);
    const renderer = new ChainRenderer();
    renderer.load();
    const moveTo = vi.spyOn(renderer.graphics, 'moveTo');
    const stroke = vi.spyOn(renderer.graphics, 'stroke');

    renderer.draw(flashes, NOW + CHAIN_FLASH_LIFETIME_MS);

    expect(moveTo).not.toHaveBeenCalled();
    expect(stroke).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **La mesure du pire cas, faite plutot que supposee** : un decor au
   * pire cas, le nombre reel de traits compte et borne. `ChainFlashes` refuse
   * tout flash au-dela de sa capacite, donc `draw` ne trace jamais plus de
   * `capacity` polylignes, quelle que soit la horde.
   */
  it('borne le nombre de traits par la CAPACITE du reservoir, jamais par une taille de horde', () => {
    // `CHAIN_FLASH_CAPACITY` n'est pas exporte : ce qui compte est que le
    // cout de `draw` suive `flashes.capacity`, quelle qu'elle soit.
    const CAPACITE_TEST = 200;
    const flashes = new ChainFlashes(CAPACITE_TEST);
    for (let i = 0; i < CAPACITE_TEST; i++) {
      flashes.spawn([pt(i, 0), pt(i, 100), pt(i, 200), pt(i, 300)], NOW);
    }
    // La capacite refuse tout flash de plus, meme si on insiste : preuve que
    // le decor est vraiment au pire cas, pas juste rempli par hasard.
    flashes.spawn([pt(9999, 0), pt(9999, 100)], NOW);
    expect(flashes.count).toBe(CAPACITE_TEST);

    const renderer = new ChainRenderer();
    renderer.load();
    const stroke = vi.spyOn(renderer.graphics, 'stroke');

    renderer.draw(flashes, NOW);

    process.stdout.write(
      `[tache 3, tour 1] pire cas : ${flashes.count} flashs de chaine, tous a ` +
        `CHAIN_FLASH_MAX_POINTS points -> ${stroke.mock.calls.length} traits ` +
        `(plafond : capacite du reservoir = ${flashes.capacity}, INDEPENDANT de la horde)\n`,
    );

    expect(stroke.mock.calls.length).toBe(CAPACITE_TEST);
    expect(stroke.mock.calls.length).toBeLessThanOrEqual(flashes.capacity);
  });
});

/**
 * **Le calque trace DEUX evenements** : la chaine de Foudre et le faisceau.
 * La teinte et l'epaisseur sont donc portees par le flash.
 */
describe('ChainFlashes — teinte et epaisseur par flash', () => {
  const DEUX = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];

  it('retombe sur zero quand rien n est demande : le calque choisira', () => {
    const f = new ChainFlashes(4);
    f.spawn(DEUX, 0);
    expect(f.tint[0]).toBe(0);
    expect(f.width[0]).toBe(0);
  });

  it('retient ce qu on lui donne', () => {
    const f = new ChainFlashes(4);
    f.spawn(DEUX, 0, 0x28e6d0, 36);
    expect(f.tint[0]).toBe(0x28e6d0);
    expect(f.width[0]).toBe(36);
  });

  it('compacte teinte et epaisseur avec le reste a l expiration', () => {
    // ⚠️ Le defaut classique d'un tableau type compacte a la main : un champ
    // oublie dans `#removeAt` fait porter au survivant la couleur du mort.
    const f = new ChainFlashes(4);
    f.spawn(DEUX, 0, 0x111111, 2);
    f.spawn(DEUX, 1000, 0x222222, 8);
    f.expire(1000 + CHAIN_FLASH_LIFETIME_MS - 1);
    expect(f.count).toBe(1);
    expect(f.tint[0]).toBe(0x222222);
    expect(f.width[0]).toBe(8);
  });
});

describe('ChainRenderer.draw — le faisceau', () => {
  it('reste accroche a son tireur : le trait part de sa position DESSINEE, direction figee', () => {
    const flashes = new ChainFlashes(4);
    flashes.spawn([pt(0, 0), pt(100, 0)], NOW, 0x28e6d0, 36, 7);
    const renderer = new ChainRenderer();
    renderer.load();
    const moveTo = vi.spyOn(renderer.graphics, 'moveTo');
    const lineTo = vi.spyOn(renderer.graphics, 'lineTo');

    renderer.draw(flashes, NOW + 40, [{ id: 7, x: 50, y: 30 }]);

    expect(moveTo).toHaveBeenCalledWith(50, 30);
    expect(lineTo).toHaveBeenCalledWith(150, 30);
  });

  it('vit plus longtemps qu une chaine', () => {
    const flashes = new ChainFlashes(4);
    flashes.spawn([pt(0, 0), pt(100, 0)], NOW, 0x28e6d0, 36, 7);
    flashes.spawn([pt(0, 0), pt(100, 0)], NOW);

    flashes.expire(NOW + CHAIN_FLASH_LIFETIME_MS);

    expect(flashes.count).toBe(1);
    expect(flashes.owner[0]).toBe(7);
  });
});
