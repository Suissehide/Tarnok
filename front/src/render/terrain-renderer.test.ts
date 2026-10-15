import { TERRAIN, type WorldMap } from '@shared/worldmap';
import { describe, expect, it } from 'vitest';

import {
  BIOME_COLORS,
  biomeLayers,
  coastCells,
  detailCells,
  groundTiles,
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

/**
 * Les tuiles de FOND d'une case — l'herbe en teinte 1 et le relief, quelle que
 * soit sa teinte : les plaques de biome sont testees a part.
 */
const at = (tiles: ReturnType<typeof groundTiles>, x: number, y: number) =>
  tiles.filter((t) => t.x === x * 64 && t.y === y * 64 && (t.color === 1 || t.sx >= 5 * 64));

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

describe('les biomes', () => {
  const ile = (n: number, bord = 1) =>
    carte(
      Array.from({ length: n }, (_, y) =>
        y < bord || y >= n - bord
          ? '~'.repeat(n)
          : `${'~'.repeat(bord)}${'.'.repeat(n - 2 * bord)}${'~'.repeat(bord)}`,
      ),
    );
  const grande = ile(94);
  const layers = biomeLayers(grande);

  it('le fond est plein, chaque calque dans [0, 1]', () => {
    expect(layers[0]?.every((v) => v === 1)).toBe(true);
    for (const l of layers) {
      expect(l.every((v) => v >= 0 && v <= 1)).toBe(true);
    }
  });

  it('les cinq teintes regnent quelque part, et se fondent aux frontieres', () => {
    // La teinte visible d'une cellule : le plus haut calque presque opaque.
    const visible = new Set<number>();
    for (let i = 0; i < grande.cols * grande.rows; i++) {
      let top = 1;
      for (const c of BIOME_COLORS) {
        if ((layers[c - 1]?.[i] ?? 0) > 0.99) {
          top = c;
        }
      }
      visible.add(top);
    }
    expect(visible).toEqual(new Set(BIOME_COLORS));
    expect(layers.slice(1).some((l) => l.some((v) => v > 0.2 && v < 0.8))).toBe(true);
  });

  it('stable pour une meme carte, differente d une carte a l autre', () => {
    expect(biomeLayers(grande)).toEqual(layers);
    expect(biomeLayers(ile(94, 2))).not.toEqual(layers);
  });

  it('chaque plateau prend une seule teinte, falaise comprise, sans plaque par-dessus', () => {
    // Des plateaux semes sur toute l'ile : au moins l'un sort de la teinte 1.
    const lignes = Array.from({ length: 94 }, (_, y) => {
      if (y === 0 || y === 93) {
        return '~'.repeat(94);
      }
      const motif = y % 8 === 3 || y % 8 === 4 ? 'PPPP' : y % 8 === 5 ? 'CCCC' : '....';
      return `~..${`${motif}....`.repeat(11)}${'.'.repeat(2)}~`;
    });
    const tiles = groundTiles(carte(lignes));
    const relief = tiles.filter((t) => t.sx >= 5 * 64);
    expect(relief.filter((t) => t.alpha !== 1)).toEqual([]);
    // Un plateau = un bloc 4 x 3 : ses tuiles partagent la teinte.
    const parPlateau = new Map<string, Set<number>>();
    for (const t of relief) {
      const k = `${Math.floor((t.x / 64 - 3) / 8)},${Math.floor(t.y / 64 / 8)}`;
      parPlateau.set(k, (parPlateau.get(k) ?? new Set()).add(t.color));
    }
    expect([...parPlateau.values()].every((c) => c.size === 1)).toBe(true);
    expect(relief.some((t) => t.color !== 1)).toBe(true);
    // Une tuile de relief par case : aucune plaque de biome posee dessus.
    expect(new Set(relief.map((t) => `${t.x},${t.y}`)).size).toBe(relief.length);
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
    const bloquee = {
      ...ile,
      blocked: new Uint8Array(ile.blocked.length).fill(1),
    };
    expect(detailCells(bloquee)).toEqual([]);
  });
});
