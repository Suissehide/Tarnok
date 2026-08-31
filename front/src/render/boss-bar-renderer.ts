import { archetypeOf, BOSS_ARCHETYPE } from '@shared/archetypes';
import { MAP_SIZE, PROJECTILE_HIT_RADIUS } from '@shared/constants';
import type { Horde } from '@shared/horde';
import { type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

import type { BossVitals } from '../net/client';
import { BODY_SCALE } from './horde-renderer';

/**
 * La barre de vie du boss (etape 6a, tache 5).
 *
 * > Decision de l'auteur : *« prevois une petite barre d'hp au dessus des
 * > boss »*.
 *
 * ⚠️ **Elle appartient a la CREATURE, pas a l'ecran.** Ce n'est pas un bandeau
 * de HUD : elle vit dans le monde, en coordonnees monde, elle suit le boss et
 * elle disparait avec lui. C'est aussi la SEULE barre de vie du jeu — ni la
 * pietaille ni les joueurs n'en ont, et c'est ce qui la rend lisible : quand
 * une barre apparait, c'est qu'il y a un boss.
 *
 * ## Pourquoi elle est dessinee en code
 *
 * Le pack fournit `UI Elements/UI Elements/Bars/SmallBar_Base.png` et
 * `SmallBar_Fill.png`. **Ils ne sont pas utilises, et ils ne doivent jamais
 * entrer dans le depot** : la licence Pixel Frog interdit la redistribution
 * meme apres modification, ce depot est public, et la CI echoue sur
 * `git ls-files | grep '^assets/tinyswords'`. Les integrer aurait demande un
 * SECOND pipeline (un outil de `tools/`, un derive de plus a deposer sur MinIO,
 * un chargement reseau de plus a rattraper quand il echoue — voir le
 * `try/catch` de `Stage.init`) pour deux rectangles. Le plan de la tache 5
 * tranche explicitement : *« si le chemin MinIO n'est pas praticable dans la
 * tache, dessiner la barre en code »*, comme `makeGlowTexture`,
 * `makeZoneTexture`, `makeRingTexture` et l'atlas de projectiles le font deja.
 *
 * ## Deux quads, et c'est tout
 *
 * Le socle (sombre, largeur pleine) et le remplissage (rouge, ancre a GAUCHE
 * pour vider vers la droite). Il n'y a qu'un boss vivant a la fois — c'est le
 * NOMBRE qui autorise sa vie a voyager sur le fil (§1.1 de la spec), et c'est le
 * meme nombre qui autorise ce calque a ne rien borner ni culler : deux quads au
 * pire, contre les 4 000 de la horde.
 */

/** Marge des bornes explicites, meme raisonnement que `ZoneRenderer`/`MarkRingRenderer`. */
const BOUNDS_MARGIN = 256;

/**
 * Taille a laquelle le CORPS du boss est dessine, en pixels monde.
 *
 * ⚠️ **DERIVEE, jamais ecrite a la main.** `spriteScale` ramene la plus grande
 * dimension du contenu de l'atlas a `2 x PROJECTILE_HIT_RADIUS x BODY_SCALE x
 * bodyScale` : c'est donc exactement ce produit qui donne la taille dessinee,
 * et il suit tout seul le jour ou la hitbox de tir, le facteur commun ou le
 * facteur du boss bougent. Lire `bodyScale` sur l'archetype plutot que
 * `BOSS_BODY_SCALE` directement, c'est la meme raison qui fait que
 * `BOSS_ARCHETYPE` se derive du nom : un seul endroit decide.
 */
export const BOSS_BODY_SIZE_PX =
  2 * PROJECTILE_HIT_RADIUS * BODY_SCALE * archetypeOf(BOSS_ARCHETYPE).bodyScale;

/**
 * Longueur de la barre : celle du corps dessine.
 *
 * Elle ceinture exactement la silhouette, donc elle se lit comme lui
 * appartenant. « Petite » se joue sur l'EPAISSEUR (voir ci-dessous), pas sur la
 * longueur : une barre courte au-dessus d'un corps de 240 px se lirait comme un
 * decor, et une barre qui deborderait de lui comme un element d'interface.
 */
export const BOSS_BAR_WIDTH_PX = BOSS_BODY_SIZE_PX;

/**
 * Epaisseur de la barre — **c'est ici que « petite » se joue**. Un vingtieme de
 * la longueur : un trait, pas un bandeau.
 *
 * Derivee de la longueur et non posee en pixels : le rapport de forme est ce
 * qu'on regle, et il reste le meme si le boss grandit.
 */
export const BOSS_BAR_HEIGHT_PX = BOSS_BAR_WIDTH_PX / 20;

/** Epaisseur du liseré sombre autour du remplissage, de part et d'autre. */
export const BOSS_BAR_BORDER_PX = BOSS_BAR_HEIGHT_PX / 4;

/**
 * De combien la barre monte au-dessus de la position du boss.
 *
 * ⚠️ **DERIVE DE LA TAILLE DESSINEE, jamais un nombre choisi.** Depuis la
 * tache 14 de l'etape 5a, `BODY_ANCHOR_Y` vaut 0,5 — le corps est CENTRE sur la
 * position, comme tout ce qui touche l'entite (`PROJECTILE_HIT_RADIUS`,
 * `CONTACT_RADIUS`, `ORB_PICKUP_RADIUS`). Le haut du corps est donc a une
 * demi-taille dessinee au-dessus, et la barre se pose juste au-dessus de lui.
 * C'est le symetrique exact de `MARK_RING_FOOT_OFFSET_PX`, qui descend d'autant
 * pour se poser sous les pieds.
 *
 * **L'approximation, dite plutot que cachee** — la meme que celle de l'anneau
 * de marque, et dans le bon sens : `spriteScale` ramene la plus GRANDE des deux
 * dimensions du contenu au diametre, donc la demi-taille majore la demi-hauteur
 * reelle des que la silhouette est plus large que haute. Le troll l'est
 * (290x225 px de contenu), et la barre flotte donc quelques dizaines de pixels
 * au-dessus de sa tete plutot que de mordre dedans. Une barre un peu haute
 * reste une barre ; une barre un peu basse masque le visage du boss.
 */
export const BOSS_BAR_OFFSET_PX = BOSS_BODY_SIZE_PX / 2 + BOSS_BAR_HEIGHT_PX;

/**
 * Cote de la texture carree, en pixels. Ce n'est PAS la taille a l'ecran : la
 * barre est un aplat, la texture ne sert qu'a porter des quads que `draw` met a
 * l'echelle.
 *
 * ⚠️ **Different de toutes les tailles affichees, et il faut que ca le reste.**
 * `MARK_RING_TEXTURE_DIAMETER` porte le meme avertissement pour l'avoir paye :
 * quand une constante de production vaut sa valeur d'affichage, l'echelle
 * calculee devient indistinguable de l'absence d'echelle et toute mutation y
 * survit. 16 ne vaut ni `BOSS_BAR_WIDTH_PX` (240) ni `BOSS_BAR_HEIGHT_PX` (12).
 */
export const BOSS_BAR_TEXTURE_SIZE = 16;

/** Socle : la meme famille terreuse sombre que le fond de la scene et les rochers. */
const BOSS_BAR_BASE_TINT = 0x241c17;

/** Remplissage : le rouge du sang, la seule couleur chaude saturee de l'ecran. */
const BOSS_BAR_FILL_TINT = 0xc23b22;

/** Le socle est un peu transparent — c'est du monde, pas de l'interface. */
const BOSS_BAR_BASE_ALPHA = 0.85;

/** Ou la barre se pose, et a quel remplissage — le resultat de `bossBarLayout`. */
export interface BossBarLayout {
  /** Abscisse du CENTRE de la barre, en coordonnees monde. */
  x: number;
  /** Ordonnee du centre de la barre, en coordonnees monde. */
  y: number;
  /** Part remplie, dans `[0, 1]`. */
  fraction: number;
}

/**
 * Part remplie de la barre, bornee a `[0, 1]`.
 *
 * ⚠️ **`maxHp <= 0` n'est pas une garde defensive de politesse** : un client qui
 * se connecte au tick ou le boss tombe a zero voit son PREMIER snapshot a 0 PV,
 * et `trackBoss` en fait alors un maximum nul (il n'a rien de mieux). Sans cette
 * branche, la barre vaudrait `NaN` de largeur — un quad de taille indefinie,
 * pas une barre vide.
 *
 * Le bornage a 1, lui, garde le cas ou le boss regagne de la vie au-dela de ce
 * que ce client a vu : ca n'arrive pas aujourd'hui, mais un remplissage a 130 %
 * deborderait de son socle sans qu'aucune erreur ne le signale.
 */
export function bossHpFraction(hp: number, maxHp: number): number {
  if (maxHp <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, hp / maxHp));
}

