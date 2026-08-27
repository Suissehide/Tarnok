import { CARD, type Card } from '@shared/cards';
import {
  FIELD_INPUT_DELAY_TICKS,
  LEVEL_FREEZE_TICKS,
  LEVEL_RESUME_TICKS,
  MAP_SIZE,
  MAX_ENTITIES,
  PLAYER_MAX_HP,
  PLAYER_SPEED,
  TICK_HZ,
} from '@shared/constants';
import { passiveOf } from '@shared/passives';
import { Projectiles } from '@shared/projectiles';
import {
  decodeSnapshot,
  OUTCOME,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_BYTES,
} from '@shared/protocol';
import { FORMATION, type WaveOrder } from '@shared/waves';
import {
  BASE_WEAPON_ID,
  cooldownWithBonus,
  MAX_FIRE_RATE_BONUS,
  WEAPONS,
  weaponOf,
} from '@shared/weapons';
import { describe, expect, it, vi } from 'vitest';

import { type DraftOpenEvent, Room } from './room';

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

function hpOf(room: Room, id: number): number {
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
  return found.hp;
}

/** Visee telle que redistribuee par le SNAPSHOT (tache 13) — voir `hpOf`. */
function aimOf(room: Room, id: number): { aimX: number; aimY: number } {
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
  return { aimX: found.aimX, aimY: found.aimY };
}

/**
 * Fait viser `playerId` vers le monstre vivant le plus proche, comme le
 * ferait un vrai joueur avec sa souris (tache 13 : la visee n'est plus
 * derivee, elle doit etre poussee via `applyInput`, tick apres tick).
 *
 * Sert aux tests d'integration de ce fichier qui, avant la tache 13,
 * comptaient sur l'auto-visee du serveur pour faire avancer un pipeline de
 * combat sans piloter la souris. Aucun monstre vivant : n'envoie rien, la
 * visee nulle du dernier `applyInput` reste en vigueur (voir `Room.join`,
 * qui initialise `aimX`/`aimY` a 0).
 */
function aimAtNearestMonster(room: Room, playerId: number, seq: number): void {
  const pos = positionOf(room, playerId);
  let bestSlot = -1;
  let bestDist2 = Number.POSITIVE_INFINITY;
  for (let i = 0; i < room.horde.count; i++) {
    const dx = (room.horde.x[i] ?? 0) - pos.x;
    const dy = (room.horde.y[i] ?? 0) - pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestSlot = i;
    }
  }
  if (bestSlot < 0) {
    return;
  }
  const dx = (room.horde.x[bestSlot] ?? 0) - pos.x;
  const dy = (room.horde.y[bestSlot] ?? 0) - pos.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    // Monstre exactement sur le joueur : pas de direction, donc pas de tir —
    // meme regle que partout ailleurs (§ « direction nulle = pas de tir »).
    return;
  }
  room.applyInput(playerId, seq, 0, 0, (dx / len) * 127, (dy / len) * 127);
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

  it("initialise la visee a (0, 0) — pas de tir tant qu aucun INPUT n'est arrive (tache 13)", () => {
    const room = new Room();
    room.join(1);

    expect(aimOf(room, 1)).toEqual({ aimX: 0, aimY: 0 });
  });

  it('borne la visee redistribuee par SNAPSHOT a -127..127, comme le deplacement (tache 13)', () => {
    const room = new Room();
    room.join(1);

    room.applyInput(1, 1, 0, 0, 500, -500);

    expect(aimOf(room, 1)).toEqual({ aimX: 127, aimY: -127 });
  });

  it(
    'borne la visee AVANT de calculer l angle de tir, pas seulement a la redistribution ' +
      '(tache 13)',
    () => {
      // ⚠️ Le test precedent ne peut PAS attraper le retrait du clamp dans
      // `applyInput` lui-meme : `encodeSnapshot` requantifie deja aimX/aimY
      // independamment avant de les mettre sur le fil (`quantizeAxis`), donc
      // la valeur redistribuee resterait bornee meme sans lui — verifie par
      // mutation en ecrivant ce test. On espionne donc directement l'appel a
      // `Projectiles.fireSalvoDirected` pour observer ce que `#fireWeapons`
      // lui passe REELLEMENT, avant toute reserialisation. `aimX` demesure
      // (1000) a cote d'un `aimY` modeste (50) : sans clamp, l'angle de tir
      // serait bien plus plat (`atan2(50, 1000)`) qu'avec (`atan2(50, 127)`).
      const room = new Room();
      room.join(1);
      const spy = vi.spyOn(Projectiles.prototype, 'fireSalvoDirected');

      room.applyInput(1, 1, 0, 0, 1000, 50);
      room.step(DT);

      expect(spy).toHaveBeenCalled();
      const [, , , , dirX, dirY] = spy.mock.calls[0] ?? [];
      expect(dirX).toBe(127);
      expect(dirY).toBe(50);
      spy.mockRestore();
    },
  );

  it('ne normalise PAS la visee au cercle unite, contrairement au deplacement (tache 13)', () => {
    // ⚠️ Seul l'angle de la visee compte (`Math.atan2` dans
    // `Projectiles.fireSalvoDirected` ignore la norme) : rien ne justifie de
    // lui imposer le meme cercle unite qu'au deplacement (§ « on avance 41 %
    // plus vite en diagonale »), qui n'a de sens que pour une VITESSE.
    const room = new Room();
    room.join(1);

    room.applyInput(1, 1, 0, 0, 100, 100);

    expect(aimOf(room, 1)).toEqual({ aimX: 100, aimY: 100 });
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

    // En-tete + 2 joueurs (SNAPSHOT_HEADER_BYTES + n * SNAPSHOT_PLAYER_BYTES) —
    // derive des constantes, pas une valeur en dur : leur taille a change avec
    // la visee (tache 13), et ce test ne doit pas avoir a le savoir.
    expect(room.metrics.bytesSent).toBe(SNAPSHOT_HEADER_BYTES + 2 * SNAPSHOT_PLAYER_BYTES);
    expect(room.metrics.snapshots).toBe(1);
    expect(room.metrics.encodeMicros).toBeGreaterThanOrEqual(0);
  });

  it('remet les compteurs a zero quand on les draine', () => {
    const room = new Room();
    room.join(1);
    room.snapshot(collector());

    const drained = room.drainMetrics();

    expect(drained.bytesSent).toBe(SNAPSHOT_HEADER_BYTES + SNAPSHOT_PLAYER_BYTES);
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

  /**
   * Pre-remplit la horde pres de sa capacite, loin du joueur — hors de portee
   * d'arme (~607 px pour l'arme de base, tache 14) et de contact (34 px) — pour observer
   * une troncature SANS attendre qu'un vrai combat vide la horde ou tue le
   * joueur. Depuis la tache 9, la horde ne sature plus « tant que rien ne
   * meurt » (§11 de la spec, vrai a l'etape 2 seulement) : un joueur seul,
   * laisse au contact d'une horde qui grossit organiquement pendant 130 s,
   * meurt bien avant qu'elle n'atteigne MAX_ENTITIES — c'est precisement le
   * livrable de cette etape (« on finit par mourir »). Le remplissage direct
   * isole donc la mecanique de troncature de celle du combat.
   */
  function fillHordeFarFromPlayer(room: Room, count: number): void {
    const order: WaveOrder = {
      waveId: 999,
      spawnTick: room.tick,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.SCATTER,
      anchorX: 0,
      anchorY: 0,
      count,
    };
    room.horde.spawn(order);
  }

  it(
    'signale dans ses metriques une vague tronquee par la capacite, ' +
      'plutot que de tronquer en silence',
    () => {
      // Une troncature muette serait un piege : ce test verrouille qu'elle
      // reste visible dans le HUD (§4.6).
      const room = new Room();
      room.join(1);
      fillHordeFarFromPlayer(room, MAX_ENTITIES - 10);

      // Une seule periode de vague (PERIOD_TICKS = TICK_HZ * 6) suffit : la
      // horde pre-remplie ne laisse que 10 places, strictement sous le
      // plancher de la toute premiere vague (`WAVE1_MIN_COUNT`, tache 14 —
      // rampe de `WaveDirector`) — la troncature est donc garantie quel que
      // soit le tirage, sans dependre du reglage exact de la rampe.
      for (let i = 0; i < TICK_HZ * 6; i++) {
        room.step(DT);
      }

      expect(room.horde.count).toBeGreaterThan(0);
      expect(room.metrics.truncatedSpawns).toBeGreaterThan(0);
    },
  );

  it('remet le compteur de troncatures a zero au drainage', () => {
    const room = new Room();
    room.join(1);
    fillHordeFarFromPlayer(room, MAX_ENTITIES - 10);
    for (let i = 0; i < TICK_HZ * 6; i++) {
      room.step(DT);
    }
    expect(room.metrics.truncatedSpawns).toBeGreaterThan(0);

    const drained = room.drainMetrics();

    expect(drained.truncatedSpawns).toBeGreaterThan(0);
    expect(room.metrics.truncatedSpawns).toBe(0);
  });
});

