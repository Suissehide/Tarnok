import { MAP_SIZE, SEPARATION_CELL, SEPARATION_RADIUS, SEPARATION_STRENGTH } from './constants';
import type { Horde } from './horde';

/**
 * Separation entre entites : la horde se pousse au lieu de se superposer.
 *
 * Deux raisons, et la seconde est la plus contraignante.
 *
 * **Le rendu.** La verification visuelle de l'etape 2 a montre que la horde
 * forme des FILES : les entites s'alignent sur les memes couloirs, consequence
 * des huit directions discretes par cellule de flowfield. Le §4.1 veut des
 * formations denses, pas des colonnes.
 *
 * **Le determinisme.** La separation COUPLE les entites entre elles : retirer un
 * ennemi ne decale plus une entite mais des dizaines, de proche en proche. C'est
 * ce qui rend le rejeu du §3.2 necessaire plutot que confortable.
 *
 * ⚠️ Les forces s'accumulent dans un tableau separe puis s'appliquent EN BLOC.
 * Les appliquer au fil de l'iteration rendrait le resultat dependant de l'ordre
 * de parcours — et deux clients compactent leurs tableaux differemment apres des
 * morts. Ce n'est pas une optimisation, c'est la condition du determinisme.
 */
export class SeparationGrid {
  readonly #cols: number;
  readonly #cellStart: Int32Array;
  readonly #cellCount: Int32Array;
  readonly #cursor: Int32Array;
  readonly #cellIdx: Int32Array;
  readonly #order: Int32Array;
  readonly #pushX: Float32Array;
  readonly #pushY: Float32Array;

  constructor(capacity: number) {
    this.#cols = Math.ceil(MAP_SIZE / SEPARATION_CELL);
    const cells = this.#cols * this.#cols;
    this.#cellStart = new Int32Array(cells + 1);
    this.#cellCount = new Int32Array(cells);
    this.#cursor = new Int32Array(cells + 1);
    this.#cellIdx = new Int32Array(capacity);
    this.#order = new Int32Array(capacity);
    this.#pushX = new Float32Array(capacity);
    this.#pushY = new Float32Array(capacity);
  }

