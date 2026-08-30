import { MAP_SIZE, MARK_DURATION_TICKS, PROJECTILE_HIT_RADIUS } from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import { Horde } from '@shared/horde';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { Container, type Particle, type ParticleContainer, Texture, TextureSource } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import { BODY_SCALE } from './horde-renderer';
import {
  MARK_RING_ALPHA,
  MARK_RING_DIAMETER_PX,
  MARK_RING_FOOT_OFFSET_PX,
  MARK_RING_TEXTURE_DIAMETER,
  MarkRingRenderer,
  ringGrid,
  ringGridCells,
  selectMarkedRings,
} from './mark-renderer';
import { type ViewBounds, ZONE_ALPHA } from './zone-renderer';

/**
 * Tache 13 de l'etape 5a, venue de l'auteur en jouant : *« je ne vois pas la
 * marque sur les ennemis, fais un anneau sous leurs pieds plutot que changer
 * leur couleur »*.
 *
 * Trois choses se gardent ici, et une seule etait dans le brief :
 * 1. **qui** recoit un anneau (marque, dans le cadre) — `selectMarkedRings` ;
 * 2. **combien** d'anneaux au pire — la borne de surface, mesuree plus bas ;
 * 3. **ou** se pose l'anneau — sous les pieds, pas sur la position, ce que la
 *    tache 14 vient de rendre necessaire en recentrant le corps.
 */

const TICK = 100;
/** Un ecran 1920x1080, ecrase de 0,82 en y comme `Stage.viewRect` le fait. */
const SCREEN_W = 1920;
const SCREEN_H = 1080 / 0.82;

/** Une vue centree sur un point du monde, de la taille d'un vrai ecran. */
function screenAt(cx: number, cy: number): ViewBounds {
  return { x: cx - SCREEN_W / 2, y: cy - SCREEN_H / 2, width: SCREEN_W, height: SCREEN_H };
}

/** Une vue qui couvre toute la carte : le culling ne doit alors rien retirer. */
const TOUTE_LA_CARTE: ViewBounds = { x: 0, y: 0, width: MAP_SIZE, height: MAP_SIZE };

/**
 * Une horde dont les positions sont POSEES, pas simulees : `spawn` disperse ses
 * entites au hasard de la formation, et tout ce fichier parle de geometrie a
 * quelques pixels pres.
 */
function hordeAt(points: readonly { x: number; y: number }[]): Horde {
  const horde = new Horde(Math.max(4, points.length));
  const order: WaveOrder = {
    waveId: 1,
    spawnTick: 0,
    seed: 3,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: 3000,
    anchorY: 3000,
    count: points.length,
  };
  horde.spawn(order);
  points.forEach((p, i) => {
    horde.x[i] = p.x;
    horde.y[i] = p.y;
  });
  return horde;
}

/** Les creneaux retenus, dans l'ordre, avec des tampons dimensionnes comme le renderer le fait. */
function selection(horde: Horde, view: ViewBounds, tick = TICK): number[] {
  const grid = ringGrid(view);
  const cells = ringGridCells(grid);
  const out = new Int32Array(cells);
  const count = selectMarkedRings(horde, tick, view, grid, new Uint8Array(cells), out);
  return [...out.slice(0, count)];
}

