/**
 * Banc des quatre elements (etape 5b, tache 10) — **les trois mesures que les
 * taches precedentes n'ont pas pu faire, faute d'armes portant Foudre et
 * Poix.** La tache 9 vient de les poser ; ce banc les exploite.
 *
 * ⚠️ **Peuple de LOURDS, et c'est une legon deja payee.** Le banc `zones` a
 * menti une premiere fois avec de la pietaille legere : tuee du meme impact,
 * elle n'est jamais marquee, donc jamais de reaction, donc zero zone —
 * un banc qui rend zero et parait vert. C'est l'archetype LOURD
 * (`HEAVY_HP`) qui porte le systeme elementaire ; c'est lui qui peuple ce
 * banc, partout, sans exception.
 *
 * Trois mesures, trois questions distinctes :
 *
 * **1. La porte de performance du §7.** `chainTargets` (`shared/chain.ts`)
 * est une recherche `O(jumps x horde.count)` declenchee A CHAQUE IMPACT de
 * Foudre — pas une fois par tick, une fois par PROJECTILE qui touche. Avec
 * quatre joueurs qui portent la bobine-tesla (la Foudre la plus rapide du
 * catalogue, `cooldownTicks: 15`, deux projectiles par salve) et une horde a
 * 4000 entites, combien d'impacts simultanes le pas encaisse-t-il, et le p95
 * tient-il sous le budget de tick (`1000 / TICK_HZ / 3`, ~11,11 ms) ?
 *
 * **2. Le point de revue n°5 : `truncatedZones` a ZERO.** La tache 6 a
 * change la regle de fusion des zones — deux zones de `kind` different ne
 * fusionnent plus, un bug de production mesure et corrige. Sa seule mesure
 * etait SYNTHETIQUE (8 `kind` x 16 foyers, jusqu'a 100 % de `ZONE_CAPACITY`),
 * faute d'armes reelles pour les cinq reactions. Ce banc peut enfin equiper
 * quatre elements a la fois et regarder si `zonesTronquees` bouge en jeu
 * reel.
 *
 * **3. La densite en Verglas.** `resolveVerglasCollisions` est en O(k²) sur
 * sa liste `sliding`, dont le docbloc suppose que « la geometrie borne
 * naturellement k ». Rien ne le verifie. Une entite qui glisse SAUTE
 * entierement son calcul de repulsion (`shared/horde.ts`,
 * `#recomputeSteering`, le `continue` juste apres l'amortissement
 * d'inertie) : elle perd sa correction anti-agglomeration pendant qu'elle
 * glisse. Une vague qui converge en ENCIRCLE (la formation reelle d'un
 * spawn autour d'un joueur) vers un point unique ou tourne une zone de
 * Verglas est le cas adversarial exact que la repulsion existe pour empecher
 * — et Verglas desactive precisement cette garde la ou elle compte le plus.
 *
 *   npm run bench:elements -w back
 */

import { ARCHETYPES, HEAVY_HP } from '@shared/archetypes';
import { CARD } from '@shared/cards';
import { chainTargets } from '@shared/chain';
import {
  CHAIN_JUMPS,
  CHAIN_RADIUS,
  MAP_SIZE,
  MAX_ENTITIES,
  TICK_HZ,
  ZONE_CAPACITY,
} from '@shared/constants';
import { ELEMENT } from '@shared/elements';
import { FlowField } from '@shared/flowfield';
import { Horde } from '@shared/horde';
import { packZoneKind } from '@shared/protocol';
import { REACTION } from '@shared/reactions';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { WEAPONS } from '@shared/weapons';
import { ZoneField } from '@shared/zones';

import { OrbField, resolveVerglasCollisions } from '../src/combat';
import { Room } from '../src/room';
import { machineDescription, stats } from './harness';

const DT = 1 / TICK_HZ;

/** Budget d'un pas serveur (§10 de la spec, §7 pour la porte de Foudre). */
const BUDGET_MS = 1000 / TICK_HZ / 3;

/** Ancre commune aux decors 1 et 2 : le centre de la carte, ou les joueurs naissent (`MAP_SIZE / 2`). */
const CENTRE = MAP_SIZE / 2;

/**
 * L'archetype LOURD — voir l'avertissement en tete de fichier. Meme
 * extraction que `zones.bench.ts`, jamais recopiee en dur.
 */
