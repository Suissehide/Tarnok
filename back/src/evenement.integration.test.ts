import type { AddressInfo } from 'node:net';
import { PROIE_ARCHETYPE } from '@shared/archetypes';
import { MAP_SIZE } from '@shared/constants';
import {
  CarrierClock,
  EVENT_KIND,
  EVENT_OUTCOME,
  EVENT_STATE_PERIOD_TICKS,
  NOIR_LIGHT_RADIUS,
  RELIQUE_CARRIER_SPEED,
} from '@shared/evenements';
import { entityIdOf } from '@shared/horde';
import {
  decode,
  type EventStateMessage,
  encodeHello,
  encodeInput,
  type Message,
  MSG,
  type SnapshotMessage,
  type WaveOrderMessage,
} from '@shared/protocol';
import { EVENT_RARITY_FLOOR } from '@shared/rarity';
import { FORMATION } from '@shared/waves';
import { BASE_WEAPON_ID } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, prisma } from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

/**
 * Le livrable de l'etape 14 (§1 de la spec) : **sur deux vraies sockets, les
 * deux clients recoivent le meme `EVENT_START`, puis des `EVENT_STATE` a 5 Hz
 * qui montent quand les joueurs remplissent l'objectif et s'arretent quand il
 * s'acheve ; un `EVENT_END` reussi est suivi d'un `LEVEL_UP` et d'un
 * `DRAFT_OPEN` dont chaque carte est au moins epique, et chaque client sait
 * que c'est un etalage d'evenement. Le `SNAPSHOT` garde sa taille.**
 *
 * ⚠️ **« Son `GameClient` dit `draftIsEvent` »** est rejoue par
 * `drapeauxDEvenement`, la regle exacte de `GameClient` (ecart n° 11) : le
 * back n'importe pas le front. `front/src/net/evenement.test.ts` couvre le
 * `GameClient` lui-meme.
 */

const ROOM_SEED = 0x14_e0_e0e0;
/** 22 octets d'en-tete + 2 joueurs x 11 (le bouclier des pactes) : ecrit NU, jamais recalcule. */
const SNAPSHOT_A_DEUX = 44;
/** Une graine du genre voulu : le genre est `graine % EVENT_KIND_COUNT` (7). */
const graine = (genre: number): number => 7 * 0x4_6a2b + genre;

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  /** Tout ce qui est arrive sur CETTE socket, hors snapshots. */
  received: Message[];
  /** Les tailles BRUTES des snapshots recus. */
  snapshotBytes: Set<number>;
  /** Les tailles BRUTES des messages d'evenement, par type. */
  eventBytes: Map<number, Set<number>>;
  seq: number;
  /** TOUT ce qui est arrive, snapshots compris, dans l'ordre d'arrivee (la datation en depend). */
  flux: Message[];
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
  // L'ecoute de 'open' AVANT tout `await` (voir `draft.integration.test.ts`).
  const ouverte = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const client: Client = {
    ws,
    playerId: 0,
    received: [],
    snapshotBytes: new Set(),
    eventBytes: new Map(),
    seq: 0,
    flux: [],
  };
  ws.on('message', (data: ArrayBuffer) => {
    const msg = decode(data);
    client.flux.push(msg);
    if (msg.type === MSG.WELCOME) {
      client.playerId = msg.playerId;
    }
    if (msg.type === MSG.SNAPSHOT) {
      client.snapshotBytes.add(data.byteLength);
      return;
    }
    if (
      msg.type === MSG.EVENT_START ||
      msg.type === MSG.EVENT_STATE ||
      msg.type === MSG.EVENT_END
    ) {
      const tailles = client.eventBytes.get(msg.type) ?? new Set<number>();
      tailles.add(data.byteLength);
      client.eventBytes.set(msg.type, tailles);
    }
    client.received.push(msg);
  });
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

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retire de la horde tout ce qui n'est pas dans `garder`, HORS du lot de morts. */
function viderSauf(room: Room, garder: ReadonlySet<number>): void {
  const ids: number[] = [];
  for (let i = 0; i < room.horde.count; i++) {
    const id = room.horde.entityIdAt(i);
    if (!garder.has(id)) {
      ids.push(id);
    }
  }
  if (ids.length > 0) {
    room.horde.kill(ids);
  }
}

