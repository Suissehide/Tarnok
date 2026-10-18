import { ARCHETYPES, archetypeIdOf, PORTEUR_ARCHETYPE } from '@shared/archetypes';
import { MAP_SIZE, PROJECTILE_HIT_RADIUS } from '@shared/constants';
import type { Horde } from '@shared/horde';
import { Assets, type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

/**
 * Rendu batché de la pietaille.
 *
 * Un seul `ParticleContainer`, un seul atlas : le GPU se moque de quelques
 * milliers de quads, ce qui tue c'est le cout JavaScript par objet et par
 * transform (des objets `Sprite` coutent six fois plus).
 *
 * `uvs` en propriete dynamique permet l'animation. Ce renderer ne connait pas
 * les elements : la marque est un anneau au sol (`mark-renderer.ts`), une
 * teinte de sprite serait invisible sur des monstres deja sombres et barioles.
 *
 * Aucun de `draw()`, `#depthSort()` ou `#ensurePool()` n'alloue en regime
 * etabli : reservoir de particules, tableaux de comptage et tableau
 * d'indices sont tous poses une fois puis reutilises. A soixante images par
 * seconde, un objet jete par image est un objet jete soixante fois par
 * seconde.
 */

/** Une planche empaquetee (course ou attaque) : ses images, dans l'ordre du cycle. */
export interface AtlasClip {
  frames: number;
  rects: { x: number; y: number; w: number; h: number }[];
}

/**
 * Boite englobante du contenu NON TRANSPARENT d'un archetype, en pixels de
 * cellule native — publiee par `tools/build_monster_atlas.py`, union sur
 * TOUTES les images (course + attaque) pour donner une echelle unique qui ne
 * varie pas d'une image d'animation a l'autre. Voir `contentSizePx`.
 */
export interface ContentBounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface AtlasManifest {
  image: string;
  size: number;
  archetypes: {
    id: number;
    name: string;
    cell: number;
    bounds: ContentBounds;
    clips: { run: AtlasClip; attack: AtlasClip };
  }[];
}

/** Images par seconde de l'animation, comme le pack. */
const ANIM_FPS = 10;

/**
 * Hauteur d'une bande de tri. Voir `#depthSort`.
 *
 * ⚠️ **Etroite, sinon le z-index clignote.** A l'interieur d'une bande,
 * l'ordre suit le tableau, sans rapport avec `y` — et il change des qu'une
 * entite franchit une frontiere de bande. Sur une bande d'un demi-sprite,
 * deux entites se **recouvrent presque totalement** : laquelle passe devant
 * se voit. A 2 px, les inversions d'ordre injustifiees tombent a 0,15 % des
 * paires et ne concernent que des entites separees de moins de deux pixels en
 * `y`, ou la profondeur est de toute facon ambigue.
 *
 * ⚠️ Fausses pistes deja ecartees par la mesure : un `bandOf` hors bornes (il
 * est garde) et l'instabilite de l'ordre du tableau apres compaction (un
 * departage stable par identite ne change rien). Le coupable est la largeur
 * de bande, seule.
 *
 * Le cout ne bouge pas : le tri par comptage est en `O(entites + bandes)`.
 */
export const DEPTH_BAND = 2;

/**
 * Nombre de bandes couvrant la carte, calcule une fois pour toutes : `y` est
 * borne a `[0, MAP_SIZE]` par la simulation (`shared/horde.ts`,
 * `shared/separation.ts`), donc ce nombre ne varie jamais en cours de partie.
 *
 * Exporte pour le test : `bandOf` et `sortByDepth` se verifient
 * directement sans passer par `draw()`, qui exige un atlas charge (reseau,
 * indisponible en test).
 */
export const BAND_COUNT = Math.floor(MAP_SIZE / DEPTH_BAND) + 1;

/**
 * Ancre verticale du sprite d'un monstre : **le corps est centre sur la
 * position**.
 *
 * ⚠️ **Pas aux pieds.** La convention habituelle de la vue de dessus (ancre a
 * 0,75, l'entite « est » ou elle pose les pieds) ne vaut pas ici : TOUT ce
 * qui touche une entite est un cercle centre sur sa position — le tir
 * (`PROJECTILE_HIT_RADIUS`), le contact (`CONTACT_RADIUS`), le ramassage
 * (`ORB_PICKUP_RADIUS`), la separation (`SEPARATION_RADIUS`). Avec les pieds
 * sur la position, on vise le corps et le projectile passe sous les pieds.
 *
 * **Consequences assumees** : les pieds sont a `y + hauteurDessinee / 2`.
 * - le tri en profondeur (`#depthSort`) trie par `horde.y`, donc par le
 *   CENTRE des corps. L'ordre entre deux entites est le meme (le decalage est
 *   le meme pour toutes, a silhouette egale) ;
 * - l'anneau de marque doit descendre d'autant pour etre « sous les pieds »
 *   (`MARK_RING_FOOT_OFFSET_PX`).
 *
 * `0,5` n'est pas un reglage : c'est la definition de « centre ». Le reglage
 * de sensation de ce fichier est `BODY_SCALE`, et lui seul — d'ou une
 * constante NON exportee : le test lit l'ancre sur la particule reellement
 * dessinee et y attend `0,5`, ce qu'aucune constante recopiee ne prouverait.
 */
const BODY_ANCHOR_Y = 0.5;

/** Marge autour de la vue, pour qu'une entite n'apparaisse pas en plein ecran. */
const CULL_MARGIN = 128;

/**
 * Marge des bornes explicites du `ParticleContainer`, pour absorber les
 * sprites qui depassent leur point d'ancrage — au plus une demi-hauteur de
 * corps dans chaque sens (`BODY_ANCHOR_Y`). Un corps dessine fait
 * `2 * PROJECTILE_HIT_RADIUS * BODY_SCALE` = 80 px : 256 px couvre largement.
 * Un `ParticleContainer` ne calcule pas ses bornes automatiquement — sans
 * `boundsArea`, son getter de bornes renvoie un rectangle vide statique, et le
 * culling comme toute extraction se comportent mal.
 */
const BOUNDS_MARGIN = 256;

/**
 * Bande de tri d'une ordonnee, bornee a `[0, BAND_COUNT - 1]`.
 *
 * `y` est deja cense rester dans `[0, MAP_SIZE]` (voir `BAND_COUNT`), mais un
 * indice hors bornes silencieux dans un tableau type (lecture `undefined`,
 * ecriture ignoree) corromprait le tri sans jamais lever d'erreur. Le clamp
 * est le prix, negligeable, de ne jamais avoir a s'en inquieter.
 *
 * Exportee : c'est la seule garde entre une position hors carte et une
 * ecriture hors bornes dans `sortByDepth`, donc elle merite un test direct.
 */
export function bandOf(y: number): number {
  const band = Math.floor(y / DEPTH_BAND);
  if (band < 0) {
    return 0;
  }
  if (band >= BAND_COUNT) {
    return BAND_COUNT - 1;
  }
  return band;
}

/**
 * Tri en profondeur par comptage, pur : deux passes lineaires sur `visible`,
 * sans allocation, ecrivant dans les tampons fournis par l'appelant.
 *
 * Extrait de `HordeRenderer#depthSort` pour etre teste sans dependre du
 * chargement de l'atlas (reseau/canevas absents en test).
 */
export function sortByDepth(
  y: Float32Array,
  visible: Int32Array,
  visibleCount: number,
  bandCounts: Uint32Array,
  bandOffsets: Uint32Array,
  sorted: Int32Array,
): void {
  bandCounts.fill(0);

  // Passe 1 : combien d'entites dans chaque bande.
  for (let n = 0; n < visibleCount; n++) {
    const i = visible[n] ?? 0;
    const band = bandOf(y[i] ?? 0);
    bandCounts[band] = (bandCounts[band] ?? 0) + 1;
  }

  // Sommes prefixees : offset de depart de chaque bande dans `sorted`.
  bandOffsets[0] = 0;
  for (let b = 0; b < BAND_COUNT; b++) {
    bandOffsets[b + 1] = (bandOffsets[b] ?? 0) + (bandCounts[b] ?? 0);
  }

  // Passe 2 : place chaque entite a son offset. `bandCounts` est reutilise
  // comme curseur d'ecriture par bande — les sommes prefixees ci-dessus n'en
  // ont plus besoin, ca evite un troisieme tableau.
  bandCounts.fill(0);
  for (let n = 0; n < visibleCount; n++) {
    const i = visible[n] ?? 0;
    const band = bandOf(y[i] ?? 0);
    const cursor = (bandOffsets[band] ?? 0) + (bandCounts[band] ?? 0);
    sorted[cursor] = i;
    bandCounts[band] = (bandCounts[band] ?? 0) + 1;
  }
}

/**
 * Facteur de CORPS : de combien le corps dessine deborde la hitbox de tir.
 *
 * ⚠️ **C'est un reglage de sensation, et le seul de ce fichier** : les ennemis
 * dessines a la taille exacte de la hitbox paraissent trop petits a cote des
 * projectiles. Il est nomme ici plutot que glisse dans `spriteScale` : un test
 * qui le recopierait en dur garderait une valeur, pas un comportement.
 *
 * **Ce qu'il coute** : la hitbox MENT de
 * `PROJECTILE_HIT_RADIUS * (BODY_SCALE - 1)` = 8 px. Un tir qui frole le bord
 * du corps sans l'atteindre passe au travers.
 *
 * **Pourquoi 8 px restent acceptables** : le projectile lui-meme est un POINT
 * pour la collision (`Projectiles.collide` teste la distance de l'entite au
 * segment parcouru) alors qu'il se dessine avec une empreinte allant jusqu'a
 * 18 px de diametre (`ProjectileLook.diameterPx`). Il porte donc deja un
 * mensonge de 9 px, de meme nature et dans le meme sens. Le corps reste sous
 * cette borne : c'est la regle qui borne ce reglage, et le test la verifie a
 * partir du catalogue d'armes, pas d'un nombre.
 */
export const BODY_SCALE = 1.25;

/**
 * Echelle de dessin d'un monstre, DERIVEE de `PROJECTILE_HIT_RADIUS` — jamais
 * l'inverse.
 *
 * Une echelle reglee a la main a cote d'une hitbox reglee a la main finit par
 * mentir : on tire sur le corps et le projectile passe au travers.
 *
 * ⚠️ `sizePx` est la taille du CONTENU (`contentSizePx`), jamais celle de la
 * cellule : une cellule de Tiny Swords est en grande partie vide, et ramener
 * le CADRE a la hitbox rendrait la creature minuscule. Voir l'appel dans
 * `load()`.
 *
 * La relation : la largeur dessinee du CONTENU vaut le diametre de la hitbox
 * de tir, a `BODY_SCALE` pres — un facteur NOMME et BORNE, pour que personne
 * ne regle la taille d'un monstre sans voir de combien la hitbox ment.
 *
 * Prend la taille en parametre plutot qu'une constante figee : les plus gros
 * archetypes de `shared/archetypes.ts` (ours, panda, tortue, minotaure,
 * troll) ont une cellule de 256 a 384 px, pas 192 — la meme formule doit les
 * ramener au meme diametre a l'ecran, puisque `PROJECTILE_HIT_RADIUS` ne
 * varie pas par archetype.
 *
 * ⚠️ **`bodyScale` est le facteur PROPRE a l'archetype**, `1` pour toute la
 * pietaille et davantage pour le boss. Il MULTIPLIE `BODY_SCALE` au lieu de
 * le remplacer : le plafond du test continue de garder la pietaille, et le
 * boss apporte son propre debordement sans relever ce plafond pour les
 * autres. Voir `Archetype.bodyScale`.
 */
export function spriteScale(sizePx: number, hitRadiusPx: number, bodyScale = 1): number {
  if (sizePx <= 0) {
    return 1;
  }
  return (2 * hitRadiusPx * BODY_SCALE * bodyScale) / sizePx;
}

/**
 * Applique `spriteScale` a une taille par archetype — un facteur par archetype.
 *
 * ⚠️ **L'INDICE EST L'IDENTIFIANT D'ARCHETYPE**, ici comme dans `ARCHETYPES` et
 * comme dans le manifeste de l'atlas (`tools/build_monster_atlas.py` :
 * *« l'index dans cette liste EST l'identifiant d'archetype »*). C'est ce qui
 * permet d'aller lire `bodyScale` sans que l'appelant ait a transporter une
 * seconde liste parallele — et une liste parallele est exactement ce qui finit
 * par se desynchroniser.
 */
export function archetypeScales(
  sizesPx: readonly number[],
  hitRadiusPx: number,
): Float32Array<ArrayBuffer> {
  const out = new Float32Array(sizesPx.length);
  for (let i = 0; i < sizesPx.length; i++) {
    out[i] = spriteScale(sizesPx[i] ?? 0, hitRadiusPx, ARCHETYPES[i]?.bodyScale ?? 1);
  }
  return out;
}

/**
 * Taille de reference d'un contenu d'atlas, pour `spriteScale` :
 * la plus GRANDE des deux dimensions de sa boite englobante.
 *
 * Pas la largeur ni la hauteur seules : une silhouette allongee dans un sens
 * (un lezard qui court, tres large et peu haut) ne doit pas recevoir une
 * echelle calculee sur sa dimension la plus petite, ce qui la ferait deborder
 * du diametre de la hitbox precisement dans le sens ou elle s'etend le plus.
 */
export function contentSizePx(bounds: { readonly w: number; readonly h: number }): number {
  return Math.max(bounds.w, bounds.h);
}

/**
 * Choix du clip anime a dessiner : RENDU PUR, deduit de l'etat
 * d'arret DEJA simule (`horde.stopped`, `shared/horde.ts`) — jamais recalcule
 * ici a partir d'une distance, jamais transmis sur le fil. Isolee pour se
 * tester sans le reseau/canevas qu'exige `load()`.
 */
export function selectClip<T>(stopped: boolean, run: T, attack: T): T {
  return stopped ? attack : run;
}

/**
 * Image a dessiner dans le clip courant.
 *
 * ⚠️ **Le clip et l'ANIMATION du clip sont deux choses.** `Horde#applyCharge`
 * pose `stopped = 1` pendant TOUTE la charge, donc `selectClip` bascule sur
 * l'attaque des le chargement : sans cette fonction, le boss aurait l'air
 * d'attaquer une seconde avant de partir.
 *
 * ⚠️ **`stopped` N'EST PAS TOUCHE, et il ne doit pas l'etre** : il sert au
 * choix du clip, jamais au mouvement, et il est simule des deux cotes. La
 * distinction des deux temps se fait ICI, a l'affichage, ou elle ne coute
 * rien au fil.
 *
 * `held` vrai : la PREMIERE image, figee — le troll arme son coup.
 */
export function clipFrameIndex(
  frameCount: number,
  animStep: number,
  phase: number,
  held: boolean,
): number {
  if (held) {
    return 0;
  }
  return (animStep + phase) % frameCount;
}

/**
 * En dessous de ce deplacement horizontal (en px, entre deux images
 * consecutives), `dx` est trop proche de zero pour trancher un sens sans
 * bruit : un deplacement quasi vertical, ou une entite immobile entre deux
 * pas de simulation (le rendu tourne a la cadence de l'ecran, la simulation a
 * `TICK_HZ` — la plupart des images ne changent aucune position). Voir
 * `facingScaleX`.
 */
export const FACING_DEAD_ZONE_PX = 0.05;

/**
 * Au-dessus de ce deplacement horizontal, `dx` est trop grand pour etre le
 * deplacement REEL d'une entite d'une image a l'autre — c'est le signe qu'un
 * creneau a change d'identite, pas qu'un monstre a bondi.
 *
 * `Horde.#removeAt` compacte par permutation avec la derniere entite vivante
 * (voir `shared/horde.ts`) : un creneau peut donc porter une entite
 * differente d'une image a l'autre, avec une position sans rapport. Le pas le
 * plus rapide qu'un VRAI monstre puisse franchir en un tick est borne par sa
 * vitesse propre (`archetypeOf(...).speed`, 95 a 130 px/s ; la repulsion
 * devie sans propulser) — soit, a `TICK_HZ = 30`, 3,2 a 4,3 px par tick. Le
 * seuil garde une marge tres large : ce qui compte est qu'il reste tres
 * inferieur a la distance separant deux points sans rapport sur une carte de
 * `MAP_SIZE = 6000` px.
 */
export const FACING_MAX_STEP_PX = 96;

/**
 * Signe de `scaleX` d'un sprite de monstre, DEDUIT du seul deplacement
 * horizontal observe depuis la derniere image (`dx = x - xPrecedent`).
 *
 * ⚠️ Rendu pur : aucun champ nouveau dans `Horde`, aucun octet de plus sur le
 * fil (voir la doc de `HordeRenderer#draw`). Tout ce qu'il faut est deja dans
 * `horde.x`, que le client possede a chaque image.
 *
 * Deux gardes (voir leurs constantes) : sous `FACING_DEAD_ZONE_PX`, `dx` ne
 * permet pas de trancher un sens ; au-dessus de `FACING_MAX_STEP_PX`, `dx` ne
 * peut pas etre un vrai deplacement. Dans les deux cas, on conserve `previous`
 * plutot que de papillotter ou de suivre un saut de compaction.
 */
export function facingScaleX(dx: number, previous: 1 | -1): 1 | -1 {
  const magnitude = Math.abs(dx);
  if (magnitude < FACING_DEAD_ZONE_PX || magnitude > FACING_MAX_STEP_PX) {
    return previous;
  }
  return dx > 0 ? 1 : -1;
}

export class HordeRenderer {
  readonly #container = new ParticleContainer({
    // `vertex` : necessaire pour que `scaleX`/`scaleY` (mise a l'echelle
    // depuis la hitbox, orientation gauche/droite) soient reteleversees a
    // chaque image — voir `spriteScale` et `facingScaleX`. Le conteneur des
    // flashs d'impact (`projectile-renderer.ts`) fait deja ce meme choix pour
    // la meme raison.
    //
    // `color` : FAUX. Rien ici n'ecrit `Particle.tint`. Reteleverser a chaque image une couleur que personne ne pose serait un
    // canal paye pour rien, sur le plus gros batch du jeu.
    dynamicProperties: { position: true, uvs: true, vertex: true, color: false, rotation: false },
  });
  /** Réservoir de particules réutilisées : aucune allocation en régime établi. */
  readonly #pool: Particle[] = [];
  /**
   * `#runFrames[archetype][image]` / `#attackFrames[archetype][image]` : deux
   * clips par archetype, choisis par `selectClip` selon `horde.stopped`.
   *
   * ⚠️ **Indexes par IDENTIFIANT d'archetype, donc TROUES** : l'atlas ne range
   * pas tout le bestiaire (le boss est l'archetype 19, les elites qui le
   * precedent n'y sont pas). Une case vide se lit `undefined`, et `draw` saute
   * l'entite.
   */
  #runFrames: Texture[][] = [];
  #attackFrames: Texture[][] = [];
  /** `#scale[archetype]` : voir `spriteScale`/`contentSizePx`, calculee une fois dans `load()`. */
  #scale = new Float32Array(0);
  /**
   * Texture posee sur les particules du reservoir a leur creation — remplacee
   * a chaque image par celle du clip courant (`draw`). N'importe laquelle fait
   * l'affaire, mais `Particle` en exige une : c'est la premiere que l'atlas
   * porte, quelle que soit sa place.
   *
   * ⚠️ **Lue dans `adoptAtlas`, PAS dans `#ensurePool`** : les indices etant
   * troues, rien ne garantit que l'archetype 0 soit range.
   */
  #placeholder: Texture | null = null;
  #loaded = false;

  /**
   * Tampons du tri par comptage (`#depthSort`), dimensionnes au premier appel
   * sur la capacite de la horde puis jamais realloues — voir `#ensureSortBuffers`.
   */
  #visible = new Int32Array(0);
  #sorted = new Int32Array(0);
  /** `#bandCounts[b]` : nombre d'entites visibles dans la bande `b`. Remis a zero et reecrit a chaque image, jamais realloue — `BAND_COUNT` est constant. */
  readonly #bandCounts = new Uint32Array(BAND_COUNT);
  /** Sommes prefixees : offset de depart de chaque bande dans `#sorted`. */
  readonly #bandOffsets = new Uint32Array(BAND_COUNT + 1);
  /**
   * `#prevX[slot]` : abscisse tenue par ce creneau a l'image precedente, et
   * `#facing[slot]` (-1 ou 1) : le sens qui en a ete deduit. Tous deux
   * dimensionnes sur `horde.capacity` et jamais realloues, meme discipline
   * que `#visible`/`#sorted` — voir `#ensureSortBuffers`.
   *
   * Purement cosmetique : aucune des deux valeurs ne sort jamais de ce
   * fichier, ni ne participe a la simulation.
   */
  #prevX = new Float32Array(0);
  #facing = new Int8Array(0);

  constructor(private readonly assetsBase: string) {
    // Bornes explicites couvrant la carte entiere : voir le commentaire de
    // `BOUNDS_MARGIN`.
    this.#container.boundsArea = new Rectangle(
      -BOUNDS_MARGIN,
      -BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
    );
  }

  async load(): Promise<void> {
    const manifest = (await fetch(`${this.assetsBase}/derived/monsters.json`).then((r) =>
      r.json(),
    )) as AtlasManifest;
    // `Texture.from` est synchrone : elle ne telecharge rien. Il faut passer
    // par `Assets.load` pour recuperer l'atlas depuis son URL.
    const atlas = await Assets.load<Texture>(`${this.assetsBase}/derived/${manifest.image}`);
    this.adoptAtlas(manifest, atlas);
  }

  /**
   * Decoupe l'atlas et rend le renderer capable de dessiner.
   *
   * ⚠️ **Separe de `load` PARCE QUE `load` va sur le reseau** : un `fetch` et
   * un `Assets.load` qu'aucun environnement de test n'a. Sans ce point
   * d'accroche, `draw` ne passerait jamais sa garde en test, et **tout son
   * corps pourrait etre retire sans qu'une seule assertion ne bouge**. Avec
   * lui, `horde-renderer.test.ts` adopte un atlas synthetique et mesure ce que
   * `draw` pose reellement sur les particules (ancre, echelle).
   */
  adoptAtlas(manifest: AtlasManifest, atlas: Texture): void {
    const texturesOf = (clip: AtlasClip): Texture[] =>
      clip.rects.map(
        (r) =>
          new Texture({
            source: atlas.source,
            frame: new Rectangle(r.x, r.y, r.w, r.h),
          }),
      );
    // ⚠️ **Range par `a.id`, jamais par la position dans le tableau** : le
    // manifeste a des TROUS (le boss, archetype 19, sans les elites qui le
    // precedent). Lire la position donnerait a un archetype les textures d'un
    // autre, silencieusement.
    this.#runFrames = [];
    this.#attackFrames = [];
    this.#placeholder = null;
    const sizesPx: number[] = [];
    for (const a of manifest.archetypes) {
      const run = texturesOf(a.clips.run);
      this.#runFrames[a.id] = run;
      this.#attackFrames[a.id] = texturesOf(a.clips.attack);
      this.#placeholder ??= run[0] ?? null;
      // Un facteur d'echelle par archetype, DERIVE de `PROJECTILE_HIT_RADIUS` —
      // voir `spriteScale`. A partir du CONTENU non transparent
      // (`contentSizePx`), pas de la cellule. Les archetypes n'ont pas tous la meme
      // cellule native (192 a 384 px, `shared/archetypes.ts`), la hitbox de
      // tir, elle, ne varie pas : chacun doit donc recevoir SON propre facteur.
      sizesPx[a.id] = contentSizePx(a.bounds);
    }
    // ⚠️ **Le porteur de coffre n'a PAS d'entree dans l'atlas** — c'est un
    // voleur agrandi, aucun actif nouveau. Sans cet
    // alias, `draw` le sauterait en silence faute de textures. Sa taille passe
    // par le mecanisme du boss : `bodyScale` (1,6) multiplie la taille de
    // contenu du voleur dans `archetypeScales`. Son clip d'« attaque » est la
    // PREMIERE image de la course, figee : `selectClip` le montre quand
    // `stopped` vaut 1, c'est-a-dire quand il attend — avec le vrai clip
    // d'attaque du voleur, il frapperait dans le vide.
    const voleur = archetypeIdOf('thief');
    this.#runFrames[PORTEUR_ARCHETYPE] = this.#runFrames[voleur] ?? [];
    this.#attackFrames[PORTEUR_ARCHETYPE] = this.#runFrames[voleur]?.slice(0, 1) ?? [];
    sizesPx[PORTEUR_ARCHETYPE] = sizesPx[voleur] ?? 0;
    // Les trous de `sizesPx` valent `undefined` : `archetypeScales` y lit 0,
    // et `spriteScale` rend alors 1 — une echelle jamais utilisee, puisque
    // l'entite est sautee faute de textures.
    this.#scale = archetypeScales(sizesPx, PROJECTILE_HIT_RADIUS);
    this.#loaded = true;
  }

  /** Vrai des que l'atlas est decoupe — meme lecture que sur les calques procéduraux. */
  get loaded(): boolean {
    return this.#loaded;
  }

  attach(parent: Container): void {
    parent.addChild(this.#container);
  }

  /**
   * Dessine les entites visibles.
   *
   * Le client **simule** toute la horde mais ne **dessine** que ce que la
   * camera voit. La vue de dessus rend ce filtrage trivial : la fenetre visible est un rectangle aligne sur les axes du monde.
   */
  /**
   * `timeMs` est l'horloge MURALE de l'animation. **Ce renderer ne recoit pas
   * le tick de horde** : c'est `MarkRingRenderer.draw` qui le recoit.
   */
  draw(horde: Horde, view: Rectangle, timeMs: number, heldEntityId: number | null = null): void {
    if (!this.#loaded) {
      return;
    }
    // ⚠️ **Une identite, pas un creneau.** Les creneaux se permutent a chaque
    // mort (`Horde.#removeAt` compacte par permutation) ; l'identite du boss,
    // elle, ne bouge pas. Resolue UNE fois par image plutot qu'une fois par
    // entite : le comparer dans la boucle ferait une recherche par entite
    // dessinee, sur le plus gros batch du jeu.
    const heldSlot = heldEntityId === null ? -1 : horde.slotOf(heldEntityId);

    this.#ensureSortBuffers(horde.capacity);

    const minX = view.x - CULL_MARGIN;
    const maxX = view.x + view.width + CULL_MARGIN;
    const minY = view.y - CULL_MARGIN;
    const maxY = view.y + view.height + CULL_MARGIN;
    const animStep = Math.floor((timeMs / 1000) * ANIM_FPS);

    // Tableau reutilise : on ecrit dans `#visible` sans jamais le reallouer,
    // `visibleCount` en est la longueur logique.
    const visible = this.#visible;
    let visibleCount = 0;
    for (let i = 0; i < horde.count; i++) {
      const x = horde.x[i] ?? 0;
      const y = horde.y[i] ?? 0;

      // Orientation : deduite ici, sur TOUTE la horde et
      // pas seulement les entites visibles, dans cette meme passe deja en
      // O(horde.count) — pas de second parcours pour un cout de rendu qui ne
      // doit pas grandir. Une entite hors-vue garde ainsi un sens a jour des
      // qu'elle revient dans le cadre, au lieu d'un sens fige perime.
      const previousFacing: 1 | -1 = (this.#facing[i] ?? 0) === -1 ? -1 : 1;
      this.#facing[i] = facingScaleX(x - (this.#prevX[i] ?? 0), previousFacing);
      this.#prevX[i] = x;

      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        visible[visibleCount] = i;
        visibleCount++;
      }
    }

    const sorted = this.#depthSort(horde, visible, visibleCount);
    this.#ensurePool(visibleCount);

    const children = this.#container.particleChildren;
    children.length = 0;

    for (let n = 0; n < visibleCount; n++) {
      const i = sorted[n] ?? 0;
      const particle = this.#pool[n];
      const archetype = horde.archetype[i] ?? 0;
      // Le clip est du rendu pur, deduit de l'etat d'arret DEJA
      // simule (`horde.stopped`) — voir `selectClip`. Jamais recalcule ici a
      // partir d'une distance : ce calcul-la vit dans `Horde.retarget`
      // (`shared/horde.ts`), pour rester identique des deux cotes.
      const stopped = (horde.stopped[i] ?? 0) === 1;
      const frames = selectClip(stopped, this.#runFrames[archetype], this.#attackFrames[archetype]);
      if (!particle || !frames || frames.length === 0) {
        continue;
      }

      particle.x = horde.x[i] ?? 0;
      particle.y = horde.y[i] ?? 0;
      // La phase decale le cycle : sans elle, mille cranes marchent au pas, et
      // ca se voit immediatement.
      particle.texture = frames[
        clipFrameIndex(frames.length, animStep, horde.animPhase[i] ?? 0, i === heldSlot)
      ] as Texture;
      // Taille DERIVEE de la hitbox de tir (`spriteScale`), retournee vers la
      // gauche quand l'entite s'y deplace (`facingScaleX`) : l'atlas dessine
      // ses cycles de course vers la droite (verifie sur les feuilles source),
      // donc `scaleX` negatif est la seule des deux mises a l'echelle a
      // changer de signe.
      const scale = this.#scale[archetype] ?? 1;
      particle.scaleX = scale * (this.#facing[i] === -1 ? -1 : 1);
      particle.scaleY = scale;
      children.push(particle);
    }

    this.#container.update();
  }

  destroy(): void {
    this.#container.destroy();
  }

  /**
   * Tri en profondeur par **compartiments**, pas par `sort()` global — et par
   * **comptage**, pas par une `Map`.
   *
   * Un `ParticleContainer` dessine dans l'ordre du tableau. Un rangement en
   * compartiments evite un tri complet par image. A l'interieur d'une bande,
   * l'ordre suit le tableau et n'a donc aucun rapport avec `y` — c'est
   * pourquoi la bande doit rester **etroite** (voir `DEPTH_BAND`) ; **entre**
   * bandes, l'ordre croissant en `y` est respecte.
   *
   * Le tri par comptage est lineaire et n'alloue rien : deux passes sur
   * `visible`, en s'appuyant sur des tampons de taille fixe (`#bandCounts`,
   * `#bandOffsets`, `#sorted`) reutilises d'une image a l'autre. Une `Map` et
   * ses tableaux de bande, recrees soixante fois par seconde, sont exactement
   * le cout JavaScript a eviter.
   */
  #depthSort(horde: Horde, visible: Int32Array, visibleCount: number): Int32Array {
    sortByDepth(horde.y, visible, visibleCount, this.#bandCounts, this.#bandOffsets, this.#sorted);
    return this.#sorted;
  }

  /**
   * Dimensionne les tampons du tri sur la capacite de la horde — au pire cas
   * toutes les entites sont visibles a la fois. Ne fait que grandir, jamais
   * retrecir, et ne realloue pas si la capacite n'a pas change : en pratique,
   * une seule fois, a la premiere image.
   */
  #ensureSortBuffers(capacity: number): void {
    if (this.#visible.length >= capacity) {
      return;
    }
    this.#visible = new Int32Array(capacity);
    this.#sorted = new Int32Array(capacity);
    // Memes garanties que les deux tableaux ci-dessus (ne grandit jamais que
    // vers le haut, jamais realloue hors de cette fonction) : voir la doc de
    // `#prevX`/`#facing`.
    this.#prevX = new Float32Array(capacity);
    this.#facing = new Int8Array(capacity);
  }

  #ensurePool(needed: number): void {
    const first = this.#placeholder;
    if (!first) {
      return;
    }
    while (this.#pool.length < needed) {
      // Le corps est centre sur la position, en `x` comme en `y` — tout ce qui
      // touche l'entite est un cercle centre sur cette meme position. Voir
      // `BODY_ANCHOR_Y`.
      this.#pool.push(new Particle({ texture: first, anchorX: 0.5, anchorY: BODY_ANCHOR_Y }));
    }
  }
}