const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;
if (LOURD < 0) {
  throw new Error('le catalogue doit porter au moins un archetype lourd');
}

const ARME_BRAISE = WEAPONS.find((w) => w.element === ELEMENT.BRAISE)?.id ?? -1;
const ARME_GIVRE = WEAPONS.find((w) => w.element === ELEMENT.GIVRE)?.id ?? -1;
// bobine-tesla : la Foudre la plus rapide du catalogue (cooldownTicks: 15,
// deux projectiles par salve) — le pire cas de frequence d'impact, donc le
// pire cas d'appels a `chainTargets`.
const ARME_FOUDRE = WEAPONS.find((w) => w.name === 'bobine-tesla')?.id ?? -1;
// seringue-a-poix : la Poix la plus rapide (cooldownTicks: 18, trois
// projectiles) — meme raisonnement, pour maximiser les poses de zone.
const ARME_POIX = WEAPONS.find((w) => w.name === 'seringue-a-poix')?.id ?? -1;
if (ARME_BRAISE < 0 || ARME_GIVRE < 0 || ARME_FOUDRE < 0 || ARME_POIX < 0) {
  throw new Error('le catalogue doit porter les quatre armes elementaires attendues');
}

/**
 * Peuple une horde de LOURDS en vagues de 200, ancrees au meme point que les
 * joueurs — identique a `peuple` de `zones.bench.ts`, dupliquee ici plutot
 * qu'importee (les deux bancs restent independants l'un de l'autre).
 */
function peuple(horde: Horde, n: number, anchorX = CENTRE, anchorY = CENTRE): void {
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

// ---------------------------------------------------------------------------
// 1. La porte du §7 — chainTargets par impact de Foudre
// ---------------------------------------------------------------------------

/**
 * Un salon a quatre joueurs, chacun portant `exemplaires` bobine-tesla,
 * visant en continu une horde LOURDE de `entites` ennemis. Chaque impact de
 * Foudre declenche `chainTargets` — c'est cet appel, repete a chaque
 * projectile qui touche, que ce decor met sous tension.
 */
function salonFoudre(exemplaires: number, entites: number): Room {
  const room = new Room(0x20_0e_5b_10);
  for (const id of [1, 2, 3, 4]) {
    room.join(id);
    for (let k = 0; k < exemplaires; k++) {
      room.grantCard(id, { nature: CARD.WEAPON, refId: ARME_FOUDRE });
    }
    // Visee fixe, meme discipline que `zones.bench.ts` : on mesure des
    // impacts, pas la qualite d'un ciblage.
    room.applyInput(id, 1, 0, 0, 127, 40);
  }
  peuple(room.horde, entites);
  return room;
}

function porteChaine(exemplaires: number, entites: number, ticks: number): number {
  const room = salonFoudre(exemplaires, entites);
  const pas: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    room.step(DT);
    pas.push(performance.now() - t0);
    room.drainZones();
    room.drainReactions();
    room.drainDeaths();
    room.drainPickups();
  }
  return stats(pas).p95;
}

/**
 * `chainTargets` seule, isolee de tout le reste du pas — le meme geste que
 * `balayage`/`recouvrement` dans `zones.bench.ts` : mesurer le terme
 * O(horde.count) tel que son docbloc le decrit, avant de le retrouver noye
 * dans un pas complet.
 */
function coutChaineSeule(entites: number, iterations = 2000): number {
  const horde = new Horde(MAX_ENTITIES);
  peuple(horde, entites);
  const exclude = new Set<number>();
  const pas: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    chainTargets(horde, CENTRE, CENTRE, CHAIN_RADIUS, CHAIN_JUMPS, exclude);
    pas.push(performance.now() - t0);
  }
  return stats(pas).p95;
}

// ---------------------------------------------------------------------------
// 2. Le point de revue n°5 — truncatedZones a ZERO, avec de vraies armes
// ---------------------------------------------------------------------------

/**
 * Un salon a quatre joueurs, chacun portant `exemplaires` exemplaires des
 * QUATRE armes elementaires (Braise, Givre, Foudre, Poix) — de quoi
 * declencher les cinq reactions du §5 en jeu reel, pas en synthetique.
 */
