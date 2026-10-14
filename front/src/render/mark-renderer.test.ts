// @vitest-environment jsdom
import {
  MAP_SIZE,
  MARK_DURATION_TICKS,
  MAX_ENTITIES,
  PROJECTILE_HIT_RADIUS,
} from '@shared/constants';
import { ELEMENT, ELEMENTS, elementOf } from '@shared/elements';
import { Horde } from '@shared/horde';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { Container, type Particle, type ParticleContainer, Texture, TextureSource } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import { BODY_SCALE } from './horde-renderer';
import {
  MARK_RING_ALPHA,
  MARK_RING_DIAMETER_PX,
  MARK_RING_FOOT_OFFSET_PX,
  MARK_RING_SCALE,
  MARK_RING_SQUASH,
  MARK_RING_TEXTURE_DIAMETER,
  MarkRingRenderer,
  selectMarkedRings,
} from './mark-renderer';
import { lookOf, MAX_PULSE_AMP, type ViewBounds, ZONE_ALPHA } from './zone-renderer';

/**
 * Taches 13 et 15 de l'etape 5a, venues de l'auteur en jouant :
 *
 * > *« Je ne vois pas la marque sur les ennemis, fais un anneau sous leurs
 * > pieds plutot que changer leur couleur. »* (13)
 *
 * > *« Les cercles doivent etre des ellipses sous les pieds, plus nettes et
 * > fines. Parfois ils disparaissent lors des superpositions ou collision ? »*
 * > (15)
 *
 * Quatre choses se gardent ici :
 * 1. **qui** recoit un anneau (marque, dans le cadre) — `selectMarkedRings` ;
 * 2. **combien** — un par ennemi marque depuis la tache 15, la deduplication
 *    par grille de la tache 13 etant exactement ce que l'auteur voyait
 *    disparaitre ;
 * 3. **ou** se pose l'anneau — sous les pieds, pas sur la position ;
 * 4. **a quoi il ressemble** — une ellipse, et un trait fin plutot qu'un
 *    degrade large.
 *
 * ⚠️ **Ce fichier tourne sous jsdom, et depuis la tache 15 seulement.** C'est
 * ce qui rend le PROFIL de la texture atteignable : `makeRingAtlas` a besoin
 * d'un `document.createElement('canvas')`, et son contexte 2D est bouchonne
 * plus bas comme `stage.test.ts` le fait deja. Sans ça, « plus nette et plus
 * fine » n'aurait ete garde par rien du tout.
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

/** Les creneaux retenus, dans l'ordre, avec un tampon dimensionne comme le renderer le fait. */
function selection(horde: Horde, view: ViewBounds, tick = TICK): number[] {
  const out = new Int32Array(horde.capacity);
  const count = selectMarkedRings(horde, tick, view, out);
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

  it('ne deborde jamais du tampon fourni', () => {
    const horde = hordeAt([
      { x: 3000, y: 3000 },
      { x: 3100, y: 3000 },
      { x: 3200, y: 3000 },
    ]);
    for (let i = 0; i < 3; i++) {
      horde.applyMark(i, ELEMENT.BRAISE, 1, TICK);
    }

    // Trois ennemis marques et visibles, un tampon de deux : c'est le tampon
    // qui borne, pas la horde. Meme garde que `selectZones`.
    expect(selectMarkedRings(horde, TICK, TOUTE_LA_CARTE, new Int32Array(2))).toBe(2);
  });
});

