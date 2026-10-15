// @vitest-environment jsdom
import { CLASSES } from '@shared/classes';
import { PASSIVES } from '@shared/passives';
import { WEAPONS, weaponOf } from '@shared/weapons';
import { describe, expect, it } from 'vitest';

// `?raw` de Vite, comme `shop.test.ts` : le vrai `index.html` entre dans le
// bundle de test, donc c'est le CABLAGE qu'on verifie (les `id` et les
// `data-panel` que `guide.ts` cherche existent reellement) et pas seulement la
// logique d'affichage.
import indexHtml from '../../index.html?raw';
import { COMBO_IDS } from './combos';
import { GUIDE_FIRST_TAB, weaponTraits, wireGuide } from './guide';

function ecran(): HTMLElement {
  document.body.innerHTML = indexHtml;
  const root = document.querySelector<HTMLElement>('#guide-screen');
  if (!root) {
    throw new Error('#guide-screen absent de index.html');
  }
  wireGuide(root);
  return root;
}

describe('le Guide', () => {
  it('cable les cinq panneaux du HTML, et ouvre les bases', () => {
    const root = ecran();
    const panneaux = [...root.querySelectorAll<HTMLElement>('[data-panel]')];
    expect(panneaux.map((p) => p.dataset.panel)).toEqual([
      'bases',
      'armes',
      'passifs',
      'combinaisons',
      'classes',
    ]);
    // Un onglet par panneau, ni plus ni moins : un onglet orphelin n'ouvrirait rien.
    expect([...root.querySelectorAll<HTMLElement>('[data-tab]')].map((b) => b.dataset.tab)).toEqual(
      panneaux.map((p) => p.dataset.panel),
    );
    for (const p of panneaux) {
      expect(p.classList.contains('hidden')).toBe(p.dataset.panel !== GUIDE_FIRST_TAB);
    }
  });

  it('montre TOUT le catalogue : chaque arme, chaque passif, chaque combinaison, chaque classe', () => {
    const root = ecran();
    const ids = (sel: string, attr: string): string[] =>
      [...root.querySelectorAll<HTMLElement>(sel)].map((e) => e.dataset[attr] ?? '');
    expect(new Set(ids('#guide-weapons [data-weapon-id]', 'weaponId'))).toEqual(
      new Set(WEAPONS.map((w) => String(w.id))),
    );
    expect(new Set(ids('#guide-passives [data-passive-id]', 'passiveId'))).toEqual(
      new Set(PASSIVES.map((p) => String(p.id))),
    );
    // Les quinze reactions, plus la ligne du neutre.
    expect(ids('#guide-combos [data-reaction]', 'reaction')).toEqual([
      ...COMBO_IDS.map(String),
      'neutre',
    ]);
    expect(new Set(ids('#guide-classes [data-classe]', 'classe'))).toEqual(
      new Set(CLASSES.map((c) => String(c.id))),
    );
  });

  it('aucune entree vide : un intitule et au moins une ligne de fond partout', () => {
    const root = ecran();
    const entrees = [...root.querySelectorAll<HTMLElement>('.guide-entry')];
    expect(entrees.length).toBeGreaterThan(0);
    for (const e of entrees) {
      expect(e.querySelector('.guide-entry__head')?.textContent?.trim()).toBeTruthy();
      expect(e.querySelectorAll('.guide-entry__line').length).toBeGreaterThan(0);
      for (const ligne of e.querySelectorAll('.guide-entry__line')) {
        expect(ligne.textContent?.trim()).toBeTruthy();
      }
    }
  });

  /**
   * ⚠️ **Le reglage du catalogue doit traverser jusqu'a l'ecran.** Le Guide
   * n'existe que pour ca : une page d'aide qui recopierait les chiffres
   * deviendrait fausse a la premiere retouche d'equilibrage, sans que rien ne
   * le dise. On verifie donc que les degats de l'arme sortent de la table.
   */
  it('les degats affiches sont ceux de la table, arme par arme', () => {
    const root = ecran();
    for (const w of WEAPONS) {
      const entree = root.querySelector<HTMLElement>(`[data-weapon-id="${w.id}"]`);
      expect(entree?.textContent).toContain(`${w.damage} dégâts`);
      expect(entree?.textContent).toContain(w.name);
    }
  });

  /**
   * `blastRadius` ne dit pas la meme chose selon la famille : pour un halo,
   * un faisceau ou une invocation, c'est sa PORTEE — annoncer « explose » la
   * dirait projectile alors que rien ne part.
   */
  it('seul un tir peut annoncer une explosion', () => {
    for (const w of WEAPONS) {
      if (w.kind !== 'tir') {
        expect(weaponTraits(w).join(' ')).not.toContain('Explose');
      }
    }
    const grenade = WEAPONS.find((w) => w.kind === 'tir' && w.blastRadius > 0);
    expect(grenade).toBeDefined();
    expect(weaponTraits(weaponOf(grenade?.id ?? 0)).join(' ')).toContain('Explose');
  });
});
