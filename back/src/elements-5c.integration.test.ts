import type { AddressInfo } from 'node:net';
import { CARD } from '@shared/cards';
import {
  PROJECTILE_HIT_RADIUS,
  SYNERGY_MAX,
  TICK_HZ,
  VIF_ARGENT_HIT_RADIUS_BONUS,
  WEAPON_SLOTS,
  ZONE_RADIUS,
} from '@shared/constants';
import { ELEMENT, ELEMENTS } from '@shared/elements';
import { FRAPPE_DELAY_TICKS, FRAPPE_SEARCH_RADIUS } from '@shared/onde-frappe';
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
import { REACTION, REACTION_DEFS, reactionForPair, zoneVifArgent } from '@shared/reactions';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { WEAPONS, type Weapon } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, prisma } from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

/**
 * **Le livrable de la tache 10 de l'etape 5c :** six elements, quinze
 * reactions, zero octet de plus.
 *
 * L'etape 5c ajoute les deux derniers elements (Chaux, Vif-argent) et les neuf
 * dernieres reactions — pour ZERO octet supplementaire sur le fil
 * (`ZONE_BYTES`, `REACTION_BYTES` et `SNAPSHOT_HEADER_BYTES` ne bougent pas).
 * Ce fichier assene que tout ca fonctionne ENSEMBLE, sur de vraies sockets :
 *
 * 1. les **quinze** reactions se declenchent, **une par une et identifiee** :
 *    les quatorze de `REACTION_DEFS` plus le Choc thermique (Braise + Givre),
 *    la seule paire sans effet specifique, qui prend le chemin generique de
 *    l'etape 5a (`reactionId === REACTION.AUCUNE`) ;
 * 2. **la moitie negative** : une paire qui ne doit rien produire ne produit
 *    RIEN, et une reaction qui n'est pas censee etre liante ne l'est pas ;
 * 3. les quinze sont **inter-joueurs par construction** ici, donc les quinze
 *    chargent la Synergie, et la barre du `SNAPSHOT` suit ;
 * 4. **le pitch du README, testable pour la premiere fois** : un joueur seul
 *    n'a que `WEAPON_SLOTS` slots, donc quatre elements au mieux, donc
 *    C(4, 2) = six paires — jamais quinze ;
 * 5. **le trafic par joueur ne bouge pas, dans les DEUX sens**, mesure au
 *    niveau socket sur la taille BRUTE de chaque message.
 *
 * ⚠️ **TROIS SALONS, et c'est une CONTRAINTE, pas un confort.** Aucun joueur ne
 * doit etre la seule source des DEUX elements d'une paire qu'il declenche :
 * c'est ce qui faisait echouer le livrable de l'etape 5b deux fois sur treize
 * (un joueur portait deux armes elementaires, et quand ses deux projectiles
 * atterrissaient dans le meme pas, la reaction cessait d'etre inter-joueurs).
 * Quatre joueurs portant chacun UNE arme elementaire couvrent quatre elements,
 * donc C(4, 2) = SIX paires : un salon unique ne peut donc PAS produire les
 * quinze avec les deux cotes tires par deux joueurs distincts. Trois salons de
 * quatre clients, une arme elementaire par joueur, 6 + 5 + 4 = 15 — et aucune
 * marque posee a la main, contrairement a l'etape 5b qui entretenait l'autre
 * element de la paire sur la cible.
 *
 * ⚠️ **Les chiffres de replication ne sont PAS mesures ici.** Ils vivent dans
 * `shared/horde.replication.test.ts`, en simulation pure : le decor d'un test
 * d'integration balaie la horde par `Horde.kill`, qui court-circuite
 * volontairement le lot `DEATHS` (voir le rapport de la tache 11 de l'etape
 * 6a) — un client qui deriverait sa horde du fil divergerait par construction,
 * et le chiffre lu ici ne dirait rien des reactions.
 *
 * ⚠️ **Le harnais est celui de `draft.integration.test.ts` /
 * `elements.integration.test.ts` / `portal.integration.test.ts` /
 * `elements-5b.integration.test.ts`** : quatre vraies sockets,
 * `buildServer({ roomSeed })`, `app.rooms`, monstres poses a la main. Chaque
 * fichier de ce depot duplique ce harnais plutot que de le partager (aucun des
 * quatre existants ne s'importe l'un l'autre) — ce fichier suit la meme
 * convention.
 */

/** Graine imposee au salon : ce test ne doit rien devoir au hasard. */
const ROOM_SEED = 0x5c11_ea0a;

/** Quatre joueurs : c'est le nombre que le livrable exige. */
const PLAYER_COUNT = 4;

/**
 * Les six elements REELS, derives de `ELEMENTS` — le neutre n'en est pas un, il
 * ne marque rien et ne reagit avec rien.
 */
const ELEMENTS_REELS: readonly number[] = ELEMENTS.filter((e) => e.id !== ELEMENT.NEUTRE).map(
  (e) => e.id,
);

/**
 * **Les quinze couples, DERIVES — aucun identifiant ecrit en dur.** C(6, 2)
 * = 15, et `packElementPair` canonicalise l'ordre, donc cette liste est celle
 * du §6.4 de l'orientation sans qu'aucune de ses valeurs n'ait ete recopiee
 * (meme doctrine que le docbloc de `REACTION_DAMAGE`).
 */
const QUINZE_PAIRES: readonly number[] = ELEMENTS_REELS.flatMap((a, i) =>
  ELEMENTS_REELS.slice(i + 1).map((b) => packElementPair(a, b)),
);

/**
 * Les trois reactions qui comptent comme du Vif-argent pour la liaison ET pour
 * le rayon de touche elargi (`ReactionDef.zoneVifArgent`, un seul critere et
 * deux consommateurs depuis le correctif R24).
 *
 * ⚠️ **Ecrit ici en ELEMENTS, pas en identifiants de reaction, et c'est la
 * moitie negative du §5 de la spec.** Cinq paires impliquent le Vif-argent ;
 * seules TROIS en ont besoin pour leur effet — Vaporisation (degats autour de
 * chaque lie), Paratonnerre (la chaine prefere les lies), Amalgame (partage
 * entre lies). *Gel profond* (Givre + Vif-argent, « vitesse nulle dans la
 * zone ») et *Aveuglement* (Chaux + Vif-argent, « la fuite ») n'en ont aucun
 * besoin : la decision est celle de la tache 6, confirmee au correctif R24, et
 * la deriver de la paire la renversait EN SILENCE. Cette liste est donc la
 * SECONDE liste, celle a laquelle `zoneVifArgent` est comparee champ a champ —
 * jamais une relecture de la table qu'elle verifie.
 */
const PAIRES_LIANTES: ReadonlySet<number> = new Set([
  packElementPair(ELEMENT.BRAISE, ELEMENT.VIF_ARGENT),
  packElementPair(ELEMENT.FOUDRE, ELEMENT.VIF_ARGENT),
  packElementPair(ELEMENT.POIX, ELEMENT.VIF_ARGENT),
]);

/** Portee d'une arme, en pixels monde : sa vitesse pendant toute sa duree de vie. */
function porteeDe(weapon: Weapon): number {
  return (weapon.projectileSpeed * weapon.projectileLifeTicks) / TICK_HZ;
}

/**
 * **Cette arme marque-t-elle une cible visee a `dist` ?** Jusqu'a l'etape 12,
 * « en deca de la portee » suffisait ; depuis, chaque forme a sa regle : la
 * frappe tombe a sa portee PILE (et prend l'ennemi le plus proche dans
 * `FRAPPE_SEARCH_RADIUS`), le mortier ne touche qu'a sa chute, le boomerang
 * s'arrete au quart de la portee droite (il ralentit jusqu'a l'arret a
 * mi-vie), l'onde, le halo et l'invocation ne vont pas plus loin que leur
 * rayon.
 */
function atteint(w: Weapon, dist: number): boolean {
  const portee = porteeDe(w);
  if (w.kind === 'frappe') {
    return Math.abs(dist - portee) < FRAPPE_SEARCH_RADIUS;
  }
  if (w.kind === 'onde' || w.kind === 'halo' || w.kind === 'invocation') {
    return dist < w.blastRadius;
  }
  if (w.motion === 'mortier') {
    return Math.abs(dist - portee) < w.blastRadius;
  }
  if (w.motion === 'boomerang') {
    return dist < portee / 4;
  }
  return dist < portee;
}

/**
 * La distance ou poser une cible pour que `atteint` la tienne avec de la marge
 * — le point d'impact de la frappe, la chute du mortier un peu en deca, les
 * autres a 60 % de leur allonge.
 */
function distanceDeTir(w: Weapon): number {
  const portee = porteeDe(w);
  if (w.kind === 'frappe') {
    return portee;
  }
  if (w.kind === 'onde' || w.kind === 'halo' || w.kind === 'invocation') {
    return w.blastRadius * 0.6;
  }
  if (w.motion === 'mortier') {
    return portee - w.blastRadius / 2;
  }
  return (w.motion === 'boomerang' ? portee / 4 : portee) * 0.6;
}