/**
 * ⚠️ **Le coeur de la tache 15, et l'inverse exact de ce que la tache 13
 * gardait.**
 *
 * La tache 13 dedoublonnait par cellule de grille, au pas du diametre de
 * l'anneau, pour que le compte suive la SURFACE et non l'effectif. L'auteur en
 * a vu l'artefact en jouant : *« parfois ils disparaissent lors des
 * superpositions ou collision ? »*. Ce n'etait pas un defaut, c'etait la borne
 * — et c'est la borne qui saute.
 *
 * **Le cout remesure, sans deduplication :**
 *
 * | Calque | Quads au pire cas |
 * | --- | --- |
 * | horde | `MAX_ENTITIES` = 4 000, un sprite par ennemi visible |
 * | anneaux | `horde.capacity` = 4 000, un anneau par ennemi marque visible |
 *
 * Le plafond n'a pas disparu, il est seulement devenu le MEME que celui de la
 * horde : un ennemi porte au plus une marque, donc au plus un anneau. Le calque
 * double au pire ce que la horde dessine deja — meme ordre de grandeur.
 */
describe('selectMarkedRings — un anneau par ennemi marque, et rien ne se partage', () => {
  /**
   * ⚠️ **LE test de la tache 15.** Deux ennemis qui se superposent — le decor
   * exact de la plainte — recoivent DEUX anneaux. La grille de la tache 13
   * n'en posait qu'un : sa cellule faisait un diametre d'anneau, et deux
   * ennemis a 2 px l'un de l'autre y tombaient toujours ensemble.
   */
  it('pose deux anneaux pour deux ennemis superposes', () => {
    const horde = hordeAt([
      { x: 3000, y: 3000 },
      { x: 3002, y: 3000 },
    ]);
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);
    horde.applyMark(1, ELEMENT.GIVRE, 1, TICK);

    expect(selection(horde, TOUTE_LA_CARTE)).toEqual([0, 1]);
  });

  /** Le coin haut-gauche de toutes les nappes de ce bloc. */
  const ORIGINE = 3000;

  /**
   * Une nappe pleine d'ennemis TOUS marques, et la vue qui la contient
   * entierement : sans ça, le culling en retirerait une rangee et le compte
   * mesurerait le cadre au lieu de la regle.
   */
  function nappe(cols: number, rows: number, spacing: number): { horde: Horde; vue: ViewBounds } {
    const points: { x: number; y: number }[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        points.push({ x: ORIGINE + col * spacing, y: ORIGINE + row * spacing });
      }
    }
    const horde = hordeAt(points);
    for (let i = 0; i < points.length; i++) {
      horde.applyMark(i, ELEMENT.BRAISE, 1, TICK);
    }
    const vue = screenAt(
      ORIGINE + ((cols - 1) * spacing) / 2,
      ORIGINE + ((rows - 1) * spacing) / 2,
    );
    return { horde, vue };
  }

  /**
   * L'inverse mot pour mot du test que la tache 13 gardait : a surface egale,
   * quatre fois plus d'ennemis donnent desormais quatre fois plus d'anneaux.
   * Un implementeur qui remettrait une grille — ou n'importe quel plafond par
   * ordre de creneau — le ferait rougir.
   */
  it('rend quatre fois plus d anneaux pour quatre fois plus d ennemis sur la meme surface', () => {
    const clairsemee = nappe(32, 32, MARK_RING_DIAMETER_PX / 2);
    const dense = nappe(64, 64, MARK_RING_DIAMETER_PX / 4);
    expect(dense.horde.count).toBe(4 * clairsemee.horde.count);

    expect(selection(clairsemee.horde, clairsemee.vue).length).toBe(clairsemee.horde.count);
    expect(selection(dense.horde, dense.vue).length).toBe(dense.horde.count);
  });

  /**
   * ⚠️ **La mesure du pire cas, faite plutot que supposee.** Une horde pleine,
   * entierement marquee et entierement dans le cadre — c'est le decor mesure a
   * la tache 13 (la horde converge sur le joueur, donc elle tient tout entiere
   * dans le plus petit ecran, et le culling ne borne rien).
   */
  it('borne le nombre d anneaux par la capacite de la horde, jamais au-dela', () => {
    // 80 x 50 = MAX_ENTITIES pile, espaces de 16 px : 1 264 x 784 px, ça tient
    // dans un ecran 1920x1080 une fois le y desecrase.
    const { horde, vue } = nappe(80, 50, 16);
    expect(horde.count).toBe(MAX_ENTITIES);
    const anneaux = selection(horde, vue).length;

    process.stdout.write(
      `[tache 15] pire cas : ${horde.count} ennemis tous marques et visibles -> ` +
        `${anneaux} anneaux (plafond : capacite de la horde = ${horde.capacity} = MAX_ENTITIES ; ` +
        `la horde en dessine deja autant en sprites)\n`,
    );

    expect(anneaux).toBe(horde.count);
    expect(anneaux).toBeLessThanOrEqual(horde.capacity);
    expect(horde.capacity).toBe(MAX_ENTITIES);
  });
});

