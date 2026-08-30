import { ARCHETYPES, HEAVY_HP, LIGHT_HP } from '@shared/archetypes';
import {
  CONTACT_DAMAGE,
  CONTACT_INTERVAL_TICKS,
  CONTACT_RADIUS,
  MARK_DURATION_TICKS,
  REACTION_DAMAGE,
  REACTION_RADIUS,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
} from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import { Horde } from '@shared/horde';
import { Projectiles } from '@shared/projectiles';
import { packElementPair } from '@shared/protocol';
import { FORMATION, type WaveOrder } from '@shared/waves';
import type { Weapon } from '@shared/weapons';
import { ZoneField } from '@shared/zones';
import { describe, expect, it } from 'vitest';

import {
  applyReactions,
  type ContactPlayer,
  markInZones,
  OrbField,
  Reactions,
  type ReactionTrigger,
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
  // Apparence quelconque : `combat.ts` ne lit jamais `look` (etape 5a, tache
  // 12 — c'est le seul champ de `Weapon` que la simulation ignore).
  look: { shape: 'sphere', diameterPx: 10, tint: 0x123456, glow: 0.3, trailTicks: 1 },
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

    markInZones(horde, zones, 10, new Reactions());

    expect(horde.markAt(horde.slotOf(dedans), 10)).toBe(ELEMENT.GIVRE);
    expect(horde.markBy[horde.slotOf(dedans)]).toBe(4);
    expect(horde.markAt(horde.slotOf(dehors), 10)).toBe(ELEMENT.NEUTRE);

    // Rafraichissement : la marque posee au tick 10 aurait expire au tick
    // 10 + MARK_DURATION_TICKS. Repassee au tick 20, elle tient jusqu'a
    // 20 + MARK_DURATION_TICKS.
    markInZones(horde, zones, 20, new Reactions());
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

    markInZones(horde, zones, ZONE_LIFETIME_TICKS, new Reactions());

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

    markInZones(horde, zones, 42, new Reactions());

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

describe('la reaction — les quatre declencheurs du §6.2 (etape 5a, tache 7)', () => {
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;
  const LEGER = ARCHETYPES.find((a) => a.hp === LIGHT_HP)?.id ?? -1;
  const BRAISE: Weapon = { ...SINGLE, element: ELEMENT.BRAISE };
  const GIVRE: Weapon = { ...SINGLE, element: ELEMENT.GIVRE };

  /**
   * Tire `arme` sur `targetId` et avance jusqu'a l'impact. Meme helper que
   * `frappe` plus haut, avec le champ de reactions en plus.
   */
  function frappeAvecReactions(
    horde: Horde,
    targetId: number,
    tick: number,
    arme: Weapon,
    reactions: Reactions,
    by: number,
  ): number {
    const orbs = new OrbField(10);
    const projectiles = new Projectiles(10);
    const dx = horde.x[horde.slotOf(targetId)] ?? 0;
    const dy = horde.y[horde.slotOf(targetId)] ?? 0;
    projectiles.fireSalvoDirected(arme, tick, 0, 0, dx, dy, arme.damage, 1, by);
    for (let i = 0; i < 20; i++) {
      resolveProjectileDamage(projectiles, DT, horde, orbs, tick + i, undefined, reactions);
      if (projectiles.count === 0) {
        return tick + i;
      }
    }
    throw new Error('le projectile ne touche jamais');
  }

  it('ennemi marque Braise, touche par un projectile Givre : reaction, et la marque se CONSOMME', () => {
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 300, 0, LOURD);
    horde.applyMark(horde.slotOf(cible), ELEMENT.BRAISE, 2, 0);
    const reactions = new Reactions();

    const tick = frappeAvecReactions(horde, cible, 0, GIVRE, reactions, 3);

    const [reaction, ...reste] = reactions.drain();
    expect(reste).toEqual([]);
    expect(reaction?.pair).toBe(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE));
    // Les deux joueurs, que la tache 8 comparera — le message, lui, n'en
    // portera aucun (§6.1).
    expect(reaction?.markBy).toBe(2);
    expect(reaction?.by).toBe(3);
    // §4.3 : l'ennemi ressort NU. Ni Braise, ni Givre.
    expect(horde.markAt(horde.slotOf(cible), tick)).toBe(ELEMENT.NEUTRE);
  });

  it('ennemi marque Braise, touche par un projectile BRAISE : aucune reaction, la marque se rafraichit', () => {
    // La quatrieme ligne du §6.2, celle qui dit « non ». Sans elle, une seule
    // arme elementaire suffirait a declencher des reactions en boucle.
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 300, 0, LOURD);
    horde.applyMark(horde.slotOf(cible), ELEMENT.BRAISE, 2, 0);
    const reactions = new Reactions();

    const tick = frappeAvecReactions(horde, cible, 5, BRAISE, reactions, 3);

    expect(reactions.count).toBe(0);
    const slot = horde.slotOf(cible);
    expect(horde.markAt(slot, tick)).toBe(ELEMENT.BRAISE);
    // RAFRAICHIE, pas seulement conservee : elle tient au-dela de la duree de
    // la marque d'origine, posee au tick 0.
    expect(horde.markAt(slot, MARK_DURATION_TICKS)).toBe(ELEMENT.BRAISE);
    // Et le joueur retenu est celui du dernier tir, pas celui de la marque
    // d'origine — c'est lui que la Synergie comparera.
    expect(horde.markBy[slot]).toBe(3);
  });

  it('un ennemi qui MEURT du meme impact ne reagit pas — il n y a plus rien a consommer', () => {
    // ⚠️ **Consequence assumee, et elle se mesure** : la pietaille legere
    // (LIGHT_HP) meurt au premier coup de la plupart des armes, donc elle ne
    // declenchera jamais de reaction par PROJECTILE. C'est la pietaille lourde
    // qui porte le systeme elementaire (§3.3 de la spec), et c'est pour ca
    // qu'elle existe.
    //
    // Le meme `return` que celui qui empeche de marquer un mourant : une
    // reaction consomme une marque, et un mort n'en porte plus.
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 300, 0, LEGER);
    horde.applyMark(horde.slotOf(cible), ELEMENT.BRAISE, 2, 0);
    expect(GIVRE.damage).toBeGreaterThanOrEqual(LIGHT_HP);
    const reactions = new Reactions();

    frappeAvecReactions(horde, cible, 0, GIVRE, reactions, 3);

    expect(horde.slotOf(cible)).toBe(-1);
    expect(reactions.count).toBe(0);
  });

  it('ennemi marque Braise, entrant dans une zone de Givre : reaction', () => {
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LOURD);
    horde.applyMark(horde.slotOf(cible), ELEMENT.BRAISE, 1, 10);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 1000, 1000, 4, 10);
    const reactions = new Reactions();

    markInZones(horde, zones, 10, reactions);

    const [reaction] = reactions.drain();
    expect(reaction?.pair).toBe(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE));
    expect(reaction?.markBy).toBe(1);
    expect(reaction?.by).toBe(4);
    expect(horde.markAt(horde.slotOf(cible), 10)).toBe(ELEMENT.NEUTRE);
  });

  it('une zone du MEME element que la marque ne declenche rien', () => {
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LOURD);
    horde.applyMark(horde.slotOf(cible), ELEMENT.GIVRE, 1, 10);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 1000, 1000, 4, 10);
    const reactions = new Reactions();

    markInZones(horde, zones, 10, reactions);

    expect(reactions.count).toBe(0);
    expect(horde.markAt(horde.slotOf(cible), 10)).toBe(ELEMENT.GIVRE);
  });

  it('une marque PERIMEE ne reagit plus : c est markAt qui decide, jamais le tableau brut', () => {
    // ⚠️ **Mutation appliquee, elle survivait avant ce test** : lire
    // `horde.mark[slot]` au lieu de `horde.markAt(slot, tick)` fait reagir un
    // ennemi dont la Braise est tombee depuis longtemps. L'expiration d'une
    // marque est DERIVEE, jamais balayee (voir `Horde.markAt`) : le tableau
    // garde donc l'element d'une marque morte indefiniment.
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LOURD);
    horde.applyMark(horde.slotOf(cible), ELEMENT.BRAISE, 1, 0);
    const zones = new ZoneField();
    const reactions = new Reactions();

    // Pile a l'expiration : la borne de `markAt` est stricte.
    const tard = MARK_DURATION_TICKS;
    zones.spawn(ELEMENT.GIVRE, 1000, 1000, 4, tard);
    markInZones(horde, zones, tard, reactions);

    expect(reactions.count).toBe(0);
    // Et la zone a fait son travail normal : elle a simplement marque.
    expect(horde.markAt(horde.slotOf(cible), tard)).toBe(ELEMENT.GIVRE);
  });

  it('le couple d elements est CANONICALISE : Braise puis Givre et Givre puis Braise portent le meme octet', () => {
    // ⚠️ Sans `packElementPair`, les deux sens porteraient deux octets
    // differents pour le MEME evenement, et deux clients dessineraient deux
    // flashs differents (constat de la tache 5).
    function pairDe(marque: number, zone: number): number {
      const horde = new Horde(10);
      const cible = addOne(horde, 1, 1000, 1000, LOURD);
      horde.applyMark(horde.slotOf(cible), marque, 1, 0);
      const zones = new ZoneField();
      zones.spawn(zone, 1000, 1000, 2, 0);
      const reactions = new Reactions();
      markInZones(horde, zones, 0, reactions);
      return reactions.drain()[0]?.pair ?? -1;
    }

    const braisePuisGivre = pairDe(ELEMENT.BRAISE, ELEMENT.GIVRE);
    expect(braisePuisGivre).toBe(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE));
    expect(pairDe(ELEMENT.GIVRE, ELEMENT.BRAISE)).toBe(braisePuisGivre);
  });

  it('deux zones reagissent quand leurs DISQUES se coupent, pas quand leurs CENTRES se couvrent (R19)', () => {
    // ⚠️ **Le facteur 2 de R19, mis en scene.** Deux predicats distincts :
    // fusionner a la pose regarde le CENTRE (distance < ZONE_RADIUS), deux
    // zones reagissent quand les DISQUES sont secants (distance
    // < 2 x ZONE_RADIUS). La distance choisie ici tombe entre les deux : elle
    // est le seul endroit ou les confondre se voit.
    // ⚠️ **Un ecart sur LES DEUX axes**, jamais sur un seul : avec deux zones
    // alignees, le milieu des centres et le centre de la seconde partagent
    // l'autre coordonnee, et une mutation sur cet axe-la survit (appliquee,
    // verifiee).
    const ECART_X = 60;
    const ECART_Y = 80;
    const distance = Math.hypot(ECART_X, ECART_Y);
    expect(distance).toBeGreaterThan(ZONE_RADIUS);
    expect(distance).toBeLessThan(2 * ZONE_RADIUS);

    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 1000, 1000, 1, 0);
    const seconde = zones.spawn(ELEMENT.GIVRE, 1000 + ECART_X, 1000 + ECART_Y, 2, 0);
    // Deux zones bien distinctes : la fusion, elle, n'a pas eu lieu.
    expect(zones.count).toBe(2);

    const reactions = new Reactions();
    reactions.onZoneCreated(zones, seconde, 0);

    const [reaction, ...reste] = reactions.drain();
    expect(reste).toEqual([]);
    expect(reaction?.pair).toBe(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE));
    // A la frontiere commune (§5.2) : le milieu des deux centres.
    expect(reaction?.x).toBe(1000 + ECART_X / 2);
    expect(reaction?.y).toBe(1000 + ECART_Y / 2);
    expect(reaction?.markBy).toBe(1);
    expect(reaction?.by).toBe(2);
  });

  it('deux zones du MEME element qui se recouvrent ne reagissent pas', () => {
    // ⚠️ **Mutation appliquee, elle survivait avant ce test.** Ce n'est pas un
    // cas theorique : la regle de fusion (§5.1 bis) espace les zones d'un
    // meme element de plus d'un RAYON, pas d'un diametre — une trainee de tir
    // est donc faite de zones du meme element qui SE RECOUVRENT. Sans ce
    // garde, chaque zone posee reagirait avec toutes ses voisines de la
    // trainee, a chaque tir.
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 1000, 1000, 1, 0);
    const seconde = zones.spawn(ELEMENT.BRAISE, 1000 + ZONE_RADIUS + 10, 1000, 2, 0);
    expect(zones.count).toBe(2);
    expect(zones.overlaps(0, seconde)).toBe(true);
    const reactions = new Reactions();

    reactions.onZoneCreated(zones, seconde, 0);

    expect(reactions.count).toBe(0);
  });

  it('deux zones TANGENTES ne reagissent pas : la borne est stricte', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 1000, 1000, 1, 0);
    const seconde = zones.spawn(ELEMENT.GIVRE, 1000 + 2 * ZONE_RADIUS, 1000, 2, 0);
    const reactions = new Reactions();

    reactions.onZoneCreated(zones, seconde, 0);

    expect(reactions.count).toBe(0);
  });

  it('une zone perimee ne reagit plus, meme si elle traine encore dans la reserve', () => {
    // Le client garde ses zones mortes quelques ticks (`ZoneField.aliveAt`) ;
    // seul le predicat decide, jamais la presence dans le tableau.
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 1000, 1000, 1, 0);
    const seconde = zones.spawn(ELEMENT.GIVRE, 1000 + ZONE_RADIUS + 10, 1000, 2, 0);
    const reactions = new Reactions();

    reactions.onZoneCreated(zones, seconde, ZONE_LIFETIME_TICKS);

    expect(zones.count).toBe(2); // elle est bien encore la
    expect(reactions.count).toBe(0);
  });

  it('deux zones ne reagissent qu A LA CREATION de la seconde, jamais a son rafraichissement', () => {
    // ⚠️ Sans cette borne, une arme elementaire qui entretient sa zone par
    // fusion (§5.1 bis) declencherait une reaction A CHAQUE TIR, indefiniment.
    //
    // Deux passes : la premiere APPREND ou le projectile finit sa course (elle
    // n'a pas de zone voisine, donc rien a declencher), la seconde y pose une
    // zone de Givre a portee et tire deux fois au meme endroit.
    function vieillit(zones: ZoneField, reactions: Reactions | undefined, tick: number): void {
      const projectiles = new Projectiles(4);
      projectiles.fireSalvoDirected(BRAISE, tick, 2000, 2000, 1, 0, BRAISE.damage, 1, 7);
      for (let t = 0; t <= BRAISE.projectileLifeTicks; t++) {
        resolveProjectileDamage(
          projectiles,
          DT,
          new Horde(1),
          new OrbField(1),
          tick + t,
          zones,
          reactions,
        );
      }
    }

    const sonde = new ZoneField();
    vieillit(sonde, undefined, 0);
    expect(sonde.count).toBe(1);
    const bx = sonde.x[0] ?? 0;
    const by = sonde.y[0] ?? 0;

    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, bx + ZONE_RADIUS + 10, by, 9, 0);
    const reactions = new Reactions();

    vieillit(zones, reactions, 0);
    expect(zones.count).toBe(2);
    expect(reactions.count).toBe(1);

    // Second tir, meme trajectoire : la zone de Braise est RAFRAICHIE, pas
    // creee — aucune zone de plus, et aucune reaction de plus.
    vieillit(zones, reactions, 20);
    expect(zones.count).toBe(2);
    expect(reactions.count).toBe(1);
  });

  it('la borne : vingt ennemis marques sous UNE zone de Givre font vingt reactions, une chacun', () => {
    // La mise en scene exacte du §6.2. Vingt, pas une : la borne est PAR
    // ENNEMI, pas par tick — un compteur global etoufferait dix-neuf flashs.
    const horde = new Horde(50);
    for (let i = 0; i < 20; i++) {
      const id = addOne(horde, i + 1, 1000 + i, 1000, LOURD);
      horde.applyMark(horde.slotOf(id), ELEMENT.BRAISE, 1, 0);
    }
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 1000, 1000, 2, 0);
    const reactions = new Reactions();

    markInZones(horde, zones, 0, reactions);

    expect(reactions.count).toBe(20);
  });

  it('la borne : un ennemi ne reagit qu UNE FOIS par tick, meme sous trois zones alternees', () => {
    // ⚠️ **Le test qui porte la borne.** Trois zones balayees dans l'ordre —
    // Givre, Braise, Givre — remarquent l'ennemi entre deux reactions : sans
    // la borne, chaque ennemi reagirait DEUX fois au meme tick, et chaque
    // reaction infligerait `REACTION_DAMAGE` a tous ses voisins. Le §6.2 :
    // « la cascade est un risque de cout autant que de lisibilite ».
    const horde = new Horde(50);
    for (let i = 0; i < 20; i++) {
      const id = addOne(horde, i + 1, 1000 + i * 0.5, 1000, LOURD);
      horde.applyMark(horde.slotOf(id), ELEMENT.BRAISE, 1, 0);
    }
    const zones = new ZoneField();
    // Les deux zones de Givre sont a plus d'un ZONE_RADIUS l'une de l'autre :
    // la regle de fusion les laisse coexister, et leur intersection couvre
    // tout l'amas.
    zones.spawn(ELEMENT.GIVRE, 1000 - 40, 1000, 2, 0);
    zones.spawn(ELEMENT.BRAISE, 1000, 1000, 3, 0);
    zones.spawn(ELEMENT.GIVRE, 1000 + 40, 1000, 2, 0);
    expect(zones.count).toBe(3);
    const reactions = new Reactions();

    markInZones(horde, zones, 0, reactions);

    // Vingt, pas quarante.
    expect(reactions.count).toBe(20);
  });

  it('drain remet la borne a zero : le tick suivant peut reagir a nouveau', () => {
    // ⚠️ Sans cette remise a zero, un ennemi qui a reagi une fois ne
    // reagirait plus jamais de toute la partie.
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LOURD);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 1000, 1000, 2, 0);
    const reactions = new Reactions();

    horde.applyMark(horde.slotOf(cible), ELEMENT.BRAISE, 1, 0);
    markInZones(horde, zones, 0, reactions);
    expect(reactions.drain().length).toBe(1);

    horde.applyMark(horde.slotOf(cible), ELEMENT.BRAISE, 1, 1);
    markInZones(horde, zones, 1, reactions);
    expect(reactions.drain().length).toBe(1);
  });
});

