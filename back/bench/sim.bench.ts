/**
 * Banc serveur — combien d'entites tiennent a 30 Hz ?
 *
 * Headless, sans reseau, sans rendu. On mesure le temps d'un pas de simulation
 * complet : recalcul des champs de flux quand il est du, puis deplacement de
 * toutes les entites.
 *
 * Verdict : le plus grand N dont le p95 reste sous **11 ms**, soit un tiers du
 * budget de 33 ms d'un tick a 30 Hz. Les deux autres tiers sont pour tout ce que
 * l'etape 0 ne fait pas encore — collisions, degats, reseau.
 *
 *   npm run bench:sim -w back
 */

import { FlowField } from '@shared/flowfield';

import { machineDescription, makeRandom, round2, type Stats, stats } from './harness';

const MAP_SIZE = 6000;
const PLAYERS = 4;
const ENEMY_SPEED = 90;
const TICK_HZ = 30;
const DT = 1 / TICK_HZ;

/** Pas mesures par configuration, plus un rodage jete. */
const MEASURED_STEPS = 600;
const WARMUP_STEPS = 60;

/** Part de cellules infranchissables : une carte vide mesurerait un cas irreel. */
const BLOCKED_RATIO = 0.06;

const BUDGET_MS = 1000 / TICK_HZ / 3;

interface Config {
  entities: number;
  cellSize: number;
  fieldHz: number;
}

/**
 * La horde en tableaux typés, jamais en objets (§4.4).
 *
 * A 1 500 entites, un objet par ennemi avec ses champs coute plus cher en
 * indirections et en pression memoire que tout le reste du pas reuni — et c'est
 * exactement le poste que Riot a du batcher.
 */
class Horde {
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Index du champ suivi, recalcule rarement : changer de cible chaque tick fait vibrer. */
  readonly target: Uint8Array;

  constructor(count: number, random: () => number) {
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.target = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      this.x[i] = random() * MAP_SIZE;
      this.y[i] = random() * MAP_SIZE;
    }
  }

  get count(): number {
    return this.x.length;
  }

  /** Chaque entite suit le champ du joueur le plus proche. */
  retarget(playerX: readonly number[], playerY: readonly number[]): void {
    for (let i = 0; i < this.count; i++) {
      const ex = this.x[i] ?? 0;
      const ey = this.y[i] ?? 0;
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let p = 0; p < playerX.length; p++) {
        const dx = (playerX[p] ?? 0) - ex;
        const dy = (playerY[p] ?? 0) - ey;
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      this.target[i] = best;
    }
  }

  step(fields: readonly FlowField[], dt: number): void {
    const speed = ENEMY_SPEED * dt;
    for (let i = 0; i < this.count; i++) {
      const field = fields[this.target[i] ?? 0];
      if (!field) {
        continue;
      }
      const ex = this.x[i] ?? 0;
      const ey = this.y[i] ?? 0;
      const cell = field.indexAt(ex, ey);
      this.x[i] = ex + (field.dirX[cell] ?? 0) * speed;
      this.y[i] = ey + (field.dirY[cell] ?? 0) * speed;
    }
  }
}

function buildFields(cellSize: number, random: () => number): FlowField[] {
  const fields: FlowField[] = [];
  // Tous les champs partagent la meme carte d'obstacles : c'est le meme monde.
  const reference = new FlowField(MAP_SIZE, cellSize);
  const cells = reference.cols * reference.rows;
  const blockedCells: number[] = [];
  for (let i = 0; i < cells; i++) {
    if (random() < BLOCKED_RATIO) {
      blockedCells.push(i);
    }
  }

  for (let p = 0; p < PLAYERS; p++) {
    const field = new FlowField(MAP_SIZE, cellSize);
    for (const cell of blockedCells) {
      field.block(cell % field.cols, Math.floor(cell / field.cols));
    }
    fields.push(field);
  }
  return fields;
}

interface Run {
  /** Pas complet : recalcul des champs quand il est du, plus deplacement. */
  total: Stats;
  /** Les quatre passes de flowfield, sur les seuls ticks ou elles ont lieu. */
  field: Stats;
  /** Le deplacement de toutes les entites, a chaque tick. */
  move: Stats;
  fieldCells: number;
}