function salonQuatreElements(exemplaires: number, entites: number): Room {
  const room = new Room(0x20_0e_5b_20);
  for (const id of [1, 2, 3, 4]) {
    room.join(id);
    for (let k = 0; k < exemplaires; k++) {
      room.grantCard(id, { nature: CARD.WEAPON, refId: ARME_BRAISE });
      room.grantCard(id, { nature: CARD.WEAPON, refId: ARME_GIVRE });
      room.grantCard(id, { nature: CARD.WEAPON, refId: ARME_FOUDRE });
      room.grantCard(id, { nature: CARD.WEAPON, refId: ARME_POIX });
    }
    room.applyInput(id, 1, 0, 0, 127, 40);
  }
  peuple(room.horde, entites);
  return room;
}

interface Occupation {
  zonesMax: number;
  tronquees: number;
  p95: number;
}

function occupationZones(exemplaires: number, entites: number, ticks: number): Occupation {
  const room = salonQuatreElements(exemplaires, entites);
  let zonesMax = 0;
  const pas: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    room.step(DT);
    pas.push(performance.now() - t0);
    room.drainZones();
    room.drainReactions();
    room.drainDeaths();
    room.drainPickups();
    zonesMax = Math.max(zonesMax, room.zoneCount);
  }
  return { zonesMax, tronquees: room.zonesTronquees, p95: stats(pas).p95 };
}

/**
 * Meme decor, mais en REGIME SOUTENU : la horde statique de `occupationZones`
 * s'epuise en 20 s (rien ne la reapprovisionne), donc elle ne dit rien d'un
 * combat qui dure. Ici, une vague de LOURDS est reinjectee toutes les 3 s
 * (90 ticks — l'ordre de grandeur d'un `WaveDirector` reel) tant que la
 * population reste sous `plafond`, sur `ticks` pas (300 ticks = 60 s).
 * `truncatedZones` doit rester a zero ICI aussi : une fusion qui tient 20 s
 * mais pas 60 s ne tiendrait pas une vraie run.
 */
function occupationSoutenue(exemplaires: number, ticks: number, plafond = 3500): Occupation {
  const room = salonQuatreElements(exemplaires, 4000);
  let idSuivant = 900_000;
  let zonesMax = 0;
  const pas: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    room.step(DT);
    pas.push(performance.now() - t0);
    room.drainZones();
    room.drainReactions();
    room.drainDeaths();
    room.drainPickups();
    zonesMax = Math.max(zonesMax, room.zoneCount);
    if (i % 90 === 0 && room.horde.count < plafond) {
      peuple(room.horde, 500, idSuivant);
      idSuivant += 10;
    }
  }
  return { zonesMax, tronquees: room.zonesTronquees, p95: stats(pas).p95 };
}

// ---------------------------------------------------------------------------
// 3. La densite en Verglas — k peut-il depasser ce que la geometrie suppose ?
// ---------------------------------------------------------------------------

/**
 * Une vague ENCIRCLE de LOURDS, nee autour d'un point unique
 * (`ENCIRCLE_RADIUS`, 1800 px — la formation reelle d'un spawn autour d'un
 * joueur), convergeant vers ce meme point ou une zone de Verglas est
 * entretenue en continu (le feu soutenu de Givre + Poix qu'un vrai groupe
 * plante a un endroit produirait). `Horde.step` et `resolveVerglasCollisions`
 * sont les fonctions REELLES ; seule la creation de la zone est directe
 * (`zones.spawn`, ce que `postZone` ferait) pour isoler la question posee —
 * la geometrie de la convergence, pas le declenchement de la reaction.
 */
