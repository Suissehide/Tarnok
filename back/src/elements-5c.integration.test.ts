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
import { REACTION, REACTION_DEFS, reactionForPair, zoneVifArgent } from '@shared/reactions';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { WEAPONS, type Weapon } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

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
 * **L'arme de cet element qui porte le plus loin, parmi celles a projectile
 * UNIQUE.**
 *
 * ⚠️ **`projectileCount === 1` n'est pas une coquetterie : c'est ce qui rend le
 * decor deterministe.** `Projectiles.#emit` repartit `projectileCount`
 * projectiles symetriquement autour de la visee — a n = 1 le `spreadRadians`
 * est ignore et le tir part EXACTEMENT dans la direction quantifiee. Une arme a
 * deux projectiles ecarte chacun de `spreadRadians / 2` : la bobine-tesla
 * (0,2 rad) manquerait une cible a 350 px de 33 px, soit juste au-dela de
 * `PROJECTILE_HIT_RADIUS` — « la reaction ne s'est pas produite » se lirait
 * alors comme un echec du jeu et non du decor.
 */
function armeDe(element: number): Weapon {
  const best = WEAPONS.filter(
    (w) => w.element === element && w.projectileCount === 1,
  ).reduce<Weapon | null>((b, w) => (b === null || porteeDe(w) > porteeDe(b) ? w : b), null);
  if (!best) {
    throw new Error(`aucune arme a projectile unique pour l element ${element}`);
  }
  return best;
}

