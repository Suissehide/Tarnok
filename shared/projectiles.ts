import { ARCHETYPES } from './archetypes';
import {
  CRIT_CHANCE,
  CRIT_MULTIPLIER,
  PROJECTILE_HIT_RADIUS,
  VIF_ARGENT_HIT_RADIUS_BONUS,
} from './constants';
import type { Horde } from './horde';
import { hashRoll } from './random';
import {
  BOOMERANG_CATCH_PX,
  FRAGMENT_DAMAGE_RATIO,
  FRAGMENT_LIFE_TICKS,
  FRAGMENT_SCALE_RATIO,
  HOMING_RANGE,
  MOTION,
  ORBIT_BREATH,
  ORBIT_BREATH_TICKS,
  ORBIT_RADIUS,
  ORBIT_TURNS_PER_S,
  REHIT_TICKS,
  RICOCHET_MIN_LIFE_TICKS,
  RICOCHET_RANGE,
  SINUS_AMPLITUDE,
  SINUS_PERIOD_TICKS,
  SPIRAL_RAD_PER_TICK,
  type Weapon,
} from './weapons';
import type { ZoneField } from './zones';

/**
 * Les projectiles : simules localement, jamais repliques (§5.2 de la spec).
 *
 * Un tir est entierement determine par des donnees que serveur et clients
 * possedent deja — l'arme, le tick, la position du tireur, et (§5.3 revu par
 * la tache 13 : la visee suit le curseur, ce n'est plus une auto-visee sur la
 * horde) la direction visee, transmise sur un octet signe par `INPUT` et
 * `SNAPSHOT`. C'est ce SEUL octet qui transite ; la salve elle-meme (position,
 * vitesse, degats de chaque projectile) reste calculee identiquement des deux
 * cotes a partir de la meme direction quantifiee — voir `fireSalvoDirected` et
 * `quantizeAxis` dans `shared/protocol.ts`. Le test de derivation de ce
 * fichier verrouille cette propriete : deux instances independantes, memes
 * entrees, memes projectiles.
 *
 * ⚠️ **`Projectiles.collide` accepte `zones`/`tick` en optionnels depuis
 * l'etape 5c (tache 3), et ca ne rouvre PAS ce contrat.** Ils elargissent le
 * rayon de touche d'un ennemi en zone de Vif-argent — un effet de DEGAT, qui
 * decide QUI un projectile touche, jamais OU il va. La trajectoire
 * (`#emit`/`fireSalvoDirected`) reste aveugle a la horde et aux zones ; seule
 * `collide`, qui resout une collision DEJA CALCULEE, les consulte.
 *
 * Tableaux typés, jamais un objet par projectile (§4.4 de l'orientation) — a
 * plusieurs centaines de projectiles vivants, le meme raisonnement que pour
 * `Horde` s'applique. `x` et `y` sont publics en lecture, comme sur `Horde` :
 * le rendu (tache 11) les lit directement sans jamais materialiser d'objet.
 *
 * L'expiration se compte en **pas de simulation**, pas en tick absolu : un
 * compte a rebours par projectile, decremente une fois par appel a `step`.
 * Ca evite a cette classe de devoir tenir sa propre horloge synchronisee sur
 * celle de l'appelant — la seule hypothese est que `step` est appele
 * exactement une fois par tick, comme `Horde.step`.
 */
/**
 * Le rayon de touche AU CARRE de chaque archetype, et sa borne elargie — deux
 * tables cuites au chargement, indexees par `Horde.archetype`.
 *
 * ⚠️ **Le rayon de touche suit le CORPS, et c'est le defaut que l'etape 8
 * corrige.** `collide` testait un rayon unique de 32 px pour tout le monde,
 * alors que le boss est dessine a `BODY_SCALE x bodyScale` de ce rayon — soit
 * 240 px de diametre pour une cible de 64. Il fallait viser le centre d'un
 * corps douze fois plus large que la zone qui encaissait : en jeu, « la hitbox
 * du boss est trop petite ». `bodyScale` existait deja et disait exactement
 * ca — `BOSS_CHARGE_WIDTH_PX` et `spriteScale` le lisent tous les deux depuis
 * l'etape 6a ; seule la collision l'ignorait.
 *
 * ⚠️ **Etape 12 : trop grande cette fois, et c'est `hitScale` qui tranche.**
 * `bodyScale` dit la taille de la CELLULE dessinee, pas celle du corps : le
 * coup de massue du troll elargit sa cellule, et le corps visible n'occupait
 * plus que les deux tiers des 96 px. La touche lit desormais
 * `Archetype.hitScale`, mesure sur l'atlas (70 px pour le boss).
 *
 * ⚠️ **Des TABLES, pas un calcul dans la boucle.** La boucle interne de
 * `collide` est en projectiles x ennemis — 49 millions de tests de distance par
 * tick ont deja ete mesures ici (voir le pre-filtre du Vif-argent). Une lecture
 * de tableau type remplace exactement l'ancienne constante ; un
 * `archetypeOf(...).bodyScale` y aurait mis une recherche d'objet.
 */
/** Le rayon de touche (pas au carre) de chaque archetype — pour les projectiles grossis par le calibre. */
const HIT_R_BY_ARCHETYPE = Float32Array.from(ARCHETYPES, (a) => PROJECTILE_HIT_RADIUS * a.hitScale);

const HIT_R2_BY_ARCHETYPE = Float32Array.from(ARCHETYPES, (a) => {
  const r = PROJECTILE_HIT_RADIUS * a.hitScale;
  return r * r;
});

/** La meme table, majoree du bonus de Vif-argent : la borne du pre-filtre. */
const WIDE_R2_BY_ARCHETYPE = Float32Array.from(ARCHETYPES, (a) => {
  const r = PROJECTILE_HIT_RADIUS * a.hitScale + VIF_ARGENT_HIT_RADIUS_BONUS;
  return r * r;
});

/**
 * Le critique d'un TIREUR (etape 10, §3.2) : sa chance (Precision) et son
 * multiplicateur (Ferocite). Calcule par `critOf` (shared/firing.ts), des
 * deux cotes, et passe a l'emission.
 */
export interface Crit {
  readonly chance: number;
  readonly multiplier: number;
}

/**
 * Ou est le tireur `by` MAINTENANT (etape 12, §3.2) — lu par l'orbite et le
 * retour du boomerang seuls. `undefined` : le projectile se rabat sur son
 * point d'emission.
 */
export type Anchor = (by: number) => { readonly x: number; readonly y: number } | undefined;

/** Taille de l'anneau de recontact d'un projectile jamais consomme (§3.3). */
const REHIT_RING = 8;
const TAU = Math.PI * 2;

/** Le critique sans aucune carte : celui de l'etape 8. */
export const BASE_CRIT: Crit = Object.freeze({ chance: CRIT_CHANCE, multiplier: CRIT_MULTIPLIER });

export class Projectiles {
  /** Position courante, publique en lecture pour le rendu — comme `Horde.x` / `Horde.y`. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  /**
   * Tick de tir. Public en lecture : la tache 11 en aura besoin pour le
   * rendu (par exemple un fondu a l'apparition), et `#removeAt` doit le
   * compacter comme tout le reste — l'exposer permet de le verifier depuis
   * un test sans ajouter de code de test dans la classe.
   */
  readonly bornTick: Uint32Array;

