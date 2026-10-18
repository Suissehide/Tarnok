import {
  ARCHETYPES,
  archetypeIdOf,
  BOSS_ARCHETYPE,
  BOSS_BODY_SCALE,
  PORTEUR_ARCHETYPE,
  PORTEUR_BODY_SCALE,
} from '@shared/archetypes';
import { MAP_SIZE, PROJECTILE_HIT_RADIUS } from '@shared/constants';
import { Horde } from '@shared/horde';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { WEAPONS } from '@shared/weapons';
import {
  Container,
  type Particle,
  type ParticleContainer,
  Rectangle,
  Texture,
  TextureSource,
} from 'pixi.js';
import { describe, expect, it } from 'vitest';

import {
  type AtlasClip,
  type AtlasManifest,
  archetypeScales,
  BAND_COUNT,
  BODY_SCALE,
  bandOf,
  clipFrameIndex,
  contentSizePx,
  DEPTH_BAND,
  FACING_DEAD_ZONE_PX,
  FACING_MAX_STEP_PX,
  facingScaleX,
  HordeRenderer,
  selectClip,
  sortByDepth,
  spriteScale,
} from './horde-renderer';

/**
 * `bandOf` ne doit jamais pouvoir sortir de `[0, BAND_COUNT)`.
 *
 * `counts[band]` (dans `sortByDepth`) est une ecriture sur `Uint32Array` : un
 * indice hors bornes y est un NO-OP SILENCIEUX (ni exception, ni `undefined`
 * a l'ecriture). `bandOf` est la seule garde entre une position hors carte et
 * cette ecriture.
 */
describe('bandOf reste dans [0, BAND_COUNT) meme hors carte', () => {
  it('clampe les ordonnees negatives a la bande 0', () => {
    expect(bandOf(-1)).toBe(0);
    expect(bandOf(-8612)).toBe(0);
  });

  it('clampe les ordonnees au-dela de MAP_SIZE a la derniere bande', () => {
    expect(bandOf(MAP_SIZE)).toBe(BAND_COUNT - 1);
    expect(bandOf(MAP_SIZE + 1)).toBe(BAND_COUNT - 1);
    expect(bandOf(7665.8)).toBe(BAND_COUNT - 1);
  });

  it('laisse les ordonnees valides inchangees', () => {
    // ⚠️ Derive de `DEPTH_BAND`, jamais code en dur : un test qui fige la
    // largeur de bande garderait la valeur d'une constante, pas le
    // comportement de la fonction.
    expect(bandOf(0)).toBe(0);
    expect(bandOf(DEPTH_BAND - 1)).toBe(0);
    expect(bandOf(DEPTH_BAND)).toBe(1);
    expect(bandOf(DEPTH_BAND * 7 + 1)).toBe(7);
  });
});

/**
 * Le defaut reel n'est pas seulement "bandOf sort de la plage" : c'est ce que
 * ca fait au TAMPON `#sorted` en aval. Sans garde, plusieurs entites hors
 * carte s'ecrivent toutes au meme curseur invalide (`offsets[band] ?? 0`
 * retombe a 0 pour un indice jamais ecrit) et s'ecrasent mutuellement ; des
 * cases du tampon ne sont alors jamais reecrites et gardent leur contenu
 * perime de l'image precedente. Ce test observe directement cette propriete
 * plutot que la seule absence d'exception : les `visibleCount` premieres
 * cases de `sorted` doivent contenir une permutation EXACTE de `visible`,
 * jamais un doublon ni un residu d'un appel precedent.
 */
