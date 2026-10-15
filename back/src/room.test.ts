import { ABILITY_COOLDOWN_TICKS, VERB_IDS } from '@shared/abilities';
import {
  ARCHETYPES,
  BOSS_ARCHETYPE,
  BOSS_HP_PER_PLAYER,
  HEAVY_ARMOR,
  HEAVY_HP,
  LIGHT_HP,
} from '@shared/archetypes';
import {
  BOSS_CHARGE_COOLDOWN_TICKS,
  BOSS_CHARGE_DAMAGE,
  type BossCharge,
  chargePointAt,
} from '@shared/boss';
import { CARD, type Card } from '@shared/cards';
import {
  COIN_DROP_ONE_IN,
  EXTRACT_MULTIPLIER_STEP,
  FIELD_INPUT_DELAY_TICKS,
  FLOWFIELD_CELL,
  LEVEL_FREEZE_TICKS,
  LEVEL_RESUME_TICKS,
  LEVEL_XP_BASE,
  MAP_SIZE,
  MAX_ENTITIES,
  MAX_PLAYERS,
  ORB_DROP_ONE_IN,
  ORB_PICKUP_RADIUS,
  PLAYER_MAX_HP,
  PLAYER_SPEED,
  PORTAL_EVERY_WAVES,
  PORTAL_WINDOW_TICKS,
  REACTION_DAMAGE,
  REACTION_RADIUS,
  SYNERGY_MAX,
  TICK_HZ,
  WAVES_PER_PALIER,
  WEAPON_SLOTS,
  WIPE_GOLD_KEPT,
  XP_PER_ORB,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
  ZONE_REFRESH_INTERVAL_TICKS,
} from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import { FlowField } from '@shared/flowfield';
import { dropsCoin, dropsOrb, entityIdOf, leavesDrop } from '@shared/horde';
import { bossHp, extractGold, hpScale, palierGold, palierHp } from '@shared/paliers';
import { PASSIVES, type PassiveKind, passiveOf } from '@shared/passives';
import { Projectiles } from '@shared/projectiles';
import {
  decodeSnapshot,
  NO_VOTE,
  OUTCOME,
  packElementPair,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_BYTES,
  VOTE_CHOICE,
  zoneElement,
  zoneReaction,
} from '@shared/protocol';
import { REACTION } from '@shared/reactions';
import { FORMATION, type WaveOrder } from '@shared/waves';
import {
  BASE_WEAPON_ID,
  cooldownWithBonus,
  MAX_FIRE_RATE_BONUS,
  stackGain,
  WEAPONS,
  weaponOf,
} from '@shared/weapons';
import { generateObstacles } from '@shared/worldmap';
import { describe, expect, it, vi } from 'vitest';

import { type AccountGrants, type DraftOpenEvent, Room } from './room';

const DT = 1 / TICK_HZ;

/**
 * Un arsenal PLEIN : `WEAPON_SLOTS` armes distinctes, toutes draftables.
 *
 * ⚠️ **Derive du catalogue et de la constante, jamais recopie.** Deux fixtures
 * de ce fichier ecrivaient `[1, 2, 3, 5, 6]` en dur ; passer les slots de 5 a 4
 * (tache 19) faisait lever `addWeapon` sur la cinquieme arme. C'est le defaut
 * le plus recurrent du depot — le meme que deux tests de vague ont paye en
 * recopiant `WAVE1_MIN_COUNT`.
 *
 * L'arme neutre est exclue : elle vit hors des slots (§6.1) et l'empiler la
 * ferait tirer deux fois par tick.
 *
 * ⚠️ **Les armes qui ne TIRENT pas aussi** (etape 8) : ce qu'on compte ici, ce
 * sont des salves de projectiles, et un halo n'en pose aucune — il met une
 * pulsation en file (voir `Room#fireOne`). L'y laisser ferait compter une
 * salve de moins que de slots, pour une raison qui n'a rien a voir avec ce que
 * ces cas gardent.
 */
const ARSENAL_PLEIN = WEAPONS.filter((w) => w.id !== BASE_WEAPON_ID && w.kind === 'tir')
  .slice(0, WEAPON_SLOTS)
  .map((w) => w.id);

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

/**
 * Rayon de ramassage de CE joueur, lu a travers le SNAPSHOT decode — tache 7
 * de l'etape 7b, ronde de correction 1. Meme discipline que `hpOf` : eprouve
 * le TRANSPORT (l'octet qui voyage), pas l'etat interne du salon.
 */
function pickupRadiusOf(room: Room, id: number): number {
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
  return found.pickupRadius;
}

/**
 * La barre de Synergie de l'EQUIPE (§7 de l'etape 5a).
 *
 * ⚠️ **Lue par le SEUL chemin qui la publie : l'en-tete du `SNAPSHOT`.** Pas
 * de `get synergy()` sur `Room` a cote — un accesseur de confort ferait une
 * seconde source de verite pour un seul nombre, exactement le defaut que
 * l'etape 3 a commis sur l'experience. Passer par le fil prouve du meme coup
 * qu'il n'y a QU UN nombre, partage, et aucun par joueur.
 */
