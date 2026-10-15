import { describe, expect, it } from 'vitest';

import { archetypeOf, BOSS_ARCHETYPE } from './archetypes';
import {
  CRIT_CHANCE,
  PROJECTILE_HIT_RADIUS,
  TICK_HZ,
  VIF_ARGENT_HIT_RADIUS_BONUS,
} from './constants';
import { ELEMENT } from './elements';
import { Horde } from './horde';
import { Projectiles } from './projectiles';
import { FORMATION, type WaveOrder } from './waves';
import type { Weapon } from './weapons';
import { projectileTrailPx, WEAPONS, weaponOf } from './weapons';
import { ZoneField } from './zones';

/**
 * Fait apparaitre une seule entite, avec un `waveId` choisi explicitement
 * pour controler son identifiant — meme technique que `targeting.test.ts`.
 */
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

/** Une arme a projectile unique, tirant droit sur la cible. */
const SINGLE: Weapon = {
  id: 0,
  name: 'test-simple',
  cooldownTicks: 5,
  damage: 7,
  projectileSpeed: 100,
  projectileLifeTicks: 5,
  projectileCount: 1,
  spreadRadians: 0,
  element: ELEMENT.NEUTRE,
  blastRadius: 0,
  pierce: 0,
  kind: 'tir' as const,
  perks: [],
  projectileScale: 1,
  venom: 0,
  bounces: 0,
  homing: 0,
  // Trois apparences DIFFERENTES entre les trois armes de test : c'est ce qui
  // permet aux cas de `weaponAt` ci-dessous de distinguer laquelle a tire.
  look: {
    shape: 'lame',
    diameterPx: 10,
    tint: 0x111111,
    glow: 0.2,
    trailTicks: 1,
    spinTurns: 0,
    trail: 'lisse',
  },
};

/** Une arme a plusieurs projectiles, pour verifier la symetrie de la dispersion. */
const SPREAD: Weapon = {
  id: 1,
  name: 'test-eventail',
  cooldownTicks: 10,
  damage: 3,
  projectileSpeed: 100,
  projectileLifeTicks: 10,
  projectileCount: 3,
  spreadRadians: Math.PI / 2,
  element: ELEMENT.NEUTRE,
  blastRadius: 0,
  pierce: 0,
  kind: 'tir' as const,
  perks: [],
  projectileScale: 1,
  venom: 0,
  bounces: 0,
  homing: 0,
  look: {
    shape: 'petale',
    diameterPx: 12,
    tint: 0x222222,
    glow: 0.4,
    trailTicks: 1,
    spinTurns: 0,
    trail: 'lisse',
  },
};

/** Une arme rapide, pour exercer le balayage de segment de `collide`. */
const FAST: Weapon = {
  id: 2,
  name: 'test-rapide',
  cooldownTicks: 30,
  damage: 9,
  projectileSpeed: 900,
  projectileLifeTicks: 30,
  projectileCount: 1,
  spreadRadians: 0,
  element: ELEMENT.NEUTRE,
  blastRadius: 0,
  pierce: 0,
  kind: 'tir' as const,
  perks: [],
  projectileScale: 1,
  venom: 0,
  bounces: 0,
  homing: 0,
  look: {
    shape: 'fleche',
    diameterPx: 14,
    tint: 0x333333,
    glow: 0.6,
    trailTicks: 2,
    spinTurns: 0,
    trail: 'lisse',
  },
};

describe('Projectiles.fireSalvo', () => {
  it('une salve produit projectileCount projectiles', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0);
    const projectiles = new Projectiles(50);

    projectiles.fireSalvo(SPREAD, 0, 0, 0, targetId, horde);

    expect(projectiles.count).toBe(SPREAD.projectileCount);
  });

  it('ne tire pas quand la cible n est plus dans la horde donnee', () => {
    const horde = new Horde(10);
    const projectiles = new Projectiles(50);

    // Identifiant qui ne correspond a aucune entite vivante.
    projectiles.fireSalvo(SINGLE, 0, 0, 0, 999_999, horde);

    expect(projectiles.count).toBe(0);
  });

  it('la dispersion est symetrique autour de la direction visee', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0); // cible plein est : angle de base 0
    const projectiles = new Projectiles(50);

    projectiles.fireSalvo(SPREAD, 0, 0, 0, targetId, horde);
    // Un pas suffit a rendre la direction de chaque projectile observable :
    // sa position s'eloigne de l'origine (0,0) dans sa propre direction.
    projectiles.step(1);

    const angles: number[] = [];
    for (let i = 0; i < projectiles.count; i++) {
      angles.push(Math.atan2(projectiles.y[i] ?? 0, projectiles.x[i] ?? 0));
    }
    angles.sort((a, b) => a - b);

    expect(angles.length).toBe(3);
    // Symetrique autour de 0 : le plus petit et le plus grand sont opposes,
    // et celui du milieu vise droit sur la cible.
    expect(angles[0]).toBeCloseTo(-(angles[2] ?? 0), 5);
    expect(angles[1]).toBeCloseTo(0, 5);
    expect(Math.abs(angles[0] ?? 0)).toBeCloseTo(SPREAD.spreadRadians / 2, 5);
  });
});

/**
 * `fireSalvoDirected` (tache 13) : une salve dans une direction donnee, sans
 * cible ni horde — c'est ce qu'appellent desormais `Room#fireWeapons` et
 * `GameClient#fireWeapons` pour l'arme de base, la visee venant du curseur.
 */
describe('Projectiles.fireSalvoDirected', () => {
  it('une salve produit projectileCount projectiles, dans la direction donnee', () => {
    const projectiles = new Projectiles(50);

    projectiles.fireSalvoDirected(SPREAD, 0, 0, 0, 1, 0);

    expect(projectiles.count).toBe(SPREAD.projectileCount);
  });

  it('ne tire pas quand la direction est nulle (0, 0) — regle centrale de la tache 13', () => {
    const projectiles = new Projectiles(50);

    projectiles.fireSalvoDirected(SINGLE, 0, 0, 0, 0, 0);

    expect(projectiles.count).toBe(0);
  });

  it('seul l angle de (dirX, dirY) compte, pas sa norme', () => {
    // Un client transmet dirX/dirY quantifies sur un octet signe (-127..127) :
    // la salve doit partir identiquement, que la paire soit (1, 0) ou
    // (127, 0) — sinon un client qui envoie sa direction sans la renormaliser
    // d'abord tirerait plus vite ou plus loin selon la distance au curseur,
    // ce qui n'a pas de sens physique et n'est jamais ce que fait le code de
    // production (voir `quantizeAxis` dans `shared/protocol.ts`).
    const unit = new Projectiles(50);
    const scaled = new Projectiles(50);

    unit.fireSalvoDirected(SINGLE, 0, 10, 20, 1, 0);
    scaled.fireSalvoDirected(SINGLE, 0, 10, 20, 127, 0);
    unit.step(1);
    scaled.step(1);

    expect(unit.x[0]).toBeCloseTo(scaled.x[0] ?? 0, 5);
    expect(unit.y[0]).toBeCloseTo(scaled.y[0] ?? 0, 5);
  });

  it('la dispersion est symetrique autour de la direction visee', () => {
    const projectiles = new Projectiles(50);

    // Direction plein est (1, 0) : angle de base 0, comme le test equivalent
    // de `fireSalvo` sur une cible plein est.
    projectiles.fireSalvoDirected(SPREAD, 0, 0, 0, 1, 0);
    projectiles.step(1);

    const angles: number[] = [];
    for (let i = 0; i < projectiles.count; i++) {
      angles.push(Math.atan2(projectiles.y[i] ?? 0, projectiles.x[i] ?? 0));
    }
    angles.sort((a, b) => a - b);

    expect(angles.length).toBe(3);
    expect(angles[0]).toBeCloseTo(-(angles[2] ?? 0), 5);
    expect(angles[1]).toBeCloseTo(0, 5);
    expect(Math.abs(angles[0] ?? 0)).toBeCloseTo(SPREAD.spreadRadians / 2, 5);
  });

  it('vise dans la direction (dirX, dirY), quelle que soit la position du tireur', () => {
    const projectiles = new Projectiles(50);

    // Plein nord (y croissant vers le bas dans ce repere, comme le reste du
    // jeu) : dirX = 0, dirY = 1.
    projectiles.fireSalvoDirected(SINGLE, 0, 500, 500, 0, 1);
    projectiles.step(1);

    expect(projectiles.x[0]).toBeCloseTo(500, 5);
    expect(projectiles.y[0] ?? 0).toBeGreaterThan(500);
  });
});