describe('sortByDepth ne corrompt pas #sorted avec des entites hors carte', () => {
  it('chaque case utilisee recoit une entite visible distincte, meme avec des y hors [0, MAP_SIZE]', () => {
    const N = 12;
    const horde = new Horde(N);
    const order: WaveOrder = {
      waveId: 1,
      spawnTick: 0,
      seed: 3,
      archetype: 0,
      formation: FORMATION.SCATTER,
      anchorX: 3000,
      anchorY: 3000,
      count: N,
    };
    horde.spawn(order);

    // Quelques entites hors carte : ce que `shared/` devrait desormais
    // empecher, mais le renderer ne doit pas en dependre pour rester correct
    // (defense en profondeur).
    horde.y[0] = -800;
    horde.y[3] = MAP_SIZE + 950;
    horde.y[7] = -8612;
    horde.y[9] = MAP_SIZE + 1665;

    const visible = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      visible[i] = i;
    }

    const bandCounts = new Uint32Array(BAND_COUNT);
    const bandOffsets = new Uint32Array(BAND_COUNT + 1);
    // Rempli d'un residu reconnaissable, comme le tampon reel d'une image
    // precedente : une case jamais reecrite doit se trahir en gardant -1.
    const sorted = new Int32Array(N).fill(-1);

    sortByDepth(horde.y, visible, N, bandCounts, bandOffsets, sorted);

    const written = Array.from(sorted.slice(0, N));
    const asSet = new Set(written);

    // Aucun residu de -1, aucun doublon : exactement les N indices visibles,
    // chacun une fois.
    expect(asSet.size).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(asSet.has(i)).toBe(true);
    }
    expect(written).not.toContain(-1);
  });
});

/**
 * `spriteScale` DERIVE l'echelle de dessin de `PROJECTILE_HIT_RADIUS`, pour
 * n'importe quelle cellule native : une echelle reglee a la main a cote d'une
 * hitbox reglee a la main finit par mentir (un projectile qui touche
 * visiblement le corps passe au travers). Les tests verifient la RELATION,
 * pas un nombre fige.
 */
describe('spriteScale derive la taille dessinee de PROJECTILE_HIT_RADIUS', () => {
  it('le diametre dessine vaut le diametre de la hitbox de tir a BODY_SCALE pres, quelle que soit la cellule native', () => {
    // Cellules reellement presentes dans l'atlas (voir shared/archetypes.ts) :
    // 192 px pour la pietaille courante, jusqu'a 384 px pour le troll.
    //
    // ⚠️ `BODY_SCALE` est DERIVE de la constante, jamais recopie : c'est un
    // reglage de sensation. Ce que ce test garde, c'est la RELATION — le diametre dessine suit la hitbox,
    // quelle que soit la valeur du facteur.
    for (const cell of [128, 192, 256, 320, 384]) {
      const scale = spriteScale(cell, PROJECTILE_HIT_RADIUS);
      expect(scale * cell).toBeCloseTo(2 * PROJECTILE_HIT_RADIUS * BODY_SCALE, 5);
    }
  });

  it('suit PROJECTILE_HIT_RADIUS si la constante bouge — rien de fige a cote', () => {
    const cell = 192;
    const scaleAujourdhui = spriteScale(cell, PROJECTILE_HIT_RADIUS);
    const scaleRayonDouble = spriteScale(cell, PROJECTILE_HIT_RADIUS * 2);
    // Doubler le rayon de hitbox doit doubler l'echelle : une implementation
    // qui ignorerait son parametre `hitRadiusPx` (par ex. `64 / cellPx` en
    // dur) passerait le premier test mais pas celui-ci.
    expect(scaleRayonDouble).toBeCloseTo(scaleAujourdhui * 2, 5);
  });
});

/**
 * Le corps de la creature est agrandi de `BODY_SCALE` : a la taille exacte de
 * la hitbox, les ennemis paraissent trop petits a cote des projectiles.
 *
 * ⚠️ **Ce facteur rend la hitbox menteuse** : un tir qui frole le bord du
 * corps sans atteindre le cercle passe au travers. Ce qui le rend acceptable
 * est une borne, pas une opinion : le projectile est un POINT pour la
 * collision alors qu'il se dessine avec une empreinte — il porte deja un
 * mensonge de meme nature, de la moitie de son plus grand diametre. Le corps
 * doit rester sous cette borne.
 *
 * **Les deux moities** : « le corps grandit » et « il ne grandit pas trop » se
 * gardent separement — un `BODY_SCALE` a 1 passerait le second tout seul.
 */