/**
 * Le corps de `draw`, atteint par `adoptTexture` — meme point d'accroche que
 * `HordeRenderer.adoptAtlas` (tache 9 bis) et `ProjectileRenderer.adoptTextures`
 * (tache 12), et pour la meme raison : `load()` cuit sa texture sur un canevas
 * 2D dont jsdom ne fournit pas le contexte, donc `draw` retournerait a son
 * premier `if (!texture)` et tout son corps pourrait etre retire en silence.
 */
function drawnRings(horde: Horde, view: ViewBounds = TOUTE_LA_CARTE, timeMs = 0): Particle[] {
  const renderer = new MarkRingRenderer();
  // L'atlas : une case par element, cote a cote.
  renderer.adoptTexture(
    new Texture({
      source: new TextureSource({
        width: MARK_RING_TEXTURE_DIAMETER * ELEMENTS.length,
        height: MARK_RING_TEXTURE_DIAMETER,
      }),
    }),
  );

  const world = new Container();
  renderer.attach(world);
  renderer.draw(horde, TICK, view, timeMs);

  const container = world.children[0] as ParticleContainer;
  return [...(container.particleChildren as Particle[])];
}

describe('MarkRingRenderer.draw — l anneau arrive bien sous les pieds', () => {
  /** Deux ennemis, dont un seul marque. */
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
   * ⚠️ **La LARGEUR est derivee de la hitbox de tir, jamais reglee a la main** —
   * la lecon de `spriteScale` (tache 16) et de `zoneScale`. L'assertion mesure
   * ce qui est DESSINE (echelle x texture), pas la constante intermediaire.
   */
  it('dessine l anneau a la LARGEUR du diametre de la hitbox de tir', () => {
    const horde = deuxEnnemis();
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);

    const ring = drawnRings(horde)[0];
    expect((ring?.scaleX ?? 0) * MARK_RING_TEXTURE_DIAMETER).toBeCloseTo(
      2 * PROJECTILE_HIT_RADIUS,
      6,
    );
  });

  /**
   * ⚠️ **Tache 15 : une ellipse, pas un cercle.** *« Les cercles doivent etre
   * des ellipses sous les pieds. »* Vue de dessus, un disque pose au sol se
   * projette en ellipse : la largeur dit le diametre vrai, la hauteur est la
   * projection.
   *
   * Le rapport se lit sur ce qui est DESSINE, et il doit etre franchement
   * inferieur a 1 : la camera en applique deja un de 0,82 (`VERTICAL_SQUASH`
   * dans `stage.ts`), et c'est justement ce que l'auteur trouvait trop rond.
   */
  it('aplatit l anneau verticalement, et le laisse intact horizontalement', () => {
    const horde = deuxEnnemis();
    horde.applyMark(0, ELEMENT.BRAISE, 1, TICK);

    const ring = drawnRings(horde)[0];
    expect(ring?.scaleX).toBeCloseTo(MARK_RING_SCALE, 6);
    expect((ring?.scaleY ?? 0) / (ring?.scaleX ?? 1)).toBeCloseTo(MARK_RING_SQUASH, 6);
    // La moitie qui rend la mutation « scaleY = scaleX » impossible a survivre.
    expect(ring?.scaleY).toBeLessThan(ring?.scaleX ?? 0);
    // Et celle qui interdit d'y recopier le 0,82 de la camera : compose avec
    // elle, l'ellipse lirait 0,82 x 0,82 ≈ 0,67, encore trop ronde.
    expect(MARK_RING_SQUASH).toBeLessThan(0.7);
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
    // La raison d'etre de la tache 13 : *« je ne vois pas la marque »*. Une
    // zone est un lavis qu'on empile (`ZONE_ALPHA`), un anneau est un trait
    // qu'on doit lire du premier coup d'oeil.
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
    renderer.draw(horde, TICK, TOUTE_LA_CARTE, 0);

    expect((world.children[0] as ParticleContainer).particleChildren).toHaveLength(0);
    expect(renderer.loaded).toBe(false);
  });
});

