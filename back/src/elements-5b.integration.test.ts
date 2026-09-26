import type { AddressInfo } from 'node:net';
import { CARD } from '@shared/cards';
import { SYNERGY_MAX, TICK_HZ, ZONE_RADIUS } from '@shared/constants';
import { ELEMENT } from '@shared/elements';
import {
  decode,
  encodeInput,
  type Message,
  MSG,
  packElementPair,
  REACTION_BYTES,
  type ReactionMessage,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_BYTES,
  type SnapshotMessage,
  unpackElementPair,
  ZONE_BYTES,
  type ZoneMessage,
  zoneElement,
  zoneReaction,
} from '@shared/protocol';
import { REACTION } from '@shared/reactions';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { WEAPONS, type Weapon } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { Room } from './room';
import { buildServer } from './server';

/**
 * **Le livrable de la tache 11 de l'etape 5b :** quatre elements, six
 * reactions, zero octet de plus.
 *
 * L'etape 5b a ajoute deux elements (Foudre, Poix), une statistique
 * (l'armure), cinq reactions specifiques et quatre armes — pour ZERO octet
 * supplementaire sur le fil (`ZONE_BYTES`, `REACTION_BYTES` et
 * `SNAPSHOT_HEADER_BYTES` ne bougent pas). Ce fichier assene que tout ca
 * fonctionne ENSEMBLE, sur de vraies sockets :
 *
 * 1. quatre joueurs portant quatre elements differents declenchent les SIX
 *    reactions (Choc thermique, Surchauffe, Embrasement, Court-circuit,
 *    Supraconduction, Verglas), chacune identifiee au bon endroit ;
 * 2. un joueur seul portant deux elements n'en declenche jamais qu'UNE ;
 * 3. le trafic par joueur ne bouge pas, mesure dans les DEUX sens : un salon
 *    ou la Foudre et la Poix tirent, un salon ou elles ne tirent jamais.
 *
 * ⚠️ **Les trois chiffres de replication a 0,000 px ne sont PAS mesures ici.**
 * Ils vivent dans `shared/horde.replication.test.ts` (scenarios ZF0-ZF2 pour
 * la Supraconduction, VF0-VF2 pour Verglas), en simulation pure — le decor
 * d'un test d'integration balaie la horde par `Horde.kill`, qui court-circuite
 * volontairement le lot `DEATHS` (voir le rapport de la tache 11 de l'etape
 * 6a) : un client qui deriverait sa horde du fil divergerait par construction,
 * et le chiffre lu ici ne dirait rien des reactions.
 *
 * ⚠️ **Le harnais est celui de `draft.integration.test.ts` /
 * `elements.integration.test.ts` / `portal.integration.test.ts`** : quatre
 * vraies sockets, `buildServer({ roomSeed })`, `app.rooms`, monstres poses a
 * la main. Chaque fichier de ce depot duplique ce harnais plutot que de le
 * partager (aucun des trois existants ne s'importe l'un l'autre) — ce fichier
 * suit la meme convention.
 */

/** Graine imposee au salon : ce test ne doit rien devoir au hasard. */
const ROOM_SEED = 0x5b11_ea01;

/** Quatre joueurs : c'est le nombre que le livrable exige. */
const PLAYER_COUNT = 4;

function armeParNom(nom: string): Weapon {
  const w = WEAPONS.find((w) => w.name === nom);
  if (!w) {
    throw new Error(`arme introuvable au catalogue : ${nom}`);
  }
  return w;
}

/** Portee d'une arme, en pixels monde : sa vitesse pendant toute sa duree de vie. */
function porteeDe(weapon: Weapon): number {
  return (weapon.projectileSpeed * weapon.projectileLifeTicks) / TICK_HZ;
}

// Braise rapide et courte portee (ancienne, etape 5a).
const EVENTAIL = armeParNom('eventail');
// Givre rapide (ancienne, etape 5a).
const FLECHES_JUMELLES = armeParNom('fleches-jumelles');
// Les deux armes de Foudre de la tache 9 de l'etape 5b.
const BOBINE_TESLA = armeParNom('bobine-tesla');
const CANON_A_ARC = armeParNom('canon-a-arc');
// Les deux armes de Poix de la tache 9 de l'etape 5b.
const SERINGUE_A_POIX = armeParNom('seringue-a-poix');
const CHAUDRON_A_POIX = armeParNom('chaudron-a-poix');

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  /** Tout ce qui est arrive sur CETTE socket, hors WELCOME et SNAPSHOT. */
  received: Message[];
  lastSnapshot: SnapshotMessage | null;
  /**
   * La taille BRUTE (`ArrayBuffer.byteLength`) de CHAQUE message recu,
   * regroupee par type — c'est ce que la mesure de trafic (dernier test de ce
   * fichier) interroge. Propre a ce fichier : aucun des trois autres fichiers
   * d'integration n'en a besoin.
   */
  rawByType: Map<number, number[]>;
  /**
   * Un releve par `SNAPSHOT` : la barre qu'il porte, et le nombre de
   * `REACTION` chargees (`synergyCharge === true`) deja arrivees sur CETTE
   * socket. Meme mecanisme que `elements.integration.test.ts` (tache 10) —
   * c'est ce qui rend la comparaison « barre = charges » insensible a
   * l'horloge : `Session#broadcast` envoie les `REACTION` d'un tick AVANT le
   * `SNAPSHOT` du meme tick, et la socket preserve l'ordre.
   */
  jalons: { synergy: number; chargees: number }[];
  seq: number;
}

let app: App;
let port: number;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  app = await buildServer({ roomSeed: ROOM_SEED });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const ws of openSockets.splice(0)) {
    ws.close();
  }
  await app.close();
});