/** Enveloppe `room.step` : `apres` s'execute a la fin de chaque tick du serveur. */
function envelopper(room: Room, apres: () => void): void {
  const pas = room.step.bind(room);
  room.step = (dt: number): void => {
    pas(dt);
    apres();
  };
}

/**
 * La regle de `GameClient` (etape 14, §6.5), rejouee sur les messages
 * DECODES, dans l'ordre d'arrivee : un drapeau « evenement ? » par `LEVEL_UP`.
 * Aucun coffre ici : la horde est retiree hors du lot de morts.
 */
function drapeauxDEvenement(recus: readonly Message[]): boolean[] {
  let dus = 0;
  const out: boolean[] = [];
  for (const m of recus) {
    if (m.type === MSG.EVENT_END && m.outcome === EVENT_OUTCOME.REUSSI) {
      dus++;
    } else if (m.type === MSG.LEVEL_UP) {
      out.push(dus > 0);
      if (dus > 0) {
        dus--;
      }
    }
  }
  return out;
}

const etats = (c: Client): EventStateMessage[] =>
  c.received.filter((m): m is EventStateMessage => m.type === MSG.EVENT_STATE);

async function salonADeux(): Promise<{ room: Room; a: Client; b: Client }> {
  const code = await createRoomCode();
  const room = app.rooms.get(code);
  if (!room) {
    throw new Error('le registre de salons doit etre accessible depuis l app');
  }
  const a = await connect(code);
  const b = await connect(code);
  // A un seul joueur, le snapshot fait 33 octets : on ne mesure qu'a deux.
  a.snapshotBytes.clear();
  b.snapshotBytes.clear();
  return { room, a, b };
}