  apply(horde: Horde, dt: number): void {
    const n = horde.count;
    const cols = this.#cols;
    const hx = horde.x;
    const hy = horde.y;
    this.#cellCount.fill(0);
    this.#pushX.fill(0, 0, n);
    this.#pushY.fill(0, 0, n);

    // Tri par comptage dans la grille : deux passes lineaires, zero allocation.
    // La cellule de chaque entite est calculee UNE fois et memorisee.
    for (let i = 0; i < n; i++) {
      const cx = Math.min(cols - 1, Math.max(0, Math.floor((hx[i] ?? 0) / SEPARATION_CELL)));
      const cy = Math.min(cols - 1, Math.max(0, Math.floor((hy[i] ?? 0) / SEPARATION_CELL)));
      const c = cy * cols + cx;
      this.#cellIdx[i] = c;
      this.#cellCount[c] = (this.#cellCount[c] ?? 0) + 1;
    }
    let running = 0;
    for (let c = 0; c < this.#cellCount.length; c++) {
      this.#cellStart[c] = running;
      this.#cursor[c] = running;
      running += this.#cellCount[c] ?? 0;
    }
    this.#cellStart[this.#cellCount.length] = running;
    for (let i = 0; i < n; i++) {
      const c = this.#cellIdx[i] ?? 0;
      this.#order[this.#cursor[c] ?? 0] = i;
      this.#cursor[c] = (this.#cursor[c] ?? 0) + 1;
    }

    // Chaque paire est examinee UNE fois (j > i) et la force appliquee aux deux
    // entites, egale et opposee. Visiter (i, j) puis (j, i) doublerait le travail
    // pour recalculer exactement la meme chose au signe pres.
    const r2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
    for (let i = 0; i < n; i++) {
      const xi = hx[i] ?? 0;
      const yi = hy[i] ?? 0;
      const cx = Math.min(cols - 1, Math.max(0, Math.floor(xi / SEPARATION_CELL)));
      const cy = Math.min(cols - 1, Math.max(0, Math.floor(yi / SEPARATION_CELL)));

      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = cx + ox;
          const ny = cy + oy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= cols) {
            continue;
          }
          const c = ny * cols + nx;
          const from = this.#cellStart[c] ?? 0;
          const to = this.#cellStart[c + 1] ?? 0;
          for (let k = from; k < to; k++) {
            const j = this.#order[k] ?? 0;
            if (j <= i) {
              continue;
            }
            const dx = xi - (hx[j] ?? 0);
            const dy = yi - (hy[j] ?? 0);
            const d2 = dx * dx + dy * dy;
            if (d2 > r2 || d2 === 0) {
              continue;
            }
            const d = Math.sqrt(d2);
            const push = (SEPARATION_RADIUS - d) / SEPARATION_RADIUS;
            const ux = (dx / d) * push;
            const uy = (dy / d) * push;
            this.#pushX[i] = (this.#pushX[i] ?? 0) + ux;
            this.#pushY[i] = (this.#pushY[i] ?? 0) + uy;
            this.#pushX[j] = (this.#pushX[j] ?? 0) - ux;
            this.#pushY[j] = (this.#pushY[j] ?? 0) - uy;
          }
        }
      }
    }

    const speed = SEPARATION_STRENGTH * dt;
    for (let i = 0; i < n; i++) {
      // Tache 18 : bornage de la poussee ACCUMULEE, par entite et par tick.
      //
      // `pushX`/`pushY` sont la somme, sur tous les voisins en recouvrement,
      // d'un vecteur de norme au plus 1 chacun (`(R - d) / R`, maximal a d=0).
      // Sans borne, dix voisins pleinement chevauches poussent DIX FOIS plus
      // fort qu'un seul — mesure : 96,8 px en un seul tick, 2900 px/s, onze
      // fois la vitesse du joueur. C'est la teleportation rapportee en jeu.
      //
      // La borne retenue est la poussee d'UN SEUL voisin en recouvrement
      // total : on ramene la norme du vecteur accumule a 1 au maximum avant
      // de multiplier par `speed`. Ca se lit « quel que soit l'entassement,
      // on n'est jamais pousse plus fort qu'une paire collee ne pousserait
      // seule » — une consequence du rayon et de la raideur deja choisis,
      // pas un reglage invente a cote.
      //
      // ⚠️ Mesure, pas suppose : un essai anterieur de plafonnement du
      // DEPLACEMENT, a une epoque ou SEPARATION_STRENGTH valait 120, avait
      // EMPIRE le cout (47 voisins d'equilibre au lieu de 37) — brider la
      // poussee empechait l'entassement de se relacher. A 1200 l'equilibre
      // est deja atteint avant le plafond (voir `back/bench/separation.bench.ts`,
      // colonnes "voisins (debut/fin)" avant/apres cette modification) : le
      // plafond ne mord que sur la queue de distribution, il ne change pas le
      // regime.
      let px = this.#pushX[i] ?? 0;
      let py = this.#pushY[i] ?? 0;
      const mag = Math.sqrt(px * px + py * py);
      if (mag > 1) {
        px /= mag;
        py /= mag;
      }
      // Bornage a la carte (tache 15) : contre un bord, la separation pousse
      // plus fort que le flowfield ne tire en retour (voir la doc de
      // SEPARATION_STRENGTH), et rien d'autre ne borne cette ecriture — c'est
      // le seul chemin de `shared/` qui deplace une position sans deja
      // clamper (le mouvement le fait dans `Horde.#advance`, l'apparition via
      // `formationPositions`). Sans ce clamp, une entite giclee hors carte
      // corrompt en silence le tri de profondeur du rendu (voir `bandOf`).
      hx[i] = clamp((hx[i] ?? 0) + px * speed, 0, MAP_SIZE);
      hy[i] = clamp((hy[i] ?? 0) + py * speed, 0, MAP_SIZE);
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