describe('Projectiles.step — duree de vie', () => {
  it('un projectile est encore vivant a life - 1 pas, et expire au pas life', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0);
    const projectiles = new Projectiles(50);
    projectiles.fireSalvo(SINGLE, 0, 0, 0, targetId, horde);

    for (let i = 0; i < SINGLE.projectileLifeTicks - 1; i++) {
      projectiles.step(1 / 30);
    }
    expect(projectiles.count).toBe(1);

    projectiles.step(1 / 30);
    expect(projectiles.count).toBe(0);
  });
});

describe('Projectiles.collide', () => {
  it('detecte un ennemi sur la trajectoire du projectile', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0);
    const projectiles = new Projectiles(50);
    projectiles.fireSalvo(SINGLE, 0, 0, 0, targetId, horde);

    // Le projectile part de (0,0) vers (100,0) a 100 px/s. Un pas d'une
    // seconde l'amene en (100,0), pile sur la cible — qui n'a pas bouge.
    projectiles.step(1);

    const hits: { entityId: number; damage: number }[] = [];
    projectiles.collide(horde, (entityId, damage) => hits.push({ entityId, damage }));

    expect(hits).toEqual([{ entityId: targetId, damage: SINGLE.damage }]);
    expect(projectiles.count).toBe(0); // le projectile est consomme par le coup
  });

  it('ne declenche rien pour un ennemi qui passe pres de la trajectoire sans la toucher', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 1000, 0);
    const projectiles = new Projectiles(50);
    projectiles.fireSalvo(SINGLE, 0, 0, 0, targetId, horde);
    projectiles.step(1); // le projectile est en (100, 0)

    // Un second ennemi, hors du rayon de collision mais pas loin, place APRES
    // le tir pour ne pas influencer le ciblage.
    addOne(horde, 2, 100, PROJECTILE_HIT_RADIUS + 10);

    const hits: { entityId: number; damage: number }[] = [];
    projectiles.collide(horde, (entityId, damage) => hits.push({ entityId, damage }));

    expect(hits).toEqual([]);
    expect(projectiles.count).toBe(1); // ni touche, ni consomme
  });

  it('detecte un ennemi qui coupe le SEGMENT parcouru pendant le pas, meme hors du rayon aux deux extremites', () => {
    // Reproduction du defaut trouve en revue : un echantillonnage au seul
    // point d'arrivee manque une cible qui coupe la trajectoire sur le cote,
    // au milieu du pas — et le defaut s'aggrave avec la vitesse.
    //
    // `FAST` va de (0,0) a (30,0) en un tick (900 px/s a 30 Hz). Un ennemi en
    // (15,30) est a 30 px du SEGMENT (0,0)-(30,0) — dans le rayon de 32 —
    // mais a ~33,5 px de CHACUNE des deux extremites — hors du rayon. Un
    // `collide` qui n'echantillonnerait que le point de depart ou le point
    // d'arrivee la manquerait ; le balayage de segment la touche.
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 1000, 0); // loin sur l'axe : angle de tir nul
    const projectiles = new Projectiles(50);
    projectiles.fireSalvo(FAST, 0, 0, 0, targetId, horde);

    const victimId = addOne(horde, 2, 15, 30);

    projectiles.step(1 / TICK_HZ); // avance de (0,0) a (30,0)

    const hits: { entityId: number; damage: number }[] = [];
    projectiles.collide(horde, (entityId, damage) => hits.push({ entityId, damage }));

    expect(hits).toEqual([{ entityId: victimId, damage: FAST.damage }]);
    expect(projectiles.count).toBe(0);
  });

  /**
   * ⚠️ **Le rayon de touche elargi du Vif-argent (etape 5c, tache 3), COTE
   * SERVEUR SEUL.** `zones`/`tick` sont optionnels : le CLIENT
   * (`front/src/net/client.ts`) appelle `collide` sans eux pour ses
   * projectiles cosmetiques et garde donc le rayon de base — c'est
   * exactement ce que le premier `collide` de ce test verifie, sur le MEME
   * projectile, avant de le refaire avec `zones` pour montrer que le rayon
   * elargi, lui, touche.
   */
  it('elargit le rayon de touche pour un ennemi en zone de Vif-argent, seulement quand `zones` est fourni', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 1000, 0); // loin sur l'axe : angle de tir nul
    const projectiles = new Projectiles(50);
    projectiles.fireSalvo(SINGLE, 0, 0, 0, targetId, horde);
    projectiles.step(1); // segment (0,0)->(100,0)

    // Au-dela du rayon de BASE (32), mais dans le rayon ELARGI (32 + 16 = 48).
    const ecart = PROJECTILE_HIT_RADIUS + 10;
    expect(ecart).toBeGreaterThan(PROJECTILE_HIT_RADIUS);
    expect(ecart).toBeLessThan(PROJECTILE_HIT_RADIUS + VIF_ARGENT_HIT_RADIUS_BONUS);
    const victimId = addOne(horde, 2, 100, ecart);

    const zones = new ZoneField();
    zones.spawn(ELEMENT.VIF_ARGENT, 100, ecart, 0, 0);

    // Sans `zones` : le rayon de BASE seul ne touche pas, le projectile reste
    // en vol — meme appel que le client.
    const misses: { entityId: number }[] = [];
    projectiles.collide(horde, (entityId) => misses.push({ entityId }));
    expect(misses).toEqual([]);
    expect(projectiles.count).toBe(1);

    // Avec `zones`/`tick` : le rayon ELARGI touche — meme appel que le serveur.
    const hits: { entityId: number; damage: number }[] = [];
    projectiles.collide(horde, (entityId, damage) => hits.push({ entityId, damage }), zones, 0);
    expect(hits).toEqual([{ entityId: victimId, damage: SINGLE.damage }]);
    expect(projectiles.count).toBe(0);
  });
});

