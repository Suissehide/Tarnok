import {
  ARCHETYPES,
  BOSS_ARCHETYPE,
  BOSS_ARMOR,
  HEAVY_ARMOR,
  HEAVY_HP,
  LIGHT_HP,
  MAX_ARMOR,
} from '@shared/archetypes';
import {
  BOSS_CHARGE_DAMAGE,
  BOSS_CHARGE_TICKS,
  type BossCharge,
  chargePointAt,
  makeBossCharge,
} from '@shared/boss';
import {
  CHAIN_JUMPS,
  CHAIN_RADIUS,
  COIN_DROP_ONE_IN,
  CONTACT_DAMAGE,
  CONTACT_INTERVAL_TICKS,
  CONTACT_RADIUS,
  MARK_DURATION_TICKS,
  ORB_DROP_ONE_IN,
  REACTION_DAMAGE,
  REACTION_RADIUS,
  SURCHAUFFE_ZONE_LIFETIME_TICKS,
  XP_PER_ORB,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
} from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import { dropsCoin, dropsOrb, entityIdOf, Horde, leavesDrop } from '@shared/horde';
import { Projectiles } from '@shared/projectiles';
import { packElementPair, packZoneKind, zoneReaction } from '@shared/protocol';
import { REACTION } from '@shared/reactions';
import { FORMATION, type WaveOrder } from '@shared/waves';
import type { Weapon } from '@shared/weapons';
import { ZoneField } from '@shared/zones';
import { describe, expect, it, vi } from 'vitest';

import {
  appliquerDegats,
  applyReactions,
  type ChargeTarget,
  type ContactPlayer,
  markInZones,
  OrbField,
  Reactions,
  type ReactionTrigger,
  resolveBurn,
  resolveChargeHit,
  resolveContact,
  resolveProjectileDamage,
} from './combat';

const DT = 1 / 30;

/**
 * Un sol NU : aucune zone, donc `ZoneField.ampAt` rend 1 partout et
 * `appliquerDegats` n'amplifie rien. C'est le decor par defaut de tout ce
 * fichier sauf des tests qui parlent des zones.
 *
 * ⚠️ **Neuf a chaque appel, jamais partage** — meme raison que la reserve
 * neuve du helper `tue` plus bas : un decor partage ferait dependre un test de
 * ce qu'un autre a pose.
 */
function solNu(): ZoneField {
  return new ZoneField();
}

/**
 * Ce qu'un coup de `brut` retire VRAIMENT a la pietaille lourde : son armure
 * en absorbe `HEAVY_ARMOR`.
 *
 * ⚠️ **Pour les DECORS seulement.** Les tests qui gardent la formule de
 * l'armure n'appellent pas cette fonction — ils ecrivent leurs nombres en
 * clair (voir `describe('l armure ...')`), sinon ils ne feraient que recopier
 * la production et passeraient quoi qu'elle fasse.
 */
function coupSurLourd(brut: number): number {
  return brut * (1 - HEAVY_ARMOR);
}

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

/**
 * Une vague ENTIERE, a index CONSECUTIFS, alignee sur l'axe des x.
 *
 * ⚠️ **Ajoutee a la tache 17, et `addOne` ne peut pas la remplacer** : chaque
 * appel a `addOne` pose une vague d'un seul monstre, donc toujours l'index 0 —
 * et l'index 0 laisse toujours un orbe (`dropsOrb`). Un decor bati sur `addOne`
 * ne verrait donc jamais le taux de chute. C'est la « fixture qui masque » du
 * depot, prise ici a la source.
 */
function addWave(horde: Horde, waveId: number, count: number, step: number): number[] {
  const order: WaveOrder = {
    waveId,
    spawnTick: 0,
    seed: 1,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: 0,
    anchorY: 0,
    count,
  };
  horde.spawn(order);
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const slot = horde.count - count + i;
    horde.x[slot] = step * (i + 1);
    horde.y[slot] = 0;
    ids.push(horde.entityIdAt(slot));
  }
  // Le decor n'a de sens que si les index se suivent vraiment.
  expect(ids).toEqual(ids.map((_, i) => entityIdOf(waveId, i)));
  return ids;
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
  blastRadius: 0,
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
      deadIds = resolveProjectileDamage(projectiles, DT, horde, orbs, i, solNu());
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

    const deadIds = resolveProjectileDamage(projectiles, DT, horde, orbs, 0, solNu());

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

    const deadIds = resolveProjectileDamage(projectiles, DT, horde, orbs, 0, solNu());

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
    const zones = solNu();
    const projectiles = new Projectiles(10);
    projectiles.fireSalvo(arme, tick, 0, 0, targetId, horde);
    const avant = projectiles.count;
    expect(avant).toBeGreaterThan(0); // sanity : la salve est bien partie
    for (let i = 0; i < 20; i++) {
      const morts = resolveProjectileDamage(projectiles, DT, horde, orbs, tick + i, zones);
      if (morts.length > 0) {
        return morts;
      }
      if (projectiles.count === 0) {
        return []; // touche sans tuer, ou expire
      }
    }
    throw new Error('le projectile ne touche jamais');
  }

  it('un ennemi lourd (20 PV, 15 % d armure) survit a quatre impacts de 5 et meurt au cinquieme', () => {
    // ⚠️ **Le test qui compte.** C'est la seule chose qui separe « les degats
    // sont soustraits » de « le premier impact tue », et c'est ce qui rend les
    // deux passifs de degats capables de changer une issue.
    //
    // ⚠️ **Les restes sont ecrits EN CLAIR, pas derives de `HEAVY_ARMOR`.** Une
    // suite `HEAVY_HP - SINGLE.damage * (1 - HEAVY_ARMOR) * coup` recopierait la
    // formule de production et passerait quoi qu'elle fasse — c'est l'assertion
    // creuse, dix-sept fois dans ce depot. 5 x 0,85 = 4,25 par coup : 15,75,
    // 11,5, 7,25, 3 — puis -1,25, donc la mort au cinquieme.
    const restes = [15.75, 11.5, 7.25, 3];
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0, LOURD);
    const orbs = new OrbField(10);
    expect(horde.hp[0]).toBe(HEAVY_HP);

    for (const [i, reste] of restes.entries()) {
      expect(frappe(horde, orbs, targetId, (i + 1) * 40)).toEqual([]);
      expect(horde.count).toBe(1);
      expect(horde.hp[0]).toBeCloseTo(reste, 5);
      expect(orbs.count).toBe(0);
    }

    expect(frappe(horde, orbs, targetId, 400)).toEqual([targetId]);
    expect(horde.count).toBe(0);
    expect(orbs.count).toBe(1);
  });

  it('un ennemi leger meurt au premier impact — et il PORTE la borne <= 0, pas < 0', () => {
    // La contrepartie de la porte du §3.3 : `LIGHT_HP` vaut les degats de la
    // dague, donc rien ne change pour la pietaille legere — son armure est
    // NULLE, et zero est une entree de la table, pas un cas particulier.
    //
    // ⚠️ **C'est donc lui, et lui seul, qui met en scene le reste EXACTEMENT
    // nul.** Le test qui portait cette borne le faisait sur un lourd frappe
    // pour `HEAVY_HP` pile ; depuis l'armure, ce coup ne retire plus que
    // 17 PV et ne prouve plus rien. Le refaire tomber pile demanderait
    // `HEAVY_HP / (1 - HEAVY_ARMOR)`, dont le produit par 0,85 ne revient a 20
    // qu'a la representation flottante pres : le test aurait eu l'air de
    // mettre en scene la borne sans garantir de l'atteindre. Un seul garde,
    // ici, ou il est exact.
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0, LEGER);
    const orbs = new OrbField(10);
    expect(ARCHETYPES[LEGER]?.armor).toBe(0);
    expect(SINGLE.damage).toBe(LIGHT_HP); // le reste est exactement zero

    expect(frappe(horde, orbs, targetId, 0)).toEqual([targetId]);
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

    for (let coup = 1; coup <= 4; coup++) {
      frappe(horde, orbs, premier, coup * 40);
    }
    // Quatre coups de 4,25 : il reste 3 PV. Ecrit en clair, voir le test du
    // rythme de mise a mort plus haut.
    expect(horde.hp[horde.slotOf(premier)]).toBeCloseTo(3, 5);
    // Le second n'a rien pris.
    const survivant = horde.entityIdAt(horde.slotOf(premier) === 0 ? 1 : 0);
    expect(horde.hp[horde.slotOf(survivant)]).toBe(HEAVY_HP);

    expect(frappe(horde, orbs, premier, 400)).toEqual([premier]);
    // Et apres compaction, le survivant garde SES PV, pas ceux du mort.
    expect(horde.count).toBe(1);
    expect(horde.hp[0]).toBe(HEAVY_HP);
  });
});

/**
 * Les armes de zone (etape 6a, tache 16) — *« les ennemis sont trop nombreux
 * par rapport aux degats des armes, il faut parfois des AoE sur certaines
 * armes comme les grenades »*.
 *
 * ⚠️ **Le decor est celui qui SEPARE les deux bornes.** Un voisin juste dedans
 * ET un voisin juste dehors, dans la MEME execution : avec le seul premier,
 * « le rayon est infini » passerait ; avec le seul second, « le rayon est nul »
 * passerait aussi.
 *
 * ⚠️ **Les voisins sont perpendiculaires a la trajectoire**, jamais sur elle :
 * `Projectiles.collide` retient l'entite la plus proche du SEGMENT parcouru, et
 * un voisin place entre le tireur et la cible serait percute a sa place — le
 * test mesurerait alors le choix de cible, pas l'explosion. Le rayon de zone
 * (70) depasse `PROJECTILE_HIT_RADIUS` (32), donc les voisins restent hors de
 * portee du percuteur tout en etant dans celle du souffle.
 */
