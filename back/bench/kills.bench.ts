/**
 * Banc du rythme de mise a mort (etape 5a, tache 1) — **la porte du §3.3**.
 *
 * Donner des points de vie a la pietaille reduit MECANIQUEMENT le rythme de
 * mise a mort, et l'etape 3 a deja failli mourir de la : son generateur etait
 * reste calibre pour un test de charge du rendu (~37 apparitions/s contre
 * 2 morts/s) et la montee de niveau etait inatteignable avant que le joueur ne
 * meure encercle.
 *
 * ⚠️ **Aucun des quatre bancs existants ne repond a la question.** `sim` a sa
 * PROPRE horde locale et ne fait qu'avancer des positions — aucun combat ;
 * `net` ne compte que des octets ; `steering` ne regarde que la repulsion ;
 * `slots` mesure le COUT d'un tick, pas ce qu'il tue. Le plan demandait de
 * « rejouer `sim.bench.ts` et mesurer le rythme de mise a mort » : ce n'est pas
 * possible, `sim` ne tue rien. C'est le meme constat qu'a la tache 12 de
 * l'etape 4, qui avait du ecrire `slots.bench.ts` pour la meme raison.
 *
 * Ce banc mesure le pipeline REEL : quatre joueurs immobiles qui visent la
 * menace la plus proche, le vrai `WaveDirector`, la vraie arme de base, les
 * vrais orbes. On compte les morts par seconde de jeu.
 *
 *   npm run bench:kills -w back
 */
import { archetypeOf, HEAVY_HP } from '@shared/archetypes';
import { TICK_HZ } from '@shared/constants';
import { decodeSnapshot } from '@shared/protocol';

import { Room } from '../src/room';

const DT = 1 / TICK_HZ;

/** Duree mesuree, en secondes de jeu. */
const SECONDES = 60;
/** Graines de carte tirees d'avance : `Room.mapSeed` fait varier le resultat. */
const GRAINES = [
  0x1111_1111, 0x2222_2222, 0x3333_3333, 0x4444_4444, 0x5555_5555, 0x6666_6666, 0x7777_7777,
  0x8888_8888, 0x9999_9999, 0xaaaa_aaaa, 0xbbbb_bbbb, 0xcccc_cccc,
];

/**
 * Vise la menace la plus proche, sans bouger les pieds — le meme geste que le
 * test « un joueur passif atteint le niveau 2 » de `room.test.ts`. La visee est
 * une entree joueur depuis la tache 13 : sans elle, personne ne tire.
 */
function vise(room: Room, playerId: number, seq: number, px: number, py: number): void {
  let bestSlot = -1;
  let bestDist2 = Number.POSITIVE_INFINITY;
  for (let i = 0; i < room.horde.count; i++) {
    const dx = (room.horde.x[i] ?? 0) - px;
    const dy = (room.horde.y[i] ?? 0) - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestSlot = i;
    }
  }
  if (bestSlot < 0) {
    return;
  }
  const dx = (room.horde.x[bestSlot] ?? 0) - px;
  const dy = (room.horde.y[bestSlot] ?? 0) - py;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return;
  }
  room.applyInput(playerId, seq, 0, 0, (dx / len) * 127, (dy / len) * 127);
}

interface Mesure {
  morts: number;
  apparitions: number;
  hordeFinale: number;
  /** Part de pietaille lourde dans la horde encore debout a la fin. */
  partLourde: number;
  premiereMort: number;
  /**
   * Orbes au sol au pic de la fenetre mesuree, et orbes qu'une reserve pleine
   * a refuses (etape 6a, tache 15).
   *
   * ⚠️ **C'est ce banc, et lui seul, qui dit si la CAPACITE tient.** Depuis
   * que l'expiration a disparu, elle est la seule borne de `OrbField`, et elle
   * est silencieuse : sans ces deux nombres ici, `Room.orbesTronquees`
   * n'aurait aucun appelant hors de son propre test unitaire — exactement
   * l'oubli que `zonesTronquees` a paye a l'etape 5a.
   */
  orbesMax: number;
  orbesTronques: number;
}

