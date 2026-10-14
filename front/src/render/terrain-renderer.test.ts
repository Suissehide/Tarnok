import { TERRAIN, type WorldMap } from '@shared/worldmap';
import { describe, expect, it } from 'vitest';

import {
  coastCells,
  detailCells,
  groundTiles,
  PATCHES,
  patchWeight,
  SHADE_MIN,
} from './terrain-renderer';

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

/** Les tuiles de FOND (teinte 1) d'une case : les plaques de couleur sont testees a part. */
const at = (tiles: ReturnType<typeof groundTiles>, x: number, y: number) =>
  tiles.filter((t) => t.x === x * 64 && t.y === y * 64 && t.color === 1);

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

  it('retourne les tuiles de milieu des quatre facons, sans jamais les tourner', () => {
    const facons = new Set(milieux.map((t) => `${t.flipX}${t.flipY}`));
    expect(facons).toEqual(new Set(['falsefalse', 'truefalse', 'falsetrue', 'truetrue']));
    expect(milieux[0]).not.toHaveProperty('turn');
  });

  it('ne retourne jamais une tuile de bord : son liseret doit rester du bon cote', () => {
    for (const t of tiles.filter((t) => !(t.sx === 64 && t.sy === 64))) {
      expect(t.flipX).toBe(false);
      expect(t.flipY).toBe(false);
    }
  });

  it('varie la luminosite dans [SHADE_MIN, 1], identiquement a chaque appel', () => {
    const shades = tiles.map((t) => t.shade);
    expect(Math.min(...shades)).toBeGreaterThanOrEqual(SHADE_MIN);
    expect(Math.max(...shades)).toBeLessThanOrEqual(1);
    expect(new Set(shades).size).toBeGreaterThan(1);
    expect(groundTiles(grande)).toEqual(tiles);
  });

  it('retourne aussi le milieu du dessus d un plateau', () => {
    const plateau = groundTiles(
      carte(['.......', '.PPPPP.', '.PPPPP.', '.PPPPP.', '.CCCCC.', '.......']),
    ).filter((t) => t.sx === 6 * 64 && t.sy === 64);
    expect(plateau.length).toBeGreaterThan(0);
    expect(plateau.some((t) => t.flipX || t.flipY)).toBe(true);
  });
});

describe('les plaques de couleur', () => {
  it('chaque teinte couvre une partie de l ile, jamais toute, avec des poids intermediaires', () => {
    for (const p of PATCHES) {
      const w = Array.from({ length: 60 * 60 }, (_, i) =>
        patchWeight(p, i % 60, Math.floor(i / 60)),
      );
      expect(w.some((v) => v === 0)).toBe(true);
      expect(w.some((v) => v > 0.9)).toBe(true);
      // Le degrade : des cellules a mi-chemin, pas un bord net.
      expect(w.some((v) => v > 0.2 && v < 0.8)).toBe(true);
    }
  });

  it('une plaque ne recouvre jamais une falaise', () => {
    const tiles = groundTiles(carte(['.......', '.PPPPP.', '.PPPPP.', '.CCCCC.', '.......']));
    expect(tiles.filter((t) => t.sy === 5 * 64 && t.color !== 1)).toEqual([]);
  });
});

describe('detailCells — les petits details du pack, en taches', () => {
  const ile = carte(
    Array.from({ length: 60 }, (_, y) =>
      y === 0 || y === 59 ? '~'.repeat(60) : `~${'.'.repeat(58)}~`,
    ),
  );
  const d = detailCells(ile);
  const libres = 58 * 58;

  it('seme peu, et en taches : une minorite de l herbe, toujours au meme endroit', () => {
    expect(d.length).toBeGreaterThan(0);
    expect(d.length).toBeLessThan(libres * 0.12);
    expect(detailCells(ile)).toEqual(d);
  });

  it('les details se tiennent en grappes : la plupart ont un voisin a moins de deux cellules', () => {
    const voisins = d.filter((a) =>
      d.some((b) => b !== a && Math.hypot(a.x - b.x, a.y - b.y) < 2 * 64),
    ).length;
    expect(voisins / d.length).toBeGreaterThan(0.7);
  });

  it('surtout des touffes et des cailloux, le reste rare', () => {
    const courants = d.filter((x) => x.kind >= 4 && x.kind <= 11).length;
    expect(courants / d.length).toBeGreaterThan(0.7);
    expect(d.every((x) => x.kind >= 1 && x.kind <= 18)).toBe(true);
  });

  it('jamais sur une cellule bloquee', () => {
    const bloquee = { ...ile, blocked: new Uint8Array(ile.blocked.length).fill(1) };
    expect(detailCells(bloquee)).toEqual([]);
  });
});