/**
 * **L'arme de cet element qui marque UNE cible visee de plus loin.**
 *
 * ⚠️ **Une seule trajectoire, connue d'avance : c'est ce qui rend le decor
 * deterministe.** `Projectiles.#emit` repartit `projectileCount` projectiles
 * symetriquement autour de la visee — a n = 1 le `spreadRadians` est ignore
 * et le tir part EXACTEMENT dans la direction quantifiee. Une arme a deux
 * projectiles ecarte chacun de `spreadRadians / 2` : la bobine-tesla (0,2 rad)
 * manquerait une cible a 350 px de 33 px, soit juste au-dela de
 * `PROJECTILE_HIT_RADIUS`. Pas de guidage ni de ricochet (ils iraient marquer
 * la cible d'une autre phase), pas d'orbite, de sinus ni de spirale (leur
 * trace n'est pas la visee), pas de halo ni d'invocation (ils ne visent rien).
 *
 * ⚠️ **Etape 12 : la frappe est admise malgre ses trois impacts** : elle ne
 * disperse rien, elle prend les ennemis les plus proches du point vise — ici
 * la seule cible vivante. C'est desormais la seule Foudre a viser juste (la
 * Bobine tire deux arcs ecartes).
 */
function armeDe(element: number): Weapon {
  const best = WEAPONS.filter(
    (w) =>
      w.element === element &&
      (w.kind === 'frappe' || w.projectileCount === 1) &&
      w.kind !== 'halo' &&
      w.kind !== 'invocation' &&
      w.homing === 0 &&
      w.bounces === 0 &&
      w.emission === 'visee' &&
      (w.motion === 'droit' || w.motion === 'mortier' || w.motion === 'boomerang'),
  ).reduce<Weapon | null>(
    (b, w) => (b === null || distanceDeTir(w) > distanceDeTir(b) ? w : b),
    null,
  );
  if (!best || distanceDeTir(best) <= 0) {
    throw new Error(`aucune arme qui vise juste pour l element ${element}`);
  }
  return best;
}

/**
 * L'arme de cet element qui tire le plus souvent, parmi celles qui marquent
 * une cible a `dist` — pour le decor du joueur seul.
 *
 * ⚠️ **`atteint`, et plus `kind === 'tir'`** : le filtre de l'etape 8 ecartait
 * l'Encensoir de poix (halo, 110 px) parce que la cible etait a 130 px. Depuis
 * l'etape 12, la Poix a projectile est un mortier qui ne touche qu'a sa chute
 * et le Semoir de chaux ne quitte pas les pieds du tireur : c'est la portee
 * EFFECTIVE de chaque forme qui decide, halo compris.
 */
function armeRapideDe(element: number, dist: number): Weapon {
  const best = WEAPONS.filter(
    (w) => w.element === element && w.homing === 0 && w.bounces === 0 && atteint(w, dist),
  ).reduce<Weapon | null>(
    (b, w) => (b === null || w.cooldownTicks < b.cooldownTicks ? w : b),
    null,
  );
  if (!best) {
    throw new Error(`aucune arme pour l element ${element} a ${dist} px`);
  }
  return best;
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
   * regroupee par type — c'est ce que la mesure de trafic (dernier test de ce
   * fichier) interroge.
   */
  rawByType: Map<number, number[]>;
  /**
   * Un releve par `SNAPSHOT` : la barre qu'il porte, et le nombre de
   * `REACTION` chargees (`synergyCharge === true`) deja arrivees sur CETTE
   * socket. Meme mecanisme que `elements.integration.test.ts` et
   * `elements-5b.integration.test.ts` — c'est ce qui rend la comparaison
   * « barre = charges » insensible a l'horloge : `Session#broadcast` envoie
   * les `REACTION` d'un tick AVANT le `SNAPSHOT` du meme tick, et la socket
   * preserve l'ordre.
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

  // Depuis l'etape 7a, toute socket de jeu presente son jeton AVANT d'obtenir
  // un slot : chaque client de ce harnais a donc son propre compte.
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

/**
 * Balaie la horde SAUF les identites retenues — meme technique que
 * `viderSauf` dans `portal.integration.test.ts`.
 *
 * ⚠️ **C'est ce qui rend « rien d'autre ne se declenche » tenable, et ce qui
 * interdit a ce fichier de mesurer une derive de replication** (voir
 * l'en-tete) : `Horde.kill` court-circuite le lot `DEATHS`. Sans ce balayage,
 * les vagues du directeur s'accumuleraient pendant la minute que durent les
 * trois salons, leurs morts feraient tomber des orbes, les orbes de
 * l'experience, l'experience un etalage — et l'etalage GELE le monde
 * (`Room.step`, `#stepDraft`). Le decor s'arreterait au milieu d'une phase sans
 * rien dire des reactions.
 */
