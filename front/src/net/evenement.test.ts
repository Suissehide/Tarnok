import { PORTEUR_ARCHETYPE, PROIE_ARCHETYPE } from '@shared/archetypes';
import { LEVEL_RESUME_TICKS, PLAYER_SPEED, TICK_HZ } from '@shared/constants';
import {
  EVENT_DURATION_TICKS,
  EVENT_KIND,
  EVENT_OUTCOME,
  RELIQUE_CARRIER_SPEED,
  RELIQUE_CARRIER_SPEED_SOLO,
} from '@shared/evenements';
import { fireCooldown, lastFireAfterCarry } from '@shared/firing';
import { entityIdOf, Horde } from '@shared/horde';
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
import { BASE_WEAPON_ID } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EVENT_BANNER_MS, eventEndBanner, eventTargets, GameClient } from './client';

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
  solo: false,
  durationTicks: EVENT_DURATION_TICKS,
  points: [{ x: 4200, y: 3000 }],
};
const CONVOI: EventMessage = {
  type: MSG.EVENT_START,
  kind: EVENT_KIND.CONVOI,
  solo: false,
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
      solo: false,
      carrierId: 0,
      relic: null,
      startedAtMs: 10_000,
      targets: [{ x: 4200, y: 3000 }],
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

const RELIQUE: EventMessage = {
  type: MSG.EVENT_START,
  kind: EVENT_KIND.RELIQUE,
  solo: false,
  durationTicks: EVENT_DURATION_TICKS,
  points: [
    { x: 1000, y: 3000 },
    { x: 2500, y: 3000 },
  ],
};
const etat = (porteur: number): EventMessage => ({
  type: MSG.EVENT_STATE,
  progress: 0,
  cartX: 1000,
  cartY: 3000,
  cartHp: porteur,
});

/** Comme `connecte`, mais le joueur local vise a droite (il tire) et pousse a droite. */
function connecteTireur(): { client: GameClient; socket: FakeSocket } {
  const client = new GameClient(
    'ws://test',
    () => ({ x: 1, y: 0 }),
    vi.fn(),
    vi.fn(),
    () => ({ x: 1, y: 0 }),
  );
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

/**
 * `n` pas de horde. Avant chacun, si `reseau`, le SNAPSHOT du tick que le
 * serveur vient de faire (`hordeTick - 1` : le client simule le suivant).
 * Rend les ticks auxquels le client a tire l'arme de base pour `id`.
 */
function simule(
  client: GameClient,
  socket: FakeSocket,
  n: number,
  reseau = true,
  id = 1,
  allie = joueur(2),
): number[] {
  const tirs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = client.hordeTick;
    if (reseau) {
      socket.emit(encodeSnapshot(t - 1, 0, 0, [joueur(1), allie]));
    }
    horloge += 1000 / TICK_HZ;
    client.update(horloge, STEP);
    if (client.lastFireTickOf(id, BASE_WEAPON_ID) === t) {
      tirs.push(t);
    }
  }
  return tirs;
}

/** Le calendrier du SERVEUR (`Room#fireOne`) apres un port fini a `from - 1`, de `from` a `jusqua` exclu. */
function calendrier(last: number, from: number, jusqua: number, cd: number): number[] {
  const out: number[] = [];
  for (let t = Math.max(from, last + cd); t < jusqua; t += cd) {
    out.push(t);
  }
  return out;
}

describe('etape 16 : le bit solo et le porteur date au SNAPSHOT qui suit', () => {
  it('EVENT_START porte solo ; la vue le rend', () => {
    const { client, socket } = connecte();
    socket.emit(ev({ ...RELIQUE, solo: true }));
    expect(client.event?.solo).toBe(true);
  });

  it('un EVENT_STATE de relique puis un SNAPSHOT date D : le porteur vaut a partir de D + 1', () => {
    const { client, socket } = connecteTireur();
    socket.emit(ev(RELIQUE));
    simule(client, socket, 5);
    const D = client.hordeTick - 1;
    socket.emit(ev(etat(1)));
    // Sans son SNAPSHOT, l'octet attend.
    expect(client.event?.carrierId).toBe(0);
    socket.emit(encodeSnapshot(D, 0, 0, [joueur(1), joueur(2)]));
    // `hordeTick` = D + 1 : le prochain tick simule est deja porte.
    expect(client.hordeTick).toBe(D + 1);
    expect(client.event?.carrierId).toBe(1);
    expect(client.event?.relic).toBeNull();
    expect(client.event?.targets).toEqual([{ x: 2500, y: 3000 }]);
  });

  it('nominal : le miroir se tait de D + 1 a E et reprend au tick exact du serveur', () => {
    const { client, socket } = connecteTireur();
    socket.emit(ev(RELIQUE));
    const libres = simule(client, socket, 12);
    expect(libres.length).toBeGreaterThan(1);
    const last = libres.at(-1) ?? 0;
    const D = client.hordeTick - 1;
    socket.emit(ev(etat(1)));
    socket.emit(encodeSnapshot(D, 0, 0, [joueur(1), joueur(2)]));
    expect(simule(client, socket, 30)).toEqual([]);
    const E = client.hordeTick - 1;
    socket.emit(ev(etat(0)));
    socket.emit(encodeSnapshot(E, 0, 0, [joueur(1), joueur(2)]));
    const cd = fireCooldown(client.loadoutOf(1), BASE_WEAPON_ID, 0);
    expect(simule(client, socket, 20)).toEqual(calendrier(last, E + 1, E + 21, cd));
  });

  /**
   * ⚠️ **La fin du port apprise EN RETARD** (le client a deja simule E + 1 a
   * E + 7) : le serveur a tire a E + 1 et E + 5 sans que le client ne dessine
   * rien. Sans le recalage, le client tirerait a E + 8 — une phase decalee
   * pour le reste de la run. Avec, il tire a E + 9, comme le serveur.
   */
  it('livraison apprise en retard : recalage, puis exactement le calendrier du serveur', () => {
    const { client, socket } = connecteTireur();
    socket.emit(ev(RELIQUE));
    const last = simule(client, socket, 12).at(-1) ?? 0;
    const D = client.hordeTick - 1;
    socket.emit(ev(etat(1)));
    socket.emit(encodeSnapshot(D, 0, 0, [joueur(1), joueur(2)]));
    simule(client, socket, 30);
    const E = client.hordeTick - 1;
    // Le reseau se tait 7 ticks : le client avance, toujours muet.
    expect(simule(client, socket, 7, false)).toEqual([]);
    socket.emit(ev(etat(0)));
    socket.emit(encodeSnapshot(E, 0, 0, [joueur(1), joueur(2)]));
    const cd = fireCooldown(client.loadoutOf(1), BASE_WEAPON_ID, 0);
    const serveur = calendrier(last, E + 1, E + 8 + 20, cd);
    expect(client.lastFireTickOf(1, BASE_WEAPON_ID)).toBe(serveur.filter((t) => t < E + 8).at(-1));
    expect(simule(client, socket, 20)).toEqual(serveur.filter((t) => t >= E + 8));
  });

  it('un allie porteur : le miroir ne tire pas pour lui non plus', () => {
    const { client, socket } = connecteTireur();
    const vise = { ...joueur(2), aimX: 127 };
    socket.emit(ev(RELIQUE));
    expect(simule(client, socket, 12, true, 2, vise).length).toBeGreaterThan(0);
    const D = client.hordeTick - 1;
    socket.emit(ev(etat(2)));
    socket.emit(encodeSnapshot(D, 0, 0, [joueur(1), vise]));
    expect(simule(client, socket, 30, true, 2, vise)).toEqual([]);
  });

  it('la prediction du porteur local : x 0,6, et x 0,8 en solo', () => {
    for (const [solo, facteur] of [
      [false, RELIQUE_CARRIER_SPEED],
      [true, RELIQUE_CARRIER_SPEED_SOLO],
    ] as const) {
      const { client, socket } = connecteTireur();
      socket.emit(ev({ ...RELIQUE, solo }));
      const D = client.hordeTick - 1;
      socket.emit(ev(etat(1)));
      socket.emit(encodeSnapshot(D, 0, 0, [joueur(1), joueur(2)]));
      // Dix images sans snapshot : l'erreur de reconciliation s'eteint (tau 33 ms).
      let x = 0;
      for (let i = 0; i < 11; i++) {
        horloge += 1000 / TICK_HZ;
        const avant = x;
        x = client.update(horloge, STEP).players.find((p) => p.id === 1)?.x ?? 0;
        if (i === 10) {
          expect(x - avant).toBeCloseTo((PLAYER_SPEED * facteur) / TICK_HZ, 2);
        }
      }
    }
  });

  it('noir : la lanterne datee de meme, sans recalage de tir', () => {
    const { client, socket } = connecte();
    socket.emit(ev({ ...RELIQUE, kind: EVENT_KIND.NOIR, points: [] }));
    socket.emit(ev(etat(2)));
    socket.emit(encodeSnapshot(client.hordeTick - 1, 0, 0, [joueur(1), joueur(2)]));
    expect(client.event?.carrierId).toBe(2);
    expect(client.event?.targets).toEqual([{ x: 100, y: 100 }]);
  });
});

describe('etape 16 : une relique qui s eteint ENCORE portee', () => {
  /**
   * Le serveur n'envoie aucun EVENT_STATE « au sol » : il efface l'evenement
   * a E et leve le garde de tir a E + 1. Apprise en retard, cette fin doit
   * recaler l'ancien porteur comme une chute.
   */
  it('EVENT_END (EXPIRE) appris en retard : recalage, puis le calendrier du serveur', () => {
    const { client, socket } = connecteTireur();
    socket.emit(ev(RELIQUE));
    const last = simule(client, socket, 12).at(-1) ?? 0;
    const D = client.hordeTick - 1;
    socket.emit(ev(etat(1)));
    socket.emit(encodeSnapshot(D, 0, 0, [joueur(1), joueur(2)]));
    simule(client, socket, 30);
    const E = client.hordeTick - 1;
    expect(simule(client, socket, 7, false)).toEqual([]);
    const avant = client.lastFireTickOf(1, BASE_WEAPON_ID);
    socket.emit(ev({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.EXPIRE }));
    socket.emit(encodeSnapshot(E, 0, 0, [joueur(1), joueur(2)]));
    expect(client.event).toBeNull();
    const cd = fireCooldown(client.loadoutOf(1), BASE_WEAPON_ID, 0);
    expect(client.lastFireTickOf(1, BASE_WEAPON_ID)).toBe(
      lastFireAfterCarry(avant, E + 1, client.hordeTick, cd),
    );
    const serveur = calendrier(last, E + 1, E + 8 + 20, cd);
    expect(simule(client, socket, 20)).toEqual(serveur.filter((t) => t >= E + 8));
  });

  it('EVENT_END sans porteur : rien ne bouge, et un EVENT_START suivant repart d une horloge neuve', () => {
    const { client, socket } = connecteTireur();
    socket.emit(ev(RELIQUE));
    simule(client, socket, 12);
    const avant = client.lastFireTickOf(1, BASE_WEAPON_ID);
    socket.emit(ev({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.EXPIRE }));
    socket.emit(encodeSnapshot(client.hordeTick - 1, 0, 0, [joueur(1), joueur(2)]));
    expect(client.lastFireTickOf(1, BASE_WEAPON_ID)).toBe(avant);
    socket.emit(ev(RELIQUE));
    expect(client.event?.carrierId).toBe(0);
  });
});

describe('etape 16 : eventTargets — vers quoi pointent les fleches', () => {
  const vide = new Horde(8);
  const base = { cart: null, relic: null, carrierId: 0 };
  const pts = [
    { x: 10, y: 20 },
    { x: 30, y: 40 },
  ];

  it('sceaux, forge, siege : leurs points ; convoi : le chariot', () => {
    for (const kind of [EVENT_KIND.SCEAUX, EVENT_KIND.FORGE, EVENT_KIND.SIEGE]) {
      expect(eventTargets({ ...base, kind, points: pts }, vide, [], 1)).toEqual(pts);
    }
    expect(
      eventTargets(
        { ...base, kind: EVENT_KIND.CONVOI, points: pts, cart: { x: 5, y: 6 } },
        vide,
        [],
        1,
      ),
    ).toEqual([{ x: 5, y: 6 }]);
  });

  it('relique : au sol la relique, portee l autel', () => {
    const r = { ...base, kind: EVENT_KIND.RELIQUE, points: pts };
    expect(eventTargets({ ...r, relic: { x: 7, y: 8 } }, vide, [], 1)).toEqual([{ x: 7, y: 8 }]);
    expect(eventTargets({ ...r, carrierId: 2 }, vide, [], 1)).toEqual([{ x: 30, y: 40 }]);
  });

  it('chasse : chaque proie vivante de la horde du client', () => {
    const h = new Horde(16);
    h.spawn({
      waveId: 7,
      spawnTick: 0,
      seed: 7,
      archetype: PROIE_ARCHETYPE,
      formation: FORMATION.POINT,
      anchorX: 500,
      anchorY: 600,
      count: 2,
    });
    h.spawn({
      waveId: 8,
      spawnTick: 0,
      seed: 8,
      archetype: 0,
      formation: FORMATION.POINT,
      anchorX: 50,
      anchorY: 60,
      count: 3,
    });
    const cibles = eventTargets({ ...base, kind: EVENT_KIND.CHASSE, points: pts }, h, [], 1);
    expect(cibles).toHaveLength(2);
    for (const c of cibles) {
      expect(Math.hypot(c.x - 500, c.y - 600)).toBeLessThan(100);
    }
  });

  it('noir : le porteur de lanterne (dernier SNAPSHOT) ; rien si c est soi', () => {
    const joueurs = [
      { id: 1, x: 1, y: 2 },
      { id: 2, x: 3, y: 4 },
    ];
    const n = { ...base, kind: EVENT_KIND.NOIR, points: [], carrierId: 2 };
    expect(eventTargets(n, vide, joueurs, 1)).toEqual([{ x: 3, y: 4 }]);
    expect(eventTargets(n, vide, joueurs, 2)).toEqual([]);
  });
});

describe('etape 16 : les bandeaux des quatre evenements', () => {
  it('au depart, un bandeau par genre ; eventCount compte (le son « evenement » en depend)', () => {
    const textes: Record<number, string> = {
      [EVENT_KIND.SIEGE]: 'Un totem appelle ses défenseurs !',
      [EVENT_KIND.RELIQUE]: 'Une relique attend son porteur !',
      [EVENT_KIND.CHASSE]: 'Des proies rôdent !',
      [EVENT_KIND.NOIR]: 'La nuit tombe !',
    };
    for (const [kind, texte] of Object.entries(textes)) {
      const { client, socket } = connecte();
      socket.emit(ev({ ...FORGE, kind: Number(kind) }));
      expect(client.eventBanner).toBe(texte);
      expect(client.eventCount).toBe(1);
    }
  });

  it('a la fin, par (genre, issue) : le genre est lu AVANT d effacer le miroir', () => {
    const fin = (kind: number, outcome: number): string | null => {
      const { client, socket } = connecte();
      socket.emit(ev({ ...FORGE, kind }));
      socket.emit(ev({ type: MSG.EVENT_END, outcome }));
      return client.eventBanner;
    };
    expect(fin(EVENT_KIND.SIEGE, EVENT_OUTCOME.DETRUIT)).toBe('Le totem est tombé…');
    expect(fin(EVENT_KIND.NOIR, EVENT_OUTCOME.DETRUIT)).toBe("La lanterne s'éteint…");
    expect(fin(EVENT_KIND.CONVOI, EVENT_OUTCOME.DETRUIT)).toBe('Le convoi est détruit…');
    expect(fin(EVENT_KIND.RELIQUE, EVENT_OUTCOME.EXPIRE)).toBe("L'événement s'éteint…");
    expect(fin(EVENT_KIND.CHASSE, EVENT_OUTCOME.REUSSI)).toBe('Réussi — étalage de règles !');
  });

  it('sans miroir (arrive en cours d evenement), le texte de l issue seule', () => {
    expect(eventEndBanner(null, EVENT_OUTCOME.DETRUIT)).toBe('Le convoi est détruit…');
    expect(eventEndBanner(null, EVENT_OUTCOME.EXPIRE)).toBe("L'événement s'éteint…");
  });
});