describe('applyReactions — la reaction tue par REACTION_RADIUS (etape 5a, tache 7)', () => {
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;

  function declencheur(x: number, y: number): ReactionTrigger {
    return { pair: packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE), x, y, markBy: 1, by: 2 };
  }

  it('tue dans le rayon, epargne juste dehors, et laisse un orbe a chaque mort', () => {
    // ⚠️ « Juste dehors » a un pixel du bord : une entite a 10 000 px
    // prouverait seulement que la boucle ne tue pas tout le monde.
    const horde = new Horde(10);
    const dedans = addOne(horde, 1, 1000 + REACTION_RADIUS - 1, 1000, LOURD);
    const dehors = addOne(horde, 2, 1000 + REACTION_RADIUS, 1000, LOURD);
    const orbs = new OrbField(10);

    const morts = applyReactions(horde, orbs, 7, [declencheur(1000, 1000)]);

    expect(morts).toEqual([dedans]);
    expect(horde.slotOf(dedans)).toBe(-1);
    // Celui de dehors n'a rien pris du tout : sa reserve est intacte.
    expect(horde.hp[horde.slotOf(dehors)]).toBe(HEAVY_HP);
    // Un orbe, a la position de la mort — le §12 de la spec : une mort
    // elementaire ne prive pas l'equipe de son experience.
    expect(orbs.count).toBe(1);
    expect(orbs.id[0]).toBe(dedans);
    expect(orbs.x[0]).toBe(1000 + REACTION_RADIUS - 1);
    expect(orbs.bornTick[0]).toBe(7);
  });

  it('des degats BRUTS et MASSIFS : la pietaille lourde tombe d un seul choc', () => {
    // `REACTION_DAMAGE` n'est jamais recopie : l'assertion porte sur la
    // relation que la constante doit tenir, pas sur son chiffre.
    expect(REACTION_DAMAGE).toBeGreaterThan(HEAVY_HP);
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LOURD);
    const morts = applyReactions(horde, new OrbField(10), 0, [declencheur(1000, 1000)]);
    expect(morts).toEqual([cible]);
  });

  it('un ennemi qui SURVIT au choc en garde la trace dans sa reserve', () => {
    // ⚠️ **Mutation appliquee, elle survivait avant ce test** : ne pas ecrire
    // `horde.hp` du tout laissait toute la suite verte, parce que
    // `REACTION_DAMAGE` depasse `HEAVY_HP` et que rien ne survivait jamais
    // pour le prouver. Les degats seraient devenus purement binaires — et le
    // jour ou un archetype plus resistant arrive (les elites, l'etape 6), deux
    // chocs ne l'useraient pas.
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LOURD);
    horde.hp[horde.slotOf(cible)] = 1000;

    expect(applyReactions(horde, new OrbField(10), 0, [declencheur(1000, 1000)])).toEqual([]);
    expect(horde.hp[horde.slotOf(cible)]).toBe(1000 - REACTION_DAMAGE);
  });

  it('une reserve qui tombe PILE a zero meurt : la borne est <= 0, pas < 0', () => {
    // Meme borne que `resolveProjectileDamage`, et elle se teste ici parce
    // qu'elle le peut : les degats de reaction sont ENTIERS, contrairement a
    // `burnPerTick` (0,1, non representable en `Float32`) dont la borne est
    // arithmetiquement intestable — voir `resolveBurn`.
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LOURD);
    horde.hp[horde.slotOf(cible)] = REACTION_DAMAGE;

    expect(applyReactions(horde, new OrbField(10), 0, [declencheur(1000, 1000)])).toEqual([cible]);
  });

  it('l ennemi qui DECLENCHE est touche comme les autres : il est a distance nulle', () => {
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 500, 500, LOURD);
    expect(applyReactions(horde, new OrbField(10), 0, [declencheur(500, 500)])).toEqual([cible]);
  });

  it('deux reactions qui achevent le meme ennemi ne le listent qu une fois', () => {
    // Meme garantie que le `Set` de `resolveProjectileDamage` : le §3.1 de la
    // spec de l'etape 3 suppose des identites uniques dans DEATHS, et
    // `Horde.kill` supprimerait l'entite VIVANTE deplacee dans le creneau.
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LOURD);
    const survivant = addOne(horde, 2, -5000, -5000, LOURD);

    const morts = applyReactions(horde, new OrbField(10), 0, [
      declencheur(1000, 1000),
      declencheur(1000 + 1, 1000),
    ]);

    expect(morts).toEqual([cible]);
    expect(horde.count).toBe(1);
    expect(horde.slotOf(survivant)).toBe(0);
  });

  it('sans declencheur, rien ne bouge', () => {
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LOURD);
    expect(applyReactions(horde, new OrbField(10), 0, [])).toEqual([]);
    expect(horde.hp[horde.slotOf(cible)]).toBe(HEAVY_HP);
  });

  it('tous les degats AVANT la compaction : la voisine d une victime n herite de rien', () => {
    // ⚠️ Tuer entre deux reactions deplacerait les entites dans les creneaux
    // liberes, et la seconde reaction frapperait des voisins choisis par
    // l'ordre du tableau plutot que par la geometrie.
    const horde = new Horde(10);
    const victime = addOne(horde, 1, 1000, 1000, LOURD);
    const loin = addOne(horde, 2, -5000, -5000, LOURD);
    const morts = applyReactions(horde, new OrbField(10), 0, [
      declencheur(1000, 1000),
      declencheur(1000, 1000),
    ]);
    expect(morts).toEqual([victime]);
    // Le survivant a pris la place du mort dans le creneau 0, mais sa reserve
    // est celle qu'il avait : rien ne l'a touche.
    expect(horde.hp[horde.slotOf(loin)]).toBe(HEAVY_HP);
  });
});
