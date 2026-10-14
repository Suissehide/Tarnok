import { MAP_SIZE, PROJECTILE_CAPACITY, REACTION_RADIUS, ZONE_RADIUS } from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import { Projectiles } from '@shared/projectiles';
import { packElementPair } from '@shared/protocol';
import {
  type ProjectileShape,
  projectileAlpha,
  projectileTrailPx,
  WEAPONS,
  weaponOf,
} from '@shared/weapons';
import {
  Container,
  type Particle,
  type ParticleContainer,
  Rectangle,
  Texture,
  TextureSource,
} from 'pixi.js';
import { describe, expect, it } from 'vitest';

import { HitFlashes } from '../net/client';

/**
 * La capacite du reservoir de flashs d'impact, recopiee ici : `net/client.ts`
 * ne l'exporte pas, et c'est elle qui donne le pire cas du cout des eclats.
 */
const HIT_FLASH_CAPACITY_TEST = 128;

import {
  FLASH_MAX_SCALE,
  IMPACT_TEXTURE_DIAMETER,
  ImpactFlashRenderer,
  impactFlashScale,
  POP_SCALE,
  POP_TICKS,
  PROJECTILE_ATLAS_PX,
  PROJECTILE_CELL_PX,
  PROJECTILE_CULL_MARGIN,
  PROJECTILE_SHAPE_FRACTION,
  ProjectileRenderer,
  projectileCellRect,
  projectilePop,
  projectileSpin,
  REACTION_TEXTURE_DIAMETER,
  ReactionFlashRenderer,
  reactionFlashScale,
  reactionTint,
  SHAPE_OUTLINE_DILATION,
  SHAPE_PAINTERS,
  SPARK_TRAVEL_PX,
  SPARKS_PER_FLASH,
  STREAK_LENGTH_PX,
  STREAK_THICKNESS_PX,
  streakCellRect,
  TRAIL_ALPHA,
  TRAIL_PROFILES,
} from './projectile-renderer';

/**
 * Cases par cote de l'atlas, DERIVEE des deux constantes exportees plutot que
 * recopiee : un nombre en dur aurait suivi le meme sort que `16` a la tache 8
 * de l'etape 5c, ou l'atlas est passe de 4 x 4 a 8 x 8 pour tenir les dix-sept
 * armes du catalogue sans que ce test n'ait rien vu venir.
 */
const PROJECTILE_ATLAS_COLS_MESURE = PROJECTILE_ATLAS_PX / PROJECTILE_CELL_PX;

/**
 * Verifie que les trois renderers posent des bornes explicites des la
 * construction — sans jamais appeler `load()`, qui a besoin d'un canevas 2D
 * (donc d'un navigateur) que l'environnement de test (`vitest`, `node`) n'a
 * pas. C'est precisement pour ca que `mapBoundsArea()` est appliquee dans le
 * CONSTRUCTEUR de chaque classe plutot que dans `load()` : un `ParticleContainer`
 * ne calcule jamais ses propres bornes (voir le spike de l'etape 2, rappele
 * dans `horde-renderer.ts`), et sans ce test rien ne l'aurait attrape si un
 * futur refactor deplacait l'affectation.
 */
describe('rendu des projectiles/flashs — bornes explicites du ParticleContainer', () => {
  const expected = {
    x: -256,
    y: -256,
    width: MAP_SIZE + 512,
    height: MAP_SIZE + 512,
  };

  it('ProjectileRenderer pose des bornes couvrant la carte entiere, marge comprise', () => {
    const renderer = new ProjectileRenderer();
    expect(renderer.boundsArea).toMatchObject(expected);
  });

  it('ImpactFlashRenderer pose des bornes couvrant la carte entiere, marge comprise', () => {
    const renderer = new ImpactFlashRenderer();
    expect(renderer.boundsArea).toMatchObject(expected);
  });
});

/**
 * Étape 5a, §9 : *« la reaction : flash court, large, genereux — c'est la que
 * passe le budget VFX »*, et la regle qui va avec : **l'etat persistant est
 * discret, la reaction est spectaculaire**.
 *
 * Cette regle n'est pas une intention, c'est une comparaison : le flash de
 * reaction doit etre visiblement plus grand que celui d'un impact ordinaire,
 * sans quoi les deux se confondent et le budget de particules repart en bruit
 * de fond. Elle se teste, et c'est ce que fait le premier cas ci-dessous.
 */
