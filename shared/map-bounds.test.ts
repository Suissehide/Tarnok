import { describe, expect, it } from 'vitest';

import { FLOWFIELD_CELL, MAP_SIZE, TICK_HZ } from './constants';
import { FlowField } from './flowfield';
import { Horde } from './horde';
import { FORMATION, type WaveOrder } from './waves';

const DT = 1 / TICK_HZ;

/**
 * Tache 15 : les entites ne doivent jamais quitter `[0, MAP_SIZE]`.
 *
 * Recette mesuree par le diagnostic (voir le rapport de la tache 15) : un
 * joueur colle a un coin de la carte tire tout le champ vers ce coin, une
 * horde dense y forme un entassement, et la repulsion (tache 19 :
 * `STEERING_REPULSION_STRENGTH`, 420 px/s, plus la vitesse propre de
 * l'archetype) pousse plus fort que le champ ne tire en retour — sans clamp,
 * les entites giclent hors du monde.
 */
describe('les entites ne quittent jamais la carte', () => {
  it(
    'une horde entassee contre un coin, sous separation active pendant de ' +
      'nombreux pas, reste dans [0, MAP_SIZE]',
    () => {
      const N = 800;
      const horde = new Horde(N);

      // Grappe dense, ancree tout pres du coin (0, 0) : formationPositions
      // clampe deja la sortie, donc l'entassement se forme juste a l'interieur
      // du bord plutot qu'au centre de la carte.
      const order: WaveOrder = {
        waveId: 1,
        spawnTick: 0,
        seed: 0x51ee_d001,
        archetype: 0,
        formation: FORMATION.CLUSTER,
        anchorX: 40,
        anchorY: 40,
        count: N,
      };
      horde.spawn(order);

      // Le joueur reste colle au coin : le champ tire toute la horde vers le
      // bord en permanence, exactement la configuration mesuree.
      const field = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
      field.update(0, 0);
      const fields = [field];

      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;

      const TICKS = 1200;
      for (let t = 0; t < TICKS; t++) {
        horde.step(DT, fields, t);

        for (let i = 0; i < horde.count; i++) {
          const x = horde.x[i] ?? 0;
          const y = horde.y[i] ?? 0;
          if (x < minX) {
            minX = x;
          }
          if (x > maxX) {
            maxX = x;
          }
          if (y < minY) {
            minY = y;
          }
          if (y > maxY) {
            maxY = y;
          }
        }
      }

      process.stdout.write(
        `bornes observees sur ${TICKS} pas : x dans [${minX.toFixed(1)}, ${maxX.toFixed(1)}], ` +
          `y dans [${minY.toFixed(1)}, ${maxY.toFixed(1)}]\n`,
      );

      expect(minX).toBeGreaterThanOrEqual(0);
      expect(maxX).toBeLessThanOrEqual(MAP_SIZE);
      expect(minY).toBeGreaterThanOrEqual(0);
      expect(maxY).toBeLessThanOrEqual(MAP_SIZE);
    },
  );
});