function densiteVerglas(
  tailleVague: number,
  ticks: number,
): { kMax: number; tickPic: number; p95Collisions: number; survivants: number } {
  const field = new FlowField(MAP_SIZE, 64);
  field.update(CENTRE, CENTRE);

  const horde = new Horde(MAX_ENTITIES);
  const order: WaveOrder = {
    waveId: 1,
    spawnTick: 0,
    seed: 0x5eed_7a1e,
    archetype: LOURD,
    formation: FORMATION.ENCIRCLE,
    anchorX: CENTRE,
    anchorY: CENTRE,
    count: tailleVague,
  };
  horde.spawn(order, field);

  const zones = new ZoneField();
  const orbs = new OrbField(MAX_ENTITIES);
  const kindVerglas = packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS);

  let kMax = 0;
  let tickPic = 0;
  const pasCollisions: number[] = [];

  for (let tick = 1; tick <= ticks; tick++) {
    // Meme ordre que `Room.step` : expirer, avancer la horde (c'est ICI que
    // le derapage et le saut de repulsion ont lieu), poser/rafraichir la
    // zone, puis resoudre les collisions.
    zones.expire(tick);
    horde.step(DT, [field], tick, zones);
    zones.spawn(kindVerglas, CENTRE, CENTRE, 1, tick);

    let k = 0;
    for (let i = 0; i < horde.count; i++) {
      if ((horde.hp[i] ?? 0) <= 0) {
        continue;
      }
      if (zones.collisionDamageAt(horde.x[i] ?? 0, horde.y[i] ?? 0, tick) > 0) {
        k++;
      }
    }
    if (k > kMax) {
      kMax = k;
      tickPic = tick;
    }

    const t0 = performance.now();
    resolveVerglasCollisions(horde, orbs, tick, zones);
    pasCollisions.push(performance.now() - t0);
  }

  return {
    kMax,
    tickPic,
    p95Collisions: stats(pasCollisions).p95,
    survivants: horde.count,
  };
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------

console.log(`Banc des quatre elements — ${machineDescription()}`);
console.log(
  `LOURD=${LOURD} (HEAVY_HP=${HEAVY_HP}), budget de tick = ${BUDGET_MS.toFixed(4)} ms ` +
    `(1000 / ${TICK_HZ} / 3)\n`,
);

console.log('1. Porte du §7 — chainTargets isole (O(jumps x horde.count) par appel)');
const chaineSeuleRows: Record<string, unknown>[] = [];
for (const entites of [1000, 2000, 4000]) {
  const p95 = coutChaineSeule(entites);
  chaineSeuleRows.push({
    entites,
    'chainTargets p95 (ms)': +p95.toFixed(4),
    'part du budget': `${((p95 / BUDGET_MS) * 100).toFixed(2)} %`,
  });
}
console.table(chaineSeuleRows);

console.log('\n2. Porte du §7 — pas COMPLET, 4 joueurs a la bobine-tesla, horde LOURDE');
const TICKS_CHAINE = 300;
const chaineRows: Record<string, unknown>[] = [];
let pireChaine = 0;
for (const entites of [1500, 4000]) {
  for (const exemplaires of [1, 4, 8]) {
    const p95 = porteChaine(exemplaires, entites, TICKS_CHAINE);
    pireChaine = Math.max(pireChaine, p95);
    chaineRows.push({
      entites,
      'exemplaires/joueur': exemplaires,
      'pas p95 (ms)': +p95.toFixed(3),
      'part du budget': `${((p95 / BUDGET_MS) * 100).toFixed(1)} %`,
      verdict: p95 < BUDGET_MS ? 'OK' : 'HORS BUDGET',
    });
  }
}
console.table(chaineRows);
console.log(
  pireChaine < BUDGET_MS
    ? `VERDICT §7 (chaine) : pire p95 ${pireChaine.toFixed(3)} ms < ${BUDGET_MS.toFixed(3)} ms -> ON GARDE (balayage O(horde) direct)`
    : `VERDICT §7 (chaine) : pire p95 ${pireChaine.toFixed(3)} ms >= ${BUDGET_MS.toFixed(3)} ms -> HORS BUDGET, router par la grille de voisinage`,
);

console.log('\n3. Point de revue n°5 — truncatedZones, quatre armes elementaires reelles');
const TICKS_ZONES = 600;
const zonesRows: Record<string, unknown>[] = [];
let tronqueesTotal = 0;
let occupationMax = 0;
for (const entites of [1500, 4000]) {
  for (const exemplaires of [1, 4, 8]) {
    const r = occupationZones(exemplaires, entites, TICKS_ZONES);
    tronqueesTotal += r.tronquees;
    occupationMax = Math.max(occupationMax, r.zonesMax);
    zonesRows.push({
      entites,
      'exemplaires/joueur': exemplaires,
      'zones vivantes (max)': r.zonesMax,
      'occupation ZONE_CAPACITY': `${((r.zonesMax / ZONE_CAPACITY) * 100).toFixed(1)} %`,
      'zones tronquees (cumul)': r.tronquees,
      'pas p95 (ms)': +r.p95.toFixed(3),
    });
  }
}
console.table(zonesRows);
console.log(
  tronqueesTotal === 0
    ? `VERDICT revue n°5 (rafale, 20 s) : truncatedZones = 0 sur toutes les configurations (occupation max ${occupationMax}/${ZONE_CAPACITY} = ${((occupationMax / ZONE_CAPACITY) * 100).toFixed(1)} %) -> ON GARDE`
    : `VERDICT revue n°5 (rafale, 20 s) : truncatedZones = ${tronqueesTotal} (> 0) -> LA FUSION NE SUFFIT PLUS, a rouvrir`,
);

