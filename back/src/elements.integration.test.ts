import type { AddressInfo } from 'node:net';
import { CARD } from '@shared/cards';
import {
  STEERING_RECOMPUTE_TICKS,
  SYNERGY_MAX,
  TICK_HZ,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
  ZONE_REFRESH_INTERVAL_TICKS,
} from '@shared/constants';
import { ELEMENT } from '@shared/elements';
import {
  decode,
  encodeHello,
  encodeInput,
  type Message,
  MSG,
  packElementPair,
  type ReactionMessage,
  type SnapshotMessage,
  type ZoneMessage,
  zoneElement,
  zoneReaction,
} from '@shared/protocol';
import { REACTION } from '@shared/reactions';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { WEAPONS, weaponOf } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, prisma } from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

/**
 * **Le livrable du §13 de la spec d'orientation, sur quatre sockets reelles :**
 * *« une reaction inter-joueurs charge la barre, une reaction solo non ; deux
 * zones qui se recouvrent reagissent. »*
 *
 * La tache 8 a fait naitre la regle et l'a mise a l'epreuve la ou elle vit,
 * dans `room.test.ts`, sur un `Room` pilote a la main. Ce fichier-ci prouve
 * qu'elle **survit au fil** : quatre `WebSocket` reelles, un vrai `Session`,
 * un vrai `buildServer`, et rien d'observe qui ne soit passe par un message.
 * La barre se lit dans le `SNAPSHOT`, les reactions dans `REACTION`, les zones
 * dans `ZONE` — jamais dans le salon.
 *
 * ⚠️ **Pourquoi le harnais est celui de `draft.integration.test.ts`.** Il
 * existe deja : `buildServer({ roomSeed })` fige la graine, `app.rooms` decore
 * l'app de son registre pour qu'un test qui n'a que des sockets puisse quand
 * meme poser ses monstres. Le generateur de vagues est lent (premiere vague au
 * tick 180) ET intermittent (taille variable) : quatre tests intermittents ont
 * deja ete produits par cette etape, et un test intermittent est pire qu'un
 * test absent.
 *
 * ⚠️ **Ce que ce fichier POSE lui-meme dans le salon, et pourquoi.** Les
 * monstres (comme `draft.integration.test.ts`), leurs points de vie (increvables :
 * ce sont les charges qui sont comptees, pas la mise a mort), leurs positions
 * (figees : une horde qui derive change la geometrie des zones d'un tick a
 * l'autre) et, dans le premier test seulement, la marque elementaire. Tout le
 * reste — les armes, les tirs, la visee, les zones, les reactions, la barre —
 * passe par le jeu et par le fil.
 */

/** Graine imposee au salon : ce test ne doit rien devoir au hasard. */
const ROOM_SEED = 0x5a10_e1e2;

/** Quatre joueurs : c'est le nombre que le livrable exige. */
const PLAYER_COUNT = 4;

const ARME_BRAISE = WEAPONS.find((w) => w.element === ELEMENT.BRAISE)?.id ?? -1;
const ARME_GIVRE = WEAPONS.find((w) => w.element === ELEMENT.GIVRE)?.id ?? -1;
if (ARME_BRAISE < 0 || ARME_GIVRE < 0) {
  throw new Error('le catalogue doit porter au moins une arme de chaque element');
}

/**
 * Nombre de ticks reactifs attendus du decor apparie du premier test.
 *
 * ⚠️ **Plus d'un, et de loin.** « Toutes sans charge » sur un echantillon de
 * un ne dirait pas grand-chose : c'est le meme raisonnement que la douzaine de
 * reactions du decor de la tache 8.
 */
const TICKS_REACTIFS = 8;

/** Le seul couple d'elements que l'etape 5a connait (§6.1). */
const CHOC_THERMIQUE = packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE);

/**
 * Distance a laquelle les cibles sont posees devant leur joueur.
 *
 * ⚠️ **Doit rester sous la portee de l'arme de Braise**, qui est la plus
 * courte des deux : sinon le joueur tire dans le vide, aucune marque n'est
 * posee, et le test expire sans jamais dire pourquoi.
 */
const DISTANCE_CIBLE = 110;
const PORTEE_BRAISE = porteeDe(ARME_BRAISE);
if (DISTANCE_CIBLE >= PORTEE_BRAISE) {
  throw new Error("la cible doit rester a portee de l'arme de Braise");
}