describe('les armes a effet de zone (etape 6a, tache 16)', () => {
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;
  /** Rayon de souffle de l'arme de test. Choisi > PROJECTILE_HIT_RADIUS, voir ci-dessus. */
  const SOUFFLE = 70;
  const ZONE: Weapon = { ...SINGLE, blastRadius: SOUFFLE };

  /** Le percuteur, un voisin JUSTE dans le rayon, un voisin JUSTE dehors. */
  function decor(horde: Horde): { percute: number; dedans: number; dehors: number } {
    const percute = addOne(horde, 1, 300, 0, LOURD);
    const dedans = addOne(horde, 2, 300, SOUFFLE - 1, LOURD);
    const dehors = addOne(horde, 3, 300, SOUFFLE, LOURD);
    return { percute, dedans, dehors };
  }

  /** Tire `arme` depuis l'origine sur `cible` et avance jusqu'a l'impact. */
  function tire(horde: Horde, orbs: OrbField, cible: number, arme: Weapon): number[] {
    const zones = solNu();
    const projectiles = new Projectiles(10);
    projectiles.fireSalvo(arme, 0, 0, 0, cible, horde);
    expect(projectiles.count).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) {
      const morts = resolveProjectileDamage(projectiles, DT, horde, orbs, i, zones);
      if (projectiles.count === 0) {
        return morts;
      }
    }
    throw new Error('le projectile ne touche jamais');
  }

  it('un seul impact tue le percute ET son voisin dans le rayon, jamais celui du bord', () => {
    // Degats largement au-dessus de la reserve, ARMURE COMPRISE : un coup
    // suffit, donc la mort dit le rayon et rien d'autre. `HEAVY_HP` tout court
    // ne suffirait plus (l'armure en retire 15 %), et un decor qui ne tue plus
    // ferait echouer ce test pour une raison qui n'est pas la sienne.
    const fatale: Weapon = { ...ZONE, damage: 2 * HEAVY_HP };
    const horde = new Horde(10);
    const { percute, dedans, dehors } = decor(horde);
    const orbs = new OrbField(10);

    const morts = tire(horde, orbs, percute, fatale);

    expect([...morts].sort((a, b) => a - b)).toEqual([percute, dedans].sort((a, b) => a - b));
    // Le bord : la borne est STRICTE, comme partout dans ce fichier.
    expect(horde.slotOf(dehors)).toBeGreaterThanOrEqual(0);
    expect(horde.hp[horde.slotOf(dehors)]).toBe(HEAVY_HP);
  });

  it('le percute ne prend pas les degats DEUX FOIS : il est dans son propre souffle', () => {
    // ⚠️ **La moitie qui manquerait sans ce test.** Retirer `damage` au
    // percute PUIS balayer le rayon lui infligerait le double du reste de la
    // horde — invisible tant qu'un seul coup tue, et faux des que la reserve
    // resiste. Degats volontairement insuffisants pour tuer.
    const horde = new Horde(10);
    const { percute, dedans, dehors } = decor(horde);
    const orbs = new OrbField(10);

    expect(tire(horde, orbs, percute, ZONE)).toEqual([]);

    expect(horde.hp[horde.slotOf(percute)]).toBeCloseTo(HEAVY_HP - coupSurLourd(ZONE.damage), 5);
    // Le voisin a pris EXACTEMENT autant : une seule source de degats.
    expect(horde.hp[horde.slotOf(dedans)]).toBeCloseTo(HEAVY_HP - coupSurLourd(ZONE.damage), 5);
    expect(horde.hp[horde.slotOf(dehors)]).toBe(HEAVY_HP);
  });

  it('une arme SANS rayon ne touche que ce qu elle percute — le meme decor, zero souffle', () => {
    // ⚠️ **La non-vacuite du decor.** Sans ce cas, un `damageInRadius` cable
    // sur toutes les armes passerait les deux tests ci-dessus : ils ne
    // regardent que ce que fait une arme de zone.
    const horde = new Horde(10);
    const { percute, dedans, dehors } = decor(horde);
    const orbs = new OrbField(10);

    expect(SINGLE.blastRadius).toBe(0);
    expect(tire(horde, orbs, percute, SINGLE)).toEqual([]);

    expect(horde.hp[horde.slotOf(percute)]).toBeCloseTo(HEAVY_HP - coupSurLourd(SINGLE.damage), 5);
    expect(horde.hp[horde.slotOf(dedans)]).toBe(HEAVY_HP);
    expect(horde.hp[horde.slotOf(dehors)]).toBe(HEAVY_HP);
  });

  it('l explosion MARQUE le seul percute, jamais le rayon qu elle emporte', () => {
    // Le choix documente par `resolveProjectileDamage` : poser l'element sur
    // tout le rayon ferait de chaque grenade un declencheur de masse, que la
    // borne « une reaction par ennemi et par tick » ne bornerait pas.
    const braise: Weapon = { ...ZONE, element: ELEMENT.BRAISE };
    const horde = new Horde(10);
    const { percute, dedans } = decor(horde);
    const orbs = new OrbField(10);
    const reactions = new Reactions();

    const projectiles = new Projectiles(10);
    projectiles.fireSalvo(braise, 0, 0, 0, percute, horde);
    let impact = -1;
    for (let i = 0; i < 40; i++) {
      resolveProjectileDamage(projectiles, DT, horde, orbs, i, solNu(), reactions);
      if (projectiles.count === 0) {
        impact = i;
        break;
      }
    }
    expect(impact).toBeGreaterThanOrEqual(0);

    // Le percute survit (degats insuffisants), donc il porte la marque.
    expect(horde.markAt(horde.slotOf(percute), impact)).toBe(ELEMENT.BRAISE);
    // Le voisin a pris le souffle, mais rien ne l a marque.
    expect(horde.hp[horde.slotOf(dedans)]).toBeCloseTo(HEAVY_HP - coupSurLourd(braise.damage), 5);
    expect(horde.markAt(horde.slotOf(dedans), impact)).toBe(ELEMENT.NEUTRE);
  });

  it('les morts du souffle laissent leur orbe comme n importe quelle mort', () => {
    // §12 de la spec de l'etape 5a : aucune facon de mourir ne prive l equipe
    // de son experience. Les identites sont choisies pour que `dropsOrb` les
    // accepte toutes les deux.
    const fatale: Weapon = { ...ZONE, damage: 2 * HEAVY_HP };
    const horde = new Horde(10);
    const percute = addOne(horde, ORB_DROP_ONE_IN, 300, 0, LOURD);
    const dedans = addOne(horde, 2 * ORB_DROP_ONE_IN, 300, SOUFFLE - 1, LOURD);
    expect(dropsOrb(percute)).toBe(true);
    expect(dropsOrb(dedans)).toBe(true);
    const orbs = new OrbField(10);

    expect(tire(horde, orbs, percute, fatale).length).toBe(2);
    expect(orbs.count).toBe(2);
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

describe('resolveChargeHit — la charge du boss (etape 6a, tache 5 bis)', () => {
  const BOSS_X = 1000;
  const BOSS_Y = 1000;

  /** Un boss en (1000, 1000) et la charge vers l'est qu'il vient d'annoncer. */
  function scene(): { horde: Horde; charge: BossCharge; id: number } {
    const horde = new Horde(10);
    const id = addOne(horde, 1, BOSS_X, BOSS_Y);
    return { horde, charge: makeBossCharge(id, BOSS_X, BOSS_Y, 5000, BOSS_Y, 0), id };
  }

  /** Un joueur avec une identite, ce que la borne « une fois par charge » exige. */
  function cible(x: number, y: number, id = 1, hp = 100): ChargeTarget {
    return { id, x, y, hp, contactInvulnTicks: 0 };
  }

  /**
   * ⚠️ **RIEN NE FAIT MAL PENDANT LE CHARGEMENT.** C'est ce qui rend le
   * telegraphe sur : le joueur a tout le chargement pour sortir du couloir.
   * Le test balaie TOUS les ticks du chargement, pas seulement le premier —
   * une borne posee un tick trop tot ne se verrait pas autrement.
   */
  it('ne fait mal a aucun tick du chargement, joueur pourtant colle au boss', () => {
    const { horde, charge } = scene();
    const p = cible(BOSS_X, BOSS_Y);

    for (let t = charge.windupTick; t <= charge.startTick; t++) {
      expect(resolveChargeHit([p], horde, charge, t, new Set()), `tick ${t}`).toEqual([]);
    }
    expect(p.hp).toBe(100);
  });

  it('endommage le joueur que le corps en mouvement traverse', () => {
    const { horde, charge } = scene();
    // A mi-parcours : le boss est a la moitie du couloir, le joueur y est.
    const t = charge.startTick + BOSS_CHARGE_TICKS / 2;
    const out = new Float32Array(2);
    chargePointAt(charge, t, out);
    const p = cible(out[0] ?? 0, out[1] ?? 0);
    // La horde doit porter la position du tick : c'est elle qui fait foi.
    horde.x[0] = out[0] ?? 0;
    horde.y[0] = out[1] ?? 0;

    expect(resolveChargeHit([p], horde, charge, t, new Set())).toEqual([p.id]);
    expect(p.hp).toBe(100 - BOSS_CHARGE_DAMAGE);
  });

  /**
   * ⚠️ **Une fois par charge, pas une fois par tick.** Sans cette borne, un
   * joueur immobile encaisserait dix-huit fois les degats de la charge — de quoi
   * le tuer plusieurs fois. C'est `Room` qui tient l'ensemble ; ici on verifie
   * que la fonction le respecte.
   */
  it('ne touche jamais deux fois le meme joueur pour une meme charge', () => {
    const { horde, charge } = scene();
    const p = cible(BOSS_X, BOSS_Y);
    const deja = new Set<number>();

    for (let t = charge.startTick + 1; t <= charge.endTick; t++) {
      // Le corps reste sur le joueur : sans la borne, chaque tick ferait mal.
      horde.x[0] = p.x;
      horde.y[0] = p.y;
      for (const id of resolveChargeHit([p], horde, charge, t, deja)) {
        deja.add(id);
      }
    }

    expect(p.hp).toBe(100 - BOSS_CHARGE_DAMAGE);
    expect([...deja]).toEqual([p.id]);
  });

  it('ne touche pas un joueur hors du corps, meme dans l axe du couloir', () => {
    const { horde, charge } = scene();
    // Juste au-dela du demi-corps, perpendiculairement au couloir : c'est
    // exactement l'esquive que le chargement rend possible.
    const p = cible(BOSS_X, BOSS_Y + charge.width / 2 + 1);

    expect(resolveChargeHit([p], horde, charge, charge.startTick + 1, new Set())).toEqual([]);
    expect(p.hp).toBe(100);
  });

  it('touche a l interieur du corps, juste en deca de la meme frontiere', () => {
    // La moitie haute du couple : sans elle, un rayon nul passerait le test
    // precedent sans que la charge ne touche jamais personne.
    const { horde, charge } = scene();
    const p = cible(BOSS_X, BOSS_Y + charge.width / 2 - 1);

    expect(resolveChargeHit([p], horde, charge, charge.startTick + 1, new Set())).toEqual([p.id]);
  });

  it('rearme l invulnerabilite de contact, pour que le corps ne repique pas au tick suivant', () => {
    const { horde, charge } = scene();
    const p = cible(BOSS_X, BOSS_Y);

    resolveChargeHit([p], horde, charge, charge.startTick + 1, new Set());

    expect(p.contactInvulnTicks).toBe(CONTACT_INTERVAL_TICKS);
  });

  it('ignore un joueur deja mort', () => {
    const { horde, charge } = scene();
    const p = cible(BOSS_X, BOSS_Y, 1, 0);

    expect(resolveChargeHit([p], horde, charge, charge.startTick + 1, new Set())).toEqual([]);
    expect(p.hp).toBe(0);
  });

  it('ne fait jamais descendre les pv sous zero', () => {
    const { horde, charge } = scene();
    const p = cible(BOSS_X, BOSS_Y, 1, BOSS_CHARGE_DAMAGE - 3);

    resolveChargeHit([p], horde, charge, charge.startTick + 1, new Set());

    expect(p.hp).toBe(0);
  });

  /**
   * ⚠️ **Une seule source de verite pour « le boss est-il encore la ».** S'il
   * meurt en pleine charge, il quitte la horde — et la charge cesse de blesser
   * au meme tick que celui ou elle cesse de le deplacer.
   */
  it('ne fait plus mal quand le boss a quitte la horde', () => {
    const { horde, charge, id } = scene();
    const p = cible(BOSS_X, BOSS_Y);
    horde.kill([id]);

    expect(resolveChargeHit([p], horde, charge, charge.startTick + 1, new Set())).toEqual([]);
    expect(p.hp).toBe(100);
  });
});

/**
 * Etape 5a, tache 17 : *« moins d'xp qui tombe »*. Le levier est le NOMBRE
 * d'objets au sol, et la garde vit au goulot — `spawn` — parce que trois
 * chemins de mort y menent (projectiles, brulures, reactions) et que l'etape
 * 5a vient d'en ajouter deux.
 */
describe('OrbField.spawn — toutes les morts ne laissent pas un orbe', () => {
  it('ne retient que ce que leavesDrop accepte, sur des index consecutifs d une meme vague', () => {
    // ⚠️ **64 morts, pas 40** : depuis la tache 14 de l'etape 6a la reserve
    // tient aussi les PIECES, et `COIN_DROP_ONE_IN` vaut quatre fois
    // `ORB_DROP_ONE_IN` — un lot trop court n'en contiendrait aucune et la
    // tache serait invisible ici.
    const MORTS = 64;
    const orbs = new OrbField(MORTS);
    const ids: number[] = [];
    for (let i = 0; i < MORTS; i++) {
      const id = entityIdOf(9, i);
      ids.push(id);
      orbs.spawn(id, 100 + i, 200);
    }

    expect(orbs.count).toBe(ids.filter((id) => leavesDrop(id)).length);
    // Les deux moities : des orbes ET des pieces, et jamais les deux sur le
    // meme cadavre.
    expect(ids.filter((id) => dropsOrb(id))).toHaveLength(MORTS / ORB_DROP_ONE_IN);
    expect(ids.filter((id) => dropsCoin(id))).toHaveLength(MORTS / COIN_DROP_ONE_IN);
    expect(ids.filter((id) => dropsOrb(id) && dropsCoin(id))).toHaveLength(0);
  });

  /**
   * ⚠️ **Le COMPTE ne suffit pas** : un filtre qui garderait les
   * `MORTS / ORB_DROP_ONE_IN` PREMIERES morts le satisferait aussi, et le
   * client — qui applique le meme predicat sur les memes identites — ne
   * retiendrait pas les memes. Ce sont les identites RETENUES qui doivent
   * coincider avec `dropsOrb`, sans quoi les deux cotes du fil divergent.
   */
  it('baisser le taux de chute ne change PAS le rythme de progression', () => {
    // ⚠️ **L'invariant de la tache 17, et rien ne le gardait.** L'auteur voulait
    // « moins d'xp qui tombe », pas « monter de niveau moins vite » — ce sont
    // deux choses, et une seule est demandee.
    //
    // C'est pour ca que `XP_PER_ORB` est DERIVEE de `ORB_DROP_ONE_IN` : une
    // mort sur quatre laisse une orbe, chaque orbe vaut quatre. L'experience
    // par mort reste donc de 1, exactement comme avant la tache, et le test
    // « le niveau 2 est atteignable » de l'etape 3 continue de mesurer la meme
    // chose.
    //
    // Verifie par mutation : decoupler les deux constantes laissait 528 tests
    // verts, et la progression aurait ete divisee par quatre en silence.
    const MORTS = 4000;
    let gagnee = 0;
    for (let id = 0; id < MORTS; id++) {
      if (dropsOrb(id)) {
        gagnee += XP_PER_ORB;
      }
    }
    expect(gagnee).toBe(MORTS);

    // Et l'autre moitie : il tombe bien QUATRE FOIS MOINS d'objets au sol.
    // Sans elle, ne rien changer du tout passerait aussi.
    let orbes = 0;
    for (let id = 0; id < MORTS; id++) {
      if (dropsOrb(id)) {
        orbes++;
      }
    }
    expect(orbes).toBe(MORTS / ORB_DROP_ONE_IN);
  });

  it('retient exactement les identites que leavesDrop accepte, position comprise', () => {
    const MORTS = 64;
    const orbs = new OrbField(MORTS);
    const attendues: number[] = [];
    for (let i = 0; i < MORTS; i++) {
      const id = entityIdOf(9, i);
      orbs.spawn(id, 100 + i, 200);
      if (leavesDrop(id)) {
        attendues.push(id);
      }
    }

    expect([...orbs.id.slice(0, orbs.count)]).toEqual(attendues);
    // Et la position suit bien l'identite retenue, pas le rang du creneau :
    // chaque objet pose est a l'abscisse de l'index dont il vient.
    //
    // ⚠️ **DERIVEE de la liste retenue, pas ecrite.** Un `100 + ORB_DROP_ONE_IN`
    // en dur decrivait le monde d'avant la tache 14 : le deuxieme objet du sol
    // est desormais la PIECE de l'index `COIN_DROP_RESIDUE`, pas l'orbe de
    // l'index 4.
    const premier = entityIdOf(9, 0);
    for (const [slot, id] of attendues.entries()) {
      expect(orbs.x[slot], `creneau ${slot}`).toBe(100 + (id - premier));
    }
  });

  /**
   * L'autre moitie, vue depuis le vrai chemin de mort : le meme filtre
   * s'applique aux orbes que `resolveProjectileDamage` fait apparaitre, et pas
   * seulement a un appel direct de `spawn`.
   */
  it('s applique au chemin reel : cinq morts par projectile, un seul orbe au sol', () => {
    const horde = new Horde(50);
    const orbs = new OrbField(50);
    const projectiles = new Projectiles(50);

    // Cinq index CONSECUTIFS d'une meme vague — pas cinq vagues d'un monstre,
    // qui tomberaient toutes sur l'index 0 et laisseraient donc toutes un orbe
    // (voir « le decor qui masque », `shared/horde.test.ts`).
    const targets = addWave(horde, 12, 5, 50);
    for (const [i, targetId] of targets.entries()) {
      projectiles.fireSalvo(SINGLE, 0, 50 * (i + 1), -20, targetId, horde);
    }

    let allDead: number[] = [];
    for (let tick = 0; tick < 5; tick++) {
      allDead = allDead.concat(
        resolveProjectileDamage(projectiles, DT, horde, orbs, tick, solNu()),
      );
    }

    expect(allDead.length).toBe(5);
    expect(orbs.count).toBe(targets.filter((id) => leavesDrop(id)).length);
    // Non-vacuite des deux cotes : le filtre laisse passer quelque chose, et
    // il ne laisse pas tout passer.
    expect(orbs.count).toBeGreaterThan(0);
    expect(orbs.count).toBeLessThan(targets.length);
  });
});

describe('OrbField.resolvePickups', () => {
  /**
   * Une identite dont la mort laisse VRAIMENT un orbe.
   *
   * ⚠️ **`1` et `2` n'en laissent plus depuis la tache 17** : `spawn` filtre
   * par `dropsOrb`, et un decor qui pose des identites choisies au hasard
   * mesurerait le taux de chute au lieu du ramassage. Derivee de la constante,
   * jamais recopiee — un `4` en dur ici cesserait de suivre `ORB_DROP_ONE_IN`
   * a son premier reglage.
   */
  const avecOrbe = (n: number): number => n * ORB_DROP_ONE_IN;

  it('ramasse un orbe a portee et laisse un orbe hors de portee intact', () => {
    const orbs = new OrbField(10);
    orbs.spawn(avecOrbe(1), 100, 100);
    // Assez loin pour etre hors d'ORB_PICKUP_RADIUS, sans etre absurde.
    orbs.spawn(avecOrbe(2), 5000, 5000);

    const picked = orbs.resolvePickups([{ x: 100, y: 100 }]);

    expect(picked).toEqual([avecOrbe(1)]);
    expect(orbs.count).toBe(1);
    expect(orbs.id[0]).toBe(avecOrbe(2));
  });

  it('un orbe que personne ne ramasse ATTEND : rien ne le retire, jamais (tache 15)', () => {
    // ⚠️ **Le retour de jeu, en un test** : *« l'xp ne doit pas disparaitre »*.
    // Ce test verifiait l'inverse — un orbe retire au bout de
    // `ORB_LIFETIME_TICKS` — et la constante n'existe plus.
    //
    // ⚠️ **Aucune duree a deriver, et c'est la propriete testee** : ce qui est
    // garde ici est une ABSENCE d'echeance. Le seul nombre qui reste est donc
    // la duree qu'on accepte d'attendre, prise cinq fois plus longue que
    // l'ancienne (600 ticks) pour qu'un rallongement deguise en suppression ne
    // puisse pas s'y cacher.
    const TRES_LONGTEMPS = 3000;
    const orbs = new OrbField(10);
    orbs.spawn(avecOrbe(1), 100, 100);
    expect(orbs.count).toBe(1);

    // Personne a proximite, des milliers de ticks durant : le ramassage est
    // desormais la SEULE sortie.
    for (let tick = 0; tick < TRES_LONGTEMPS; tick++) {
      expect(orbs.resolvePickups([{ x: -9000, y: -9000 }])).toEqual([]);
    }
    expect(orbs.count).toBe(1);

    // Et il est toujours ramassable au bout du compte : un orbe « garde » mais
    // devenu inerte satisferait tout ce qui precede.
    expect(orbs.resolvePickups([{ x: 100, y: 100 }])).toEqual([avecOrbe(1)]);
    expect(orbs.count).toBe(0);
  });

  it('la capacite pleine refuse en SILENCE, et le compte (truncatedOrbs)', () => {
    // ⚠️ **La capacite est devenue la seule borne de la reserve** (tache 15) :
    // sans compteur, l'experience refusee au sol disparaitrait sans trace —
    // meme role que `Projectiles.truncatedProjectiles` et
    // `ZoneField.truncatedZones`.
    const PLACES = 3;
    const orbs = new OrbField(PLACES);
    // `dropsOrb` n'en retient qu'une sur `ORB_DROP_ONE_IN` : on ne presente
    // donc QUE des identites qui en demandent une, sinon le refus mesure
    // serait celui du taux de chute, pas celui du plafond.
    const REFUSES = 5;
    for (let i = 0; i < PLACES + REFUSES; i++) {
      orbs.spawn(avecOrbe(i + 1), 100 + i, 200);
    }

    expect(orbs.count).toBe(PLACES);
    expect(orbs.truncatedOrbs).toBe(REFUSES);

    // ⚠️ **Et une mort SANS orbe n'est pas une troncature.** Sans cette
    // moitie, un compteur incremente a chaque refus de `dropsOrb` passerait :
    // il monterait tout le temps et ne dirait plus rien du plafond.
    const large = new OrbField(100);
    const ids: number[] = [];
    for (let i = 0; i < 64; i++) {
      const id = entityIdOf(9, i);
      ids.push(id);
      large.spawn(id, 0, 0);
    }
    expect(large.count).toBe(ids.filter((id) => leavesDrop(id)).length);
    expect(large.truncatedOrbs).toBe(0);
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
      const dead = resolveProjectileDamage(projectiles, DT, horde, orbs, tick, solNu());
      allDead = allDead.concat(dead);
    }

    expect(allDead.length).toBe(5);
    expect(new Set(allDead).size).toBe(5); // toutes distinctes
    expect(orbs.count).toBe(5);

    // Orbes a x = 50,100,150,200,250 ; un joueur en (150,0), rayon 90 :
    // atteint 100, 150 et 200 (distances 50, 0, 50) mais pas 50 ni 250
    // (distances 100) — trois ramasses sur cinq, ni zero ni tous.
    const picked = orbs.resolvePickups([{ x: 150, y: 0 }]);
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
    by = 0,
  ): { morts: number[]; impactTick: number } {
    const projectiles = new Projectiles(10);
    const dx = horde.x[horde.slotOf(targetId)] ?? 0;
    const dy = horde.y[horde.slotOf(targetId)] ?? 0;
    projectiles.fireSalvoDirected(arme, tick, 0, 0, dx, dy, arme.damage, 1, by);
    for (let i = 0; i < 20; i++) {
      const morts = resolveProjectileDamage(projectiles, DT, horde, orbs, tick + i, solNu());
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

    const { morts, impactTick } = frappe(horde, orbs, targetId, 7, BRAISE, 3);
    expect(morts).toEqual([]);
    const slot = horde.slotOf(targetId);
    expect(horde.markAt(slot, impactTick)).toBe(ELEMENT.BRAISE);
    expect(horde.markBy[slot]).toBe(3);
  });

  it('une arme neutre ne marque rien', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0, LOURD);
    const orbs = new OrbField(10);

    frappe(horde, orbs, targetId, 0, SINGLE, 3);
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

    const { morts, impactTick } = frappe(horde, orbs, victime, 11, BRAISE, 3);
    expect(morts).toEqual([victime]);

    expect(horde.count).toBe(1);
    const slot = horde.slotOf(voisin);
    expect(slot).toBe(0);
    expect(horde.markAt(slot, impactTick)).toBe(ELEMENT.NEUTRE);
    expect(horde.markBy[slot]).toBe(0);
  });

  it('⚠️ NE POSE AUCUNE ZONE — ni a l impact, ni a l expiration (tache 21)', () => {
    // ⚠️ **La non-regression de la tache 21, et elle porte les DEUX fins de
    // course.** `postZone` etait appele aux deux — l'impact dans `collide`, la
    // vieillesse par le rappel `onExpire` de `Projectiles.step` — et n'en
    // retirer qu'une laisserait la moitie du modele en place, invisible au
    // type comme au lint. Le decor met donc les deux en scene dans le meme
    // test : un projectile qui touche, un projectile qui vieillit.
    //
    // Le champ de zones est passe a `markInZones` a la fin : il est LE meme
    // objet, donc s'il s'etait rempli au passage on le verrait.
    const horde = new Horde(10);
    // Position non entiere : c'etait elle qui rendait l'arrondi de `postZone`
    // observable. Gardee pour que le test echoue si la pose revenait, arrondie
    // ou non.
    const cible = addOne(horde, 1, 100.4, 0.4, LOURD);
    const orbs = new OrbField(10);
    const zones = new ZoneField();

    // 1. l'impact.
    const { morts, impactTick } = frappe(horde, orbs, cible, 5, BRAISE, 2);
    expect(morts).toEqual([]);
    // Le decor n'est pas creux : le projectile a bien touche, et il a MARQUE.
    expect(impactTick).toBeGreaterThan(5);
    expect(horde.markAt(horde.slotOf(cible), impactTick)).toBe(ELEMENT.BRAISE);

    // 2. la vieillesse : plus rien a toucher, le projectile finit sa course.
    const projectiles = new Projectiles(10);
    projectiles.fireSalvoDirected(BRAISE, 0, 5000, 5000, 1, 0, BRAISE.damage, 1, 1);
    for (let t = 0; t <= BRAISE.projectileLifeTicks; t++) {
      resolveProjectileDamage(projectiles, DT, new Horde(1), orbs, t, zones);
    }
    expect(projectiles.count).toBe(0);

    // Aucune zone, et aucune troncature non plus — une pose refusee faute de
    // place compterait ici, et « zero zone » se lirait « reserve pleine ».
    expect(zones.count).toBe(0);
    expect(zones.truncatedZones).toBe(0);
  });
});

describe('la reaction laisse un champ au sol (etape 5a, tache 21)', () => {
  /**
   * Un declencheur qui vient d'une MARQUE de `marque` posee par `markBy`, et
   * d'un SECOND element `declencheur` applique par `by`.
   *
   * ⚠️ Les deux elements sont distincts dans le decor, et les deux joueurs
   * aussi : c'est ce qui rend observable lequel des quatre champs le sol
   * herite. Un declencheur ou marque et declencheur seraient le meme element
   * ne pourrait pas separer les deux regles.
   */
  function trigger(
    x: number,
    y: number,
    marque = ELEMENT.BRAISE,
    declencheur = ELEMENT.GIVRE,
    markBy = 1,
    by = 2,
  ): ReactionTrigger {
    return {
      pair: packElementPair(marque, declencheur),
      x,
      y,
      markBy,
      by,
      element: declencheur,
    };
  }

  it('pose UN champ au point d application, arrondi comme sur le fil', () => {
    // Coordonnees non entieres : c'est ce qui rend l'arrondi observable. Le
    // message `ZONE` ne transporte que des `int16`, et le serveur s'impose
    // l'arrondi qu'il inflige au client.
    const zones = new ZoneField();

    applyReactions(
      new Horde(1),
      new OrbField(1),
      9,
      [trigger(300.6, -12.6)],
      zones,
      new Reactions(),
    );

    expect(zones.count).toBe(1);
    expect(zones.x[0]).toBe(301);
    expect(zones.y[0]).toBe(-13);
    expect(zones.bornTick[0]).toBe(9);
  });

  it('⚠️ le champ porte l element qui DECLENCHE, et le joueur qui declenche', () => {
    // ⚠️ **Le choix de la tache 21, et c'est le seul qui ne degenere pas.**
    // Avec l'element de la MARQUE, le champ remarquerait l'ennemi de l'element
    // que la reaction vient de consommer : le meme tireur redeclencherait a
    // chaque volee, indefiniment, avec UNE SEULE arme. Avec l'element qui
    // declenche, le §6.2 quatrieme ligne s'applique — meme element, simple
    // rafraichissement — et il faut de nouveau l'autre element.
    //
    // Les deux elements ET les deux joueurs sont distincts : sans ca, « porte
    // le declencheur » se lirait aussi bien « porte la marque ».
    const zones = new ZoneField();

    applyReactions(
      new Horde(1),
      new OrbField(1),
      0,
      [trigger(0, 0, ELEMENT.BRAISE, ELEMENT.GIVRE, 1, 2)],
      zones,
      new Reactions(),
    );

    expect(zones.kind[0]).toBe(ELEMENT.GIVRE);
    expect(zones.by[0]).toBe(2);
  });

  it('deux reactions au meme endroit ne font qu un champ : la regle de fusion tient', () => {
    // §5.1 bis : le compte des zones est fonction de la SURFACE, jamais du
    // nombre de reactions. A moins d'un `ZONE_RADIUS`, la seconde rafraichit.
    const zones = new ZoneField();

    applyReactions(
      new Horde(1),
      new OrbField(1),
      0,
      [trigger(1000, 1000), trigger(1000 + ZONE_RADIUS - 1, 1000)],
      zones,
      new Reactions(),
    );

    expect(zones.count).toBe(1);
    // Et le decor n'est pas creux : un rayon de plus, et la seconde CREE.
    const espacees = new ZoneField();
    applyReactions(
      new Horde(1),
      new OrbField(1),
      0,
      [trigger(1000, 1000), trigger(1000 + ZONE_RADIUS + 1, 1000)],
      espacees,
      new Reactions(),
    );
    expect(espacees.count).toBe(2);
  });

  it('le champ pose declenche le couple avec une zone voisine d un AUTRE element', () => {
    // ⚠️ **Le troisieme declencheur du §6.2 reste atteignable, et c'est par ce
    // chemin-la qu'il l'est desormais** : les zones ne naissant plus que d'une
    // reaction, deux zones ne peuvent se recouvrir que si DEUX reactions les
    // ont posees. Sans cet appel a `onZoneCreated`, `ZoneField.overlaps`
    // n'aurait plus aucun appelant de production.
    const zones = new ZoneField();
    const reactions = new Reactions();
    zones.spawn(ELEMENT.BRAISE, 1000, 1000, 5, 0);

    applyReactions(
      new Horde(1),
      new OrbField(1),
      0,
      [trigger(1000 + ZONE_RADIUS + 10, 1000, ELEMENT.BRAISE, ELEMENT.GIVRE, 1, 2)],
      zones,
      reactions,
    );

    expect(zones.count).toBe(2);
    // ⚠️ **Au tick SUIVANT, jamais celui-ci** : `Room.step` a deja draine ce
    // tick-la quand `applyReactions` tourne. Le declencheur attend le prochain
    // `drain`, ce qui est aussi ce qui empeche une chaine de tourner pendant
    // que la horde est balayee par creneau.
    const [suite, ...reste] = reactions.drain();
    expect(reste).toEqual([]);
    expect(suite?.pair).toBe(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE));
    expect(suite?.markBy).toBe(5);
    expect(suite?.by).toBe(2);
  });

  it('un champ RAFRAICHI ne declenche rien : seule une CREATION reagit', () => {
    // ⚠️ Sans la comparaison des comptes, deux reactions repetees au meme
    // endroit — le cas normal d'un amas qui reagit tick apres tick —
    // declencheraient une reaction de recouvrement a chaque fois.
    const zones = new ZoneField();
    const reactions = new Reactions();
    zones.spawn(ELEMENT.BRAISE, 1000, 1000, 5, 0);
    const declencheur = trigger(1000 + ZONE_RADIUS + 10, 1000);

    applyReactions(new Horde(1), new OrbField(1), 0, [declencheur], zones, reactions);
    expect(reactions.drain().length).toBe(1);

    // Meme point, meme element : `spawn` rafraichit, ne cree pas.
    applyReactions(new Horde(1), new OrbField(1), 1, [declencheur], zones, reactions);
    expect(zones.count).toBe(2);
    expect(reactions.drain()).toEqual([]);
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

  /**
   * ⚠️ **`markInZones` doit decoder `zones.kind`, pas le lire brut.** Une zone
   * qui porte deja un type de reaction empaquete (§5b, tache 5) doit marquer
   * l'ennemi avec l'ELEMENT seul — jamais l'octet complet, que `Horde.mark`
   * accepterait sans broncher (aucune validation la), mais que `elementOf`
   * refuserait plus tard (`resolveBurn`, la teinte). `kind !== element` ici :
   * un empaquetage a reaction nulle n'aurait rien distingue d'une lecture
   * brute.
   */
  it('marque avec l element DECODE, meme quand la zone porte un type de reaction empaquete', () => {
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000);
    const zones = new ZoneField();
    const kind = packZoneKind(ELEMENT.GIVRE, 6);
    expect(kind).not.toBe(ELEMENT.GIVRE);
    zones.spawn(kind, 1000, 1000, 4, 10);

    markInZones(horde, zones, 10, new Reactions());

    expect(horde.markAt(horde.slotOf(cible), 10)).toBe(ELEMENT.GIVRE);
  });
});

describe('resolveBurn — la Braise brule (etape 5a, tache 6)', () => {
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;
  const BRULURE = elementOf(ELEMENT.BRAISE).burnPerTick;
  // ⚠️ **Cinq decimales et plus six, depuis l'armure.** `Horde.hp` est un
  // `Float32Array` : 19,915 (20 - 0,1 x 0,85) s'y arrondit a 9,2e-7 pres, la ou
  // 19,9 tombait a 3,8e-7. C'est le format de stockage qui le dit, pas le
  // calcul — et cinq decimales separent encore largement une brulure amputee de
  // son armure d'une brulure qui ne le serait pas (0,085 contre 0,1).

  it('descend les PV du marque Braise, laisse le marque Givre intact', () => {
    const horde = new Horde(10);
    const brule = addOne(horde, 1, 0, 0, LOURD);
    const givre = addOne(horde, 2, 500, 500, LOURD);
    horde.applyMark(horde.slotOf(brule), ELEMENT.BRAISE, 1, 0);
    horde.applyMark(horde.slotOf(givre), ELEMENT.GIVRE, 1, 0);
    const orbs = new OrbField(10);

    expect(resolveBurn(horde, orbs, 0, solNu())).toEqual([]);

    expect(horde.hp[horde.slotOf(brule)]).toBeCloseTo(HEAVY_HP - coupSurLourd(BRULURE), 5);
    expect(horde.hp[horde.slotOf(givre)]).toBe(HEAVY_HP);
    expect(orbs.count).toBe(0);
  });

  it('ne brule plus une fois la marque expiree — l expiration est DERIVEE, jamais balayee', () => {
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 0, 0, LOURD);
    horde.applyMark(horde.slotOf(cible), ELEMENT.BRAISE, 1, 0);
    const orbs = new OrbField(10);

    resolveBurn(horde, orbs, MARK_DURATION_TICKS - 1, solNu());
    const apresDernier = horde.hp[horde.slotOf(cible)] ?? 0;
    expect(apresDernier).toBeCloseTo(HEAVY_HP - coupSurLourd(BRULURE), 5);

    resolveBurn(horde, orbs, MARK_DURATION_TICKS, solNu());
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

    expect(resolveBurn(horde, orbs, 0, solNu())).toEqual([cible]);
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

    expect(resolveBurn(horde, orbs, 0, solNu())).toEqual([mourante]);
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
      resolveProjectileDamage(projectiles, DT, horde, orbs, tick + i, solNu(), reactions);
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

  /**
   * ⚠️ **Le meme decor que ci-dessus, mais l octet BRUT differe alors que
   * l element decode ne differe pas** (tache 5 de l'etape 5b). `onZoneCreated`
   * doit comparer `zoneElement(...)` des deux cotes, jamais `zones.kind[...]`
   * brut : sinon deux zones de Braise portant deux types de reaction
   * empaquetes DIFFERENTS se verraient comme deux elements distincts, et
   * reagiraient l'une avec l'autre — exactement le defaut que le test
   * precedent existe pour interdire, ici cause par la reaction empaquetee au
   * lieu de l'element.
   */
  it('deux zones du MEME element mais de types de reaction empaquetes DIFFERENTS ne reagissent pas non plus', () => {
    const zones = new ZoneField();
    const premier = packZoneKind(ELEMENT.BRAISE, 2);
    const second = packZoneKind(ELEMENT.BRAISE, 9);
    expect(premier).not.toBe(second);

    zones.spawn(premier, 1000, 1000, 1, 0);
    const seconde = zones.spawn(second, 1000 + ZONE_RADIUS + 10, 1000, 2, 0);
    expect(zones.count).toBe(2);
    expect(zones.overlaps(0, seconde)).toBe(true);
    const reactions = new Reactions();

    reactions.onZoneCreated(zones, seconde, 0);

    expect(reactions.count).toBe(0);
  });

  /**
   * ⚠️ **La moitie qui prouve que le decodage tourne dans les DEUX sens.** La
   * zone deja la ET celle qui vient de naitre portent chacune un type de
   * reaction empaquete, distinct de zero : si `onZoneCreated` lisait l'octet
   * brut d'un seul cote, `pair` porterait un fragment d'octet de reaction au
   * lieu d'un element, et ne vaudrait plus `packElementPair(BRAISE, GIVRE)`.
   */
  it('deux zones d elements DIFFERENTS, chacune avec un type de reaction empaquete, reagissent avec le bon couple', () => {
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.BRAISE, 4), 1000, 1000, 1, 0);
    const seconde = zones.spawn(
      packZoneKind(ELEMENT.GIVRE, 11),
      1000 + ZONE_RADIUS + 10,
      1000,
      2,
      0,
    );
    const reactions = new Reactions();

    reactions.onZoneCreated(zones, seconde, 0);

    const [reaction, ...reste] = reactions.drain();
    expect(reste).toEqual([]);
    expect(reaction?.pair).toBe(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE));
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
  const LEGER = ARCHETYPES.find((a) => a.hp === LIGHT_HP)?.id ?? -1;

  function declencheur(x: number, y: number): ReactionTrigger {
    return {
      pair: packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE),
      x,
      y,
      markBy: 1,
      by: 2,
      element: ELEMENT.GIVRE,
    };
  }

  /**
   * Resout des declencheurs sans regarder le champ qu'ils laissent au sol.
   *
   * ⚠️ **Une reserve de zones NEUVE a chaque appel, jamais partagee.** Ce
   * `describe` ne parle que des degats ; les champs poses ont le leur (« la
   * reaction laisse un champ au sol »). Partager la reserve ferait dependre un
   * test de degats de la regle de fusion d'un autre.
   */
  function tue(horde: Horde, orbs: OrbField, tick: number, triggers: ReactionTrigger[]): number[] {
    return applyReactions(horde, orbs, tick, triggers, new ZoneField(), new Reactions());
  }

  it('tue dans le rayon, epargne juste dehors, et laisse un orbe a chaque mort', () => {
    // ⚠️ « Juste dehors » a un pixel du bord : une entite a 10 000 px
    // prouverait seulement que la boucle ne tue pas tout le monde.
    const horde = new Horde(10);
    const dedans = addOne(horde, 1, 1000 + REACTION_RADIUS - 1, 1000, LOURD);
    const dehors = addOne(horde, 2, 1000 + REACTION_RADIUS, 1000, LOURD);
    const orbs = new OrbField(10);

    const morts = tue(horde, orbs, 7, [declencheur(1000, 1000)]);

    expect(morts).toEqual([dedans]);
    expect(horde.slotOf(dedans)).toBe(-1);
    // Celui de dehors n'a rien pris du tout : sa reserve est intacte.
    expect(horde.hp[horde.slotOf(dehors)]).toBe(HEAVY_HP);
    // Un orbe, a la position de la mort — le §12 de la spec : une mort
    // elementaire ne prive pas l'equipe de son experience.
    expect(orbs.count).toBe(1);
    expect(orbs.id[0]).toBe(dedans);
    expect(orbs.x[0]).toBe(1000 + REACTION_RADIUS - 1);
  });

  it('des degats BRUTS et MASSIFS : la pietaille lourde tombe d un seul choc', () => {
    // `REACTION_DAMAGE` n'est jamais recopie : l'assertion porte sur la
    // relation que la constante doit tenir, pas sur son chiffre.
    //
    // ⚠️ **La relation a change a l'etape 5b, et la comparaison des deux
    // constantes NUES ne la dit plus.** Le Choc thermique passe par
    // `appliquerDegats` comme tout le reste, donc l'armure de la lourde le
    // rabote : c'est `REACTION_DAMAGE x (1 - HEAVY_ARMOR)` qu'il faut comparer
    // a `HEAVY_HP` (21,25 contre 20). `expect(REACTION_DAMAGE > HEAVY_HP)`
    // resterait vert avec une armure de 0,25, ou le choc ne tue plus rien.
    expect(REACTION_DAMAGE * (1 - HEAVY_ARMOR)).toBeGreaterThan(HEAVY_HP);
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LOURD);
    const morts = tue(horde, new OrbField(10), 0, [declencheur(1000, 1000)]);
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

    expect(tue(horde, new OrbField(10), 0, [declencheur(1000, 1000)])).toEqual([]);
    expect(horde.hp[horde.slotOf(cible)]).toBeCloseTo(1000 - coupSurLourd(REACTION_DAMAGE), 4);
  });

  it('une reserve qui tombe PILE a zero meurt : la borne est <= 0, pas < 0', () => {
    // Meme borne que `resolveProjectileDamage`, et elle se teste ici parce
    // qu'elle le peut : les degats de reaction sont ENTIERS, contrairement a
    // `burnPerTick` (0,1, non representable en `Float32`) dont la borne est
    // arithmetiquement intestable — voir `resolveBurn`.
    //
    // ⚠️ **Sur un LEGER, depuis l'etape 5b.** Un lourd rabote les degats de son
    // armure, et `REACTION_DAMAGE x 0,85` ne retombe sur une reserve entiere
    // qu'a la representation flottante pres : le reste ne serait plus
    // exactement nul, et le test aurait l'air de mettre en scene la borne sans
    // jamais l'atteindre. C'est l'armure NULLE du leger qui rend le zero exact.
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LEGER);
    expect(ARCHETYPES[LEGER]?.armor).toBe(0);
    horde.hp[horde.slotOf(cible)] = REACTION_DAMAGE;

    expect(tue(horde, new OrbField(10), 0, [declencheur(1000, 1000)])).toEqual([cible]);
  });

  it('l ennemi qui DECLENCHE est touche comme les autres : il est a distance nulle', () => {
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 500, 500, LOURD);
    expect(tue(horde, new OrbField(10), 0, [declencheur(500, 500)])).toEqual([cible]);
  });

  it('deux reactions qui achevent le meme ennemi ne le listent qu une fois', () => {
    // Meme garantie que le `Set` de `resolveProjectileDamage` : le §3.1 de la
    // spec de l'etape 3 suppose des identites uniques dans DEATHS, et
    // `Horde.kill` supprimerait l'entite VIVANTE deplacee dans le creneau.
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LOURD);
    const survivant = addOne(horde, 2, -5000, -5000, LOURD);

    const morts = tue(horde, new OrbField(10), 0, [
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
    expect(tue(horde, new OrbField(10), 0, [])).toEqual([]);
    expect(horde.hp[horde.slotOf(cible)]).toBe(HEAVY_HP);
  });

  it('tous les degats AVANT la compaction : la voisine d une victime n herite de rien', () => {
    // ⚠️ Tuer entre deux reactions deplacerait les entites dans les creneaux
    // liberes, et la seconde reaction frapperait des voisins choisis par
    // l'ordre du tableau plutot que par la geometrie.
    const horde = new Horde(10);
    const victime = addOne(horde, 1, 1000, 1000, LOURD);
    const loin = addOne(horde, 2, -5000, -5000, LOURD);
    const morts = tue(horde, new OrbField(10), 0, [
      declencheur(1000, 1000),
      declencheur(1000, 1000),
    ]);
    expect(morts).toEqual([victime]);
    // Le survivant a pris la place du mort dans le creneau 0, mais sa reserve
    // est celle qu'il avait : rien ne l'a touche.
    expect(horde.hp[horde.slotOf(loin)]).toBe(HEAVY_HP);
  });
});

