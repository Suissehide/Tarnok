/**
 * Champ de flux (flowfield) : une passe par joueur, jamais d'A* par agent.
 *
 * C'est l'enseignement principal du post-mortem de Riot (§4.2 de la spec) :
 * leur pathfinding A* par agent scalait **quadratiquement** avec le nombre de
 * sbires, et ils l'ont remplace par une carte de Dijkstra. Le cout passe de
 * `O(ennemis x longueur du chemin)` a `O(cellules)` — donc independant du
 * nombre d'ennemis, ce qui est exactement la propriete qu'il faut pour tenir
 * 1 500 entites.
 *
 * Benefice secondaire, et c'est lui qui rend le §3.3 possible : le champ **se
 * replique gratuitement**. Le client le recalcule a partir des quatre positions
 * de joueurs qu'il recoit deja, donc aucune position de monstre ne transite.
 * C'est pour cette raison que ce fichier vit dans `shared/` et pas dans `back/`.
 *
 * Aucune contrainte de purete ici (§12.1) : on cherche la ressemblance entre
 * client et serveur, pas la reproduction au bit pres.
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

  /**
   * Incremente a chaque `update`. Sert a detecter qu'un champ a ete rafraichi
   * entre deux pas de horde — voir `Horde.spawnCatchingUp`.
   */
  revision = 0;

  /**
   * File du parcours en largeur, allouee une fois pour toutes.
   *
   * Le champ est recalcule 5 a 10 fois par seconde et par joueur : une file qui
   * s'agrandit a chaque passe rendrait le ramasse-miettes visible dans les
   * mesures de l'etape 1, et on mesurerait le GC au lieu du flowfield.
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
   * Recalcule le champ vers `(targetX, targetY)`.
   *
   * Parcours en largeur a huit voisins depuis la cible. La direction d'une
   * cellule est posee **au moment ou on la decouvre**, en pointant vers la
   * cellule d'ou l'on vient : on evite ainsi une seconde passe sur toutes les
   * cellules pour chercher le plus petit voisin.
   */
  update(targetX: number, targetY: number): void {
    this.revision++;

    const { cols, rows, dist, dirX, dirY, blocked } = this;
    const queue = this.#queue;

    dist.fill(UNREACHED);
    dirX.fill(0);
    dirY.fill(0);

    const start = this.indexAt(targetX, targetY);
    if (blocked[start] === 1) {
      // Cible dans un mur : personne ne converge, plutot que de converger vers
      // n'importe quoi.
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
  }
}

function clampInt(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
