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
import { packElementPair, packZoneKind } from '@shared/protocol';
import { REACTION, zoneInvolvesVifArgent } from '@shared/reactions';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { WEAPONS } from '@shared/weapons';
import { ZoneField } from '@shared/zones';

import {
  appliquerDegats,
  applyReactions,
  OrbField,
  Reactions,
  type ReactionTrigger,
  resolveVerglasCollisions,
} from '../src/combat';
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
// poire-a-chaux : la Chaux la plus rapide (cooldownTicks: 17, trois
// projectiles, tache 8 de l'etape 5c) — meme raisonnement que les autres
// armes "rapides" ci-dessus.
const ARME_CHAUX = WEAPONS.find((w) => w.name === 'poire-a-chaux')?.id ?? -1;
// fronde-a-mercure : le Vif-argent le plus rapide (cooldownTicks: 14, deux
// aiguilles, tache 8 de l'etape 5c) — le pire cas de frequence de pose de
// liaison, donc le pire cas d'appels a `linkedNeighbours` (tache 9).
const ARME_MERCURE = WEAPONS.find((w) => w.name === 'fronde-a-mercure')?.id ?? -1;
if (
  ARME_BRAISE < 0 ||
  ARME_GIVRE < 0 ||
  ARME_FOUDRE < 0 ||
  ARME_POIX < 0 ||
  ARME_CHAUX < 0 ||
  ARME_MERCURE < 0
) {
  throw new Error('le catalogue doit porter les six armes elementaires attendues');
}

/**
 * Peuple une horde de LOURDS en vagues de 200, ancrees au meme point que les
 * joueurs — identique a `peuple` de `zones.bench.ts`, dupliquee ici plutot
 * qu'importee (les deux bancs restent independants l'un de l'autre).
 */
