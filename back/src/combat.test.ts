import { ARCHETYPES, HEAVY_HP, LIGHT_HP } from '@shared/archetypes';
import { CONTACT_DAMAGE, CONTACT_INTERVAL_TICKS, CONTACT_RADIUS } from '@shared/constants';
import { Horde } from '@shared/horde';
import { Projectiles } from '@shared/projectiles';
import { FORMATION, type WaveOrder } from '@shared/waves';
import type { Weapon } from '@shared/weapons';
import { describe, expect, it } from 'vitest';

import { type ContactPlayer, OrbField, resolveContact, resolveProjectileDamage } from './combat';

const DT = 1 / 30;

/** Fait apparaitre une seule entite a une position controlee, avec un waveId choisi pour controler son identite. */
function addOne(horde: Horde, waveId: number, x: number, y: number, archetype = 0): number {
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

/** Arme de test : projectile unique, rapide, portee tres large. */
const SINGLE: Weapon = {
  id: 0,
  name: 'test-simple',
  cooldownTicks: 5,
  damage: 5,
  projectileSpeed: 1000,
  projectileLifeTicks: 10,
  projectileCount: 1,
  spreadRadians: 0,
};

function player(x: number, y: number, hp = 100): ContactPlayer {
  return { x, y, hp, contactInvulnTicks: 0 };
}

describe('resolveProjectileDamage', () => {
  it('tue l entite touchee et laisse un orbe a sa derniere position', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0);
    const projectiles = new Projectiles(10);
    projectiles.fireSalvo(SINGLE, 0, 0, 0, targetId, horde);
    const orbs = new OrbField(10);

    // Le projectile va de (0,0) a (1000,0) a 1000 px/s : un pas de 1/30s
    // l'amene a x=33,3, loin de la cible a x=100. Il faut plusieurs pas.
    let deadIds: number[] = [];
    for (let i = 0; i < 5 && deadIds.length === 0; i++) {
      deadIds = resolveProjectileDamage(projectiles, DT, horde, orbs, i);
    }

    expect(deadIds).toEqual([targetId]);
    expect(horde.count).toBe(0);
    expect(orbs.count).toBe(1);
    expect(orbs.id[0]).toBe(targetId);
    expect(orbs.x[0]).toBeCloseTo(100, 0);
    expect(orbs.y[0]).toBeCloseTo(0, 0);
  });

  it('ne tue rien et ne fait apparaitre aucun orbe quand aucun projectile n atteint un ennemi', () => {
    const horde = new Horde(10);
    // Cible tres loin de la trajectoire du projectile : jamais touchee.
    addOne(horde, 1, -5000, -5000);
    const projectiles = new Projectiles(10);
    // Tire sans cible valable : le projectile ne part meme pas (voir Projectiles.fireSalvo).
    projectiles.fireSalvo(SINGLE, 0, 500, 500, 999_999, horde);
    const orbs = new OrbField(10);

    const deadIds = resolveProjectileDamage(projectiles, DT, horde, orbs, 0);

    expect(deadIds).toEqual([]);
    expect(horde.count).toBe(1);
    expect(orbs.count).toBe(0);
  });

  it('ne liste jamais deux fois la meme identite quand deux projectiles la tuent au meme tick', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 100);
    const projectiles = new Projectiles(10);
    // Deux tireurs distincts, tres proches de la cible : un seul pas suffit
    // aux deux projectiles pour atteindre le segment qui la touche.
    projectiles.fireSalvo(SINGLE, 0, 100, 50, targetId, horde);
    projectiles.fireSalvo(SINGLE, 0, 50, 100, targetId, horde);
    expect(projectiles.count).toBe(2);
    const orbs = new OrbField(10);

    const deadIds = resolveProjectileDamage(projectiles, DT, horde, orbs, 0);

    expect(deadIds).toEqual([targetId]);
    expect(horde.count).toBe(0);
    expect(orbs.count).toBe(1); // un seul orbe, pas deux
  });
});