describe('reactionFlashScale — la taille du flash de reaction', () => {
  it('couvre EXACTEMENT 2 x REACTION_RADIUS a la fin de sa vie : ni plus, ni moins', () => {
    // La doc de `REACTION_RADIUS` (shared/constants.ts) l'exige mot pour mot :
    // « un rayon plus petit que le flash ferait mourir des ennemis hors du
    // dessin ; un rayon plus grand tuerait hors champ ».
    expect(
      reactionFlashScale(1, REACTION_TEXTURE_DIAMETER) * REACTION_TEXTURE_DIAMETER,
    ).toBeCloseTo(2 * REACTION_RADIUS, 6);
  });

  it('grandit en s eteignant : plus petit a la naissance qu a la fin', () => {
    expect(reactionFlashScale(0, REACTION_TEXTURE_DIAMETER)).toBeLessThan(
      reactionFlashScale(1, REACTION_TEXTURE_DIAMETER),
    );
  });

  it(
    'est SPECTACULAIRE devant le flash d impact : plus large a son maximum que celui-ci au sien ' +
      '(§6.6 — sinon les deux se confondent)',
    () => {
      const reaction = reactionFlashScale(1, REACTION_TEXTURE_DIAMETER) * REACTION_TEXTURE_DIAMETER;
      // Le flash d'impact est dessine sur une texture de 48 px (voir
      // `ImpactFlashRenderer.load`) et grandit jusqu'a `FLASH_MAX_SCALE`.
      const impact = IMPACT_TEXTURE_DIAMETER * FLASH_MAX_SCALE;
      expect(reaction).toBeGreaterThan(impact);
    },
  );

  it('ne divise pas par zero sur une texture degeneree', () => {
    expect(reactionFlashScale(1, 0)).toBe(1);
  });
});

/**
 * ⚠️ **Les deux moities, toujours** (R24/R25) : une fonction qui rendrait
 * toujours `0xffffff` passerait le cas « charge », et une qui rendrait
 * toujours la moyenne passerait le cas « solo ». Il faut les deux, et il faut
 * qu'ils DIFFERENT.
 */
describe('reactionTint — ce que la teinte du flash encode', () => {
  const CHOC_THERMIQUE = packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE);

  it('rend l identite 0xffffff quand la reaction a charge la Synergie (deux joueurs)', () => {
    // `0xffffff` est l'identite du produit que fait `tint` : la reaction
    // inter-joueurs est donc, litteralement, la plus lumineuse que ce
    // renderer puisse dessiner (§6.5 — « le coeur du projet »).
    expect(reactionTint(CHOC_THERMIQUE, true)).toBe(0xffffff);
  });

  it('rend une teinte DIFFERENTE, tiree des deux elements, pour une reaction solo', () => {
    const solo = reactionTint(CHOC_THERMIQUE, false);

    expect(solo).not.toBe(0xffffff);
    // Entre les deux teintes d'element, canal par canal : ni l'une ni l'autre.
    expect(solo).not.toBe(elementOf(ELEMENT.BRAISE).tint);
    expect(solo).not.toBe(elementOf(ELEMENT.GIVRE).tint);
  });

  it('est insensible a l ordre des elements du couple, comme packElementPair', () => {
    // `packElementPair` est canonique (voir sa doc) : un choc declenche par du
    // Givre sur une marque de Braise et l'inverse sont la MEME reaction, et
    // deux clients ne doivent pas en dessiner deux flashs differents.
    expect(reactionTint(packElementPair(ELEMENT.GIVRE, ELEMENT.BRAISE), false)).toBe(
      reactionTint(CHOC_THERMIQUE, false),
    );
  });

  it('rend l identite pour un couple neutre — aucune table par couple a maintenir', () => {
    expect(reactionTint(packElementPair(ELEMENT.NEUTRE, ELEMENT.NEUTRE), false)).toBe(0xffffff);
  });
});

describe('ReactionFlashRenderer — ce que le §6.6 exige du conteneur', () => {
  it('fusionne en ADDITIF, comme les zones', () => {
    expect(new ReactionFlashRenderer().blendMode).toBe('add');
  });

  it('pose des bornes explicites couvrant la carte entiere, marge comprise', () => {
    expect(new ReactionFlashRenderer().boundsArea).toMatchObject({
      x: -256,
      y: -256,
      width: MAP_SIZE + 512,
      height: MAP_SIZE + 512,
    });
  });
});

/**
 * Étape 5a, tache 12 — **une apparence par arme**, venue de l'auteur en
 * jouant : *« fais des projectiles differents pour chaque arme, en forme,
 * taille, couleur, halo, avec une trainee »*. Jusqu'ici les neuf armes
 * tiraient le meme point lumineux.
 *
 * ⚠️ **`draw` n'etait atteignable par AUCUN test avant ce bloc**, exactement
 * comme celui de `HordeRenderer` avant la tache 9 bis : il retournait au
 * premier `if (!texture)` faute de canevas 2D, et tout son corps pouvait etre
 * retire sans qu'une assertion ne bouge. `adoptTextures` separe le decoupage
 * de la cuisson, et un atlas synthetique suffit alors a mesurer ce que `draw`
 * pose reellement sur les particules.
 */
function drawnLayers(
  projectiles: Projectiles,
  view = new Rectangle(0, 0, MAP_SIZE, MAP_SIZE),
): { heads: Particle[]; trails: Particle[] } {
  const renderer = new ProjectileRenderer();
  renderer.adoptTextures(
    new Texture({ source: new TextureSource({ width: 128, height: 128 }) }),
    // Une bande par profil (etape 8) : un atlas trop court ferait decouper des
    // cases hors source, exactement ce que `streakCellRect` numerote.
    new Texture({
      source: new TextureSource({
        width: STREAK_LENGTH_PX,
        height: STREAK_THICKNESS_PX * TRAIL_PROFILES.length,
      }),
    }),
  );

  const world = new Container();
  renderer.attach(world);
  renderer.draw(projectiles, view);

  // `attach` pose UN groupe, qui contient les trainees puis les tetes.
  const group = world.children[0] as Container;
  const trails = group.children[0] as ParticleContainer;
  const heads = group.children[1] as ParticleContainer;
  return {
    heads: [...(heads.particleChildren as Particle[])],
    trails: [...(trails.particleChildren as Particle[])],
  };
}

