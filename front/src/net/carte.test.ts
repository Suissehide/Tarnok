import { FLOWFIELD_CELL, MAP_SIZE, TICK_HZ } from '@shared/constants';
import { FlowField } from '@shared/flowfield';
import { encodeSnapshot, encodeWelcome } from '@shared/protocol';
import { generateWorld, TERRAIN } from '@shared/worldmap';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GameClient } from './client';
import { PredictedPlayer } from './prediction';

const STEP = 1 / TICK_HZ;

/** Faux `WebSocket`, meme principe que `client.test.ts`. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readonly #listeners = new Map<string, ((event: { data: ArrayBuffer }) => void)[]>();
  binaryType = '';
  readyState = 0;

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  addEventListener(type: string, cb: (event: { data: ArrayBuffer }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), cb]);
  }

  send(): void {
    // Rien a envoyer.
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

/** La premiere cellule d'eau a l'est du centre, sur la rangee du milieu, pour `seed`. */
function rivageEst(seed: number): { x: number; y: number } {
  const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
  const world = generateWorld(seed, probe.cols, probe.rows);
  const cy = Math.floor(probe.rows / 2);
  let cx = Math.floor(probe.cols / 2);
  while (world.terrain[cy * probe.cols + cx] !== TERRAIN.WATER) {
    cx++;
  }
  return { x: cx * FLOWFIELD_CELL, y: cy * FLOWFIELD_CELL + FLOWFIELD_CELL / 2 };
}

describe('la prediction bute sur le decor, comme le serveur', () => {
  it('PredictedPlayer s arrete devant une cellule bloquee', () => {
    const map = { mask: new Uint8Array([0, 0, 1, 0]), cols: 4, rows: 1, cellSize: 100 };
    const p = new PredictedPlayer(150, 50, map);
    for (let i = 0; i < 60; i++) {
      p.predict(1, 0, STEP);
    }
    expect(p.simX).toBeLessThan(200);
  });

  it('le client donne a sa prediction la carte du WELCOME', () => {
    const seed = 11;
    const rivage = rivageEst(seed);
    const client = new GameClient('ws://test', () => ({ x: 1, y: 0 }), vi.fn());
    client.connect();
    const socket = FakeSocket.last;
    if (!socket) {
      throw new Error('aucune socket');
    }
    socket.emit(encodeWelcome(1, 0, seed));
    const depart = rivage.x - 3 * FLOWFIELD_CELL;
    socket.emit(
      encodeSnapshot(0, 0, 0, [
        { id: 1, x: depart, y: rivage.y, hp: 100, aimX: 0, aimY: 0, pickupRadius: 0 },
      ]),
    );
    for (let t = 0; t < 3 * TICK_HZ; t++) {
      client.update(t * STEP, STEP);
    }
    const x = client.localPosition?.x ?? Number.POSITIVE_INFINITY;
    expect(x).toBeLessThan(rivage.x);
    expect(x).toBeGreaterThan(depart);
  });
});
