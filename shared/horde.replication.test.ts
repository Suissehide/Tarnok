import { describe, expect, it } from 'vitest';

import { FLOWFIELD_CELL, FLOWFIELD_HZ, MAP_SIZE, TICK_HZ } from './constants';
import { FlowField } from './flowfield';
import { Horde } from './horde';
import { PlayerHistory } from './player-history';
import { FORMATION, type WaveOrder } from './waves';
import { applyObstacles, generateObstacles } from './worldmap';

const DT = 1 / TICK_HZ;
const STEPS = 600;
const PARTICIPANTS = 5; // le serveur, plus quatre clients
const ENTITIES = 1000;

/** Seuil de derive tolere, en pixels. Valeur de depart, a confirmer par la mesure. */
const DRIFT_LIMIT_PX = 2;

/**
 * Une instance de simulation : ce que fait le serveur, et ce que fait chaque
 * client. Le code est le meme des deux cotes — c'est tout le sujet.
 */
function makeParticipant(mapSeed: number): {
  horde: Horde;
  fields: FlowField[];
  history: PlayerHistory;
} {
  const horde = new Horde(4000);
  const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
  const mask = generateObstacles(mapSeed, probe.cols, probe.rows);
  const fields = Array.from({ length: 4 }, () => {
    const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    applyObstacles(f, mask);
    return f;
  });
  return { horde, fields, history: new PlayerHistory() };
}

describe("le livrable de l'etape 2", () => {
  it('fait converger 1 000 ennemis identiquement sur cinq simulations', () => {
    const mapSeed = 0xc0ff_ee12;
    const parts = Array.from({ length: PARTICIPANTS }, () => makeParticipant(mapSeed));

    const order: WaveOrder = {
      waveId: 1,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 1200,
      anchorY: 1200,
      count: ENTITIES,
    };
    for (const p of parts) {
      p.horde.spawn(order);
    }

    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    let maxDrift = 0;

    for (let tick = 0; tick < STEPS; tick++) {
      // Les joueurs bougent : un champ fige ne prouverait rien.
      const xs = [0, 1, 2, 3].map((p) => 3000 + Math.cos(tick * 0.02 + p) * 1500);
      const ys = [0, 1, 2, 3].map((p) => 3000 + Math.sin(tick * 0.02 + p) * 1500);

      for (const p of parts) {
        p.history.record(tick, xs, ys);

        if (tick % stepsPerField === 0) {
          // Les positions du tick retarde, pas celles du tick courant.
          const seen = p.history.delayed(tick);
          if (seen) {
            for (let f = 0; f < 4; f++) {
              p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
            }
            p.horde.retarget(seen.x, seen.y);
          }
        }

        p.horde.step(DT, p.fields);
      }

      // 1. L'ensemble des identites doit etre STRICTEMENT egal.
      const reference = parts[0];
      if (!reference) {
        throw new Error('aucun participant');
      }
      for (const p of parts.slice(1)) {
        expect(p.horde.count).toBe(reference.horde.count);
      }

      // 2. La position a le droit de deriver, mais de facon bornee.
      for (const p of parts.slice(1)) {
        for (let i = 0; i < reference.horde.count; i++) {
          const drift = Math.hypot(
            (p.horde.x[i] ?? 0) - (reference.horde.x[i] ?? 0),
            (p.horde.y[i] ?? 0) - (reference.horde.y[i] ?? 0),
          );
          if (drift > maxDrift) {
            maxDrift = drift;
          }
        }
      }
    }

    // Le chiffre est affiche pour etre lisible plutot que cache : c'est lui qui
    // permettra de confirmer ou d'ajuster le seuil (§12 de la spec).
    console.log(`derive maximale observee : ${maxDrift.toFixed(3)} px sur ${STEPS} pas`);

    expect(maxDrift).toBeLessThan(DRIFT_LIMIT_PX);
  });

  it('donne les memes identites a toutes les simulations', () => {
    const parts = Array.from({ length: PARTICIPANTS }, () => makeParticipant(1));
    const order: WaveOrder = {
      waveId: 9,
      spawnTick: 0,
      seed: 42,
      archetype: 1,
      formation: FORMATION.RING,
      anchorX: 2000,
      anchorY: 2000,
      count: 500,
    };
    for (const p of parts) {
      p.horde.spawn(order);
    }

    const reference = parts[0];
    if (!reference) {
      throw new Error('aucun participant');
    }
    const ids = Array.from({ length: reference.horde.count }, (_, i) =>
      reference.horde.entityIdAt(i),
    );

    for (const p of parts.slice(1)) {
      const autres = Array.from({ length: p.horde.count }, (_, i) => p.horde.entityIdAt(i));
      expect(autres).toEqual(ids);
    }
  });
});
