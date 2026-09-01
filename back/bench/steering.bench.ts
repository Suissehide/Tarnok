/**
 * Banc — que coute le recalcul de trajectoire par intervalle (tache 19) ?
 *
 * Avant la tache 19, ce banc mesurait `Horde.step` puis `SeparationGrid.apply`
 * comme deux passes distinctes : la separation recalculait sa repulsion a
 * CHAQUE tick, pour CHAQUE entite. Depuis la tache 19, les deux sont fondues
 * dans `Horde.step` — chaque entite ne recalcule sa trajectoire (direction du
 * champ melangee a la repulsion, tache 21) qu'un tick sur
 * `STEERING_RECOMPUTE_TICKS`, et conserve sa vitesse le reste du temps. Ce
 * banc mesure ce que ca coute REELLEMENT — pas separement.
 *
 * Depuis la tache 21, le saut maximal par tick n'est plus une consequence
 * REGLEE de `K` et du poids de repulsion : il est devenu INTRINSEQUE (la
 * vitesse propre de l'archetype, quelle que soit la densite). Ce banc publie
 * quand meme le saut maximal observe, en colonne, pour verifier PAR LA MESURE
 * que cette borne tient a l'echelle — pas pour la regler.
 *
 *   npm run bench:sep -w back
 */

import {
  FLOWFIELD_CELL,
  MAP_SIZE,
  SEPARATION_RADIUS,
  STEERING_RECOMPUTE_TICKS,
  STEERING_REPULSION_WEIGHT,
  TICK_HZ,
} from '@shared/constants';
import { FlowField } from '@shared/flowfield';
import { Horde } from '@shared/horde';
import { FORMATION, type WaveOrder } from '@shared/waves';

import { machineDescription, round2, stats } from './harness';

const DT = 1 / TICK_HZ;
const MEASURED_STEPS = 300;

/**
 * Chauffe avant mesure, en ticks.
 *
 * ⚠️ **Monte de 300 a 900 a la tache 18 de l'etape 6a, et sans ca le banc
 * mesurait autre chose que ce qu'il annonce.** `ENCIRCLE` fait naitre la horde
 * a `ENCIRCLE_RADIUS` (1 800 px) de sa cible ; a la vitesse de l'archetype 0
 * (95 px/s) il lui faut ~19 s, soit 570 ticks, pour seulement ARRIVER. Avec
 * 300 ticks de chauffe (10 s), la fenetre mesuree tombait en plein trajet :
 * un cout bas et une densite basse, mais ceux d'une horde qui n'est pas encore
 * la — le « decor qui ne produit pas ce qu'il pretend mesurer ». 900 ticks
 * (30 s) laissent la horde arriver ET s'entasser avant qu'on la chronometre.
 * `CLUSTER` naissait deja a ~400 px et n'en avait pas besoin ; il garde la
 * meme chauffe pour que les deux tableaux restent comparables.
 */
const WARMUP_STEPS = 900;

/**
 * Les deux geometries de naissance mesurees.
 *
 * ⚠️ **`CLUSTER` n'est plus ce que le directeur emet — `ENCIRCLE` l'est**
 * (tache 18 de l'etape 6a). Ce banc l'ignorait completement : sa formation
 * etait ecrite en dur, donc il aurait rendu EXACTEMENT les memes chiffres
 * apres le changement qu'avant, sans rien mesurer de ce qu'on lui demandait.
 * C'est le piege du « banc qui rend zero », deja paye par le banc des zones.
 *
 * Les deux restent mesurees : `CLUSTER` parce que c'est la reference
 * historique de toutes les lignes de cout du depot et le pire cas de densite
 * a la naissance, `ENCIRCLE` parce que c'est ce qui tourne desormais en jeu.
 */
const FORMATIONS = [
  { id: FORMATION.CLUSTER, label: 'CLUSTER (reference historique)' },
  { id: FORMATION.ENCIRCLE, label: 'ENCIRCLE (ce que le directeur emet)' },
] as const;

function makeHorde(count: number, formation: number): { horde: Horde; fields: FlowField[] } {
  const horde = new Horde(4000);
  const order: WaveOrder = {
    waveId: 1,
    spawnTick: 0,
    seed: 0x51ee_d001,
    archetype: 0,
    formation,
    // L'ancre EST la position des joueurs : c'est ce que fait le directeur
    // depuis la tache 18, et `ENCIRCLE` ne veut rien dire sans ca.
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

/**
 * Nombre moyen de voisins dans le rayon, par force brute.
 *
 * ⚠️ Meme role que dans l'ancien banc de separation : le cout d'un recalcul
 * croit avec le CARRE de la densite de voisins, donc cette colonne dit si le
 * chiffre de cout mesure un regime stable ou un entassement encore en train
 * de se former. Voir la doc equivalente dans `git log` (tache 0 / tache 18).
 */
function meanNeighbours(horde: Horde): number {
  const n = horde.count;
  const r2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
  let total = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        continue;
      }
      const dx = (horde.x[i] ?? 0) - (horde.x[j] ?? 0);
      const dy = (horde.y[i] ?? 0) - (horde.y[j] ?? 0);
      if (dx * dx + dy * dy <= r2) {
        total++;
      }
    }
  }
  return total / n;
}