describe('Projectiles.fireSalvo — capacite', () => {
  it('tronque une salve qui depasserait la capacite, sans toucher aux projectiles deja en vol', () => {
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 100, 0);
    // Capacite pile remplie par une seule salve de SPREAD.
    const projectiles = new Projectiles(SPREAD.projectileCount);

    projectiles.fireSalvo(SPREAD, 0, 0, 0, targetId, horde);
    expect(projectiles.count).toBe(SPREAD.projectileCount);

    const beforeX = Array.from(projectiles.x.slice(0, projectiles.count));
    const beforeY = Array.from(projectiles.y.slice(0, projectiles.count));

    // Plus une seule place : cette salve devrait etre entierement rejetee.
    projectiles.fireSalvo(SINGLE, 1, 999, 999, targetId, horde);

    expect(projectiles.count).toBe(SPREAD.projectileCount); // jamais au-dela de la capacite
    expect(Array.from(projectiles.x.slice(0, projectiles.count))).toEqual(beforeX);
    expect(Array.from(projectiles.y.slice(0, projectiles.count))).toEqual(beforeY);
  });
});

describe('Projectiles — bornTick et compaction', () => {
  it('le projectile deplace dans le trou par la compaction porte le bon bornTick', () => {
    const horde = new Horde(10);
    // Loin de toute position de tir ci-dessous, pour ne pas coincider avec un
    // projectile et fausser le compte de coups.
    const targetId = addOne(horde, 1, 1000, 0);
    const projectiles = new Projectiles(50);

    // Trois projectiles, tires a des ticks distincts et a des positions
    // distinctes (pour ne toucher que celui vise par le test).
    projectiles.fireSalvo(SINGLE, 10, 0, 0, targetId, horde); // slot 0
    projectiles.fireSalvo(SINGLE, 20, 50, 0, targetId, horde); // slot 1, sera consomme
    projectiles.fireSalvo(SINGLE, 30, 100, 0, targetId, horde); // slot 2, dernier -> deplace dans le trou

    expect(projectiles.bornTick[0]).toBe(10);
    expect(projectiles.bornTick[1]).toBe(20);
    expect(projectiles.bornTick[2]).toBe(30);

    // Un ennemi pile sur le projectile du milieu, assez loin des deux autres
    // pour ne toucher que lui.
    addOne(horde, 2, 50, 0);
    projectiles.collide(horde, () => {
      // Seule la compaction nous interesse ici, pas les degats.
    });

    expect(projectiles.count).toBe(2);
    // Le dernier projectile (tick 30) a ete deplace dans le trou laisse par
    // celui du milieu (tick 20) : sans la compaction de `bornTick`, la
    // valeur au creneau 1 resterait perimee a 20.
    expect(projectiles.bornTick[1]).toBe(30);
  });

  it('la position de depart de segment suit la compaction, meme sans step() entre deux collide()', () => {
    // `#prevX`/`#prevY` ne sont pas exposes (contrairement a `bornTick`) —
    // trouve en mutant leur compaction dans `#removeAt` : aucun des dix
    // autres tests ne l'a vu passer au rouge. Sans elle, le SEGMENT teste
    // par un `collide()` ulterieur melangerait le `prev` de l'occupant
    // retire avec la position courante — correctement compactee, elle —
    // du projectile deplace dans le trou : un segment fantome qui n'a
    // jamais ete parcouru par personne.
    const horde = new Horde(10);
    const targetId = addOne(horde, 1, 1000, 0); // plein est, loin de tout le reste

    const projectiles = new Projectiles(50);
    projectiles.fireSalvo(SINGLE, 0, 0, 0, targetId, horde); // slot 0
    projectiles.fireSalvo(SINGLE, 0, 500, 0, targetId, horde); // slot 1, dernier -> deplace dans le trou

    projectiles.step(1); // slot 0 : (0,0)->(100,0) ; slot 1 : (500,0)->(600,0)

    // Un ennemi pile sur le projectile 0 : le consomme, ce qui deplace le
    // projectile 1 (dernier) dans le trou laisse au creneau 0.
    const triggerId = addOne(horde, 2, 100, 0);
    projectiles.collide(horde, () => {
      // Seule la compaction nous interesse ici, pas les degats.
    });
    expect(projectiles.count).toBe(1);

    // Retire cet ennemi de la horde : sinon, pile sur l'axe (0,0)-(600,0), il
    // masquerait le segment fantome en se faisant toucher lui-meme a nouveau
    // (distance nulle), quelle que soit la version de `#removeAt` testee.
    horde.kill([triggerId]);

    // Un ennemi proche du segment FANTOME (0,0)->(600,0) — celui qu'on
    // obtiendrait si `prev` n'avait pas suivi la compaction, melangeant le
    // prev de l'ancien occupant du creneau 0 avec la position courante,
    // elle correctement compactee, du survivant — mais loin du VRAI segment
    // qu'il a reellement parcouru, (500,0)->(600,0).
    const decoyId = addOne(horde, 3, 250, 20);

    const hits: { entityId: number; damage: number }[] = [];
    projectiles.collide(horde, (entityId, damage) => hits.push({ entityId, damage }));

    expect(hits.some((h) => h.entityId === decoyId)).toBe(false);
  });
});

/**
 * ⚠️ **Ce `describe` gardait `fireSalvo` (visee par cible) sous le titre
 * generique « derivation », et se faisait passer pour le contrat de
 * PRODUCTION — trouve en ecrivant le plan de la tache 3 (etape 5c) :
 * `fireSalvo` n'a plus un seul appelant en production depuis la tache 13 de
 * l'etape 6a (`room.ts:1526`, `client.ts:2190` appellent tous deux
 * `fireSalvoDirected`). Le contrat qu'il verifie reste reel — deux instances
 * independantes, memes entrees, memes projectiles — mais garde une fonction
 * QUE LE JEU N'APPELLE PLUS : `fireSalvo` reste dans `shared/projectiles.ts`
 * pour d'eventuelles armes a tete chercheuse (voir son docbloc), et ce test
 * continue de couvrir SA propre derivation. Le contrat de PRODUCTION est
 * desormais garde par le `describe` suivant.
 */
describe('Projectiles — derivation (fireSalvo, visee par cible, reservee aux armes futures)', () => {
  it('fireSalvo derive identiquement des deux cotes', () => {
    // Deux instances INDEPENDANTES (aucun tableau partage), memes armes, meme
    // tick de depart, memes positions : elles doivent produire exactement les
    // memes salves. C'est ce qui permet de ne rien envoyer sur le fil (§5.2).
    function buildSide(): { horde: Horde; projectiles: Projectiles; targetId: number } {
      const horde = new Horde(20);
      const targetId = addOne(horde, 1, 2000, 300);
      return { horde, projectiles: new Projectiles(200), targetId };
    }

    const a = buildSide();
    const b = buildSide();
    const dt = 1 / 30;
    // 33 : ni multiple de SINGLE.cooldownTicks (5) ni de SPREAD.cooldownTicks
    // (10) — les deux dernieres salves sont donc encore vivantes a la fin de
    // la boucle, et la comparaison finale porte reellement sur des
    // projectiles actifs plutot que sur deux tableaux vides.
    const TICKS = 33;

    for (let tick = 0; tick < TICKS; tick++) {
      // Un tireur qui se deplace, pour exercer une position variable.
      const shooterX = tick * 5;
      const shooterY = Math.sin(tick * 0.3) * 20;

      // Deux armes independantes, chacune sur sa propre cadence — choisies
      // deterministement par le tick, donc par construction identiques des
      // deux cotes.
      if (tick % SINGLE.cooldownTicks === 0) {
        a.projectiles.fireSalvo(SINGLE, tick, shooterX, shooterY, a.targetId, a.horde);
        b.projectiles.fireSalvo(SINGLE, tick, shooterX, shooterY, b.targetId, b.horde);
      }
      if (tick % SPREAD.cooldownTicks === 0) {
        a.projectiles.fireSalvo(SPREAD, tick, shooterX, shooterY, a.targetId, a.horde);
        b.projectiles.fireSalvo(SPREAD, tick, shooterX, shooterY, b.targetId, b.horde);
      }

      a.projectiles.step(dt);
      b.projectiles.step(dt);
    }

    // Le scenario n'a de valeur que si les deux cotes portent vraiment des
    // projectiles a comparer — sinon la boucle ci-dessous ne verifie rien.
    expect(a.projectiles.count).toBeGreaterThan(0);
    expect(b.projectiles.count).toBe(a.projectiles.count);
    for (let i = 0; i < a.projectiles.count; i++) {
      expect(b.projectiles.x[i]).toBeCloseTo(a.projectiles.x[i] ?? 0, 6);
      expect(b.projectiles.y[i]).toBeCloseTo(a.projectiles.y[i] ?? 0, 6);
    }
  });
});

