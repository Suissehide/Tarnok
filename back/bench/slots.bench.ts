/**
 * Banc des slots (etape 4, tache 12) — combien coute le tir depuis plusieurs
 * armes ?
 *
 * La tache 12 du plan demandait de rejouer les trois bancs parce que « le tir
 * depuis plusieurs slots change le cout du tick ». Aucun des trois ne le
 * mesurait : `sim` ne fait avancer que la horde, `net` ne compte que des
 * octets, `steering` ne regarde que la repulsion. Ce banc-la repond a la
 * question posee.
 *
 * Ce qui est en jeu : `Projectiles.collide` est en O(projectiles x entites), et
 * la tache 7 a mesure que quatre joueurs a cinq slots pleins entretiennent
 * jusqu'a 112 projectiles simultanes contre 28 avec la seule arme neutre. Un
 * facteur quatre sur le nombre de projectiles pouvait donc se payer cher.
 *
 * On compare le meme salon a 1, 3 et 6 armes par joueur, horde constante.
 */
import { CARD } from '@shared/cards';
import { MAX_ENTITIES, TICK_HZ } from '@shared/constants';
import { FORMATION, type WaveOrder } from '@shared/waves';

import { Room } from '../src/room';

const DT = 1 / TICK_HZ;

function peuple(room: Room, n: number): void {
  let id = 90_000;
  const parVague = 200;
  for (let k = 0; k < n; k += parVague) {
    const order: WaveOrder = {
      waveId: id++,
      spawnTick: room.tick,
      seed: (k * 2654435761) >>> 0,
      archetype: 0,
      formation: FORMATION.RING,
      anchorX: 3000,
      anchorY: 3000,
      count: Math.min(parVague, n - k),
    };
    room.horde.spawn(order);
  }
}

function mesure(
  slots: number,
  entites: number,
  exemplaires = 1,
): { p95: number; max: number; projectiles: number; tronques: number } {
  const room = new Room(0x5107_5107);
  for (const id of [1, 2, 3, 4]) {
    room.join(id);
  }
  for (let p = 1; p <= 4; p++) {
    for (let w = 1; w <= slots; w++) {
      for (let k = 0; k < exemplaires; k++) {
        room.grantCard(p, { nature: CARD.WEAPON, refId: w });
      }
    }
    room.applyInput(p, 1, 0, 0, 127, 40);
  }
  peuple(room, entites);
  const pas: number[] = [];
  let vivants = 0;
  for (let i = 0; i < 400; i++) {
    const t0 = performance.now();
    room.step(DT);
    pas.push(performance.now() - t0);
    vivants = Math.max(vivants, room.projectileCount);
  }
  pas.sort((a, b) => a - b);
  return {
    p95: pas[Math.floor(pas.length * 0.95)] ?? 0,
    max: pas[pas.length - 1] ?? 0,
    projectiles: vivants,
    tronques: room.projectilesTronques,
  };
}

console.log(`Banc slots — MAX_ENTITIES=${MAX_ENTITIES}, 4 joueurs, 400 pas mesures`);
const lignes: Record<string, unknown>[] = [];
for (const entites of [1500, 4000]) {
  for (const [slots, exemplaires] of [
    [0, 1],
    [5, 1],
    [5, 4],
    [5, 8],
    [5, 16],
  ] as const) {
    const r = mesure(slots, entites, exemplaires);
    lignes.push({
      entites,
      'armes par joueur': slots + 1,
      'exemplaires/arme': exemplaires,
      'projectiles vivants (max)': r.projectiles,
      'pas p95 (ms)': +r.p95.toFixed(3),
      'salves tronquees': r.tronques,
    });
  }
}
console.table(lignes);
