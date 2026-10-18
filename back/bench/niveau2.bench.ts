/**
 * Banc de la montee au niveau 2.
 *
 * Rejoue sur 40 graines de carte le scenario du test « un joueur passif atteint
 * le niveau 2 » de `back/src/room.test.ts` — un joueur IMMOBILE qui vise la
 * menace la plus proche, le pipeline reel, un budget de 100 s — et compte les
 * echecs. Le test ne joue qu'UNE graine ; ce banc donne la part de graines qui
 * echouent, et c'est lui qui garde `HEAVY_FIRST_WAVE` et `palierHp`.
 *
 * ⚠️ Ce releve est anti-correle a la puissance des armes tant que le joueur ne
 * bouge pas : une arme plus forte tue PLUS LOIN, les orbes tombent au-dela
 * d'`ORB_PICKUP_RADIUS` et rien ne va les chercher (l'aimantation est un effet
 * de rendu, pas de jeu). Une cadence plus rapide peut donc AUGMENTER les
 * echecs ; le levier est le rayon de ramassage, pas la cadence.
 *
 * ⚠️ Pour un joueur seul, le boss coute d'abord par sa PRESENCE (un corps de
 * plus qui capte le tir automatique, un palier qui avance quand il tombe), bien
 * plus que par sa reserve de PV : baisser ses PV ne fait presque pas bouger les
 * echecs.
 *
 *   npm run bench:niveau2 -w back
 */
import { TICK_HZ } from '@shared/constants';
import { decodeSnapshot } from '@shared/protocol';

import { Room } from '../src/room';

const DT = 1 / TICK_HZ;
const BUDGET = TICK_HZ * 100;

function positionOf(room: Room, id: number): { x: number; y: number } {
  const buffers: ArrayBuffer[] = [];
  room.snapshot({ push: (b: ArrayBuffer) => buffers.push(b) });
  const buf = buffers[0];
  const found = buf ? decodeSnapshot(buf).players.find((p) => p.id === id) : undefined;
  return { x: found?.x ?? 0, y: found?.y ?? 0 };
}

function vise(room: Room, playerId: number, seq: number): void {
  const pos = positionOf(room, playerId);
  let bestSlot = -1;
  let bestDist2 = Number.POSITIVE_INFINITY;
  for (let i = 0; i < room.horde.count; i++) {
    const dx = (room.horde.x[i] ?? 0) - pos.x;
    const dy = (room.horde.y[i] ?? 0) - pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestSlot = i;
    }
  }
  if (bestSlot < 0) {
    return;
  }
  const dx = (room.horde.x[bestSlot] ?? 0) - pos.x;
  const dy = (room.horde.y[bestSlot] ?? 0) - pos.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return;
  }
  room.applyInput(playerId, seq, 0, 0, (dx / len) * 127, (dy / len) * 127);
}

interface Essai {
  ticks: number;
  palier: number;
  perdue: boolean;
  /** Tick auquel le boss du palier 0 est apparu, `-1` s'il n'est jamais venu. */
  tickBoss: number;
  /** Tick auquel la run a ete perdue, `-1` sinon. */
  tickPerte: number;
}

function unEssai(seed: number): Essai {
  const room = new Room(seed);
  room.join(1);
  let perdue = false;
  let tickBoss = -1;
  let tickPerte = -1;
  for (let i = 0; i < BUDGET; i++) {
    vise(room, 1, i + 1);
    room.step(DT);
    room.drainDeaths();
    room.drainPickups();
    if (tickBoss < 0 && room.bossEntityId !== null) {
      tickBoss = i + 1;
    }
    if (room.drainRunOver()) {
      perdue = true;
      tickPerte = i + 1;
    }
    const ups = room.drainLevelUps();
    if (ups.length > 0) {
      return { ticks: i + 1, palier: room.palier, perdue, tickBoss, tickPerte };
    }
  }
  return { ticks: -1, palier: room.palier, perdue, tickBoss, tickPerte };
}

const lignes: Record<string, unknown>[] = [];
const temps: number[] = [];
let echecs = 0;
for (let seed = 1; seed <= 40; seed++) {
  const m = unEssai(seed);
  if (m.ticks < 0) {
    echecs++;
  } else {
    temps.push(m.ticks / TICK_HZ);
  }
  lignes.push({
    graine: seed,
    's jusqu au niveau 2': m.ticks < 0 ? 'ECHEC' : +(m.ticks / TICK_HZ).toFixed(1),
    palier: m.palier,
    'boss a (s)': m.tickBoss < 0 ? '—' : +(m.tickBoss / TICK_HZ).toFixed(1),
    'run perdue a (s)': m.tickPerte < 0 ? '' : +(m.tickPerte / TICK_HZ).toFixed(1),
  });
}
console.table(lignes);
temps.sort((a, b) => a - b);
const mediane = temps.length > 0 ? temps[Math.floor(temps.length / 2)] : Number.NaN;
console.log(
  `-> echecs ${echecs}/40 — mediane ${mediane?.toFixed(1)} s, maximum ${temps[temps.length - 1]?.toFixed(1)} s`,
);
