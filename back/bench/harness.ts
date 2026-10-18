/** Petit outillage commun aux bancs : statistiques et description de la machine. */

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
