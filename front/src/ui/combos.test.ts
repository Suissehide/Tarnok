// @vitest-environment jsdom
import { ELEMENT, ELEMENTS } from '@shared/elements';
import { packElementPair } from '@shared/protocol';
import { REACTION, REACTION_DEFS, reactionForPair } from '@shared/reactions';
import { describe, expect, it } from 'vitest';

import { COMBO_IDS, reactionHelp, renderCombos } from './combos';

describe('aide des combinaisons', () => {
  it('chaque reaction de la table a une aide dont le couple est le sien', () => {
    for (const def of REACTION_DEFS) {
      const help = reactionHelp(def.id);
      expect(packElementPair(help.a, help.b)).toBe(def.pair);
      expect(help.title.length).toBeGreaterThan(0);
      expect(help.effect.length).toBeGreaterThan(0);
      expect(help.effect.length).toBeLessThanOrEqual(60);
      expect(help.effect).not.toMatch(/\d/);
    }
  });

  it('le Choc thermique est la seule paire generique, et c est Braise + Givre', () => {
    const choc = reactionHelp(REACTION.AUCUNE);
    expect(packElementPair(choc.a, choc.b)).toBe(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE));
    expect(reactionForPair(packElementPair(choc.a, choc.b))).toBeUndefined();
  });

  it('couvre toutes les paires d elements non neutres, sans doublon', () => {
    const actifs = ELEMENTS.filter((e) => e.id !== ELEMENT.NEUTRE).length;
    const paires = new Set(
      COMBO_IDS.map((id) => packElementPair(reactionHelp(id).a, reactionHelp(id).b)),
    );
    expect(paires.size).toBe((actifs * (actifs - 1)) / 2);
    expect(COMBO_IDS.length).toBe(paires.size);
  });

  it('une ligne par entree de REACTION_DEFS, plus le Choc thermique', () => {
    const root = document.createElement('div');
    renderCombos(root, new Set());
    const rows = [...root.querySelectorAll<HTMLElement>('.combo')];
    expect(rows.length).toBe(REACTION_DEFS.length + 1);
    for (const def of REACTION_DEFS) {
      expect(rows.filter((r) => r.dataset.reaction === String(def.id))).toHaveLength(1);
    }
  });

  it('active une reaction ssi ses deux elements sont connus', () => {
    const known = new Set<number>([ELEMENT.BRAISE, ELEMENT.FOUDRE, ELEMENT.POIX]);
    const root = document.createElement('div');
    renderCombos(root, known);
    for (const row of root.querySelectorAll<HTMLElement>('.combo')) {
      const { a, b } = reactionHelp(Number(row.dataset.reaction));
      expect(row.dataset.active).toBe(String(known.has(a) && known.has(b)));
    }
    const actives = root.querySelectorAll('[data-active="true"]');
    expect(actives).toHaveLength(3); // Surchauffe, Embrasement, Court-circuit
  });

  it('une reaction dont un seul element est tenu est a completer, pas attenuee', () => {
    const root = document.createElement('div');
    renderCombos(root, new Set([ELEMENT.BRAISE]));
    for (const row of root.querySelectorAll<HTMLElement>('.combo')) {
      const { a, b } = reactionHelp(Number(row.dataset.reaction));
      const un = (a === ELEMENT.BRAISE) !== (b === ELEMENT.BRAISE);
      expect(row.dataset.partial, row.dataset.reaction).toBe(String(un));
      expect(row.dataset.active).toBe('false');
    }
  });

  it('un nouveau rendu remplace l ancien', () => {
    const root = document.createElement('div');
    renderCombos(root, new Set());
    renderCombos(root, new Set());
    expect(root.querySelectorAll('.combo')).toHaveLength(COMBO_IDS.length);
  });
});
