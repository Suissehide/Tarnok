import {
  FIELD_INPUT_DELAY_TICKS,
  MAP_SIZE,
  PLAYER_MAX_HP,
  PLAYER_SPEED,
  TICK_HZ,
} from '@shared/constants';
import { decodeSnapshot } from '@shared/protocol';
import { describe, expect, it } from 'vitest';

import { Room } from './room';

const DT = 1 / TICK_HZ;

/** Avance le salon d'une seconde de temps simule. */
function stepOneSecond(room: Room): void {
  for (let i = 0; i < TICK_HZ; i++) {
    room.step(DT);
  }
}

/** Outbox de test : elle garde ce qu'on lui pousse, comme le fera le serveur. */
function collector(): { sent: ArrayBuffer[]; push(msg: ArrayBuffer): void } {
  const sent: ArrayBuffer[] = [];
  return { sent, push: (msg) => sent.push(msg) };
}

function positionOf(room: Room, id: number): { x: number; y: number } {
  const out = collector();
  room.snapshot(out);
  const first = out.sent[0];
  if (!first) {
    throw new Error('aucun snapshot emis');
  }
  const found = decodeSnapshot(first).players.find((p) => p.id === id);
  if (!found) {
    throw new Error(`joueur ${id} absent du snapshot`);
  }
  return { x: found.x, y: found.y };
}

describe('Room.step', () => {
  it('avance un joueur a PLAYER_SPEED pixels par seconde a fond a droite', () => {
    const room = new Room();
    room.join(1);
    const before = positionOf(room, 1);

    room.applyInput(1, 1, 127, 0);
    stepOneSecond(room);

    expect(positionOf(room, 1).x - before.x).toBeCloseTo(PLAYER_SPEED, 0);
    expect(positionOf(room, 1).y).toBe(before.y);
  });

  it('ne va pas plus vite en diagonale qu en ligne droite', () => {
    const straight = new Room();
    straight.join(1);
    straight.applyInput(1, 1, 127, 0);

    const diagonal = new Room();
    diagonal.join(1);
    diagonal.applyInput(1, 1, 127, 127);

    const straightStart = positionOf(straight, 1);
    const diagonalStart = positionOf(diagonal, 1);
    stepOneSecond(straight);
    stepOneSecond(diagonal);

    const straightMoved = Math.hypot(
      positionOf(straight, 1).x - straightStart.x,
      positionOf(straight, 1).y - straightStart.y,
    );
    const diagonalMoved = Math.hypot(
      positionOf(diagonal, 1).x - diagonalStart.x,
      positionOf(diagonal, 1).y - diagonalStart.y,
    );

    expect(diagonalMoved).toBeCloseTo(straightMoved, 0);
  });

  it('est deterministe : deux salons, memes entrees, memes positions', () => {
    const a = new Room();
    const b = new Room();
    for (const room of [a, b]) {
      room.join(1);
      room.applyInput(1, 1, 90, -40);
      for (let i = 0; i < 100; i++) {
        room.step(DT);
      }
    }

    expect(positionOf(a, 1)).toEqual(positionOf(b, 1));
  });

  it('borne les joueurs a la carte', () => {
    const room = new Room();
    room.join(1);
    room.applyInput(1, 1, -127, -127);
    for (let i = 0; i < TICK_HZ * 120; i++) {
      room.step(DT);
    }

    expect(positionOf(room, 1)).toEqual({ x: 0, y: 0 });
  });

  it('incremente le tick a chaque pas', () => {
    const room = new Room();
    room.step(DT);
    room.step(DT);

    expect(room.tick).toBe(2);
  });
});

describe('Room.applyInput', () => {
  it("ignore sans planter l'entree d'un joueur absent", () => {
    const room = new Room();

    expect(() => room.applyInput(99, 1, 127, 127)).not.toThrow();
    expect(room.playerCount).toBe(0);
  });

  it('ignore une entree plus ancienne que la derniere appliquee', () => {
    const room = new Room();
    room.join(1);
    room.applyInput(1, 10, 127, 0);
    room.applyInput(1, 4, 0, 127);
    const before = positionOf(room, 1);

    stepOneSecond(room);

    // L'entree perimee n'a pas remplace la courante : on bouge toujours en x.
    expect(positionOf(room, 1).x - before.x).toBeCloseTo(PLAYER_SPEED, 0);
    expect(positionOf(room, 1).y).toBe(before.y);
  });
});

describe('Room.join / Room.leave', () => {
  it('place les joueurs a des positions de depart distinctes', () => {
    const room = new Room();
    room.join(1);
    room.join(2);

    expect(positionOf(room, 1)).not.toEqual(positionOf(room, 2));
  });

  it('fait disparaitre du snapshot un joueur qui part', () => {
    const room = new Room();
    room.join(1);
    room.join(2);
    room.leave(1);

    const out = collector();
    room.snapshot(out);
    const first = out.sent[0];
    if (!first) {
      throw new Error('aucun snapshot emis');
    }

    expect(decodeSnapshot(first).players.map((p) => p.id)).toEqual([2]);
  });

  it('refuse de depasser MAX_PLAYERS', () => {
    const room = new Room();
    for (let id = 1; id <= 4; id++) {
      expect(room.join(id)).toBe(true);
    }

    expect(room.join(5)).toBe(false);
    expect(room.playerCount).toBe(4);
  });
});