/**
 * Ou poser la barre, et a quel remplissage — ou `null` quand il n'y a rien a
 * dessiner. PURE, sans Pixi : c'est ce qui la rend testable sans canevas, meme
 * motif que `selectMarkedRings` et `sortByDepth`.
 *
 * **Les deux facons dont la barre disparait, et elles sont distinctes :**
 * - `boss === null` : aucun boss en jeu, la sentinelle du snapshot (tache 4) ;
 * - `slotOf(...) < 0` : le boss n'est plus dans la horde de CE client, parce
 *   qu'il a appris sa mort par `DEATHS` — comme pour tout le monde (§2 de la
 *   spec). Le snapshot peut encore le porter le temps d'un tick de decalage :
 *   c'est la horde qui fait foi pour la POSITION, donc c'est elle qui decide.
 *
 * Le cout est un `slotOf`, soit un balayage lineaire de la horde par image. A
 * 4 000 entites c'est du meme ordre que la passe de culling que
 * `HordeRenderer.draw` fait deja, et il n'y en a qu'un : la barre n'a pas de
 * reservoir a dimensionner ni de tri a faire.
 */
export function bossBarLayout(horde: Horde, boss: BossVitals | null): BossBarLayout | null {
  if (boss === null) {
    return null;
  }
  const slot = horde.slotOf(boss.id);
  if (slot < 0) {
    return null;
  }
  return {
    x: horde.x[slot] ?? 0,
    // AU-DESSUS du corps, pas sur la position : voir `BOSS_BAR_OFFSET_PX`.
    y: (horde.y[slot] ?? 0) - BOSS_BAR_OFFSET_PX,
    fraction: bossHpFraction(boss.hp, boss.maxHp),
  };
}

