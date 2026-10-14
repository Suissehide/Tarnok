// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { showTab, wireOptions } from './options';
import { DEFAULT_SETTINGS } from './settings';

/** Un ecran d'options minimal, avec la structure de `index.html`. */
function ecran(): HTMLElement {
  const root = document.createElement('section');
  root.innerHTML = `
    <button data-tab="jeu"></button><button data-tab="commandes"></button>
    <div data-panel="jeu">
      <div data-setting="minimap">
        <button data-value="true"></button><button data-value="false"></button>
      </div>
    </div>
    <div data-panel="commandes"><ul id="options-controls"></ul></div>
    <button id="options-apply"></button><button id="options-back"></button>`;
  return root;
}

describe('l ecran d options', () => {
  it('une bascule change le brouillon, et seul Appliquer le rend', () => {
    const root = ecran();
    const onApply = vi.fn();
    const o = wireOptions(root, () => DEFAULT_SETTINGS, onApply, vi.fn());
    o.open();
    const masquee = root.querySelector<HTMLButtonElement>('[data-value="false"]');
    masquee?.click();
    expect(masquee?.getAttribute('aria-pressed')).toBe('true');
    expect(onApply).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('#options-apply')?.click();
    expect(onApply).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, minimap: false });
  });

  it('Retour ferme sans rien garder, et rouvrir repart des options gardees', () => {
    const root = ecran();
    const onApply = vi.fn();
    const onBack = vi.fn();
    const o = wireOptions(root, () => DEFAULT_SETTINGS, onApply, onBack);
    o.open();
    root.querySelector<HTMLButtonElement>('[data-value="false"]')?.click();
    root.querySelector<HTMLButtonElement>('#options-back')?.click();
    expect(onBack).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    o.open();
    expect(root.querySelector('[data-value="true"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('un onglet montre son panneau et cache les autres, et les commandes sont listees', () => {
    const root = ecran();
    wireOptions(root, () => DEFAULT_SETTINGS, vi.fn(), vi.fn());
    showTab(root, 'commandes');
    expect(root.querySelector('[data-panel="jeu"]')?.classList.contains('hidden')).toBe(true);
    expect(root.querySelector('[data-panel="commandes"]')?.classList.contains('hidden')).toBe(
      false,
    );
    expect(root.querySelectorAll('#options-controls li').length).toBeGreaterThan(3);
  });
});
