/**
 * Champ de flux (flowfield) : une passe par joueur, jamais d'A* par agent.
 *
 * Le cout passe de `O(ennemis x longueur du chemin)` a `O(cellules)`,
 * independant du nombre d'ennemis : c'est ce qui permet de tenir 1 500
 * entites (lecon du post-mortem de Riot sur l'A* par sbire).
 *
 * Le champ **se replique gratuitement** : le client le recalcule a partir des
 * positions de joueurs qu'il recoit deja, donc aucune position de monstre ne
 * transite. D'ou sa place dans `shared/`.
 *
 * Aucune contrainte de purete ici : on cherche la ressemblance entre client et
 * serveur, pas la reproduction au bit pres.
 */

/** Les huit voisins, en decalages de cellule. */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const UNREACHED = -1;

/**
 * Poids (ou norme) en dessous duquel un resultat est traite comme nul plutot
 * que divise par une valeur quasi nulle — bruit flottant apres l'annulation
 * de directions opposees, ou position tombant exactement sur la cible. Voir
 * `FlowField.sampleDirection`.
 */
const SAMPLE_DEGENERATE_EPSILON = 1e-6;

export class FlowField {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;

  /** Distance en cellules depuis la cible, ou UNREACHED. */
  readonly dist: Int32Array;
  /** Direction a suivre, normalisee. (0, 0) sur la cible et l'inatteignable. */
  readonly dirX: Float32Array;
  readonly dirY: Float32Array;
  readonly blocked: Uint8Array;

  #revision = 0;

  /**
   * Nombre de recalculs subis par ce champ.
   *
   * En lecture seule de l'exterieur : c'est la donnee sur laquelle
   * `Horde.spawnCatchingUp` s'appuie pour detecter un rafraichissement survenu
   * au mauvais moment. La rendre inscriptible permettrait de neutraliser ce
   * garde-fou sans que rien ne le signale.
   */
  get revision(): number {
    return this.#revision;
  }

  /**
   * File du parcours en largeur, allouee une fois pour toutes.
   *
   * Le champ est recalcule plusieurs fois par seconde et par joueur : une file
   * qui s'agrandit a chaque passe ferait mesurer le GC au lieu du flowfield.
   */
  readonly #queue: Int32Array;

  constructor(mapSize: number, cellSize: number) {
    this.cellSize = cellSize;
    // `ceil` : une carte de 250 px avec des cellules de 100 en demande trois,
    // pas deux, sinon la derniere bande n'est couverte par aucune cellule.
    this.cols = Math.ceil(mapSize / cellSize);
    this.rows = Math.ceil(mapSize / cellSize);

    const cells = this.cols * this.rows;
    this.dist = new Int32Array(cells);
    this.dirX = new Float32Array(cells);
    this.dirY = new Float32Array(cells);
    this.blocked = new Uint8Array(cells);
    this.#queue = new Int32Array(cells);
  }

  block(cx: number, cy: number): void {
    this.blocked[cy * this.cols + cx] = 1;
  }

  /** Index de cellule pour une position monde, borne a la carte. */
  indexAt(x: number, y: number): number {
    const cx = clampInt(Math.floor(x / this.cellSize), 0, this.cols - 1);
    const cy = clampInt(Math.floor(y / this.cellSize), 0, this.rows - 1);
    return cy * this.cols + cx;
  }

