import type { Horde } from './horde';

/**
 * L'auto-visee deterministe du §5.3 : le plus proche ennemi vivant, dans
 * `horde`, a portee de `maxRange` depuis `(fromX, fromY)`.
 *
 * Rend un **identifiant d'entite**, pas un indice de creneau : un indice ne
 * survit pas a une compaction (`Horde.kill` deplace la derniere entite dans
 * le trou), et la cible doit rester valable entre le moment ou l'on vise et
 * celui ou le projectile arrive.
 *
 * ⚠️ **Vise sur l'etat COURANT de `horde`, jamais retarde.** Une premiere
 * version de cette doc demandait un retard `T − K` (par analogie avec le
 * flowfield), corrigee en tache 9 : le retard du flowfield fonctionne parce
 * qu'il porte sur des POSITIONS DE JOUEURS, repliquees avec un delai connu
 * des deux cotes — serveur et client peuvent s'accorder exactement sur « ce
 * qu'etait cette position il y a K ticks ». La horde, elle, est DERIVEE et
 * jamais repliquee : son desaccord entre deux participants ne vient pas d'une
 * latence d'entree qu'un retard pourrait absorber, mais de la PROPAGATION DES
 * MORTS (§3.2) — et retarder la lecture n'y change rien, sauf a faire tenir
 * un second anneau d'etats complet, jamais budgete par le banc de la tache 0.
 * La divergence de cible qui en resulte entre deux participants est acceptee,
 * exactement comme documente sur `Projectiles.fireSalvo`. Cette fonction n'a
 * de toute facon aucune notion du temps, exactement comme
 * `SeparationGrid.apply` n'a aucune notion de vague — c'est a l'appelant de
 * lui passer l'etat qu'il souhaite interroger.
 *
 * **A egalite de distance, le plus petit identifiant gagne.** Une
 * comparaison flottante stricte laisserait le departage a l'ordre de
 * parcours du tableau — et deux clients compactent leurs tableaux
 * differemment apres des morts. Meme raisonnement que le tri canonique des
 * morts (§3.1) et l'application en bloc des forces de separation (§4).
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