/** Portee d'une arme, en pixels monde : sa vitesse pendant toute sa duree de vie. */
function porteeDe(weaponId: number): number {
  const w = weaponOf(weaponId);
  return (w.projectileSpeed * w.projectileLifeTicks) / TICK_HZ;
}

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  /** Tout ce qui est arrive sur CETTE socket, hors snapshots. */
  received: Message[];
  /** Dernier `SNAPSHOT` recu : c'est lui, et lui seul, qui porte la barre. */
  lastSnapshot: SnapshotMessage | null;
  /**
   * Un releve par `SNAPSHOT` : la barre qu'il porte, et le nombre de
   * `REACTION` chargees deja arrivees sur CETTE socket.
   *
   * ⚠️ **C'est ce qui rend la comparaison « barre = charges » insensible a
   * l'horloge.** Arreter le pilote n'arrete pas le salon : les projectiles en
   * vol finissent leur course et les zones vivent `ZONE_LIFETIME_TICKS`. Lire
   * la liste des reactions d'un cote et la barre de l'autre comparerait deux
   * instants differents. `Session#broadcast` envoie les `REACTION` d'un tick
   * AVANT le `SNAPSHOT` du meme tick, et la socket preserve l'ordre : chaque
   * releve est donc un couple coherent, pris au meme instant.
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

  let chargees = 0;
  const client: Client = {
    ws,
    playerId: 0,
    received: [],
    lastSnapshot: null,
    jalons: [],
    seq: 0,
  };

  ws.on('message', (data: ArrayBuffer) => {
    const msg = decode(data);
    if (msg.type === MSG.WELCOME) {
      client.playerId = msg.playerId;
      return;
    }
    if (msg.type === MSG.SNAPSHOT) {
      // Les snapshots arrivent a 15 Hz pendant toute la manche : les empiler
      // noierait les quelques messages qu'on interroge. Seul le dernier
      // compte — la barre est un TOTAL, pas un evenement.
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

/**
 * **La barre vaut, a CHAQUE instant, le nombre de reactions chargees deja
 * annoncees — plafonnee, et rien d'autre.**
 *
 * C'est la forme la plus forte de la regle du §7, et c'est aussi la reponse au
 * constat R24 : une barre qui monterait a chaque reaction, sans comparer quoi
 * que ce soit, ferait rougir chaque releve ou une reaction solo est arrivee.
 */
