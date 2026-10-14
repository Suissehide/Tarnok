import {
  ARCHETYPES,
  KAMIKAZE_MONSTER_DAMAGE,
  KAMIKAZE_PLAYER_DAMAGE,
  KAMIKAZE_RADIUS,
  LEAP_DASH_SPEED,
  LEAP_PAUSE_SPEED,
  LEAP_PERIOD_TICKS,
  leapFactor,
  SHAMAN_AURA_RADIUS,
  SHAMAN_AURA_REDUCTION,
  SHOOTER_PERIOD_TICKS,
  SHOOTER_RANGE,
  SHOT_LIFETIME_S,
  SHOT_SPEED,
} from '@shared/archetypes';
import { TICK_HZ } from '@shared/constants';
import { EnemyShots, shotPhase } from '@shared/enemy-shots';
import { Horde } from '@shared/horde';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { ZoneField } from '@shared/zones';
import { describe, expect, it } from 'vitest';

import { appliquerDegats, armureA, type ContactPlayer, OrbField, resolveBlasts } from './combat';
import { Room } from './room';

/**
 * Les comportements des monstres (retour de playtest : *« des ennemis qui
 * avancent par bond », kamikaze, chaman*). Chacun se derive de ce que serveur
 * et clients calculent deja : ces tests gardent la regle, puis le cablage.
 */
const DT = 1 / TICK_HZ;
const de = (behavior: string): number => {
  const a = ARCHETYPES.find((x) => x.behavior === behavior);
  if (!a) {
    throw new Error(`aucun archetype ${behavior}`);
  }
  return a.id;
};
const KAMIKAZE = de('kamikaze');
const CHAMAN = de('chaman');
const BONDISSEUR = de('bond');

function poser(horde: Horde, waveId: number, x: number, y: number, archetype: number): number {
  const order: WaveOrder = {
    waveId,
    spawnTick: 0,
    seed: 1,
    archetype,
    formation: FORMATION.SCATTER,
    anchorX: x,
    anchorY: y,
    count: 1,
  };
  horde.spawn(order);
  const slot = horde.count - 1;
  horde.x[slot] = x;
  horde.y[slot] = y;
  return horde.entityIdAt(slot);
}

describe('le bondisseur avance par bonds', () => {
  it('alterne une ruee et une pause, de facon deterministe et dephasee par entite', () => {
    const facteurs = Array.from({ length: LEAP_PERIOD_TICKS }, (_, t) => leapFactor(7, t));
    expect(facteurs).toContain(LEAP_DASH_SPEED);
    expect(facteurs).toContain(LEAP_PAUSE_SPEED);
    expect(leapFactor(7, 3)).toBe(leapFactor(7, 3 + LEAP_PERIOD_TICKS));
    // Deux entites ne bondissent pas d'un seul bloc.
    const a = Array.from({ length: LEAP_PERIOD_TICKS }, (_, t) => leapFactor(1, t));
    const b = Array.from({ length: LEAP_PERIOD_TICKS }, (_, t) => leapFactor(2, t));
    expect(a).not.toEqual(b);
  });

  it('dans la horde, son pas varie avec le bond quand un pas ordinaire reste constant', () => {
    const horde = new Horde(4);
    poser(horde, 1, 1000, 1000, BONDISSEUR);
    horde.vx[0] = 100;
    horde.vy[0] = 0;
    const pas: number[] = [];
    for (let t = 1; t <= LEAP_PERIOD_TICKS; t++) {
      const x0 = horde.x[0] ?? 0;
      // Sans champ : la vitesse tenue reste celle posee.
      horde.step(DT, [], t);
      horde.vx[0] = 100;
      pas.push((horde.x[0] ?? 0) - x0);
    }
    expect(Math.max(...pas)).toBeGreaterThan(Math.min(...pas) * 5);
  });
});

