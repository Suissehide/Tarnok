import {
  ABILITY_COOLDOWN_TICKS,
  ABILITY_ZONE_RADIUS,
  ADJACENT_RANGE,
  RELAIS_INTANGIBLE_TICKS,
  RELAIS_RANGE,
  REMPART_ARMOR,
  REMPART_LIFETIME_TICKS,
} from '@shared/abilities';
import { CONTACT_DAMAGE, TICK_HZ } from '@shared/constants';
import { elementOf } from '@shared/elements';
import { zoneElement, zoneReaction } from '@shared/protocol';
import { BONUS_ZERO, SHOP_ITEMS } from '@shared/shop';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { startingWeapons, weaponOf } from '@shared/weapons';
import { describe, expect, it } from 'vitest';

import { Room } from './room';

/**
 * Les verbes de classe (Rempart, Appat, Relais), cote salon. Les identifiants de classe s'epinglent en nombres nus, comme au
 * catalogue (`shared/classes.ts`) : 0 Amorce, 1 Rempart, 2 Appat, 3 Relais.
 */
const AMORCE = 0;
const REMPART = 1;
const APPAT = 2;
const RELAIS = 3;

const DT = 1 / TICK_HZ;

/** Un monstre pose a une position, hors du directeur de vagues (meme technique que `room.test.ts`). */
function monstreSur(room: Room, waveId: number, x: number, y: number): void {
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
}

describe('etape 8 tache 5 : Rempart', () => {
  it('un allie dans la zone encaisse moins, un allie dehors encaisse autant', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, REMPART);
    room.join(2, undefined, undefined, AMORCE); // l'allie protege
    room.join(3, undefined, undefined, AMORCE); // le temoin, hors zone

    room.debugPlace(1, 2000, 2000);
    room.debugPlace(2, 1000, 1000);
    room.debugPlace(3, 1000 + ABILITY_ZONE_RADIUS * 4, 1000);
    expect(room.useAbility(1, 1000, 1000)).not.toBeNull();

    expect(room.armorOf(2)).toBe(REMPART_ARMOR);
    expect(room.armorOf(3)).toBe(0);
  });

  /**
   * ⚠️ **Le Rempart doit exister dans les PV, pas seulement dans `armorOf`.**
   * Un accesseur juste que `resolveContact` ne lirait pas serait un mecanisme
   * mort — d'ou cette paire mesuree au contact reel d'un monstre.
   */
  it('la protection se lit dans les PV au contact, pas seulement dans l accesseur', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, REMPART);
    room.join(2, undefined, undefined, AMORCE);
    room.join(3, undefined, undefined, AMORCE);
    room.debugPlace(1, 3000, 3000);
    room.debugPlace(2, 1000, 1000);
    room.debugPlace(3, 2000, 1000);
    room.useAbility(1, 1000, 1000);
    monstreSur(room, 900_001, 1000, 1000);
    monstreSur(room, 900_002, 2000, 1000);
    const avant2 = room.hpOf(2);
    const avant3 = room.hpOf(3);

    room.step(DT);

    expect(avant3 - room.hpOf(3)).toBe(CONTACT_DAMAGE);
    expect(avant2 - room.hpOf(2)).toBeCloseTo(CONTACT_DAMAGE * (1 - REMPART_ARMOR));
  });

  /**
   * ⚠️ **MAXIMUM, jamais une somme.** La boutique vend `Armure` sur cinq
   * paliers ; une somme ferait de « cinq paliers plus un Rempart » une
   * quasi-immunite.
   */
  it('l armure du compte et celle du Rempart se combinent par le MAXIMUM', () => {
    const armure = SHOP_ITEMS.find((i) => i.bonusKind === 'armor');
    if (!armure) {
      throw new Error('la boutique ne vend plus d armure');
    }
    const achetee = armure.perLevel * armure.levels;

    const room = new Room(1);
    room.join(1, undefined, undefined, REMPART);
    room.join(2, { bonuses: { ...BONUS_ZERO, armor: achetee } }, undefined, AMORCE);
    room.debugPlace(2, 1000, 1000);
    room.useAbility(1, 1000, 1000);

    expect(room.armorOf(2)).toBe(Math.max(achetee, REMPART_ARMOR));
    expect(room.armorOf(2)).toBeLessThan(achetee + REMPART_ARMOR);
  });

  it('le trait remparteAllie etend la protection a l allie adjacent, hors zone', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, REMPART); // il a le trait
    room.join(2, undefined, undefined, AMORCE);
    room.debugPlace(2, 1000 + ABILITY_ZONE_RADIUS * 3, 1000);
    room.debugPlace(1, 1000 + ABILITY_ZONE_RADIUS * 3 + ADJACENT_RANGE / 2, 1000);
    room.useAbility(1, 1000, 1000); // la zone est posee LOIN des deux

    expect(room.armorOf(2)).toBe(REMPART_ARMOR);
  });

  it('sans le trait, le meme allie adjacent n est pas protege', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, AMORCE); // pas le trait
    room.join(2, undefined, undefined, AMORCE);
    room.debugPlace(1, 1000, 1000);
    room.debugPlace(2, 1000 + ADJACENT_RANGE / 2, 1000);
    room.useAbility(1, 4000, 4000);

    expect(room.armorOf(2)).toBe(0);
  });

  it('la protection expire avec la zone, et pas un tick avant', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, REMPART);
    room.join(2, undefined, undefined, AMORCE);
    room.debugPlace(1, 3000, 3000);
    room.debugPlace(2, 1000, 1000);
    room.useAbility(1, 1000, 1000);
    for (let i = 0; i < REMPART_LIFETIME_TICKS - 1; i++) {
      room.step(DT);
    }
    expect(room.armorOf(2)).toBe(REMPART_ARMOR);
    room.step(DT);
    expect(room.armorOf(2)).toBe(0);
  });

  it('la recharge du Rempart est lue de sa source', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, REMPART);
    expect(room.useAbility(1, 1000, 1000)).not.toBeNull();
    expect(room.useAbility(1, 1000, 1000)).toBeNull();
    for (let i = 0; i < ABILITY_COOLDOWN_TICKS.rempart; i++) {
      room.step(DT);
    }
    expect(room.useAbility(1, 1000, 1000)).not.toBeNull();
  });
});