/**
 * Le contrat de PRODUCTION : `room.ts:1526` et `client.ts:2190` appellent
 * tous deux `fireSalvoDirected`, jamais `fireSalvo` — c'est ce chemin, et lui
 * seul, que « la salve reste calculee identiquement des deux cotes » doit
 * garder (docbloc du module).
 */
describe('Projectiles — derivation (fireSalvoDirected, le chemin de PRODUCTION)', () => {
  it('fireSalvoDirected derive identiquement des deux cotes', () => {
    // Meme scenario que le test de derivation de `fireSalvo` ci-dessus, sur
    // le chemin de PRODUCTION : une direction quantifiee fixe par tick,
    // jamais une cible.
    const a = new Projectiles(200);
    const b = new Projectiles(200);
    const dt = 1 / 30;
    // 33 : ni multiple de SINGLE.cooldownTicks (5) ni de SPREAD.cooldownTicks
    // (10) — les deux dernieres salves sont donc encore vivantes a la fin de
    // la boucle, et la comparaison finale porte reellement sur des
    // projectiles actifs plutot que sur deux tableaux vides.
    const TICKS = 33;

    for (let tick = 0; tick < TICKS; tick++) {
      // Un tireur qui se deplace ET une direction qui tourne, pour exercer
      // une position ET une direction variables — deterministes par
      // construction, donc identiques des deux cotes.
      const shooterX = tick * 5;
      const shooterY = Math.sin(tick * 0.3) * 20;
      const angle = tick * 0.2;
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);

      if (tick % SINGLE.cooldownTicks === 0) {
        a.fireSalvoDirected(SINGLE, tick, shooterX, shooterY, dirX, dirY);
        b.fireSalvoDirected(SINGLE, tick, shooterX, shooterY, dirX, dirY);
      }
      if (tick % SPREAD.cooldownTicks === 0) {
        a.fireSalvoDirected(SPREAD, tick, shooterX, shooterY, dirX, dirY);
        b.fireSalvoDirected(SPREAD, tick, shooterX, shooterY, dirX, dirY);
      }

      a.step(dt);
      b.step(dt);
    }

    // Le scenario n'a de valeur que si les deux cotes portent vraiment des
    // projectiles a comparer — sinon la boucle ci-dessous ne verifie rien.
    expect(a.count).toBeGreaterThan(0);
    expect(b.count).toBe(a.count);
    for (let i = 0; i < a.count; i++) {
      expect(b.x[i]).toBeCloseTo(a.x[i] ?? 0, 6);
      expect(b.y[i]).toBeCloseTo(a.y[i] ?? 0, 6);
    }
  });

  /**
   * ⚠️ **AUCUN TEST NE PEUT prouver l'independance a la horde et aux zones
   * DEPUIS ICI — et c'est STRUCTUREL, pas une lacune.** `fireSalvoDirected`
   * et `#emit` (juste au-dessus dans `shared/projectiles.ts`) ne recoivent
   * ni `horde` ni `zones` DANS LEUR SIGNATURE, et le constructeur de
   * `Projectiles` ne garde de reference vers aucun des deux : rien dans
   * cette classe ne peut seulement les NOMMER, encore moins les lire.
   * L'independance est donc garantie AVANT tout test, par la forme du code
   * lui-meme — exactement le meme raisonnement que la borne `<= 0` de
   * `appliquerDegats` (`back/src/combat.ts`), dont le commentaire dit
   * *« aucun test ne peut la separer de `< 0` »* et explique pourquoi plutot
   * que de laisser croire a une borne testee.
   *
   * Une premiere version de ce test construisait deux `Horde` et deux
   * `ZoneField` deliberement DIFFERENTS des deux cotes (avec de vraies
   * assertions `not.toBe`), mais ne les passait JAMAIS a `fireSalvoDirected`
   * — impossible, sa signature ne les accepte pas. Le test etait donc
   * rigoureusement EQUIVALENT au test de determinisme ci-dessus : verifie
   * par mutation en revue (un `zones?` ajoute a `fireSalvoDirected`, qui
   * devie reellement l'angle emis, laissait les 24 tests de ce fichier
   * verts, celui-la y compris). Un test qui ne peut pas distinguer une
   * implementation correcte d'une implementation qui devie reellement ne
   * garde rien — il a ete retire plutot que remplace par une forme plus
   * elaboree mais tout aussi creuse.
   *
   * Ce qui protege reellement le contrat : ce docbloc, la signature de
   * `fireSalvoDirected`/`#emit`, et la revue de code a chaque changement de
   * signature — pas un test.
   */
});

describe('truncatedProjectiles — la salve qui ne part pas ne disparait pas en silence', () => {
  it('compte exactement ce qui manque, et rien tant que la place suffit', () => {
    // ⚠️ Ce compteur existe parce que l'empilement a leve la borne : chaque
    // exemplaire d'arme elargit la salve, et le plafond de `WEAPON_SLOTS` armes
    // ne borne plus rien. Une salve tronquee est une CARTE que le joueur a
    // payee et qui ne fait rien — ca ne doit jamais disparaitre sans trace.
    const arme = weaponOf(0);
    const p = new Projectiles(10);
    expect(p.truncatedProjectiles).toBe(0);

    // Sept projectiles dans dix places : rien ne manque.
    p.fireSalvoDirected(arme, 0, 0, 0, 1, 0, arme.damage, 7);
    expect(p.count).toBe(7);
    expect(p.truncatedProjectiles).toBe(0);

    // Cinq de plus pour trois places : il en manque exactement deux.
    p.fireSalvoDirected(arme, 1, 0, 0, 1, 0, arme.damage, 5);
    expect(p.count).toBe(10);
    expect(p.truncatedProjectiles).toBe(2);

    // Reservoir plein : la salve entiere manque, et le compteur CUMULE.
    p.fireSalvoDirected(arme, 2, 0, 0, 1, 0, arme.damage, 4);
    expect(p.count).toBe(10);
    expect(p.truncatedProjectiles).toBe(6);
  });
});