/**
 * Fait apparaitre une seule entite a une position controlee, hors du
 * mecanisme normal de `WaveDirector` — meme technique que dans
 * `combat.test.ts` et les tests `shared/*.test.ts`.
 */
function spawnMonsterAt(room: Room, waveId: number, x: number, y: number): number {
  const order: WaveOrder = {
    waveId,
    spawnTick: room.tick,
    seed: 1,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: x,
    anchorY: y,
    count: 1,
  };
  room.horde.spawn(order);
  const slot = room.horde.count - 1;
  room.horde.x[slot] = x;
  room.horde.y[slot] = y;
  return room.horde.entityIdAt(slot);
}

describe("l'arbitrage de combat integre au salon (tache 9)", () => {
  it('tue un monstre a portee et met sa mort en file pour diffusion', () => {
    const room = new Room();
    room.join(1);
    const before = positionOf(room, 1);
    // A portee de l'arme de base (~607 px, tache 14) mais hors de
    // CONTACT_RADIUS (34 px) : isole le chemin "degats de projectile" du
    // chemin "contact".
    const targetId = spawnMonsterAt(room, 500, before.x + 100, before.y);

    let deaths: { tick: number; ids: number[] }[] = [];
    for (let i = 0; i < 30 && deaths.length === 0; i++) {
      // Visee tache 13 : sans elle, aimX/aimY restent a (0, 0) — voir
      // `Room.join` — et l'arme ne tire jamais.
      aimAtNearestMonster(room, 1, i + 1);
      room.step(DT);
      deaths = deaths.concat(room.drainDeaths());
    }

    expect(room.horde.count).toBe(0);
    expect(deaths.length).toBeGreaterThan(0);
    expect(deaths[0]?.ids).toEqual([targetId]);
  });

  it('ne tire jamais sur un monstre a portee si la visee reste nulle (tache 13)', () => {
    // ⚠️ C'est LA regle centrale de la tache 13 : la proximite d'un monstre ne
    // suffit plus a declencher un tir, contrairement a l'ancienne auto-visee
    // (§5.3 d'origine). Sans `aimAtNearestMonster`, ce test doit voir le
    // monstre survivre indefiniment malgre sa portee.
    const room = new Room();
    room.join(1);
    const before = positionOf(room, 1);
    spawnMonsterAt(room, 501, before.x + 100, before.y);

    for (let i = 0; i < 30; i++) {
      room.step(DT);
    }

    expect(room.horde.count).toBe(1);
    expect(room.drainDeaths()).toEqual([]);
  });

  it('une visee nulle ne consomme pas le cooldown : le premier tir reel part sans delai supplementaire', () => {
    // ⚠️ Ce test existe parce qu'une mutation qui retire le garde « visee
    // nulle » de `#fireWeapons` (en laissant `Projectiles.fireSalvoDirected`
    // seul juge, via son propre garde interne) ne fait echouer AUCUN autre
    // test de ce fichier : `horde.count` et les morts restent inchanges tant
    // que la visee est nulle, dans les deux versions — la salve ne part
    // jamais, `Projectiles` s'en charge deja. La seule difference observable
    // est que `p.lastFireTick` avancerait quand meme a chaque tick de
    // cooldown ecoule, meme sans salve : le VRAI premier tir, une fois la
    // visee non nulle, serait alors retarde d'un cooldown complet.
    //
    // Un seul salon (pas de comparaison entre deux salons independants : leur
    // `mapSeed` tire au hasard change la trajectoire du monstre pres des
    // obstacles et aurait rendu la comparaison instable). Le monstre est gele
    // a une distance FIXE du joueur tant que la visee reste nulle — sans quoi
    // il se rapproche via le flowfield, ce qui fausserait le temps de vol
    // mesure apres coup.
    const weapon = weaponOf(0);
    const room = new Room();
    room.join(1);
    const before = positionOf(room, 1);
    const spawnX = before.x + 80;
    const spawnY = before.y;
    spawnMonsterAt(room, 504, spawnX, spawnY);

    // ⚠️ Duree d'amorcage choisie a DESSEIN pas multiple du cooldown : sur un
    // multiple exact, la mutation retiree ci-dessus (garde de visee nulle)
    // finit par re-tomber en phase avec un vrai cooldown par pur hasard
    // arithmetique, et le test ne prouve plus rien (constate en ecrivant ce
    // test). `cooldownTicks + 3` garantit un reste non nul.
    let seq = 1;
    for (let i = 0; i < weapon.cooldownTicks + 3; i++) {
      room.applyInput(1, seq++, 0, 0, 0, 0);
      room.step(DT);
      room.horde.x[0] = spawnX;
      room.horde.y[0] = spawnY;
    }

    // Visee reelle, maintenant : un tir correct part DES CE TICK (le
    // cooldown n'a jamais ete entame par la phase de visee nulle qui
    // precede). Le monstre, plus attire par le flowfield que repousse (il se
    // rapproche encore du joueur pendant que le projectile vole), rend la
    // mort quasi immediate : mesure a 1 tick apres le tir sur ce reglage.
    // Sans le garde de visee nulle, le cooldown est arme des la phase de
    // visee (0, 0) et retarde le premier tir REEL de plusieurs ticks —
    // mesure a 5 ticks post-visee sur ce meme reglage, une fois le garde
    // retire (verifie par mutation). Le seuil ci-dessous separe nettement
    // les deux : tres au-dessus du cas correct, tres en-dessous du cas
    // mutant.
    room.applyInput(1, seq++, 0, 0, 127, 0);

    let deathTick = -1;
    for (let i = 0; i < 60 && deathTick < 0; i++) {
      room.step(DT);
      if (room.drainDeaths().length > 0) {
        deathTick = i;
      }
    }

    expect(deathTick).toBeGreaterThanOrEqual(0);
    expect(deathTick).toBeLessThanOrEqual(2);
  });

  it('tire dans la direction visee, pas necessairement vers le monstre le plus proche (tache 13)', () => {
    // ⚠️ Preuve que le tir est DIRIGE, pas cible : un monstre A l'ouest est le
    // plus proche, mais le joueur vise plein est, ou un second monstre B,
    // deux fois plus loin, se trouve pile sur la ligne de mire. Avec l'ancien
    // ciblage automatique (nearestTarget), A aurait ete tue en premier ; avec
    // la visee au curseur, seul B peut l'etre.
    const room = new Room();
    room.join(1);
    const before = positionOf(room, 1);
    const nearId = spawnMonsterAt(room, 502, before.x - 50, before.y);
    const farId = spawnMonsterAt(room, 503, before.x + 300, before.y);

    room.applyInput(1, 1, 0, 0, 127, 0); // plein est

    let deaths: { tick: number; ids: number[] }[] = [];
    for (let i = 0; i < 60 && deaths.length === 0; i++) {
      room.step(DT);
      deaths = deaths.concat(room.drainDeaths());
    }

    expect(deaths.length).toBeGreaterThan(0);
    expect(deaths[0]?.ids).toEqual([farId]);
    // Le monstre le plus proche, hors de la ligne de mire, est toujours vivant.
    expect(room.horde.slotOf(nearId)).toBeGreaterThanOrEqual(0);
  });

  it('endommage un joueur au contact et arrete d en faire mal pendant la fenetre d invulnerabilite', () => {
    const room = new Room();
    room.join(1);
    const before = positionOf(room, 1);
    // Contact et arme partagent la meme cible potentielle des qu'un monstre
    // est a portee de contact (34 px < ~607 px de portee d'arme, tache 14) :
    // avec un seul monstre, l'arme le tue au tick 1 (tir depuis la position
    // exacte du joueur, donc a distance nulle) et le contact ne voit plus
    // jamais rien. Plusieurs monstres au meme point absorbent les tirs
    // suivants (au plus un par fenetre de cooldown de l'arme, 7 ticks depuis
    // la tache 14) — mais ce que ce test verrouille, c'est que meme si tous
    // finissent par mourir, l'absence de degats jusqu'au tick 15 vient de la
    // fenetre d'invulnerabilite de CONTACT (elle decompte tick par tick,
    // qu'un monstre touche ou non), jamais du hasard de qui reste vivant.
    for (let i = 0; i < 3; i++) {
      spawnMonsterAt(room, 500 + i, before.x, before.y);
    }

    room.step(DT);
    const out1 = collector();
    room.snapshot(out1);
    const first = out1.sent[0];
    if (!first) {
      throw new Error('aucun snapshot');
    }
    expect(decodeSnapshot(first).players[0]?.hp).toBe(PLAYER_MAX_HP - 8); // CONTACT_DAMAGE

    // Toujours au contact : aucun degat supplementaire tant que la fenetre
    // d'invulnerabilite (15 ticks) n'est pas ecoulee.
    for (let i = 0; i < 14; i++) {
      room.step(DT);
    }
    const out2 = collector();
    room.snapshot(out2);
    const second = out2.sent[0];
    if (!second) {
      throw new Error('aucun snapshot');
    }
    expect(decodeSnapshot(second).players[0]?.hp).toBe(PLAYER_MAX_HP - 8);
  });

  it("l'experience gagnee est celle de l'equipe : elle vit dans l'entete du snapshot, jamais par joueur", () => {
    const room = new Room();
    room.join(1);
    room.join(2);
    const p1 = positionOf(room, 1);
    // Uniquement pres du JOUEUR 1 : si l'experience etait par joueur (elle ne
    // l'est pas — §2 de la spec d'orientation), seul le joueur 1 en verrait
    // le fruit. Le snapshot n'a de toute facon aucun champ xp par joueur.
    spawnMonsterAt(room, 500, p1.x + 60, p1.y);

    let ticks = 0;
    let xp = 0;
    while (xp === 0 && ticks < 60) {
      // Visee tache 13 : voir le commentaire du test precedent.
      aimAtNearestMonster(room, 1, ticks + 1);
      room.step(DT);
      ticks++;
      const out = collector();
      room.snapshot(out);
      const buf = out.sent[0];
      if (buf) {
        xp = decodeSnapshot(buf).xp;
      }
    }

    expect(xp).toBeGreaterThan(0);
  });

  it("gele le monde a la montee de niveau, date le tick d'effet, et reprend apres le gel", () => {
    const room = new Room();
    room.join(1);
    const before = positionOf(room, 1);
    // A un joueur, le seuil du niveau 1 vaut LEVEL_XP_BASE * 1 * 1 = 10 :
    // dix monstres a portee et a proximite de ramassage suffisent a le
    // franchir. Le joueur ne bouge PAS encore : un joueur en mouvement
    // s'eloignerait de ses propres cibles (260 px/s contre ~95 px/s pour un
    // monstre) plus vite qu'il ne peut les abattre, ce qui a ete verifie en
    // premiere version de ce test — le niveau n'arrivait qu'apres avoir
    // heurte le bord de la carte.
    //
    // ⚠️ En ANNEAU, pas alignes sur un segment (regression constatee tache
    // 14, en durcissant l'arme). Dix monstres colles en ligne, espaces de 2 px,
    // sont tous a moins de `SEPARATION_RADIUS` (28 px) les uns des autres : la
    // repulsion (tache 19 : `Horde#recomputeSteering`) les pousse activement
    // pendant qu'ils attendent leur tour d'etre cibles, et le dernier abattu peut deriver
    // au-dela d'`ORB_PICKUP_RADIUS` (90 px) avant de mourir — verifie en
    // mesurant sa distance au joueur a l'instant de sa mort : 116 px avec
    // l'arme reglee tache 14, contre 90 px de rayon de ramassage. Un anneau a
    // 50 px, espace de `2 * 50 * sin(pi/10) ≈ 30,9 px` entre voisins
    // immediats — juste au-dessus de `SEPARATION_RADIUS` — ne declenche
    // aucune repulsion mutuelle : chaque monstre reste a portee de ramassage
    // jusqu'a sa mort, quelle que soit la cadence de l'arme.
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2;
      spawnMonsterAt(
        room,
        1000 + i,
        before.x + Math.cos(angle) * 50,
        before.y + Math.sin(angle) * 50,
      );
    }

    let levelUps: { tick: number; level: number }[] = [];
    let ticks = 0;
    while (levelUps.length === 0 && ticks < 1000) {
      // Visee tache 13 : sans elle, l'arme ne tire jamais et l'anneau ne meurt
      // jamais — voir le commentaire du premier test de cette description.
      aimAtNearestMonster(room, 1, ticks + 1);
      room.step(DT);
      ticks++;
      levelUps = levelUps.concat(room.drainLevelUps());
    }

    expect(levelUps.length).toBeGreaterThan(0);
    expect(levelUps[0]?.level).toBe(2);
    // ⚠️ Date du tick ou le gel COMMENCE reellement, qui est desormais le tick
    // courant : l'etape 4 ouvre l'etalage au moment ou le niveau tombe, au lieu
    // de programmer un gel de duree constante un tick plus tard.
    //
    // La propriete que ce test garde n'a pas change — le message porte un tick
    // d'effet, et les clients gelent a CE tick plutot qu'a la reception (sans
    // quoi chacun gelerait selon sa latence). Seul le decalage de `+1`, qui
    // etait un artefact de la programmation a l'avance, a disparu.
    expect(levelUps[0]?.tick).toBe(room.tick);

    // Le joueur se met en mouvement seulement MAINTENANT, pour observer le
    // gel : un joueur qui bouge doit s'arreter net des le tick d'effet.
    //
    // ⚠️ `ticks + 1`, pas `1` : la boucle de visee ci-dessus a deja fait
    // avancer `lastSeq` bien au-dela de 1 (tache 13) — envoyer `seq: 1`
    // maintenant serait rejete par `isNewer` comme une entree perimee, et ce
    // mouvement n'aurait jamais lieu.
    room.applyInput(1, ticks + 1, 127, 0);
    // Un monstre au contact, pose juste avant le gel : le mouvement seul ne
    // suffit pas a prouver que « le monde » est gele au sens du §6.2 — sans
    // ce monstre, un gel qui suspendrait le DEPLACEMENT mais laisserait le
    // COMBAT continuer (tir automatique, contact, ramassage — aucun des
    // trois n'est modere par la rampe de vitesse, voir `#movementScale`)
    // passerait ce test inapercu, puisque plus aucun monstre n'est a portee
    // a cet instant. Verifie par mutation : retirer le garde de tete de
    // `step()` sans ce monstre laissait ce test vert.
    const atTrigger = positionOf(room, 1);
    spawnMonsterAt(room, 9000, atTrigger.x, atTrigger.y);
    const hpAtTrigger = hpOf(room, 1);
    const hordeCountAtTrigger = room.horde.count;
    room.drainDeaths(); // vide les morts accumulees pendant la phase de collecte, avant de mesurer

    // ⚠️ TROIS FOIS l'ancienne duree de gel. C'est le coeur de ce que la tache
    // 6 change : le gel ne dure plus une constante, il dure jusqu'a ce que le
    // draft se ferme. Un pas de `LEVEL_FREEZE_TICKS` ne verrait pas la
    // difference — celui-ci echoue des qu'une duree fixe reapparait.
    for (let i = 0; i < LEVEL_FREEZE_TICKS * 3; i++) {
      room.step(DT);
    }
    expect(positionOf(room, 1)).toEqual(atTrigger);
    // Le combat aussi est suspendu : ni degats de contact, ni mort du
    // monstre pose au tick precedent.
    expect(hpOf(room, 1)).toBe(hpAtTrigger);
    expect(room.horde.count).toBe(hordeCountAtTrigger);
    expect(room.drainDeaths()).toEqual([]);

    // La montee de niveau a bien ouvert un etalage, et c'est LUI qui tient le
    // gel ouvert.
    const opens = room.drainDraftOpens();
    expect(opens.length).toBe(1);
    expect(opens[0]?.cards.length).toBeGreaterThan(0);

    // Le joueur choisit : c'est ce geste, et rien d'autre, qui rend la main.
    expect(room.setDraftToken(1, 0)).toBe(true);
    room.step(DT);

    const results = room.drainDraftResults();
    // ⚠️ **UN SEUL resultat par draft** : la repioche a disparu, la resolution
    // est un seul moment. L'octet `phase` qui distinguait « termine » de
    // « repioche ouverte » n'existe plus.
    expect(results.length).toBe(1);
    // `deadlineTick` porte la fin du gel, que le client ne peut plus deduire
    // (§8 de la spec).
    expect(results[0]?.deadlineTick).toBe(room.tick);
    // La carte pointee est bien celle qui a ete gagnee, et elle a atterri dans
    // l'inventaire — sans quoi le draft serait une ceremonie sans effet.
    expect(results[0]?.outcomes).toEqual([{ playerId: 1, cardIndex: 0, outcome: 0 }]);
    const carte = opens[0]?.cards[0];
    const loadout = room.loadoutOf(1);
    if (!carte || !loadout) {
      throw new Error('etalage ou inventaire manquant');
    }
    if (carte.nature === CARD.PASSIVE) {
      expect(loadout.stacksOf(carte.refId)).toBe(1);
    } else {
      expect(loadout.stacksOfWeapon(carte.refId)).toBe(1);
    }

    // Reprend : apres la fermeture du draft et la rampe de reprise, le joueur
    // bouge de nouveau.
    for (let i = 0; i < LEVEL_RESUME_TICKS + 30; i++) {
      room.step(DT);
    }
    expect(positionOf(room, 1)).not.toEqual(atTrigger);
  });

  /**
   * Amene le salon au niveau 2 et rend l'etalage ouvert. Rend les cartes
   * tirees. Les monstres sont poses en ANNEAU autour du joueur 1 pour la
   * raison detaillee dans le test du gel ci-dessus.
   */
  function ouvreLEtalage(room: Room, monstres: number): readonly Card[] {
    const centre = positionOf(room, 1);
    for (let i = 0; i < monstres; i++) {
      const angle = (i / monstres) * Math.PI * 2;
      spawnMonsterAt(
        room,
        1000 + i,
        centre.x + Math.cos(angle) * 50,
        centre.y + Math.sin(angle) * 50,
      );
    }
    let ticks = 0;
    let opens: DraftOpenEvent[] = [];
    while (opens.length === 0 && ticks < 3000) {
      aimAtNearestMonster(room, 1, ticks + 1);
      room.step(DT);
      ticks++;
      opens = room.drainDraftOpens();
    }
    const cartes = opens[0]?.cards;
    if (!cartes || cartes.length === 0) {
      throw new Error(`aucun etalage apres ${ticks} ticks`);
    }
    return cartes;
  }

  /**
   * Ticks auxquels chaque arme a tire, sur `ticks` pas, visee fixe et non nulle.
   *
   * ⚠️ **Garder la fenetre courte quand on mesure une cadence.** Le generateur
   * lache une vague toutes les `TICK_HZ * 6` = 180 ticks ; le tir automatique
   * finit par en tuer assez pour faire monter de niveau, et le draft qui
   * s'ouvre gele le monde jusqu'a ce qu'un jeton soit pose — plus une seule
   * salve ensuite.
   *
   * Ce n'est donc PAS la periode des vagues qui borne la mesure (une premiere
   * version de ce commentaire l'affirmait, avec en prime un mauvais chiffre) :
   * c'est le temps qu'il faut aux morts pour franchir le seuil d'experience.
   * A 300 ticks et un seul joueur, la marge tient largement.
   */
  function ticksDeSalves(room: Room, ticks: number): Map<number, number[]> {
    const spy = vi.spyOn(Projectiles.prototype, 'fireSalvoDirected');
    room.applyInput(1, 1, 0, 0, 127, 0);
    for (let i = 0; i < ticks; i++) {
      room.step(DT);
    }
    const parArme = new Map<number, number[]>();
    for (const [arme, tick] of spy.mock.calls) {
      const liste = parArme.get(arme.id) ?? [];
      liste.push(tick);
      parArme.set(arme.id, liste);
    }
    spy.mockRestore();
    return parArme;
  }

  /**
   * Compte les salves par arme sur `ticks` pas, visee fixe et non nulle.
   * Rend une table `id d'arme -> nombre de salves`.
   */
  function salvesParArme(room: Room, ticks: number): Map<number, number> {
    const spy = vi.spyOn(Projectiles.prototype, 'fireSalvoDirected');
    room.applyInput(1, 1, 0, 0, 127, 0);
    for (let i = 0; i < ticks; i++) {
      room.step(DT);
    }
    const compte = new Map<number, number>();
    for (const [arme] of spy.mock.calls) {
      compte.set(arme.id, (compte.get(arme.id) ?? 0) + 1);
    }
    spy.mockRestore();
    return compte;
  }

  it('une arme draftee tire EN PLUS de l arme neutre, chacune a sa propre cadence', () => {
    const room = new Room();
    room.join(1);
    // La grenade (id 4) est l'arme la plus lente du catalogue : 75 ticks de
    // recharge contre 7 pour la dague neutre. L'ecart est ce qui rend le
    // defaut visible.
    const GRENADE = 4;
    const DAGUE = 0;
    const grenade = weaponOf(GRENADE);
    const dague = weaponOf(DAGUE);
    expect(grenade.cooldownTicks).toBeGreaterThan(dague.cooldownTicks * 5);

    const inv = room.loadoutOf(1);
    if (!inv) {
      throw new Error('inventaire manquant');
    }
    inv.addWeapon(GRENADE);

    const TICKS = 300;
    const compte = salvesParArme(room, TICKS);

    // Les deux ont tire.
    expect(compte.get(DAGUE) ?? 0).toBeGreaterThan(0);
    expect(compte.get(GRENADE) ?? 0).toBeGreaterThan(0);

    // ⚠️ **Le coeur de cette tache.** Chacune tire a SA cadence. Avec un
    // `lastFireTick` unique pour tout l'arsenal, la dague serait bridee a la
    // cadence de la grenade et les deux compteurs seraient EGAUX — un test qui
    // se contenterait de « des projectiles existent » passerait sans rien voir.
    //
    // `+1` de tolerance : la premiere salve part au tick 1 (recharge jamais
    // faite), donc le compte vaut `floor((TICKS - 1) / cooldown) + 1`.
    const attenduDague = Math.floor((TICKS - 1) / dague.cooldownTicks) + 1;
    const attenduGrenade = Math.floor((TICKS - 1) / grenade.cooldownTicks) + 1;
    expect(compte.get(DAGUE)).toBe(attenduDague);
    expect(compte.get(GRENADE)).toBe(attenduGrenade);
  });

  it('l arme neutre reste hors slots : cinq armes draftees font six salves au meme tick', () => {
    const room = new Room();
    room.join(1);
    const inv = room.loadoutOf(1);
    if (!inv) {
      throw new Error('inventaire manquant');
    }
    const DRAFTEES = [1, 2, 3, 5, 6];
    for (const id of DRAFTEES) {
      inv.addWeapon(id);
    }
    expect(inv.weaponSlotsUsed).toBe(DRAFTEES.length);

    // Un seul tick : aucune arme n'a jamais tire, donc toutes sont dues.
    const compte = salvesParArme(room, 1);

    // ⚠️ SIX, pas cinq. L'arme neutre du §6.1 vit hors des slots : elle ne
    // figure dans aucun `Loadout` et tire quand meme. Un `#fireWeapons` qui
    // se contenterait de parcourir `weaponIds` en oubliant l'arme de base
    // ferait cinq salves — et le joueur qui drafte sa premiere arme perdrait
    // celle avec laquelle il a commence.
    expect([...compte.values()].reduce((a, b) => a + b, 0)).toBe(DRAFTEES.length + 1);
    expect([...compte.keys()].sort((a, b) => a - b)).toEqual([0, ...DRAFTEES]);
  });

  it('empiler une arme ELARGIT sa salve d un projectile par exemplaire', () => {
    // ⚠️ **C'est ici que « l'accumulation des cartes fait la puissance »
    // devient observable dans le salon.** Une arme ne monte pas de niveau :
    // chaque carte prise ajoute UN projectile a sa salve. C'est le levier le
    // plus lisible a l'ecran — on VOIT sa salve s'elargir.
    //
    // ⚠️ L'arme choisie tire DEJA plusieurs projectiles (eventail, cinq) : sur
    // une arme a projectile unique, un code qui rendrait `stacks` au lieu de
    // `projectileCount + stacks - 1` donnerait exactement les memes nombres.
    const EVENTAIL = 1;
    const eventail = weaponOf(EVENTAIL);
    expect(eventail.projectileCount).toBeGreaterThan(1);
    const dague = weaponOf(BASE_WEAPON_ID);

    /** Projectiles de la premiere salve d'eventail, avec `exemplaires` cartes prises. */
    function projectilesDeLaSalve(exemplaires: number): number {
      const room = new Room();
      room.join(1);
      for (let i = 0; i < exemplaires; i++) {
        room.grantCard(1, { nature: CARD.WEAPON, refId: EVENTAIL });
      }
      expect(room.loadoutOf(1)?.stacksOfWeapon(EVENTAIL)).toBe(exemplaires);

      const spy = vi.spyOn(Projectiles.prototype, 'fireSalvoDirected');
      room.applyInput(1, 1, 0, 0, 127, 0);
      room.step(DT);
      const salve = spy.mock.calls.find((c) => c[0].id === EVENTAIL);
      const neutre = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
      spy.mockRestore();
      if (!salve || !neutre) {
        throw new Error('salve manquante');
      }
      // ⚠️ L'arme neutre vit hors des slots : elle n'est dans aucun `Loadout`,
      // donc jamais empilee — sa salve ne bouge pas d'un exemplaire a l'autre.
      // Sans ce garde, un `stacks` lu au mauvais endroit l'elargirait aussi.
      expect(neutre[7]).toBe(dague.projectileCount);
      return salve[7] ?? 0;
    }

    // Une seule carte n'elargit RIEN : c'est la deuxieme qui ajoute le premier
    // projectile.
    expect(projectilesDeLaSalve(1)).toBe(eventail.projectileCount);
    expect(projectilesDeLaSalve(2)).toBe(eventail.projectileCount + 1);
    expect(projectilesDeLaSalve(3)).toBe(eventail.projectileCount + 2);
  });

  describe('les passifs empiles changent un nombre mesurable (tache 8)', () => {
    const VITALITE = 0;
    const CADENCE = 1;
    const PUISSANCE = 2;
    const FOUGUE = 3;

    /** Donne `n` fois la carte de passif `id` au joueur 1, par le vrai chemin. */
    function prend(room: Room, id: number, n: number): void {
      const carte: Card = { nature: CARD.PASSIVE, refId: id };
      for (let i = 0; i < n; i++) {
        room.grantCard(1, carte);
      }
    }

    it('deux cartes de cadence retirent DEUX FOIS ce qu une seule retire', () => {
      const magnitude = passiveOf(CADENCE).magnitude;
      // La grenade, l'arme la plus lente du catalogue : sur la dague (7 ticks),
      // `round(7 * 0,92)` et `round(7 * 0,84)` valent tous deux 6 et
      // l'empilement serait invisible — voir le test de monotonie qui suit.
      const GRENADE = 4;
      const base = weaponOf(GRENADE).cooldownTicks;

      /** Intervalle constate entre deux salves de la grenade, avec `cartes` cartes. */
      function intervalle(cartes: number): number {
        const room = new Room();
        room.join(1);
        room.grantCard(1, { nature: CARD.WEAPON, refId: GRENADE });
        prend(room, CADENCE, cartes);
        // 300 ticks : trois intervalles de grenade, et surtout SOUS la periode
        // du generateur de vagues (voir `ticksDeSalves`).
        const tirs = ticksDeSalves(room, 300).get(GRENADE) ?? [];
        expect(tirs.length).toBeGreaterThanOrEqual(3);
        const ecarts = tirs.slice(1).map((t, i) => t - (tirs[i] ?? 0));
        // Un intervalle unique : la cadence est stable, pas moyennee.
        expect(new Set(ecarts).size).toBe(1);
        return ecarts[0] ?? 0;
      }

      const attendu = (cartes: number): number =>
        Math.max(1, Math.round(base * (1 - magnitude * cartes)));

      expect(intervalle(0)).toBe(attendu(0));
      expect(intervalle(1)).toBe(attendu(1));
      // **Le coeur de la tache.** Le modele Risk of Rain veut que CHAQUE carte
      // ajoute son bonus. Un code qui regarderait « ce passif est possede »
      // sans compter les exemplaires donnerait le meme intervalle qu'a une
      // carte — et un test qui se contenterait de « c'est plus rapide qu'a
      // zero carte » ne le verrait pas.
      expect(intervalle(2)).toBe(attendu(2));
      expect(intervalle(2)).toBeLessThan(intervalle(1));
      expect(intervalle(1)).toBeLessThan(intervalle(0));
      // Et le second pas retire bien autant que le premier, a l'arrondi pres.
      const premierPas = intervalle(0) - intervalle(1);
      const secondPas = intervalle(1) - intervalle(2);
      expect(Math.abs(premierPas - secondPas)).toBeLessThanOrEqual(1);
    });

    it('la cadence ne se degrade JAMAIS quand on prend une carte de plus', () => {
      // ⚠️ Le corollaire du test precedent, et le vrai risque de l'arrondi :
      // sur une arme rapide l'empilement peut ne rien changer, mais il ne doit
      // jamais RETIRER de cadence. Balaie tout le catalogue, de zero a douze
      // cartes — au-dela de la douzieme, le plafond `MAX_FIRE_RATE_BONUS`
      // aplatit la courbe, ce qui reste monotone.
      const magnitude = passiveOf(CADENCE).magnitude;
      for (const arme of WEAPONS) {
        let precedent = Number.POSITIVE_INFINITY;
        for (let cartes = 0; cartes <= 12; cartes++) {
          const recharge = cooldownWithBonus(arme.cooldownTicks, magnitude * cartes);
          expect(recharge).toBeLessThanOrEqual(precedent);
          expect(recharge).toBeGreaterThanOrEqual(1);
          precedent = recharge;
        }
      }
    });

    it('cooldownWithBonus : le plafond et le plancher, chacun sans l autre', () => {
      // ⚠️ Ces deux gardes se couvrent MUTUELLEMENT par le jeu : tant que le
      // plafond tient a 0,75, aucune arme du catalogue n'atteint le plancher,
      // et tant que le plancher tient, retirer le plafond ne casse pas la
      // monotonie. Les deux mutations survivaient donc a 323 tests. Elles
      // s'eprouvent ici directement, a des valeurs que le catalogue actuel
      // n'atteint pas — mais qu'une arme future atteindra.

      // Le PLAFOND : sans lui, un bonus de 5 donnerait une recharge negative,
      // ramenee a 1 par le plancher — l'arme tirerait a chaque tick.
      expect(cooldownWithBonus(100, 5)).toBe(25);
      expect(cooldownWithBonus(100, MAX_FIRE_RATE_BONUS)).toBe(25);
      // Au-dela du plafond, plus rien ne bouge : la carte suivante est inutile,
      // et c'est assume.
      expect(cooldownWithBonus(100, 0.9)).toBe(cooldownWithBonus(100, 0.75));

      // Le PLANCHER : une arme a un seul tick de recharge, au plafond, arrondit
      // a zero. Une recharge nulle ferait tirer plusieurs fois par tick si la
      // boucle de tir changeait.
      expect(cooldownWithBonus(1, MAX_FIRE_RATE_BONUS)).toBe(1);
      expect(cooldownWithBonus(2, MAX_FIRE_RATE_BONUS)).toBeGreaterThanOrEqual(1);

      // Un bonus negatif ne RALENTIT jamais : `Math.max(bonus, 0)`.
      expect(cooldownWithBonus(50, -1)).toBe(50);
    });

    it('deux cartes de vitalite ajoutent DEUX FOIS les points de vie, et soignent d autant', () => {
      const magnitude = passiveOf(VITALITE).magnitude;
      const room = new Room();
      room.join(1);
      expect(hpOf(room, 1)).toBe(PLAYER_MAX_HP);

      prend(room, VITALITE, 1);
      expect(hpOf(room, 1)).toBe(PLAYER_MAX_HP + magnitude);
      prend(room, VITALITE, 1);
      expect(hpOf(room, 1)).toBe(PLAYER_MAX_HP + magnitude * 2);
    });

    it('les points de vie depassent 255 sans se replier — le snapshot les porte sur deux octets', () => {
      // ⚠️ Ce test garde l'elargissement `u8 -> u16` de `SNAPSHOT_PLAYER_BYTES`
      // (tache 8). Avec un `u8`, huit cartes de vitalite (100 + 160 = 260)
      // rendaient 4 points de vie au decodage : le joueur passait de presque
      // trois barres de vie a la mort en un ramassage.
      const magnitude = passiveOf(VITALITE).magnitude;
      const cartes = Math.ceil((256 - PLAYER_MAX_HP) / magnitude);
      const room = new Room();
      room.join(1);
      prend(room, VITALITE, cartes);

      const attendu = PLAYER_MAX_HP + magnitude * cartes;
      expect(attendu).toBeGreaterThan(255);
      // `hpOf` lit le SNAPSHOT decode, pas l'etat interne : c'est bien le
      // transport qu'on eprouve ici.
      expect(hpOf(room, 1)).toBe(attendu);
    });

    it('deux cartes de fougue font parcourir DEUX FOIS le supplement d une seule', () => {
      const magnitude = passiveOf(FOUGUE).magnitude;

      function parcours(cartes: number): number {
        const room = new Room();
        room.join(1);
        prend(room, FOUGUE, cartes);
        const depart = positionOf(room, 1);
        room.applyInput(1, 1, 127, 0);
        const TICKS = 60;
        for (let i = 0; i < TICKS; i++) {
          room.step(DT);
        }
        return positionOf(room, 1).x - depart.x;
      }

      const sans = parcours(0);
      const une = parcours(1);
      const deux = parcours(2);

      const supplement = une - sans;
      expect(supplement).toBeGreaterThan(0);
      // La magnitude est en pixels par SECONDE : sur `TICKS` ticks a
      // `TICK_HZ`, le supplement attendu vaut `magnitude * TICKS / TICK_HZ`.
      const attendu = (magnitude * 60) / TICK_HZ;
      // Tolerance d'un pixel : `positionOf` lit le snapshot, ou les positions
      // sont arrondies a l'entier.
      expect(deux - sans).toBeGreaterThanOrEqual(supplement * 2 - 1);
      expect(deux - sans).toBeLessThanOrEqual(supplement * 2 + 1);
      // Et le supplement vaut bien la magnitude annoncee, sur une seconde
      // pleine de deplacement.
      expect(supplement).toBeCloseTo(attendu, 0);
    });

    it('deux cartes de puissance doublent le bonus de degats porte par le projectile', () => {
      // ⚠️ **Ce nombre ne change AUCUNE issue de combat aujourd'hui** : la
      // pietaille n'a pas de reserve de points de vie (voir `resolveCombat`),
      // un projectile qui touche est toujours letal. Le bonus est neanmoins
      // calcule et transporte, et c'est ici qu'on le verifie — sans quoi les
      // deux passifs de degats du catalogue seraient du code mort silencieux.
      const magnitude = passiveOf(PUISSANCE).magnitude;
      const base = weaponOf(BASE_WEAPON_ID).damage;

      function degatsDuPremierTir(cartes: number): number {
        const room = new Room();
        room.join(1);
        prend(room, PUISSANCE, cartes);
        const spy = vi.spyOn(Projectiles.prototype, 'fireSalvoDirected');
        room.applyInput(1, 1, 0, 0, 127, 0);
        room.step(DT);
        const appel = spy.mock.calls[0];
        spy.mockRestore();
        if (!appel) {
          throw new Error('aucune salve');
        }
        return appel[6] ?? base;
      }

      expect(degatsDuPremierTir(0)).toBeCloseTo(base, 5);
      expect(degatsDuPremierTir(1)).toBeCloseTo(base * (1 + magnitude), 5);
      expect(degatsDuPremierTir(2)).toBeCloseTo(base * (1 + magnitude * 2), 5);
    });

    it('les passifs d un joueur ne changent rien pour son voisin', () => {
      // Un `Loadout` par joueur, et pas un pour le salon : sans ca, la
      // premiere carte prise en cooperatif profiterait a toute l'equipe.
      const room = new Room();
      room.join(1);
      room.join(2);
      prend(room, FOUGUE, 3);
      expect(room.loadoutOf(1)?.bonus('speed')).toBe(passiveOf(FOUGUE).magnitude * 3);
      expect(room.loadoutOf(2)?.bonus('speed')).toBe(0);
    });
  });

  it('la carte disputee ne va qu au gagnant : le perdant ne recoit rien de ce tour', () => {
    const room = new Room();
    room.join(1);
    room.join(2);
    // Seuil du niveau 1 a deux joueurs : LEVEL_XP_BASE * 1 * 2 = 20.
    const cartes = ouvreLEtalage(room, 20);
    expect(cartes.length).toBeGreaterThan(1);

    // Les deux visent la MEME carte : le conflit est garanti, pas espere.
    expect(room.setDraftToken(1, 0)).toBe(true);
    expect(room.setDraftToken(2, 0)).toBe(true);
    room.step(DT);

    const results = room.drainDraftResults();
    expect(results.length).toBe(1);
    const issues = results[0]?.outcomes ?? [];
    const gagnant = issues.find((o) => o.outcome === OUTCOME.WON);
    const perdant = issues.find((o) => o.outcome === OUTCOME.LOST);
    if (!gagnant || !perdant) {
      throw new Error(`conflit non arbitre : ${JSON.stringify(issues)}`);
    }
    expect(gagnant.cardIndex).toBe(0);
    expect(perdant.cardIndex).toBe(0);

    // ⚠️ Le coeur de ce test : le perdant a POSE son jeton sur la carte 0 et
    // figure dans le meme lot de resultats que le gagnant. Rien dans la
    // structure du message ne distingue les deux — seul l'examen de
    // `outcome` le fait. Sans ce filtre, les deux joueurs empocheraient la
    // carte 0 et le conflit ne servirait a rien (verifie par mutation :
    // neutraliser le filtre laissait 310 tests verts).
    const carte = cartes[0];
    const inv = room.loadoutOf(perdant.playerId);
    if (!carte || !inv) {
      throw new Error('carte ou inventaire manquant');
    }
    if (carte.nature === CARD.PASSIVE) {
      expect(inv.stacksOf(carte.refId)).toBe(0);
    } else {
      expect(inv.stacksOfWeapon(carte.refId)).toBe(0);
    }
    // Et le gagnant, lui, l'a bien eue : sans cette moitie, un code qui ne
    // donnerait la carte a PERSONNE passerait aussi.
    const invGagnant = room.loadoutOf(gagnant.playerId);
    if (!invGagnant) {
      throw new Error('inventaire du gagnant manquant');
    }
    if (carte.nature === CARD.PASSIVE) {
      expect(invGagnant.stacksOf(carte.refId)).toBe(1);
    } else {
      expect(invGagnant.stacksOfWeapon(carte.refId)).toBe(1);
    }
  });

  it('deux niveaux gagnes au meme tick ouvrent deux drafts bout a bout, sans repit', () => {
    // ⚠️ Graine FIXE. La geometrie du tas d'orbes depend des obstacles, qui
    // derivent de `mapSeed` : avec une graine tiree au hasard, ce test echouait
    // environ une fois sur quatre. Un test intermittent est pire qu'un test
    // absent — on finit par l'ignorer.
    const room = new Room(0x7a11_c0de);
    room.join(1);
    const depart = positionOf(room, 1);
    // ⚠️ Le tas d'orbes se construit HORS portee de ramassage (200 px contre
    // ORB_PICKUP_RADIUS = 90) : sinon chaque orbe serait empoche a la mort du
    // monstre, l'experience arriverait au compte-gouttes et on ne verrait
    // jamais deux niveaux franchis dans le meme appel a `#gainXp`.
    //
    // On respawn au MEME point apres chaque mort, au lieu de poser trente
    // monstres d'un coup : un monstre vivant marche vers le joueur, donc
    // trente monstres poses ensemble mourraient echelonnes sur 700 px et le
    // tas serait etale. La, chacun meurt a quelques pixels de son point
    // d'apparition.
    const tas = { x: depart.x + 150, y: depart.y };
    // Seuils solo : 10 pour le niveau 2, 20 pour le niveau 3 — trente orbes
    // empoches d'un seul tick franchissent donc DEUX seuils d'un coup.
    //
    // ⚠️ On en amasse SOIXANTE, pas trente. Le tas s'etale sur une douzaine de
    // pixels — un monstre vit entre quatre et huit ticks selon la phase du tir,
    // et derive vers le joueur pendant ce temps — donc le joueur qui arrive
    // dessus n'en ramasse d'abord qu'une partie. Mesure : `+4`, `+4`, puis
    // `+34` d'un coup. Trente orbes ne donnaient que dix-neuf au tick decisif,
    // soit un seul niveau, et ce test ne prouvait plus rien.
    const ORBES = 60;
    let morts = 0;
    let ticks = 0;
    let waveId = 1000;
    // ⚠️ On suit NOTRE monstre par son identite, pas par `horde.count`. Ce
    // test dure au-dela du tick 360, ou le generateur de vagues lache sa
    // premiere vague : un compteur global cesserait alors d'atteindre zero et
    // le tas ne se remplirait plus jamais. Les monstres de cette vague
    // apparaissent bien plus loin que le tas, donc la visee ne les prend
    // jamais pour cible avant la fin de la boucle.
    let courant = -1;
    while (morts < ORBES && ticks < 700) {
      if (courant < 0 || room.horde.slotOf(courant) < 0) {
        courant = spawnMonsterAt(room, waveId++, tas.x, tas.y);
      }
      aimAtNearestMonster(room, 1, ticks + 1);
      room.step(DT);
      ticks++;
      for (const lot of room.drainDeaths()) {
        morts += lot.ids.length;
      }
    }
    expect(morts).toBe(ORBES);
    // Personne n'a encore monte de niveau : tout est reste par terre.
    expect(room.drainDraftOpens()).toEqual([]);

    // Le joueur marche sur le tas. `ticks + 1` : voir la note sur `isNewer`
    // dans le test de la rampe.
    room.applyInput(1, ticks + 1, 127, 0);
    let opens: DraftOpenEvent[] = [];
    let marche = 0;
    while (opens.length === 0 && marche < 200) {
      room.step(DT);
      marche++;
      opens = room.drainDraftOpens();
    }
    expect(opens.length).toBe(1);

    // ⚠️ LE point de ce test. Le premier draft se ferme ; le monde ne doit pas
    // reprendre la main entre les deux, meme pendant la rampe de reprise — le
    // second niveau attend et son etalage doit s'ouvrir AU TICK SUIVANT.
    const positionGelee = positionOf(room, 1);
    expect(room.setDraftToken(1, 0)).toBe(true);
    room.step(DT);
    const premier = room.drainDraftResults();
    expect(premier.length).toBe(1);
    expect(premier[0]?.deadlineTick).toBe(room.tick);

    room.step(DT);
    const second = room.drainDraftOpens();
    expect(second.length).toBe(1);
    // Le joueur n'a pas avance d'un pixel entre les deux etalages.
    expect(positionOf(room, 1)).toEqual(positionGelee);

    // Et le second se ferme comme le premier, rendant enfin la main.
    expect(room.setDraftToken(1, 0)).toBe(true);
    room.step(DT);
    expect(room.drainDraftResults()).toHaveLength(1);
    for (let i = 0; i < LEVEL_RESUME_TICKS + 10; i++) {
      room.step(DT);
    }
    expect(positionOf(room, 1)).not.toEqual(positionGelee);
    // ⚠️ On ne verifie PAS qu'aucun troisieme etalage ne s'ouvre ensuite, et
    // une premiere version de ce test le faisait a tort : une douzaine d'orbes
    // restent au sol apres les deux niveaux, le joueur les ramasse des qu'il
    // reprend la main, et un troisieme draft s'ouvre — c'est le jeu qui marche,
    // pas un defaut.
  });

  it('la reprise apres le draft est progressive, pas un retour brutal a pleine vitesse', () => {
    const room = new Room();
    room.join(1);
    ouvreLEtalage(room, 10);

    expect(room.setDraftToken(1, 0)).toBe(true);
    room.step(DT);
    expect(room.drainDraftResults()).toHaveLength(1);

    // Le joueur pousse a fond, et ne relachera pas : chaque pas mesure ci-
    // dessous est donc entierement du a la rampe.
    //
    // ⚠️ `room.tick + 1` : `seq` est compare modulo 16 bits (`isNewer`), donc
    // un grand nombre arbitraire peut passer pour PLUS ANCIEN que la sequence
    // deja atteinte par la boucle de visee — l'entree serait rejetee en
    // silence et le joueur ne bougerait jamais (constate en ecrivant ce test).
    room.applyInput(1, room.tick + 1, 127, 0);

    // ⚠️ On mesure la rampe ENTIERE, pas un tick. Le pas d'un seul tick au
    // debut de la rampe vaut une fraction de pixel, et `positionOf` lit le
    // snapshot, ou les positions sont arrondies a l'entier : un test tick a
    // tick lirait 0 des deux cotes et ne prouverait rien (constate en
    // ecrivant celui-ci).
    const debut = positionOf(room, 1);
    for (let i = 0; i < LEVEL_RESUME_TICKS; i++) {
      room.step(DT);
    }
    const parcouruEnRampe = positionOf(room, 1).x - debut.x;

    // Bien apres la fin de la rampe : la meme duree, a pleine vitesse.
    for (let i = 0; i < LEVEL_RESUME_TICKS; i++) {
      room.step(DT);
    }
    const reference = positionOf(room, 1);
    for (let i = 0; i < LEVEL_RESUME_TICKS; i++) {
      room.step(DT);
    }
    const parcouruPlein = positionOf(room, 1).x - reference.x;

    expect(parcouruPlein).toBeGreaterThan(0);
    // La rampe monte lineairement de 0 a 1 : sur toute sa duree elle parcourt
    // environ la MOITIE de la distance a pleine vitesse. Sans la ligne qui
    // date la fin du gel (`#freezeUntilTick = tick` a la fermeture), l'echelle
    // vaut 1 des le premier tick et les deux distances sont EGALES — mutation
    // qui survivait aux 310 tests precedents.
    expect(parcouruEnRampe).toBeLessThan(parcouruPlein * 0.7);
    // Mais elle avance quand meme : un gel qui ne finirait jamais passerait
    // aussi la ligne ci-dessus.
    expect(parcouruEnRampe).toBeGreaterThan(0);
  });

  it('signale la fin de run exactement une fois quand tous les joueurs sont a 0 pv', () => {
    const room = new Room();
    room.join(1);
    const p1 = positionOf(room, 1);
    // Vingt-cinq monstres au contact : meme si l'arme en tue un toutes les
    // 15 ticks, il en reste toujours au moins un a portee de contact pour
    // continuer a faire mal jusqu'a la mort du joueur.
    for (let i = 0; i < 25; i++) {
      spawnMonsterAt(room, 2000 + i, p1.x, p1.y);
    }

    let runOver: { tick: number; survivedTicks: number; level: number; kills: number } | null =
      null;
    let ticks = 0;
    while (!runOver && ticks < 3000) {
      room.step(DT);
      ticks++;
      runOver = room.drainRunOver();
    }

    expect(runOver).not.toBeNull();
    expect(runOver?.survivedTicks).toBeGreaterThan(0);
    expect(runOver?.level).toBeGreaterThanOrEqual(1);

    // Sentinelle de mouvement : verifier seulement `drainRunOver()` ne
    // prouverait pas que le SALON ENTIER s'est arrete, seulement que le
    // message ne repart pas. Le deplacement d'un joueur n'est gate par AUCUNE
    // verification de `hp` dans `Room.step` (contrairement au tir et au
    // contact, verifies dans `combat.ts`) : sans le garde de tete de `step()`,
    // un joueur a 0 pv continuerait de glisser sur la carte si une entree de
    // mouvement lui arrivait encore. On lui en envoie une maintenant, apres
    // la mort, pour verifier qu'elle reste sans effet.
    room.applyInput(1, 2, 127, 0);
    const atRunOver = positionOf(room, 1);

    // Une seule fois : aucun RUN_OVER supplementaire, et plus rien n'avance,
    // meme si le salon continue d'etre avance.
    for (let i = 0; i < 100; i++) {
      room.step(DT);
      expect(room.drainRunOver()).toBeNull();
    }
    expect(positionOf(room, 1)).toEqual(atRunOver);
  });
});