/**
 * Un joueur en (1000, 2000), un monstre a droite en (1600, 2000), le verbe
 * vise (2600, 2000). Rend le deplacement horizontal du monstre au bout de
 * trois secondes : negatif s'il marche vers le joueur, positif vers le leurre.
 */
function deriveDuMonstre(classe: number): number {
  const room = new Room(1);
  room.join(1, undefined, undefined, classe);
  room.debugPlace(1, 1000, 2000);
  for (let i = 0; i < TICK_HZ; i++) {
    room.step(DT);
  }
  room.useAbility(1, 2600, 2000);
  monstreSur(room, 900_010, 1600, 2000);
  const depart = room.horde.x[room.horde.count - 1] ?? 0;
  for (let i = 0; i < 3 * TICK_HZ; i++) {
    room.debugPlace(1, 1000, 2000);
    room.step(DT);
  }
  return (room.horde.x[room.horde.count - 1] ?? 0) - depart;
}

describe('etape 8 tache 6 : Appat', () => {
  it('un leurre attire les monstres qui poursuivaient son lanceur', () => {
    expect(deriveDuMonstre(APPAT)).toBeGreaterThan(0);
  });

  /** La paire discriminante : sans leurre, le meme monstre marche vers le joueur. */
  it('sans leurre, le meme monstre marche vers le joueur', () => {
    expect(deriveDuMonstre(REMPART)).toBeLessThan(0);
  });

  it('l annonce porte le point du leurre', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, APPAT);
    const annonce = room.useAbility(1, 2600, 2000);
    expect([annonce?.x, annonce?.y]).toEqual([2600, 2000]);
  });

  it('le trait leurreElementaire : le leurre pose une zone de l element de l arme', () => {
    const arme = startingWeapons().find((w) => weaponOf(w).element !== 0);
    if (arme === undefined) {
      throw new Error('aucune arme elementaire au catalogue');
    }
    const room = new Room(1);
    room.join(1, undefined, arme, APPAT);
    room.drainZones();
    room.useAbility(1, 2600, 2000);
    const zones = room.drainZones();
    expect(zones).toHaveLength(1);
    expect(zoneElement(zones[0]?.kind ?? 0)).toBe(weaponOf(arme).element);
    expect(zoneReaction(zones[0]?.kind ?? 0)).toBe(0);
    expect(elementOf(weaponOf(arme).element).id).toBe(weaponOf(arme).element);
  });

  it('une autre classe ne pose ni leurre ni zone', () => {
    const room = new Room(1);
    room.join(1, undefined, startingWeapons()[0], REMPART);
    room.drainZones();
    room.useAbility(1, 2600, 2000);
    expect(room.drainZones()).toHaveLength(0);
  });
});