/** Un projectile de chaque arme, aligne, chacun a sa propre abscisse. */
function oneOfEachWeapon(): Projectiles {
  const p = new Projectiles(PROJECTILE_CAPACITY);
  WEAPONS.forEach((w, i) => {
    p.fireSalvoDirected(w, 0, 200 + i * 100, 500, 1, 0, w.damage, 1);
  });
  return p;
}

describe('ProjectileRenderer.draw — neuf armes, neuf apparences distinctes', () => {
  it('dessine une tete ET une trainee pour chaque arme du catalogue', () => {
    const { heads, trails } = drawnLayers(oneOfEachWeapon());
    expect(heads).toHaveLength(WEAPONS.length);
    expect(trails).toHaveLength(WEAPONS.length);
  });

  /**
   * ⚠️ **« Neuf armes ont une apparence » et « neuf armes ont la MEME
   * apparence » se ressemblent beaucoup.** On assene donc que les neuf
   * diffèrent DEUX A DEUX, sur chacun des trois canaux que `draw` pose : la
   * case d'atlas (la forme), la teinte, et le calibre.
   */
  it('pose une case d atlas differente par arme', () => {
    const { heads } = drawnLayers(oneOfEachWeapon());
    const cases = new Set(heads.map((h) => `${h.texture.frame.x},${h.texture.frame.y}`));
    expect(cases.size).toBe(WEAPONS.length);
  });

  it('pose une teinte differente par arme sur la trainee', () => {
    const { trails } = drawnLayers(oneOfEachWeapon());
    expect(new Set(trails.map((t) => t.tint)).size).toBe(WEAPONS.length);
    // Et ce sont bien CELLES du catalogue, pas neuf valeurs quelconques.
    expect(trails.map((t) => t.tint)).toEqual(WEAPONS.map((w) => w.look.tint));
  });

  it('pose un calibre different par arme, derive de son diametre', () => {
    const { heads } = drawnLayers(oneOfEachWeapon());
    // ⚠️ `projectilePop(0)` : ces projectiles viennent de PARTIR, donc ils
    // claquent (etape 8). Le calibre nu se mesure en regime etabli, plus bas.
    expect(heads.map((h) => h.scaleX)).toEqual(
      WEAPONS.map((w) => (w.look.diameterPx * projectilePop(0)) / PROJECTILE_CELL_PX),
    );
    expect(new Set(heads.map((h) => h.scaleX)).size).toBe(WEAPONS.length);
    // Isotrope : la case d'atlas est carree, et l'etirement dans un seul axe
    // est le role de la TRAINEE. Un `scaleY` decroche du `scaleX` ecraserait
    // chaque forme dans son sens de vol.
    expect(heads.map((h) => h.scaleY)).toEqual(heads.map((h) => h.scaleX));
  });

  it('donne a la trainee une epaisseur qui suit le calibre, et plus fine que la tete', () => {
    const { trails } = drawnLayers(oneOfEachWeapon());
    // Elle SUIT le calibre : neuf armes, neuf epaisseurs.
    expect(new Set(trails.map((t) => t.scaleY)).size).toBe(WEAPONS.length);
    trails.forEach((t, i) => {
      const w = WEAPONS[i];
      if (!w) {
        throw new Error(`arme ${i} absente`);
      }
      const epaisseur = t.scaleY * STREAK_THICKNESS_PX;
      expect(epaisseur, w.name).toBeGreaterThan(0);
      // Plus fine que le corps : une trainee aussi large masquerait sa tete.
      expect(epaisseur, w.name).toBeLessThan(w.look.diameterPx);
    });
  });

  it('etire la trainee a la distance reellement parcourue par l arme', () => {
    const { trails } = drawnLayers(oneOfEachWeapon());
    trails.forEach((t, i) => {
      const w = WEAPONS[i];
      if (!w) {
        throw new Error(`arme ${i} absente`);
      }
      expect(t.scaleX * STREAK_LENGTH_PX, w.name).toBeCloseTo(projectileTrailPx(w), 6);
    });
  });

  it('pose tete ET trainee sur la position du projectile', () => {
    // ⚠️ Les deux moities : la trainee est ancree a droite, donc elle s'etend
    // DERRIERE la position — mais son ancre, elle, est bien sur le projectile.
    // Sans ce cas, ne plus poser la position de la trainee laissait 214 tests
    // verts (mutation appliquee, pas raisonnee).
    const { heads, trails } = drawnLayers(oneOfEachWeapon());
    const attendues = WEAPONS.map((_, i) => ({ x: 200 + i * 100, y: 500 }));

    expect(heads.map((h) => ({ x: h.x, y: h.y }))).toEqual(attendues);
    expect(trails.map((t) => ({ x: t.x, y: t.y }))).toEqual(attendues);
  });

  it('oriente tete et trainee dans l axe du vol', () => {
    const p = new Projectiles(4);
    const arme = weaponOf(0);
    // Vers le bas : une rotation laissee a zero passerait un tir vers +x.
    p.fireSalvoDirected(arme, 0, 1000, 1000, 0, 1, arme.damage, 1);

    const { heads, trails } = drawnLayers(p);
    expect(heads[0]?.rotation).toBeCloseTo(Math.PI / 2, 6);
    expect(trails[0]?.rotation).toBeCloseTo(Math.PI / 2, 6);
  });
});

