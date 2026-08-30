// @vitest-environment jsdom
import { SYNERGY_MAX } from '@shared/constants';
import { beforeEach, describe, expect, it } from 'vitest';

// `?raw` de Vite : le HTML entre dans le bundle de test tel quel, meme motif
// que `draft.test.ts` — c'est ce qui permet de verifier le CABLAGE vers
// `index.html` et pas seulement la fonction qui ecrit dedans.
import indexHtml from '../../index.html?raw';
import { paintSynergy, synergyRatio } from './hud';

/**
 * Étape 5a, §9 : *« la barre de Synergie : une jauge dans le HUD, visible de
 * tous »*.
 *
 * Testee sous jsdom parce que c'est la SEULE partie du rendu de cette tache
 * qui soit reellement observable sans navigateur : le reste passe par des
 * `ParticleContainer` dont les textures exigent un canevas 2D que jsdom ne
 * fournit pas (voir `zone-renderer.test.ts`).
 */

interface Harness {
  fill: HTMLElement;
  label: HTMLElement;
}

function mount(): Harness {
  document.body.innerHTML = indexHtml;
  const fill = document.getElementById('hud-synergy-fill');
  const label = document.getElementById('hud-synergy-label');
  if (!fill || !label) {
    throw new Error('la jauge de Synergie est absente de index.html');
  }
  return { fill, label };
}

describe('le cablage vers index.html', () => {
  it('trouve les deux elements que main.ts va chercher', () => {
    document.body.innerHTML = indexHtml;

    // Meme garde que celle de `draft.test.ts` : `main.ts` fait
    // `await stage.init()` au niveau module et n'est pas importable en test,
    // donc rien d'autre ne verifie que ces identifiants existent encore. Un
    // renommage dans le HTML ferait planter le jeu au demarrage (`el()` leve),
    // sans qu'aucune suite ne rougisse.
    expect(document.getElementById('hud-synergy-fill')).not.toBeNull();
    expect(document.getElementById('hud-synergy-label')).not.toBeNull();
  });
});

describe('synergyRatio — la part remplie de la barre', () => {
  it('vaut 0 barre vide et 1 barre pleine', () => {
    expect(synergyRatio(0)).toBe(0);
    expect(synergyRatio(SYNERGY_MAX)).toBe(1);
  });

  it('monte proportionnellement entre les deux', () => {
    expect(synergyRatio(SYNERGY_MAX / 2)).toBeCloseTo(0.5, 6);
  });

  it('ne deborde jamais du cadre, meme au-dela du plafond', () => {
    // Le serveur plafonne deja (tache 8) ; un serveur plus recent, dont le
    // plafond aurait ete releve, ne doit pas faire deborder la barre d'un
    // client plus ancien.
    expect(synergyRatio(SYNERGY_MAX * 3)).toBe(1);
  });
});

describe('paintSynergy — ce que le joueur voit', () => {
  let dom: Harness;

  beforeEach(() => {
    dom = mount();
  });

  /**
   * ⚠️ **Les deux extremes, dans le meme fichier** (R24/R25) : « la jauge ne
   * se remplit jamais » et « la jauge est toujours pleine » se ressemblent
   * beaucoup dans un test qui n'en verifierait qu'un. En solo la barre ne
   * monte JAMAIS (§7), donc une jauge cassee a 0 % passerait inapercue en
   * partie solo — c'est exactement le cas ou il faut que le test parle.
   */
  it('ne remplit rien quand la barre est vide', () => {
    paintSynergy(dom.fill, dom.label, 0);

    expect(dom.fill.style.width).toBe('0%');
    expect(dom.label.textContent).toBe(`0 / ${SYNERGY_MAX}`);
  });

  it('remplit tout quand la barre est pleine', () => {
    paintSynergy(dom.fill, dom.label, SYNERGY_MAX);

    expect(dom.fill.style.width).toBe('100%');
    expect(dom.label.textContent).toBe(`${SYNERGY_MAX} / ${SYNERGY_MAX}`);
  });

  it('remplit a moitie a mi-course — la barre BOUGE, elle ne saute pas de vide a pleine', () => {
    paintSynergy(dom.fill, dom.label, SYNERGY_MAX / 2);

    expect(dom.fill.style.width).toBe('50%');
  });

  it('affiche le compte en clair, pas seulement la barre', () => {
    // Une barre qui glisse de trois pixels ne dit pas ce qui l'a fait monter ;
    // un « 3 / 20 » qui change juste apres un flash blanc, si. C'est le §6.5
    // — la Synergie est *le coeur du projet*, elle doit se lire.
    paintSynergy(dom.fill, dom.label, 3);

    expect(dom.label.textContent).toBe(`3 / ${SYNERGY_MAX}`);
  });

  it('repeint a chaque appel, sans garder la valeur precedente', () => {
    paintSynergy(dom.fill, dom.label, SYNERGY_MAX);
    paintSynergy(dom.fill, dom.label, 0);

    expect(dom.fill.style.width).toBe('0%');
    expect(dom.label.textContent).toBe(`0 / ${SYNERGY_MAX}`);
  });
});