describe('etape 14 : les evenements bonus, sur vraies sockets (le livrable)', () => {
  it('les sceaux : meme depart chez les deux, etats a 5 Hz, reussite, puis un etalage tout epique nomme evenement', async () => {
    const { room, a, b } = await salonADeux();
    let debut = -1;
    let fin = -1;
    envelopper(room, () => {
      viderSauf(room, new Set());
      const sceaux = room.eventPoints;
      const [s0, s1] = sceaux ?? [];
      if (s0 && s1) {
        room.debugPlace(a.playerId, s0.x, s0.y);
        room.debugPlace(b.playerId, s1.x, s1.y);
      } else if (debut >= 0 && fin < 0) {
        fin = room.tick;
      }
    });
    room.debugStartEvent(graine(EVENT_KIND.SCEAUX));
    debut = room.tick;

    // ---- 1. La reussite, chez les deux --------------------------------------
    await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.EVENT_END) ?? null,
          `EVENT_END (joueur ${c.playerId})`,
          40_000,
        ),
      ),
    );
    // ---- 2. Puis l'etalage ---------------------------------------------------
    const opens = await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.DRAFT_OPEN) ?? null,
          `DRAFT_OPEN (joueur ${c.playerId})`,
          5_000,
        ),
      ),
    );

    // ---- 3. Le meme depart, en 13 octets (deux sceaux) -----------------------
    const departs = [a, b].map((c) => c.received.find((m) => m.type === MSG.EVENT_START));
    expect(departs[0]).toEqual(departs[1]);
    expect(departs[0]).toMatchObject({ type: MSG.EVENT_START, kind: EVENT_KIND.SCEAUX });
    for (const c of [a, b]) {
      expect([...(c.eventBytes.get(MSG.EVENT_START) ?? [])]).toEqual([13]);
      expect([...(c.eventBytes.get(MSG.EVENT_STATE) ?? [])]).toEqual([7]);
      expect([...(c.eventBytes.get(MSG.EVENT_END) ?? [])]).toEqual([2]);
    }

    // ---- 4. Les etats : 5 Hz de jeu, qui montent, et rien apres la fin -------
    expect(fin).toBeGreaterThan(debut);
    expect(etats(a)).toHaveLength(etats(b).length);
    expect(
      Math.abs(etats(a).length - (fin - debut) / EVENT_STATE_PERIOD_TICKS),
    ).toBeLessThanOrEqual(1);
    const progres = etats(a).map((e) => e.progress);
    expect(progres).toEqual([...progres].sort((x, y) => x - y));
    expect(progres.at(-1)).toBeGreaterThan(0);
    for (const c of [a, b]) {
      const types = c.received.map((m) => m.type);
      const iFin = types.indexOf(MSG.EVENT_END);
      expect(c.received[iFin]).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.REUSSI });
      expect(types.lastIndexOf(MSG.EVENT_STATE)).toBeLessThan(iFin);
      // Dans l'ordre : la fin, le LEVEL_UP, l'etalage.
      expect(types.indexOf(MSG.LEVEL_UP)).toBeGreaterThan(iFin);
      expect(types.indexOf(MSG.DRAFT_OPEN)).toBeGreaterThan(types.indexOf(MSG.LEVEL_UP));
    }

    // ---- 5. L'etalage : min(2 + 3, 6) cartes, toutes au moins epiques -------
    for (const open of opens) {
      if (open.type !== MSG.DRAFT_OPEN) {
        throw new Error('DRAFT_OPEN attendu');
      }
      expect(open.cards).toHaveLength(5);
      for (const carte of open.cards) {
        expect(carte.rarity).toBeGreaterThanOrEqual(EVENT_RARITY_FLOOR);
      }
    }

    // ---- 6. Chacun sait que c'est un etalage d'evenement, sans un octet ------
    expect(drapeauxDEvenement(a.received)).toEqual([true]);
    expect(drapeauxDEvenement(b.received)).toEqual([true]);

    // ---- 7. Rien de plus par tick --------------------------------------------
    expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
    expect([...b.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
  }, 60_000);

  /**
   * La forge se lit sur l'ENTREE (§3.2). Le decor repose A sur la forge a
   * chaque tick : l'entree de mouvement envoyee PAR LA SOCKET est donc la
   * seule chose qui change — et elle suffit a suspendre, sans remise a zero.
   */
  it('la forge : immobile elle monte, une entree de mouvement la suspend sans la remettre a zero', async () => {
    const { room, a, b } = await salonADeux();
    envelopper(room, () => {
      viderSauf(room, new Set());
      const forge = room.eventPoints?.[0];
      if (forge) {
        room.debugPlace(a.playerId, forge.x, forge.y);
      }
    });
    room.debugStartEvent(graine(EVENT_KIND.FORGE));

    // 1. Immobile : ca monte.
    await waitFor(
      () => (etats(a).filter((e) => e.progress > 0).length >= 2 ? true : null),
      'la forge monte',
      5_000,
    );
    // 2. A bouge, par la socket.
    const bouge = setInterval(() => {
      a.seq++;
      a.ws.send(encodeInput(a.seq, 127, 0, 0, 0));
    }, 10);
    let gele = -1;
    try {
      await dormir(600);
      gele = etats(a).at(-1)?.progress ?? -1;
      const n = etats(a).length;
      await dormir(1_000);
      const pendant = etats(a).slice(n);
      expect(pendant.length).toBeGreaterThanOrEqual(3);
      for (const e of pendant) {
        expect(e.progress).toBe(gele);
      }
      // Suspendu, pas remis a zero.
      expect(gele).toBeGreaterThan(0);
    } finally {
      clearInterval(bouge);
    }
    // 3. Immobile de nouveau : ca repart d'ou c'etait.
    a.seq++;
    a.ws.send(encodeInput(a.seq, 0, 0, 0, 0));
    await waitFor(
      () => ((etats(a).at(-1)?.progress ?? 0) > gele ? true : null),
      'la forge repart',
      5_000,
    );
    expect(etats(b).length).toBeGreaterThan(0);
  }, 30_000);

  it('le convoi : sans escorte et sous cinq ennemis, il est detruit — aucun etalage', async () => {
    const { room, a, b } = await salonADeux();
    room.debugStartEvent(graine(EVENT_KIND.CONVOI));
    const depart = room.eventPoints?.[0];
    if (!depart) {
      throw new Error('le convoi a un depart');
    }
    // Cinq frappeurs, reposes sur le chariot a chaque tick ; tout le reste retire.
    // Les joueurs sont a ~1 200 px : personne n'escorte, le chariot attend.
    // ⚠️ `waveId` est un `Uint16Array` cote horde (`shared/horde.ts` l.499) :
    // 990 014 (le brief) deborde et se tronque silencieusement a 6 974, ce qui
    // desaccorde `frappeurs` de l'identite reellement posee et vide la horde
    // au premier `viderSauf`. 61 014 reste sous 65 536.
    room.horde.spawn({
      waveId: 61_014,
      spawnTick: room.tick,
      seed: 1,
      archetype: 0,
      formation: FORMATION.SCATTER,
      anchorX: depart.x,
      anchorY: depart.y,
      count: 5,
    });
    const frappeurs = new Set(Array.from({ length: 5 }, (_, k) => entityIdOf(61_014, k)));
    envelopper(room, () => {
      viderSauf(room, frappeurs);
      for (let i = 0; i < room.horde.count; i++) {
        room.horde.x[i] = depart.x;
        room.horde.y[i] = depart.y;
      }
    });

    const fins = await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.EVENT_END) ?? null,
          `EVENT_END (joueur ${c.playerId})`,
          15_000,
        ),
      ),
    );
    for (const f of fins) {
      expect(f).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.DETRUIT });
    }
    // Les PV du chariot descendent, le chariot n'a pas bouge.
    const pv = etats(a).map((e) => e.cartHp);
    expect(pv[0]).toBe(255);
    expect(pv).toEqual([...pv].sort((x, y) => y - x));
    for (const e of etats(a)) {
      expect({ x: e.cartX, y: e.cartY }).toEqual(depart);
    }
    // Un evenement rate ne doit rien : aucun etalage.
    await dormir(1_000);
    for (const c of [a, b]) {
      expect(c.received.some((m) => m.type === MSG.LEVEL_UP)).toBe(false);
      expect(c.received.some((m) => m.type === MSG.DRAFT_OPEN)).toBe(false);
      expect([...(c.eventBytes.get(MSG.EVENT_START) ?? [])]).toEqual([13]);
    }
    expect(drapeauxDEvenement(a.received)).toEqual([]);
    expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
    expect([...b.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
  }, 30_000);
});

