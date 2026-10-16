import { ABILITY_COOLDOWN_TICKS, VERB_IDS } from '@shared/abilities';
import {
  FIELD_INPUT_DELAY_TICKS,
  FLOWFIELD_HZ,
  ROLLBACK_DEPTH_TICKS,
  TICK_HZ,
} from '@shared/constants';
import {
  decode,
  encodeAbilityUsed,
  encodeLobby,
  encodeSnapshot,
  encodeWelcome,
  MSG,
  NO_WEAPON,
} from '@shared/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GameClient } from './client';

/**
 * Le miroir client des verbes (etape 8, taches 6 et 7, et la touche du verbe).
 * Les classes s'epinglent en nombres nus : 2 Appat, 3 Relais.
 */
const APPAT = 2;
const RELAIS = 3;
const STEP = 1 / TICK_HZ;

/** Faux `WebSocket`, meme principe que `client.test.ts`. */
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

const joueur = (id: number, x: number, y: number) => ({
  id,
  x,
  y,
  hp: 100,
  aimX: 0,
  aimY: 0,
  pickupRadius: 0,
  shield: 0,
});

/** Un client connecte, joueur local 1 de classe `classe`, au tick 0, joueurs 1 et 2 poses. */
function connecte(classe: number): { client: GameClient; socket: FakeSocket } {
  const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
  client.connect();
  const socket = FakeSocket.last;
  if (!socket) {
    throw new Error('aucune socket');
  }
  socket.emit(
    encodeLobby(1, [
      { playerId: 1, weaponId: NO_WEAPON, classId: classe },
      { playerId: 2, weaponId: NO_WEAPON, classId: 0 },
    ]),
  );
  socket.emit(encodeWelcome(1, 0, 0x51ee_d0));
  socket.emit(encodeSnapshot(0, 0, 0, [joueur(1, 100, 100), joueur(2, 3000, 3000)]));
  client.update(0, STEP);
  return { client, socket };
}

describe('etape 8 tache 7 : le miroir recale sa prediction sur un Relais', () => {
  it('apres l annonce, la position predite EGALE la destination, sans interpolation', () => {
    const { client, socket } = connecte(RELAIS);
    socket.emit(encodeAbilityUsed(1, 1, VERB_IDS.relais, 3000, 3000, 2));
    expect(client.localPosition).toEqual({ x: 3000, y: 3000 });
  });

  it('le Relais d un AUTRE joueur ne deplace pas le joueur local', () => {
    const { client, socket } = connecte(RELAIS);
    const avant = client.localPosition;
    socket.emit(encodeAbilityUsed(1, 2, VERB_IDS.relais, 100, 100, 1));
    expect(client.localPosition).toEqual(avant);
  });
});

describe('la touche du verbe', () => {
  it('envoie ABILITY avec le point vise, et ne prejuge de rien', () => {
    const { client, socket } = connecte(RELAIS);
    socket.sent.length = 0;
    client.useAbility(1234, 567);
    const trames = socket.sent.map((b) => decode(b)).filter((m) => m.type === MSG.ABILITY);
    expect(trames).toHaveLength(1);
    expect(trames[0]).toMatchObject({ aimX: 1234, aimY: 567 });
    // Le client propose : aucune recharge tant que le salon n'a rien annonce.
    expect(client.abilityCooldownTicks).toBe(0);
  });

  it('la recharge se derive de l ANNONCE du joueur local, jamais d un autre', () => {
    const { client, socket } = connecte(RELAIS);
    socket.emit(encodeAbilityUsed(0, 2, VERB_IDS.relais, 100, 100, 1));
    expect(client.abilityCooldownTicks).toBe(0);
    socket.emit(encodeAbilityUsed(0, 1, VERB_IDS.relais, 3000, 3000, 2));
    expect(client.abilityCooldownTicks).toBe(ABILITY_COOLDOWN_TICKS.relais - client.hordeTick);
    expect(client.localClassId).toBe(RELAIS);
  });
});

