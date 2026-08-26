import { TICK_HZ } from '@shared/constants';
import { describe, expect, it } from 'vitest';

import type { RenderState } from '../net/client';
import { formatSummary, formatTimer, hudInfo } from './stage';

/**
 * `hudInfo`/`formatSummary`/`formatTimer` sont des fonctions PURES, sans Pixi
 * ni `document` — voir leur doc dans `stage.ts`. C'est ce qui les rend
 * testables sans navigateur : `Stage` lui-meme (Pixi `Application`) ne l'est
 * pas dans cet environnement (`vitest`, `environment: 'node'`), donc c'est ici
 * — et seulement ici — que « le HUD reflete les pv et l'xp du snapshot » et
 * « le bilan affiche les chiffres portes par RUN_OVER » peuvent s'asserter.
 */
describe('hudInfo — le HUD reflete les pv et l xp du snapshot', () => {
  it('lit les pv du joueur local, pas d un autre joueur', () => {
    const state: RenderState = {
      localId: 2,
      xp: 0,
      players: [
        { id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 },
        { id: 2, x: 0, y: 0, hp: 37, aimX: 0, aimY: 0 },
      ],
    };

    expect(hudInfo(state, 1, 0).hp).toBe(37);
  });

  it("reprend l'xp d'equipe telle que portee par RenderState.xp", () => {
    const state: RenderState = {
      localId: 1,
      xp: 654,
      players: [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }],
    };

    expect(hudInfo(state, 1, 0).xp).toBe(654);
  });

  it('reprend le niveau tel que fourni par l appelant (GameClient.level), pas derive de l etat', () => {
    const state: RenderState = {
      localId: 1,
      xp: 0,
      players: [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }],
    };

    expect(hudInfo(state, 5, 0).level).toBe(5);
  });

  it('rend hp=0 quand le joueur local est absent de RenderState.players (pas encore de WELCOME)', () => {
    const state: RenderState = { localId: null, xp: 0, players: [] };

    expect(hudInfo(state, 1, 0).hp).toBe(0);
  });

  it(
    "reprend l'indicateur de gel tel que fourni par l appelant (GameClient.isFrozen), " +
      'pas derive de l etat (tache 24) — et vaut faux par defaut',
    () => {
      const state: RenderState = {
        localId: 1,
        xp: 0,
        players: [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }],
      };

      expect(hudInfo(state, 1, 0, true).frozen).toBe(true);
      expect(hudInfo(state, 1, 0, false).frozen).toBe(false);
      expect(hudInfo(state, 1, 0).frozen).toBe(false);
    },
  );
});

describe('formatTimer — ticks -> m:ss, a TICK_HZ pas par seconde', () => {
  it('formate zero tick', () => {
    expect(formatTimer(0)).toBe('0:00');
  });

  it('formate moins d une minute avec le zero de tete', () => {
    expect(formatTimer(9 * TICK_HZ)).toBe('0:09');
  });

  it('formate plusieurs minutes', () => {
    // 2 min 5 s = 125 s, a TICK_HZ pas par seconde.
    expect(formatTimer(125 * TICK_HZ)).toBe('2:05');
  });
});

describe('formatSummary — le bilan affiche les chiffres portes par RUN_OVER', () => {
  it('reprend survivedTicks/level/kills du message, sans les permuter', () => {
    const info = formatSummary({ survivedTicks: 90 * TICK_HZ, level: 6, kills: 213 });

    expect(info).toEqual({ time: '1:30', level: 6, kills: 213 });
  });
});