describe('selectMarkedRings — qui recoit un anneau', () => {
  it('retient un ennemi marque, et rend son creneau', () => {
    const horde = hordeAt([{ x: 3000, y: 3000 }]);
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);

    expect(selection(horde, TOUTE_LA_CARTE)).toEqual([0]);
  });

  /**
   * ⚠️ **L'autre moitie** (R24/R25) : sans elle, un `selectMarkedRings` qui
   * retiendrait TOUTE la horde passerait le cas ci-dessus sans rien garder — et
   * l'anneau deviendrait une ombre portee universelle au lieu d'une marque.
   */
  it('ecarte un ennemi NON marque, dans le meme decor', () => {
    const horde = hordeAt([
      { x: 3000, y: 3000 },
      { x: 3200, y: 3000 },
    ]);
    horde.applyMark(1, ELEMENT.BRAISE, 1, TICK);

    expect(selection(horde, TOUTE_LA_CARTE)).toEqual([1]);
  });

  /**
   * ⚠️ **`markAt`, jamais `horde.mark`.** Rien ne balaie le tableau des marques
   * a l'expiration : c'est `markUntil` compare au tick courant qui decide, des
   * deux cotes du fil. Un renderer qui lirait `horde.mark` laisserait l'anneau
   * allume pour toujours — la meme classe de defaut que « dessiner
   * `zones.count` au lieu de `aliveAt` », attrapee a la tache 9.
   *
   * Les bornes se derivent de `MARK_DURATION_TICKS`, jamais recopiees : c'est
   * un reglage de la tache 11, et un test qui le figerait garderait une valeur.
   */
  it('garde l anneau jusqu au dernier tick de la marque, et pas un de plus', () => {
    const horde = hordeAt([{ x: 3000, y: 3000 }]);
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);

    expect(selection(horde, TOUTE_LA_CARTE, TICK + MARK_DURATION_TICKS - 1)).toEqual([0]);
    expect(selection(horde, TOUTE_LA_CARTE, TICK + MARK_DURATION_TICKS)).toEqual([]);
  });

  it('ecarte un ennemi marque hors du cadre, et garde celui qui y est', () => {
    const horde = hordeAt([
      { x: 3000, y: 3000 },
      { x: 3000 + SCREEN_W, y: 3000 },
    ]);
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);
    horde.applyMark(1, ELEMENT.BRAISE, 1, TICK);

    expect(selection(horde, screenAt(3000, 3000))).toEqual([0]);
  });

  /**
   * L'anneau se pose PLUS BAS que l'ennemi (`MARK_RING_FOOT_OFFSET_PX`) : un
   * ennemi dont la position vient de sortir par le haut du cadre a donc encore
   * son anneau dedans. C'est ce que la marge de culling couvre, et le decor la
   * met a l'epreuve juste au-dessus du bord.
   */
  it('garde un ennemi juste hors cadre dont l anneau, pose plus bas, mord encore dedans', () => {
    const view = screenAt(3000, 3000);
    const horde = hordeAt([{ x: 3000, y: view.y - MARK_RING_FOOT_OFFSET_PX / 2 }]);
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);

    expect(selection(horde, view)).toEqual([0]);
  });
});

/**
 * ⚠️ **La borne de coût, et c'est le point de la tache.**
 *
 * Le §6.6 de l'orientation donnait la teinte de sprite comme gratuite et
 * reservait l'anneau au cas « deux elements avant reaction » ; un anneau par
 * ennemi marque coute un quad par ennemi marque. Mesure avec la simulation
 * reelle (decor de `bench/steering.bench.ts`, 600 ticks de convergence) :
 *
 * | Entites | Rayon median | Dans un cadre 1920x1080 |
 * | --- | --- | --- |
 * | 1 500 | 230 px | **1 500** |
 * | 4 000 | 368 px | **4 000** |
 *
 * **Le culling ne borne rien** quand la horde converge sur le joueur : elle
 * tient tout entiere dans le plus petit ecran. La borne est donc la SURFACE —
 * au plus un anneau par cellule au pas de l'anneau — exactement comme la
 * tache 4 a rendu le nombre de zones fonction de la surface couverte et non de
 * la cadence de tir.
 */
