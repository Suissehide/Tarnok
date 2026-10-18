/**
 * Banc des zones au sol — **ce que les zones coutent, en octets et en
 * millisecondes.**
 *
 * **1. Le trafic.** La fusion rend le NOMBRE de zones fonction de la surface
 * couverte, pas de la cadence. Mais le rafraichissement doit etre annonce —
 * sinon la zone du client meurt avant celle du serveur — et l'annoncer a
 * chaque fusion ferait suivre au trafic la cadence des armes. La parade : une
 * re-annonce par `ZONE_REFRESH_INTERVAL_TICKS` au plus. Ce banc mesure le ko/s
 * recu par chaque client, a 1, 4 et 8 exemplaires par arme.
 *
 * **2. Le cout du balayage.** Le recouvrement est en O(zones²) et le
 * marquage en O(zones x entites). `ZONE_RADIUS` est le levier des deux : il
 * fixe le nombre de zones qu'une surface donnee peut porter (la fusion les
 * espace d'au moins un rayon) ET la surface que chacune balaie. On mesure donc
 * le balayage a nombre de zones croissant, a 1 500 et 4 000 entites.
 *
 *   npm run bench:zones -w back
 */

import { ARCHETYPES, HEAVY_HP } from '@shared/archetypes';
import { CARD } from '@shared/cards';
import { MAX_ENTITIES, TICK_HZ, ZONE_LIFETIME_TICKS, ZONE_RADIUS } from '@shared/constants';
import { ELEMENT } from '@shared/elements';
import { Horde } from '@shared/horde';
import { ZONE_BYTES } from '@shared/protocol';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { WEAPONS } from '@shared/weapons';
import { ZoneField } from '@shared/zones';

import { markInZones, Reactions } from '../src/combat';
import { Room } from '../src/room';
import { stats } from './harness';

const DT = 1 / TICK_HZ;

/** Budget d'un pas serveur, en ms : un tiers d'un tick a 30 Hz. */
const BUDGET_MS = 11.11;

/** Ancre commune a la horde et aux zones du banc de balayage. */
const ANCRE = 3000;

/**
 * L'archetype LOURD, pas decoratif.
 *
 * ⚠️ **Avec la pietaille legere, ce banc ne mesure RIEN.** Un ennemi tue du
 * meme impact n'est pas marque (`resolveProjectileDamage`), donc il ne reagit
 * jamais ; or les zones naissent de la REACTION : pas de reaction, pas une
 * seule zone, et le banc rend des zeros partout.
 */
const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;
if (LOURD < 0) {
  throw new Error('le catalogue doit porter au moins un archetype lourd');
}

const ARME_BRAISE = WEAPONS.find((w) => w.element === ELEMENT.BRAISE)?.id ?? -1;
const ARME_GIVRE = WEAPONS.find((w) => w.element === ELEMENT.GIVRE)?.id ?? -1;
if (ARME_BRAISE < 0 || ARME_GIVRE < 0) {
  throw new Error('le catalogue doit porter au moins une arme de chaque element');
}

function peuple(horde: Horde, n: number, anchorX = ANCRE, anchorY = ANCRE): void {
  let id = 90_000;
  const parVague = 200;
  for (let k = 0; k < n; k += parVague) {
    const order: WaveOrder = {
      waveId: id++,
      spawnTick: 0,
      seed: (k * 2654435761) >>> 0,
      archetype: LOURD,
      formation: FORMATION.RING,
      anchorX,
      anchorY,
      count: Math.min(parVague, n - k),
    };
    horde.spawn(order);
  }
}

/**
 * Un salon a quatre joueurs, chacun portant les deux armes elementaires en
 * `exemplaires` exemplaires, tous visant en continu — le decor de trafic le
 * plus defavorable (chaque exemplaire elargit la salve d'un projectile, donc
 * multiplie les fins de course, donc les poses).
 */
function salonElementaire(exemplaires: number, entites: number): Room {
  const room = new Room(0x20_0e_5a_10);
  for (const id of [1, 2, 3, 4]) {
    room.join(id);
    for (let k = 0; k < exemplaires; k++) {
      room.grantCard(id, { nature: CARD.WEAPON, refId: ARME_BRAISE });
      room.grantCard(id, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    }
    // Visee fixe : ce banc mesure des poses, pas la qualite d'un ciblage. Une
    // visee qui suit la horde ferait varier les fins de course d'une
    // configuration a l'autre et melangerait deux effets.
    room.applyInput(id, 1, 0, 0, 127, 40);
  }
  peuple(room.horde, entites);
  return room;
}

interface Trafic {
  annonces: number;
  zonesMax: number;
  tronquees: number;
  p95: number;
}

function trafic(exemplaires: number, entites: number, ticks: number): Trafic {
  const room = salonElementaire(exemplaires, entites);
  let annonces = 0;
  let zonesMax = 0;
  const pas: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    room.step(DT);
    pas.push(performance.now() - t0);
    annonces += room.drainZones().length;
    room.drainReactions();
    room.drainDeaths();
    room.drainPickups();
    zonesMax = Math.max(zonesMax, room.zoneCount);
  }
  return { annonces, zonesMax, tronquees: room.zonesTronquees, p95: stats(pas).p95 };
}