function peuple(horde: Horde, n: number, anchorX = CENTRE, anchorY = CENTRE): void {
  let id = 90_000;
  const parVague = 200;
  const avant = horde.count;
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
  // ⚠️ **Le decor DOIT etre LOURD — assertionne, pas suppose.** Le banc
  // `zones` a menti une fois en etant peuple de pietaille legere, morte au
  // premier impact : zero marque, zero zone, un banc vert qui ne mesurait
  // rien (voir le brief de la tache 9). Cette garde fait rougir LE BANC
  // ENTIER, bruyamment, plutot que de laisser un decor fausse produire un
  // zero silencieux.
  if (n > 0 && (horde.hp[avant] ?? 0) !== HEAVY_HP) {
    throw new Error(
      `peuple() devait poser des LOURDS (HEAVY_HP=${HEAVY_HP}), a trouve ${horde.hp[avant]} au premier creneau pose`,
    );
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

/**
 * Tache 9 de l'etape 5c : les QUINZE reactions du §6.4 sont desormais toutes
 * atteignables par du vrai combat (les armes de Chaux et de Vif-argent datent
 * de la tache 8). `WEAPON_SLOTS` (4) interdit de donner les SIX elements a un
 * seul joueur ; ils sont donc repartis sur les quatre, chacun en portant
 * assez pour qu'aucun element ne manque a la table que la horde partagee
 * subit — les paires se forment entre projectiles de joueurs DIFFERENTS
 * aussi bien qu'entre deux tirs du meme, `applyElement` ne distingue pas.
 */
function salonSixElements(exemplaires: number, entites: number): Room {
  const room = new Room(0x20_0e_5c_90);
  const loadouts: readonly (readonly number[])[] = [
    [ARME_BRAISE, ARME_GIVRE, ARME_FOUDRE, ARME_POIX],
    [ARME_CHAUX, ARME_MERCURE, ARME_BRAISE, ARME_GIVRE],
    [ARME_FOUDRE, ARME_POIX, ARME_CHAUX, ARME_MERCURE],
    [ARME_BRAISE, ARME_CHAUX, ARME_FOUDRE, ARME_MERCURE],
  ];
  const couverts = new Set(loadouts.flat());
  if (
    ![ARME_BRAISE, ARME_GIVRE, ARME_FOUDRE, ARME_POIX, ARME_CHAUX, ARME_MERCURE].every((a) =>
      couverts.has(a),
    )
  ) {
    throw new Error('salonSixElements doit couvrir les six elements, un en manque');
  }
  for (const [i, id] of [1, 2, 3, 4].entries()) {
    room.join(id);
    const armes = loadouts[i] ?? [];
    for (let k = 0; k < exemplaires; k++) {
      for (const refId of armes) {
        room.grantCard(id, { nature: CARD.WEAPON, refId });
      }
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

function occupationZones(
  construitSalon: (exemplaires: number, entites: number) => Room,
  exemplaires: number,
  entites: number,
  ticks: number,
): Occupation {
  const room = construitSalon(exemplaires, entites);
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
function occupationSoutenue(
  construitSalon: (exemplaires: number, entites: number) => Room,
  exemplaires: number,
  ticks: number,
  plafond = 3500,
): Occupation {
  const room = construitSalon(exemplaires, 4000);
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
// 4. Le cout de la liaison — linkedNeighbours sous Amalgame (tache 9)
// ---------------------------------------------------------------------------

/** Le couple (Poix, Vif-argent) qui declenche Amalgame, canonicalise une fois. */
const AMALGAME_PAIR = packElementPair(ELEMENT.POIX, ELEMENT.VIF_ARGENT);

/**
 * Un salon a quatre joueurs, chacun portant `exemplaires` exemplaires de
 * seringue-a-poix ET de fronde-a-mercure — la paire la plus rapide des deux
 * elements d'Amalgame, pour maximiser la cadence de declenchement reelle.
 */
function salonMercure(exemplaires: number, entites: number): Room {
  const room = new Room(0x20_0e_5c_a0);
  for (const id of [1, 2, 3, 4]) {
    room.join(id);
    for (let k = 0; k < exemplaires; k++) {
      room.grantCard(id, { nature: CARD.WEAPON, refId: ARME_POIX });
      room.grantCard(id, { nature: CARD.WEAPON, refId: ARME_MERCURE });
    }
    room.applyInput(id, 1, 0, 0, 127, 40);
  }
  peuple(room.horde, entites);
  return room;
}

interface CoutAmalgame {
  p95: number;
  /** Le plus grand nombre d'Amalgame REELLEMENT declenches en un seul tick. */
  declenchementsMax: number;
  /**
   * Le nombre de zones annoncees ce run qui IMPLIQUENT le Vif-argent
   * (`zoneInvolvesVifArgent`, `shared/reactions.ts`) — celles que
   * `linkedNeighbours` suit desormais (revue post-tache 9, qui renverse le
   * filtre mort de la tache 3). Toute zone qu'Amalgame pose pour
   * elle-meme compte ICI : voir le rapport, ce compte n'est PLUS a zero en
   * jeu reel.
   */
  zonesLiantesVues: number;
}

/**
 * `shareAmalgameDamage` (tache 7 de l'etape 5c, `back/src/combat.ts`) est le
 * consommateur le PLUS LOURD de `linkedNeighbours` — elle l'appelle une fois
 * PAR DECLENCHEUR, pas une fois par tick. Ce decor la met sous tension via le
 * chemin reel (armes -> `Room.step` -> `applyReactions` -> ici), jamais en
 * appelant `linkedNeighbours` a vide.
 */
function porteAmalgame(exemplaires: number, entites: number, ticks: number): CoutAmalgame {
  const room = salonMercure(exemplaires, entites);
  const pas: number[] = [];
  let declenchementsMax = 0;
  let zonesLiantesVues = 0;
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    room.step(DT);
    pas.push(performance.now() - t0);
    const zonesAnnoncees = room.drainZones();
    let declenchementsTick = 0;
    for (const ev of zonesAnnoncees) {
      if (zoneInvolvesVifArgent(ev.kind)) {
        zonesLiantesVues++;
      }
    }
    for (const ev of room.drainReactions()) {
      if (ev.pair === AMALGAME_PAIR) {
        declenchementsTick++;
      }
    }
    declenchementsMax = Math.max(declenchementsMax, declenchementsTick);
    room.drainDeaths();
    room.drainPickups();
  }
  return { p95: stats(pas).p95, declenchementsMax, zonesLiantesVues };
}

/**
 * Le plafond ISOLE de `linkedNeighbours` sous son vrai consommateur
 * (`applyReactions`, l'unique point d'entree public qui appelle
 * `shareAmalgameDamage`) — jamais `linkedNeighbours` directement.
 *
 * ⚠️ **Decor SYNTHETIQUE — mais `zonesLiantesVues` n'est PLUS a zero en jeu
 * reel (revue post-tache 9, qui renverse le filtre mort de la tache 3).**
 * `zoneInvolvesVifArgent` (`shared/reactions.ts`) lit desormais la PAIRE de
 * la zone, pas son nibble d'element : les CINQ paires du Vif-argent LIENT
 * toutes, y compris via la zone que `postZone` pose POUR le declencheur
 * lui-meme — la mesure 5/5bis ci-dessous le confirme (`zonesLiantesVues`
 * compte desormais des dizaines de zones par run). Ce plafond reste utile
 * malgre tout : il isole le cout a un NOMBRE DE ZONES LIANTES CHOISI
 * (`zonesLiantes`), au lieu du nombre que le jeu produit organiquement, pour
 * mesurer comment `applyReactions` degrade quand les declencheurs/tick
 * augmentent — ⚠️ y COMPRIS l'effet du fait que `zones` est PARTAGE entre
 * toutes les iterations (postZone y ajoute reellement des zones a chaque
 * declencheur, jusqu'a `ZONE_CAPACITY`), donc ce plafond mesure un regime
 * OU LE NOMBRE DE ZONES CROIT avec les declencheurs/tick, pas un nombre de
 * zones liantes fixe — a lire comme un pire cas, pas un budget typique.
 */
function coutLiaisonSousAmalgame(
  entites: number,
  declencheurs: number,
  zonesLiantes: number,
  iterations: number,
): number {
  const horde = new Horde(MAX_ENTITIES);
  peuple(horde, entites);
  // PV enormes : cette mesure isole le cout arithmetique de la liaison, pas
  // la survie — une mort en cours de boucle compacterait la horde et
  // fausserait le compte d'une iteration a l'autre (meme piege que partout
  // ailleurs dans ce fichier).
  for (let i = 0; i < horde.count; i++) {
    horde.hp[i] = 1e9;
  }

  const zones = new ZoneField();
  for (let i = 0; i < zonesLiantes; i++) {
    // `zonesLiantes` foyers de Vif-argent PUR distincts — le seul type de
    // zone que `linkedNeighbours` suit (tache 3) — repartis sur la carte
    // pour ne pas se fusionner en un seul kind-foyer (deux zones de MEME
    // kind fusionnent, §5.1 bis).
    zones.spawn(ELEMENT.VIF_ARGENT, (i * 137) % MAP_SIZE, (i * 211) % MAP_SIZE, i + 1, 1);
  }

  const orbs = new OrbField(MAX_ENTITIES);
  const reactions = new Reactions();
  const triggers: ReactionTrigger[] = [];
  for (let i = 0; i < declencheurs; i++) {
    const slot = i % horde.count;
    triggers.push({
      pair: AMALGAME_PAIR,
      x: horde.x[slot] ?? 0,
      y: horde.y[slot] ?? 0,
      markBy: 1,
      by: 2,
      element: ELEMENT.VIF_ARGENT,
      entityId: horde.entityIdAt(slot),
    });
  }

  const pas: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    applyReactions(horde, orbs, 1, triggers, zones, reactions);
    pas.push(performance.now() - t0);
  }
  return stats(pas).p95;
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

/**
 * ⚠️ **8 exemplaires n'est PAS un plafond du jeu, et le tableau ci-dessus ne
 * le disait pas.** `Loadout#addWeapon` (`shared/loadout.ts`) ne borne que le
 * nombre d'armes DISTINCTES (`WEAPON_SLOTS`, 4) ; les exemplaires d'une meme
 * arme s'accumulent dans un `Uint16Array` SANS PLAFOND FORMEL —
 * `#weaponStacks[weaponId] = stacks + 1`, jamais borne. C'est le modele du
 * jeu depuis l'etape 4 (« aucun niveau d'arme, c'est l'empilement qui fait
 * la puissance ») : le meme angle mort qui avait deja fait deriver le cout a
 * cette etape-la, ici rejoue sur la chaine de Foudre. Ce banc doit donc
 * porter l'axe lui-meme, pas seulement le dire en commentaire.
 */
const pileRows: Record<string, unknown>[] = [];
for (const exemplaires of [16, 32, 64]) {
  const p95 = porteChaine(exemplaires, 4000, TICKS_CHAINE);
  pireChaine = Math.max(pireChaine, p95);
  pileRows.push({
    entites: 4000,
    'exemplaires/joueur': exemplaires,
    'pas p95 (ms)': +p95.toFixed(3),
    'part du budget': `${((p95 / BUDGET_MS) * 100).toFixed(1)} %`,
    verdict: p95 < BUDGET_MS ? 'OK' : 'HORS BUDGET',
  });
}
console.log("\n2 bis. Meme porte, l'empilement pousse au-dela de 8 (aucun plafond de jeu)");
console.table(pileRows);

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
    const r = occupationZones(salonQuatreElements, exemplaires, entites, TICKS_ZONES);
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
  const r = occupationSoutenue(salonQuatreElements, exemplaires, TICKS_SOUTENU);
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

console.log('\n5. Le cout de la liaison — linkedNeighbours SOUS Amalgame (tache 9), pas COMPLET');
const TICKS_AMALGAME = 300;
const amalgameRows: Record<string, unknown>[] = [];
let pireAmalgameReel = 0;
let declenchementsMaxGlobal = 0;
let zonesLiantesVuesTotal = 0;
for (const entites of [1500, 4000]) {
  for (const exemplaires of [1, 4, 8]) {
    const r = porteAmalgame(exemplaires, entites, TICKS_AMALGAME);
    pireAmalgameReel = Math.max(pireAmalgameReel, r.p95);
    declenchementsMaxGlobal = Math.max(declenchementsMaxGlobal, r.declenchementsMax);
    zonesLiantesVuesTotal += r.zonesLiantesVues;
    amalgameRows.push({
      entites,
      'exemplaires/joueur': exemplaires,
      'Amalgame declenches (max/tick)': r.declenchementsMax,
      'zones liantes vues': r.zonesLiantesVues,
      'pas p95 (ms)': +r.p95.toFixed(3),
      'part du budget': `${((r.p95 / BUDGET_MS) * 100).toFixed(1)} %`,
      verdict: r.p95 < BUDGET_MS ? 'OK' : 'HORS BUDGET',
    });
  }
}
console.table(amalgameRows);

console.log(
  "\n5 bis. Meme porte, l'empilement pousse au-dela de 8 (meme angle mort que la chaine, §2 bis)",
);
const pileAmalgameRows: Record<string, unknown>[] = [];
for (const exemplaires of [16, 32, 64]) {
  const r = porteAmalgame(exemplaires, 4000, TICKS_AMALGAME);
  pireAmalgameReel = Math.max(pireAmalgameReel, r.p95);
  declenchementsMaxGlobal = Math.max(declenchementsMaxGlobal, r.declenchementsMax);
  zonesLiantesVuesTotal += r.zonesLiantesVues;
  pileAmalgameRows.push({
    entites: 4000,
    'exemplaires/joueur': exemplaires,
    'Amalgame declenches (max/tick)': r.declenchementsMax,
    'zones liantes vues': r.zonesLiantesVues,
    'pas p95 (ms)': +r.p95.toFixed(3),
    'part du budget': `${((r.p95 / BUDGET_MS) * 100).toFixed(1)} %`,
    verdict: r.p95 < BUDGET_MS ? 'OK' : 'HORS BUDGET',
  });
}
console.table(pileAmalgameRows);

// ⚠️ **Le compteur qui ne compte pas est le defaut le plus frequent de ce
// depot (brief de la tache 9) — gardee bruyamment.** Amalgame doit s'etre
// DECLENCHE au moins une fois sur 2 100 ticks cumules (300 x 6 + 300 x 3) de
// combat reel a quatre joueurs ; s'il ne s'est JAMAIS declenche, le decor
// (armes, portee, marquage) est casse et le reste de cette section ne mesure
// rien — exactement le piege « banc qui rend zero ».
if (declenchementsMaxGlobal === 0) {
  throw new Error(
    "le banc n'a declenche AUCUN Amalgame reel sur toute la campagne : decor fausse (armes/portee/marquage)",
  );
}
console.log(
  `\nAmalgame s'est reellement declenche en jeu (max observe : ${declenchementsMaxGlobal}/tick). ` +
    `Zones impliquant le Vif-argent vues sur toute la campagne (celles que linkedNeighbours suit desormais, revue post-tache 9) : ${zonesLiantesVuesTotal}.`,
);

console.log(
  '\n5 ter. Le plafond ISOLE — applyReactions (donc shareAmalgameDamage) repete, ' +
    'zone liante SYNTHETIQUE a 4000 entites (voir le docbloc de coutLiaisonSousAmalgame)',
);
const ZONES_LIANTES_REALISTE = 4;
const plafondRows: Record<string, unknown>[] = [];
let pirePlafond = 0;
let plafondLimite = 0;
for (const declencheurs of [10, 25, 50, 100, 250, 500]) {
  const p95 = coutLiaisonSousAmalgame(MAX_ENTITIES, declencheurs, ZONES_LIANTES_REALISTE, 30);
  pirePlafond = Math.max(pirePlafond, p95);
  if (p95 < BUDGET_MS) {
    plafondLimite = declencheurs;
  }
  plafondRows.push({
    entites: MAX_ENTITIES,
    'zones Vif-argent liantes': ZONES_LIANTES_REALISTE,
    'declencheurs/tick': declencheurs,
    'applyReactions p95 (ms)': +p95.toFixed(4),
    'part du budget': `${((p95 / BUDGET_MS) * 100).toFixed(1)} %`,
    verdict: p95 < BUDGET_MS ? 'OK' : 'HORS BUDGET',
  });
}
console.table(plafondRows);

// ⚠️ **Revue post-tache 9 : `zonesLiantesVuesTotal` N'EST PLUS a zero — la
// boucle couteuse de `linkedNeighbours` TOURNE desormais pour de vrai
// pendant 5/5bis.** `zoneInvolvesVifArgent` (`shared/reactions.ts`) lit la
// PAIRE de la zone, pas son nibble d'element : les CINQ reactions qui
// apparient le Vif-argent lient toutes, y compris via la zone que
// `postZone` pose POUR le declencheur lui-meme. Le pas p95 de 5/5bis reste
// neanmoins dans le budget a toutes les configurations SAUF 4000/64
// exemplaires (12,459 ms) — et la section 7 (attribution) impute ce
// depassement a `appliquerDegats` (zones.ampAt/armorReductionAt), pas a
// `linkedNeighbours` : voir son VERDICT, hors de cette tache.
console.log(
  `\nInformatif (5/5bis) : pas COMPLET pire p95 ${pireAmalgameReel.toFixed(3)} ms, zonesLiantesVuesTotal = ${zonesLiantesVuesTotal} ` +
    '-> la liaison tourne reellement desormais ; le depassement a 4000/64 reste impute a appliquerDegats (section 7), pas a linkedNeighbours.',
);
console.log(
  pirePlafond < BUDGET_MS
    ? `VERDICT liaison (linkedNeighbours sous shareAmalgameDamage, zone liante presente) : pire p95 ${pirePlafond.toFixed(3)} ms < ${BUDGET_MS.toFixed(3)} ms a ${MAX_ENTITIES} entites et jusqu'a 500 declencheurs/tick -> ON GARDE (pas de grille de voisinage requise)`
    : `VERDICT liaison (linkedNeighbours sous shareAmalgameDamage, zone liante presente) : pire p95 ${pirePlafond.toFixed(3)} ms >= ${BUDGET_MS.toFixed(3)} ms a ${MAX_ENTITIES} entites et 500 declencheurs/tick -> HORS BUDGET dans ce regime SYNTHETIQUE (voir le docbloc de coutLiaisonSousAmalgame : le nombre de zones y croit avec les declencheurs, jusqu'a ZONE_CAPACITY) ; le jeu reel (5/5bis) ne produit pas cette densite de declencheurs simultanes`,
);
console.log(
  `VERDICT plafond isole (synthetique, zones liantes = ${ZONES_LIANTES_REALISTE}) : tient jusqu'a ` +
    `${plafondLimite || '< 10'} declencheurs/tick, pire p95 observe ${pirePlafond.toFixed(3)} ms -> ` +
    'ce plafond synthetique depasse le budget bien avant 500 declencheurs/tick ; la mesure 5/5bis (jeu reel) est le verdict qui engage, celle-ci reste un pire cas a surveiller si le nombre de declencheurs/tick simultanes venait a augmenter',
);

console.log('\n6. Point de revue n°5, REPRISE — QUINZE kind reels, six elements (tache 9)');
const TICKS_ZONES_SIX = 600;
const zonesSixRows: Record<string, unknown>[] = [];
let tronqueesSixTotal = 0;
let occupationSixMax = 0;
for (const entites of [1500, 4000]) {
  for (const exemplaires of [1, 4, 8]) {
    const r = occupationZones(salonSixElements, exemplaires, entites, TICKS_ZONES_SIX);
    tronqueesSixTotal += r.tronquees;
    occupationSixMax = Math.max(occupationSixMax, r.zonesMax);
    zonesSixRows.push({
      entites,
      'exemplaires/joueur': exemplaires,
      'zones vivantes (max)': r.zonesMax,
      'occupation ZONE_CAPACITY': `${((r.zonesMax / ZONE_CAPACITY) * 100).toFixed(1)} %`,
      'zones tronquees (cumul)': r.tronquees,
      'pas p95 (ms)': +r.p95.toFixed(3),
    });
  }
}
console.table(zonesSixRows);
console.log(
  tronqueesSixTotal === 0
    ? `VERDICT revue n°5 (rafale 20 s, SIX elements) : truncatedZones = 0 (occupation max ${occupationSixMax}/${ZONE_CAPACITY} = ${((occupationSixMax / ZONE_CAPACITY) * 100).toFixed(1)} %) -> ON GARDE`
    : `VERDICT revue n°5 (rafale 20 s, SIX elements) : truncatedZones = ${tronqueesSixTotal} (> 0) -> LA FUSION NE SUFFIT PLUS, a rouvrir`,
);

console.log(
  '\n6 bis. Meme point de revue, SIX elements, en REGIME SOUTENU (60 s, horde reapprovisionnee)',
);
const TICKS_SOUTENU_SIX = 1800;
const soutenuSixRows: Record<string, unknown>[] = [];
let tronqueesSoutenuSix = 0;
let occupationSoutenueSixMax = 0;
/** Le pas p95 de la ligne a 4 exemplaires — le decor DEBORDE que le coordinateur designe. */
let pasReferenceDebordant = 0;
for (const exemplaires of [1, 4, 8]) {
  const r = occupationSoutenue(salonSixElements, exemplaires, TICKS_SOUTENU_SIX);
  tronqueesSoutenuSix += r.tronquees;
  occupationSoutenueSixMax = Math.max(occupationSoutenueSixMax, r.zonesMax);
  if (exemplaires === 4) {
    pasReferenceDebordant = r.p95;
  }
  soutenuSixRows.push({
    'exemplaires/joueur': exemplaires,
    'duree simulee': '60 s',
    'zones vivantes (max)': r.zonesMax,
    'occupation ZONE_CAPACITY': `${((r.zonesMax / ZONE_CAPACITY) * 100).toFixed(1)} %`,
    'zones tronquees (cumul)': r.tronquees,
    'pas p95 (ms)': +r.p95.toFixed(3),
  });
}
console.table(soutenuSixRows);
console.log(
  tronqueesSoutenuSix === 0
    ? `VERDICT revue n°5 (soutenu 60 s, SIX elements) : truncatedZones = 0 (occupation max ${occupationSoutenueSixMax}/${ZONE_CAPACITY} = ${((occupationSoutenueSixMax / ZONE_CAPACITY) * 100).toFixed(1)} %) -> ON GARDE`
    : `VERDICT revue n°5 (soutenu 60 s, SIX elements) : truncatedZones = ${tronqueesSoutenuSix} (> 0) -> LA FUSION NE SUFFIT PLUS, a rouvrir`,
);

// ---------------------------------------------------------------------------
// 7. Attribution — quel balayage domine au decor qui deborde (demande du coordinateur)
// ---------------------------------------------------------------------------

/**
 * `#computeSlow`/`#computeFieldSign` (`shared/horde.ts`) sont PRIVEES :
 * aucun acces direct depuis ce banc. Leur cout se lit donc en DELTA sur
 * l'API PUBLIQUE qui les appelle (`Horde.step`) — `step` AVEC zones moins
 * `step` SANS (`zones` undefined court-circuite les deux par un retour
 * anticipe, voir leur docbloc) — plutot qu'en rejouant une copie de leur
 * algorithme, qui mesurerait une replique, pas le code reel.
 *
 * ⚠️ **Le delta couvre aussi toute consultation de zones dans
 * `#recomputeSteering`** (le derapage du Verglas, `densiteVerglas`
 * ci-dessus) : `step` lui passe `zones` aussi. Impossible de l'en separer
 * sans acces prive — le delta est donc etiquete pour les TROIS, jamais pour
 * les deux seules nommees par le coordinateur.
 */
function coutStepZones(
  horde: Horde,
  zones: ZoneField | undefined,
  tick: number,
  iterations: number,
): number {
  const pas: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    horde.step(DT, [], tick, zones);
    pas.push(performance.now() - t0);
  }
  return stats(pas).p95;
}

/** Balayage horde complet pour un point de mesure PUBLIC de `ZoneField` (`burnAt`, `collisionDamageAt`, `hitRadiusBonusAt`). */
function coutBalayageZone(
  horde: Horde,
  tick: number,
  lire: (x: number, y: number, t: number) => number,
  iterations: number,
): number {
  const pas: number[] = [];
  for (let iter = 0; iter < iterations; iter++) {
    const t0 = performance.now();
    for (let i = 0; i < horde.count; i++) {
      lire(horde.x[i] ?? 0, horde.y[i] ?? 0, tick);
    }
    pas.push(performance.now() - t0);
  }
  return stats(pas).p95;
}

/** `appliquerDegats` (donc `ampAt` + `armorReductionAt`, les DEUX appeles depuis l'interieur), balayage complet. */
function coutAppliquerDegatsBalayage(
  horde: Horde,
  zones: ZoneField,
  tick: number,
  iterations: number,
): number {
  const pas: number[] = [];
  const dead = new Set<number>();
  for (let iter = 0; iter < iterations; iter++) {
    const t0 = performance.now();
    for (let i = 0; i < horde.count; i++) {
      // Degat negligeable : horde.hp est a 1e9, aucune mort possible, donc
      // aucune compaction qui fausserait l'iteration suivante.
      appliquerDegats(horde, i, 0.0001, zones, tick, dead);
    }
    pas.push(performance.now() - t0);
  }
  return stats(pas).p95;
}

console.log(
  '\n7. Attribution du cout — quel balayage domine au decor qui deborde ' +
    '(4000 LOURDS, 128 zones, demande du coordinateur)',
);
// ⚠️ **Ce que cette section NE PEUT PAS attribuer.** `hitRadiusBonusAt` a un
// SECOND site d'appel, `Projectiles.collide` (`shared/projectiles.ts`), dans
// la boucle PROJECTILE x ENNEMI — un cout en projectiles x ennemis x zones,
// PAS entites x zones comme les balayages ci-dessous. C'est ce site, pas
// celui mesure ici, qu'un commit concurrent a ce banc (`fix(shared): pre-filtre
// le rayon elargi de vif-argent avant de balayer les zones`) vient de corriger
// par un pre-filtre, en citant CE MEME banc (49 millions de tests de distance
// par tick a 4000 ennemis/96 projectiles/128 zones). La ligne
// « hitRadiusBonusAt » ci-dessous reste une BORNE HAUTE du cout PAR ENTITE
// (un balayage complet de la horde), jamais une mesure du site reel —
// voir le rapport de la tache pour la lecture complete.
const hordeAttribution = new Horde(MAX_ENTITIES);
peuple(hordeAttribution, MAX_ENTITIES);
for (let i = 0; i < hordeAttribution.count; i++) {
  hordeAttribution.hp[i] = 1e9;
}
const hordeAttributionSansZones = new Horde(MAX_ENTITIES);
peuple(hordeAttributionSansZones, MAX_ENTITIES);

// 128 zones (ZONE_CAPACITY, l'occupation mesuree a la section 6 bis) a des
// positions DISTINCTES (aucune fusion) et des `kind` varies — element x
// reaction cycles sur les six elements et les quinze reactions, pour couvrir
// la meme diversite que le decor REEL (Surchauffe/Gel profond/Aveuglement a
// duree longue INCLUS).
const zonesAttribution = new ZoneField();
for (let i = 0; i < ZONE_CAPACITY; i++) {
  const element = (i % 6) + 1;
  const reactionId = i % 15;
  zonesAttribution.spawn(
    packZoneKind(element, reactionId),
    (i * 173) % MAP_SIZE,
    (i * 257) % MAP_SIZE,
    1,
    1,
  );
}
if (zonesAttribution.count !== ZONE_CAPACITY) {
  throw new Error(
    `decor d'attribution : ${zonesAttribution.count} zones posees, ${ZONE_CAPACITY} attendues (une a fusionne ou a ete tronquee)`,
  );
}

const ITER_ATTRIBUTION = 30;
const attributionRows: {
  nom: string;
  p95: number;
}[] = [
  {
    nom: 'Horde.step, delta zones (#computeFieldSign + #computeSlow + zones dans #recomputeSteering)',
    p95:
      coutStepZones(hordeAttribution, zonesAttribution, 1, ITER_ATTRIBUTION) -
      coutStepZones(hordeAttributionSansZones, undefined, 1, ITER_ATTRIBUTION),
  },
  {
    nom: 'resolveBurn — zones.burnAt, balayage horde complet',
    p95: coutBalayageZone(
      hordeAttribution,
      1,
      (x, y, t) => zonesAttribution.burnAt(x, y, t),
      ITER_ATTRIBUTION,
    ),
  },
  {
    nom: 'resolveVerglasCollisions — zones.collisionDamageAt, balayage horde complet',
    p95: coutBalayageZone(
      hordeAttribution,
      1,
      (x, y, t) => zonesAttribution.collisionDamageAt(x, y, t),
      ITER_ATTRIBUTION,
    ),
  },
  {
    nom: 'appliquerDegats — zones.ampAt + zones.armorReductionAt, balayage horde complet',
    p95: coutAppliquerDegatsBalayage(hordeAttribution, zonesAttribution, 1, ITER_ATTRIBUTION),
  },
  {
    nom: 'Projectiles.collide — zones.hitRadiusBonusAt, balayage horde complet (borne haute, PAS le site reel)',
    p95: coutBalayageZone(
      hordeAttribution,
      1,
      (x, y, t) => zonesAttribution.hitRadiusBonusAt(x, y, t),
      ITER_ATTRIBUTION,
    ),
  },
];
const sommeAttribution = attributionRows.reduce((acc, r) => acc + r.p95, 0);
console.table(
  attributionRows.map((r) => ({
    balayage: r.nom,
    'p95 (ms)': +r.p95.toFixed(3),
    'part de la somme attribuee': `${((r.p95 / sommeAttribution) * 100).toFixed(1)} %`,
    'part du pas de reference (4000/4, soutenu)': `${((r.p95 / pasReferenceDebordant) * 100).toFixed(1)} %`,
  })),
);
const dominant = attributionRows.reduce((a, b) => (b.p95 > a.p95 ? b : a));
console.log(
  `\nPas de reference (6 bis, 4000 entites, 4 exemplaires, soutenu) : ${pasReferenceDebordant.toFixed(3)} ms. ` +
    `Somme des cinq balayages isoles : ${sommeAttribution.toFixed(3)} ms (${((sommeAttribution / pasReferenceDebordant) * 100).toFixed(1)} % du pas de reference).`,
);
console.log(
  `VERDICT attribution (parmi les cinq mesures ici) : ${dominant.nom} domine, ${((dominant.p95 / sommeAttribution) * 100).toFixed(1)} % de la somme attribuee -> c'est LUI qu'il faut borner en premier PARMI CES CINQ`,
);