describe('resolveProjectileDamage soustrait au lieu de tuer (etape 5a)', () => {
  /** L'identifiant du premier archetype a `HEAVY_HP` PV. */
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;
  const LEGER = ARCHETYPES.find((a) => a.hp === LIGHT_HP)?.id ?? -1;

  /**
   * Tire un projectile sur `targetId` et avance jusqu'a ce qu'il touche ou
   * expire. Rend les identites mortes a ce tick-la (vide si l'ennemi a
   * survecu).
   */
  function frappe(
    horde: Horde,
    orbs: OrbField,
    targetId: number,
    tick: number,
    arme: Weapon = SINGLE,
  ): number[] {
    const projectiles = new Projectiles(10);
    projectiles.fireSalvo(arme, tick, 0, 0, targetId, horde);
    const avant = projectiles.count;
    expect(avant).toBeGreaterThan(0); // sanity : la salve est bien partie
    for (let i = 0; i < 20; i++) {
      const morts = resolveProjectileDamage(projectiles, DT, horde, orbs, tick + i);
      if (morts.length > 0) {
        return morts;
      }
      if (projectiles.count === 0) {
        return []; // touche sans tuer, ou expire
      }
    }
    throw new Error('le projectile ne touche jamais');
  }

  it('un ennemi lourd (20 PV) survit a trois impacts de 5 et meurt au quatrieme', () => {
    // ⚠️ **Le test qui compte.** C'est la seule chose qui separe « les degats
    // sont soustraits » de « le premier impact tue », et c'est ce qui rend les
    // deux passifs de degats capables de changer une issue.
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0, LOURD);
    const orbs = new OrbField(10);
    expect(horde.hp[0]).toBe(HEAVY_HP);

    for (let coup = 1; coup <= 3; coup++) {
      expect(frappe(horde, orbs, targetId, coup * 40)).toEqual([]);
      expect(horde.count).toBe(1);
      expect(horde.hp[0]).toBe(HEAVY_HP - SINGLE.damage * coup);
      expect(orbs.count).toBe(0);
    }

    expect(frappe(horde, orbs, targetId, 400)).toEqual([targetId]);
    expect(horde.count).toBe(0);
    expect(orbs.count).toBe(1);
  });

  it('un ennemi leger meurt au premier impact — le rythme de l etape 3, inchange', () => {
    // La contrepartie de la porte du §3.3 : `LIGHT_HP` vaut les degats de la
    // dague, donc rien ne change pour la pietaille legere.
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0, LEGER);
    const orbs = new OrbField(10);

    expect(frappe(horde, orbs, targetId, 0)).toEqual([targetId]);
    expect(horde.count).toBe(0);
  });

  it('une arme qui frappe pile la reserve tue : la borne est <= 0, pas < 0', () => {
    // ⚠️ La mutation `reste <= 0` -> `reste < 0`. Sans ce cas, un ennemi
    // ramene a exactement zero PV resterait vivant a 0 PV, invulnerable a rien
    // mais bien present — et il faudrait un impact de plus pour chaque mort.
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0, LOURD);
    const orbs = new OrbField(10);
    const pile: Weapon = { ...SINGLE, damage: HEAVY_HP };

    expect(frappe(horde, orbs, targetId, 0, pile)).toEqual([targetId]);
    expect(horde.count).toBe(0);
  });

  it('les degats vont a l entite TOUCHEE, pas au creneau qui porte son indice', () => {
    // ⚠️ La compaction de `Horde.kill` deplace la derniere entite dans le trou :
    // confondre « identite » et « creneau » ferait descendre les PV d'un
    // monstre au hasard. Deux lourds, on tue le premier par quatre impacts, et
    // le second doit etre INTACT.
    const horde = new Horde(10);
    const premier = addOne(horde, 1, 100, 0, LOURD);
    addOne(horde, 2, -4000, -4000, LOURD);
    const orbs = new OrbField(10);

    for (let coup = 1; coup <= 3; coup++) {
      frappe(horde, orbs, premier, coup * 40);
    }
    expect(horde.hp[horde.slotOf(premier)]).toBe(HEAVY_HP - SINGLE.damage * 3);
    // Le second n'a rien pris.
    const survivant = horde.entityIdAt(horde.slotOf(premier) === 0 ? 1 : 0);
    expect(horde.hp[horde.slotOf(survivant)]).toBe(HEAVY_HP);

    expect(frappe(horde, orbs, premier, 400)).toEqual([premier]);
    // Et apres compaction, le survivant garde SES PV, pas ceux du mort.
    expect(horde.count).toBe(1);
    expect(horde.hp[0]).toBe(HEAVY_HP);
  });
});