describe('BODY_SCALE — un corps plus grand que sa hitbox, mais borne', () => {
  it('agrandit le corps, sinon la tache 14 ne corrige rien', () => {
    expect(BODY_SCALE).toBeGreaterThan(1);
  });

  it('ne fait pas mentir la hitbox plus que le rendu des projectiles ne la fait deja mentir', () => {
    const mensongeDuCorps = PROJECTILE_HIT_RADIUS * (BODY_SCALE - 1);
    // Le plus gros projectile du catalogue, derive de la table des armes et
    // non recopie : ajouter une arme plus grosse desserre la borne toute
    // seule, en retrecir une la resserre.
    const mensongeDuPlusGrosProjectile = Math.max(...WEAPONS.map((w) => w.look.diameterPx)) / 2;

    expect(mensongeDuCorps).toBeLessThanOrEqual(mensongeDuPlusGrosProjectile);
  });
});

/**
 * Les monstres se retournent vers leur direction de deplacement.
 * `facingScaleX` deduit le signe de `scaleX` (`vertex` dans le
 * `ParticleContainer`, voir le commentaire de la classe) du seul deplacement
 * horizontal observe entre deux images — jamais d'un champ ajoute a `Horde`
 * ni d'un octet de plus sur le fil.
 *
 * Deux gardes, testees separement :
 * - `FACING_DEAD_ZONE_PX` : sous ce seuil, `dx` est trop proche de zero pour
 *   trancher un sens (deplacement quasi vertical, ou entite immobile entre
 *   deux ticks de simulation — le rendu tourne plus vite que la simulation) ;
 *   on conserve le sens precedent plutot que de papillotter.
 * - `FACING_MAX_STEP_PX` : au-dessus de ce seuil, `dx` est trop grand pour
 *   etre un deplacement reel d'une image a l'autre (`Horde#removeAt` compacte
 *   par permutation, un creneau peut changer d'identite et produire un `dx`
 *   de plusieurs centaines de pixels) ; on conserve aussi le sens precedent.
 */
describe('facingScaleX deduit le sens du sprite du seul deplacement horizontal', () => {
  const plausible = (FACING_DEAD_ZONE_PX + FACING_MAX_STEP_PX) / 2;

  it('un pas plausible vers la droite donne +1, quel que soit le sens precedent', () => {
    expect(facingScaleX(plausible, -1)).toBe(1);
    expect(facingScaleX(plausible, 1)).toBe(1);
  });

  it('un pas plausible vers la gauche donne -1, quel que soit le sens precedent', () => {
    expect(facingScaleX(-plausible, 1)).toBe(-1);
    expect(facingScaleX(-plausible, -1)).toBe(-1);
  });

  it('sous la zone morte, conserve le sens precedent plutot que de papillotter', () => {
    expect(facingScaleX(FACING_DEAD_ZONE_PX / 2, -1)).toBe(-1);
    expect(facingScaleX(-FACING_DEAD_ZONE_PX / 2, 1)).toBe(1);
  });

  it('au-dela du pas plausible (creneau recompacte), conserve le sens precedent plutot que de suivre le saut', () => {
    expect(facingScaleX(FACING_MAX_STEP_PX * 2, -1)).toBe(-1);
    expect(facingScaleX(-FACING_MAX_STEP_PX * 2, 1)).toBe(1);
  });
});

/**
 * Une cellule d'atlas Tiny Swords de 192 px est en grande partie VIDE : ramener
 * le CADRE a la hitbox rendrait le CORPS bien plus petit qu'elle.
 * `contentSizePx` nourrit `spriteScale` : la plus grande dimension de la boite
 * englobante du contenu NON TRANSPARENT (`tools/build_monster_atlas.py` la
 * calcule et la publie dans le manifeste, voir `bounds` dans `AtlasManifest`).
 *
 * On retient la plus grande des deux dimensions, pas la largeur ni la hauteur
 * seules : une silhouette allongee horizontalement (un lezard qui court) ne
 * doit pas se voir attribuer une echelle calculee sur sa hauteur, plus
 * petite, ce qui la ferait deborder de son propre diametre de hitbox dans le
 * sens ou elle est justement la plus etendue.
 */
describe('contentSizePx retient la plus grande dimension de la boite englobante du contenu', () => {
  it('rend la largeur quand elle domine (silhouette large et basse)', () => {
    expect(contentSizePx({ w: 150, h: 80 })).toBe(150);
  });

  it('rend la hauteur quand elle domine (silhouette haute et etroite)', () => {
    expect(contentSizePx({ w: 80, h: 150 })).toBe(150);
  });
});