function barreSuitLesCharges(client: Client): void {
  const jalons = client.jalons.filter((j) => j.chargees > 0);
  expect(jalons.length, 'aucun SNAPSHOT n a suivi une charge').toBeGreaterThan(0);
  for (const j of jalons) {
    expect(j.synergy).toBe(Math.min(SYNERGY_MAX, j.chargees));
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

/**
 * Pose une entite increvable a une position choisie, hors du generateur de
 * vagues — meme technique que `spawnMonsterAt` dans `room.test.ts`. Rend son
 * identite.
 */
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
  // Increvable : ce sont les charges qui sont comptees, pas la mise a mort.
  // Une cible qui meurt emporte sa marque et le decor s'eteint en silence.
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

describe('le livrable du §13 sur quatre sockets reelles (etape 5a, tache 10)', () => {
  /**
   * **Le meme decor pour les deux moities, au SEUL detail qui les separe :
   * `markBy`** — et cette fois les deux moities tournent dans le MEME salon, au
   * MEME tick, sur deux cibles qui occupent la MEME position.
   *
   * ⚠️ **C'est le constat R24, traite de front.** « La barre ne bouge pas » se
   * lit aussi bien « aucune reaction n'a eu lieu », et c'est le defaut le plus
   * probable de ce test. La tache 8 l'a ecarte en comparant les deux listes de
   * reactions champ a champ ; ici, les deux reactions naissent du meme tick et
   * du meme point, donc `pair`, `x`, `y` et `tick` sont EGAUX et le seul champ
   * qui differe est `synergyCharge`. Une comparaison entre deux runs d'horloge
   * ne pourrait pas le faire : le tick auquel une socket reelle delivre sa
   * premiere visee n'est pas reproductible.
   *
   * ⚠️ **Deux cibles a la MEME position, et ce n'est pas un artifice.**
   * `Horde#separate` ignore deliberement les voisins a distance nulle (`d2
   * === 0`), donc deux entites du meme archetype posees au meme point avancent
   * a l'identique, tick pour tick — c'est ce qui rend `x` et `y` comparables.
   * Et toute zone qui couvre l'une couvre l'autre, donc elles reagissent
   * toujours ENSEMBLE : un tick ne peut pas produire une charge sans produire
   * sa jumelle sans charge.
   *
   * ⚠️ **La marque est posee a la main, comme a la tache 8, et c'est la seule
   * facon.** Un element de zone ou de projectile couvre les deux cibles a la
   * fois : aucun decor joue ne peut donner a l'une un `markBy` different de
   * l'autre. Ce qui passe par le fil reste tout ce qui compte — l'arme, le
   * tir, la reaction, la barre.
   */
  it('une reaction inter-joueurs charge la barre, la meme reaction en solo ne charge rien', async () => {
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

    // Les positions viennent du fil, pas d'une constante du serveur.
    const snap = await fullSnapshot(a.ws);
    const moi = snap.players.find((p) => p.id === a.playerId);
    if (!moi) {
      throw new Error('le joueur A doit etre dans le snapshot');
    }
    const cibleX = moi.x + DISTANCE_CIBLE;
    const cibleY = moi.y;

    // Le joueur A porte le Givre : c'est lui qui DECLENCHE, des deux cotes.
    room.grantCard(a.playerId, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    // ⚠️ **Deux vagues distantes de `STEERING_RECOMPUTE_TICKS`, et ce n'est
    // PAS cosmetique.** Une entite ne recalcule sa trajectoire qu'un tick sur
    // `STEERING_RECOMPUTE_TICKS`, et **la phase vient de son identite**
    // (`entityId % K`, voir `Horde#recomputeSteering`). Deux identites de
    // phases differentes recalculent a des ticks differents : posees au meme
    // point, elles avancent quand meme differemment, `#applyDeoverlap` les
    // ecarte, et leurs positions cessent d'etre comparables — mesure, 7 px au
    // dixieme tick. `entityIdOf` vaut `waveId * MAX_PER_WAVE + index`, donc
    // deux vagues separees d'un multiple de `K` portent la MEME phase, quel
    // que soit `MAX_PER_WAVE`.
    const duo = poseCible(room, 9100, cibleX, cibleY);
    const solo = poseCible(room, 9100 + STEERING_RECOMPUTE_TICKS, cibleX, cibleY);
    // Le garde qui rend cette dependance bruyante plutot que tacite.
    expect(duo % STEERING_RECOMPUTE_TICKS).toBe(solo % STEERING_RECOMPUTE_TICKS);

    const pilote = setInterval(() => {
      const slotDuo = room.horde.slotOf(duo);
      const slotSolo = room.horde.slotOf(solo);
      if (slotDuo < 0 || slotSolo < 0) {
        return;
      }
      // Les deux cibles restent sur leur marque : sans ca elles rejoignent le
      // joueur, le touchent, et la run se termine avant la fin du test.
      for (const slot of [slotDuo, slotSolo]) {
        room.horde.x[slot] = cibleX;
        room.horde.y[slot] = cibleY;
        room.horde.vx[slot] = 0;
        room.horde.vy[slot] = 0;
      }
      // ⚠️ **LE SEUL parametre qui separe les deux moities.** La marque se
      // consomme a chaque reaction (§4.3) : la reposer en continu est ce qui
      // rend la reaction repetable, donc la barre comptable.
      room.horde.applyMark(slotDuo, ELEMENT.BRAISE, b.playerId, room.tick);
      room.horde.applyMark(slotSolo, ELEMENT.BRAISE, a.playerId, room.tick);
      vise(a, DISTANCE_CIBLE, 0);
    }, 8);

    try {
      await waitFor(
        () => (reactionsDe(a).length >= 2 * TICKS_REACTIFS ? true : null),
        `${2 * TICKS_REACTIFS} REACTION sur la socket du joueur A`,
        20_000,
      );
    } finally {
      clearInterval(pilote);
    }

    const recues = reactionsDe(a);
    // Les quatre sockets recoivent le meme flot, mais pas au meme
    // millieme : on attend qu'elles aient toutes rattrape avant de les
    // comparer, plutot que de croiser deux instants differents.
    await waitFor(
      () => (clients.every((c) => reactionsDe(c).length >= recues.length) ? true : null),
      'les quatre sockets a jour',
      5000,
    );

    // ---- 1. Une reaction A EU LIEU, et elle est du bon couple -------------
    //
    // ⚠️ **L'assertion centrale, et le defaut n°1 de ce test si elle
    // manque** : on COMPTE les reactions, on ne les suppose pas.
    expect(recues.length, "aucune reaction n'est arrivee sur la socket").toBeGreaterThanOrEqual(
      2 * TICKS_REACTIFS,
    );
    for (const r of recues) {
      expect(r.pair).toBe(CHOC_THERMIQUE);
      expect(Math.hypot(r.x - cibleX, r.y - cibleY)).toBeLessThan(ZONE_RADIUS);
    }

    // ---- 2. Les deux moities, champ a champ ------------------------------
    //
    // Sans ce groupement, « aucune charge » se lirait aussi bien « aucune
    // reaction en solo ».
    // ⚠️ **Par PAIRES de ticks voisins, plus par tick, depuis la recharge par
    // ennemi** (`REACTION_COOLDOWN_TICKS`). Le tick d'amorcage ne porte
    // qu'une reaction : un projectile ne touche qu'une cible a la fois
    // (`collide` departage a l'identite la plus petite, donc le duo). Le champ
    // qu'elle laisse fait reagir la jumelle AU TICK SUIVANT — et la recharge,
    // la meme pour les deux, garde ce decalage d'un tick pour toute la suite.
    // Les reactions arrivent donc par paires (t, t + 1) : meme point, meme
    // couple, seul le bit (et le tick) differe.
    const triees = [...recues].sort((x, y) => x.tick - y.tick);
    const paires: [ReactionMessage, ReactionMessage][] = [];
    for (let k = 0; k + 1 < triees.length; k += 2) {
      const [r1, r2] = [triees[k], triees[k + 1]];
      if (r1 && r2) {
        paires.push([r1, r2]);
      }
    }
    expect(paires.length, 'le decor n a pas produit assez de paires').toBeGreaterThanOrEqual(
      TICKS_REACTIFS - 2,
    );

    for (const [r1, r2] of paires) {
      expect(
        r2.tick - r1.tick,
        `la paire du tick ${r1.tick} n est pas voisine`,
      ).toBeLessThanOrEqual(1);
      const [avecCharge, sansCharge] = r1.synergyCharge ? [r1, r2] : [r2, r1];
      // ⚠️ **Champ a champ** : tout est egal sauf le bit. C'est ce qui
      // interdit de lire « la barre ne bouge pas » comme « rien n'a reagi ».
      expect(avecCharge.synergyCharge).toBe(true);
      expect(sansCharge.synergyCharge).toBe(false);
      // Un tick d'ecart : la position, reepinglee entre deux ticks, peut avoir
      // glisse d'un pas de deplacement — pas davantage.
      expect(sansCharge.pair).toBe(avecCharge.pair);
      expect(Math.hypot(sansCharge.x - avecCharge.x, sansCharge.y - avecCharge.y)).toBeLessThan(8);
    }

    // ---- 3. La barre, lue dans le SNAPSHOT et nulle part ailleurs ---------
    barreSuitLesCharges(a);
    expect(a.lastSnapshot?.synergy).toBeGreaterThan(0);

    // ---- 4. Les quatre sockets voient la meme chose -----------------------
    //
    // La diffusion est un `#send` a tous les clients ouverts : un joueur qui
    // ne tire pas doit voir les reactions des autres, sinon la barre monterait
    // pour une equipe dont trois membres n'ont rien vu.
    for (const other of clients) {
      const siennes = reactionsDe(other);
      expect(siennes.slice(0, recues.length)).toEqual(recues);
      expect(other.lastSnapshot?.synergy).toBe(a.lastSnapshot?.synergy);
    }
  }, 60_000);

  /**
   * **La meme regle, sans qu'aucune marque ne soit posee a la main** : deux
   * joueurs marquent et declenchent chacun leur tour d'un cote de la carte,
   * un troisieme fait les deux tout seul de l'autre cote, et le quatrieme
   * regarde.
   *
   * ⚠️ **C'est ici que « en solo la barre ne monte jamais » devient une
   * propriete DU MODELE et pas une convention du harnais** : le joueur seul
   * ne peut ecrire que sa propre identite des deux cotes de la comparaison, et
   * aucune ligne de code n'a a le verifier.
   *
   * ⚠️ **Et la borne anti-R24 est ici arithmetique** : la barre doit valoir
   * EXACTEMENT le nombre de reactions chargees, alors que le cote solo en a
   * produit plusieurs. « La barre ne bouge pas pour le solo » ne peut donc pas
   * se lire « le solo n'a rien produit ».
   */
  it('deux joueurs marquent et declenchent, un troisieme fait les deux seul : seul le duo charge', async () => {
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

    const snap = await fullSnapshot(a.ws);
    const pos = new Map(snap.players.map((p) => [p.id, { x: p.x, y: p.y }]));
    const pa = pos.get(a.playerId);
    const pb = pos.get(b.playerId);
    const pc = pos.get(c.playerId);
    if (!pa || !pb || !pc) {
      throw new Error('les trois joueurs actifs doivent etre dans le snapshot');
    }

    // Le duo : A marque a la Braise, B declenche au Givre, sur la cible du duo.
    room.grantCard(a.playerId, { nature: CARD.WEAPON, refId: ARME_BRAISE });
    room.grantCard(b.playerId, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    // Le solo : C porte les deux armes et se debrouille tout seul.
    room.grantCard(c.playerId, { nature: CARD.WEAPON, refId: ARME_BRAISE });
    room.grantCard(c.playerId, { nature: CARD.WEAPON, refId: ARME_GIVRE });

    // La cible du duo, a portee de Braise des DEUX : au milieu de A et B.
    const duo = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    // Celle du solo, devant C, et assez loin de l'autre pour qu'aucune zone ni
    // aucun rayon de reaction ne franchisse l'ecart.
    const seul = { x: pc.x - DISTANCE_CIBLE, y: pc.y };
    const ecart = Math.hypot(duo.x - seul.x, duo.y - seul.y);
    expect(ecart, 'les deux moities du decor doivent etre etanches').toBeGreaterThan(
      4 * ZONE_RADIUS,
    );
    expect(Math.hypot(duo.x - pa.x, duo.y - pa.y)).toBeLessThan(PORTEE_BRAISE);
    expect(Math.hypot(duo.x - pb.x, duo.y - pb.y)).toBeLessThan(PORTEE_BRAISE);

    const cibleDuo = poseCible(room, 9200, duo.x, duo.y);
    const cibleSeul = poseCible(room, 9201, seul.x, seul.y);

    const pilote = setInterval(() => {
      for (const [id, point] of [
        [cibleDuo, duo],
        [cibleSeul, seul],
      ] as const) {
        const slot = room.horde.slotOf(id);
        if (slot < 0) {
          continue;
        }
        room.horde.x[slot] = point.x;
        room.horde.y[slot] = point.y;
        room.horde.vx[slot] = 0;
        room.horde.vy[slot] = 0;
      }
      vise(a, duo.x - pa.x, duo.y - pa.y);
      vise(b, duo.x - pb.x, duo.y - pb.y);
      vise(c, seul.x - pc.x, seul.y - pc.y);
      // D ne vise jamais : sans `aimX`/`aimY`, aucune arme ne tire.
    }, 8);

    const prochesDe = (point: { x: number; y: number }) => (r: ReactionMessage) =>
      Math.hypot(r.x - point.x, r.y - point.y) < 2 * ZONE_RADIUS;

    try {
      await waitFor(
        () => {
          const r = reactionsDe(a);
          return r.filter(prochesDe(duo)).length >= 3 && r.filter(prochesDe(seul)).length >= 3
            ? true
            : null;
        },
        'trois reactions de chaque cote',
        30_000,
      );
    } finally {
      clearInterval(pilote);
    }

    const recues = reactionsDe(a);
    const cotDuo = recues.filter(prochesDe(duo));
    const cotSeul = recues.filter(prochesDe(seul));

    // Le decor a bien produit les DEUX cas : on les compte, on ne les suppose
    // pas. Et toutes les reactions recues appartiennent a l'une des moities.
    expect(cotDuo.length).toBeGreaterThanOrEqual(3);
    expect(cotSeul.length).toBeGreaterThanOrEqual(3);
    expect(cotDuo.length + cotSeul.length).toBe(recues.length);

    expect(cotDuo.every((r) => r.pair === CHOC_THERMIQUE)).toBe(true);
    expect(cotSeul.every((r) => r.pair === CHOC_THERMIQUE)).toBe(true);
    expect(cotDuo.every((r) => r.synergyCharge)).toBe(true);
    expect(cotSeul.every((r) => r.synergyCharge === false)).toBe(true);

    // ⚠️ **La barre vaut EXACTEMENT le nombre de reactions chargees, a chaque
    // releve**, alors que le cote solo en a produit autant : c'est ce qui
    // interdit de lire « le solo ne charge rien » comme « le solo n'a rien
    // produit ».
    barreSuitLesCharges(a);
    expect(a.lastSnapshot?.synergy).toBeGreaterThan(0);
  }, 60_000);

  /**
   * **« Deux zones qui se recouvrent reagissent »** — la seconde voie du §6.3
   * de l'orientation, et le troisieme declencheur du §6.2.
   *
   * ⚠️ **Le decor « aucun ennemi » de la tache 10 n'existe plus, et il ne peut
   * plus exister.** Il tenait sur le fait que deux projectiles posaient deux
   * disques la ou ils finissaient leur course, sans rien toucher : c'etait
   * l'unique moyen de faire naitre deux zones dans un salon vide, et donc
   * d'isoler ce chemin des deux autres. Depuis la tache 21, **une zone ne nait
   * que d'une reaction**, et une reaction ne nait que sur un ennemi ou entre
   * deux zones — donc, a la racine, d'un ennemi. Un salon vide ne peut plus
   * porter une seule zone.
   *
   * ⚠️ **Le discriminant devient le COMPTE, pas le decor.** Le §6.2 borne les
   * reactions a **une par ennemi et par tick**. Avec UN SEUL ennemi dans le
   * salon, un tick qui porte DEUX `REACTION` ne peut donc pas les tenir toutes
   * les deux du chemin « ennemi marque + second element » : la seconde vient
   * du recouvrement de deux champs. C'est une preuve par la borne, et elle est
   * plus solide que la precedente — elle ne suppose rien de la geometrie.
   *
   * Le decor : un seul ennemi, un seul joueur portant LES DEUX armes
   * elementaires. Il marque, il declenche, chaque reaction laisse un champ ; et
   * comme l'ennemi avance, les champs successifs sont assez espaces pour etre
   * CREES plutot que rafraichis — c'est la creation, et elle seule, qui fait
   * reagir un couple de disques.
   */
  it('deux champs d elements differents qui se recouvrent declenchent une reaction de plus', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('le registre de salons doit etre accessible depuis l app');
    }

    const clients = await quatreClients(code);
    const [a] = clients;
    if (!a) {
      throw new Error('quatre clients attendus');
    }
    expect(room.horde.count).toBe(0);

    const snap = await fullSnapshot(a.ws);
    const pa = snap.players.find((p) => p.id === a.playerId);
    if (!pa) {
      throw new Error('le tireur doit etre dans le snapshot');
    }

    // Les DEUX elements sur le meme joueur : il marque et il declenche seul,
    // donc chaque reaction a lieu sur la seule cible du salon.
    room.grantCard(a.playerId, { nature: CARD.WEAPON, refId: ARME_BRAISE });
    room.grantCard(a.playerId, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    const cible = poseCible(room, 9200, pa.x + DISTANCE_CIBLE, pa.y);

    // ⚠️ **La cible n'est PAS figee, contrairement aux autres decors de ce
    // fichier.** Une cible immobile verrait tous ses champs se rafraichir au
    // meme point, et un rafraichissement ne declenche rien (§6.2) : le couple
    // ne reagirait qu'une seule fois de toute la run. Qu'elle avance est ce qui
    // fait naitre des champs NEUFS, donc des couples neufs.
    let hordeMax = 0;
    const pilote = setInterval(() => {
      hordeMax = Math.max(hordeMax, room.horde.count);
      const slot = room.horde.slotOf(cible);
      if (slot < 0) {
        return;
      }
      vise(a, (room.horde.x[slot] ?? 0) - pa.x, (room.horde.y[slot] ?? 0) - pa.y);
      // ⚠️ **L'alternance des elements, tenue a la main depuis la recharge par
      // ennemi** (`REACTION_COOLDOWN_TICKS`). Un ennemi ne reagit plus qu'une
      // fois par recharge, et au rythme fixe des deux armes c'est toujours le
      // MEME element qui declenche : les champs successifs portent le meme
      // element, se rafraichissent, et aucun couple de disques ne nait plus.
      // Reposer, apres chaque reaction, la marque de l'element qui vient de
      // declencher fait declencher l'AUTRE a la suivante — donc un champ de
      // l'autre element, qui recoupe le precedent.
      const element = reactionsDe(a).length % 2 === 0 ? ELEMENT.BRAISE : ELEMENT.GIVRE;
      room.horde.applyMark(slot, element, a.playerId, room.tick);
    }, 8);

    /** Le tick qui porte DEUX reactions — impossible avec un seul ennemi. */
    const tireur = a;
    const tickDouble = (): number | null => {
      const parTick = new Map<number, number>();
      for (const r of reactionsDe(tireur)) {
        parTick.set(r.tick, (parTick.get(r.tick) ?? 0) + 1);
      }
      for (const [tick, n] of parTick) {
        if (n >= 2) {
          return tick;
        }
      }
      return null;
    };

    let doubleTick: number | null = null;
    try {
      doubleTick = await waitFor(
        () => tickDouble(),
        'un tick portant DEUX reactions, donc un recouvrement de champs',
        30_000,
      );
    } finally {
      clearInterval(pilote);
    }

    // ⚠️ **Le decor n'isole que si l'ennemi reste SEUL.** Le generateur fait
    // naitre sa premiere vague au tick 180 ; on le surveille plutot que de le
    // supposer, parce que deux ennemis rendraient le compte muet.
    expect(hordeMax, 'une vague est apparue : la borne par ennemi ne discrimine plus').toBe(1);

    const recues = reactionsDe(a);
    expect(recues.length).toBeGreaterThan(0);
    for (const r of recues) {
      expect(r.pair).toBe(CHOC_THERMIQUE);
    }
    // Et les DEUX elements sont bien passes par le sol : sans ca, « deux
    // reactions au meme tick » ne dirait pas d'ou vient la seconde.
    const zones = zonesDe(a);
    expect(zones.filter((z) => z.kind === ELEMENT.BRAISE).length).toBeGreaterThan(0);
    expect(zones.filter((z) => z.kind === ELEMENT.GIVRE).length).toBeGreaterThan(0);
    const braises = zones.filter((z) => z.kind === ELEMENT.BRAISE);
    const givres = zones.filter((z) => z.kind === ELEMENT.GIVRE);
    expect(
      braises.some((zb) =>
        givres.some((zg) => Math.hypot(zb.x - zg.x, zb.y - zg.y) < 2 * ZONE_RADIUS),
      ),
      'aucune paire de champs ne se recouvre : le decor ne prouve rien',
    ).toBe(true);
    expect(doubleTick).not.toBeNull();
  }, 60_000);

  /**
   * **Etape 3 bis : le trafic des rafraichissements, mesure sur le fil.**
   *
   * Une zone entretenue sans relache pendant plusieurs vies de zone doit etre
   * re-annoncee au rythme du TEMPS, jamais a celui de l'arme. La regle vit
   * dans `ZoneField.spawn` et ses tests unitaires ; ce qui se verifie ICI,
   * c'est que le compte qui arrive sur une socket reelle est bien celui-la.
   */
  it('une zone entretenue sans relache n arrive au client qu une fois par demi-vie', async () => {
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

    const snap = await fullSnapshot(a.ws);
    const pa = snap.players.find((p) => p.id === a.playerId);
    if (!pa) {
      throw new Error('le tireur doit etre dans le snapshot');
    }
    const cibleX = pa.x + DISTANCE_CIBLE;
    const cibleY = pa.y;

    room.grantCard(a.playerId, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    const cible = poseCible(room, 9300, cibleX, cibleY);

    const debut = room.tick;
    const pilote = setInterval(() => {
      const slot = room.horde.slotOf(cible);
      if (slot >= 0) {
        room.horde.x[slot] = cibleX;
        room.horde.y[slot] = cibleY;
        room.horde.vx[slot] = 0;
        room.horde.vy[slot] = 0;
        // ⚠️ **Depuis la tache 21, c'est la REACTION qui entretient le champ,
        // plus la volee.** Le joueur B remet une marque de Braise en continu,
        // le Givre du joueur A la declenche : chaque reaction rearrose le meme
        // point, et le point est fige, donc c'est bien un RAFRAICHISSEMENT que
        // ce test compte.
        room.horde.applyMark(slot, ELEMENT.BRAISE, b.playerId, room.tick);
      }
      vise(a, DISTANCE_CIBLE, 0);
    }, 8);

    // Plusieurs vies de zone : sans ca, « peu d'annonces » se lirait « la zone
    // n'a pas eu le temps d'etre rafraichie ».
    const duree = ZONE_LIFETIME_TICKS * 3;
    try {
      await waitFor(() => (room.tick - debut >= duree ? true : null), 'trois vies de zone', 30_000);
    } finally {
      clearInterval(pilote);
    }
    const ecoules = room.tick - debut;

    const zones = zonesDe(a);
    // Les annonces, regroupees par point et rangees dans l'ordre du temps :
    // c'est l'ECART entre deux annonces d'un meme point qui dit tout.
    const parPoint = new Map<string, number[]>();
    for (const z of zones) {
      const cle = `${z.x},${z.y}`;
      const suite = parPoint.get(cle) ?? [];
      suite.push(z.bornTick);
      parPoint.set(cle, suite);
    }
    expect(parPoint.size, 'aucune zone annoncee sur la socket').toBeGreaterThan(0);

    // ⚠️ **« Plusieurs annonces au meme point » ne prouve RIEN — mutation
    // appliquee, elle survivait.** Une zone qui ne serait jamais prolongee
    // MOURRAIT au bout de `ZONE_LIFETIME_TICKS` et renaitrait au meme pixel au
    // tir suivant : deux annonces au meme point, exactement comme un
    // rafraichissement. Ce qui les separe, c'est l'ECART : une prolongation
    // arrive STRICTEMENT AVANT la peremption, une renaissance jamais.
    const ecarts: number[] = [];
    for (const suite of parPoint.values()) {
      for (let i = 1; i < suite.length; i++) {
        ecarts.push((suite[i] ?? 0) - (suite[i - 1] ?? 0));
      }
    }
    expect(
      ecarts.some((e) => e < ZONE_LIFETIME_TICKS),
      'aucune zone n a ete PROLONGEE : elles sont seulement mortes et renees',
    ).toBe(true);

    // ⚠️ **Et la borne : jamais deux annonces plus serrees que l'intervalle.**
    // Le decor pose bien plus souvent que lui — l'arme tire deja plus vite, et
    // depuis la tache 21 le champ redeclenche a CHAQUE tick une fois pose —
    // donc sans la parade le trafic suivrait la cadence des poses au lieu du
    // temps.
    expect(weaponOf(ARME_GIVRE).cooldownTicks).toBeLessThan(ZONE_REFRESH_INTERVAL_TICKS);
    for (const e of ecarts) {
      expect(e, `deux annonces du meme point a ${e} ticks d ecart`).toBeGreaterThanOrEqual(
        ZONE_REFRESH_INTERVAL_TICKS,
      );
    }
    const volees = Math.floor(ecoules / weaponOf(ARME_GIVRE).cooldownTicks);
    expect(zones.length).toBeLessThan(volees);
  }, 60_000);
});

/**
 * ⚠️ **Ferme une mutation HERITEE de la tache 5** (etape 5b, tache 6) :
 * `Session#broadcast` (back/src/server.ts:213) decodait `zone.kind` avant de
 * l'encoder sur le fil — indetectable tant qu'aucune reaction ne posait de
 * type non nul, puisque `zoneElement(kind) === kind` pour toute zone de
 * reaction nulle (voir le rapport de la tache 5). Surchauffe (Braise + Foudre,
 * tache 6) est la premiere reaction reelle du jeu a empaqueter un nibble non
 * nul : ce test traverse le fil ENTIER — `Room#announceZones`,
 * `Session#broadcast`, `encodeZone`, la socket, `decodeZone` — et doit rougir
 * si l'un de ces sites redecode l'octet par erreur.
 *
 * ⚠️ **Aucune arme de Foudre n'existe encore au catalogue** (tache 9) : ce
 * decor s'en passe, exactement comme le test-jumeau de `room.test.ts`. Le
 * joueur A tire l'arme de Braise REELLE ; la cible est reposee marquee Foudre
 * a la main, cote salon — c'est le seul geste de ce fichier qui touche
 * directement `room.horde`, tout le reste passe par le jeu et par le fil.
 */
describe('Surchauffe empaquette son nibble de reaction sur le fil (etape 5b, tache 6)', () => {
  it('⚠️ le client recoit une ZONE dont le nibble de reaction survit au trajet complet', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('le registre de salons doit etre accessible depuis l app');
    }

    const clients = await quatreClients(code);
    const [a] = clients;
    if (!a) {
      throw new Error('quatre clients attendus');
    }

    const snap = await fullSnapshot(a.ws);
    const pa = snap.players.find((p) => p.id === a.playerId);
    if (!pa) {
      throw new Error('le tireur doit etre dans le snapshot');
    }
    const cibleX = pa.x + DISTANCE_CIBLE;
    const cibleY = pa.y;

    room.grantCard(a.playerId, { nature: CARD.WEAPON, refId: ARME_BRAISE });
    const cible = poseCible(room, 9400, cibleX, cibleY);

    const pilote = setInterval(() => {
      const slot = room.horde.slotOf(cible);
      if (slot >= 0) {
        room.horde.x[slot] = cibleX;
        room.horde.y[slot] = cibleY;
        room.horde.vx[slot] = 0;
        room.horde.vy[slot] = 0;
        // Le seul geste manuel : la cible reste marquee Foudre, le tir REEL de
        // Braise du joueur A declenche donc Surchauffe (canonique Braise+Foudre).
        room.horde.applyMark(slot, ELEMENT.FOUDRE, a.playerId, room.tick);
      }
      vise(a, DISTANCE_CIBLE, 0);
    }, 8);

    try {
      await waitFor(
        () => (zonesDe(a).some((z) => zoneReaction(z.kind) === REACTION.SURCHAUFFE) ? true : null),
        'une ZONE de Surchauffe sur la socket du joueur A',
        20_000,
      );
    } finally {
      clearInterval(pilote);
    }

    const surchauffe = zonesDe(a).find((z) => zoneReaction(z.kind) === REACTION.SURCHAUFFE);
    expect(surchauffe, 'aucune zone de Surchauffe n est arrivee sur le fil').toBeDefined();
    // ⚠️ **La ligne qui tue les deux mutations heritees.** Un decodage avant
    // l'envoi, a l'un ou l'autre des deux sites, rendrait `kind` egal a son
    // seul element : cette comparaison ne peut rester vraie que si l'octet
    // COMPLET a fait tout le trajet.
    expect(surchauffe?.kind).not.toBe(zoneElement(surchauffe?.kind ?? 0));
  }, 30_000);
});