describe('etape 8 tache 6 : le miroir plante le leurre', () => {
  /**
   * Le leurre doit atteindre l'entree du champ du CLIENT : le scenario AP2 de
   * `shared/horde.replication.test.ts` eprouve l'algorithme, ce test-ci le
   * CABLAGE — `#feedFields` substitue bien les leurres annonces.
   */
  it('un leurre annonce remplace son lanceur dans le reciblage de la horde', () => {
    const { client, socket } = connecte(APPAT);
    const spy = vi.spyOn(client.horde, 'retarget');
    socket.emit(encodeAbilityUsed(1, 1, VERB_IDS.appat, 2500, 900, 0));
    for (let t = 1; t <= FIELD_INPUT_DELAY_TICKS + 6; t++) {
      socket.emit(encodeSnapshot(t, 0, 0, [joueur(1, 100, 100), joueur(2, 3000, 3000)]));
      client.update(t * STEP, STEP);
    }
    const vus = spy.mock.calls.map((c) => [...(c[0] as number[])]);
    expect(vus.some((xs) => xs[0] === 2500)).toBe(true);
  });

  /**
   * Le leurre annonce EN RETARD : des champs ont deja ete nourris sans lui, le
   * miroir restaure l'anneau et REJOUE. Le rejeu doit substituer le leurre lui
   * aussi — sinon la horde rejouee suit le lanceur, et le serveur le leurre.
   * Le tick de l'annonce n'est PAS un tick de champ : seuls les reciblages du
   * rejeu sont observes.
   */
  it('un leurre annonce en retard est substitue PENDANT le rejeu', () => {
    const steps = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    let present = FIELD_INPUT_DELAY_TICKS + 3 * steps;
    while (present % steps === 0) {
      present++;
    }
    const ne = present - ROLLBACK_DEPTH_TICKS + 2;
    // Garde du decor : au moins un champ du rejeu lit des positions vivantes du leurre.
    const champsRejoues = Array.from({ length: present - ne }, (_, i) => ne + 1 + i).filter(
      (t) => t % steps === 0 && t - FIELD_INPUT_DELAY_TICKS >= ne,
    );
    expect(champsRejoues.length).toBeGreaterThan(0);

    const { client, socket } = connecte(APPAT);
    for (let t = 1; t < present; t++) {
      socket.emit(encodeSnapshot(t, 0, 0, [joueur(1, 100, 100), joueur(2, 3000, 3000)]));
      client.update(t * STEP, STEP);
    }
    socket.emit(encodeAbilityUsed(ne, 1, VERB_IDS.appat, 2500, 900, 0));
    const spy = vi.spyOn(client.horde, 'retarget');
    socket.emit(encodeSnapshot(present, 0, 0, [joueur(1, 100, 100), joueur(2, 3000, 3000)]));
    client.update(present * STEP, STEP);

    expect(client.lateDecoys).toBe(0);
    const vus = spy.mock.calls.map((c) => [...(c[0] as number[])]);
    expect(vus.length).toBeGreaterThan(0);
    expect(vus.some((xs) => xs[0] === 2500)).toBe(true);
  });

  /** La paire : sans leurre, le joueur 1 reste lui-meme dans l'entree du champ. */
  it('sans leurre, le reciblage garde la position du joueur', () => {
    const { client, socket } = connecte(APPAT);
    const spy = vi.spyOn(client.horde, 'retarget');
    for (let t = 1; t <= FIELD_INPUT_DELAY_TICKS + 6; t++) {
      socket.emit(encodeSnapshot(t, 0, 0, [joueur(1, 100, 100), joueur(2, 3000, 3000)]));
      client.update(t * STEP, STEP);
    }
    const vus = spy.mock.calls.map((c) => [...(c[0] as number[])]);
    expect(vus.length).toBeGreaterThan(0);
    expect(vus.every((xs) => xs[0] === 100)).toBe(true);
  });
});