/**
 * Le choix du clip est du RENDU PUR, derive de l'etat d'arret DEJA simule
 * (`horde.stopped`, voir `shared/horde.ts`) — jamais recalcule ni envoye sur
 * le fil. `selectClip` se teste sans l'atlas (reseau/canevas absents en
 * test).
 */
describe("selectClip choisit l'attaque a l'arret, la course sinon", () => {
  it('rend le clip d attaque quand l entite est arretee', () => {
    expect(selectClip(true, 'course', 'attaque')).toBe('attaque');
  });

  it('rend le clip de course quand l entite avance', () => {
    expect(selectClip(false, 'course', 'attaque')).toBe('course');
  });
});

/**
 * **Le corps de `draw`, atteint.** `load` fetch un manifeste et un atlas ;
 * `adoptAtlas` separe le decoupage du reseau, et un atlas synthetique suffit
 * alors a mesurer ce que `draw` pose vraiment : une particule par ennemi
 * visible, son ancre et son echelle.
 */
/**
 * ⚠️ **La cellule, le contenu, la largeur et la hauteur valent tous des
 * nombres DIFFERENTS, et c'est delibere.** Avec des valeurs egales, l'echelle
 * calculee depuis la cellule, la largeur du contenu, sa hauteur ou la bonne
 * valeur donnerait le meme resultat, et le test de l'echelle posee par `draw`
 * ne distinguerait aucune de ces mutations. Avec une cellule de 64, un
 * contenu de 24x40, seule `contentSizePx(bounds) = 40` rend l'echelle
 * attendue.
 */
const FIXTURE_CELL_PX = 64;
const FIXTURE_BOUNDS = { x: 12, y: 8, w: 24, h: 40 } as const;

/**
 * Un atlas d'UN seul archetype, range a l'identifiant demande.
 *
 * ⚠️ **`id` est un PARAMETRE, et c'est le point** : le manifeste a des TROUS
 * (le boss, archetype 19, sans les elites qui le precedent) et la position
 * dans son tableau n'est pas l'identifiant. Un decor qui ne sait ranger qu'a
 * l'index 0 ne distingue pas les deux lectures.
 */
/**
 * ⚠️ **Les deux clips occupent des rectangles DIFFERENTS de l'atlas**, et c'est
 * ce qui rend le choix de `selectClip` observable sur la particule dessinee :
 * avec un rectangle commun, `draw` pourrait lire l'un pour l'autre sans
 * qu'aucune assertion ne bouge.
 */
const FIXTURE_RUN_X = 0;
const FIXTURE_ATTACK_X = 64;

function clipAt(x: number): AtlasClip {
  return { frames: 1, rects: [{ x, y: 0, w: FIXTURE_CELL_PX, h: FIXTURE_CELL_PX }] };
}

function syntheticAtlas(id = 0): { manifest: AtlasManifest; atlas: Texture } {
  return {
    manifest: {
      image: 'atlas.png',
      size: 128,
      archetypes: [
        {
          id,
          name: 'synthetique',
          cell: FIXTURE_CELL_PX,
          bounds: { ...FIXTURE_BOUNDS },
          clips: { run: clipAt(FIXTURE_RUN_X), attack: clipAt(FIXTURE_ATTACK_X) },
        },
      ],
    },
    atlas: new Texture({ source: new TextureSource({ width: 128, height: 64 }) }),
  };
}

function drawnParticles(horde: Horde, atlasId = 0): Particle[] {
  const renderer = new HordeRenderer('/assets-de-test');
  const { manifest, atlas } = syntheticAtlas(atlasId);
  renderer.adoptAtlas(manifest, atlas);

  const world = new Container();
  renderer.attach(world);
  renderer.draw(horde, new Rectangle(0, 0, MAP_SIZE, MAP_SIZE), 0);

  const container = world.children[0] as ParticleContainer;
  // `particleChildren` est type `IParticle[]` ; le reservoir de
  // `HordeRenderer`, lui, ne contient que des `Particle`.
  return [...(container.particleChildren as Particle[])];
}