/**
 * Ce que le projectile porte POUR LE RENDU (etape 5a, tache 12) : l'arme qui
 * l'a tire, son compte a rebours, et sa direction de vol.
 *
 * ⚠️ **Rien de tout ceci n'entre dans la simulation.** `weaponAt` est le seul
 * champ purement cosmetique de la classe ; ce qui decide d'un degat, d'une
 * marque ou d'une zone reste recopie a cote (`damageAt`, `elementAt`,
 * `ownerAt`).
 */
describe('ce que le rendu lit sur un projectile', () => {
  it('retient l arme qui a tire, et distingue deux armes differentes', () => {
    const p = new Projectiles(8);
    p.fireSalvoDirected(SINGLE, 0, 0, 0, 1, 0, SINGLE.damage, 1);
    p.fireSalvoDirected(FAST, 0, 0, 0, 1, 0, FAST.damage, 1);

    // ⚠️ Les DEUX moities : un `weaponAt` qui rendrait toujours 0 passerait le
    // premier creneau seul.
    expect(p.weaponAt(0)).toBe(SINGLE.id);
    expect(p.weaponAt(1)).toBe(FAST.id);
    expect(SINGLE.id).not.toBe(FAST.id);
  });

  it('compacte l arme comme le reste quand un projectile disparait', () => {
    // `#removeAt` deplace le DERNIER projectile dans le creneau libere. Un
    // tableau oublie dans cette copie ferait porter a un projectile l'arme de
    // son predecesseur — donc la mauvaise apparence, pour toujours.
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 60, 0);
    expect(cible).toBeGreaterThanOrEqual(0);

    const p = new Projectiles(8);
    // Creneau 0 : SINGLE, dirige sur la cible. Creneau 1 : FAST, a l'oppose.
    p.fireSalvoDirected(SINGLE, 0, 0, 0, 1, 0, SINGLE.damage, 1);
    p.fireSalvoDirected(FAST, 0, 0, 0, -1, 0, FAST.damage, 1);
    p.step(1);
    p.collide(horde, () => undefined);

    expect(p.count).toBe(1);
    expect(p.weaponAt(0)).toBe(FAST.id);
  });

  it('rend le compte a rebours de vie, decremente a chaque pas', () => {
    // C'est LUI que `projectileAlpha` lit, et pas `tick - bornTick` : le rendu
    // n'a donc aucun tick a synchroniser avec la simulation.
    const p = new Projectiles(4);
    p.fireSalvoDirected(SINGLE, 0, 0, 0, 1, 0, SINGLE.damage, 1);
    expect(p.ticksRemainingAt(0)).toBe(SINGLE.projectileLifeTicks);

    p.step(0.01);
    expect(p.ticksRemainingAt(0)).toBe(SINGLE.projectileLifeTicks - 1);
    p.step(0.01);
    expect(p.ticksRemainingAt(0)).toBe(SINGLE.projectileLifeTicks - 2);
  });

  it('rend la direction de vol, et pas celle du voisin', () => {
    const p = new Projectiles(4);
    p.fireSalvoDirected(SINGLE, 0, 0, 0, 1, 0, SINGLE.damage, 1); // vers +x
    p.fireSalvoDirected(SINGLE, 0, 0, 0, 0, 1, SINGLE.damage, 1); // vers +y

    expect(p.headingAt(0)).toBeCloseTo(0, 6);
    expect(p.headingAt(1)).toBeCloseTo(Math.PI / 2, 6);
  });
});

/**
 * Étape 8 — **le rayon de touche suit le CORPS**, signale par l'auteur en
 * jouant : *« la hitbox des boss n'est pas correcte, trop petite »*.
 *
 * Il avait raison, et le chiffre le dit : le boss est DESSINE a
 * `2 x PROJECTILE_HIT_RADIUS x BODY_SCALE x bodyScale` = 240 px de diametre,
 * et `collide` lui opposait les memes 64 px de diametre qu'a un gobelin. Il
 * fallait viser le centre exact d'un corps qui remplit un quart d'ecran.
 *
 * ⚠️ `bodyScale` EXISTAIT DEJA et disait exactement cela : `BOSS_CHARGE_WIDTH_PX`
 * et `spriteScale` le lisent depuis l'etape 6a. Seule la collision l'ignorait —
 * c'est pourquoi la correction est une lecture de plus, pas une constante de
 * plus.
 */
describe('Projectiles.collide — le rayon de touche suit le corps de la cible', () => {
  const BOSS_R = PROJECTILE_HIT_RADIUS * archetypeOf(BOSS_ARCHETYPE).bodyScale;

  /** Tire un projectile IMMOBILE a `distance` du corps vise, et dit s'il touche. */
  function touche(archetype: number, distance: number): boolean {
    const horde = new Horde(10);
    addOne(horde, 1, 0, 0, archetype);
    const p = new Projectiles(8);
    const arme = weaponOf(0);
    // Vitesse nulle : le segment balaye est un point, donc la distance testee
    // est exactement `distance` — aucun balayage ne vient la masquer.
    p.fireSalvoDirected({ ...arme, projectileSpeed: 0 }, 0, 0, distance, 1, 0, arme.damage, 1);
    let touches = 0;
    p.collide(horde, () => {
      touches++;
    });
    return touches > 0;
  }

  it('oppose au boss un rayon TROIS fois celui de la pietaille', () => {
    expect(archetypeOf(BOSS_ARCHETYPE).bodyScale).toBeGreaterThan(1);
    expect(BOSS_R).toBeCloseTo(96, 6);
  });

  it('touche le boss bien au-dela du rayon de la pietaille', () => {
    // 80 px : hors des 32 px de la pietaille, largement dans le corps du boss.
    expect(touche(BOSS_ARCHETYPE, 80)).toBe(true);
    expect(touche(0, 80)).toBe(false);
  });

  it('garde la pietaille EXACTEMENT sur son rayon — rien n a grossi pour elle', () => {
    expect(touche(0, PROJECTILE_HIT_RADIUS - 1)).toBe(true);
    expect(touche(0, PROJECTILE_HIT_RADIUS + 1)).toBe(false);
  });

  it('s arrete au bord du corps du boss, sans le deborder', () => {
    expect(touche(BOSS_ARCHETYPE, BOSS_R - 1)).toBe(true);
    expect(touche(BOSS_ARCHETYPE, BOSS_R + 1)).toBe(false);
  });

  it('ajoute le bonus de Vif-argent AU rayon du boss, sans le remplacer', () => {
    const horde = new Horde(10);
    addOne(horde, 1, 0, 0, BOSS_ARCHETYPE);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.VIF_ARGENT, 0, 0, 0, 0);
    const arme = weaponOf(0);
    const dehors = BOSS_R + VIF_ARGENT_HIT_RADIUS_BONUS - 1;

    const sansZone = new Projectiles(8);
    sansZone.fireSalvoDirected({ ...arme, projectileSpeed: 0 }, 0, 0, dehors, 1, 0, arme.damage, 1);
    let sans = 0;
    sansZone.collide(horde, () => {
      sans++;
    });

    const avecZone = new Projectiles(8);
    avecZone.fireSalvoDirected({ ...arme, projectileSpeed: 0 }, 0, 0, dehors, 1, 0, arme.damage, 1);
    let avec = 0;
    avecZone.collide(
      horde,
      () => {
        avec++;
      },
      zones,
      0,
    );

    expect(sans).toBe(0);
    expect(avec).toBe(1);
  });
});

