import { ELEMENT, elementOf } from '@shared/elements';
import { type Container, Graphics } from 'pixi.js';

import { CHAIN_FLASH_LIFETIME_MS, type ChainFlashes } from '../net/client';

/**
 * La polyligne de la chaine de Foudre, cote client (etape 5b, tache 3).
 *
 * ⚠️ **TOUR DE CORRECTION 1 : ce calque ne lit plus jamais la horde.** La
 * premiere version redérivait la chaine a CHAQUE IMAGE depuis
 * `horde.markAt(i, tick) === FOUDRE`, un balayage `O(horde)` par ennemi
 * marque — et `GameClient#markInZones` peut marquer TOUTE la horde d'un
 * coup (c'est litteralement le decor du pire cas de
 * `mark-renderer.test.ts`), donc le cout reel etait `O(horde²)` par image :
 * jusqu'a ~48 millions d'operations a `MAX_ENTITIES`, en JS pur. La revue l'a
 * releve, avec le precedent du depot : `mark-renderer.ts` et
 * `projectile-renderer.ts` bornent tous deux leur pire cas ET le testent, ce
 * que cette version ne faisait ni l'un ni l'autre.
 *
 * **Le second defaut etait de fidelite, pas seulement de cout.** Le serveur
 * chaine UNE FOIS, a l'impact (`resolveProjectileDamage`), et n'y revient
 * jamais. Redériver depuis la marque (un etat DURABLE, `MARK_DURATION_TICKS`
 * = 60 ticks = 2 s) empruntait la machinerie d'un etat persistant pour
 * dessiner un evenement ponctuel — la polyligne suivait des ennemis qui
 * bougent pendant deux secondes, et rebasculait d'une image a l'autre entre
 * deux voisins presque equidistants, sans que rien de tel n'ait jamais eu
 * lieu cote serveur.
 *
 * **La correction : un FLASH, seme une fois, comme `HitFlashes` et
 * `ReactionFlashes`.** `GameClient#seedChainFlash` calcule le chemin une
 * seule fois, au moment ou son propre projectile de Foudre touche (le meme
 * instant que `hitFlashes.spawn(...)`), et le FIGE dans `ChainFlashes`. Ce
 * fichier ne fait plus que lire ce qui a ete figé et l'amortir sur
 * `CHAIN_FLASH_LIFETIME_MS` — exactement le role de `ImpactFlashRenderer` et
 * `ReactionFlashRenderer` (`projectile-renderer.ts`), dont il reprend la
 * discipline : itérer `flashes.count` (jamais la horde), un cout borne par la
 * CAPACITE du reservoir, jamais par la taille de la horde.
 *
 * ⚠️ **Reste cosmetique et approximatif, exactement comme `#markLocally`.**
 * Le client seme depuis SON PROPRE impact predit, pas depuis une annonce du
 * serveur : deux clients peuvent tracer des chaines legerement differentes
 * l'un de l'autre (projectiles des AUTRES joueurs jamais chaines ici, morts
 * du meme tick jamais exclues comme cote serveur) — voir la doc de
 * `GameClient#seedChainFlash`. Sans consequence : rien de ce que ce fichier
 * dessine n'entre jamais dans une decision de jeu.
 */

/** Largeur du trait, en pixels monde. */
export const CHAIN_LINE_WIDTH_PX = 4;

/**
 * Opacite MAXIMALE du trait, a la naissance du flash. **Haute, contrairement
 * a `ZONE_ALPHA`** : la Foudre est un evenement instantane et rare (un flash
 * par impact), pas un etat persistant — meme raisonnement que
 * `MARK_RING_ALPHA`, qui casse deja la meme regle pour la meme raison.
 *
 * S'ETEINT avec l'age du flash, comme `ImpactFlashRenderer` : un trait qui
 * resterait a pleine opacite jusqu'a sa disparition nette lirait comme un
 * clignotement, pas comme un evenement qui s'estompe.
 */
export const CHAIN_LINE_ALPHA = 0.9;

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
   * `nowMs` est l'horloge MURALE — meme convention que `drawImpactFlashes` /
   * `drawReactionFlashes`, et pour la meme raison : un flash de chaine
   * n'arbitre rien (§2), donc rien n'exige qu'il s'amortisse au rythme du
   * tick de simulation.
   *
   * ⚠️ **Ne lit QUE `flashes` : jamais la horde, jamais `chainTargets`.** Le
   * chemin est deja figé par `GameClient#seedChainFlash` — le recalculer ici
   * serait exactement la regression que le tour de correction 1 corrige.
   */
  draw(flashes: ChainFlashes, nowMs: number): void {
    this.#graphics.clear();
    if (!this.#ready) {
      return;
    }
    const tint = elementOf(ELEMENT.FOUDRE).tint;
    for (let i = 0; i < flashes.count; i++) {
      const n = flashes.pointCount[i] ?? 0;
      if (n < 2) {
        continue;
      }
      // S'ETEINT avec l'age, comme `ImpactFlashRenderer` : `t` de 0 (naissance)
      // a 1 (juste avant l'expiration, que `GameClient#advanceHorde` a deja
      // appliquee sur `flashes` avant cet appel — `flashes.count` n'inclut
      // donc deja plus aucun flash perime).
      const age = nowMs - (flashes.bornMs[i] ?? 0);
      const t = Math.min(1, Math.max(0, age / CHAIN_FLASH_LIFETIME_MS));
      const alpha = CHAIN_LINE_ALPHA * (1 - t);

      this.#graphics.moveTo(flashes.pointX(i, 0), flashes.pointY(i, 0));
      for (let p = 1; p < n; p++) {
        this.#graphics.lineTo(flashes.pointX(i, p), flashes.pointY(i, p));
      }
      // Un `stroke` PAR FLASH, pas un seul a la fin : chaque chaine a son
      // propre age, donc sa propre opacite — un `stroke` commun appliquerait
      // la teinte du DERNIER flash a tous les traits deja tracés.
      this.#graphics.stroke({ color: tint, width: CHAIN_LINE_WIDTH_PX, alpha });
    }
  }

  destroy(): void {
    this.#graphics.destroy();
  }
}
