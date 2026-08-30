import { MAP_SIZE, MARK_DURATION_TICKS, PROJECTILE_HIT_RADIUS } from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import { Horde } from '@shared/horde';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { describe, expect, it } from 'vitest';

import {
  BAND_COUNT,
  bandOf,
  contentSizePx,
  DEPTH_BAND,
  FACING_DEAD_ZONE_PX,
  FACING_MAX_STEP_PX,
  facingScaleX,
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
  it('le diametre dessine egale le diametre de la hitbox de tir, quelle que soit la cellule native', () => {
    // Cellules reellement presentes dans l'atlas (voir shared/archetypes.ts) :
    // 192 px pour la pietaille courante, jusqu'a 384 px pour le troll.
    for (const cell of [128, 192, 256, 320, 384]) {
      const scale = spriteScale(cell, PROJECTILE_HIT_RADIUS);
      expect(scale * cell).toBeCloseTo(2 * PROJECTILE_HIT_RADIUS, 5);
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