/**
 * Étape 8 — **le transpercage**, sur retour de jeu : *« l'arc lourd est nul, il
 * faudra peut-etre qu'il transperce les ennemis vu sa cadence de tir ? »*.
 *
 * Le releve lui donnait raison : 20,8 degats par seconde pour la cadence la
 * deuxieme plus lente du catalogue, sous la mediane. Et c'est son autre
 * extreme — 1 200 px de portee, le double de la dague — qui rend le
 * transpercage juste : c'est la seule arme dont le projectile traverse assez
 * de terrain pour rencontrer une FILE.
 */
describe('Projectiles.collide — transpercer', () => {
  /** Trois ennemis en file sur l'axe +x, espaces de `ecart`. */
  function fileDeTrois(ecart: number): Horde {
    const horde = new Horde(10);
    addOne(horde, 1, 200, 0);
    addOne(horde, 2, 200 + ecart, 0);
    addOne(horde, 3, 200 + 2 * ecart, 0);
    return horde;
  }

  /** Une arme a projectile unique, lente, qui traverse `pierce` ennemis de plus. */
  function perceur(pierce: number): Weapon {
    // ⚠️ Portee 533 px (400 px/s x 40 ticks) : elle doit couvrir la file
    // ENTIERE, sinon un projectile qui expire avant le dernier corps ferait
    // echouer le transpercage pour une raison qui n'est pas le transpercage.
    return { ...SINGLE, projectileSpeed: 400, projectileLifeTicks: 40, pierce };
  }

  /** Tire depuis l'origine vers +x et avance `pas` ticks, en notant chaque corps touche. */
  function traverse(arme: Weapon, horde: Horde, pas: number): number[] {
    const p = new Projectiles(8);
    p.fireSalvoDirected(arme, 0, 0, 0, 1, 0, arme.damage, 1);
    const touches: number[] = [];
    for (let i = 0; i < pas; i++) {
      p.step(1 / TICK_HZ);
      p.collide(horde, (entityId) => touches.push(entityId));
    }
    return touches;
  }

  it('traverse trois corps quand l arme en autorise deux de plus', () => {
    const touches = traverse(perceur(2), fileDeTrois(90), 60);
    expect(touches).toHaveLength(3);
    expect(new Set(touches).size).toBe(3);
  });

  it('s arrete au PREMIER corps quand l arme ne transperce pas', () => {
    // Le cas temoin : sans lui, un `collide` qui ne consommerait plus jamais
    // ses projectiles passerait le cas precedent.
    expect(traverse(perceur(0), fileDeTrois(90), 60)).toHaveLength(1);
  });

  it('ne frappe JAMAIS deux fois le meme corps', () => {
    // Une seule cible, une fleche a trois traversees : sans `#lastHit`, elle
    // lui infligerait quatre fois ses degats en restant collee dessus.
    const horde = new Horde(10);
    const seul = addOne(horde, 1, 200, 0);
    const touches = traverse(perceur(3), horde, 60);
    expect(touches).toEqual([seul]);
  });

  it('consomme UNE traversee par corps, pas une par tick', () => {
    // Quatre corps pour trois traversees : le quatrieme survit.
    const horde = new Horde(10);
    for (let i = 0; i < 4; i++) {
      addOne(horde, i + 1, 200 + i * 90, 0);
    }
    const touches = traverse(perceur(2), horde, 80);
    expect(touches).toHaveLength(3);
  });

  it('inflige ses degats PLEINS a chaque corps traverse', () => {
    const arme = perceur(2);
    const p = new Projectiles(8);
    p.fireSalvoDirected(arme, 0, 0, 0, 1, 0, arme.damage, 1);
    const horde = fileDeTrois(90);
    const degats: number[] = [];
    for (let i = 0; i < 60; i++) {
      p.step(1 / TICK_HZ);
      p.collide(horde, (_id, degat) => degats.push(degat));
    }
    expect(degats).toEqual([arme.damage, arme.damage, arme.damage]);
  });

  it('rend au catalogue une arme qui transperce, et une seule', () => {
    const perceuses = WEAPONS.filter((w) => w.pierce > 0);
    expect(perceuses.length).toBeGreaterThan(0);
    for (const w of perceuses) {
      // Le transpercage appartient aux armes LENTES a projectile unique : une
      // arme rapide qui traverse frapperait toute une file a chaque tick.
      expect(w.projectileCount, w.name).toBe(1);
      expect(w.cooldownTicks, w.name).toBeGreaterThanOrEqual(30);
    }
  });
});

/**
 * Étape 8 — **le tir circulaire**, demande par l'auteur : *« il faut varier les
 * types, pas que des projectiles… des tirs circulaires »*.
 *
 * ⚠️ **Aucun type d'arme de plus n'a ete ajoute** : une salve dont l'ouverture
 * fait un tour complet EST un anneau. Ce que ces cas gardent, c'est la seule
 * chose qui ait vraiment change — la REPARTITION, qui doit se fermer au lieu
 * de poser deux projectiles au meme endroit.
 */
describe('Projectiles — la salve en anneau', () => {
  /** Les caps des projectiles vivants, tries, ramenes a [0, 2π). */
  function caps(p: Projectiles): number[] {
    const tau = Math.PI * 2;
    return Array.from({ length: p.count }, (_, i) => ((p.headingAt(i) % tau) + tau) % tau).sort(
      (a, b) => a - b,
    );
  }

  const ROUE = { ...SINGLE, projectileCount: 8, spreadRadians: Math.PI * 2 };

  it('repartit les projectiles sur TOUT le tour, a pas egal', () => {
    const p = new Projectiles(32);
    p.fireSalvoDirected(ROUE, 0, 0, 0, 1, 0, ROUE.damage, ROUE.projectileCount);
    const angles = caps(p);
    expect(angles).toHaveLength(8);
    for (let i = 1; i < angles.length; i++) {
      expect((angles[i] ?? 0) - (angles[i - 1] ?? 0)).toBeCloseTo(Math.PI / 4, 6);
    }
  });

  it('FERME l anneau : aucun projectile n en double un autre', () => {
    // ⚠️ Le defaut que la repartition d'un arc ouvert (`i / (n - 1)`) aurait
    // produit : ses deux extremes tombent sur les bords, et sur un cercle les
    // deux bords sont le MEME angle — le dernier projectile se serait pose sur
    // le premier, et l'arme aurait tire sept lames en annoncant huit.
    const p = new Projectiles(32);
    p.fireSalvoDirected(ROUE, 0, 0, 0, 1, 0, ROUE.damage, ROUE.projectileCount);
    const arrondis = new Set(caps(p).map((a) => Math.round(a * 1000)));
    expect(arrondis.size).toBe(8);
  });

  it('ne touche PAS la repartition des salves en arc', () => {
    // Le temoin : une arme a dispersion etroite garde exactement la
    // repartition d'avant, bords compris.
    const arc = { ...SINGLE, projectileCount: 3, spreadRadians: Math.PI / 3 };
    const p = new Projectiles(32);
    p.fireSalvoDirected(arc, 0, 0, 0, 1, 0, arc.damage, arc.projectileCount);
    const angles = caps(p).map((a) => (a > Math.PI ? a - Math.PI * 2 : a));
    expect(angles.sort((x, y) => x - y)).toEqual([
      expect.closeTo(-Math.PI / 6, 6),
      expect.closeTo(0, 6),
      expect.closeTo(Math.PI / 6, 6),
    ]);
  });

  it('rend au catalogue une arme qui tire en anneau', () => {
    const anneaux = WEAPONS.filter((w) => w.spreadRadians >= Math.PI * 2);
    expect(anneaux.length).toBeGreaterThan(0);
    for (const w of anneaux) {
      // Un anneau n'a de sens qu'a plusieurs projectiles.
      expect(w.projectileCount, w.name).toBeGreaterThan(2);
    }
  });
});