function twoEnemies(archetype = 0): Horde {
  const horde = new Horde(4);
  const order: WaveOrder = {
    waveId: 1,
    spawnTick: 0,
    seed: 3,
    archetype,
    formation: FORMATION.SCATTER,
    anchorX: 3000,
    anchorY: 3000,
    count: 2,
  };
  horde.spawn(order);
  return horde;
}

/** La particule dessinee a la position du creneau `slot` — l'ordre de `draw` est celui de la PROFONDEUR. */
function particleOf(particles: Particle[], horde: Horde, slot: number): Particle {
  const found = particles.find((p) => p.x === horde.x[slot] && p.y === horde.y[slot]);
  if (!found) {
    throw new Error(`aucune particule dessinee pour le creneau ${slot}`);
  }
  return found;
}

describe('HordeRenderer.draw — ce que le corps de draw pose vraiment', () => {
  it('dessine une particule par ennemi visible', () => {
    const horde = twoEnemies();
    expect(drawnParticles(horde)).toHaveLength(2);
  });
});

/**
 * **Le manifeste est indexe par IDENTIFIANT, jamais par position.**
 *
 * L'atlas embarque le BOSS — archetype 19 — mais pas les cinq elites qui le
 * precedent : les ranger toutes sature un atlas de 4096 (voir
 * `tools/build_monster_atlas.py`). `SOURCES` porte donc des trous, et le
 * manifeste ne liste que ce qui est reellement range.
 *
 * ⚠️ **La mutation que ce bloc tue est SILENCIEUSE et generale.** Lire la
 * position du tableau au lieu de `a.id` ne leve rien : elle donne au premier
 * archetype range les textures du creneau 0, au deuxieme celles du creneau 1,
 * et ainsi de suite. Le symptome n'est pas une erreur, c'est « les monstres
 * ont change de sprite ».
 */
/**
 * `draw` doit LIRE le clip que `selectClip` choisit. La fonction elle-meme est
 * gardee plus haut, purement ; ici on garde le CABLAGE — que le clip
 * d'attaque range par `adoptAtlas` (a l'identifiant d'archetype, pas a la
 * position du manifeste) soit bien celui que `draw` pose sur la particule
 * d'une entite arretee.
 */
describe('HordeRenderer.draw — le clip pose suit l etat d arret', () => {
  it('pose une image du clip de COURSE quand l entite avance', () => {
    const horde = twoEnemies();
    const particule = particleOf(drawnParticles(horde), horde, 0);
    expect(particule.texture.frame.x).toBe(FIXTURE_RUN_X);
  });

  it('pose une image du clip d ATTAQUE quand l entite est arretee', () => {
    const horde = twoEnemies();
    horde.stopped[0] = 1;
    horde.stopped[1] = 1;
    const particule = particleOf(drawnParticles(horde), horde, 0);
    expect(particule.texture.frame.x).toBe(FIXTURE_ATTACK_X);
  });
});

describe('adoptAtlas range par identifiant d archetype, pas par position', () => {
  it('dessine un archetype range loin dans le manifeste, seul dans sa liste', () => {
    const horde = twoEnemies(BOSS_ARCHETYPE);
    expect(drawnParticles(horde, BOSS_ARCHETYPE)).toHaveLength(2);
  });

  /**
   * **La moitie basse** : sans elle, un `adoptAtlas` qui donnerait ses textures
   * a TOUS les archetypes passerait le test ci-dessus. Un archetype absent du
   * manifeste ne doit rien dessiner — c'est le cas des elites qui n'y sont
   * pas.
   */
  it('ne dessine rien pour un archetype absent du manifeste', () => {
    const horde = twoEnemies(0);
    expect(drawnParticles(horde, BOSS_ARCHETYPE)).toHaveLength(0);
  });

  /**
   * Le clip d'attaque est range dans un SECOND tableau : le ranger a la
   * position ne se voit que sur une entite arretee, jamais sur une entite qui
   * court.
   */
  it('donne au boss son clip d attaque, range au meme identifiant', () => {
    const horde = twoEnemies(BOSS_ARCHETYPE);
    horde.stopped[0] = 1;
    horde.stopped[1] = 1;
    const particule = particleOf(drawnParticles(horde, BOSS_ARCHETYPE), horde, 0);
    expect(particule.texture.frame.x).toBe(FIXTURE_ATTACK_X);
  });

  /**
   * L'echelle suit la meme indexation que les textures : la lire a la position
   * donnerait au boss celle de l'archetype 0 — un corps trois fois trop petit,
   * sans qu'aucune erreur ne le signale.
   */
  it('donne au boss l echelle calculee pour SON identifiant', () => {
    const horde = twoEnemies(BOSS_ARCHETYPE);
    const particule = particleOf(drawnParticles(horde, BOSS_ARCHETYPE), horde, 0);
    const attendue = spriteScale(
      contentSizePx(FIXTURE_BOUNDS),
      PROJECTILE_HIT_RADIUS,
      BOSS_BODY_SCALE,
    );

    expect(particule.scaleY).toBeCloseTo(attendue, 5);
  });
});