  /**
   * Direction du champ echantillonnee par interpolation bilineaire autour de
   * `(x, y)`, plutot que la direction unique de la cellule qui la contient.
   *
   * Une seule direction par cellule permet a la direction de s'inverser de
   * 180° en franchissant une frontiere : avec une vitesse tenue plusieurs
   * ticks, l'entite depasse, recalcule dans la cellule voisine et repart en
   * arriere. Le melange lit le champ comme continu.
   *
   * La grille de melange est centree sur le MILIEU de chaque cellule : au
   * centre exact d'une cellule, le melange degenere exactement en la lecture
   * par cellule (des tests de `shared/horde.test.ts` en dependent).
   *
   * ⚠️ **Les cellules bloquees sont exclues du melange par `this.blocked`.**
   * Elles portent une direction de secours (`#carveExitsFromWalls`) utile a
   * une entite coincee dans le mur, mais qui tirerait vers cette sortie une
   * entite qui longe l'obstacle. Un test `dirX === 0 && dirY === 0` ne les
   * detecterait pas : leur direction est non nulle. Les poids restants sont
   * renormalises ; si les quatre sont bloquees, on retombe sur `indexAt`.
   *
   * Ecrit dans `out[0]` (x) et `out[1]` (y), sans allocation : appelee a
   * chaque recalcul de trajectoire, une allocation se verrait au banc
   * (`bench:sep`).
   */
  sampleDirection(x: number, y: number, out: Float32Array): void {
    const { cellSize, cols, rows, blocked, dirX, dirY } = this;

    const gx = x / cellSize - 0.5;
    const gy = y / cellSize - 0.5;
    const floorGx = Math.floor(gx);
    const floorGy = Math.floor(gy);
    const tx = gx - floorGx;
    const ty = gy - floorGy;

    // Coins bornes independamment de la fraction : au bord de la carte, les
    // deux coins d'un axe designent la meme cellule (« bord duplique »,
    // convention habituelle d'echantillonnage), et leurs poids s'additionnent
    // simplement sur cette seule cellule plus bas.
    const cx0 = clampInt(floorGx, 0, cols - 1);
    const cx1 = clampInt(floorGx + 1, 0, cols - 1);
    const cy0 = clampInt(floorGy, 0, rows - 1);
    const cy1 = clampInt(floorGy + 1, 0, rows - 1);

    let sumX = 0;
    let sumY = 0;
    let weight = 0;

    const i00 = cy0 * cols + cx0;
    const w00 = (1 - tx) * (1 - ty);
    if (blocked[i00] !== 1) {
      sumX += w00 * (dirX[i00] ?? 0);
      sumY += w00 * (dirY[i00] ?? 0);
      weight += w00;
    }

    const i10 = cy0 * cols + cx1;
    const w10 = tx * (1 - ty);
    if (blocked[i10] !== 1) {
      sumX += w10 * (dirX[i10] ?? 0);
      sumY += w10 * (dirY[i10] ?? 0);
      weight += w10;
    }

    const i01 = cy1 * cols + cx0;
    const w01 = (1 - tx) * ty;
    if (blocked[i01] !== 1) {
      sumX += w01 * (dirX[i01] ?? 0);
      sumY += w01 * (dirY[i01] ?? 0);
      weight += w01;
    }

    const i11 = cy1 * cols + cx1;
    const w11 = tx * ty;
    if (blocked[i11] !== 1) {
      sumX += w11 * (dirX[i11] ?? 0);
      sumY += w11 * (dirY[i11] ?? 0);
      weight += w11;
    }

    if (weight <= SAMPLE_DEGENERATE_EPSILON) {
      // Les quatre coins sont dans un mur : rien a melanger, on retombe sur
      // la lecture par cellule (elle-meme pourvue d'une sortie par
      // `#carveExitsFromWalls`, sauf poche entierement muree — voir sa doc).
      const fallback = this.indexAt(x, y);
      out[0] = dirX[fallback] ?? 0;
      out[1] = dirY[fallback] ?? 0;
      return;
    }

    const blendX = sumX / weight;
    const blendY = sumY / weight;
    const mag = Math.hypot(blendX, blendY);

    if (mag <= SAMPLE_DEGENERATE_EPSILON) {
      // Cible pile sur une des cellules melangees, ou annulation exacte de
      // directions opposees : meme convention que la lecture par cellule,
      // (0, 0) plutot qu'une division par une norme quasi nulle.
      out[0] = 0;
      out[1] = 0;
      return;
    }

    out[0] = blendX / mag;
    out[1] = blendY / mag;
  }

  /**
   * Recalcule le champ vers `(targetX, targetY)`.
   *
   * Parcours en largeur a huit voisins depuis la cible. La direction d'une
   * cellule est posee **au moment ou on la decouvre**, en pointant vers la
   * cellule d'ou l'on vient : on evite ainsi une seconde passe sur toutes les
   * cellules pour chercher le plus petit voisin.
   *
   * ⚠️ **Si la cellule cible est bloquee, le parcours ne part pas d'elle** :
   * rien ne serait explore et plus aucun monstre n'aurait de direction, pour
   * un seul joueur pousse ou teleporte dans un obstacle. On amorce depuis la
   * cellule libre la plus proche (`#nearestFreeCell`, deterministe pour que
   * serveur et client retombent sur la meme). La cellule cible recoit sa
   * direction de `#carveExitsFromWalls`, comme toute cellule muree.
   */
  update(targetX: number, targetY: number): void {
    this.#revision++;

    const { cols, rows, dist, dirX, dirY, blocked } = this;
    const queue = this.#queue;

    dist.fill(UNREACHED);
    dirX.fill(0);
    dirY.fill(0);

    const targetCell = this.indexAt(targetX, targetY);
    const start =
      blocked[targetCell] === 1
        ? this.#nearestFreeCell(targetCell, cols, rows, blocked)
        : targetCell;
    if (start === UNREACHED) {
      // Cible dans un mur ET aucune cellule libre nulle part sur la carte :
      // cas degenere (carte entierement obstruee), personne ne peut converger.
      return;
    }

    dist[start] = 0;
    queue[0] = start;
    let head = 0;
    let tail = 1;

    while (head < tail) {
      const current = queue[head++] ?? 0;
      const cx = current % cols;
      const cy = (current - cx) / cols;
      const nextDist = (dist[current] ?? 0) + 1;

      for (const [dx, dy] of NEIGHBOURS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) {
          continue;
        }

        const neighbour = ny * cols + nx;
        if (blocked[neighbour] === 1 || dist[neighbour] !== UNREACHED) {
          continue;
        }

        dist[neighbour] = nextDist;
        // On pointe du voisin vers la cellule courante, c'est-a-dire vers la
        // cible. `dx` et `dy` sont deja l'oppose de ce qu'il faut.
        const inv = dx !== 0 && dy !== 0 ? Math.SQRT1_2 : 1;
        dirX[neighbour] = -dx * inv;
        dirY[neighbour] = -dy * inv;

        queue[tail++] = neighbour;
      }
    }

