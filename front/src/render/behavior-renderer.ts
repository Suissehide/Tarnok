import {
  archetypeOf,
  KAMIKAZE_RADIUS,
  NECRO_RADIUS,
  SHAMAN_AURA_RADIUS,
  SHOT_RADIUS,
} from '@shared/archetypes';
import type { EnemyShot } from '@shared/enemy-shots';
import type { Horde } from '@shared/horde';
import { Container, Graphics, type Rectangle, Sprite, type Texture } from 'pixi.js';

import { type BlastFlash, flashLifeMs } from '../net/client';
import { COIN_TINT } from './orb-renderer';
import { framesOf } from './player-renderer';

/**
 * Ce que les comportements montrent au sol (retour de playtest : *« des
 * monstres uniques »*) : le cercle d'alerte d'un kamikaze — exactement le
 * rayon de son explosion —, l'aura d'un chaman, et les explosions elles-memes.
 * Tout est DERIVE de la horde et des morts deja recues : aucun octet de plus.
 */

export interface BehaviorShape {
  kind: 'kamikaze' | 'chaman' | 'necro' | 'bouclier' | 'butin' | 'coffre' | 'explosion' | 'releve';
  x: number;
  y: number;
  radius: number;
  /** De 0 a 1 : l'opacite (l'explosion s'eteint). */
  alpha: number;
  /** Le bouclier : son cap, en radians. */
  angle?: number;
}

/**
 * Le porteur de coffre (etape 11, §5.1) : un anneau dore sous ses pieds — ce
 * rayon —, et un coffre au-dessus. Le corps reste celui d'un voleur (le
 * `ParticleContainer` ne televerse pas la couleur) : l'or est AUTOUR.
 */
export const PORTEUR_RING_RADIUS = 46;
/** Hauteur du coffre au-dessus du porteur, en px monde. */
const CHEST_LIFT = 60;
/** Le brun du contour, du couvercle et de la serrure. */
const CHEST_BROWN = 0x5a3a1a;

/**
 * Un petit coffre procedural centre sur (x, y) : 22 x 15 px a l'echelle 1,
 * dore, contoure de brun, couvercle au tiers haut, serrure au centre. Aucun
 * fichier d'image. Partage avec la fleche de bord (`PingRenderer`).
 */
export function drawChest(g: Graphics, x: number, y: number, scale: number): void {
  const w = 22 * scale;
  const h = 15 * scale;
  const left = x - w / 2;
  const top = y - h / 2;
  g.rect(left, top, w, h).fill(COIN_TINT).stroke({ color: CHEST_BROWN, width: 2 });
  // `moveTo` d'abord : sans lui, Pixi relierait le couvercle a la forme precedente.
  g.moveTo(left, top + h / 3)
    .lineTo(left + w, top + h / 3)
    .stroke({ color: CHEST_BROWN, width: 2 });
  const k = 4 * scale;
  g.rect(x - k / 2, y - k / 2, k, k).fill(CHEST_BROWN);
}

/**
 * Les formes a dessiner, dans le cadre `view` (et sa marge). PURE : la horde,
 * les explosions, l'horloge — c'est elle que les tests lisent.
 */
