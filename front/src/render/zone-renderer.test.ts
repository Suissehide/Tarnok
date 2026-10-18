// @vitest-environment jsdom
import {
  MAP_SIZE,
  ROLLBACK_DEPTH_TICKS,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
} from '@shared/constants';
import { ELEMENT, ELEMENTS, elementOf } from '@shared/elements';
import { packZoneKind } from '@shared/protocol';
import { REACTION, zoneRadius } from '@shared/reactions';
import { ZoneField } from '@shared/zones';
import { Container, type Particle, type ParticleContainer, Texture, TextureSource } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import {
  lookOf,
  MAX_PULSE_AMP,
  RIM_MIN,
  selectZones,
  ZONE_ALPHA,
  ZONE_FADE_FLOOR,
  ZONE_SPAWN_OVERSHOOT,
  ZONE_SPAWN_TICKS,
  ZONE_TEXTURE_DIAMETER,
  ZoneRenderer,
  zoneFade,
  zoneScale,
  zoneSpawnScale,
} from './zone-renderer';

/** Une vue qui couvre toute la carte : le culling ne doit alors rien retirer. */
const TOUTE_LA_CARTE = { x: 0, y: 0, width: MAP_SIZE, height: MAP_SIZE };

/**
 * Les zones au sol : un grand quad teinte, additif, avec un bord net.
 *
 * ⚠️ Tester `zoneScale` ne prouve pas que `draw` s'en sert : `adoptTexture`
 * est le point d'accroche qui atteint le corps de `draw`, et ce fichier tourne
 * sous jsdom pour atteindre aussi le PROFIL de la texture.
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
      // seule rafraichie cinq fois (regle de fusion de `spawn`).
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
 * meme discipline que `spriteScale`, et pour un enjeu
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
 * Le corps de `draw`, atteint par `adoptTexture` : le disque dessine se sert
 * bien de `zoneScale`.
 */
function drawnZones(zones: ZoneField, tick: number, timeMs = 0): Particle[] {
  const renderer = new ZoneRenderer();
  // L'atlas : une colonne par element, une rangee simple et une de reaction.
  renderer.adoptTexture(
    new Texture({
      source: new TextureSource({
        width: ZONE_TEXTURE_DIAMETER * ELEMENTS.length,
        height: ZONE_TEXTURE_DIAMETER * 2,
      }),
    }),
  );

  const world = new Container();
  renderer.attach(world);
  renderer.draw(zones, tick, TOUTE_LA_CARTE, timeMs);

  const container = world.children[0] as ParticleContainer;
  return [...(container.particleChildren as Particle[])];
}

/**
 * Un tick ou la zone nee a 50 est POSEE (apparition finie) et loin de son
 * fondu : l'echelle et l'opacite y valent leur valeur de repos.
 */
const POSEE = 50 + ZONE_SPAWN_TICKS + 4;

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
   * ⚠️ **Le bord dit la verite.** L'assertion porte sur ce
   * qui est DESSINE — echelle x diametre de texture — et non sur `zoneScale`
   * prise a part, qui ne prouve rien de ce que `draw` fait. Une zone qui
   * parait plus grande qu'elle n'est ment sur une regle : c'est `ZONE_RADIUS`
   * qui decide qui est marque et ou deux zones reagissent.
   */
  it('dessine le disque au diametre exact de ZONE_RADIUS', () => {
    const drawn = drawnZones(uneZone(), POSEE)[0];

    expect((drawn?.scaleX ?? 0) * ZONE_TEXTURE_DIAMETER).toBeCloseTo(2 * ZONE_RADIUS, 6);
  });

  /**
   * ⚠️ **Un CERCLE, pas une ellipse — l'inverse de l'anneau de marque.** La
   * difference n'est pas esthetique : le rayon de l'anneau ne
   * decide de rien, celui de la zone est compare en distance euclidienne des
   * deux cotes du fil (`markInZones`, `Horde#computeSlow`). Un
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

  /**
   * ⚠️ **`draw` doit decoder `zones.kind`, jamais le lire brut.**
   * `packZoneKind(GIVRE, reaction)` avec une reaction non nulle depasse la
   * portee d'`ELEMENTS` : un `draw` qui lirait l'octet brut leverait au lieu de
   * teinter. `kind !== element` : le decor empaquette une reaction non nulle.
   */
  it('teint du bon element meme quand la zone porte un type de reaction empaquete', () => {
    const kind = packZoneKind(ELEMENT.GIVRE, 9);
    expect(kind).not.toBe(ELEMENT.GIVRE);

    expect(() => drawnZones(uneZone(kind), 50)).not.toThrow();
    expect(drawnZones(uneZone(kind), 50)[0]?.tint).toBe(elementOf(ELEMENT.GIVRE).tint);
  });

  it('pose l opacite du bord, et centre le disque sur la position de la zone', () => {
    const drawn = drawnZones(uneZone(), POSEE)[0];

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
    renderer.draw(uneZone(), 50, TOUTE_LA_CARTE, 0);

    expect((world.children[0] as ParticleContainer).particleChildren).toHaveLength(0);
    expect(renderer.loaded).toBe(false);
  });
});

