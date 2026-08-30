import { ARCHETYPES, HEAVY_HP, LIGHT_HP } from '@shared/archetypes';
import {
  CONTACT_DAMAGE,
  CONTACT_INTERVAL_TICKS,
  CONTACT_RADIUS,
  MARK_DURATION_TICKS,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
} from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import { Horde } from '@shared/horde';
import { Projectiles } from '@shared/projectiles';
import { FORMATION, type WaveOrder } from '@shared/waves';
import type { Weapon } from '@shared/weapons';
import { ZoneField } from '@shared/zones';
import { describe, expect, it } from 'vitest';

import {
  type ContactPlayer,
  markInZones,
  OrbField,
  resolveBurn,
  resolveContact,
  resolveProjectileDamage,
} from './combat';

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
  element: ELEMENT.NEUTRE,
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

describe('la marque elementaire posee a l impact (etape 5a, tache 6)', () => {
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;
  const LEGER = ARCHETYPES.find((a) => a.hp === LIGHT_HP)?.id ?? -1;
  const BRAISE: Weapon = { ...SINGLE, element: ELEMENT.BRAISE };

  /**
   * Tire `arme` depuis `(0,0)` sur `targetId` et avance jusqu'a l'impact.
   *
   * Rend les morts ET le tick de l'impact : le projectile met plusieurs pas a
   * parcourir la distance, et c'est ce tick-la — pas celui du tir — qui date la
   * marque et la zone. Le recopier a la main dans une assertion serait la
   * constante recopiee, qui derive en silence des que la geometrie change.
   */
  function frappe(
    horde: Horde,
    orbs: OrbField,
    targetId: number,
    tick: number,
    arme: Weapon,
    zones?: ZoneField,
    by = 0,
  ): { morts: number[]; impactTick: number } {
    const projectiles = new Projectiles(10);
    const dx = horde.x[horde.slotOf(targetId)] ?? 0;
    const dy = horde.y[horde.slotOf(targetId)] ?? 0;
    projectiles.fireSalvoDirected(arme, tick, 0, 0, dx, dy, arme.damage, 1, by);
    for (let i = 0; i < 20; i++) {
      const morts = resolveProjectileDamage(projectiles, DT, horde, orbs, tick + i, zones);
      if (morts.length > 0) {
        return { morts, impactTick: tick + i };
      }
      if (projectiles.count === 0) {
        return { morts: [], impactTick: tick + i };
      }
    }
    throw new Error('le projectile ne touche jamais');
  }

  it('marque le survivant avec l element de l arme et le joueur qui tire', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0, LOURD);
    const orbs = new OrbField(10);

    const { morts, impactTick } = frappe(horde, orbs, targetId, 7, BRAISE, undefined, 3);
    expect(morts).toEqual([]);
    const slot = horde.slotOf(targetId);
    expect(horde.markAt(slot, impactTick)).toBe(ELEMENT.BRAISE);
    expect(horde.markBy[slot]).toBe(3);
  });

  it('une arme neutre ne marque rien', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0, LOURD);
    const orbs = new OrbField(10);

    frappe(horde, orbs, targetId, 0, SINGLE, undefined, 3);
    const slot = horde.slotOf(targetId);
    expect(horde.markAt(slot, 0)).toBe(ELEMENT.NEUTRE);
    // Et le tireur n'est pas retenu non plus : rien n'a ete pose.
    expect(horde.markBy[slot]).toBe(0);
  });

  it('⚠️ un ennemi qui MEURT du meme impact n est PAS marque — et c est le voisin qui le prouve', () => {
    // ⚠️ **Le test le plus important de cette tache.** La marque serait posee
    // sur un creneau que `horde.kill` va COMPACTER : c'est le voisin deplace
    // dans ce creneau qui en heriterait, avec le joueur qui l'a posee — donc
    // la capacite de declencher une reaction, et une charge de Synergie, pour
    // un element que personne ne lui a applique. Meme classe de defaut que R16
    // de l'etape 4 (`Horde.spawn`).
    //
    // La victime est LEGERE (meurt en un coup) et occupe le creneau 0 ; le
    // voisin, indemne, est le dernier — c'est lui que `#removeAt` deplacera
    // dans le creneau 0.
    const horde = new Horde(10);
    const victime = addOne(horde, 1, 100, 0, LEGER);
    const voisin = addOne(horde, 2, -4000, -4000, LOURD);
    const orbs = new OrbField(10);
    expect(horde.slotOf(victime)).toBe(0);
    expect(horde.slotOf(voisin)).toBe(1);

    const { morts, impactTick } = frappe(horde, orbs, victime, 11, BRAISE, undefined, 3);
    expect(morts).toEqual([victime]);

    expect(horde.count).toBe(1);
    const slot = horde.slotOf(voisin);
    expect(slot).toBe(0);
    expect(horde.markAt(slot, impactTick)).toBe(ELEMENT.NEUTRE);
    expect(horde.markBy[slot]).toBe(0);
  });

  it('pose une zone a l impact, sur des coordonnees ARRONDIES comme sur le fil', () => {
    const horde = new Horde(10);
    // Position non entiere : c'est ce qui rend l'arrondi observable. Sans ca,
    // le test passerait avec ou sans `Math.round`.
    const targetId = addOne(horde, 1, 100.4, 0.4, LOURD);
    const orbs = new OrbField(10);
    const zones = new ZoneField();

    const { impactTick } = frappe(horde, orbs, targetId, 5, BRAISE, zones, 2);

    expect(zones.count).toBe(1);
    expect(zones.element[0]).toBe(ELEMENT.BRAISE);
    expect(zones.by[0]).toBe(2);
    // Le tick de l'IMPACT, pas celui du tir — et le projectile a bien voyage.
    expect(impactTick).toBeGreaterThan(5);
    expect(zones.bornTick[0]).toBe(impactTick);
    expect(Number.isInteger(zones.x[0])).toBe(true);
    expect(Number.isInteger(zones.y[0])).toBe(true);
  });

  it('pose une zone MEME quand le projectile n a rien touche : il finit sa course de vieillesse', () => {
    // §5.1 : « la ou un projectile elementaire finit sa course, QU IL AIT
    // TOUCHE OU NON ». C'est l'autre moitie du cablage, dans `step` et pas
    // dans `collide` — n'en cabler qu'une laisse la moitie des tirs sans trace.
    const horde = new Horde(10);
    const orbs = new OrbField(10);
    const zones = new ZoneField();
    const projectiles = new Projectiles(10);
    // Aucune entite dans la horde : rien a toucher, le projectile vieillit.
    projectiles.fireSalvoDirected(BRAISE, 0, 500, 500, 1, 0, BRAISE.damage, 1, 1);

    for (let t = 0; t <= BRAISE.projectileLifeTicks; t++) {
      resolveProjectileDamage(projectiles, DT, horde, orbs, t, zones);
    }

    expect(projectiles.count).toBe(0);
    expect(zones.count).toBe(1);
    expect(zones.element[0]).toBe(ELEMENT.BRAISE);
    expect(zones.by[0]).toBe(1);
  });

  it('un projectile neutre ne pose aucune zone, ni a l impact ni a l expiration', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0, LOURD);
    const orbs = new OrbField(10);
    const zones = new ZoneField();

    frappe(horde, orbs, targetId, 0, SINGLE, zones, 1);
    const projectiles = new Projectiles(10);
    projectiles.fireSalvoDirected(SINGLE, 0, 3000, 3000, 1, 0, SINGLE.damage, 1, 1);
    for (let t = 0; t <= SINGLE.projectileLifeTicks; t++) {
      resolveProjectileDamage(projectiles, DT, new Horde(1), orbs, t, zones);
    }

    expect(zones.count).toBe(0);
    expect(zones.truncatedZones).toBe(0);
  });

  it('sans champ de zones, rien ne se pose et la resolution reste celle d avant', () => {
    // Le chemin `zones === undefined` : c'est celui que prennent tous les
    // tests d'avant cette tache, et le client cosmetique n'en a pas d'autre.
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0, LOURD);
    const orbs = new OrbField(10);
    expect(frappe(horde, orbs, targetId, 0, BRAISE).morts).toEqual([]);
    expect(horde.hp[horde.slotOf(targetId)]).toBe(HEAVY_HP - BRAISE.damage);
  });
});

