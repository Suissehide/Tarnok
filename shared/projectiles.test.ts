import { describe, expect, it } from 'vitest';

import { PROJECTILE_HIT_RADIUS, TICK_HZ } from './constants';
import { Horde } from './horde';
import { Projectiles } from './projectiles';
import { FORMATION, type WaveOrder } from './waves';
import type { Weapon } from './weapons';
import { weaponOf } from './weapons';

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

describe('Projectiles — derivation', () => {
  it('tire aux memes ticks des deux cotes, sans qu aucun evenement ne transite', () => {
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

describe('truncatedProjectiles — la salve qui ne part pas ne disparait pas en silence', () => {
  it('compte exactement ce qui manque, et rien tant que la place suffit', () => {
    // ⚠️ Ce compteur existe parce que l'empilement a leve la borne : chaque
    // exemplaire d'arme elargit la salve, et le plafond de cinq armes ne borne
    // plus rien. Une salve tronquee est une CARTE que le joueur a payee et qui
    // ne fait rien — ca ne doit jamais disparaitre sans trace.
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