function synergyOf(room: Room): number {
  const out = collector();
  room.snapshot(out);
  const first = out.sent[0];
  if (!first) {
    throw new Error('aucun snapshot emis');
  }
  return decodeSnapshot(first).synergy;
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
    const room = new Room(3);
    room.join(1);
    const before = positionOf(room, 1);

    room.applyInput(1, 1, 127, 0);
    stepOneSecond(room);

    expect(positionOf(room, 1).x - before.x).toBeCloseTo(PLAYER_SPEED, 0);
    expect(positionOf(room, 1).y).toBe(before.y);
  });

  it('ne va pas plus vite en diagonale qu en ligne droite', () => {
    const straight = new Room(3);
    straight.join(1);
    straight.applyInput(1, 1, 127, 0);

    const diagonal = new Room(3);
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
    // ⚠️ MEME graine : depuis la carte en tuiles, le decor arrete les joueurs,
    // et deux graines feraient deux iles.
    const a = new Room(3);
    const b = new Room(3);
    for (const room of [a, b]) {
      room.join(1);
      room.applyInput(1, 1, 90, -40);
      for (let i = 0; i < 100; i++) {
        room.step(DT);
      }
    }

    expect(positionOf(a, 1)).toEqual(positionOf(b, 1));
  });

  it('borne les joueurs a la carte : le rivage les arrete avant le bord', () => {
    const room = new Room(3);
    room.join(1);
    room.applyInput(1, 1, -127, -127);
    for (let i = 0; i < TICK_HZ * 120; i++) {
      room.step(DT);
    }

    // Le coin (0, 0) est de l'eau : le joueur s'arrete sur une cellule libre,
    // dans la carte, et il a bien couru vers le coin.
    const pos = positionOf(room, 1);
    const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    const mask = generateObstacles(room.mapSeed, probe.cols, probe.rows);
    const cx = Math.floor(pos.x / FLOWFIELD_CELL);
    const cy = Math.floor(pos.y / FLOWFIELD_CELL);
    expect(mask[cy * probe.cols + cx]).toBe(0);
    expect(pos.x).toBeGreaterThanOrEqual(0);
    expect(pos.y).toBeGreaterThanOrEqual(0);
    expect(pos.x + pos.y).toBeLessThan(MAP_SIZE);
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
      fillHordeFarFromPlayer(room, MAX_ENTITIES - 1);

      // Une seule periode de vague (PERIOD_TICKS = TICK_HZ * 6) suffit : la
      // horde pre-remplie ne laisse qu'UNE place, donc toute vague de deux
      // entites ou plus tronque, quel que soit le reglage de la rampe.
      //
      // ⚠️ **Ce test etait intermittent, et c'est l'etape 5a qui l'a revele.**
      // Il laissait 10 places en se fiant a « strictement sous le plancher de
      // la premiere vague (`WAVE1_MIN_COUNT`) » — vrai tant que ce plancher
      // valait 16. L'etape 7 bis l'a ramene a 10 : une vague de 10 tenait
      // pile, ne tronquait rien, et le test echouait environ une fois sur
      // neuf. La constante n'est pas exportee ; la fixture ne doit donc pas
      // dependre de sa valeur du tout.
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
    // Une seule place libre : voir l'avertissement du test precedent.
    fillHordeFarFromPlayer(room, MAX_ENTITIES - 1);
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
function spawnMonsterAt(room: Room, waveId: number, x: number, y: number, archetype = 0): number {
  const order: WaveOrder = {
    waveId,
    spawnTick: room.tick,
    seed: 1,
    archetype,
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

/**
 * Une vague ENTIERE, a index CONSECUTIFS, groupee sur un point.
 *
 * ⚠️ **`spawnMonsterAt` ne peut pas la remplacer** : elle pose une vague d'un
 * seul monstre, donc toujours l'index 0 — et l'index 0 laisse toujours un orbe
 * (`dropsOrb`, tache 17). Tout decor bati sur elle est aveugle au taux de
 * chute. C'est la « fixture qui masque » du depot, prise ici a la source.
 */
function spawnWaveAt(room: Room, waveId: number, count: number, x: number, y: number): number[] {
  const order: WaveOrder = {
    waveId,
    spawnTick: room.tick,
    seed: 1,
    archetype: 0,
    formation: FORMATION.CLUSTER,
    anchorX: x,
    anchorY: y,
    count,
  };
  room.horde.spawn(order);
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const slot = room.horde.count - count + i;
    // Espaces de plus de `SEPARATION_RADIUS` : sans ça la repulsion les
    // disperse pendant qu'ils attendent leur tour d'etre cibles.
    room.horde.x[slot] = x;
    room.horde.y[slot] = y + i * 40;
    ids.push(room.horde.entityIdAt(slot));
  }
  expect(ids).toEqual(ids.map((_, i) => entityIdOf(waveId, i)));
  return ids;
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

  it('la dague occupe un slot : un arsenal PLEIN fait autant de salves que de slots, dague comprise', () => {
    const room = new Room();
    room.join(1);
    const inv = room.loadoutOf(1);
    if (!inv) {
      throw new Error('inventaire manquant');
    }
    // ⚠️ **Un arsenal PLEIN, derive de `WEAPON_SLOTS`.** La liste valait
    // `[1, 2, 3, 5, 6]` en dur : passer les slots de 5 a 4 (tache 19) faisait
    // lever `addWeapon` sur la cinquieme. C'est « la constante recopiee dans
    // une fixture », et le compte attendu se derive lui aussi.
    const DRAFTEES = ARSENAL_PLEIN.slice(0, WEAPON_SLOTS - 1);
    for (const id of DRAFTEES) {
      inv.addWeapon(id);
    }
    expect(inv.weaponSlotsUsed).toBe(WEAPON_SLOTS);

    // Un seul tick : aucune arme n'a jamais tire, donc toutes sont dues.
    const compte = salvesParArme(room, 1);

    // La dague est dans le `Loadout` depuis `join` (retour de playtest : elle
    // s'ameliore comme les autres) : elle tire, et prend un slot.
    expect([...compte.values()].reduce((a, b) => a + b, 0)).toBe(WEAPON_SLOTS);
    expect([...compte.keys()].sort((a, b) => a - b)).toEqual([BASE_WEAPON_ID, ...DRAFTEES]);
  });

  it('empiler une arme ELARGIT sa salve de stackGain par exemplaire', () => {
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

    // Une seule carte n'elargit RIEN : c'est la deuxieme qui ajoute les
    // premiers projectiles.
    //
    // ⚠️ **`stackGain` et pas `+ 1` depuis l'etape 8** : le gain suit la
    // largeur de la salve de base (l'eventail en tire cinq, donc deux par
    // carte). Ce que ce cas garde, c'est que le salon lit bien `salvoCount` —
    // la REGLE, elle, est gardee par `shared/weapons.test.ts`, et la recopier
    // ici en ferait une seconde definition a tenir.
    const gain = stackGain(eventail);
    expect(gain).toBeGreaterThan(1);
    expect(projectilesDeLaSalve(1)).toBe(eventail.projectileCount);
    expect(projectilesDeLaSalve(2)).toBe(eventail.projectileCount + gain);
    expect(projectilesDeLaSalve(3)).toBe(eventail.projectileCount + 2 * gain);
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
        const room = new Room(3);
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
      // Le nombre transporte. Qu'il change une ISSUE — un ennemi lourd qui
      // meurt en moins d'impacts — est verifie par le test suivant : c'est la
      // dette de l'etape 4 (« `damage` ne module aucune issue ») qui se solde
      // la, pas ici.
      const magnitude = passiveOf(PUISSANCE).magnitude;
      const base = weaponOf(BASE_WEAPON_ID).damage;

      function degatsDuPremierTir(cartes: number): number {
        const room = new Room(3);
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

    it('deux cartes de puissance font mourir un ennemi lourd en MOINS d impacts', () => {
      // ⚠️ **La dette de l'etape 4, soldee.** « Puissance » et « acier »
      // calculaient un bonus qui ne modulait aucune issue : la pietaille
      // n'avait pas de PV, un projectile qui touche etait toujours letal. Le
      // test precedent ne garde que le NOMBRE ; celui-ci garde l'ISSUE.
      //
      // Compte les IMPACTS, pas les ticks : la cadence est identique dans les
      // trois cas (« puissance » ne la touche pas), mais compter des ticks
      // ferait dependre le resultat du temps de vol du projectile.
      // Pas le porte-bouclier : il arrete les tirs de face, ce test compte des impacts.
      const LOURD =
        ARCHETYPES.find((a) => a.hp === HEAVY_HP && a.behavior !== 'bouclier')?.id ?? -1;
      expect(LOURD).toBeGreaterThanOrEqual(0);

      function impactsPourTuer(cartes: number): number {
        const room = new Room(0x5a5a_1234);
        room.join(1);
        prend(room, PUISSANCE, cartes);
        const pos = positionOf(room, 1);
        // 500 px : dans la portee de la dague (~607 px, tache 14) et hors de
        // CONTACT_RADIUS, pour isoler le chemin « degats de projectile ».
        const cible = spawnMonsterAt(room, 900, pos.x + 500, pos.y, LOURD);
        let impacts = 0;
        let reste = HEAVY_HP;
        // Sous 180 ticks : la periode du generateur de vagues. Au-dela, un
        // autre monstre pourrait devenir la cible la plus proche.
        for (let t = 0; t < 170; t++) {
          aimAtNearestMonster(room, 1, t + 1);
          room.step(DT);
          const slot = room.horde.slotOf(cible);
          if (slot < 0) {
            return impacts + 1; // l'impact qui vient de l'achever
          }
          const courant = room.horde.hp[slot] ?? 0;
          if (courant !== reste) {
            impacts++;
            reste = courant;
          }
        }
        throw new Error("l'ennemi lourd n'est jamais mort");
      }

      const degats = weaponOf(BASE_WEAPON_ID).damage;
      const magnitude = passiveOf(PUISSANCE).magnitude;
      // ⚠️ **L'armure entre dans le compte depuis l'etape 5b.** Le lourd passe
      // par `appliquerDegats` comme tout le monde, donc chaque impact ne lui
      // retire que `degats x (1 - HEAVY_ARMOR)`. L'oublier ici ferait repondre
      // au modele un palier que le salon ne franchit plus.
      const impacts = (cartes: number) =>
        Math.ceil(HEAVY_HP / (degats * (1 + magnitude * cartes) * (1 - HEAVY_ARMOR)));

      // Sanity : c'est bien CINQ impacts de dague qu'il faut sans carte
      // (20 / (5 x 0,85) = 4,7) — sinon la fixture ne met pas en scene le cas
      // qu'on croit.
      expect(impactsPourTuer(0)).toBe(5);
      expect(impacts(0)).toBe(5);

      // ⚠️ **UNE carte ne suffit pas, et c'est le motif R9 de l'etape 4 : le
      // nombre d'impacts est un ENTIER, et le bonus une fraction.**
      // 20 PV / (5 x 1,1 x 0,85) = 4,28, donc toujours cinq impacts. Le palier
      // n'est pas la ou la fraction le suggere, et c'est tout l'interet du
      // test.
      expect(impactsPourTuer(1)).toBe(5);
      expect(impacts(1)).toBe(5);

      // **L'issue change a DEUX cartes** (20 / (5 x 1,2 x 0,85) = 3,92 -> 4).
      // C'est ce qui separe cette etape de l'etape 4.
      expect(impactsPourTuer(2)).toBe(4);
      expect(impacts(2)).toBe(4);
      expect(impactsPourTuer(2)).toBeLessThan(impactsPourTuer(0));
    });

    it('les passifs d un joueur ne changent rien pour son voisin', () => {
      // Un `Loadout` par joueur, et pas un pour le salon : sans ca, la
      // premiere carte prise en cooperatif profiterait a toute l'equipe.
      const room = new Room(3);
      room.join(1);
      room.join(2);
      prend(room, FOUGUE, 3);
      expect(room.loadoutOf(1)?.bonus('speed')).toBe(passiveOf(FOUGUE).magnitude * 3);
      expect(room.loadoutOf(2)?.bonus('speed')).toBe(0);
    });
  });

  it('un arsenal lourdement empile ne tronque aucune salve', () => {
    // ⚠️ **La borne que l'empilement a levee.** Tant qu'une arme ne se prenait
    // qu'une fois, quatre joueurs aux slots pleins tenaient une centaine de
    // projectiles simultanes contre 256 de capacite, et la marge tenait toute
    // seule. Chaque exemplaire elargit desormais la salve d'un projectile, et
    // **le plafond de slots d'armes ne borne plus rien** : c'est le nombre
    // d'EXEMPLAIRES qui commande, et il n'a pas de plafond.
    //
    // `Projectiles` tronque en SILENCE quand la capacite est atteinte : la salve
    // que le joueur a payee en cartes ne partirait pas, sans aucun signal. Ce
    // test est ce qui rend la constante verifiable. 256 n'est pas une constante
    // du depot mais la valeur que `PROJECTILE_CAPACITY` avait AVANT
    // l'empilement : le pic la depasse, donc la ramener a 256 ferait rougir.
    const room = new Room(0x0ca9_ac17);
    for (const id of [1, 2, 3, 4]) {
      room.join(id);
    }
    const ARMES = ARSENAL_PLEIN;
    // ⚠️ **Douze, et plus huit depuis la tache 19.** Retirer un slot d'arme a
    // retire un cinquieme du debit : a huit exemplaires le pic tombait a 208,
    // sous le seuil ci-dessous, et le test serait passe au vert en cessant de
    // mesurer quoi que ce soit. C'est le nombre d'EXEMPLAIRES qui leve la
    // borne, pas le nombre de slots — voir la doc de `PROJECTILE_CAPACITY`.
    //
    // ⚠️ **Ce nombre est MESURE au reglage courant de `WEAPON_SLOTS`**, il ne
    // s'en derive pas : le debit depend aussi de QUELLES armes remplissent
    // l'arsenal, et deux slots d'eventail et d'arc-lourd ne portent pas le
    // meme reservoir que quatre. Le jour ou les slots rebougent, ce test
    // rougit — bruyamment, ce qui est exactement ce qu'on veut : la capacite
    // se REMESURE, elle ne se recalcule pas de tete.
    const EXEMPLAIRES = 12;
    for (const id of [1, 2, 3, 4]) {
      // Le pic est mesure sur quatre armes de tir : sans la dague du depart.
      room.debugResetLoadout(id);
      for (const arme of ARMES) {
        for (let k = 0; k < EXEMPLAIRES; k++) {
          room.grantCard(id, { nature: CARD.WEAPON, refId: arme });
        }
      }
      room.applyInput(id, 1, 0, 0, 127, 40);
    }

    // Assez de ticks pour que toutes les armes soient en regime : la plus lente
    // du catalogue recharge en 75 ticks.
    //
    // ⚠️ On garde le PIC, pas le compte final. Les salves ne sont pas en phase :
    // a un tick donne le reservoir peut etre a moitie vide alors qu'il a frole
    // sa capacite deux ticks plus tot. Une premiere version lisait le compte au
    // dernier tick et mesurait 156 la ou le pic depasse 256.
    let pic = 0;
    for (let i = 0; i < 300; i++) {
      room.step(DT);
      pic = Math.max(pic, room.projectileCount);
    }

    expect(pic).toBeGreaterThan(256);
    expect(room.projectilesTronques).toBe(0);
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
    // Seuils solo : le passage du niveau `n` au suivant coute
    // `LEVEL_XP_BASE * n`, soit 10 puis 20 puis 30 — donc 30 d'experience d'un
    // seul tick franchissent DEUX seuils, et 60 en franchiraient trois.
    //
    // ⚠️ **Le tas est ramasse d'UN SEUL coup depuis la tache 19** (voir la note
    // dans la boucle ci-dessous), donc son total est exactement ce que
    // `#gainXp` recoit : il doit tenir STRICTEMENT entre les deux bornes.
    // Trop peu, un seul niveau tombe et le test ne prouve plus rien ; trop, un
    // troisieme etalage s'ouvre derriere les deux observes et le monde ne rend
    // jamais la main a la derniere assertion. Les deux moities sont gardees
    // juste en dessous plutot que laissees a la lecture — ce decor s'est deja
    // trompe deux fois de cote.
    //
    // ⚠️ **Derive de `XP_PER_ORB` depuis la tache 17**, jamais un nombre pose a
    // cote : chaque orbe vaut `XP_PER_ORB` et non 1.
    const ORBES = 10;
    expect(ORBES * XP_PER_ORB).toBeGreaterThanOrEqual(LEVEL_XP_BASE * (1 + 2));
    expect(ORBES * XP_PER_ORB).toBeLessThan(LEVEL_XP_BASE * (1 + 2 + 3));
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
      // ⚠️ **Le monstre est REPOSE sur le tas a chaque tick, et ce n'est pas
      // de la coquetterie de decor.** Il marche vers le joueur tant qu'il vit,
      // donc l'etalement du tas etait une fonction de sa DUREE DE VIE, elle
      // meme une fonction de `cooldownTicks` : le tas s'etalait sur une
      // douzaine de pixels a 7 ticks de recharge, le joueur en ramassait
      // trente-quatre d'un coup, et deux niveaux tombaient ensemble. La tache
      // 19 a porte la dague a 4 ticks — le monstre meurt plus tot, le tas se
      // pose autrement, le joueur n'en ramasse plus que cinq au tick decisif
      // et ce test ne voyait plus qu'UN niveau. Onzieme « fixture qui masque »
      // du depot : le decor mesurait la cadence sans le dire.
      //
      // Repose ici, la derive d'un cadavre est bornee a UN tick de marche quoi
      // que vaille la cadence, donc les quinze orbes tiennent dans le rayon de
      // ramassage et le test observe ce qu'il pretend observer.
      const slot = room.horde.slotOf(courant);
      if (slot >= 0) {
        room.horde.x[slot] = tas.x;
        room.horde.y[slot] = tas.y;
      }
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
    // ⚠️ On ne verifie PAS qu'aucun troisieme etalage ne s'ouvre ensuite : rien
    // ici n'interdit au generateur de vagues de nourrir un troisieme niveau
    // plus tard, et une premiere version de ce test l'a paye. Ce qui est
    // garde, c'est que le monde REPREND la main — donc qu'aucun etalage ne
    // reste ouvert derriere les deux observes.
  });

  it('la reprise apres le draft est progressive, pas un retour brutal a pleine vitesse', () => {
    const room = new Room(3);
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

describe('le debit d orbes, dans le salon (etape 5a, tache 17)', () => {
  /**
   * *« Moins d'xp qui tombe »* — et c'est bien le NOMBRE D'OBJETS AU SOL que
   * l'auteur decrit, pas la courbe de progression. Ce test le mesure sur le
   * pipeline reel : de vraies morts par projectile, dans un vrai salon.
   *
   * ⚠️ **Le tas meurt HORS portee de ramassage** (`ORB_PICKUP_RADIUS` = 90 px) :
   * un orbe empoche disparaitrait du compte, et le test mesurerait le ramassage
   * au lieu de la chute. `drainPickups` vide en dessous est ce qui le prouve,
   * plutot que de le supposer.
   *
   * ⚠️ Graine FIXE, meme raison qu'ailleurs dans ce fichier : les obstacles
   * derivent de `mapSeed` et decident du chemin des monstres.
   */
  it('une vague entiere abattue ne laisse au sol que ce que leavesDrop accepte', () => {
    const room = new Room(0x0b_e5_0017);
    room.join(1);
    const depart = positionOf(room, 1);
    // ⚠️ **Assez large pour contenir des PIECES** (etape 6a, tache 14) :
    // `COIN_DROP_ONE_IN` vaut quatre fois `ORB_DROP_ONE_IN`, donc une vague de
    // 16 n'en laisserait aucune et le nouveau drop serait invisible ici. Pas
    // plus large non plus : le budget de 300 ticks doit suffire a TOUT abattre,
    // sinon le compte du sol mesure la duree du test.
    const ids = spawnWaveAt(room, 800, 2 * COIN_DROP_ONE_IN, depart.x + 520, depart.y - 120);

    let morts = 0;
    let ticks = 0;
    // Budget court, et volontairement sous le tick 360 : au-dela le generateur
    // lache sa premiere vague, et ses morts a elle brouilleraient le compte.
    while (morts < ids.length && ticks < 300) {
      aimAtNearestMonster(room, 1, ticks + 1);
      room.step(DT);
      ticks++;
      for (const lot of room.drainDeaths()) {
        morts += lot.ids.length;
      }
    }

    expect(morts).toBe(ids.length);
    // Rien n'a ete empoche : ce qui reste au sol est bien ce qui est TOMBE.
    expect(room.drainPickups()).toEqual([]);
    expect(room.orbCount).toBe(ids.filter((id) => leavesDrop(id)).length);
    // Les deux natures sont bien la, et elles sont disjointes.
    expect(ids.filter((id) => dropsOrb(id))).toHaveLength(ids.length / ORB_DROP_ONE_IN);
    expect(ids.filter((id) => dropsCoin(id))).toHaveLength(ids.length / COIN_DROP_ONE_IN);
    // ⚠️ **`orbesTronquees` n'est GARDE par rien de plus que ce zero au niveau
    // du salon** — mutation appliquee, « rendre 0 » survit ici. Remplir
    // `MAX_ENTITIES` (4000) creneaux d'orbes demande plus de morts qu'un test
    // de salon n'en produit a un cout raisonnable ; c'est `combat.test.ts` qui
    // eprouve le refus lui-meme, sur une reserve de trois places. Dit tel quel
    // plutot que credite d'un test qui ne le tient pas — meme choix que
    // `zonesTronquees`.
    expect(room.orbesTronquees).toBe(0);
  });
});

/**
 * L'or qui tombe des monstres (etape 6a, tache 14) — *« les monstres ne
 * droppent pas d'or j'ai l'impression, t'as l'icone dans UI Elements/Icons/
 * Icon_03 »*.
 *
 * **L'auteur avait raison, et c'etait verifie** : `#gold` ne montait que par
 * `palierGold` a la mort du boss. Un monstre ne laissait rien.
 */
describe("l'or que laissent les monstres (etape 6a, tache 14)", () => {
  /**
   * Abat une vague loin du joueur, puis le fait MARCHER dessus, et rend ce que
   * le salon a ramasse.
   *
   * ⚠️ **En deux temps, et c'est oblige.** Une vague posee sous les pieds tue
   * le joueur au contact avant la premiere mort — `step` s'arrete alors sur une
   * run perdue, et le decor mesurerait zero sans rien dire. On abat d'abord,
   * on ramasse ensuite.
   */
  function ramasseUneVague(
    waveId: number,
    count: number,
  ): { ids: number[]; ramasses: number[]; or: number; xp: number } {
    const room = new Room(0x0_60_1d_00);
    room.join(1);
    const depart = positionOf(room, 1);
    const ids = spawnWaveAt(room, waveId, count, depart.x + 520, depart.y);
    const ramasses: number[] = [];
    let seq = 1;
    let niveau = 1;
    const fermeLEtalage = (): void => {
      for (const up of room.drainLevelUps()) {
        niveau = Math.max(niveau, up.level);
      }
      for (const ouverture of room.drainDraftOpens()) {
        if (ouverture.cards.length > 0) {
          room.setDraftToken(1, 0);
        }
      }
      room.drainDraftResults();
    };

    for (let tick = 0; tick < 400 && room.horde.count > 0; tick++) {
      aimAtNearestMonster(room, 1, seq++);
      room.step(DT);
      room.drainDeaths();
      room.drainPickups();
      fermeLEtalage();
    }
    // ⚠️ **Un BALAYAGE, pas une ligne droite.** Le tas s'etale sur la largeur
    // de la formation ; un joueur qui traverse tout droit n'en ramasse qu'une
    // poignee, et le test mesurerait sa trajectoire plutot que la regle. Il
    // fait des allers-retours en s'ecartant, jusqu'a ce que le sol soit vide.
    for (let tick = 0; tick < 900 && room.orbCount > 0; tick++) {
      const phase = Math.floor(tick / 60) % 4;
      const dx = phase === 0 || phase === 1 ? 127 : -127;
      const dy = phase === 1 || phase === 2 ? 127 : -127;
      room.applyInput(1, seq++, dx, dy, 127, 0);
      room.step(DT);
      room.drainDeaths();
      for (const lot of room.drainPickups()) {
        ramasses.push(...lot.ids);
      }
      fermeLEtalage();
    }
    // ⚠️ **L'experience TOTALE gagnee, pas le reste affiche.** `#xp` se voit
    // retirer le cout de chaque seuil franchi : le comparer tel quel a « une
    // orbe vaut `XP_PER_ORB` » mesurerait la courbe de niveau. On rajoute donc
    // ce que les niveaux ont consomme — a un joueur, `LEVEL_XP_BASE * n` pour
    // passer du niveau `n` au suivant.
    let consomme = 0;
    for (let n = 1; n < niveau; n++) {
      consomme += LEVEL_XP_BASE * n;
    }
    const buffers: ArrayBuffer[] = [];
    room.snapshot({ push: (b: ArrayBuffer) => buffers.push(b) });
    const reste = decodeSnapshot(buffers[0] ?? new ArrayBuffer(0)).xp;
    return { ids, ramasses, or: room.gold, xp: consomme + reste };
  }

  /**
   * **LE test de la tache.** Une piece par identite que `dropsCoin` accepte, et
   * pas une de plus.
   *
   * ⚠️ **La vague est assez large pour en contenir plusieurs** : a une seule,
   * « une piece par mort » et « une piece sur seize » rendraient le meme
   * nombre, et le taux ne serait garde par rien.
   */
  it('verse de l or a chaque piece ramassee, et rien pour les autres morts', () => {
    const { ids, ramasses, or } = ramasseUneVague(910, 4 * COIN_DROP_ONE_IN);
    const piecesRamassees = ramasses.filter((id) => dropsCoin(id));

    // ⚠️ **L'or suit ce qui a ete RAMASSE, jamais ce qui est tombe.** Le
    // comparer au nombre de pieces de la vague ferait de ce test une mesure de
    // la trajectoire du joueur a travers le tas.
    expect(or).toBe(piecesRamassees.length);
    // Non-vacuite des deux cotes : des pieces ont bien ete ramassees, et le
    // joueur a ramasse bien plus de choses que de pieces.
    // Au moins une : depuis les roles, les vagues du directeur qui traversent
    // le decor ne laissent plus toujours une seconde piece en chemin.
    expect(piecesRamassees.length).toBeGreaterThanOrEqual(1);
    expect(ramasses.length).toBeGreaterThan(piecesRamassees.length);
    // Les pieces de la vague du TEST seulement : celles des vagues du
    // directeur ramassees en chemin n'en font pas partie.
    expect(ids.filter((id) => dropsCoin(id)).length).toBeGreaterThanOrEqual(
      piecesRamassees.filter((id) => ids.includes(id)).length,
    );
  });

  /**
   * ⚠️ **Une piece ne vaut AUCUNE experience, et une orbe aucun or.** Les deux
   * ensembles sont disjoints (`COIN_DROP_RESIDUE`) ; les confondre reviendrait
   * a ralentir les niveaux en rarefiant l'or, ou a rendre l'or fonction de la
   * courbe d'experience.
   */
  it('separe les deux monnaies : une piece ne vaut aucune experience', () => {
    const { ramasses, or, xp } = ramasseUneVague(911, 4 * COIN_DROP_ONE_IN);
    const orbes = ramasses.filter((id) => dropsOrb(id));
    const pieces = ramasses.filter((id) => dropsCoin(id));

    expect(or).toBe(pieces.length);
    // ⚠️ **LE coeur du test, et la mutation qu'il tue** : crediter aussi les
    // pieces en experience laissait tout le reste vert. L'experience suit les
    // ORBES, une par une.
    expect(xp).toBe(orbes.length * XP_PER_ORB);
    expect(pieces.length).toBeGreaterThan(0);
    // ⚠️ **Les deux ensembles sont DISJOINTS** (`COIN_DROP_RESIDUE`) : aucun
    // ramassage ne compte deux fois, et l'or ne suit pas la courbe
    // d'experience — les confondre reviendrait a ralentir les niveaux en
    // rarefiant l'or.
    expect(orbes.length + pieces.length).toBe(ramasses.length);
    expect(orbes.length).toBeGreaterThan(pieces.length);
  });

  /**
   * ⚠️ **L'or des monstres rejoint l'or NON SECURISE**, celui que le §9.3 fait
   * perdre a la mort de l'equipe. Une seconde bourse aurait fait de la piece
   * une monnaie a part, que le vote d'extraction ne mettrait pas en jeu — et
   * c'est precisement le sel du palier.
   */
  it('n en verse aucun quand personne ne va les chercher', () => {
    // La moitie basse : un `#gold` qui monterait a chaque MORT — ou a chaque
    // tick — passerait tout ce qui precede.
    const room = new Room(0x0_60_1d_01);
    room.join(1);
    const depart = positionOf(room, 1);
    spawnWaveAt(room, 912, 2 * COIN_DROP_ONE_IN, depart.x + 520, depart.y);
    for (let tick = 0; tick < 400 && room.horde.count > 0; tick++) {
      aimAtNearestMonster(room, 1, tick + 1);
      room.step(DT);
      room.drainDeaths();
      room.drainLevelUps();
      for (const ouverture of room.drainDraftOpens()) {
        if (ouverture.cards.length > 0) {
          room.setDraftToken(1, 0);
        }
      }
      room.drainDraftResults();
    }

    // Des objets sont bien tombes — sans quoi ce zero ne prouverait rien — et
    // personne n'est alle les chercher.
    expect(room.orbCount).toBeGreaterThan(0);
    expect(room.drainPickups()).toEqual([]);
    expect(room.gold).toBe(0);
  });
});

/**
 * La regeneration (etape 6a, tache 17) — *« il faut un moyen de regen aussi »*.
 *
 * ⚠️ **RIEN NE SOIGNAIT avant cette tache** : « vitalite » releve `maxHp` et
 * offre le delta une seule fois, dans `grantCard`. Ce qui se garde ici a DEUX
 * moities, et la seconde n'est pas facultative : sans elle, une regeneration
 * qui deborde son plafond passerait.
 */
describe('le passif de regeneration (etape 6a, tache 17)', () => {
  /**
   * ⚠️ **Trouve par GENRE, jamais par indice.** `VITALITE = 0` ailleurs dans ce
   * fichier survivrait a une reindexation du catalogue en mesurant une autre
   * carte ; « le passif dont le genre est `regen` » ne le peut pas.
   */
  function parGenre(kind: PassiveKind): number {
    const trouve = PASSIVES.find((p) => p.kind === kind);
    if (!trouve) {
      throw new Error(`fixture : aucun passif de genre ${kind}`);
    }
    return trouve.id;
  }

  const REGAIN = parGenre('regen');
  const VITALITE = parGenre('maxHp');
  const PAR_SECONDE = passiveOf(REGAIN).magnitude;
  const PAR_CARTE_MAX_HP = passiveOf(VITALITE).magnitude;

  function prend(room: Room, playerId: number, id: number, n: number): void {
    const carte: Card = { nature: CARD.PASSIVE, refId: id };
    for (let i = 0; i < n; i++) {
      room.grantCard(playerId, carte);
    }
  }

  /**
   * Blesse le joueur par le VRAI chemin — un monstre au contact — puis retire
   * le monstre. Rend les points de vie constates.
   *
   * ⚠️ **Aucun raccourci vers `PlayerState.hp`** : c'est le serveur qui arbitre
   * la vie (§5.4), et un decor qui l'ecrirait a la main testerait un etat que
   * le jeu ne peut pas produire.
   */
  function blesse(room: Room, playerId: number, waveId: number, ticks: number): number {
    const avant = hpOf(room, playerId);
    const pos = positionOf(room, playerId);
    const monstre = spawnMonsterAt(room, waveId, pos.x, pos.y);
    for (let t = 0; t < ticks; t++) {
      room.step(DT);
    }
    room.horde.kill([monstre]);
    const vie = hpOf(room, playerId);
    // Non-vacuite : il a bien morfle. Compare au point de DEPART, jamais a
    // `PLAYER_MAX_HP` — le plafond de ce joueur peut deja avoir ete releve par
    // des cartes de vitalite, et l'assertion mesurerait alors autre chose.
    expect(vie).toBeLessThan(avant);
    return vie;
  }

  it('PREMIERE MOITIE : la vie remonte, et DEUX cartes remontent deux fois plus vite', () => {
    // ⚠️ **L'empilement, pas seulement l'effet.** Un code qui regarderait
    // « ce passif est possede » sans compter les exemplaires soignerait autant
    // a une carte qu'a deux, et « la vie remonte » passerait quand meme.
    // 150 ticks (5 s) : assez pour que deux cartes se distinguent nettement
    // d'une, et assez peu pour rester sous le plafond de 100 apres blessure.
    // Assez long pour que UNE carte rende au moins 10 PV (regen baissee au playtest).
    const REGEN_TICKS = Math.ceil((10 * TICK_HZ) / PAR_SECONDE) + 30;

    function remonte(cartes: number): number {
      const room = new Room(0x0e_9e_0001);
      room.join(1);
      const blesse1 = blesse(room, 1, 700, 40);
      prend(room, 1, REGAIN, cartes);
      // ⚠️ Prendre la carte ne soigne PAS de son cote : seule « vitalite »
      // porte un soin immediat, et le confondre ici rendrait le gain mesure
      // plus grand qu'il n'est.
      expect(hpOf(room, 1)).toBe(blesse1);
      for (let t = 0; t < REGEN_TICKS; t++) {
        // La fenetre est longue : la premiere nuee atteindrait le joueur.
        room.horde.kill(
          Array.from({ length: room.horde.count }, (_, i) => room.horde.entityIdAt(i)),
        );
        room.step(DT);
      }
      const apres = hpOf(room, 1);
      // ⚠️ **Le decor doit rester SOUS le plafond**, sinon les deux mesures se
      // rejoindraient pour la mauvaise raison et « deux cartes soignent deux
      // fois plus » passerait sans rien mesurer.
      expect(apres).toBeLessThan(PLAYER_MAX_HP);
      return apres - blesse1;
    }

    // Sans carte, rien ne remonte : c'est l'etat d'avant la tache.
    expect(remonte(0)).toBe(0);

    // ⚠️ **A UN POINT PRES, et c'est le fil qui l'impose** : `hp` est un
    // flottant cote serveur (le bonus vaut `magnitude / TICK_HZ` par tick) et
    // le `SNAPSHOT` le porte en `u16`, donc `hpOf` TRONQUE. La somme de 150
    // fois 0,0666… ne tombe pas non plus pile sur 10 en virgule flottante.
    // Un point de tolerance couvre les deux ; il ne couvre pas l'ecart de dix
    // points que separe une carte de deux.
    const attendu = (PAR_SECONDE * REGEN_TICKS) / TICK_HZ;
    expect(attendu).toBeGreaterThanOrEqual(10);
    expect(remonte(1)).toBeGreaterThanOrEqual(attendu - 1);
    expect(remonte(1)).toBeLessThanOrEqual(attendu);
    expect(remonte(2)).toBeGreaterThanOrEqual(2 * attendu - 1);
    expect(remonte(2)).toBeLessThanOrEqual(2 * attendu);
  });

  it('SECONDE MOITIE : la vie PLAFONNE au maximum PERSONNEL, sans jamais le depasser', () => {
    // ⚠️ **`maxHp`, pas `PLAYER_MAX_HP`.** Le plafond suit les cartes de
    // vitalite depuis l'etape 4 : le lire dans la constante ferait d'une
    // vitalite empilee un plafond qu'aucun soin ne peut remplir.
    //
    // ⚠️ **Et le plafond est au-dela de 255**, pour que le `u16` du snapshot
    // soit reellement en jeu : une regeneration qui deborderait rendrait 4 au
    // decodage au lieu de 260, et le joueur passerait de trois barres de vie a
    // la mort en un ramassage. C'est le meme cas que le test « les points de
    // vie depassent 255 sans se replier », vu depuis le soin.
    const cartesVie = Math.ceil((256 - PLAYER_MAX_HP) / PAR_CARTE_MAX_HP);
    const maxHp = PLAYER_MAX_HP + PAR_CARTE_MAX_HP * cartesVie;
    expect(maxHp).toBeGreaterThan(255);

    const room = new Room(0x0e_9e_0002);
    room.join(1);
    prend(room, 1, VITALITE, cartesVie);
    expect(hpOf(room, 1)).toBe(maxHp);

    const vieBlesse = blesse(room, 1, 700, 40);
    prend(room, 1, REGAIN, 3);

    // Trois cartes rendent 3 x `PAR_SECONDE` par seconde : de quoi combler
    // plusieurs fois le trou en 300 ticks. Sans plafond, la vie deborderait
    // largement.
    // Assez long pour combler plusieurs fois le trou, quelle que soit la regen.
    const PLAFOND_TICKS = Math.ceil((200 * TICK_HZ) / (3 * PAR_SECONDE));
    const rendu = (3 * PAR_SECONDE * PLAFOND_TICKS) / TICK_HZ;
    expect(vieBlesse + rendu).toBeGreaterThan(maxHp);

    let plafondDepasse = false;
    for (let t = 0; t < PLAFOND_TICKS; t++) {
      // La fenetre est longue : les vagues tueraient le joueur avant la fin.
      room.horde.kill(Array.from({ length: room.horde.count }, (_, i) => room.horde.entityIdAt(i)));
      room.step(DT);
      if (hpOf(room, 1) > maxHp) {
        plafondDepasse = true;
      }
    }
    expect(plafondDepasse).toBe(false);
    expect(hpOf(room, 1)).toBe(maxHp);
  });

  it('un joueur MORT ne se releve pas, pendant qu un vivant blesse remonte', () => {
    // ⚠️ **Le seul garde qui porte cette regle est `p.hp <= 0` dans
    // `#regenerate`** — et il est MASQUE par le retour anticipe de `step` des
    // que TOUS les joueurs sont morts (la run est finie, plus rien n'avance).
    // Il faut donc un salon a deux joueurs : l'un tombe, l'autre tient la run
    // ouverte, et la mutation redevient visible.
    const room = new Room(0x0e_9e_0003);
    room.join(1);
    room.join(2);
    prend(room, 1, REGAIN, 1);
    prend(room, 2, REGAIN, 1);

    const p1 = positionOf(room, 1);
    const p2 = positionOf(room, 2);
    // Les deux positions de naissance sont assez ecartees pour qu'un monstre
    // ne touche qu'un seul joueur — sinon le « vivant » mourrait aussi.
    expect(Math.hypot(p1.x - p2.x, p1.y - p2.y)).toBeGreaterThan(200);

    const bourreau = spawnMonsterAt(room, 700, p1.x, p1.y);
    const passant = spawnMonsterAt(room, 701, p2.x, p2.y);
    for (let t = 0; t < 40; t++) {
      room.step(DT);
    }
    room.horde.kill([passant]);
    expect(hpOf(room, 2)).toBeLessThan(PLAYER_MAX_HP);

    let tickMort = -1;
    for (let t = 0; t < 400 && tickMort < 0; t++) {
      room.step(DT);
      if (hpOf(room, 1) === 0) {
        tickMort = t;
      }
    }
    expect(tickMort).toBeGreaterThanOrEqual(0);
    room.horde.kill([bourreau]);

    const vieAvant = hpOf(room, 2);
    for (let t = 0; t < 90; t++) {
      room.step(DT);
    }
    // Le mort reste mort : sans le garde, il remonterait a 6 points de vie en
    // 90 ticks et `#checkRunOver` verrait la run repartir.
    expect(hpOf(room, 1)).toBe(0);
    // Non-vacuite : la regeneration TOURNE pendant ces memes ticks.
    expect(hpOf(room, 2)).toBeGreaterThan(vieAvant);
  });
});

/**
 * Amendement du controleur (etape 7b, tache 6, point 2) : `join` applique
 * deja `accountBonuses.maxHp` au depart ET le recalcul de `grantCard` doit le
 * garder. Les deux sites sont COUPLES — corriger l'un sans l'autre fait
 * REDESCENDRE la vie maximum a la premiere carte de vitalite piochee, et ce
 * n'est pas un cas marginal : un acheteur de vitalite qui pioche une carte du
 * meme genre est un chemin tres ordinaire de la run.
 */
describe('les bonus de compte entrent en jeu a la connexion (etape 7b, tache 6)', () => {
  it('un bonus de compte sur la vitalite ne redescend jamais quand une carte de vitalite est piochee', () => {
    const vitalite = PASSIVES.find((p) => p.kind === 'maxHp');
    if (!vitalite) {
      throw new Error('fixture : aucun passif de genre maxHp');
    }
    const grants: AccountGrants = {
      bonuses: {
        fireRate: 0,
        damage: 0,
        maxHp: 40,
        speed: 0,
        regen: 0,
        pickupRadius: 0,
        armor: 0,
        xp: 0,
        gold: 0,
      },
    };
    const room = new Room(0x07_6b_0006);
    room.join(1, grants);

    const maxAvant = room.maxHpOf(1);
    expect(maxAvant).toBe(PLAYER_MAX_HP + 40);

    room.grantCard(1, { nature: CARD.PASSIVE, refId: vitalite.id });

    // La mutation « ignorer accountBonuses.maxHp au recalcul de grantCard »
    // fait DESCENDRE ce maximum au lieu de le monter : voir le rapport pour
    // la mesure.
    expect(room.maxHpOf(1)).toBeGreaterThan(maxAvant);
    expect(room.maxHpOf(1)).toBe(PLAYER_MAX_HP + 40 + vitalite.magnitude);
  });

  it('un bonus de compte nul laisse le maximum de vie a PLAYER_MAX_HP', () => {
    const room = new Room(0x07_6b_0007);
    room.join(1);
    expect(room.maxHpOf(1)).toBe(PLAYER_MAX_HP);
  });

  /**
   * Couvre le deuxieme site de la tache (sur les cinq) : un bonus de compte
   * sur la vitesse doit se voir en jeu, pas seulement dans un champ jamais lu.
   */
  it('un bonus de compte sur la vitesse s ajoute a PLAYER_SPEED en jeu', () => {
    const grants: AccountGrants = {
      bonuses: {
        fireRate: 0,
        damage: 0,
        maxHp: 0,
        speed: 50,
        regen: 0,
        pickupRadius: 0,
        armor: 0,
        xp: 0,
        gold: 0,
      },
    };
    const room = new Room(0x07_6b_0008);
    room.join(1, grants);
    const before = positionOf(room, 1);

    room.applyInput(1, 1, 127, 0);
    stepOneSecond(room);

    expect(positionOf(room, 1).x - before.x).toBeCloseTo(PLAYER_SPEED + 50, 0);
  });

  /**
   * Troisieme site (ronde de correction 1) : un bonus de compte sur la
   * cadence doit raccourcir la recharge, comme le ferait une carte
   * « cadence » — meme mesure (intervalle entre deux salves), meme arme
   * lente (la grenade) pour eviter que l'arrondi n'ecrase le bonus, voir le
   * test de cadence par cartes plus haut dans ce fichier.
   */
  it('un bonus de compte sur la cadence raccourcit la recharge d une arme', () => {
    const cadence = PASSIVES.find((p) => p.kind === 'fireRate');
    if (!cadence) {
      throw new Error('fixture : aucun passif de genre fireRate');
    }
    const GRENADE = 4;
    const base = weaponOf(GRENADE).cooldownTicks;

    function intervalle(bonus: number): number {
      const grants: AccountGrants = {
        bonuses: {
          fireRate: bonus,
          damage: 0,
          maxHp: 0,
          speed: 0,
          regen: 0,
          pickupRadius: 0,
          armor: 0,
          xp: 0,
          gold: 0,
        },
      };
      const room = new Room(0x07_6b_0009);
      room.join(1, grants);
      room.grantCard(1, { nature: CARD.WEAPON, refId: GRENADE });

      const spy = vi.spyOn(Projectiles.prototype, 'fireSalvoDirected');
      room.applyInput(1, 1, 0, 0, 127, 0);
      const tirs: number[] = [];
      // 300 ticks, comme le test de cadence par cartes : assez pour au moins
      // trois salves de grenade, et sous la periode du generateur de vagues.
      for (let t = 0; t < 300; t++) {
        room.step(DT);
      }
      for (const [arme, tick] of spy.mock.calls) {
        if (arme.id === GRENADE) {
          tirs.push(tick);
        }
      }
      spy.mockRestore();

      expect(tirs.length).toBeGreaterThanOrEqual(3);
      const ecarts = tirs.slice(1).map((t, i) => t - (tirs[i] ?? 0));
      expect(new Set(ecarts).size).toBe(1);
      return ecarts[0] ?? 0;
    }

    const attendu = (bonus: number): number => Math.max(1, Math.round(base * (1 - bonus)));

    expect(intervalle(0)).toBe(attendu(0));
    expect(intervalle(cadence.magnitude)).toBe(attendu(cadence.magnitude));
    expect(intervalle(cadence.magnitude)).toBeLessThan(intervalle(0));
  });

  /**
   * Quatrieme site : un bonus de compte sur la puissance doit augmenter le
   * degat porte par le projectile, meme mesure que le test « deux cartes de
   * puissance doublent le bonus de degats... » plus haut dans ce fichier.
   */
  it('un bonus de compte sur la puissance augmente le degat porte par le projectile', () => {
    const puissance = PASSIVES.find((p) => p.kind === 'damage');
    if (!puissance) {
      throw new Error('fixture : aucun passif de genre damage');
    }
    const base = weaponOf(BASE_WEAPON_ID).damage;

    function degatsDuPremierTir(bonus: number): number {
      const grants: AccountGrants = {
        bonuses: {
          fireRate: 0,
          damage: bonus,
          maxHp: 0,
          speed: 0,
          regen: 0,
          pickupRadius: 0,
          armor: 0,
          xp: 0,
          gold: 0,
        },
      };
      const room = new Room(0x07_6b_000a);
      room.join(1, grants);
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
    expect(degatsDuPremierTir(puissance.magnitude)).toBeCloseTo(
      base * (1 + puissance.magnitude),
      5,
    );
  });

  /**
   * Cinquieme et dernier site : un bonus de compte sur la regeneration doit
   * rendre la vie plus vite apres une blessure.
   *
   * ⚠️ **Le joueur part a sa vie maximale** (amendement, point 2 du rapport
   * de ronde 1) : sans le blesser d'abord, la regeneration ne pourrait rien
   * rendre et ce test mesurerait zero AVEC ou SANS le bonus — vingt-quatrieme
   * assertion creuse du depot. On le blesse par le vrai chemin (un monstre au
   * contact), comme le fait `blesse` dans le describe de regeneration plus
   * haut.
   */
  it('un bonus de compte sur la regeneration rend la vie plus vite apres une blessure', () => {
    const regain = PASSIVES.find((p) => p.kind === 'regen');
    if (!regain) {
      throw new Error('fixture : aucun passif de genre regen');
    }
    // Assez long pour que le bonus rende au moins 10 PV (regen baissee au playtest).
    const FENETRE = Math.ceil((10 * TICK_HZ) / regain.magnitude) + 30;

    function remonte(bonus: number): number {
      const grants: AccountGrants = {
        bonuses: {
          fireRate: 0,
          damage: 0,
          maxHp: 0,
          speed: 0,
          regen: bonus,
          pickupRadius: 0,
          armor: 0,
          xp: 0,
          gold: 0,
        },
      };
      const room = new Room(0x07_6b_000b);
      room.join(1, grants);

      const pos = positionOf(room, 1);
      const monstre = spawnMonsterAt(room, 700, pos.x, pos.y);
      for (let t = 0; t < 40; t++) {
        room.step(DT);
      }
      room.horde.kill([monstre]);
      const blesse1 = hpOf(room, 1);
      // Non-vacuite : il a bien morfle, sinon la remontee mesuree plus bas
      // serait un plafond jamais quitte, pas un soin.
      expect(blesse1).toBeLessThan(PLAYER_MAX_HP);

      const REGEN_TICKS = FENETRE;
      for (let t = 0; t < REGEN_TICKS; t++) {
        // La fenetre est longue : une nuee rapide atteindrait le joueur.
        room.horde.kill(
          Array.from({ length: room.horde.count }, (_, i) => room.horde.entityIdAt(i)),
        );
        room.step(DT);
      }
      const apres = hpOf(room, 1);
      // Reste sous le plafond pour que la mesure ne soit pas ecrasee par la
      // borne de `#regenerate`.
      expect(apres).toBeLessThan(PLAYER_MAX_HP);
      return apres - blesse1;
    }

    expect(remonte(0)).toBe(0);

    const attendu = (regain.magnitude * FENETRE) / TICK_HZ;
    expect(attendu).toBeGreaterThanOrEqual(10);
    expect(remonte(regain.magnitude)).toBeGreaterThanOrEqual(attendu - 1);
    // Un point de tolerance au-dessus aussi : le debut ET la fin sont tronques
    // par le `u16` du snapshot, et l'attendu n'est plus un entier.
    expect(remonte(regain.magnitude)).toBeLessThanOrEqual(attendu + 1);
  });

  /**
   * Sixieme site (ronde de correction 1, tache 7) : le SNAPSHOT doit porter
   * le rayon ELARGI, lu de sa source (`ORB_PICKUP_RADIUS` + le bonus), jamais
   * un nombre pose a cote. Lu a travers le decodeur (`pickupRadiusOf`, meme
   * discipline que `hpOf`) : c'est le TRANSPORT qui est eprouve, pas l'etat
   * interne du salon.
   */
  it('un bonus de compte sur le rayon de ramassage se lit elargi dans le SNAPSHOT decode', () => {
    const bonus = 50;
    const grants: AccountGrants = {
      bonuses: {
        fireRate: 0,
        damage: 0,
        maxHp: 0,
        speed: 0,
        regen: 0,
        pickupRadius: bonus,
        armor: 0,
        xp: 0,
        gold: 0,
      },
    };
    const room = new Room(0x07_6b_000c);
    room.join(1, grants);

    expect(pickupRadiusOf(room, 1)).toBe(ORB_PICKUP_RADIUS + bonus);
  });

  /**
   * Sixieme site, seconde moitie (ronde de correction 1) : la PAIRE
   * discriminante — une orbe prise entre les deux bornes ET une orbe laissee
   * au-dela, dans le MEME salon et au MEME tick. Sans la seconde moitie, un
   * rayon INFINI passerait ce test aussi bien qu'un rayon correctement
   * elargi — vingt-quatrieme assertion creuse du depot.
   *
   * ⚠️ **Les deux monstres sont repositionnes a chaque tick** (meme
   * technique que « deux niveaux gagnes au meme tick... » plus haut) : seule
   * la derive du DERNIER tick avant la mort reste, bornee a un pas de
   * marche — raison de la marge de securite au-dela du rayon elargi. Les deux
   * cibles ne sont pas colineaires (l'une en +x, l'autre en +y) pour qu'un
   * tir vise sur l'une ne puisse pas accidentellement toucher l'autre.
   */
  it('le rayon elargi ramasse une orbe entre les deux bornes, et laisse celle au-dela intacte', () => {
    const bonus = 50;
    const grants: AccountGrants = {
      bonuses: {
        fireRate: 0,
        damage: 0,
        maxHp: 0,
        speed: 0,
        regen: 0,
        pickupRadius: bonus,
        armor: 0,
        xp: 0,
        gold: 0,
      },
    };
    const room = new Room(0x07_6b_000d);
    room.join(1, grants);
    const depart = positionOf(room, 1);

    const elargi = ORB_PICKUP_RADIUS + bonus;
    const MARGE_DERIVE = 30;
    const dansLaBande = { x: depart.x + ORB_PICKUP_RADIUS + 10, y: depart.y };
    const horsPortee = { x: depart.x, y: depart.y + elargi + MARGE_DERIVE };

    const idDansLaBande = spawnMonsterAt(room, 2000, dansLaBande.x, dansLaBande.y);
    const idHorsPortee = spawnMonsterAt(room, 2001, horsPortee.x, horsPortee.y);
    let aliveA = true;
    let aliveB = true;

    const ramasses: number[] = [];
    let ticks = 0;
    while ((aliveA || aliveB) && ticks < 300) {
      aimAtNearestMonster(room, 1, ticks + 1);
      room.step(DT);
      ticks++;

      for (const lot of room.drainPickups()) {
        ramasses.push(...lot.ids);
      }

      const slotA = room.horde.slotOf(idDansLaBande);
      if (slotA >= 0) {
        room.horde.x[slotA] = dansLaBande.x;
        room.horde.y[slotA] = dansLaBande.y;
      } else {
        aliveA = false;
      }

      const slotB = room.horde.slotOf(idHorsPortee);
      if (slotB >= 0) {
        room.horde.x[slotB] = horsPortee.x;
        room.horde.y[slotB] = horsPortee.y;
      } else {
        aliveB = false;
      }
    }

    // Non-vacuite : les deux sont bien mortes avant le plafond, sinon la
    // paire suivante ne prouverait rien.
    expect(ticks).toBeLessThan(300);
    expect(ramasses).toContain(idDansLaBande);
    expect(ramasses).not.toContain(idHorsPortee);
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
   *
   * ⚠️ **C'est LA garde de l'etape 7 bis de l'etape 5a** (« moins d'ennemi au
   * debut »). Moins d'ennemis, c'est moins d'orbes, et le seuil de niveau ne
   * bouge pas : un debut trop maigre repousserait la premiere arme au lieu de
   * l'avancer. Remesure sur 40 graines apres la baisse de `WAVE1_*` (16-28 ->
   * 10-18) et l'allongement de `RAMP_WAVES` (20 -> 30) : mediane **41,3 s**,
   * maximum **50,1 s**, zero echec — contre 36,8 / 44,5 avant.
   *
   * ⚠️ Le meme releve a montre que des vagues LOURDES des le debut faisaient
   * perdre la run avant le niveau 2 dans 3 essais sur 20 : ce test serait
   * devenu intermittent a 15 %. C'est ce qui a impose `HEAVY_FIRST_WAVE`
   * (`wave-director.ts`).
   *
   * ⚠️⚠️ **GRAINE FIXEE A L'ETAPE 6a, ET CE N'EST PAS UN CONFORT.** La
   * structure en paliers coute une vague ordinaire par palier (la cinquieme
   * devient le boss, `count: 1`) et, des le palier 1, `hpScale(1) = 1,12`
   * fait passer la pietaille legere de 5 a 5,6 PV — **au-dessus des degats de
   * la dague**, donc deux coups au lieu d'un. Remesure du meme releve, 40
   * graines, budget de 100 s :
   *
   * | | Mediane | Maximum | Echecs |
   * | --- | --- | --- | --- |
   * | avant les paliers | 40,4 s | 55,1 s | **0/40** |
   * | avec les paliers | 40,9 s | 64,2 s | **1/40** (graine 10 : run perdue au palier 1) |
   *
   * Avec `new Room()` (graine tiree au hasard), ce test devenait donc
   * intermittent a 2,5 % — *« un test intermittent est pire qu'un test
   * absent »*. La graine 5 est retenue parce qu'elle passe par le palier 1 :
   * le cas DUR, a 53,9 s pour un budget de 100 s.
   *
   * ⚠️⚠️ **LE 1/40 EST RESOLU DEPUIS LA TACHE 3, et pas par
   * `PALIER_HP_SCALE`.** La cause n'etait pas la pente mais la FRONTIERE :
   * `LIGHT_HP` vaut exactement les degats de la dague, donc la premiere marche
   * de l'escalier de durabilite doublait le cout de la pietaille legere pour
   * +12 % de PV. `palierHp` (`shared/paliers.ts`) exempte desormais la chair a
   * canon de la montee. Meme releve, 40 graines, budget de 100 s :
   *
   * | Etat du code | Mediane | Maximum | Echecs |
   * | --- | --- | --- | --- |
   * | avec les paliers, sans exemption | 40,9 s | 64,2 s | **1/40** |
   * | avec l'exemption, boss pas encore reel | 41,3 s | 63,5 s | **0/40** |
   * | **+ le boss reel (aujourd'hui)** | **40,8 s** | **60,0 s** | **3/40** |
   *
   * ⚠️⚠️ **LE 3/40 N'EST PAS UN RETOUR EN ARRIERE : ce n'est pas la meme
   * cause.** Le boss porte desormais `BOSS_HP_PER_PLAYER` et apparait a 30 s sur
   * TOUTES les graines. Un joueur seul vise la menace la plus proche — donc lui
   * — et verse toute sa production dans 6 000 PV qu'il ne percera pas ; il
   * cesse de tuer, donc de ramasser des orbes, et la horde l'emporte. Quatre
   * joueurs le tuent en 87 s (`bench/boss.bench.ts`) ; un joueur, jamais.
   * Une part en revient au DECOR : `aimAtNearestMonster` vise aveuglement, la
   * ou un joueur reel laisserait le boss de cote pour continuer a moissonner la
   * horde. C'est un pire cas de comportement, pas une impossibilite.
   * **Question laissee ouverte a la tache 12 : un boss doit-il tomber dans une
   * run solo ?** Rien dans la spec ne repond, et ce jeu vise quatre joueurs.
   *
   * La graine reste fixee, et c'est elle qui empeche ce test d'etre
   * intermittent a 7,5 %. Le releve complet vit dans `bench/niveau2.bench.ts`,
   * pas ici — ce test mesure une run, pas quarante.
   */
  it('un joueur passif atteint le niveau 2 via le pipeline reel (vagues, arme de base, orbes)', () => {
    const room = new Room(5);
    room.join(1);

    let levelUps: { tick: number; level: number }[] = [];
    let totalDeaths = 0;
    let totalPickups = 0;
    const budget = TICK_HZ * 100;
    for (let i = 0; i < budget && levelUps.length === 0; i++) {
      aimAtNearestMonster(room, 1, i + 1);
      // Ce test garde le PIPELINE d'experience, pas la survie : un joueur
      // immobile finissait deja la minute a ~30 PV, et les tireurs (qui
      // blessent de 300 px, gardes par `comportements.test.ts`) le tuent avant
      // qu'un orbe ne roule jusqu'a lui.
      room.shots.shots = [];
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

describe('les zones, les marques et les brulures dans le salon (etape 5a, tache 6)', () => {
  /** La premiere arme de Braise du catalogue — jamais un identifiant recopie. */
  const ARME_BRAISE = WEAPONS.find((w) => w.element === ELEMENT.BRAISE)?.id ?? -1;
  const ARME_GIVRE = WEAPONS.find((w) => w.element === ELEMENT.GIVRE)?.id ?? -1;

  /**
   * Fait tirer le joueur 1 sur le monstre le plus proche pendant `ticks` pas,
   * et rend tous les lots de morts et toutes les zones vus au passage.
   *
   * `avantChaquePas` tourne juste avant `step`, avec le tick que ce pas va
   * simuler DEJA connu du decor : c'est la ou les tests de la tache 21 posent
   * la marque qu'une reaction va consommer.
   */
  function joue(
    room: Room,
    ticks: number,
    avantChaquePas?: (room: Room) => void,
  ): { deaths: { tick: number; ids: number[] }[]; zones: ReturnType<Room['drainZones']> } {
    const deaths: { tick: number; ids: number[] }[] = [];
    const zones: ReturnType<Room['drainZones']> = [];
    for (let i = 0; i < ticks; i++) {
      avantChaquePas?.(room);
      aimAtNearestMonster(room, 1, i + 1);
      room.step(DT);
      deaths.push(...room.drainDeaths());
      zones.push(...room.drainZones());
    }
    return { deaths, zones };
  }

  /**
   * **Le decor MINIMAL qui produit un champ au sol depuis la tache 21.**
   *
   * Un projectile ne pose plus rien : *« un projectile marque, un second
   * element declenche, la reaction laisse un champ »* (§5.1). Il faut donc
   * DEUX elements sur la meme cible pour voir un seul disque au sol — c'est
   * exactement ce que la tache 21 a rendu vrai, et ce qu'un decor a une seule
   * arme ne peut plus mettre en scene.
   *
   * Ici : le joueur 1 tire au Givre, le joueur `markBy` remet une marque de
   * Braise a chaque tick. Chaque impact declenche (§6.2, premiere ligne) et
   * chaque reaction laisse un champ de Givre aux pieds de la cible. Une fois le
   * premier champ pose, il remarque la cible et la reaction se repete meme
   * entre deux volees — c'est ce qui fait de ce decor un champ ENTRETENU.
   */
  function remarqueBraise(cible: number, markBy: number): (room: Room) => void {
    return (room) => {
      const slot = room.horde.slotOf(cible);
      if (slot >= 0) {
        room.horde.applyMark(slot, ELEMENT.BRAISE, markBy, room.tick);
      }
    };
  }

  /**
   * Un monstre qui ne meurt pas : reserve de PV gonflee a la main.
   *
   * ⚠️ Sans ca, la cible meurt en quelques ticks — et un test qui interroge
   * `slotOf` apres coup ne trouve plus rien. Ce n'est PAS le rythme de mise a
   * mort qui est teste ici, ce sont les zones et les marques.
   */
  function monstreIndestructible(room: Room, waveId: number, x: number, y: number): number {
    const id = spawnMonsterAt(room, waveId, x, y);
    room.horde.hp[room.horde.slotOf(id)] = 1e6;
    return id;
  }

  it('une arme de Braise marque et brule ce qu elle touche — et ne pose PLUS aucune zone', () => {
    // ⚠️ **La non-regression de la tache 21, vue du salon.** Ce test disait
    // l'inverse jusqu'ici : une arme elementaire posait un disque a chaque fin
    // de course. Elle MARQUE encore — c'est le seul chemin qui reste vers la
    // premiere reaction — mais le sol ne lui appartient plus.
    expect(ARME_BRAISE).toBeGreaterThanOrEqual(0);
    const room = new Room(0xbaa1_5e00);
    room.join(1);
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_BRAISE });
    const before = positionOf(room, 1);
    const cible = monstreIndestructible(room, 600, before.x + 100, before.y);

    const { zones } = joue(room, 15);

    // Le decor n'est pas creux : l'arme a bien touche, marque, et brule.
    const slot = room.horde.slotOf(cible);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(room.horde.markAt(slot, room.tick)).toBe(ELEMENT.BRAISE);
    // La BRULURE descend les PV en plus des impacts d'armes, qui sont entiers :
    // une partie fractionnaire ne peut venir que d'elle.
    expect(Number.isInteger(room.horde.hp[slot])).toBe(false);

    // Et pourtant : rien au sol, rien sur le fil.
    expect(zones).toEqual([]);
    expect(room.zoneCount).toBe(0);
    // « Zero zone » ne doit pas se lire « reserve pleine ».
    expect(room.zonesTronquees).toBe(0);
  });

  it('la REACTION, elle, laisse un champ — annonce, du bon element, du bon joueur', () => {
    // Le pendant du test precedent : ce que le projectile ne fait plus, la
    // reaction le fait. Le joueur 2 entretient la Braise, le joueur 1 declenche
    // au Givre ; le champ porte l'element et l'identite du DECLENCHEUR (voir
    // `ReactionTrigger.element`).
    expect(ARME_GIVRE).toBeGreaterThanOrEqual(0);
    const room = new Room(0xbaa1_5e10);
    room.join(1);
    room.join(2);
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    const before = positionOf(room, 1);
    const cible = monstreIndestructible(room, 601, before.x + 100, before.y);

    const { zones } = joue(room, 20, remarqueBraise(cible, 2));

    expect(zones.length).toBeGreaterThan(0);
    expect(zones.every((z) => z.kind === ELEMENT.GIVRE)).toBe(true);
    expect(zones.every((z) => z.by === 1)).toBe(true);
    // Le champ est bien la ou la reaction a eu lieu : sur l'ennemi, pas sur le
    // joueur.
    const slot = room.horde.slotOf(cible);
    const cx = room.horde.x[slot] ?? 0;
    const cy = room.horde.y[slot] ?? 0;
    expect(zones.some((z) => Math.hypot(z.x - cx, z.y - cy) < ZONE_RADIUS)).toBe(true);
  });

  /**
   * ⚠️ **Ferme une mutation HERITEE de la tache 5** (etape 5b) : `#announceZones`
   * (back/src/room.ts:1442) decodait `this.#zones.kind[z]` avant de le pousser
   * dans `#pendingZones` — indetectable tant qu'aucune reaction ne posait de
   * type non nul, puisque `zoneElement(kind) === kind` pour toute zone de
   * reaction nulle. Surchauffe (Braise + Foudre, tache 6) est la premiere
   * reaction reelle du jeu a empaqueter un nibble non nul : ce test doit
   * rougir si `#announceZones` (ou n'importe quel site en amont) redecode
   * l'octet par erreur.
   *
   * ⚠️ **Aucune arme de Foudre n'existe encore au catalogue** (elle arrive a
   * la tache 9) : ce decor s'en passe. Le joueur 1 tire l'arme de Braise
   * REELLE ; la cible est reposee marquee Foudre a la main, exactement comme
   * `remarqueBraise` repose une marque de Braise plus haut dans ce fichier.
   * Le couple (Foudre, Braise) — canonique (Braise, Foudre) — est Surchauffe,
   * quel que soit celui des deux qui vient du catalogue.
   */
  it('⚠️ Surchauffe empaquette un nibble de reaction non nul sur le fil (ferme une mutation heritee de la tache 5)', () => {
    const room = new Room(0xbaa1_5e11);
    room.join(1);
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_BRAISE });
    const before = positionOf(room, 1);
    const cible = monstreIndestructible(room, 603, before.x + 100, before.y);

    const { zones } = joue(room, 20, (r) => {
      const slot = r.horde.slotOf(cible);
      if (slot >= 0) {
        r.horde.applyMark(slot, ELEMENT.FOUDRE, 1, r.tick);
      }
    });

    expect(zones.length).toBeGreaterThan(0);
    const surchauffe = zones.find((z) => zoneReaction(z.kind) === REACTION.SURCHAUFFE);
    expect(surchauffe, 'aucune zone de Surchauffe annoncee').toBeDefined();
    // ⚠️ **La ligne qui tue la mutation.** Un decodage avant l'envoi rendrait
    // `kind` egal a son seul element (`zoneElement(kind) === kind`) : cette
    // comparaison ne peut rester vraie que si l'octet COMPLET a voyage.
    expect(surchauffe?.kind).not.toBe(zoneElement(surchauffe?.kind ?? 0));
  });

  it('une mort par BRULURE part dans le meme lot DEATHS que les morts par projectile', () => {
    // ⚠️ **Le rejeu de l'etape 3 en depend** : `GameClient#drainPendingDeaths`
    // suppose « un seul lot par tick » et rejouerait le second par-dessus la
    // correction du premier. Ce test met en scene un tick ou les deux chemins
    // tuent : un monstre acheve par la brulure seule (PV mis a un cheveu de
    // zero, marque a la main) et un autre acheve par un projectile.
    const GRAINE = 0xbaa1_5e01;

    /**
     * Rejoue le meme salon deux fois. La premiere passe (`armeLaBrulure` a
     * `null`) sert a APPRENDRE a quel tick le projectile tue ; la seconde
     * arme la brulure juste avant, pour que les deux morts tombent au MEME
     * tick. Rejouable a l'identique : meme graine, memes entrees.
     */
    function run(tickDArmement: number | null): {
      deaths: { tick: number; ids: number[] }[];
      parProjectile: number;
      parBrulure: number;
    } {
      const room = new Room(GRAINE);
      room.join(1);
      const before = positionOf(room, 1);
      const parProjectile = spawnMonsterAt(room, 601, before.x + 60, before.y);
      // Assez loin pour que le joueur ne vise jamais celui-la.
      const parBrulure = spawnMonsterAt(room, 602, before.x - 900, before.y);
      const deaths: { tick: number; ids: number[] }[] = [];
      for (let i = 0; i < 30; i++) {
        if (tickDArmement !== null && room.tick === tickDArmement - 1) {
          const s = room.horde.slotOf(parBrulure);
          room.horde.hp[s] = elementOf(ELEMENT.BRAISE).burnPerTick / 2;
          room.horde.applyMark(s, ELEMENT.BRAISE, 1, room.tick);
        }
        aimAtNearestMonster(room, 1, i + 1);
        room.step(DT);
        deaths.push(...room.drainDeaths());
      }
      return { deaths, parProjectile, parBrulure };
    }

    const reperage = run(null);
    const tickProjectile = reperage.deaths.find((b) =>
      b.ids.includes(reperage.parProjectile),
    )?.tick;
    expect(tickProjectile).toBeDefined();

    const { deaths, parProjectile, parBrulure } = run(tickProjectile ?? 0);

    // UN SEUL lot a ce tick-la, portant les DEUX identites.
    const auTick = deaths.filter((b) => b.tick === tickProjectile);
    expect(auTick.length).toBe(1);
    expect(auTick[0]?.ids).toContain(parProjectile);
    expect(auTick[0]?.ids).toContain(parBrulure);
  });

  it('le champ de Givre ne d une REACTION ralentit la horde : le monstre arrive moins loin', () => {
    // ⚠️ **La preuve que le ralentissement traverse tout le salon**, du tir a
    // la position — et la chaine s'est allongee d'un maillon a la tache 21 :
    // tir → reaction → champ → ralentissement. Une arme de Givre ne ralentit
    // plus rien A ELLE SEULE, puisqu'elle ne pose plus de disque ; il lui faut
    // un second element sur la cible.
    //
    // Deux salons de MEME graine, meme monstre, meme marque de Braise remise a
    // chaque tick, meme visee : seule l'arme du joueur 1 change. Sans le Givre,
    // aucune reaction, donc aucun champ, donc aucun ralentissement.
    expect(ARME_GIVRE).toBeGreaterThanOrEqual(0);
    const GRAINE = 0xbaa1_5e02;

    function distanceParcourue(armeId: number | null): { d: number; zones: number } {
      const room = new Room(GRAINE);
      room.join(1);
      room.join(2);
      if (armeId !== null) {
        room.grantCard(1, { nature: CARD.WEAPON, refId: armeId });
      }
      const before = positionOf(room, 1);
      const cible = monstreIndestructible(room, 610, before.x + 200, before.y);
      const x0 = room.horde.x[room.horde.slotOf(cible)] ?? 0;
      const y0 = room.horde.y[room.horde.slotOf(cible)] ?? 0;
      joue(room, 60, remarqueBraise(cible, 2));
      const slot = room.horde.slotOf(cible);
      expect(slot).toBeGreaterThanOrEqual(0);
      return {
        d: Math.hypot((room.horde.x[slot] ?? 0) - x0, (room.horde.y[slot] ?? 0) - y0),
        zones: room.zoneCount,
      };
    }

    const neutre = distanceParcourue(null);
    const givre = distanceParcourue(ARME_GIVRE);
    // ⚠️ Les deux moities du decor, dites plutot que supposees : le temoin ne
    // pose AUCUN champ, la moitie elementaire en pose au moins un. Sans ces
    // deux comptes, « il avance moins loin » se lirait aussi bien « il a ete
    // gene par autre chose ».
    expect(neutre.zones).toBe(0);
    expect(givre.zones).toBeGreaterThan(0);
    expect(neutre.d).toBeGreaterThan(0);
    expect(givre.d).toBeLessThan(neutre.d);
  });

  /**
   * **Etape 3 bis de la tache 10 : le trafic des rafraichissements, borne.**
   *
   * Une prolongation DOIT etre annoncee — sinon le client derive la mort de SA
   * zone d'un `bornTick` perime, elle s'eteint chez lui pendant qu'elle vit
   * encore chez le serveur, et le ralentissement du Givre diverge. Mais
   * annoncer chaque fusion fait suivre au trafic la **cadence des armes**,
   * exactement le couplage que la regle de pose venait de supprimer pour le
   * COMPTE : 9,67 ko/s par client a 30 zones arrosees a chaque tick (banc
   * `zones`), contre 1,22 ko/s de trafic TOTAL a l'etape 4.
   *
   * La parade est dans `ZoneField.spawn` : **l'annonce EST la verite**, une
   * prolongation par `ZONE_REFRESH_INTERVAL_TICKS` au plus, et entre deux le
   * serveur ne prolonge pas non plus. Les annonces doivent donc croitre avec
   * le TEMPS, jamais avec la cadence.
   */
  function annoncesEntretenues(
    graine: number,
    ticks: number,
    cartesDeCadence: number,
  ): { zones: ReturnType<Room['drainZones']>; cooldown: number } {
    const room = new Room(graine);
    room.join(1);
    room.join(2);
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    const cadence = PASSIVES.find((p) => p.kind === 'fireRate')?.id ?? -1;
    for (let k = 0; k < cartesDeCadence; k++) {
      room.grantCard(1, { nature: CARD.PASSIVE, refId: cadence });
    }
    const before = positionOf(room, 1);
    // Increvable : ce sont les annonces qui sont comptees, pas la mise a mort.
    // Un monstre qui meurt cesserait d'arreter les projectiles, et la zone
    // entretenue se deplacerait avec eux.
    const cible = spawnMonsterAt(room, 620, before.x + 100, before.y);
    room.horde.hp[room.horde.slotOf(cible)] = 1e6;

    // Depuis la tache 21, ce n'est plus la volee qui entretient le champ mais
    // la REACTION : le joueur 2 remet la Braise, le Givre du joueur 1 la
    // declenche, et chaque reaction rearrose le meme point.
    const { zones } = joue(room, ticks, remarqueBraise(cible, 2));
    const loadout = room.loadoutOf(1);
    return {
      zones,
      cooldown: cooldownWithBonus(
        weaponOf(ARME_GIVRE).cooldownTicks,
        loadout?.bonus('fireRate') ?? 0,
      ),
    };
  }

  it('le salon expose combien de zones il porte, et combien il en a perdues', () => {
    // ⚠️ **Sans ce lecteur, `ZoneField.truncatedZones` n'avait AUCUN appelant
    // hors de son propre test unitaire** : le second rideau de
    // `ZONE_CAPACITY` se serait declenche sans que rien ne le dise. Meme motif
    // que `projectilesTronques`.
    const room = new Room(0xbaa1_5e0f);
    room.join(1);
    room.join(2);
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    const before = positionOf(room, 1);
    const cible = spawnMonsterAt(room, 660, before.x + 100, before.y);
    room.horde.hp[room.horde.slotOf(cible)] = 1e6;

    expect(room.zoneCount).toBe(0);
    const { zones } = joue(room, 20, remarqueBraise(cible, 2));

    // Le compte du salon EST celui des points annonces : deux facons
    // independantes de compter la meme chose, et elles doivent s'accorder.
    expect(room.zoneCount).toBe(new Set(zones.map((z) => `${z.x},${z.y}`)).size);
    expect(room.zoneCount).toBeGreaterThan(0);
    // ⚠️ **`zonesTronquees` n'est GARDE par rien de plus que ce zero** —
    // mutation appliquee, « rendre 0 » survit. Remplir 128 creneaux demande
    // plus de zones que quatre joueurs n'en posent en une duree de vie, et
    // aucun test unitaire ne peut les faire naitre a un cout raisonnable. Dit
    // tel quel plutot que credite d'un test qui ne le tient pas — meme choix
    // que le `slot < 0` de `resolveProjectileDamage`.
    expect(room.zonesTronquees).toBe(0);
  });

  it('une zone entretenue n est re-annoncee qu une fois par demi-vie : le trafic suit le TEMPS', () => {
    const long = annoncesEntretenues(0xbaa1_5e03, ZONE_LIFETIME_TICKS * 3, 0);

    // ⚠️ **« Plusieurs annonces au meme point » ne prouve RIEN.** Une zone
    // jamais prolongee MOURRAIT au bout de `ZONE_LIFETIME_TICKS` et renaitrait
    // au meme pixel au tir suivant : deux annonces au meme point, exactement
    // comme un rafraichissement. Ce qui les separe, c'est l'ECART — une
    // prolongation arrive STRICTEMENT AVANT la peremption, une renaissance
    // jamais.
    const parPoint = new Map<string, number[]>();
    for (const z of long.zones) {
      const cle = `${z.x},${z.y}`;
      const suite = parPoint.get(cle) ?? [];
      suite.push(z.bornTick);
      parPoint.set(cle, suite);
    }
    const ecarts = [...parPoint.values()].flatMap((suite) =>
      suite.slice(1).map((t, i) => t - (suite[i] ?? 0)),
    );
    expect(
      ecarts.some((e) => e < ZONE_LIFETIME_TICKS),
      'aucune zone n a ete PROLONGEE : elles sont seulement mortes et renees',
    ).toBe(true);
    // Et chaque annonce porte le tick auquel elle a ete faite, jamais un tick
    // fige a la creation.
    expect(new Set(long.zones.map((z) => z.bornTick)).size).toBeGreaterThan(1);

    // ⚠️ **Le compte des TIRS, sinon « peu d'annonces » se lirait « peu de
    // poses ».** La cadence de l'arme est strictement plus serree que
    // l'intervalle de prolongation : sans la parade, chaque volee annoncerait.
    expect(long.cooldown).toBeLessThan(ZONE_REFRESH_INTERVAL_TICKS);
    const volees = Math.floor((ZONE_LIFETIME_TICKS * 3) / long.cooldown);
    expect(long.zones.length).toBeLessThan(volees);

    // Croit avec le temps : trois fois moins de ticks, moins d'annonces.
    const court = annoncesEntretenues(0xbaa1_5e03, ZONE_LIFETIME_TICKS, 0);
    expect(court.zones.length).toBeLessThan(long.zones.length);
  });

  it('et PAS avec la cadence : la meme duree, une arme plus rapide, le meme plafond d annonces', () => {
    // ⚠️ **C'est l'assertion du §3.3 de l'orientation** — le trafic ne doit
    // dependre ni du nombre d'entites ni de la cadence des armes. Les cartes
    // de cadence multiplient les poses ; les annonces, elles, ne doivent pas
    // bouger d'un message.
    const ticks = ZONE_LIFETIME_TICKS * 3;
    const lente = annoncesEntretenues(0xbaa1_5e0e, ticks, 0);
    const rapide = annoncesEntretenues(0xbaa1_5e0e, ticks, 4);

    // Le decor a bien change de cadence : sans ce compte, deux runs identiques
    // rendraient trivialement le meme nombre d'annonces.
    const ratioCadence = lente.cooldown / rapide.cooldown;
    // 1,3 et pas davantage : `MAX_FIRE_RATE_BONUS` plafonne le gain de
    // cadence, et un seuil derive de ce plafond vaut mieux qu'un nombre choisi.
    expect(ratioCadence).toBeGreaterThan(1.3);

    // ⚠️ **La borne se lit PAR POINT, parce que c'est par zone qu'elle vit.**
    // Une arme plus rapide couvre un peu plus de terrain — le monstre avance
    // entre deux volees — donc elle peut CREER une zone de plus ; ce qu'elle
    // ne doit jamais faire, c'est en re-annoncer une plus souvent.
    for (const run of [lente, rapide]) {
      const parPoint = new Map<string, number[]>();
      for (const z of run.zones) {
        const cle = `${z.x},${z.y}`;
        const suite = parPoint.get(cle) ?? [];
        suite.push(z.bornTick);
        parPoint.set(cle, suite);
      }
      const ecarts = [...parPoint.values()].flatMap((suite) =>
        suite.slice(1).map((t, i) => t - (suite[i] ?? 0)),
      );
      // Le decor entretient bien AU MOINS une zone : sinon « jamais plus
      // serre que l'intervalle » se lirait « jamais rafraichie ».
      expect(ecarts.some((e) => e < ZONE_LIFETIME_TICKS)).toBe(true);
      for (const e of ecarts) {
        expect(e, `deux annonces du meme point a ${e} ticks d ecart`).toBeGreaterThanOrEqual(
          ZONE_REFRESH_INTERVAL_TICKS,
        );
      }
    }

    // Et globalement : le trafic ne suit PAS le rapport des cadences.
    expect(rapide.zones.length / lente.zones.length).toBeLessThan(ratioCadence);
  });

  it('un champ marque un ennemi que RIEN n a touche — c est le seul chemin qui le puisse', () => {
    // ⚠️ **Sans ce test, retirer `markInZones` de `Room.step` ne fait rougir
    // personne** (mutation appliquee, verifiee) : tous les autres cas ont un
    // ennemi qui prend un projectile, et le projectile marque deja. Il faut
    // donc un ennemi que le champ couvre et que RIEN n'a touche.
    //
    // ⚠️ **Et depuis la tache 21, le voisin ne suffit plus.** `REACTION_RADIUS`
    // (90) est plus GRAND que `ZONE_RADIUS` (70) : tout ce qui se trouve dans
    // un champ au moment de sa pose a forcement pris les degats de la reaction
    // qui l'a pose. « Il n'a rien pris » ne peut donc plus se prouver par la
    // geometrie — il faut le TEMPS. Le temoin est tenu tres loin pendant que la
    // reaction a lieu, puis amene dans le champ une fois le tir arrete.
    expect(REACTION_RADIUS).toBeGreaterThan(ZONE_RADIUS);
    const room = new Room(0xbaa1_5e05);
    room.join(1);
    room.join(2);
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    const before = positionOf(room, 1);
    const cible = monstreIndestructible(room, 640, before.x + 100, before.y);
    // Tres loin : hors de tout projectile et de tout rayon de reaction.
    const temoin = monstreIndestructible(room, 641, before.x + 6000, before.y + 6000);

    joue(room, 20, remarqueBraise(cible, 2));

    // Un champ existe, et le temoin n'a rien pris : sa reserve est intacte au
    // pixel pres.
    expect(room.zoneCount).toBeGreaterThan(0);
    expect(room.horde.hp[room.horde.slotOf(temoin)]).toBe(1e6);
    expect(room.horde.markAt(room.horde.slotOf(temoin), room.tick)).toBe(ELEMENT.NEUTRE);

    // On l'amene DANS le champ, et on cesse de tirer : plus de volee, plus de
    // marque a declencher, donc plus aucune reaction. Ce qui lui arrive
    // ensuite ne peut venir que du balayage des champs.
    const slotCible = room.horde.slotOf(cible);
    const zx = room.horde.x[slotCible] ?? 0;
    const zy = room.horde.y[slotCible] ?? 0;
    const slotTemoin = room.horde.slotOf(temoin);
    room.horde.x[slotTemoin] = zx;
    room.horde.y[slotTemoin] = zy;
    for (let i = 0; i < 3; i++) {
      room.applyInput(1, 900 + i, 0, 0, 0, 0);
      room.step(DT);
    }

    const apres = room.horde.slotOf(temoin);
    expect(apres).toBeGreaterThanOrEqual(0);
    // La preuve qu'il n'a rien pris : ses PV n'ont pas bouge d'un pixel.
    expect(room.horde.hp[apres]).toBe(1e6);
    expect(room.horde.markAt(apres, room.tick)).toBe(ELEMENT.GIVRE);
  });

  it('un tick sans pose n annonce rien', () => {
    // Le garde `bornTick === #tick` de `#announceZones` : sans lui, toutes les
    // zones vivantes seraient re-annoncees a chaque tick.
    const room = new Room(0xbaa1_5e04);
    room.join(1);
    room.join(2);
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    const before = positionOf(room, 1);
    const cible = monstreIndestructible(room, 630, before.x + 100, before.y);
    joue(room, 20, remarqueBraise(cible, 2));
    // Le decor a bien pose : sans ca, « plus rien ne s'annonce » se lirait
    // « rien ne s'est jamais annonce ».
    expect(room.zoneCount).toBeGreaterThan(0);
    expect(room.drainZones()).toEqual([]);

    // Un tick de plus, sans visee ET sans marque a declencher : aucune
    // reaction, donc aucune pose.
    room.applyInput(1, 999, 0, 0, 0, 0);
    room.step(DT);
    expect(room.drainZones()).toEqual([]);
  });
});

describe('la reaction dans le salon (etape 5a, tache 7)', () => {
  const ARME_GIVRE = WEAPONS.find((w) => w.element === ELEMENT.GIVRE)?.id ?? -1;
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? 0;

  it('annonce la reaction : couple canonicalise, position, tick', () => {
    // Le joueur 2 entretient la marque de Braise, le joueur 1 la declenche au
    // Givre. Ce test-ci ne regarde que le TRANSPORT — couple, ou, quand ; la
    // regle de Synergie que ce couple d'identites declenche a son propre
    // `describe` plus bas (tache 8).
    expect(ARME_GIVRE).toBeGreaterThanOrEqual(0);
    const room = new Room(0xbaa1_5e07);
    room.join(1);
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    const before = positionOf(room, 1);
    const cible = spawnMonsterAt(room, 700, before.x + 100, before.y, LOURD);
    room.horde.hp[room.horde.slotOf(cible)] = 1e6;

    const reactions: ReturnType<Room['drainReactions']> = [];
    for (let i = 0; i < 20; i++) {
      // Le joueur 2 remet sa marque a chaque tick : sans ca, la premiere
      // reaction la consomme et la zone de Givre reprend la place.
      const slot = room.horde.slotOf(cible);
      room.horde.applyMark(slot, ELEMENT.BRAISE, 2, room.tick);
      aimAtNearestMonster(room, 1, i + 1);
      room.step(DT);
      reactions.push(...room.drainReactions());
    }

    expect(reactions.length).toBeGreaterThan(0);
    const first = reactions[0];
    // ⚠️ Le SEUL chemin legitime pour le couple : sans canonicalisation,
    // Braise+Givre et Givre+Braise porteraient deux octets differents pour le
    // meme evenement, et deux clients dessineraient deux flashs differents.
    expect(first?.pair).toBe(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE));
    expect(first?.tick).toBeGreaterThan(0);
    // La reaction a lieu SUR l'ennemi, pas sur le joueur.
    expect(Math.hypot((first?.x ?? 0) - (before.x + 100), (first?.y ?? 0) - before.y)).toBeLessThan(
      ZONE_RADIUS,
    );
  });

  it('un tick sans reaction n annonce rien', () => {
    // Le pendant de « un tick sans pose n annonce rien » : sans ce test, une
    // file qui ne se viderait jamais passerait inapercue.
    const room = new Room(0xbaa1_5e08);
    room.join(1);
    spawnMonsterAt(room, 701, 2000, 2000, LOURD);
    for (let i = 0; i < 10; i++) {
      aimAtNearestMonster(room, 1, i + 1);
      room.step(DT);
    }
    expect(room.drainReactions()).toEqual([]);
  });

  it('les morts d une reaction partent dans le lot DEATHS EXISTANT, un seul par tick', () => {
    // ⚠️ **Le rejeu de l'etape 3 en depend** : `GameClient#drainPendingDeaths`
    // suppose « un seul lot par tick » et rejouerait le second par-dessus la
    // correction du premier. Un amas de pietaille lourde marquee Braise, un
    // projectile de Givre : la reaction en tue plusieurs D UN COUP, et tout
    // doit tenir dans le lot du tick.
    const room = new Room(0xbaa1_5e09);
    room.join(1);
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    const before = positionOf(room, 1);
    const amas: number[] = [];
    for (let i = 0; i < 5; i++) {
      const id = spawnMonsterAt(room, 710 + i, before.x + 100, before.y + i * 8, LOURD);
      amas.push(id);
    }

    const deaths: { tick: number; ids: number[] }[] = [];
    for (let i = 0; i < 30; i++) {
      for (const id of amas) {
        const slot = room.horde.slotOf(id);
        if (slot >= 0) {
          room.horde.applyMark(slot, ELEMENT.BRAISE, 2, room.tick);
        }
      }
      aimAtNearestMonster(room, 1, i + 1);
      room.step(DT);
      deaths.push(...room.drainDeaths());
    }

    // La reaction a bien eu lieu, et elle a tue : sans ca le test ne prouve
    // rien. `REACTION_DAMAGE > HEAVY_HP`, donc un choc emporte tout l'amas.
    const gros = deaths.find((b) => b.ids.length >= 3);
    expect(gros).toBeDefined();

    // UN SEUL lot par tick, sur toute la course.
    const ticks = deaths.map((b) => b.tick);
    expect(new Set(ticks).size).toBe(ticks.length);
    // Et aucune identite listee deux fois : les trois passes (projectiles,
    // reactions, brulures) tournent chacune apres la compaction de la
    // precedente.
    const ids = deaths.flatMap((b) => b.ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('la reaction traverse le salon en entier (etape 5a, tache 7)', () => {
  const ARME_GIVRE = WEAPONS.find((w) => w.element === ELEMENT.GIVRE)?.id ?? -1;
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? 0;

  it('une reaction declenchee par un IMPACT est annoncee — le chemin le plus facile a perdre', () => {
    // ⚠️ **Mutation appliquee, elle survivait avant ce test.** Vider les
    // reactions AVANT `markInZones` jette celles que les projectiles et les
    // poses de zone ont deja declenchees, et le salon continue d'en annoncer
    // par les zones : le defaut passe inapercu si le decor produit des
    // reactions par plusieurs chemins a la fois. Ce test n'en laisse QU UN.
    //
    // Deux passes, comme pour les brulures : la premiere APPREND a quel tick
    // le premier projectile touche (aucune marque, donc aucune reaction — et
    // c'est verifie), la seconde pose la marque de Braise juste avant ce
    // tick-la. Une seule marque, une seule reaction, et elle ne peut venir que
    // de l'impact : la premiere zone de Givre nait de ce meme impact, et la
    // marque est deja consommee quand `markInZones` la balaie.
    const GRAINE = 0xbaa1_5e0a;

    function run(tickDArmement: number | null): {
      reactions: ReturnType<Room['drainReactions']>;
      impact: number | null;
    } {
      const room = new Room(GRAINE);
      room.join(1);
      room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_GIVRE });
      const before = positionOf(room, 1);
      const cible = spawnMonsterAt(room, 720, before.x + 120, before.y, LOURD);
      // Increvable : on teste la marque et la reaction, pas la mise a mort.
      room.horde.hp[room.horde.slotOf(cible)] = 1e6;
      const reactions: ReturnType<Room['drainReactions']> = [];
      let impact: number | null = null;
      for (let i = 0; i < 40; i++) {
        if (tickDArmement !== null && room.tick === tickDArmement - 1) {
          room.horde.applyMark(room.horde.slotOf(cible), ELEMENT.BRAISE, 2, room.tick);
        }
        aimAtNearestMonster(room, 1, i + 1);
        room.step(DT);
        reactions.push(...room.drainReactions());
        if (impact === null && (room.horde.hp[room.horde.slotOf(cible)] ?? 0) < 1e6) {
          impact = room.tick;
        }
      }
      return { reactions, impact };
    }

    const sonde = run(null);
    expect(sonde.impact).not.toBeNull();
    // ⚠️ La sonde ne masque rien : sans marque, ce decor ne produit AUCUNE
    // reaction. Ce qui suit ne peut donc venir que de la marque armee.
    expect(sonde.reactions).toEqual([]);

    const { reactions } = run(sonde.impact);
    expect(reactions.length).toBe(1);
    expect(reactions[0]?.tick).toBe(sonde.impact);
    expect(reactions[0]?.pair).toBe(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE));
  });

  it('une mort par REACTION part dans le meme lot DEATHS qu une mort par projectile', () => {
    // ⚠️ **Mutation appliquee, elle survivait avant ce test.** Mettre les
    // morts de reaction dans un lot A PART passe inapercu tant que la reaction
    // est la SEULE a tuer ce tick-la : il n'y a alors qu'un lot de toute
    // facon. C'est la fixture qui masque, et il faut donc un tick ou les DEUX
    // chemins tuent.
    //
    // `GameClient#drainPendingDeaths` suppose « un seul lot par tick » et
    // rejouerait le second par-dessus la correction du premier.
    //
    // ⚠️ **Deux joueurs qui visent dans deux directions opposees, depuis la
    // tache 21.** Le decor precedent tenait sur « les zones de Givre posees a
    // chaque impact couvrent le voisin » — ce chemin n'existe plus. Il faut
    // maintenant un ATELIER a reactions (une cible remarquee de Braise a chaque
    // tick, arrosee de Givre : chaque reaction y laisse un champ, et le champ
    // redeclenche au tick suivant) et, LOIN de lui, une cible ordinaire que les
    // projectiles tuent. Les deux points sont a plus de `REACTION_RADIUS` l'un
    // de l'autre, sinon les degats de reaction acheveraient aussi la premiere.
    const GRAINE = 0xbaa1_5e0b;
    const ECART = 400;

    /**
     * Premiere passe (`tickDArmement` a `null`) : apprendre a quel tick les
     * projectiles tuent `parProjectile`. Seconde : donner a `parReaction`
     * exactement `REACTION_DAMAGE` points de vie juste avant ce tick-la, pour
     * que les deux morts tombent ensemble.
     */
    function run(tickDArmement: number | null): {
      deaths: { tick: number; ids: number[] }[];
      parProjectile: number;
      parReaction: number;
    } {
      const room = new Room(GRAINE);
      room.join(1);
      room.join(2);
      room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_GIVRE });
      room.grantCard(2, { nature: CARD.WEAPON, refId: ARME_GIVRE });
      const p1 = positionOf(room, 1);
      const p2 = positionOf(room, 2);
      // Le joueur 1 tire vers +x, le joueur 2 vers +y : chacun sa cible, et
      // aucun projectile ne traverse l'autre scene.
      const parProjectile = spawnMonsterAt(room, 730, p1.x + ECART, p1.y, LOURD);
      const parReaction = spawnMonsterAt(room, 731, p2.x, p2.y + ECART, LOURD);
      room.horde.hp[room.horde.slotOf(parReaction)] = 1e6;
      // Le decor ne prouverait rien si les deux scenes se touchaient : une
      // reaction porte a `REACTION_RADIUS`.
      expect(ECART).toBeGreaterThan(2 * REACTION_RADIUS);

      const deaths: { tick: number; ids: number[] }[] = [];
      for (let i = 0; i < 90; i++) {
        const s = room.horde.slotOf(parReaction);
        if (s >= 0) {
          room.horde.applyMark(s, ELEMENT.BRAISE, 3, room.tick);
          if (tickDArmement !== null && room.tick === tickDArmement - 1) {
            // ⚠️ **Une reserve que le choc emporte A COUP SUR, armure
            // comprise.** Elle valait `REACTION_DAMAGE` pile, ce qui en
            // faisait un decor de BORNE la ou ce test ne parle que de DATE :
            // depuis l'etape 5b, l'armure de la lourde rabote le choc a 21,25
            // et la cible survivrait a 3,75 PV. La borne `<= 0`, elle, a son
            // propre test dans `combat.test.ts`.
            room.horde.hp[s] = 1;
          }
        }
        room.applyInput(1, i + 1, 0, 0, 127, 0);
        room.applyInput(2, i + 1, 0, 0, 0, 127);
        room.step(DT);
        deaths.push(...room.drainDeaths());
      }
      return { deaths, parProjectile, parReaction };
    }

    const reperage = run(null);
    const tickProjectile = reperage.deaths.find((b) =>
      b.ids.includes(reperage.parProjectile),
    )?.tick;
    expect(tickProjectile).toBeDefined();
    // La sonde ne masque rien : sans l'armement, l'atelier ne tue personne.
    expect(reperage.deaths.some((b) => b.ids.includes(reperage.parReaction))).toBe(false);

    const { deaths, parProjectile, parReaction } = run(tickProjectile ?? 0);

    const auTick = deaths.filter((b) => b.tick === tickProjectile);
    expect(auTick.length).toBe(1);
    expect(auTick[0]?.ids).toContain(parProjectile);
    expect(auTick[0]?.ids).toContain(parReaction);
  });
});

/**
 * **Le livrable du §13, arbitre cote serveur** : *« une reaction inter-joueurs
 * charge la barre, une reaction solo non »*. La tache 10 le rejouera sur
 * quatre sockets reelles ; ici, c'est la REGLE elle-meme qui est mise a
 * l'epreuve, la ou elle vit.
 */
describe('le compteur de Synergie (etape 5a, tache 8)', () => {
  const ARME_BRAISE = WEAPONS.find((w) => w.element === ELEMENT.BRAISE)?.id ?? -1;
  const ARME_GIVRE = WEAPONS.find((w) => w.element === ELEMENT.GIVRE)?.id ?? -1;
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? 0;
  const GRAINE = 0xbaa1_5e0c;

  /**
   * Le decor des deux moities, au SEUL detail qui les separe : `markBy`.
   *
   * Deux joueurs dans le salon des deux cotes, le meme monstre au meme
   * endroit, la meme graine, le meme nombre de ticks. Le joueur 1 tire au
   * Givre et declenche ; qui a pose la Braise est le seul parametre. Tout le
   * reste — physique, positions, ticks — est bit pour bit identique, et le
   * test le VERIFIE plutot que de le supposer.
   *
   * ⚠️ **Le joueur 2 est reellement dans le salon, meme dans la moitie ou il
   * ne fait rien.** Un decor ou il n'existerait que comme un numero pose sur
   * une marque laisserait planer le doute : la barre ne monte-t-elle pas parce
   * que le joueur est le meme, ou parce qu'il n'y a personne d'autre ? Il ne
   * vise jamais (`Room.join` met la visee a zero, et rien ne la pousse), donc
   * il ne tire pas et ne trouble rien.
   *
   * ⚠️ **Et ce `join(2)` n'est GARDE par aucune assertion — sonde appliquee,
   * pas raisonnee.** Le retirer laisse ces trois tests verts : la regle du §7
   * ne compare que deux indices, elle ne demande a personne d'etre connecte.
   * Il reste ici parce qu'un decor ou le joueur 2 ne serait qu'un numero pose
   * sur une marque laisserait le doute entier — mais il est dit tel quel,
   * plutot que credite d'un test qui ne le tient pas (meme choix que le garde
   * de `#checkRunOver`). Ce qui prouve reellement que la charge survit a une
   * vraie socket, c'est `server.test.ts`, et la tache 10 a quatre clients.
   */
  function scene(markBy: number, ticks: number) {
    const room = new Room(GRAINE);
    room.join(1);
    room.join(2);
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    const before = positionOf(room, 1);
    const cible = spawnMonsterAt(room, 800, before.x + 100, before.y, LOURD);
    // Increvable : ce sont les charges qui sont comptees, pas la mise a mort.
    room.horde.hp[room.horde.slotOf(cible)] = 1e6;

    const reactions: ReturnType<Room['drainReactions']> = [];
    for (let i = 0; i < ticks; i++) {
      // La marque se consomme a chaque reaction (§4.3) : la reposer chaque
      // tick est ce qui rend la reaction repetable, donc la barre comptable.
      room.horde.applyMark(room.horde.slotOf(cible), ELEMENT.BRAISE, markBy, room.tick);
      aimAtNearestMonster(room, 1, i + 1);
      room.step(DT);
      reactions.push(...room.drainReactions());
    }
    return { synergie: synergyOf(room), reactions };
  }

  /** Une reaction sans son bit de charge : ce qui doit etre identique des deux cotes. */
  function sansCharge(r: { pair: number; x: number; y: number; tick: number }) {
    return { pair: r.pair, x: r.x, y: r.y, tick: r.tick };
  }

  it('deux joueurs differents chargent la barre ; le meme joueur des deux cotes ne charge RIEN', () => {
    expect(ARME_GIVRE).toBeGreaterThanOrEqual(0);
    const aDeux = scene(2, 15);
    const seul = scene(1, 15);

    // ⚠️ **La seconde moitie est celle qui porte le sens.** Un compteur qui
    // monterait a CHAQUE reaction — donc sans aucune comparaison — passerait
    // la premiere assertion sans broncher. C'est exactement le mecanisme que
    // le §6.5 de l'orientation appelle « le cœur du projet » : la cooperation
    // devient une ressource visible, et elle ne se gagne QUE des que deux
    // joueurs sont dans la meme melee.
    expect(aDeux.synergie).toBeGreaterThan(0);
    expect(seul.synergie).toBe(0);

    // ⚠️ **Et la preuve que le decor separe vraiment les deux cas** (constat
    // R24 de la tache 7 : une illustration qui ne les separe pas est une
    // assertion creuse). Sans ce qui suit, « la barre ne bouge pas » se lirait
    // aussi bien « aucune reaction n'a eu lieu » — et le test passerait avec
    // un salon ou plus rien ne reagit.
    // PLUSIEURS reactions, pas une : « toutes sans charge » sur un echantillon
    // de un ne dirait pas grand-chose. Ce decor en produit une douzaine.
    expect(seul.reactions.length).toBeGreaterThan(3);
    expect(seul.reactions.map(sansCharge)).toEqual(aDeux.reactions.map(sansCharge));

    // Le bit annonce, reaction par reaction, ce que la comparaison a rendu.
    expect(aDeux.reactions.every((r) => r.synergyCharge)).toBe(true);
    expect(seul.reactions.every((r) => r.synergyCharge)).toBe(false);
    // Une charge par reaction inter-joueurs, pas une de plus ni de moins.
    expect(aDeux.synergie).toBe(aDeux.reactions.length);
  });

  it('un seul joueur, ses deux armes elementaires : la reaction a lieu et ne rapporte rien — par construction', () => {
    // ⚠️ **Aucune marque posee a la main ici.** Le joueur 1 porte une arme de
    // Braise ET une de Givre : il marque et declenche lui-meme, par le jeu.
    // C'est la preuve que « en solo la barre ne monte jamais » est une
    // propriete DU MODELE et pas une convention du harnais — un joueur seul ne
    // peut ecrire que sa propre identite des deux cotes de la comparaison, et
    // aucune ligne de code n'a a le verifier.
    //
    // C'est voulu, pas un effet de bord : le §6.5 en fait un outil de
    // regroupement qui fonctionne PAR LE GAIN, jamais par la punition. Le
    // joueur seul ne perd rien — sa reaction fait ses degats comme celle de
    // n'importe qui. Il ne gagne simplement pas la charge d'equipe.
    expect(ARME_BRAISE).toBeGreaterThanOrEqual(0);
    const room = new Room(0xbaa1_5e0d);
    room.join(1);
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_BRAISE });
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    const before = positionOf(room, 1);
    const cible = spawnMonsterAt(room, 810, before.x + 100, before.y, LOURD);
    room.horde.hp[room.horde.slotOf(cible)] = 1e6;

    const reactions: ReturnType<Room['drainReactions']> = [];
    for (let i = 0; i < 60; i++) {
      aimAtNearestMonster(room, 1, i + 1);
      room.step(DT);
      reactions.push(...room.drainReactions());
    }

    // La reaction a bien lieu — sinon le test ne prouve rien du tout.
    expect(reactions.length).toBeGreaterThan(0);
    expect(reactions.every((r) => r.synergyCharge === false)).toBe(true);
    expect(synergyOf(room)).toBe(0);
  });

  it('la barre plafonne a SYNERGY_MAX, et rien ne la depense jamais', () => {
    // ⚠️ **Le plafond est le comportement VOULU, pas un oubli.** L'ultime
    // d'equipe que la barre pleine declenche est hors perimetre de l'etape 5a
    // (§1) : a cette etape la barre se charge, s'affiche, et ne se depense
    // JAMAIS. Le dire ici, sinon quelqu'un « corrigera » un jour ce plafond en
    // le prenant pour un compteur qu'on aurait oublie de remettre a zero.
    const assezDeReactions = SYNERGY_MAX * 3;
    const { synergie, reactions } = scene(2, assezDeReactions);

    // Le decor a produit STRICTEMENT plus de charges que le plafond : sans ce
    // compte, un plafond jamais atteint se lirait comme un plafond respecte.
    expect(reactions.filter((r) => r.synergyCharge).length).toBeGreaterThan(SYNERGY_MAX);
    expect(synergie).toBe(SYNERGY_MAX);

    // ⚠️ Et le bit continue de dire vrai une fois la barre pleine : il annonce
    // la COMPARAISON — deux joueurs differents — pas le mouvement de la jauge.
    // Le total, lui, fait foi dans le SNAPSHOT, et le client n'a rien a
    // recalculer.
    expect(reactions[reactions.length - 1]?.synergyCharge).toBe(true);
  });
});

describe('le palier structure la run (etape 6a, tache 2)', () => {
  /**
   * Retire de la horde tout sauf les identites `garder`.
   *
   * ⚠️ **Le decor doit produire ce qu'il pretend mesurer.** Ces tests mesurent
   * le PALIER, pas la capacite d'un joueur solo a survivre une minute sous
   * quatre vagues : sans ce nettoyage, ils finiraient par mesurer un `RUN_OVER`
   * et deviendraient intermittents au premier reglage de vague. `Horde.kill`
   * court-circuite volontairement le salon — ces morts-la ne doivent ni
   * compter, ni laisser d'orbe, ni faire monter de niveau.
   */
  function viderSauf(room: Room, garder: readonly (number | null)[]): void {
    const ids: number[] = [];
    for (let i = 0; i < room.horde.count; i++) {
      const id = room.horde.entityIdAt(i);
      if (!garder.includes(id)) {
        ids.push(id);
      }
    }
    if (ids.length > 0) {
      room.horde.kill(ids);
    }
  }

  /** PV poses a l'apparition sur la premiere entite d'un ordre, et ceux de son archetype. */
  function pvALApparition(room: Room, order: WaveOrder): { poses: number; archetype: number } {
    const slot = room.horde.slotOf(entityIdOf(order.waveId, 0));
    expect(slot).toBeGreaterThanOrEqual(0);
    return { poses: room.horde.hp[slot] ?? 0, archetype: ARCHETYPES[order.archetype]?.hp ?? 0 };
  }

  it('les vagues continuent pendant le boss, et sa MORT ouvre le palier suivant', () => {
    const room = new Room(4242);
    room.join(1);

    // --- 1. Jusqu'a l'ordre de boss, en relevant les PV du palier 0.
    let pvPalier0: { poses: number; archetype: number } | null = null;
    for (let t = 0; t < 90 * TICK_HZ && room.bossEntityId === null; t++) {
      room.step(DT);
      for (const o of room.drainWaveOrders()) {
        pvPalier0 ??= pvALApparition(room, o);
      }
      viderSauf(room, [room.bossEntityId]);
    }

    expect(room.bossEntityId).not.toBeNull();
    expect(room.palier).toBe(0);
    // Au palier 0, l'echelle vaut exactement 1 : les PV sont ceux de
    // l'archetype, au flottant pres.
    expect(pvPalier0?.poses).toBe(pvPalier0?.archetype);

    const bossId = room.bossEntityId;
    const ancre = positionOf(room, 1);

    /**
     * ⚠️ **Le boss doit etre TENU A DISTANCE tant qu'on ne veut pas le tuer**,
     * sinon il marche jusqu'au joueur — c'est son comportement, celui de la
     * pietaille (§4 de la spec) — et le tue en une vingtaine de secondes : la
     * run se terminait et `step` revenait aussitot sans plus rien emettre.
     * Mesure faite avant de corriger : joueur a 0 pv au tick 1579, `RUN_OVER`
     * en file. Un decor qui ne peut pas produire ce qu'il mesure.
     */
    function eloignerLeBoss(): void {
      const slot = room.horde.slotOf(bossId ?? -1);
      if (slot >= 0) {
        room.horde.x[slot] = Math.min(ancre.x + 2000, MAP_SIZE - 100);
        room.horde.y[slot] = ancre.y;
      }
    }

    // --- 2. Le boss vit : les vagues continuent, et le temps ne fait pas
    // avancer le palier.
    const comptesPendantLeBoss: number[] = [];
    for (let t = 0; t < 20 * TICK_HZ; t++) {
      eloignerLeBoss();
      room.step(DT);
      for (const o of room.drainWaveOrders()) {
        comptesPendantLeBoss.push(o.count);
      }
      viderSauf(room, [bossId]);
    }

    // ⚠️ **L'assertion qui empeche une « correction » future.** L'intuition
    // « le boss, seul, en duel » est fausse pour ce genre : un bullet heaven ou
    // la horde disparait est un jeu qui s'arrete (§2 de la spec).
    expect(comptesPendantLeBoss.length).toBeGreaterThan(0);
    expect(comptesPendantLeBoss.every((c) => c > 1)).toBe(true);
    // Vingt secondes de plus, et toujours le palier 0 : il se termine a une
    // MORT, pas a un tick.
    expect(room.palier).toBe(0);
    expect(room.bossEntityId).toBe(bossId);

    // --- 3. Une mort ORDINAIRE ne termine pas le palier.
    //
    // ⚠️ **Sans cette moitie, « le palier se termine a la mort du BOSS » se lit
    // aussi bien comme « a la premiere mort venue ».** Le lot de morts du tick
    // est unique et melange tout le monde : c'est la comparaison d'identite,
    // et elle seule, qui distingue le boss du reste.
    const figurant = spawnMonsterAt(room, 8000, ancre.x + 100, ancre.y);
    let figurantMort = false;
    for (let t = 0; t < 20 * TICK_HZ && !figurantMort; t++) {
      eloignerLeBoss();
      viderSauf(room, [bossId, figurant]);
      aimAtNearestMonster(room, 1, 5000 + t);
      room.step(DT);
      for (const lot of room.drainDeaths()) {
        figurantMort ||= lot.ids.includes(figurant);
      }
    }

    expect(figurantMort).toBe(true);
    expect(room.palier).toBe(0);
    expect(room.bossEntityId).toBe(bossId);

    // --- 4. Le boss meurt, par le chemin de mort normal du salon.
    //
    // ⚠️ **Sa reserve est RAMENEE A UN COUP, et c'est du decor, pas une
    // triche.** Depuis la tache 3, le boss porte `BOSS_HP_PER_PLAYER` : un joueur
    // solo a la dague ne l'entame pas en trente secondes, et ce test
    // mesurerait alors une DPS au lieu de mesurer un palier. Ce qui est teste
    // ici est le CHEMIN — les degats du salon, le lot unique de morts, le
    // verrou qui se relache — et il est identique a 1 PV comme a 6 000. Le
    // temps de mise a mort reel est mesure ailleurs, au banc
    // `bench/boss.bench.ts`, qui est la porte du §7.
    const slotBossAffaibli = room.horde.slotOf(bossId ?? -1);
    expect(slotBossAffaibli).toBeGreaterThanOrEqual(0);
    room.horde.hp[slotBossAffaibli] = 1;

    let lots: { tick: number; ids: number[] }[] = [];
    for (let t = 0; t < 30 * TICK_HZ && room.palier === 0; t++) {
      const slot = room.horde.slotOf(bossId ?? -1);
      if (slot >= 0) {
        room.horde.x[slot] = ancre.x + 100;
        room.horde.y[slot] = ancre.y;
      }
      viderSauf(room, [bossId]);
      aimAtNearestMonster(room, 1, 10_000 + t);
      room.step(DT);
      lots = lots.concat(room.drainDeaths());
    }

    expect(room.palier).toBe(1);
    expect(room.bossEntityId).toBeNull();
    // Le boss est bien passe par le lot UNIQUE de morts du tick, celui de
    // l'etape 3 — pas par un second chemin invente pour lui.
    expect(lots.some((l) => l.ids.includes(bossId ?? -1))).toBe(true);

    // --- 5. Au palier 1, les PV d'apparition suivent `palierHp`.
    //
    // ⚠️ **`palierHp`, plus `hpScale`** (tache 3, etape 0) : la pietaille
    // LEGERE est exemptee de la montee, donc l'ordre ordinaire qui tombe ici
    // peut tres bien rendre exactement les PV de son archetype. Comparer a
    // `hpScale(1)` en dur rendrait ce test dependant de l'archetype tire —
    // c'est-a-dire intermittent au premier changement de graine.
    //
    // Deux vagues, pas une : la premiere donne les PV a l'apparition, la
    // seconde sert de temoin — voir l'assertion finale.
    // Le joueur cesse de viser : la visee de la section 4 tirerait sur le
    // temoin (et, depuis plusieurs boss a la fois, sur le boss suivant).
    room.applyInput(1, 20_000, 0, 0, 0, 0);
    let pvPalier1: { poses: number; archetype: number } | null = null;
    let temoin = -1;
    let vaguesSuivantes = 0;
    for (let t = 0; t < 60 * TICK_HZ && vaguesSuivantes === 0; t++) {
      room.step(DT);
      // Une vague est un GROUPE d'ordres au meme tick : on n'en prend que le
      // principal, et on compte les vagues, pas les ordres.
      const o = room.drainWaveOrders().find((x) => x.count > 1);
      if (o) {
        if (pvPalier1 === null) {
          pvPalier1 = pvALApparition(room, o);
          temoin = entityIdOf(o.waveId, 0);
        } else {
          vaguesSuivantes++;
        }
      }
      viderSauf(room, [room.bossEntityId, temoin]);
    }

    expect(pvPalier1).not.toBeNull();
    expect(pvPalier1?.poses).toBeCloseTo(palierHp(pvPalier1?.archetype ?? 0, 1), 4);

    // ⚠️ **L'echelle s'applique aux entites NEES a ce tick, pas a la horde
    // entiere.** Un `#scalePalierHp(0)` la reappliquerait a tout le monde a
    // chaque vague : un monstre deja la se renforcerait de 12 % toutes les six
    // secondes, indefiniment. Rien d'autre dans ce fichier ne le verrait.
    expect(vaguesSuivantes).toBe(1);
    const slotTemoin = room.horde.slotOf(temoin);
    expect(slotTemoin).toBeGreaterThanOrEqual(0);
    expect(room.horde.hp[slotTemoin]).toBeCloseTo(pvPalier1?.poses ?? 0, 4);

    // --- 6. LA MOITIE QUI COMPTE : au palier 1, quelque chose monte VRAIMENT.
    //
    // ⚠️ **Sans elle, la section 5 passe avec une echelle constamment egale a
    // 1** — elle se reduit alors aux PV de l'archetype, exactement comme au
    // palier 0, et depuis l'exemption de la chair a canon c'est meme le cas le
    // plus PROBABLE (quatre vagues sur cinq sont legeres). Le temoin choisi est
    // le boss du palier 1 : c'est le seul dont la montee soit garantie par
    // construction, sans dependre d'un tirage d'archetype.
    let pvBoss1: { poses: number; archetype: number } | null = null;
    for (let t = 0; t < 60 * TICK_HZ && pvBoss1 === null; t++) {
      room.step(DT);
      for (const o of room.drainWaveOrders()) {
        if (o.count === 1) {
          pvBoss1 = pvALApparition(room, o);
        }
      }
      // Tout le monde dehors, boss compris : on n'attend que l'ORDRE du
      // prochain boss. Un boss garde en vie tuerait le joueur avant (depuis
      // qu'un boss vient sans attendre la mort du precedent).
      viderSauf(room, []);
    }

    expect(pvBoss1).not.toBeNull();
    expect(pvBoss1?.archetype).toBe(BOSS_HP_PER_PLAYER);
    expect(pvBoss1?.poses).toBeCloseTo(BOSS_HP_PER_PLAYER * hpScale(1), 4);
    expect(pvBoss1?.poses).toBeGreaterThan(BOSS_HP_PER_PLAYER);
  }, 30_000);

  it('plusieurs boss peuvent vivre a la fois : le suivant n attend pas la mort du premier', () => {
    // Retour de playtest : *« on peut avoir plusieurs boss en meme temps »*.
    const room = new Room(4242);
    room.join(1);
    const ancre = positionOf(room, 1);
    const boss = (): number[] =>
      Array.from({ length: room.horde.count }, (_, i) => i)
        .filter((i) => room.horde.archetype[i] === BOSS_ARCHETYPE)
        .map((i) => room.horde.entityIdAt(i));
    for (let t = 0; t < 3 * 60 * TICK_HZ && boss().length < 2; t++) {
      // Les boss gardes, loin du joueur ; tout le reste dehors.
      const vivants = boss();
      viderSauf(room, vivants);
      for (const id of vivants) {
        const slot = room.horde.slotOf(id);
        room.horde.x[slot] = Math.min(ancre.x + 2000, MAP_SIZE - 100);
        room.horde.y[slot] = ancre.y;
      }
      room.step(DT);
      room.drainWaveOrders();
    }
    expect(boss().length).toBeGreaterThanOrEqual(2);
    // La barre suit le PLUS ANCIEN.
    expect(room.bossEntityId).toBe(boss()[0]);
  }, 60_000);

  it("un boss qui n'a pas pu apparaitre est redemande, et personne ne le croit vivant", () => {
    // ⚠️ **Le seul cas ou le verrou du palier pourrait ne jamais se relacher.**
    // `Horde.spawn` tronque a `capacity` : une horde pleine au moment ou l'ordre
    // de boss tombe ne fait naitre personne, et le boss designe par le verrou
    // n'existe pas — donc il ne mourra jamais, et le palier serait fige pour le
    // reste de la run.
    const room = new Room(4242);
    room.join(1);

    let ordinaires = 0;
    let ordresBoss = 0;
    let rempli = false;
    for (let t = 0; t < 60 * TICK_HZ && ordresBoss === 0; t++) {
      // La horde n'est remplie qu'une fois les `WAVES_PER_PALIER` vagues
      // ordinaires passees, donc juste avant l'echeance du boss : la remplir
      // des le debut ferait tourner soixante secondes de simulation a 4 000
      // entites pour rien. Le declencheur est DERIVE du compte de vagues, pas
      // d'un numero de tick recopie.
      if (!rempli && ordinaires >= WAVES_PER_PALIER) {
        room.horde.spawn({
          waveId: 9000,
          spawnTick: room.tick,
          seed: 7,
          archetype: 0,
          formation: FORMATION.CLUSTER,
          anchorX: MAP_SIZE - 200,
          anchorY: MAP_SIZE - 200,
          count: MAX_ENTITIES,
        });
        expect(room.horde.count).toBe(MAX_ENTITIES);
        rempli = true;
      }
      room.step(DT);
      for (const o of room.drainWaveOrders()) {
        if (o.count === 1) {
          ordresBoss++;
        } else {
          ordinaires++;
        }
      }
      if (!rempli) {
        // Meme raison que dans le test precedent, et mesuree de la meme
        // facon : un joueur passif qui ne tire pas meurt sous les quatre
        // premieres vagues avant le tick 900, `step` revient alors aussitot,
        // et l'ordre de boss ne tombe jamais.
        viderSauf(room, []);
      }
    }

    expect(rempli).toBe(true);
    expect(ordresBoss).toBe(1);
    // Personne ne croit le boss vivant : le salon n'enregistre une identite que
    // si l'entite est reellement nee.
    expect(room.bossEntityId).toBeNull();

    // La horde se vide : le boss doit revenir a la prochaine echeance.
    viderSauf(room, []);
    for (let t = 0; t < 30 * TICK_HZ && room.bossEntityId === null; t++) {
      room.step(DT);
      room.drainWaveOrders();
    }

    expect(room.bossEntityId).not.toBeNull();
    // ⚠️ Et le palier n'a PAS avance : un boss jamais apparu n'est pas un boss
    // vaincu. Sans cette ligne, `bossMissing` et `bossDefeated` seraient
    // interchangeables.
    expect(room.palier).toBe(0);
  }, 30_000);
});

/**
 * Le boss vit DANS la horde (etape 6a, tache 3, etape 2 du plan).
 *
 * ⚠️ **Rien n'a ete ecrit pour lui, et c'est ce que ce bloc verifie.**
 * Identite arithmetique, champ de flux, separation, collision, orbes, marques
 * elementaires : il est une vague de `count: 1` avec un archetype different, et
 * tout le reste marche parce que quatre etapes l'ont construit. Le §1.2 de la
 * spec : *« seules deux choses le distinguent, et elles sont hors de la
 * horde »*.
 */
describe('le boss vit dans la horde (etape 6a, tache 3)', () => {
  const ARME_BRAISE = WEAPONS.find((w) => w.element === ELEMENT.BRAISE)?.id ?? -1;
  const ARME_GIVRE = WEAPONS.find((w) => w.element === ELEMENT.GIVRE)?.id ?? -1;
  const LEGER = ARCHETYPES.find((a) => a.hp === LIGHT_HP)?.id ?? 0;

  /**
   * Un joueur, deux armes elementaires, une cible a portee — **et AUCUNE
   * marque posee a la main, AUCUN `hp = 1e6`**.
   *
   * C'est le point : tous les decors de reaction de l'etape 5a devaient rendre
   * leur cible increvable pour qu'une marque ait le temps d'etre consommee. Ce
   * decor-ci ne triche pas, et c'est la reserve du JEU qui decide.
   *
   * ⚠️ **`reserve` est ce que le SALON aurait pose, pas une valeur de
   * confort.** `spawnMonsterAt` court-circuite `Room#step`, donc ni l'echelle
   * du palier ni la multiplication par le nombre de joueurs (tache 3 bis) ne
   * s'appliquent : l'appelant les compose par `bossHp`, exactement comme le
   * banc `bench/boss.bench.ts` le fait pour son duel. Sans ce parametre, ce
   * decor mesurerait le boss d'UN joueur en le presentant comme LE boss.
   */
  function scene(
    archetype: number,
    reserve?: number,
  ): {
    reactions: ReturnType<Room['drainReactions']>;
    morte: boolean;
    pvDepart: number;
    pvFin: number;
  } {
    const room = new Room(0xb055_0001);
    room.join(1);
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_BRAISE });
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    const ancre = positionOf(room, 1);
    const cible = spawnMonsterAt(room, 730, ancre.x + 120, ancre.y, archetype);
    if (reserve !== undefined) {
      room.horde.hp[room.horde.slotOf(cible)] = reserve;
    }
    const pvDepart = room.horde.hp[room.horde.slotOf(cible)] ?? 0;

    const reactions: ReturnType<Room['drainReactions']> = [];
    let morte = false;
    for (let i = 0; i < 120; i++) {
      // La cible reste ou elle est : on mesure une reaction, pas une poursuite.
      const s = room.horde.slotOf(cible);
      if (s >= 0) {
        room.horde.x[s] = ancre.x + 120;
        room.horde.y[s] = ancre.y;
      }
      aimAtNearestMonster(room, 1, i + 1);
      room.step(DT);
      reactions.push(...room.drainReactions());
      for (const lot of room.drainDeaths()) {
        morte ||= lot.ids.includes(cible);
      }
    }
    const s = room.horde.slotOf(cible);
    return { reactions, morte, pvDepart, pvFin: s >= 0 ? (room.horde.hp[s] ?? 0) : 0 };
  }

  /**
   * ⚠️ **LES DEUX MOITIES, et la premiere est le piege que l'etape 5a a
   * paye.** Un banc peuplait de pietaille legere, tuee du meme impact, donc
   * jamais marquee : il rendait zero partout et paraissait vert. Ici la
   * pietaille legere EST la moitie temoin — elle doit rendre zero reaction ET
   * mourir, sinon le zero ne prouve rien. Le boss est la seconde moitie : il
   * encaisse, donc il porte, donc la reaction se voit.
   */
  it('est le premier ennemi sur qui une reaction se voie — la pietaille legere meurt avant', () => {
    const legere = scene(LEGER);
    // Le decor a bien tue : le zero qui suit est un zero de MARQUE, pas un
    // zero de « rien ne s'est passe ».
    expect(legere.morte).toBe(true);
    expect(legere.reactions).toEqual([]);

    // ⚠️ **Le boss d'une equipe PLEINE, et il faut dire pourquoi.** Depuis la
    // tache 3 bis, un boss n'a pas une reserve mais quatre — une par effectif.
    // Le §4 de la spec (*« le premier ennemi qui survivra assez longtemps pour
    // qu'une reaction se voie »*) parle du jeu que ce projet vise, qui est a
    // quatre ; et le joueur unique de ce decor porte DEUX armes elementaires,
    // soit deja la puissance de feu d'une equipe.
    //
    // ⚠️ **Mesure faite en passant, a garder** : avec la reserve d'un joueur
    // SEUL (1 500 PV), ce meme decor tue le boss en 2,5 s — 55 reactions a
    // 25 PV. Une equipe qui tient deux elements fond un boss par les
    // reactions, pas par ses armes. C'est un resultat de la tache 3 bis, pas
    // un incident, et c'est a la tache 12 d'en juger en jeu.
    const boss = scene(BOSS_ARCHETYPE, bossHp(0, MAX_PLAYERS));
    // Sa reserve vaut des dizaines de reactions : c'est CA qui laisse a une
    // marque le temps de se consommer sur lui.
    expect(boss.pvDepart).toBeGreaterThan(REACTION_DAMAGE * 10);
    // Il porte les marques comme tout le monde, et il vit assez pour qu'elles
    // se consomment (§4 de la spec).
    expect(boss.reactions.length).toBeGreaterThan(0);
    expect(boss.reactions[0]?.pair).toBe(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE));
    // Et il SURVIT a la reaction — c'est ce qui la rend visible plutot que
    // mortelle : `REACTION_DAMAGE` emporte un lourd entier, pas lui.
    expect(boss.morte).toBe(false);
    expect(boss.pvFin).toBeLessThan(boss.pvDepart);
    expect(boss.pvFin).toBeGreaterThan(REACTION_DAMAGE);
  }, 30_000);

  /**
   * L'ordre de boss traverse le generateur sans rien de special : `count: 1`,
   * l'archetype de boss, et une identite arithmetique comme les autres.
   *
   * ⚠️ **`count: 1` est une regle, pas un reglage** (§1.1) : la vie du boss n'a
   * le droit de voyager que parce qu'il est UN.
   */
  it('apparait comme une vague de count 1, avec l archetype de boss', () => {
    const room = new Room(4242);
    room.join(1);

    let ordreBoss: WaveOrder | null = null;
    const ordinaires: WaveOrder[] = [];
    for (let t = 0; t < 90 * TICK_HZ && ordreBoss === null; t++) {
      room.step(DT);
      for (const o of room.drainWaveOrders()) {
        if (room.bossEntityId !== null && entityIdOf(o.waveId, 0) === room.bossEntityId) {
          ordreBoss = o;
        } else {
          ordinaires.push(o);
        }
      }
      // La horde est videe a chaque tick : ce test mesure un ordre, pas une
      // survie (voir `viderSauf` plus haut, meme intention).
      const ids: number[] = [];
      for (let i = 0; i < room.horde.count; i++) {
        const id = room.horde.entityIdAt(i);
        if (id !== room.bossEntityId) {
          ids.push(id);
        }
      }
      if (ids.length > 0) {
        room.horde.kill(ids);
      }
    }

    expect(ordreBoss).not.toBeNull();
    expect(ordreBoss?.count).toBe(1);
    expect(ordreBoss?.archetype).toBe(BOSS_ARCHETYPE);
    // Le decor a bien produit les DEUX cas : sans vagues ordinaires avant lui,
    // « le boss a l'archetype de boss » se lirait aussi bien avec un
    // generateur qui ne sait plus produire que des boss.
    expect(ordinaires.length).toBeGreaterThanOrEqual(WAVES_PER_PALIER);
    expect(ordinaires.every((o) => o.archetype !== BOSS_ARCHETYPE)).toBe(true);
    expect(ordinaires.every((o) => o.count > 1)).toBe(true);
  }, 30_000);
});

/**
 * Les PV du boss suivent le nombre de joueurs (etape 6a, tache 3 bis).
 *
 * > *« les PV du boss doivent dependre du nombre de joueurs »* — decision de
 * > l'auteur, apres la mesure de la tache 3 : quatre joueurs tuaient le boss en
 * > 87 s, **un joueur seul ne le tuait jamais**, et 3 graines sur 40 y
 * > perdaient leur run avant le niveau 2 (`bench/niveau2.bench.ts`).
 *
 * ⚠️ **La formule vit dans `shared/paliers.ts` et elle y est testee pour
 * elle-meme.** Ce bloc-ci teste ce que le SALON en fait, et lui seul : le
 * nombre de joueurs qu'il lui passe, et le MOMENT ou il le lit.
 */
describe('les PV du boss suivent le nombre de joueurs (etape 6a, tache 3 bis)', () => {
  /**
   * Avance jusqu'a l'apparition du boss du palier 0 et rend son creneau.
   *
   * ⚠️ **La horde est videe a chaque tick** — meme intention que `viderSauf`
   * plus haut : ce decor mesure une RESERVE a l'apparition, pas la survie d'un
   * joueur immobile sous quatre vagues. Sans ce nettoyage il mesurerait un
   * `RUN_OVER`, et le boss ne tomberait jamais.
   */
  function jusquAuBoss(room: Room): number {
    for (let t = 0; t < 90 * TICK_HZ && room.bossEntityId === null; t++) {
      room.step(DT);
      room.drainWaveOrders();
      const ids: number[] = [];
      for (let i = 0; i < room.horde.count; i++) {
        const id = room.horde.entityIdAt(i);
        if (id !== room.bossEntityId) {
          ids.push(id);
        }
      }
      if (ids.length > 0) {
        room.horde.kill(ids);
      }
    }
    expect(room.bossEntityId).not.toBeNull();
    const slot = room.horde.slotOf(room.bossEntityId ?? -1);
    expect(slot).toBeGreaterThanOrEqual(0);
    return slot;
  }

  /** PV du boss du palier 0 dans un salon de `joueurs` joueurs, meme graine. */
  function pvDuBossAvec(joueurs: number): number {
    const room = new Room(4242);
    for (let id = 1; id <= joueurs; id++) {
      room.join(id);
    }
    return room.horde.hp[jusquAuBoss(room)] ?? 0;
  }

  it('donne au boss la reserve d un joueur par joueur present a son apparition', () => {
    const solo = pvDuBossAvec(1);
    const equipe = pvDuBossAvec(MAX_PLAYERS);

    // Au palier 0 l'echelle vaut exactement 1 : le boss d'un joueur seul, c'est
    // la reserve par joueur, sans rien d'autre.
    expect(solo).toBeCloseTo(BOSS_HP_PER_PLAYER, 4);
    // ⚠️ **LA MOITIE QUI COMPTE.** Sans elle, un salon qui ignorerait le nombre
    // de joueurs passerait l'assertion precedente sans broncher — c'est
    // exactement l'etat d'avant cette tache.
    expect(equipe).toBeCloseTo(solo * MAX_PLAYERS, 4);
  });

  /**
   * ⚠️ **FIGES A L'APPARITION, et c'est une decision.** Le nombre de joueurs
   * bouge pendant un palier ; le boss, lui, est deja la. Les faire suivre
   * ferait REGAGNER de la vie a un boss entame parce qu'un joueur rejoint —
   * ca se lirait comme un bug, et la barre de vie de la tache 5 le montrerait
   * a l'ecran.
   *
   * ⚠️ **Ce test et le precedent ne se couvrent pas** : celui-la dit que le
   * nombre de joueurs COMPTE, celui-ci qu'il ne compte qu'UNE FOIS. Un salon
   * qui relirait `#players.size` a chaque tick passerait le premier.
   */
  it('fige les PV du boss a son apparition : trois joueurs qui rejoignent ne le regonflent pas', () => {
    const room = new Room(4242);
    room.join(1);
    const pvApparition = room.horde.hp[jusquAuBoss(room)] ?? 0;
    const bossId = room.bossEntityId;
    expect(pvApparition).toBeCloseTo(BOSS_HP_PER_PLAYER, 4);

    for (let id = 2; id <= MAX_PLAYERS; id++) {
      room.join(id);
    }

    for (let t = 0; t < 10 * TICK_HZ; t++) {
      // Le boss est tenu a distance : personne ne le touche, personne ne le
      // vise (aucun `applyInput`), donc tout ecart de PV viendrait de la
      // formule et d'elle seule.
      const slot = room.horde.slotOf(bossId ?? -1);
      if (slot >= 0) {
        room.horde.x[slot] = MAP_SIZE - 100;
        room.horde.y[slot] = MAP_SIZE - 100;
      }
      room.step(DT);
      room.drainWaveOrders();
      const ids: number[] = [];
      for (let i = 0; i < room.horde.count; i++) {
        const id = room.horde.entityIdAt(i);
        if (id !== bossId) {
          ids.push(id);
        }
      }
      if (ids.length > 0) {
        room.horde.kill(ids);
      }
    }

    // Le decor a bien produit le cas qu'il croit produire : les trois joueurs
    // sont REELLEMENT dans le salon. Sans ce compte, « les PV n'ont pas bouge »
    // se lirait aussi bien comme « personne n'a rejoint ».
    const out: ArrayBuffer[] = [];
    room.snapshot({ push: (b: ArrayBuffer) => out.push(b) });
    expect(decodeSnapshot(out[0] as ArrayBuffer).players).toHaveLength(MAX_PLAYERS);

    const apres = room.horde.hp[room.horde.slotOf(bossId ?? -1)] ?? 0;
    expect(apres).toBe(pvApparition);
    // Et il n'est PAS devenu le boss de quatre joueurs — l'assertion precedente
    // le dit deja, celle-ci nomme la valeur qu'il aurait prise.
    expect(apres).not.toBeCloseTo(bossHp(0, MAX_PLAYERS), 4);
  }, 30_000);
});

/**
 * La vie du boss voyage (etape 6a, tache 4).
 *
 * ⚠️ **La premiere donnee PAR ENTITE que le fil transporte, et c'est le NOMBRE
 * qui l'autorise** (§1.1 de la spec) : un seul boss vivant, jamais plus. La
 * regle est ecrite dans `shared/protocol.ts`, la ou elle risquerait d'etre
 * pliee ; ce bloc-ci verifie que le salon la sert.
 */
describe('la vie du boss voyage dans le snapshot (etape 6a, tache 4)', () => {
  /** Le boss tel que le FIL le porte — decode, jamais lu dans le salon. */
  function bossAnnonce(room: Room): { id: number; hp: number } | null {
    const out: ArrayBuffer[] = [];
    room.snapshot({ push: (b: ArrayBuffer) => out.push(b) });
    return decodeSnapshot(out[0] as ArrayBuffer).boss;
  }

  /** PV du boss dans la horde, source de verite du serveur. */
  function pvDansLaHorde(room: Room): number {
    return room.horde.hp[room.horde.slotOf(room.bossEntityId ?? -1)] ?? 0;
  }

  /** Vide la horde de tout sauf le boss — meme intention que `viderSauf`. */
  function garderLeBoss(room: Room): void {
    const ids: number[] = [];
    for (let i = 0; i < room.horde.count; i++) {
      const id = room.horde.entityIdAt(i);
      if (id !== room.bossEntityId) {
        ids.push(id);
      }
    }
    if (ids.length > 0) {
      room.horde.kill(ids);
    }
  }

  it('annonce null avant, l identite et la vie pendant, et null a nouveau apres la mort', () => {
    const room = new Room(4242);
    room.join(1);

    // --- 1. Pas de boss : le fil porte la sentinelle, que `decodeSnapshot`
    // rend comme un `null`.
    expect(bossAnnonce(room)).toBeNull();

    // --- 2. Le boss arrive.
    for (let t = 0; t < 90 * TICK_HZ && room.bossEntityId === null; t++) {
      room.step(DT);
      room.drainWaveOrders();
      garderLeBoss(room);
    }
    expect(room.bossEntityId).not.toBeNull();

    const annonce = bossAnnonce(room);
    expect(annonce?.id).toBe(room.bossEntityId);
    // ⚠️ **La vie annoncee EST celle de la horde**, pas une copie tenue a
    // cote : une seconde source de verite se decalerait au premier degat
    // soigne autrement — l'erreur que l'etape 3 a faite avec l'experience.
    expect(annonce?.hp).toBe(Math.round(pvDansLaHorde(room)));
    expect(annonce?.hp).toBeGreaterThan(0);

    // --- 3. On l'entame POUR DE VRAI, par le chemin de degats du salon : la
    // vie annoncee suit.
    const ancre = positionOf(room, 1);
    const avant = annonce?.hp ?? 0;
    for (let t = 0; t < 5 * TICK_HZ; t++) {
      const slot = room.horde.slotOf(room.bossEntityId ?? -1);
      if (slot >= 0) {
        room.horde.x[slot] = ancre.x + 120;
        room.horde.y[slot] = ancre.y;
      }
      aimAtNearestMonster(room, 1, 20_000 + t);
      room.step(DT);
      room.drainDeaths();
      garderLeBoss(room);
    }

    const apres = bossAnnonce(room);
    expect(apres?.id).toBe(room.bossEntityId);
    expect(apres?.hp).toBeLessThan(avant);
    expect(apres?.hp).toBe(Math.round(pvDansLaHorde(room)));

    // --- 4. Il meurt : le fil reprend sa sentinelle. Sa reserve est ramenee a
    // un coup — ce qui est teste ici est l'ANNONCE, pas une DPS.
    room.horde.hp[room.horde.slotOf(room.bossEntityId ?? -1)] = 1;
    for (let t = 0; t < 10 * TICK_HZ && room.bossEntityId !== null; t++) {
      const slot = room.horde.slotOf(room.bossEntityId ?? -1);
      if (slot >= 0) {
        room.horde.x[slot] = ancre.x + 120;
        room.horde.y[slot] = ancre.y;
      }
      aimAtNearestMonster(room, 1, 30_000 + t);
      room.step(DT);
      room.drainDeaths();
      garderLeBoss(room);
    }

    expect(room.bossEntityId).toBeNull();
    expect(bossAnnonce(room)).toBeNull();
  }, 30_000);

  /**
   * ⚠️ **Le cout est un cout d'EN-TETE, pas un cout par entite** : les huit
   * octets du boss sont les memes qu'il y ait un joueur ou quatre, et la horde
   * n'en paie aucun. C'est ce qui distingue « le boss est du cote des joueurs »
   * d'un debut de replication de la horde.
   */
  it('coute les memes octets, horde vide ou pleine, boss annonce ou non', () => {
    const room = new Room(4242);
    room.join(1);
    const taille = (): number => {
      const out: ArrayBuffer[] = [];
      room.snapshot({ push: (b: ArrayBuffer) => out.push(b) });
      return (out[0] as ArrayBuffer).byteLength;
    };

    // Un joueur, aucune horde, aucun boss.
    const reference = taille();

    for (let t = 0; t < 90 * TICK_HZ && room.bossEntityId === null; t++) {
      room.step(DT);
      room.drainWaveOrders();
      garderLeBoss(room);
    }
    expect(room.bossEntityId).not.toBeNull();
    // Le boss annonce ne coute rien de plus : ses huit octets sont dans
    // l'en-tete de TOUS les snapshots, sentinelle comprise.
    expect(taille()).toBe(reference);

    room.horde.spawn({
      waveId: 9000,
      spawnTick: room.tick,
      seed: 7,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: MAP_SIZE - 200,
      anchorY: MAP_SIZE - 200,
      count: 500,
    });
    // Le decor a bien produit une horde : sans ce compte, l'egalite qui suit
    // ne comparerait rien.
    expect(room.horde.count).toBeGreaterThan(100);
    // ⚠️ **Et c'est LA le contrat de replication** : cinq cents entites de
    // plus, zero octet de plus. Le boss est du cote des joueurs parce qu'il
    // est UN ; la horde reste serveur seul parce qu'elle est mille.
    expect(taille()).toBe(reference);
  }, 30_000);
});

/**
 * Etape 6a, tache 5 bis — **la charge du troll**.
 *
 * > *« Le troll charge une attaque lineaire, donc un long rectangle, et son
 * > animation le fait tourner, donc il spin rapidement a travers ce rectangle
 * > en avancant. »*
 *
 * ⚠️ **Ce n'est pas un telegraphe, c'est un DEPLACEMENT** : pendant toute la
 * charge, la position du boss vient de l'attaque et non du champ de flux. Ce
 * decor verifie le cote SERVEUR de cette bascule — l'annonce unique, la
 * direction figee, la position derivee, et les degats. La replication a
 * proprement parler, elle, se mesure dans `shared/horde.replication.test.ts`
 * (scenario 11).
 */
describe('le boss charge (etape 6a, tache 5 bis)', () => {
  /** Fait tourner le salon jusqu'a ce qu'un boss existe, en balayant la horde. */
  function jusquAuBoss(room: Room): number {
    for (let t = 0; t < 120 * TICK_HZ && room.bossEntityId === null; t++) {
      room.step(DT);
      room.drainWaveOrders();
      const ids: number[] = [];
      for (let i = 0; i < room.horde.count; i++) {
        const id = room.horde.entityIdAt(i);
        if (id !== room.bossEntityId) {
          ids.push(id);
        }
      }
      if (ids.length > 0) {
        room.horde.kill(ids);
      }
      room.drainBossCharges();
    }
    const bossId = room.bossEntityId;
    expect(bossId).not.toBeNull();
    return bossId ?? -1;
  }

  /** Vide la horde de tout sauf le boss : on mesure une charge, pas une melee. */
  function seulLeBoss(room: Room, bossId: number): void {
    const ids: number[] = [];
    for (let i = 0; i < room.horde.count; i++) {
      const id = room.horde.entityIdAt(i);
      if (id !== bossId) {
        ids.push(id);
      }
    }
    if (ids.length > 0) {
      room.horde.kill(ids);
    }
  }

  it('annonce UNE fois, tient le boss immobile pendant le chargement, puis le fait traverser le couloir sans jamais rien annoncer de plus', () => {
    const room = new Room(0xc0de_5b15);
    room.join(1);
    const bossId = jusquAuBoss(room);
    const tickApparition = room.tick;
    const ancre = positionOf(room, 1);

    // Le boss est pose a 500 px a l'ouest du joueur, donc le couloir (900 px)
    // le traversera : c'est ce qui rend la moitie « degats » de ce test
    // porteuse. Repose a chaque tick tant que rien n'est annonce — sinon il
    // marche, et l'origine du couloir ne serait plus connue d'avance.
    let charge: BossCharge | null = null;
    let annonces = 0;
    for (let t = 0; t < 10 * TICK_HZ && charge === null; t++) {
      const slot = room.horde.slotOf(bossId);
      if (slot >= 0) {
        room.horde.x[slot] = ancre.x - 500;
        room.horde.y[slot] = ancre.y;
      }
      seulLeBoss(room, bossId);
      room.step(DT);
      room.drainWaveOrders();
      const lot = room.drainBossCharges();
      annonces += lot.length;
      charge = lot[0] ?? null;
    }

    expect(charge).not.toBeNull();
    expect(annonces).toBe(1);
    if (!charge) {
      return;
    }
    expect(charge.entityId).toBe(bossId);
    // ⚠️ **Il n'arrive pas en chargeant.** Le boss apparait au bord de la carte,
    // loin de tout le monde : la premiere charge attend le meme delai que celui
    // qui separe deux charges, sans quoi son unique fenetre de reaction serait
    // dilapidee hors de portee.
    expect(charge.windupTick).toBe(tickApparition + BOSS_CHARGE_COOLDOWN_TICKS);
    // La direction est figee vers le joueur, a l'est : `dirX` proche de 1.
    expect(charge.dirX).toBeGreaterThan(0.99);

    // --- Le chargement : le boss ne bouge pas d'un pixel, et rien ne fait mal.
    const pvAvant = positionOf(room, 1);
    expect(pvAvant).toBeTruthy();
    let pv = hpOf(room, 1);
    for (let tick = charge.windupTick + 1; tick <= charge.startTick; tick++) {
      seulLeBoss(room, bossId);
      room.step(DT);
      room.drainWaveOrders();
      annonces += room.drainBossCharges().length;
      const slot = room.horde.slotOf(bossId);
      expect(room.horde.x[slot], `tick ${tick}`).toBe(charge.x);
      expect(room.horde.y[slot], `tick ${tick}`).toBe(charge.y);
    }
    expect(hpOf(room, 1), 'rien ne fait mal pendant le chargement').toBe(pv);

    // --- La traversee : la position est exactement celle que les deux cotes
    // derivent des ticks. Le joueur, lui, s'ecarte — et le couloir ne le suit
    // PAS, c'est ce qui rend l'esquive possible.
    const attendu = new Float32Array(2);
    for (let tick = charge.startTick + 1; tick <= charge.endTick; tick++) {
      seulLeBoss(room, bossId);
      room.step(DT);
      room.drainWaveOrders();
      annonces += room.drainBossCharges().length;
      chargePointAt(charge, tick, attendu);
      const slot = room.horde.slotOf(bossId);
      expect(room.horde.x[slot], `tick ${tick}`).toBe(Math.fround(attendu[0] ?? 0));
      expect(room.horde.y[slot], `tick ${tick}`).toBe(Math.fround(attendu[1] ?? 0));
    }

    // ⚠️ **ZERO OCTET APRES L'ANNONCE.** Quarante-huit ticks de charge, un
    // seul message : tout le reste s'est derive des ticks, des deux cotes.
    expect(annonces).toBe(1);

    // --- Les degats : le corps en mouvement a traverse le joueur, une fois.
    expect(hpOf(room, 1)).toBe(pv - BOSS_CHARGE_DAMAGE);
    pv = hpOf(room, 1);

    // --- Le cooldown : rien ne repart avant `endTick + BOSS_CHARGE_COOLDOWN_TICKS`.
    for (let n = 0; n < BOSS_CHARGE_COOLDOWN_TICKS - 1; n++) {
      seulLeBoss(room, bossId);
      room.step(DT);
      room.drainWaveOrders();
      expect(room.drainBossCharges(), `n=${n}`).toEqual([]);
    }
    const suivantes: BossCharge[] = [];
    for (let n = 0; n < 3; n++) {
      seulLeBoss(room, bossId);
      room.step(DT);
      room.drainWaveOrders();
      suivantes.push(...room.drainBossCharges());
    }
    expect(suivantes).toHaveLength(1);
    // Et la seconde charge repart de la position REELLE du boss a cet
    // instant, pas de l'origine de la premiere : c'est bien une nouvelle
    // annonce, pas un rejeu de l'ancienne.
    expect(suivantes[0]?.x).not.toBe(charge.x);
  }, 60_000);

  /**
   * ⚠️ **La borne « une fois par charge » se REARME a chaque annonce.** Sans le
   * vidage de l'ensemble des joueurs deja touches, un joueur encaisserait la
   * PREMIERE charge du combat et plus jamais aucune autre — un boss inoffensif
   * apres son coup d'essai, et rien dans le reste de la suite ne le dirait.
   */
  it('refait mal a la charge suivante, au meme joueur', () => {
    const room = new Room(0xc0de_5b16);
    room.join(1);
    const bossId = jusquAuBoss(room);
    const ancre = positionOf(room, 1);
    // ⚠️ Un cote DEGAGE : depuis la carte en tuiles, le boss qui charge bute
    // sur un arbre ou un rocher, et un obstacle entre lui et le joueur le
    // protegerait — c'est voulu, mais ce n'est pas ce que ce test mesure.
    const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    const mask = generateObstacles(room.mapSeed, probe.cols, probe.rows);
    const libre = (x: number, y: number): boolean =>
      mask[Math.floor(y / FLOWFIELD_CELL) * probe.cols + Math.floor(x / FLOWFIELD_CELL)] === 0;
    const cote = [
      [-500, 0],
      [500, 0],
      [0, -500],
      [0, 500],
    ].find(([dx, dy]) =>
      Array.from({ length: 21 }, (_, k) => k / 20).every((f) =>
        libre(ancre.x + (dx ?? 0) * f * 1.2, ancre.y + (dy ?? 0) * f * 1.2),
      ),
    ) ?? [-500, 0];

    /** Pose le boss d'un cote degage du joueur jusqu'a ce qu'une charge parte, puis la joue en entier. */
    function uneCharge(): { charge: BossCharge; degats: number } {
      let charge: BossCharge | null = null;
      for (let t = 0; t < 20 * TICK_HZ && charge === null; t++) {
        const slot = room.horde.slotOf(bossId);
        if (slot >= 0) {
          room.horde.x[slot] = ancre.x + (cote[0] ?? 0);
          room.horde.y[slot] = ancre.y + (cote[1] ?? 0);
        }
        seulLeBoss(room, bossId);
        room.step(DT);
        room.drainWaveOrders();
        charge = room.drainBossCharges()[0] ?? null;
      }
      if (!charge) {
        throw new Error('aucune charge annoncee');
      }
      const avant = hpOf(room, 1);
      for (let tick = charge.windupTick + 1; tick <= charge.endTick; tick++) {
        seulLeBoss(room, bossId);
        room.step(DT);
        room.drainWaveOrders();
        room.drainBossCharges();
      }
      return { charge, degats: avant - hpOf(room, 1) };
    }

    const premiere = uneCharge();
    const seconde = uneCharge();

    expect(premiere.degats).toBe(BOSS_CHARGE_DAMAGE);
    expect(seconde.degats).toBe(BOSS_CHARGE_DAMAGE);
    expect(seconde.charge.windupTick).toBeGreaterThan(premiere.charge.endTick);
  }, 60_000);
});

/**
 * Etape 6a, tache 6 — **l'or non securise**.
 *
 * > *« L'or ramasse pendant la run n'est pas acquis. Il est non securise
 * > jusqu'a l'extraction. »* (§5 de la spec)
 *
 * ⚠️ **Ce bloc a DEUX moities, et la seconde porte le sens.** L'or monte quand
 * un boss tombe **et** il tombe a `WIPE_GOLD_KEPT` quand l'equipe est effacee.
 * Sans la moitie negative, un or qui ne bougerait JAMAIS passerait la premiere
 * — c'est la lecon de la Synergie a l'etape 5a, ou seule la comparaison des
 * deux etats disait que « la barre ne bouge pas » ne voulait pas dire « rien ne
 * s'est passe ».
 *
 * ⚠️ **Le MULTIPLICATEUR d'extraction n'est pas ici** : il appartient au
 * portail (tache 9). Ce bloc ne connait que l'accumulation et la perte.
 */
describe("l'or non securise (etape 6a, tache 6)", () => {
  /** Vide la horde de tout sauf le boss courant : on mesure un or, pas une melee. */
  function seulLeBoss(room: Room): void {
    const ids: number[] = [];
    for (let i = 0; i < room.horde.count; i++) {
      const id = room.horde.entityIdAt(i);
      if (id !== room.bossEntityId) {
        ids.push(id);
      }
    }
    if (ids.length > 0) {
      room.horde.kill(ids);
    }
  }

  /**
   * Tue le boss du palier courant **par le chemin de mort normal du salon** et
   * rend le numero du palier qu'il fermait.
   *
   * ⚠️ **Sa reserve est ramenee a un coup, et c'est du decor, pas une triche** —
   * meme raison qu'a la tache 2 : ce qui est mesure ici est l'OR, pas une DPS.
   * Le temps de mise a mort reel est la porte du §7, mesuree au banc
   * `bench/boss.bench.ts`.
   *
   * ⚠️ **La horde est videe a chaque tick.** Sans ce nettoyage, ce decor
   * mesurerait la survie d'un joueur immobile sous quatre vagues : il finirait
   * en `RUN_OVER` et aucun boss ne tomberait jamais.
   */
  function tuerLeBoss(room: Room): number {
    const k = room.palier;
    for (let t = 0; t < 90 * TICK_HZ && room.bossEntityId === null; t++) {
      seulLeBoss(room);
      room.step(DT);
      room.drainWaveOrders();
      room.drainDeaths();
      room.drainBossCharges();
    }
    const bossId = room.bossEntityId;
    expect(bossId).not.toBeNull();

    const ancre = positionOf(room, 1);
    const slotAffaibli = room.horde.slotOf(bossId ?? -1);
    expect(slotAffaibli).toBeGreaterThanOrEqual(0);
    room.horde.hp[slotAffaibli] = 1;

    for (let t = 0; t < 30 * TICK_HZ && room.palier === k; t++) {
      const slot = room.horde.slotOf(bossId ?? -1);
      if (slot >= 0) {
        room.horde.x[slot] = ancre.x + 100;
        room.horde.y[slot] = ancre.y;
      }
      seulLeBoss(room);
      aimAtNearestMonster(room, 1, 20_000 + room.tick);
      room.step(DT);
      room.drainWaveOrders();
      room.drainDeaths();
      room.drainBossCharges();
    }

    expect(room.palier).toBe(k + 1);
    return k;
  }

  it('monte du bonus du palier VAINCU, a chaque boss tombe', () => {
    const room = new Room(4242);
    room.join(1);

    // Rien n'a encore ete gagne : sans cette ligne, un or initialise a
    // `palierGold(0)` passerait la suivante.
    expect(room.gold).toBe(0);

    expect(tuerLeBoss(room)).toBe(0);
    expect(room.gold).toBe(palierGold(0));

    // ⚠️ **DEUX boss, et c'est ce qui distingue le palier vaincu du palier
    // ouvert.** Avec un seul, `palierGold(#palier)` lu APRES `bossDefeated()`
    // rendrait `palierGold(1)` et rien ne le verrait — le decor doit produire
    // le cas qu'il pretend produire.
    expect(tuerLeBoss(room)).toBe(1);
    expect(room.gold).toBe(palierGold(0) + palierGold(1));

    // ⚠️ **Et il SORT du salon.** Le total part dans l'en-tete du `SNAPSHOT`,
    // a cote de l'experience et de la Synergie (tache 7) : sans cette ligne,
    // un salon qui compterait juste mais ne dirait rien passerait tout ce
    // bloc. C'est la « ligne de diffusion qu'aucun test n'atteint » du depot,
    // qui a deja laisse passer `REACTION` et `BOSS_CHARGE`.
    const out = collector();
    room.snapshot(out);
    const premier = out.sent[0];
    expect(premier).toBeDefined();
    expect(decodeSnapshot(premier ?? new ArrayBuffer(0)).gold).toBe(room.gold);

    // ⚠️ **Le decor ne discrimine que si les deux montants DIFFERENT.** Une
    // recompense plate rendrait les deux assertions ci-dessus vraies quel que
    // soit le palier lu. C'est la « fixture qui masque » du depot, prise a la
    // source.
    expect(palierGold(1)).toBeGreaterThan(palierGold(0));
  }, 60_000);

  it("tombe a WIPE_GOLD_KEPT quand l'equipe est effacee, et pas a la mort d'un seul", () => {
    const room = new Room(4242);
    room.join(1);
    room.join(2);
    tuerLeBoss(room);

    const gagne = room.gold;
    // La moitie negative ne prouve rien si la cagnotte est deja vide.
    expect(gagne).toBeGreaterThan(0);

    /**
     * Tue un joueur au contact, en tenant la horde a ce seul lot : les vagues
     * ordinaires atteindraient l'autre joueur et l'effacement arriverait trop
     * tot pour que la moitie « une mort seule ne coute rien » veuille dire
     * quelque chose.
     */
    function tuer(playerId: number): void {
      const pos = positionOf(room, playerId);
      const bourreaux: number[] = [];
      for (let i = 0; i < 25; i++) {
        bourreaux.push(spawnMonsterAt(room, 7000 + playerId * 100 + i, pos.x, pos.y));
      }
      for (let t = 0; t < 60 * TICK_HZ && hpOf(room, playerId) > 0; t++) {
        const ids: number[] = [];
        for (let i = 0; i < room.horde.count; i++) {
          const id = room.horde.entityIdAt(i);
          if (!bourreaux.includes(id)) {
            ids.push(id);
          }
        }
        if (ids.length > 0) {
          room.horde.kill(ids);
        }
        // ⚠️ **Les bourreaux sont RENDUS INTUABLES et TENUS AU CONTACT.**
        // Mesure faite avant de corriger : sans ces deux lignes, le tir
        // automatique du joueur avait liquide les vingt-cinq monstres avant
        // qu'ils ne l'aient descendu, et il se stabilisait a 28 pv pour le
        // reste du test — un decor qui ne peut pas produire ce qu'il pretend
        // mesurer. Meme technique que partout ailleurs dans ce fichier.
        for (const id of bourreaux) {
          const slot = room.horde.slotOf(id);
          if (slot >= 0) {
            room.horde.hp[slot] = 1e6;
            room.horde.x[slot] = pos.x;
            room.horde.y[slot] = pos.y;
          }
        }
        room.step(DT);
        room.drainWaveOrders();
        room.drainDeaths();
        room.drainBossCharges();
      }
      expect(hpOf(room, playerId)).toBe(0);
    }

    // --- 1. Un seul joueur tombe : le §5 de la spec dit « rien ».
    tuer(1);
    expect(hpOf(room, 2)).toBeGreaterThan(0);
    expect(room.drainRunOver()).toBeNull();
    expect(room.gold).toBe(gagne);

    // --- 2. Le second tombe : l'equipe est effacee.
    tuer(2);
    expect(room.drainRunOver()).not.toBeNull();

    // ⚠️ **La constante n'est pas recopiee en chiffre : c'est sa PROPRIETE qui
    // est assenee.** `toBe(0)` serait juste aujourd'hui et deviendrait faux le
    // jour ou l'auteur essaie le plancher de 10 a 20 % que le §9.3 nomme —
    // alors que ce test doit precisement survivre a cet essai. La ligne
    // ci-dessous garde ce qui ne doit pas changer : l'equipe conserve la
    // FRACTION `WIPE_GOLD_KEPT` de ce qu'elle avait, et rien d'autre.
    //
    // Et elle n'est pas tautologique : `WIPE_GOLD_KEPT < 1` garantit que la
    // valeur attendue DIFFERE de `gagne`, donc qu'un salon qui ne perdrait
    // rien echoue ici.
    expect(WIPE_GOLD_KEPT).toBeLessThan(1);
    expect(room.gold).toBe(Math.round(gagne * WIPE_GOLD_KEPT));
  }, 60_000);
});

describe("le portail s'ouvre toutes les PORTAL_EVERY_WAVES vagues (etape 6a, tache 9, revu au playtest)", () => {
  /** Vide la horde de tout sauf les identites `garder`. */
  function viderSauf(room: Room, garder: readonly (number | null)[]): void {
    const ids: number[] = [];
    for (let i = 0; i < room.horde.count; i++) {
      const id = room.horde.entityIdAt(i);
      if (!garder.includes(id)) {
        ids.push(id);
      }
    }
    if (ids.length > 0) {
      room.horde.kill(ids);
    }
  }

  /** Un tick, files de diffusion videes — sauf celles du portail, qu'on mesure. */
  function pas(room: Room): void {
    room.step(DT);
    room.drainWaveOrders();
    room.drainDeaths();
    room.drainBossCharges();
    room.drainPickups();
    room.drainZones();
    room.drainReactions();
  }

  /**
   * Tue le boss du palier courant **par le chemin de mort normal du salon** et
   * rend le tick de sa mort.
   *
   * ⚠️ **Sa reserve est ramenee a un coup, et c'est du decor** — meme raison
   * qu'aux taches 2 et 6 : ce qui est mesure ici est le PORTAIL, pas une DPS.
   *
   * ⚠️ **La horde est videe a chaque tick**, sans quoi ce decor mesurerait la
   * survie d'un joueur immobile sous quatre vagues : il finirait en `RUN_OVER`
   * et aucun boss ne tomberait jamais.
   *
   * ⚠️ **Il assene au passage que RIEN n'ouvre le portail avant la mort.** Un
   * portail ouvert par un tick, par un ordre de vague ou par l'apparition du
   * boss ferait rougir cette boucle-la, pas le test qui suit.
   *
   * ⚠️ **`tireur` n'est pas un confort** : le boss est pose a cote de lui et
   * c'est lui qui vise, donc il doit etre VIVANT. Le test du joueur mort tue
   * le joueur 1 avant le boss — le laisser tirer ferait mourir le boss de
   * vieillesse, et le decor mesurerait une fin de run au lieu d'un vote.
   */
  function tuerLeBoss(room: Room, tireur = 1): number {
    const k = room.palier;
    for (let t = 0; t < 90 * TICK_HZ && room.bossEntityId === null; t++) {
      viderSauf(room, [room.bossEntityId]);
      expect(room.portalOpen).toBe(false);
      pas(room);
    }
    const bossId = room.bossEntityId;
    expect(bossId).not.toBeNull();

    const ancre = positionOf(room, tireur);
    const slotAffaibli = room.horde.slotOf(bossId ?? -1);
    expect(slotAffaibli).toBeGreaterThanOrEqual(0);
    room.horde.hp[slotAffaibli] = 1;

    for (let t = 0; t < 30 * TICK_HZ && room.palier === k; t++) {
      const slot = room.horde.slotOf(bossId ?? -1);
      if (slot >= 0) {
        room.horde.x[slot] = ancre.x + 100;
        room.horde.y[slot] = ancre.y;
      }
      viderSauf(room, [bossId]);
      expect(room.portalOpen).toBe(false);
      // ⚠️ **`20_000 + tick`, pas `40_000 + tick`** : `isNewer` compare sur
      // seize bits, et une premiere sequence au-dela de 0x8000 est vue comme
      // ANCIENNE face au `lastSeq` de 0 d'un joueur qui vient d'arriver. Toutes
      // les visees etaient alors rejetees, le joueur ne tirait pas, et le boss
      // ne mourait jamais — un decor qui ne peut pas produire ce qu'il pretend
      // produire, pris en trente minutes.
      aimAtNearestMonster(room, tireur, 20_000 + room.tick);
      pas(room);
    }

    expect(room.palier).toBe(k + 1);
    return room.tick;
  }

  /**
   * Avance, horde videe a chaque tick, jusqu'a l'ouverture du portail ; rend
   * son tick. Retour de playtest : *« ne fait pas de fin a chaque boss »* — le
   * portail a son propre rythme, `PORTAL_EVERY_WAVES` vagues.
   *
   * ⚠️ **Il assene qu'il ne s'ouvre PAS avant** la vingtieme vague, et qu'il
   * s'ouvre AU TICK de celle-ci.
   */
  function ouvrirLePortail(room: Room, exact = false): number {
    let vagues = 0;
    for (let t = 0; t < 10 * 60 * TICK_HZ && !room.portalOpen; t++) {
      viderSauf(room, []);
      room.step(DT);
      // Une vague = un groupe d'ordres au meme tick.
      vagues += room.drainWaveOrders().length > 0 ? 1 : 0;
      room.drainDeaths();
      room.drainBossCharges();
      room.drainPickups();
      room.drainZones();
      room.drainReactions();
      if (!room.portalOpen) {
        expect(vagues).toBeLessThan(PORTAL_EVERY_WAVES);
      }
    }
    expect(room.portalOpen).toBe(true);
    // Sur un salon neuf, le compte est exact ; sinon des vagues ont deja pu
    // tomber avant l'appel.
    if (exact) {
      expect(vagues).toBe(PORTAL_EVERY_WAVES);
    }
    return room.tick;
  }

  it('la mort d un boss ne termine plus rien : le portail reste ferme', () => {
    const room = new Room(4242);
    room.join(1);
    tuerLeBoss(room);
    expect(room.portalOpen).toBe(false);
    expect(room.drainPortalOpens()).toEqual([]);
  }, 60_000);

  it('ouvre le portail toutes les PORTAL_EVERY_WAVES vagues, pour vingt secondes, et une seule fois', () => {
    const room = new Room(4242);
    room.join(1);

    const tickMort = ouvrirLePortail(room, true);

    expect(room.portalOpen).toBe(true);
    // ⚠️ **Le multiplicateur part AVEC l'ouverture** (tache 10) : le client ne
    // peut ni le coder en dur — c'est un reglage — ni le compter, puisqu'un
    // client connecte en cours de run n'a vu aucun des portails precedents.
    // C'est le premier portail de la run, donc le multiplicateur vaut encore 1.
    expect(room.drainPortalOpens()).toEqual([
      { deadlineTick: tickMort + PORTAL_WINDOW_TICKS, multiplier: 1 },
    ]);
    // ⚠️ Une seule annonce par portail : le second drainage est vide, sans quoi
    // le client recevrait une ouverture a chaque tick pendant vingt secondes.
    expect(room.drainPortalOpens()).toEqual([]);
    expect(room.portalDeadlineTick).toBe(tickMort + PORTAL_WINDOW_TICKS);
    // Le verdict, lui, n'est pas encore tombe : personne n'a vote.
    expect(room.drainPortalResults()).toEqual([]);
  }, 60_000);

  it('montre les votes en continu, silencieux compris, et les oublie apres le verdict', () => {
    const room = new Room(4242);
    room.join(1);
    room.join(2);
    ouvrirLePortail(room);

    // ⚠️ **La visibilite EST la mecanique** (§6) : les deux joueurs figurent
    // dans la table des l'ouverture, avant d'avoir tranche quoi que ce soit.
    // On ne negocie pas un choix qu'on ne voit pas, et « qui n'a pas encore
    // vote » fait partie de ce qu'il faut voir.
    expect([...room.portalVotes()].sort()).toEqual([
      [1, NO_VOTE],
      [2, NO_VOTE],
    ]);

    expect(room.setVote(1, VOTE_CHOICE.LEAVE)).toBe(true);
    expect(room.portalVotes().get(1)).toBe(VOTE_CHOICE.LEAVE);
    expect(room.portalVotes().get(2)).toBe(NO_VOTE);

    room.setVote(2, VOTE_CHOICE.LEAVE);
    pas(room);
    // Le portail ferme : plus rien a rediffuser, sinon le vote du palier
    // precedent reviendrait a chaque tick jusqu'au suivant.
    expect(room.portalVotes().size).toBe(0);
  }, 60_000);

  it('LE MONDE NE S ARRETE PAS : la horde avance et le joueur bouge pendant le vote', () => {
    // ⚠️ **LE test de cette tache, et la mutation qu'il existe pour tuer** : la
    // machinerie du gel est la, juste au-dessus dans `Room#step`, et elle
    // marche. Un `if (portail ouvert) { #stepPortal(); return; }` calque sur
    // celui du draft rendrait ce test rouge — et c'est le seul qui rougirait.
    // Le §6 : *« le draft gele parce qu'un choix de carte n'a pas d'enjeu
    // temporel ; le vote ne gele pas parce que le temps EST son enjeu »*.
    const room = new Room(4242);
    room.join(1);
    ouvrirLePortail(room);
    expect(room.portalOpen).toBe(true);

    const joueurAvant = positionOf(room, 1);
    const suiveur = spawnMonsterAt(room, 8100, joueurAvant.x + 900, joueurAvant.y);
    const distance = (): number => {
      const slot = room.horde.slotOf(suiveur);
      expect(slot).toBeGreaterThanOrEqual(0);
      const p = positionOf(room, 1);
      return Math.hypot((room.horde.x[slot] ?? 0) - p.x, (room.horde.y[slot] ?? 0) - p.y);
    };
    const depart = distance();
    const tickAvant = room.tick;

    for (let t = 0; t < 3 * TICK_HZ; t++) {
      viderSauf(room, [suiveur]);
      // Increvable : ce qui est mesure est un DEPLACEMENT, pas une mise a mort
      // — et le tir automatique du joueur part tout seul.
      room.horde.hp[room.horde.slotOf(suiveur)] = 1e6;
      // Le joueur, lui, marche vers la droite : un gel l'arreterait aussi.
      room.applyInput(1, 20_000 + room.tick, 127, 0);
      pas(room);
    }

    // Le vote court toujours : personne n'a tranche, l'echeance est loin.
    expect(room.portalOpen).toBe(true);
    expect(room.tick).toBe(tickAvant + 3 * TICK_HZ);

    // ⚠️ **Les DEUX moities du monde qui tourne.** La horde se rapproche...
    expect(distance()).toBeLessThan(depart - 100);
    // ...et le joueur se deplace. Un gel arreterait les deux, et une seule des
    // deux assertions laisserait la moitie de la mutation en vie.
    expect(positionOf(room, 1).x).toBeGreaterThan(joueurAvant.x + 100);
  }, 60_000);

  it("PARTIR termine la run avec l'or ACQUIS, par le RUN_OVER de l'etape 3", () => {
    const room = new Room(4242);
    room.join(1);
    // Depuis que le portail ne suit plus la mort d'un boss, rien n'a verse
    // d'or en route : la cagnotte est posee, c'est du decor.
    room.debugSetGold(240);
    ouvrirLePortail(room);
    room.drainPortalOpens();

    const cagnotte = room.gold;
    // La moitie positive ne prouve rien si la cagnotte est vide.
    expect(cagnotte).toBeGreaterThan(0);
    expect(room.drainRunOver()).toBeNull();

    expect(room.setVote(1, VOTE_CHOICE.LEAVE)).toBe(true);
    pas(room);

    expect(room.drainPortalResults()).toEqual([
      { effectTick: room.tick, decision: VOTE_CHOICE.LEAVE, gold: cagnotte },
    ]);
    const fin = room.drainRunOver();
    expect(fin).not.toBeNull();
    expect(fin?.tick).toBe(room.tick);

    // ⚠️ **L'AUTRE moitie, et c'est elle qui porte le sens** : l'or acquis
    // n'est pas l'or perdu. Le chemin de l'effacement multiplie par
    // `WIPE_GOLD_KEPT` (tache 6) ; celui-ci ne retire rien. Sans la ligne
    // ci-dessous, une extraction qui viderait la cagnotte passerait.
    expect(WIPE_GOLD_KEPT).toBeLessThan(1);
    expect(room.gold).toBe(cagnotte);

    // ⚠️ **Une seule fin de run**, et le monde s'arrete pour de bon : c'est le
    // garde de tete de `step`, celui-la meme que l'etape 3 avait pose.
    const compteAvant = room.horde.count;
    for (let t = 0; t < TICK_HZ; t++) {
      pas(room);
    }
    expect(room.drainRunOver()).toBeNull();
    expect(room.drainPortalResults()).toEqual([]);
    expect(room.horde.count).toBe(compteAvant);
  }, 60_000);

  it('RESTER majore la mise du palier suivant, et la run continue', () => {
    // ⚠️ **Le decor DOIT enchainer DEUX paliers.** Au premier portail, le
    // multiplicateur vaut 1 : une extraction immediate rendrait exactement la
    // cagnotte, et « l'or est majore » se lirait aussi bien d'un
    // multiplicateur qui ne fait rien. C'est la fixture qui masque, prise a la
    // source — la meme que la tache 6 a du eviter en tuant deux boss.
    expect(EXTRACT_MULTIPLIER_STEP).toBeGreaterThan(0);

    const room = new Room(4242);
    room.join(1);
    room.debugSetGold(240);
    ouvrirLePortail(room);
    room.drainPortalOpens();

    const apresLePremier = room.gold;
    expect(room.extractMultiplier).toBe(1);

    expect(room.setVote(1, VOTE_CHOICE.STAY)).toBe(true);
    pas(room);

    expect(room.drainPortalResults()).toEqual([
      // L'or REPORTE, pas acquis : un seul champ, dont le sens se lit dans la
      // decision.
      { effectTick: room.tick, decision: VOTE_CHOICE.STAY, gold: apresLePremier },
    ]);
    expect(room.gold).toBe(apresLePremier);
    expect(room.extractMultiplier).toBe(1 + EXTRACT_MULTIPLIER_STEP);
    // La run continue : aucune fin, et le portail s'est referme.
    expect(room.drainRunOver()).toBeNull();
    expect(room.portalOpen).toBe(false);

    // --- Le palier suivant, et l'extraction qui suit. L'or gagne entre les
    // deux portails est pose (decor), comme au premier.
    room.debugSetGold(apresLePremier + 160);
    ouvrirLePortail(room);
    const cagnotte = room.gold;
    expect(cagnotte).toBeGreaterThan(apresLePremier);
    // ⚠️ **Le SECOND portail annonce la mise majoree**, et c'est le seul
    // endroit du depot qui le dise : au premier, le multiplicateur vaut 1, et
    // une ouverture qui porterait toujours 1 y passerait sans bruit. C'est ce
    // chiffre que l'ecran du vote multiplie pour dire « ce qu'on gagne en
    // partant » (tache 10).
    expect(room.drainPortalOpens()).toEqual([
      { deadlineTick: room.tick + PORTAL_WINDOW_TICKS, multiplier: 1 + EXTRACT_MULTIPLIER_STEP },
    ]);

    room.setVote(1, VOTE_CHOICE.LEAVE);
    pas(room);

    expect(room.gold).toBe(extractGold(cagnotte, 1 + EXTRACT_MULTIPLIER_STEP));
    // Et la majoration se VOIT : sans elle, les deux nombres seraient egaux.
    expect(room.gold).toBeGreaterThan(cagnotte);
    expect(room.drainRunOver()).not.toBeNull();
  }, 120_000);

  it('un joueur MORT vote, et sa voix fait BASCULER le verdict', () => {
    // ⚠️ **Le decor doit produire le cas qu'il pretend creer.** Deux joueurs
    // vivants qui votent l'un contre l'autre : 1-1, egalite, on continue. La
    // voix du MORT fait 2-1 pour partir. Toute autre repartition — le mort
    // d'accord avec la majorite, ou deux joueurs seulement — rendrait le meme
    // verdict avec et sans sa voix, et le test ne dirait rien.
    const room = new Room(4242);
    room.join(1);
    room.join(2);
    room.join(3);

    // Le joueur 1 tombe AVANT le boss : il sera mort a l'ouverture du portail,
    // et toujours dans le salon — le §6 dit « tout joueur connecte ».
    const pos = positionOf(room, 1);
    const bourreaux: number[] = [];
    for (let i = 0; i < 25; i++) {
      bourreaux.push(spawnMonsterAt(room, 9000 + i, pos.x, pos.y));
    }
    for (let t = 0; t < 60 * TICK_HZ && hpOf(room, 1) > 0; t++) {
      viderSauf(room, bourreaux);
      for (const id of bourreaux) {
        const slot = room.horde.slotOf(id);
        if (slot >= 0) {
          room.horde.hp[slot] = 1e6;
          room.horde.x[slot] = pos.x;
          room.horde.y[slot] = pos.y;
        }
      }
      pas(room);
    }
    expect(hpOf(room, 1)).toBe(0);
    expect(hpOf(room, 2)).toBeGreaterThan(0);
    viderSauf(room, []);

    ouvrirLePortail(room);
    expect(hpOf(room, 1)).toBe(0);

    // Le mort vote, et les deux vivants s'annulent.
    expect(room.setVote(1, VOTE_CHOICE.LEAVE)).toBe(true);
    room.setVote(2, VOTE_CHOICE.LEAVE);
    room.setVote(3, VOTE_CHOICE.STAY);
    pas(room);

    const verdicts = room.drainPortalResults();
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.decision).toBe(VOTE_CHOICE.LEAVE);
  }, 120_000);
});

/**
 * Tue un joueur par contact, pour les tests qui n'ont besoin que de l'etat
 * MORT et pas d'un combat realiste.
 *
 * ⚠️ **Aucun utilitaire de mort reutilisable n'existait dans ce fichier.**
 * Chaque test de mort inscrit sa propre boucle de combat (`tuerLeBoss`, le
 * `tuer` local au test de credit d'or, la boucle en ligne du test de
 * `RUN_OVER`) ; aucun n'est un `tue(room, id)` a deux arguments, module-scope,
 * reutilisable depuis un nouveau describe. Celle-ci reprend le motif le plus
 * simple des trois — vingt-cinq monstres au contact, meme sans arme tiree
 * assez vite pour les tenir tous a distance, il en reste toujours un pour
 * continuer a faire mal — plutot que d'en inventer un quatrieme variant.
 */
function tue(room: Room, playerId: number): void {
  const pos = positionOf(room, playerId);
  for (let i = 0; i < 25; i++) {
    spawnMonsterAt(room, 9000 + playerId * 100 + i, pos.x, pos.y);
  }
  for (let t = 0; t < 3000 && hpOf(room, playerId) > 0; t++) {
    room.step(DT);
  }
}

describe('etape 8 tache 3 : le socle du verbe', () => {
  it('un verbe demande est accepte UNE fois, puis refuse jusqu a la recharge', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 0); // Amorce
    const recharge = ABILITY_COOLDOWN_TICKS.amorce;

    expect(room.useAbility(1, 1, 0)).not.toBeNull();
    expect(room.useAbility(1, 1, 0)).toBeNull();

    for (let t = 0; t < recharge - 1; t++) {
      room.step(DT);
    }
    expect(room.useAbility(1, 1, 0)).toBeNull();
    room.step(DT);
    expect(room.useAbility(1, 1, 0)).not.toBeNull();
  });

  /** Review Focus n°3 : un spam a 30 Hz ne doit laisser passer qu'un usage. */
  it('un spam de cent demandes dans le meme tick n en laisse passer qu une', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 0);
    let acceptes = 0;
    for (let i = 0; i < 100; i++) {
      if (room.useAbility(1, 1, 0)) {
        acceptes++;
      }
    }
    expect(acceptes).toBe(1);
  });

  /** Review Focus n°2 : un joueur mort n a pas de verbe. */
  it('un joueur mort est refuse en silence', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 0);
    tue(room, 1);
    expect(room.useAbility(1, 1, 0)).toBeNull();
  });

  it('un joueur inconnu est refuse en silence', () => {
    const room = new Room();
    expect(room.useAbility(42, 1, 0)).toBeNull();
  });

  it('l annonce porte le verbe de la CLASSE du joueur, pas un verbe choisi par lui', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 2); // Appat
    expect(room.useAbility(1, 1, 0)?.verb).toBe(VERB_IDS.appat);
  });
});

