import type { Horde } from './horde';

/**
 * Les cibles d'une chaine de Foudre, depuis un point d'impact.
 *
 * ⚠️ **Totalement deterministe, et c'est la raison d'etre du fichier.** Les
 * positions de la horde sont bit-identiques des deux cotes : la meme entree
 * rend donc la meme sortie, et il n'y a RIEN a annoncer. Mais a une
 * condition — a distance egale, c'est
 * `entityId` qui departage, jamais l'ordre du tableau : `Horde#removeAt`
 * compacte en echangeant avec le dernier element, et l'ordre qui en resulte
 * n'est garanti identique ni entre deux clients, ni entre un client et le
 * serveur. Meme convention que `nearestTarget` (`shared/targeting.ts`) et
 * `Horde#isBehind` (`shared/horde.ts`) : le plus petit identifiant gagne.
 *
 * ⚠️ **Aucun RNG, meme seme.** Deux cotes qui doivent consommer le meme
 * nombre de tirages au meme moment est une contrainte qui se brise en
 * silence.
 *
 * ⚠️ **Une CHAINE, pas une etoile.** **A chaque saut, la cible la plus proche
 * NON DEJA TOUCHEE, dans `radius`, mesuree depuis la position de la cible du
 * saut PRECEDENT** ; le premier saut seul est mesure depuis `(cx, cy)`. Le
 * client en dessine une polyligne, et Court-circuit « propage sans limite de
 * sauts », ce qui n'aurait pas de sens si chaque saut repartait du meme point.
 * Le departage par `entityId` s'applique a CHAQUE saut.
 *
 * `O(jumps x horde.count)`, volontairement pas optimise : avec `CHAIN_JUMPS`
 * a 3, c'est l'ordre de grandeur d'un tri unique.
 *
 * `exclude` porte les identites deja touchees AVANT le premier saut (l'entite
 * frappee par l'impact direct, les morts du meme impact, qui ne doivent pas
 * propager). Les cibles choisies PENDANT la chaine s'y ajoutent, sans
 * modifier le `Set` de l'appelant.
 *
 * Rend au plus `jumps` identites, dans l'ORDRE DES SAUTS. Si un saut ne
 * trouve plus personne dans `radius` autour du curseur, la chaine S'ARRETE LA
 * plutot que de sauter plus loin.
 */
export function chainTargets(
  horde: Horde,
  cx: number,
  cy: number,
  radius: number,
  jumps: number,
  exclude: ReadonlySet<number>,
): number[] {
  // Pas de garde `jumps <= 0` : la boucle n'execute alors aucun tour, et une
  // garde explicite serait une branche qu'aucune mutation ne fait rougir.
  const r2 = radius * radius;
  const touched = new Set(exclude);
  const result: number[] = [];
  let curX = cx;
  let curY = cy;

  for (let hop = 0; hop < jumps; hop++) {
    let bestSlot = -1;
    let bestId = -1;
    let bestD2 = Number.POSITIVE_INFINITY;

    for (let i = 0; i < horde.count; i++) {
      const id = horde.entityIdAt(i);
      if (touched.has(id)) {
        continue;
      }
      const dx = (horde.x[i] ?? 0) - curX;
      const dy = (horde.y[i] ?? 0) - curY;
      const d2 = dx * dx + dy * dy;
      // Meme convention que `nearestTarget` : la borne est INCLUSIVE (`>`,
      // pas `>=`), une entite pile a `radius` compte.
      if (d2 > r2) {
        continue;
      }
      // `d2` d'abord, `id` en depart a egalite EXACTE, jamais l'ordre de
      // parcours. `bestId` demarre a `-1`, mais le premier candidat est
      // toujours retenu par la branche `d2 < bestD2` seule.
      if (d2 < bestD2 || (d2 === bestD2 && id < bestId)) {
        bestD2 = d2;
        bestId = id;
        bestSlot = i;
      }
    }

    if (bestSlot === -1) {
      break;
    }

    result.push(bestId);
    touched.add(bestId);
    // Le PROCHAIN saut part d'ici, pas du point d'impact d'origine.
    curX = horde.x[bestSlot] ?? 0;
    curY = horde.y[bestSlot] ?? 0;
  }

  return result;
}
