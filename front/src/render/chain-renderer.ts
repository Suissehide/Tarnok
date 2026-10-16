import { ELEMENT, elementOf } from '@shared/elements';
import { type Container, Graphics } from 'pixi.js';

import { BEAM_FLASH_LIFETIME_MS, CHAIN_FLASH_LIFETIME_MS, type ChainFlashes } from '../net/client';

/** Ce que le faisceau lit d'un joueur pour rester accroche a lui. */
export interface BeamAnchor {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/** Etincelles par faisceau : un nombre fixe, donc un cout borne par flash. */
export const BEAM_SPARKS = 14;

/** Hachage deterministe dans `[0, 1)` : une etincelle garde sa trajectoire d'une image a l'autre. */
function hash01(a: number, b: number): number {
  const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * La polyligne de la chaine de Foudre, et les faisceaux, cote client.
 *
 * ⚠️ **Ce calque ne lit jamais la horde.** Le serveur chaine UNE FOIS, a
 * l'impact (`resolveProjectileDamage`) : `GameClient#seedChainFlash` calcule
 * le chemin au meme instant et le FIGE dans `ChainFlashes`, comme
 * `HitFlashes`. Ce fichier ne fait que l'amortir sur
 * `CHAIN_FLASH_LIFETIME_MS`, en iterant `flashes.count` : cout borne par la
 * capacite du reservoir. Rederiver la chaine de la marque a chaque image
 * coutait `O(horde²)` (`#markInZones` peut marquer toute la horde) et faisait
 * suivre au trait des ennemis qui bougent pendant toute la duree de la marque.
 *
 * ⚠️ **Cosmetique et approximatif, comme `#markLocally`** : le client seme
 * depuis SON impact predit, donc deux clients peuvent tracer des chaines un
 * peu differentes (voir `GameClient#seedChainFlash`). Rien ici n'entre dans
 * une decision de jeu.
 */

/** Largeur du trait, en pixels monde. */
export const CHAIN_LINE_WIDTH_PX = 4;

/**
 * Opacite MAXIMALE du trait, a la naissance du flash. **Haute, contrairement
 * a `ZONE_ALPHA`** : la Foudre est un evenement instantane et rare, pas un
 * etat persistant (meme raison que `MARK_RING_ALPHA`). Elle s'eteint avec
 * l'age du flash : une disparition nette lirait comme un clignotement.
 */
export const CHAIN_LINE_ALPHA = 0.9;

export class ChainRenderer {
  readonly #graphics = new Graphics();
  /**
   * Rien a cuire : ce booleen sert seulement le protocole de chargement
   * commun a tous les calques (`Stage.layersLoaded`).
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
   * `nowMs` est l'horloge MURALE, comme `drawImpactFlashes` : un flash de
   * chaine n'arbitre rien, il n'a pas a suivre le tick de simulation.
   *
   * ⚠️ **Ne lit QUE `flashes` : jamais la horde, jamais `chainTargets`.**
   */
  draw(flashes: ChainFlashes, nowMs: number, players: readonly BeamAnchor[] = []): void {
    this.#graphics.clear();
    if (!this.#ready) {
      return;
    }
    for (let i = 0; i < flashes.count; i++) {
      const n = flashes.pointCount[i] ?? 0;
      if (n < 2) {
        continue;
      }
      const owner = flashes.owner[i] ?? -1;
      if (owner >= 0) {
        this.#drawBeam(
          flashes,
          i,
          nowMs,
          players.find((p) => p.id === owner),
        );
        continue;
      }
      // `t` de 0 (naissance) a 1 (expiration). `GameClient#advanceHorde` a
      // deja retire les flashs perimes de `flashes.count`.
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
      // ⚠️ **La teinte et l'epaisseur viennent du FLASH** : la chaine de
      // Foudre est jaune et fine, le faisceau porte la teinte et la largeur de
      // son arme. Un flash sans teinte ni largeur retombe sur la Foudre.
      this.#graphics.stroke({
        color: flashes.tint[i] || elementOf(ELEMENT.FOUDRE).tint,
        width: flashes.width[i] || CHAIN_LINE_WIDTH_PX,
        alpha,
      });
    }
  }

  /**
   * Un faisceau : un halo large, un corps teinte et un coeur blanc, qui
   * FRAPPENT (largeur qui jaillit puis se resserre), ondulent, et s'eteignent
   * en se rétrécissant. Des etincelles se detachent du trait. Le trait reste
   * accroche a son tireur (`anchor`, sa position dessinee) — la direction,
   * elle, est celle du tir, la seule que le serveur a fauchee.
   */
  #drawBeam(flashes: ChainFlashes, i: number, nowMs: number, anchor?: BeamAnchor): void {
    const g = this.#graphics;
    const born = flashes.bornMs[i] ?? 0;
    const age = nowMs - born;
    const t = Math.min(1, Math.max(0, age / BEAM_FLASH_LIFETIME_MS));
    const x0 = flashes.pointX(i, 0);
    const y0 = flashes.pointY(i, 0);
    const dx = flashes.pointX(i, 1) - x0;
    const dy = flashes.pointY(i, 1) - y0;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const ax = anchor ? anchor.x : x0;
    const ay = anchor ? anchor.y : y0;
    const bx = ax + dx;
    const by = ay + dy;
    const color = flashes.tint[i] || elementOf(ELEMENT.FOUDRE).tint;
    const full = flashes.width[i] || CHAIN_LINE_WIDTH_PX;
    // Frappe : 0 -> 1,25 en 12 % de la vie, puis decroissance douce vers 0.
    const env = t < 0.12 ? (t / 0.12) * 1.25 : 1.25 * (1 - (t - 0.12) / 0.88) ** 1.4;
    const flicker = 0.85 + 0.15 * Math.sin(age * 0.09 + born);
    const w = full * env * flicker;
    if (w <= 0.2) {
      return;
    }
    const fade = 1 - t * t;

    g.moveTo(ax, ay)
      .lineTo(bx, by)
      .stroke({ color, width: w * 2.2, alpha: 0.18 * fade, cap: 'round' });
    g.moveTo(ax, ay)
      .lineTo(bx, by)
      .stroke({ color, width: w, alpha: 0.55 * fade, cap: 'round' });
    // Le coeur ondule : une sinusoide qui court le long du trait.
    const segments = 16;
    const amp = w * 0.12;
    g.moveTo(ax, ay);
    for (let s = 1; s <= segments; s++) {
      const k = s / segments;
      const off = Math.sin(k * 18 - age * 0.05) * amp * Math.sin(k * Math.PI);
      g.lineTo(ax + dx * k - uy * off, ay + dy * k + ux * off);
    }
    g.stroke({ color: 0xffffff, width: Math.max(1.5, w * 0.3), alpha: 0.95 * fade, cap: 'round' });

    // Bouche du rayon et point d'impact.
    g.circle(ax, ay, w * 0.9).fill({ color, alpha: 0.35 * fade });
    g.circle(ax, ay, w * 0.4).fill({ color: 0xffffff, alpha: 0.8 * fade });
    g.circle(bx, by, w * 0.6).fill({ color, alpha: 0.4 * fade });

    // Etincelles : nees le long du trait, elles s'en ecartent et s'eteignent.
    for (let s = 0; s < BEAM_SPARKS; s++) {
      const along = hash01(born, s);
      const side = hash01(s, born) < 0.5 ? -1 : 1;
      const drift = (0.4 + hash01(born + 1, s) * 0.8) * full * 1.6 * t * side;
      const slide = (hash01(s + 7, born) - 0.3) * 40 * t;
      const px = ax + dx * along - uy * drift + ux * slide;
      const py = ay + dy * along + ux * drift + uy * slide;
      const r = (1 + hash01(born + 3, s) * 2.2) * (1 - t);
      if (r > 0.3) {
        g.circle(px, py, r).fill({ color: s % 3 === 0 ? 0xffffff : color, alpha: 0.9 * (1 - t) });
      }
    }
  }

  destroy(): void {
    this.#graphics.destroy();
  }
}