/**
 * *« Varier les effets en fonction des etats »* : la marque se reconnait a sa
 * silhouette et a son animation, plus seulement a sa teinte.
 */
describe('MarkRingRenderer.draw — une silhouette et une animation par element', () => {
  function unEnnemiMarque(element: number): Horde {
    const horde = hordeAt([{ x: 3000, y: 3000 }]);
    horde.applyMark(0, element, 1, TICK);
    return horde;
  }

  it('prend la case de son element dans l atlas : deux elements, deux formes', () => {
    const cases = ELEMENTS.filter((e) => e.id !== ELEMENT.NEUTRE).map(
      (e) => drawnRings(unEnnemiMarque(e.id))[0]?.texture.frame.x,
    );

    expect(new Set(cases).size).toBe(cases.length);
  });

  /**
   * La respiration multiplie les DEUX axes : l'ellipse reste une ellipse posee
   * au sol (`MARK_RING_SQUASH`), elle ne fait que battre, dans la marge.
   */
  it('respire avec l horloge murale sans perdre son aplatissement', () => {
    const horde = unEnnemiMarque(ELEMENT.VIF_ARGENT);
    const t0 = drawnRings(horde, TOUTE_LA_CARTE, 0)[0];
    const t1 = drawnRings(horde, TOUTE_LA_CARTE, 370)[0];

    expect(t1?.scaleX).not.toBe(t0?.scaleX);
    expect((t1?.scaleY ?? 0) / (t1?.scaleX ?? 1)).toBeCloseTo(MARK_RING_SQUASH, 6);
    expect(t1?.scaleX ?? 0).toBeLessThanOrEqual(MARK_RING_SCALE * (1 + MAX_PULSE_AMP));
    // Pas de rotation : la particule est aplatie, et Pixi tourne apres l'echelle.
    expect(t1?.rotation).toBe(0);
  });

  it('fait crepiter la Foudre, sans jamais depasser l opacite de l anneau', () => {
    const horde = unEnnemiMarque(ELEMENT.FOUDRE);
    const alphas = [0, 40, 90, 130, 170].map(
      (ms) => drawnRings(horde, TOUTE_LA_CARTE, ms)[0]?.alpha ?? 0,
    );

    expect(Math.min(...alphas)).toBeLessThan(MARK_RING_ALPHA);
    expect(Math.max(...alphas)).toBeLessThanOrEqual(MARK_RING_ALPHA);
    expect(Math.min(...alphas)).toBeGreaterThanOrEqual(
      MARK_RING_ALPHA * (1 - lookOf(ELEMENT.FOUDRE).flicker),
    );
  });
});

describe('MarkRingRenderer.load — l atlas se cuit', () => {
  it('cuit une case par element sur un contexte 2D', () => {
    const noop = (): void => undefined;
    const proto = HTMLCanvasElement.prototype as unknown as { getContext: () => unknown };
    proto.getContext = (): unknown => ({
      beginPath: noop,
      closePath: noop,
      moveTo: noop,
      lineTo: noop,
      arc: noop,
      fill: noop,
      stroke: noop,
    });

    const renderer = new MarkRingRenderer();
    renderer.load();
    expect(renderer.loaded).toBe(true);
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