/**
 * **Le chemin unique des degats** (etape 5b, tache 1) : `appliquerDegats` est
 * la seule fonction qui ecrive `horde.hp`, et les trois sites qui retiraient
 * des PV eux-memes y passent desormais.
 */
describe("l'armure et le chemin unique des degats (etape 5b, tache 1)", () => {
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;
  const LEGER = ARCHETYPES.find((a) => a.hp === LIGHT_HP)?.id ?? -1;

  it('reduit le coup de l armure de l ARCHETYPE, et le leger n en a pas', () => {
    const horde = new Horde(10);
    addOne(horde, 1, 0, 0, LOURD);
    addOne(horde, 2, 900, 900, LEGER);
    // ⚠️ **30 et 24 ne sont AUCUNE constante de production**, et c'est
    // delibere : une valeur de decor egale a une valeur de production rend la
    // tache inverifiable (`GEL_TICKS` valait `LEVEL_FREEZE_TICKS`, et 80 tests
    // passaient sur une derivation fausse). Le decor precedent de ce test
    // ecrivait `20` ici — qui EST `HEAVY_HP` par coincidence, meme si le
    // commentaire pretendait le contraire. Ca n'aveuglait pas le test (voir
    // l'assertion jumelle du leger, plus bas, qui tue la mutation a elle
    // seule), mais le commentaire enseignait l'inverse exact de ce que ce
    // depot traque : `24` leve la coincidence pour de bon.
    horde.hp[0] = 30;
    horde.hp[1] = 30;

    appliquerDegats(horde, 0, 24, solNu(), 0, new Set());
    appliquerDegats(horde, 1, 24, solNu(), 0, new Set());

    // 24 x (1 - 0,15) = 20,4 : il reste 9,6. Le nombre est ecrit en clair,
    // jamais derive de `HEAVY_ARMOR` — sinon l'assertion recopierait la
    // production et passerait quoi qu'elle fasse.
    expect(horde.hp[0]).toBeCloseTo(9.6, 5);
    // Le leger, lui, prend les 24 entiers : zero est une entree de la table.
    expect(horde.hp[1]).toBeCloseTo(6, 5);
  });

  it('une reduction fractionnaire n est arrondie nulle part', () => {
    // ⚠️ **C'est le test de R9**, l'arrondi qui a avale l'empilement des
    // passifs a l'etape 4 et amplifie l'echelle de palier a l'etape 6a.
    // `Horde.hp` est un `Float32Array` et la combustion y retire deja 0,1 par
    // tick : rien n'impose un entier. Un `Math.round` glisse n'importe ou sur
    // le chemin fait rougir cette ligne.
    //
    // 7 x (1 - 0,15) = 5,95, et 30 - 5,95 = 24,05. Ni le coup ni le reste ne
    // sont entiers, donc un arrondi de l'un OU de l'autre se voit.
    const horde = new Horde(10);
    addOne(horde, 1, 0, 0, LOURD);
    horde.hp[0] = 30;

    appliquerDegats(horde, 0, 7, solNu(), 0, new Set());

    expect(horde.hp[0]).toBeCloseTo(24.05, 4);
    expect(Number.isInteger(horde.hp[0])).toBe(false);
  });

  it('une armure totale ne rend pas un ennemi immortel', () => {
    // Plancher : un coup retire toujours quelque chose.
    //
    // ⚠️ **La borne vit dans la TABLE (`capArmor`, `MAX_ARMOR`), pas ici.** Une
    // valeur aberrante n'arrive donc jamais jusqu'a cette fonction, et
    // `archetypes.test.ts` garde `capArmor` en lui en donnant une. Ce qui se
    // verifie ICI, c'est la consequence en jeu : le plus blinde du bestiaire
    // perd des PV a chaque coup, et il en perd ce que la table annonce.
    const plusBlinde = [...ARCHETYPES].sort((a, b) => b.armor - a.armor)[0];
    expect(plusBlinde?.id).toBe(BOSS_ARCHETYPE);
    expect(plusBlinde?.armor).toBe(BOSS_ARMOR);
    expect(MAX_ARMOR).toBeLessThan(1);

    const horde = new Horde(10);
    addOne(horde, 1, 0, 0, BOSS_ARCHETYPE);
    horde.hp[0] = 100;

    appliquerDegats(horde, 0, 10, solNu(), 0, new Set());

    // 10 x (1 - 0,4) = 6.
    expect(horde.hp[0]).toBeCloseTo(94, 5);
    // Et la phrase que le point de revue n° 3 demandait, dite telle quelle.
    expect(horde.hp[0] ?? 0).toBeLessThan(100);
  });

  it('note l identite dans un `Set` comme dans un tableau', () => {
    // Les deux formes sont deliberees : les chemins de projectile
    // dedoublonnent, la combustion balaie chaque creneau une fois. Un seul
    // `if` les separe, et sans ce test la branche tableau ne serait exercee
    // que par `resolveBurn`, dont les brulures tuent rarement.
    const horde = new Horde(10);
    const id = addOne(horde, 1, 0, 0, LEGER);
    horde.hp[0] = 1;
    const enSet = new Set<number>();
    appliquerDegats(horde, 0, 100, solNu(), 0, enSet);
    expect([...enSet]).toEqual([id]);

    const horde2 = new Horde(10);
    const id2 = addOne(horde2, 1, 0, 0, LEGER);
    horde2.hp[0] = 1;
    const enTableau: number[] = [];
    appliquerDegats(horde2, 0, 100, solNu(), 0, enTableau);
    expect(enTableau).toEqual([id2]);
  });

  /**
   * **Les trois sites, un test chacun.** Chaque test remet une mutation en
   * echec : « ce site-la retire les PV lui-meme au lieu de passer par
   * `appliquerDegats` ». Un site debranche cesse de consulter `zones.ampAt`,
   * et le mouchard le voit — y compris quand l'amplification vaut 1 partout,
   * ce qu'aucune assertion sur les PV ne pourrait faire avant la Poix (tache
   * 4).
   *
   * ⚠️ **Le mouchard porte aussi la position, et c'est la moitie du test** :
   * l'amplification se lit AU PIED de l'ennemi frappe, jamais au centre du
   * balayage — deux ennemis du meme souffle, l'un dans une flaque et l'autre a
   * cote, ne subissent pas la meme chose.
   */
  describe('les TROIS sites passent par le chemin unique', () => {
    const SOUFFLE = 70;

    it('site 1 — le tir DIRECT consulte les zones au pied de l ennemi percute', () => {
      const horde = new Horde(10);
      const cible = addOne(horde, 1, 300, 40, LOURD);
      const orbs = new OrbField(10);
      const zones = solNu();
      const mouchard = vi.spyOn(zones, 'ampAt');
      const projectiles = new Projectiles(10);
      projectiles.fireSalvo(SINGLE, 0, 0, 0, cible, horde);

      let impact = -1;
      for (let t = 0; t < 40 && impact < 0; t++) {
        resolveProjectileDamage(projectiles, DT, horde, orbs, t, zones);
        if (mouchard.mock.calls.length > 0) {
          impact = t;
        }
      }

      expect(impact).toBeGreaterThanOrEqual(0);
      expect(SINGLE.blastRadius).toBe(0); // le decor est bien le tir direct
      expect(mouchard).toHaveBeenCalledTimes(1);
      expect(mouchard).toHaveBeenCalledWith(300, 40, impact);
    });

    it('site 2 — le balayage par RAYON consulte les zones au pied de CHAQUE touche', () => {
      const bombe: Weapon = { ...SINGLE, blastRadius: SOUFFLE };
      const horde = new Horde(10);
      const percute = addOne(horde, 1, 300, 0, LOURD);
      addOne(horde, 2, 300, SOUFFLE - 1, LOURD);
      addOne(horde, 3, 300, SOUFFLE, LOURD); // pile au bord : dehors
      const orbs = new OrbField(10);
      const zones = solNu();
      const mouchard = vi.spyOn(zones, 'ampAt');
      const projectiles = new Projectiles(10);
      projectiles.fireSalvo(bombe, 0, 0, 0, percute, horde);

      let impact = -1;
      for (let t = 0; t < 40 && impact < 0; t++) {
        resolveProjectileDamage(projectiles, DT, horde, orbs, t, zones);
        if (mouchard.mock.calls.length > 0) {
          impact = t;
        }
      }

      expect(impact).toBeGreaterThanOrEqual(0);
      // Deux fois, pas une : le facteur est derive PAR ENTITE. Et pas trois :
      // celui du bord est hors du souffle.
      expect(mouchard).toHaveBeenCalledTimes(2);
      expect(mouchard).toHaveBeenCalledWith(300, 0, impact);
      expect(mouchard).toHaveBeenCalledWith(300, SOUFFLE - 1, impact);
    });

    it('site 3 — la COMBUSTION consulte les zones au pied de l ennemi qui brule', () => {
      const horde = new Horde(10);
      const brule = addOne(horde, 1, 120, -250, LOURD);
      addOne(horde, 2, 900, 900, LOURD); // non marque : rien ne le consulte
      horde.applyMark(horde.slotOf(brule), ELEMENT.BRAISE, 1, 0);
      const zones = solNu();
      const mouchard = vi.spyOn(zones, 'ampAt');

      resolveBurn(horde, new OrbField(10), 4, zones);

      expect(mouchard).toHaveBeenCalledTimes(1);
      expect(mouchard).toHaveBeenCalledWith(120, -250, 4);
    });
  });
});