export function behaviorShapes(
  horde: Horde,
  blasts: readonly BlastFlash[],
  view: Rectangle,
  nowMs: number,
): BehaviorShape[] {
  const out: BehaviorShape[] = [];
  const marge = SHAMAN_AURA_RADIUS;
  for (let i = 0; i < horde.count; i++) {
    const behavior = archetypeOf(horde.archetype[i] ?? 0).behavior;
    const enFuite = behavior === 'voleur' && horde.fleeing[i] === 1;
    if (
      behavior !== 'kamikaze' &&
      behavior !== 'chaman' &&
      behavior !== 'necro' &&
      behavior !== 'bouclier' &&
      behavior !== 'porteur' &&
      !enFuite
    ) {
      continue;
    }
    const x = horde.x[i] ?? 0;
    const y = horde.y[i] ?? 0;
    if (
      x < view.x - marge ||
      x > view.x + view.width + marge ||
      y < view.y - marge ||
      y > view.y + view.height + marge
    ) {
      continue;
    }
    if (behavior === 'kamikaze') {
      out.push({ kind: 'kamikaze', x, y, radius: KAMIKAZE_RADIUS, alpha: 1 });
    } else if (behavior === 'chaman') {
      out.push({ kind: 'chaman', x, y, radius: SHAMAN_AURA_RADIUS, alpha: 1 });
    } else if (behavior === 'necro') {
      out.push({ kind: 'necro', x, y, radius: NECRO_RADIUS, alpha: 1 });
    } else if (behavior === 'bouclier') {
      const angle = Math.atan2(horde.vy[i] ?? 0, horde.vx[i] ?? 0);
      out.push({ kind: 'bouclier', x, y, radius: 30, alpha: 1, angle });
    } else if (behavior === 'porteur') {
      // En permanence, a l'arret comme en fuite : c'est ce qui le distingue
      // d'un voleur ordinaire d'un coup d'oeil, avec sa taille.
      out.push({ kind: 'coffre', x, y, radius: PORTEUR_RING_RADIUS, alpha: 1 });
    } else {
      out.push({ kind: 'butin', x, y: y - 42, radius: 7, alpha: 1 });
    }
  }
  for (const b of blasts) {
    const t = (nowMs - b.bornMs) / flashLifeMs(b);
    if (t < 0 || t >= 1) {
      continue;
    }
    if (b.kind === 'releve') {
      out.push({ kind: 'releve', x: b.x, y: b.y, radius: 40, alpha: 1 - t });
      continue;
    }
    out.push({
      kind: 'explosion',
      x: b.x,
      y: b.y,
      radius: KAMIKAZE_RADIUS * (0.5 + 0.6 * t),
      alpha: 1 - t,
    });
  }
  return out;
}

/**
 * Les planches du pack que ces effets jouent, par nom d'archetype pour les
 * tirs. `frame` : le cote d'une image ; `spin` : le projectile tourne en vol
 * (os, gland) plutot que de pointer sa direction (harpon, dessine a -45°).
 */
const SHOT_SHEETS: Readonly<Record<string, { path: string; frame: number; spin: boolean }>> = {
  gnoll: { path: 'Monsters/Gnoll/Gnoll_Bone.png', frame: 64, spin: true },
  'slingshot-gnome': {
    path: 'Monsters/Slingshot Gnome/Acorn_Projectile.png',
    frame: 64,
    spin: true,
  },
  'harpoon-shark': { path: 'Monsters/Harpoon Shark/Harpoon.png', frame: 64, spin: false },
};
/** `content` : le diametre du dessin au plus fort, mesure sur la planche (64 px sur 192). */
const EXPLOSION = { path: 'Particle FX/Explosion_01.png', frame: 192, content: 64 };
const HEX_CAST = { path: 'Monsters/Hex Shaman/Hex Shaman_Explosion.png', frame: 128 };
/** Le sort de transformation du pack : la bouffee qui releve un mort. */
const RAISE = {
  path: 'Monsters/Extra/Hex Shaman Transformation Spell/Hex Shaman_Explosion Spell.png',
  frame: 192,
};
const COIN = { path: 'UI Elements/UI Elements/Icons/Icon_03.png', frame: 64 };
/** Le chaman lance son sort toutes les `HEX_PERIOD_MS`, pendant `HEX_CAST_MS`. */
const HEX_PERIOD_MS = 2400;
const HEX_CAST_MS = 700;

export class BehaviorRenderer {
  readonly #root = new Container();
  readonly #graphics = new Graphics();
  readonly #sprites = new Container();
  /** Reserve de sprites reutilises d'une image a l'autre : jamais d'allocation par tir. */
  readonly #pool: Sprite[] = [];
  #used = 0;
  readonly #frames = new Map<string, Texture[]>();
  #ready = false;