/**
 * Le fondu, pose sur la particule. La REGLE est gardee dans
 * `shared/weapons.test.ts` (`projectileAlpha`) ; ici on verifie seulement
 * qu'elle arrive jusqu'au dessin — et les DEUX moities, sans quoi un `draw`
 * qui laisserait `alpha` a sa valeur par defaut (1) passerait le cas de
 * l'arc-lourd tout seul.
 */
describe('ProjectileRenderer.draw — la portee se voit', () => {
  const LANCE_FLAMMES = 3;
  const ARC_LOURD = 2;

  function apresPas(weaponId: number, pas: number): Particle {
    const arme = weaponOf(weaponId);
    const p = new Projectiles(4);
    p.fireSalvoDirected(arme, 0, 1000, 1000, 1, 0, arme.damage, 1);
    for (let i = 0; i < pas; i++) {
      p.step(0);
    }
    const head = drawnLayers(p).heads[0];
    if (!head) {
      throw new Error('aucune tete dessinee');
    }
    return head;
  }

  it('eteint le lance-flammes en vol', () => {
    const flammes = weaponOf(LANCE_FLAMMES);
    const vieux = apresPas(LANCE_FLAMMES, flammes.projectileLifeTicks - 1);
    expect(vieux.alpha).toBeLessThan(1);
    expect(vieux.alpha).toBe(projectileAlpha(flammes.projectileLifeTicks, 1));
  });

  it('laisse l arc-lourd a pleine opacite au meme instant de sa course', () => {
    const arc = weaponOf(ARC_LOURD);
    expect(apresPas(ARC_LOURD, arc.projectileLifeTicks - 1).alpha).toBe(1);
  });

  it('estompe la trainee sous sa tete, sans jamais l eteindre a part', () => {
    // La trainee suit le fondu de sa tete (produit), elle n'a pas sa propre
    // courbe : deux atténuations cote a cote finiraient par se contredire.
    const p = new Projectiles(4);
    const arme = weaponOf(LANCE_FLAMMES);
    p.fireSalvoDirected(arme, 0, 1000, 1000, 1, 0, arme.damage, 1);
    for (let i = 0; i < arme.projectileLifeTicks - 1; i++) {
      p.step(0);
    }
    const { heads, trails } = drawnLayers(p);
    const head = heads[0];
    const trail = trails[0];
    if (!head || !trail) {
      throw new Error('rien dessine');
    }
    expect(trail.alpha).toBeLessThan(head.alpha);
    expect(trail.alpha / head.alpha).toBeCloseTo(TRAIL_ALPHA, 6);
  });
});

/**
 * Les dix-sept silhouettes (etape 8 : neuf jusque-la), mesurees sur un
 * contexte 2D MOUCHARD.
 *
 * ⚠️ **Les cases de l'atlas sont jointives**, donc une forme qui depasse son
 * rayon bave dans la case de l'arme voisine et deux armes finissent dessinees
 * avec un bout l'une de l'autre — a l'ecran, pas en test. Rien dans le
 * compilateur ne voit ca : le `Record<ProjectileShape, …>` garantit qu'un
 * dessin existe, jamais qu'il tient dans sa case.
 *
 * Le mouchard note toutes les coordonnees que le peintre lui passe, et le
 * demi-trait des formes TRACEES (`arc` est la seule aujourd'hui) : c'est
 * l'empreinte reelle de l'encre, pas celle du chemin.
 */