describe('etape 8 tache 7 : Relais', () => {
  it('teleporte le lanceur sur l allie vise, et l annonce porte sa cible et sa destination', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, RELAIS);
    room.join(2, undefined, undefined, AMORCE);
    room.debugPlace(1, 1000, 1000);
    room.debugPlace(2, 1400, 1300);

    const annonce = room.useAbility(1, 1400, 1300);
    expect(annonce?.targetId).toBe(2);
    expect(room.positionOf(1)).toEqual(room.positionOf(2));
    expect([annonce?.x, annonce?.y]).toEqual([1400, 1300]);
  });

  it('vise l allie le plus proche du POINT VISE, pas du lanceur', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, RELAIS);
    room.join(2, undefined, undefined, AMORCE);
    room.join(3, undefined, undefined, AMORCE);
    room.debugPlace(1, 1000, 1000);
    room.debugPlace(2, 1100, 1000); // le plus proche du lanceur
    room.debugPlace(3, 1800, 1000); // le plus proche du point vise
    expect(room.useAbility(1, 1750, 1000)?.targetId).toBe(3);
  });

  /** Les cas limites : vers soi-meme, et vers un allie disparu. */
  it('un Relais vers soi-meme est refuse en silence', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, RELAIS);
    room.debugPlace(1, 1000, 1000);
    expect(room.useAbility(1, 1000, 1000)).toBeNull();
  });

  it('un Relais sans aucun allie vivant est refuse en silence', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, RELAIS);
    room.join(2, undefined, undefined, AMORCE);
    room.debugKill(2);
    expect(room.useAbility(1, 1400, 1300)).toBeNull();
  });

  it('un allie hors de portee est refuse en silence', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, RELAIS);
    room.join(2, undefined, undefined, AMORCE);
    room.debugPlace(1, 100, 100);
    room.debugPlace(2, 100 + RELAIS_RANGE * 2, 100);
    expect(room.useAbility(1, 100 + RELAIS_RANGE * 2, 100)).toBeNull();
  });

  it('un refus ne consomme PAS la recharge', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, RELAIS);
    room.join(2, undefined, undefined, AMORCE);
    room.debugPlace(1, 1000, 1000);
    room.debugPlace(2, 1400, 1000);
    room.debugKill(2);
    expect(room.useAbility(1, 1400, 1000)).toBeNull();
    room.debugRevive(2);
    expect(room.useAbility(1, 1400, 1000)).not.toBeNull();
  });

  it('le trait relaisIntangible rend l allie brievement intangible', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, RELAIS);
    room.join(2, undefined, undefined, AMORCE);
    room.debugPlace(1, 1000, 1000);
    room.debugPlace(2, 1400, 1000);
    room.useAbility(1, 1400, 1000);
    expect(room.intangibleTicksOf(2)).toBe(RELAIS_INTANGIBLE_TICKS);
  });

  /** La paire : un verbe qui n'est pas le Relais ne rend personne intangible. */
  it('sans Relais, l allie n est pas rendu intangible', () => {
    const room = new Room(1);
    room.join(1, undefined, undefined, REMPART);
    room.join(2, undefined, undefined, AMORCE);
    room.debugPlace(1, 1000, 1000);
    room.debugPlace(2, 1400, 1000);
    room.useAbility(1, 1400, 1000);
    expect(room.intangibleTicksOf(2)).toBe(0);
  });
});
