import type { FlowField } from './flowfield';
import { makeRandom } from './random';

/**
 * Carte d'obstacles, regeneree a l'identique de chaque cote.
 *
 * Le client **regenere** la carte depuis `mapSeed`, il ne la recoit pas : une
 * carte de 6000 px a 64 px par cellule fait 8836 cellules, et les envoyer
 * couterait plus cher que tout le reste du protocole reuni.
 *
 * Le champ de flux ne concorde entre serveur et client que si les deux murent
 * exactement les memes cellules — c'est la condition du §5.1 de la spec.
 */

/** Part de cellules murees visee. */
const BLOCKED_RATIO = 0.06;

/** Rayon, en cellules, de la zone laissee libre au centre. */
const SPAWN_CLEARANCE = 4;

export function generateObstacles(mapSeed: number, cols: number, rows: number): Uint8Array {
  const rng = makeRandom(mapSeed);
  const mask = new Uint8Array(cols * rows);

  const centreX = Math.floor(cols / 2);
  const centreY = Math.floor(rows / 2);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      // On tire pour **chaque** cellule, y compris celles qu'on laissera
      // libres : sauter un tirage ferait dependre la suite de la geometrie, et
      // deux cartes de tailles differentes ne seraient plus comparables.
      const draw = rng();
      const nearSpawn =
        Math.abs(cx - centreX) <= SPAWN_CLEARANCE && Math.abs(cy - centreY) <= SPAWN_CLEARANCE;
      if (!nearSpawn && draw < BLOCKED_RATIO) {
        mask[cy * cols + cx] = 1;
      }
    }
  }

  return mask;
}

/** Reporte un masque d'obstacles dans un champ, en effacant le precedent. */
export function applyObstacles(field: FlowField, mask: Uint8Array): void {
  field.blocked.fill(0);
  field.blocked.set(mask);
}