/**
 * ⚠️ **Ferme M19 du rapport de la tache 1** : « la VALEUR rendue par
 * `ampAt` n'est consommee par aucune assertion ». Les trois tests du bloc
 * ci-dessus gardent l'APPEL (mouchard) — l'un d'eux debranche fait rougir.
 * Mais tant que `damageAmp` valait 1 partout, `brut x amp x (1 - armure)` et
 * `brut x (1 - armure)` (le facteur tombe, l'appel reste) rendaient le MEME
 * nombre de PV : personne ne rougissait. La Poix ferme cette mutation-la.
 */
describe('la Poix amplifie reellement les degats retires (tache 4, ferme M19)', () => {
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;

  it('un coup identique retire PLUS de PV dans une flaque de Poix qu au meme point sans zone', () => {
    // ⚠️ Le sujet est la RELATION entre les deux hordes, pas un nombre
    // recopie de la production : un `brut` qui laisserait tomber `amp`
    // rendrait les deux PV identiques, quelle que soit la valeur choisie.
    const horde = new Horde(10);
    addOne(horde, 1, 500, 500, LOURD);
    const flaqueDePoix = new ZoneField();
    flaqueDePoix.spawn(ELEMENT.POIX, 500, 500, 0, 0);
    appliquerDegats(horde, 0, 6, flaqueDePoix, 0, new Set());

    const temoin = new Horde(10);
    addOne(temoin, 1, 500, 500, LOURD);
    appliquerDegats(temoin, 0, 6, solNu(), 0, new Set());

    expect(horde.hp[0]).toBeLessThan(temoin.hp[0] ?? 0);
  });

  it('retire EXACTEMENT brut x damageAmp(Poix) x (1 - armure), pas brut x (1 - armure) seul', () => {
    const horde = new Horde(10);
    addOne(horde, 1, 500, 500, LOURD);
    const flaqueDePoix = new ZoneField();
    flaqueDePoix.spawn(ELEMENT.POIX, 500, 500, 0, 0);

    appliquerDegats(horde, 0, 6, flaqueDePoix, 0, new Set());

    // damageAmp(Poix) est une valeur de production (comme HEAVY_ARMOR l a
    // deja ete pour l armure a la tache 1) : la reference directement plutot
    // que de recopier son nombre garde ce test valide si la tache 11 la
    // regle a l oeil differemment.
    const attendu = HEAVY_HP - 6 * elementOf(ELEMENT.POIX).damageAmp * (1 - HEAVY_ARMOR);
    expect(horde.hp[0]).toBeCloseTo(attendu, 5);
    // Non-vacuite : si `damageAmp` valait encore 1 ici, `attendu` et
    // `coupSurLourd(6)` soustrait de `HEAVY_HP` seraient IDENTIQUES, et
    // cette assertion ne prouverait rien de plus que celle de la tache 1.
    expect(HEAVY_HP - 6 * elementOf(ELEMENT.POIX).damageAmp * (1 - HEAVY_ARMOR)).not.toBe(
      HEAVY_HP - coupSurLourd(6),
    );
  });
});

