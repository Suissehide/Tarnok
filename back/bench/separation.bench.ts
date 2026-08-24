/**
 * Banc — que coutent la separation et le rejeu ?
 *
 * Le §3.3 de la spec de l'etape 3 en fait une porte : rejouer `L` ticks coute
 * `L + 1` pas de simulation, a chaque tick et en permanence. Le deplacement seul
 * a ete mesure a l'etape 1 (0,02 ms pour 4 000 entites) ; la separation, jamais.
 *
 *   npm run bench:sep -w back
 */

import { FLOWFIELD_CELL, MAP_SIZE, TICK_HZ } from '@shared/constants';
import { FlowField } from '@shared/flowfield';
import { Horde } from '@shared/horde';
import { FORMATION, type WaveOrder } from '@shared/waves';

import { machineDescription, round2, stats } from './harness';

const DT = 1 / TICK_HZ;
const MEASURED_STEPS = 300;
const WARMUP_STEPS = 60;

const SEPARATION_RADIUS = 28;
const SEPARATION_CELL = 56;
const SEPARATION_STRENGTH = 120;

/**
 * Grille spatiale jetable, ecrite ici pour mesurer la FORME de l'algorithme
 * avant de l'adopter. La version retenue vivra dans `shared/separation.ts`.
 *
 * Les forces s'accumulent dans un tableau separe puis s'appliquent en bloc :
 * appliquer au fil de l'iteration rendrait le resultat dependant de l'ordre de
 * parcours, et deux clients compactent leurs tableaux differemment.
 */
class Separation {
  readonly #cols: number;
  readonly #cellStart: Int32Array;
  readonly #cellCount: Int32Array;
  readonly #order: Int32Array;
  readonly #pushX: Float32Array;
  readonly #pushY: Float32Array;

  constructor(capacity: number) {
    this.#cols = Math.ceil(MAP_SIZE / SEPARATION_CELL);
    const cells = this.#cols * this.#cols;
    this.#cellStart = new Int32Array(cells + 1);
    this.#cellCount = new Int32Array(cells);
    this.#order = new Int32Array(capacity);
    this.#pushX = new Float32Array(capacity);
    this.#pushY = new Float32Array(capacity);
  }

  apply(horde: Horde, dt: number): void {
    const n = horde.count;
    const cols = this.#cols;
    this.#cellCount.fill(0);
    this.#pushX.fill(0, 0, n);
    this.#pushY.fill(0, 0, n);

    // Tri par comptage dans la grille : deux passes lineaires, zero allocation.
    const cellOf = (i: number): number => {
      const cx = Math.min(cols - 1, Math.max(0, Math.floor((horde.x[i] ?? 0) / SEPARATION_CELL)));
      const cy = Math.min(cols - 1, Math.max(0, Math.floor((horde.y[i] ?? 0) / SEPARATION_CELL)));
      return cy * cols + cx;
    };
    for (let i = 0; i < n; i++) {
      this.#cellCount[cellOf(i)] = (this.#cellCount[cellOf(i)] ?? 0) + 1;
    }
    let running = 0;
    for (let c = 0; c < this.#cellCount.length; c++) {
      this.#cellStart[c] = running;
      running += this.#cellCount[c] ?? 0;
    }
    this.#cellStart[this.#cellCount.length] = running;
    const cursor = this.#cellStart.slice();
    for (let i = 0; i < n; i++) {
      const c = cellOf(i);
      this.#order[cursor[c] ?? 0] = i;
      cursor[c] = (cursor[c] ?? 0) + 1;
    }

    const r2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
    for (let i = 0; i < n; i++) {
      const xi = horde.x[i] ?? 0;
      const yi = horde.y[i] ?? 0;
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
            if (j === i) {
              continue;
            }
            const dx = xi - (horde.x[j] ?? 0);
            const dy = yi - (horde.y[j] ?? 0);
            const d2 = dx * dx + dy * dy;
            if (d2 > r2 || d2 === 0) {
              continue;
            }
            const d = Math.sqrt(d2);
            const push = (SEPARATION_RADIUS - d) / SEPARATION_RADIUS;
            this.#pushX[i] = (this.#pushX[i] ?? 0) + (dx / d) * push;
            this.#pushY[i] = (this.#pushY[i] ?? 0) + (dy / d) * push;
          }
        }
      }
    }

    const speed = SEPARATION_STRENGTH * dt;
    for (let i = 0; i < n; i++) {
      horde.x[i] = (horde.x[i] ?? 0) + (this.#pushX[i] ?? 0) * speed;
      horde.y[i] = (horde.y[i] ?? 0) + (this.#pushY[i] ?? 0) * speed;
    }
  }
}

function makeHorde(count: number): { horde: Horde; fields: FlowField[] } {
  const horde = new Horde(4000);
  const order: WaveOrder = {
    waveId: 1,
    spawnTick: 0,
    seed: 0x51ee_d001,
    archetype: 0,
    formation: FORMATION.CLUSTER,
    anchorX: 3000,
    anchorY: 3000,
    count,
  };
  horde.spawn(order);
  const fields = Array.from({ length: 4 }, () => {
    const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    f.update(3000, 3000);
    return f;
  });
  horde.retarget([3000, 3000, 3000, 3000], [3000, 3000, 3000, 3000]);
  return { horde, fields };
}

function measure(count: number, withSeparation: boolean): { median: number; p95: number } {
  const { horde, fields } = makeHorde(count);
  const sep = new Separation(4000);
  const times: number[] = [];
  for (let step = 0; step < WARMUP_STEPS + MEASURED_STEPS; step++) {
    const started = performance.now();
    horde.step(DT, fields);
    if (withSeparation) {
      sep.apply(horde, DT);
    }
    const elapsed = performance.now() - started;
    if (step >= WARMUP_STEPS) {
      times.push(elapsed);
    }
  }
  const s = stats(times);
  return { median: s.median, p95: s.p95 };
}

function main(): void {
  console.log(`Banc de separation — ${machineDescription()}`);
  console.log(`Rayon ${SEPARATION_RADIUS} px, cellule ${SEPARATION_CELL} px\n`);

  const rows = [250, 500, 1000, 1500, 2500, 4000].map((n) => {
    const sans = measure(n, false);
    const avec = measure(n, true);
    const rejeu4 = avec.median * 4;
    return {
      entites: n,
      'pas sans separation (ms)': round2(sans.median),
      'pas avec separation (ms)': round2(avec.median),
      'cout de la separation (ms)': round2(avec.median - sans.median),
      'rejeu de 3 ticks (ms)': round2(rejeu4),
      verdict: rejeu4 < 1 ? 'OK' : rejeu4 < 4 ? 'a borner' : 'rouvrir le §3.2',
    };
  });
  console.table(rows);

  const cible = rows.find((r) => r.entites === 1500);
  console.log(
    `\n-> A la cible de 1 500 entites (§4.1), un rejeu de trois ticks coute ` +
      `${cible?.['rejeu de 3 ticks (ms)']} ms sur un budget d'image de 16,7 ms.`,
  );
}

main();