function viderSauf(room: Room, garder: readonly number[]): void {
  const ids: number[] = [];
  for (let i = 0; i < room.horde.count; i++) {
    const id = room.horde.entityIdAt(i);
    if (!garder.includes(id)) {
      ids.push(id);
    }
  }
  if (ids.length > 0) {
    room.horde.kill(ids);
  }
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
 * Meme mecanisme que `elements.integration.test.ts` (tache 10, §7) : une barre
 * qui monterait a chaque reaction sans comparer les identites ferait rougir
 * chaque releve ou une reaction non chargee est arrivee ; une barre qui ne
 * montait JAMAIS (la mutation `charge = false` de `Room.step`) ferait rougir
 * des que `chargees > 0`.
 */
function barreSuitLesCharges(client: Client): void {
  const jalons = client.jalons.filter((j) => j.chargees > 0);
  expect(jalons.length, 'aucun SNAPSHOT n a suivi une charge').toBeGreaterThan(0);
  for (const j of jalons) {
    expect(j.synergy).toBe(Math.min(SYNERGY_MAX, j.chargees));
  }
}

/** Une phase : une paire, une cible neuve, deux porteurs, deux joueurs a l'ecart. */
interface Phase {
  nom: string;
  pair: number;
  reactionId: number;
  liante: boolean;
  elements: readonly [number, number];
  x: number;
  y: number;
  porteurs: readonly number[];
  autres: readonly number[];
  /** Ou chaque joueur se tient pendant CETTE phase (`debugPlace`), par rang. */
  places: readonly Position[];
}

interface Position {
  x: number;
  y: number;
}

/**
 * **Ecartement des cibles, et il est CALCULE.** Les quatre joueurs naissent aux
 * quatre coins d'un carre de 240 px de cote (`SPAWN_OFFSETS`,
 * `back/src/room.ts`). Une cible de paire ADJACENTE part a `ECART_AXE` du
 * centre dans l'axe du milieu des deux porteurs ; une cible de paire DIAGONALE
 * part a `ECART_DIAG` sur la perpendiculaire a la diagonale — son milieu EST le
 * centre, il ne designe aucune direction. Les deux gardes du test verifient ce
 * que ces deux nombres doivent satisfaire : chaque cible a portee de ses DEUX
 * armes (plus courte portee du decor : 405 px), et les six cibles ecartees de
 * plus de `4 * ZONE_RADIUS` les unes des autres (minimum atteint : 319 px).
 */
const ECART_AXE = 450;
const ECART_DIAG = 297;

/** La cible d'une paire de joueurs : derivee de leurs positions, jamais ecrite. */
function positionCible(pi: Position, pj: Position, centre: Position): Position {
  const mx = (pi.x + pj.x) / 2 - centre.x;
  const my = (pi.y + pj.y) / 2 - centre.y;
  const len = Math.hypot(mx, my);
  if (len > 1) {
    // Paire ADJACENTE : vers l'exterieur, dans l'axe du milieu des deux.
    return { x: centre.x + (mx / len) * ECART_AXE, y: centre.y + (my / len) * ECART_AXE };
  }
  // Paire DIAGONALE : le milieu est le centre, on prend la perpendiculaire.
  const ax = pj.x - pi.x;
  const ay = pj.y - pi.y;
  const al = Math.hypot(ax, ay);
  return { x: centre.x + (ay / al) * ECART_DIAG, y: centre.y - (ax / al) * ECART_DIAG };
}

const BUCKET = 2 * ZONE_RADIUS;

/**
 * Ou se tiennent les deux joueurs qui ne jouent pas la phase : assez loin pour
 * qu'aucune de leurs armes n'atteigne la cible, quelle que soit sa forme —
 * l'onde ne vise rien, et un « visez a l'oppose » ne suffit plus a l'en
 * ecarter. Verifie par la garde 3.
 */
const LOIN = 1200;

/** Le point a `dist` de `cible`, du cote de `depuis`. */
function versCible(cible: Position, depuis: Position, dist: number): Position {
  const dx = depuis.x - cible.x;
  const dy = depuis.y - cible.y;
  const len = Math.hypot(dx, dy);
  return { x: cible.x + (dx / len) * dist, y: cible.y + (dy / len) * dist };
}

/** Une visee nulle : plus aucune arme ne part (`#fireWeapons`). */
function silence(client: Client): void {
  client.seq++;
  client.ws.send(encodeInput(client.seq, 0, 0, 0, 0));
}

/** Deux reactions par cible : une seule ne dirait pas que la paire se REJOUE. */
const MIN_PAR_CIBLE = 2;

describe('etape 5c, tache 10 : six elements, quinze reactions, zero octet de plus', () => {
  /**
   * **Le livrable central : les quinze reactions, une par une, identifiee, et
   * aucune autre.**
   *
   * Trois salons successifs de quatre clients, UNE arme elementaire par joueur
   * (voir l'en-tete pour l'arithmetique qui l'impose) :
   *
   * | salon | elements portes | paires NEUVES |
   * | --- | --- | --- |
   * | A | Braise, Givre, Foudre, Poix | 6 |
   * | B | Chaux, Vif-argent, Braise, Givre | 5 |
   * | C | Foudre, Poix, Chaux, Vif-argent | 4 |
   *
   * 6 + 5 + 4 = 15, et les deux cotes de chaque paire sortent TOUJOURS de deux
   * joueurs differents, par une arme REELLE, sans aucun marquage a la main.
   *
   * **Une seule paire active a la fois.** Par phase : une cible neuve
   * increvable, les deux porteurs la visent, **les deux autres visent le vide**
   * — exactement a l'oppose de la cible, donc leurs projectiles s'en eloignent,
   * et la cible est la SEULE entite vivante du salon (le balayage de
   * `viderSauf`). La phase finie, la cible est tuee et la suivante est posee.
   *
   * ⚠️ **Les cibles sont ecartees de plus de `4 * ZONE_RADIUS` dans les DEUX
   * sens.** Sans cette garde, une zone laissee par une phase pourrait recouvrir
   * celle d'une voisine et declencher une reaction FANTOME (`onZoneCreated`,
   * `back/src/combat.ts`) : « les quinze se declenchent » survivrait a un salon
   * qui declenche n'importe quoi a cote — exactement le piege du §9 de la spec.
   */
  it('les quinze reactions se declenchent, une par une, et rien d autre', async () => {
    // La table du livrable, en ELEMENTS : les trois salons et ce que chacun
    // porte. Tout le reste — paires, identifiants de reaction, noms, cibles —
    // en est DERIVE.
    const SALONS: readonly (readonly number[])[] = [
      [ELEMENT.BRAISE, ELEMENT.GIVRE, ELEMENT.FOUDRE, ELEMENT.POIX],
      [ELEMENT.CHAUX, ELEMENT.VIF_ARGENT, ELEMENT.BRAISE, ELEMENT.GIVRE],
      [ELEMENT.FOUDRE, ELEMENT.POIX, ELEMENT.CHAUX, ELEMENT.VIF_ARGENT],
    ];

    // ---- L'arithmetique du livrable, verifiee AVANT de jouer quoi que ce
    //      soit : quinze couples, quatorze lignes de table, un seul couple
    //      generique (le Choc thermique de l'etape 5a). ---------------------
    expect(QUINZE_PAIRES.length, 'C(6, 2) doit valoir quinze').toBe(15);
    expect(new Set(QUINZE_PAIRES).size, 'les quinze couples doivent etre distincts').toBe(15);
    expect(REACTION_DEFS.length, 'quatorze reactions a effet specifique').toBe(14);
    expect(
      QUINZE_PAIRES.filter((p) => reactionForPair(p) === undefined),
      'un seul couple sans effet specifique : le Choc thermique',
    ).toEqual([packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE)]);
    // Cinq couples impliquent le Vif-argent, et SEULS TROIS sont liants.
    expect(
      QUINZE_PAIRES.filter((p) => unpackElementPair(p).includes(ELEMENT.VIF_ARGENT)).length,
    ).toBe(5);
    expect(PAIRES_LIANTES.size).toBe(3);

    const dejaVues = new Set<number>();
    /** Toutes les reactions recues, salon par salon, pour l'union finale. */
    const pairesRecues = new Set<number>();
    /** Le nombre de phases jouees par salon : 6, 5, 4 — et rien d'autre. */
    const phasesParSalon: number[] = [];

    for (const elements of SALONS) {
      expect(new Set(elements).size, 'un salon porte quatre elements distincts').toBe(PLAYER_COUNT);

      const code = await createRoomCode();
      const room = app.rooms.get(code);
      if (!room) {
        throw new Error('le registre de salons doit etre accessible depuis l app');
      }

      const clients = await quatreClients(code);
      const armes = elements.map((e) => armeDe(e));
      for (let i = 0; i < PLAYER_COUNT; i++) {
        const client = clients[i];
        const arme = armes[i];
        if (!client || !arme) {
          throw new Error('quatre clients et quatre armes attendus');
        }
        equipe(room, client.playerId, arme.id);
      }

      const temoin = clients[0];
      if (!temoin) {
        throw new Error('quatre clients attendus');
      }
      const snap = await fullSnapshot(temoin.ws);
      const positions = clients.map((c) => {
        const p = snap.players.find((q) => q.id === c.playerId);
        if (!p) {
          throw new Error('les quatre joueurs doivent etre dans le snapshot');
        }
        return { x: p.x, y: p.y };
      });
      const centre = {
        x: positions.reduce((s, p) => s + p.x, 0) / PLAYER_COUNT,
        y: positions.reduce((s, p) => s + p.y, 0) / PLAYER_COUNT,
      };

      // ---- Les phases de CE salon : toute paire de joueurs dont le couple
      //      d'elements n'a pas deja ete couvert par un salon precedent. 6
      //      pour le premier, 5 pour le second, 4 pour le troisieme — derive,
      //      pas enumere. ---------------------------------------------------
      const phases: Phase[] = [];
      for (let i = 0; i < PLAYER_COUNT; i++) {
        for (let j = i + 1; j < PLAYER_COUNT; j++) {
          const ei = elements[i];
          const ej = elements[j];
          const pi = positions[i];
          const pj = positions[j];
          if (ei === undefined || ej === undefined || !pi || !pj) {
            throw new Error('elements et positions attendus');
          }
          const pair = packElementPair(ei, ej);
          if (dejaVues.has(pair)) {
            continue;
          }
          dejaVues.add(pair);
          const def = reactionForPair(pair);
          const cible = positionCible(pi, pj, centre);
          // ⚠️ **Chaque joueur est REPLACE pour la phase (etape 12).** Les
          // coins du depart mettaient toutes les cibles a ~350 px de leurs
          // porteurs, ce qui suffisait a des tirs droits. Un mortier ne
          // touche qu'a sa chute, un boomerang s'arrete a 250 px, une onde a
          // 220, une frappe tombe a 480 pile : chaque porteur se tient donc a
          // `distanceDeTir` de la cible, dans la direction d'ou il venait, et
          // les deux autres a `LOIN`.
          const places = positions.map((p, k) => {
            const arme = armes[k];
            if (!arme) {
              throw new Error('quatre armes attendues');
            }
            return versCible(cible, p, k === i || k === j ? distanceDeTir(arme) : LOIN);
          });
          phases.push({
            nom: def?.name ?? 'choc-thermique',
            pair,
            reactionId: def?.id ?? REACTION.AUCUNE,
            liante: PAIRES_LIANTES.has(pair),
            elements: [ei, ej],
            x: cible.x,
            y: cible.y,
            porteurs: [i, j],
            autres: [0, 1, 2, 3].filter((k) => k !== i && k !== j),
            places,
          });
        }
      }
      phasesParSalon.push(phases.length);

      // ⚠️ **Garde 1 : chaque cible reste a portee des DEUX armes qui doivent
      // la declencher.** Sans elle, une cible hors de portee ne recevrait
      // jamais de tir, et « la reaction ne s'est jamais produite » se lirait
      // comme un succes silencieux du reste du test.
      for (const phase of phases) {
        for (const k of phase.porteurs) {
          const p = phase.places[k];
          const arme = armes[k];
          if (!p || !arme) {
            throw new Error('porteur et arme attendus');
          }
          expect(
            atteint(arme, Math.hypot(phase.x - p.x, phase.y - p.y)),
            `${phase.nom} : la cible doit rester a portee de ${arme.name}`,
          ).toBe(true);
        }
        // ⚠️ **Garde 3 : les deux autres ne l'atteignent JAMAIS.** Le
        // pendant de la garde 1 : une onde (ou n'importe quelle forme a
        // venir) d'un joueur a l'ecart qui toucherait la cible y ajouterait
        // une paire etrangere. La borne prend le plus grand de tout ce que
        // l'arme sait couvrir, frappe comprise.
        for (const k of phase.autres) {
          const p = phase.places[k];
          const arme = armes[k];
          if (!p || !arme) {
            throw new Error('autre et arme attendus');
          }
          expect(
            Math.hypot(phase.x - p.x, phase.y - p.y),
            `${phase.nom} : ${arme.name} atteindrait la cible depuis l ecart`,
          ).toBeGreaterThan(Math.max(porteeDe(arme), arme.blastRadius) + FRAPPE_SEARCH_RADIUS);
        }
      }

      // ⚠️ **Garde 2 : les cibles restent etanches les unes des autres, DANS
      // LES DEUX SENS.** Une zone laissee par une phase ne doit jamais
      // recouvrir celle d'une autre : `onZoneCreated` y verrait un couple
      // d'elements et declencherait une reaction fantome.
      for (let i = 0; i < phases.length; i++) {
        for (let j = i + 1; j < phases.length; j++) {
          const ci = phases[i];
          const cj = phases[j];
          if (!ci || !cj) {
            throw new Error('paire de phases attendue');
          }
          const dist = Math.hypot(ci.x - cj.x, ci.y - cj.y);
          expect(
            dist,
            `${ci.nom} et ${cj.nom} sont trop proches (${dist.toFixed(1)} px)`,
          ).toBeGreaterThan(4 * ZONE_RADIUS);
        }
      }

      // ---- Les phases, l'une apres l'autre. --------------------------------
      //
      // ⚠️ **Un SILENCE avant chaque phase (etape 12).** Les joueurs changent
      // de place d'une phase a l'autre : un boomerang qui revient vers son
      // tireur replace, une onde ou une frappe encore en cours pourraient
      // croiser la cible suivante et y poser l'element d'un joueur qui n'en
      // est pas porteur. Visee nulle, horde videe, le temps que le plus long
      // de ces tirs s'eteigne.
      const SILENCE_TICKS =
        Math.max(...armes.map((a) => a.projectileLifeTicks)) + FRAPPE_DELAY_TICKS + 5;
      let waveId = 9500;
      for (const phase of phases) {
        for (const client of clients) {
          silence(client);
        }
        const finSilence = room.tick + SILENCE_TICKS;
        const balai = setInterval(() => viderSauf(room, []), 8);
        try {
          await waitFor(() => (room.tick >= finSilence ? true : null), 'le silence', 10_000);
        } finally {
          clearInterval(balai);
        }
        for (let k = 0; k < PLAYER_COUNT; k++) {
          const client = clients[k];
          const p = phase.places[k];
          if (client && p) {
            room.debugPlace(client.playerId, p.x, p.y);
          }
        }
        const cible = poseCible(room, waveId++, phase.x, phase.y);
        const dansLeLot = (r: ReactionMessage | ZoneMessage): boolean =>
          Math.hypot(r.x - phase.x, r.y - phase.y) < BUCKET;

        const pilote = setInterval(() => {
          // La cible est la SEULE entite vivante : plus aucune vague ne peut
          // porter une marque, donc plus aucune reaction ne peut naitre
          // ailleurs qu'ici.
          viderSauf(room, [cible]);
          const slot = room.horde.slotOf(cible);
          if (slot >= 0) {
            room.horde.x[slot] = phase.x;
            room.horde.y[slot] = phase.y;
            room.horde.vx[slot] = 0;
            room.horde.vy[slot] = 0;
            room.horde.hp[slot] = 1e6;
          }
          for (const k of phase.porteurs) {
            const client = clients[k];
            const p = phase.places[k];
            if (client && p) {
              vise(client, phase.x - p.x, phase.y - p.y);
            }
          }
          // ⚠️ **Les deux autres visent le VIDE, a l'ecart** : la direction
          // exactement OPPOSEE a la cible, depuis `LOIN`. Leurs armes tirent
          // donc vraiment — leurs deux elements sont bien en jeu dans ce
          // salon — mais aucun de leurs tirs ne peut atteindre la seule
          // entite vivante (garde 3).
          for (const k of phase.autres) {
            const client = clients[k];
            const p = phase.places[k];
            if (client && p) {
              vise(client, p.x - phase.x, p.y - phase.y);
            }
          }
        }, 8);

        try {
          await waitFor(
            () => (reactionsDe(temoin).filter(dansLeLot).length >= MIN_PAR_CIBLE ? true : null),
            `${MIN_PAR_CIBLE} reactions de ${phase.nom}`,
            40_000,
          );
        } finally {
          clearInterval(pilote);
        }
        room.horde.kill([cible]);
      }

      // ---- Les quatre sockets a jour avant de lire. ------------------------
      const recues = reactionsDe(temoin);
      await waitFor(
        () => (clients.every((c) => reactionsDe(c).length >= recues.length) ? true : null),
        'les quatre sockets a jour',
        5000,
      );

      // ---- 1. Chaque phase a produit AU MOINS deux reactions, et EXACTEMENT
      //         celles de sa propre paire — jamais une autre. ---------------
      //
      // ⚠️ **Et CHACUNE charge la barre.** Les deux cotes de chaque paire
      // sortent de deux joueurs DIFFERENTS, par une arme reelle : `markBy`
      // (celui qui a pose le premier element, ou la zone qui le porte) differe
      // donc toujours de `by` (celui qui declenche). C'est precisement le
      // scenario du §7, et la mutation « la Synergie ne charge jamais »
      // (`const charge = false` dans `Room.step`) le fait rougir ici.
      const lots = phases.map((phase) =>
        recues.filter((r) => Math.hypot(r.x - phase.x, r.y - phase.y) < BUCKET),
      );
      for (let i = 0; i < phases.length; i++) {
        const phase = phases[i];
        const lot = lots[i];
        if (!phase || !lot) {
          throw new Error('phase et lot attendus');
        }
        expect(lot.length, `${phase.nom} : pas assez de reactions`).toBeGreaterThanOrEqual(
          MIN_PAR_CIBLE,
        );
        for (const r of lot) {
          expect(r.pair, `${phase.nom} porte la mauvaise paire`).toBe(phase.pair);
          expect(r.synergyCharge, `${phase.nom} : reaction inter-joueurs non chargee`).toBe(true);
        }
        for (const r of lot) {
          pairesRecues.add(r.pair);
        }
      }

      // ---- 2. Champ a champ : AUCUNE reaction n'echappe aux lots. ---------
      //
      // La ligne qui tue « les quinze se declenchent, et n'importe quoi
      // d'autre aussi » : une reaction nee d'un recouvrement de zones entre
      // deux cibles voisines, ou d'une vague echappee au balayage, ne
      // tomberait dans aucun lot et sa somme ne compterait plus le total.
      expect(
        lots.reduce((n, lot) => n + lot.length, 0),
        'des reactions n appartiennent a aucune cible de ce salon',
      ).toBe(recues.length);

      // ⚠️ **La moitie negative par salon est DEJA dite.** Les cibles sont
      // ecartees de plus de `2 * BUCKET` (Garde 2), donc une reaction tombe
      // dans AU PLUS un lot ; la somme ci-dessus dit qu'elle tombe dans au
      // moins un ; et chaque lot ne porte que la paire de sa phase. Toute
      // paire recue est donc une paire jouee — y compris pour celles que les
      // quatre elements du salon rendraient possibles (le salon B porte
      // Braise et Givre sans jamais les faire reagir ensemble). Une boucle de
      // plus sur les paires non jouees ne distinguerait aucune mutation.

      // ---- 3. Le champ laisse au sol porte le bon nibble de reaction, un
      //         element DU couple, et la bonne liaison — sur les DEUX canaux,
      //         ZONE et REACTION, pas seulement l'un des deux. -------------
      const zones = zonesDe(temoin);
      for (const phase of phases) {
        const lot = zones.filter((z) => Math.hypot(z.x - phase.x, z.y - phase.y) < BUCKET);
        expect(lot.length, `${phase.nom} : aucune zone annoncee`).toBeGreaterThan(0);
        for (const z of lot) {
          expect(zoneReaction(z.kind), `${phase.nom} : mauvais nibble de reaction`).toBe(
            phase.reactionId,
          );
          expect(
            phase.elements.includes(zoneElement(z.kind)),
            `${phase.nom} : le champ porte un element hors du couple`,
          ).toBe(true);
          // ⚠️ **La liaison, comparee a la SECONDE liste** (`PAIRES_LIANTES`,
          // ecrite en elements) : trois des cinq paires du Vif-argent sont
          // liantes, Gel profond et Aveuglement ne le sont pas. Retirer
          // `zoneVifArgent: true` d'Amalgame fait rougir cette ligne.
          expect(zoneVifArgent(z.kind), `${phase.nom} : mauvaise liaison`).toBe(phase.liante);
        }
      }

      // ---- 4. La barre suit les charges, et les quatre sockets voient le
      //         meme flot. ---------------------------------------------------
      //
      // `barreSuitLesCharges` exige au moins un releve a `chargees > 0` et
      // `synergy === min(SYNERGY_MAX, chargees)` sur chacun : `chargees` ne
      // decroit jamais, donc le DERNIER releve — celui de `lastSnapshot` —
      // porte forcement une barre non nulle. Rien a assener de plus.
      barreSuitLesCharges(temoin);
      for (const other of clients) {
        expect(reactionsDe(other).slice(0, recues.length)).toEqual(recues);
      }

      for (const ws of openSockets.splice(0)) {
        ws.close();
      }
    }

    // ---- Les QUINZE, et exactement les quinze. ---------------------------
    expect(phasesParSalon, 'six, cinq, puis quatre paires neuves').toEqual([6, 5, 4]);
    expect(pairesRecues.size, 'quinze paires distinctes recues').toBe(15);
    expect(pairesRecues).toEqual(new Set(QUINZE_PAIRES));
  }, 240_000);

  /**
   * **Le pitch du README, testable pour la premiere fois : un joueur seul ne
   * peut couvrir que SIX paires sur quinze.**
   *
   * `WEAPON_SLOTS` vaut quatre : un joueur seul porte au mieux quatre elements
   * differents, donc C(4, 2) = six couples. Les NEUF autres lui sont
   * inaccessibles — non pas parce que le decor les evite, mais parce qu'il ne
   * possede pas les elements qui les forment. C'est ce qui rend vraie la phrase
   * « jouable seul, pense a quatre » : a quatre elements seulement (etape 5a
   * puis 5b), un joueur seul couvrait TOUT.
   *
   * ⚠️ **Les trois autres clients sont connectes et DESARMES.** Ils ne tirent
   * jamais (aucune visee ne leur est envoyee, et `fireSalvoDirected` ne tire pas
   * sur une direction nulle) : le salon entier ne connait donc que les quatre
   * elements du joueur seul.
   */
  it('un joueur seul, quatre slots : six paires au plus, jamais les quinze', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('le registre de salons doit etre accessible depuis l app');
    }

    const clients = await quatreClients(code);
    const a = clients[0];
    if (!a) {
      throw new Error('quatre clients attendus');
    }

    // ---- Quatre elements, un par slot : le maximum qu'un joueur puisse
    //      porter — et c'est la QUEUE de `ELEMENTS_REELS`, pas sa tete. ----
    //
    // ⚠️ **La tete serait un decor qui masque.** `ELEMENTS_REELS` est dans
    // l'ordre de `ELEMENT`, donc ses quatre PREMIERS sont exactement les
    // quatre elements d'AVANT 5c (Braise, Givre, Foudre, Poix) : un joueur
    // seul qui ne porterait qu'eux ne mettrait aucun des deux elements de
    // cette etape sur le chemin solo, et ses neuf paires « interdites »
    // seraient toutes et seulement celles qui EXIGENT la Chaux ou le
    // Vif-argent — une moitie negative vraie par construction, qu'aucune arme
    // du salon ne pourrait de toute facon former. La queue renverse les deux :
    // les elements NEUFS passent par le chemin solo et ses neuf zones de
    // reaction neuves, et ce sont les paires ANCIENNES qui peuplent la moitie
    // negative. L'arithmetique est identique au chiffre pres (six accessibles,
    // neuf interdites) : seule la charge de preuve change de camp.
    const SIENS: readonly number[] = ELEMENTS_REELS.slice(ELEMENTS_REELS.length - WEAPON_SLOTS);
    expect(SIENS.length, 'quatre slots, donc quatre elements au plus').toBe(4);
    expect(WEAPON_SLOTS).toBe(4);
    expect(SIENS, 'le chemin solo doit porter la Chaux').toContain(ELEMENT.CHAUX);
    expect(SIENS, 'le chemin solo doit porter le Vif-argent').toContain(ELEMENT.VIF_ARGENT);

    // Une seule cible, a portee de ses QUATRE armes. ⚠️ **90 px et plus 130
    // depuis l'etape 12** : la Poix qui l'atteint est le halo de l'Encensoir
    // (110 px de rayon ; le mortier du Chaudron ne touche qu'a sa chute, bien
    // plus loin), et la Chaux l'onde du Canon (le Semoir reste aux pieds).
    const OFFSET = 90;
    const armes = SIENS.map((e) => armeRapideDe(e, OFFSET));
    // Les quatre slots pour les quatre elements : sans la dague du depart.
    room.debugResetLoadout(a.playerId);
    for (const arme of armes) {
      equipe(room, a.playerId, arme.id);
    }

    // ---- **Et c'est la PRODUCTION qui refuse le cinquieme element, pas
    //      l'arithmetique de ce test.** ------------------------------------
    //
    // Sans ces trois lignes, « quatre slots donc six paires » reposerait sur
    // le fait que le test n'equipe que quatre armes. `Loadout.canTake` filtre
    // l'etalage et `Loadout.addWeapon` leve : les deux chemins sont assenes,
    // parce qu'ils sont independants (`grantCard` ne passe pas par `canTake`),
    // et l'effet observable — le loadout reste a quatre — avec eux.
    const cinquieme = ELEMENTS_REELS.find((e) => !SIENS.includes(e));
    if (cinquieme === undefined) {
      throw new Error('un cinquieme element doit exister hors des quatre slots');
    }
    const armeDeTrop = armeRapideDe(cinquieme, OFFSET);
    const loadout = room.loadoutOf(a.playerId);
    expect(
      loadout?.canTake(CARD.WEAPON, armeDeTrop.id),
      'l etalage doit refuser un cinquieme element',
    ).toBe(false);
    expect(() => equipe(room, a.playerId, armeDeTrop.id)).toThrow();
    expect(loadout?.weaponSlotsUsed, 'le loadout doit rester a quatre armes').toBe(WEAPON_SLOTS);

    // Les six paires qu'il PEUT former, et les neuf qu'il ne peut pas.
    const ACCESSIBLES = new Set(
      SIENS.flatMap((x, i) => SIENS.slice(i + 1).map((y) => packElementPair(x, y))),
    );
    expect(ACCESSIBLES.size, 'C(4, 2) doit valoir six').toBe(6);
    const INTERDITES = QUINZE_PAIRES.filter((p) => !ACCESSIBLES.has(p));
    expect(INTERDITES.length, 'neuf paires hors de sa portee').toBe(9);

    const snap = await fullSnapshot(a.ws);
    const pa = snap.players.find((p) => p.id === a.playerId);
    if (!pa) {
      throw new Error('le tireur doit etre dans le snapshot');
    }

    for (const arme of armes) {
      expect(atteint(arme, OFFSET), `${arme.name} doit atteindre la cible`).toBe(true);
    }
    const cibleX = pa.x + OFFSET;
    const cibleY = pa.y;
    const cible = poseCible(room, 9800, cibleX, cibleY);

    const pilote = setInterval(() => {
      viderSauf(room, [cible]);
      const slot = room.horde.slotOf(cible);
      if (slot >= 0) {
        room.horde.x[slot] = cibleX;
        room.horde.y[slot] = cibleY;
        room.horde.vx[slot] = 0;
        room.horde.vy[slot] = 0;
        room.horde.hp[slot] = 1e6;
      }
      vise(a, OFFSET, 0);
    }, 8);

    try {
      await waitFor(
        () => {
          const vues = new Set(reactionsDe(a).map((r) => r.pair));
          return vues.size >= ACCESSIBLES.size ? true : null;
        },
        'les six paires d un joueur seul',
        60_000,
      );
    } finally {
      clearInterval(pilote);
    }

    const recues = reactionsDe(a);
    expect(recues.length).toBeGreaterThan(0);

    // ---- 1. Toute reaction recue est bien sur SA cible : aucune ne vient
    //         d'ailleurs. -----------------------------------------------------
    for (const r of recues) {
      expect(Math.hypot(r.x - cibleX, r.y - cibleY), 'une reaction hors de la cible').toBeLessThan(
        BUCKET,
      );
    }

    // ---- 2. **Le compte exact : six paires distinctes, jamais une
    //         septieme — ET la moitie negative du meme coup.** -------------
    //
    // `ACCESSIBLES` et `INTERDITES` partitionnent les quinze : l'egalite
    // d'ensembles ci-dessous dit donc DEJA qu'aucune des neuf interdites n'est
    // apparue, et que six est strictement moins que quinze. Une boucle sur
    // `INTERDITES` ne distinguerait aucune mutation de plus.
    const vues = new Set(recues.map((r) => r.pair));
    expect(vues.size, 'un joueur seul atteint exactement six paires').toBe(6);
    expect(vues).toEqual(ACCESSIBLES);

    // ---- 3. Et rien n'a charge la Synergie : un joueur seul ne peut poser
    //         que sa propre identite des deux cotes de la comparaison du §7.
    //         (Assertion vraie A VIDE prise seule — c'est le livrable
    //         ci-dessus, inter-joueurs, qui lui donne son pouvoir de
    //         distinguer.) ----------------------------------------------------
    expect(recues.every((r) => r.synergyCharge === false)).toBe(true);
    expect(a.lastSnapshot?.synergy).toBe(0);
  }, 90_000);

  /**
   * **Le rayon de touche elargi du §4, mesure au niveau socket et dans les DEUX
   * sens — la cinquieme grandeur de zone, celle qu'aucun test d'integration ne
   * voyait.**
   *
   * Un ennemi dans une zone de Vif-argent est plus facile a toucher :
   * `PROJECTILE_HIT_RADIUS` (32) est majore de `VIF_ARGENT_HIT_RADIUS_BONUS`
   * (16). Le decor place un tireur dont la visee passe a `ECART` de la cible —
   * **strictement au-dela du rayon de base, strictement en deca du rayon
   * elargi** — et compare deux salons :
   *
   * - salon LIE : la cible vit sous une zone de *Paratonnerre* (Foudre +
   *   Vif-argent), `zoneVifArgent: true` ;
   * - salon LIBRE : la cible vit sous une zone d'*Arc caustique* (Foudre +
   *   Chaux), `zoneVifArgent: false`.
   *
   * Le troisieme tireur porte le froleur (la Grenade depuis l'etape 12) dans les deux salons. Si et seulement si
   * le rayon elargi existe, son tir accroche — et une paire PORTANT SON ELEMENT
   * apparait. Dans le salon libre, elle ne doit jamais apparaitre : c'est la
   * moitie negative, et sans elle « le froleur a touche » se lirait aussi bien
   * « le froleur touche toujours ».
   *
   * ⚠️ **Le salon libre porte une SECONDE cible, pile sur l'axe du frolement**
   * (ecart lateral zero, donc touchee au rayon de BASE quoi qu'il arrive), et
   * un quatrieme tireur pour lui donner son second element. C'est elle qui
   * prouve que le froleur est arme ET qu'elle tire DANS CE SALON-CI : sans elle,
   * la moitie negative serait satisfaite a vide par une regression qui perdrait
   * l'equipement ou la visee du troisieme tireur du second banc seulement.
   *
   * ⚠️ **Le tireur de frolement porte une arme a projectile UNIQUE** : a n = 1,
   * `Projectiles.#emit` ignore `spreadRadians` et le tir part exactement dans la
   * direction quantifiee — une salve dispersee rendrait `ECART` indefini.
   *
   * ⚠️ **La cible est re-epinglee depuis le PAS DE SIMULATION, pas depuis
   * l'horloge murale, et c'est ce qui separe un vert d'un faux vert.** La cible
   * est vivante et mobile (`archetype: 0`, `speed` non nul) et sa traction vers
   * le joueur le plus proche a une composante LATERALE, c'est-a-dire vers le
   * rayon du frolement. Un pilote sur `setInterval` la re-epinglait en temps
   * MURAL, alors que la simulation avance en TICKS : `MAX_CATCH_UP_STEPS`
   * (`back/src/server.ts`) vaut cinq, donc un blocage de boucle enchaine
   * jusqu'a cinq `room.step` sans un seul re-epinglage — cinq pas de derive
   * laterale suffisaient a faire tomber l'ecart SOUS le rayon de base, et le
   * frolement accrochait alors sans aucun bonus. Le test passait au vert avec
   * le mecanisme du §4 retire. En enveloppant `Room#step`, la derive est bornee
   * par UN tick, et bornee de facon deterministe plutot que statistique.
   *
   * ⚠️ **Et le TEMOIN la mesure, tick par tick.** `min >= PROJECTILE_HIT_RADIUS`
   * dit que la cible n'a JAMAIS ete a portee du rayon de base — donc que toute
   * touche vient forcement du rayon elargi ; `max < PROJECTILE_HIT_RADIUS +
   * VIF_ARGENT_HIT_RADIUS_BONUS` dit qu'elle est restee dans la fenetre du
   * bonus. Sans ce couple, « le frolement n'accroche que grace au bonus »
   * resterait une esperance geometrique au lieu d'une mesure.
   */
  it('le rayon de touche elargi : un frolement n accroche que dans une zone de Vif-argent', async () => {
    /** Entre le rayon de base et le rayon elargi — derive des deux constantes. */
    const ECART = PROJECTILE_HIT_RADIUS + VIF_ARGENT_HIT_RADIUS_BONUS / 2;
    expect(ECART).toBeGreaterThan(PROJECTILE_HIT_RADIUS);
    expect(ECART).toBeLessThan(PROJECTILE_HIT_RADIUS + VIF_ARGENT_HIT_RADIUS_BONUS);

    // ⚠️ Rien ne compare ici `PAIRES_LIANTES` a ces deux litteraux : ce serait
    // comparer le test a lui-meme, zero couverture de production. La liaison
    // REELLE de chaque salon est assenee plus bas, sur le `kind` des zones que
    // la production a diffusees.
    const PAIRE_LIEE = packElementPair(ELEMENT.FOUDRE, ELEMENT.VIF_ARGENT);
    const PAIRE_LIBRE = packElementPair(ELEMENT.FOUDRE, ELEMENT.CHAUX);

    const FOUDRE = armeDe(ELEMENT.FOUDRE);
    // ⚠️ **Le froleur n'est plus la Poix depuis l'etape 12.** Le frolement
    // exige un projectile qui PERCUTE (le rayon elargi est celui de
    // `collide`), droit et unique ; le Chaudron a poix est devenu un mortier
    // qui ne percute rien en vol, et aucune autre Poix ne tire. Le froleur est
    // donc la plus longue de ces armes hors des elements que le decor met
    // deja en jeu (Foudre, Vif-argent, Chaux, et le Givre de la cible d'axe) :
    // la Grenade, Braise. Ce que le test garde ne change pas — un element
    // TIERS qui n'accroche qu'a la faveur du Vif-argent.
    const FROLEUR = WEAPONS.filter(
      (w) =>
        w.kind === 'tir' &&
        w.projectileCount === 1 &&
        w.motion === 'droit' &&
        w.emission === 'visee' &&
        w.homing === 0 &&
        w.bounces === 0 &&
        w.projectileScale === 1 &&
        !(
          [
            ELEMENT.NEUTRE,
            ELEMENT.FOUDRE,
            ELEMENT.VIF_ARGENT,
            ELEMENT.CHAUX,
            ELEMENT.GIVRE,
          ] as number[]
        ).includes(w.element),
    ).reduce<Weapon | null>((b, w) => (b === null || porteeDe(w) > porteeDe(b) ? w : b), null);
    if (!FROLEUR) {
      throw new Error('aucune arme pour le frolement');
    }
    const LIANT = armeDe(ELEMENT.VIF_ARGENT);
    const INERTE = armeDe(ELEMENT.CHAUX);
    /** Le second element de la cible d'AXE du salon libre — voir plus bas. */
    const AXE = armeDe(ELEMENT.GIVRE);
    /** La paire que la cible d'axe doit produire : elle PORTE l'element du froleur. */
    const PAIRE_AXE = packElementPair(ELEMENT.GIVRE, FROLEUR.element);
    expect(FROLEUR.projectileCount, 'le frolement doit partir droit').toBe(1);

    interface Banc {
      nom: string;
      room: Room;
      clients: Client[];
      /** La cible du FROLEMENT : tout est filtre autour d'elle. */
      x: number;
      y: number;
      /**
       * La cible pile sur l'axe du frolement (ecart lateral zero), posee dans
       * le salon libre seulement — `null` ailleurs.
       */
      axe: Position | null;
      tickDebut: number;
      /**
       * Un releve PAR TICK : la distance perpendiculaire de la cible du
       * frolement au rayon du froleur, mesuree juste apres le pas qui vient de
       * resoudre les collisions.
       */
      ecarts: number[];
      arret: () => void;
    }

    const bancs: Banc[] = [];
    for (const [nom, poseur] of [
      ['lie', LIANT],
      ['libre', INERTE],
    ] as const) {
      const code = await createRoomCode();
      const room = app.rooms.get(code);
      if (!room) {
        throw new Error('le registre de salons doit etre accessible depuis l app');
      }
      const clients = await quatreClients(code);
      const [poseurClient, foudreClient, froleurClient, axeClient] = clients;
      if (!poseurClient || !foudreClient || !froleurClient || !axeClient) {
        throw new Error('quatre tireurs attendus');
      }
      equipe(room, poseurClient.playerId, poseur.id);
      equipe(room, foudreClient.playerId, FOUDRE.id);
      equipe(room, froleurClient.playerId, FROLEUR.id);
      // ⚠️ **Le quatrieme tireur n'existe QUE dans le salon libre**, et c'est
      // la moitie negative qui l'exige (voir sa cible, plus bas). Dans le
      // salon lie il reste desarme et sans visee : il ne tire donc jamais.
      const avecAxe = nom === 'libre';
      if (avecAxe) {
        equipe(room, axeClient.playerId, AXE.id);
      }

      const snap = await fullSnapshot(poseurClient.ws);
      const pos = clients.map((c) => {
        const p = snap.players.find((q) => q.id === c.playerId);
        if (!p) {
          throw new Error('les quatre joueurs doivent etre dans le snapshot');
        }
        return { x: p.x, y: p.y };
      });
      const pFroleur = pos[2];
      const pAxe = pos[3];
      if (!pFroleur || !pAxe) {
        throw new Error('quatre positions attendues');
      }

      // La cible : droit devant le froleur (visee +X exacte), decalee
      // lateralement de `ECART`. Sa visee passe donc a `ECART` d'elle, et a
      // `ECART` seulement — jamais sur elle.
      //
      // ⚠️ **`AVANCE` est court, et c'est la cible d'AXE qui l'impose.** Un
      // projectile MEURT a sa premiere touche (`Projectiles.collide` ->
      // `#removeAt`) : la cible d'axe doit donc etre DERRIERE celle du
      // frolement sur le meme rayon, sinon elle avalerait chaque projectile de
      // froleur et la moitie negative redeviendrait vide par construction. Les
      // deux doivent de plus tenir dans `porteeDe(FROLEUR)` (521 px pour
      // la Grenade) en restant ecartees de plus de `4 * ZONE_RADIUS` —
      // d'ou 80 et 380 plutot que 300 seul.
      const AVANCE = 80;
      const AVANCE_AXE = 380;
      const x = pFroleur.x + AVANCE;
      const y = pFroleur.y + ECART;
      const xAxe = pFroleur.x + AVANCE_AXE;
      const yAxe = pFroleur.y;

      // ⚠️ **Le poseur et la Foudre sont REPLACES (etape 12)**, a la distance
      // ou leur forme marque la cible : le Glaive s'arrete a 250 px, l'onde a
      // 220, la frappe tombe a 480 pile — les coins du depart ne conviennent a
      // aucune. Le poseur en bas a gauche, loin de la cible d'axe (son onde
      // n'a pas de direction) ; la Foudre droit en dessous, visee (0, -1)
      // exacte, pour que l'impact tombe sur la cible et nulle part ailleurs.
      const dPoseur = distanceDeTir(poseur) * Math.SQRT1_2;
      const pPoseur = { x: x - dPoseur, y: y + dPoseur };
      const pFoudre = { x, y: y + distanceDeTir(FOUDRE) };
      room.debugPlace(poseurClient.playerId, pPoseur.x, pPoseur.y);
      room.debugPlace(foudreClient.playerId, pFoudre.x, pFoudre.y);

      // Gardes : les cibles a portee des armes qui doivent les declencher, le
      // frolement RIGOUREUSEMENT lateral, et les deux cibles etanches.
      expect(atteint(poseur, Math.hypot(x - pPoseur.x, y - pPoseur.y))).toBe(true);
      expect(atteint(FOUDRE, Math.hypot(x - pFoudre.x, y - pFoudre.y))).toBe(true);
      expect(atteint(FROLEUR, Math.hypot(x - pFroleur.x, y - pFroleur.y))).toBe(true);
      // L'onde du poseur ne doit pas atteindre la cible d'axe : elle y
      // poserait la Chaux, une paire de plus autour de l'axe.
      expect(Math.hypot(xAxe - pPoseur.x, yAxe - pPoseur.y)).toBeGreaterThan(
        Math.max(porteeDe(poseur) / 4, poseur.blastRadius),
      );
      expect(y - pFroleur.y, 'le frolement doit valoir exactement ECART').toBe(ECART);
      expect(x).toBeGreaterThan(pFroleur.x);
      expect(AVANCE_AXE, 'la cible d axe doit etre DERRIERE celle du frolement').toBeGreaterThan(
        AVANCE,
      );
      expect(AVANCE_AXE, 'la cible d axe doit rester a portee du froleur').toBeLessThan(
        porteeDe(FROLEUR),
      );
      expect(yAxe - pFroleur.y, 'la cible d axe doit etre PILE sur l axe').toBe(0);
      expect(atteint(AXE, Math.hypot(xAxe - pAxe.x, yAxe - pAxe.y))).toBe(true);
      expect(
        Math.hypot(xAxe - x, yAxe - y),
        'les deux cibles declencheraient une zone fantome',
      ).toBeGreaterThan(4 * ZONE_RADIUS);

      const cible = poseCible(room, 9900, x, y);
      const gardees = [cible];
      let axe: Position | null = null;
      if (avecAxe) {
        // ⚠️ **La cible d'AXE : ecart lateral ZERO, donc touchee au rayon de
        // BASE quoi qu'il arrive.** C'est elle qui prouve que le froleur est
        // arme ET qu'elle tire DANS CE SALON-CI. Sans elle, « aucune paire
        // portant son element dans le salon libre » serait satisfaite par une
        // regression qui perdrait l'equipement ou la visee du troisieme
        // tireur du second banc seulement — et « le frolement n'accroche QUE
        // sous Vif-argent » resterait non prouve pendant que le test verdit.
        gardees.push(poseCible(room, 9901, xAxe, yAxe));
        axe = { x: xAxe, y: yAxe };
      }

      /** Le corps que le pilote mural executait : il repart de la position exacte. */
      const epingle = (): void => {
        viderSauf(room, gardees);
        for (const id of gardees) {
          const slot = room.horde.slotOf(id);
          if (slot < 0) {
            continue;
          }
          const cx = id === cible ? x : xAxe;
          const cy = id === cible ? y : yAxe;
          room.horde.x[slot] = cx;
          room.horde.y[slot] = cy;
          room.horde.vx[slot] = 0;
          room.horde.vy[slot] = 0;
          room.horde.hp[slot] = 1e6;
        }
      };
      const ecarts: number[] = [];
      /** La distance que la collision a VUE, a un tick pres. */
      const releve = (): void => {
        const slot = room.horde.slotOf(cible);
        if (slot >= 0) {
          ecarts.push(Math.abs((room.horde.y[slot] ?? 0) - pFroleur.y));
        }
      };

      // ⚠️ **Le re-epinglage vit dans le PAS, pas dans l'horloge murale** —
      // voir le docbloc. La visee reste sur l'horloge : elle traverse la
      // socket, c'est sa place ; seule la POSITION doit etre epinglee au tick.
      const pasOriginal = room.step.bind(room);
      room.step = (dt: number): void => {
        epingle();
        pasOriginal(dt);
        releve();
      };

      const pilote = setInterval(() => {
        vise(poseurClient, x - pPoseur.x, y - pPoseur.y);
        vise(foudreClient, x - pFoudre.x, y - pFoudre.y);
        // Le frolement : plein axe +X, jamais vers la cible.
        vise(froleurClient, 1, 0);
        if (avecAxe) {
          vise(axeClient, xAxe - pAxe.x, yAxe - pAxe.y);
        }
      }, 8);

      bancs.push({
        nom,
        room,
        clients,
        x,
        y,
        axe,
        tickDebut: room.tick,
        ecarts,
        arret: () => {
          clearInterval(pilote);
          room.step = pasOriginal;
        },
      });
    }

    const lie = bancs[0];
    const libre = bancs[1];
    if (!lie || !libre) {
      throw new Error('deux bancs attendus');
    }
    const temoinLie = lie.clients[0];
    const temoinLibre = libre.clients[0];
    if (!temoinLie || !temoinLibre) {
      throw new Error('deux temoins attendus');
    }

    const axeLibre = libre.axe;
    if (!axeLibre) {
      throw new Error('le salon libre doit porter une cible d axe');
    }

    /** Vrai si la paire porte l'element du froleur — donc si le frolement a accroche. */
    const parLeFroleur = (r: ReactionMessage): boolean =>
      unpackElementPair(r.pair).includes(FROLEUR.element);

    /**
     * Les reactions d'un point donne. **Le salon libre porte DEUX cibles**,
     * donc « le froleur a accroche » n'a plus de sens sans dire OU.
     */
    const autour = (client: Client, p: Position): ReactionMessage[] =>
      reactionsDe(client).filter((r) => Math.hypot(r.x - p.x, r.y - p.y) < BUCKET);

    /** Dix secondes de tir dans le salon libre : le froleur a tire une dizaine de fois. */
    const TICKS_DE_PREUVE = TICK_HZ * 10;

    try {
      await waitFor(
        () =>
          autour(temoinLie, lie).filter(parLeFroleur).length >= MIN_PAR_CIBLE &&
          autour(temoinLie, lie).some((r) => r.pair === PAIRE_LIEE) &&
          autour(temoinLibre, libre).some((r) => r.pair === PAIRE_LIBRE) &&
          autour(temoinLibre, axeLibre).some((r) => r.pair === PAIRE_AXE) &&
          libre.room.tick - libre.tickDebut >= TICKS_DE_PREUVE
            ? true
            : null,
        'le frolement accroche dans la zone liante, et le froleur tire dans le salon libre',
        90_000,
      );
    } finally {
      lie.arret();
      libre.arret();
    }

    // ---- Les deux salons ont bien pose la zone qu'ils pretendent poser : la
    //      comparaison ne porte pas sur deux decors vides. -------------------
    for (const banc of [lie, libre]) {
      const temoin = banc.clients[0];
      if (!temoin) {
        throw new Error('temoin attendu');
      }
      const zones = zonesDe(temoin).filter((z) => Math.hypot(z.x - banc.x, z.y - banc.y) < BUCKET);
      expect(zones.length, `${banc.nom} : aucune zone annoncee`).toBeGreaterThan(0);
      const liantes = zones.filter((z) => zoneVifArgent(z.kind));
      if (banc === lie) {
        expect(liantes.length, 'le salon lie doit porter une zone liante').toBeGreaterThan(0);
      } else {
        expect(liantes.length, 'le salon libre ne doit porter aucune zone liante').toBe(0);
      }
    }

    // ---- **Le TEMOIN : ce que la collision a VU, tick par tick.** Sans ce
    //      couple, « le frolement n'accroche que grace au bonus » resterait
    //      une esperance geometrique. ------------------------------------------
    for (const banc of [lie, libre]) {
      expect(banc.ecarts.length, `${banc.nom} : aucun releve de frolement`).toBeGreaterThan(0);
      expect(
        Math.min(...banc.ecarts),
        `${banc.nom} : la cible est passee a portee du rayon de BASE`,
      ).toBeGreaterThanOrEqual(PROJECTILE_HIT_RADIUS);
      expect(
        Math.max(...banc.ecarts),
        `${banc.nom} : la cible est sortie de la fenetre du bonus`,
      ).toBeLessThan(PROJECTILE_HIT_RADIUS + VIF_ARGENT_HIT_RADIUS_BONUS);
    }

    // ---- **Les deux sens.** Dans la zone liante, le frolement accroche ;
    //      sans elle, JAMAIS — et le salon libre a tire au moins aussi
    //      longtemps. -------------------------------------------------------
    expect(
      autour(temoinLie, lie).filter(parLeFroleur).length,
      'le frolement n a jamais accroche dans la zone liante',
    ).toBeGreaterThanOrEqual(MIN_PAR_CIBLE);
    expect(
      autour(temoinLibre, libre).filter(parLeFroleur),
      'le frolement a accroche SANS zone de Vif-argent',
    ).toEqual([]);
    expect(libre.room.tick - libre.tickDebut).toBeGreaterThanOrEqual(TICKS_DE_PREUVE);

    // ---- **Et le froleur du salon libre a bien TIRE.** La cible d'axe est a
    //      ecart lateral ZERO : elle est touchee au rayon de BASE quoi qu'il
    //      arrive. Cette seule assertion dit « le froleur est arme et tire dans
    //      CE salon » — donc que son absence sur la cible du frolement vient
    //      bien des 40 px, et de rien d'autre. ----------------------------
    expect(
      autour(temoinLibre, axeLibre).filter(parLeFroleur).length,
      'le froleur du salon libre n a jamais tire',
    ).toBeGreaterThanOrEqual(MIN_PAR_CIBLE);
  }, 120_000);

  /**
   * **Le critere de l'etape, mesure ou il compte : `Room`/socket, avec de
   * vraies armes dans un vrai salon — dans les DEUX sens.**
   *
   * - le salon VIEUX : seules Braise et Givre tirent (Choc thermique, la
   *   reaction generique de l'etape 5a) ;
   * - le salon NEUF : la Chaux et le Vif-argent tirent (Aveuglement, la
   *   quinzieme reaction).
   *
   * ⚠️ **Le second doit produire des paires NOUVELLES**, sinon l'egalite
   * comparerait deux ensembles vides — le cinquieme des « decors qui
   * masquent » du §9 de la spec. Les deux ensembles de paires sont donc
   * assenes DISJOINTS et non vides avant toute mesure d'octets.
   *
   * ⚠️ **Ce que « le trafic ne bouge pas » prouve VRAIMENT ici.** D'un salon a
   * l'autre, le NOMBRE de `ZONE`/`REACTION` recus differe forcement (quatre
   * armes de cadences differentes) : egaler ce compte ne prouverait rien qu'un
   * decor bien choisi n'ait deja truque. Ce qui NE PEUT PAS bouger,
   * structurellement, c'est le cout PAR MESSAGE — `ZONE_BYTES`,
   * `REACTION_BYTES` et la formule du `SNAPSHOT` ne dependent QUE du nombre de
   * joueurs, jamais du contenu qu'ils empaquettent (`packZoneKind`,
   * `packElementPair`). C'est ca, le contrat a « zero octet de plus ».
   */
  it('le trafic par joueur ne bouge pas : meme cout par message, chaux/vif-argent tirent ou pas', async () => {
    const BRAISE = armeDe(ELEMENT.BRAISE);
    const GIVRE = armeDe(ELEMENT.GIVRE);
    const CHAUX = armeDe(ELEMENT.CHAUX);
    const VIF_ARGENT = armeDe(ELEMENT.VIF_ARGENT);

    const PAIR_VIEUX = packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE);
    const PAIR_NEUF = packElementPair(ELEMENT.CHAUX, ELEMENT.VIF_ARGENT);

    interface Banc {
      nom: string;
      clients: Client[];
      debutSnapshot: number;
      arret: () => void;
    }

    const bancs: Banc[] = [];
    for (const [nom, gauche, droite] of [
      ['vieux', BRAISE, GIVRE],
      ['neuf', CHAUX, VIF_ARGENT],
    ] as const) {
      const code = await createRoomCode();
      const room = app.rooms.get(code);
      if (!room) {
        throw new Error('le registre de salons doit etre accessible depuis l app');
      }
      const clients = await quatreClients(code);
      const [un, deux] = clients;
      if (!un || !deux) {
        throw new Error('deux tireurs attendus');
      }
      equipe(room, un.playerId, gauche.id);
      equipe(room, deux.playerId, droite.id);

      const snap = await fullSnapshot(un.ws);
      const pUn = snap.players.find((p) => p.id === un.playerId);
      const pDeux = snap.players.find((p) => p.id === deux.playerId);
      if (!pUn || !pDeux) {
        throw new Error('les deux tireurs doivent etre dans leur snapshot');
      }

      // La cible, a mi-chemin exact des deux tireurs : a portee des deux.
      const x = (pUn.x + pDeux.x) / 2;
      const y = (pUn.y + pDeux.y) / 2 + 120;
      expect(atteint(gauche, Math.hypot(x - pUn.x, y - pUn.y))).toBe(true);
      expect(atteint(droite, Math.hypot(x - pDeux.x, y - pDeux.y))).toBe(true);

      const cible = poseCible(room, 9700, x, y);
      // A partir d'ici, chaque snapshot porte les quatre joueurs : c'est le
      // point de depart de la mesure, pour ne pas confondre les tailles
      // PARTIELLES de la connexion avec la taille STABLE du reste de la run.
      const debutSnapshot = un.rawByType.get(MSG.SNAPSHOT)?.length ?? 0;

      const pilote = setInterval(() => {
        viderSauf(room, [cible]);
        const slot = room.horde.slotOf(cible);
        if (slot >= 0) {
          room.horde.x[slot] = x;
          room.horde.y[slot] = y;
          room.horde.vx[slot] = 0;
          room.horde.vy[slot] = 0;
          room.horde.hp[slot] = 1e6;
        }
        vise(un, x - pUn.x, y - pUn.y);
        vise(deux, x - pDeux.x, y - pDeux.y);
      }, 8);

      bancs.push({ nom, clients, debutSnapshot, arret: () => clearInterval(pilote) });
    }

    const vieux = bancs[0];
    const neuf = bancs[1];
    if (!vieux || !neuf) {
      throw new Error('deux bancs attendus');
    }
    const aVieux = vieux.clients[0];
    const aNeuf = neuf.clients[0];
    if (!aVieux || !aNeuf) {
      throw new Error('deux temoins attendus');
    }

    const MIN_REACTIONS = 6;
    /** Les huit sockets des deux bancs : la mesure « par joueur » les exige TOUTES. */
    const toutesLesSockets = [...vieux.clients, ...neuf.clients];
    try {
      await waitFor(
        () =>
          reactionsDe(aVieux).length >= MIN_REACTIONS &&
          reactionsDe(aNeuf).length >= MIN_REACTIONS &&
          // La diffusion atteint les NON-tireurs aussi : on l'attend, pour que
          // la mesure par joueur plus bas ne puisse pas etre vide.
          toutesLesSockets.every(
            (c) =>
              (c.rawByType.get(MSG.ZONE)?.length ?? 0) > 0 &&
              (c.rawByType.get(MSG.REACTION)?.length ?? 0) > 0,
          )
            ? true
            : null,
        `${MIN_REACTIONS} reactions dans chaque salon, diffusees aux quatre joueurs`,
        60_000,
      );
    } finally {
      vieux.arret();
      neuf.arret();
    }

    // ---- Le decor prouve ce qu'il pretend prouver : les paires annoncees
    //      sont celles recues, elles sont DISJOINTES, et la Chaux comme le
    //      Vif-argent ne tirent VRAIMENT jamais dans le salon vieux. --------
    const pairesVieux = new Set(reactionsDe(aVieux).map((r) => r.pair));
    const pairesNeuf = new Set(reactionsDe(aNeuf).map((r) => r.pair));
    expect(pairesVieux).toEqual(new Set([PAIR_VIEUX]));
    expect(pairesNeuf).toEqual(new Set([PAIR_NEUF]));
    // ⚠️ **La seule chose que la disjonction disait de plus : les deux
    // litteraux sont distincts.** Les deux egalites ci-dessus la donnent
    // sinon mot pour mot — mais un `packElementPair` qui confondrait deux
    // couples les satisferait toutes les deux en comparant des ensembles
    // EGAUX, et les deux salons se recouvriraient en silence.
    expect(PAIR_VIEUX, 'les deux salons se recouvrent').not.toBe(PAIR_NEUF);
    expect(
      zonesDe(aVieux).every(
        (z) => zoneElement(z.kind) !== ELEMENT.CHAUX && zoneElement(z.kind) !== ELEMENT.VIF_ARGENT,
      ),
    ).toBe(true);
    expect(
      zonesDe(aNeuf).some(
        (z) => zoneElement(z.kind) === ELEMENT.CHAUX || zoneElement(z.kind) === ELEMENT.VIF_ARGENT,
      ),
    ).toBe(true);

    // ---- La mesure : le cout PAR MESSAGE, pas le compte. -----------------
    function tailles(client: Client, type: number, depuis: number): number[] {
      return (client.rawByType.get(type) ?? []).slice(depuis);
    }

    // ⚠️ **Les deux constantes du `SNAPSHOT`, en chiffres NUS.**
    // `snapshotAttendu` est la formule de production elle-meme : la comparer a
    // une taille que ces deux memes constantes produisent serait vraie quoi
    // qu'il arrive — porter l'en-tete de 22 a 24 ferait attendre 60 et recevoir
    // 60. C'est le piege que `shared/protocol.test.ts` nomme mot pour mot (« une
    // assertion `toBe(SNAPSHOT_HEADER_BYTES)` serait vraie quoi qu'il
    // arrive »), et ce sont ces deux lignes-ci qui portent « zero octet de
    // plus » pour le `SNAPSHOT`, exactement comme `ZONE_BYTES` /
    // `REACTION_BYTES` plus bas le portent pour les deux autres lots.
    expect(SNAPSHOT_HEADER_BYTES).toBe(22);
    expect(SNAPSHOT_PLAYER_BYTES).toBe(10);
    const snapshotAttendu = SNAPSHOT_HEADER_BYTES + PLAYER_COUNT * SNAPSHOT_PLAYER_BYTES;

    for (const banc of [vieux, neuf]) {
      const temoin = banc.clients[0];
      if (!temoin) {
        throw new Error('temoin attendu');
      }
      const zoneSizes = tailles(temoin, MSG.ZONE, 0);
      const reactionSizes = tailles(temoin, MSG.REACTION, 0);
      const snapshotSizes = tailles(temoin, MSG.SNAPSHOT, banc.debutSnapshot);

      expect(zoneSizes.length, `${banc.nom} : aucune ZONE mesuree`).toBeGreaterThan(0);
      expect(reactionSizes.length, `${banc.nom} : aucune REACTION mesuree`).toBeGreaterThan(0);
      expect(snapshotSizes.length, `${banc.nom} : aucun SNAPSHOT mesure`).toBeGreaterThan(0);

      // Chaque ZONE et chaque REACTION coute EXACTEMENT `ZONE_BYTES` /
      // `REACTION_BYTES`, quel que soit le `kind`/`pair` qu'elle empaquette.
      expect(new Set(zoneSizes)).toEqual(new Set([ZONE_BYTES]));
      expect(new Set(reactionSizes)).toEqual(new Set([REACTION_BYTES]));
      expect(new Set(snapshotSizes)).toEqual(new Set([snapshotAttendu]));
    }

    // ---- Le meme cout, salon a salon : c'est LA comparaison qui repond a
    //      « le trafic n'a pas bouge », dans les deux sens. -----------------
    expect(ZONE_BYTES).toBe(11);
    expect(REACTION_BYTES).toBe(11);
    expect(tailles(aVieux, MSG.ZONE, 0)[0]).toBe(tailles(aNeuf, MSG.ZONE, 0)[0]);
    expect(tailles(aVieux, MSG.REACTION, 0)[0]).toBe(tailles(aNeuf, MSG.REACTION, 0)[0]);
    expect(tailles(aVieux, MSG.SNAPSHOT, vieux.debutSnapshot)[0]).toBe(
      tailles(aNeuf, MSG.SNAPSHOT, neuf.debutSnapshot)[0],
    );

    // ---- Et c'est vrai PAR JOUEUR, pas seulement pour le tireur. ---------
    //
    // ⚠️ **Aucun `if` ici.** Garder la comparaison derriere « s'il y en a »
    // laissait une boucle VIDE et verte sous un commentaire qui affirmait le
    // contraire : si la diffusion aux non-tireurs tombait a zero, rien n'aurait
    // rougi. Les huit sockets doivent avoir recu les deux lots.
    for (const client of toutesLesSockets) {
      const zoneSizes = tailles(client, MSG.ZONE, 0);
      const reactionSizes = tailles(client, MSG.REACTION, 0);
      expect(zoneSizes.length, 'une socket n a recu aucune ZONE').toBeGreaterThan(0);
      expect(reactionSizes.length, 'une socket n a recu aucune REACTION').toBeGreaterThan(0);
      expect(new Set(zoneSizes)).toEqual(new Set([ZONE_BYTES]));
      expect(new Set(reactionSizes)).toEqual(new Set([REACTION_BYTES]));
    }
  }, 120_000);
});
