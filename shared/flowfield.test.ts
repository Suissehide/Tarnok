import { describe, expect, it } from 'vitest';

import { FlowField } from './flowfield';
import { applyObstacles, generateObstacles } from './worldmap';

describe('FlowField, dimensions', () => {
  it('couvre la carte entiere, meme si le cote n est pas un multiple de la cellule', () => {
    const field = new FlowField(250, 100);

    expect(field.cols).toBe(3);
    expect(field.rows).toBe(3);
  });
});

describe('FlowField, sans obstacle', () => {
  it('pointe vers la cible', () => {
    const field = new FlowField(900, 100);
    field.update(850, 450);

    const i = field.indexAt(50, 450);

    expect(field.dirX[i]).toBeGreaterThan(0.9);
    expect(field.dirY[i]).toBeCloseTo(0, 5);
  });

  it('ne pointe nulle part depuis la cellule de la cible', () => {
    const field = new FlowField(900, 100);
    field.update(450, 450);

    const i = field.indexAt(450, 450);

    expect(field.dirX[i]).toBe(0);
    expect(field.dirY[i]).toBe(0);
  });

  it('rend des directions normalisees', () => {
    const field = new FlowField(900, 100);
    field.update(850, 850);

    for (let i = 0; i < field.dirX.length; i++) {
      const len = Math.hypot(field.dirX[i] ?? 0, field.dirY[i] ?? 0);
      // 0 pour la cellule de la cible, 1 partout ailleurs : jamais entre les deux.
      expect(len === 0 || Math.abs(len - 1) < 1e-5).toBe(true);
    }
  });

  it('fait converger un agent qui suit le gradient', () => {
    const field = new FlowField(900, 60);
    field.update(800, 800);

    let x = 50;
    let y = 50;
    for (let step = 0; step < 400; step++) {
      const i = field.indexAt(x, y);
      x += (field.dirX[i] ?? 0) * 10;
      y += (field.dirY[i] ?? 0) * 10;
    }

    expect(Math.hypot(800 - x, 800 - y)).toBeLessThan(100);
  });
});

describe('FlowField, avec obstacles', () => {
  it('contourne un mur au lieu de le traverser', () => {
    const field = new FlowField(300, 100);
    field.block(1, 1);
    field.update(250, 150);

    const i = field.indexAt(50, 150);

    // Tout droit vers l'est, c'est le mur. Le champ doit devier.
    expect(field.dirY[i]).not.toBe(0);
  });

  it('offre une sortie a une cellule muree plutot que de la laisser sans direction (tache 18)', () => {
    // Avant la tache 18, une cellule bloquee ne portait AUCUNE direction : une
    // entite qui s'y retrouvait — apparition en plein mur, poussee de
    // separation — n'en ressortait jamais. `FlowField.update` fait maintenant
    // une seconde passe qui donne a toute cellule muree une direction vers la
    // cellule libre la plus proche.
    const field = new FlowField(300, 100);
    field.block(1, 1);
    field.update(250, 150);

    const i = field.indexAt(150, 150);
    const len = Math.hypot(field.dirX[i] ?? 0, field.dirY[i] ?? 0);

    // Une direction UNITAIRE, pas juste "non nulle" : le premier parcours ne
    // rend jamais autre chose que 0 ou une norme 1 (voir 'rend des directions
    // normalisees' plus haut), et la seconde passe reutilise la meme
    // convention — un test qui se contenterait de `!== 0` laisserait passer
    // une direction mal normalisee.
    expect(len).toBeCloseTo(1, 5);
  });

  it('une entite placee au centre d un mur en ressort en quelques pas (tache 18)', () => {
    // Le scenario reel : une entite se retrouve, pour une raison ou une
    // autre, avec des coordonnees qui tombent dans une cellule bloquee. Sans
    // la seconde passe de `update`, elle y resterait figee pour toujours —
    // c'etait le douzieme sur douze immobiles mesures, tous dans un mur.
    const field = new FlowField(300, 100);
    field.block(1, 1);
    field.update(250, 150);

    let x = 150;
    let y = 150;
    const step = 10;
    let leftWall = false;
    for (let t = 0; t < 30; t++) {
      const cell = field.indexAt(x, y);
      if (field.blocked[cell] === 0) {
        leftWall = true;
        break;
      }
      x += (field.dirX[cell] ?? 0) * step;
      y += (field.dirY[cell] ?? 0) * step;
    }

    expect(leftWall).toBe(true);
  });

  it('laisse sans direction une zone entierement muree', () => {
    const field = new FlowField(300, 100);
    // On isole le coin (0,0) derriere trois murs.
    field.block(1, 0);
    field.block(0, 1);
    field.block(1, 1);
    field.update(250, 150);

    const i = field.indexAt(50, 50);

    expect(field.dirX[i]).toBe(0);
    expect(field.dirY[i]).toBe(0);
  });
});