/**
 * Étape 8 — **la mine**, quatrieme famille demandee par l'auteur. Comme
 * l'anneau, elle n'a demande aucun type d'arme : un projectile IMMOBILE a
 * souffle est une mine, et `collide` est deja un detecteur de proximite.
 */
describe('Projectiles — la mine, un projectile qui ne part pas', () => {
  const MINE: Weapon = {
    ...SINGLE,
    projectileSpeed: 0,
    projectileLifeTicks: 240,
    blastRadius: 60,
  };

  it('reste EXACTEMENT ou on la pose, pas de pas en pas', () => {
    const p = new Projectiles(8);
    p.fireSalvoDirected(MINE, 0, 300, 400, 1, 0, MINE.damage, 1);
    for (let i = 0; i < 60; i++) {
      p.step(1 / TICK_HZ);
    }
    expect(p.x[0]).toBe(300);
    expect(p.y[0]).toBe(400);
  });

  it('ne saute QUE si un corps s approche', () => {
    // ⚠️ Le detecteur, c'est `PROJECTILE_HIT_RADIUS` autour d'elle — le meme
    // que pour un projectile en vol, applique a un segment degenere en point.
    const loin = new Horde(10);
    addOne(loin, 1, 300 + PROJECTILE_HIT_RADIUS + 5, 400);
    const pLoin = new Projectiles(8);
    pLoin.fireSalvoDirected(MINE, 0, 300, 400, 1, 0, MINE.damage, 1);
    pLoin.step(1 / TICK_HZ);
    let touches = 0;
    pLoin.collide(loin, () => {
      touches++;
    });
    expect(touches).toBe(0);
    expect(pLoin.count).toBe(1);

    const pres = new Horde(10);
    addOne(pres, 1, 300 + PROJECTILE_HIT_RADIUS - 5, 400);
    const pPres = new Projectiles(8);
    pPres.fireSalvoDirected(MINE, 0, 300, 400, 1, 0, MINE.damage, 1);
    pPres.step(1 / TICK_HZ);
    pPres.collide(pres, () => {
      touches++;
    });
    expect(touches).toBe(1);
    // Et elle est consommee en sautant : une mine ne saute qu'une fois.
    expect(pPres.count).toBe(0);
  });

  it('expire si personne ne marche dessus', () => {
    const p = new Projectiles(8);
    p.fireSalvoDirected(MINE, 0, 300, 400, 1, 0, MINE.damage, 1);
    for (let i = 0; i < MINE.projectileLifeTicks; i++) {
      p.step(1 / TICK_HZ);
    }
    expect(p.count).toBe(0);
  });

  it('ne tracte AUCUNE trainee : sa longueur est un produit par la vitesse', () => {
    expect(projectileTrailPx(MINE)).toBe(0);
  });

  it('rend au catalogue une arme qui se pose, et elle emporte un souffle', () => {
    const mines = WEAPONS.filter((w) => w.projectileSpeed === 0);
    expect(mines.length).toBeGreaterThan(0);
    for (const w of mines) {
      expect(w.blastRadius, w.name).toBeGreaterThan(0);
      // Elle doit ATTENDRE : une mine a la duree de vie d'un tir ne serait
      // qu'un coup rate.
      expect(w.projectileLifeTicks, w.name).toBeGreaterThan(100);
    }
  });
});

/**
 * Étape 8 — **le souffle de fin de course**, signale en jouant : *« la grenade
 * doit exploser en fin de course meme si elle touche personne »*.
 *
 * Ce que `Projectiles` apporte ici est le RAPPEL ; ce qu'il emporte est decide
 * par l'appelant (`resolveProjectileDamage`, back/src/combat.ts).
 */
describe('Projectiles.step — le rappel de fin de course', () => {
  it('rend la main sur CHAQUE projectile qui s eteint, et une seule fois', () => {
    const arme = { ...SINGLE, projectileLifeTicks: 3 };
    const p = new Projectiles(8);
    p.fireSalvoDirected(arme, 0, 0, 0, 1, 0, arme.damage, 2);
    const expires: number[] = [];
    for (let i = 0; i < 10; i++) {
      p.step(1 / TICK_HZ, () => expires.push(i));
    }
    // Les deux projectiles s'eteignent au meme pas, et plus rien ensuite.
    expect(expires).toHaveLength(2);
    expect(new Set(expires).size).toBe(1);
  });

  it('laisse LIRE le projectile avant de le retirer', () => {
    // ⚠️ C'est toute la raison d'etre du rappel : au moment ou il est appele,
    // le creneau porte encore la position, le souffle et les degats de ce qui
    // vient de s'eteindre. Appele apres `#removeAt`, il n'aurait rien a lire.
    const arme = { ...SINGLE, projectileLifeTicks: 2, blastRadius: 40, projectileSpeed: 600 };
    const p = new Projectiles(8);
    p.fireSalvoDirected(arme, 0, 100, 200, 1, 0, arme.damage, 1);
    const vus: { x: number; souffle: number; degats: number }[] = [];
    for (let i = 0; i < 4; i++) {
      p.step(1 / TICK_HZ, (slot) => {
        vus.push({
          x: p.x[slot] ?? 0,
          souffle: p.blastRadiusAt(slot),
          degats: p.damageAt(slot),
        });
      });
    }
    expect(vus).toHaveLength(1);
    expect(vus[0]?.souffle).toBe(40);
    expect(vus[0]?.degats).toBe(arme.damage);
    // Et la position est celle du DERNIER pas, pas celle du tir.
    expect(vus[0]?.x).toBeGreaterThan(100);
  });

  it('ne rappelle RIEN sans projectile expire', () => {
    const arme = { ...SINGLE, projectileLifeTicks: 40 };
    const p = new Projectiles(8);
    p.fireSalvoDirected(arme, 0, 0, 0, 1, 0, arme.damage, 1);
    let appels = 0;
    for (let i = 0; i < 5; i++) {
      p.step(1 / TICK_HZ, () => {
        appels++;
      });
    }
    expect(appels).toBe(0);
    expect(p.count).toBe(1);
  });

  it('reste optionnel : l appelant qui s en moque ne le passe pas', () => {
    const arme = { ...SINGLE, projectileLifeTicks: 1 };
    const p = new Projectiles(8);
    p.fireSalvoDirected(arme, 0, 0, 0, 1, 0, arme.damage, 1);
    expect(() => p.step(1 / TICK_HZ)).not.toThrow();
    expect(p.count).toBe(0);
  });
});