  readonly #vx: Float32Array;
  readonly #vy: Float32Array;
  readonly #damage: Float32Array;
  /**
   * Element porte par le projectile, index dans `ELEMENTS` — recopie de
   * `Weapon.element` a l'emission (etape 5a, tache 6). `ELEMENT.NEUTRE` pour
   * les cinq armes neutres, qui ne marquent rien et ne posent aucune zone.
   */
  readonly #element: Uint8Array;
  /**
   * Index du joueur qui a tire — c'est LUI que la marque retient (`Horde.markBy`)
   * et que la zone porte (`ZoneField.by`), donc lui que la Synergie du §7
   * comparera. Sans ce tableau, une reaction entre deux joueurs et une
   * reaction en solo seraient indiscernables au moment de l'impact.
   */
  readonly #by: Uint8Array;
  /**
   * Rayon de l'explosion a l'impact, en pixels monde — recopie de
   * `Weapon.blastRadius` a l'emission (etape 6a, tache 16). `0` : ce
   * projectile ne touche que ce qu'il percute.
   *
   * ⚠️ **Recopie a cote, JAMAIS relu dans `WEAPONS` a l'impact** — la meme
   * raison que `#damage`, `#element` et `#by` juste au-dessus, et la raison
   * exacte pour laquelle `#weapon` peut rester purement cosmetique : ce qui
   * decide d'un degat ne doit pas dependre d'une table qu'on pourrait
   * reindexer.
   */
  readonly #blastRadius: Float32Array;
  /**
   * Identifiant de l'arme qui a tire, index dans `WEAPONS` — recopie de
   * `Weapon.id` a l'emission (etape 5a, tache 12).
   *
   * ⚠️ **Purement COSMETIQUE, et c'est le seul champ qui le soit.** Il existe
   * pour que le rendu sache quel projectile dessiner : chaque arme, son
   * apparence propre (`Weapon.look`). La simulation ne le lit jamais — ce qui
   * decide d'un degat, d'une marque ou d'une zone est deja recopie a cote
   * (`#damage`, `#element`, `#by`), justement pour que le tir ne depende pas
   * d'une table.
   *
   * `Uint8Array` : le catalogue en compte treize (tache 9 de l'etape 5b), le
   * §6.2 en projette quarante.
   */
  readonly #weapon: Uint8Array;
  /**
   * Traversees RESTANTES : combien d'ennemis supplementaires ce projectile
   * peut encore transpercer avant d'etre consomme (etape 8). Recopie de
   * `Weapon.pierce` a l'emission, decremente a chaque traversee.
   */
  readonly #pierce: Uint8Array;
  /**
   * Le multiplicateur critique EMPORTE par ce projectile : celui de son
   * tireur si le tirage a crite, `1` sinon (etapes 8 et 10).
   *
   * ⚠️ **Decide a l'EMISSION, pas a l'impact.** Les deux cotes emettent la
   * meme salve a partir des memes trois entiers (le tick, le tireur, le rang
   * du projectile) : ils tirent donc le meme critique, et le client peut
   * l'afficher au moment ou le serveur l'arbitre. Le decider a l'impact aurait
   * voulu dire deux tirages, a deux instants, sur deux machines.
   *
   * ⚠️ **Le multiplicateur voyage, pas un booleen** (etape 10) : Ferocite le
   * rend propre au tireur, et les trois lecteurs (deux dans `combat.ts`, un
   * dans `client.ts`) lisent le projectile — plus jamais `CRIT_MULTIPLIER`.
   */
  readonly #crit: Float32Array;
  /**
   * Echelle du projectile — recopie de `Weapon.projectileScale` a l'emission
   * (carte « calibre »). Elargit le rayon de touche ET le dessin : un
   * projectile plus gros a l'ecran qui ne toucherait pas plus large mentirait.
   */
  readonly #scale: Float32Array;
  /**
   * Fraction des degats de l'impact infligee ensuite en poison — recopie de
   * `Weapon.venom` (carte « venin »). Le serveur seul la convertit en degats
   * (`Venins`), le client n'en tire qu'un effet visuel.
   */
  readonly #venom: Float32Array;
  /** Rebonds restants — recopie de `Weapon.bounces`, decremente a chaque ricochet. */
  readonly #bounces: Uint8Array;
  /** Guidage en radians par seconde — recopie de `Weapon.homing`. `0` : file droit. */
  readonly #homing: Float32Array;
  /**
   * Le dernier ennemi touche par ce projectile, ou `-1`.
   *
   * ⚠️ **Sans lui, « transpercer » devient « frapper le meme ennemi a chaque
   * tick ».** Un projectile qui survit a son impact continue sa course, mais
   * la cible qu'il vient de traverser est encore a portee au tick suivant —
   * il la retoucherait, et une fleche a trois traversees infligerait quatre
   * fois ses degats au PREMIER ennemi rencontre au lieu d'en traverser
   * quatre.
   *
   * ponytail: un seul souvenir, donc A -> B -> A reste possible si le
   * projectile recroise sa premiere cible apres une autre — rare pour ceux qui
   * l'utilisent encore (droit, mortier, sinus). L'orbite et le boomerang, qui
   * recroisent par construction, tiennent l'anneau `#ringId` a la place.
   */
  readonly #lastHit: Int32Array;
  /** Pas restants avant expiration. Decremente a chaque `step`. */
  readonly #ticksRemaining: Int32Array;
  /**
   * Position au DEBUT du pas de simulation qui vient de s'ecouler — alimentee
   * par `step`, lue par `collide`. Voir la doc de `collide` : c'est ce qui
   * permet de tester le SEGMENT parcouru pendant le pas plutot que le seul
   * point d'arrivee.
   *
   * Stockee plutot que reconstruite par `x - vx * dt` : reconstruire
   * imposerait a `collide` de connaitre le `dt` du dernier `step`, donc un
   * ordre d'appel implicite entre les deux methodes. La stocker rend
   * `collide` correcte quel que soit le moment ou elle est appelee apres
   * `step`.
   */
  readonly #prevX: Float32Array;
  readonly #prevY: Float32Array;
  /** Mouvement, code `MOTION` — recopie de `Weapon.motion` (etape 12). */
  readonly #motion: Uint8Array;
  /** Eclats a projeter a la consommation — recopie de `Weapon.fragments`. */
  readonly #fragments: Uint8Array;
  /** Echelle gagnee par seconde de vol — recopie de `Weapon.growth`. */
  readonly #growth: Float32Array;
  /** Vitesse de base (px/s) : celle du boomerang a l'aller, de la ligne du sinus, du guidage. */
  readonly #speed: Float32Array;
  /**
   * Cap de la ligne de vol (droit, mortier, sinus, boomerang a l'aller), ou
   * angle courant sur le cercle pour l'orbite.
   */
  readonly #angle: Float32Array;
  /**
   * Point d'emission (centre de l'orbite et but du retour sans ancre), ou
   * point courant de la ligne de vol du sinus.
   */
  readonly #ox: Float32Array;
  readonly #oy: Float32Array;
  /**
   * Pas vecus depuis l'emission. ⚠️ Pas `life - ticksRemaining` : un ricochet
   * rallonge la vie, et l'anneau de recontact veut une horloge qui ne recule pas.
   */
  readonly #age: Int32Array;
  /**
   * Anneau des `REHIT_RING` derniers ennemis touches par un projectile jamais
   * consomme, avec son age au contact (§3.3), et la prochaine case a ecraser.
   */
  readonly #ringId: Int32Array;
  readonly #ringAge: Int32Array;
  readonly #ringNext: Uint8Array;