describe('markInZones — un ennemi DANS une zone est marque (etape 5a, tache 6)', () => {
  it('marque ce qui est dedans, laisse ce qui est dehors, et rafraichit tant qu on y reste', () => {
    const horde = new Horde(10);
    const dedans = addOne(horde, 1, 1000, 1000);
    // ⚠️ Juste DEHORS, a un pixel du bord : une entite a 10 000 px prouverait
    // seulement que la boucle ne marque pas tout le monde, pas que le rayon
    // est le bon.
    const dehors = addOne(horde, 2, 1000 + ZONE_RADIUS + 1, 1000);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 1000, 1000, 4, 10);

    markInZones(horde, zones, 10);

    expect(horde.markAt(horde.slotOf(dedans), 10)).toBe(ELEMENT.GIVRE);
    expect(horde.markBy[horde.slotOf(dedans)]).toBe(4);
    expect(horde.markAt(horde.slotOf(dehors), 10)).toBe(ELEMENT.NEUTRE);

    // Rafraichissement : la marque posee au tick 10 aurait expire au tick
    // 10 + MARK_DURATION_TICKS. Repassee au tick 20, elle tient jusqu'a
    // 20 + MARK_DURATION_TICKS.
    markInZones(horde, zones, 20);
    const slot = horde.slotOf(dedans);
    expect(horde.markAt(slot, 10 + MARK_DURATION_TICKS)).toBe(ELEMENT.GIVRE);
    expect(horde.markAt(slot, 20 + MARK_DURATION_TICKS)).toBe(ELEMENT.NEUTRE);
  });

  it('une zone perimee ne marque plus rien, meme si elle traine encore dans la reserve', () => {
    // Le client garde ses zones mortes quelques ticks (voir `ZoneField.aliveAt`) :
    // seul le predicat decide, jamais la presence dans le tableau.
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 1000, 1000, 4, 0);

    markInZones(horde, zones, ZONE_LIFETIME_TICKS);

    expect(zones.count).toBe(1); // elle est bien encore la
    expect(horde.markAt(horde.slotOf(cible), ZONE_LIFETIME_TICKS)).toBe(ELEMENT.NEUTRE);
  });

  it('marque DES le tick de la pose — contrairement au ralentissement', () => {
    // ⚠️ Les deux predicats du §5.1 bis, appliques au temps : `aliveAt` pour
    // la marque (la zone existe deja quand ce balayage tourne), `slowsAt` pour
    // le ralentissement (la horde a deja avance ce tick-la).
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 1000, 1000, 4, 42);

    markInZones(horde, zones, 42);

    expect(horde.markAt(horde.slotOf(cible), 42)).toBe(ELEMENT.GIVRE);
    expect(zones.slowsAt(0, 42)).toBe(false);
  });
});

