// @vitest-environment jsdom
import { MAP_SIZE, MAX_ENTITIES, ORB_DROP_ONE_IN, ORB_PICKUP_RADIUS } from '@shared/constants';
import {
  Container,
  type Particle,
  type ParticleContainer,
  Rectangle,
  Texture,
  TextureSource,
} from 'pixi.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { DerivedOrbs } from '../net/client';
import {
  type MagnetPoint,
  ORB_ALPHA_MIN,
  ORB_DIAMETER_PX,
  ORB_MAGNET_RADIUS,
  ORB_TEXTURE_DIAMETER,
  ORB_TINT,
  OrbRenderer,
  orbPullFraction,
} from './orb-renderer';

/** Une vue qui couvre toute la carte : le culling ne doit alors rien retirer. */
const TOUTE_LA_CARTE = new Rectangle(0, 0, MAP_SIZE, MAP_SIZE);

/**
 * Une identite dont la mort laisse VRAIMENT un orbe.
 *
 * ⚠️ Depuis la tache 17, `DerivedOrbs.spawn` filtre par `dropsOrb` : un decor
 * qui pose `1` ou `2` ne poserait rien du tout, et chaque assertion de ce
 * fichier compterait zero particule sans rien prouver. Derivee de la constante,
 * jamais recopiee.
 */
const avecOrbe = (n: number): number => n * ORB_DROP_ONE_IN;

/**
 * Étape 5a, tache 17 : *« l'xp plus nette aussi, legerement attiree par le
 * joueur s'il passe a cote »*.
 *
 * ⚠️ **Tout le corps de `OrbRenderer.draw` etait garde par RIEN avant ce
 * fichier**, et quatre mutations appliquees AVANT d'ecrire une ligne de test
 * l'ont montre — `particle.scaleX = 1`, `const pull = 0`, et les deux gardes de
 * chute — toutes vertes a 280 tests. C'est le motif des dix-sept assertions
 * creuses du depot, et la lecon de la tache 16 sur `ZoneRenderer` : `load()`
 * cuit sa texture sur un canevas 2D absent de node, donc `draw` retournait a son
 * premier `if (!texture)` et rien de ce qu'elle fait n'etait atteignable.
 * `adoptTexture` est le point d'accroche qui referme ça.
 */
describe('orbPullFraction — l aimantation est cosmetique, et l ecart est NUL la ou ça compte', () => {
  it('ne tire pas du tout un orbe hors du rayon d aimant', () => {
    expect(orbPullFraction(ORB_MAGNET_RADIUS)).toBe(0);
    // ⚠️ **La courbe est CONVEXE, et c'est le sujet.** Une attraction lineaire
    // se lit comme une derive : l'orbe s'eloignerait doucement de sa vraie
    // place sur toute la distance. Un carre la laisse fremir puis partir d'un
    // coup — c'est ce qui se lit comme un aimant.
    //
    // Verifie par mutation : remplacer `t * t` par `t` laissait 303 tests
    // verts. A mi-chemin, une droite rendrait 0,5 ; le carre rend 0,25.
    const mi = (ORB_PICKUP_RADIUS + ORB_MAGNET_RADIUS) / 2;
    expect(orbPullFraction(mi)).toBeLessThan(0.5);
    expect(orbPullFraction(mi)).toBeCloseTo(0.25, 5);

    expect(orbPullFraction(ORB_MAGNET_RADIUS + 500)).toBe(0);
  });

  /**
   * ⚠️ **L'ASSERTION CENTRALE DE LA TACHE.** Le mouvement est cosmetique : le
   * client anime, le serveur ne bouge rien et ramasse a `ORB_PICKUP_RADIUS`. Le
   * risque nomme par le plan — *« le ramassage se declenche la ou l'orbe n'est
   * plus dessinee »* — est annule par la FORME de cette courbe : a la distance
   * exacte ou le serveur ramasse, la fraction vaut 1, donc l'orbe est dessinee
   * SUR le joueur. **L'ecart entre l'orbe dessinee et l'orbe ramassee vaut zero
   * pixel.**
   */
  it('a pose tout le chemin AU rayon de ramassage : l orbe est dessinee sur le joueur pile quand le serveur la prend', () => {
    expect(orbPullFraction(ORB_PICKUP_RADIUS)).toBe(1);
    expect(orbPullFraction(ORB_PICKUP_RADIUS - 1)).toBe(1);
    expect(orbPullFraction(0)).toBe(1);
  });

  it('croit sans jamais reculer entre les deux rayons', () => {
    let precedent = -1;
    for (let d = ORB_MAGNET_RADIUS; d >= ORB_PICKUP_RADIUS; d -= 1) {
      const f = orbPullFraction(d);
      expect(f).toBeGreaterThanOrEqual(precedent);
      expect(f).toBeLessThanOrEqual(1);
      precedent = f;
    }
    expect(precedent).toBe(1);
  });

  /**
   * ⚠️ **`ORB_MAGNET_RADIUS` doit rester STRICTEMENT plus grand que le rayon de
   * ramassage.** Egaux, la fraction sauterait de 0 a 1 sans intervalle : le
   * serveur ramasserait au meme instant ou l'attraction commence, et
   * l'aimantation n'aurait jamais une seule image pour se voir. C'est la
   * condition d'existence de l'effet, pas un reglage.
   */
  it('laisse une vraie course a l attraction, entre le rayon d aimant et celui de ramassage', () => {
    expect(ORB_MAGNET_RADIUS).toBeGreaterThan(ORB_PICKUP_RADIUS);
    const milieu = (ORB_MAGNET_RADIUS + ORB_PICKUP_RADIUS) / 2;
    expect(orbPullFraction(milieu)).toBeGreaterThan(0);
    expect(orbPullFraction(milieu)).toBeLessThan(1);
  });
});

