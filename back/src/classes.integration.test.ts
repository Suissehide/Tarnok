import type { AddressInfo } from 'node:net';
import { REMPART_ARMOR, VERB_IDS } from '@shared/abilities';
import { CONTACT_DAMAGE } from '@shared/constants';
import {
  decode,
  encodeAbility,
  encodeHello,
  encodePick,
  encodeStart,
  type Message,
  MSG,
  NO_WEAPON,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_BYTES,
  zoneElement,
  zoneReaction,
} from '@shared/protocol';
import { FORMATION } from '@shared/waves';
import { startingWeapons, weaponOf } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import * as accounts from './accounts';
import { buildServer } from './server';

/**
 * Le livrable de l'etape 8 : **un joueur choisit une classe au salon, et son
 * verbe agit dans la partie.** Vraies sockets, du `PICK` a l'effet, observe a
 * travers le DECODAGE — jamais depuis l'etat interne du salon. La seule
 * ecriture interne est un DECOR (le monstre du Rempart), jamais une mesure.
 *
 * Le harnais est DUPLIQUE de `lobby.integration.test.ts`, pas importe :
 * aucun fichier d'integration de ce depot n'en importe un autre.
 *
 * La derive serveur/client des verbes qui touchent la simulation (Appat) est
 * eprouvee a 0,000 px par le scenario AP de `shared/horde.replication.test.ts`.
 */

/** Classes en nombres nus, comme le fil : 0 Amorce, 1 Rempart, 2 Appat, 3 Relais. */
const AMORCE = 0;
const REMPART = 1;
const APPAT = 2;
const RELAIS = 3;

type App = Awaited<ReturnType<typeof buildServer>>;

let app: App;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  await accounts.prisma.account.deleteMany();
  app = await buildServer({ roomSeed: 1, waitingRoom: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    ws.close();
  }
  await app.close();
});

interface Client {
  ws: WebSocket;
  recus: Message[];
  /** La taille BRUTE de chaque trame recue, par type : c'est elle que le fil paie. */
  tailles: { type: number; octets: number }[];
}

async function entre(code: string): Promise<Client> {
  const { token } = await accounts.createAccount();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  sockets.push(ws);
  const c: Client = { ws, recus: [], tailles: [] };
  ws.on('message', (data: ArrayBuffer) => {
    const m = decode(data);
    c.recus.push(m);
    c.tailles.push({ type: m.type, octets: data.byteLength });
  });
  await new Promise((res) => ws.once('open', res));
  ws.send(encodeHello(token));
  return c;
}

async function jusqua<T>(lire: () => T | undefined, quoi: string): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const v = lire();
    if (v !== undefined) {
      return v;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`rien recu : ${quoi}`);
}

type De<T extends number> = Extract<Message, { type: T }>;
const derniers = <T extends number>(c: Client, type: T): De<T>[] =>
  c.recus.filter((m) => m.type === type) as De<T>[];

/**
 * Un salon dont chaque joueur a choisi (classe, arme) au salon, partie lancee
 * par l'hote, chacun ayant recu son WELCOME et un premier snapshot.
 */
async function partie(
  choix: readonly { classe: number; arme?: number }[],
): Promise<{ salon: string; clients: Client[] }> {
  const res = await app.inject({ method: 'POST', url: '/rooms' });
  const salon = res.json<{ code: string }>().code;
  const clients: Client[] = [];
  for (const [i, c] of choix.entries()) {
    const client = await entre(salon);
    clients.push(client);
    await jusqua(
      () => (derniers(client, MSG.LOBBY).at(-1)?.players.length === i + 1 ? true : undefined),
      `lobby a ${i + 1}`,
    );
    client.ws.send(encodePick(c.arme ?? NO_WEAPON, c.classe));
    await jusqua(
      () =>
        derniers(client, MSG.LOBBY)
          .at(-1)
          ?.players.find((p) => p.playerId === i + 1)?.classId === c.classe
          ? true
          : undefined,
      `classe ${c.classe} enregistree`,
    );
  }
  clients[0]?.ws.send(encodeStart());
  for (const c of clients) {
    await jusqua(() => derniers(c, MSG.SNAPSHOT).at(-1), 'premier snapshot');
  }
  return { salon, clients };
}