/**
 * Chaque element a sa silhouette et son animation, et une zone de
 * reaction se distingue d'une zone d'element simple.
 */
describe('lookOf — une silhouette par element, et le bord reste sur la regle', () => {
  const ANGLES = Array.from({ length: 360 }, (_, k) => (k * Math.PI) / 180);

  /**
   * ⚠️ **L'essentiel.** La signature d'un element est sa silhouette
   * echantillonnee, son trace et son animation : deux elements qui la
   * partageraient ne se distingueraient plus que par la teinte. Un element ajoute a `ELEMENT_DEFS` sans ligne
   * dans la table retombe sur le Neutre et fait rougir ce test.
   */
  it('donne a chaque element une forme ET une animation qu aucun autre ne partage', () => {
    const formes = ELEMENTS.map((e) => {
      const look = lookOf(e.id);
      return `${look.stroke}:${ANGLES.map((t) => look.rim(t).toFixed(3)).join(',')}`;
    });
    const animations = ELEMENTS.map((e) => {
      const l = lookOf(e.id);
      return [l.spin, l.pulseHz, l.pulseAmp, l.flicker, l.flickerHz].join(',');
    });

    expect(new Set(formes).size).toBe(ELEMENTS.length);
    expect(new Set(animations).size).toBe(ELEMENTS.length);
  });

  /**
   * ⚠️ **Le bord dit toujours la verite.** Les silhouettes
   * ondulent vers l'INTERIEUR, jamais au-dela du rayon de la case — que
   * `zoneScale` place a `ZONE_RADIUS` — et chacune touche ce rayon quelque
   * part : l'enveloppe exterieure est la regle.
   */
  it('garde chaque silhouette entre RIM_MIN et le rayon, et la fait toucher le rayon', () => {
    for (const e of ELEMENTS) {
      const rayons = ANGLES.map((t) => lookOf(e.id).rim(t));
      expect(Math.min(...rayons)).toBeGreaterThanOrEqual(RIM_MIN - 1e-3);
      expect(Math.max(...rayons)).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.max(...rayons)).toBeGreaterThan(0.97);
    }
  });

  it('ne laisse aucune respiration deborder de plus de MAX_PULSE_AMP', () => {
    for (const e of ELEMENTS) {
      expect(lookOf(e.id).pulseAmp).toBeLessThanOrEqual(MAX_PULSE_AMP);
    }
  });
});

describe('zoneSpawnScale / zoneFade — la zone suit sa vie', () => {
  it('se pose plus large que la regle, puis retombe exactement dessus', () => {
    expect(zoneSpawnScale(0)).toBeCloseTo(1 + ZONE_SPAWN_OVERSHOOT, 9);
    expect(zoneSpawnScale(ZONE_SPAWN_TICKS / 2)).toBeGreaterThan(1);
    expect(zoneSpawnScale(ZONE_SPAWN_TICKS)).toBe(1);
  });

  /**
   * ⚠️ **Le plancher est ce qui empeche le fondu de devenir une seconde garde
   * d'expiration** (voir `ZONE_ALPHA`) : au dernier tick vivant, la zone se
   * voit encore ; c'est `aliveAt` seul qui la retire.
   */
  it('s estompe en fin de vie sans jamais s eteindre', () => {
    const vie = ZONE_LIFETIME_TICKS;
    expect(zoneFade(vie / 2, vie)).toBe(1);
    expect(zoneFade(vie - 10, vie)).toBeLessThan(1);
    expect(zoneFade(vie - 1, vie)).toBeGreaterThanOrEqual(ZONE_FADE_FLOOR);
    expect(zoneFade(vie, vie)).toBeCloseTo(ZONE_FADE_FLOOR, 9);
  });

  it('est vue PLUS GRANDE a sa pose, et plus pale a sa fin, que posee', () => {
    const posee = drawnZones(uneZone(ELEMENT.NEUTRE), POSEE)[0];
    const pose = drawnZones(uneZone(ELEMENT.NEUTRE), 50)[0];
    const fin = drawnZones(uneZone(ELEMENT.NEUTRE), 50 + ZONE_LIFETIME_TICKS - 1)[0];

    expect(pose?.scaleX ?? 0).toBeGreaterThan(posee?.scaleX ?? 0);
    expect(fin?.alpha ?? 1).toBeLessThan(posee?.alpha ?? 0);
    expect(fin?.alpha ?? 0).toBeGreaterThan(0);
  });
});