/**
 * L'ancre et l'echelle ne se lisent que sur la particule reellement
 * dessinee. `spriteScale` et `contentSizePx` se testent purement plus haut ;
 * ici on garde le CABLAGE — que `draw` pose bien ce que `adoptAtlas` a
 * calcule, et depuis le CONTENU de l'atlas, pas depuis sa cellule.
 */
describe('HordeRenderer.draw — le corps est centre sur la position et a la bonne taille', () => {
  it("centre le corps sur la position : l'ancre verticale est au milieu du sprite", () => {
    const horde = twoEnemies();
    const particle = particleOf(drawnParticles(horde), horde, 0);

    // 0,5 n'est pas un reglage a deriver d'une constante : c'est la definition
    // de « centre ». A 0,75 (les pieds sur la position), le corps monterait
    // de 25 % de sa hauteur au-dessus de la hitbox.
    expect(particle.anchorY).toBe(0.5);
    expect(particle.anchorX).toBe(0.5);
  });

  it('met le sprite a l echelle du CONTENU de l atlas, pas de sa cellule', () => {
    const horde = twoEnemies();
    const particle = particleOf(drawnParticles(horde), horde, 0);

    // Attendue derivee de la fixture : `contentSizePx({ w: 24, h: 40 }) = 40`,
    // et non la cellule de 64 ni la largeur de 24 — voir `FIXTURE_BOUNDS`.
    const attendue = spriteScale(contentSizePx(FIXTURE_BOUNDS), PROJECTILE_HIT_RADIUS);

    expect(particle.scaleY).toBeCloseTo(attendue, 5);
    // `scaleX` porte en plus le SENS (`facingScaleX`) : c'est sa valeur
    // absolue qui doit valoir la meme echelle.
    expect(Math.abs(particle.scaleX)).toBeCloseTo(attendue, 5);
  });
});

/**
 * Le facteur de corps du BOSS.
 *
 * ⚠️ **`BODY_SCALE` reste plafonne, et le boss ne releve pas ce plafond.** Le
 * bloc ci-dessus mesure de combien la hitbox ment pour un monstre ORDINAIRE et
 * borne ce mensonge par celui que le rendu des projectiles assume deja. Le
 * boss apporte son propre facteur (`Archetype.bodyScale`), qui MULTIPLIE le
 * commun au lieu de le remplacer. Un `BODY_SCALE` releve a 3 agrandirait tout
 * le bestiaire pour n'en vouloir qu'un — et ferait rougir le plafond.
 */
