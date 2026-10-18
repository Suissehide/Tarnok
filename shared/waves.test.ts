import { describe, expect, it } from 'vitest';

import { FLOWFIELD_CELL, MAP_SIZE } from './constants';
import {
  ENCIRCLE_RADIUS,
  FORMATION,
  formationPositions,
  type ObstacleField,
  type WaveOrder,
} from './waves';

function order(overrides: Partial<WaveOrder> = {}): WaveOrder {
  return {
    waveId: 1,
    spawnTick: 100,
    seed: 0xabc_def,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: 3000,
    anchorY: 3000,
    count: 200,
    ...overrides,
  };
}

function positionsOf(o: WaveOrder): { x: Float32Array; y: Float32Array } {
  const x = new Float32Array(o.count);
  const y = new Float32Array(o.count);
  formationPositions(o, x, y);
  return { x, y };
}

describe('formationPositions', () => {
  it('rend exactement les memes positions pour la meme graine', () => {
    const a = positionsOf(order());
    const b = positionsOf(order());

    expect([...a.x]).toEqual([...b.x]);
    expect([...a.y]).toEqual([...b.y]);
  });

  it('rend des positions differentes pour une graine differente', () => {
    const a = positionsOf(order({ seed: 1 }));
    const b = positionsOf(order({ seed: 2 }));

    expect([...a.x]).not.toEqual([...b.x]);
  });

  it('remplit toutes les entites demandees', () => {
    const { x } = positionsOf(order({ count: 500 }));

    // Une position non ecrite resterait a 0, tres loin de l'ancre.
    for (let i = 0; i < 500; i++) {
      expect(Math.abs((x[i] ?? 0) - 3000)).toBeLessThan(2000);
    }
  });

  it('groupe RING sur un anneau autour de l ancre', () => {
    const { x, y } = positionsOf(order({ formation: FORMATION.RING, count: 100 }));

    const rayons: number[] = [];
    for (let i = 0; i < 100; i++) {
      rayons.push(Math.hypot((x[i] ?? 0) - 3000, (y[i] ?? 0) - 3000));
    }
    const min = Math.min(...rayons);
    const max = Math.max(...rayons);

    // Un anneau, pas un disque : le rayon varie peu.
    expect(min).toBeGreaterThan(100);
    expect(max - min).toBeLessThan(120);
  });

  it('rend CLUSTER plus dense que SCATTER', () => {
    const scatter = positionsOf(order({ formation: FORMATION.SCATTER, count: 300 }));
    const cluster = positionsOf(order({ formation: FORMATION.CLUSTER, count: 300 }));

    expect(meanNearestNeighbour(cluster)).toBeLessThan(meanNearestNeighbour(scatter));
  });

  it('borne toutes les positions a la carte', () => {
    const { x, y } = positionsOf(order({ anchorX: 20, anchorY: 20, count: 300 }));

    for (let i = 0; i < 300; i++) {
      expect(x[i]).toBeGreaterThanOrEqual(0);
      expect(y[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('ne laisse aucune position depasser MAP_SIZE', () => {
    const { x, y } = positionsOf(
      order({ anchorX: MAP_SIZE - 20, anchorY: MAP_SIZE - 20, count: 300 }),
    );

    for (let i = 0; i < 300; i++) {
      expect(x[i]).toBeLessThanOrEqual(MAP_SIZE);
      expect(y[i]).toBeLessThanOrEqual(MAP_SIZE);
    }
  });
});

/**
 * Ecarts angulaires entre entites consecutives, vues depuis l'ancre, triees —
 * le dernier est le plus grand TROU du cercle. C'est la mesure qui distingue un
 * encerclement d'un anneau : un anneau tire au hasard a le meme rayon, la meme
 * moyenne, et laisse pourtant des trous.
 */
function angularGaps(o: WaveOrder): number[] {
  const { x, y } = positionsOf(o);
  const angles: number[] = [];
  for (let i = 0; i < o.count; i++) {
    const a = Math.atan2((y[i] ?? 0) - o.anchorY, (x[i] ?? 0) - o.anchorX);
    angles.push(a < 0 ? a + Math.PI * 2 : a);
  }
  angles.sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < angles.length; i++) {
    gaps.push((angles[i] ?? 0) - (angles[i - 1] ?? 0));
  }
  // Le tour se referme : l'ecart entre le dernier et le premier compte aussi.
  gaps.push((angles[0] ?? 0) + Math.PI * 2 - (angles[angles.length - 1] ?? 0));
  return gaps.sort((a, b) => a - b);
}

function maxGap(o: WaveOrder): number {
  const gaps = angularGaps(o);
  return gaps[gaps.length - 1] ?? 0;
}

describe('FORMATION.ENCIRCLE — la vague encercle le joueur (etape 6a, tache 18)', () => {
  /** Effectifs realistes d'une premiere vague, plus deux plus gros. */
  const EFFECTIFS = [8, 12, 20, 40];
  const GRAINES = Array.from({ length: 40 }, (_, i) => i + 1);

  it('fait naitre la vague sur un cercle de ENCIRCLE_RADIUS autour de l ancre', () => {
    const o = order({ formation: FORMATION.ENCIRCLE, count: 200 });
    const { x, y } = positionsOf(o);

    let somme = 0;
    let minR = Number.POSITIVE_INFINITY;
    let maxR = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < o.count; i++) {
      const r = Math.hypot((x[i] ?? 0) - o.anchorX, (y[i] ?? 0) - o.anchorY);
      somme += r;
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      // Derive de la constante, jamais recopiee : epingler sa valeur rend le
      // test intermittent quand elle bouge.
      expect(Math.abs(r - ENCIRCLE_RADIUS)).toBeLessThan(ENCIRCLE_RADIUS * 0.1);
    }
    expect(Math.abs(somme / o.count - ENCIRCLE_RADIUS)).toBeLessThan(ENCIRCLE_RADIUS * 0.02);

    // ⚠️ **L'anneau a une EPAISSEUR, et seul ce test le garde** (contre
    // `ENCIRCLE_JITTER = 0`). Sur un cercle parfait, toute la vague arrive au
    // contact au meme instant, en un rang d'un seul monstre : un mur. Le bruit
    // exact est un reglage, son existence ne l'est pas — d'ou un plancher d'un
    // pixel plutot qu'une valeur.
    //
    // ⚠️ **Un simple `maxR > minR` NE SUFFIT PAS** : `outX`/`outY` sont des
    // `Float32Array`, donc meme a bruit nul les rayons relus different au
    // dernier bit (~2e-4 px a 1 800 px de l'ancre).
    expect(maxR - minR).toBeGreaterThan(1);
  });

  /**
   * ⚠️ **L'assertion centrale de l'encerclement : le rayon ne suffit pas.**
   * `FORMATION.RING` pose lui aussi ses entites sur un cercle de rayon
   * constant ; ce qu'il ne fait pas, c'est le REMPLIR. A douze entites — la
   * taille d'une premiere vague — un tirage uniforme laisse regulierement un
   * demi-tour vide, c'est-a-dire le pack d'un seul cote qu'on cherche a
   * supprimer. Deux secteurs, c'est le trou que le bruit angulaire borne peut
   * ouvrir au pire ; au-dela, la vague n'encercle plus.
   */
  it('ne laisse aucun trou plus grand que deux secteurs, sur 40 graines et quatre effectifs', () => {
    for (const count of EFFECTIFS) {
      const secteur = (Math.PI * 2) / count;
      for (const seed of GRAINES) {
        const o = order({ formation: FORMATION.ENCIRCLE, count, seed });
        expect(maxGap(o)).toBeLessThan(2 * secteur);
      }
    }
  });

  /**
   * ⚠️ **La garde contre la fixture qui masque.** Sans elle, l'assertion precedente pourrait etre vraie de N'IMPORTE
   * QUELLE formation posee sur un cercle, et ne prouverait donc rien de
   * l'encerclement. Les memes graines, le meme effectif, passes a `RING` :
   * le trou depasse bel et bien deux secteurs.
   */
  it('et ce seuil a des dents : un anneau tire au hasard (RING) laisse des trous plus grands', () => {
    let depassements = 0;
    for (const count of EFFECTIFS) {
      const secteur = (Math.PI * 2) / count;
      for (const seed of GRAINES) {
        if (maxGap(order({ formation: FORMATION.RING, count, seed })) >= 2 * secteur) {
          depassements++;
        }
      }
    }
    expect(depassements).toBeGreaterThan(0);
  });
});

function makeObstacleField(
  cols: number,
  rows: number,
  cellSize: number,
  blockedCells: ReadonlyArray<readonly [number, number]>,
): ObstacleField {
  const blocked = new Uint8Array(cols * rows);
  for (const [cx, cy] of blockedCells) {
    blocked[cy * cols + cx] = 1;
  }
  return { cols, rows, cellSize, blocked };
}

describe('formationPositions, evitement des murs (tache 18)', () => {
  const cellSize = FLOWFIELD_CELL;
  const cols = Math.ceil(MAP_SIZE / cellSize);
  const rows = cols;
  const anchorCol = Math.floor(cols / 2);
  const anchorRow = Math.floor(rows / 2);

  // Un pate de mur de 7x7 cellules centre exactement sur l'ancre : assez
  // large pour que plusieurs positions SCATTER, calculees sans connaissance de
  // l'obstacle, y tombent directement (verifie plus bas par la premiere
  // assertion — un test qui ne le verifierait pas pourrait passer alors que
  // la mitigation est absente).
  const blockedCells: [number, number][] = [];
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      blockedCells.push([anchorCol + dx, anchorRow + dy]);
    }
  }
  const obstacles = makeObstacleField(cols, rows, cellSize, blockedCells);
  const anchorX = (anchorCol + 0.5) * cellSize;
  const anchorY = (anchorRow + 0.5) * cellSize;

  function cellOf(x: number, y: number): number {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(x / cellSize)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(y / cellSize)));
    return cy * cols + cx;
  }

  it('une vague ancree en plein mur ne fait naitre aucune entite a l interieur d un obstacle', () => {
    const o = order({ formation: FORMATION.SCATTER, count: 400, anchorX, anchorY });

    // Sans le masque, une partie des positions calculees tombe dans le pate
    // de murs : sinon ce test ne prouverait rien (l'ancre serait, par
    // accident, deja loin de tout obstacle).
    const rawX = new Float32Array(o.count);
    const rawY = new Float32Array(o.count);
    formationPositions(o, rawX, rawY);
    let rawInWall = 0;
    for (let i = 0; i < o.count; i++) {
      if (obstacles.blocked[cellOf(rawX[i] ?? 0, rawY[i] ?? 0)] === 1) {
        rawInWall++;
      }
    }
    expect(rawInWall).toBeGreaterThan(0);

    const x = new Float32Array(o.count);
    const y = new Float32Array(o.count);
    formationPositions(o, x, y, obstacles);

    for (let i = 0; i < o.count; i++) {
      expect(obstacles.blocked[cellOf(x[i] ?? 0, y[i] ?? 0)]).toBe(0);
    }
  });

  it('le decalage est deterministe : deux appels identiques rendent les memes positions nudgees', () => {
    const o = order({ formation: FORMATION.CLUSTER, count: 150, anchorX, anchorY });
    const ax = new Float32Array(o.count);
    const ay = new Float32Array(o.count);
    const bx = new Float32Array(o.count);
    const by = new Float32Array(o.count);

    formationPositions(o, ax, ay, obstacles);
    formationPositions(o, bx, by, obstacles);

    expect([...ax]).toEqual([...bx]);
    expect([...ay]).toEqual([...by]);
  });
});

/** Distance moyenne au plus proche voisin — une mesure de densite. */
function meanNearestNeighbour(p: { x: Float32Array; y: Float32Array }): number {
  let total = 0;
  for (let i = 0; i < p.x.length; i++) {
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < p.x.length; j++) {
      if (i === j) {
        continue;
      }
      const d = Math.hypot((p.x[i] ?? 0) - (p.x[j] ?? 0), (p.y[i] ?? 0) - (p.y[j] ?? 0));
      if (d < best) {
        best = d;
      }
    }
    total += best;
  }
  return total / p.x.length;
}
