import { chainTargets } from '@shared/chain';
import { CHAIN_JUMPS, CHAIN_RADIUS } from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import type { Horde } from '@shared/horde';
import { type Container, Graphics } from 'pixi.js';

/**
 * La polyligne de la chaine de Foudre, cote client (etape 5b, tache 3).
 *
 * ⚠️ **Rien ne voyage : ce calque REDERIVE la chaine, il ne la recoit pas.**
 * Le serveur applique `chainTargets` dans `resolveProjectileDamage`
 * (`back/src/combat.ts`), mais le message qui en resulte ne porte que des
 * `DEATHS` — comme toute mort. Ce fichier appelle le MEME `chainTargets`
 * (`shared/chain.ts`), sur la MEME horde, depuis le MEME point : une chaine
 * qui a eu lieu se retrace donc a l'identique, sans qu'un seul octet
 * supplementaire n'ait ete requis.
 *
 * ⚠️ **Le declencheur est la MARQUE, pas un evenement.** Il n'existe aucun
 * `ChainEvent` local a cote de `Horde.mark` : contrairement aux flashs
 * d'impact (nes de `Projectiles.collide`, purement cosmetiques), ce calque ne
 * garde aucun etat a lui. A chaque image, il relit `horde.markAt(i, tick)`
 * pour chaque ennemi — exactement le meme balayage que `MarkRingRenderer`
 * (`selectMarkedRings`) — et retrace la chaine pour tout ennemi actuellement
 * marque `FOUDRE`. La polyligne vit donc aussi longtemps que la marque
 * (`MARK_DURATION_TICKS`), et suit ses cibles si elles bougent : un choix
 * cosmetique assume, pas une approximation cachee — voir `GameClient#markLocally`
 * pour la meme discipline sur la teinte des ennemis.
 *
 * ⚠️ **La marque locale est une APPROXIMATION** (§2 de la spec de l'etape 5a,
 * documentee en detail sur `GameClient#markLocally`) : elle vient des propres
 * projectiles du joueur, ou d'une zone connue localement. Deux clients peuvent
 * donc tracer des chaines legerement differentes — sans consequence, puisque
 * c'est un effet purement visuel, jamais arbitre ici.
 */

/** Largeur du trait, en pixels monde. */
export const CHAIN_LINE_WIDTH_PX = 4;

/**
 * Opacite du trait. **Haute, contrairement a `ZONE_ALPHA`** : la Foudre est un
 * evenement instantane et rare (une chaine par impact), pas un etat persistant
 * — meme raisonnement que `MARK_RING_ALPHA`, qui casse deja la meme regle pour
 * la meme raison.
 */
export const CHAIN_LINE_ALPHA = 0.9;

/** Un point du monde, structurellement compatible avec `{ x, y }`. */
export interface ChainPoint {
  x: number;
  y: number;
}

/**
 * Une polyligne de chaine : le point d'impact d'abord, puis chaque saut DANS
 * L'ORDRE — c'est cet ordre qui en fait une polyligne et non une etoile (voir
 * le docbloc de `shared/chain.ts`).
 */
export interface ChainPolyline {
  points: ChainPoint[];
}

/**
 * Calcule les polylignes a dessiner au tick `tick` : une par ennemi
 * actuellement marque `FOUDRE`, depuis SA position.
 *
 * PURE, sans Pixi — testable sans canevas, meme motif que `selectZones` et
 * `selectMarkedRings`.
 *
 * ⚠️ **`markAt`, jamais `horde.mark` directement** — meme regle que
 * `selectMarkedRings` : une marque EXPIRE, et son expiration est DERIVEE du
 * seul `markUntil` (voir `Horde.markAt`). Lire le tableau brut laisserait des
 * chaines tracees bien apres la fin de la marque qui les origine.
 *
 * ⚠️ **`new Set([originId])`, et RIEN D'AUTRE en exclusion.** Ce calque ne
 * connait pas les morts du tick serveur (elles ne voyagent pas) : il ne peut
 * exclure que l'origine elle-meme, pour la meme raison que
 * `resolveProjectileDamage` le fait cote serveur — sans elle, le premier saut,
 * mesure depuis la position de l'origine, la retrouverait a distance nulle.
 */
export function selectChains(horde: Horde, tick: number): ChainPolyline[] {
  const chains: ChainPolyline[] = [];
  for (let i = 0; i < horde.count; i++) {
    if (horde.markAt(i, tick) !== ELEMENT.FOUDRE) {
      continue;
    }
    const originId = horde.entityIdAt(i);
    const cx = horde.x[i] ?? 0;
    const cy = horde.y[i] ?? 0;
    const path = chainTargets(horde, cx, cy, CHAIN_RADIUS, CHAIN_JUMPS, new Set([originId]));
    if (path.length === 0) {
      continue;
    }
    const points: ChainPoint[] = [{ x: cx, y: cy }];
    for (const id of path) {
      const slot = horde.slotOf(id);
      // ⚠️ **INATTEIGNABLE par construction, meme raisonnement que le
      // `chainedSlot >= 0` de `resolveProjectileDamage` cote serveur.**
      // `chainTargets` ne rend que des identites lues DANS `horde` a
      // l'instant meme de cet appel, et rien ne compacte la horde entre les
      // deux. Gardee quand meme : un point manquant silencieux briserait la
      // polyligne sans qu'aucune trace n'existe.
      if (slot < 0) {
        continue;
      }
      points.push({ x: horde.x[slot] ?? 0, y: horde.y[slot] ?? 0 });
    }
    chains.push({ points });
  }
  return chains;
}

export class ChainRenderer {
  readonly #graphics = new Graphics();
  /**
   * Rien de procedural a cuire (pas de canevas 2D, contrairement aux autres
   * calques) : ce booleen existe uniquement pour que `Stage` continue de
   * compter ses calques comme charges/pas charges par le meme protocole que
   * les autres — voir `Stage.layersLoaded` et sa doc sur la dette des 170
   * tests verts.
   */
  #ready = false;

  attach(parent: Container): void {
    parent.addChild(this.#graphics);
  }

  /** Expose pour le test, comme `boundsArea` sur les calques a particules. */
  get graphics(): Graphics {
    return this.#graphics;
  }

  get loaded(): boolean {
    return this.#ready;
  }

  load(): void {
    this.#ready = true;
  }

  /**
   * `tick` est le tick de horde du client (`GameClient.hordeTick`), **jamais
   * l'horloge murale** — meme convention que `drawMarks` : c'est lui qui dit
   * si la marque `FOUDRE` qui origine une chaine est encore vivante.
   */
  draw(horde: Horde, tick: number): void {
    this.#graphics.clear();
    if (!this.#ready) {
      return;
    }
    const tint = elementOf(ELEMENT.FOUDRE).tint;
    for (const chain of selectChains(horde, tick)) {
      const [origin, ...rest] = chain.points;
      if (!origin || rest.length === 0) {
        continue;
      }
      this.#graphics.moveTo(origin.x, origin.y);
      for (const p of rest) {
        this.#graphics.lineTo(p.x, p.y);
      }
    }
    this.#graphics.stroke({ color: tint, width: CHAIN_LINE_WIDTH_PX, alpha: CHAIN_LINE_ALPHA });
  }

  destroy(): void {
    this.#graphics.destroy();
  }
}