/** Le corps de `draw`, atteint par `adoptTexture` — voir l'avertissement en tete de fichier. */
function drawnOrbs(
  orbs: DerivedOrbs,
  players: readonly MagnetPoint[],
  view = TOUTE_LA_CARTE,
): Particle[] {
  const renderer = new OrbRenderer();
  renderer.adoptTexture(
    new Texture({
      source: new TextureSource({ width: ORB_TEXTURE_DIAMETER, height: ORB_TEXTURE_DIAMETER }),
    }),
  );

  const world = new Container();
  renderer.attach(world);
  renderer.draw(orbs, players, view, 0);

  const container = world.children[0] as ParticleContainer;
  return [...(container.particleChildren as Particle[])];
}

/** Un orbe unique, a la position demandee. */
function unOrbe(x: number, y: number): DerivedOrbs {
  const orbs = new DerivedOrbs(MAX_ENTITIES);
  orbs.spawn(avecOrbe(1), x, y, 0);
  expect(orbs.count).toBe(1);
  return orbs;
}

describe('OrbRenderer.draw — ce que le joueur voit vraiment', () => {
  it('pose une particule par orbe, a sa vraie position quand personne n est a portee', () => {
    const drawn = drawnOrbs(unOrbe(1000, 1000), []);

    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.x).toBe(1000);
    expect(drawn[0]?.y).toBe(1000);
  });

  it('laisse l orbe ou elle est quand le joueur le plus proche est hors du rayon d aimant', () => {
    const drawn = drawnOrbs(unOrbe(1000, 1000), [{ x: 1000 + ORB_MAGNET_RADIUS, y: 1000 }]);

    expect(drawn[0]?.x).toBe(1000);
  });

  /**
   * ⚠️ **L'ecart mesure, en pixels.** A l'instant precis ou le serveur ramasse
   * — le joueur vient d'entrer dans `ORB_PICKUP_RADIUS` — l'orbe DESSINEE est
   * a zero pixel du joueur. Elle est en revanche a `ORB_PICKUP_RADIUS` de sa
   * position VRAIE, et c'est sans consequence : rien, cote client, ne compare
   * jamais cette position a quoi que ce soit.
   */
  it('dessine l orbe exactement sur le joueur au rayon de ramassage : zero pixel d ecart', () => {
    const joueur = { x: 1000 + ORB_PICKUP_RADIUS, y: 1000 };
    const drawn = drawnOrbs(unOrbe(1000, 1000), [joueur])[0];

    expect(Math.hypot((drawn?.x ?? 0) - joueur.x, (drawn?.y ?? 0) - joueur.y)).toBeCloseTo(0, 6);
    expect(Math.hypot((drawn?.x ?? 0) - 1000, (drawn?.y ?? 0) - 1000)).toBeCloseTo(
      ORB_PICKUP_RADIUS,
      6,
    );
  });

  /**
   * L'aimantation, vue de l'oeil : entre les deux rayons l'orbe a quitte sa
   * position et s'est RAPPROCHEE du joueur, sans jamais le depasser.
   */
  it('fait glisser l orbe vers le joueur entre les deux rayons, sans jamais le depasser', () => {
    const milieu = (ORB_MAGNET_RADIUS + ORB_PICKUP_RADIUS) / 2;
    const joueur = { x: 1000 + milieu, y: 1000 };
    const drawn = drawnOrbs(unOrbe(1000, 1000), [joueur])[0];

    expect(drawn?.x).toBeGreaterThan(1000);
    expect(drawn?.x).toBeLessThan(joueur.x);
  });

  /**
   * ⚠️ **Le plus proche, jamais le premier de la liste** : c'est celui-la que
   * le serveur verra entrer dans `ORB_PICKUP_RADIUS` en premier
   * (`OrbField.resolvePickups` s'arrete au premier joueur a portee). Attirer
   * vers un autre ferait disparaitre l'orbe a l'oppose de son mouvement.
   */
  /**
   * ⚠️ **Les DEUX axes.** Un decor ou le joueur n'est decale qu'en x laisse
   * `particle.y = y` passer pour de l'aimantation : mutation appliquee, 289
   * tests verts. L'orbe doit arriver sur le joueur, pas sur sa colonne.
   */
  it('attire aussi en Y : l orbe arrive sur le joueur, pas sur sa colonne', () => {
    const diagonale = ORB_PICKUP_RADIUS / Math.SQRT2;
    const joueur = { x: 1000 + diagonale, y: 1000 + diagonale };
    const drawn = drawnOrbs(unOrbe(1000, 1000), [joueur])[0];

    expect(drawn?.x).toBeCloseTo(joueur.x, 6);
    expect(drawn?.y).toBeCloseTo(joueur.y, 6);
  });

  it('choisit le joueur le plus proche, pas le premier venu', () => {
    const loin = { x: 1000 - ORB_MAGNET_RADIUS + 1, y: 1000 };
    const proche = { x: 1000 + ORB_PICKUP_RADIUS, y: 1000 };
    const drawn = drawnOrbs(unOrbe(1000, 1000), [loin, proche])[0];

    expect(drawn?.x).toBeCloseTo(proche.x, 6);
  });

  /**
   * ⚠️ **Tache 17, etape 1 : l'orbe est dessinee a une taille CHOISIE, pas a la
   * taille de sa texture.** Jusqu'ici la texture faisait 16 px et aucune echelle
   * n'etait posee : `scaleX` valait 1 par defaut, donc toute mutation de
   * l'echelle etait indistinguable de son absence — la « fixture qui masque »
   * logee dans une constante de production, deja vue sur
   * `MARK_RING_TEXTURE_DIAMETER` a la tache 15.
   */
  it('dessine l orbe au diametre voulu, et la texture est plus fine que l affichage', () => {
    const drawn = drawnOrbs(unOrbe(1000, 1000), [])[0];

    expect((drawn?.scaleX ?? 0) * ORB_TEXTURE_DIAMETER).toBeCloseTo(ORB_DIAMETER_PX, 6);
    expect(drawn?.scaleY).toBe(drawn?.scaleX);
    expect(ORB_TEXTURE_DIAMETER).not.toBe(ORB_DIAMETER_PX);
  });

  it('teint l orbe et la centre sur sa position', () => {
    const drawn = drawnOrbs(unOrbe(1000, 1000), [])[0];

    expect(drawn?.tint).toBe(ORB_TINT);
    expect(drawn?.anchorX).toBe(0.5);
    expect(drawn?.anchorY).toBe(0.5);
  });

  /**
   * La pulsation reste, mais resserree : une orbe qui s'efface a moitie n'est
   * plus « nette ». L'assertion porte sur la BORNE, jamais sur la valeur d'une
   * phase — celle-ci depend de l'horloge et n'a rien a prouver.
   */
  /**
   * ⚠️ **`ORB_ALPHA_MIN` est une regle, pas un reglage libre.** Une orbe qui
   * s'efface de plus de moitie n'est plus « nette » : elle redevient le halo
   * clignotant d'avant la tache 17. L'assertion porte donc sur la VALEUR
   * autorisee, et pas seulement sur le fait que la pulsation la respecte —
   * cette seconde moitie, seule, est une tautologie : abaisser la constante
   * abaisse aussi la borne, et 301 tests restaient verts.
   */
  it('ne laisse jamais l orbe s effacer de plus de moitie', () => {
    expect(ORB_ALPHA_MIN).toBeGreaterThan(0.5);
  });

  it('pulse entre ce creux et l opacite pleine, et touche les deux bornes', () => {
    const orbs = new DerivedOrbs(MAX_ENTITIES);
    for (let k = 1; k <= 8; k++) {
      orbs.spawn(avecOrbe(k), 1000 + k, 1000, k * 7);
    }
    const renderer = new OrbRenderer();
    renderer.adoptTexture(
      new Texture({
        source: new TextureSource({ width: ORB_TEXTURE_DIAMETER, height: ORB_TEXTURE_DIAMETER }),
      }),
    );
    const world = new Container();
    renderer.attach(world);

    let vu = { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
    for (let ms = 0; ms < 2000; ms += 1) {
      renderer.draw(orbs, [], TOUTE_LA_CARTE, ms);
      for (const p of (world.children[0] as ParticleContainer).particleChildren as Particle[]) {
        expect(p.alpha).toBeGreaterThanOrEqual(ORB_ALPHA_MIN);
        expect(p.alpha).toBeLessThanOrEqual(1);
        vu = { min: Math.min(vu.min, p.alpha), max: Math.max(vu.max, p.alpha) };
      }
    }

    // Les bornes sont ATTEINTES : sans ça, une pulsation qui ne bougerait plus
    // du tout satisferait aussi les deux inegalites ci-dessus.
    expect(vu.min).toBeCloseTo(ORB_ALPHA_MIN, 3);
    expect(vu.max).toBeCloseTo(1, 3);
  });

  /**
   * ⚠️ **La marge de culling est celle de l'aimant, et elle sert.** Sans elle,
   * une orbe dont la position VRAIE vient de sortir du cadre serait ecartee
   * alors que sa position DESSINEE — tiree vers un joueur qui, lui, est a
   * l'ecran — y serait encore : elle disparaitrait en pleine aimantation, le
   * defaut meme que l'auteur a signale sur les anneaux de marque.
   */
  it('garde une orbe juste hors cadre que l aimantation ramene dedans, des QUATRE cotes', () => {
    const vue = new Rectangle(0, 0, 800, 800);
    const dehors = ORB_PICKUP_RADIUS - 1;
    const cotes: { orbe: [number, number]; joueur: MagnetPoint }[] = [
      { orbe: [800 + dehors, 400], joueur: { x: 799, y: 400 } },
      { orbe: [-dehors, 400], joueur: { x: 1, y: 400 } },
      { orbe: [400, 800 + dehors], joueur: { x: 400, y: 799 } },
      { orbe: [400, -dehors], joueur: { x: 400, y: 1 } },
    ];

    for (const cas of cotes) {
      const drawn = drawnOrbs(unOrbe(cas.orbe[0], cas.orbe[1]), [cas.joueur], vue);
      expect(drawn, `cote ${cas.orbe.join(',')}`).toHaveLength(1);
    }
  });

  it('ecarte une orbe franchement hors cadre', () => {
    const vue = new Rectangle(0, 0, 800, 800);

    expect(drawnOrbs(unOrbe(800 + ORB_MAGNET_RADIUS + 1, 400), [], vue)).toHaveLength(0);
  });

  it('ne dessine rien tant qu aucune texture n a ete adoptee', () => {
    const renderer = new OrbRenderer();
    const world = new Container();
    renderer.attach(world);
    renderer.draw(unOrbe(1000, 1000), [], TOUTE_LA_CARTE, 0);

    expect((world.children[0] as ParticleContainer).particleChildren).toHaveLength(0);
    expect(renderer.loaded).toBe(false);
  });

  it('pose des bornes explicites couvrant la carte entiere, marge comprise', () => {
    expect(new OrbRenderer().boundsArea).toMatchObject({
      x: -256,
      y: -256,
      width: MAP_SIZE + 512,
      height: MAP_SIZE + 512,
    });
  });
});