describe('SHAPE_PAINTERS — aucune forme ne bave dans la case voisine', () => {
  /** Le rayon du corps plein dans une case, tel que `paintProjectileCell` le calcule. */
  // Le rayon reellement demande au peintre par `paintProjectileCell` : le corps
  // plein DILATE, puisque c'est la silhouette du CERNE qui est la plus grosse
  // des deux (etape 8).
  const BODY = (PROJECTILE_CELL_PX / 2) * PROJECTILE_SHAPE_FRACTION * SHAPE_OUTLINE_DILATION;
  const DEMI_CASE = PROJECTILE_CELL_PX / 2;

  function empreinte(shape: ProjectileShape): number {
    let max = 0;
    let lineWidth = 0;
    const note = (x: number, y: number, pad = 0): void => {
      max = Math.max(max, Math.abs(x) + pad, Math.abs(y) + pad);
    };
    const ctx = {
      fillStyle: '' as unknown,
      strokeStyle: '' as unknown,
      lineJoin: '' as unknown,
      lineCap: '' as unknown,
      get lineWidth(): number {
        return lineWidth;
      },
      set lineWidth(v: number) {
        lineWidth = v;
      },
      beginPath: () => undefined,
      closePath: () => undefined,
      fill: () => undefined,
      // Une forme tracee occupe son chemin PLUS la moitie de son trait.
      stroke: () => {
        max += lineWidth / 2;
      },
      moveTo: note,
      lineTo: note,
      quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => {
        // Le point de controle borne la courbe : elle ne le depasse jamais.
        note(cx, cy);
        note(x, y);
      },
      arc: (x: number, y: number, r: number) => note(x, y, r),
      fillRect: (x: number, y: number, w: number, h: number) => note(x + w, y + h),
    };
    SHAPE_PAINTERS[shape](ctx as unknown as CanvasRenderingContext2D, BODY);
    return max;
  }

  it('garde les dix-sept formes dans leur demi-case', () => {
    for (const shape of Object.keys(SHAPE_PAINTERS) as ProjectileShape[]) {
      expect(empreinte(shape), shape).toBeLessThanOrEqual(DEMI_CASE);
    }
  });

  it('mesure bien une empreinte, et pas zero : le mouchard voit passer l encre', () => {
    // Sans ce cas, un mouchard qui n'enregistrerait rien rendrait le precedent
    // vert pour dix-sept formes vides.
    for (const shape of Object.keys(SHAPE_PAINTERS) as ProjectileShape[]) {
      expect(empreinte(shape), shape).toBeGreaterThan(BODY / 2);
    }
  });

  it('couvre toutes les formes que le catalogue utilise', () => {
    for (const w of WEAPONS) {
      expect(SHAPE_PAINTERS[w.look.shape], w.name).toBeTypeOf('function');
    }
  });
});

/**
 * Étape 8 — **le jus**, venu de l'auteur en jouant : *« ameliore et diversifie
 * les projectiles, animation, particule, forme »*.
 *
 * Trois courbes, et toutes les trois tirent leur temps du MEME compteur que le
 * fondu : `Projectiles.ticksRemainingAt`. C'est ce qui permet a `draw` de
 * n'avoir toujours aucune horloge en parametre — voir `POP_TICKS`.
 */
describe('ProjectileRenderer.draw — le depart claque, et ce qui est lance tourne', () => {
  const CHAKRAM = 5;
  const DAGUE = 0;
  const TESLA = 9;

  function teteApres(weaponId: number, pas: number): Particle {
    const arme = weaponOf(weaponId);
    const p = new Projectiles(4);
    p.fireSalvoDirected(arme, 0, 1000, 1000, 1, 0, arme.damage, 1);
    for (let i = 0; i < pas; i++) {
      p.step(0);
    }
    const head = drawnLayers(p).heads[0];
    if (!head) {
      throw new Error('aucune tete dessinee');
    }
    return head;
  }

  it('fait claquer la tete au depart, puis la ramene a son calibre nu', () => {
    const arme = weaponOf(CHAKRAM);
    const nu = arme.look.diameterPx / PROJECTILE_CELL_PX;

    expect(teteApres(CHAKRAM, 0).scaleX).toBeCloseTo(nu * POP_SCALE, 6);
    // ⚠️ Les DEUX moities : sans le second cas, un pop qui ne retomberait
    // jamais (une arme dessinee 40 % trop grosse toute sa course) passerait.
    expect(teteApres(CHAKRAM, POP_TICKS).scaleX).toBeCloseTo(nu, 6);
    expect(teteApres(CHAKRAM, POP_TICKS + 5).scaleX).toBeCloseTo(nu, 6);
  });

  it('garde la tete isotrope pendant le pop : il grossit, il n etire pas', () => {
    const jeune = teteApres(CHAKRAM, 0);
    expect(jeune.scaleY).toBe(jeune.scaleX);
  });

  it('fait tourner le chakram sur lui-meme en plus de son cap', () => {
    const arme = weaponOf(CHAKRAM);
    expect(arme.look.spinTurns).toBeGreaterThan(0);
    // Le cap est +x (tir vers la droite), donc zero : ce qui reste est la
    // rotation propre.
    expect(teteApres(CHAKRAM, 0).rotation).toBeCloseTo(0, 6);
    expect(teteApres(CHAKRAM, 4).rotation).toBeCloseTo(projectileSpin(arme.look.spinTurns, 4), 6);
    expect(teteApres(CHAKRAM, 4).rotation).toBeGreaterThan(teteApres(CHAKRAM, 2).rotation);
  });

  it('laisse la dague droite dans son axe, quel que soit son age', () => {
    expect(weaponOf(DAGUE).look.spinTurns).toBe(0);
    expect(teteApres(DAGUE, 0).rotation).toBeCloseTo(0, 6);
    expect(teteApres(DAGUE, 10).rotation).toBeCloseTo(0, 6);
  });

  it('tourne a contresens quand l arme le demande', () => {
    expect(weaponOf(TESLA).look.spinTurns).toBeLessThan(0);
    expect(teteApres(TESLA, 3).rotation).toBeLessThan(0);
  });

  it('ne fait JAMAIS tourner la trainee : elle dessine un chemin, pas un objet', () => {
    const arme = weaponOf(CHAKRAM);
    const p = new Projectiles(4);
    // Vers le bas : un cap laisse a zero passerait une trainee qui ignore tout.
    p.fireSalvoDirected(arme, 0, 1000, 1000, 0, 1, arme.damage, 1);
    for (let i = 0; i < 6; i++) {
      p.step(0);
    }
    const { heads, trails } = drawnLayers(p);
    expect(trails[0]?.rotation).toBeCloseTo(Math.PI / 2, 6);
    expect(heads[0]?.rotation).not.toBeCloseTo(Math.PI / 2, 6);
  });
});