describe('la run est jouable (tache 14)', () => {
  /**
   * Integration bout-en-bout : AUCUN monstre ni vague injecte a la main —
   * seulement `WaveDirector`, l'arme de base et le ramassage d'orbes, exactement
   * le pipeline qu'un vrai client declenche. Un joueur IMMOBILE (le pire cas :
   * aucune approche active des orbes) doit tout de meme atteindre le niveau 2.
   *
   * ⚠️ « Passif » porte sur le DEPLACEMENT, pas sur la visee (tache 13) : la
   * visee est desormais une entree joueur, jamais automatique — un joueur qui
   * ne vise litteralement rien (souris jamais bougee) ne tirerait jamais, quel
   * que soit le reglage de l'arme. `aimAtNearestMonster` simule donc la souris
   * d'un joueur qui suit la menace la plus proche sans bouger les pieds —
   * exactement ce qu'un vrai joueur ferait dans cette situation.
   *
   * Avant la tache 14, ce test aurait echoue : la horde partait a 120-320
   * entites des la premiere vague (~37 apparitions/s) contre 2 morts/s pour la
   * dague de base, et le joueur mourait encercle en ~20 s — bien avant les 10
   * orbes necessaires. Voir le rapport de la tache pour les mesures.
   *
   * Budget de 100 s (3000 ticks) : le banc `back/bench/_probe.ts` (jete,
   * mesures dans le rapport) situe le niveau 2 entre 35 et 64 s sur une
   * vingtaine d'essais avec un joueur passif — la graine de carte tiree au
   * hasard a chaque `Room` (`Room.mapSeed`) fait varier ce delai d'un essai a
   * l'autre. 100 s laisse une marge large sans figer de graine.
   */
  it('un joueur passif atteint le niveau 2 via le pipeline reel (vagues, arme de base, orbes)', () => {
    const room = new Room();
    room.join(1);

    let levelUps: { tick: number; level: number }[] = [];
    let totalDeaths = 0;
    let totalPickups = 0;
    const budget = TICK_HZ * 100;
    for (let i = 0; i < budget && levelUps.length === 0; i++) {
      aimAtNearestMonster(room, 1, i + 1);
      room.step(DT);
      totalDeaths += room.drainDeaths().reduce((n, d) => n + d.ids.length, 0);
      totalPickups += room.drainPickups().reduce((n, p) => n + p.ids.length, 0);
      levelUps = levelUps.concat(room.drainLevelUps());
    }

    expect(levelUps.length).toBeGreaterThan(0);
    expect(levelUps[0]?.level).toBe(2);
    // Garde-fou contre un test qui ne prouverait rien (§ « ne jamais rien
    // tuer ») : la montee de niveau doit venir de vrais monstres tues et de
    // vrais orbes ramasses, pas d'un chemin degenere.
    expect(totalDeaths).toBeGreaterThan(0);
    expect(totalPickups).toBeGreaterThan(0);
  }, 30_000);
});