/** Un arret du degrade radial, tel que la texture le pose reellement. */
interface Stop {
  readonly at: number;
  readonly alpha: number;
}

const stops: Stop[] = [];
/** Rayon exterieur du degrade, puis rayon du disque effectivement rempli. */
const rayons = { degrade: 0, disque: 0 };

/**
 * Bouchonne le contexte 2D et cuit la texture d'orbe POUR DE VRAI, via `load()`.
 * Meme technique que `bakeZoneTexture` dans `zone-renderer.test.ts` : jsdom ne
 * fournit pas de contexte 2D, et le bouchon ne fait pas rien — il ENREGISTRE
 * les arrets et les rayons, qui sont exactement ce que « plus nette » affirme.
 */
function bakeOrbTexture(): void {
  const noop = (): void => undefined;
  const gradient = {
    addColorStop(at: number, color: string): void {
      const parsed = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(color);
      stops.push({ at, alpha: Number(parsed?.[1]) });
    },
  };
  const context = {
    createRadialGradient: (
      _x0: number,
      _y0: number,
      _r0: number,
      _x1: number,
      _y1: number,
      r1: number,
    ) => {
      rayons.degrade = r1;
      return gradient;
    },
    fillStyle: '' as unknown,
    beginPath: noop,
    arc: (_x: number, _y: number, r: number): void => {
      rayons.disque = r;
    },
    fill: noop,
  };
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: () => unknown };
  proto.getContext = (): unknown => context;

  const renderer = new OrbRenderer();
  renderer.load();
  expect(renderer.loaded).toBe(true);
}