/**
 * Carre BLANC opaque, teinte ensuite par particule.
 *
 * Blanc, parce que `Particle.tint` MULTIPLIE — meme raison, mot pour mot, que
 * `makeRingTexture` et `makeZoneTexture` : en blanc, `tint` rend exactement la
 * couleur demandee.
 */
function makeBarTexture(size: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 1)';
  ctx.fillRect(0, 0, size, size);
  return Texture.from(canvas);
}

export class BossBarRenderer {
  readonly #container = new ParticleContainer({
    // Opaque, pas additif : contrairement aux zones et aux anneaux, cette barre
    // n'est pas un effet pose sur le sol — c'est une lecture, et elle doit
    // rester lisible par-dessus une melee deja saturee de rouge et d'orange.
    //
    // `vertex` : la largeur du remplissage change a chaque coup porte au boss.
    // `color` : FAUX — les deux teintes sont posees une fois a la construction
    // des deux particules et ne changent jamais.
    dynamicProperties: { position: true, vertex: true, color: false, rotation: false, uvs: false },
  });
  /**
   * Socle et remplissage, construits une fois : il n'y a jamais qu'un boss.
   *
   * ⚠️ **UN seul champ nullable, pas trois.** Une texture, un socle et un
   * remplissage separement nullables donnaient trois gardes qui se couvraient
   * l'une l'autre — le motif que ce depot a solde seize fois, plusieurs fois
   * par une suppression de code. Les deux quads naissent ensemble dans
   * `adoptTexture` ou n'existent pas : c'est une seule question, elle se pose
   * une seule fois.
   */
  #bar: { base: Particle; fill: Particle } | null = null;

  constructor() {
    this.#container.boundsArea = new Rectangle(
      -BOUNDS_MARGIN,
      -BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
    );
  }

  /** Expose pour le test, comme sur les autres calques. */
  get boundsArea(): Rectangle {
    return this.#container.boundsArea as Rectangle;
  }

  /** Vrai des que `load`/`adoptTexture` a cuit ses deux quads — ce que `Stage.layersLoaded` lit. */
  get loaded(): boolean {
    return this.#bar !== null;
  }

  load(): void {
    this.adoptTexture(makeBarTexture(BOSS_BAR_TEXTURE_SIZE));
  }

  /**
   * ⚠️ **Separe de `load` PARCE QUE `load` a besoin d'un canevas 2D** que node
   * ne fournit pas — exactement la raison de `adoptAtlas` et de `adoptTexture`
   * sur les autres calques. Sans ce point d'accroche, `draw` retournerait a son
   * premier `if (!texture)` dans toute la suite, et **tout son corps pourrait
   * etre retire sans qu'une assertion ne bouge** : c'est litteralement ce que
   * `ZoneRenderer.draw` a fait pendant 237 tests verts.
   */
  adoptTexture(texture: Texture): void {
    this.#bar = {
      base: new Particle({
        texture,
        anchorX: 0.5,
        anchorY: 0.5,
        tint: BOSS_BAR_BASE_TINT,
        alpha: BOSS_BAR_BASE_ALPHA,
      }),
      // Ancre a GAUCHE : le remplissage se vide vers la droite en retrecissant,
      // il ne se contracte pas vers son centre.
      fill: new Particle({ texture, anchorX: 0, anchorY: 0.5, tint: BOSS_BAR_FILL_TINT }),
    };
  }

  attach(parent: Container): void {
    parent.addChild(this.#container);
  }

  /**
   * `boss` est ce que le client sait du boss vivant (`GameClient.boss`), `horde`
   * ce qu'il en simule. Les deux sont necessaires et aucune ne suffit : le
   * snapshot porte les PV mais pas la position, la horde porte la position mais
   * jamais les PV (elle les met a leur valeur d'archetype, sans l'echelle de
   * palier que seul le serveur applique — voir `Horde.hp`).
   */
  draw(horde: Horde, boss: BossVitals | null): void {
    const bar = this.#bar;
    const children = this.#container.particleChildren;
    children.length = 0;

    const layout = bossBarLayout(horde, boss);
    if (bar && layout) {
      const { base, fill } = bar;
      base.x = layout.x;
      base.y = layout.y;
      base.scaleX = (BOSS_BAR_WIDTH_PX + 2 * BOSS_BAR_BORDER_PX) / BOSS_BAR_TEXTURE_SIZE;
      base.scaleY = (BOSS_BAR_HEIGHT_PX + 2 * BOSS_BAR_BORDER_PX) / BOSS_BAR_TEXTURE_SIZE;

      // Le remplissage part du bord GAUCHE du socle, d'ou la demi-largeur
      // soustraite : son ancre est a gauche, celle du socle au centre.
      fill.x = layout.x - BOSS_BAR_WIDTH_PX / 2;
      fill.y = layout.y;
      fill.scaleX = (BOSS_BAR_WIDTH_PX * layout.fraction) / BOSS_BAR_TEXTURE_SIZE;
      fill.scaleY = BOSS_BAR_HEIGHT_PX / BOSS_BAR_TEXTURE_SIZE;

      children.push(base, fill);
    }

    this.#container.update();
  }

  destroy(): void {
    this.#container.destroy();
  }
}
