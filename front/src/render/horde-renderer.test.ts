import { MAP_SIZE, MARK_DURATION_TICKS, PROJECTILE_HIT_RADIUS } from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
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
  BAND_COUNT,
  BODY_SCALE,
  bandOf,
  contentSizePx,
  DEPTH_BAND,
  FACING_DEAD_ZONE_PX,
  FACING_MAX_STEP_PX,
  facingScaleX,
  HordeRenderer,
  markTint,
  selectClip,
  sortByDepth,
  spriteScale,
} from './horde-renderer';

/**
 * Tache 15 : `bandOf` ne doit jamais pouvoir sortir de `[0, BAND_COUNT)`.
 *
 * `counts[band]` (dans `sortByDepth`) est une ecriture sur `Uint32Array` : un
 * indice hors bornes y est un NO-OP SILENCIEUX (ni exception, ni `undefined`
 * a l'ecriture) — la meme propriete du langage qui avait deja fait tomber la
 * tache 7 (troncature de capacite des projectiles). `bandOf` est la seule
 * garde entre une position hors carte et cette ecriture.
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
    // ⚠️ Derive de `DEPTH_BAND`, jamais code en dur. La premiere version
    // affirmait `bandOf(63) === 0` et `bandOf(64) === 1` — vrai pour une bande
    // de 64 px, faux des qu'on la retrecit. Passer la bande de 64 a 2 px pour
    // corriger le clignotement a fait echouer ce test alors que `bandOf` etait
    // parfaitement correcte : le test gardait la valeur d'une constante, pas le
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
    // (defense en profondeur, meme logique que la tache 7).
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
 * Tache 16 : un sprite de monstre se dessinait a 192 px (la cellule native de
 * l'atlas, dessinee 1:1) pour une hitbox de tir de 64 px de diametre
 * (`PROJECTILE_HIT_RADIUS = 32`) — trois fois trop grand, un projectile qui
 * touche visiblement le corps passait au travers.
 *
 * `spriteScale` est la relation qui remplace « une echelle reglee a la main a
 * cote d'une hitbox reglee a la main » : elle DERIVE l'echelle de dessin de
 * `PROJECTILE_HIT_RADIUS`, pour n'importe quelle cellule native. Les deux
 * tests ci-dessous verifient la RELATION, pas un nombre fige — exactement la
 * legon de `bandOf(63) === 0` rappelee plus haut dans ce fichier : un test qui
 * pin la valeur d'aujourd'hui ne proteg rien du defaut de demain.
 */
