import { ARCHETYPES, archetypeIdOf, PORTEUR_ARCHETYPE } from '@shared/archetypes';
import { MAP_SIZE, PROJECTILE_HIT_RADIUS } from '@shared/constants';
import type { Horde } from '@shared/horde';
import { Assets, type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

/**
 * Rendu batché de la pietaille.
 *
 * Un seul `ParticleContainer`, un seul atlas. Le §4.3 de l'orientation est
 * categorique : « le GPU se moque de 1 500 quads ; ce qui tue, c'est le cout
 * JavaScript par objet et par transform ». Le banc de l'etape 1 a chiffre
 * l'ecart avec des objets `Sprite` : x6.
 *
 * `uvs` en propriete dynamique permet l'animation.
 *
 * ⚠️ **Ce fichier a longtemps annonce que `color` donnerait « gratuitement la
 * teinte elementaire du §6.6 a l'etape 5 ». La promesse a ete tenue, puis
 * retiree** (tache 13 de l'etape 5a) : la teinte etait bien gratuite, et bien
 * invisible — *« je ne vois pas la marque sur les ennemis »*. Elle multipliait
 * un sprite deja sombre et bariole par une couleur d'element, ce qui ne change
 * presque rien a ce qu'on lit. La marque est passee au sol, sous les pieds,
 * dans `mark-renderer.ts` ; `markTint`, le `color` dynamique du conteneur et le
 * `tick` que `draw` recevait sont partis avec elle. **Ce renderer ne connait
 * plus les elements.**
 *
 * Aucun de `draw()`, `#depthSort()` ou `#ensurePool()` n'alloue en regime
 * etabli : reservoir de particules, tableaux de comptage et tableau
 * d'indices sont tous poses une fois puis reutilises. C'est le meme §4.3 qui
 * le justifie — a soixante images par seconde, un objet jete par image est un
 * objet jete soixante fois par seconde.
 */

/** Une planche empaquetee (course ou attaque) : ses images, dans l'ordre du cycle. */
export interface AtlasClip {
  frames: number;
  rects: { x: number; y: number; w: number; h: number }[];
}

/**
 * Boite englobante du contenu NON TRANSPARENT d'un archetype, en pixels de
 * cellule native — publiee par `tools/build_monster_atlas.py` (tache 17.1),
 * union sur TOUTES les images (course + attaque) pour donner une echelle
 * unique qui ne varie pas d'une image d'animation a l'autre. Voir
 * `contentSizePx`.
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

/** Images par seconde de l'animation, comme le pack (§12.2 de l'orientation). */
const ANIM_FPS = 10;

/**
 * Hauteur d'une bande de tri. Voir `#depthSort`.
 *
 * ⚠️ **Valait 64 px, et c'etait la cause du clignotement de z-index** remonte a
 * la verification manuelle de l'etape 3. Le commentaire d'origine justifiait ce
 * chiffre par « a l'interieur d'une bande, l'ordre est indifferent — c'est la
 * hauteur d'un demi-sprite ». C'est faux, et exactement a l'envers : sur un
 * demi-sprite de haut, deux entites se **recouvrent presque totalement**, donc
 * savoir laquelle passe devant est on ne peut plus visible. L'ordre intra-bande
 * suit l'ordre du tableau, qui n'a aucun rapport avec `y` — et il change des
 * qu'une des deux franchit une frontiere de bande.
 *
 * Mesure, 300 entites sur 40 images, en comptant les inversions d'ordre de
 * dessin que **rien dans les `y` ne justifie** :
 *
 * | Bande | Inversions injustifiees |
 * | --- | --- |
 * | 64 px | 1,99 % des paires |
 * | 16 px | 1,00 % |
 * | 8 px | 0,60 % |
 * | 4 px | 0,34 % |
 * | **2 px** | **0,15 %** |
 *
 * Le residuel a 2 px ne concerne que des entites separees de moins de deux
 * pixels en `y`, ou la profondeur est de toute facon ambigue.
 *
 * ⚠️ Deux fausses pistes ecartees par la mesure, pour qu'on ne les reprenne pas :
 * la corruption du tri par un `bandOf` hors bornes (il est garde depuis
 * toujours), et l'instabilite de l'ordre du tableau apres compaction — un
 * departage stable par identite a ete essaye et ne change **rien**
 * (31 228 inversions contre 31 698). Le coupable est la largeur de bande, seule.
 *
 * Le cout ne bouge pas : le tri par comptage est en `O(entites + bandes)`, et
 * passer de 94 a 3 001 bandes ajoute deux parcours de tableau typé par image.
 */
export const DEPTH_BAND = 2;

/**
 * Nombre de bandes couvrant la carte, calcule une fois pour toutes : `y` est
 * borne a `[0, MAP_SIZE]` par la simulation (`shared/horde.ts`,
 * `shared/separation.ts`), donc ce nombre ne varie jamais en cours de partie.
 *
 * Exporte pour le test (tache 15) : `bandOf` et `sortByDepth` se verifient
 * directement sans passer par `draw()`, qui exige un atlas charge (reseau,
 * indisponible en test).
 */
export const BAND_COUNT = Math.floor(MAP_SIZE / DEPTH_BAND) + 1;

/**
 * Ancre verticale du sprite d'un monstre : **le corps est centre sur la
 * position**.
 *
 * ⚠️ **Valait 0,75, et c'est ce que la verification manuelle de l'etape 5a a
 * remonte** : *« la hitbox semble plus basse »*. Elle l'etait de 16 px. Le
 * commentaire d'origine (etape 2) justifiait 0,75 ainsi : *« place les pieds
 * du sprite sur la position logique, pas son centre : c'est ce qui fait que le
 * tri par `y` correspond a ce que l'oeil attend »* — la convention habituelle
 * de la vue de dessus, ou une entite « est » la ou elle pose les pieds.
 *
 * **Ce que l'intention d'origine ne voyait pas** : dans ce jeu, une entite
 * n'« est » pas ses pieds. TOUT ce qui la touche est un cercle centre sur sa
 * position — le tir (`PROJECTILE_HIT_RADIUS`), le contact (`CONTACT_RADIUS`),
 * le ramassage (`ORB_PICKUP_RADIUS`), la separation (`SEPARATION_RADIUS`).
 * Avec 0,75, le sprite (64 px de haut une fois mis a l'echelle) s'etendait de
 * `y-48` a `y+16` : son centre visuel etait a `y-16`, soit **un quart du corps
 * au-dessus de la hitbox**. On visait le corps, et le projectile passait sous
 * les pieds.
 *
 * **Ce que ce changement casse, et il casse quelque chose** : les pieds ne
 * sont plus sur la position, ils sont a `y + hauteurDessinee / 2`. Deux
 * consequences, toutes deux assumees :
 * - le tri en profondeur (`#depthSort`) trie toujours par `horde.y`, donc par
 *   le CENTRE des corps et non par les pieds. L'ordre entre deux entites est
 *   inchange (le decalage est le meme pour toutes, a silhouette egale), mais
 *   la ligne de contact au sol de chaque sprite descend de 16 px par rapport a
 *   la position qui la classe ;
 * - **l'anneau au sol de la tache 13 ne peut plus etre pose sur la position**
 *   s'il doit etre « sous les pieds » : il lui faudra ce meme decalage vers le
 *   bas. C'est pourquoi la tache 14 passe avant la 13.
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
 * corps dans chaque sens depuis la tache 14, l'ancre etant centree
 * (`BODY_ANCHOR_Y`), contre trois quarts vers le haut auparavant. La marge de
 * 256 px couvre les deux tres largement : un corps dessine fait
 * `2 * PROJECTILE_HIT_RADIUS * BODY_SCALE` = 80 px.
 * (Le commentaire d'origine renvoyait a un « §12.3 de l'orientation » qui
 * n'existe pas — la section 12 s'arrete a 12.2.)
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
 * Exportee (tache 15) : c'est la seule garde entre une position hors carte
 * et une ecriture hors bornes dans `sortByDepth`, donc elle merite un test
 * direct plutot qu'une confiance aveugle dans son appelant.
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
 * Extrait de `HordeRenderer#depthSort` (tache 15) pour etre teste directement
 * sans dependre du chargement de l'atlas (reseau/canevas absents en test) —
 * la classe elle-meme se contente d'appeler cette fonction avec ses propres
 * tampons prives, comportement inchange.
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
 * ⚠️ **C'est un reglage de sensation, et le seul de ce fichier.** Il vient de
 * la verification manuelle de l'etape 5a — *« les ennemis sont trop petits par
 * rapport a la taille des projectiles »* — et il est ecrit ici, nomme, plutot
 * que glisse dans le corps de `spriteScale` : un test qui le recopierait en
 * dur garderait une valeur, pas un comportement (voir `bandOf(63) === 0` dans
 * le test, et `WAVE1_MIN_COUNT` a la tache 1).
 *
 * **Ce qu'il coute, dit franchement** : la hitbox MENT de
 * `PROJECTILE_HIT_RADIUS * (BODY_SCALE - 1)` = 8 px. Un tir qui frole le bord
 * du corps sans l'atteindre passe au travers. C'est le defaut de la tache 16
 * de l'etape 3 (« les hitbox sont mauvaises »), en beaucoup plus petit et dans
 * l'autre sens.
 *
 * **Pourquoi 8 px restent acceptables** : le projectile lui-meme est un POINT
 * pour la collision (`Projectiles.collide` teste la distance de l'entite au
 * segment parcouru) alors qu'il se dessine avec une empreinte allant jusqu'a
 * 18 px de diametre (`ProjectileLook.diameterPx`, tache 12). Il porte donc
 * deja un mensonge de 9 px, de meme nature et dans le meme sens. Le corps
 * reste sous cette borne — il n'ajoute pas un ecart plus grand que celui que
 * le rendu des projectiles assume deja. C'est la regle qui borne ce reglage,
 * et le test la verifie a partir du catalogue d'armes, pas d'un nombre.
 *
 * **L'autre moitie de la correction n'est pas ici** : la tache 12 a fait
 * passer les projectiles de 20 px uniformes a 7-18 px selon l'arme. Le rapport
 * de taille se corrige des deux cotes ; c'est pour ca que ce facteur peut
 * rester petit.
 */
export const BODY_SCALE = 1.25;

/**
 * Echelle de dessin d'un monstre, DERIVEE de `PROJECTILE_HIT_RADIUS` — jamais
 * l'inverse.
 *
 * Tache 16 : un sprite se dessinait a 192 px (la cellule native de l'atlas,
 * dessinee 1:1) pour une hitbox de tir de 64 px de diametre — trois fois trop
 * grand, on tirait sur le corps et le projectile passait au travers. Ecrire
 * une echelle reglee a la main a cote d'une hitbox reglee a la main est
 * exactement ce qui a produit ce defaut ; le tableau « Coherence des
 * constantes » du plan existe pour l'empecher.
 *
 * ⚠️ Tache 17.1 : la tache 16 appelait cette fonction avec la CELLULE (192 px)
 * — mais une cellule de Tiny Swords est en grande partie vide, la creature
 * n'en occupe qu'une fraction. Ramener le CADRE a la hitbox rend alors le
 * CORPS bien plus petit qu'elle, exactement l'inverse du but (« les monstres
 * sont minuscules » remonte en jeu). Cette fonction reste correcte et
 * inchangee — c'est `sizePx` qui doit desormais etre la taille du CONTENU
 * (`contentSizePx`), jamais celle de la cellule. Voir le site d'appel dans
 * `load()`.
 *
 * La relation reste la plus simple qui se laisse enoncer : la largeur dessinee
 * du CONTENU vaut le diametre de la hitbox de tir, a `BODY_SCALE` pres.
 *
 * ⚠️ **Tache 14 de l'etape 5a : ce paragraphe disait exactement l'inverse.**
 * Il refusait tout facteur de generosite — *« un peu plus grand pour que ca se
 * voie »* — comme « un nombre choisi au ressenti, non derive de la hitbox
 * qu'il est cense representer ». La verification manuelle a tranche contre :
 * *« les ennemis sont trop petits par rapport a la taille des projectiles »*.
 * Le facteur existe donc, mais il est NOMME et BORNE (voir `BODY_SCALE`) au
 * lieu d'etre dissous dans cette formule — ce qui garde intacte la seule chose
 * que le paragraphe d'origine protegeait vraiment : que personne ne puisse
 * regler la taille d'un monstre sans voir a cote de combien la hitbox ment.
 *
 * Prend la taille en parametre plutot qu'une constante figee : les plus gros
 * archetypes de `shared/archetypes.ts` (ours, panda, tortue, minotaure,
 * troll) ont une cellule de 256 a 384 px, pas 192 — la meme formule doit les
 * ramener au meme diametre a l'ecran, puisque `PROJECTILE_HIT_RADIUS` ne
 * varie pas par archetype.
 *
 * ⚠️ **`bodyScale` (etape 6a, tache 3) est le facteur PROPRE a l'archetype**,
 * `1` pour toute la pietaille et davantage pour le boss. Il MULTIPLIE
 * `BODY_SCALE` au lieu de le remplacer : le plafond du test ci-contre continue
 * de garder la pietaille — ce qu'il mesure, c'est de combien la hitbox ment
 * pour un monstre ordinaire — et le boss apporte son propre debordement sans
 * relever ce plafond pour les vingt autres. Voir `Archetype.bodyScale`.
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
 * Taille de reference d'un contenu d'atlas, pour `spriteScale` (tache 17.1) :
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
 * Choix du clip anime a dessiner (tache 17.2) : RENDU PUR, deduit de l'etat
 * d'arret DEJA simule (`horde.stopped`, `shared/horde.ts`) — jamais recalcule
 * ici a partir d'une distance, jamais transmis sur le fil. Isolee pour se
 * tester sans le reseau/canevas qu'exige `load()`, meme raison que
 * `spriteScale`/`facingScaleX` plus haut.
 */
export function selectClip<T>(stopped: boolean, run: T, attack: T): T {
  return stopped ? attack : run;
}

/**
 * Image a dessiner dans le clip courant (etape 6a, tache 13) — *« lance pas
 * l'animation d'attaque du boss avant qu'il dash, juste la frame 1 pour avoir
 * l'impression qu'il charge son attaque »*.
 *
 * ⚠️ **Le clip et l'ANIMATION du clip sont deux choses, et rien ne les
 * distinguait.** `Horde#applyCharge` pose `stopped = 1` pendant TOUTE la
 * charge, donc `selectClip` bascule sur l'attaque des le chargement et les six
 * images du troll defilaient pendant qu'il ne bougeait pas : le boss avait
 * l'air d'attaquer une seconde avant de partir, et le couloir devenait la seule
 * chose qui disait qu'il ne s'etait rien passe encore.
 *
 * ⚠️ **`stopped` N'EST PAS TOUCHE, et il ne doit pas l'etre** : il sert au
 * choix du clip, jamais au mouvement (voir le commentaire de `selectClip`
 * juste au-dessus), et il est simule des deux cotes. La distinction des deux
 * temps se fait ICI, a l'affichage, ou elle ne coute rien au fil.
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
 * vitesse tenue (tache 19), et depuis la tache 21 cette borne est INTRINSEQUE :
 * `archetypeOf(...).speed` SEULE (95 a 130 px/s dans `shared/archetypes.ts`),
 * la repulsion ne pouvant plus s'y ajouter (elle devie la direction, elle ne
 * propulse plus) — soit, a `TICK_HZ = 30`, 3,2 a 4,3 px par tick, quelle que
 * soit la densite de voisins. Ce seuil garde donc une marge tres large,
 * heritee d'une epoque ou la borne etait plus lache (44 px avant la tache 19,
 * 18 px entre les taches 19 et 21) et jamais resserree depuis faute de raison
 * de le faire : il reste tres inferieur a la distance separant deux points
 * choisis sans rapport sur une carte de `MAP_SIZE = 6000` px — c'est cet ecart
 * d'ordre de grandeur qui rend le departage fiable, pas une precision au
 * pixel pres.
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
    // `color` : FAUX depuis la tache 13. Il a porte la teinte elementaire du
    // §6.6 le temps des taches 9 a 12 ; la marque est maintenant un anneau au
    // sol (`mark-renderer.ts`), et plus rien ici n'ecrit `Particle.tint`.
    // Reteleverser a chaque image une couleur que personne ne pose serait un
    // canal paye pour rien, sur le plus gros batch du jeu.
    dynamicProperties: { position: true, uvs: true, vertex: true, color: false, rotation: false },
  });
  /** Réservoir de particules réutilisées : aucune allocation en régime établi. */
  readonly #pool: Particle[] = [];
  /**
   * `#runFrames[archetype][image]` / `#attackFrames[archetype][image]` —
   * tache 17.2 : deux clips par archetype, choisis par `selectClip` selon
   * `horde.stopped`. Auparavant un seul `#frames` (course uniquement) :
   * l'atlas n'embarquait pas l'attaque.
   *
   * ⚠️ **Indexes par IDENTIFIANT d'archetype, donc TROUES** (etape 6a, tache 5) :
   * l'atlas ne range pas tout le bestiaire, et le boss est l'archetype 19 alors
   * que les cinq elites qui le precedent n'y sont pas. Une case vide se lit
   * `undefined`, et `draw` saute l'entite — le meme comportement qu'avant cette
   * tache pour les six elites.
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
   * ⚠️ **Lue dans `adoptAtlas`, PAS dans `#ensurePool`.** Elle y valait
   * `#runFrames[0]?.[0]` — l'archetype 0 en dur, ce qui n'est plus une
   * hypothese tenable depuis que les indices sont troues : le premier archetype
   * range pourrait un jour n'etre pas le zero.
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
   * fichier, ni ne participe a la simulation (tache 16, etape 2).
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
   * ⚠️ **Separe de `load` PARCE QUE `load` va sur le reseau** (tache 9 bis) :
   * un `fetch` et un `Assets.load` qu'aucun environnement de test n'a. Tant
   * que les deux etaient une seule methode, `draw` retournait toujours au
   * premier `if (!this.#loaded)` en test, et **tout son corps pouvait etre
   * retire sans qu'une seule assertion ne bouge.** Verifie par mutation a
   * l'etape 5a. Avec ce point d'accroche, `horde-renderer.test.ts` adopte un
   * atlas synthetique et mesure ce que `draw` pose reellement sur les
   * particules — ce qui a d'abord garde la teinte elementaire, et garde
   * aujourd'hui l'ancre et l'echelle de la tache 14.
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
    // ⚠️ **Range par `a.id`, jamais par la position dans le tableau** (etape 6a,
    // tache 5). Tant que l'atlas contenait exactement les quatorze pietailles,
    // les deux coincidaient ; depuis qu'il embarque le boss (archetype 19) sans
    // les cinq elites qui le precedent, le manifeste a des TROUS. Lire la
    // position donnerait au boss les textures du creneau 14 — c'est-a-dire
    // aucune, et surtout la meme classe de defaut que « les monstres ont change
    // de sprite » : silencieuse, et fausse pour tout le monde.
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
      // voir `spriteScale`. Tache 17.1 : a partir du CONTENU non transparent
      // (`contentSizePx`), pas de la cellule — une cellule de Tiny Swords est en
      // grande partie vide, et la rapporter a la hitbox rendait le corps de la
      // creature bien plus petit qu'elle. Les archetypes n'ont pas tous la meme
      // cellule native (192 a 384 px, `shared/archetypes.ts`), la hitbox de
      // tir, elle, ne varie pas : chacun doit donc recevoir SON propre facteur.
      sizesPx[a.id] = contentSizePx(a.bounds);
    }
    // ⚠️ **Etape 11 : le porteur de coffre n'a PAS d'entree dans l'atlas** —
    // c'est un voleur agrandi (§3.4 de la spec), aucun actif nouveau. Sans cet
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
   * camera voit. Le §4.5 rappelle pourquoi la vue de dessus rend ce filtrage
   * trivial : la fenetre visible est un rectangle aligne sur les axes du monde.
   */
  /**
   * `timeMs` est l'horloge MURALE de l'animation. **Ce renderer ne recoit plus
   * le tick de horde depuis la tache 13** : il ne servait qu'a la teinte
   * elementaire, et un parametre que plus personne ne lit est du code qui ment.
   * C'est `MarkRingRenderer.draw` qui le recoit desormais.
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

      // Orientation (tache 16, etape 2) : deduite ici, sur TOUTE la horde et
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
      // Tache 17.2 : le clip est du rendu pur, deduit de l'etat d'arret DEJA
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
   * Un `ParticleContainer` dessine dans l'ordre du tableau. Le §4.5 tranche
   * deja : a 1 500 entites, c'est la difference entre un tri complet par image
   * et un rangement en compartiments. A l'interieur d'une bande, l'ordre suit
   * le tableau et n'a donc aucun rapport avec `y` — c'est pourquoi la bande
   * doit rester **etroite** (voir `DEPTH_BAND`) ; **entre** bandes, l'ordre
   * croissant en `y` est respecte, sans quoi une entite basse passerait
   * derriere une entite haute.
   *
   * Le tri par comptage est lineaire et n'alloue rien : deux passes sur
   * `visible`, en s'appuyant sur des tampons de taille fixe (`#bandCounts`,
   * `#bandOffsets`, `#sorted`) reutilises d'une image a l'autre. Le §4.3 est
   * categorique sur ce point precis — le cout qui tue n'est pas le GPU, c'est
   * l'objet JavaScript alloue puis jete a chaque image ; une `Map` et ses
   * tableaux de bande, recrees soixante fois par seconde, sont exactement ce
   * cout-la.
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
      // `BODY_ANCHOR_Y` pour ce que l'ancre a 0,75 visait, et ce que la
      // recentrer casse.
      this.#pool.push(new Particle({ texture: first, anchorX: 0.5, anchorY: BODY_ANCHOR_Y }));
    }
  }
}
