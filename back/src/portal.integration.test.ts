import type { AddressInfo } from 'node:net';
import {
  EXTRACT_MULTIPLIER_STEP,
  PORTAL_WINDOW_TICKS,
  TICK_HZ,
  WIPE_GOLD_KEPT,
} from '@shared/constants';
import {
  type DeathsMessage,
  decode,
  encodeInput,
  encodeVote,
  type Message,
  MSG,
  NO_VOTE,
  type PortalOpenMessage,
  type PortalResultMessage,
  type SnapshotMessage,
  VOTE_CHOICE,
  type VotesMessage,
} from '@shared/protocol';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { BASE_WEAPON_ID, weaponOf } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { Room } from './room';
import { buildServer } from './server';

/**
 * **Le livrable du §13 de la spec d'orientation, sur quatre sockets reelles :**
 * *« une run infinie avec un vote qui engage reellement l'or. »*
 *
 * Un palier se termine — le boss meurt —, le portail s'ouvre, les votes se
 * voient, la majorite tranche, l'egalite continue, et **l'or bouge dans les
 * DEUX sens** : acquis en partant, majore du multiplicateur ; efface quand
 * l'equipe l'est. Le monde, lui, ne s'arrete pas pendant qu'on negocie.
 *
 * ⚠️ **Ce que ce fichier apporte, et que ni `room.test.ts` ni `server.test.ts`
 * ne pouvaient porter.** La regle vit dans `portal.ts` et `Room#stepPortal`, et
 * elle y est eprouvee a la main ; la ligne de diffusion est gardee par
 * `server.test.ts`, sur **une** socket. Une seule socket ne peut pas produire
 * ce qui fait le vote :
 *
 * | | une socket | quatre sockets |
 * | --- | --- | --- |
 * | le verdict | toujours unanime | une **majorite**, et une **egalite** |
 * | un vote revoque | ne change aucun verdict | fait **basculer** l'egalite |
 * | `VOTES` | se relit soi-meme | chacun voit **les autres** |
 * | l'or acquis | au PREMIER portail, ou le multiplicateur vaut 1 | au SECOND, donc **majore** |
 * | l'or efface | jamais mesure sur le fil | mesure ici |
 *
 * ⚠️ **Le salon est avance DEPUIS LE TEST, en plus de la boucle du serveur**,
 * comme aux taches 5 bis et 9 de `server.test.ts` : atteindre un boss demande
 * quatre vagues, soit trente secondes d'horloge murale, et ce test en enchaine
 * DEUX. `Room.step` est public et le tick n'est qu'un compteur. **Les phases
 * qui se mesurent — le vote, le monde qui tourne — ne sont JAMAIS accelerees**,
 * elles tournent a la vitesse du serveur, sinon les sockets n'auraient pas le
 * temps de dire ce qu'on leur demande.
 *
 * ⚠️ **Les trois chiffres de replication ne sont PAS mesures ici, et ce n'est
 * pas un oubli.** Ils vivent dans `shared/horde.replication.test.ts` — scenario
 * 9 pour « morts + separation avec rejeu », le scenario de rattrapage pour
 * « apparition tardive », le scenario C1 pour « tick serveur recale en
 * continu » — et cette suite tourne dans la meme commande que ce fichier. Les y
 * recopier ici serait une **seconde mesure**, et elle serait FAUSSE : le decor
 * ci-dessous balaie la horde avec `Horde.kill`, qui court-circuite
 * volontairement le lot `DEATHS` du salon (voir `viderSauf`). Un client qui
 * derive sa horde de ce qui passe sur le fil divergerait donc **par
 * construction**, et le chiffre qu'on lirait ne dirait rien du portail.
 */

/** Graine imposee au salon : ce test ne doit rien devoir au hasard. */
const ROOM_SEED = 0x6a11_0007;

/** Quatre joueurs : c'est le nombre que le livrable exige. */
const PLAYER_COUNT = 4;

const DT = 1 / TICK_HZ;

/**
 * Distance a laquelle le boss est tenu devant son tueur.
 *
 * ⚠️ **Doit rester sous la portee de la dague**, la seule arme que les joueurs
 * portent ici : au-dela, le tireur tire dans le vide, le boss ne meurt jamais,
 * et le test expire sans dire pourquoi. Le garde rend la dependance bruyante.
 */
const DISTANCE_BOSS = 100;
const DAGUE = weaponOf(BASE_WEAPON_ID);
const PORTEE_DAGUE = (DAGUE.projectileSpeed * DAGUE.projectileLifeTicks) / TICK_HZ;
if (DISTANCE_BOSS >= PORTEE_DAGUE) {
  throw new Error('le boss doit etre tenu a portee de la dague');
}

/**
 * Distance a laquelle le temoin de « le monde tourne » est pose DERRIERE les
 * joueurs, qui marchent, eux, vers la gauche.
 *
 * ⚠️ **Derriere, et pas devant** : un temoin place sur le chemin finirait au
 * contact, blesserait les votants, et le decor mesurerait une melee au lieu
 * d'un deplacement. Il reste loin : a 95 px/s contre 260, il ne rattrape
 * personne.
 */
