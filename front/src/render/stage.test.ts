import { TICK_HZ } from '@shared/constants';
import { describe, expect, it } from 'vitest';

import type { RenderState } from '../net/client';
import { formatSummary, formatTimer, hudInfo, obstacleCells } from './stage';

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
      synergy: 0,
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
      synergy: 0,
      players: [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }],
    };

    expect(hudInfo(state, 1, 0).xp).toBe(654);
  });

  it('reprend le niveau tel que fourni par l appelant (GameClient.level), pas derive de l etat', () => {
    const state: RenderState = {
      localId: 1,
      xp: 0,
      synergy: 0,
      players: [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0 }],
    };

    expect(hudInfo(state, 5, 0).level).toBe(5);
  });

  it('rend hp=0 quand le joueur local est absent de RenderState.players (pas encore de WELCOME)', () => {
    const state: RenderState = { localId: null, xp: 0, synergy: 0, players: [] };

    expect(hudInfo(state, 1, 0).hp).toBe(0);
  });

  it(
    "reprend l'indicateur de gel tel que fourni par l appelant (GameClient.isFrozen), " +
      'pas derive de l etat (tache 24) — et vaut faux par defaut',
    () => {
      const state: RenderState = {
        localId: 1,
        xp: 0,
        synergy: 0,
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

/**
 * `obstacleCells` est PURE (voir sa doc dans `stage.ts`) : c'est elle qui
 * porte « le rendu consulte le meme masque que le champ de flux » (tache
 * 28). `mapObstacles` (la construction Pixi elle-meme) n'est en revanche pas
 * testable ici, meme raison que `Stage` — pas de canevas sous `vitest`.
 */
describe('obstacleCells — geometrie des cellules bloquees, pour le dessin des obstacles (tache 28)', () => {
  it('rend le coin haut-gauche de chaque cellule bloquee, a la bonne position (pas de transposition ligne/colonne)', () => {
    // Mutation testee : indexer `mask` par `cx * rows + cy` au lieu de
    // `cy * cols + cx` (confusion ligne/colonne facile a commettre) deplace
    // les rectangles rendus sur une carte non carree comme celle-ci
    // (cols=3, rows=2) — un damier carre ne le detecterait pas.
    const cols = 3;
    const rows = 2;
    const cellSize = 10;
    const mask = new Uint8Array(cols * rows);
    mask[2] = 1; // (cx=2, cy=0)
    mask[3] = 1; // (cx=0, cy=1)
    mask[5] = 1; // (cx=2, cy=1) — derniere cellule : verifie que la derniere ligne est bien parcourue.

    const cells = obstacleCells(mask, cols, rows, cellSize);

    expect(cells).toEqual([
      { x: 20, y: 0 },
      { x: 0, y: 10 },
      { x: 20, y: 10 },
    ]);
  });

  it('ne rend aucune cellule pour un masque entierement libre', () => {
    // Mutation testee : une garde inversee (`=== 0` au lieu de `!== 0`, ou un
    // `?? 1` au lieu de `?? 0`) ferait apparaitre des rochers sur une carte
    // sans le moindre obstacle.
    const mask = new Uint8Array(6);

    expect(obstacleCells(mask, 3, 2, 10)).toEqual([]);
  });
});