/**
 * Les profils de trainee (etape 8) : quatre matieres cuites dans UN atlas,
 * donc toujours un seul quad etire par projectile — ce que le bloc de cout
 * juste en dessous mesure, inchange.
 */
describe('ProjectileRenderer.draw — la matiere de la trainee', () => {
  it('donne a chaque arme la bande de SON profil', () => {
    const { trails } = drawnLayers(oneOfEachWeapon());
    expect(trails.map((t) => ({ x: t.texture.frame.x, y: t.texture.frame.y }))).toEqual(
      WEAPONS.map((w) => {
        const cell = streakCellRect(w.look.trail);
        return { x: cell.x, y: cell.y };
      }),
    );
  });

  it('utilise les quatre profils du catalogue, et pas un seul', () => {
    const { trails } = drawnLayers(oneOfEachWeapon());
    expect(new Set(trails.map((t) => t.texture.frame.y)).size).toBe(TRAIL_PROFILES.length);
  });

  it('fait PARTAGER la meme bande a deux armes de meme profil', () => {
    // Le pendant du cas precedent : quatre bandes pour dix-sept armes, donc le
    // partage est la regle, pas un accident.
    const { trails } = drawnLayers(oneOfEachWeapon());
    const lisses = WEAPONS.map((w, i) => (w.look.trail === 'lisse' ? trails[i] : null)).filter(
      (t) => t !== null,
    );
    expect(lisses.length).toBeGreaterThan(1);
    expect(new Set(lisses.map((t) => t?.texture)).size).toBe(1);
  });

  it('leve plutot que de numeroter un profil inconnu', () => {
    expect(() => streakCellRect('torsade' as never)).toThrow(/profil de trainee inconnu/);
  });
});

/**
 * Le flash d'impact prend la teinte de l'ARME qui vient de toucher (etape 8).
 *
 * ⚠️ Ce bloc n'existe que parce que `adoptTexture` existe : sans ce point
 * d'entree, `draw` retourne au premier `if (!texture)` faute de canevas 2D, et
 * la ligne de teinte pourrait etre retiree sans qu'une assertion ne bouge.
 */