const positionDe = (c: Client, id: number): { x: number; y: number } => {
  const p = derniers(c, MSG.SNAPSHOT)
    .at(-1)
    ?.players.find((j) => j.id === id);
  if (!p) {
    throw new Error(`joueur ${id} absent du snapshot`);
  }
  return { x: p.x, y: p.y };
};

const armeElementaire = (): number => {
  const w = startingWeapons().find((id) => weaponOf(id).element !== 0);
  if (w === undefined) {
    throw new Error('aucune arme elementaire au catalogue');
  }
  return w;
};

describe('etape 8 : le livrable, un verbe par classe, de PICK a l effet', () => {
  it('Amorce : l annonce, puis la zone de l element de l arme, sans reaction', async () => {
    const arme = armeElementaire();
    const { clients } = await partie([{ classe: AMORCE, arme }]);
    const [c] = clients as [Client];
    c.ws.send(encodeAbility(0, 2000, 2100));

    const annonce = await jusqua(() => derniers(c, MSG.ABILITY_USED)[0], 'ABILITY_USED');
    expect(annonce).toMatchObject({ playerId: 1, verb: VERB_IDS.amorce, x: 2000, y: 2100 });
    const zone = await jusqua(
      () => derniers(c, MSG.ZONE).find((z) => z.x === 2000 && z.y === 2100),
      'ZONE',
    );
    expect(zoneElement(zone.kind)).toBe(weaponOf(arme).element);
    expect(zoneReaction(zone.kind)).toBe(0);
  });

  it('Rempart : l allie dans la zone encaisse moins, mesure dans le snapshot', async () => {
    const { salon, clients } = await partie([{ classe: REMPART }, { classe: AMORCE }]);
    const [hote] = clients as [Client, Client];
    const allie = positionDe(hote, 2);
    hote.ws.send(encodeAbility(0, allie.x, allie.y));
    await jusqua(() => derniers(hote, MSG.ABILITY_USED)[0], 'ABILITY_USED');

    // Le DECOR : un monstre pose sur l'allie. La mesure, elle, passe par le fil.
    const room = app.rooms.get(salon);
    if (!room) {
      throw new Error('salon introuvable');
    }
    room.horde.spawn({
      waveId: 990_001,
      spawnTick: room.tick,
      seed: 1,
      archetype: 0,
      formation: FORMATION.SCATTER,
      anchorX: allie.x,
      anchorY: allie.y,
      count: 1,
    });
    room.horde.x[room.horde.count - 1] = allie.x;
    room.horde.y[room.horde.count - 1] = allie.y;

    const pvAvant =
      derniers(hote, MSG.SNAPSHOT)
        .at(-1)
        ?.players.find((p) => p.id === 2)?.hp ?? 0;
    const pvApres = await jusqua(() => {
      const hp = derniers(hote, MSG.SNAPSHOT)
        .at(-1)
        ?.players.find((p) => p.id === 2)?.hp;
      return hp !== undefined && hp < pvAvant ? hp : undefined;
    }, 'un coup encaisse');
    // Le snapshot porte les PV en entier : on compare a l'arrondi du fil.
    expect(pvAvant - pvApres).toBeCloseTo(CONTACT_DAMAGE * (1 - REMPART_ARMOR), 0);
    expect(pvAvant - pvApres).toBeLessThan(CONTACT_DAMAGE);
  });

  it('Appat : l annonce porte le point du leurre, et le leurre pose l element de l arme', async () => {
    const arme = armeElementaire();
    const { clients } = await partie([{ classe: APPAT, arme }]);
    const [c] = clients as [Client];
    c.ws.send(encodeAbility(0, 1500, 2500));

    const annonce = await jusqua(() => derniers(c, MSG.ABILITY_USED)[0], 'ABILITY_USED');
    expect(annonce).toMatchObject({ playerId: 1, verb: VERB_IDS.appat, x: 1500, y: 2500 });
    const zone = await jusqua(
      () => derniers(c, MSG.ZONE).find((z) => z.x === 1500 && z.y === 2500),
      'ZONE du leurre',
    );
    expect(zoneElement(zone.kind)).toBe(weaponOf(arme).element);
  });

  it('Relais : la cible est annoncee, et le snapshot suivant montre le lanceur sur elle', async () => {
    const { clients } = await partie([{ classe: RELAIS }, { classe: AMORCE }]);
    const [hote] = clients as [Client, Client];
    const allie = positionDe(hote, 2);
    expect(positionDe(hote, 1)).not.toEqual(allie);
    hote.ws.send(encodeAbility(0, allie.x, allie.y));

    const annonce = await jusqua(() => derniers(hote, MSG.ABILITY_USED)[0], 'ABILITY_USED');
    expect(annonce).toMatchObject({ playerId: 1, verb: VERB_IDS.relais, targetId: 2 });
    const vus = derniers(hote, MSG.SNAPSHOT).length;
    await jusqua(() => (derniers(hote, MSG.SNAPSHOT).length > vus ? true : undefined), 'snapshot');
    expect(positionDe(hote, 1)).toEqual(positionDe(hote, 2));
  });

  it('le SNAPSHOT ne grossit pas d un octet, verbes utilises ou non', async () => {
    // Nombres NUS : contrat de fil.
    // ⚠️ **L'etape 13 a paye un octet, assume.** `SNAPSHOT_PLAYER_BYTES` passe
    // de 10 a 11 : un `shield u8` dans l'enregistrement joueur, pour la carte
    // Transcendance (PV max contre bouclier) — un bouclier arbitre serveur,
    // qu'un client ne peut pas rederiver de son cote. Cout mesure : +0,12 ko/s
    // par client (62 -> 66 octets, 30 fois/s) et +0,47 ko/s d'egress serveur
    // pour un salon de quatre, soit environ 11 % du relevé de l'etape 3
    // (1,09 ko/s par joueur). La garde reste vivante : elle interdit toujours
    // qu'un octet s'ajoute sans qu'on en assume le cout, elle n'a fait
    // qu'absorber celui-ci.
    expect(SNAPSHOT_PLAYER_BYTES).toBe(11);
    expect(SNAPSHOT_HEADER_BYTES + 4 * SNAPSHOT_PLAYER_BYTES).toBe(66);

    const { clients } = await partie([{ classe: REMPART }]);
    const [c] = clients as [Client];
    c.ws.send(encodeAbility(0, 2000, 2000));
    await jusqua(() => derniers(c, MSG.ABILITY_USED)[0], 'ABILITY_USED');
    const vus = derniers(c, MSG.SNAPSHOT).length;
    await jusqua(
      () => (derniers(c, MSG.SNAPSHOT).length > vus + 3 ? true : undefined),
      'snapshots apres le verbe',
    );

    // ⚠️ La MESURE REELLE, comparee a une VALEUR — pas seulement a elle-meme.
    // Un instantane qui aurait grossi serait uniforme lui aussi, donc vert
    // contre lui-meme : c'est la septieme forme du « decor qui masque ».
    const tailles = c.tailles.filter((t) => t.type === MSG.SNAPSHOT).map((t) => t.octets);
    expect(tailles.length).toBeGreaterThan(0);
    expect(tailles.every((t) => t === SNAPSHOT_HEADER_BYTES + SNAPSHOT_PLAYER_BYTES)).toBe(true);
  });

  it('ABILITY_USED ne part QUE sur acceptation : deux demandes, une annonce', async () => {
    const { clients } = await partie([{ classe: REMPART }]);
    const [c] = clients as [Client];
    c.ws.send(encodeAbility(0, 2000, 2000));
    c.ws.send(encodeAbility(0, 2000, 2000));
    await jusqua(() => derniers(c, MSG.ABILITY_USED)[0], 'ABILITY_USED');
    await new Promise((r) => setTimeout(r, 500));
    expect(derniers(c, MSG.ABILITY_USED)).toHaveLength(1);
  });
});