console.log('\n3 bis. Meme point de revue, en REGIME SOUTENU (60 s, horde reapprovisionnee)');
const TICKS_SOUTENU = 1800;
const soutenuRows: Record<string, unknown>[] = [];
let tronqueesSoutenu = 0;
let occupationSoutenueMax = 0;
for (const exemplaires of [1, 4, 8]) {
  const r = occupationSoutenue(exemplaires, TICKS_SOUTENU);
  tronqueesSoutenu += r.tronquees;
  occupationSoutenueMax = Math.max(occupationSoutenueMax, r.zonesMax);
  soutenuRows.push({
    'exemplaires/joueur': exemplaires,
    'duree simulee': '60 s',
    'zones vivantes (max)': r.zonesMax,
    'occupation ZONE_CAPACITY': `${((r.zonesMax / ZONE_CAPACITY) * 100).toFixed(1)} %`,
    'zones tronquees (cumul)': r.tronquees,
    'pas p95 (ms)': +r.p95.toFixed(3),
  });
}
console.table(soutenuRows);
console.log(
  tronqueesSoutenu === 0
    ? `VERDICT revue n°5 (soutenu, 60 s) : truncatedZones = 0 (occupation max ${occupationSoutenueMax}/${ZONE_CAPACITY} = ${((occupationSoutenueMax / ZONE_CAPACITY) * 100).toFixed(1)} %) -> ON GARDE`
    : `VERDICT revue n°5 (soutenu, 60 s) : truncatedZones = ${tronqueesSoutenu} (> 0) -> LA FUSION NE SUFFIT PLUS, a rouvrir`,
);

console.log('\n4. Densite en Verglas — k (la liste `sliding`) sous une vague ENCIRCLE convergente');
const TICKS_VERGLAS = 900;
const verglasRows: Record<string, unknown>[] = [];
let kMaxGlobal = 0;
let pirePasVerglas = 0;
for (const tailleVague of [200, 500, 1000, 2000, 3500]) {
  const r = densiteVerglas(tailleVague, TICKS_VERGLAS);
  kMaxGlobal = Math.max(kMaxGlobal, r.kMax);
  pirePasVerglas = Math.max(pirePasVerglas, r.p95Collisions);
  verglasRows.push({
    'vague ENCIRCLE': tailleVague,
    'k max (sliding)': r.kMax,
    'k / vague': `${((r.kMax / tailleVague) * 100).toFixed(1)} %`,
    'tick du pic': r.tickPic,
    'resolveVerglasCollisions p95 (ms)': +r.p95Collisions.toFixed(4),
    'part du budget': `${((r.p95Collisions / BUDGET_MS) * 100).toFixed(2)} %`,
    'survivants (fin)': r.survivants,
  });
}
console.table(verglasRows);
console.log(
  pirePasVerglas < BUDGET_MS
    ? `VERDICT Verglas : k max observe = ${kMaxGlobal}, pire p95 collisions ${pirePasVerglas.toFixed(4)} ms < ${BUDGET_MS.toFixed(3)} ms -> le cout tient, MALGRE un k qui depasse une poignee d'entites`
    : `VERDICT Verglas : k max observe = ${kMaxGlobal}, pire p95 collisions ${pirePasVerglas.toFixed(4)} ms >= ${BUDGET_MS.toFixed(3)} ms -> HORS BUDGET`,
);
console.log(
  '\nRappel : `resolveVerglasCollisions` suppose « la geometrie borne naturellement k ».\n' +
    'Le tableau ci-dessus est la premiere verification de cette hypothese — voir le\n' +
    'rapport de la tache pour la lecture complete.',
);