describe('ImpactFlashRenderer.draw — dix-sept armes, dix-sept impacts', () => {
  /** Les deux calques du groupe : le flash, puis la gerbe d'eclats. */
  function calquesDessines(
    coups: readonly { tint: number; radius: number }[],
    ageMs = 0,
  ): { flashs: Particle[]; eclats: Particle[] } {
    const flashes = new HitFlashes(HIT_FLASH_CAPACITY_TEST);
    for (const coup of coups) {
      flashes.spawn(100, 200, coup.tint, coup.radius, 0);
    }
    const renderer = new ImpactFlashRenderer();
    renderer.adoptTexture(
      new Texture({ source: new TextureSource({ width: 48, height: 48 }) }),
      new Texture({ source: new TextureSource({ width: 16, height: 16 }) }),
    );
    const world = new Container();
    renderer.attach(world);
    renderer.draw(flashes, ageMs);
    const group = world.children[0] as Container;
    const flashs = group.children[0] as ParticleContainer;
    const eclats = group.children[1] as ParticleContainer;
    return {
      flashs: [...(flashs.particleChildren as Particle[])],
      eclats: [...(eclats.particleChildren as Particle[])],
    };
  }

  function flashesDessines(teintes: readonly number[]): Particle[] {
    return calquesDessines(teintes.map((tint) => ({ tint, radius: 0 }))).flashs;
  }

  it('reporte la teinte portee par le flash, arme par arme', () => {
    const teintes = WEAPONS.slice(0, 4).map((w) => w.look.tint);
    expect(flashesDessines(teintes).map((f) => f.tint)).toEqual(teintes);
  });

  it('retombe sur le blanc — l identite de tint — quand rien n est teinte', () => {
    expect(flashesDessines([0]).map((f) => f.tint)).toEqual([0xffffff]);
  });

  it('projette six eclats par impact, teintes comme lui', () => {
    const { eclats } = calquesDessines([{ tint: 0x39d97a, radius: 0 }]);
    expect(eclats).toHaveLength(SPARKS_PER_FLASH);
    expect(new Set(eclats.map((e) => e.tint))).toEqual(new Set([0x39d97a]));
    // Six directions DIFFERENTES : une gerbe dont tous les eclats partent du
    // meme cote n'est pas une gerbe.
    expect(new Set(eclats.map((e) => e.rotation)).size).toBe(SPARKS_PER_FLASH);
  });

  it('fait partir les eclats du point d impact, puis les eloigne', () => {
    const naissance = calquesDessines([{ tint: 0xffffff, radius: 0 }], 0).eclats;
    const plusTard = calquesDessines([{ tint: 0xffffff, radius: 0 }], 110).eclats;
    for (let k = 0; k < SPARKS_PER_FLASH; k++) {
      const a = naissance[k];
      const b = plusTard[k];
      if (!a || !b) {
        throw new Error('eclat manquant');
      }
      expect(Math.hypot(a.x - 100, a.y - 200)).toBeCloseTo(0, 6);
      expect(Math.hypot(b.x - 100, b.y - 200)).toBeGreaterThan(0);
      // Et il s'eteint en chemin, sinon la gerbe reste allumee au sol.
      expect(b.alpha).toBeLessThan(a.alpha);
    }
  });

  it('souffle plus loin et plus large quand le coup a un rayon', () => {
    const [sansSouffle] = calquesDessines([{ tint: 0xffffff, radius: 0 }], 220).eclats;
    const [avecSouffle] = calquesDessines([{ tint: 0xffffff, radius: ZONE_RADIUS }], 220).eclats;
    if (!sansSouffle || !avecSouffle) {
      throw new Error('eclat manquant');
    }
    expect(Math.hypot(avecSouffle.x - 100, avecSouffle.y - 200)).toBeCloseTo(ZONE_RADIUS, 0);
    expect(Math.hypot(sansSouffle.x - 100, sansSouffle.y - 200)).toBeCloseTo(SPARK_TRAVEL_PX, 0);
  });

  it('asservit le flash d une arme de souffle a ce qui meurt vraiment', () => {
    // Mot pour mot la discipline de `reactionFlashScale` : a la fin de sa vie,
    // le disque couvre EXACTEMENT 2 x le rayon qui a tue.
    const scale = impactFlashScale(1, ZONE_RADIUS, IMPACT_TEXTURE_DIAMETER);
    expect(scale * IMPACT_TEXTURE_DIAMETER).toBeCloseTo(2 * ZONE_RADIUS, 6);
    // Et il grandit en s'eteignant, comme les deux autres flashs.
    expect(impactFlashScale(0, ZONE_RADIUS, IMPACT_TEXTURE_DIAMETER)).toBeLessThan(scale);
    // Un coup sans souffle garde sa courbe d'origine, inchangee.
    expect(impactFlashScale(1, 0, IMPACT_TEXTURE_DIAMETER)).toBe(FLASH_MAX_SCALE);
  });

  it('ne divise pas par zero sur une texture degeneree', () => {
    expect(impactFlashScale(0.5, ZONE_RADIUS, 0)).toBe(1);
  });

  /**
   * ⚠️ **Le poste de cout de cet effet.** Six eclats par flash et 128 flashs
   * font 768 quads : mesure, comme la trainee l'a ete a la tache 12.
   */
  it('ne pose JAMAIS plus de six eclats par flash, a capacite pleine', () => {
    const coups = Array.from({ length: HIT_FLASH_CAPACITY_TEST }, () => ({
      tint: 0xffffff,
      radius: 0,
    }));
    const { flashs, eclats } = calquesDessines(coups);
    process.stdout.write(
      `[etape 8] pire cas : ${flashs.length} impacts -> ${eclats.length} eclats ` +
        `(${eclats.length / flashs.length} par impact)\n`,
    );
    expect(flashs).toHaveLength(HIT_FLASH_CAPACITY_TEST);
    expect(eclats).toHaveLength(HIT_FLASH_CAPACITY_TEST * SPARKS_PER_FLASH);
  });

  it('fusionne les eclats en ADDITIF, et borne leur calque comme les autres', () => {
    const renderer = new ImpactFlashRenderer();
    expect(renderer.sparkBlendMode).toBe('add');
    expect(renderer.sparkBoundsArea).toMatchObject({ x: -256, y: -256 });
  });
});

/**
 * ⚠️ **Le poste de cout de la tache 12**, et le §4.3 de l'orientation est
 * explicite : *« le danger est le VFX, pas les sprites »*. `PROJECTILE_CAPACITY`
 * vaut 2048, et une trainee de N segments multiplierait les quads par N — a
 * six segments, 12 288 quads. La borne est **de construction** : la trainee est
 * UN quad etire, jamais une file de segments. Ces cas la mesurent au lieu de
 * l'esperer, comme la tache 4 a du compter ses zones (368 la ou « quelques
 * dizaines » etaient budgetees).
 */
describe('ProjectileRenderer.draw — le cout de la trainee, mesure', () => {
  it('ne pose JAMAIS plus de deux quads par projectile visible, a capacite pleine', () => {
    const arme = weaponOf(0);
    const p = new Projectiles(PROJECTILE_CAPACITY);
    p.fireSalvoDirected(arme, 0, 2000, 2000, 1, 0, arme.damage, PROJECTILE_CAPACITY);
    expect(p.count).toBe(PROJECTILE_CAPACITY);

    const { heads, trails } = drawnLayers(p);
    const quads = heads.length + trails.length;
    process.stdout.write(
      `[tache 12] pire cas : ${p.count} projectiles -> ${quads} quads ` +
        `(${quads / p.count} par projectile)\n`,
    );
    expect(quads).toBe(2 * PROJECTILE_CAPACITY);
  });

  it('ne depend PAS de la longueur des trainees : la plus longue coute comme la plus courte', () => {
    // C'est exactement ce qu'une trainee a segments ne sait pas faire.
    const [courte, longue] = [...WEAPONS].sort(
      (a, b) => projectileTrailPx(a) - projectileTrailPx(b),
    );
    if (!courte || !longue) {
      throw new Error('catalogue vide');
    }
    expect(projectileTrailPx(longue)).toBeGreaterThan(projectileTrailPx(courte));

    const quadsPour = (arme: (typeof WEAPONS)[number]): number => {
      const p = new Projectiles(64);
      p.fireSalvoDirected(arme, 0, 2000, 2000, 1, 0, arme.damage, 32);
      const { heads, trails } = drawnLayers(p);
      return heads.length + trails.length;
    };

    expect(quadsPour(longue)).toBe(quadsPour(courte));
    expect(quadsPour(longue)).toBe(64);
  });
});