    this.#carveExitsFromWalls(cols, rows, blocked, dirX, dirY, dist, queue);
  }

  /**
   * Cellule libre la plus proche de `from`, au sens de la distance de
   * Tchebychev — la meme metrique que le parcours a huit voisins de `update`.
   *
   * Deterministe et sans allocation : parcourt les anneaux carres autour de
   * `from` par rayon croissant (0, 1, 2, ...), et a l'interieur d'un anneau
   * dans l'ordre croissant de `y` puis de `x` — qui est aussi l'ordre
   * croissant d'index de cellule (`y * cols + x`), puisque `x` reste borne a
   * `cols`. Le premier index libre trouve est donc a la fois le plus proche
   * ET, a egalite de rayon, le plus petit index : serveur et client
   * produisent exactement la meme cellule de depart.
   *
   * Plus proche geometriquement, pas en chemin contournant les obstacles.
   * Rend `UNREACHED` si la carte entiere est bloquee.
   */
  #nearestFreeCell(from: number, cols: number, rows: number, blocked: Uint8Array): number {
    const cx = from % cols;
    const cy = (from - cx) / cols;
    const maxRadius = Math.max(cols, rows);

    for (let r = 0; r <= maxRadius; r++) {
      const yMin = cy - r;
      const yMax = cy + r;
      for (let y = yMin; y <= yMax; y++) {
        if (y < 0 || y >= rows) {
          continue;
        }
        const onHorizontalEdge = y === yMin || y === yMax;
        const xMin = cx - r;
        const xMax = cx + r;
        for (let x = xMin; x <= xMax; x++) {
          if (x < 0 || x >= cols) {
            continue;
          }
          // Sur les lignes interieures de l'anneau, seuls les deux bords
          // verticaux appartiennent au rayon `r` : le reste a deja ete
          // visite (rayon plus petit) ou le sera (rayon plus grand).
          if (!onHorizontalEdge && x !== xMin && x !== xMax) {
            continue;
          }

          const idx = y * cols + x;
          if (blocked[idx] !== 1) {
            return idx;
          }
        }
      }
    }

    return UNREACHED;
  }

  /**
   * Deuxieme parcours : offre une sortie a TOUTE cellule muree, quelle que
   * soit la raison pour laquelle une entite s'y trouve. C'est le filet : une
   * cause imprevue doit degrader plutot que figer une entite pour toujours.
   *
   * BFS en largeur, en O(cellules) comme le premier : on part de TOUTES les
   * cellules deja atteintes (la frontiere du premier parcours) et on avance
   * uniquement dans les cellules MUREES pas encore pourvues d'une sortie. Le
   * sentinel « pas encore visitee par cette passe » est `dirX === 0 && dirY
   * === 0` : jamais vrai pour une cellule muree deja traitee, puisque
   * `NEIGHBOURS` ne contient jamais `(0, 0)` — la direction assignee a une
   * norme non nulle.
   *
   * ⚠️ Ne touche PAS les cellules libres mais inatteignables (une poche isolee
   * par des murs tout autour) : ce n'est pas la meme classe de defaut — une
   * entite qui s'y trouve n'est pas « dans un mur », c'est un probleme de
   * connectivite. Seules les cellules dont `blocked[cellule] === 1` sont
   * concernees ici.
   *
   * Reutilise `#queue` : aucune allocation, comme le premier parcours.
   */
  #carveExitsFromWalls(
    cols: number,
    rows: number,
    blocked: Uint8Array,
    dirX: Float32Array,
    dirY: Float32Array,
    dist: Int32Array,
    queue: Int32Array,
  ): void {
    let head = 0;
    let tail = 0;
    const cells = cols * rows;
    for (let c = 0; c < cells; c++) {
      if (dist[c] !== UNREACHED) {
        queue[tail++] = c;
      }
    }

    while (head < tail) {
      const current = queue[head++] ?? 0;
      const cx = current % cols;
      const cy = (current - cx) / cols;

      for (const [dx, dy] of NEIGHBOURS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) {
          continue;
        }

        const neighbour = ny * cols + nx;
        if (blocked[neighbour] !== 1) {
          continue;
        }
        if (dirX[neighbour] !== 0 || dirY[neighbour] !== 0) {
          continue;
        }

        // Meme convention que le premier parcours : on pointe du voisin
        // (dans le mur) vers la cellule courante (plus proche de la sortie).
        const inv = dx !== 0 && dy !== 0 ? Math.SQRT1_2 : 1;
        dirX[neighbour] = -dx * inv;
        dirY[neighbour] = -dy * inv;

        queue[tail++] = neighbour;
      }
    }
  }
}

function clampInt(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