describe('etape 8 tache 4a : Amorce', () => {
  /** Une arme dont l'element DIFFERE de celui de l'arme neutre, derivee du catalogue. */
  const ARME_ELEMENTAIRE = WEAPONS.find(
    (w) => w.id !== BASE_WEAPON_ID && w.element !== weaponOf(BASE_WEAPON_ID).element,
  );

  it('ANNONCE une zone de l element de l arme du joueur, a reaction nulle', () => {
    if (!ARME_ELEMENTAIRE) {
      throw new Error('aucune arme au catalogue ne differe de la neutre par son element');
    }
    const room = new Room();
    room.join(1, undefined, ARME_ELEMENTAIRE.id, 0); // Amorce
    room.drainZones(); // vide ce qui precede

    const annonce = room.useAbility(1, 300, 400);
    expect(annonce).not.toBeNull();

    // ⚠️ On lit l'ANNONCE, pas l'etat interne : `#zones` est prive, et c'est
    // l'annonce que le client recoit. Eprouver l'etat interne laisserait passer
    // une zone posee mais jamais diffusee — le serveur l'aurait, le client non.
    const annoncees = room.drainZones();
    expect(annoncees.length).toBe(1);
    const z = annoncees[0];
    if (!z) {
      throw new Error('aucune zone annoncee');
    }
    expect(z.by).toBe(1);
    // L'element est LU du catalogue, jamais code en dur.
    expect(zoneElement(z.kind)).toBe(ARME_ELEMENTAIRE.element);
    // Reaction NULLE : elle marque, elle ne brule pas.
    expect(zoneReaction(z.kind)).toBe(0);
  });

  it('annonce la zone au point VISE, pas a la position du joueur', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 0);
    room.drainZones();
    const depart = positionOf(room, 1);
    room.useAbility(1, 300, 400);
    const z = room.drainZones()[0];
    expect([z?.x, z?.y]).toEqual([300, 400]);
    // Et la visee n'est pas la position de depart, sans quoi le test ne
    // distinguerait rien.
    expect([depart.x, depart.y]).not.toEqual([300, 400]);
  });

  /** La paire discriminante : il agit ici, et il n'agit pas la. */
  it('une classe qui n est PAS Amorce n annonce aucune zone', () => {
    const room = new Room();
    room.join(1, undefined, ARME_ELEMENTAIRE?.id, 1); // Rempart
    room.drainZones();
    expect(room.useAbility(1, 300, 400)).not.toBeNull();
    expect(room.drainZones().length).toBe(0);
  });

  /**
   * Le repli de `#armeAmorce` : le salon autorise explicitement `NO_WEAPON`,
   * donc un Amorce sans arme existe reellement. Il doit poser la zone de l'arme
   * neutre plutot que de refuser son verbe.
   */
  it('un Amorce sans arme pose l element de l arme neutre, et ne refuse pas', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 0);
    room.drainZones();
    expect(room.useAbility(1, 300, 400)).not.toBeNull();
    const z = room.drainZones()[0];
    expect(zoneElement(z?.kind ?? 255)).toBe(weaponOf(BASE_WEAPON_ID).element);
  });
});