describe('resolveContact', () => {
  it('endommage un joueur au contact, une fois, puis plus rien pendant CONTACT_INTERVAL_TICKS', () => {
    const horde = new Horde(10);
    addOne(horde, 1, 500, 500);
    const p = player(500, 500);

    resolveContact([p], horde);
    expect(p.hp).toBe(100 - CONTACT_DAMAGE);
    expect(p.contactInvulnTicks).toBe(CONTACT_INTERVAL_TICKS);

    // Toujours au contact, mais invulnerable : aucun degat supplementaire
    // pendant toute la fenetre. Le compteur part de CONTACT_INTERVAL_TICKS et
    // se decremente d'un par appel ; il faut donc CONTACT_INTERVAL_TICKS
    // appels pour l'epuiser jusqu'a zero (le dernier de ces appels le fait
    // passer de 1 a 0 mais ne fait pas encore mal — voir resolveContact).
    for (let i = 0; i < CONTACT_INTERVAL_TICKS; i++) {
      resolveContact([p], horde);
    }
    expect(p.hp).toBe(100 - CONTACT_DAMAGE);

    // La fenetre est ecoulee : le contact fait a nouveau mal.
    resolveContact([p], horde);
    expect(p.hp).toBe(100 - 2 * CONTACT_DAMAGE);
  });

  it('ne touche pas un joueur hors de CONTACT_RADIUS', () => {
    const horde = new Horde(10);
    addOne(horde, 1, 500, 500);
    const p = player(500 + CONTACT_RADIUS + 5, 500);

    resolveContact([p], horde);

    expect(p.hp).toBe(100);
    expect(p.contactInvulnTicks).toBe(0);
  });

  it('ne fait jamais descendre les pv sous zero', () => {
    const horde = new Horde(10);
    addOne(horde, 1, 500, 500);
    const p = player(500, 500, CONTACT_DAMAGE - 3);

    resolveContact([p], horde);

    expect(p.hp).toBe(0);
  });
});

describe('OrbField.resolvePickups', () => {
  it('ramasse un orbe a portee et laisse un orbe hors de portee intact', () => {
    const orbs = new OrbField(10);
    orbs.spawn(1, 100, 100, 0);
    // Assez loin pour etre hors d'ORB_PICKUP_RADIUS, sans etre absurde.
    orbs.spawn(2, 5000, 5000, 0);

    const picked = orbs.resolvePickups([{ x: 100, y: 100 }], 1);

    expect(picked).toEqual([1]);
    expect(orbs.count).toBe(1);
    expect(orbs.id[0]).toBe(2);
  });

  it('expire un orbe apres ORB_LIFETIME_TICKS meme si personne n est a portee', () => {
    const orbs = new OrbField(10);
    orbs.spawn(1, 100, 100, 0);

    // Personne a proximite : la duree de vie seule doit le retirer.
    const picked = orbs.resolvePickups([{ x: -9000, y: -9000 }], 600);

    expect(picked).toEqual([]);
    expect(orbs.count).toBe(0);
  });

  it('preuve de non-vacuite : plusieurs morts, plusieurs orbes, plusieurs ramassages', () => {
    const horde = new Horde(50);
    const orbs = new OrbField(50);
    const projectiles = new Projectiles(50);

    // Espaces de 50 px : largement au-dela de PROJECTILE_HIT_RADIUS (32 px)
    // pour qu'aucun tir ne touche accidentellement la cible voisine.
    const targets: number[] = [];
    for (let w = 0; w < 5; w++) {
      targets.push(addOne(horde, w + 1, 50 * (w + 1), 0));
    }
    for (const [i, targetId] of targets.entries()) {
      projectiles.fireSalvo(SINGLE, 0, 50 * (i + 1), -20, targetId, horde);
    }

    let allDead: number[] = [];
    for (let tick = 0; tick < 5; tick++) {
      const dead = resolveProjectileDamage(projectiles, DT, horde, orbs, tick);
      allDead = allDead.concat(dead);
    }

    expect(allDead.length).toBe(5);
    expect(new Set(allDead).size).toBe(5); // toutes distinctes
    expect(orbs.count).toBe(5);

    // Orbes a x = 50,100,150,200,250 ; un joueur en (150,0), rayon 90 :
    // atteint 100, 150 et 200 (distances 50, 0, 50) mais pas 50 ni 250
    // (distances 100) — trois ramasses sur cinq, ni zero ni tous.
    const picked = orbs.resolvePickups([{ x: 150, y: 0 }], 5);
    expect(picked.length).toBe(3);
    expect(orbs.count).toBe(2);
  });
});