describe('resolveBurn — la Braise brule (etape 5a, tache 6)', () => {
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;
  const BRULURE = elementOf(ELEMENT.BRAISE).burnPerTick;

  it('descend les PV du marque Braise, laisse le marque Givre intact', () => {
    const horde = new Horde(10);
    const brule = addOne(horde, 1, 0, 0, LOURD);
    const givre = addOne(horde, 2, 500, 500, LOURD);
    horde.applyMark(horde.slotOf(brule), ELEMENT.BRAISE, 1, 0);
    horde.applyMark(horde.slotOf(givre), ELEMENT.GIVRE, 1, 0);
    const orbs = new OrbField(10);

    expect(resolveBurn(horde, orbs, 0)).toEqual([]);

    expect(horde.hp[horde.slotOf(brule)]).toBeCloseTo(HEAVY_HP - BRULURE, 6);
    expect(horde.hp[horde.slotOf(givre)]).toBe(HEAVY_HP);
    expect(orbs.count).toBe(0);
  });

  it('ne brule plus une fois la marque expiree — l expiration est DERIVEE, jamais balayee', () => {
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 0, 0, LOURD);
    horde.applyMark(horde.slotOf(cible), ELEMENT.BRAISE, 1, 0);
    const orbs = new OrbField(10);

    resolveBurn(horde, orbs, MARK_DURATION_TICKS - 1);
    const apresDernier = horde.hp[horde.slotOf(cible)] ?? 0;
    expect(apresDernier).toBeCloseTo(HEAVY_HP - BRULURE, 6);

    resolveBurn(horde, orbs, MARK_DURATION_TICKS);
    expect(horde.hp[horde.slotOf(cible)]).toBe(apresDernier);
  });

  it('tue quand la reserve tombe a zero, laisse un orbe, et rend l identite pour le DEATHS existant', () => {
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 700, 800, LOURD);
    // ⚠️ **La MOITIE de la brulure, pas la brulure exacte.** `Horde.hp` est un
    // `Float32Array` et `burnPerTick` vaut 0,1, qui n'y est pas representable :
    // `hp = BRULURE` donnerait un reste de ~1,5e-9, positif. Le test aurait
    // l'air de mettre en scene la borne `reste <= 0` sans jamais l'atteindre —
    // exactement le defaut des deux tests d'arrondi de la tache 5.
    horde.hp[horde.slotOf(cible)] = BRULURE / 2;
    horde.applyMark(horde.slotOf(cible), ELEMENT.BRAISE, 1, 0);
    const orbs = new OrbField(10);

    expect(resolveBurn(horde, orbs, 0)).toEqual([cible]);
    expect(horde.count).toBe(0);
    expect(orbs.count).toBe(1);
    expect(orbs.id[0]).toBe(cible);
    expect(orbs.x[0]).toBeCloseTo(700, 3);
    expect(orbs.y[0]).toBeCloseTo(800, 3);
  });

  it('la brulure d une entite ne descend pas les PV de sa voisine apres compaction', () => {
    // ⚠️ La boucle avance vers l avant et `kill` compacte APRES : deux
    // entites, la premiere meurt, la seconde doit garder SES PV.
    const horde = new Horde(10);
    const mourante = addOne(horde, 1, 0, 0, LOURD);
    const voisine = addOne(horde, 2, 900, 900, LOURD);
    horde.hp[horde.slotOf(mourante)] = BRULURE / 2;
    horde.applyMark(horde.slotOf(mourante), ELEMENT.BRAISE, 1, 0);
    const orbs = new OrbField(10);

    expect(resolveBurn(horde, orbs, 0)).toEqual([mourante]);
    expect(horde.count).toBe(1);
    expect(horde.entityIdAt(0)).toBe(voisine);
    expect(horde.hp[0]).toBe(HEAVY_HP);
  });
});