describe('FlowField.update, cible sur un obstacle (tache 27)', () => {
  it('ne vide jamais le champ : depuis une cellule bloquee, le parcours atteint autant de cellules que depuis une cellule libre voisine', () => {
    // Mesure a l'origine de la tache : un joueur poste sur un obstacle
    // faisait tomber le nombre de cellules atteintes a 0/8836, contre ~8330
    // depuis une position libre — plus aucun monstre de la carte n'avait de
    // direction. Mutation visee : supprimer le repli vers la cellule libre
    // la plus proche (revenir a un simple `return` quand la cible est
    // bloquee) fait chuter `reachedFromBlocked` a 0 tout en laissant
    // `reachedFromFreeNeighbour` inchange — l'egalite ci-dessous echoue.
    //
    // Fixture sur un VRAI masque : `generateObstacles` prend
    // `(seed, cols, rows)` — l'appeler avec un seul argument rend un masque
    // vide en silence, ce qui a deja coute trois diagnostics faux dans cette
    // meme zone (voir le brief de la tache 27). On verifie donc explicitement
    // que le masque contient des cellules bloquees avant de s'appuyer dessus.
    const MAP_SIZE = 6000;
    const CELL = 64;
    const cols = Math.ceil(MAP_SIZE / CELL);
    const rows = cols;
    const mask = generateObstacles(1, cols, rows);

    const hasBlockedCell = mask.some((cell) => cell === 1);
    expect(hasBlockedCell).toBe(true);

    // Premiere cellule bloquee, loin du bord, qui a au moins un voisin libre
    // (sinon elle ne temoignerait de rien : une poche entierement muree est
    // un defaut de connectivite distinct, hors perimetre de cette tache).
    let targetCell = -1;
    let freeNeighbourCell = -1;
    for (let cy = 10; cy < rows - 10 && targetCell === -1; cy++) {
      for (let cx = 10; cx < cols - 10; cx++) {
        const idx = cy * cols + cx;
        if (mask[idx] !== 1) {
          continue;
        }
        for (let dy = -1; dy <= 1 && freeNeighbourCell === -1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) {
              continue;
            }
            const neighbourIdx = (cy + dy) * cols + (cx + dx);
            if (mask[neighbourIdx] !== 1) {
              freeNeighbourCell = neighbourIdx;
              break;
            }
          }
        }
        if (freeNeighbourCell !== -1) {
          targetCell = idx;
        }
      }
    }
    expect(targetCell).toBeGreaterThanOrEqual(0);
    expect(freeNeighbourCell).toBeGreaterThanOrEqual(0);

    const cellCentre = (cell: number): [number, number] => {
      const cx = cell % cols;
      const cy = (cell - cx) / cols;
      return [cx * CELL + CELL / 2, cy * CELL + CELL / 2];
    };

    const fieldOnObstacle = new FlowField(MAP_SIZE, CELL);
    applyObstacles(fieldOnObstacle, mask);
    fieldOnObstacle.update(...cellCentre(targetCell));

    const fieldOnFreeNeighbour = new FlowField(MAP_SIZE, CELL);
    applyObstacles(fieldOnFreeNeighbour, mask);
    fieldOnFreeNeighbour.update(...cellCentre(freeNeighbourCell));

    const countReached = (field: FlowField): number => {
      let reached = 0;
      for (const d of field.dist) {
        if (d !== -1) {
          reached++;
        }
      }
      return reached;
    };

    const reachedFromBlocked = countReached(fieldOnObstacle);
    const reachedFromFreeNeighbour = countReached(fieldOnFreeNeighbour);

    // Garde-fou : si les deux valaient 0, l'egalite passerait pour de
    // mauvaises raisons (masque vide, appel `generateObstacles` casse).
    expect(reachedFromFreeNeighbour).toBeGreaterThan(0);
    expect(reachedFromBlocked).toBe(reachedFromFreeNeighbour);
  });

  it("brise les egalites de facon deterministe : entre plusieurs cellules libres a distance egale, c'est toujours la plus petite en index qui amorce le parcours", () => {
    // Grille 3x3 : la cellule centrale (1,1), index 4, est bloquee — c'est la
    // cible. Les huit voisines sont TOUTES libres et TOUTES a distance de
    // Tchebychev 1 : une egalite totale. La regle enoncee dans le brief est
    // "plus petit index de cellule" ; en parcours ligne par ligne, colonne
    // par colonne, la plus petite est l'index 0, la cellule (0,0).
    //
    // Mutation visee : un repli qui choisirait la premiere cellule libre
    // trouvee dans un ordre different (par exemple l'ordre du tableau
    // `NEIGHBOURS`, qui commence par (1,0) puis (-1,0)...) retomberait sur
    // une autre cellule que l'index 0, et l'assertion sur `dist[0]` echouerait.
    const field = new FlowField(300, 100); // cols = rows = 3
    field.block(1, 1);
    field.update(150, 150); // centre de la cellule bloquee (1, 1)

    expect(field.dist[0]).toBe(0);
    // Aucune autre cellule ne doit avoir ete choisie comme depart : une seule
    // cellule a distance 0.
    for (let i = 1; i < field.dist.length; i++) {
      if (i === 4) {
        continue; // la cible elle-meme, toujours bloquee, jamais atteinte par ce parcours.
      }
      expect(field.dist[i]).not.toBe(0);
    }
  });
});

