/**
 * Banc des slots — combien coute le tir depuis plusieurs armes ?
 *
 * `Projectiles.collide` est en O(projectiles x entites), et un salon de quatre
 * joueurs aux slots pleins entretient un ordre de grandeur de plus de
 * projectiles qu'avec la seule arme neutre. Les bancs `sim`, `net` et
 * `steering` ne mesurent pas ce cout.
 *
 * On compare le meme salon a l'arme neutre seule puis a un arsenal plein,
 * empile de plus en plus, horde constante. Les colonnes sont derivees de
 * `WEAPON_SLOTS`, donc le banc suit le reglage.
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
  //
  // ⚠️ Un joueur arrive deja arme : son arme de classe occupe un slot. On la
  // compte, et on complete jusqu'a `slots` avec ce qu'il ne porte pas encore,
  // sans quoi la derniere carte leve « slots d'armes pleins ».
  for (let p = 1; p <= 4; p++) {
    const tenues = [...(room.loadoutOf(p)?.weaponIds ?? [])];
    const arsenal = [
      ...tenues.slice(0, slots),
      ...WEAPONS.filter((w) => w.id !== BASE_WEAPON_ID && !tenues.includes(w.id))
        .slice(0, Math.max(0, slots - tenues.length))
        .map((w) => w.id),
    ];
    for (const [rang, arme] of arsenal.entries()) {
      // L'arme de classe est deja tenue une fois : un exemplaire de moins.
      const deja = rang < Math.min(slots, tenues.length) ? 1 : 0;
      for (let k = deja; k < exemplaires; k++) {
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