async function createRoomCode(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/rooms' });
  return res.json<{ code: string }>().code;
}

async function connect(code: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  openSockets.push(ws);

  const client: Client = {
    ws,
    playerId: 0,
    received: [],
    lastSnapshot: null,
    rawByType: new Map(),
    jalons: [],
    seq: 0,
  };

  let chargees = 0;
  ws.on('message', (data: ArrayBuffer) => {
    const msg = decode(data);
    const parType = client.rawByType.get(msg.type) ?? [];
    parType.push(data.byteLength);
    client.rawByType.set(msg.type, parType);

    if (msg.type === MSG.WELCOME) {
      client.playerId = msg.playerId;
      return;
    }
    if (msg.type === MSG.SNAPSHOT) {
      client.lastSnapshot = msg;
      client.jalons.push({ synergy: msg.synergy, chargees });
      return;
    }
    if (msg.type === MSG.REACTION && msg.synergyCharge) {
      chargees++;
    }
    client.received.push(msg);
  });

  await waitFor(() => (client.playerId !== 0 ? client.playerId : null), 'WELCOME', 3000);
  return client;
}

async function waitFor<T>(probe: () => T | null, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`${what} : rien en ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 8));
  }
}

/** Les quatre clients connectes, dans l'ordre de leurs identifiants. */
async function quatreClients(code: string): Promise<Client[]> {
  const clients: Client[] = [];
  for (let i = 0; i < PLAYER_COUNT; i++) {
    clients.push(await connect(code));
  }
  expect(new Set(clients.map((c) => c.playerId)).size).toBe(PLAYER_COUNT);
  return clients;
}

/** Le premier snapshot ou les quatre joueurs sont la — il porte leurs positions. */
function fullSnapshot(ws: WebSocket): Promise<SnapshotMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('aucun snapshot a quatre joueurs en 3000 ms'));
    }, 3000);
    function cleanup(): void {
      clearTimeout(timer);
      ws.off('message', onMessage);
    }
    function onMessage(data: ArrayBuffer): void {
      const msg = decode(data);
      if (msg.type === MSG.SNAPSHOT && msg.players.length === PLAYER_COUNT) {
        cleanup();
        resolve(msg);
      }
    }
    ws.on('message', onMessage);
  });
}

/** Pose une entite increvable a une position choisie, hors du generateur de vagues. */
function poseCible(room: Room, waveId: number, x: number, y: number): number {
  const order: WaveOrder = {
    waveId,
    spawnTick: room.tick,
    seed: 1,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: x,
    anchorY: y,
    count: 1,
  };
  room.horde.spawn(order);
  const slot = room.horde.count - 1;
  room.horde.x[slot] = x;
  room.horde.y[slot] = y;
  // Increvable : ce sont les reactions qui sont comptees, pas la mise a mort.
  room.horde.hp[slot] = 1e6;
  return room.horde.entityIdAt(slot);
}

function reactionsDe(client: Client): ReactionMessage[] {
  return client.received.filter((m): m is ReactionMessage => m.type === MSG.REACTION);
}

function zonesDe(client: Client): ZoneMessage[] {
  return client.received.filter((m): m is ZoneMessage => m.type === MSG.ZONE);
}

/** Envoie une visee sur la socket : sans elle, aucune arme ne tire (tache 13). */
function vise(client: Client, dx: number, dy: number): void {
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return;
  }
  client.seq++;
  client.ws.send(
    encodeInput(client.seq, 0, 0, Math.round((dx / len) * 127), Math.round((dy / len) * 127)),
  );
}

/** Petit raccourci local : `room.grantCard` attend un `Card`, pas un id nu. */
function equipe(room: Room, playerId: number, weaponId: number): void {
  room.grantCard(playerId, { nature: CARD.WEAPON, refId: weaponId });
}

/**
 * **La barre vaut, a CHAQUE instant, le nombre de reactions chargees deja
 * annoncees — plafonnee, et rien d'autre.**
 *
 * Meme mecanisme que `elements.integration.test.ts` (tache 10, §7) : une
 * barre qui monterait a chaque reaction sans comparer les identites ferait
 * rougir chaque releve ou une reaction non chargee est arrivee ; une barre
 * qui ne montrait JAMAIS (la mutation `charge = false` de `Room.step`,
 * corrigee a cette tache) ferait rougir des que `chargees > 0`.
 */
function barreSuitLesCharges(client: Client): void {
  const jalons = client.jalons.filter((j) => j.chargees > 0);
  expect(jalons.length, 'aucun SNAPSHOT n a suivi une charge').toBeGreaterThan(0);
  for (const j of jalons) {
    expect(j.synergy).toBe(Math.min(SYNERGY_MAX, j.chargees));
  }
}

describe('etape 5b, tache 11 : quatre elements, six reactions, zero octet de plus', () => {
  /**
   * **Le livrable central : quatre joueurs, quatre elements, les six paires
   * possibles — chacune identifiee, aucune paire fantome.**
   *
   * Quatre elements distincts font exactement C(4,2) = 6 paires : Braise+Givre
   * (Choc thermique, generique de l'etape 5a), Braise+Foudre (Surchauffe),
   * Braise+Poix (Embrasement), Givre+Foudre (Supraconduction), Givre+Poix
   * (Verglas), Foudre+Poix (Court-circuit). Un joueur par element porte une
   * arme REELLE de cet element ; pour que chaque PAIRE ait sa propre cible
   * (six paires, quatre porteurs), l'AUTRE element de chaque paire est
   * entretenu a la main sur la cible (meme technique que le decor
   * inter-joueurs de `elements.integration.test.ts`, tache 10) — c'est le seul
   * geste manuel de ce test, tout le reste (armes, tirs, visee, zones,
   * reactions) passe par le jeu et par le fil.
   *
   * ⚠️ **Six cibles, ecartees de plus de `4 * ZONE_RADIUS`, dans les DEUX
   * sens.** Sans cette garde, une zone d'une cible pourrait recouvrir celle
   * d'une voisine et declencher une SEPTIEME reaction fantome (`onZoneCreated`,
   * `back/src/combat.ts`) : la lecture « les six paires se declenchent »
   * survivrait a un salon qui declenche n'importe quoi a cote — exactement le
   * piege du §8 de la spec.
   *
   * ⚠️ **Chaque cible est aussi INTER-JOUEURS** : `markBy` designe un joueur,
   * `firer` en est TOUJOURS un autre, sur les six lignes. C'est le scenario
   * exact ou la Synergie du §7 doit charger — et ce fichier est le seul du
   * depot a le verifier a quatre elements sur une vraie socket. Une revue a
   * mute `Room.step` (`const charge = t.markBy !== t.by` -> `const charge =
   * false`) et ce test restait vert tant que la barre n'etait pas lue : voir
   * la note dans la premiere assertion ci-dessous.
   */
  it('quatre joueurs portant quatre elements differents declenchent les six reactions, une par une', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('le registre de salons doit etre accessible depuis l app');
    }

    const clients = await quatreClients(code);
    const [a, b, c, d] = clients;
    if (!a || !b || !c || !d) {
      throw new Error('quatre clients attendus');
    }

    equipe(room, a.playerId, EVENTAIL.id);
    equipe(room, b.playerId, FLECHES_JUMELLES.id);
    equipe(room, c.playerId, BOBINE_TESLA.id);
    equipe(room, c.playerId, CANON_A_ARC.id);
    equipe(room, d.playerId, SERINGUE_A_POIX.id);
    equipe(room, d.playerId, CHAUDRON_A_POIX.id);

    const snap = await fullSnapshot(a.ws);
    const pos = new Map(snap.players.map((p) => [p.id, { x: p.x, y: p.y }]));
    const pa = pos.get(a.playerId);
    const pb = pos.get(b.playerId);
    const pc = pos.get(c.playerId);
    const pd = pos.get(d.playerId);
    if (!pa || !pb || !pc || !pd) {
      throw new Error('les quatre joueurs doivent etre dans le snapshot');
    }

    /**
     * Une cible par paire. `markElement` est entretenu a la main sur la
     * cible ; `fireWeapon` porte l'arme REELLE dont l'element declenche la
     * reaction — le SECOND element du couple (voir `ReactionTrigger.element`
     * dans `back/src/combat.ts`), celui que la zone laissee au sol doit
     * porter aussi.
     */
    const brut = [
      {
        nom: 'choc-thermique',
        reactionId: REACTION.AUCUNE,
        markElement: ELEMENT.GIVRE,
        markBy: () => b.playerId,
        firer: a,
        pos: pa,
        offsetX: -130,
        offsetY: 0,
        fireWeapon: EVENTAIL,
      },
      {
        nom: 'surchauffe',
        reactionId: REACTION.SURCHAUFFE,
        markElement: ELEMENT.BRAISE,
        markBy: () => a.playerId,
        firer: c,
        pos: pc,
        offsetX: -300,
        offsetY: 150,
        fireWeapon: BOBINE_TESLA,
      },
      {
        nom: 'embrasement',
        reactionId: REACTION.EMBRASEMENT,
        markElement: ELEMENT.BRAISE,
        markBy: () => a.playerId,
        firer: d,
        pos: pd,
        offsetX: 180,
        offsetY: 180,
        fireWeapon: SERINGUE_A_POIX,
      },
      {
        nom: 'supraconduction',
        reactionId: REACTION.SUPRACONDUCTION,
        markElement: ELEMENT.FOUDRE,
        markBy: () => c.playerId,
        firer: b,
        pos: pb,
        offsetX: 300,
        offsetY: -150,
        fireWeapon: FLECHES_JUMELLES,
      },
      {
        nom: 'verglas',
        reactionId: REACTION.VERGLAS,
        markElement: ELEMENT.POIX,
        markBy: () => d.playerId,
        firer: b,
        pos: pb,
        offsetX: 400,
        offsetY: 150,
        fireWeapon: FLECHES_JUMELLES,
      },
      {
        nom: 'court-circuit',
        reactionId: REACTION.COURT_CIRCUIT,
        markElement: ELEMENT.POIX,
        markBy: () => d.playerId,
        firer: c,
        pos: pc,
        offsetX: -100,
        offsetY: 400,
        fireWeapon: BOBINE_TESLA,
      },
    ] as const;

    // ⚠️ **Le couple exact, derive de l'element marque et de l'element qui
    // tire — jamais suppose.** `packElementPair` canonicalise l'ordre, donc
    // c'est le meme calcul quel que soit celui des deux qui « arrive en
    // premier » dans le decor.
    const cibles = brut.map((def) => ({
      ...def,
      x: def.pos.x + def.offsetX,
      y: def.pos.y + def.offsetY,
      pair: packElementPair(def.markElement, def.fireWeapon.element),
      fireElement: def.fireWeapon.element,
      portee: porteeDe(def.fireWeapon),
    }));

    // Six paires DISTINCTES : c'est le §6.3 tout entier, verifie une seule
    // fois plutot que suppose a chaque assertion qui suit.
    expect(new Set(cibles.map((cible) => cible.pair)).size).toBe(6);

    // ⚠️ **Garde 1 : chaque cible reste a portee de l'arme qui doit la
    // declencher.** Sans elle, une cible hors de portee ne recevrait jamais
    // de tir, et « la reaction ne s'est jamais produite » se lirait comme un
    // succes silencieux du reste du test.
    for (const cible of cibles) {
      const dist = Math.hypot(cible.offsetX, cible.offsetY);
      expect(
        dist,
        `${cible.nom} : la cible doit rester a portee de son arme declenchante`,
      ).toBeLessThan(cible.portee);
    }

    // ⚠️ **Garde 2 : les six cibles restent etanches les unes des autres, DANS
    // LES DEUX SENS.** Sans elle, une zone laissee par une reaction pourrait
    // recouvrir celle d'une cible voisine et declencher une SEPTIEME reaction
    // fantome (`onZoneCreated`) — la lecture « les six se declenchent » se
    // lirait alors aussi bien « n'importe quoi se declenche a cote ».
    for (let i = 0; i < cibles.length; i++) {
      for (let j = i + 1; j < cibles.length; j++) {
        const ci = cibles[i];
        const cj = cibles[j];
        if (!ci || !cj) {
          throw new Error('paire de cibles attendue');
        }
        const dist = Math.hypot(ci.x - cj.x, ci.y - cj.y);
        expect(
          dist,
          `${ci.nom} et ${cj.nom} sont trop proches (${dist.toFixed(1)} px)`,
        ).toBeGreaterThan(4 * ZONE_RADIUS);
      }
    }

    const entityIds = cibles.map((cible, i) => poseCible(room, 9500 + i, cible.x, cible.y));

    /** Alterne l'angle de tir de B et C entre leurs deux cibles respectives. */
    const PHASE_TICKS = 45;
    const iSurchauffe = 1;
    const iEmbrasement = 2;
    const iSupraconduction = 3;
    const iVerglas = 4;
    const iCourtCircuit = 5;
    const iChocThermique = 0;

    const pilote = setInterval(() => {
      for (let i = 0; i < cibles.length; i++) {
        const id = entityIds[i];
        const cible = cibles[i];
        if (id === undefined || !cible) {
          continue;
        }
        const slot = room.horde.slotOf(id);
        if (slot < 0) {
          continue;
        }
        room.horde.x[slot] = cible.x;
        room.horde.y[slot] = cible.y;
        room.horde.vx[slot] = 0;
        room.horde.vy[slot] = 0;
        // Le seul geste manuel de ce decor : entretenir l'AUTRE element de la
        // paire, pour que l'arme reelle du tireur trouve toujours de quoi
        // reagir.
        room.horde.applyMark(slot, cible.markElement, cible.markBy(), room.tick);
      }

      const phase = Math.floor(room.tick / PHASE_TICKS) % 2;
      const chocThermique = cibles[iChocThermique];
      const embrasement = cibles[iEmbrasement];
      const supraconduction = cibles[iSupraconduction];
      const verglas = cibles[iVerglas];
      const surchauffe = cibles[iSurchauffe];
      const courtCircuit = cibles[iCourtCircuit];
      if (
        !chocThermique ||
        !embrasement ||
        !supraconduction ||
        !verglas ||
        !surchauffe ||
        !courtCircuit
      ) {
        throw new Error('six cibles attendues');
      }

      vise(a, chocThermique.x - pa.x, chocThermique.y - pa.y);
      vise(d, embrasement.x - pd.x, embrasement.y - pd.y);
      const cibleB = phase === 0 ? supraconduction : verglas;
      vise(b, cibleB.x - pb.x, cibleB.y - pb.y);
      const cibleC = phase === 0 ? surchauffe : courtCircuit;
      vise(c, cibleC.x - pc.x, cibleC.y - pc.y);
    }, 8);

    const bucketDe = (cible: (typeof cibles)[number]) => (r: ReactionMessage) =>
      Math.hypot(r.x - cible.x, r.y - cible.y) < 2 * ZONE_RADIUS;

    const MIN_PAR_CIBLE = 2;

    try {
      await waitFor(
        () => {
          const recues = reactionsDe(a);
          return cibles.every((cible) => recues.filter(bucketDe(cible)).length >= MIN_PAR_CIBLE)
            ? true
            : null;
        },
        `au moins ${MIN_PAR_CIBLE} reactions sur chacune des six cibles`,
        45_000,
      );
    } finally {
      clearInterval(pilote);
    }

    const recues = reactionsDe(a);
    await waitFor(
      () => (clients.every((c) => reactionsDe(c).length >= recues.length) ? true : null),
      'les quatre sockets a jour',
      5000,
    );

    // ---- 1. Chaque cible a produit AU MOINS deux reactions, et EXACTEMENT
    //         celles de sa propre paire — jamais une autre. --------------------
    //
    // ⚠️ **Et CHACUNE charge la barre.** Les six cibles ci-dessus sont TOUTES
    // inter-joueurs par construction (`markBy` designe un joueur, `firer` en
    // est un AUTRE, sur les six lignes) : c'est precisement le scenario ou
    // `markBy !== by`, et donc le SEUL endroit ou la regle centrale du
    // couplage cooperatif (§7) s'observe sur quatre vraies sockets. Une
    // mutation qui ferait tomber la barre a JAMAIS (`charge = false` dans
    // `Room.step`) laisserait les cinq autres assertions de ce test
    // parfaitement vertes — sans celle-ci, ce fichier ne verifierait jamais
    // la regle que le code lui-meme appelle « le coeur du projet ».
    const buckets = cibles.map((cible) => recues.filter(bucketDe(cible)));
    for (let i = 0; i < cibles.length; i++) {
      const cible = cibles[i];
      const bucket = buckets[i];
      if (!cible || !bucket) {
        throw new Error('cible et lot attendus');
      }
      expect(bucket.length, `${cible.nom} : pas assez de reactions`).toBeGreaterThanOrEqual(
        MIN_PAR_CIBLE,
      );
      for (const r of bucket) {
        expect(r.pair, `${cible.nom} porte la mauvaise paire`).toBe(cible.pair);
        expect(r.synergyCharge, `${cible.nom} : reaction inter-joueurs non chargee`).toBe(true);
      }
    }

    // La barre elle-meme, lue dans le SNAPSHOT et nulle part ailleurs : elle
    // doit suivre EXACTEMENT le compte des charges, jamais rester a zero ni
    // monter sans rapport avec lui.
    barreSuitLesCharges(a);
    expect(a.lastSnapshot?.synergy).toBeGreaterThan(0);

    // ---- 2. Champ a champ : AUCUNE reaction n'echappe aux six lots. --------
    //
    // ⚠️ **La ligne qui tue « les six se declenchent, et n'importe quoi
    // d'autre aussi ».** Sans elle, une reaction fantome nee d'un recouvrement
    // de zones entre deux cibles voisines (ou d'une vague apparue par
    // accident) passerait inapercue : chaque lot serait toujours assez
    // fourni, mais leur somme ne compterait plus le total recu.
    const total = buckets.reduce((n, lot) => n + lot.length, 0);
    expect(total, 'des reactions n appartiennent a aucune des six cibles').toBe(recues.length);

    // ---- 3. Les six couples distincts sont bien tous representes. ---------
    expect(new Set(recues.map((r) => r.pair))).toEqual(new Set(cibles.map((cible) => cible.pair)));

    // ---- 4. Le champ laisse au sol porte le bon type de reaction ET le bon
    //         element (le SECOND, celui qui declenche) — sur les DEUX
    //         canaux, ZONE et REACTION, pas seulement l'un des deux. --------
    const zones = zonesDe(a);
    for (const cible of cibles) {
      const zonesBucket = zones.filter(
        (z) => Math.hypot(z.x - cible.x, z.y - cible.y) < 2 * ZONE_RADIUS,
      );
      expect(zonesBucket.length, `${cible.nom} : aucune zone annoncee`).toBeGreaterThan(0);
      for (const z of zonesBucket) {
        expect(zoneReaction(z.kind), `${cible.nom} : mauvais nibble de reaction`).toBe(
          cible.reactionId,
        );
        expect(zoneElement(z.kind), `${cible.nom} : mauvais element de champ`).toBe(
          cible.fireElement,
        );
      }
    }

    // ---- 5. Les quatre sockets voient le meme flot. ------------------------
    for (const other of clients) {
      expect(reactionsDe(other).slice(0, recues.length)).toEqual(recues);
    }
  }, 60_000);

  /**
   * **Un joueur seul, deux elements : jamais qu'une seule paire — et
   * l'assertion « la barre ne charge pas » rendue capable de DISTINGUER.**
   *
   * Le joueur porte a la fois Givre et Poix, REELLEMENT (deux armes
   * distinctes) : quelle que soit laquelle des deux touche en premier sur sa
   * PROPRE cible, la seule paire que DEUX elements peuvent former est
   * C(2, 2) = 1 — Verglas. Aucun decor ne peut faire surgir une sixieme
   * paire fantome ici : c'est une propriete du MODELE (une seule paire
   * possible avec deux elements), pas une convention du harnais.
   *
   * ⚠️ **Une revue a mute `Room.step` (`charge = t.markBy !== t.by` ->
   * `charge = false`) et la version precedente de ce test restait VERTE.**
   * « La barre ne charge jamais pour un joueur seul » est vrai quel que soit
   * le code — un seul joueur ne peut ecrire que sa propre identite des DEUX
   * cotes de la comparaison — donc une assertion qui ne verifie QUE ce cas
   * est vraie A VIDE : elle ne distingue pas « la regle fonctionne et rend
   * toujours faux ici » de « la regle est cassee et rend toujours faux
   * partout ». La parade, tenue par ce dépot depuis la tache 8 de l'etape 5a
   * (le decor « inter-joueurs contre solo » de `elements.integration.test.ts`) :
   * une SECONDE cible, ou un coequipier (`b`, deja connecte, jamais arme)
   * entretient une marque de Givre a la main — le seul geste manuel de ce
   * test — pendant que la POIX reelle du meme joueur `a` la declenche. La
   * paire reste Verglas (toujours C(2,2) = 1 dans le SALON entier : `b` ne
   * porte aucune arme, il ne fait qu'entretenir un element deja en jeu), mais
   * `markBy` (b) differe cette fois de `by` (a) : la barre DOIT charger. Les
   * deux cibles, cote a cote dans le meme releve, sont ce qui rend
   * l'assertion negative enfin capable de distinguer.
   */
  it('un joueur seul portant Givre et Poix ne declenche jamais que Verglas ; seule une marque inter-joueurs charge la barre', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('le registre de salons doit etre accessible depuis l app');
    }

    const clients = await quatreClients(code);
    const [a, b] = clients;
    if (!a || !b) {
      throw new Error('quatre clients attendus');
    }

    equipe(room, a.playerId, FLECHES_JUMELLES.id);
    equipe(room, a.playerId, SERINGUE_A_POIX.id);

    const snap = await fullSnapshot(a.ws);
    const pa = snap.players.find((p) => p.id === a.playerId);
    if (!pa) {
      throw new Error('le tireur doit etre dans le snapshot');
    }

    const PAIR_VERGLAS = packElementPair(ELEMENT.GIVRE, ELEMENT.POIX);

    // Cible SOLO : ni marque ni identite d'un autre joueur n'y touche jamais.
    const SOLO_OFFSET_X = 150;
    const SOLO_OFFSET_Y = 0;
    const soloX = pa.x + SOLO_OFFSET_X;
    const soloY = pa.y;

    // Cible COOPERATIVE : `b` y entretient Givre a la main, la Poix reelle de
    // `a` la declenche. Assez loin de la cible solo pour qu'aucune zone ne
    // recouvre l'autre (meme garde qu'au test a quatre cibles).
    const DUO_OFFSET_X = 0;
    const DUO_OFFSET_Y = -260;
    const duoX = pa.x + DUO_OFFSET_X;
    const duoY = pa.y + DUO_OFFSET_Y;

    // Garde 1 : les deux cibles restent a portee des DEUX armes (la plus
    // courte, la seringue, decide).
    expect(Math.hypot(SOLO_OFFSET_X, SOLO_OFFSET_Y)).toBeLessThan(porteeDe(SERINGUE_A_POIX));
    expect(Math.hypot(SOLO_OFFSET_X, SOLO_OFFSET_Y)).toBeLessThan(porteeDe(FLECHES_JUMELLES));
    expect(Math.hypot(DUO_OFFSET_X, DUO_OFFSET_Y)).toBeLessThan(porteeDe(SERINGUE_A_POIX));
    expect(Math.hypot(DUO_OFFSET_X, DUO_OFFSET_Y)).toBeLessThan(porteeDe(FLECHES_JUMELLES));
    // Garde 2 : etanches l'une de l'autre, comme les six cibles du test
    // precedent.
    const ecartCibles = Math.hypot(soloX - duoX, soloY - duoY);
    expect(ecartCibles, 'les deux cibles doivent etre etanches').toBeGreaterThan(4 * ZONE_RADIUS);

    const solo = poseCible(room, 9600, soloX, soloY);
    const duo = poseCible(room, 9601, duoX, duoY);

    /** Alterne l'angle de tir de `a` entre sa cible solo et la cible cooperative. */
    const PHASE_TICKS = 45;

    const pilote = setInterval(() => {
      for (const [id, x, y] of [
        [solo, soloX, soloY],
        [duo, duoX, duoY],
      ] as const) {
        const slot = room.horde.slotOf(id);
        if (slot >= 0) {
          room.horde.x[slot] = x;
          room.horde.y[slot] = y;
          room.horde.vx[slot] = 0;
          room.horde.vy[slot] = 0;
        }
      }
      // Le seul geste manuel de ce decor : `b` entretient Givre sur la cible
      // cooperative, jamais sur la cible solo.
      const slotDuo = room.horde.slotOf(duo);
      if (slotDuo >= 0) {
        room.horde.applyMark(slotDuo, ELEMENT.GIVRE, b.playerId, room.tick);
      }

      const phase = Math.floor(room.tick / PHASE_TICKS) % 2;
      if (phase === 0) {
        vise(a, SOLO_OFFSET_X, SOLO_OFFSET_Y);
      } else {
        vise(a, DUO_OFFSET_X, DUO_OFFSET_Y);
      }
    }, 8);

    const bucketSolo = (r: ReactionMessage) =>
      Math.hypot(r.x - soloX, r.y - soloY) < 2 * ZONE_RADIUS;
    const bucketDuo = (r: ReactionMessage) => Math.hypot(r.x - duoX, r.y - duoY) < 2 * ZONE_RADIUS;

    const MIN_PAR_CIBLE = 3;
    try {
      await waitFor(
        () => {
          const r = reactionsDe(a);
          return r.filter(bucketSolo).length >= MIN_PAR_CIBLE &&
            r.filter(bucketDuo).length >= MIN_PAR_CIBLE
            ? true
            : null;
        },
        `au moins ${MIN_PAR_CIBLE} reactions sur chacune des deux cibles`,
        30_000,
      );
    } finally {
      clearInterval(pilote);
    }

    const recues = reactionsDe(a);
    const lotSolo = recues.filter(bucketSolo);
    const lotDuo = recues.filter(bucketDuo);

    // Le decor a bien produit les DEUX cas : on les compte, on ne les
    // suppose pas — et toute reaction recue appartient a l'une des deux
    // cibles (champ a champ, comme au test precedent).
    expect(lotSolo.length).toBeGreaterThanOrEqual(MIN_PAR_CIBLE);
    expect(lotDuo.length).toBeGreaterThanOrEqual(MIN_PAR_CIBLE);
    expect(lotSolo.length + lotDuo.length).toBe(recues.length);

    // ---- 1. Jamais qu'une seule paire, et c'est la bonne — sur les DEUX
    //         cibles : `b` n'arme jamais rien, il ne fait qu'entretenir un
    //         element deja en jeu, donc le salon entier ne connait toujours
    //         que Givre et Poix. ------------------------------------------
    for (const r of recues) {
      expect(r.pair).toBe(PAIR_VERGLAS);
      expect(unpackElementPair(r.pair)).toEqual([ELEMENT.GIVRE, ELEMENT.POIX]);
    }

    // ---- 2. La moitie negative, et la moitie positive, l'une A COTE DE
    //         L'AUTRE. ---------------------------------------------------
    //
    // ⚠️ **La ligne que la revue a demandee.** Sans le lot cooperatif juste
    // en dessous, « toujours faux » ne distinguerait pas la regle qui
    // fonctionne (un seul joueur ne peut jamais differer de lui-meme) de la
    // regle cassee (`charge = false`, mutation appliquee au §6 du rapport).
    expect(lotSolo.every((r) => r.synergyCharge === false)).toBe(true);
    expect(lotDuo.every((r) => r.synergyCharge === true)).toBe(true);

    // La barre suit exactement les charges cooperatives (jamais les solo).
    barreSuitLesCharges(a);
    expect(a.lastSnapshot?.synergy).toBeGreaterThan(0);

    // ---- 3. Les deux elements alternent reellement comme declencheur sur
    //         la cible SOLO : la zone laissee porte tantot Givre, tantot
    //         Poix — sinon une seule des deux armes aurait fait tout le
    //         travail, et « deux elements » se lirait « un seul, en
    //         double ». ------------------------------------------------
    const zonesSolo = zonesDe(a).filter(
      (z) => Math.hypot(z.x - soloX, z.y - soloY) < 2 * ZONE_RADIUS,
    );
    for (const z of zonesDe(a)) {
      expect(zoneReaction(z.kind)).toBe(REACTION.VERGLAS);
    }
    expect(zonesSolo.some((z) => zoneElement(z.kind) === ELEMENT.GIVRE)).toBe(true);
    expect(zonesSolo.some((z) => zoneElement(z.kind) === ELEMENT.POIX)).toBe(true);

    // ---- 4. Les quatre sockets voient le meme flot. ------------------------
    for (const other of clients) {
      expect(reactionsDe(other).slice(0, recues.length)).toEqual(recues);
    }
  }, 45_000);

  /**
   * **Le critere de l'etape, mesure ou il compte enfin : `Room`/socket, avec
   * de vraies armes dans un vrai salon — dans les DEUX sens.**
   *
   * La tache 3 n'a pu tenir son test « aucun octet nouveau » qu'au niveau de
   * `back/src/combat.ts`, faute d'armes portant Foudre et Poix (elles
   * n'existaient pas encore). La tache 9 les a posees ; ce test-ci mesure la
   * taille BRUTE (`ArrayBuffer.byteLength`, pas la taille decodee) de chaque
   * message recu sur une socket reelle, dans deux salons distincts :
   *
   * - le salon VIEUX : seules Braise et Givre tirent (Choc thermique, la
   *   seule reaction de l'etape 5a) ;
   * - le salon NEUF : Foudre tire aussi (Supraconduction, une reaction de
   *   l'etape 5b).
   *
   * ⚠️ **Ce que « le trafic ne bouge pas » prouve VRAIMENT ici.** Un salon a
   * l'autre, le NOMBRE de `ZONE`/`REACTION` recus differe forcement (deux
   * armes de cadences differentes) : egaler ce compte ne prouverait rien
   * qu'un decor bien choisi n'ait deja truque. Ce qui NE PEUT PAS bouger,
   * structurellement, c'est le cout PAR MESSAGE — `ZONE_BYTES`,
   * `REACTION_BYTES` et la formule du `SNAPSHOT` ne dependent QUE du nombre de
   * joueurs, jamais du contenu qu'ils empaquettent (`packZoneKind`,
   * `packElementPair`). C'est ca, le contrat a « zero octet de plus » du §2 :
   * le cout d'UN evenement ne change pas, quel que soit l'element en cause.
   */
  it('le trafic par joueur ne bouge pas : meme cout par message, foudre/poix tirent ou pas', async () => {
    const codeVieux = await createRoomCode();
    const codeNeuf = await createRoomCode();
    const roomVieux = app.rooms.get(codeVieux);
    const roomNeuf = app.rooms.get(codeNeuf);
    if (!roomVieux || !roomNeuf) {
      throw new Error('les deux salons doivent etre accessibles depuis l app');
    }

    const clientsVieux = await quatreClients(codeVieux);
    const clientsNeuf = await quatreClients(codeNeuf);
    const [aVieux, bVieux] = clientsVieux;
    const [aNeuf, bNeuf] = clientsNeuf;
    if (!aVieux || !bVieux || !aNeuf || !bNeuf) {
      throw new Error('quatre clients attendus par salon');
    }

    // Salon VIEUX : Braise (reelle) + Givre (a la main) -> Choc thermique.
    equipe(roomVieux, aVieux.playerId, EVENTAIL.id);
    // Salon NEUF : Foudre (reelle) + Givre (a la main) -> Supraconduction.
    equipe(roomNeuf, aNeuf.playerId, BOBINE_TESLA.id);

    const snapVieux = await fullSnapshot(aVieux.ws);
    const snapNeuf = await fullSnapshot(aNeuf.ws);
    const paVieux = snapVieux.players.find((p) => p.id === aVieux.playerId);
    const paNeuf = snapNeuf.players.find((p) => p.id === aNeuf.playerId);
    if (!paVieux || !paNeuf) {
      throw new Error('le tireur doit etre dans son snapshot');
    }

    const OFFSET = -130;
    expect(Math.abs(OFFSET)).toBeLessThan(porteeDe(EVENTAIL));
    expect(Math.abs(OFFSET)).toBeLessThan(porteeDe(BOBINE_TESLA));
    const cibleVieuxX = paVieux.x + OFFSET;
    const cibleVieuxY = paVieux.y;
    const cibleNeufX = paNeuf.x + OFFSET;
    const cibleNeufY = paNeuf.y;

    const cibleV = poseCible(roomVieux, 9700, cibleVieuxX, cibleVieuxY);
    const cibleN = poseCible(roomNeuf, 9700, cibleNeufX, cibleNeufY);

    // A partir d'ici, chaque snapshot porte les quatre joueurs des deux
    // cotes : c'est le point de depart de la mesure, pour ne pas confondre
    // les tailles PARTIELLES de la connexion (moins de quatre joueurs) avec
    // la taille STABLE de tout le reste de la run.
    const debutVieux = aVieux.rawByType.get(MSG.SNAPSHOT)?.length ?? 0;
    const debutNeuf = aNeuf.rawByType.get(MSG.SNAPSHOT)?.length ?? 0;

    const piloteVieux = setInterval(() => {
      const slot = roomVieux.horde.slotOf(cibleV);
      if (slot >= 0) {
        roomVieux.horde.x[slot] = cibleVieuxX;
        roomVieux.horde.y[slot] = cibleVieuxY;
        roomVieux.horde.vx[slot] = 0;
        roomVieux.horde.vy[slot] = 0;
        roomVieux.horde.applyMark(slot, ELEMENT.GIVRE, bVieux.playerId, roomVieux.tick);
      }
      vise(aVieux, OFFSET, 0);
    }, 8);
    const piloteNeuf = setInterval(() => {
      const slot = roomNeuf.horde.slotOf(cibleN);
      if (slot >= 0) {
        roomNeuf.horde.x[slot] = cibleNeufX;
        roomNeuf.horde.y[slot] = cibleNeufY;
        roomNeuf.horde.vx[slot] = 0;
        roomNeuf.horde.vy[slot] = 0;
        roomNeuf.horde.applyMark(slot, ELEMENT.GIVRE, bNeuf.playerId, roomNeuf.tick);
      }
      vise(aNeuf, OFFSET, 0);
    }, 8);

    const MIN_REACTIONS = 6;
    try {
      await Promise.all([
        waitFor(
          () => (reactionsDe(aVieux).length >= MIN_REACTIONS ? true : null),
          `${MIN_REACTIONS} reactions (salon vieux)`,
          30_000,
        ),
        waitFor(
          () => (reactionsDe(aNeuf).length >= MIN_REACTIONS ? true : null),
          `${MIN_REACTIONS} reactions (salon neuf)`,
          30_000,
        ),
      ]);
    } finally {
      clearInterval(piloteVieux);
      clearInterval(piloteNeuf);
    }

    // Les paires recues sont bien celles annoncees — le decor prouve ce qu il
    // pretend prouver, il ne le suppose pas.
    const PAIR_CT = packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE);
    const PAIR_SUPRA = packElementPair(ELEMENT.GIVRE, ELEMENT.FOUDRE);
    expect(reactionsDe(aVieux).every((r) => r.pair === PAIR_CT)).toBe(true);
    expect(reactionsDe(aNeuf).every((r) => r.pair === PAIR_SUPRA)).toBe(true);
    // Et la Foudre/la Poix ne tirent VRAIMENT jamais dans le salon vieux.
    expect(
      zonesDe(aVieux).every(
        (z) => zoneElement(z.kind) !== ELEMENT.FOUDRE && zoneElement(z.kind) !== ELEMENT.POIX,
      ),
    ).toBe(true);
    expect(zonesDe(aNeuf).some((z) => zoneElement(z.kind) === ELEMENT.FOUDRE)).toBe(true);

    // ---- La mesure : le cout PAR MESSAGE, pas le compte. -------------------
    function tailles(client: Client, type: number, depuis: number): number[] {
      return (client.rawByType.get(type) ?? []).slice(depuis);
    }

    const snapshotAttendu = SNAPSHOT_HEADER_BYTES + PLAYER_COUNT * SNAPSHOT_PLAYER_BYTES;

    for (const [nom, client, debut] of [
      ['vieux', aVieux, debutVieux],
      ['neuf', aNeuf, debutNeuf],
    ] as const) {
      const zoneSizes = tailles(client, MSG.ZONE, 0);
      const reactionSizes = tailles(client, MSG.REACTION, 0);
      const snapshotSizes = tailles(client, MSG.SNAPSHOT, debut);

      expect(zoneSizes.length, `${nom} : aucune ZONE mesuree`).toBeGreaterThan(0);
      expect(reactionSizes.length, `${nom} : aucune REACTION mesuree`).toBeGreaterThan(0);
      expect(snapshotSizes.length, `${nom} : aucun SNAPSHOT mesure`).toBeGreaterThan(0);

      // Chaque ZONE et chaque REACTION coute EXACTEMENT `ZONE_BYTES` /
      // `REACTION_BYTES`, quel que soit le `kind`/`pair` qu'elle empaquette.
      expect(new Set(zoneSizes)).toEqual(new Set([ZONE_BYTES]));
      expect(new Set(reactionSizes)).toEqual(new Set([REACTION_BYTES]));
      // Chaque SNAPSHOT, une fois les quatre joueurs presents, coute
      // EXACTEMENT la meme formule (l'en-tete plus quatre joueurs).
      expect(new Set(snapshotSizes)).toEqual(new Set([snapshotAttendu]));
    }

    // ---- Le meme cout, salon a salon : c'est LA comparaison qui repond a
    //      « le trafic n'a pas bouge », dans les deux sens. ------------------
    expect(ZONE_BYTES).toBe(11);
    expect(REACTION_BYTES).toBe(11);
    const zoneVieux = tailles(aVieux, MSG.ZONE, 0)[0];
    const zoneNeuf = tailles(aNeuf, MSG.ZONE, 0)[0];
    const reactionVieux = tailles(aVieux, MSG.REACTION, 0)[0];
    const reactionNeuf = tailles(aNeuf, MSG.REACTION, 0)[0];
    const snapshotVieux = tailles(aVieux, MSG.SNAPSHOT, debutVieux)[0];
    const snapshotNeuf = tailles(aNeuf, MSG.SNAPSHOT, debutNeuf)[0];
    expect(zoneVieux).toBe(zoneNeuf);
    expect(reactionVieux).toBe(reactionNeuf);
    expect(snapshotVieux).toBe(snapshotNeuf);

    // ---- Et c'est vrai PAR JOUEUR, pas seulement pour le tireur. -----------
    for (const client of [...clientsVieux, ...clientsNeuf]) {
      const zoneSizes = tailles(client, MSG.ZONE, 0);
      const reactionSizes = tailles(client, MSG.REACTION, 0);
      if (zoneSizes.length > 0) {
        expect(new Set(zoneSizes)).toEqual(new Set([ZONE_BYTES]));
      }
      if (reactionSizes.length > 0) {
        expect(new Set(reactionSizes)).toEqual(new Set([REACTION_BYTES]));
      }
    }
  }, 60_000);
});
