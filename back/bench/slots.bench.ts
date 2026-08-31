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
 * la tache 7 a mesure qu'un salon de quatre joueurs aux slots d'armes pleins
 * entretient un ordre de grandeur de plus de projectiles qu'avec la seule arme
 * neutre. Un tel facteur pouvait se payer cher.
 *
 * ⚠️ **Les chiffres cites ici etaient calcules a CINQ slots**, et la tache 19
 * a ramene `WEAPON_SLOTS` a quatre : ils ont ete retires plutot que corriges a
 * l'aveugle — un banc rapporte ce qu'il mesure, il n'a pas a promettre un
 * nombre d'avance. Les colonnes ci-dessous sont derivees de `WEAPON_SLOTS`,
 * donc le banc suit le reglage au lieu de lever « slots d'armes pleins ».
 *
 * On compare le meme salon a l'arme neutre seule puis a un arsenal plein,
 * empile de plus en plus, horde constante.
 */
import { CARD } from '@shared/cards';
import { MAX_ENTITIES, TICK_HZ, WEAPON_SLOTS } from '@shared/constants';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { BASE_WEAPON_ID, WEAPONS } from '@shared/weapons';

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
  // ⚠️ Les armes se prennent dans le CATALOGUE, pas par indice suppose : un
  // `refId` recopie a la main leve des que `WEAPON_SLOTS` change, et le banc
  // entier meurt au premier appel.
  const arsenal = WEAPONS.filter((w) => w.id !== BASE_WEAPON_ID)
    .slice(0, slots)
    .map((w) => w.id);
  for (let p = 1; p <= 4; p++) {
    for (const arme of arsenal) {
      for (let k = 0; k < exemplaires; k++) {
        room.grantCard(p, { nature: CARD.WEAPON, refId: arme });
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
    [WEAPON_SLOTS, 1],
    [WEAPON_SLOTS, 4],
    [WEAPON_SLOTS, 8],
    [WEAPON_SLOTS, 16],
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