describe('l explosion du kamikaze', () => {
  it('blesse monstres et joueurs dans le rayon, epargne ceux hors du rayon', () => {
    const horde = new Horde(8);
    const proche = poser(horde, 1, 1000 + KAMIKAZE_RADIUS / 2, 1000, 1);
    const loin = poser(horde, 2, 1000 + KAMIKAZE_RADIUS * 2, 1000, 1);
    const pvProche = horde.hp[horde.slotOf(proche)] ?? 0;
    const joueurs: ContactPlayer[] = [
      { x: 1000, y: 1030, hp: 100, contactInvulnTicks: 0 },
      { x: 1000 + KAMIKAZE_RADIUS * 3, y: 1000, hp: 100, contactInvulnTicks: 0 },
    ];
    const morts = resolveBlasts(
      horde,
      new OrbField(16),
      [{ x: 1000, y: 1000 }],
      [],
      joueurs,
      0,
      new ZoneField(),
    );

    expect(joueurs[0]?.hp).toBe(100 - KAMIKAZE_PLAYER_DAMAGE);
    expect(joueurs[1]?.hp).toBe(100);
    const slot = horde.slotOf(proche);
    if (KAMIKAZE_MONSTER_DAMAGE >= pvProche) {
      expect(morts).toContain(proche);
    } else {
      expect(horde.hp[slot] ?? 0).toBeLessThan(pvProche);
    }
    expect(horde.slotOf(loin)).toBeGreaterThanOrEqual(0);
  });

  it('le kamikaze qui se fait sauter MEURT, par le lot de morts', () => {
    const horde = new Horde(8);
    const k = poser(horde, 1, 1000, 1000, KAMIKAZE);
    const morts = resolveBlasts(
      horde,
      new OrbField(16),
      [{ x: 1000, y: 1000 }],
      [k],
      [],
      0,
      new ZoneField(),
    );
    expect(morts).toContain(k);
    expect(horde.slotOf(k)).toBe(-1);
  });

  it('dans le salon, un kamikaze au contact explose : il meurt, le joueur encaisse', () => {
    const room = new Room(5);
    room.join(1);
    room.step(DT);
    const pos = room.positionOf(1) ?? { x: 0, y: 0 };
    const pvAvant = room.hpOf(1);
    const k = poser(room.horde, 990_001, pos.x + 20, pos.y, KAMIKAZE);
    let mort = false;
    for (let t = 0; t < 2 * TICK_HZ && !mort; t++) {
      room.step(DT);
      mort = room.drainDeaths().some((d) => d.ids.includes(k));
    }
    expect(mort).toBe(true);
    expect(room.hpOf(1)).toBeLessThan(pvAvant);
  });
});

describe('la reaction en chaine', () => {
  it('un kamikaze tue par une explosion explose a son tour, au tick suivant', () => {
    const room = new Room(5);
    room.join(1);
    room.step(DT);
    const pos = room.positionOf(1) ?? { x: 0, y: 0 };
    // Le premier touche le joueur ; le second est dans SON rayon ; le temoin
    // n'est que dans le rayon du second.
    const premier = poser(room.horde, 990_101, pos.x + 20, pos.y, KAMIKAZE);
    const second = poser(room.horde, 990_102, pos.x + 20 + KAMIKAZE_RADIUS * 0.8, pos.y, KAMIKAZE);
    const temoin = poser(room.horde, 990_103, pos.x + 20 + KAMIKAZE_RADIUS * 1.6, pos.y, 2);
    const morts: number[] = [];
    for (let t = 0; t < 2 * TICK_HZ && !morts.includes(temoin); t++) {
      // Le temoin reste en place : on mesure l'explosion, pas sa marche.
      const s3 = room.horde.slotOf(temoin);
      if (s3 >= 0) {
        room.horde.x[s3] = pos.x + 20 + KAMIKAZE_RADIUS * 1.6;
        room.horde.y[s3] = pos.y;
      }
      room.step(DT);
      for (const d of room.drainDeaths()) {
        morts.push(...d.ids);
      }
    }
    expect(morts).toContain(premier);
    expect(morts).toContain(second);
    expect(morts).toContain(temoin);
    expect(morts.indexOf(second)).toBeLessThan(morts.indexOf(temoin));
  });
});