describe('Projectiles — le calibre elargit le rayon de touche', () => {
  it('un projectile grossi touche un ennemi que le projectile normal frole', () => {
    // Juste au-dela du rayon de base, dans le rayon d'un projectile x1,5.
    const ecart = PROJECTILE_HIT_RADIUS + 8;
    const essai = (scale: number): number[] => {
      const horde = new Horde(10);
      const cible = addOne(horde, 1, 1000, 0);
      const victime = addOne(horde, 2, 100, ecart);
      const p = new Projectiles(10);
      p.fireSalvo({ ...SINGLE, projectileScale: scale }, 0, 0, 0, cible, horde);
      p.step(1);
      const touches: number[] = [];
      p.collide(horde, (id) => touches.push(id));
      expect(touches.every((id) => id === victime)).toBe(true);
      return touches;
    };
    expect(essai(1)).toEqual([]);
    expect(essai(1.5)).toHaveLength(1);
  });

  it('recopie echelle et venin sur le projectile a l emission', () => {
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 0);
    const p = new Projectiles(10);
    p.fireSalvo({ ...SINGLE, projectileScale: 1.3, venom: 0.4 }, 0, 0, 0, cible, horde);
    expect(p.scaleAt(0)).toBeCloseTo(1.3, 5);
    expect(p.venomAt(0)).toBeCloseTo(0.4, 5);
  });
});

describe('Projectiles — guidage et ricochet', () => {
  it('un projectile guide tourne vers l ennemi, un projectile droit non', () => {
    const vise = (homing: number): number => {
      const horde = new Horde(10);
      const cible = addOne(horde, 1, 1000, 0); // tir vers +x
      addOne(horde, 2, 200, 200); // la proie, en diagonale
      const p = new Projectiles(10);
      p.fireSalvo({ ...SINGLE, homing }, 0, 0, 0, cible, horde);
      horde.x[0] = 5000; // la cible de visee s'eloigne : seule la proie reste a portee
      for (let t = 0; t < 5; t++) {
        p.step(1 / TICK_HZ, undefined, horde);
      }
      return p.headingAt(0);
    };
    expect(vise(0)).toBeCloseTo(0, 5);
    // Vers la proie (+y), mais jamais plus vite que `homing` rad/s.
    const tourne = vise(3);
    expect(tourne).toBeGreaterThan(0);
    expect(tourne).toBeLessThanOrEqual((3 * 5) / TICK_HZ + 1e-6);
  });

  it('un projectile qui ricoche repart vers un voisin, degats pleins, et s use', () => {
    const horde = new Horde(10);
    const premier = addOne(horde, 1, 100, 0);
    const voisin = addOne(horde, 2, 100, 150);
    const p = new Projectiles(10);
    // Une vitesse de vraie arme : a 100 px/s, `SINGLE` n'atteindrait pas le voisin.
    p.fireSalvo({ ...SINGLE, bounces: 1, projectileSpeed: 600 }, 0, 0, 0, premier, horde);
    const touches: number[] = [];
    p.step(1); // segment (0,0) -> au-dela du premier
    p.collide(horde, (id) => touches.push(id));
    expect(touches).toEqual([premier]);
    expect(p.count).toBe(1);
    // Il file maintenant vers le voisin, plein +y.
    expect(p.headingAt(0)).toBeCloseTo(Math.PI / 2, 1);
    for (let t = 0; t < 30 && p.count > 0; t++) {
      p.step(1 / TICK_HZ);
      p.collide(horde, (id) => touches.push(id));
    }
    expect(touches).toEqual([premier, voisin]);
    // Plus de rebond : consomme sur le voisin.
    expect(p.count).toBe(0);
  });

  it('sans voisin a portee, le ricochet ne sauve pas le projectile', () => {
    const horde = new Horde(10);
    const seul = addOne(horde, 1, 100, 0);
    const p = new Projectiles(10);
    p.fireSalvo({ ...SINGLE, bounces: 2 }, 0, 0, 0, seul, horde);
    p.step(1);
    p.collide(horde, () => undefined);
    expect(p.count).toBe(0);
  });
});

/**
 * Étape 8 — **les coups critiques**, demandes par l'auteur : *« un systeme de
 * crit peut-etre aussi ? »*.
 *
 * Ce que ces cas gardent n'est pas la chance elle-meme (un reglage), c'est ce
 * qui rend le critique AFFICHABLE : il est decide a l'emission, par une
 * fonction des trois entiers que les deux cotes possedent, donc le client peut
 * montrer le chiffre que le serveur va arbitrer.
 */
describe('Projectiles — le coup critique', () => {
  /** Les critiques d'une salve de `count` projectiles tiree au tick `tick` par `by`. */
  function salve(tick: number, by: number, count: number): boolean[] {
    const p = new Projectiles(64);
    const arme = { ...SPREAD, projectileCount: count };
    p.fireSalvoDirected(arme, tick, 0, 0, 1, 0, arme.damage, count, by);
    return Array.from({ length: p.count }, (_, i) => p.critAt(i));
  }

  it('rend le MEME resultat pour le meme tir : deux instances independantes concordent', () => {
    // ⚠️ C'est toute la propriete : le serveur et le client emettent la meme
    // salve et doivent en tirer les memes critiques, sans rien s'annoncer.
    expect(salve(1234, 3, 8)).toEqual(salve(1234, 3, 8));
  });

  it('ne fait PAS criter toute une salve d un bloc', () => {
    // Sans le rang du projectile dans le melange, les huit partageraient leur
    // tirage — un coup critique deviendrait une salve critique.
    const longue = salve(77, 1, 40);
    expect(new Set(longue).size).toBe(2);
  });

  it('change avec le TICK, le TIREUR et le rang', () => {
    expect(salve(10, 1, 12)).not.toEqual(salve(11, 1, 12));
    expect(salve(10, 1, 12)).not.toEqual(salve(10, 2, 12));
  });

  it('tombe pres de la chance annoncee sur un grand nombre de tirs', () => {
    let crits = 0;
    let total = 0;
    for (let tick = 0; tick < 500; tick++) {
      for (const c of salve(tick, tick % 4, 8)) {
        total++;
        if (c) {
          crits++;
        }
      }
    }
    // ⚠️ Une fourchette LARGE : ce cas garde que le tirage n'est ni toujours
    // vrai ni toujours faux, pas que le melange soit un bon generateur — le
    // jour ou la chance devient un passif, c'est la valeur qui bougera, pas
    // cette propriete.
    expect(crits / total).toBeGreaterThan(CRIT_CHANCE / 2);
    expect(crits / total).toBeLessThan(CRIT_CHANCE * 2);
  });

  it('suit le projectile jusqu a son impact, compaction comprise', () => {
    // ⚠️ `#removeAt` deplace le DERNIER projectile dans le creneau libere : un
    // `#crit` oublie dans cette copie ferait porter au survivant le tirage du
    // mort.
    const p = new Projectiles(16);
    const arme = { ...SPREAD, projectileCount: 12 };
    p.fireSalvoDirected(arme, 99, 0, 0, 1, 0, arme.damage, 12, 1);
    const avant = Array.from({ length: p.count }, (_, i) => p.critAt(i));
    const horde = new Horde(10);
    addOne(horde, 1, 0, 0);
    p.collide(horde, () => undefined);
    // Le creneau 0 a ete comble par le dernier : son critique doit l'avoir
    // suivi.
    expect(p.critAt(0)).toBe(avant[avant.length - 1]);
  });
});