describe('Room.snapshot', () => {
  it('pousse dans l outbox un snapshot decodable portant le tick courant', () => {
    const room = new Room();
    room.join(1);
    room.step(DT);
    const out = collector();

    room.snapshot(out);

    const first = out.sent[0];
    if (!first) {
      throw new Error('aucun snapshot emis');
    }
    expect(decodeSnapshot(first).tick).toBe(1);
    expect(out.sent).toHaveLength(1);
  });

  it(
    'cable hp (personnel) et xp (d equipe) avec des valeurs fixes : ni degats ni ' +
      "experience n'existent encore cote serveur (tache 9)",
    () => {
      const room = new Room();
      room.join(1);
      const out = collector();

      room.snapshot(out);

      const first = out.sent[0];
      if (!first) {
        throw new Error('aucun snapshot emis');
      }
      const decoded = decodeSnapshot(first);
      expect(decoded.players[0]?.hp).toBe(PLAYER_MAX_HP);
      expect(decoded.xp).toBe(0);
    },
  );

  it("compte les octets emis et les micro-secondes d'encodage (§4.6)", () => {
    const room = new Room();
    room.join(1);
    room.join(2);
    const out = collector();

    room.snapshot(out);

    // 8 octets d'en-tete + 6 par joueur (SNAPSHOT_HEADER_BYTES + SNAPSHOT_PLAYER_BYTES).
    expect(room.metrics.bytesSent).toBe(20);
    expect(room.metrics.snapshots).toBe(1);
    expect(room.metrics.encodeMicros).toBeGreaterThanOrEqual(0);
  });

  it('remet les compteurs a zero quand on les draine', () => {
    const room = new Room();
    room.join(1);
    room.snapshot(collector());

    const drained = room.drainMetrics();

    expect(drained.bytesSent).toBe(14);
    expect(room.metrics.bytesSent).toBe(0);
  });
});

describe('la carte tient dans un int16', () => {
  it('MAP_SIZE ne peut pas depasser ce que le protocole sait encoder', () => {
    expect(MAP_SIZE).toBeLessThanOrEqual(32767);
  });
});

describe('Room et la horde', () => {
  it('fait apparaitre des vagues au fil du temps', () => {
    const room = new Room();
    room.join(1);
    for (let i = 0; i < TICK_HZ * 20; i++) {
      room.step(DT);
    }

    expect(room.horde.count).toBeGreaterThan(0);
  });

  it('met les ordres de vague dans une file que le serveur vide', () => {
    const room = new Room();
    room.join(1);
    for (let i = 0; i < TICK_HZ * 20; i++) {
      room.step(DT);
    }

    const ordres = room.drainWaveOrders();

    expect(ordres.length).toBeGreaterThan(0);
    expect(room.drainWaveOrders()).toHaveLength(0);
  });

  it('calcule ses champs sur des positions retardees, jamais sur les courantes', () => {
    const room = new Room();
    room.join(1);
    for (let i = 0; i < TICK_HZ; i++) {
      room.step(DT);
    }

    // Le serveur s'impose le retard qu'il inflige au client. Si cette
    // difference tombe a zero, c'est qu'il calcule sur les positions
    // courantes — et son champ devient irreproductible cote client.
    expect(room.tick - room.fieldInputTick).toBe(FIELD_INPUT_DELAY_TICKS);
  });

  it('a une graine de carte stable pendant toute la vie du salon', () => {
    const room = new Room();
    const graine = room.mapSeed;
    for (let i = 0; i < 100; i++) {
      room.step(DT);
    }

    expect(room.mapSeed).toBe(graine);
  });

  it(
    'signale dans ses metriques une vague tronquee par la capacite, ' +
      'plutot que de tronquer en silence',
    () => {
      // La horde sature a MAX_ENTITIES tant que rien ne meurt (§11 de la
      // spec — les morts arrivent a l'etape 3). Une troncature muette serait
      // un piege : ce test verrouille qu'elle reste visible dans le HUD.
      const room = new Room();
      room.join(1);
      // De quoi voir arriver plusieurs vagues et, une fois la horde pleine,
      // au moins une troncature.
      for (let i = 0; i < TICK_HZ * 130; i++) {
        room.step(DT);
      }

      expect(room.horde.count).toBeGreaterThan(0);
      expect(room.metrics.truncatedSpawns).toBeGreaterThan(0);
    },
  );

  it('remet le compteur de troncatures a zero au drainage', () => {
    const room = new Room();
    room.join(1);
    for (let i = 0; i < TICK_HZ * 130; i++) {
      room.step(DT);
    }
    expect(room.metrics.truncatedSpawns).toBeGreaterThan(0);

    const drained = room.drainMetrics();

    expect(drained.truncatedSpawns).toBeGreaterThan(0);
    expect(room.metrics.truncatedSpawns).toBe(0);
  });
});