describe('FlowField.indexAt', () => {
  it('borne les positions hors carte au lieu de sortir du tableau', () => {
    const field = new FlowField(300, 100);

    expect(field.indexAt(-5000, -5000)).toBe(0);
    expect(field.indexAt(99999, 99999)).toBe(field.cols * field.rows - 1);
  });
});

describe('FlowField.update', () => {
  it('efface le champ precedent au lieu de le cumuler', () => {
    const field = new FlowField(900, 100);
    field.update(850, 450);
    const before = field.dirX[field.indexAt(50, 450)];
    field.update(50, 450);
    const after = field.dirX[field.indexAt(850, 450)];

    expect(before).toBeGreaterThan(0.9);
    expect(after).toBeLessThan(-0.9);
  });

  it('incremente revision a chaque recalcul, pour detecter un rafraichissement', () => {
    const field = new FlowField(900, 100);

    expect(field.revision).toBe(0);
    field.update(450, 450);
    expect(field.revision).toBe(1);
    field.update(450, 450);
    expect(field.revision).toBe(2);
  });
});

describe('FlowField.sampleDirection (tache 25)', () => {
  it("deux positions distantes d'un pixel de part et d'autre d'une frontiere de cellule donnent des directions proches, la ou la lecture par cellule les donnerait tres differentes", () => {
    // Mutation visee : `sampleDirection` qui retomberait sur la lecture par
    // cellule (`indexAt` puis lecture directe de `dirX`/`dirY`) au lieu de
    // melanger les quatre coins environnants — exactement le defaut mesure
    // au rapport de la tache 25 (1282 demi-tours sur 400 trajets avant,
    // contre 165 apres, pour un monstre isole).
    //
    // Deux cellules voisines directement posees a angle DROIT l'une de
    // l'autre (est vs nord), pas a l'oppose exact (180°) : a l'oppose exact,
    // meme une interpolation correcte redevient instable pile au point de
    // melange 50/50 (les deux contributions s'annulant presque), ce qui
    // n'est pas le defaut que cette tache corrige — le choisir aurait rendu
    // ce test fragile sans rien prouver de plus.
    const field = new FlowField(400, 100);
    const cellA = field.indexAt(150, 150); // cellule (1, 1), centre (150, 150)
    const cellB = field.indexAt(250, 150); // cellule (2, 1), centre (250, 150)
    field.dirX[cellA] = 1;
    field.dirY[cellA] = 0;
    field.dirX[cellB] = 0;
    field.dirY[cellB] = 1;

    // Frontiere de cellule en x = 200 : un pixel de chaque cote.
    const a = new Float32Array(2);
    const b = new Float32Array(2);
    field.sampleDirection(199.5, 150, a);
    field.sampleDirection(200.5, 150, b);

    const interpolatedDist = Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0));
    expect(interpolatedDist).toBeLessThan(0.05);

    // Sanity : la lecture par cellule, elle, donnerait bien deux directions
    // tres differentes ici (angle droit, distance ~1.41) — c'est le
    // contraste que ce test existe pour verifier.
    const perCellAx = field.dirX[field.indexAt(199.5, 150)] ?? 0;
    const perCellAy = field.dirY[field.indexAt(199.5, 150)] ?? 0;
    const perCellBx = field.dirX[field.indexAt(200.5, 150)] ?? 0;
    const perCellBy = field.dirY[field.indexAt(200.5, 150)] ?? 0;
    const perCellDist = Math.hypot(perCellAx - perCellBx, perCellAy - perCellBy);
    expect(perCellDist).toBeGreaterThan(1);
  });

  it('une position au bord d une cellule bloquee rend une direction qui ne pointe pas vers le mur', () => {
    // Fixture avec un VRAI masque d'obstacles (pas une construction a la
    // main) : `generateObstacles` prend `(seed, cols, rows)` — l'appeler
    // avec un seul argument rend un masque vide en silence, ce qui a deja
    // couté deux diagnostics faux dans cette meme zone (voir le brief de la
    // tache 25).
    const MAP_SIZE = 6000;
    const CELL = 64;
    const cols = Math.ceil(MAP_SIZE / CELL);
    const rows = cols;
    const mask = generateObstacles(1, cols, rows);
    const field = new FlowField(MAP_SIZE, CELL);
    applyObstacles(field, mask);
    field.update(MAP_SIZE / 2, MAP_SIZE / 2);

    // Une cellule libre avec un mur immediatement au NORD, CHERCHEE dans le
    // masque plutot que recopiee : depuis la carte en tuiles (une ile), les
    // coordonnees trouvees jadis par le script d'exploration ne tiennent plus.
    let freeCell = -1;
    // ⚠️ Et SOUS le centre : la cible est alors au nord, de l'autre cote du
    // mur — le seul cas ou « pointer vers le mur » serait la pente naturelle.
    for (let i = Math.ceil(rows / 2 + 1) * cols; i < mask.length && freeCell < 0; i++) {
      // Un PAN de mur (nord-ouest, nord, nord-est) : sous un arbre isole, le
      // chemin le contourne en diagonale, et la pointe vers le nord est juste.
      if (
        mask[i] === 0 &&
        mask[i - cols] === 1 &&
        mask[i - cols - 1] === 1 &&
        mask[i - cols + 1] === 1
      ) {
        freeCell = i;
      }
    }
    expect(freeCell).toBeGreaterThanOrEqual(0);
    const cx = freeCell % cols;
    const cy = (freeCell - cx) / cols;

    // Un pixel apres la frontiere avec le mur (bord haut de la cellule
    // libre, en y).
    const out = new Float32Array(2);
    field.sampleDirection(cx * CELL + CELL / 2, cy * CELL + 1, out);

    // "Vers le mur" ici, c'est une composante y NEGATIVE (le mur est au
    // nord, y plus petit). Une direction qui longe le mur ou s'en eloigne a
    // une composante y NULLE ou POSITIVE — jamais negative au-dela du bruit
    // flottant.
    expect(out[1] ?? 0).toBeGreaterThanOrEqual(-1e-3);
  });
});