/**
 * ⚠️ **Tache 17, etape 1 : l'orbe plus nette.** Le profil precedent etait celui
 * d'un FLASH — blanc au centre, colore a 0,35, transparent au bord — partage
 * avec les flashs d'impact et de reaction alors qu'il dit l'inverse d'eux. Un
 * halo n'a pas de bord ; un objet a ramasser en a un.
 *
 * Ce bloc garde la FORME du profil, jamais ses valeurs : des relations, pas une
 * recopie des constantes de production.
 */
describe('makeOrbTexture — un contour, pas un halo', () => {
  beforeAll(bakeOrbTexture);

  it('reste opaque AU BORD, la ou le halo s eteignait', () => {
    expect(stops.at(-1)).toEqual({ at: 1, alpha: 1 });
  });

  /**
   * Le creux entre le coeur et le lisere est ce qui fait lire DEUX traits
   * concentriques plutot qu'une tache : sans lui, le profil redevient un disque
   * uniforme dont on ne sait pas dire ou il finit.
   */
  it('creuse entre le coeur plein et le lisere, franchement', () => {
    const creux = Math.min(...stops.map((s) => s.alpha));
    const coeur = stops[0]?.alpha ?? 0;

    expect(coeur).toBe(1);
    expect(creux).toBeLessThanOrEqual(coeur / 2);
    // Le creux est au MILIEU du rayon, entre le coeur et le lisere — pas au
    // centre (ce serait un anneau) ni au bord (ce serait un halo).
    const auCreux = stops.filter((s) => s.alpha === creux).map((s) => s.at);
    expect(Math.min(...auCreux)).toBeGreaterThan(0);
    expect(Math.max(...auCreux)).toBeLessThan(1);
    // ⚠️ **Un PALIER, pas un simple passage.** Un unique arret au creux ne
    // dessine qu'une ligne sombre au ras du lisere : le disque redevient un
    // aplat, et « deux traits concentriques » est faux. Mutation appliquee
    // (creux porte a 1 sur son premier arret), 303 tests verts sans cette
    // ligne.
    expect(auCreux.length).toBeGreaterThanOrEqual(2);
    // Et le coeur est un palier lui aussi, avant le creux.
    const coeurPlein = stops.filter((s) => s.alpha === 1 && s.at < Math.min(...auCreux));
    expect(coeurPlein.length).toBeGreaterThanOrEqual(2);
  });

  it('remonte NET vers le lisere : la rampe tient dans un dixieme de rayon', () => {
    const creux = Math.min(...stops.map((s) => s.alpha));
    const dernierCreux = Math.max(...stops.filter((s) => s.alpha === creux).map((s) => s.at));
    const premierOpaque = Math.min(
      ...stops.filter((s) => s.alpha === 1 && s.at > dernierCreux).map((s) => s.at),
    );

    expect(premierOpaque - dernierCreux).toBeLessThanOrEqual(0.1);
  });

  /**
   * L'orbe s'arrete NET au bord de la texture, comme le disque de zone : c'est
   * le `ctx.arc` qui fait la coupure, et les deux rayons doivent coincider.
   */
  it('remplit le disque jusqu au bord de la texture, degrade et trace confondus', () => {
    expect(rayons.degrade).toBe(ORB_TEXTURE_DIAMETER / 2);
    expect(rayons.disque).toBe(ORB_TEXTURE_DIAMETER / 2);
  });
});