  #count = 0;

  constructor(readonly capacity: number) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.bornTick = new Uint32Array(capacity);
    this.#vx = new Float32Array(capacity);
    this.#vy = new Float32Array(capacity);
    this.#damage = new Float32Array(capacity);
    this.#element = new Uint8Array(capacity);
    this.#by = new Uint8Array(capacity);
    this.#blastRadius = new Float32Array(capacity);
    this.#weapon = new Uint8Array(capacity);
    this.#pierce = new Uint8Array(capacity);
    this.#crit = new Float32Array(capacity);
    this.#scale = new Float32Array(capacity);
    this.#venom = new Float32Array(capacity);
    this.#bounces = new Uint8Array(capacity);
    this.#homing = new Float32Array(capacity);
    this.#lastHit = new Int32Array(capacity).fill(-1);
    this.#ticksRemaining = new Int32Array(capacity);
    this.#prevX = new Float32Array(capacity);
    this.#prevY = new Float32Array(capacity);
    this.#motion = new Uint8Array(capacity);
    this.#fragments = new Uint8Array(capacity);
    this.#growth = new Float32Array(capacity);
    this.#speed = new Float32Array(capacity);
    this.#angle = new Float32Array(capacity);
    this.#ox = new Float32Array(capacity);
    this.#oy = new Float32Array(capacity);
    this.#age = new Int32Array(capacity);
    this.#ringId = new Int32Array(capacity * REHIT_RING).fill(-1);
    this.#ringAge = new Int32Array(capacity * REHIT_RING);
    this.#ringNext = new Uint8Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  /**
   * Tire une salve de `weapon` depuis `(x, y)`, visant `targetId` dans
   * `horde`.
   *
   * `horde` doit etre l'etat sur lequel `targetId` a ete choisi — c'est ce
   * qui garantit que la direction visee est, elle aussi, coherente avec la
   * cible retenue.
   *
   * Si `targetId` ne designe plus une entite vivante dans `horde`, la salve
   * ne part pas : sans cible, aucune direction ne serait deterministe des
   * deux cotes, donc rien ne se tire plutot que de deviner.
   *
   * **Cette regle peut faire diverger serveur et client, et c'est accepte.**
   * Les deux visent sur l'etat COURANT de leur propre horde (jamais retarde
   * — voir `nearestTarget`, corrige en tache 9). Si une mort n'est pas
   * encore parvenue au client, sa horde peut encore contenir la cible que le
   * serveur, lui, a deja retiree de la sienne — donc l'un saute le tir
   * pendant que l'autre le lance, ou l'inverse. L'ecart est purement visuel
   * et se resorbe au rejeu du §3.2 : les projectiles ne sont jamais
   * repliques, et les degats restent arbitres par le serveur (§5.4). Ce qui
   * serait inacceptable, ce serait qu'un client tire une conclusion sur les
   * degats a partir de sa propre salve — ce n'est jamais le cas, `fireSalvo`
   * ne fait que deplacer un projectile.
   */
  /**
   * ⚠️ **Aucun appelant en production depuis la tache 13.** La visee suit le
   * curseur, donc les salves partent par `fireSalvoDirected`. Conserve pour
   * l'etape 4 (armes a tete chercheuse) ; ne decrit pas le comportement
   * actuel du jeu.
   */
  fireSalvo(
    weapon: Weapon,
    tick: number,
    x: number,
    y: number,
    targetId: number,
    horde: Horde,
  ): void {
    const targetSlot = horde.slotOf(targetId);
    if (targetSlot < 0) {
      return;
    }

    const dx = (horde.x[targetSlot] ?? 0) - x;
    const dy = (horde.y[targetSlot] ?? 0) - y;
    this.#emit(weapon, tick, x, y, Math.atan2(dy, dx));
  }

  /**
   * Tire une salve de `weapon` depuis `(x, y)`, dans la direction `(dirX,
   * dirY)` — decision de la tache 13 : la visee suit le curseur, elle n'est
   * plus derivee d'une cible (voir `fireSalvo`, qui reste pour d'eventuelles
   * armes futures a ciblage automatique, mais que plus personne n'appelle
   * pour l'arme de base).
   *
   * `(dirX, dirY) = (0, 0)` ne tire pas : c'est la direction qu'envoie un
   * curseur pile sur le joueur, ou une souris jamais bougee, et les DEUX
   * cotes (serveur, chaque client) la voient identique — ne pas tirer est
   * deterministe, choisir une direction par defaut ne le serait pas.
   *
   * Seul l'ANGLE de `(dirX, dirY)` compte (`Math.atan2` ignore la norme) :
   * l'appelant peut donc passer la paire quantifiee sur un octet signe
   * (-127..127) telle quelle, sans la renormaliser — c'est d'ailleurs ce qui
   * est exige : voir `quantizeAxis` dans `shared/protocol.ts`, dont la doc
   * explique pourquoi tirer avec un flottant non quantifie desynchroniserait
   * durablement serveur et client.
   */
  fireSalvoDirected(
    weapon: Weapon,
    tick: number,
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    damage = weapon.damage,
    count = weapon.projectileCount,
    by = 0,
    crit: Crit = BASE_CRIT,
  ): void {
    if (dirX === 0 && dirY === 0) {
      return;
    }
    this.#emit(weapon, tick, x, y, Math.atan2(dirY, dirX), damage, count, by, crit);
  }

  /**
   * Coeur commun a `fireSalvo` et `fireSalvoDirected` : pose `weapon.projectileCount`
   * projectiles, repartis symetriquement autour de `baseAngle`. Factorise pour
   * qu'un decalage d'octet ou de formule ne puisse pas diverger entre les deux
   * points d'entree — seul le calcul de l'angle differe entre eux.
   */
  #emit(
    weapon: Weapon,
    tick: number,
    x: number,
    y: number,
    angleVise: number,
    damage = weapon.damage,
    count = weapon.projectileCount,
    by = 0,
    crit: Crit = BASE_CRIT,
  ): void {
    let baseAngle = angleVise;
    const n = count;
    const room = this.capacity - this.#count;
    const toFire = Math.min(n, room);
    // Rend visible une troncature silencieuse. Une salve qui ne part pas est
    // une carte que le joueur a payee et qui ne fait rien : ca ne doit jamais
    // disparaitre sans trace. Meme motif que `RoomMetrics.truncatedSpawns`
    // pour les vagues.
    this.truncatedProjectiles += n - toFire;

    // ⚠️ **Une salve dont l'ouverture fait un TOUR COMPLET est un tir
    // circulaire** (etape 8) — et c'est tout ce qu'il a fallu pour en avoir
    // un : pas un type d'arme de plus, une valeur de plus dans un champ qui
    // existait deja. Ce qui change est la REPARTITION : sur un arc ouvert, les
    // deux extremes tombent sur les bords (`i / (n - 1)`) ; sur un cercle, ces
    // deux bords sont le MEME angle, et le dernier projectile se poserait sur
    // le premier. L'anneau se ferme donc en `i / n`.
    //
    // La SPIRALE (etape 12) est un anneau dont l'angle de base tourne avec le
    // tick de tir, sans regarder la visee : ses bras se repartissent sur tout
    // le tour quel que soit `spreadRadians`. La visee nulle, elle, ne tire
    // toujours pas — la regle est dans `fireSalvoDirected`, en amont.
    const spirale = weapon.emission === 'spirale';
    if (spirale) {
      baseAngle = (tick * SPIRAL_RAD_PER_TICK) % TAU;
    }
    const anneau = spirale || weapon.spreadRadians >= TAU;
    const motion = MOTION[weapon.motion ?? 'droit'];
    for (let i = 0; i < toFire; i++) {
      // Repartition symetrique autour de `baseAngle` : a n = 1, le spread
      // n'a pas de sens et est ignore — un seul projectile part droit sur la
      // cible, quelle que soit la valeur de `spreadRadians`.
      const angle = anneau
        ? baseAngle + (Math.PI * 2 * i) / n
        : n > 1
          ? baseAngle + weapon.spreadRadians * (i / (n - 1) - 0.5)
          : baseAngle;

      const slot = this.#count + i;
      // L'orbite nait DEJA sur son cercle : nee au centre, elle sauterait de
      // `ORBIT_RADIUS` au premier pas.
      const r = motion === MOTION.orbite ? ORBIT_RADIUS : 0;
      this.x[slot] = x + Math.cos(angle) * r;
      this.y[slot] = y + Math.sin(angle) * r;
      // Avant le premier `step`, le segment parcouru est un point : prev =
      // position de depart. Un `collide` appele avant tout mouvement teste
      // donc simplement le point de tir, comme attendu.
      this.#prevX[slot] = this.x[slot] ?? 0;
      this.#prevY[slot] = this.y[slot] ?? 0;
      this.#ox[slot] = x;
      this.#oy[slot] = y;
      this.#angle[slot] = angle;
      this.#speed[slot] = weapon.projectileSpeed;
      this.#motion[slot] = motion;
      this.#fragments[slot] = weapon.fragments ?? 0;
      this.#growth[slot] = weapon.growth ?? 0;
      this.#age[slot] = 0;
      this.#ringId.fill(-1, slot * REHIT_RING, (slot + 1) * REHIT_RING);
      this.#ringNext[slot] = 0;
      this.#vx[slot] = Math.cos(angle) * weapon.projectileSpeed;
      this.#vy[slot] = Math.sin(angle) * weapon.projectileSpeed;
      this.#damage[slot] = damage;
      this.#element[slot] = weapon.element;
      this.#by[slot] = by;
      this.#blastRadius[slot] = weapon.blastRadius;
      this.#weapon[slot] = weapon.id;
      this.#pierce[slot] = weapon.pierce;
      // Le critique, tire d'une fonction du TIR et non d'une suite — voir
      // `CRIT_CHANCE` et `hashRoll`. Le rang `i` est ce qui empeche une salve
      // entiere de criter d'un bloc. La chance et le multiplicateur sont ceux
      // du TIREUR (etape 10).
      this.#crit[slot] = hashRoll(tick, by, i) < crit.chance ? crit.multiplier : 1;
      this.#scale[slot] = weapon.projectileScale;
      this.#venom[slot] = weapon.venom;
      this.#bounces[slot] = weapon.bounces;
      this.#homing[slot] = weapon.homing;
      this.#lastHit[slot] = -1;
      this.#ticksRemaining[slot] = weapon.projectileLifeTicks;
      this.bornTick[slot] = tick;
    }

    this.#count += toFire;
  }

  /**
   * Degats portes par le projectile de ce slot.
   *
   * Depuis l'etape 5a, ce nombre **module l'issue** : `resolveProjectileDamage`
   * le soustrait de `Horde.hp`, et une pietaille lourde (`HEAVY_HP`) survit ou
   * non selon les passifs de degats du tireur. Il reste lisible ici parce que
   * c'est le seul point ou le client peut verifier ce qu'il tire — mais ce
   * n'est plus le seul endroit ou son effet s'observe.
   */
  damageAt(slot: number): number {
    return this.#damage[slot] ?? 0;
  }

  /**
   * Element porte par le projectile de ce slot — voir `#element`.
   *
   * Lu par `resolveProjectileDamage` (back) a l'IMPACT, et seulement la : un
   * projectile MARQUE ce qu'il touche, il ne laisse plus rien au sol (tache 21
   * — c'est la reaction qui pose le champ). Le client, lui, le lit pour teindre
   * la marque qu'il approxime ; les zones, elles, sont ANNONCEES (§5.3).
   */
  elementAt(slot: number): number {
    return this.#element[slot] ?? 0;
  }

  /** Index du joueur qui a tire le projectile de ce slot — voir `#by`. */
  ownerAt(slot: number): number {
    return this.#by[slot] ?? 0;
  }

  /**
   * Rayon de l'explosion a l'impact du projectile de ce slot — voir
   * `#blastRadius`. Lu par `resolveProjectileDamage` (back) a l'IMPACT, et
   * seulement la.
   */
  blastRadiusAt(slot: number): number {
    return this.#blastRadius[slot] ?? 0;
  }

  /** Echelle du projectile — voir `#scale`. */
  scaleAt(slot: number): number {
    return this.#scale[slot] ?? 1;
  }

  /** Fraction de l'impact rendue en poison — voir `#venom`. */
  venomAt(slot: number): number {
    return this.#venom[slot] ?? 0;
  }

  /**
   * Arme qui a tire le projectile de ce slot — voir `#weapon`. Lu par le seul
   * rendu (`ProjectileRenderer`), qui y trouve la forme, la taille, la teinte,
   * le halo et la trainee a dessiner.
   */
  weaponAt(slot: number): number {
    return this.#weapon[slot] ?? 0;
  }

  /**
   * Pas restants avant expiration — voir `#ticksRemaining`.
   *
   * ⚠️ **Le rendu lit CE compte a rebours, jamais `tick - bornTick`.** Les
   * deux diraient la meme chose tant que le tick du dessin suit exactement
   * celui de la simulation ; le compte a rebours, lui, le dit sans hypothese
   * — et il n'oblige pas la boucle de rendu a se faire passer un tick de plus.
   * C'est ce que `projectileAlpha` attend.
   */
  /**
   * Ce projectile porte-t-il un coup critique ? Lu par l'arbitrage (serveur) et
   * par l'affichage des degats (client), qui obtiennent la meme reponse.
   */
  critAt(slot: number): boolean {
    return (this.#crit[slot] ?? 1) > 1;
  }

  /**
   * Ce qu'un impact de ce projectile multiplie : le multiplicateur de son
   * tireur s'il a crite, `1` sinon. Lu par l'arbitrage (serveur) et par
   * l'affichage des degats (client).
   */
  critFactorAt(slot: number): number {
    return this.#crit[slot] ?? 1;
  }

  ticksRemainingAt(slot: number): number {
    return this.#ticksRemaining[slot] ?? 0;
  }

  /**
   * Direction de vol du projectile de ce slot, en radians.
   *
   * Calculee a la demande depuis la vitesse plutot que stockee. ⚠️ Ce n'est
   * pas `#angle` : l'orbite, le boomerang et le sinus remettent `vx/vy` a la
   * vitesse REELLE de leur dernier pas (etape 12), c'est elle qui oriente le
   * sprite — `#angle` est le cap de la ligne, ou l'angle sur le cercle.
   */
  headingAt(slot: number): number {
    return Math.atan2(this.#vy[slot] ?? 0, this.#vx[slot] ?? 0);
  }

  /** Pas vecus depuis l'emission — voir `#age`. Le rendu du mortier y lit sa cloche. */
  ageAt(slot: number): number {
    return this.#age[slot] ?? 0;
  }

  /**
   * Mouvement du projectile, code `MOTION`. Lu sur le projectile, pas sur
   * l'arme : l'eclat d'un mortier vole droit.
   */
  motionAt(slot: number): number {
    return this.#motion[slot] ?? MOTION.droit;
  }

  /**
   * Projectiles qu'une salve n'a pas pu poser faute de place, cumules depuis la
   * creation. Jamais remis a zero par `Projectiles` : c'est `Room` qui draine
   * ses metriques.
   *
   * ⚠️ **Ce compteur existe parce que l'empilement a leve la borne.** Jusqu'a
   * ce que les armes s'empilent, quatre joueurs aux slots pleins tenaient une
   * centaine de projectiles simultanes contre une capacite de 256, et la marge
   * tenait toute seule. Un exemplaire supplementaire elargit desormais la salve
   * sans borne : la capacite peut etre atteinte, et sans ce compteur la salve
   * manquante ne se verrait nulle part.
   */
  truncatedProjectiles = 0;

  /**
   * Un pas de simulation. Appele exactement une fois par tick, `dt` fixe.
   *
   * ⚠️ **Un rappel `onExpire(slot)` a vecu ici, de la tache 6 a la tache 21 de
   * l'etape 5a.** Il servait la moitie « n'a rien touche » du modele ou un
   * projectile elementaire posait une zone au bout de sa course. Depuis que
   * c'est la REACTION qui laisse un champ au sol (§5.1 de la spec, tache 21),
   * plus rien ne s'interesse a la mort de vieillesse d'un projectile : le
   * parametre est parti avec son seul appelant, aucun test ne le tenait, et un
   * point d'extension que personne n'utilise est un point d'extension qui ment.
   */
  /**
   * `anchor` (etape 12, §3.2) : ou est chaque tireur a ce pas, lu par l'orbite
   * et le retour du boomerang seuls. Sans elle, ils se rabattent sur leur
   * point d'emission.
   */
  step(dt: number, onExpire?: (slot: number) => void, horde?: Horde, anchor?: Anchor): void {
    for (let i = 0; i < this.#count; i++) {
      const motion = this.#motion[i] ?? MOTION.droit;
      // Le guidage tourne la vitesse AVANT le pas — sans horde (tests, bancs
      // anciens), le missile file droit. L'orbite et le boomerang suivent
      // leur tireur, pas la horde : ils l'ignorent.
      if (
        horde &&
        (this.#homing[i] ?? 0) > 0 &&
        motion !== MOTION.orbite &&
        motion !== MOTION.boomerang
      ) {
        this.#steer(i, horde, dt);
      }
      // Capture la position de DEBUT de pas avant de la faire avancer : c'est
      // le point de depart du segment que `collide` testera.
      const px = this.x[i] ?? 0;
      const py = this.y[i] ?? 0;
      this.#prevX[i] = px;
      this.#prevY[i] = py;
      const age = this.#age[i] ?? 0;
      if (motion === MOTION.droit || motion === MOTION.mortier) {
        this.x[i] = px + (this.#vx[i] ?? 0) * dt;
        this.y[i] = py + (this.#vy[i] ?? 0) * dt;
      } else {
        if (motion === MOTION.orbite) {
          this.#orbit(i, dt, age + 1, anchor);
        } else if (motion === MOTION.boomerang) {
          this.#boomerang(i, dt, age, anchor);
        } else {
          this.#sinus(i, dt, age + 1);
        }
        // La vitesse REELLE du pas : c'est elle que `headingAt` lit. Un pas
        // nul garde la precedente plutot que de diviser par zero.
        if (dt > 0) {
          this.#vx[i] = ((this.x[i] ?? 0) - px) / dt;
          this.#vy[i] = ((this.y[i] ?? 0) - py) / dt;
        }
      }
      this.#age[i] = age + 1;
      // La croissance agrandit `#scale`, donc la touche ET le dessin.
      this.#scale[i] = (this.#scale[i] ?? 1) + (this.#growth[i] ?? 0) * dt;
      this.#ticksRemaining[i] = (this.#ticksRemaining[i] ?? 0) - 1;
    }

    // Retrait par indice decroissant, meme raisonnement que `Horde.kill` :
    // un projectile deplace dans un trou par une compaction ne doit jamais
    // etre lui-meme retire par erreur ensuite.
    for (let i = this.#count - 1; i >= 0; i--) {
      if ((this.#ticksRemaining[i] ?? 0) <= 0) {
        // ⚠️ **AVANT `#removeAt`, pendant que le creneau est encore valide** :
        // l'appelant y lit la position, le souffle et les degats du projectile
        // qui s'eteint — exactement la fenetre que `collide` ouvre a l'impact.
        //
        // ⚠️ **Ce rappel RESSEMBLE a celui que la tache 21 a retire, et il ne
        // fait pas la meme chose.** L'ancien servait le modele ou un projectile
        // POSAIT une zone en fin de course ; celui-ci ne pose rien, il rend
        // seulement la main — et c'est l'appelant qui decide, aujourd'hui pour
        // faire sauter une arme de souffle qui n'a percute personne.
        onExpire?.(i);
        this.#consume(i, -1);
      }
    }
  }

  /** Tourne autour de l'ancre (ou du point d'emission), sur un rayon qui respire. */
  #orbit(i: number, dt: number, age: number, anchor: Anchor | undefined): void {
    const a = (this.#angle[i] ?? 0) + TAU * ORBIT_TURNS_PER_S * dt;
    this.#angle[i] = a;
    const c = anchor?.(this.#by[i] ?? 0);
    const r = ORBIT_RADIUS * (1 + ORBIT_BREATH * Math.sin((TAU * age) / ORBIT_BREATH_TICKS));
    this.x[i] = (c ? c.x : (this.#ox[i] ?? 0)) + Math.cos(a) * r;
    this.y[i] = (c ? c.y : (this.#oy[i] ?? 0)) + Math.sin(a) * r;
  }

  /**
   * L'aller ralentit lineairement jusqu'a l'arret a mi-vie ; le retour fonce
   * a pleine vitesse vers l'ancre (ou le point d'emission) et s'eteint a
   * `BOOMERANG_CATCH_PX` — comme une fin de course, `onExpire` compris.
   * `age` est celui d'AVANT ce pas : le premier pas part a pleine vitesse.
   */
  #boomerang(i: number, dt: number, age: number, anchor: Anchor | undefined): void {
    const speed = this.#speed[i] ?? 0;
    // La vie totale ne change pas pour un boomerang (jamais de ricochet).
    const life = age + (this.#ticksRemaining[i] ?? 0);
    if (age * 2 < life) {
      const v = speed * (1 - (age * 2) / life) * dt;
      const a = this.#angle[i] ?? 0;
      this.x[i] = (this.x[i] ?? 0) + Math.cos(a) * v;
      this.y[i] = (this.y[i] ?? 0) + Math.sin(a) * v;
      return;
    }
    const c = anchor?.(this.#by[i] ?? 0);
    const tx = c ? c.x : (this.#ox[i] ?? 0);
    const ty = c ? c.y : (this.#oy[i] ?? 0);
    const dx = tx - (this.x[i] ?? 0);
    const dy = ty - (this.y[i] ?? 0);
    const d = Math.hypot(dx, dy);
    const k = d > 0 ? Math.min(1, (speed * dt) / d) : 0;
    this.x[i] = (this.x[i] ?? 0) + dx * k;
    this.y[i] = (this.y[i] ?? 0) + dy * k;
    if (d * (1 - k) < BOOMERANG_CATCH_PX) {
      this.#ticksRemaining[i] = 0;
    }
  }

  /** Le point de ligne avance tout droit ; le projectile ondule autour, perpendiculairement. */
  #sinus(i: number, dt: number, age: number): void {
    const a = this.#angle[i] ?? 0;
    const step = (this.#speed[i] ?? 0) * dt;
    const ox = (this.#ox[i] ?? 0) + Math.cos(a) * step;
    const oy = (this.#oy[i] ?? 0) + Math.sin(a) * step;
    this.#ox[i] = ox;
    this.#oy[i] = oy;
    const off = sinusOffset(age);
    this.x[i] = ox - Math.sin(a) * off;
    this.y[i] = oy + Math.cos(a) * off;
  }

  /**
   * Resout les collisions avec `horde` : pour chaque projectile touchant une
   * entite, appelle `onHit(entityId, damage)` et consomme le projectile.
   *
   * **Teste le SEGMENT parcouru pendant le dernier `step`, pas seulement le
   * point d'arrivee.** Un projectile rapide peut parcourir plusieurs
   * dizaines de pixels en un seul tick ; une entite qui coupe sa trajectoire
   * AU MILIEU du pas peut se trouver hors du rayon des deux extremites tout
   * en etant a l'interieur du rayon du segment lui-meme — c'est exactement
   * le cas que le test de reproduction de ce fichier verifie : une entite a
   * 30 px du segment mais a ~33,5 px de chacune de ses deux extremites,
   * touchee uniquement parce que la distance mesuree est celle au segment.
   * Se limiter au point d'arrivee la manquerait, et le defaut s'aggraverait
   * avec la vitesse — precisement la ou on voudrait le plus de fiabilite.
   *
   * A egalite, le plus petit identifiant gagne — meme departage que
   * `nearestTarget`, pour la meme raison : le resultat ne doit pas dependre
   * de l'ordre des entites dans le tableau.
   *
   * ⚠️ **Un projectile TRANSPERCANT n'est pas consomme** (etape 8) : tant
   * qu'il lui reste des traversees (`Weapon.pierce`, recopie a l'emission), il
   * poursuit sa course apres avoir appele `onHit`, et il inflige ses degats
   * PLEINS a chaque corps. Il ne peut jamais toucher deux fois de suite le
   * meme — voir `#lastHit`, sans quoi « transpercer » voudrait dire « frapper
   * le premier ennemi quatre fois ».
   *
   * ⚠️ **Etape 12** : le mortier est ignore (il ne touche qu'en tombant, via
   * `onExpire`) ; l'orbite et le boomerang ne sont JAMAIS consommes et ne
   * retouchent un corps qu'apres `REHIT_TICKS` (`#ringId`) ; un projectile
   * consomme eclate s'il porte des eclats (`#consume`).
   *
   * ⚠️ **Le rayon teste suit le CORPS de la cible depuis l'etape 8** : un boss
   * (`Archetype.hitScale` = 2,2 depuis l etape 12) encaisse sur 70 px, la pietaille sur
   * 32. Voir `HIT_R2_BY_ARCHETYPE` — jusque-la, il fallait viser le centre
   * exact d'un corps dessine a 240 px de diametre.
   *
   * ⚠️ **`zones`/`tick` sont optionnels, et c'est ce qui branche le rayon de
   * touche elargi du Vif-argent (§4 de la spec de l'etape 5c) COTE SERVEUR
   * SEUL.** `back/src/combat.ts` les passe ; le client (`front/src/net/client.ts`,
   * ses projectiles cosmetiques) appelle `collide` sans eux, et retombe donc
   * exactement sur le rayon de base — aucun changement de comportement pour
   * lui. Ceci ne touche AUCUNE trajectoire : `zones` n'entre jamais dans
   * `#emit`/`fireSalvoDirected`, qui restent aveugles a la horde et aux
   * zones — voir le docbloc du module.
   */
  collide(
    horde: Horde,
    onHit: (entityId: number, damage: number, slot: number) => void,
    zones?: ZoneField,
    tick?: number,
  ): void {
    const defaultR2 = PROJECTILE_HIT_RADIUS * PROJECTILE_HIT_RADIUS;

    for (let i = this.#count - 1; i >= 0; i--) {
      const motion = this.#motion[i] ?? MOTION.droit;
      // Le mortier vole AU-DESSUS de la horde : il ne touche que la ou il
      // tombe, par le souffle de fin de course (`onExpire`).
      if (motion === MOTION.mortier) {
        continue;
      }
      // L'orbite et le boomerang ne sont jamais consommes (§3.3).
      const perpetuel = motion === MOTION.orbite || motion === MOTION.boomerang;
      const ax = this.#prevX[i] ?? 0;
      const ay = this.#prevY[i] ?? 0;
      const bx = this.x[i] ?? 0;
      const by = this.y[i] ?? 0;

      let bestId = -1;
      let bestSlot = -1;
      let bestDist2 = Number.POSITIVE_INFINITY;
      // Ce que le calibre ajoute au rayon de touche, en pixels. Zero pour
      // presque tous : la boucle garde alors ses tables telles quelles.
      const extra = PROJECTILE_HIT_RADIUS * ((this.#scale[i] ?? 1) - 1);
      for (let e = 0; e < horde.count; e++) {
        const ex = horde.x[e] ?? 0;
        const ey = horde.y[e] ?? 0;
        const d2 = distanceToSegmentSquared(ex, ey, ax, ay, bx, by);
        // Le rayon de CE corps : `PROJECTILE_HIT_RADIUS` pour les vingt
        // archetypes de pietaille, 2,2 fois plus pour le boss (`hitScale`). Voir
        // `HIT_R2_BY_ARCHETYPE`.
        const kind = horde.archetype[e] ?? 0;
        let baseR2 = HIT_R2_BY_ARCHETYPE[kind] ?? defaultR2;
        let wideR2 = WIDE_R2_BY_ARCHETYPE[kind] ?? defaultR2;
        if (extra > 0) {
          const r = (HIT_R_BY_ARCHETYPE[kind] ?? PROJECTILE_HIT_RADIUS) + extra;
          baseR2 = r * r;
          wideR2 = (r + VIF_ARGENT_HIT_RADIUS_BONUS) ** 2;
        }
        if (d2 > baseR2) {
          // ⚠️ **Le rayon de base ne touche pas — le rayon ELARGI est-il
          // pose, et seulement s'il y a un `zones` a consulter ?** Cout
          // supplementaire nul pour le client (`zones` est `undefined`, donc
          // `continue` immediat) et pour le cas courant serveur (aucune zone
          // de Vif-argent sur ce point).
          if (!zones) {
            continue;
          }
          // ⚠️ **Pre-filtre AVANT le balayage, et c'est une borne SUPERIEURE
          // EXACTE, pas une approximation.** `hitRadiusBonusAt` est en
          // O(zones) : l'appeler ici le mettait dans la boucle
          // projectile x ennemi, donc un cout en projectiles x ennemis x
          // zones — **49 millions de tests de distance par tick** mesures a
          // 4 000 ennemis, 96 projectiles et 128 zones (banc des six
          // elements, etape 5c). Aucun bonus ne depasse
          // `VIF_ARGENT_HIT_RADIUS_BONUS`, donc un ennemi au-dela de
          // `PROJECTILE_HIT_RADIUS + VIF_ARGENT_HIT_RADIUS_BONUS` ne peut
          // etre touche par AUCUNE zone : le balayage ne sert plus qu'a
          // l'anneau, une poignee d'entites.
          //
          // ⚠️ **AUCUN test ne peut separer ce pre-filtre de son absence** —
          // c'est une optimisation a comportement identique. Ce qui le garde
          // est le BANC, pas la suite ; meme honnetete que la borne `<= 0` de
          // `resolveBurn`, qui assume qu'aucun test ne la distingue de `< 0`.
          if (d2 > wideR2) {
            continue;
          }
          const bonus = zones.hitRadiusBonusAt(ex, ey, tick ?? 0);
          if (bonus <= 0) {
            continue;
          }
          // Le bonus de zone s'AJOUTE au rayon du corps, il ne le remplace
          // pas : un boss dans une flaque de Vif-argent reste un boss.
          const wideR = Math.sqrt(baseR2) + bonus;
          if (d2 > wideR * wideR) {
            continue;
          }
        }
        const id = horde.entityIdAt(e);
        // Jamais deux fois de suite le meme corps — voir `#lastHit` ; jamais
        // avant `REHIT_TICKS` pour un projectile perpetuel — voir `#ringId`.
        if (perpetuel ? this.#recentlyHit(i, id) : id === this.#lastHit[i]) {
          continue;
        }
        if (d2 < bestDist2 || (d2 === bestDist2 && id < bestId)) {
          bestDist2 = d2;
          bestId = id;
          bestSlot = e;
        }
      }

      if (bestId >= 0) {
        // `i` est passe pour que l'appelant puisse lire ce que le projectile
        // porte d'autre que ses degats — son element, son tireur, sa position
        // d'impact (etape 5a, tache 6). Valide seulement pendant le rappel :
        // `#removeAt` juste apres deplace le dernier projectile dans ce
        // creneau.
        onHit(bestId, this.#damage[i] ?? 0, i);
        // ⚠️ **Le degat est PLEIN a chaque traversee** (voir `Weapon.pierce`) :
        // `onHit` vient d'etre appele avant ce test, et il l'est de la meme
        // facon au premier ennemi qu'au dernier. Ce qui se consomme, c'est le
        // droit de continuer.
        const restantes = this.#pierce[i] ?? 0;
        if (perpetuel) {
          const n = this.#ringNext[i] ?? 0;
          this.#ringId[i * REHIT_RING + n] = bestId;
          this.#ringAge[i * REHIT_RING + n] = this.#age[i] ?? 0;
          this.#ringNext[i] = (n + 1) % REHIT_RING;
        } else if (restantes > 0) {
          this.#pierce[i] = restantes - 1;
          this.#lastHit[i] = bestId;
        } else if ((this.#bounces[i] ?? 0) > 0 && this.#ricochet(i, horde, bestId, bestSlot)) {
          // Le ricochet : le meme projectile repart vers un voisin, degats
          // pleins comme la perforation. Il ne peut pas reprendre tout de suite
          // celui qu'il quitte — `#lastHit`.
          this.#bounces[i] = (this.#bounces[i] ?? 1) - 1;
          this.#lastHit[i] = bestId;
          this.#ticksRemaining[i] = Math.max(this.#ticksRemaining[i] ?? 0, RICOCHET_MIN_LIFE_TICKS);
        } else {
          this.#consume(i, bestId);
        }
      }
    }
  }

  /** `id` est-il dans l'anneau de `i`, touche il y a moins de `REHIT_TICKS` pas ? */
  #recentlyHit(i: number, id: number): boolean {
    const age = this.#age[i] ?? 0;
    for (let k = i * REHIT_RING; k < (i + 1) * REHIT_RING; k++) {
      if (this.#ringId[k] === id && age - (this.#ringAge[k] ?? 0) < REHIT_TICKS) {
        return true;
      }
    }
    return false;
  }

  /**
   * Retire le projectile `i`, consomme — a l'impact (`hitId`) ou en fin de
   * course (`-1`) —, apres l'avoir fait eclater s'il porte des eclats.
   *
   * ⚠️ **Le premier eclat PREND le creneau `i`, les autres s'ajoutent en fin
   * de tableau** : aucun `#removeAt`, et les deux appelants parcourent par
   * indice decroissant, donc aucun eclat n'est revu au pas ou il nait — ni
   * deplace, ni teste. Chacun est une copie du parent (tireur, element,
   * critique, venin, arme, bornTick) dont on ne change que ce qui fait un
   * eclat. Ils ne retouchent pas `hitId`, que le parent vient de frapper.
   */
  #consume(i: number, hitId: number): void {
    const n = this.#fragments[i] ?? 0;
    if (n === 0) {
      this.#removeAt(i);
      return;
    }
    const extra = Math.min(n - 1, this.capacity - this.#count);
    this.truncatedProjectiles += n - 1 - extra;
    const heading = this.headingAt(i);
    // Decroissant : le parent, en `i`, est copie AVANT de devenir l'eclat 0.
    for (let k = extra; k >= 0; k--) {
      const slot = k === 0 ? i : this.#count + k - 1;
      if (k > 0) {
        this.#copy(i, slot);
      }
      const a = heading + (TAU * k) / n;
      const speed = this.#speed[slot] ?? 0;
      this.#vx[slot] = Math.cos(a) * speed;
      this.#vy[slot] = Math.sin(a) * speed;
      this.#angle[slot] = a;
      this.#prevX[slot] = this.x[slot] ?? 0;
      this.#prevY[slot] = this.y[slot] ?? 0;
      this.#damage[slot] = (this.#damage[slot] ?? 0) * FRAGMENT_DAMAGE_RATIO;
      this.#scale[slot] = (this.#scale[slot] ?? 1) * FRAGMENT_SCALE_RATIO;
      this.#blastRadius[slot] = 0;
      this.#fragments[slot] = 0;
      this.#motion[slot] = MOTION.droit;
      this.#growth[slot] = 0;
      this.#pierce[slot] = 0;
      this.#bounces[slot] = 0;
      this.#homing[slot] = 0;
      this.#lastHit[slot] = hitId;
      this.#age[slot] = 0;
      this.#ticksRemaining[slot] = FRAGMENT_LIFE_TICKS;
    }
    this.#count += extra;
  }

  /**
   * Oriente le projectile `i` vers l'ennemi le plus proche de lui (sauf
   * `exclude`) a moins de `range`, a vitesse constante. Rend `false` si
   * personne n'est a portee. `maxTurn` borne la rotation (radians) :
   * `Infinity` pour un ricochet, qui repart droit sur sa cible.
   */
  #aim(i: number, horde: Horde, range: number, maxTurn: number, exclude: number): boolean {
    const x = this.x[i] ?? 0;
    const y = this.y[i] ?? 0;
    let best = -1;
    let bestD2 = range * range;
    for (let e = 0; e < horde.count; e++) {
      const dx = (horde.x[e] ?? 0) - x;
      const dy = (horde.y[e] ?? 0) - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2 && horde.entityIdAt(e) !== exclude) {
        bestD2 = d2;
        best = e;
      }
    }
    if (best < 0) {
      return false;
    }
    // Le cap de la LIGNE et la vitesse de base, pas `vx/vy` : chez le sinus,
    // ceux-la sont la vitesse ondulante du dernier pas.
    const speed = this.#speed[i] ?? 0;
    const current = this.#angle[i] ?? 0;
    const wanted = Math.atan2((horde.y[best] ?? 0) - y, (horde.x[best] ?? 0) - x);
    // L'ecart le plus court, ramene dans [-pi, pi].
    let turn = wanted - current;
    turn -= Math.round(turn / (2 * Math.PI)) * 2 * Math.PI;
    const angle = current + Math.max(-maxTurn, Math.min(maxTurn, turn));
    this.#vx[i] = Math.cos(angle) * speed;
    this.#vy[i] = Math.sin(angle) * speed;
    this.#angle[i] = angle;
    return true;
  }

  /**
   * ⚠️ **Le guidage lit la horde : c'est la seule trajectoire qui le fasse.**
   * O(horde) par projectile guide et par tick — le meme ordre que `collide`,
   * reserve aux armes qui le portent. Le client le joue sur SA horde, la meme
   * a la replication pres : le missile dessine suit celui qui frappe.
   */
  #steer(i: number, horde: Horde, dt: number): void {
    this.#aim(i, horde, HOMING_RANGE, (this.#homing[i] ?? 0) * dt, -1);
  }

  /**
   * Le ricochet repart du POINT D'IMPACT — l'ennemi touche —, pas de la fin du
   * segment : un projectile rapide l'a deja depasse, et viserait le voisin
   * depuis l'autre cote.
   */
  #ricochet(i: number, horde: Horde, hitId: number, hitSlot: number): boolean {
    this.x[i] = horde.x[hitSlot] ?? this.x[i] ?? 0;
    this.y[i] = horde.y[hitSlot] ?? this.y[i] ?? 0;
    const ok = this.#aim(i, horde, RICOCHET_RANGE, Number.POSITIVE_INFINITY, hitId);
    if (ok && this.#motion[i] === MOTION.sinus) {
      // La ligne du sinus repart de l'impact, decalee de l'ecart du moment :
      // le projectile continue son onde depuis la, sans saut lateral.
      const a = this.#angle[i] ?? 0;
      const off = sinusOffset(this.#age[i] ?? 0);
      this.#ox[i] = (this.x[i] ?? 0) + Math.sin(a) * off;
      this.#oy[i] = (this.y[i] ?? 0) - Math.cos(a) * off;
    }
    return ok;
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.#copy(last, slot);
    }
    this.#count = last;
  }

  /** Recopie TOUT le projectile `from` dans `to` — chaque tableau par projectile, anneau compris. */
  #copy(from: number, to: number): void {
    this.x[to] = this.x[from] ?? 0;
    this.y[to] = this.y[from] ?? 0;
    this.bornTick[to] = this.bornTick[from] ?? 0;
    this.#vx[to] = this.#vx[from] ?? 0;
    this.#vy[to] = this.#vy[from] ?? 0;
    this.#damage[to] = this.#damage[from] ?? 0;
    this.#element[to] = this.#element[from] ?? 0;
    this.#by[to] = this.#by[from] ?? 0;
    this.#blastRadius[to] = this.#blastRadius[from] ?? 0;
    this.#weapon[to] = this.#weapon[from] ?? 0;
    this.#pierce[to] = this.#pierce[from] ?? 0;
    this.#crit[to] = this.#crit[from] ?? 1;
    this.#scale[to] = this.#scale[from] ?? 1;
    this.#venom[to] = this.#venom[from] ?? 0;
    this.#bounces[to] = this.#bounces[from] ?? 0;
    this.#homing[to] = this.#homing[from] ?? 0;
    this.#lastHit[to] = this.#lastHit[from] ?? -1;
    this.#ticksRemaining[to] = this.#ticksRemaining[from] ?? 0;
    this.#prevX[to] = this.#prevX[from] ?? 0;
    this.#prevY[to] = this.#prevY[from] ?? 0;
    this.#motion[to] = this.#motion[from] ?? 0;
    this.#fragments[to] = this.#fragments[from] ?? 0;
    this.#growth[to] = this.#growth[from] ?? 0;
    this.#speed[to] = this.#speed[from] ?? 0;
    this.#angle[to] = this.#angle[from] ?? 0;
    this.#ox[to] = this.#ox[from] ?? 0;
    this.#oy[to] = this.#oy[from] ?? 0;
    this.#age[to] = this.#age[from] ?? 0;
    this.#ringNext[to] = this.#ringNext[from] ?? 0;
    this.#ringId.copyWithin(to * REHIT_RING, from * REHIT_RING, (from + 1) * REHIT_RING);
    this.#ringAge.copyWithin(to * REHIT_RING, from * REHIT_RING, (from + 1) * REHIT_RING);
  }
}

/**
 * Distance au carre entre le point `(px, py)` et le SEGMENT `(ax, ay)` —
 * `(bx, by)`. Projection classique, parametre borne a `[0, 1]` pour rester
 * sur le segment plutot que sur la droite qui le porte.
 *
 * Au carre pour eviter une racine par paire projectile/entite : seule la
 * comparaison au carre du rayon compte dans `collide`.
 */
export function distanceToSegmentSquared(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abLenSq = abx * abx + aby * aby;
  const t = abLenSq > 0 ? clamp01(((px - ax) * abx + (py - ay) * aby) / abLenSq) : 0;
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

/** Ecart lateral du sinus a l'age `age` : `SINUS_AMPLITUDE` au plus. */
function sinusOffset(age: number): number {
  return SINUS_AMPLITUDE * Math.sin((TAU * age) / SINUS_PERIOD_TICKS);
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