const DISTANCE_TEMOIN = 900;

/** Duree de la mesure « le monde tourne », en ticks de jeu. */
const TICKS_MESURE = 45;

/**
 * Seuils de la mesure, en pixels monde. Le joueur va a `PLAYER_SPEED` (260
 * px/s), la pietaille a ~100 px/s : sur `TICKS_MESURE` (1,5 s) ils parcourent
 * ~390 px et ~150 px. Les seuils sont pris bien en dessous — ce qui est teste
 * est un mouvement, pas une vitesse.
 */
const SEUIL_JOUEUR_PX = 100;
const SEUIL_HORDE_PX = 30;

/** Ticks avances d'affilee avant de rendre la main a la boucle du serveur. */
const TICKS_PAR_RESPIRATION = 60;
/** Ce que dure cette respiration : assez pour qu'une diffusion (30 Hz) passe. */
const RESPIRATION_MS = 20;

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  /** Tout ce qui est arrive sur CETTE socket, hors snapshots. */
  received: Message[];
  /** Dernier `SNAPSHOT` recu : il porte les positions, les pv et l'or. */
  lastSnapshot: SnapshotMessage | null;
  /**
   * L'or tel que le FIL l'a dit, tick par tick.
   *
   * ⚠️ **C'est lui qui date l'or d'AVANT le verdict.** Lire `room.gold` apres
   * coup comparerait deux instants differents — et surtout l'or a deja ete
   * majore a ce moment-la. Le verdict porte `effectTick` : c'est le dernier
   * jalon d'avant ce tick qui dit ce que l'equipe risquait.
   */
  jalonsOr: { tick: number; gold: number }[];
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
    jalonsOr: [],
    seq: 0,
  };

  ws.on('message', (data: ArrayBuffer) => {
    const msg = decode(data);
    if (msg.type === MSG.WELCOME) {
      client.playerId = msg.playerId;
      return;
    }
    if (msg.type === MSG.SNAPSHOT) {
      client.lastSnapshot = msg;
      client.jalonsOr.push({ tick: msg.tick, gold: msg.gold });
      return;
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

/** Rend la main a la boucle du serveur : sans elle, rien n'est jamais diffuse. */
function respirer(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
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

/** Le premier snapshot ou les quatre joueurs sont la. */
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
 * Retire de la horde tout sauf les identites `garder` — copie conforme du
 * `viderSauf` de `room.test.ts`, et pour la meme raison : ces tests mesurent le
 * PORTAIL, pas la survie de quatre joueurs immobiles sous des vagues qui
 * tombent toutes les six secondes. Sans ce balayage, ils finiraient en
 * `RUN_OVER` avant qu'un seul boss ne tombe.
 *
 * ⚠️ **`Horde.kill` court-circuite volontairement le salon** : ces morts-la ne
 * comptent pas, ne laissent pas d'orbe — donc pas d'or, pas d'experience, pas
 * d'etalage qui gelerait le monde au milieu d'un vote — et **ne partent pas
 * dans `DEATHS`**. C'est aussi ce qui interdit a ce fichier de mesurer une
 * derive de replication (voir l'en-tete).
 */
function viderSauf(room: Room, garder: readonly (number | null)[]): void {
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
  room.horde.hp[slot] = 1e6;
  return room.horde.entityIdAt(slot);
}

/** Epingle une entite a un point, immobile et increvable. */
function epingler(room: Room, id: number, x: number, y: number): void {
  const slot = room.horde.slotOf(id);
  if (slot < 0) {
    return;
  }
  room.horde.x[slot] = x;
  room.horde.y[slot] = y;
  room.horde.vx[slot] = 0;
  room.horde.vy[slot] = 0;
  room.horde.hp[slot] = 1e6;
}

/**
 * Avance le salon **depuis le test** jusqu'a ce que `pret` soit vrai, en
 * executant `parTick` avant chaque pas et en rendant la main regulierement a la
 * boucle du serveur — sans quoi aucune diffusion n'aurait lieu et les sondes
 * qui lisent le fil ne verraient jamais rien.
 */
async function avancerJusqua(
  room: Room,
  pret: () => boolean,
  quoi: string,
  maxTicks: number,
  parTick: () => void,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (pret()) {
      return;
    }
    parTick();
    room.step(DT);
    if (i % TICKS_PAR_RESPIRATION === TICKS_PAR_RESPIRATION - 1) {
      await respirer(RESPIRATION_MS);
    }
  }
  await respirer(RESPIRATION_MS);
  if (!pret()) {
    throw new Error(`${quoi} : rien en ${maxTicks} ticks`);
  }
}

/** Un pilote qui tourne a l'horloge REELLE, pendant que le serveur simule. */
function piloter(tache: () => void): () => void {
  const timer = setInterval(tache, 8);
  return () => {
    clearInterval(timer);
  };
}

/** Envoie une trame d'entree sur la socket : deplacement et visee. */
function envoyer(client: Client, moveX: number, moveY: number, aimX: number, aimY: number): void {
  client.seq++;
  client.ws.send(encodeInput(client.seq, moveX, moveY, aimX, aimY));
}

/** Le snapshot suivant celui qu'on a deja, pour ne pas lire un instant perime. */
async function snapshotFrais(client: Client): Promise<SnapshotMessage> {
  const avant = client.lastSnapshot?.tick ?? -1;
  return waitFor(
    () => {
      const s = client.lastSnapshot;
      return s && s.tick > avant ? s : null;
    },
    'un SNAPSHOT frais',
    5000,
  );
}

function positionDuFil(client: Client, id = client.playerId): { x: number; y: number } {
  const moi = client.lastSnapshot?.players.find((p) => p.id === id);
  if (!moi) {
    throw new Error(`le joueur ${id} est absent du dernier snapshot`);
  }
  return { x: moi.x, y: moi.y };
}

function hpDuFil(client: Client, id = client.playerId): number {
  const moi = client.lastSnapshot?.players.find((p) => p.id === id);
  if (!moi) {
    throw new Error(`le joueur ${id} est absent du dernier snapshot`);
  }
  return moi.hp;
}

/**
 * Coupe le deplacement et la visee d'un joueur, et rend sa position une fois
 * qu'elle a cesse de bouger.
 *
 * ⚠️ **Deux snapshots identiques, pas un seul.** Le snapshot ne porte pas
 * l'intention de deplacement, seulement son effet : la seule facon de savoir
 * que la trame « je m'arrete » a traverse le fil est de voir la position se
 * figer. Sans cette attente, le boss serait epingle par rapport a une position
 * perimee et sortirait de la portee de la dague.
 */
async function immobiliser(client: Client): Promise<{ x: number; y: number }> {
  envoyer(client, 0, 0, 0, 0);
  for (let i = 0; i < 100; i++) {
    await snapshotFrais(client);
    const a = positionDuFil(client);
    await snapshotFrais(client);
    const b = positionDuFil(client);
    if (a.x === b.x && a.y === b.y) {
      return b;
    }
  }
  throw new Error('le joueur ne s arrete pas');
}

function ouverturesDe(client: Client): PortalOpenMessage[] {
  return client.received.filter((m): m is PortalOpenMessage => m.type === MSG.PORTAL_OPEN);
}

function verdictsDe(client: Client): PortalResultMessage[] {
  return client.received.filter((m): m is PortalResultMessage => m.type === MSG.PORTAL_RESULT);
}

function votesDe(client: Client): VotesMessage[] {
  return client.received.filter((m): m is VotesMessage => m.type === MSG.VOTES);
}

function mortsDe(client: Client): DeathsMessage[] {
  return client.received.filter((m): m is DeathsMessage => m.type === MSG.DEATHS);
}

function finDeRun(client: Client): Message | undefined {
  return client.received.find((m) => m.type === MSG.RUN_OVER);
}

/**
 * Attend que **les quatre** sockets aient recu une table de votes exactement
 * egale a `attendu`.
 *
 * ⚠️ **C'est l'assertion « les votes se voient », et elle porte sur LES
 * AUTRES.** Le §6 : *« on ne negocie pas un choix qu'on ne voit pas »*. Une
 * socket qui ne recevrait que son propre vote rendrait la mecanique inexistante
 * — et une seule socket ne pourrait pas s'en apercevoir.
 */
async function tousVoient(
  clients: readonly Client[],
  attendu: ReadonlyMap<number, number>,
  quoi: string,
): Promise<void> {
  await waitFor(
    () =>
      clients.every((c) => {
        const derniere = votesDe(c).at(-1);
        if (!derniere || derniere.votes.length !== attendu.size) {
          return false;
        }
        return derniere.votes.every((v) => attendu.get(v.playerId) === v.choice);
      })
        ? true
        : null,
    quoi,
    15_000,
  );
}

/**
 * Amene le boss du palier courant puis le fait tomber **par le chemin de mort
 * normal du salon**, et rend son identite.
 *
 * ⚠️ **Sa reserve est ramenee a un coup, et c'est du decor** — meme raison
 * qu'aux taches 2, 6 et 9 : ce qui est mesure ici est le PORTAIL, pas une DPS.
 * Le temps de mise a mort reel est la porte du §7, et il se mesure au banc.
 *
 * ⚠️ **Et cette boucle assene au passage que RIEN n'ouvre le portail avant la
 * mort** : un portail ouvert par un tick, par un ordre de vague ou par
 * l'apparition du boss ferait rougir ICI, avant que le moindre vote ne soit
 * emis. C'est la parade au defaut n°1 de ce depot — le test qui vote sur un
 * portail qui ne s'est jamais ouvert, et qui passe tout seul.
 */
async function tuerLeBoss(room: Room, tireur: Client): Promise<number> {
  const k = room.palier;
  await avancerJusqua(
    room,
    () => room.bossEntityId !== null,
    "l'apparition du boss",
    150 * TICK_HZ,
    () => {
      expect(room.portalOpen).toBe(false);
      viderSauf(room, [room.bossEntityId]);
    },
  );
  const bossId = room.bossEntityId;
  if (bossId === null) {
    throw new Error('le boss doit etre en jeu');
  }

  // Le tireur s'arrete : l'epinglage du boss se fait par rapport a SA position,
  // et un joueur qui glisse emmenerait le boss hors de portee.
  const ancre = await immobiliser(tireur);
  const slot = room.horde.slotOf(bossId);
  expect(slot).toBeGreaterThanOrEqual(0);
  room.horde.hp[slot] = 1;

  // ⚠️ **La visee passe par la SOCKET, et on attend qu'elle en REVIENNE.** Sans
  // ca, la rafale de pas ci-dessous partirait avant que le serveur n'ait lu la
  // trame : le joueur ne tirerait pas et le boss mourrait de vieillesse.
  envoyer(tireur, 0, 0, 127, 0);
  await waitFor(
    () =>
      (tireur.lastSnapshot?.players.find((p) => p.id === tireur.playerId)?.aimX ?? 0) > 0
        ? true
        : null,
    'la visee du tueur revenue dans le SNAPSHOT',
    5000,
  );

  await avancerJusqua(
    room,
    () => room.palier === k + 1,
    'la mort du boss',
    60 * TICK_HZ,
    () => {
      const s = room.horde.slotOf(bossId);
      if (s >= 0) {
        room.horde.x[s] = ancre.x + DISTANCE_BOSS;
        room.horde.y[s] = ancre.y;
      }
      viderSauf(room, [bossId]);
    },
  );
  expect(room.palier).toBe(k + 1);
  return bossId;
}

/** Le lot `DEATHS` qui a emporte le boss — la mort qui termine le palier. */
async function mortDuBoss(client: Client, bossId: number): Promise<DeathsMessage> {
  return waitFor(
    () => mortsDe(client).find((m) => m.ids.includes(bossId)) ?? null,
    'le lot DEATHS qui emporte le boss',
    15_000,
  );
}

/** L'ouverture de portail numero `n` (1-based), vue par les quatre sockets. */
async function ouvertureVueParTous(
  clients: readonly Client[],
  n: number,
): Promise<PortalOpenMessage> {
  const vues = await Promise.all(
    clients.map((c) =>
      waitFor(
        () => ouverturesDe(c)[n - 1] ?? null,
        `PORTAL_OPEN numero ${n} pour le joueur ${c.playerId}`,
        15_000,
      ),
    ),
  );
  const premiere = vues[0];
  if (!premiere) {
    throw new Error('quatre ouvertures attendues');
  }
  // Les quatre clients voient la MEME ouverture : une annonce par socket
  // divergerait sur l'echeance ou sur la mise.
  for (const vue of vues) {
    expect(vue).toEqual(premiere);
  }
  return premiere;
}

/** Le verdict numero `n` (1-based), vu par les quatre sockets. */
async function verdictVuParTous(
  clients: readonly Client[],
  n: number,
): Promise<PortalResultMessage> {
  const vus = await Promise.all(
    clients.map((c) =>
      waitFor(
        () => verdictsDe(c)[n - 1] ?? null,
        `PORTAL_RESULT numero ${n} pour le joueur ${c.playerId}`,
        15_000,
      ),
    ),
  );
  const premier = vus[0];
  if (!premier) {
    throw new Error('quatre verdicts attendus');
  }
  for (const vu of vus) {
    expect(vu).toEqual(premier);
  }
  return premier;
}

describe('le livrable du §13 sur quatre sockets reelles (etape 6a, tache 11)', () => {
  /**
   * **La moitie POSITIVE : un palier se termine, l'egalite continue, la
   * majorite fait partir, et l'or part MAJORE.**
   *
   * ⚠️ **L'egalite vient de DEUX voix contre DEUX, jamais de deux voix et deux
   * silences.** Le §6 fait de l'egalite le defaut : tout ce qui n'est pas une
   * majorite de departs continue. Un decor ou deux joueurs se taisent rendrait
   * donc le meme verdict pour une autre raison, et le test ne dirait rien. La
   * preuve que les quatre ont vote tient en une ligne : le portail ne se ferme
   * avant l'echeance que lorsque **tous** ont vote, donc un verdict qui tombe
   * AVANT `deadlineTick` prouve qu'il n'y avait plus un seul silence.
   *
   * ⚠️ **Et l'or est majore, pas recopie.** Le multiplicateur vaut 1 au premier
   * portail : partir la-bas rendrait exactement la cagnotte, et « majore » se
   * lirait aussi bien d'un multiplicateur qui ne fait rien. Ce test reste une
   * fois, tue un SECOND boss, et part au second portail — c'est le seul endroit
   * du depot ou l'or majore traverse la socket.
   */
  it('l egalite continue, puis la majorite fait partir avec l or MAJORE', async () => {
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

    // L'or part de zero : sans cette ligne, « l'or a bouge » plus bas pourrait
    // se lire d'une cagnotte deja pleine a l'arrivee.
    const depart = await fullSnapshot(a.ws);
    expect(depart.gold).toBe(0);

    // ---- 1. Un palier SE TERMINE, et le portail s'ouvre A LA MORT ----------
    const boss1 = await tuerLeBoss(room, a);
    const mort1 = await mortDuBoss(a, boss1);
    const open1 = await ouvertureVueParTous(clients, 1);

    // ⚠️ **La fenetre est datee de la MORT, pas d'un tick quelconque** (§2 : le
    // palier se termine a la mort du boss). Le tick de la mort vient du fil,
    // pas du salon : c'est `DEATHS` qui le porte.
    expect(open1.deadlineTick).toBe(mort1.tick + PORTAL_WINDOW_TICKS);
    // Premier portail de la run : la mise n'est pas encore majoree.
    expect(open1.multiplier).toBe(1);

    // Le boss a bien paye le palier qu'on vient de finir.
    const apresLePremierBoss = await waitFor(
      () => (a.lastSnapshot && a.lastSnapshot.gold > 0 ? a.lastSnapshot.gold : null),
      "l'or du bonus de palier dans le SNAPSHOT",
      10_000,
    );

    /**
     * L'or tel que le FIL le disait juste avant le tick d'effet d'un verdict.
     *
     * ⚠️ **Date, jamais releve apres coup.** Au moment ou le verdict arrive, la
     * cagnotte du salon a deja ete majoree : la comparer a elle-meme ne dirait
     * rien. Et un releve pris trop tot dirait un autre nombre — une piece
     * ramassee entre-temps vaut un or de plus (`COIN_DROP_ONE_IN`).
     */
    const orJusteAvant = (client: Client, effectTick: number): number => {
      const jalon = client.jalonsOr.filter((j) => j.tick < effectTick).at(-1);
      expect(jalon, "aucun SNAPSHOT n'a precede le verdict").toBeDefined();
      return jalon?.gold ?? -1;
    };

    // ---- 2. Les quatre sont votants, silence compris ----------------------
    //
    // ⚠️ **Le portail est REELLEMENT ouvert avant qu'on vote.** C'est le defaut
    // n°1 de ce depot — un vote sur un portail jamais ouvert passe tout seul.
    const silences = new Map(clients.map((x) => [x.playerId, NO_VOTE]));
    await tousVoient(clients, silences, 'les quatre silences a l ouverture');

    // ---- 3. LE MONDE NE S ARRETE PAS pendant qu'on negocie ----------------
    //
    // ⚠️ **Les DEUX moities, et une seule laisserait la moitie de la mutation
    // en vie** : un `if (portail ouvert) { #stepPortal(); return; }` calque sur
    // le gel du draft arreterait la horde ET les joueurs.
    // ⚠️ **Les joueurs marchent vers la GAUCHE, et le temoin est pose a
    // DROITE.** Le corps du boss est tombe a `DISTANCE_BOSS` a la droite de A,
    // et il y a laisse son orbe : marcher vers la droite ferait ramasser cette
    // orbe — donc peut-etre une piece, donc un or de plus — a un tick que rien
    // ne rend reproductible. `ORB_PICKUP_RADIUS` vaut 90 et le corps est a 100 :
    // immobile ou en s'eloignant, personne ne le ramasse.
    const ancreA = positionDuFil(a);
    const temoin = poseCible(room, 9500, ancreA.x + DISTANCE_TEMOIN, ancreA.y);
    const posTemoin = (): { x: number; y: number } => {
      const slot = room.horde.slotOf(temoin);
      expect(slot).toBeGreaterThanOrEqual(0);
      return { x: room.horde.x[slot] ?? 0, y: room.horde.y[slot] ?? 0 };
    };

    // Le pilote tourne a l'horloge REELLE : c'est le serveur qui simule, pas
    // le test. Il balaie la horde — sauf le temoin — et fait marcher les quatre
    // joueurs vers la droite.
    const stopPilote = piloter(() => {
      viderSauf(room, [temoin]);
      const slot = room.horde.slotOf(temoin);
      if (slot >= 0) {
        // Increvable, mais LIBRE de se deplacer : c'est un deplacement qu'on
        // mesure, pas une mise a mort.
        room.horde.hp[slot] = 1e6;
      }
      for (const client of clients) {
        envoyer(client, -127, 0, 0, 0);
      }
    });

    try {
      const tickDebut = room.tick;
      const monstreAvant = posTemoin();
      const joueursAvant = new Map(clients.map((x) => [x.playerId, positionDuFil(x).x]));

      await waitFor(
        () => (room.tick >= tickDebut + TICKS_MESURE ? true : null),
        'le monde qui tourne pendant le vote',
        20_000,
      );

      const monstreApres = posTemoin();
      const dernierReleve = a.lastSnapshot?.tick ?? -1;

      // ⚠️ **Le portail est encore ouvert au dernier tick mesure**, sinon la
      // mesure ne dirait rien du vote : elle dirait seulement que le monde
      // tourne quand personne ne negocie.
      expect(room.portalOpen).toBe(true);
      expect(verdictsDe(a)).toHaveLength(0);
      expect(dernierReleve).toBeLessThan(open1.deadlineTick);

      // La horde avance...
      expect(
        Math.hypot(monstreApres.x - monstreAvant.x, monstreApres.y - monstreAvant.y),
        'la horde est figee pendant le vote',
      ).toBeGreaterThan(SEUIL_HORDE_PX);
      // ...et les joueurs aussi, les quatre.
      for (const client of clients) {
        const avant = joueursAvant.get(client.playerId) ?? 0;
        expect(
          avant - positionDuFil(client).x,
          `le joueur ${client.playerId} est fige pendant le vote`,
        ).toBeGreaterThan(SEUIL_JOUEUR_PX);
      }

      // ---- 4. Les votes se voient, et ils sont REVOCABLES -----------------
      const table = new Map(silences);
      const voir = async (client: Client, choix: number, quoi: string): Promise<void> => {
        client.ws.send(encodeVote(choix));
        table.set(client.playerId, choix);
        await tousVoient(clients, table, quoi);
      };

      await voir(a, VOTE_CHOICE.LEAVE, 'le vote de A vu par les quatre');
      await voir(b, VOTE_CHOICE.LEAVE, 'le vote de B vu par les quatre');
      await voir(c, VOTE_CHOICE.LEAVE, 'le vote de C vu par les quatre');

      // ⚠️ **Trois departs sur quatre, et RIEN ne tranche.** Le portail ne se
      // ferme pas des qu'une majorite semble acquise : les votes sont
      // revocables, donc le decompte n'est stable qu'une fois tout le monde
      // passe. Une fermeture anticipee ferait partir l'equipe ici.
      expect(verdictsDe(a)).toHaveLength(0);
      expect(room.portalOpen).toBe(true);

      // C se ravise : il RETIRE son vote, puis vote l'inverse.
      await voir(c, NO_VOTE, 'la revocation de C vue par les quatre');
      expect(verdictsDe(a)).toHaveLength(0);
      await voir(c, VOTE_CHOICE.STAY, 'le changement d avis de C vu par les quatre');

      // D tranche en dernier : deux departs, deux restes.
      d.ws.send(encodeVote(VOTE_CHOICE.STAY));

      // ---- 5. L'EGALITE CONTINUE ------------------------------------------
      const verdict1 = await verdictVuParTous(clients, 1);
      expect(verdict1.decision).toBe(VOTE_CHOICE.STAY);
      // ⚠️ **La preuve que l'egalite est un 2-2 et non un 2-0 plus deux
      // silences** : avant l'echeance, le portail ne se ferme QUE lorsque les
      // quatre ont vote.
      expect(verdict1.effectTick).toBeLessThan(open1.deadlineTick);
      // L'or est REPORTE, pas acquis : la cagnotte ne bouge pas d'un pouce, et
      // surtout elle n'est PAS majoree — c'est ce qui laisse quelque chose a
      // risquer au palier suivant.
      const orAvant1 = orJusteAvant(a, verdict1.effectTick);
      expect(orAvant1).toBeGreaterThanOrEqual(apresLePremierBoss);
      expect(verdict1.gold).toBe(orAvant1);
      // Et la run continue : rester n'est pas une fin.
      expect(finDeRun(a)).toBeUndefined();
      expect(room.portalOpen).toBe(false);
    } finally {
      stopPilote();
    }

    // ---- 6. Un joueur MEURT avant le portail suivant ----------------------
    //
    // ⚠️ **Il reste connecte, et il votera** (§6 : « tout joueur connecte, mort
    // ou vif »). Sa voix sera DECISIVE plus bas, sans quoi le test ne dirait
    // rien de sa mort.
    for (const client of clients) {
      await immobiliser(client);
    }
    viderSauf(room, []);
    const posD = positionDuFil(d);
    const bourreau = poseCible(room, 9600, posD.x, posD.y);
    await avancerJusqua(
      room,
      () => hpDuFil(d) === 0,
      'la mort du joueur D',
      90 * TICK_HZ,
      () => {
        epingler(room, bourreau, posD.x, posD.y);
        viderSauf(room, [bourreau]);
      },
    );
    viderSauf(room, []);
    expect(hpDuFil(d)).toBe(0);
    // Les trois autres sont debout : la mort d'un seul ne termine rien (§5).
    for (const vivant of [a, b, c]) {
      expect(hpDuFil(vivant)).toBeGreaterThan(0);
    }
    expect(finDeRun(a)).toBeUndefined();

    // ---- 7. Le SECOND palier, et la mise MAJOREE sur le fil ---------------
    const boss2 = await tuerLeBoss(room, a);
    const mort2 = await mortDuBoss(a, boss2);
    const open2 = await ouvertureVueParTous(clients, 2);

    expect(open2.deadlineTick).toBe(mort2.tick + PORTAL_WINDOW_TICKS);
    // ⚠️ **LA ligne que le premier portail ne peut pas garder** : rester a
    // majore la mise, et c'est ce chiffre-la que l'ecran du vote multiplie.
    expect(open2.multiplier).toBe(1 + EXTRACT_MULTIPLIER_STEP);
    expect(open2.multiplier).toBeGreaterThan(1);

    // ---- 8. Le mort vote, l'absent ne bloque pas, la majorite tranche -----
    const table2 = new Map(clients.map((x) => [x.playerId, NO_VOTE]));
    await tousVoient(clients, table2, 'les quatre silences au second portail');

    // A part, B reste, C se tait, et D — qui est MORT — part.
    for (const [client, choix] of [
      [a, VOTE_CHOICE.LEAVE],
      [b, VOTE_CHOICE.STAY],
      [d, VOTE_CHOICE.LEAVE],
    ] as const) {
      client.ws.send(encodeVote(choix));
      table2.set(client.playerId, choix);
      await tousVoient(clients, table2, `le vote du joueur ${client.playerId} vu par les quatre`);
    }
    // ⚠️ **Il est toujours mort au moment de voter.** Sans cette ligne, « un
    // mort vote » se lirait aussi bien d'un joueur qu'on aurait laisse revivre.
    expect(hpDuFil(d)).toBe(0);
    expect(hpDuFil(a)).toBeGreaterThan(0);

    // C ne votera jamais : l'absence ne bloque pas, c'est l'echeance qui
    // tranche. On y va en accelerant — la table des votes a deja fait le tour
    // des quatre sockets.
    const releve = a.lastSnapshot;
    if (!releve) {
      throw new Error('aucun snapshot avant l echeance');
    }
    // ⚠️ **La cagnotte a GROSSI d'un palier a l'autre** : le bonus est paye a
    // chaque boss, et il paye le palier qu'on vient de finir. Un bonus verse
    // une seule fois passerait ici.
    const cagnotte = releve.gold;
    expect(cagnotte).toBeGreaterThan(apresLePremierBoss);

    await avancerJusqua(
      room,
      // ⚠️ **Le SECOND verdict, pas « un verdict ».** Le premier est deja dans
      // la liste : une sonde a `length > 0` rendrait la main tout de suite, et
      // l'echeance ne serait jamais atteinte.
      () => verdictsDe(a).length >= 2,
      'le verdict a l echeance du portail',
      PORTAL_WINDOW_TICKS + 10 * TICK_HZ,
      () => {
        viderSauf(room, []);
      },
    );

    const verdict2 = await verdictVuParTous(clients, 2);

    // ⚠️ **La voix du mort est DECISIVE, et l'abstention ne compte pas.** Deux
    // departs (dont le sien) contre un reste : sans sa voix, 1-1, egalite, on
    // continue. Et si `NO_VOTE` se comptait comme « rester », le silence de C
    // rendrait 2-2, donc « rester » lui aussi. Dans les deux cas, aucune fin de
    // run, et ce qui suit rougirait.
    expect(verdict2.decision).toBe(VOTE_CHOICE.LEAVE);
    // ⚠️ **Le tick d'effet est celui de l'echeance, a l'unite pres** — le
    // client ne peut pas le deduire, et il ne doit pas avoir a le faire.
    expect(verdict2.effectTick).toBe(open2.deadlineTick);

    // ---- 9. L'OR EST ACQUIS, ET MAJORE -----------------------------------
    //
    // L'or d'avant le verdict vient du FIL, date : c'est le dernier jalon
    // anterieur au tick d'effet. Le lire apres coup lirait l'or deja majore.
    const fenetre = a.jalonsOr.filter((j) => j.tick >= releve.tick && j.tick < verdict2.effectTick);
    expect(fenetre.length, 'aucun snapshot pendant la fenetre de vote').toBeGreaterThan(0);
    // La cagnotte ne bouge pas pendant qu'on negocie : c'est ce qui rend la
    // comparaison ci-dessous univoque.
    for (const jalon of fenetre) {
      expect(jalon.gold).toBe(cagnotte);
    }
    const orAvant = orJusteAvant(a, verdict2.effectTick);
    expect(orAvant).toBe(cagnotte);

    expect(verdict2.gold).toBe(Math.round(orAvant * open2.multiplier));
    // ⚠️ **Et la majoration SE VOIT** : sans elle, les deux nombres seraient
    // egaux, et « l'or est acquis » se lirait d'un or recopie.
    expect(verdict2.gold).toBeGreaterThan(orAvant);

    // La run se termine — par le `RUN_OVER` de l'etape 3, pas par une seconde
    // fin inventee pour le portail — et l'or acquis reste affiche.
    for (const client of clients) {
      await waitFor(() => finDeRun(client) ?? null, `RUN_OVER pour ${client.playerId}`, 10_000);
    }
    await waitFor(
      () => (a.lastSnapshot?.gold === verdict2.gold ? true : null),
      "l'or acquis dans le SNAPSHOT",
      10_000,
    );
  }, 120_000);

  /**
   * **La moitie NEGATIVE, et c'est elle qui porte le sens** (§8 : *« l'or est
   * acquis quand on part » se lit aussi bien avec un or qui ne bouge
   * jamais*).
   *
   * Le decor est celui de la moitie positive jusqu'a la mort du boss — meme
   * salon, meme graine, meme balayage, meme cagnotte gagnee au palier. Ce qui
   * change est ce qui arrive ENSUITE : l'equipe est effacee **pendant** qu'elle
   * negocie, et la cagnotte tombe a `WIPE_GOLD_KEPT`.
   */
  it('l effacement de l equipe efface l or, sur le fil', async () => {
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

    const depart = await fullSnapshot(a.ws);
    expect(depart.gold).toBe(0);

    const boss = await tuerLeBoss(room, a);
    const mort = await mortDuBoss(a, boss);
    const open = await ouvertureVueParTous(clients, 1);
    expect(open.deadlineTick).toBe(mort.tick + PORTAL_WINDOW_TICKS);

    // ⚠️ **La cagnotte est NON VIDE avant l'effacement.** Sans cette ligne,
    // « l'or tombe a zero » se lirait aussi bien d'un or qui n'a jamais rien
    // valu — le defaut « le test qui rend zero », cinq fois dans ce depot.
    const cagnotte = await waitFor(
      () => (a.lastSnapshot && a.lastSnapshot.gold > 0 ? a.lastSnapshot.gold : null),
      "l'or du bonus de palier dans le SNAPSHOT",
      10_000,
    );
    expect(cagnotte).toBeGreaterThan(0);

    // Un bourreau increvable epingle sur chaque joueur : l'equipe entiere
    // tombe, et c'est le seul chemin qui coute la cagnotte (§5 — la mort d'un
    // seul ne coute rien, la moitie positive vient de le montrer).
    const bourreaux = new Map<number, { id: number; x: number; y: number }>();
    for (const client of clients) {
      const pos = positionDuFil(client);
      bourreaux.set(client.playerId, {
        id: poseCible(room, 9700 + client.playerId, pos.x, pos.y),
        x: pos.x,
        y: pos.y,
      });
    }

    await avancerJusqua(
      room,
      () => clients.every((client) => hpDuFil(client) === 0),
      "l'effacement de l equipe",
      120 * TICK_HZ,
      () => {
        for (const bourreau of bourreaux.values()) {
          epingler(room, bourreau.id, bourreau.x, bourreau.y);
        }
        viderSauf(
          room,
          [...bourreaux.values()].map((x) => x.id),
        );
      },
    );

    // ---- Les quatre sont a terre, et l'or a disparu -----------------------
    for (const client of clients) {
      await waitFor(() => finDeRun(client) ?? null, `RUN_OVER pour ${client.playerId}`, 10_000);
      expect(hpDuFil(client)).toBe(0);
    }
    await waitFor(
      () => (a.lastSnapshot?.gold === 0 ? true : null),
      "l'or efface dans le SNAPSHOT",
      10_000,
    );

    // ⚠️ **`WIPE_GOLD_KEPT` est LE parametre du §9.3, et ce test ne le garde
    // PAS — il ne peut pas.** Le §5 de la spec le dit lui-meme : *« tant que
    // `WIPE_GOLD_KEPT` vaut 0, aucun test ne la distingue d'un zero ecrit en
    // dur »*. Un `expect(gold).toBe(Math.round(cagnotte * WIPE_GOLD_KEPT))`
    // ecrit ici PRETENDRAIT le garder et ne garderait rien : les deux cotes de
    // la comparaison bougeraient ensemble. Il a ete ecrit puis retire — c'est
    // l'assertion creuse, dix-sept fois dans ce depot.
    //
    // Ce que cette ligne-ci garde, c'est le DECOR : si le parametre montait a
    // 1, l'attente ci-dessus expirerait au bout de dix secondes sans jamais
    // dire pourquoi. Meme idiome que `expect(EXTRACT_MULTIPLIER_STEP)` dans
    // `room.test.ts`.
    expect(WIPE_GOLD_KEPT).toBeLessThan(1);

    // ⚠️ **Et le portail n'a jamais tranche** : la run s'est terminee pendant
    // la fenetre, et `step` ne rappelle plus personne une fois `#runOver` vrai.
    // Une equipe effacee ne part pas avec la mise.
    expect(verdictsDe(a)).toHaveLength(0);
  }, 120_000);
});