describe('ProjectileRenderer — le cadre, la grille et les bornes', () => {
  it('pose des bornes explicites sur le calque des trainees aussi', () => {
    expect(new ProjectileRenderer().trailBoundsArea).toMatchObject({
      x: -256,
      y: -256,
      width: MAP_SIZE + 512,
      height: MAP_SIZE + 512,
    });
  });

  it('fusionne les trainees en ADDITIF, comme les zones et le flash de reaction', () => {
    expect(new ProjectileRenderer().trailBlendMode).toBe('add');
  });

  it('donne une case distincte a chaque arme, en grille', () => {
    const cases = WEAPONS.map((w) => projectileCellRect(w.id));
    expect(new Set(cases.map((c) => `${c.x},${c.y}`)).size).toBe(WEAPONS.length);
    // La grille se remplit par LIGNES : la case juste apres la derniere
    // colonne retombe en colonne 0 de la ligne suivante.
    expect(projectileCellRect(0)).toEqual({ x: 0, y: 0, w: 32, h: 32 });
    expect(projectileCellRect(PROJECTILE_ATLAS_COLS_MESURE)).toEqual({
      x: 0,
      y: 32,
      w: 32,
      h: 32,
    });
  });

  it('leve plutot que de faire retomber une arme sur la case d une autre', () => {
    const capacite = PROJECTILE_ATLAS_COLS_MESURE * PROJECTILE_ATLAS_COLS_MESURE;
    // La capacite doit rester devant le catalogue reel, sinon ce cas ne
    // prouverait rien : il faut qu'une arme de plus que la capacite existe
    // encore hors de la grille pour que « hors atlas » ait un sens.
    expect(capacite).toBeGreaterThan(WEAPONS.length);
    expect(() => projectileCellRect(capacite)).toThrow(/hors atlas/i);
    expect(() => projectileCellRect(-1)).toThrow(/hors atlas/i);
  });

  /**
   * La marge de culling est DERIVEE du catalogue : sans elle, un projectile
   * dont le centre vient de quitter le cadre emporte sa trainee de plusieurs
   * dizaines de pixels d'un coup, en plein ecran.
   */
  it('couvre la plus grande empreinte du catalogue', () => {
    for (const w of WEAPONS) {
      expect(PROJECTILE_CULL_MARGIN, w.name).toBeGreaterThanOrEqual(
        projectileTrailPx(w) + w.look.diameterPx,
      );
    }
  });

  it('dessine encore ce qui vient de sortir du cadre, et rien au-dela', () => {
    const arme = weaponOf(0);
    const view = new Rectangle(1000, 1000, 500, 500);

    const dedans = new Projectiles(4);
    dedans.fireSalvoDirected(
      arme,
      0,
      1000 - PROJECTILE_CULL_MARGIN + 1,
      1200,
      1,
      0,
      arme.damage,
      1,
    );
    expect(drawnLayers(dedans, view).heads).toHaveLength(1);

    const dehors = new Projectiles(4);
    dehors.fireSalvoDirected(
      arme,
      0,
      1000 - PROJECTILE_CULL_MARGIN - 1,
      1200,
      1,
      0,
      arme.damage,
      1,
    );
    expect(drawnLayers(dehors, view).heads).toHaveLength(0);
  });
});

/**
 * ⚠️ **Les canaux dynamiques, lus sur le conteneur.** Ces quatre cas viennent
 * d'une mutation qui a SURVECU : `uvs: false` sur les tetes laissait 212 tests
 * verts, parce que `draw` pose bien `head.texture` et que le test le relit —
 * seul le televersement changeait. Le reservoir de particules etant reutilise,
 * la case d'atlas du premier occupant d'un creneau y serait restee pour
 * toujours, et les neuf armes auraient fini dessinees avec la meme forme.
 * C'est le meme motif que `HordeRenderer.dynamicTint`, ne de la meme surprise
 * a la tache 9 bis.
 */
describe('ProjectileRenderer — ce qui est vraiment reteleverse a chaque image', () => {
  it('rafraichit case, orientation, calibre et couleur sur les tetes', () => {
    expect(new ProjectileRenderer().dynamicHeadChannels).toEqual({
      uvs: true,
      rotation: true,
      vertex: true,
      color: true,
    });
  });

  it('rafraichit orientation, etirement et couleur sur les trainees', () => {
    expect(new ProjectileRenderer().dynamicTrailChannels).toEqual({
      rotation: true,
      vertex: true,
      color: true,
    });
  });
});