/**
 * Le balayage seul : `markInZones` sur une horde figee, a nombre de zones
 * croissant. Isole le O(zones x entites) du reste du pas — c'est le terme que
 * `ZONE_RADIUS` pilote, et il tourne A CHAQUE tick, contrairement au
 * recouvrement qui ne tourne qu'a la creation d'une zone.
 */
function balayage(entites: number, nZones: number, iterations = 200): number {
  const horde = new Horde(MAX_ENTITIES);
  peuple(horde, entites);
  const zones = new ZoneField();
  // Espacees d'un rayon : c'est exactement ce que la regle de fusion produit
  // (deux zones du meme element finissent toujours a plus de `ZONE_RADIUS`
  // l'une de l'autre), donc le decor le plus dense qu'un salon puisse porter.
  const cote = Math.ceil(Math.sqrt(nZones));
  for (let k = 0; k < nZones; k++) {
    const cx = ANCRE + ((k % cote) - cote / 2) * ZONE_RADIUS;
    const cy = ANCRE + (Math.floor(k / cote) - cote / 2) * ZONE_RADIUS;
    zones.spawn(k % 2 === 0 ? ELEMENT.BRAISE : ELEMENT.GIVRE, cx, cy, 0, 0);
  }
  const reactions = new Reactions();
  const pas: number[] = [];
  for (let i = 0; i < iterations; i++) {
    // Toujours dans la duree de vie des zones : `markInZones` ignore ce que
    // `aliveAt` juge perime, et mesurer un balayage qui ne balaie rien ne
    // prouverait rien.
    const tick = i % ZONE_LIFETIME_TICKS;
    const t0 = performance.now();
    markInZones(horde, zones, tick, reactions);
    pas.push(performance.now() - t0);
    reactions.drain();
  }
  return stats(pas).p95;
}

/** Le recouvrement seul : O(zones²), une fois par CREATION de zone. */
function recouvrement(nZones: number, iterations = 2000): number {
  const zones = new ZoneField();
  const cote = Math.ceil(Math.sqrt(nZones));
  for (let k = 0; k < nZones; k++) {
    const cx = ANCRE + ((k % cote) - cote / 2) * ZONE_RADIUS;
    const cy = ANCRE + (Math.floor(k / cote) - cote / 2) * ZONE_RADIUS;
    zones.spawn(k % 2 === 0 ? ELEMENT.BRAISE : ELEMENT.GIVRE, cx, cy, 0, 0);
  }
  const reactions = new Reactions();
  const pas: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    reactions.onZoneCreated(zones, i % Math.max(1, nZones), 0);
    pas.push(performance.now() - t0);
    reactions.drain();
  }
  return stats(pas).p95;
}

const TICKS = 300;
const SECONDES = TICKS / TICK_HZ;
const CLIENTS = 4;

console.log(
  `Banc zones — ZONE_RADIUS=${ZONE_RADIUS}, ZONE_LIFETIME_TICKS=${ZONE_LIFETIME_TICKS}, ` +
    `ZONE_BYTES=${ZONE_BYTES}, ${CLIENTS} joueurs, ${TICKS} pas mesures`,
);

console.log('\n1. Trafic ZONE — ce que CHAQUE client recoit');
const traficRows: Record<string, unknown>[] = [];
for (const entites of [1500]) {
  for (const exemplaires of [1, 4, 8]) {
    const r = trafic(exemplaires, entites, TICKS);
    traficRows.push({
      entites,
      'exemplaires/arme': exemplaires,
      'zones vivantes (max)': r.zonesMax,
      'annonces/s/joueur': +(r.annonces / SECONDES / CLIENTS).toFixed(1),
      'ko/s par client': +((r.annonces * ZONE_BYTES) / SECONDES / 1024).toFixed(2),
      'zones tronquees': r.tronquees,
      'pas p95 (ms)': +r.p95.toFixed(3),
    });
  }
}
console.table(traficRows);