describe('bodyScale — le boss a son propre debordement, pas celui de tout le monde', () => {
  it('dessine le boss BOSS_BODY_SCALE fois plus grand qu une pietaille de meme cellule', () => {
    const cell = 192;
    const pietaille = spriteScale(cell, PROJECTILE_HIT_RADIUS, 1);
    const boss = spriteScale(cell, PROJECTILE_HIT_RADIUS, BOSS_BODY_SCALE);
    expect(boss).toBeCloseTo(pietaille * BOSS_BODY_SCALE, 10);
  });

  /**
   * **Les deux moities.** « Le boss grandit » passe tout seul si `bodyScale`
   * etait ignore et `BODY_SCALE` releve — mais alors la pietaille grandirait
   * aussi. La seconde assertion est celle qui l'interdit.
   */
  it('donne son facteur au boss, et a chacun le sien', () => {
    const tailles = ARCHETYPES.map(() => 192);
    const echelles = archetypeScales(tailles, PROJECTILE_HIT_RADIUS);

    // Precision 6 et non 10 : `archetypeScales` rend un `Float32Array`, dont
    // les 24 bits de mantisse ne portent pas dix decimales.
    expect(echelles[BOSS_ARCHETYPE]).toBeCloseTo(
      spriteScale(192, PROJECTILE_HIT_RADIUS) * BOSS_BODY_SCALE,
      6,
    );
    for (const a of ARCHETYPES) {
      if (a.id === BOSS_ARCHETYPE) {
        continue;
      }
      // Chacun a SON facteur de corps : 1 pour la pietaille, plus pour le
      // colosse, jamais celui du boss.
      expect(echelles[a.id], a.name).toBeCloseTo(
        spriteScale(192, PROJECTILE_HIT_RADIUS) * a.bodyScale,
        6,
      );
      expect(a.bodyScale).toBeLessThan(BOSS_BODY_SCALE);
    }
  });
});

/**
 * L'animation d'attaque ne part qu'au DASH : pendant le chargement, le clip
 * reste sur sa premiere image.
 *
 * ⚠️ **`stopped` n'est PAS touche**, et `selectClip` continue de basculer sur
 * l'attaque des le chargement : les deux temps se distinguent a l'AFFICHAGE,
 * ou cela ne coute pas un octet sur le fil. Une mutation qui toucherait
 * `stopped` casserait le mouvement, pas le dessin.
 */
describe("clipFrameIndex fige la premiere image tant que le coup n'est pas parti", () => {
  it('rend la premiere image, et rien d autre, quand le clip est tenu', () => {
    expect(clipFrameIndex(6, 0, 0, true)).toBe(0);
    expect(clipFrameIndex(6, 41, 3, true)).toBe(0);
  });

  it('deroule le clip quand il ne l est pas', () => {
    expect(clipFrameIndex(6, 0, 0, false)).toBe(0);
    expect(clipFrameIndex(6, 1, 0, false)).toBe(1);
    // La phase decale le cycle : sans elle, mille cranes marchent au pas.
    expect(clipFrameIndex(6, 1, 2, false)).toBe(3);
    // Et il boucle.
    expect(clipFrameIndex(6, 5, 3, false)).toBe(2);
  });

  /**
   * Non-vacuite : sur ce cas precis, « tenu » et « deroule » ne rendent pas la
   * meme image. Sans cette moitie, un `held` ignore passerait a chaque fois que
   * l'animation se trouve par hasard sur sa premiere image.
   */
  it('distingue vraiment les deux cas', () => {
    expect(clipFrameIndex(6, 2, 1, true)).not.toBe(clipFrameIndex(6, 2, 1, false));
  });
});

/** Trois cases de 64 px : la course, puis DEUX images d'attaque. */
const FIXTURE_ATTACK_FRAME_1_X = 128;

function atlasAnime(): { manifest: AtlasManifest; atlas: Texture } {
  return {
    manifest: {
      image: 'atlas.png',
      size: 192,
      archetypes: [
        {
          id: 0,
          name: 'synthetique',
          cell: FIXTURE_CELL_PX,
          bounds: { ...FIXTURE_BOUNDS },
          clips: {
            run: clipAt(FIXTURE_RUN_X),
            attack: {
              frames: 2,
              rects: [
                { x: FIXTURE_ATTACK_X, y: 0, w: FIXTURE_CELL_PX, h: FIXTURE_CELL_PX },
                { x: FIXTURE_ATTACK_FRAME_1_X, y: 0, w: FIXTURE_CELL_PX, h: FIXTURE_CELL_PX },
              ],
            },
          },
        },
      ],
    },
    atlas: new Texture({ source: new TextureSource({ width: 192, height: 64 }) }),
  };
}

function particulesAnimees(horde: Horde, heldEntityId: number | null): Particle[] {
  const renderer = new HordeRenderer('/assets-de-test');
  const { manifest, atlas } = atlasAnime();
  renderer.adoptAtlas(manifest, atlas);
  const world = new Container();
  renderer.attach(world);
  renderer.draw(horde, new Rectangle(0, 0, MAP_SIZE, MAP_SIZE), 0, heldEntityId);
  const container = world.children[0] as ParticleContainer;
  return [...(container.particleChildren as Particle[])];
}