describe('etape 16 : quatre evenements de plus, sur vraies sockets (le livrable)', () => {
  const CENTRE = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
  const snapshots = (c: Client): SnapshotMessage[] =>
    c.flux.filter((m): m is SnapshotMessage => m.type === MSG.SNAPSHOT);

  /** Rejoue le flux d'un client dans `CarrierClock` : les dates `from` de chaque changement. */
  function datesDuClient(c: Client): number[] {
    let horloge: CarrierClock | null = null;
    const dates: number[] = [];
    for (const m of c.flux) {
      if (m.type === MSG.EVENT_START) {
        horloge = m.kind === EVENT_KIND.RELIQUE ? new CarrierClock() : null;
      } else if (m.type === MSG.EVENT_STATE) {
        horloge?.heard(m.cartHp);
      } else if (m.type === MSG.EVENT_END) {
        horloge = null;
      } else if (m.type === MSG.SNAPSHOT && horloge) {
        const d = horloge.dated(m.tick);
        if (d) {
          dates.push(d.from);
        }
      }
    }
    return dates;
  }

  it('la relique : meme porteur, date D + 1 chez les deux, 60 % au serveur, aucune salve, livraison → etalage epique', async () => {
    const { room, a, b } = await salonADeux();
    const changes: number[] = [];
    const tirsDuPorteur = new Set<number>();
    let porteur = 0;
    let ramasser = true;
    envelopper(room, () => {
      viderSauf(room, new Set());
      if (room.eventPoints === null) {
        return;
      }
      const c = room.eventCarrier;
      if (c !== porteur) {
        changes.push(room.tick);
        porteur = c;
      }
      if (c === a.playerId) {
        ramasser = false;
        tirsDuPorteur.add(room.lastFireTickOf(a.playerId, BASE_WEAPON_ID));
      }
      const r = room.eventPoints[0];
      if (ramasser && r) {
        room.debugPlace(a.playerId, r.x, r.y);
      }
    });
    // A vise a droite, par la socket : il tire tant qu'il ne porte pas.
    a.seq++;
    a.ws.send(encodeInput(a.seq, 0, 0, 127, 0));
    await dormir(300);
    room.debugStartEvent(graine(EVENT_KIND.RELIQUE));

    // ---- 1. Le ramassage, et le meme octet de porteur chez les deux --------
    await waitFor(() => (room.eventCarrier === a.playerId ? true : null), 'ramassage', 5_000);
    await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => (etats(c).some((e) => e.cartHp === a.playerId) ? true : null),
          `octet de porteur (joueur ${c.playerId})`,
          3_000,
        ),
      ),
    );

    // ---- 2. 60 % au serveur : A porte, B non, meme entree, au centre degage --
    room.debugPlace(a.playerId, CENTRE.x - 120, CENTRE.y);
    room.debugPlace(b.playerId, CENTRE.x - 120, CENTRE.y + 100);
    a.seq++;
    a.ws.send(encodeInput(a.seq, 127, 0, 127, 0));
    b.seq++;
    b.ws.send(encodeInput(b.seq, 127, 0, 0, 0));
    await dormir(200);
    const n0 = snapshots(a).length;
    await dormir(400);
    const fenetre = snapshots(a).slice(n0);
    const premier = fenetre[0];
    const dernier = fenetre.at(-1);
    if (!premier || !dernier) {
      throw new Error('des snapshots pendant la marche');
    }
    const dx = (id: number): number =>
      (dernier.players.find((p) => p.id === id)?.x ?? 0) -
      (premier.players.find((p) => p.id === id)?.x ?? 0);
    expect(dx(b.playerId)).toBeGreaterThan(50);
    expect(dx(a.playerId) / dx(b.playerId)).toBeCloseTo(RELIQUE_CARRIER_SPEED, 1);

    // ---- 3. Aucune salve pour le porteur, au serveur : un seul tick de tir --
    expect(tirsDuPorteur.size).toBe(1);

    // ---- 4. La livraison ---------------------------------------------------
    const autel = room.eventPoints?.[1];
    if (!autel) {
      throw new Error('un autel');
    }
    room.debugPlace(a.playerId, autel.x, autel.y);
    const fins = await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.EVENT_END) ?? null,
          `EVENT_END (joueur ${c.playerId})`,
          5_000,
        ),
      ),
    );
    for (const f of fins) {
      expect(f).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.REUSSI });
    }
    const opens = await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.DRAFT_OPEN) ?? null,
          `DRAFT_OPEN (joueur ${c.playerId})`,
          5_000,
        ),
      ),
    );
    for (const c of [a, b]) {
      const types = c.received.map((m) => m.type);
      expect(types.indexOf(MSG.LEVEL_UP)).toBeGreaterThan(types.indexOf(MSG.EVENT_END));
      expect(types.indexOf(MSG.DRAFT_OPEN)).toBeGreaterThan(types.indexOf(MSG.LEVEL_UP));
      expect(drapeauxDEvenement(c.received)).toEqual([true]);
    }
    for (const open of opens) {
      if (open.type !== MSG.DRAFT_OPEN) {
        throw new Error('DRAFT_OPEN attendu');
      }
      for (const carte of open.cards) {
        expect(carte.rarity).toBeGreaterThanOrEqual(EVENT_RARITY_FLOOR);
      }
    }

    // ---- 5. Le meme depart (13 o), les memes dates, D + 1 a 4 ticks pres ----
    const departs = [a, b].map((c) => c.received.find((m) => m.type === MSG.EVENT_START));
    expect(departs[0]).toEqual(departs[1]);
    expect(departs[0]).toMatchObject({ kind: EVENT_KIND.RELIQUE, solo: false });
    expect([...(a.eventBytes.get(MSG.EVENT_START) ?? [])]).toEqual([13]);
    const datesA = datesDuClient(a);
    expect(datesDuClient(b)).toEqual(datesA);
    expect(datesA).toHaveLength(changes.length);
    datesA.forEach((from, i) => {
      const d = changes[i] ?? 0;
      expect(from - (d + 1)).toBeGreaterThanOrEqual(0);
      expect(from - (d + 1)).toBeLessThanOrEqual(4);
    });
    // L'ORDRE d'envoi qui fait la date (spec §12) : l'etat du ramassage arrive avant tout
    // SNAPSHOT date D ou plus. Inverse (`SNAPSHOT` avant `EVENT_*`), la date glisserait d'un
    // envoi en restant dans la tolerance ci-dessus : c'est cette ligne qui le verrait.
    for (const c of [a, b]) {
      const iEtat = c.flux.findIndex((m) => m.type === MSG.EVENT_STATE && m.cartHp === a.playerId);
      expect(iEtat).toBeGreaterThan(0);
      const avant = c.flux
        .slice(0, iEtat)
        .filter((m): m is SnapshotMessage => m.type === MSG.SNAPSHOT);
      expect(avant.at(-1)?.tick ?? -1).toBeLessThan(changes[0] ?? 0);
    }

    // ---- 6. Rien de plus par tick ------------------------------------------
    expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
    expect([...b.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
  }, 30_000);

  it('le noir : PV hors lumiere qui baissent dans les SNAPSHOT, lanterne tombee → detruit, aucun etalage', async () => {
    const { room, a, b } = await salonADeux();
    room.debugStartEvent(graine(EVENT_KIND.NOIR));
    const lanterne = room.eventCarrier;
    expect([a.playerId, b.playerId]).toContain(lanterne);
    const autre = lanterne === a.playerId ? b.playerId : a.playerId;
    envelopper(room, () => {
      viderSauf(room, new Set());
      if (room.eventPoints !== null) {
        room.debugPlace(lanterne, CENTRE.x, CENTRE.y);
        room.debugPlace(autre, CENTRE.x + NOIR_LIGHT_RADIUS + 100, CENTRE.y);
      }
    });
    await dormir(1_500);
    // Le meme depart, 5 octets (n = 0), et l'octet d'etat dit la lanterne chez les deux.
    const departs = [a, b].map((c) => c.received.find((m) => m.type === MSG.EVENT_START));
    expect(departs[0]).toEqual(departs[1]);
    expect(departs[0]).toMatchObject({ kind: EVENT_KIND.NOIR, points: [] });
    for (const c of [a, b]) {
      expect([...(c.eventBytes.get(MSG.EVENT_START) ?? [])]).toEqual([5]);
      expect(etats(c).length).toBeGreaterThan(0);
      for (const e of etats(c)) {
        expect(e.cartHp).toBe(lanterne);
      }
    }
    const pv = snapshots(a).map((s) => s.players.find((p) => p.id === autre)?.hp ?? 0);
    expect(pv).toEqual([...pv].sort((x, y) => y - x));
    expect((pv[0] ?? 0) - (pv.at(-1) ?? 0)).toBeGreaterThanOrEqual(2);
    const pvLanterne = snapshots(a).map((s) => s.players.find((p) => p.id === lanterne)?.hp);
    expect(new Set(pvLanterne).size).toBe(1);

    room.debugKill(lanterne);
    const fins = await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.EVENT_END) ?? null,
          `EVENT_END (joueur ${c.playerId})`,
          3_000,
        ),
      ),
    );
    for (const f of fins) {
      expect(f).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.DETRUIT });
    }
    await dormir(1_000);
    for (const c of [a, b]) {
      expect(c.received.some((m) => m.type === MSG.DRAFT_OPEN)).toBe(false);
    }
    expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
  }, 30_000);

  it('la chasse : trois WAVE_ORDER de proies avant le meme EVENT_START (17 o), toutes tombees → etalage', async () => {
    const { room, a, b } = await salonADeux();
    room.debugStartEvent(graine(EVENT_KIND.CHASSE));
    const proies = new Set<number>();
    for (let i = 0; i < room.horde.count; i++) {
      if (room.horde.archetype[i] === PROIE_ARCHETYPE) {
        proies.add(room.horde.entityIdAt(i));
      }
    }
    expect(proies.size).toBe(3);
    envelopper(room, () => viderSauf(room, proies));
    await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.EVENT_START) ?? null,
          `EVENT_START (joueur ${c.playerId})`,
          3_000,
        ),
      ),
    );
    const ordresDe = (c: Client): WaveOrderMessage[] =>
      c.received.filter(
        (m): m is WaveOrderMessage => m.type === MSG.WAVE_ORDER && m.archetype === PROIE_ARCHETYPE,
      );
    expect(ordresDe(a)).toHaveLength(3);
    expect(ordresDe(a)).toEqual(ordresDe(b));
    for (const c of [a, b]) {
      const types = c.received.map((m) => m.type);
      const iDepart = types.indexOf(MSG.EVENT_START);
      expect(c.received.lastIndexOf(ordresDe(c).at(-1) as Message)).toBeLessThan(iDepart);
      expect([...(c.eventBytes.get(MSG.EVENT_START) ?? [])]).toEqual([17]);
    }
    await dormir(500);
    room.horde.kill([...proies]);
    await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.DRAFT_OPEN) ?? null,
          `DRAFT_OPEN (joueur ${c.playerId})`,
          5_000,
        ),
      ),
    );
    for (const c of [a, b]) {
      expect(c.received.find((m) => m.type === MSG.EVENT_END)).toEqual({
        type: MSG.EVENT_END,
        outcome: EVENT_OUTCOME.REUSSI,
      });
      expect(drapeauxDEvenement(c.received)).toEqual([true]);
    }
    expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
  }, 30_000);

  it('le siege : sans defenseur la progression reste nulle, cinq ennemis l abattent — aucun etalage', async () => {
    const { room, a, b } = await salonADeux();
    room.debugStartEvent(graine(EVENT_KIND.SIEGE));
    const totem = room.eventPoints?.[0];
    if (!totem) {
      throw new Error('un totem');
    }
    room.horde.spawn({
      waveId: 61_016,
      spawnTick: room.tick,
      seed: 1,
      archetype: 0,
      formation: FORMATION.SCATTER,
      anchorX: totem.x,
      anchorY: totem.y,
      count: 5,
    });
    const frappeurs = new Set(Array.from({ length: 5 }, (_, k) => entityIdOf(61_016, k)));
    envelopper(room, () => {
      viderSauf(room, frappeurs);
      for (let i = 0; i < room.horde.count; i++) {
        room.horde.x[i] = totem.x;
        room.horde.y[i] = totem.y;
      }
    });
    const fins = await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.EVENT_END) ?? null,
          `EVENT_END (joueur ${c.playerId})`,
          15_000,
        ),
      ),
    );
    for (const f of fins) {
      expect(f).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.DETRUIT });
    }
    const departs = [a, b].map((c) => c.received.find((m) => m.type === MSG.EVENT_START));
    expect(departs[0]).toEqual(departs[1]);
    expect(departs[0]).toMatchObject({ kind: EVENT_KIND.SIEGE, points: [totem] });
    expect([...(a.eventBytes.get(MSG.EVENT_START) ?? [])]).toEqual([9]);
    const pv = etats(a).map((e) => e.cartHp);
    expect(pv[0]).toBe(255);
    expect(pv).toEqual([...pv].sort((x, y) => y - x));
    for (const e of etats(a)) {
      expect(e.progress).toBe(0);
    }
    await dormir(1_000);
    expect(a.received.some((m) => m.type === MSG.DRAFT_OPEN)).toBe(false);
    expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
  }, 30_000);
});