interface Measurement {
  median: number;
  p95: number;
  /** Voisins moyens juste apres la chauffe. */
  neighboursEarly: number;
  /** Voisins moyens a la fin — doit rester proche du precedent. */
  neighboursLate: number;
  /** Plus grand deplacement observe par une entite en UN SEUL tick, en px. */
  maxJump: number;
}

function measure(count: number, formation: number): Measurement {
  const { horde, fields } = makeHorde(count, formation);
  const times: number[] = [];
  let neighboursEarly = 0;
  let maxJump = 0;

  for (let step = 0; step < WARMUP_STEPS + MEASURED_STEPS; step++) {
    const beforeX = horde.x.slice(0, horde.count);
    const beforeY = horde.y.slice(0, horde.count);

    const started = performance.now();
    horde.step(DT, fields, step);
    const elapsed = performance.now() - started;

    for (let i = 0; i < horde.count; i++) {
      const d = Math.hypot(
        (horde.x[i] ?? 0) - (beforeX[i] ?? 0),
        (horde.y[i] ?? 0) - (beforeY[i] ?? 0),
      );
      if (d > maxJump) {
        maxJump = d;
      }
    }

    if (step === WARMUP_STEPS) {
      neighboursEarly = meanNeighbours(horde);
    }
    if (step >= WARMUP_STEPS) {
      times.push(elapsed);
    }
  }
  const s = stats(times);
  return {
    median: s.median,
    p95: s.p95,
    neighboursEarly,
    neighboursLate: meanNeighbours(horde),
    maxJump,
  };
}

function main(): void {
  console.log(`Banc de trajectoire (tache 19) — ${machineDescription()}`);
  console.log(
    `K = STEERING_RECOMPUTE_TICKS = ${STEERING_RECOMPUTE_TICKS} ` +
      `(${round2((1000 * STEERING_RECOMPUTE_TICKS) / TICK_HZ)} ms a ${TICK_HZ} Hz), ` +
      `poids de repulsion = STEERING_REPULSION_WEIGHT = ${STEERING_REPULSION_WEIGHT} (sans dimension), ` +
      `rayon ${SEPARATION_RADIUS} px\n`,
  );

  for (const { id, label } of FORMATIONS) {
    console.log(`\n=== formation ${label} ===`);
    tableau(id);
  }
}

function tableau(formation: number): void {
  const rows = [250, 500, 1000, 1500, 2500, 4000].map((n) => {
    const m = measure(n, formation);
    const rejeu4 = m.median * 4;
    // Meme raisonnement que l'ancien banc de separation : une horde a moins de
    // 8 voisins par entite reste dans un regime bon marche, meme mal
    // stabilisee — le verdict ne peut pas etre faux dans cette bande.
    const stable = m.neighboursLate < 8 || m.neighboursLate <= m.neighboursEarly * 1.5;
    return {
      entites: n,
      'pas (ms)': round2(m.median),
      'voisins (debut)': round2(m.neighboursEarly),
      'voisins (fin)': round2(m.neighboursLate),
      equilibre: stable ? 'atteint' : 'NON ATTEINT',
      'rejeu de 3 ticks (ms)': round2(rejeu4),
      'saut maximal (px)': round2(m.maxJump),
      verdict: !stable
        ? 'mesure invalide'
        : rejeu4 < 1
          ? 'OK'
          : rejeu4 < 4
            ? 'a borner'
            : 'rouvrir le §3.2',
    };
  });
  console.table(rows);

  const cible1500 = rows.find((r) => r.entites === 1500);
  const cible4000 = rows.find((r) => r.entites === 4000);
  console.log(
    `\n-> A 1 500 entites (§4.1), un rejeu de trois ticks coute ` +
      `${cible1500?.['rejeu de 3 ticks (ms)']} ms ; a 4 000, ${cible4000?.['rejeu de 3 ticks (ms)']} ms ` +
      `(budget d'image 16,7 ms).`,
  );
  console.log(
    `   Saut maximal observe : ${cible1500?.['saut maximal (px)']} px (1 500) / ` +
      `${cible4000?.['saut maximal (px)']} px (4 000) — borne intrinseque depuis la tache 21 : la` +
      ` vitesse propre de l'archetype, jamais depassee quelle que soit la densite.`,
  );
  if (rows.some((r) => r.equilibre !== 'atteint')) {
    console.log(
      `\n⚠️  Un effectif au moins n'a PAS atteint son equilibre de densite. Son chiffre de\n` +
        `   cout ne mesure pas l'algorithme, il mesure un entassement qui grossit encore.\n` +
        `   Corriger STEERING_REPULSION_WEIGHT avant de lire le verdict.`,
    );
  }
}

main();
