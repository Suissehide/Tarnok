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

type Participant = ReturnType<typeof makeParticipant>;

/** Cumule les deux mesures de divergence sur la duree d'un test. */
interface DriftStats {
  maxDrift: number;
  identityMismatches: number;
}

/**
 * Fait avancer toutes les simulations de `fromTick` (inclus) a `toTick`
 * (exclu), en accumulant dans `stats` la derive maximale et le nombre de
 * mesappariements d'identite observes.
 *
 * Factorise la boucle commune aux deux tests : elle seule sait comment
 * nourrir l'historique de joueurs, recalculer les champs a la cadence de
 * `FLOWFIELD_HZ` a partir des positions retardees, et faire avancer chaque
 * horde d'un pas.
 */
function advance(
  parts: readonly Participant[],
  fromTick: number,
  toTick: number,
  stats: DriftStats,
): void {
  const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
  const reference = parts[0];
  if (!reference) {
    throw new Error('aucun participant');
  }

  for (let tick = fromTick; tick < toTick; tick++) {
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
    for (const p of parts.slice(1)) {
      expect(p.horde.count).toBe(reference.horde.count);
    }

    // 2. Comparer position et identite par indice n'a de sens que si
    // l'indice designe la meme entite chez tous les participants. Rien ne le
    // garantit a priori : deux participants qui compacteraient differemment
    // apres une mort auraient le meme `count` mais pas les memes entites aux
    // memes indices, et la comparaison de position deviendrait muette.
    for (const p of parts.slice(1)) {
      for (let i = 0; i < reference.horde.count; i++) {
        const drift = Math.hypot(
          (p.horde.x[i] ?? 0) - (reference.horde.x[i] ?? 0),
          (p.horde.y[i] ?? 0) - (reference.horde.y[i] ?? 0),
        );
        if (drift > stats.maxDrift) {
          stats.maxDrift = drift;
        }

        if (p.horde.entityIdAt(i) !== reference.horde.entityIdAt(i)) {
          stats.identityMismatches++;
        }
      }
    }
  }
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

    const stats: DriftStats = { maxDrift: 0, identityMismatches: 0 };
    advance(parts, 0, STEPS, stats);

    // Le chiffre est affiche pour etre lisible plutot que cache : c'est lui qui
    // permettra de confirmer ou d'ajuster le seuil (§12 de la spec). Vitest 4
    // n'imprime les `console.log` que pour les tests en echec : ecrire
    // directement sur le flux du process contourne cette interception.
    process.stdout.write(
      `derive maximale observee : ${stats.maxDrift.toFixed(3)} px sur ${STEPS} pas\n`,
    );

    expect(stats.identityMismatches).toBe(0);
    expect(stats.maxDrift).toBeLessThan(DRIFT_LIMIT_PX);
  });

  it('reste identique quand une seconde vague apparait en cours de partie', () => {
    // Le premier test ne couvre que `spawn` sur une horde vide. En vrai, le
    // serveur emet une vague toutes les six secondes environ : `spawn`
    // s'exerce aussi sur une horde deja peuplee, avec la comptabilite de
    // capacite que ca implique. C'est ce cas que ce test verifie, plutot que
    // de dupliquer la premiere assertion sans avancer la simulation.
    const mapSeed = 0x7a11_0c0d;
    const parts = Array.from({ length: PARTICIPANTS }, () => makeParticipant(mapSeed));

    const firstWave: WaveOrder = {
      waveId: 1,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 1200,
      anchorY: 1200,
      count: 600,
    };
    for (const p of parts) {
      p.horde.spawn(firstWave);
    }

    const stats: DriftStats = { maxDrift: 0, identityMismatches: 0 };
    const FIRST_LEG = 100;
    const SECOND_LEG = 200;

    advance(parts, 0, FIRST_LEG, stats);

    const secondWave: WaveOrder = {
      waveId: 2,
      spawnTick: FIRST_LEG,
      seed: 0x1234_5678,
      archetype: 1,
      formation: FORMATION.RING,
      anchorX: 4000,
      anchorY: 2000,
      count: 400,
    };
    for (const p of parts) {
      p.horde.spawn(secondWave);
    }

    advance(parts, FIRST_LEG, FIRST_LEG + SECOND_LEG, stats);

    process.stdout.write(
      `derive maximale observee (seconde vague) : ${stats.maxDrift.toFixed(3)} px sur ${FIRST_LEG + SECOND_LEG} pas\n`,
    );

    expect(stats.identityMismatches).toBe(0);
    expect(stats.maxDrift).toBeLessThan(DRIFT_LIMIT_PX);
  });
});
