import { TICK_HZ } from '@shared/constants';
import {
  decode,
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

const joueur = (id: number) => ({ id, x: 100, y: 100, hp: 100, aimX: 0, aimY: 0, pickupRadius: 0 });

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

  it('l annonce pose le ping, date au tick de horde de la reception', () => {
    const { client, socket } = connecte();
    socket.emit(encodePingShown(2, 1, 300, 400));
    expect(client.pings.get(2)).toEqual({
      playerId: 2,
      intent: 1,
      x: 300,
      y: 400,
      tick: client.hordeTick,
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
