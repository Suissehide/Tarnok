import { LEVEL_RESUME_TICKS, TICK_HZ } from '@shared/constants';
import { PING_LIFE_TICKS } from '@shared/ping';
import {
  decode,
  encodeDraftResult,
  encodeLevelUp,
  encodeLobby,
  encodePingShown,
  encodeSnapshot,
  encodeWelcome,
  MSG,
  NO_WEAPON,
} from '@shared/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GameClient } from './client';

const STEP = 1 / TICK_HZ;

class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readonly #listeners = new Map<string, ((event: { data: ArrayBuffer }) => void)[]>();
  readonly sent: ArrayBuffer[] = [];
  binaryType = '';
  readyState = 0;

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  addEventListener(type: string, cb: (event: { data: ArrayBuffer }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), cb]);
  }

  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    // Rien a fermer.
  }

  emit(data: ArrayBuffer): void {
    for (const cb of this.#listeners.get('message') ?? []) {
      cb({ data });
    }
  }
}

beforeEach(() => {
  FakeSocket.last = null;
  vi.stubGlobal('WebSocket', FakeSocket);
});

const joueur = (id: number) => ({
  id,
  x: 100,
  y: 100,
  hp: 100,
  aimX: 0,
  aimY: 0,
  pickupRadius: 0,
  shield: 0,
});

function connecte(): { client: GameClient; socket: FakeSocket } {
  const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
  client.connect();
  const socket = FakeSocket.last;
  if (!socket) {
    throw new Error('aucune socket');
  }
  socket.emit(
    encodeLobby(1, [
      { playerId: 1, weaponId: NO_WEAPON, classId: 0 },
      { playerId: 2, weaponId: NO_WEAPON, classId: 0 },
    ]),
  );
  socket.emit(encodeWelcome(1, 0, 0x51ee_d0));
  socket.emit(encodeSnapshot(0, 0, 0, [joueur(1), joueur(2)]));
  client.update(0, STEP);
  return { client, socket };
}

describe('etape 9 : le miroir client des pings', () => {
  it('sendPing envoie un PING et n affiche RIEN avant l annonce', () => {
    const { client, socket } = connecte();
    client.sendPing(2, 640, 480);
    expect(decode(socket.sent.at(-1) as ArrayBuffer)).toEqual({
      type: MSG.PING,
      intent: 2,
      x: 640,
      y: 480,
    });
    expect(client.pings.size).toBe(0);
  });

  it('l annonce pose le ping, date au tick de l horloge de ping (pas hordeTick) de la reception', () => {
    const { client, socket } = connecte();
    socket.emit(encodePingShown(2, 1, 300, 400));
    expect(client.pings.get(2)).toEqual({
      playerId: 2,
      intent: 1,
      x: 300,
      y: 400,
      tick: client.pingClock,
    });
    expect(client.pingCount).toBe(1);
    expect(client.lastPingIntent).toBe(1);
  });

  it('un nouveau ping du meme joueur remplace l ancien, celui d un autre s ajoute', () => {
    const { client, socket } = connecte();
    socket.emit(encodePingShown(2, 0, 1, 1));
    socket.emit(encodePingShown(2, 3, 2, 2));
    socket.emit(encodePingShown(1, 0, 3, 3));
    expect(client.pings.size).toBe(2);
    expect(client.pings.get(2)?.intent).toBe(3);
    expect(client.pingCount).toBe(3);
  });
});

describe('revue finale de l etape 9 : pingClock ne vieillit pas pendant le gel de niveau', () => {
  it('avance au meme rythme que hordeTick hors de tout gel', () => {
    const { client } = connecte();
    const hordeAvant = client.hordeTick;
    const pingAvant = client.pingClock;
    for (let i = 0; i < 20; i++) {
      client.update(0, STEP);
    }
    expect(client.pingClock - pingAvant).toBe(client.hordeTick - hordeAvant);
    expect(client.pingClock - pingAvant).toBe(20);
  });

  /**
   * Constat de la revue finale : un ping pose juste avant une montee de
   * niveau disparaissait pendant que l'equipe choisissait ses cartes, parce
   * que `#onPingShown` datait au `hordeTick` — qui avance a CHAQUE pas fixe,
   * gel ou pas (seul `#movementScale` ralentit le mouvement). `pingClock`,
   * lui, n'avance pas tant que `isFrozen` est vrai (gel strict ET rampe de
   * reprise — tache 24), ce qu'un gel plus long que `PING_LIFE_TICKS` suffit
   * a prouver : sans la correction, ce test echouerait avec l'ancien
   * comportement.
   */
  it('un ping recu juste avant un palier survit a un gel plus long que sa duree de vie', () => {
    const { client, socket } = connecte();
    socket.emit(encodePingShown(2, 1, 300, 400));
    const ping = client.pings.get(2);
    if (!ping) {
      throw new Error('ping absent');
    }
    const ageAvantGel = client.pingClock - ping.tick;

    const GEL_TICKS = PING_LIFE_TICKS + 30; // plus long que la duree de vie d un ping
    const freezeStart = client.hordeTick + 1;
    socket.emit(encodeLevelUp(freezeStart, 2));

    for (let i = 0; i < GEL_TICKS; i++) {
      client.update(0, STEP);
    }

    // Gele : l'age du ping sur l'horloge de ping n'a pas bouge, bien que le
    // gel ait dure plus longtemps que PING_LIFE_TICKS.
    expect(client.pingClock - ping.tick).toBe(ageAvantGel);
    expect(client.pingClock - ping.tick).toBeLessThan(PING_LIFE_TICKS);

    // Le serveur annonce la fin du gel ; la rampe de reprise (tache 24) gele
    // encore l'horloge de ping, puisque `isFrozen` la couvre aussi.
    socket.emit(encodeDraftResult(client.hordeTick, []));
    for (let i = 0; i < LEVEL_RESUME_TICKS + 5; i++) {
      client.update(0, STEP);
    }
    expect(client.isFrozen).toBe(false);

    // Hors gel et hors rampe : l'horloge de ping avance de nouveau au meme
    // rythme que hordeTick.
    const pingApresRampe = client.pingClock;
    const hordeApresRampe = client.hordeTick;
    for (let i = 0; i < 10; i++) {
      client.update(0, STEP);
    }
    expect(client.pingClock - pingApresRampe).toBe(client.hordeTick - hordeApresRampe);
    expect(client.pingClock - pingApresRampe).toBe(10);
  });
});
