import { MAP_SIZE } from './constants';
import { makeRandom } from './random';

/**
 * Un ordre de vague : la seule chose que le serveur decide et diffuse pour la
 * horde. 19 octets sur le fil (18 de charge utile + 1 octet de type), une
 * fois par vague, contre ~150 ko/s si l'on repliquait les positions (§2.1 de
 * la spec de l'etape 2).
 */
export interface WaveOrder {
  waveId: number;
  spawnTick: number;
  seed: number;
  archetype: number;
  formation: number;
  anchorX: number;
  anchorY: number;
  count: number;
}

export const FORMATION = { SCATTER: 0, RING: 1, COLUMN: 2, CLUSTER: 3 } as const;

export type FormationId = (typeof FORMATION)[keyof typeof FORMATION];

const SCATTER_RADIUS = 900;
const RING_RADIUS = 700;
const RING_JITTER = 90;
const COLUMN_LENGTH = 1400;
const COLUMN_WIDTH = 160;
const CLUSTER_COUNT = 5;
const CLUSTER_SPREAD = 800;
const CLUSTER_RADIUS = 170;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Remplit `outX` / `outY` avec les positions d'apparition de la vague.
 *
 * Fonction pure de `(seed, count, formation, ancre)` : c'est elle qui garantit
 * que deux clients font apparaitre la meme vague au meme endroit sans qu'un
 * seul octet de position ne transite.
 */
export function formationPositions(order: WaveOrder, outX: Float32Array, outY: Float32Array): void {
  const rng = makeRandom(order.seed);
  const { count, anchorX, anchorY } = order;

  // Precalcul des parametres constants selon la formation
  let heading = 0;
  const clusterCentres: Array<{ cx: number; cy: number }> = [];

  if (order.formation === FORMATION.COLUMN) {
    // L'orientation vient de la graine : deux vagues successives au meme
    // endroit ne se superposent pas.
    heading = makeRandom(order.seed ^ 0x5f37_1d2b)() * Math.PI * 2;
  } else if (order.formation === FORMATION.CLUSTER) {
    // Grappes denses : c'est ce qui fabrique la sensation de masse (§4.1),
    // pas le compteur. Precalcul des centres pour eviter de recreer le generateur
    // a chaque iteration.
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      const clusterRng = makeRandom(order.seed + c * 0x9e37_79b9);
      const cx = (clusterRng() - 0.5) * CLUSTER_SPREAD;
      const cy = (clusterRng() - 0.5) * CLUSTER_SPREAD;
      clusterCentres.push({ cx, cy });
    }
  }

  for (let i = 0; i < count; i++) {
    let dx = 0;
    let dy = 0;

    switch (order.formation) {
      case FORMATION.RING: {
        const angle = rng() * Math.PI * 2;
        const radius = RING_RADIUS + (rng() - 0.5) * RING_JITTER;
        dx = Math.cos(angle) * radius;
        dy = Math.sin(angle) * radius;
        break;
      }
      case FORMATION.COLUMN: {
        const along = (rng() - 0.5) * COLUMN_LENGTH;
        const across = (rng() - 0.5) * COLUMN_WIDTH;
        dx = Math.cos(heading) * along - Math.sin(heading) * across;
        dy = Math.sin(heading) * along + Math.cos(heading) * across;
        break;
      }
      case FORMATION.CLUSTER: {
        const cluster = i % CLUSTER_COUNT;
        const centre = clusterCentres[cluster];
        if (centre) {
          const { cx, cy } = centre;
          const angle = rng() * Math.PI * 2;
          const radius = Math.sqrt(rng()) * CLUSTER_RADIUS;
          dx = cx + Math.cos(angle) * radius;
          dy = cy + Math.sin(angle) * radius;
        }
        break;
      }
      default: {
        // SCATTER. `sqrt` donne une densite uniforme dans le disque ; sans lui
        // tout s'agglutine au centre.
        const angle = rng() * Math.PI * 2;
        const radius = Math.sqrt(rng()) * SCATTER_RADIUS;
        dx = Math.cos(angle) * radius;
        dy = Math.sin(angle) * radius;
        break;
      }
    }

    outX[i] = clamp(anchorX + dx, 0, MAP_SIZE);
    outY[i] = clamp(anchorY + dy, 0, MAP_SIZE);
  }
}
