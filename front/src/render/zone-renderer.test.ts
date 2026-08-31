// @vitest-environment jsdom
import {
  MAP_SIZE,
  ROLLBACK_DEPTH_TICKS,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
} from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import { ZoneField } from '@shared/zones';
import { Container, type Particle, type ParticleContainer, Texture, TextureSource } from 'pixi.js';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  selectZones,
  ZONE_ALPHA,
  ZONE_FILL_RATIO,
  ZONE_TEXTURE_DIAMETER,
  ZoneRenderer,
  zoneScale,
} from './zone-renderer';

/** Une vue qui couvre toute la carte : le culling ne doit alors rien retirer. */
const TOUTE_LA_CARTE = { x: 0, y: 0, width: MAP_SIZE, height: MAP_SIZE };

/**
 * Étape 5a, §9 / §6.6 de l'orientation : *« zone au sol : grand quad teinte,
 * additif »*, et tache 16 : *« rends les zones au sol plus nettes, en anneau
 * de different alpha si besoin »*.
 *
 * ⚠️ **Tout le corps de `ZoneRenderer.draw` etait garde par RIEN jusqu'a la
 * tache 16**, et deux mutations appliquees avant d'ecrire une ligne de test
 * l'ont montre : `particle.scaleX = 1` et la suppression de `particle.alpha`
 * passaient toutes deux a 237 tests verts. `zoneScale` etait teste — mais rien
 * ne verifiait que `draw` s'en servait. Le motif exact des dix-sept assertions
 * creuses du depot : le test met en scene la bonne intention et rate la ligne
 * qu'il nomme. `adoptTexture` est le point d'accroche qui le ferme, et ce
 * fichier tourne desormais sous jsdom pour atteindre aussi le PROFIL de la
 * texture.
 */
describe('selectZones — quelles zones se dessinent, au tick courant', () => {
  it('retient une zone vivante, et rend son creneau', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 1000, 1000, 1, 50);
    const out = new Int32Array(zones.capacity);

    expect(selectZones(zones, 50, TOUTE_LA_CARTE, out)).toBe(1);
    expect(out[0]).toBe(0);
  });

  /**
   * ⚠️ **LE test de ce fichier.** Le client garde volontairement ses zones
   * mortes `ROLLBACK_DEPTH_TICKS` ticks de plus dans le tableau, pour pouvoir
   * rejouer un tick ou elles vivaient encore (voir `GameClient#advanceHorde`).
   * Un renderer qui dessinerait `zones.count` disques — au lieu de ne retenir
   * que ceux que `aliveAt` juge vivants — les laisserait donc tous a l'ecran
   * un quart de seconde de trop, en permanence, sans que rien ne le signale.
   *
   * Le decor reproduit exactement cet etat : une zone perimee que `expire` n'a
   * pas encore retiree, parce que le client expire EN RETARD.
   */
  it('ne retient PAS une zone perimee que le tableau contient encore (expiration en retard du client)', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 1000, 1000, 1, 50);
    const out = new Int32Array(zones.capacity);

    const mort = 50 + ZONE_LIFETIME_TICKS;
    // Ce que fait le client, mot pour mot : il expire `ROLLBACK_DEPTH_TICKS`
    // ticks en arriere, donc la zone est encore la.
    zones.expire(mort - ROLLBACK_DEPTH_TICKS);
    expect(zones.count).toBe(1);

    expect(selectZones(zones, mort, TOUTE_LA_CARTE, out)).toBe(0);
  });

  it('retient la zone jusqu au dernier tick de sa vie, pas un de moins', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 1000, 1000, 1, 50);
    const out = new Int32Array(zones.capacity);

    expect(selectZones(zones, 50 + ZONE_LIFETIME_TICKS - 1, TOUTE_LA_CARTE, out)).toBe(1);
  });

  it('ecarte une zone hors du cadre, et garde celle qui y est', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 100, 100, 1, 50);
    // Meme element : il faut donc l'eloigner de plus de `ZONE_RADIUS`, sans
    // quoi `spawn` fusionnerait les deux au lieu d'en creer une seconde.
    zones.spawn(ELEMENT.BRAISE, 4000, 4000, 1, 50);
    // ⚠️ **Compte les zones creees, ne les suppose pas.** `spawn` FUSIONNE
    // deux zones du meme element dont les centres sont a moins de
    // `ZONE_RADIUS` : un decor mal espace ne poserait qu'UNE zone, et le
    // « 1 » attendu plus bas serait alors le compte du culling ou celui de la
    // fusion, indistinctement.
    expect(zones.count).toBe(2);
    const out = new Int32Array(zones.capacity);

    const vue = { x: 0, y: 0, width: 800, height: 800 };
    expect(selectZones(zones, 50, vue, out)).toBe(1);
    expect(out[0]).toBe(0);
  });

  /**
   * La marge de culling vaut `ZONE_RADIUS` : un disque dont le CENTRE vient de
   * sortir du cadre teint encore le bord de l'ecran, et le faire disparaitre
   * d'un coup se verrait.
   */
  it('garde une zone dont le centre est juste hors cadre mais dont le disque mord dedans', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 800 + ZONE_RADIUS - 1, 400, 1, 50);
    const out = new Int32Array(zones.capacity);

    expect(selectZones(zones, 50, { x: 0, y: 0, width: 800, height: 800 }, out)).toBe(1);
  });

  it('ne deborde jamais du tampon fourni', () => {
    const zones = new ZoneField();
    for (let i = 0; i < 5; i++) {
      // Espacees de plus d'un `ZONE_RADIUS` : cinq zones distinctes, pas une
      // seule rafraichie cinq fois (regle de fusion du §5.1 bis).
      zones.spawn(ELEMENT.GIVRE, 500 + i * 3 * ZONE_RADIUS, 500, 1, 10);
    }
    expect(zones.count).toBe(5);
    const out = new Int32Array(2);

    // Cinq zones vivantes et visibles, un tampon de deux : c'est le tampon qui
    // borne, pas le champ.
    expect(selectZones(zones, 10, TOUTE_LA_CARTE, out)).toBe(2);
  });
});

