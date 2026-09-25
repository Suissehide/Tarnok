import type { Horde } from './horde';

/**
 * Les cibles d'une chaine de Foudre, depuis un point d'impact.
 *
 * ⚠️ **Totalement deterministe, et c'est la raison d'etre du fichier.** Les
 * positions de la horde sont bit-identiques des deux cotes (contrat de
 * l'etape 2, 0,000 px) : la meme entree rend donc la meme sortie, et il n'y
 * a RIEN a annoncer. Mais a une condition — a distance egale, c'est
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
 * ⚠️ **Une CHAINE, pas une etoile.** Une premiere version de ce fichier
 * triait la horde une seule fois par la distance au point d'impact
 * `(cx, cy)` — « les N plus proches DU POINT D'IMPACT », au sens le plus
 * litteral du §4 de la spec. C'etait une lecture incomplete : le §4 demande
 * aussi une POLYLIGNE cote client (une etoile ne s'en dessine pas une), le
 * parametre `exclude` n'a de sens qu'ENTRE deux sauts, et Court-circuit
 * (tache 6) « propage sans limite de sauts » — une phrase vide si chaque
 * saut repart du meme point. La forme retenue : **a chaque saut, la cible la
 * plus proche NON DEJA TOUCHEE, dans `radius`, mesuree depuis la position de
 * la cible du saut PRECEDENT** — le premier saut seul est mesure depuis
 * `(cx, cy)`. `curX`/`curY` ci-dessous portent ce curseur.
 *
 * Reste totalement deterministe et independant de l'ordre du tableau : le
 * curseur n'est jamais qu'une position de horde deja bit-identique des deux
 * cotes, et le departage a distance egale (`entityId`, ci-dessus) s'applique
 * a CHAQUE saut, pas seulement au premier.
 *
 * ⚠️ **`O(jumps x horde.count)`, et volontairement pas optimise davantage.**
 * Avec `CHAIN_JUMPS` a 3, c'est le meme ordre de grandeur qu'un tri unique en
 * `O(horde.count log horde.count)` — la porte de performance du §7 de la
 * spec se mesure au banc de la tache 10, pas ici : ecrire la forme lisible
 * d'abord.
 *
 * `exclude` porte les identites deja touchees AVANT le premier saut — c'est
 * ce qui empeche la chaine de revenir sur ses pas (l'entite frappee par
 * l'impact direct, typiquement), et c'est aussi le parametre par lequel la
 * tache 3 exclut les morts : un ennemi mort du meme impact ne doit pas
 * propager. Les cibles choisies PENDANT la chaine s'y ajoutent au fur et a
 * mesure (une chaine ne revient jamais sur une cible qu'elle vient de
 * toucher), sans modifier le `Set` passe par l'appelant.
 *
 * Rend au plus `jumps` identites, dans l'ORDRE DES SAUTS (la premiere cible
 * touchee, puis la seconde, etc.) — moins si un saut ne trouve plus personne
 * dans `radius` autour du curseur courant, auquel cas la chaine S'ARRETE LA
 * plutot que de sauter plus loin. Jamais plus : `jumps` est un plafond, pas
 * une promesse.
 */
export function chainTargets(
  horde: Horde,
  cx: number,
  cy: number,
  radius: number,
  jumps: number,
  exclude: ReadonlySet<number>,
): number[] {
  // ⚠️ **Pas de garde `jumps <= 0` ici, et c'est delibere.** Contrairement a
  // la version en etoile (qui tranchait via `Array.prototype.slice`, ou un
  // index negatif se compte depuis la fin — un piege reel, voir le rapport
  // de correction), la boucle ci-dessous n'execute simplement aucun tour
  // quand `jumps <= 0` (`0 < jumps` est faux) : une garde explicite ajouterait
  // une branche qu'aucune mutation ne peut faire rougir, jamais exercee par
  // aucun chemin.
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
      // Comparateur totalement ordonnant : `d2` d'abord, `id` en depart a
      // egalite EXACTE — jamais l'ordre de parcours de `horde`. Meme
      // convention que `nearestTarget` (`shared/targeting.ts`) :
      // `bestId` demarre a `-1`, donc le premier candidat trouve est
      // toujours retenu par la branche `d2 < bestD2` seule.
      if (d2 < bestD2 || (d2 === bestD2 && id < bestId)) {
        bestD2 = d2;
        bestId = id;
        bestSlot = i;
      }
    }

    if (bestSlot === -1) {
      // Plus personne a portee du curseur courant : la chaine s'arrete,
      // elle ne saute pas plus loin pour recuperer les sauts restants.
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