function run(config: Config): Run {
  const random = makeRandom(0x5eed_1234);
  const fields = buildFields(config.cellSize, random);
  const horde = new Horde(config.entities, random);

  const playerX = Array.from({ length: PLAYERS }, () => random() * MAP_SIZE);
  const playerY = Array.from({ length: PLAYERS }, () => random() * MAP_SIZE);

  const stepsPerField = Math.max(1, Math.round(TICK_HZ / config.fieldHz));
  const totals: number[] = [];
  const fieldTimes: number[] = [];
  const moveTimes: number[] = [];

  for (let step = 0; step < WARMUP_STEPS + MEASURED_STEPS; step++) {
    const measured = step >= WARMUP_STEPS;
    const started = performance.now();

    // Les joueurs bougent : sans ca les champs seraient recalcules a l'identique
    // et le processeur predirait tout, ce qui flatterait la mesure.
    for (let p = 0; p < PLAYERS; p++) {
      playerX[p] = wrap((playerX[p] ?? 0) + Math.cos(step * 0.05 + p) * 6);
      playerY[p] = wrap((playerY[p] ?? 0) + Math.sin(step * 0.05 + p) * 6);
    }

    if (step % stepsPerField === 0) {
      const fieldStart = performance.now();
      for (let p = 0; p < PLAYERS; p++) {
        fields[p]?.update(playerX[p] ?? 0, playerY[p] ?? 0);
      }
      horde.retarget(playerX, playerY);
      if (measured) {
        fieldTimes.push(performance.now() - fieldStart);
      }
    }

    const moveStart = performance.now();
    horde.step(fields, DT);
    if (measured) {
      moveTimes.push(performance.now() - moveStart);
      totals.push(performance.now() - started);
    }
  }

  const first = fields[0];
  return {
    total: stats(totals),
    field: stats(fieldTimes),
    move: stats(moveTimes),
    fieldCells: first ? first.cols * first.rows : 0,
  };
}

function wrap(v: number): number {
  if (v < 0) {
    return v + MAP_SIZE;
  }
  if (v > MAP_SIZE) {
    return v - MAP_SIZE;
  }
  return v;
}

function main(): void {
  console.log(`Banc de simulation — ${machineDescription()}`);
  console.log(
    `Carte ${MAP_SIZE}x${MAP_SIZE}, ${PLAYERS} joueurs, ${PLAYERS} champs, ` +
      `${Math.round(BLOCKED_RATIO * 100)} % de cellules murees, ${MEASURED_STEPS} pas mesures.`,
  );
  console.log(`Budget vise : p95 < ${round2(BUDGET_MS)} ms (un tiers d'un tick a ${TICK_HZ} Hz)\n`);

  console.log("1. Combien d'entites ? (cellule 64 px, champs a 10 Hz)");
  const entityRows = [250, 500, 1000, 1500, 2500, 4000].map((entities) => {
    const r = run({ entities, cellSize: 64, fieldHz: 10 });
    return {
      entites: entities,
      'pas p95 (ms)': round2(r.total.p95),
      'dont champs (ms)': round2(r.field.p95),
      'dont deplacement (ms)': round2(r.move.p95),
      'pas max (ms)': round2(r.total.max),
      verdict: r.total.p95 < BUDGET_MS ? 'OK' : 'hors budget',
    };
  });
  console.table(entityRows);

  const passing = entityRows.filter((r) => r.verdict === 'OK').map((r) => r.entites);
  const ceiling = passing.length > 0 ? Math.max(...passing) : 0;
  console.log(`-> Plus grand N sous le budget : ${ceiling} entites`);
  console.log(
    '   Le cout des champs ne depend pas de N — il ne depend que du nombre de\n' +
      "   cellules. C'est pour ca que la colonne « dont champs » ne bouge pas.\n",
  );

  console.log('2. Quelle cellule, quelle cadence de recalcul ? (1 500 entites)');
  const gridRows: Record<string, number | string>[] = [];
  for (const cellSize of [32, 64, 128]) {
    for (const fieldHz of [5, 10, 20]) {
      const r = run({ entities: 1500, cellSize, fieldHz });
      gridRows.push({
        cellule: `${cellSize} px`,
        'cellules/champ': r.fieldCells,
        'recalcul (Hz)': fieldHz,
        'une passe de 4 champs (ms)': round2(r.field.median),
        'pas p95 (ms)': round2(r.total.p95),
        verdict: r.total.p95 < BUDGET_MS ? 'OK' : 'hors budget',
      });
    }
  }
  console.table(gridRows);

  console.log(
    "\nRappel (§15.2) : le cout d'un champ est en O(cellules) et il y en a un par\n" +
      "joueur. C'est ce tableau, pas une intuition, qui fixe la taille de carte.",
  );
}

main();
