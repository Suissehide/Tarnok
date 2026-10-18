import { PORTEUR_ARCHETYPE } from '@shared/archetypes';
import { LEVEL_RESUME_TICKS, TICK_HZ } from '@shared/constants';
import { EVENT_DURATION_TICKS, EVENT_KIND, EVENT_OUTCOME } from '@shared/evenements';
import { entityIdOf } from '@shared/horde';
import {
  type EventMessage,
  encodeDeaths,
  encodeDraftResult,
  encodeEvent,
  encodeLevelUp,
  encodeLobby,
  encodeRunOver,
  encodeSnapshot,
  encodeWaveOrder,
  encodeWelcome,
  MSG,
  NO_WEAPON,
} from '@shared/protocol';
import { FORMATION } from '@shared/waves';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EVENT_BANNER_MS, GameClient } from './client';

/**
 * Le miroir client des evenements (etape 14, §6.5 et §7.1), sur le patron de
 * `ping.test.ts` : une fausse socket, des messages encodes par les VRAIS
 * encodeurs, et l'horloge murale bouchonnee.
 */

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

let horloge = 10_000;
beforeEach(() => {
  FakeSocket.last = null;
  vi.stubGlobal('WebSocket', FakeSocket);
  horloge = 10_000;
  vi.spyOn(performance, 'now').mockImplementation(() => horloge);
});
afterEach(() => {
  vi.restoreAllMocks();
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

const ev = (msg: EventMessage): ArrayBuffer => encodeEvent(msg);
const FORGE: EventMessage = {
  type: MSG.EVENT_START,
  kind: EVENT_KIND.FORGE,
  durationTicks: EVENT_DURATION_TICKS,
  points: [{ x: 4200, y: 3000 }],
};
const CONVOI: EventMessage = {
  type: MSG.EVENT_START,
  kind: EVENT_KIND.CONVOI,
  durationTicks: EVENT_DURATION_TICKS,
  points: [
    { x: 1000, y: 3000 },
    { x: 2500, y: 3000 },
  ],
};
const REUSSI: EventMessage = { type: MSG.EVENT_END, outcome: EVENT_OUTCOME.REUSSI };

describe('etape 14 : le client tient l evenement', () => {
  it('EVENT_START : la vue, 60 s restantes, un compteur, et le bandeau du genre pendant EVENT_BANNER_MS', () => {
    const { client, socket } = connecte();
    expect(client.event).toBeNull();
    expect(client.eventCount).toBe(0);
    socket.emit(ev(FORGE));
    expect(client.event).toEqual({
      kind: EVENT_KIND.FORGE,
      points: [{ x: 4200, y: 3000 }],
      progress: 0,
      secondsLeft: 60,
      cart: null,
      cartHp: 1,
    });
    expect(client.eventCount).toBe(1);
    expect(client.eventBanner).toBe("La forge s'allume !");
    horloge += EVENT_BANNER_MS - 1;
    expect(client.eventBanner).toBe("La forge s'allume !");
    horloge += 1;
    expect(client.eventBanner).toBeNull();
  });

  it('EVENT_STATE : la progression, et le chariot INTERPOLE sur 200 ms depuis sa position affichee', () => {
    const { client, socket } = connecte();
    socket.emit(ev(CONVOI));
    expect(client.event?.cart).toEqual({ x: 1000, y: 3000 });
    socket.emit(ev({ type: MSG.EVENT_STATE, progress: 51, cartX: 1012, cartY: 3000, cartHp: 204 }));
    expect(client.event?.progress).toBeCloseTo(0.2, 5);
    expect(client.event?.cartHp).toBeCloseTo(0.8, 5);
    expect(client.event?.cart).toEqual({ x: 1000, y: 3000 });
    horloge += 100;
    expect(client.event?.cart?.x).toBeCloseTo(1006, 5);
    horloge += 100;
    expect(client.event?.cart).toEqual({ x: 1012, y: 3000 });
    horloge += 500;
    expect(client.event?.cart).toEqual({ x: 1012, y: 3000 });
  });

  it('un EVENT_STATE sans depart (arrivee en cours d evenement) est ignore : pas de chariot fantome', () => {
    const { client, socket } = connecte();
    socket.emit(ev({ type: MSG.EVENT_STATE, progress: 99, cartX: 0, cartY: 0, cartHp: 255 }));
    expect(client.event).toBeNull();
  });

  it('les secondes restantes sont FIGEES pendant isFrozen, gel et rampe compris (pingClock)', () => {
    const { client, socket } = connecte();
    socket.emit(ev(FORGE));
    for (let i = 0; i < TICK_HZ; i++) {
      client.update(0, STEP);
    }
    expect(client.event?.secondsLeft).toBeCloseTo(59, 5);
    socket.emit(encodeLevelUp(client.hordeTick + 1, 2));
    for (let i = 0; i < 3 * TICK_HZ; i++) {
      client.update(0, STEP);
    }
    expect(client.event?.secondsLeft).toBeCloseTo(59, 5);
    socket.emit(encodeDraftResult(client.hordeTick, []));
    for (let i = 0; i < LEVEL_RESUME_TICKS + 5; i++) {
      client.update(0, STEP);
    }
    expect(client.isFrozen).toBe(false);
    const avant = client.event?.secondsLeft ?? 0;
    for (let i = 0; i < TICK_HZ; i++) {
      client.update(0, STEP);
    }
    expect(avant - (client.event?.secondsLeft ?? 0)).toBeCloseTo(1, 5);
  });

  it('EVENT_END : l evenement s efface, le bandeau de l issue s allume', () => {
    const { client, socket } = connecte();
    socket.emit(ev(CONVOI));
    socket.emit(ev({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.DETRUIT }));
    expect(client.event).toBeNull();
    expect(client.eventBanner).toBe('Le convoi est détruit…');
    socket.emit(ev(FORGE));
    socket.emit(ev({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.EXPIRE }));
    expect(client.eventBanner).toBe("L'événement s'éteint…");
    socket.emit(ev(FORGE));
    socket.emit(ev(REUSSI));
    expect(client.eventBanner).toBe('Réussi — étalage de règles !');
  });

  it('RUN_OVER : le client oublie l evenement', () => {
    const { client, socket } = connecte();
    socket.emit(ev(FORGE));
    socket.emit(encodeRunOver(500, 500, 3, 10));
    expect(client.event).toBeNull();
  });
});

describe('etape 14 : le client reconnait l etalage d evenement, sans un octet', () => {
  it('EVENT_END reussi puis LEVEL_UP : ce LEVEL_UP est un evenement, le suivant un niveau', () => {
    const { client, socket } = connecte();
    socket.emit(ev(FORGE));
    socket.emit(ev(REUSSI));
    socket.emit(encodeLevelUp(31, 1));
    expect(client.draftIsEvent).toBe(true);
    expect(client.draftIsChest).toBe(false);
    expect(client.level).toBe(1);
    socket.emit(encodeLevelUp(40, 2));
    expect(client.draftIsEvent).toBe(false);
  });

  it('un evenement expire ou detruit ne doit aucun etalage', () => {
    const { client, socket } = connecte();
    socket.emit(ev(FORGE));
    socket.emit(ev({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.EXPIRE }));
    socket.emit(encodeLevelUp(31, 2));
    expect(client.draftIsEvent).toBe(false);
  });

  /** La meme priorite que le salon (§5.1) : coffre, puis evenement, puis niveau. */
  it('DEATHS du porteur et EVENT_END reussi avant un meme LEVEL_UP : coffre, puis evenement, puis niveau', () => {
    const { client, socket } = connecte();
    socket.emit(
      encodeWaveOrder({
        waveId: 4242,
        spawnTick: 0,
        seed: 7,
        archetype: PORTEUR_ARCHETYPE,
        formation: FORMATION.POINT,
        anchorX: 4500,
        anchorY: 3000,
        count: 1,
      }),
    );
    socket.emit(ev(FORGE));
    socket.emit(encodeDeaths(30, [entityIdOf(4242, 0)]));
    socket.emit(ev(REUSSI));
    const drapeaux: [boolean, boolean][] = [];
    for (const tick of [31, 40, 50]) {
      socket.emit(encodeLevelUp(tick, 1));
      drapeaux.push([client.draftIsChest, client.draftIsEvent]);
    }
    expect(drapeaux).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  /** Ecart n° 12 du plan : l'`EVENT_END` suffit, le depart n'est pas requis. */
  it('arrive en cours d evenement : son EVENT_END reussi compte quand meme l etalage', () => {
    const { client, socket } = connecte();
    socket.emit(ev(REUSSI));
    socket.emit(encodeLevelUp(31, 1));
    expect(client.draftIsEvent).toBe(true);
  });
});