describe('selectMarkedRings — le cout, borne par la surface et non par la horde', () => {
  /** Un carre plein d'ennemis TOUS marques, cale sur une frontiere de cellule. */
  function nappe(side: number, spacing: number): { horde: Horde; cotePx: number } {
    const origin = 40 * MARK_RING_DIAMETER_PX;
    const points: { x: number; y: number }[] = [];
    for (let row = 0; row < side; row++) {
      for (let col = 0; col < side; col++) {
        points.push({ x: origin + col * spacing, y: origin + row * spacing });
      }
    }
    const horde = hordeAt(points);
    for (let i = 0; i < points.length; i++) {
      horde.applyMark(i, ELEMENT.BRAISE, 1, TICK);
    }
    return { horde, cotePx: (side - 1) * spacing };
  }

  /**
   * Ce qu'une nappe de `cotePx` de cote doit coûter : **un anneau par cellule
   * qu'elle couvre**, et rien de plus. Derive de `MARK_RING_DIAMETER_PX`, qui
   * est le pas de la grille — un test qui recopierait le pas laisserait passer
   * exactement la mutation qui l'elargit ou le retrecit, donc qui multiplie ou
   * divise la borne de coût sans qu'on le voie.
   */
  function anneauxAttendus(cotePx: number): number {
    return (Math.floor(cotePx / MARK_RING_DIAMETER_PX) + 1) ** 2;
  }

  it('ne pose jamais deux anneaux dans la meme cellule, et en pose deux de part et d autre', () => {
    const frontiere = 41 * MARK_RING_DIAMETER_PX;
    const memeCellule = hordeAt([
      { x: frontiere + 4, y: 3000 },
      { x: frontiere + 6, y: 3000 },
    ]);
    memeCellule.applyMark(0, ELEMENT.BRAISE, 1, TICK);
    memeCellule.applyMark(1, ELEMENT.BRAISE, 1, TICK);
    expect(selection(memeCellule, TOUTE_LA_CARTE)).toEqual([0]);

    const deuxCellules = hordeAt([
      { x: frontiere - 4, y: 3000 },
      { x: frontiere + 6, y: 3000 },
    ]);
    deuxCellules.applyMark(0, ELEMENT.BRAISE, 1, TICK);
    deuxCellules.applyMark(1, ELEMENT.BRAISE, 1, TICK);
    expect(selection(deuxCellules, TOUTE_LA_CARTE)).toEqual([0, 1]);
  });

  /**
   * ⚠️ **LE test de ce fichier.** Deux hordes qui couvrent la MEME surface, la
   * seconde quatre fois plus dense que la premiere : le nombre d'anneaux ne
   * bouge pas. C'est ce qu'un plafond dur — un `MARK_RING_CAPACITY` avec son
   * compteur de troncature — n'aurait pas donne : il aurait bien borne le
   * compte, mais en jetant des anneaux au hasard de l'ordre des creneaux, donc
   * en concentrant les survivants la ou les creneaux sont bas.
   */
  it('rend le meme compte pour quatre fois plus d ennemis sur la meme surface', () => {
    const view = screenAt(40 * MARK_RING_DIAMETER_PX + 512, 40 * MARK_RING_DIAMETER_PX + 512);
    const clairsemee = nappe(32, MARK_RING_DIAMETER_PX / 2);
    const dense = nappe(64, MARK_RING_DIAMETER_PX / 4);
    expect(dense.horde.count).toBe(4 * clairsemee.horde.count);

    const anneauxClairsemee = selection(clairsemee.horde, view).length;
    const anneauxDense = selection(dense.horde, view).length;

    process.stdout.write(
      `[tache 13] pire cas : ${dense.horde.count} ennemis tous marques -> ${anneauxDense} anneaux ` +
        `(plafond de surface : ${ringGridCells(ringGrid(view))} cellules pour un ecran ` +
        `${SCREEN_W}x1080)\n`,
    );

    // Exactement une cellule couverte, un anneau : c'est la borne elle-meme,
    // pas seulement un « moins que le nombre d'ennemis ».
    expect(anneauxClairsemee).toBe(anneauxAttendus(clairsemee.cotePx));
    expect(anneauxDense).toBe(anneauxAttendus(dense.cotePx));
    expect(anneauxDense).toBe(anneauxClairsemee);
    expect(anneauxDense).toBeLessThan(dense.horde.count);
    expect(anneauxDense).toBeLessThanOrEqual(ringGridCells(ringGrid(view)));
  });

  /**
   * ⚠️ **La grille est ancree sur le MONDE, pas sur le coin de la vue.** Calee
   * sur la camera, son decoupage glisserait a chaque image des que le joueur
   * bouge, donc l'ennemi retenu dans chaque cellule changerait : une nappe
   * d'anneaux qui scintille sans qu'aucune marque ne change.
   *
   * Les deux abscisses encadrent une frontiere de cellule du MONDE (donc deux
   * anneaux, quelle que soit la camera) mais tombent dans la meme cellule d'une
   * grille calee sur la premiere vue — un decalage de 18 px suffit alors a les
   * separer, et le compte changerait d'une camera a l'autre.
   */
  it('rend la MEME selection quand la camera bouge sans que rien d autre ne change', () => {
    const frontiere = 41 * MARK_RING_DIAMETER_PX;
    const horde = hordeAt([
      { x: frontiere - 4, y: 3000 },
      { x: frontiere + 6, y: 3000 },
    ]);
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);
    horde.applyMark(1, ELEMENT.BRAISE, 1, TICK);

    const camera = screenAt(3000, 3000);
    const cameraDecalee = { ...camera, x: camera.x + 18 };

    expect(selection(horde, camera)).toEqual([0, 1]);
    expect(selection(horde, cameraDecalee)).toEqual(selection(horde, camera));
  });
});

