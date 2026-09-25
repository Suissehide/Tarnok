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
 * ⚠️ **« Les N plus proches dans un rayon R », au sens litteral (§4 de la
 * spec) — pas un parcours qui saute de voisin en voisin.** Un parcours de
 * proche en proche est un graphe dont le resultat depend de l'ordre de
 * visite, exactement la fragilite qu'Embrasement (tache 6) evite pour la
 * meme raison. `chainTargets` trie donc la horde une seule fois par la
 * distance au POINT D'IMPACT fixe `(cx, cy)`, jamais par la distance a la
 * derniere cible choisie.
 *
 * `exclude` porte les identites deja touchees — c'est ce qui empeche la
 * chaine de revenir sur ses pas (l'entite frappee par l'impact direct,
 * typiquement), et c'est aussi le parametre par lequel la tache 3 exclut les
 * morts : un ennemi mort du meme impact ne doit pas propager.
 *
 * Rend au plus `jumps` identites, triees de la plus proche a la plus
 * lointaine — moins si `CHAIN_RADIUS` (ou le `radius` passe) n'offre pas
 * assez de cibles vivantes. Jamais plus : `jumps` est un plafond, pas une
 * promesse.
 */
export function chainTargets(
  horde: Horde,
  cx: number,
  cy: number,
  radius: number,
  jumps: number,
  exclude: ReadonlySet<number>,
): number[] {
  if (jumps <= 0) {
    return [];
  }

  const r2 = radius * radius;
  const candidates: { id: number; d2: number }[] = [];

  for (let i = 0; i < horde.count; i++) {
    const id = horde.entityIdAt(i);
    if (exclude.has(id)) {
      continue;
    }
    const dx = (horde.x[i] ?? 0) - cx;
    const dy = (horde.y[i] ?? 0) - cy;
    const d2 = dx * dx + dy * dy;
    // Meme convention que `nearestTarget` : la borne est INCLUSIVE (`>`,
    // pas `>=`), une entite pile a `radius` compte.
    if (d2 > r2) {
      continue;
    }
    candidates.push({ id, d2 });
  }

  // Comparateur totalement ordonnant : `d2` d'abord, `id` en depart a
  // egalite EXACTE. Deux entites distinctes ne peuvent jamais avoir le meme
  // `id`, donc ce tri ne depend a aucun moment de l'ordre dans lequel
  // `candidates` a ete rempli — donc pas de l'ordre du tableau de `horde`
  // (voir le docbloc du module). `Array.prototype.sort` n'a pas besoin
  // d'etre stable ici : le comparateur seul fixe l'ordre.
  candidates.sort((a, b) => a.d2 - b.d2 || a.id - b.id);

  return candidates.slice(0, jumps).map((c) => c.id);
}