function unEssai(seed: number): Mesure {
  const room = new Room(seed);
  const joueurs = [1, 2, 3, 4];
  for (const id of joueurs) {
    room.join(id);
  }
  // Positions de naissance, relevees une fois : les joueurs ne bougent pas.
  const snap = positions(room);

  let morts = 0;
  let apparitions = 0;
  let premiereMort = -1;
  let orbesMax = 0;
  const ticks = SECONDES * TICK_HZ;
  for (let t = 0; t < ticks; t++) {
    for (let k = 0; k < joueurs.length; k++) {
      const p = snap[k];
      if (p) {
        vise(room, joueurs[k] ?? 0, t + 1, p.x, p.y);
      }
    }
    const avant = room.horde.count;
    room.step(DT);
    const lot = room.drainDeaths().reduce((n, d) => n + d.ids.length, 0);
    morts += lot;
    apparitions += Math.max(0, room.horde.count - avant + lot);
    room.drainPickups();
    room.drainLevelUps();
    // ⚠️ **Fermer l'etalage, sinon on mesure un monde GELE.** Une montee de
    // niveau ouvre un draft qui gele le monde jusqu'a ce que tout le monde ait
    // pose son jeton — ou jusqu'a l'echeance, 20 s plus tard. Sans ces deux
    // lignes, la moitie de la fenetre mesuree ne tue rien du tout, et le banc
    // repondrait a une autre question que celle posee.
    for (const ouverture of room.drainDraftOpens()) {
      const cartes = ouverture.cards.length;
      for (let k = 0; k < joueurs.length && cartes > 0; k++) {
        room.setDraftToken(joueurs[k] ?? 0, k % cartes);
      }
    }
    room.drainDraftResults();
    if (premiereMort < 0 && room.drainRunOver()) {
      premiereMort = t;
    }
    if (room.orbCount > orbesMax) {
      orbesMax = room.orbCount;
    }
  }
  let lourds = 0;
  for (let i = 0; i < room.horde.count; i++) {
    if (archetypeOf(room.horde.archetype[i] ?? 0).hp === HEAVY_HP) {
      lourds++;
    }
  }
  return {
    morts,
    apparitions,
    hordeFinale: room.horde.count,
    partLourde: room.horde.count > 0 ? lourds / room.horde.count : 0,
    premiereMort,
    orbesMax,
    orbesTronques: room.orbesTronquees,
  };
}

/** Positions des joueurs, lues une fois au depart (ils ne bougent jamais). */
function positions(room: Room): { x: number; y: number }[] {
  const buffers: ArrayBuffer[] = [];
  room.snapshot({ push: (b: ArrayBuffer) => buffers.push(b) });
  const buf = buffers[0];
  return buf ? decodeSnapshot(buf).players.map((p) => ({ x: p.x, y: p.y })) : [];
}

function main(): void {
  console.log(
    `Banc du rythme de mise a mort — 4 joueurs immobiles, ${SECONDES} s de jeu, ` +
      `${GRAINES.length} graines de carte.\n`,
  );

  const lignes: Record<string, unknown>[] = [];
  let totalMorts = 0;
  let totalApparitions = 0;
  let orbesMax = 0;
  let orbesTronques = 0;
  for (const seed of GRAINES) {
    const m = unEssai(seed);
    totalMorts += m.morts;
    totalApparitions += m.apparitions;
    orbesMax = Math.max(orbesMax, m.orbesMax);
    orbesTronques += m.orbesTronques;
    lignes.push({
      graine: `0x${seed.toString(16)}`,
      'morts/s': +(m.morts / SECONDES).toFixed(2),
      'apparitions/s': +(m.apparitions / SECONDES).toFixed(2),
      'horde finale': m.hordeFinale,
      'dont lourds': `${Math.round(m.partLourde * 100)} %`,
      'fin de run (tick)': m.premiereMort < 0 ? '—' : m.premiereMort,
      'orbes au sol (pic)': m.orbesMax,
      'orbes tronques': m.orbesTronques,
    });
  }
  console.table(lignes);

  const mortsParSeconde = totalMorts / (SECONDES * GRAINES.length);
  const apparitionsParSeconde = totalApparitions / (SECONDES * GRAINES.length);
  console.log(`-> Rythme de mise a mort : ${mortsParSeconde.toFixed(2)} morts/s`);
  console.log(`-> Apparitions           : ${apparitionsParSeconde.toFixed(2)} /s`);
  console.log(
    `-> Rapport morts/apparitions : ${(mortsParSeconde / Math.max(1e-9, apparitionsParSeconde)).toFixed(2)}`,
  );
  console.log(`-> Orbes au sol, pic toutes graines : ${orbesMax}`);
  console.log(`-> Orbes tronques (capacite pleine) : ${orbesTronques}`);
}

main();