/**
 * ⚠️ La taille dessinee est DERIVEE de `ZONE_RADIUS`, jamais reglee a cote —
 * meme discipline que `spriteScale` (tache 16 de l'etape 3), et pour un enjeu
 * plus grand : le disque dit au joueur ou ses ennemis sont marques et
 * ralentis, et c'est `ZONE_RADIUS` qui le decide reellement.
 */
describe('zoneScale — le disque dessine couvre exactement le rayon de la zone', () => {
  it('rend un diametre dessine egal a 2 x ZONE_RADIUS', () => {
    expect(zoneScale(ZONE_TEXTURE_DIAMETER) * ZONE_TEXTURE_DIAMETER).toBeCloseTo(
      2 * ZONE_RADIUS,
      6,
    );
  });

  it('suit ZONE_RADIUS quelle que soit la finesse de la texture', () => {
    expect(zoneScale(64) * 64).toBeCloseTo(2 * ZONE_RADIUS, 6);
    expect(zoneScale(256) * 256).toBeCloseTo(2 * ZONE_RADIUS, 6);
  });

  it('ne divise pas par zero sur une texture degeneree', () => {
    expect(zoneScale(0)).toBe(1);
  });
});

/**
 * Le corps de `draw`, atteint par `adoptTexture`. **La moitie qui manquait :**
 * `zoneScale` disait la bonne chose, personne ne verifiait que le disque
 * dessine s'en servait.
 */
function drawnZones(zones: ZoneField, tick: number): Particle[] {
  const renderer = new ZoneRenderer();
  renderer.adoptTexture(
    new Texture({
      source: new TextureSource({ width: ZONE_TEXTURE_DIAMETER, height: ZONE_TEXTURE_DIAMETER }),
    }),
  );

  const world = new Container();
  renderer.attach(world);
  renderer.draw(zones, tick, TOUTE_LA_CARTE);

  const container = world.children[0] as ParticleContainer;
  return [...(container.particleChildren as Particle[])];
}

/** Une zone de Braise nee au tick 50, seule sur la carte. */
function uneZone(element: number = ELEMENT.BRAISE): ZoneField {
  const zones = new ZoneField();
  zones.spawn(element, 1000, 1000, 1, 50);
  expect(zones.count).toBe(1);
  return zones;
}