/**
 * Étape 8 — **l'invocation**, cinquieme famille d'armes. Ce bloc garde ce que
 * `shared/weapons.test.ts` ne peut pas voir : qu'elle est bien POSEE par le
 * salon, qu'elle frappe autour d'ELLE et pas autour du joueur, et qu'elle
 * finit par s'eteindre.
 */
describe("l'invocation, posee par le salon (etape 8)", () => {
  const HOMONCULE = WEAPONS.find((w) => w.kind === 'invocation');

  /** Un salon ou le joueur ne porte QUE l'invocation — aucune autre arme ne peut tuer. */
  function salonAvecInvocation(): Room {
    if (!HOMONCULE) {
      throw new Error('aucune invocation au catalogue');
    }
    const room = new Room();
    room.join(1, undefined, HOMONCULE.id);
    const inv = room.loadoutOf(1);
    expect([...(inv?.weaponIds ?? [])]).toEqual([HOMONCULE.id]);
    return room;
  }

  it('tue ce qui s approche, meme DANS LE DOS du joueur', () => {
    // ⚠️ **Le dos, et c'est tout l'interet du cas** : la visee part a l'oppose,
    // donc aucune arme qui TIRE n'aurait pu toucher. Ce qui tue ici ne peut
    // etre que la pulsation de l'invocation, qui frappe tout autour d'elle.
    const room = salonAvecInvocation();
    const pos = positionOf(room, 1);
    const cible = spawnMonsterAt(room, 500, pos.x - 60, pos.y);

    for (let i = 0; i < 60 && room.horde.slotOf(cible) >= 0; i++) {
      room.applyInput(1, i + 1, 0, 0, 127, 0);
      room.step(DT);
    }
    expect(room.horde.slotOf(cible)).toBe(-1);
  });

  it('reste OU ELLE A ETE POSEE quand le joueur s en va', () => {
    // Elle se detache : c'est la difference avec le halo, qui suit son
    // porteur. Le joueur part a droite, l'invocation continue de frapper a
    // gauche.
    const room = salonAvecInvocation();
    const depart = positionOf(room, 1);

    // Un tick pour poser l'invocation, puis le joueur FUIT — et la cible
    // n'arrive qu'apres, sinon elle mourrait avant qu'il ait bouge d'un pixel
    // et ce cas ne mesurerait rien.
    room.applyInput(1, 1, 0, 0, 127, 0);
    room.step(DT);
    for (let i = 0; i < 30; i++) {
      room.applyInput(1, i + 2, 127, 0, 127, 0);
      room.step(DT);
    }
    const arrivee = positionOf(room, 1);
    const rayon = HOMONCULE?.blastRadius ?? 0;
    // Le joueur est bien PARTI, hors de portee de ce qu'il a pose…
    expect(arrivee.x - depart.x).toBeGreaterThan(2 * rayon);

    // …et ce qui arrive la-bas meurt quand meme. Trop loin du joueur pour
    // qu'une invocation POSTERIEURE (il en repose une toutes les 90 ticks, a
    // sa nouvelle position) puisse y etre pour quelque chose.
    const cible = spawnMonsterAt(room, 501, depart.x, depart.y);
    expect(Math.abs(arrivee.x - depart.x)).toBeGreaterThan(rayon);
    for (let i = 0; i < 60 && room.horde.slotOf(cible) >= 0; i++) {
      room.applyInput(1, 100 + i, 127, 0, 127, 0);
      room.step(DT);
    }
    expect(room.horde.slotOf(cible)).toBe(-1);
  });

  it('finit par s eteindre : un monstre pose trop tard survit', () => {
    const room = salonAvecInvocation();
    const pos = positionOf(room, 1);
    const vie = HOMONCULE?.projectileLifeTicks ?? 0;
    const recharge = HOMONCULE?.cooldownTicks ?? 0;
    // ⚠️ On laisse passer la vie de la PREMIERE invocation ET la recharge,
    // pour qu'aucune autre ne soit posee pendant qu'on observe : sans ca, ce
    // cas mesurerait la cadence de l'arme, pas l'extinction.
    expect(vie).toBeGreaterThan(0);
    for (let i = 0; i < vie + recharge; i++) {
      // Visee NULLE : plus aucune arme ne part, donc plus aucune invocation.
      room.applyInput(1, i + 1, 0, 0, 0, 0);
      room.step(DT);
    }
    const tardif = spawnMonsterAt(room, 502, pos.x - 60, pos.y);
    for (let i = 0; i < 60; i++) {
      room.applyInput(1, 1000 + i, 0, 0, 0, 0);
      room.step(DT);
    }
    expect(room.horde.slotOf(tardif)).toBeGreaterThanOrEqual(0);
  });
});
