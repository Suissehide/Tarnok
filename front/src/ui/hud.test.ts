// @vitest-environment jsdom
import { SYNERGY_MAX } from '@shared/constants';
import { beforeEach, describe, expect, it } from 'vitest';

// `?raw` de Vite : le HTML entre dans le bundle de test tel quel, meme motif
// que `draft.test.ts` — c'est ce qui permet de verifier le CABLAGE vers
// `index.html` et pas seulement la fonction qui ecrit dedans.
import indexHtml from '../../index.html?raw';
import type { HudInfo } from '../render/stage';
import { type HudElements, paintHud, paintSynergy, synergyRatio } from './hud';

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

/**
 * Tache 9 bis : le HUD entier, monte sur le vrai `index.html`.
 *
 * ⚠️ **C'est ici que meurt la mutation « `paintSynergy` retiree ».** Avant
 * cette suite, l'appel vivait dans `main.ts` : la fonction etait gardee, le
 * fait de l'appeler ne l'etait pas. La distinction n'est pas theorique — trois
 * etapes de suite ont perdu une ligne de cablage exactement comme ca.
 */
function hudElements(): HudElements {
  document.body.innerHTML = indexHtml;
  const pick = (id: string): HTMLElement => {
    const node = document.getElementById(id);
    if (!node) {
      throw new Error(`#${id} absent de index.html`);
    }
    return node;
  };
  return {
    hp: pick('hud-hp'),
    level: pick('hud-level'),
    timer: pick('hud-timer'),
    lateDeaths: pick('hud-late-deaths'),
    synergyFill: pick('hud-synergy-fill'),
    synergyLabel: pick('hud-synergy-label'),
    freeze: pick('hud-freeze'),
  };
}

const INFO: HudInfo = { hp: 73, xp: 500, level: 4, timer: '2:07', frozen: false };

describe('paintHud — chaque case du HUD recoit son ecriture', () => {
  let el: HudElements;

  beforeEach(() => {
    el = hudElements();
  });

  it('ecrit les points de vie du joueur local', () => {
    paintHud(el, INFO, 0, 0);
    expect(el.hp.textContent).toBe('73');
  });

  it('ecrit le niveau', () => {
    paintHud(el, INFO, 0, 0);
    expect(el.level.textContent).toBe('4');
  });

  it('ecrit le chronometre, prefixe', () => {
    paintHud(el, INFO, 0, 0);
    expect(el.timer.textContent).toBe('Temps 2:07');
  });

  it('ecrit le compteur de morts tardives — le chiffre de diagnostic du §2', () => {
    paintHud(el, INFO, 12, 0);
    expect(el.lateDeaths.textContent).toBe('12');
  });

  it('peint la jauge de Synergie', () => {
    paintHud(el, INFO, 0, SYNERGY_MAX / 2);
    expect(el.synergyFill.style.width).toBe('50%');
    expect(el.synergyLabel.textContent).toBe(`${SYNERGY_MAX / 2} / ${SYNERGY_MAX}`);
  });

  /** Tache 24 : le gel de niveau, la dette non gardee de l'etape 3. */
  it('montre le bandeau de gel pendant le gel, et le cache sinon', () => {
    paintHud(el, { ...INFO, frozen: true }, 0, 0);
    expect(el.freeze.classList.contains('hidden')).toBe(false);

    paintHud(el, { ...INFO, frozen: false }, 0, 0);
    expect(el.freeze.classList.contains('hidden')).toBe(true);
  });
});