/**
 * La chaine de Foudre, cote serveur (etape 5b, tache 3) : `resolveProjectileDamage`
 * appelle `chainTargets` (le MEME que le client, `shared/chain.ts`) et applique
 * `appliquerDegats` — LE seul chemin de degats — a chaque cible qu'elle rend.
 *
 * ⚠️ **Rien de neuf ne voyage.** Les morts de la chaine rejoignent le meme
 * `dead`/`deadIds` que n importe quelle autre mort de ce fichier : aucun
 * second tableau, aucun second message. Voir le dernier `describe` de ce
 * bloc, qui le met en scene directement — la forme la plus etroite mais
 * vraie de « la chaine n ajoute aucun octet au fil » qu un test SANS le
 * harnais a quatre sockets de la tache 11 puisse tenir (voir R3 du rapport).
 */
describe('la chaine de Foudre (etape 5b, tache 3)', () => {
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;
  const LEGER = ARCHETYPES.find((a) => a.hp === LIGHT_HP)?.id ?? -1;
  const FOUDRE: Weapon = { ...SINGLE, element: ELEMENT.FOUDRE };

  /**
   * Tire `arme` sur `targetId` depuis l origine, et avance jusqu a l impact.
   * Rend les morts ET le tick de l impact — meme helper que `frappe` plus
   * haut dans ce fichier, redefini ici en local pour ne pas dependre d une
   * fermeture d un autre `describe`.
   */
  function frappe(
    horde: Horde,
    orbs: OrbField,
    targetId: number,
    tick: number,
    arme: Weapon,
  ): { morts: number[]; impactTick: number } {
    const zones = solNu();
    const projectiles = new Projectiles(10);
    projectiles.fireSalvo(arme, tick, 0, 0, targetId, horde);
    const avant = projectiles.count;
    expect(avant).toBeGreaterThan(0); // sanity : la salve est bien partie
    for (let i = 0; i < 20; i++) {
      const morts = resolveProjectileDamage(projectiles, DT, horde, orbs, tick + i, zones);
      if (morts.length > 0 || projectiles.count === 0) {
        return { morts, impactTick: tick + i };
      }
    }
    throw new Error('le projectile ne touche jamais');
  }

  it('un impact de Foudre saute de proche en proche, jusqu a CHAIN_JUMPS cibles', () => {
    // Une ligne de cinq LOURDS espaces de 100 px : CHAIN_RADIUS (150) couvre
    // chaque saut successif, mais pas deux sauts d un coup (200 > 150) — donc
    // la chaine ne peut que suivre la ligne, un maillon a la fois. Tous
    // LOURDS pour qu aucun ne meure en route : un maillon mort arreterait la
    // propagation (point de revue n°1) et ce test ne verrait plus CHAIN_JUMPS.
    expect(100).toBeLessThan(CHAIN_RADIUS);
    expect(200).toBeGreaterThan(CHAIN_RADIUS);
    expect(CHAIN_JUMPS).toBe(3);

    const horde = new Horde(10);
    const percute = addOne(horde, 1, 100, 0, LOURD);
    const saut1 = addOne(horde, 2, 100, 100, LOURD);
    const saut2 = addOne(horde, 3, 100, 200, LOURD);
    const saut3 = addOne(horde, 4, 100, 300, LOURD);
    // Hors de portee de CHAIN_JUMPS (le 4e saut n a pas lieu), pas hors de
    // portee GEOMETRIQUE (100 px du precedent) : sans ce controle, un bug qui
    // sauterait un maillon de trop passerait inapercu.
    const horsJumps = addOne(horde, 5, 100, 400, LOURD);
    const orbs = new OrbField(10);

    const { morts } = frappe(horde, orbs, percute, 0, FOUDRE);

    expect(morts).toEqual([]); // personne ne meurt : c est le coup qui compte, pas la mort
    const coup = coupSurLourd(FOUDRE.damage);
    expect(horde.hp[horde.slotOf(percute)]).toBeCloseTo(HEAVY_HP - coup, 5);
    expect(horde.hp[horde.slotOf(saut1)]).toBeCloseTo(HEAVY_HP - coup, 5);
    expect(horde.hp[horde.slotOf(saut2)]).toBeCloseTo(HEAVY_HP - coup, 5);
    expect(horde.hp[horde.slotOf(saut3)]).toBeCloseTo(HEAVY_HP - coup, 5);
    // Le plafond CHAIN_JUMPS, et pas un CINQUIEME maillon rate par hasard.
    expect(horde.hp[horde.slotOf(horsJumps)]).toBe(HEAVY_HP);
  });

  it('⚠️ un ennemi qui MEURT du meme impact ne propage pas la chaine — point de revue n°1', () => {
    // Meme regle que « un ennemi qui MEURT du meme impact n est pas marque » :
    // un mort ne porte plus rien, donc rien ne peut plus partir de lui. La
    // victime est LEGERE (meurt au premier coup, `SINGLE.damage === LIGHT_HP`)
    // ; le voisin, a portee de chaine mais increvable a l oeil (LOURD, tres
    // loin de mourir d un seul coup de Foudre), doit rester intact.
    const horde = new Horde(10);
    const victime = addOne(horde, 1, 100, 0, LEGER);
    const voisin = addOne(horde, 2, 100, 100, LOURD); // a 100 px : dans CHAIN_RADIUS
    const orbs = new OrbField(10);
    expect(FOUDRE.damage).toBe(LIGHT_HP);

    const { morts } = frappe(horde, orbs, victime, 0, FOUDRE);

    expect(morts).toEqual([victime]);
    // Le voisin n a RIEN pris : ni degats, ni marque — la chaine ne s est
    // jamais declenchee.
    const slot = horde.slotOf(voisin);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(horde.hp[slot]).toBe(HEAVY_HP);
    expect(horde.markAt(slot, 20)).toBe(ELEMENT.NEUTRE);
  });

  it('la chaine EXCLUT un voisin deja tue par le souffle du MEME projectile', () => {
    // ⚠️ **Le decor qui separe « exclut les morts » de « exclut seulement le
    // percute ».** Une Foudre a souffle (`blastRadius`) tue un LEGER voisin
    // (`proche`) au meme coup que le percute — AVANT que la branche de la
    // chaine ne s execute (l ordre du code : souffle, puis element). Un
    // second LEGER (`lointain`) est hors du souffle mais dans CHAIN_RADIUS du
    // percute, et surtout HORS de portee de `proche` (200 > CHAIN_RADIUS) :
    // si l exclusion des morts manquait, la chaine choisirait `proche`
    // (le plus proche, meme mort) comme premier saut, et le second saut,
    // mesure depuis `proche`, ne pourrait plus atteindre `lointain` du tout —
    // `lointain` resterait donc intact, un signal net et sans ambiguite.
    const SOUFFLE = 70;
    const FOUDRE_SOUFFLE: Weapon = { ...FOUDRE, blastRadius: SOUFFLE };
    const horde = new Horde(10);
    const percute = addOne(horde, 1, 300, 0, LOURD);
    const proche = addOne(horde, 2, 300, 60, LEGER); // 60 < SOUFFLE : meurt au souffle
    const lointain = addOne(horde, 3, 300, -140, LEGER); // 140 < CHAIN_RADIUS depuis le percute
    expect(60).toBeLessThan(SOUFFLE);
    expect(140).toBeLessThan(CHAIN_RADIUS);
    // Le controle qui rend le decor decisif : `lointain` est hors de portee
    // de `proche`, donc un saut qui passerait (a tort) par `proche` ne
    // pourrait pas rebondir jusqu a `lointain` ensuite.
    expect(Math.hypot(300 - 300, 60 - -140)).toBeGreaterThan(CHAIN_RADIUS);
    const orbs = new OrbField(10);

    const { morts } = frappe(horde, orbs, percute, 0, FOUDRE_SOUFFLE);

    // Les DEUX meurent — `proche` du souffle, `lointain` de la chaine — et
    // c est la PREUVE que la chaine a bien saute par-dessus `proche` : sans
    // l exclusion, `lointain` resterait vivant (voir le decor ci-dessus).
    expect([...morts].sort((a, b) => a - b)).toEqual([proche, lointain].sort((a, b) => a - b));
    expect(horde.slotOf(percute)).toBeGreaterThanOrEqual(0); // le percute survit, lui
  });

  it('une arme elementaire NON-Foudre marque mais ne chaine jamais', () => {
    const BRAISE: Weapon = { ...SINGLE, element: ELEMENT.BRAISE };
    const horde = new Horde(10);
    const percute = addOne(horde, 1, 100, 0, LOURD);
    const voisin = addOne(horde, 2, 100, 100, LEGER); // a portee de CHAIN_RADIUS
    const orbs = new OrbField(10);

    const { morts, impactTick } = frappe(horde, orbs, percute, 0, BRAISE);

    expect(morts).toEqual([]);
    expect(horde.markAt(horde.slotOf(percute), impactTick)).toBe(ELEMENT.BRAISE);
    // Le voisin est intact : la Braise marque ce qu elle touche, elle ne
    // chaine jamais — seule `ELEMENT.FOUDRE` le fait.
    const slot = horde.slotOf(voisin);
    expect(horde.hp[slot]).toBe(LIGHT_HP);
    expect(horde.markAt(slot, impactTick)).toBe(ELEMENT.NEUTRE);
  });

  it('les morts de la chaine partent dans le MEME deadIds que les morts par impact direct — aucun canal nouveau', () => {
    // ⚠️ **La forme etroite mais vraie de « la chaine n ajoute aucun octet au
    // fil » (R3).** Ce fichier ne monte pas quatre sockets reelles — ce
    // harnais est celui de la tache 11. Ce qu il peut tenir ICI, et qui tient
    // reellement la contrainte : `resolveProjectileDamage` ne rend riend de
    // plus qu un `number[]` d identites mortes, EXACTEMENT comme pour tout
    // autre chemin de mort de ce fichier (impact direct, souffle, brulure,
    // reaction). C est ce meme tableau que `Room.step` transforme en DEATHS
    // — aucun second canal n existe a cote pour la chaine.
    const horde = new Horde(10);
    const percute = addOne(horde, 1, 300, 0, LOURD); // survit au coup direct
    const enchaine = addOne(horde, 2, 300, 100, LEGER); // meurt du SEUL saut de chaine
    const orbs = new OrbField(10);
    expect(FOUDRE.damage).toBe(LIGHT_HP);

    const { morts } = frappe(horde, orbs, percute, 0, FOUDRE);

    // Un seul tableau, une seule identite — celle que la chaine a tuee, et
    // rien de plus : pas de second retour, pas de champ supplementaire.
    expect(morts).toEqual([enchaine]);
    expect(horde.slotOf(percute)).toBeGreaterThanOrEqual(0);
    // Le reste du pipeline EXISTANT s applique sans rien de nouveau non plus
    // (etape 8 de `Room.step`) : l orbe nait comme pour n importe quelle
    // autre mort.
    expect(orbs.count).toBe(1);
    expect(orbs.id[0]).toBe(enchaine);
  });
});