console.log('\n2. Cout du balayage — markInZones, O(zones x entites), a CHAQUE tick');
const balayageRows: Record<string, unknown>[] = [];
for (const entites of [1500, 4000]) {
  for (const nZones of [0, 15, 30, 60, 128]) {
    const p95 = balayage(entites, nZones);
    balayageRows.push({
      entites,
      'zones vivantes': nZones,
      'balayage p95 (ms)': +p95.toFixed(3),
      'part du budget': `${((p95 / BUDGET_MS) * 100).toFixed(1)} %`,
    });
  }
}
console.table(balayageRows);

console.log('\n3. Cout du recouvrement — O(zones²), une fois par CREATION');
const recouvrementRows: Record<string, unknown>[] = [];
for (const nZones of [15, 30, 60, 128]) {
  const p95 = recouvrement(nZones);
  recouvrementRows.push({
    'zones vivantes': nZones,
    'recouvrement p95 (ms)': +p95.toFixed(4),
  });
}
console.table(recouvrementRows);

/**
 * **Le PIRE cas du rafraichissement, et le seul chiffre qui borne quoi que ce
 * soit.** Le decor de la section 1 depend du catalogue : il mesure ce que les
 * cadences d'AUJOURD'HUI produisent, et une arme elementaire rapide le ferait
 * mentir des le prochain ajout. Ici, chaque zone vivante est arrosee a CHAQUE
 * tick — la limite que la regle de pose autorise — et on compte les annonces.
 *
 * Sans plafond, c'est `zones x TICK_HZ` annonces par seconde, donc un trafic
 * fonction de la cadence des armes. Avec le plafond de re-annonce, c'est
 * `zones / (ZONE_REFRESH_INTERVAL_TICKS / TICK_HZ)`, donc un
 * trafic fonction du seul NOMBRE de zones — que la fusion borne deja par la
 * surface.
 */
function rafraichissementSature(nZones: number, ticks: number): number {
  const zones = new ZoneField();
  const cote = Math.ceil(Math.sqrt(nZones));
  const centres: [number, number][] = [];
  for (let k = 0; k < nZones; k++) {
    const cx = ANCRE + ((k % cote) - cote / 2) * ZONE_RADIUS;
    const cy = ANCRE + (Math.floor(k / cote) - cote / 2) * ZONE_RADIUS;
    centres.push([cx, cy]);
    zones.spawn(ELEMENT.BRAISE, cx, cy, 0, 0);
  }
  let annonces = 0;
  for (let tick = 1; tick <= ticks; tick++) {
    zones.expire(tick);
    for (const [cx, cy] of centres) {
      zones.spawn(ELEMENT.BRAISE, cx, cy, 0, tick);
    }
    // Ce que `Room#announceZones` met en file : un message par zone dont le
    // `bornTick` vaut le tick courant, creation comme rafraichissement.
    for (let z = 0; z < zones.count; z++) {
      if (zones.bornTick[z] === tick) {
        annonces++;
      }
    }
  }
  return annonces;
}

console.log('\n4. Pire cas du rafraichissement — chaque zone arrosee a CHAQUE tick');
const satureRows: Record<string, unknown>[] = [];
for (const nZones of [15, 30, 60]) {
  const annonces = rafraichissementSature(nZones, TICKS);
  satureRows.push({
    'zones vivantes': nZones,
    'annonces/s': +(annonces / SECONDES).toFixed(1),
    'ko/s par client': +((annonces * ZONE_BYTES) / SECONDES / 1024).toFixed(2),
  });
}
console.table(satureRows);

console.log('\n5. Pas complet d un vrai salon, avec et sans armes elementaires');
const pasRows: Record<string, unknown>[] = [];
for (const entites of [1500, 4000]) {
  const sans = new Room(0x20_0e_5a_10);
  for (const id of [1, 2, 3, 4]) {
    sans.join(id);
    sans.applyInput(id, 1, 0, 0, 127, 40);
  }
  peuple(sans.horde, entites);
  const sansPas: number[] = [];
  for (let i = 0; i < TICKS; i++) {
    const t0 = performance.now();
    sans.step(DT);
    sansPas.push(performance.now() - t0);
    sans.drainZones();
    sans.drainReactions();
    sans.drainDeaths();
    sans.drainPickups();
  }
  pasRows.push({
    entites,
    armes: 'neutres seules',
    'zones vivantes (max)': 0,
    'pas p95 (ms)': +stats(sansPas).p95.toFixed(3),
  });
  for (const exemplaires of [1, 8]) {
    const r = trafic(exemplaires, entites, TICKS);
    pasRows.push({
      entites,
      armes: `elementaires x${exemplaires}`,
      'zones vivantes (max)': r.zonesMax,
      'pas p95 (ms)': +r.p95.toFixed(3),
    });
  }
}
console.table(pasRows);