  constructor(private readonly assetsBase = '') {
    this.#root.addChild(this.#graphics, this.#sprites);
  }

  attach(parent: Container): void {
    parent.addChild(this.#root);
  }

  get loaded(): boolean {
    return this.#ready;
  }

  /**
   * Pret tout de suite (cercles et repli dessines en code) ; les planches
   * arrivent en arriere-plan, et un effet sans sa planche garde son dessin.
   */
  load(): void {
    this.#ready = true;
    const all = [...Object.values(SHOT_SHEETS), EXPLOSION, HEX_CAST, RAISE, COIN];
    for (const sheet of all) {
      framesOf(`${this.assetsBase}/${encodeURI(sheet.path)}`, sheet.frame)
        .then((frames) => this.#frames.set(sheet.path, frames))
        .catch(() => undefined);
    }
  }

  #sprite(path: string, index: number): Sprite | null {
    const frames = this.#frames.get(path);
    const texture = frames?.[index % frames.length];
    if (!texture) {
      return null;
    }
    let s = this.#pool[this.#used];
    if (!s) {
      s = new Sprite();
      s.anchor.set(0.5);
      this.#pool.push(s);
      this.#sprites.addChild(s);
    }
    this.#used++;
    s.texture = texture;
    s.visible = true;
    s.alpha = 1;
    s.rotation = 0;
    return s;
  }

  draw(
    horde: Horde,
    blasts: readonly BlastFlash[],
    shots: readonly EnemyShot[],
    view: Rectangle,
    nowMs: number,
  ): void {
    const g = this.#graphics;
    g.clear();
    this.#used = 0;
    // Les tirs ennemis : le projectile du pack de chaque tireur ; une bille
    // rouge cerclee de noir tant que sa planche n'est pas chargee.
    for (const t of shots) {
      const sheet = SHOT_SHEETS[archetypeOf(t.archetype).name];
      const sp = sheet ? this.#sprite(sheet.path, Math.floor(nowMs / 90)) : null;
      if (sp && sheet) {
        sp.position.set(t.x, t.y);
        sp.scale.set(0.7);
        sp.rotation = sheet.spin ? 0 : Math.atan2(t.uy, t.ux) + Math.PI / 4;
      } else {
        g.circle(t.x, t.y, SHOT_RADIUS).fill(0xff4a3d).stroke({ color: 0x1a0f0a, width: 2 });
      }
    }
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 140);
    const hexT = (nowMs % HEX_PERIOD_MS) / HEX_CAST_MS;
    for (const s of behaviorShapes(horde, blasts, view, nowMs)) {
      if (s.kind === 'kamikaze') {
        // Le rayon EXACT de l'explosion, rouge et qui bat : on sait ou ne pas etre.
        g.circle(s.x, s.y, s.radius).fill({ color: 0xff3b2f, alpha: 0.07 + 0.05 * pulse });
        g.circle(s.x, s.y, s.radius).stroke({
          color: 0xff3b2f,
          width: 3,
          alpha: 0.5 + 0.4 * pulse,
        });
      } else if (s.kind === 'chaman') {
        // L'aura : un voile violet calme, qui dit « tuez-moi d'abord ».
        g.circle(s.x, s.y, s.radius).fill({ color: 0xa66bff, alpha: 0.08 });
        g.circle(s.x, s.y, s.radius).stroke({ color: 0xc9a2ff, width: 2, alpha: 0.45 });
        // Et le sort du pack, lance a intervalle regulier : c'est lui qui la nourrit.
        const n = this.#frames.get(HEX_CAST.path)?.length ?? 0;
        if (hexT < 1 && n > 0) {
          const sp = this.#sprite(HEX_CAST.path, Math.floor(hexT * n));
          sp?.position.set(s.x, s.y);
          sp?.scale.set(1.4);
        }
      } else if (s.kind === 'necro') {
        // Le rayon ou les morts se relevent : vert d'outre-tombe.
        g.circle(s.x, s.y, s.radius).fill({ color: 0x5bd16a, alpha: 0.06 });
        g.circle(s.x, s.y, s.radius).stroke({ color: 0x7cf08a, width: 2, alpha: 0.4 });
      } else if (s.kind === 'bouclier') {
        // L'arc du bouclier, devant lui : c'est le cote ou les tirs ricochent.
        const a = s.angle ?? 0;
        // `moveTo` d'abord : sans lui, Pixi relie l'arc a la fin de la forme
        // precedente — le long trait blanc vu en jeu.
        g.moveTo(s.x + Math.cos(a - 0.9) * s.radius, s.y + Math.sin(a - 0.9) * s.radius);
        g.arc(s.x, s.y, s.radius, a - 0.9, a + 0.9).stroke({
          color: 0xd9e3f0,
          width: 5,
          alpha: 0.85,
        });
      } else if (s.kind === 'butin') {
        // Le voleur en fuite porte l'or vole : la piece du HUD au-dessus de la tete.
        const sp = this.#sprite(COIN.path, 0);
        if (sp) {
          sp.position.set(s.x, s.y);
          sp.scale.set(0.45);
        } else {
          g.circle(s.x, s.y, s.radius).fill(0xffd34d).stroke({ color: 0x1a0f0a, width: 2 });
        }
      } else if (s.kind === 'coffre') {
        // L'anneau dore sous ses pieds, rempli a 20 %, puis le coffre au-dessus.
        g.circle(s.x, s.y, s.radius).fill({ color: COIN_TINT, alpha: 0.2 });
        g.circle(s.x, s.y, s.radius).stroke({ color: COIN_TINT, width: 4 });
        drawChest(g, s.x, s.y - CHEST_LIFT, 1);
      } else if (s.kind === 'releve') {
        // Le sort de transformation, la ou les squelettes se relevent ; un
        // eclat vert en repli.
        const n = this.#frames.get(RAISE.path)?.length ?? 0;
        const t = 1 - s.alpha;
        const sp = n > 0 ? this.#sprite(RAISE.path, Math.min(n - 1, Math.floor(t * n))) : null;
        if (sp) {
          sp.position.set(s.x, s.y - 20);
        } else {
          g.circle(s.x, s.y, s.radius).fill({ color: 0x7cf08a, alpha: 0.5 * s.alpha });
        }
      } else {
        // L'explosion du pack, etiree au rayon reel ; le disque en repli.
        const n = this.#frames.get(EXPLOSION.path)?.length ?? 0;
        const t = 1 - s.alpha;
        const sp = n > 0 ? this.#sprite(EXPLOSION.path, Math.min(n - 1, Math.floor(t * n))) : null;
        // Un eclair qui couvre EXACTEMENT la zone touchee, le premier quart :
        // l'explosion du pack seule se lisait mal (retour de playtest).
        if (t < 0.25) {
          g.circle(s.x, s.y, KAMIKAZE_RADIUS).fill({
            color: 0xffb347,
            alpha: 0.45 * (1 - t / 0.25),
          });
        }
        if (sp) {
          sp.position.set(s.x, s.y);
          sp.scale.set((KAMIKAZE_RADIUS * 2) / EXPLOSION.content);
        } else {
          g.circle(s.x, s.y, s.radius).fill({ color: 0xffa21f, alpha: 0.55 * s.alpha });
          g.circle(s.x, s.y, s.radius).stroke({ color: 0xfff0b0, width: 5, alpha: s.alpha });
        }
      }
    }
    for (let k = this.#used; k < this.#pool.length; k++) {
      const sp = this.#pool[k];
      if (sp) {
        sp.visible = false;
      }
    }
  }
}
