// @vitest-environment jsdom
import { ELEMENTS } from '@shared/elements';
import { describe, expect, it } from 'vitest';

import { elementBadge, elementIconSvg, elementLabel } from './element-icons';

describe('icones d element', () => {
  it('chaque element a une icone svg, toutes distinctes', () => {
    const svgs = ELEMENTS.map((e) => elementIconSvg(e.id));
    for (const svg of svgs) {
      expect(svg.startsWith('<svg')).toBe(true);
    }
    expect(new Set(svgs).size).toBe(ELEMENTS.length);
  });

  it('respecte la taille demandee', () => {
    expect(elementIconSvg(1, 40)).toContain('width="40" height="40"');
  });

  it('refuse un element inconnu', () => {
    expect(() => elementIconSvg(ELEMENTS.length)).toThrow();
  });

  it('le libelle est le nom capitalise', () => {
    expect(elementLabel(1)).toBe('Braise');
    expect(ELEMENTS.map((e) => elementLabel(e.id))).toContain('Vif-argent');
  });

  it('le badge porte le nom en infobulle et un svg parsable', () => {
    for (const e of ELEMENTS) {
      const badge = elementBadge(e.id);
      expect(badge.classList.contains('element-badge')).toBe(true);
      expect(badge.title).toBe(elementLabel(e.id));
      expect(badge.querySelector('svg')).not.toBeNull();
    }
  });
});
