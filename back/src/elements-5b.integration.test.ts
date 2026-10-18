import type { AddressInfo } from 'node:net';
import { CARD } from '@shared/cards';
import { PROJECTILE_HIT_RADIUS, SYNERGY_MAX, TICK_HZ, ZONE_RADIUS } from '@shared/constants';
import { ELEMENT } from '@shared/elements';
import {
  decode,
  encodeHello,
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

import { createAccount, prisma } from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

/**
 * Quatre elements, six reactions, zero octet de plus sur le fil, verifie
 * ENSEMBLE sur de vraies sockets :
 *
 * 1. quatre joueurs portant quatre elements differents declenchent les SIX
 *    reactions, chacune identifiee au bon endroit ;
 * 2. un joueur seul portant deux elements n'en declenche jamais qu'UNE ;
 * 3. le cout par message ne bouge pas, que la Foudre tire ou non.
 *
 * ⚠️ **La replication a 0,000 px n'est PAS mesuree ici** mais dans
 * `shared/horde.replication.test.ts` : le decor d'un test d'integration
 * balaie la horde par `Horde.kill`, qui court-circuite le lot `DEATHS`, donc
 * un client derive du fil divergerait par construction.
 *
 * Le harnais (quatre sockets, `buildServer({ roomSeed })`, monstres poses a
 * la main) est duplique d'un fichier d'integration a l'autre, par convention.
 */

/** Graine imposee au salon : ce test ne doit rien devoir au hasard. */
const ROOM_SEED = 0x5b11_ea01;

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

// Braise rapide et courte portee (~169 px, au-dela des 130 px vises ici).
const LANCE_FLAMMES = armeParNom('Lance-flammes');
const FLECHES_JUMELLES = armeParNom('Flèches jumelles');
const BOBINE_TESLA = armeParNom('Bobine Tesla');
const CANON_A_ARC = armeParNom('Canon à arc');
// La seule Poix qui tire un projectile : l'Encensoir de poix est un halo, il
// ne vise rien.
const CHAUDRON_A_POIX = armeParNom('Chaudron à poix');

/**
 * Ou tombe un tir de Chaudron : un MORTIER, qui ne touche personne en vol et
 * ne frappe (et ne marque) qu'au point de chute, a sa portee pile. Une cible
 * du Chaudron se pose donc A cette distance, un peu court (la moitie du
 * souffle), pour que la chute la couvre.
 */
const CHUTE_POIX = porteeDe(CHAUDRON_A_POIX) - CHAUDRON_A_POIX.blastRadius / 2;

/**
 * Cette arme touche-t-elle une cible visee a `dist` ? Une ligne droite, tout
 * ce qui est en deca de la portee ; le mortier, seulement sous sa chute.
 */
function atteint(weapon: Weapon, dist: number): boolean {
  const portee = porteeDe(weapon);
  return weapon.motion === 'mortier' ? Math.abs(dist - portee) < weapon.blastRadius : dist < portee;
}

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  /** Tout ce qui est arrive sur CETTE socket, hors WELCOME et SNAPSHOT. */
  received: Message[];
  lastSnapshot: SnapshotMessage | null;
  /**
   * La taille BRUTE (`ArrayBuffer.byteLength`) de CHAQUE message recu,
   * regroupee par type, pour la mesure de trafic (dernier test).
   */
  rawByType: Map<number, number[]>;
  /**
   * Un releve par `SNAPSHOT` : la barre qu'il porte, et le nombre de
   * `REACTION` chargees deja arrivees sur CETTE socket. La comparaison
   * « barre = charges » est insensible a l'horloge : `Session#broadcast`
   * envoie les `REACTION` d'un tick AVANT le `SNAPSHOT` du meme tick, et la
   * socket preserve l'ordre.
   */
  jalons: { synergy: number; chargees: number }[];
  seq: number;
}

