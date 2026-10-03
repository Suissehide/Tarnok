import { LINK_RADIUS, ZONE_RADIUS } from './constants';
import type { Horde } from './horde';
import { zoneInvolvesVifArgent } from './reactions';
import type { ZoneField } from './zones';

/**
 * Les voisins LIES d'une entite : ceux qui partagent une zone de Vif-argent
 * avec elle et sont a moins de `LINK_RADIUS` (§3 de la spec de l'etape 5c).
 *
 * ⚠️ **Deterministe et NON TRANSITIVE.** Les positions de la horde sont
 * bit-identiques des deux cotes et les zones sont annoncees : la meme entree
 * rend la meme sortie, sans qu'aucune relation ne voyage. Mais une fermeture
 * transitive serait un parcours de graphe, dont le resultat depend de
 * l'ordre de visite — cet ordre depend du compactage de la horde
 * (`Horde#removeAt` echange avec le dernier element), qui n'est PAS garanti
 * identique des deux cotes du fil. C'est la troisieme rencontre de ce piege
 * dans ce projet : la chaine de la Foudre (5b, tache 2) departage par
 * `entityId` plutot que par l'ordre du tableau, *Embrasement* (5b, tache 6)
 * est devenu un rayon plutot qu'une propagation de proche en proche, et la
 * liaison ici en est la troisieme forme — voir `shared/links.test.ts` pour
 * le test qui separe les deux modeles.
 *
 * ⚠️ **L'entite elle-meme n'est JAMAIS dans le resultat.** Son propre centre
 * est a distance NULLE d'elle-meme, donc dans TOUT rayon — sans exclusion
 * explicite, chaque ennemi serait lie a lui-meme et *Amalgame* (tache 7)
 * le frapperait deux fois pour un seul impact recu.
 *
 * ⚠️ **« La meme zone », pas « une zone de Vif-argent chacun ».** Deux
 * ennemis chacun dans SA PROPRE zone de Vif-argent, meme proches l'un de
 * l'autre, ne sont pas lies si aucune zone ne les couvre TOUS LES DEUX a la
 * fois — voir le test dedie.
 *
 * ⚠️ **`O(zones x horde.count)`, meme famille que `ZoneField.ampAt` et
 * consorts.** Pas optimise davantage ici : la porte de performance du §8 de
 * la spec se mesure au banc dedie (tache 10), pas dans cette fonction.
 *
 * ⚠️ **`zoneInvolvesVifArgent` (`shared/reactions.ts`), PAS le nibble
 * d'ELEMENT — revue post-tache 9, qui RENVERSE le correctif de la tache 3.**
 * L'ancien filtre (`zoneReaction(kind) === 0`, « seules les zones purement
 * elementaires lient ») partait d'une observation exacte — le nibble
 * d'ELEMENT d'une zone de reaction porte le DECLENCHEUR, le second
 * projectile arrive, Vif-argent OU son partenaire selon l'ordre — mais en
 * tirait la mauvaise conclusion : il excluait TOUTE zone de reaction, alors
 * que `postZone` (`back/src/combat.ts`) est le SEUL createur de zones et que
 * les CINQ paires du Vif-argent (Vaporisation, Paratonnerre, Gel profond,
 * Aveuglement, Amalgame) sont TOUTES nommees dans `REACTION_DEFS` — une zone
 * portant le Vif-argent a donc TOUJOURS une reaction non nulle en
 * production. Le filtre excluait donc TOUT, en silence : mesure au banc,
 * `zonesLiantesVues = 0` sur 2700 ticks de combat reel, les quatre
 * mecanismes qui en dependent (Amalgame, Vaporisation, Paratonnerre, le
 * rayon de touche elargi) totalement inertes.
 *
 * Le bon deriveur lit la PAIRE de la reaction (`reactionOfId(zoneReaction(
 * kind))?.pair`), jamais le nibble d'element : `packElementPair` la
 * canonicalise (plus petit, plus grand), donc elle est ORDRE-INDEPENDANTE
 * par construction, contrairement au nibble d'element. Voir
 * `shared/links.test.ts` : une zone de reaction qui pair le Vif-argent LIE
 * desormais, dans les DEUX ordres de declencheur ; une zone dont la paire ne
 * contient pas le Vif-argent ne lie jamais.
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
    if (!zoneInvolvesVifArgent(zones.kind[z] ?? 0)) {
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
        // Jamais soi-meme : voir le docbloc ci-dessus.
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