/**
 * Le corps de `draw`, atteint par `adoptTexture` — meme point d'accroche que
 * `HordeRenderer.adoptAtlas` (tache 9 bis) et `ProjectileRenderer.adoptTextures`
 * (tache 12), et pour la meme raison : `load()` cuit sa texture sur un canevas
 * 2D que ni node ni jsdom ne fournissent, donc `draw` retournerait a son premier
 * `if (!texture)` et tout son corps pourrait etre retire en silence.
 */
function drawnRings(horde: Horde, view: ViewBounds = TOUTE_LA_CARTE): Particle[] {
  const renderer = new MarkRingRenderer();
  renderer.adoptTexture(
    new Texture({
      source: new TextureSource({
        width: MARK_RING_TEXTURE_DIAMETER,
        height: MARK_RING_TEXTURE_DIAMETER,
      }),
    }),
  );

  const world = new Container();
  renderer.attach(world);
  renderer.draw(horde, TICK, view);

  const container = world.children[0] as ParticleContainer;
  return [...(container.particleChildren as Particle[])];
}

describe('MarkRingRenderer.draw — l anneau arrive bien sous les pieds', () => {
  /** Deux ennemis loin l'un de l'autre : jamais dans la meme cellule de grille. */
  function deuxEnnemis(): Horde {
    return hordeAt([
      { x: 3000, y: 3000 },
      { x: 3400, y: 3000 },
    ]);
  }

  it('dessine un anneau pour l ennemi marque, et aucun pour l autre', () => {
    const horde = deuxEnnemis();
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);

    const rings = drawnRings(horde);
    expect(rings).toHaveLength(1);
    expect(rings[0]?.x).toBe(horde.x[0]);
  });

  /**
   * ⚠️ **La rencontre des taches 13 et 14, et la raison de leur ordre.** Tant
   * que l'ancre du sprite valait 0,75, les pieds etaient SUR la position et un
   * anneau pose a `horde.y` tombait juste. Depuis que le corps est centre
   * (`BODY_ANCHOR_Y = 0,5`), les pieds sont une demi-hauteur de corps plus bas —
   * et un anneau reste a `horde.y` ceinturerait le ventre.
   *
   * L'attendu se derive des deux constantes qui decident la taille dessinee du
   * corps, jamais d'un 40 recopie.
   */
  it('pose l anneau SOUS la position, d une demi-hauteur de corps', () => {
    const horde = deuxEnnemis();
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);

    const ring = drawnRings(horde)[0];
    expect(ring?.y).toBeGreaterThan(horde.y[0] ?? 0);
    expect((ring?.y ?? 0) - (horde.y[0] ?? 0)).toBeCloseTo(PROJECTILE_HIT_RADIUS * BODY_SCALE, 6);
  });

  /**
   * ⚠️ **Derive de la hitbox de tir, jamais reglee a la main** — la lecon de
   * `spriteScale` (tache 16) et de `zoneScale`. L'anneau dit deux choses d'un
   * coup : cet ennemi est marque, et voila le cercle qu'un projectile touche.
   * L'assertion mesure ce qui est DESSINE (echelle x texture), pas la constante
   * intermediaire.
   */
  it('dessine l anneau au diametre de la hitbox de tir', () => {
    const horde = deuxEnnemis();
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);

    const ring = drawnRings(horde)[0];
    expect((ring?.scaleX ?? 0) * MARK_RING_TEXTURE_DIAMETER).toBeCloseTo(
      2 * PROJECTILE_HIT_RADIUS,
      6,
    );
    expect(ring?.scaleY).toBe(ring?.scaleX);
  });

  it('teint l anneau de la couleur de l element, et distingue la Braise du Givre', () => {
    const braise = deuxEnnemis();
    braise.applyMark(0, ELEMENT.BRAISE, 1, TICK);
    const givre = deuxEnnemis();
    givre.applyMark(0, ELEMENT.GIVRE, 1, TICK);

    expect(drawnRings(braise)[0]?.tint).toBe(elementOf(ELEMENT.BRAISE).tint);
    expect(drawnRings(givre)[0]?.tint).toBe(elementOf(ELEMENT.GIVRE).tint);
    expect(drawnRings(givre)[0]?.tint).not.toBe(drawnRings(braise)[0]?.tint);
  });

  it('pose l opacite de l anneau, bien plus lisible que celle d une zone', () => {
    const horde = deuxEnnemis();
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);

    expect(drawnRings(horde)[0]?.alpha).toBe(MARK_RING_ALPHA);
    // La raison d'etre de la tache : *« je ne vois pas la marque »*. Une zone
    // est un lavis qu'on empile (`ZONE_ALPHA`), un anneau est un trait qu'on
    // doit lire du premier coup d'oeil.
    expect(MARK_RING_ALPHA).toBeGreaterThan(ZONE_ALPHA);
  });

  /**
   * L'anneau est centre sur SON propre point — qui est deja descendu aux pieds
   * par `MARK_RING_FOOT_OFFSET_PX`. Une ancre en haut le ferait redescendre
   * d'un rayon de plus, et le decalage des pieds ne voudrait plus rien dire.
   */
  it('centre l anneau sur son point, dans les deux axes', () => {
    const horde = deuxEnnemis();
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);

    const ring = drawnRings(horde)[0];
    expect(ring?.anchorX).toBe(0.5);
    expect(ring?.anchorY).toBe(0.5);
  });

  it('ne dessine rien tant qu aucune texture n a ete adoptee', () => {
    const horde = deuxEnnemis();
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);

    const renderer = new MarkRingRenderer();
    const world = new Container();
    renderer.attach(world);
    renderer.draw(horde, TICK, TOUTE_LA_CARTE);

    expect((world.children[0] as ParticleContainer).particleChildren).toHaveLength(0);
    expect(renderer.loaded).toBe(false);
  });
});

describe('MarkRingRenderer — ce que le §6.6 exige du conteneur', () => {
  it('fusionne en ADDITIF, comme les zones sur lesquelles il se pose', () => {
    expect(new MarkRingRenderer().blendMode).toBe('add');
  });

  it('pose des bornes explicites couvrant la carte entiere, marge comprise', () => {
    expect(new MarkRingRenderer().boundsArea).toMatchObject({
      x: -256,
      y: -256,
      width: MAP_SIZE + 512,
      height: MAP_SIZE + 512,
    });
  });
});
