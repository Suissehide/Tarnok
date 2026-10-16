import { MAP_SIZE, ZONE_RADIUS } from '@shared/constants';
import { ELEMENT, ELEMENTS, elementOf } from '@shared/elements';
import { zoneElement, zoneReaction } from '@shared/protocol';
import { type ZoneShape, zoneLifetimeTicks, zoneRadius, zoneShape } from '@shared/reactions';
import type { ZoneField } from '@shared/zones';
import { type Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

/**
 * Rendu des zones au sol : un grand quad teinte, additif, quelques dizaines
 * de quads.
 *
 * Un `ParticleContainer` de plus, meme discipline que les trois de
 * `projectile-renderer.ts` : bornes explicites, reservoir de `Particle`
 * reutilise, aucune allocation en regime etabli.
 *
 * ⚠️ **C'est le calque le plus BAS des entites** (voir l'ordre d'attache dans
 * `Stage.init`) : une zone est du terrain teinte, pas un effet qui passe
 * devant les monstres qu'elle couvre.
 *
 * ⚠️ **Le quad teinte a un BORD.** Un aplat diffus ne
 * dit ni ou il commence ni ou il finit, et la frontiere d'une zone est une
 * **regle de jeu** : elle decide qui est marque, qui est ralenti, et ou deux
 * zones reagissent. Le disque garde exactement le rayon de la regle
 * (`zoneScale`, derive de `ZONE_RADIUS`) et le rend lisible.
 *
 * ⚠️ **Une zone reste un CERCLE en coordonnees monde**, contrairement a
 * l'anneau de marque, aplati en ellipse. La difference
 * n'est pas esthetique : le rayon de l'anneau ne decide de rien, celui de la
 * zone decide de tout, et il est compare en distance EUCLIDIENNE des deux
 * cotes du fil (`markInZones`, `reactions`). Une ellipse mentirait sur la
 * regle. C'est la camera seule qui l'ecrase de `VERTICAL_SQUASH`, uniformement
 * avec le reste du monde.
 *
 * ⚠️ **Une SILHOUETTE par element, pas seulement une teinte.** Deux teintes
 * voisines (Givre et Vif-argent, Braise et Foudre) se confondent des qu'on
 * regarde la horde plutot que le sol. Chaque element a son bord (`lookOf`), son animation (rotation, pulsation, scintillement) et la
 * zone suit sa vie (`zoneSpawnScale`, `zoneFade`) ; une zone de REACTION a sa
 * propre case, a double contour et lavis plus dense. Tout reste dans le MEME
 * `ParticleContainer` : l'atlas est un seul canevas, une case par couple
 * (element, reaction ou non), et la particule change de case par `uvs`.
 */

/** Marge des bornes explicites, meme raisonnement que `HordeRenderer.BOUNDS_MARGIN`. */
const BOUNDS_MARGIN = 256;

/**
 * Cote de la texture de zone, en pixels.
 *
 * Ce n'est PAS la taille a l'ecran : c'est la finesse du disque dessine, que
 * `zoneScale` ramene ensuite au vrai `ZONE_RADIUS`. Une puissance de deux,
 * assez grande pour qu'un disque de 140 px de diametre monde ne soit pas
 * pixelise a l'agrandissement.
 */
export const ZONE_TEXTURE_DIAMETER = 128;

/**
 * Epaisseur du lisere, en fraction du cote de la case : ~0,09 du rayon.
 */
const ZONE_RIM_WIDTH = 0.045;

/**
 * Opacite du BORD d'une zone. **Constante, et c'est un choix**, pas un oubli.
 *
 * ⚠️ **L'etat persistant est DISCRET.** Une zone vit
 * `ZONE_LIFETIME_TICKS` (3 s) et plusieurs se recouvrent des qu'un joueur
 * arrose : a pleine opacite, quelques dizaines de disques additifs suffisent a
 * blanchir l'ecran et plus rien ne se lit — ni la horde, ni le flash de
 * reaction, qui est precisement ce que le budget VFX doit rendre visible.
 *
 * ⚠️ **Le budget d'encre est la surface ponderee par l'opacite.** Le profil
 * — un lavis mince a `ZONE_FILL_RATIO` et un lisere au bord — a une opacite
 * moyenne de 0,44 fois cette constante : la valeur peut donc etre haute au
 * bord sans blanchir l'ecran plus vite qu'un aplat plus pale.
 *
 * ⚠️ **Le fondu de fin de vie (`zoneFade`) a un PLANCHER, et c'est ce qui le
 * rend admissible.** Un fondu jusqu'a zero ferait une SECONDE garde
 * d'expiration a cote de `ZoneField.aliveAt` : les deux se couvriraient l'une
 * l'autre, et supprimer la bonne ne ferait rougir aucun test. Arrete a
 * `ZONE_FADE_FLOOR`, il annonce la fin sans jamais la decider : une seule
 * chose decide qu'une zone se dessine — `aliveAt`, dans `selectZones`.
 */
export const ZONE_ALPHA = 0.34;

/**
 * Lavis d'une zone de REACTION, en fraction de l'opacite du bord : plus dense
 * que `ZONE_FILL_RATIO`, c'est l'« intensite » qui la distingue d'un champ
 * d'element simple, avec le double contour. Le budget d'encre tient : le banc
 * `zones` compte 3 a 5 zones vivantes, pas des dizaines.
 */
export const ZONE_REACTION_FILL_RATIO = 0.48;

/** Duree de l'apparition, en ticks : la zone se pose de `ZONE_SPAWN_OVERSHOOT` plus large et se resserre. */
export const ZONE_SPAWN_TICKS = 6;

/**
 * Surplus d'echelle a la pose. **Vers l'exterieur, jamais vers l'interieur** :
 * une zone qui naitrait petite mentirait 0,2 s sur la regle dans le sens
 * dangereux (le joueur croirait un ennemi hors de portee). Plus large, elle
 * dit « ici, maintenant » et retombe sur le vrai rayon.
 */
export const ZONE_SPAWN_OVERSHOOT = 0.2;

/** Fraction finale de la vie pendant laquelle la zone s'estompe. */
export const ZONE_FADE_SPAN = 0.25;

/** Opacite residuelle au dernier tick vivant, en fraction de `ZONE_ALPHA`. Voir la note sur `ZONE_ALPHA`. */
export const ZONE_FADE_FLOOR = 0.35;

/**
 * Bord interieur le plus creux qu'une silhouette ait le droit de dessiner, en
 * fraction du rayon. Les flammes, les dents et les cotes de l'hexagone ondulent
 * ENTRE ce creux et le rayon de la regle : l'oeil lit toujours un bord a moins
 * de 15 % du vrai, et l'enveloppe exterieure tombe dessus exactement.
 */
export const RIM_MIN = 0.85;

/** Comment le bord d'une silhouette est trace. */
export type RimStroke = 'plein' | 'pointille' | 'anneaux';

/**
 * L'identite visuelle d'un element : sa silhouette ET son animation. Partagee
 * par les zones et les anneaux de marque (`mark-renderer.ts`) — un element doit
 * se reconnaitre de la meme facon au sol et sous les pieds.
 */
export interface ElementLook {
  /** Rayon du bord a l'angle `theta`, en fraction du rayon, dans [`RIM_MIN`, 1]. */
  readonly rim: (theta: number) => number;
  readonly stroke: RimStroke;
  /** Rotation, en radians par seconde (zones seulement — voir `mark-renderer.ts`). */
  readonly spin: number;
  /** Respiration de l'echelle : frequence (Hz) et amplitude (fraction). */
  readonly pulseHz: number;
  readonly pulseAmp: number;
  /** Scintillement de l'opacite : amplitude (fraction retiree au pire) et frequence (Hz). */
  readonly flicker: number;
  readonly flickerHz: number;
}

/** Amplitude de pulsation la plus forte de la table : borne ce que le bord deborde du rayon de la regle. */
export const MAX_PULSE_AMP = 0.04;

const TAU = Math.PI * 2;
const SIXTH = Math.PI / 3;

const NEUTRE_LOOK: ElementLook = {
  rim: () => 1,
  stroke: 'plein',
  spin: 0,
  pulseHz: 0,
  pulseAmp: 0,
  flicker: 0,
  flickerHz: 0,
};

/**
 * La table des silhouettes, une ligne par element.
 *
 * - **Braise** : neuf langues de flamme (`|sin|^3` : pointes etroites, creux
 *   larges), qui tournent et vacillent.
 * - **Givre** : un hexagone de cristal, sommets sur le rayon, qui tourne
 *   lentement et ne tremble pas — le froid est immobile.
 * - **Foudre** : une couronne crenelee en dents de scie qui crepite vite et
 *   tourne a rebours.
 * - **Poix** : une flaque irreguliere, lente, qui respire profondement.
 * - **Chaux** : un nuage pointille de bouffees, qui derive.
 * - **Vif-argent** : des anneaux concentriques ouverts, qui tournent vite et
 *   pulsent — la seule silhouette dont la rotation se voit sur un cercle,
 *   grace aux breches.
 */
const LOOKS: Record<number, ElementLook> = {
  [ELEMENT.NEUTRE]: NEUTRE_LOOK,
  [ELEMENT.BRAISE]: {
    rim: (t) => RIM_MIN + (1 - RIM_MIN) * Math.abs(Math.sin(4.5 * t)) ** 3,
    stroke: 'plein',
    spin: 0.6,
    pulseHz: 2.2,
    pulseAmp: 0.03,
    flicker: 0.25,
    flickerHz: 7,
  },
  [ELEMENT.GIVRE]: {
    rim: (t) => Math.cos(Math.PI / 6) / Math.cos((((t % SIXTH) + SIXTH) % SIXTH) - Math.PI / 6),
    stroke: 'plein',
    spin: 0.25,
    pulseHz: 0,
    pulseAmp: 0,
    flicker: 0.08,
    flickerHz: 0.5,
  },
  [ELEMENT.FOUDRE]: {
    rim: (t) => {
      const x = (t / TAU) * 14;
      return RIM_MIN + (1 - RIM_MIN) * (1 - Math.abs(2 * (x - Math.floor(x)) - 1));
    },
    stroke: 'plein',
    spin: -1.2,
    pulseHz: 5,
    pulseAmp: 0.015,
    flicker: 0.5,
    flickerHz: 11,
  },
  [ELEMENT.POIX]: {
    rim: (t) => 0.925 + 0.045 * Math.sin(3 * t + 1.3) + 0.03 * Math.sin(5 * t + 0.4),
    stroke: 'plein',
    spin: 0.08,
    pulseHz: 0.4,
    pulseAmp: MAX_PULSE_AMP,
    flicker: 0,
    flickerHz: 0,
  },
  [ELEMENT.CHAUX]: {
    rim: () => 1,
    stroke: 'pointille',
    spin: 0.35,
    pulseHz: 0.8,
    pulseAmp: 0.02,
    flicker: 0.12,
    flickerHz: 1.2,
  },
  [ELEMENT.VIF_ARGENT]: {
    rim: () => 1,
    stroke: 'anneaux',
    spin: 1.8,
    pulseHz: 1.6,
    pulseAmp: 0.035,
    flicker: 0,
    flickerHz: 0,
  },
};

/**
 * La silhouette d'un element. Un element sans ligne retombe sur celle du
 * Neutre — et le test « deux elements, deux silhouettes » rougit alors, ce qui
 * est exactement le rappel voulu quand une ligne s'ajoute a `ELEMENT_DEFS`.
 */
export function lookOf(element: number): ElementLook {
  return LOOKS[element] ?? NEUTRE_LOOK;
}

/**
 * Facteur d'echelle de la respiration, `1` au repos. `seed` decale la phase
 * par creneau pour que cent anneaux ne battent pas a l'unisson.
 */
export function lookPulse(look: ElementLook, seconds: number, seed: number): number {
  return 1 + look.pulseAmp * Math.sin(TAU * look.pulseHz * seconds + seed);
}

/**
 * Facteur d'opacite du scintillement, dans [1 - `flicker`, 1]. Deux sinus de
 * frequences incommensurables : un crepitement irregulier, pas un clignotant.
 * Au carre pour rester a 1 quand les deux s'annulent (t = 0, seed = 0).
 */
export function lookFlicker(look: ElementLook, seconds: number, seed: number): number {
  const w = TAU * look.flickerHz * seconds;
  const c = 0.5 * (Math.sin(w + seed) + Math.sin(1.73 * w + 2 * seed));
  return 1 - look.flicker * c * c;
}

/** Decalage de phase d'un creneau : l'angle d'or, qui ne se repete jamais. */
export function slotSeed(slot: number): number {
  return slot * 2.399963;
}

/** Echelle relative a l'apparition (voir `ZONE_SPAWN_OVERSHOOT`), `1` une fois posee. */
export function zoneSpawnScale(age: number): number {
  if (age >= ZONE_SPAWN_TICKS) {
    return 1;
  }
  return 1 + ZONE_SPAWN_OVERSHOOT * (1 - Math.max(0, age) / ZONE_SPAWN_TICKS);
}

/** Opacite relative en fin de vie : `1`, puis une rampe jusqu'a `ZONE_FADE_FLOOR` au dernier tick. */
export function zoneFade(age: number, lifetime: number): number {
  const span = lifetime * ZONE_FADE_SPAN;
  const start = lifetime - span;
  if (age <= start || span <= 0) {
    return 1;
  }
  const f = Math.min(1, (age - start) / span);
  return 1 - (1 - ZONE_FADE_FLOOR) * f;
}

/** Points du trace d'une silhouette. Assez pour que les 14 dents de la Foudre restent nettes. */
const RIM_SEGMENTS = 112;

/**
 * Trace le bord d'une silhouette, centre en (`cx`, `cy`), le rayon `1` de
 * `look.rim` valant `radius` pixels. Partage avec `mark-renderer.ts`.
 *
 * N'emploie que `beginPath`/`moveTo`/`lineTo`/`closePath`/`arc`/`fill`/`stroke`
 * — ce que le bouchon de `stage.test.ts` fournit.
 */
export function strokeLook(
  ctx: CanvasRenderingContext2D,
  look: ElementLook,
  cx: number,
  cy: number,
  radius: number,
  lineWidth: number,
  alpha: number,
): void {
  const color = `rgba(255, 255, 255, ${alpha})`;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  if (look.stroke === 'pointille') {
    const puffs = 14;
    for (let k = 0; k < puffs; k++) {
      const t = (TAU * k) / puffs;
      ctx.beginPath();
      ctx.arc(cx + radius * Math.cos(t), cy + radius * Math.sin(t), lineWidth * 0.85, 0, TAU);
      ctx.fill();
    }
    return;
  }
  if (look.stroke === 'anneaux') {
    // Trois arcs ouverts dehors, deux dedans decales : les breches sont ce qui
    // fait voir la rotation.
    for (const [ring, arcs, width, offset] of [
      [1, 3, 1, 0],
      [0.62, 2, 0.6, 0.9],
    ] as const) {
      const span = TAU / arcs;
      for (let k = 0; k < arcs; k++) {
        const a0 = offset + k * span;
        ctx.lineWidth = lineWidth * width;
        ctx.beginPath();
        ctx.arc(cx, cy, radius * ring, a0, a0 + span * 0.78);
        ctx.stroke();
      }
    }
    return;
  }
  tracePath(ctx, look, cx, cy, radius);
  ctx.stroke();
}

function tracePath(
  ctx: CanvasRenderingContext2D,
  look: ElementLook,
  cx: number,
  cy: number,
  radius: number,
): void {
  ctx.beginPath();
  for (let k = 0; k <= RIM_SEGMENTS; k++) {
    const t = (TAU * k) / RIM_SEGMENTS;
    const r = radius * look.rim(t);
    const x = cx + r * Math.cos(t);
    const y = cy + r * Math.sin(t);
    if (k === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
}

/**
 * L'identite visuelle des quatre familles de champ de REACTION.
 *
 * ⚠️ **Indexees par la FAMILLE, pas par la reaction ni par l'element.** La
 * teinte d'une particule dit deja l'element (elle est posee par `draw`, et
 * l'atlas reste blanc) : la forme dit de quelle REACTION vient le champ.
 * Quatorze silhouettes auraient voulu dire quatorze traces a tenir pour
 * une lecture que le joueur fait au sol en un quart de seconde ; quatre
 * familles — rond, lobes, etoile, fracture — suffisent a separer ce qui
 * s'etale de ce qui eclate.
 *
 * ⚠️ **Le bord reste dans `[RIM_MIN, 1]`**, comme pour les elements : la ou
 * l'encre s'arrete, la regle s'arrete. Une silhouette qui
 * deborderait promettrait du terrain que la zone ne couvre pas.
 */
const SHAPE_LOOKS: Record<ZoneShape, ElementLook> = {
  /** Le repli : un disque franc, qui ne dit rien de plus que sa teinte. */
  rond: {
    rim: () => 1,
    stroke: 'plein',
    spin: 0.5,
    pulseHz: 1,
    pulseAmp: 0.03,
    flicker: 0.06,
    flickerHz: 1.1,
  },
  /** Trois bosses molles : ce qui s'etale et englue. */
  lobes: {
    rim: (t) => 1 - 0.1 * (1 - Math.cos(3 * t)) * 0.5,
    stroke: 'plein',
    spin: 0.35,
    pulseHz: 0.7,
    pulseAmp: 0.05,
    flicker: 0.08,
    flickerHz: 0.8,
  },
  /** Cinq pointes : ce qui eclate d'un coup. */
  etoile: {
    rim: (t) => 1 - 0.14 * (1 - Math.cos(5 * t)) * 0.5,
    stroke: 'pointille',
    spin: 1.1,
    pulseHz: 2.2,
    pulseAmp: 0.045,
    flicker: 0.16,
    flickerHz: 2.4,
  },
  /** Un bord brise : ce qui fracture et crepite. */
  fracture: {
    rim: (t) => 1 - 0.12 * ((Math.sin(7 * t) + 1) * 0.5) ** 3,
    stroke: 'anneaux',
    spin: -1.4,
    pulseHz: 3.1,
    pulseAmp: 0.025,
    flicker: 0.2,
    flickerHz: 3.3,
  },
};

/** L'ordre des cases de reaction dans l'atlas — celui des cles de `SHAPE_LOOKS`. */
export const ZONE_SHAPES = Object.keys(SHAPE_LOOKS) as ZoneShape[];

/** La silhouette d'une famille de reaction. */
export function shapeLook(shape: ZoneShape): ElementLook {
  return SHAPE_LOOKS[shape] ?? SHAPE_LOOKS.rond;
}

/**
 * L'apparence d'une zone : celle de sa REACTION si elle en porte une, celle de
 * son element sinon.
 *
 * ⚠️ **La teinte, elle, reste toujours celle de l'element** (`draw`) : la
 * forme dit l'evenement, la couleur dit la matiere — le meme partage que
 * `Weapon.look` entre la silhouette d'un projectile et sa teinte.
 */
export function zoneLook(kind: number): ElementLook {
  return zoneReaction(kind) !== 0 ? shapeLook(zoneShape(kind)) : lookOf(zoneElement(kind));
}

/**
 * Nombre de cases de l'atlas : une rangee d'elements simples, une de
 * silhouettes de reaction.
 */
export const ZONE_CELL_COUNT = ELEMENTS.length + ZONE_SHAPES.length;

/**
 * La case d'une zone : l'element en colonne sur la rangee du haut, la FAMILLE
 * de reaction sur celle du bas.
 *
 * ⚠️ **La rangee du bas n'est pas indexee par element** : deux champs de
 * reaction d'un meme element se ressembleraient trait pour trait. C'est la
 * forme qui les separe, et la teinte qui les relie a leur element.
 */
export function zoneCell(kind: number): number {
  if (zoneReaction(kind) === 0) {
    return zoneElement(kind);
  }
  const rang = ZONE_SHAPES.indexOf(zoneShape(kind));
  return ELEMENTS.length + (rang < 0 ? 0 : rang);
}

/**
 * Opacite de l'INTERIEUR de la zone, en fraction de celle du bord.
 *
 * Franchement en dessous de 1 : c'est ce qui fait qu'on lit un BORD et non un
 * aplat. Un disque uniformement diffus ne dit ni ou il commence ni ou il finit,
 * et sa frontiere est une **regle de jeu** — c'est elle qui decide qui est
 * marque (`markInZones`), qui est ralenti (`Horde#computeSlow`) et ou deux
 * zones reagissent.
 */
export const ZONE_FILL_RATIO = 0.32;

/**
 * Marge de culling : un demi-diametre de zone, pour qu'un disque dont le
 * centre vient de sortir du cadre continue de teindre le bord de l'ecran au
 * lieu de disparaitre d'un coup.
 */
const CULL_MARGIN = ZONE_RADIUS;

/**
 * Ce que `selectZones` a besoin de connaitre de la vue — structurellement un
 * `Rectangle` de Pixi, ecrit comme une interface pour que le test n'ait pas a
 * en construire un.
 */
export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Facteur d'echelle d'une particule de zone : la texture dessinee doit couvrir
 * EXACTEMENT `2 x ZONE_RADIUS` pixels monde.
 *
 * ⚠️ **Derive de `ZONE_RADIUS`, jamais reglee a la main**, comme
 * `spriteScale` : un sprite dessine a une taille choisie a
 * cote d'un rayon choisi a cote finit par mentir sur ce qu'il represente. Ici
 * le mensonge serait pire qu'esthetique — le disque dit au joueur ou ses
 * ennemis sont marques et ralentis, et c'est `ZONE_RADIUS` qui le decide
 * reellement (`markInZones`, `Horde#computeSlow`).
 */
export function zoneScale(textureDiameterPx: number, radiusPx = ZONE_RADIUS): number {
  if (textureDiameterPx <= 0) {
    return 1;
  }
  return (2 * radiusPx) / textureDiameterPx;
}

/**
 * Choisit les zones a dessiner au tick `tick` : celles qui sont VIVANTES et
 * dans le cadre. Ecrit leurs creneaux dans `out` et rend leur nombre — pure,
 * sans allocation, testable sans Pixi ni canevas, meme motif que `sortByDepth`
 * dans `horde-renderer.ts`.
 *
 * ⚠️ **`aliveAt`, et surtout pas `zones.count`.** Le client garde
 * volontairement ses zones mortes `ROLLBACK_DEPTH_TICKS` ticks de plus dans le
 * tableau, pour pouvoir rejouer un tick ou elles vivaient encore (voir
 * `GameClient#advanceHorde` et la doc de `ZoneField.aliveAt`). Dessiner tout ce
 * que le tableau contient laisserait donc chaque zone visible ~0,27 s de trop,
 * partout, en permanence — et personne ne saurait dire pourquoi les disques
 * du client survivent a ceux du serveur.
 */
export function selectZones(
  zones: ZoneField,
  tick: number,
  view: ViewBounds,
  out: Int32Array,
): number {
  const minX = view.x - CULL_MARGIN;
  const maxX = view.x + view.width + CULL_MARGIN;
  const minY = view.y - CULL_MARGIN;
  const maxY = view.y + view.height + CULL_MARGIN;

  let count = 0;
  for (let i = 0; i < zones.count && count < out.length; i++) {
    if (!zones.aliveAt(i, tick)) {
      continue;
    }
    const x = zones.x[i] ?? 0;
    const y = zones.y[i] ?? 0;
    if (x < minX || x > maxX || y < minY || y > maxY) {
      continue;
    }
    out[count] = i;
    count++;
  }
  return count;
}

/**
 * Atlas BLANC des silhouettes de zone, cuit une fois puis teinte par particule :
 * une colonne par element, la rangee du haut pour les zones d'element simple,
 * celle du bas pour les zones de REACTION.
 *
 * ⚠️ **Blanc, parce que `Particle.tint` MULTIPLIE** : en blanc, `tint` rend
 * exactement `Element.tint`, sans qu'un element soit plus fidele qu'un autre.
 *
 * ⚠️ **Le bord dit toujours la verite.** Dans chaque case, le trace
 * est place pour que le bord EXTERIEUR de l'encre — rayon de la silhouette plus
 * demi-epaisseur du trait — tombe sur le bord de la case, que `zoneScale` ramene
 * a `ZONE_RADIUS`. Les silhouettes ondulent vers l'interieur (`RIM_MIN`), jamais
 * au-dela : la ou l'encre s'arrete, la regle s'arrete.
 *
 * Une case de reaction ajoute un second contour a 0,8 du premier et un lavis
 * plus dense (`ZONE_REACTION_FILL_RATIO`) : on lit « champ de reaction » avant
 * meme de reconnaitre l'element.
 */
function makeZoneAtlas(cell: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = cell * ELEMENTS.length;
  canvas.height = cell * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  const half = cell / 2;
  const lineWidth = cell * ZONE_RIM_WIDTH;
  const radius = half - lineWidth / 2;
  // Rangee du haut : une case par element (zones sans reaction). Rangee du
  // bas : une case par FAMILLE de reaction — voir `zoneCell`.
  const rangees: readonly { looks: readonly ElementLook[]; reaction: boolean }[] = [
    { looks: ELEMENTS.map((e) => lookOf(e.id)), reaction: false },
    { looks: ZONE_SHAPES.map((f) => shapeLook(f)), reaction: true },
  ];
  for (let row = 0; row < rangees.length; row++) {
    const rangee = rangees[row];
    if (!rangee) {
      continue;
    }
    const reaction = rangee.reaction;
    for (let col = 0; col < rangee.looks.length; col++) {
      const look = rangee.looks[col] as ElementLook;
      const cx = col * cell + half;
      const cy = row * cell + half;
      ctx.fillStyle = `rgba(255, 255, 255, ${reaction ? ZONE_REACTION_FILL_RATIO : ZONE_FILL_RATIO})`;
      tracePath(ctx, look, cx, cy, radius);
      ctx.fill();
      strokeLook(ctx, look, cx, cy, radius, lineWidth, 1);
      if (reaction) {
        strokeLook(ctx, look, cx, cy, radius * 0.8, lineWidth * 0.55, 0.8);
      }
    }
  }
  return Texture.from(canvas);
}

export class ZoneRenderer {
  readonly #container = new ParticleContainer({
    // ⚠️ **Additif.** Deux zones qui se recouvrent s'ADDITIONNENT — et leur
    // recouvrement est precisement ce qui declenche une reaction. En melange normal, la seconde masquerait la
    // premiere et la frontiere commune, la seule chose qu'il faille voir,
    // serait invisible.
    blendMode: 'add',
    // Tout bouge a chaque image : `vertex`
    // (l'echelle respire), `rotation`, `color` (scintillement et fondu), et
    // `uvs` parce que le reservoir est REUTILISE — le creneau 3 peut porter la
    // case de Braise a cette image et celle de Givre a la suivante. Quelques
    // dizaines de quads : le cout de l'envoi est sans objet.
    dynamicProperties: { position: true, color: true, rotation: true, uvs: true, vertex: true },
  });
  readonly #pool: Particle[] = [];
  /** Tampon des creneaux retenus par `selectZones`, dimensionne une fois. Voir `#ensureBuffers`. */
  #selected = new Int32Array(0);
  /**
   * Les cases de l'atlas, indexees par `zoneCell`. **UN tableau, jamais une
   * texture nullable de plus** — meme raison que `OrbRenderer#cells`.
   */
  #cells: Texture[] = [];

  constructor() {
    this.#container.boundsArea = new Rectangle(
      -BOUNDS_MARGIN,
      -BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
      MAP_SIZE + 2 * BOUNDS_MARGIN,
    );
  }

  /** Expose pour le test, comme les trois renderers de `projectile-renderer.ts`. */
  get boundsArea(): Rectangle {
    return this.#container.boundsArea as Rectangle;
  }

  /** Expose pour le test : « additif » est une exigence, pas un detail. */
  get blendMode(): string {
    return this.#container.blendMode;
  }

  attach(parent: Container): void {
    parent.addChild(this.#container);
  }

  /**
   * Vrai des que `load` a pose sa texture. Expose pour le test, comme
   * `boundsArea` : c'est ce qui permet a `stage.test.ts` de verifier que
   * `Stage.composeWorld` charge CHAQUE calque.
   */
  get loaded(): boolean {
    return this.#cells.length === ZONE_CELL_COUNT;
  }

  /** Texture procedurale — hors du constructeur, meme raison que les autres renderers. */
  load(): void {
    this.adoptTexture(makeZoneAtlas(ZONE_TEXTURE_DIAMETER));
  }

  /**
   * Rend le calque capable de dessiner a partir d'une texture deja cuite.
   *
   * ⚠️ **Sans ce point d'accroche, TOUT le corps de `draw` est hors de portee
   * des tests** (tester `zoneScale` ne prouve pas que `draw` s'en sert) :
   * `load()` cuit sa texture sur un canevas 2D que l'environnement de test ne
   * fournit pas, donc `draw` retournerait a son premier `if (!texture)`.
   */
  adoptTexture(atlas: Texture): void {
    const cell = ZONE_TEXTURE_DIAMETER;
    this.#cells = Array.from(
      { length: ZONE_CELL_COUNT },
      (_, n) =>
        new Texture({
          source: atlas.source,
          // Les deux rangees n'ont pas la meme largeur (sept elements, quatre
          // familles) : la colonne se derive du rang DANS sa rangee, jamais
          // d'un modulo sur une largeur commune qui n'existe pas.
          frame: new Rectangle(
            (n < ELEMENTS.length ? n : n - ELEMENTS.length) * cell,
            (n < ELEMENTS.length ? 0 : 1) * cell,
            cell,
            cell,
          ),
        }),
    );
  }

  /**
   * `tick` est le tick de horde du client (`GameClient.hordeTick`) : c'est lui
   * qui decide quelles zones sont encore vivantes, avec exactement le meme
   * predicat que le serveur (l'expiration est DERIVEE, jamais annoncee),
   * et quel age elles ont (apparition, fondu).
   *
   * `timeMs` est l'horloge MURALE, et ne sert qu'a l'animation (rotation,
   * respiration, scintillement) : au tick, a 30 Hz, une rotation saccaderait.
   * Elle ne decide de rien — meme partage que `HordeRenderer.draw`.
   */
  draw(zones: ZoneField, tick: number, view: ViewBounds, timeMs: number): void {
    if (!this.loaded) {
      return;
    }
    this.#ensureBuffers(zones.capacity);

    const count = selectZones(zones, tick, view, this.#selected);
    const seconds = timeMs / 1000;

    const children = this.#container.particleChildren;
    children.length = 0;
    for (let n = 0; n < count; n++) {
      const i = this.#selected[n] ?? 0;
      const particle = this.#pool[n];
      if (!particle) {
        break;
      }
      const kind = zones.kind[i] ?? 0;
      const element = zoneElement(kind);
      // La silhouette ET l'animation : celles de la REACTION si elle en porte
      // une, celles de l'element sinon. Voir `zoneLook`.
      const look = zoneLook(kind);
      // ⚠️ **Aucun facteur sur les reactions** : leur rotation vient de la
      // silhouette de leur FAMILLE (`SHAPE_LOOKS`) — une fracture tourne a
      // l'envers, une etoile tourne vite.
      const spin = look.spin;
      const age = tick - (zones.bornTick[i] ?? 0);
      const seed = slotSeed(i);

      particle.texture = this.#cells[zoneCell(kind)] ?? particle.texture;
      particle.x = zones.x[i] ?? 0;
      particle.y = zones.y[i] ?? 0;
      // ⚠️ **L'echelle suit le rayon de CETTE zone** : toutes ne font pas
      // `ZONE_RADIUS`, et le disque dessine doit dire ce que la regle couvre.
      //
      // Un seul facteur pour les deux axes : la zone reste un CERCLE en monde.
      const s =
        zoneScale(ZONE_TEXTURE_DIAMETER, zoneRadius(kind)) *
        zoneSpawnScale(age) *
        lookPulse(look, seconds, seed);
      particle.scaleX = s;
      particle.scaleY = s;
      particle.rotation = seed + spin * seconds;
      // Teinte de l'element, sans jamais tester lequel : `ELEMENT.NEUTRE`
      // porte 0xffffff, l'identite du produit (voir `shared/elements.ts`).
      particle.tint = elementOf(element).tint;
      particle.alpha =
        ZONE_ALPHA * zoneFade(age, zoneLifetimeTicks(kind)) * lookFlicker(look, seconds, seed);
      children.push(particle);
    }
    this.#container.update();
  }

  destroy(): void {
    this.#container.destroy();
  }

  /**
   * Dimensionne le tampon de selection et le reservoir sur la capacite du
   * champ de zones (`ZONE_CAPACITY`) : au pire cas toutes les zones sont
   * vivantes et visibles a la fois. Ne grandit jamais deux fois — la capacite
   * est une constante partagee.
   */
  #ensureBuffers(capacity: number): void {
    if (this.#selected.length < capacity) {
      this.#selected = new Int32Array(capacity);
    }
    const texture = this.#cells[0] as Texture;
    while (this.#pool.length < capacity) {
      this.#pool.push(new Particle({ texture, anchorX: 0.5, anchorY: 0.5 }));
    }
  }
}
