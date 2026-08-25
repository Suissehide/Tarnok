import { TICK_HZ } from '@shared/constants';
import { encodeSnapshot, encodeWaveOrder, encodeWelcome } from '@shared/protocol';
import { FORMATION } from '@shared/waves';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GameClient } from './client';

/**
 * Faux `WebSocket` : ni connexion reseau ni serveur, juste de quoi capturer
 * les ecouteurs et simuler l'arrivee de messages. `GameClient` n'importe pas
 * `WebSocket` explicitement — il lit le symbole global — donc le remplacer
 * globalement suffit a l'isoler du reseau.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly #listeners = new Map<string, ((event: { data: ArrayBuffer }) => void)[]>();
  binaryType = '';
  readyState = 0;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (event: { data: ArrayBuffer }) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(cb);
    this.#listeners.set(type, list);
  }

  send(): void {
    // Rien a envoyer : ce test n'exerce pas le chemin sortant.
  }

  close(): void {
    // Rien a fermer.
  }

  emit(type: string, event: { data: ArrayBuffer }): void {
    for (const cb of this.#listeners.get(type) ?? []) {
      cb(event);
    }
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

function latestSocket(): FakeSocket {
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (!socket) {
    throw new Error('aucune fausse socket creee');
  }
  return socket;
}

describe('GameClient — alignement du tick de la horde sur le WELCOME', () => {
  it('initialise hordeTick avec le tick absolu du WELCOME, pas avec zero', () => {
    // `WelcomeMessage.tick` est le tick ABSOLU du salon (`this.room.tick` cote
    // serveur), pas un compteur qui repart de zero par joueur. Un salon qui
    // vit depuis plusieurs minutes envoie un tick eleve a un joueur qui vient
    // tout juste de rejoindre.
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();

    latestSocket().emit('message', { data: encodeWelcome(1, 5000, 0xabc_def) });

    expect(client.hordeTick).toBe(5000);
  });

  it('calcule un rattrapage non nul pour un ordre emis avant le tick local courant', () => {
    // Sans l'alignement, `hordeTick` serait reste proche de zero alors que
    // `order.spawnTick` est un tick serveur absolu et eleve : la soustraction
    // `tick - spawnTick` serait massivement negative, `missed` clampe a zero
    // en permanence, et le rattrapage ne s'executerait jamais — exactement la
    // regression que ce test verrouille.
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();

    socket.emit('message', { data: encodeWelcome(1, 5000, 0xabc_def) });

    const spy = vi.spyOn(client.horde, 'spawnCatchingUp');

    const STEP = 1 / TICK_HZ;
    // Deux pas locaux avant que l'ordre n'arrive : le tick local passe de
    // 5000 a 5002.
    client.update(0, STEP);
    client.update(STEP, STEP);

    // L'ordre a ete emis au tick serveur 5000 : le client, qui en est
    // maintenant a 5002, doit rattraper deux pas.
    socket.emit('message', {
      data: encodeWaveOrder({
        waveId: 1,
        spawnTick: 5000,
        seed: 0x51ee_d001,
        archetype: 0,
        formation: FORMATION.CLUSTER,
        anchorX: 3000,
        anchorY: 3000,
        count: 10,
      }),
    });

    client.update(2 * STEP, STEP);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ spawnTick: 5000 }),
      2,
      STEP,
      expect.anything(),
    );
    expect(client.horde.count).toBe(10);
  });
});

describe('GameClient — hp du joueur local et xp d equipe', () => {
  it(
    'reprend hp du dernier snapshot pour le joueur local predit, ' +
      'la prediction ne simule que la position',
    () => {
      const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
      client.connect();
      const socket = latestSocket();

      socket.emit('message', { data: encodeWelcome(1, 0, 0) });
      socket.emit('message', {
        data: encodeSnapshot(0, 777, [{ id: 1, x: 10, y: 20, hp: 42 }]),
      });

      const state = client.update(0, 0);

      expect(state.players.find((p) => p.id === 1)).toMatchObject({ hp: 42 });
    },
  );

  it("reprend l'experience d'equipe du dernier snapshot, au niveau du RenderState", () => {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();

    socket.emit('message', { data: encodeWelcome(1, 0, 0) });
    socket.emit('message', {
      data: encodeSnapshot(0, 777, [{ id: 1, x: 10, y: 20, hp: 42 }]),
    });

    const state = client.update(0, 0);

    expect(state.xp).toBe(777);
  });
});
