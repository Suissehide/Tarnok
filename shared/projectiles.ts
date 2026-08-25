import { PROJECTILE_HIT_RADIUS } from './constants';
import type { Horde } from './horde';
import type { Weapon } from './weapons';

/**
 * Les projectiles : simules localement, jamais repliques (§5.2 de la spec).
 *
 * Un tir est entierement determine par des donnees que serveur et clients
 * possedent deja — l'arme, le tick, la position du tireur, la cible choisie
 * par `nearestTarget` — donc les deux cotes calculent les memes salves aux
 * memes ticks sans qu'un seul octet ne transite. Le test de derivation de ce
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

  readonly #vx: Float32Array;
  readonly #vy: Float32Array;
  readonly #damage: Float32Array;
  /** Pas restants avant expiration. Decremente a chaque `step`. */
  readonly #ticksRemaining: Int32Array;
  /** Tick de tir, pour le debogage et un futur rendu qui en tiendrait compte. */
  readonly #bornTick: Uint32Array;

  #count = 0;

  constructor(readonly capacity: number) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.#vx = new Float32Array(capacity);
    this.#vy = new Float32Array(capacity);
    this.#damage = new Float32Array(capacity);
    this.#ticksRemaining = new Int32Array(capacity);
    this.#bornTick = new Uint32Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  /**
   * Tire une salve de `weapon` depuis `(x, y)`, visant `targetId` dans
   * `horde`.
   *
   * `horde` doit etre l'etat sur lequel `targetId` a ete choisi (§5.3 : celui
   * de `T − TARGETING_DELAY_TICKS`) — c'est ce qui garantit que la direction
   * visee est, elle aussi, identique des deux cotes.
   *
   * Si `targetId` ne designe plus une entite vivante dans `horde`, la salve
   * ne part pas : sans cible, aucune direction ne serait deterministe des
   * deux cotes, donc rien ne se tire plutot que de deviner.
   *
   * **Cette regle peut faire diverger serveur et client, et c'est accepte.**
   * Les deux tirent depuis l'etat retarde a `T − TARGETING_DELAY_TICKS`. Si
   * une mort n'est pas encore parvenue au client, son etat retarde peut
   * encore contenir la cible que le serveur, lui, a deja retiree du sien —
   * donc l'un saute le tir pendant que l'autre le lance, ou l'inverse.
   * L'ecart est purement visuel et se resorbe au rejeu du §3.2 : les
   * projectiles ne sont jamais repliques, et les degats restent arbitres par
   * le serveur (§5.4). Ce qui serait inacceptable, ce serait qu'un client
   * tire une conclusion sur les degats a partir de sa propre salve — ce
   * n'est jamais le cas, `fireSalvo` ne fait que deplacer un projectile.
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
    const baseAngle = Math.atan2(dy, dx);

    const n = weapon.projectileCount;
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
      this.#vx[slot] = Math.cos(angle) * weapon.projectileSpeed;
      this.#vy[slot] = Math.sin(angle) * weapon.projectileSpeed;
      this.#damage[slot] = weapon.damage;
      this.#ticksRemaining[slot] = weapon.projectileLifeTicks;
      this.#bornTick[slot] = tick;
    }

    this.#count += toFire;
  }

  /** Un pas de simulation. Appele exactement une fois par tick, `dt` fixe. */
  step(dt: number): void {
    for (let i = 0; i < this.#count; i++) {
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
   * A egalite, le plus petit identifiant gagne — meme departage que
   * `nearestTarget`, pour la meme raison : le resultat ne doit pas dependre
   * de l'ordre des entites dans le tableau.
   */
  collide(horde: Horde, onHit: (entityId: number, damage: number) => void): void {
    const r2 = PROJECTILE_HIT_RADIUS * PROJECTILE_HIT_RADIUS;

    for (let i = this.#count - 1; i >= 0; i--) {
      const px = this.x[i] ?? 0;
      const py = this.y[i] ?? 0;

      let bestId = -1;
      let bestDist2 = Number.POSITIVE_INFINITY;
      for (let e = 0; e < horde.count; e++) {
        const dx = (horde.x[e] ?? 0) - px;
        const dy = (horde.y[e] ?? 0) - py;
        const d2 = dx * dx + dy * dy;
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
      this.#vx[slot] = this.#vx[last] ?? 0;
      this.#vy[slot] = this.#vy[last] ?? 0;
      this.#damage[slot] = this.#damage[last] ?? 0;
      this.#ticksRemaining[slot] = this.#ticksRemaining[last] ?? 0;
      this.#bornTick[slot] = this.#bornTick[last] ?? 0;
    }
    this.#count = last;
  }
}