describe('ZoneRenderer.draw — la silhouette suit l element, la reaction, et le temps', () => {
  it('prend la case de son element dans l atlas : Braise et Givre ne partagent pas de forme', () => {
    const braise = drawnZones(uneZone(ELEMENT.BRAISE), POSEE)[0];
    const givre = drawnZones(uneZone(ELEMENT.GIVRE), POSEE)[0];

    expect(braise?.texture.frame.x).not.toBe(givre?.texture.frame.x);
  });

  it('distingue une zone de REACTION d une zone d element simple du meme element', () => {
    const simple = drawnZones(uneZone(ELEMENT.BRAISE), POSEE)[0];
    const reaction = drawnZones(
      uneZone(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE)),
      POSEE,
    )[0];

    // ⚠️ **La rangee change, et la colonne AUSSI** : la rangee du bas est
    // indexee par FAMILLE de reaction, pas par element.
    expect(reaction?.texture.frame.y).not.toBe(simple?.texture.frame.y);
    // La teinte, elle, reste celle de l'element : la forme dit l'evenement,
    // la couleur dit la matiere.
    expect(reaction?.tint).toBe(simple?.tint);
  });

  it('distingue DEUX reactions d un meme element : la forme dit laquelle', () => {
    // Surchauffe est une « etoile », Embrasement aussi — mais Fournee est un
    // « rond » : deux familles differentes, deux cases differentes.
    const etoile = drawnZones(uneZone(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE)), POSEE)[0];
    const rond = drawnZones(uneZone(packZoneKind(ELEMENT.BRAISE, REACTION.FOURNEE)), POSEE)[0];

    expect(etoile?.texture.frame.x).not.toBe(rond?.texture.frame.x);
    expect(etoile?.texture.frame.y).toBe(rond?.texture.frame.y);
    expect(etoile?.tint).toBe(rond?.tint);
  });

  it('met l echelle de chaque zone sur SON rayon, pas sur le generique', () => {
    // ⚠️ « Le bord dit toujours la verite » : un champ de Verglas
    // couvre 1,45 fois le rayon generique, et il doit se dessiner d'autant.
    const large = drawnZones(uneZone(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS)), POSEE)[0];
    const etroit = drawnZones(
      uneZone(packZoneKind(ELEMENT.FOUDRE, REACTION.PARATONNERRE)),
      POSEE,
    )[0];
    if (!large || !etroit) {
      throw new Error('zone manquante');
    }
    expect(large.scaleX / etroit.scaleX).toBeCloseTo(
      zoneRadius(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS)) /
        zoneRadius(packZoneKind(ELEMENT.FOUDRE, REACTION.PARATONNERRE)),
      5,
    );
    // Isotrope : une zone reste un CERCLE en monde.
    expect(large.scaleY).toBe(large.scaleX);
  });

  /**
   * L'animation est APPLIQUEE, pas seulement decrite par la table : la meme
   * zone, au meme tick, a deux instants de l'horloge murale, n'est pas
   * dessinee pareil — et sa respiration reste dans la marge de lecture.
   */
  it('anime la zone avec l horloge murale, sans sortir de la marge du rayon', () => {
    const t0 = drawnZones(uneZone(ELEMENT.VIF_ARGENT), POSEE, 0)[0];
    const t1 = drawnZones(uneZone(ELEMENT.VIF_ARGENT), POSEE, 370)[0];

    expect(t1?.rotation).not.toBe(t0?.rotation);
    expect(t1?.scaleX).not.toBe(t0?.scaleX);
    expect((t1?.scaleX ?? 0) * ZONE_TEXTURE_DIAMETER).toBeLessThanOrEqual(
      2 * ZONE_RADIUS * (1 + MAX_PULSE_AMP),
    );
    expect(t1?.scaleY).toBe(t1?.scaleX);
  });
});

describe('ZoneRenderer.load — l atlas se cuit', () => {
  it('cuit toutes ses cases sur un contexte 2D', () => {
    const noop = (): void => undefined;
    const proto = HTMLCanvasElement.prototype as unknown as { getContext: () => unknown };
    proto.getContext = (): unknown => ({
      beginPath: noop,
      closePath: noop,
      moveTo: noop,
      lineTo: noop,
      arc: noop,
      fill: noop,
      stroke: noop,
    });

    const renderer = new ZoneRenderer();
    renderer.load();
    expect(renderer.loaded).toBe(true);
  });
});

describe('ZoneRenderer — ce que le §6.6 exige du conteneur', () => {
  it('fusionne en ADDITIF : deux zones qui se recouvrent s additionnent, elles ne se masquent pas', () => {
    // Le recouvrement de deux zones d'elements differents est ce qui declenche
    // une reaction : en melange normal, la seconde masquerait la
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
