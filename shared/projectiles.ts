import { PROJECTILE_HIT_RADIUS } from './constants';
import type { Horde } from './horde';
import type { Weapon } from './weapons';

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

  #count = 0;

  constructor(readonly capacity: number) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.bornTick = new Uint32Array(capacity);
    this.#vx = new Float32Array(capacity);
    this.#vy = new Float32Array(capacity);
    this.#damage = new Float32Array(capacity);
    this.#ticksRemaining = new Int32Array(capacity);
    this.#prevX = new Float32Array(capacity);
    this.#prevY = new Float32Array(capacity);
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
  ): void {
    if (dirX === 0 && dirY === 0) {
      return;
    }
    this.#emit(weapon, tick, x, y, Math.atan2(dirY, dirX), damage, count);
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
    baseAngle: number,
    damage = weapon.damage,
    count = weapon.projectileCount,
  ): void {
    const n = count;
    const room = this.capacity - this.#count;
    const toFire = Math.min(n, room);

    for (let i = 0; i < toFire; i++) {
      // Repartition symetrique autour de `baseAngle` : a n = 1, le spread
      // n'a pas de sens et est ignore — un seul projectile part droit sur la
      // cible, quelle que soit la valeur de `spreadRadians`.
      const angle = n > 1 ? baseAngle + weapon.spreadRadians * (i / (n - 1) - 0.5) : baseAngle;

      const slot = this.#count + i;
      this.x[slot] = x;
      this.y[slot] = y;
      // Avant le premier `step`, le segment parcouru est un point : prev =
      // position de depart. Un `collide` appele avant tout mouvement teste
      // donc simplement le point de tir, comme attendu.
      this.#prevX[slot] = x;
      this.#prevY[slot] = y;
      this.#vx[slot] = Math.cos(angle) * weapon.projectileSpeed;
      this.#vy[slot] = Math.sin(angle) * weapon.projectileSpeed;
      this.#damage[slot] = damage;
      this.#ticksRemaining[slot] = weapon.projectileLifeTicks;
      this.bornTick[slot] = tick;
    }

    this.#count += toFire;
  }

  /**
   * Degats portes par le projectile de ce slot.
   *
   * ⚠️ **Ce nombre ne module rien pour l'instant** : la pietaille n'a aucune
   * reserve de points de vie (voir la doc de `resolveCombat`), donc un
   * projectile qui touche est toujours letal. Il est transporte pour
   * l'affichage et les elites futures — et c'est le SEUL endroit ou l'effet
   * des passifs de degats est observable aujourd'hui.
   */
  damageAt(slot: number): number {
    return this.#damage[slot] ?? 0;
  }

  /** Un pas de simulation. Appele exactement une fois par tick, `dt` fixe. */
  step(dt: number): void {
    for (let i = 0; i < this.#count; i++) {
      // Capture la position de DEBUT de pas avant de la faire avancer : c'est
      // le point de depart du segment que `collide` testera.
      this.#prevX[i] = this.x[i] ?? 0;
      this.#prevY[i] = this.y[i] ?? 0;
      this.x[i] = (this.x[i] ?? 0) + (this.#vx[i] ?? 0) * dt;
      this.y[i] = (this.y[i] ?? 0) + (this.#vy[i] ?? 0) * dt;
      this.#ticksRemaining[i] = (this.#ticksRemaining[i] ?? 0) - 1;
    }

    // Retrait par indice decroissant, meme raisonnement que `Horde.kill` :
    // un projectile deplace dans un trou par une compaction ne doit jamais
    // etre lui-meme retire par erreur ensuite.
    for (let i = this.#count - 1; i >= 0; i--) {
      if ((this.#ticksRemaining[i] ?? 0) <= 0) {
        this.#removeAt(i);
      }
    }
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
   */
  collide(horde: Horde, onHit: (entityId: number, damage: number) => void): void {
    const r2 = PROJECTILE_HIT_RADIUS * PROJECTILE_HIT_RADIUS;

    for (let i = this.#count - 1; i >= 0; i--) {
      const ax = this.#prevX[i] ?? 0;
      const ay = this.#prevY[i] ?? 0;
      const bx = this.x[i] ?? 0;
      const by = this.y[i] ?? 0;

      let bestId = -1;
      let bestDist2 = Number.POSITIVE_INFINITY;
      for (let e = 0; e < horde.count; e++) {
        const d2 = distanceToSegmentSquared(horde.x[e] ?? 0, horde.y[e] ?? 0, ax, ay, bx, by);
        if (d2 > r2) {
          continue;
        }
        const id = horde.entityIdAt(e);
        if (d2 < bestDist2 || (d2 === bestDist2 && id < bestId)) {
          bestDist2 = d2;
          bestId = id;
        }
      }

      if (bestId >= 0) {
        onHit(bestId, this.#damage[i] ?? 0);
        this.#removeAt(i);
      }
    }
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
      this.bornTick[slot] = this.bornTick[last] ?? 0;
      this.#vx[slot] = this.#vx[last] ?? 0;
      this.#vy[slot] = this.#vy[last] ?? 0;
      this.#damage[slot] = this.#damage[last] ?? 0;
      this.#ticksRemaining[slot] = this.#ticksRemaining[last] ?? 0;
      this.#prevX[slot] = this.#prevX[last] ?? 0;
      this.#prevY[slot] = this.#prevY[last] ?? 0;
    }
    this.#count = last;
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
function distanceToSegmentSquared(
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

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