/**
 * `postZone` (back/src/combat.ts) empaquette desormais le vrai type de
 * reaction de la table `shared/reactions.ts` (tache 6 de l'etape 5b) — plus
 * seulement l'element brut. Ferme les deux mutations heritees de la tache 5 :
 * `Room#announceZones` et `Session#broadcast` decodaient l'octet AVANT de
 * l'envoyer, et rien ne le voyait tant qu'aucune reaction ne posait de type
 * non nul (voir leur test dedie dans `room.test.ts` et
 * `elements.integration.test.ts`).
 */
describe('postZone empaquette le type de reaction de la table (etape 5b, tache 6)', () => {
  function trigger(pair: number, element: number): ReactionTrigger {
    return { pair, x: 1000, y: 1000, markBy: 1, by: 2, element };
  }

  it('Surchauffe (Braise + Foudre) laisse un champ portant le nibble SURCHAUFFE', () => {
    const zones = new ZoneField();
    applyReactions(
      new Horde(1),
      new OrbField(1),
      0,
      [trigger(packElementPair(ELEMENT.BRAISE, ELEMENT.FOUDRE), ELEMENT.FOUDRE)],
      zones,
      new Reactions(),
    );
    expect(zones.count).toBe(1);
    expect(zoneReaction(zones.kind[0] ?? 0)).toBe(REACTION.SURCHAUFFE);
  });

  it('Embrasement (Braise + Poix) laisse un champ portant le nibble EMBRASEMENT', () => {
    const zones = new ZoneField();
    applyReactions(
      new Horde(1),
      new OrbField(1),
      0,
      [trigger(packElementPair(ELEMENT.BRAISE, ELEMENT.POIX), ELEMENT.POIX)],
      zones,
      new Reactions(),
    );
    expect(zones.count).toBe(1);
    expect(zoneReaction(zones.kind[0] ?? 0)).toBe(REACTION.EMBRASEMENT);
  });

  it('Court-circuit (Foudre + Poix) laisse un champ portant le nibble COURT_CIRCUIT', () => {
    const zones = new ZoneField();
    applyReactions(
      new Horde(1),
      new OrbField(1),
      0,
      [trigger(packElementPair(ELEMENT.FOUDRE, ELEMENT.POIX), ELEMENT.POIX)],
      zones,
      new Reactions(),
    );
    expect(zones.count).toBe(1);
    expect(zoneReaction(zones.kind[0] ?? 0)).toBe(REACTION.COURT_CIRCUIT);
  });

  it('le Choc thermique generique (Braise + Givre) laisse un champ SANS type de reaction — non-regression', () => {
    const zones = new ZoneField();
    applyReactions(
      new Horde(1),
      new OrbField(1),
      0,
      [trigger(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE), ELEMENT.GIVRE)],
      zones,
      new Reactions(),
    );
    expect(zones.count).toBe(1);
    expect(zoneReaction(zones.kind[0] ?? 0)).toBe(REACTION.AUCUNE);
    // Et l'octet reste EGAL a l'element seul, exactement comme avant la
    // tache 6 : `packZoneKind(element, 0) === element`.
    expect(zones.kind[0]).toBe(ELEMENT.GIVRE);
  });
});