describe('l aura du chaman', () => {
  it('un monstre dans l aura encaisse moins : l aura se combine a l armure', () => {
    const horde = new Horde(8);
    const protege = poser(horde, 1, 1000, 1000, 1);
    const slot = horde.slotOf(protege);
    const zones = new ZoneField();
    const sans = armureA(horde, slot, zones, 0);
    horde.aura.add(protege);
    const avec = armureA(horde, slot, zones, 0);
    expect(avec).toBeCloseTo(1 - (1 - sans) * (1 - SHAMAN_AURA_REDUCTION), 10);
    expect(avec).toBeGreaterThan(sans);
  });

  it('dans le salon, l aura protege les voisins du chaman et eux seuls', () => {
    const room = new Room(5);
    room.join(1);
    room.step(DT);
    const pos = room.positionOf(1) ?? { x: 0, y: 0 };
    // Loin du joueur, pour qu'il ne tire pas dessus.
    const cx = pos.x + 1500;
    poser(room.horde, 990_010, cx, pos.y, CHAMAN);
    const voisin = poser(room.horde, 990_011, cx + SHAMAN_AURA_RADIUS / 2, pos.y, 1);
    const isole = poser(room.horde, 990_012, cx + SHAMAN_AURA_RADIUS * 3, pos.y, 1);
    room.step(DT);
    expect(room.horde.aura.has(voisin)).toBe(true);
    expect(room.horde.aura.has(isole)).toBe(false);
    // Et l'aura se lit au seul chemin des degats.
    const slotV = room.horde.slotOf(voisin);
    const slotI = room.horde.slotOf(isole);
    const avantV = room.horde.hp[slotV] ?? 0;
    const avantI = room.horde.hp[slotI] ?? 0;
    appliquerDegats(room.horde, slotV, 4, new ZoneField(), room.tick, []);
    appliquerDegats(room.horde, slotI, 4, new ZoneField(), room.tick, []);
    expect(avantV - (room.horde.hp[slotV] ?? 0)).toBeLessThan(avantI - (room.horde.hp[slotI] ?? 0));
  });
});

describe('le tireur', () => {
  const TIREUR = de('tir');

  it('tire a son temps, dans sa direction, et le tir s eteint au bout de sa portee', () => {
    const horde = new Horde(4);
    const id = poser(horde, 1, 1000, 1000, TIREUR);
    horde.retarget([1000], [1500]);
    expect(horde.stopped[0]).toBe(0);
    horde.stopped[0] = 1;
    const shots = new EnemyShots();
    const tir = (SHOOTER_PERIOD_TICKS - shotPhase(id)) % SHOOTER_PERIOD_TICKS;
    shots.step(horde, tir - 1 + SHOOTER_PERIOD_TICKS, DT);
    expect(shots.shots).toHaveLength(0);
    shots.step(horde, tir + SHOOTER_PERIOD_TICKS, DT);
    expect(shots.shots).toHaveLength(1);
    expect(shots.shots[0]?.x).toBeCloseTo(1000);
    expect(shots.shots[0]?.y).toBeCloseTo(1000 + SHOT_SPEED * DT);
    // Un tireur en marche (pas arrete) ne tire pas.
    horde.stopped[0] = 0;
    shots.step(horde, tir + 2 * SHOOTER_PERIOD_TICKS, DT);
    expect(shots.shots).toHaveLength(1);
    shots.step(horde, 0, SHOT_LIFETIME_S);
    expect(shots.shots).toHaveLength(0);
  });

  it('un tir qui touche un joueur disparait et compte pour lui seul', () => {
    const shots = new EnemyShots();
    shots.shots.push({ x: 100, y: 100, ux: 1, uy: 0, life: 1 });
    shots.shots.push({ x: 500, y: 500, ux: 1, uy: 0, life: 1 });
    expect(
      shots.hits(
        [
          { x: 105, y: 100 },
          { x: 0, y: 0 },
        ],
        17,
      ),
    ).toEqual([1, 0]);
    expect(shots.shots).toHaveLength(1);
  });

  it('dans le salon, il s arrete a distance et blesse le joueur de loin', () => {
    const room = new Room(5);
    room.join(1);
    room.step(DT);
    const pos = room.positionOf(1) ?? { x: 0, y: 0 };
    const pvAvant = room.hpOf(1);
    const t = poser(room.horde, 990_001, pos.x + 260, pos.y, TIREUR);
    room.horde.hp[room.horde.slotOf(t)] = 1e9;
    for (let k = 0; k < 4 * TICK_HZ; k++) {
      room.step(DT);
    }
    const slot = room.horde.slotOf(t);
    expect(slot).toBeGreaterThanOrEqual(0);
    const d = Math.hypot((room.horde.x[slot] ?? 0) - pos.x, (room.horde.y[slot] ?? 0) - pos.y);
    expect(d).toBeGreaterThan(SHOOTER_RANGE / 2);
    expect(room.hpOf(1)).toBeLessThan(pvAvant);
  });
});