describe('HordeRenderer.draw — le boss qui arme reste sur sa premiere image', () => {
  /**
   * Le decor : deux entites ARRETEES, donc toutes deux sur le clip d'attaque
   * (`selectClip`), et une phase d'animation de 1 — sans quoi la premiere image
   * serait deja celle que le cycle donne, et « fige » se confondrait avec
   * « anime ».
   */
  function deuxArretes(): Horde {
    const horde = twoEnemies();
    horde.stopped[0] = 1;
    horde.stopped[1] = 1;
    horde.animPhase[0] = 1;
    horde.animPhase[1] = 1;
    return horde;
  }

  it('deroule le clip d attaque quand personne n arme', () => {
    const horde = deuxArretes();
    const p = particleOf(particulesAnimees(horde, null), horde, 0);
    expect(p.texture.frame.x).toBe(FIXTURE_ATTACK_FRAME_1_X);
  });

  it('fige la premiere image de l attaque pour l entite qui arme', () => {
    const horde = deuxArretes();
    const arme = horde.entityIdAt(0);
    const p = particleOf(particulesAnimees(horde, arme), horde, 0);
    expect(p.texture.frame.x).toBe(FIXTURE_ATTACK_X);
  });

  /**
   * ⚠️ **L'autre moitie, et c'est elle qui tue la mutation « figer tout le
   * monde ».** Une seule entite arme ; sa voisine, arretee elle aussi, continue
   * de s'animer.
   */
  it('ne fige QUE celle-la, jamais ses voisines', () => {
    const horde = deuxArretes();
    const arme = horde.entityIdAt(0);
    const particules = particulesAnimees(horde, arme);
    expect(particleOf(particules, horde, 1).texture.frame.x).toBe(FIXTURE_ATTACK_FRAME_1_X);
  });

  /**
   * ⚠️ **Une IDENTITE, pas un creneau.** Les creneaux se permutent a chaque
   * mort ; passer l'identite d'une entite absente ne doit figer personne, et
   * surtout pas le creneau 0 par defaut (`slotOf` rend `-1`).
   */
  it('ne fige personne quand l entite annoncee n est plus la', () => {
    const horde = deuxArretes();
    const particules = particulesAnimees(horde, 999_999);
    expect(particleOf(particules, horde, 0).texture.frame.x).toBe(FIXTURE_ATTACK_FRAME_1_X);
  });
});

/**
 * L'atlas n'a PAS d'entree pour le porteur. Sans l'alias de `adoptAtlas`, il
 * serait simule et tuable mais jamais dessine, en silence. L'atlas
 * synthetique ne range ici QUE le voleur : tout ce que le porteur dessine
 * vient de l'alias.
 */
describe('etape 11 : le porteur emprunte le voleur, en plus grand', () => {
  const VOLEUR = archetypeIdOf('thief');

  it('dessine le porteur avec les textures du voleur', () => {
    const horde = twoEnemies(PORTEUR_ARCHETYPE);
    expect(drawnParticles(horde, VOLEUR)).toHaveLength(2);
  });

  it('a l arret il attend sur la PREMIERE image de sa course, jamais sur l attaque du voleur', () => {
    const horde = twoEnemies(PORTEUR_ARCHETYPE);
    horde.stopped[0] = 1;
    horde.stopped[1] = 1;
    const particule = particleOf(drawnParticles(horde, VOLEUR), horde, 0);
    expect(particule.texture.frame.x).toBe(FIXTURE_RUN_X);
  });

  it('a 1,6 fois l echelle du voleur', () => {
    const porteurs = twoEnemies(PORTEUR_ARCHETYPE);
    const voleurs = twoEnemies(VOLEUR);
    const p = particleOf(drawnParticles(porteurs, VOLEUR), porteurs, 0);
    const v = particleOf(drawnParticles(voleurs, VOLEUR), voleurs, 0);
    expect(p.scaleY / v.scaleY).toBeCloseTo(PORTEUR_BODY_SCALE, 5);
  });
});