describe('ZoneRenderer.draw — le disque dessine dit le rayon de la regle', () => {
  it('pose une particule par zone vivante et visible, a sa position', () => {
    const zones = uneZone();

    const drawn = drawnZones(zones, 50);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.x).toBe(zones.x[0]);
    expect(drawn[0]?.y).toBe(zones.y[0]);
  });

  /**
   * ⚠️ **Tache 16, etape 2 : le bord dit la verite.** L'assertion porte sur ce
   * qui est DESSINE — echelle x diametre de texture — et non sur `zoneScale`
   * prise a part, qui ne prouvait rien de ce que `draw` fait. Une zone qui
   * parait plus grande qu'elle n'est ment sur une regle : c'est `ZONE_RADIUS`
   * qui decide qui est marque et ou deux zones reagissent.
   */
  it('dessine le disque au diametre exact de ZONE_RADIUS', () => {
    const drawn = drawnZones(uneZone(), 50)[0];

    expect((drawn?.scaleX ?? 0) * ZONE_TEXTURE_DIAMETER).toBeCloseTo(2 * ZONE_RADIUS, 6);
  });

  /**
   * ⚠️ **Un CERCLE, pas une ellipse — l'inverse de l'anneau de marque de la
   * tache 15.** La difference n'est pas esthetique : le rayon de l'anneau ne
   * decide de rien, celui de la zone est compare en distance euclidienne des
   * deux cotes du fil (`markInZones`, `Horde#computeSlow`, §5.2). Un
   * aplatissement en monde ferait mentir la regle sur un axe. C'est la camera
   * seule qui l'ecrase, uniformement avec le reste du monde.
   */
  it('garde le disque circulaire en coordonnees monde', () => {
    const drawn = drawnZones(uneZone(), 50)[0];

    expect(drawn?.scaleY).toBe(drawn?.scaleX);
  });

  it('teint le disque de la couleur de l element, et distingue la Braise du Givre', () => {
    expect(drawnZones(uneZone(ELEMENT.BRAISE), 50)[0]?.tint).toBe(elementOf(ELEMENT.BRAISE).tint);
    expect(drawnZones(uneZone(ELEMENT.GIVRE), 50)[0]?.tint).toBe(elementOf(ELEMENT.GIVRE).tint);
    expect(drawnZones(uneZone(ELEMENT.GIVRE), 50)[0]?.tint).not.toBe(
      drawnZones(uneZone(ELEMENT.BRAISE), 50)[0]?.tint,
    );
  });

  it('pose l opacite du bord, et centre le disque sur la position de la zone', () => {
    const drawn = drawnZones(uneZone(), 50)[0];

    expect(drawn?.alpha).toBe(ZONE_ALPHA);
    expect(drawn?.anchorX).toBe(0.5);
    expect(drawn?.anchorY).toBe(0.5);
  });

  /**
   * L'autre moitie de `selectZones` vue depuis `draw` : une zone perimee ne
   * pose aucune particule, elle n'est pas seulement retiree d'un tableau.
   */
  it('ne dessine rien pour une zone perimee que le tableau contient encore', () => {
    expect(drawnZones(uneZone(), 50 + ZONE_LIFETIME_TICKS)).toHaveLength(0);
  });

  it('ne dessine rien tant qu aucune texture n a ete adoptee', () => {
    const renderer = new ZoneRenderer();
    const world = new Container();
    renderer.attach(world);
    renderer.draw(uneZone(), 50, TOUTE_LA_CARTE);

    expect((world.children[0] as ParticleContainer).particleChildren).toHaveLength(0);
    expect(renderer.loaded).toBe(false);
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
 * Bouchonne le contexte 2D et cuit la texture de zone POUR DE VRAI, via
 * `load()`.
 *
 * ⚠️ **C'est le seul moyen d'atteindre `makeZoneTexture`.** jsdom ne fournit
 * pas de contexte 2D (il faudrait le paquet `canvas`) ; `stage.test.ts`
 * bouchonne le sien depuis la tache 9 bis. Ici le bouchon ne fait pas rien : il
 * ENREGISTRE les arrets du degrade et les rayons, qui sont exactement ce que
 * *« une bordure lisible »* et *« le bord dit la verite »* affirment.
 */
function bakeZoneTexture(): void {
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

  const renderer = new ZoneRenderer();
  renderer.load();
  expect(renderer.loaded).toBe(true);
}

/**
 * ⚠️ **Tache 16, etape 1 : une bordure lisible.** Le profil de la tache 9 etait
 * plein jusqu'a 0,65 de rayon puis s'eteignait en fondu : on ne pouvait lire
 * nulle part ou la zone s'arrete, et l'oeil placait la frontiere la ou le fondu
 * devient faible — donc plus PRES du centre qu'elle n'est. Or cette frontiere
 * decide qui est marque et ou deux zones reagissent.
 *
 * Ce bloc garde la FORME du profil, jamais ses valeurs : des relations (« le
 * bord est le plus opaque », « l'interieur est franchement plus pale »), pas
 * une recopie des constantes de production.
 */
describe('makeZoneTexture — un bord, et il tombe sur le rayon de la regle', () => {
  beforeAll(bakeZoneTexture);

  /**
   * ⚠️ **L'assertion centrale de la tache.** Le point le plus opaque est a
   * l'offset 1 du degrade, c'est-a-dire au bord de la texture — et `zoneScale`
   * place ce bord exactement a `ZONE_RADIUS` (bloc `zoneScale` plus haut, et
   * « dessine le disque au diametre exact de ZONE_RADIUS » sur `draw`). **Le
   * bord qu'on voit est donc le rayon qui decide.**
   */
  it('met son maximum d opacite AU BORD, pas avant', () => {
    const max = Math.max(...stops.map((s) => s.alpha));
    expect(stops.at(-1)).toEqual({ at: 1, alpha: max });
    expect(max).toBe(1);
  });

  it('laisse l interieur franchement plus pale que le bord : on lit un anneau, pas un aplat', () => {
    const bord = stops.at(-1)?.alpha ?? 0;
    expect(stops[0]?.alpha).toBe(ZONE_FILL_RATIO);
    // Moitie moins au plus : en deça, le disque redevient l'aplat uniforme
    // dont on ne sait pas dire ou il finit.
    expect(stops[0]?.alpha).toBeLessThanOrEqual(bord / 2);
  });

  it('monte NET vers le bord : la rampe tient dans un dixieme de rayon', () => {
    const dernierPale = Math.max(
      ...stops.filter((s) => s.alpha === stops[0]?.alpha).map((s) => s.at),
    );
    const premierOpaque = Math.min(...stops.filter((s) => s.alpha === 1).map((s) => s.at));

    expect(premierOpaque - dernierPale).toBeLessThanOrEqual(0.1);
  });

  /**
   * ⚠️ **La seconde moitie de « le bord dit la verite ».** Le degre le plus
   * opaque au bord du DEGRADE ne sert a rien si le disque rempli s'arrete
   * avant : la zone paraitrait plus petite que `ZONE_RADIUS`. Les deux rayons
   * valent le demi-cote de la texture, que `zoneScale` ramene a `ZONE_RADIUS`.
   */
  it('remplit le disque jusqu au bord de la texture, degrade et trace confondus', () => {
    expect(rayons.degrade).toBe(ZONE_TEXTURE_DIAMETER / 2);
    expect(rayons.disque).toBe(ZONE_TEXTURE_DIAMETER / 2);
  });
});

describe('ZoneRenderer — ce que le §6.6 exige du conteneur', () => {
  it('fusionne en ADDITIF : deux zones qui se recouvrent s additionnent, elles ne se masquent pas', () => {
    // Le recouvrement de deux zones d'elements differents est ce qui declenche
    // une reaction (§5.2) : en melange normal, la seconde masquerait la
    // premiere et leur frontiere commune — la seule chose qu'il faille voir —
    // serait invisible.
    expect(new ZoneRenderer().blendMode).toBe('add');
  });

  it('pose des bornes explicites couvrant la carte entiere, marge comprise', () => {
    expect(new ZoneRenderer().boundsArea).toMatchObject({
      x: -256,
      y: -256,
      width: MAP_SIZE + 512,
      height: MAP_SIZE + 512,
    });
  });
});
