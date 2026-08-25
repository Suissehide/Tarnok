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
import { decodeSnapshot } from '@shared/protocol';
import { FORMATION, type WaveOrder } from '@shared/waves';
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

  /**
   * Pre-remplit la horde pres de sa capacite, loin du joueur — hors de portee
   * d'arme (333 px pour l'arme de base) et de contact (34 px) — pour observer
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
      fillHordeFarFromPlayer(room, MAX_ENTITIES - 50);

      // Une seule periode de vague (PERIOD_TICKS = TICK_HZ * 6) suffit : la
      // horde pre-remplie ne laisse plus de place pour les 120 a 320 entites
      // que WaveDirector va vouloir faire apparaitre.
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
    fillHordeFarFromPlayer(room, MAX_ENTITIES - 50);
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
    // A portee de l'arme de base (333 px) mais hors de CONTACT_RADIUS (34 px)
    // : isole le chemin "degats de projectile" du chemin "contact".
    const targetId = spawnMonsterAt(room, 500, before.x + 100, before.y);

    let deaths: { tick: number; ids: number[] }[] = [];
    for (let i = 0; i < 30 && deaths.length === 0; i++) {
      room.step(DT);
      deaths = deaths.concat(room.drainDeaths());
    }

    expect(room.horde.count).toBe(0);
    expect(deaths.length).toBeGreaterThan(0);
    expect(deaths[0]?.ids).toEqual([targetId]);
  });

  it('endommage un joueur au contact et arrete d en faire mal pendant la fenetre d invulnerabilite', () => {
    const room = new Room();
    room.join(1);
    const before = positionOf(room, 1);
    // Contact et arme partagent la meme cible potentielle des qu'un monstre
    // est a portee de contact (34 px < 333 px de portee d'arme) : avec un
    // seul monstre, l'arme le tue au tick 1 (tir depuis la position exacte du
    // joueur, donc a distance nulle) et le contact ne voit plus jamais rien.
    // Plusieurs monstres au meme point : un seul meurt par fenetre de
    // cooldown (15 ticks), les autres restent pour continuer a faire mal.
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
    for (let i = 0; i < 10; i++) {
      spawnMonsterAt(room, 1000 + i, before.x + 60 + i * 2, before.y);
    }

    let levelUps: { tick: number; level: number }[] = [];
    let ticks = 0;
    while (levelUps.length === 0 && ticks < 1000) {
      room.step(DT);
      ticks++;
      levelUps = levelUps.concat(room.drainLevelUps());
    }

    expect(levelUps.length).toBeGreaterThan(0);
    expect(levelUps[0]?.level).toBe(2);
    // Date au tick d'EFFET, dans le futur par rapport au tick d'emission —
    // jamais le tick courant au moment de l'emission.
    expect(levelUps[0]?.tick).toBeGreaterThan(room.tick);

    // Le joueur se met en mouvement seulement MAINTENANT, pour observer le
    // gel : un joueur qui bouge doit s'arreter net des le tick d'effet.
    room.applyInput(1, 1, 127, 0);
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

    for (let i = 0; i < LEVEL_FREEZE_TICKS; i++) {
      room.step(DT);
    }
    expect(positionOf(room, 1)).toEqual(atTrigger);
    // Le combat aussi est suspendu : ni degats de contact, ni mort du
    // monstre pose au tick precedent.
    expect(hpOf(room, 1)).toBe(hpAtTrigger);
    expect(room.horde.count).toBe(hordeCountAtTrigger);
    expect(room.drainDeaths()).toEqual([]);

    // Reprend : apres le gel et la rampe de reprise, le joueur bouge de
    // nouveau.
    for (let i = 0; i < LEVEL_RESUME_TICKS + 30; i++) {
      room.step(DT);
    }
    expect(positionOf(room, 1)).not.toEqual(atTrigger);
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