/** L'arme de cet element qui tire le plus souvent — pour le decor du joueur seul. */
function armeRapideDe(element: number): Weapon {
  const best = WEAPONS.filter((w) => w.element === element).reduce<Weapon | null>(
    (b, w) => (b === null || w.cooldownTicks < b.cooldownTicks ? w : b),
    null,
  );
  if (!best) {
    throw new Error(`aucune arme pour l element ${element}`);
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
          const p = positions[k];
          const arme = armes[k];
          if (!p || !arme) {
            throw new Error('porteur et arme attendus');
          }
          expect(
            Math.hypot(phase.x - p.x, phase.y - p.y),
            `${phase.nom} : la cible doit rester a portee de ${arme.name}`,
          ).toBeLessThan(porteeDe(arme));
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
      let waveId = 9500;
      for (const phase of phases) {
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
            const p = positions[k];
            if (client && p) {
              vise(client, phase.x - p.x, phase.y - p.y);
            }
          }
          // ⚠️ **Les deux autres visent le VIDE, a l'ecart** : la direction
          // exactement OPPOSEE a la cible. Leurs armes tirent donc vraiment —
          // leurs deux elements sont bien en jeu dans ce salon — mais aucun de
          // leurs projectiles ne peut atteindre la seule entite vivante.
          for (const k of phase.autres) {
            const client = clients[k];
            const p = positions[k];
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

      // ---- 3. **La moitie negative.** Les paires que ce salon NE joue PAS
      //         n'apparaissent jamais — y compris celles que ses quatre
      //         elements rendraient pourtant possibles (le salon B porte
      //         Braise et Givre sans jamais les faire reagir ensemble). ----
      const jouees = new Set(phases.map((p) => p.pair));
      for (const pair of QUINZE_PAIRES) {
        if (jouees.has(pair)) {
          continue;
        }
        expect(
          recues.some((r) => r.pair === pair),
          `une paire non jouee est apparue : ${reactionForPair(pair)?.name ?? 'choc-thermique'}`,
        ).toBe(false);
      }

      // ---- 4. Le champ laisse au sol porte le bon nibble de reaction, un
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

      // ---- 5. La barre suit les charges, et les quatre sockets voient le
      //         meme flot. ---------------------------------------------------
      barreSuitLesCharges(temoin);
      expect(temoin.lastSnapshot?.synergy).toBeGreaterThan(0);
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

    // Quatre elements, un par slot : le maximum qu'un joueur puisse porter.
    const SIENS: readonly number[] = ELEMENTS_REELS.slice(0, WEAPON_SLOTS);
    expect(SIENS.length, 'quatre slots, donc quatre elements au plus').toBe(4);
    expect(WEAPON_SLOTS).toBe(4);

    const armes = SIENS.map((e) => armeRapideDe(e));
    for (const arme of armes) {
      equipe(room, a.playerId, arme.id);
    }

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

    // Une seule cible, a portee de ses QUATRE armes (la plus courte decide).
    const OFFSET = 130;
    for (const arme of armes) {
      expect(OFFSET, `${arme.name} doit atteindre la cible`).toBeLessThan(porteeDe(arme));
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
    //         septieme.** -----------------------------------------------------
    const vues = new Set(recues.map((r) => r.pair));
    expect(vues.size, 'un joueur seul atteint exactement six paires').toBe(6);
    expect(vues).toEqual(ACCESSIBLES);

    // ---- 3. **La moitie negative : les NEUF autres n'apparaissent jamais.**
    //         Et c'est ca, le pitch : les quinze exigent les six elements,
    //         donc une equipe. -----------------------------------------------
    for (const pair of INTERDITES) {
      expect(
        vues.has(pair),
        `une paire hors de ses slots est apparue : ${
          reactionForPair(pair)?.name ?? 'choc-thermique'
        }`,
      ).toBe(false);
    }
    expect(vues.size).toBeLessThan(QUINZE_PAIRES.length);

    // ---- 4. Et rien n'a charge la Synergie : un joueur seul ne peut poser
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
   * Le troisieme tireur porte la Poix dans les deux salons. Si et seulement si
   * le rayon elargi existe, sa Poix accroche — et une paire PORTANT LA POIX
   * apparait. Dans le salon libre, elle ne doit jamais apparaitre : c'est la
   * moitie negative, et sans elle « la Poix a touche » se lirait aussi bien
   * « la Poix touche toujours ».
   *
   * ⚠️ **Le tireur de frolement porte une arme a projectile UNIQUE** : a n = 1,
   * `Projectiles.#emit` ignore `spreadRadians` et le tir part exactement dans la
   * direction quantifiee — une salve dispersee rendrait `ECART` indefini.
   */
  it('le rayon de touche elargi : un frolement n accroche que dans une zone de Vif-argent', async () => {
    /** Entre le rayon de base et le rayon elargi — derive des deux constantes. */
    const ECART = PROJECTILE_HIT_RADIUS + VIF_ARGENT_HIT_RADIUS_BONUS / 2;
    expect(ECART).toBeGreaterThan(PROJECTILE_HIT_RADIUS);
    expect(ECART).toBeLessThan(PROJECTILE_HIT_RADIUS + VIF_ARGENT_HIT_RADIUS_BONUS);

    const PAIRE_LIEE = packElementPair(ELEMENT.FOUDRE, ELEMENT.VIF_ARGENT);
    const PAIRE_LIBRE = packElementPair(ELEMENT.FOUDRE, ELEMENT.CHAUX);
    expect(PAIRES_LIANTES.has(PAIRE_LIEE), 'Paratonnerre doit etre liante').toBe(true);
    expect(PAIRES_LIANTES.has(PAIRE_LIBRE), 'Arc caustique ne doit pas l etre').toBe(false);

    const FOUDRE = armeDe(ELEMENT.FOUDRE);
    const POIX = armeDe(ELEMENT.POIX);
    const LIANT = armeDe(ELEMENT.VIF_ARGENT);
    const INERTE = armeDe(ELEMENT.CHAUX);
    expect(POIX.projectileCount, 'le frolement doit partir droit').toBe(1);

    interface Banc {
      nom: string;
      room: Room;
      clients: Client[];
      x: number;
      y: number;
      tickDebut: number;
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
      const [poseurClient, foudreClient, poixClient] = clients;
      if (!poseurClient || !foudreClient || !poixClient) {
        throw new Error('trois tireurs attendus');
      }
      equipe(room, poseurClient.playerId, poseur.id);
      equipe(room, foudreClient.playerId, FOUDRE.id);
      equipe(room, poixClient.playerId, POIX.id);

      const snap = await fullSnapshot(poseurClient.ws);
      const pos = clients.map((c) => {
        const p = snap.players.find((q) => q.id === c.playerId);
        if (!p) {
          throw new Error('les quatre joueurs doivent etre dans le snapshot');
        }
        return { x: p.x, y: p.y };
      });
      const pPoseur = pos[0];
      const pFoudre = pos[1];
      const pPoix = pos[2];
      if (!pPoseur || !pFoudre || !pPoix) {
        throw new Error('trois positions attendues');
      }

      // La cible : droit devant le tireur de Poix (visee +X exacte), decalee
      // lateralement de `ECART`. Sa visee passe donc a `ECART` d'elle, et a
      // `ECART` seulement — jamais sur elle.
      const AVANCE = 300;
      const x = pPoix.x + AVANCE;
      const y = pPoix.y + ECART;

      // Gardes : la cible a portee des trois armes, et le frolement
      // RIGOUREUSEMENT lateral.
      expect(Math.hypot(x - pPoseur.x, y - pPoseur.y)).toBeLessThan(porteeDe(poseur));
      expect(Math.hypot(x - pFoudre.x, y - pFoudre.y)).toBeLessThan(porteeDe(FOUDRE));
      expect(Math.hypot(x - pPoix.x, y - pPoix.y)).toBeLessThan(porteeDe(POIX));
      expect(y - pPoix.y, 'le frolement doit valoir exactement ECART').toBe(ECART);
      expect(x).toBeGreaterThan(pPoix.x);

      const cible = poseCible(room, 9900, x, y);
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
        vise(poseurClient, x - pPoseur.x, y - pPoseur.y);
        vise(foudreClient, x - pFoudre.x, y - pFoudre.y);
        // Le frolement : plein axe +X, jamais vers la cible.
        vise(poixClient, 1, 0);
      }, 8);

      bancs.push({
        nom,
        room,
        clients,
        x,
        y,
        tickDebut: room.tick,
        arret: () => clearInterval(pilote),
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

    /** Vrai si la paire porte la Poix — donc si le frolement a accroche. */
    const parLaPoix = (r: ReactionMessage): boolean =>
      unpackElementPair(r.pair).includes(ELEMENT.POIX);

    /** Dix secondes de tir dans le salon libre : la Poix a tire une dizaine de fois. */
    const TICKS_DE_PREUVE = TICK_HZ * 10;

    try {
      await waitFor(
        () =>
          reactionsDe(temoinLie).filter(parLaPoix).length >= MIN_PAR_CIBLE &&
          reactionsDe(temoinLibre).some((r) => r.pair === PAIRE_LIBRE) &&
          libre.room.tick - libre.tickDebut >= TICKS_DE_PREUVE
            ? true
            : null,
        'le frolement accroche dans la zone liante, et le salon libre a tire autant',
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

    // ---- **Les deux sens.** Dans la zone liante, le frolement accroche ;
    //      sans elle, JAMAIS — et les deux salons ont tire aussi longtemps.
    expect(
      reactionsDe(temoinLie).filter(parLaPoix).length,
      'le frolement n a jamais accroche dans la zone liante',
    ).toBeGreaterThanOrEqual(MIN_PAR_CIBLE);
    expect(
      reactionsDe(temoinLibre).filter(parLaPoix),
      'le frolement a accroche SANS zone de Vif-argent',
    ).toEqual([]);
    expect(libre.room.tick - libre.tickDebut).toBeGreaterThanOrEqual(TICKS_DE_PREUVE);
    expect(
      reactionsDe(temoinLibre).length,
      'le salon libre n a rien produit du tout',
    ).toBeGreaterThan(0);
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
      expect(Math.hypot(x - pUn.x, y - pUn.y)).toBeLessThan(porteeDe(gauche));
      expect(Math.hypot(x - pDeux.x, y - pDeux.y)).toBeLessThan(porteeDe(droite));

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
    try {
      await waitFor(
        () =>
          reactionsDe(aVieux).length >= MIN_REACTIONS && reactionsDe(aNeuf).length >= MIN_REACTIONS
            ? true
            : null,
        `${MIN_REACTIONS} reactions dans chaque salon`,
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
    expect(
      [...pairesNeuf].some((p) => pairesVieux.has(p)),
      'les deux salons se recouvrent',
    ).toBe(false);
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
    for (const client of [...vieux.clients, ...neuf.clients]) {
      const zoneSizes = tailles(client, MSG.ZONE, 0);
      const reactionSizes = tailles(client, MSG.REACTION, 0);
      if (zoneSizes.length > 0) {
        expect(new Set(zoneSizes)).toEqual(new Set([ZONE_BYTES]));
      }
      if (reactionSizes.length > 0) {
        expect(new Set(reactionSizes)).toEqual(new Set([REACTION_BYTES]));
      }
    }
  }, 120_000);
});