/**
 * Surchauffe (Braise + Foudre, tache 6 de l'etape 5b) : la zone brule
 * D'ELLE-MEME, independamment de toute marque — voir le second balayage de
 * `resolveBurn`.
 */
describe('resolveBurn — Surchauffe brule la zone elle-meme (etape 5b, tache 6)', () => {
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;
  const LEGER = ARCHETYPES.find((a) => a.hp === LIGHT_HP)?.id ?? -1;
  const BRULURE_GENERIQUE = elementOf(ELEMENT.BRAISE).burnPerTick;

  it('brule un ennemi DANS la zone, sans qu il porte la moindre marque', () => {
    const horde = new Horde(10);
    const dedans = addOne(horde, 1, 1000, 1000, LOURD);
    const dehors = addOne(horde, 2, 1000 + ZONE_RADIUS + 1, 1000, LOURD);
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 1000, 1000, 4, 0);

    expect(horde.markAt(horde.slotOf(dedans), 5)).toBe(ELEMENT.NEUTRE);

    resolveBurn(horde, new OrbField(10), 5, zones);

    expect(horde.hp[horde.slotOf(dedans)]).toBeLessThan(HEAVY_HP);
    expect(horde.hp[horde.slotOf(dehors)]).toBe(HEAVY_HP);
  });

  it('epargne un ennemi PILE sur le bord : la borne est stricte (`<`), comme partout ailleurs', () => {
    // Meme convention que `markInZones` et `damageInRadius` : un ennemi
    // exactement a `ZONE_RADIUS` n est pas touche.
    const horde = new Horde(10);
    const surLeBord = addOne(horde, 1, 1000 + ZONE_RADIUS, 1000, LOURD);
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 1000, 1000, 4, 0);

    resolveBurn(horde, new OrbField(10), 5, zones);

    expect(horde.hp[horde.slotOf(surLeBord)]).toBe(HEAVY_HP);
  });

  /**
   * ⚠️ **LES DEUX MOITIES.** Meme decor — un LOURD, meme tick, meme position —
   * une seule fois marque Braise (le champ generique, §4.1), une seule fois
   * dans une zone de Surchauffe : seule la source de brulure differe. « Plus
   * fort que le champ generique » (§5 de la spec) se lit ici a la difference
   * des deux pertes de PV, jamais a un chiffre recopie de production.
   */
  it('⚠️ brule PLUS FORT que le champ generique de la marque, sur le meme decor', () => {
    const generique = new Horde(10);
    addOne(generique, 1, 1000, 1000, LOURD);
    generique.applyMark(0, ELEMENT.BRAISE, 1, 0);
    resolveBurn(generique, new OrbField(10), 0, solNu());

    const surchauffe = new Horde(10);
    addOne(surchauffe, 1, 1000, 1000, LOURD);
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 1000, 1000, 4, 0);
    resolveBurn(surchauffe, new OrbField(10), 0, zones);

    const perteGenerique = HEAVY_HP - (generique.hp[0] ?? 0);
    const perteSurchauffe = HEAVY_HP - (surchauffe.hp[0] ?? 0);
    expect(perteGenerique).toBeCloseTo(coupSurLourd(BRULURE_GENERIQUE), 5);
    expect(perteSurchauffe).toBeGreaterThan(perteGenerique);
  });

  it('brule MEME quand la zone porte l element FOUDRE (le declencheur) : le taux vient de la reaction, pas de l element', () => {
    // ⚠️ **La ligne qui tue la mutation « lire `elementOf(zoneElement(kind))`
    // au lieu de `zoneBurnPerTick(kind)` ».** `elementOf(FOUDRE).burnPerTick`
    // vaut zero : une lecture generique ne brulerait jamais ici.
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LOURD);
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.FOUDRE, REACTION.SURCHAUFFE), 1000, 1000, 4, 0);
    expect(elementOf(ELEMENT.FOUDRE).burnPerTick).toBe(0);

    resolveBurn(horde, new OrbField(10), 5, zones);

    expect(horde.hp[horde.slotOf(cible)]).toBeLessThan(HEAVY_HP);
  });

  it('ne brule plus une fois SA PROPRE duree de vie ecoulee, meme si elle traine encore dans la reserve', () => {
    // ⚠️ Meme discipline que `markInZones` / `ZoneField.aliveAt` : une zone
    // perimee mais pas encore retiree (le serveur n'appelle `expire` qu'une
    // fois par tick, ailleurs) ne doit plus rien infliger.
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LOURD);
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 1000, 1000, 4, 0);
    expect(zones.count).toBe(1); // elle est bien encore la

    resolveBurn(horde, new OrbField(10), SURCHAUFFE_ZONE_LIFETIME_TICKS, zones);

    expect(horde.hp[horde.slotOf(cible)]).toBe(HEAVY_HP);
  });

  it('ne liste jamais deux fois le meme mort : marque ET zone touchent la meme entite deja a terre', () => {
    // ⚠️ Ferme le risque introduit par le second balayage : sans la garde
    // `hp <= 0`, un ennemi acheve par la marque au premier balayage
    // reprendrait un coup de la zone au second, et `dead` (un TABLEAU)
    // listerait son identite deux fois.
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LEGER);
    horde.hp[0] = 0.05; // meurt du seul burnPerTick generique (0,1, arme nulle)
    horde.applyMark(0, ELEMENT.BRAISE, 1, 0);
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 1000, 1000, 4, 0);
    const orbs = new OrbField(10);

    const dead = resolveBurn(horde, orbs, 0, zones);

    expect(dead).toEqual([cible]);
    expect(orbs.count).toBe(1);
  });

  it('deux zones de Surchauffe qui se recouvrent ne brulent pas deux fois le meme ennemi', () => {
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LEGER);
    horde.hp[0] = 0.05;
    const zones = new ZoneField();
    // Deux zones DISTINCTES (elements differents : la fusion ne les fond pas)
    // qui couvrent toutes les deux la cible.
    zones.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 1000, 1000, 4, 0);
    zones.spawn(packZoneKind(ELEMENT.FOUDRE, REACTION.SURCHAUFFE), 1010, 1010, 4, 0);
    expect(zones.count).toBe(2);
    const orbs = new OrbField(10);

    const dead = resolveBurn(horde, orbs, 0, zones);

    expect(dead).toEqual([cible]);
    expect(orbs.count).toBe(1);
  });
});

/**
 * Embrasement (Braise + Poix, tache 6 de l'etape 5b) : degats instantanes a
 * tout ennemi POISSE dans un rayon, filtre sur la marque — voir
 * `damagePoisonedInRadius`.
 */
describe('applyReactions — Embrasement ne touche que les POISSES (etape 5b, tache 6)', () => {
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;

  function trigger(x: number, y: number): ReactionTrigger {
    return {
      pair: packElementPair(ELEMENT.BRAISE, ELEMENT.POIX),
      x,
      y,
      markBy: 1,
      by: 2,
      element: ELEMENT.POIX,
    };
  }

  it('touche un ennemi POISSE, epargne un ennemi SAIN AU MEME POINT', () => {
    const horde = new Horde(10);
    const poisse = addOne(horde, 1, 1000, 1000, LOURD);
    const sain = addOne(horde, 2, 1000, 1000, LOURD);
    horde.hp[horde.slotOf(poisse)] = 1000;
    horde.hp[horde.slotOf(sain)] = 1000;
    horde.applyMark(horde.slotOf(poisse), ELEMENT.POIX, 3, 0);

    applyReactions(
      horde,
      new OrbField(10),
      0,
      [trigger(1000, 1000)],
      new ZoneField(),
      new Reactions(),
    );

    expect(horde.hp[horde.slotOf(poisse)]).toBeLessThan(1000);
    expect(horde.hp[horde.slotOf(sain)]).toBe(1000);
  });

  it('epargne un ennemi POISSE mais HORS du rayon', () => {
    const horde = new Horde(10);
    const dedans = addOne(horde, 1, 1000 + REACTION_RADIUS - 1, 1000, LOURD);
    const dehors = addOne(horde, 2, 1000 + REACTION_RADIUS, 1000, LOURD);
    horde.applyMark(horde.slotOf(dedans), ELEMENT.POIX, 3, 0);
    horde.applyMark(horde.slotOf(dehors), ELEMENT.POIX, 3, 0);
    horde.hp[horde.slotOf(dedans)] = 1000;
    horde.hp[horde.slotOf(dehors)] = 1000;

    applyReactions(
      horde,
      new OrbField(10),
      0,
      [trigger(1000, 1000)],
      new ZoneField(),
      new Reactions(),
    );

    expect(horde.hp[horde.slotOf(dedans)]).toBeLessThan(1000);
    expect(horde.hp[horde.slotOf(dehors)]).toBe(1000);
  });

  it('l ennemi qui DECLENCHE ressort NU (§4.3) : sa propre marque consommee l exclut de sa propre Embrasement', () => {
    // ⚠️ Contrairement au Choc thermique generique, ou le declencheur est
    // touche comme les autres (il est a distance nulle du point) : ici, sa
    // marque de Poix vient d etre consommee par `applyElement` avant que
    // `applyReactions` ne resolve, donc `markAt` y rend NEUTRE.
    const horde = new Horde(10);
    const declencheur = addOne(horde, 1, 1000, 1000, LOURD);
    horde.hp[0] = 1000;
    // Pas de marque posee : c est exactement l etat d un ennemi qui vient de
    // reagir (`applyElement` la remet a NEUTRE).
    expect(horde.markAt(0, 0)).toBe(ELEMENT.NEUTRE);

    applyReactions(
      horde,
      new OrbField(10),
      0,
      [trigger(1000, 1000)],
      new ZoneField(),
      new Reactions(),
    );

    expect(horde.hp[horde.slotOf(declencheur)]).toBe(1000);
  });

  /**
   * ⚠️ **LES DEUX MOITIES**, le test le plus important de cette tache. Meme
   * decor exactement — un POISSE et un SAIN, au meme point, au meme tick —
   * pour deux couples differents : Embrasement (qui doit filtrer) et le Choc
   * thermique generique (qui ne filtre jamais). « Le sain ne bouge pas » se
   * lirait aussi bien « personne n a reagi » si le Choc thermique, lui,
   * n epargnait personne — c est exactement ce que la seconde moitie prouve.
   */
  it('⚠️ Embrasement filtre sur la marque, le Choc thermique generique ne filtre rien — meme decor, seule la paire differe', () => {
    function decor(): { horde: Horde; poisse: number; sain: number } {
      const horde = new Horde(10);
      const poisse = addOne(horde, 1, 1000, 1000, LOURD);
      const sain = addOne(horde, 2, 1000, 1000, LOURD);
      horde.hp[horde.slotOf(poisse)] = 1000;
      horde.hp[horde.slotOf(sain)] = 1000;
      horde.applyMark(horde.slotOf(poisse), ELEMENT.POIX, 3, 0);
      return { horde, poisse, sain };
    }

    const embrasement = decor();
    applyReactions(
      embrasement.horde,
      new OrbField(10),
      0,
      [trigger(1000, 1000)],
      new ZoneField(),
      new Reactions(),
    );

    const chocThermique = decor();
    applyReactions(
      chocThermique.horde,
      new OrbField(10),
      0,
      [
        {
          pair: packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE),
          x: 1000,
          y: 1000,
          markBy: 1,
          by: 2,
          element: ELEMENT.GIVRE,
        },
      ],
      new ZoneField(),
      new Reactions(),
    );

    // Moitie 1 — Embrasement : seul le poisse perd des PV.
    expect(embrasement.horde.hp[embrasement.horde.slotOf(embrasement.poisse)]).toBeLessThan(1000);
    expect(embrasement.horde.hp[embrasement.horde.slotOf(embrasement.sain)]).toBe(1000);

    // Moitie 2 — Choc thermique generique, MEME decor : les DEUX perdent des
    // PV, la marque de Poix du premier ne joue ici aucun role de filtre.
    expect(chocThermique.horde.hp[chocThermique.horde.slotOf(chocThermique.poisse)]).toBeLessThan(
      1000,
    );
    expect(chocThermique.horde.hp[chocThermique.horde.slotOf(chocThermique.sain)]).toBeLessThan(
      1000,
    );
  });
});