describe('spriteScale derive la taille dessinee de PROJECTILE_HIT_RADIUS', () => {
  it('le diametre dessine vaut le diametre de la hitbox de tir a BODY_SCALE pres, quelle que soit la cellule native', () => {
    // Cellules reellement presentes dans l'atlas (voir shared/archetypes.ts) :
    // 192 px pour la pietaille courante, jusqu'a 384 px pour le troll.
    //
    // ⚠️ `BODY_SCALE` est DERIVE de la constante, jamais recopie : c'est un
    // reglage de sensation (tache 14), et deux tests sont devenus
    // intermittents a la tache 1 pour avoir recopie `WAVE1_MIN_COUNT`. Ce que
    // ce test garde, c'est la RELATION — le diametre dessine suit la hitbox,
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
 * Tache 14 : *« les ennemis sont trop petits par rapport a la taille des
 * projectiles »*. La correction se fait des deux cotes — la tache 12 a fait
 * passer les projectiles de 20 px uniformes a 7-18 px selon l'arme, et le
 * corps de la creature gagne `BODY_SCALE`.
 *
 * ⚠️ **Ce facteur rend la hitbox menteuse dans l'AUTRE sens que le defaut de
 * l'etape 3** (des sprites de 192 px pour une hitbox de 64) : un tir qui frole
 * le bord du corps sans atteindre le cercle passe au travers. Ce qui le rend
 * acceptable est une borne, pas une opinion : le projectile est un POINT pour
 * la collision alors qu'il se dessine avec une empreinte — il porte deja un
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
 * Tache 16, etape 2 : les monstres ne se retournaient jamais vers leur
 * direction de deplacement. `facingScaleX` deduit le signe de `scaleX`
 * (`vertex` dans le `ParticleContainer`, voir le commentaire de la classe)
 * du seul deplacement horizontal observe entre deux images — jamais d'un
 * champ ajoute a `Horde` ni d'un octet de plus sur le fil.
 *
 * Deux gardes, testees separement :
 * - `FACING_DEAD_ZONE_PX` : sous ce seuil, `dx` est trop proche de zero pour
 *   trancher un sens (deplacement quasi vertical, ou entite immobile entre
 *   deux ticks de simulation — le rendu tourne plus vite que la simulation) ;
 *   on conserve le sens precedent plutot que de papillotter sur un signe qui
 *   n'a plus de sens visuel.
 * - `FACING_MAX_STEP_PX` : au-dessus de ce seuil, `dx` est trop grand pour
 *   etre un deplacement reel d'une image a l'autre (le tableau `Horde` est
 *   compacte par `#removeAt` — swap avec la derniere entite vivante — un
 *   creneau peut donc changer d'identite d'une image a l'autre et produire un
 *   `dx` de plusieurs centaines de pixels qui n'est le deplacement de
 *   PERSONNE) ; on conserve aussi le sens precedent plutot que de suivre ce
 *   saut.
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
 * Tache 17.1 : une cellule d'atlas Tiny Swords de 192 px est en grande partie
 * VIDE — la creature n'en occupe qu'une fraction. `spriteScale(cellPx, ...)`
 * (tache 16) ramenait le CADRE a la hitbox, ce qui rend le CORPS bien plus
 * petit qu'elle. `contentSizePx` est la mesure qui doit desormais nourrir
 * `spriteScale` : la plus grande dimension de la boite englobante du contenu
 * NON TRANSPARENT (`tools/build_monster_atlas.py` la calcule et la publie
 * dans le manifeste, voir `bounds` dans `AtlasManifest`).
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
 * Tache 17.2 : le choix du clip est du RENDU PUR, derive de l'etat d'arret
 * DEJA simule (`horde.stopped`, voir `shared/horde.ts`) — jamais recalcule ni
 * envoye sur le fil. `selectClip` isole cette seule decision pour qu'elle se
 * teste sans dependre du chargement de l'atlas (reseau/canevas absents en
 * test, meme raison que `sortByDepth`/`spriteScale` plus haut dans ce fichier).
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
 * Étape 5a, §9 : *« un element sur un ennemi : teinte du sprite »*. La teinte
 * est ce que le §6.6 appelle « le probleme visuel le plus difficile du
 * projet », et c'est aussi la ligne dont le cout doit rester nul — d'ou une
 * fonction qui ne teste JAMAIS l'element et s'appuie sur `ELEMENT.NEUTRE =
 * 0xffffff`, l'identite du produit que fait `Particle.tint`.
 *
 * ⚠️ **Les deux moities, toujours** (R24/R25) : « rien ne se teinte » et
 * « tout se teinte pareil » se ressemblent beaucoup dans un test faible. Un
 * `markTint` qui rendrait toujours `0xffffff` passerait le cas non marque ; un
 * qui rendrait toujours la teinte de la Braise passerait le cas marque. Il
 * faut donc, dans le meme fichier, un marque QUI CHANGE et un non marque QUI
 * NE CHANGE PAS.
 */
describe('markTint — la teinte elementaire du sprite (§6.6)', () => {
  it('teint un ennemi marque de la couleur de son element', () => {
    const horde = new Horde(4);
    horde.applyMark(0, ELEMENT.BRAISE, 1, 100);

    expect(markTint(horde, 0, 100)).toBe(elementOf(ELEMENT.BRAISE).tint);
  });

  it('distingue deux elements : la Braise et le Givre ne rendent pas la meme teinte', () => {
    const horde = new Horde(4);
    horde.applyMark(0, ELEMENT.BRAISE, 1, 100);
    horde.applyMark(1, ELEMENT.GIVRE, 1, 100);

    expect(markTint(horde, 0, 100)).not.toBe(markTint(horde, 1, 100));
  });

  it("laisse un ennemi NON marque a l'identite 0xffffff — le sprite est rendu inchange", () => {
    const horde = new Horde(4);

    // Aucune marque posee : le tableau vaut `ELEMENT.NEUTRE`, et c'est la
    // seule chose qui rend la teinte gratuite pour toute la horde.
    expect(markTint(horde, 0, 100)).toBe(0xffffff);
  });

  it('rend l identite des que la marque a EXPIRE, sans qu aucun balayage ne l efface', () => {
    const horde = new Horde(4);
    horde.applyMark(0, ELEMENT.BRAISE, 1, 100);

    // Derive de la constante partagee, jamais un nombre en dur : la duree de
    // marque est un reglage de la tache 11 (« a tester en jeu »), et un test
    // qui la figerait garderait une valeur, pas un comportement.
    expect(markTint(horde, 0, 100 + MARK_DURATION_TICKS - 1)).toBe(elementOf(ELEMENT.BRAISE).tint);
    expect(markTint(horde, 0, 100 + MARK_DURATION_TICKS)).toBe(0xffffff);
  });
});

/**
 * Tache 9 bis : **le corps de `draw`, atteint pour la premiere fois.**
 *
 * `draw` retournait au premier `if (!this.#loaded)` dans tout environnement de
 * test, parce que `load` fetch un manifeste et un atlas. Deux mutations y
 * survivaient a 170 tests verts : retirer la pose de la teinte, et remettre
 * `color: false` sur le conteneur. `adoptAtlas` separe le decoupage du reseau,
 * et un atlas synthetique suffit alors a mesurer ce que `draw` pose vraiment.
 *
 * ⚠️ **Les deux moities, comme pour `markTint`** (R24/R25) : un `draw` qui ne
 * poserait jamais la teinte laisserait `Particle.tint` a sa valeur par defaut,
 * qui est justement `0xffffff` — donc le cas NON marque passerait tout seul.
 * Seul l'ennemi marque prouve que la ligne existe.
 */
/**
 * ⚠️ **La cellule, le contenu, la largeur et la hauteur valent tous des
 * nombres DIFFERENTS, et c'est delibere.** La premiere version de cette
 * fixture avait `cell: 32` et `bounds: { w: 32, h: 32 }` : l'echelle calculee
 * depuis la cellule, depuis la largeur du contenu, depuis sa hauteur ou depuis
 * la bonne valeur y donnaient toutes le meme resultat, et le test de l'echelle
 * posee par `draw` (plus bas) n'aurait distingue aucune de ces mutations. Avec
 * une cellule de 64, un contenu de 24x40, seule `contentSizePx(bounds) = 40`
 * rend l'echelle attendue.
 */
const FIXTURE_CELL_PX = 64;
const FIXTURE_BOUNDS = { x: 12, y: 8, w: 24, h: 40 } as const;

function syntheticAtlas(): { manifest: AtlasManifest; atlas: Texture } {
  const clip: AtlasClip = {
    frames: 1,
    rects: [{ x: 0, y: 0, w: FIXTURE_CELL_PX, h: FIXTURE_CELL_PX }],
  };
  return {
    manifest: {
      image: 'atlas.png',
      size: 64,
      archetypes: [
        {
          id: 0,
          name: 'synthetique',
          cell: FIXTURE_CELL_PX,
          bounds: { ...FIXTURE_BOUNDS },
          clips: { run: clip, attack: clip },
        },
      ],
    },
    atlas: new Texture({ source: new TextureSource({ width: 64, height: 64 }) }),
  };
}

/** Deux ennemis poses, le creneau 0 marque a la Braise au tick `TINT_TICK`. */
const TINT_TICK = 100;

function drawnParticles(horde: Horde): Particle[] {
  const renderer = new HordeRenderer('/assets-de-test');
  const { manifest, atlas } = syntheticAtlas();
  renderer.adoptAtlas(manifest, atlas);

  const world = new Container();
  renderer.attach(world);
  renderer.draw(horde, new Rectangle(0, 0, MAP_SIZE, MAP_SIZE), 0, TINT_TICK);

  const container = world.children[0] as ParticleContainer;
  // `particleChildren` est type `IParticle[]`, qui ne porte pas `tint` (seul
  // son encodage `color`) ; le reservoir de `HordeRenderer`, lui, ne contient
  // que des `Particle`.
  return [...(container.particleChildren as Particle[])];
}

function twoEnemies(): Horde {
  const horde = new Horde(4);
  const order: WaveOrder = {
    waveId: 1,
    spawnTick: 0,
    seed: 3,
    archetype: 0,
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

describe('HordeRenderer.draw — la teinte elementaire arrive bien sur la particule', () => {
  it('dessine une particule par ennemi visible', () => {
    const horde = twoEnemies();
    expect(drawnParticles(horde)).toHaveLength(2);
  });

  it('pose la teinte de l element sur l ennemi MARQUE', () => {
    const horde = twoEnemies();
    horde.applyMark(0, ELEMENT.BRAISE, 1, TINT_TICK);

    const marked = particleOf(drawnParticles(horde), horde, 0);
    expect(marked.tint).toBe(elementOf(ELEMENT.BRAISE).tint);
  });

  it('laisse l ennemi NON marque a l identite, dans la meme image', () => {
    const horde = twoEnemies();
    horde.applyMark(0, ELEMENT.BRAISE, 1, TINT_TICK);

    const plain = particleOf(drawnParticles(horde), horde, 1);
    expect(plain.tint).toBe(0xffffff);
  });

  it('distingue deux elements : le Givre ne rend pas la teinte de la Braise', () => {
    const horde = twoEnemies();
    horde.applyMark(0, ELEMENT.GIVRE, 1, TINT_TICK);

    const marked = particleOf(drawnParticles(horde), horde, 0);
    expect(marked.tint).toBe(elementOf(ELEMENT.GIVRE).tint);
    expect(marked.tint).not.toBe(elementOf(ELEMENT.BRAISE).tint);
  });

  /**
   * ⚠️ **`color` dynamique, sinon la teinte est televersee une fois puis
   * jamais rafraichie** — et un ennemi garde la couleur du precedent occupant
   * de son creneau. Rien dans `draw` ne le montre : le drapeau ne se lit que
   * sur le conteneur.
   */
  it('reteleverse la teinte a chaque image', () => {
    expect(new HordeRenderer('/assets-de-test').dynamicTint).toBe(true);
  });
});

/**
 * Tache 14 : *« les ennemis sont trop petits par rapport a la taille des
 * projectiles et la hitbox semble plus basse »*.
 *
 * Ces deux assertions ne sont possibles que depuis la tache 9 bis : l'ancre et
 * l'echelle ne se lisent nulle part ailleurs que sur la particule reellement
 * dessinee. `spriteScale` et `contentSizePx` se testent purement plus haut ;
 * ici on garde le CABLAGE — que `draw` pose bien ce que `adoptAtlas` a
 * calcule, et depuis le CONTENU de l'atlas, pas depuis sa cellule.
 */
describe('HordeRenderer.draw — le corps est centre sur la position et a la bonne taille', () => {
  it("centre le corps sur la position : l'ancre verticale est au milieu du sprite", () => {
    const horde = twoEnemies();
    const particle = particleOf(drawnParticles(horde), horde, 0);

    // 0,5 n'est pas un reglage a deriver d'une constante : c'est la definition
    // de « centre ». A 0,75 (l'ancre d'origine, les pieds sur la position), le
    // corps montait de 25 % de sa hauteur au-dessus de la hitbox — les 16 px
    // que l'auteur a vus.
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
