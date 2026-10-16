import { LINK_RADIUS, ZONE_RADIUS } from './constants';
import type { Horde } from './horde';
import { zoneVifArgent } from './reactions';
import type { ZoneField } from './zones';

/**
 * Les voisins LIES d'une entite : ceux qui partagent une zone de Vif-argent
 * avec elle et sont a moins de `LINK_RADIUS`.
 *
 * ⚠️ **Deterministe et NON TRANSITIVE.** Les positions de la horde sont
 * bit-identiques des deux cotes et les zones sont annoncees : la meme entree
 * rend la meme sortie, sans qu'aucune relation ne voyage. Mais une fermeture
 * transitive serait un parcours de graphe, dont le resultat depend de
 * l'ordre de visite — cet ordre depend du compactage de la horde
 * (`Horde#removeAt` echange avec le dernier element), qui n'est PAS garanti
 * identique des deux cotes du fil. Meme piege que la chaine de la Foudre et
 * *Embrasement* ; `shared/links.test.ts` separe les deux modeles.
 *
 * ⚠️ **L'entite elle-meme n'est JAMAIS dans le resultat.** Son propre centre
 * est a distance NULLE d'elle-meme, donc dans TOUT rayon — sans exclusion
 * explicite, chaque ennemi serait lie a lui-meme et *Amalgame*
 * le frapperait deux fois pour un seul impact recu.
 *
 * ⚠️ **« La meme zone », pas « une zone de Vif-argent chacun ».** Deux
 * ennemis chacun dans SA PROPRE zone de Vif-argent, meme proches l'un de
 * l'autre, ne sont pas lies si aucune zone ne les couvre TOUS LES DEUX a la
 * fois — voir le test dedie.
 *
 * `O(zones x horde.count)`, comme `ZoneField.ampAt` : la performance se
 * mesure au banc, pas ici.
 *
 * ⚠️ **Le critere est `zoneVifArgent` (`shared/reactions.ts`), un champ
 * EPINGLE de `REACTION_DEFS`, PARTAGE avec `ZoneField.hitRadiusBonusAt`** :
 * un seul critere pour la liaison et le rayon de touche. `true` sur les
 * TROIS reactions qui ont BESOIN du Vif-argent pour leur propre effet
 * (Vaporisation, Paratonnerre, Amalgame), `false` partout ailleurs, y compris
 * Gel profond et Aveuglement. Deux pieges evites :
 * - `zoneReaction(kind) === 0` n'irait pas : une zone portant le Vif-argent
 *   a TOUJOURS une reaction non nulle en production, rien ne lierait ;
 * - deriver de la paire d'elements ferait lier les cinq paires du Vif-argent,
 *   Gel profond et Aveuglement compris.
 *
 * ⚠️ **ORDRE-INDEPENDANTE** : `zoneVifArgent` est lu par `id`
 * (`zoneReaction(kind)`), jamais par un element, donc ne depend d'aucun
 * ordre d'arrivee des deux projectiles. `shared/links.test.ts` pose les deux
 * ordres de declencheur.
 */
export function linkedNeighbours(
  horde: Horde,
  slot: number,
  zones: ZoneField,
  tick: number,
): number[] {
  const zoneR2 = ZONE_RADIUS * ZONE_RADIUS;
  const linkR2 = LINK_RADIUS * LINK_RADIUS;
  const x0 = horde.x[slot] ?? 0;
  const y0 = horde.y[slot] ?? 0;

  const linked = new Set<number>();

  for (let z = 0; z < zones.count; z++) {
    if (!zoneVifArgent(zones.kind[z] ?? 0)) {
      continue;
    }
    if (!zones.aliveAt(z, tick)) {
      continue;
    }

    const zx = zones.x[z] ?? 0;
    const zy = zones.y[z] ?? 0;
    const dx0 = x0 - zx;
    const dy0 = y0 - zy;
    if (dx0 * dx0 + dy0 * dy0 >= zoneR2) {
      // L'entite `slot` elle-meme n'est pas dans CETTE zone : elle ne peut
      // partager cette zone-la avec personne.
      continue;
    }

    for (let i = 0; i < horde.count; i++) {
      if (i === slot) {
        continue;
      }

      const xi = horde.x[i] ?? 0;
      const yi = horde.y[i] ?? 0;
      const dxz = xi - zx;
      const dyz = yi - zy;
      if (dxz * dxz + dyz * dyz >= zoneR2) {
        // Candidat hors de CETTE zone : ne partage pas celle-ci avec `slot`,
        // meme s'il en partage peut-etre une autre a un tour suivant.
        continue;
      }

      const dx = xi - x0;
      const dy = yi - y0;
      if (dx * dx + dy * dy >= linkR2) {
        continue;
      }

      linked.add(horde.entityIdAt(i));
    }
  }

  return [...linked];
}
