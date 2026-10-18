import { TICK_HZ } from './constants';
import type { Horde } from './horde';

/**
 * Les deux familles d'armes qui ne posent aucun projectile :
 * l'ONDE (un anneau qui s'agrandit depuis le point de tir) et la FRAPPE (des
 * impacts differes autour d'un point vise).
 *
 * ⚠️ **La logique PURE seulement, partagee par les deux cotes** : le serveur
 * en tire des degats (`Room`), le client le dessin qui les accompagne. Meme
 * discipline que `Guard` (`shared/weapons.ts`) : tout se derive de l'arme, du
 * tick et du tireur, aucun octet ne part sur le fil.
 *
 * ⚠️ **Pas `waves.ts`** : ce fichier-la parle des vagues d'ENNEMIS.
 */

/** Une onde vivante : un anneau centre sur le point de tir, fige. */
export interface Onde {
  readonly x: number;
  readonly y: number;
  readonly bornTick: number;
  /** Vitesse d'expansion du rayon, px/s — `projectileSpeed` de l'arme. */
  readonly speed: number;
  /** Rayon ou l'onde s'eteint — `blastRadius` de l'arme, ZONE comprise. */
  readonly maxRadius: number;
  readonly damage: number;
  readonly element: number;
  /** Le tireur : c'est lui que la marque retient. */
  readonly by: number;
}

/**
 * Rayon de l'onde au tick `tick` : nul a sa naissance (et avant), plafonne a
 * `maxRadius`. Une vitesse nulle rend l'anneau instantane plutot qu'eternel.
 */
export function ondeRadiusAt(onde: Onde, tick: number): number {
  if (onde.speed <= 0) {
    return onde.maxRadius;
  }
  const age = Math.max(0, tick - onde.bornTick);
  return Math.min(onde.maxRadius, (onde.speed * age) / TICK_HZ);
}

/**
 * La bande que l'onde balaie a ce tick, `(inner, outer]`, ou `null` si elle
 * n'est pas nee ou deja eteinte.
 *
 * ⚠️ **Chaque ennemi n'est frappe qu'une fois par onde, sans ensemble a
 * tenir** : les bandes de deux ticks successifs se touchent sans se
 * recouvrir. Au tick de naissance, la bande est `[0, 0]` (`inner` vaut -1)
 * pour qu'un ennemi pile sur le tireur ne passe pas au travers.
 *
 * Vie de l'onde : jusqu'au tick ou `outer` atteint `maxRadius`, compris.
 */
export function ondeBand(
  onde: Onde,
  tick: number,
): { readonly inner: number; readonly outer: number } | null {
  const age = tick - onde.bornTick;
  if (age < 0) {
    return null;
  }
  const inner = age === 0 ? -1 : ondeRadiusAt(onde, tick - 1);
  if (inner >= onde.maxRadius) {
    return null;
  }
  return { inner, outer: ondeRadiusAt(onde, tick) };
}

/** L'onde vit-elle encore a ce tick (a-t-elle une bande a balayer) ? */
export function ondeIsAlive(onde: Onde, tick: number): boolean {
  return ondeBand(onde, tick) !== null;
}

/** Ce tick de l'onde frappe-t-il un ennemi a la distance `dist` de son centre ? */
export function ondeStrikes(onde: Onde, tick: number, dist: number): boolean {
  const band = ondeBand(onde, tick);
  return band !== null && dist > band.inner && dist <= band.outer;
}

/** Jusqu'ou une frappe cherche ses cibles autour du point vise, en pixels monde. */
export const FRAPPE_SEARCH_RADIUS = 160;
/** Ticks entre le tir et l'impact — 0,3 s a `TICK_HZ`, le temps de l'avertissement. */
export const FRAPPE_DELAY_TICKS = 9;

/**
 * Un impact de frappe en attente.
 *
 * ⚠️ **C'est un `HaloPulse` (`back/src/combat.ts`) differe, au champ pres** :
 * memes six champs, plus son echeance. Le serveur le verse tel quel dans ses
 * pulsations de halo le tick venu, la machinerie existe.
 */
export interface FrappeImpact {
  readonly x: number;
  readonly y: number;
  /** Rayon de l'impact — `blastRadius` de l'arme, ZONE comprise. */
  readonly radius: number;
  readonly damage: number;
  readonly element: number;
  readonly by: number;
  /** Le tick ou il frappe — `frappeDueTick(tick du tir)`. */
  readonly dueTick: number;
}

/** L'echeance d'un impact tire au tick `firedTick`. */
export function frappeDueTick(firedTick: number): number {
  return firedTick + FRAPPE_DELAY_TICKS;
}

/**
 * Cet impact frappe-t-il a ce tick ? `>=` et pas `===` : un tick saute (gel,
 * rattrapage) ne doit pas le laisser en attente pour toujours.
 */
export function frappeIsDue(impact: FrappeImpact, tick: number): boolean {
  return tick >= impact.dueTick;
}

/**
 * Les points d'impact d'une frappe visant `(px, py)` : les `n` ennemis les
 * plus proches du point dans `FRAPPE_SEARCH_RADIUS`, positions figees au
 * tir ; s'il y en a moins de `n` (aucun compris), UN impact de plus tombe
 * sur le point lui-meme — jamais deux.
 *
 * ⚠️ **A distance egale, le plus petit `entityId` gagne**, jamais l'ordre du
 * tableau : meme convention que `chainTargets` (`shared/chain.ts`). Le client
 * l'appelle sur SA horde, approximation cosmetique comme la chaine de Foudre.
 */
export function frappeTargets(
  horde: Horde,
  px: number,
  py: number,
  n: number,
): { x: number; y: number }[] {
  const r2 = FRAPPE_SEARCH_RADIUS * FRAPPE_SEARCH_RADIUS;
  const found: { x: number; y: number; d2: number; id: number }[] = [];
  for (let i = 0; i < horde.count; i++) {
    const x = horde.x[i] ?? 0;
    const y = horde.y[i] ?? 0;
    const d2 = (x - px) * (x - px) + (y - py) * (y - py);
    if (d2 <= r2) {
      found.push({ x, y, d2, id: horde.entityIdAt(i) });
    }
  }
  // ponytail: tri de tout ce qui est dans 160 px, quelques dizaines au pire ;
  // une selection partielle si le banc la voit.
  found.sort((a, b) => a.d2 - b.d2 || a.id - b.id);
  const points = found.slice(0, Math.max(0, n)).map(({ x, y }) => ({ x, y }));
  if (points.length < n) {
    points.push({ x: px, y: py });
  }
  return points;
}