let app: App;
let port: number;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  await prisma.account.deleteMany();
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

  // ⚠️ L'ecoute de 'open' est posee ICI, avant tout `await` : sur
  // localhost la socket peut s'ouvrir plus vite qu'une volee Prisma, et un
  // `once('open', ...)` pose apres `createAccount()` manquerait l'evenement
  // deja passe, bloquant `connect` jusqu'au timeout du test.
  const ouverte = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

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

  // Toute socket de jeu presente son jeton AVANT d'obtenir un slot : chaque
  // client de ce harnais a donc son propre compte.
  const { token } = await createAccount();
  await ouverte;
  ws.send(encodeHello(token));

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

/** Envoie une visee sur la socket : sans elle, aucune arme ne tire. */
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

function equipe(room: Room, playerId: number, weaponId: number): void {
  room.grantCard(playerId, { nature: CARD.WEAPON, refId: weaponId });
}

/**
 * **La barre vaut, a CHAQUE instant, le nombre de reactions chargees deja
 * annoncees — plafonnee, et rien d'autre.** Une barre qui monterait a chaque
 * reaction sans comparer les identites rougit des qu'une reaction non
 * chargee arrive ; une barre qui ne monte JAMAIS (`charge = false` dans
 * `Room.step`) rougit des que `chargees > 0`.
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
   * **Quatre joueurs, quatre elements, les six paires possibles — chacune
   * identifiee, aucune paire fantome.**
   *
   * Quatre elements font C(4,2) = 6 paires : Braise+Givre (Choc thermique,
   * generique), Braise+Foudre (Surchauffe), Braise+Poix (Embrasement),
   * Givre+Foudre (Supraconduction), Givre+Poix (Verglas), Foudre+Poix
   * (Court-circuit). Un joueur par element porte une arme REELLE ; pour que
   * chaque paire ait sa propre cible, l'AUTRE element est entretenu a la main
   * sur la cible — seul geste manuel du test, tout le reste passe par le jeu
   * et par le fil.
   *
   * ⚠️ **Six cibles, ecartees de plus de `4 * ZONE_RADIUS`.** Sinon une zone
   * pourrait recouvrir celle d'une voisine et declencher une SEPTIEME reaction
   * fantome (`onZoneCreated`), et « les six se declenchent » survivrait a un
   * salon qui declenche n'importe quoi a cote.
   *
   * ⚠️ **Chaque cible est aussi INTER-JOUEURS** (`markBy` et `firer` toujours
   * differents) : c'est le scenario ou la Synergie doit charger, et ce test
   * le seul a le verifier a quatre elements sur une vraie socket.
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

    equipe(room, a.playerId, LANCE_FLAMMES.id);
    equipe(room, b.playerId, FLECHES_JUMELLES.id);
    equipe(room, c.playerId, BOBINE_TESLA.id);
    equipe(room, c.playerId, CANON_A_ARC.id);
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
        fireWeapon: LANCE_FLAMMES,
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
        // En diagonale, a la distance de chute du mortier.
        offsetX: CHUTE_POIX / Math.SQRT2,
        offsetY: CHUTE_POIX / Math.SQRT2,
        fireWeapon: CHAUDRON_A_POIX,
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

    // Le couple exact, derive de l'element marque et de l'element qui tire —
    // jamais suppose. `packElementPair` canonicalise l'ordre.
    const cibles = brut.map((def) => ({
      ...def,
      x: def.pos.x + def.offsetX,
      y: def.pos.y + def.offsetY,
      pair: packElementPair(def.markElement, def.fireWeapon.element),
      fireElement: def.fireWeapon.element,
    }));

    // Six paires DISTINCTES, verifie une fois plutot que suppose ensuite.
    expect(new Set(cibles.map((cible) => cible.pair)).size).toBe(6);

    // Garde 1 : chaque cible reste a portee de l'arme qui doit la declencher.
    // Sinon la cible ne recevrait jamais de tir et le test echouerait sans
    // dire pourquoi.
    for (const cible of cibles) {
      const dist = Math.hypot(cible.offsetX, cible.offsetY);
      expect(
        atteint(cible.fireWeapon, dist),
        `${cible.nom} : la cible doit rester a portee de son arme declenchante`,
      ).toBe(true);
    }

    // Garde 2 : les six cibles restent etanches les unes des autres (voir le
    // docbloc : pas de reaction fantome par recouvrement de zones).
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
        // Le seul geste manuel : entretenir l'AUTRE element de la paire, pour
        // que l'arme reelle du tireur trouve toujours de quoi reagir.
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
    // ⚠️ **Et CHACUNE charge la barre.** Les six cibles sont inter-joueurs
    // (`markBy !== by`) : sans cette assertion, `charge = false` dans
    // `Room.step` laisserait toutes les autres vertes, et la regle centrale du
    // couplage cooperatif ne serait jamais verifiee sur vraies sockets.
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
    // ⚠️ Sans cette ligne, une reaction fantome (recouvrement de zones, vague
    // apparue par accident) passerait inapercue : chaque lot serait assez
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
   * `a` porte REELLEMENT Givre et Poix : sur sa propre cible (solo), deux
   * elements ne forment qu'une paire, Verglas. C'est une propriete du modele,
   * pas une convention du harnais.
   *
   * ⚠️ **« La barre ne charge jamais pour un joueur seul » est vrai A VIDE** :
   * un seul joueur ecrit sa propre identite des deux cotes de la comparaison,
   * donc l'assertion seule resterait verte avec `charge = false` dans
   * `Room.step`. D'ou une SECONDE cible cooperative, cote a cote dans le meme
   * releve, ou `b` (jamais arme) entretient le Givre a la main.
   *
   * ⚠️ **La cible cooperative est declenchee par `c`, jamais par `a`.** Si `a`
   * la visait aussi, sa propre fleche de Givre y tomberait parfois dans le
   * meme pas que sa Poix : `markBy` vaudrait `a`, `charge` tomberait a faux,
   * et le test echouerait par intermittence. `c` ne porte que le Chaudron :
   * `b` est la SEULE source de Givre de cette cible, donc `markBy` (b) differe
   * toujours de `by` (c), sans dependre d'aucun ordre d'arrivee.
   *
   * La paire reste Verglas partout : ni `b` ni `c` n'ajoutent un element que
   * le salon ne connaisse deja.
   */
  it('un joueur seul portant Givre et Poix ne declenche jamais que Verglas ; seule une marque inter-joueurs charge la barre', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('le registre de salons doit etre accessible depuis l app');
    }

    const clients = await quatreClients(code);
    const [a, b, c] = clients;
    if (!a || !b || !c) {
      throw new Error('quatre clients attendus');
    }

    equipe(room, a.playerId, FLECHES_JUMELLES.id);
    equipe(room, a.playerId, CHAUDRON_A_POIX.id);
    // `c` ne porte QUE la Poix : la seule arme reelle qui touche jamais la
    // cible cooperative — voir le docbloc ci-dessus.
    equipe(room, c.playerId, CHAUDRON_A_POIX.id);

    const snap = await fullSnapshot(a.ws);
    const pa = snap.players.find((p) => p.id === a.playerId);
    const pc = snap.players.find((p) => p.id === c.playerId);
    if (!pa || !pc) {
      throw new Error('les tireurs doivent etre dans le snapshot');
    }

    const PAIR_VERGLAS = packElementPair(ELEMENT.GIVRE, ELEMENT.POIX);

    // Cible SOLO : ni marque ni identite d'un autre joueur n'y touche
    // jamais — `a` seul la vise, avec ses deux armes.
    // ⚠️ **A la chute du Chaudron** : le mortier ne touche qu'en tombant. Et
    // dans l'axe x PILE : la visee (127, 0) est exacte, donc les deux Fleches
    // jumelles passent a `CHUTE_POIX x tan(spread / 2)` de la cible, sous
    // `PROJECTILE_HIT_RADIUS` (garde ci-dessous).
    const SOLO_OFFSET_X = CHUTE_POIX;
    const SOLO_OFFSET_Y = 0;
    const soloX = pa.x + SOLO_OFFSET_X;
    const soloY = pa.y;

    // Cible COOPERATIVE : `b` y entretient Givre a la main, la Poix reelle de
    // `c` la declenche. Ancree sur `c`, qui spawne a un autre coin que `a`
    // (`SPAWN_OFFSETS`, back/src/room.ts) : assez loin de la cible solo pour
    // qu'aucune zone ne recouvre l'autre.
    const DUO_OFFSET_X = 0;
    const DUO_OFFSET_Y = CHUTE_POIX;
    const duoX = pc.x + DUO_OFFSET_X;
    const duoY = pc.y + DUO_OFFSET_Y;

    // Garde 1 : chaque cible reste a portee de l'arme qui la declenche
    // REELLEMENT — la cible solo, des DEUX armes de `a` (la plus courte
    // decide) ; la cible cooperative, de la seule arme de `c`.
    expect(atteint(CHAUDRON_A_POIX, Math.hypot(SOLO_OFFSET_X, SOLO_OFFSET_Y))).toBe(true);
    expect(atteint(FLECHES_JUMELLES, Math.hypot(SOLO_OFFSET_X, SOLO_OFFSET_Y))).toBe(true);
    expect(
      SOLO_OFFSET_X * Math.tan(FLECHES_JUMELLES.spreadRadians / 2),
      'les deux fleches doivent encore froler la cible solo',
    ).toBeLessThan(PROJECTILE_HIT_RADIUS);
    expect(atteint(CHAUDRON_A_POIX, Math.hypot(DUO_OFFSET_X, DUO_OFFSET_Y))).toBe(true);
    // Garde 2 : etanches l'une de l'autre, comme les six cibles du test
    // precedent.
    const ecartCibles = Math.hypot(soloX - duoX, soloY - duoY);
    expect(ecartCibles, 'les deux cibles doivent etre etanches').toBeGreaterThan(4 * ZONE_RADIUS);

    const solo = poseCible(room, 9600, soloX, soloY);
    const duo = poseCible(room, 9601, duoX, duoY);

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
      // Le seul geste manuel : `b` entretient Givre sur la cible cooperative,
      // jamais sur la cible solo.
      const slotDuo = room.horde.slotOf(duo);
      if (slotDuo >= 0) {
        room.horde.applyMark(slotDuo, ELEMENT.GIVRE, b.playerId, room.tick);
      }

      // Chaque tireur vise EN CONTINU sa seule cible, sans alternance :
      // deterministe par construction, pas par probabilite.
      vise(a, soloX - pa.x, soloY - pa.y);
      vise(c, duoX - pc.x, duoY - pc.y);
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
    // ⚠️ Sans le lot cooperatif juste en dessous, « toujours faux » ne
    // distinguerait pas la regle qui fonctionne de `charge = false`.
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
   * **Zero octet de plus, mesure sur `Room`/socket avec de vraies armes.**
   *
   * Taille BRUTE (`ArrayBuffer.byteLength`, pas la taille decodee) de chaque
   * message recu, dans deux salons :
   *
   * - le salon VIEUX : seules Braise et Givre tirent (Choc thermique) ;
   * - le salon NEUF : Foudre tire aussi (Supraconduction).
   *
   * ⚠️ **On compare le cout PAR MESSAGE, pas le nombre de messages.** Le
   * nombre de `ZONE`/`REACTION` differe forcement (cadences differentes) ; ce
   * qui ne doit pas bouger, c'est que `ZONE_BYTES`, `REACTION_BYTES` et la
   * formule du `SNAPSHOT` ne dependent que du nombre de joueurs, jamais de
   * l'element empaquete (`packZoneKind`, `packElementPair`).
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
    equipe(roomVieux, aVieux.playerId, LANCE_FLAMMES.id);
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
    expect(Math.abs(OFFSET)).toBeLessThan(porteeDe(LANCE_FLAMMES));
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
