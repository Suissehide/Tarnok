import { describe, expect, it } from 'vitest';

import { PROJECTILE_HIT_RADIUS, TICK_HZ, VIF_ARGENT_HIT_RADIUS_BONUS } from './constants';
import { ELEMENT } from './elements';
import { Horde } from './horde';
import { Projectiles } from './projectiles';
import { FORMATION, type WaveOrder } from './waves';
import type { Weapon } from './weapons';
import { weaponOf } from './weapons';
import { ZoneField } from './zones';

/**
 * Fait apparaitre une seule entite, avec un `waveId` choisi explicitement
 * pour controler son identifiant — meme technique que `targeting.test.ts`.
 */
function addOne(horde: Horde, waveId: number, x: number, y: number): number {
  const order: WaveOrder = {
    waveId,
    spawnTick: 0,
    seed: 1,
    archetype: 0,
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
  // Trois apparences DIFFERENTES entre les trois armes de test : c'est ce qui
  // permet aux cas de `weaponAt` ci-dessous de distinguer laquelle a tire.
  look: { shape: 'lame', diameterPx: 10, tint: 0x111111, glow: 0.2, trailTicks: 1 },
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
  look: { shape: 'petale', diameterPx: 12, tint: 0x222222, glow: 0.4, trailTicks: 1 },
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
  look: { shape: 'fleche', diameterPx: 14, tint: 0x333333, glow: 0.6, trailTicks: 2 },
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
   * ⚠️ **Le vrai test — celui que l'ancien `describe('Projectiles —
   * derivation')` ne pouvait pas rendre**, parce que ses deux cotes
   * construisaient la MEME horde : il prouvait le determinisme A HORDE
   * EGALE, jamais l'INDEPENDANCE. Ici, les deux cotes portent des hordes
   * DIFFERENTES (2 entites contre 5, positions differentes) ET des zones
   * DIFFERENTES (une zone de Vif-argent d'un cote, aucune de l'autre) — et
   * les trajectoires doivent rester IDENTIQUES malgre ca, puisque
   * `fireSalvoDirected` (voir son parametre : `weapon, tick, x, y, dirX,
   * dirY, damage, count` — jamais `horde` ni `zones`) et `step` n'en lisent
   * aucune.
   *
   * ⚠️ **Garde de non-vacuite, meme reflexe que le test ci-dessus** : les
   * deux cotes portent reellement des projectiles vivants a la fin, ET les
   * hordes/zones sont reellement differentes — sans quoi une implementation
   * qui ignorerait purement et simplement ses deux arguments passerait ce
   * test aussi bien qu'une implementation correcte.
   */
  it('une trajectoire ne depend NI de la horde NI des zones', () => {
    function buildDivergentSide(entityCount: number, poserUneZoneVifArgent: boolean) {
      const horde = new Horde(20);
      for (let i = 0; i < entityCount; i++) {
        addOne(horde, i + 1, 100 + i * 10, 0);
      }
      const zones = new ZoneField();
      if (poserUneZoneVifArgent) {
        zones.spawn(ELEMENT.VIF_ARGENT, 100, 0, 0, 0);
      }
      return { horde, zones, projectiles: new Projectiles(200) };
    }

    // Cote A : 2 entites, une zone de Vif-argent. Cote B : 5 entites,
    // AUCUNE zone. Deux hordes et deux jeux de zones deliberement
    // differents.
    const a = buildDivergentSide(2, true);
    const b = buildDivergentSide(5, false);
    expect(a.horde.count).not.toBe(b.horde.count);
    expect(a.zones.count).not.toBe(b.zones.count);

    const dt = 1 / 30;
    const TICKS = 33;

    for (let tick = 0; tick < TICKS; tick++) {
      const shooterX = tick * 5;
      const shooterY = Math.sin(tick * 0.3) * 20;
      const angle = tick * 0.2;
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);

      if (tick % SINGLE.cooldownTicks === 0) {
        a.projectiles.fireSalvoDirected(SINGLE, tick, shooterX, shooterY, dirX, dirY);
        b.projectiles.fireSalvoDirected(SINGLE, tick, shooterX, shooterY, dirX, dirY);
      }
      if (tick % SPREAD.cooldownTicks === 0) {
        a.projectiles.fireSalvoDirected(SPREAD, tick, shooterX, shooterY, dirX, dirY);
        b.projectiles.fireSalvoDirected(SPREAD, tick, shooterX, shooterY, dirX, dirY);
      }

      a.projectiles.step(dt);
      b.projectiles.step(dt);
    }

    expect(a.projectiles.count).toBeGreaterThan(0);
    expect(b.projectiles.count).toBe(a.projectiles.count);
    for (let i = 0; i < a.projectiles.count; i++) {
      expect(b.projectiles.x[i]).toBeCloseTo(a.projectiles.x[i] ?? 0, 6);
      expect(b.projectiles.y[i]).toBeCloseTo(a.projectiles.y[i] ?? 0, 6);
    }
  });
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
