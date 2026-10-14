import { TERRAIN, type WorldMap } from '@shared/worldmap';
import { describe, expect, it } from 'vitest';

import { coastCells, groundTiles, SHADE_MIN } from './terrain-renderer';

/** Une carte a partir de lignes : `~` eau, `.` herbe, `P` plateau, `C` falaise. */
function carte(lignes: string[]): WorldMap {
  const rows = lignes.length;
  const cols = lignes[0]?.length ?? 0;
  const code: Record<string, number> = {
    '~': TERRAIN.WATER,
    '.': TERRAIN.GRASS,
    P: TERRAIN.PLATEAU,
    C: TERRAIN.CLIFF,
  };
  const terrain = new Uint8Array(
    lignes
      .join('')
      .split('')
      .map((c) => code[c] ?? 0),
  );
  return {
    cols,
    rows,
    terrain,
    deco: new Uint8Array(cols * rows),
    blocked: new Uint8Array(cols * rows),
  };
}

const at = (tiles: ReturnType<typeof groundTiles>, x: number, y: number) =>
  tiles.filter((t) => t.x === x * 64 && t.y === y * 64);

describe('groundTiles — l autotuile du pack', () => {
  it('choisit coin, bord et milieu de l herbe selon ses voisins', () => {
    const tiles = groundTiles(carte(['~~~~~', '~...~', '~...~', '~...~', '~~~~~']));
    // Coin haut-gauche : debut sur les deux axes.
    expect(at(tiles, 1, 1)[0]).toMatchObject({ sx: 0, sy: 0 });
    // Milieu.
    expect(at(tiles, 2, 2)[0]).toMatchObject({ sx: 64, sy: 64 });
    // Coin bas-droit : fin sur les deux axes.
    expect(at(tiles, 3, 3)[0]).toMatchObject({ sx: 128, sy: 128 });
    // Rien sur l'eau.
    expect(at(tiles, 0, 0)).toHaveLength(0);
  });

  it('une cellule isolee prend la tuile seule (colonne et rangee 3)', () => {
    const tiles = groundTiles(carte(['~~~', '~.~', '~~~']));
    expect(at(tiles, 1, 1)[0]).toMatchObject({ sx: 192, sy: 192 });
  });

  it('un plateau pose son dessus PAR-DESSUS l herbe, et sa falaise en rangee 5', () => {
    const tiles = groundTiles(carte(['.....', '.PPP.', '.CCC.', '.....']));
    const dessus = at(tiles, 1, 1);
    expect(dessus).toHaveLength(2);
    expect(dessus[1]).toMatchObject({ sx: 5 * 64, sy: 3 * 64 });
    const falaise = at(tiles, 2, 2);
    expect(falaise[1]).toMatchObject({ sx: 6 * 64, sy: 5 * 64 });
  });
});

describe('coastCells — l ecume', () => {
  it('ne retient que la terre qui touche l eau', () => {
    const cells = coastCells(carte(['~~~~~', '~...~', '~...~', '~...~', '~~~~~']));
    expect(cells).toHaveLength(8);
    expect(cells).not.toContainEqual({ x: 2 * 64 + 32, y: 2 * 64 + 32 });
  });
});

describe('groundTiles — la variation de l herbe', () => {
  const grande = carte(
    Array.from({ length: 12 }, (_, y) =>
      y === 0 || y === 11 ? '~'.repeat(12) : `~${'.'.repeat(10)}~`,
    ),
  );
  const tiles = groundTiles(grande);
  const milieux = tiles.filter((t) => t.sx === 64 && t.sy === 64);

  it('tourne et retourne les tuiles de milieu, de toutes les facons', () => {
    expect(new Set(milieux.map((t) => t.turn))).toEqual(new Set([0, 1, 2, 3]));
    expect(milieux.some((t) => t.flip)).toBe(true);
    expect(milieux.some((t) => !t.flip)).toBe(true);
  });

  it('ne tourne jamais une tuile de bord : son liseret doit rester du bon cote', () => {
    for (const t of tiles.filter((t) => !(t.sx === 64 && t.sy === 64))) {
      expect(t.turn).toBe(0);
      expect(t.flip).toBe(false);
    }
  });

  it('varie la luminosite dans [SHADE_MIN, 1], identiquement a chaque appel', () => {
    const shades = tiles.map((t) => t.shade);
    expect(Math.min(...shades)).toBeGreaterThanOrEqual(SHADE_MIN);
    expect(Math.max(...shades)).toBeLessThanOrEqual(1);
    expect(new Set(shades).size).toBeGreaterThan(1);
    expect(groundTiles(grande)).toEqual(tiles);
  });

  it('tourne aussi le milieu du dessus d un plateau', () => {
    const plateau = groundTiles(
      carte(['.......', '.PPPPP.', '.PPPPP.', '.PPPPP.', '.CCCCC.', '.......']),
    ).filter((t) => t.sx === 6 * 64 && t.sy === 64);
    expect(plateau.length).toBeGreaterThan(0);
    expect(plateau.some((t) => t.turn !== 0 || t.flip)).toBe(true);
  });
});
