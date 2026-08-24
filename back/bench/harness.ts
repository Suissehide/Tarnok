/**
 * Petit outillage commun aux bancs de l'etape 1.
 *
 * L'etape 1 est une porte : son livrable n'est pas du code, c'est un tableau de
 * chiffres. Tant qu'il n'est pas rempli, la cible de 1 500 entites, la carte
 * immense et le scaling x N sont des hypotheses.
 */

export interface Stats {
  median: number;
  p95: number;
  max: number;
  samples: number;
}

export function stats(values: readonly number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
    samples: sorted.length,
  };
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[index] ?? 0;
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export { makeRandom } from '@shared/random';

export function machineDescription(): string {
  const os = process.platform;
  const cpus = process.env.NUMBER_OF_PROCESSORS ?? '';
  return `node ${process.version} — ${os} ${process.arch}${cpus ? ` — ${cpus} coeurs` : ''}`;
}