/**
 * Court-circuit (Foudre + Poix, tache 6 de l'etape 5b) : `chainTargets`
 * (tache 2) reutilisee telle quelle, jumps non borne, tant que les cibles
 * restent POISSEES — voir `chainWhilePoisoned`.
 */
describe('applyReactions — Court-circuit chaine tant que les cibles sont poissees (etape 5b, tache 6)', () => {
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? -1;

  function trigger(x: number, y: number): ReactionTrigger {
    return {
      pair: packElementPair(ELEMENT.FOUDRE, ELEMENT.POIX),
      x,
      y,
      markBy: 1,
      by: 2,
      element: ELEMENT.POIX,
    };
  }

  /**
   * ⚠️ **« Sans limite de sauts » n'est pas cosmetique : une chaine qui
   * reutiliserait `CHAIN_JUMPS` (3, la Foudre ordinaire) au lieu de
   * `horde.count` s'arreterait au TROISIEME maillon poisse et laisserait
   * intacts les suivants — ce test en pose CINQ.
   */
  it('⚠️ chaine reellement au-dela de CHAIN_JUMPS quand tous les maillons restent poisses', () => {
    expect(CHAIN_JUMPS).toBe(3);
    const horde = new Horde(10);
    const maillons: number[] = [];
    // Cinq maillons alignes, espaces de 100 px (< CHAIN_RADIUS) : cinq sauts.
    for (let i = 1; i <= 5; i++) {
      const id = addOne(horde, i, i * 100, 0, LOURD);
      horde.hp[horde.slotOf(id)] = 1000;
      horde.applyMark(horde.slotOf(id), ELEMENT.POIX, 3, 0);
      maillons.push(id);
    }

    applyReactions(horde, new OrbField(10), 0, [trigger(0, 0)], new ZoneField(), new Reactions());

    // ⚠️ **La ligne qui distingue `horde.count` de `CHAIN_JUMPS`** : le
    // CINQUIEME maillon, au-dela du plafond de la Foudre ordinaire, a bien
    // ete touche.
    for (const id of maillons) {
      expect(horde.hp[horde.slotOf(id)], `maillon ${id}`).toBeLessThan(1000);
    }
  });

  it('⚠️ s ARRETE au premier maillon NON poisse, elle ne saute pas par-dessus', () => {
    // Trois maillons alignes, espaces de 100 px (< CHAIN_RADIUS 150) : le
    // premier saut depuis l origine ne peut atteindre QUE le premier —
    // chaque saut suivant repart de la cible precedente. A: poisse, B: sain,
    // C: poisse — C est GEOMETRIQUEMENT atteignable (100 px de B), mais la
    // chaine doit s arreter a B.
    expect(100).toBeLessThan(CHAIN_RADIUS);
    const horde = new Horde(10);
    const a = addOne(horde, 1, 100, 0, LOURD);
    const b = addOne(horde, 2, 200, 0, LOURD);
    const c = addOne(horde, 3, 300, 0, LOURD);
    for (const id of [a, b, c]) {
      horde.hp[horde.slotOf(id)] = 1000;
    }
    horde.applyMark(horde.slotOf(a), ELEMENT.POIX, 3, 0);
    // b : AUCUNE marque.
    horde.applyMark(horde.slotOf(c), ELEMENT.POIX, 3, 0);

    applyReactions(horde, new OrbField(10), 0, [trigger(0, 0)], new ZoneField(), new Reactions());

    expect(horde.hp[horde.slotOf(a)]).toBeLessThan(1000);
    expect(horde.hp[horde.slotOf(b)]).toBe(1000);
    // ⚠️ La ligne qui distingue « s arrete » de « saute par-dessus » : C est
    // poisse et geometriquement a portee du saut suivant, et pourtant intact.
    expect(horde.hp[horde.slotOf(c)]).toBe(1000);
  });

  /**
   * ⚠️ **LES DEUX MOITIES.** Meme decor — un POISSE a 120 px de l origine,
   * hors de `REACTION_RADIUS` (90) mais dans `CHAIN_RADIUS` (150) — pour deux
   * couples differents : Court-circuit (qui doit l atteindre EN SAUTANT) et
   * un couple qui ne declenche AUCUN effet specifique (qui doit se limiter au
   * balayage generique, donc RATER cette cible). « La cible eloignee ne bouge
   * pas » se lirait aussi bien « rien n a reagi » si le couple generique, lui
   * non plus, ne l atteignait jamais pour une autre raison.
   */
  it('⚠️ chaine reellement au-dela de REACTION_RADIUS, la ou le generique ne porte pas', () => {
    expect(REACTION_RADIUS).toBeLessThan(120);
    expect(120).toBeLessThan(CHAIN_RADIUS);

    function decor(): { horde: Horde; loin: number } {
      const horde = new Horde(10);
      const loin = addOne(horde, 1, 120, 0, LOURD);
      horde.hp[horde.slotOf(loin)] = 1000;
      horde.applyMark(horde.slotOf(loin), ELEMENT.POIX, 3, 0);
      return { horde, loin };
    }

    const courtCircuit = decor();
    applyReactions(
      courtCircuit.horde,
      new OrbField(10),
      0,
      [trigger(0, 0)],
      new ZoneField(),
      new Reactions(),
    );

    const generique = decor();
    applyReactions(
      generique.horde,
      new OrbField(10),
      0,
      [
        {
          pair: packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE),
          x: 0,
          y: 0,
          markBy: 1,
          by: 2,
          element: ELEMENT.GIVRE,
        },
      ],
      new ZoneField(),
      new Reactions(),
    );

    // Moitie 1 — Court-circuit atteint la cible en sautant jusqu a elle.
    expect(courtCircuit.horde.hp[courtCircuit.horde.slotOf(courtCircuit.loin)]).toBeLessThan(1000);
    // Moitie 2 — le generique, meme point d origine, ne porte pas jusque-la.
    expect(generique.horde.hp[generique.horde.slotOf(generique.loin)]).toBe(1000);
  });

  it('exclut l ennemi qui declenche : il ne saute pas sur lui-meme malgre la distance nulle', () => {
    // ⚠️ Sans `trigger.entityId` exclu, le premier saut — mesure depuis SA
    // PROPRE position — le retrouverait a distance nulle et la chaine
    // boucherait sur lui-meme au lieu d atteindre le VRAI premier maillon.
    const horde = new Horde(10);
    const declencheur = addOne(horde, 1, 500, 500, LOURD);
    const cible = addOne(horde, 2, 500 + 50, 500, LOURD);
    horde.hp[horde.slotOf(declencheur)] = 1000;
    horde.hp[horde.slotOf(cible)] = 1000;
    horde.applyMark(horde.slotOf(cible), ELEMENT.POIX, 3, 0);
    // Le declencheur ressort NU (§4.3) : sa propre marque est deja consommee.
    expect(horde.markAt(horde.slotOf(declencheur), 0)).toBe(ELEMENT.NEUTRE);

    const t = trigger(500, 500);
    t.entityId = horde.entityIdAt(horde.slotOf(declencheur));

    applyReactions(horde, new OrbField(10), 0, [t], new ZoneField(), new Reactions());

    expect(horde.hp[horde.slotOf(cible)]).toBeLessThan(1000);
    // Le declencheur n a pas ete rappele sur lui-meme.
    expect(horde.hp[horde.slotOf(declencheur)]).toBe(1000);
  });

  /**
   * ⚠️ **Un ennemi deja mort d'une AUTRE reaction du meme tick ne doit plus
   * propager la chaine.** `chainWhilePoisoned` exclut `dead` en plus de
   * `trigger.entityId` — meme raisonnement que le chainage de la Foudre dans
   * `resolveProjectileDamage`, transpose a deux DECLENCHEURS distincts au
   * lieu d'un impact et d'un souffle. Sans cette exclusion, `chainTargets`
   * choisirait le mort comme hop, et le hop SUIVANT — mesure depuis SA
   * position — atteindrait une cible que le vrai chemin (sans lui) ne peut
   * pas atteindre en un seul saut depuis l origine.
   */
  it('exclut un voisin deja tue par une reaction PRECEDENTE du meme tick : il ne relaie plus la chaine', () => {
    const LEGER = ARCHETYPES.find((a) => a.hp === LIGHT_HP)?.id ?? -1;
    // X : tue par un Choc thermique GENERIQUE pose exactement sur lui, avant
    // que Court-circuit ne parte de l origine.
    const horde = new Horde(10);
    const x = addOne(horde, 1, 50, 0, LEGER);
    horde.hp[horde.slotOf(x)] = 1;
    horde.applyMark(horde.slotOf(x), ELEMENT.POIX, 3, 0);
    // Y : hors de CHAIN_RADIUS de l ORIGINE (190 > 150), mais a portee d un
    // hop mesure depuis X (140 < 150) — le seul chemin par lequel Y pourrait
    // etre touche si X relayait la chaine a tort.
    const y = addOne(horde, 2, 190, 0, LOURD);
    horde.hp[horde.slotOf(y)] = 1000;
    horde.applyMark(horde.slotOf(y), ELEMENT.POIX, 3, 0);
    expect(Math.hypot(0 - 190, 0)).toBeGreaterThan(CHAIN_RADIUS);
    expect(Math.hypot(50 - 190, 0)).toBeLessThan(CHAIN_RADIUS);

    const chocThermiqueSurX: ReactionTrigger = {
      pair: packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE),
      x: 50,
      y: 0,
      markBy: 1,
      by: 2,
      element: ELEMENT.GIVRE,
    };
    const courtCircuitDepuisOrigine = trigger(0, 0);

    const morts = applyReactions(
      horde,
      new OrbField(10),
      0,
      [chocThermiqueSurX, courtCircuitDepuisOrigine],
      new ZoneField(),
      new Reactions(),
    );

    // X est bien mort du Choc thermique, et lui SEUL.
    expect(morts).toEqual([x]);
    // Y, HORS de portee directe de l origine, n a pas ete atteint : Court-circuit
    // n a pas relaye sa chaine a travers le cadavre de X.
    expect(horde.hp[horde.slotOf(y)]).toBe(1000);
  });

  /**
   * ⚠️ **Le test precedent fabrique `entityId` a la main — celui-ci le
   * recueille du chemin REEL** (`markInZones` -> `applyElement`), la seule
   * facon de garder `applyElement` lui-meme sous garde : rien d'autre
   * n'exerce la ligne `entityId: horde.entityIdAt(slot)` de sa construction
   * du declencheur.
   */
  it('un declencheur NE de markInZones porte bien sa propre identite, et s exclut de sa chaine', () => {
    const horde = new Horde(10);
    const declencheur = addOne(horde, 1, 1000, 1000, LOURD);
    // A 100 px : DANS CHAIN_RADIUS (150), mais HORS de ZONE_RADIUS (70) —
    // sinon la zone qui suit reagirait aussi AVEC elle, et markInZones
    // rendrait deux declencheurs au lieu d un.
    const cible = addOne(horde, 2, 1000 + 100, 1000, LOURD);
    horde.hp[horde.slotOf(declencheur)] = 1000;
    horde.hp[horde.slotOf(cible)] = 1000;
    horde.applyMark(horde.slotOf(declencheur), ELEMENT.POIX, 3, 0);
    horde.applyMark(horde.slotOf(cible), ELEMENT.POIX, 3, 0);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.FOUDRE, 1000, 1000, 4, 0);
    const reactions = new Reactions();

    markInZones(horde, zones, 0, reactions);
    const triggers = reactions.drain();
    // Le decor n est pas creux : UN SEUL declencheur (la cible est hors de
    // portee de la zone), et c est bien Court-circuit.
    expect(triggers.length).toBe(1);
    expect(triggers[0]?.pair).toBe(packElementPair(ELEMENT.FOUDRE, ELEMENT.POIX));

    applyReactions(horde, new OrbField(10), 0, triggers, new ZoneField(), new Reactions());

    expect(horde.hp[horde.slotOf(cible)]).toBeLessThan(1000);
    expect(horde.hp[horde.slotOf(declencheur)]).toBe(1000);
  });
});
