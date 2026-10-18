import type { Horde } from './horde';

/**
 * ⚠️ **Aucun appelant en production.** La visee suit le curseur : la direction
 * de tir vient de la souris, transite dans `INPUT` puis dans le `SNAPSHOT`.
 * Tant que rien n'appelle ce module, **il ne decrit pas le comportement du
 * jeu** : ne pas le lire comme la preuve que le ciblage serait automatique.
 */

/**
 * Auto-visee deterministe : le plus proche ennemi vivant, dans
 * `horde`, a portee de `maxRange` depuis `(fromX, fromY)`.
 *
 * Rend un **identifiant d'entite**, pas un indice de creneau : un indice ne
 * survit pas a une compaction (`Horde.kill` deplace la derniere entite dans
 * le trou), et la cible doit rester valable entre le moment ou l'on vise et
 * celui ou le projectile arrive.
 *
 * ⚠️ **Vise sur l'etat COURANT de `horde`, jamais retarde.** Le retard du
 * flowfield marche parce qu'il porte sur des positions de joueurs, repliquees
 * avec un delai connu des deux cotes. La horde, elle, est DERIVEE : son
 * desaccord entre participants vient de la propagation des morts, qu'un
 * retard de lecture n'absorbe pas. La divergence de cible qui en resulte est
 * acceptee, comme sur `Projectiles.fireSalvo`.
 *
 * **A egalite de distance, le plus petit identifiant gagne.** Une
 * comparaison flottante stricte laisserait le departage a l'ordre de
 * parcours du tableau, et deux clients compactent leurs tableaux
 * differemment apres des morts.
 */
export function nearestTarget(
  horde: Horde,
  fromX: number,
  fromY: number,
  maxRange: number,
): number {
  const maxRange2 = maxRange * maxRange;
  let bestId = -1;
  let bestDist2 = Number.POSITIVE_INFINITY;

  for (let i = 0; i < horde.count; i++) {
    const dx = (horde.x[i] ?? 0) - fromX;
    const dy = (horde.y[i] ?? 0) - fromY;
    const d2 = dx * dx + dy * dy;
    if (d2 > maxRange2) {
      continue;
    }
    const id = horde.entityIdAt(i);
    if (d2 < bestDist2 || (d2 === bestDist2 && id < bestId)) {
      bestDist2 = d2;
      bestId = id;
    }
  }

  return bestId;
}
