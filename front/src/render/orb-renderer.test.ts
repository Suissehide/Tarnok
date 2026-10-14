// @vitest-environment jsdom
import {
  COIN_DROP_ONE_IN,
  COIN_DROP_RESIDUE,
  MAP_SIZE,
  MAX_ENTITIES,
  ORB_DROP_ONE_IN,
  ORB_PICKUP_RADIUS,
  PLAYER_SPEED,
} from '@shared/constants';
import { dropsCoin, dropsOrb } from '@shared/horde';
import {
  Container,
  type Particle,
  type ParticleContainer,
  Rectangle,
  Texture,
  TextureSource,
} from 'pixi.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { DerivedOrbs, ORB_FLIGHT_LIFETIME_MS, OrbFlights, type PickupTarget } from '../net/client';
import {
  COIN_SCALE,
  COIN_TINT,
  DROP_COIN_CELL,
  DROP_ORB_CELL,
  DROP_OUTLINE,
  dropCellRect,
  ORB_DIAMETER_PX,
  ORB_PULSE,
  ORB_PULSE_MS,
  ORB_SCALE,
  ORB_SHADES,
  ORB_TEXTURE_DIAMETER,
  ORB_TINT,
  OrbRenderer,
  orbFlightFraction,
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
 * Étape 5a, tache 20, sur retour de jeu : *« l'aimantation est plus proche du
 * joueur et attire l'xp jusqu'a lui, meme s'il l'eloigne »*.
 *
 * ⚠️ **Tout le corps de `OrbRenderer.draw` etait garde par RIEN avant la tache
 * 17**, et quatre mutations appliquees AVANT d'ecrire une ligne de test l'ont
 * montre — `particle.scaleX = 1`, `const pull = 0`, et les deux gardes de
 * chute — toutes vertes a 280 tests. C'est le motif des dix-sept assertions
 * creuses du depot, et la lecon de la tache 16 sur `ZoneRenderer` : `load()`
 * cuit sa texture sur un canevas 2D absent de node, donc `draw` retournait a son
 * premier `if (!texture)` et rien de ce qu'elle fait n'etait atteignable.
 * `adoptTexture` est le point d'accroche qui referme ça.
 */
describe('orbFlightFraction — le vol decore un ramassage deja acquis', () => {
  it('ne bouge pas l orbe a l instant de la capture : elle part de la ou elle etait tombee', () => {
    expect(orbFlightFraction(0)).toBe(0);
    expect(orbFlightFraction(-10)).toBe(0);
  });

  /**
   * ⚠️ **L'ASSERTION CENTRALE DE LA TACHE.** La fraction vaut EXACTEMENT 1 a
   * l'echeance, et la position dessinee est interpolee vers la position
   * COURANTE du joueur : le vol arrive donc SUR lui, ou qu'il soit alle. C'est
   * ce qui remplace la surete de la tache 17 — la ou une fonction de la
   * distance garantissait « dessinee sur le joueur au rayon de ramassage »,
   * c'est ici le declenchement (`DerivedOrbs.capture`, meme predicat que le
   * serveur) qui garantit que le vol ne commence jamais avant le ramassage.
   */
  it('a pose tout le chemin a l echeance, exactement, et n en repart jamais', () => {
    expect(orbFlightFraction(ORB_FLIGHT_LIFETIME_MS)).toBe(1);
    expect(orbFlightFraction(ORB_FLIGHT_LIFETIME_MS + 1000)).toBe(1);
  });

  it('croit sans jamais reculer, de 0 a 1', () => {
    let precedent = -1;
    for (let ms = 0; ms <= ORB_FLIGHT_LIFETIME_MS; ms += 1) {
      const f = orbFlightFraction(ms);
      expect(f).toBeGreaterThanOrEqual(precedent);
      expect(f).toBeLessThanOrEqual(1);
      precedent = f;
    }
    expect(precedent).toBe(1);
  });

  /**
   * ⚠️ **Une courbe en S, pas une droite.** Une interpolation lineaire se lit
   * comme un glissement regulier : l'orbe demarre d'un coup et percute le
   * joueur. Le S la decolle en douceur puis la pose. Le milieu ne le prouve
   * PAS — smoothstep y vaut 0,5 comme la droite : ce sont les quarts qui
   * separent les deux, et remplacer `t * t * (3 - 2 * t)` par `t` les fait
   * rougir.
   */
  it('demarre plus lentement et finit plus vite qu une droite', () => {
    expect(orbFlightFraction(ORB_FLIGHT_LIFETIME_MS / 4)).toBeLessThan(0.25);
    expect(orbFlightFraction(ORB_FLIGHT_LIFETIME_MS / 2)).toBeCloseTo(0.5, 6);
    expect(orbFlightFraction((3 * ORB_FLIGHT_LIFETIME_MS) / 4)).toBeGreaterThan(0.75);
  });

  /**
   * ⚠️ **Le vol doit DEPASSER un joueur qui fuit, pas le suivre.** Il part
   * d'au plus `ORB_PICKUP_RADIUS` — c'est la le seul rayon du systeme depuis la
   * tache 20 — et il a `ORB_FLIGHT_LIFETIME_MS` pour couvrir cette distance :
   * si la vitesse moyenne qui en resulte tombait sous `PLAYER_SPEED`, l'orbe
   * trainerait derriere le joueur au lieu d'etre aspiree. Une regle, pas un
   * reglage.
   */
  it('couvre le rayon de ramassage plus vite qu un joueur ne le parcourt', () => {
    const vitesseMoyenne = ORB_PICKUP_RADIUS / (ORB_FLIGHT_LIFETIME_MS / 1000);
    expect(vitesseMoyenne).toBeGreaterThan(PLAYER_SPEED);
  });
});

/**
 * Un calque pret a dessiner, et de quoi relire ce qu'il a pose. La texture est
 * adoptee comme apres `load()` — voir l'avertissement en tete de fichier.
 *
 * Rendu plutot que masque derriere un appel unique parce que **le reservoir de
 * particules survit d'une image a l'autre** : certaines proprietes ne se
 * gardent qu'en dessinant DEUX images sur le meme calque (voir la pulsation).
 */
function calque(): { renderer: OrbRenderer; particules: () => Particle[] } {
  const renderer = new OrbRenderer();
  // ⚠️ **L'atlas fait DEUX cases** depuis la tache 14 de l'etape 6a : l'orbe et
  // la piece. Un decor d'une seule case laisserait `#kindOf` rendre la meme
  // texture aux deux natures, et « la piece se dessine comme une piece »
  // deviendrait invérifiable.
  renderer.adoptTexture(
    new Texture({
      source: new TextureSource({ width: ORB_TEXTURE_DIAMETER * 2, height: ORB_TEXTURE_DIAMETER }),
    }),
  );

  const world = new Container();
  renderer.attach(world);
  const container = world.children[0] as ParticleContainer;
  return { renderer, particules: () => [...(container.particleChildren as Particle[])] };
}

/** Une image unique, sur un calque neuf. */
function dessine(
  orbs: DerivedOrbs,
  flights: OrbFlights,
  players: readonly PickupTarget[],
  view = TOUTE_LA_CARTE,
  timeMs = 0,
): Particle[] {
  const { renderer, particules } = calque();
  renderer.draw(orbs, flights, players, view, timeMs);
  return particules();
}

/** Les orbes AU SOL, dessinees : aucun vol en cours. */
function drawnOrbs(
  orbs: DerivedOrbs,
  players: readonly PickupTarget[] = [],
  view = TOUTE_LA_CARTE,
): Particle[] {
  return dessine(orbs, new OrbFlights(8), players, view);
}

/** Un orbe unique, a la position demandee. */
function unOrbe(x: number, y: number): DerivedOrbs {
  const orbs = new DerivedOrbs(MAX_ENTITIES);
  orbs.spawn(avecOrbe(1), x, y, 0);
  expect(orbs.count).toBe(1);
  return orbs;
}

/** Identite du joueur qui ramasse, dans tous les decors de vol de ce fichier. */
const RAMASSEUR = 7;

/**
 * Horloge murale de la capture, dans tous les decors de vol de ce fichier.
 *
 * ⚠️ **Jamais zero, et c'est une « fixture qui masque » de moins.** Un vol ne a
 * l'instant 0 rend `timeMs - bornMs` egal a `timeMs` : oublier la naissance
 * dans le calcul de l'age serait alors indistinguable, et la mutation a
 * effectivement survecu tant que ce decor valait 0. Neuvieme occurrence du
 * motif dans ce depot.
 */
const NAISSANCE = 1234.5;

/** Un vol unique, capture en (x, y) par `RAMASSEUR`, a l'instant `NAISSANCE`. */
function unVol(x: number, y: number, targetId = RAMASSEUR): OrbFlights {
  const flights = new OrbFlights(8);
  flights.spawn(x, y, targetId, avecOrbe(1), NAISSANCE);
  expect(flights.count).toBe(1);
  return flights;
}

/** L'horloge murale a laquelle lire un vol, `age` millisecondes apres sa capture. */
const aLAge = (age: number): number => NAISSANCE + age;

describe('OrbRenderer.draw — les orbes au sol', () => {
  it('pose une particule par orbe, a sa vraie position', () => {
    const drawn = drawnOrbs(unOrbe(1000, 1000));

    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.x).toBe(1000);
    expect(drawn[0]?.y).toBe(1000);
  });

  /**
   * ⚠️ **L'AUTRE MOITIE DE LA TACHE 20 : plus rien ne glisse.** L'attraction
   * par la distance de la tache 17 est SUPPRIMEE, `ORB_MAGNET_RADIUS` avec
   * elle. Une orbe qu'un joueur touche n'est pas « attiree » : elle est
   * ramassee — `DerivedOrbs.capture` l'a deja retiree de cette reserve et mise
   * en vol. Une orbe qui serait encore ici avec un joueur dessus est une orbe
   * que le serveur n'a pas prise, et la dessiner ailleurs qu'a sa place serait
   * exactement le mensonge que la tache evite.
   */
  it('ne deplace plus une orbe au sol, meme avec un joueur colle dessus', () => {
    const colle = drawnOrbs(unOrbe(1000, 1000), [
      { id: 1, x: 1000, y: 1000, pickupRadius: ORB_PICKUP_RADIUS },
    ]);
    expect(colle[0]?.x).toBe(1000);
    expect(colle[0]?.y).toBe(1000);

    const aPortee = drawnOrbs(unOrbe(1000, 1000), [
      { id: 1, x: 1000 + ORB_PICKUP_RADIUS - 1, y: 1000 + 1, pickupRadius: ORB_PICKUP_RADIUS },
    ]);
    expect(aPortee[0]?.x).toBe(1000);
    expect(aPortee[0]?.y).toBe(1000);
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
    const drawn = drawnOrbs(unOrbe(1000, 1000))[0];

    expect((drawn?.scaleX ?? 0) * ORB_TEXTURE_DIAMETER).toBeCloseTo(ORB_DIAMETER_PX, 6);
    expect(drawn?.scaleY).toBe(drawn?.scaleX);
    expect(ORB_TEXTURE_DIAMETER).not.toBe(ORB_DIAMETER_PX);
  });

  it('teint l orbe et la centre sur sa position', () => {
    const drawn = drawnOrbs(unOrbe(1000, 1000))[0];

    expect(drawn?.tint).toBe(ORB_TINT);
    expect(drawn?.anchorX).toBe(0.5);
    expect(drawn?.anchorY).toBe(0.5);
  });

  /**
   * La pulsation est EN TAILLE (retour de playtest : *« plus de contraste et
   * pulsation »*) : l'orbe reste opaque, son echelle respire autour de
   * `ORB_SCALE` et touche ses deux bornes. La piece, elle, ne bouge pas.
   */
  it('pulse en taille autour de ORB_SCALE, opaque, et touche les deux bornes', () => {
    // Douce : sensible, sans faire battre l'orbe (retour de playtest).
    expect(ORB_PULSE).toBeGreaterThan(0.03);
    expect(ORB_PULSE).toBeLessThanOrEqual(0.1);
    const orbs = new DerivedOrbs(MAX_ENTITIES);
    for (let k = 1; k <= 8; k++) {
      orbs.spawn(avecOrbe(k), 1000 + k, 1000, k * 7);
    }
    const { renderer, particules } = calque();

    let vu = { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
    for (let ms = 0; ms < 2 * ORB_PULSE_MS; ms += 1) {
      renderer.draw(orbs, new OrbFlights(8), [], TOUTE_LA_CARTE, ms);
      for (const p of particules()) {
        expect(p.alpha).toBe(1);
        expect(p.scaleX).toBe(p.scaleY);
        const r = p.scaleX / ORB_SCALE;
        vu = { min: Math.min(vu.min, r), max: Math.max(vu.max, r) };
      }
    }
    // Les bornes sont ATTEINTES : une pulsation figee satisferait aussi des
    // inegalites.
    expect(vu.min).toBeCloseTo(1 - ORB_PULSE, 3);
    expect(vu.max).toBeCloseTo(1 + ORB_PULSE, 3);
  });

  /**
   * ⚠️ **La marge de culling est celle du DESSIN, depuis la tache 20** : une
   * orbe dont le centre vient de sortir du cadre en montre encore la moitie.
   * Elle valait `ORB_MAGNET_RADIUS` (180 px) tant qu'une orbe pouvait etre
   * dessinee loin de sa vraie place ; ce rayon a disparu, et une marge huit
   * fois trop large est une marge que rien ne justifie.
   */
  it('garde une orbe a cheval sur le bord du cadre, des QUATRE cotes', () => {
    const vue = new Rectangle(0, 0, 800, 800);
    const dehors = ORB_DIAMETER_PX / 2 - 1;
    const cotes: [number, number][] = [
      [800 + dehors, 400],
      [-dehors, 400],
      [400, 800 + dehors],
      [400, -dehors],
    ];

    for (const [x, y] of cotes) {
      expect(drawnOrbs(unOrbe(x, y), [], vue), `cote ${x},${y}`).toHaveLength(1);
    }
  });

  it('ecarte une orbe entierement hors cadre', () => {
    const vue = new Rectangle(0, 0, 800, 800);

    expect(drawnOrbs(unOrbe(800 + ORB_DIAMETER_PX, 400), [], vue)).toHaveLength(0);
  });

  it('ne dessine rien tant qu aucune texture n a ete adoptee', () => {
    const renderer = new OrbRenderer();
    const world = new Container();
    renderer.attach(world);
    renderer.draw(unOrbe(1000, 1000), unVol(1000, 1000), [], TOUTE_LA_CARTE, 0);

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

describe('OrbRenderer.draw — l orbe capturee rejoint son ramasseur', () => {
  it('part du point de capture, pas du joueur', () => {
    const drawn = dessine(
      new DerivedOrbs(MAX_ENTITIES),
      unVol(1000, 1000),
      [{ id: RAMASSEUR, x: 1000 + ORB_PICKUP_RADIUS, y: 1000, pickupRadius: ORB_PICKUP_RADIUS }],
      TOUTE_LA_CARTE,
      aLAge(0),
    );

    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.x).toBe(1000);
    expect(drawn[0]?.y).toBe(1000);
  });

  /**
   * ⚠️ **LE TEST QUI SEPARE LES DEUX MODELES**, et la seule assertion qui le
   * fasse. Le joueur capture l'orbe au rayon de ramassage puis S'EN ELOIGNE,
   * jusqu'a trois fois ce rayon — au-dela des 180 px ou l'aimantation de la
   * tache 17 rendait deja zero. Avec elle, l'orbe serait dessinee exactement a
   * sa place au sol, a `3 × ORB_PICKUP_RADIUS` du joueur ; ici elle est SUR
   * lui, et a trois rayons de la ou elle etait tombee.
   *
   * Un test qui verifierait seulement « l'orbe s'est rapprochee » passerait
   * avec les deux modeles, et ne prouverait rien.
   */
  it('finit SUR un joueur qui s eloigne, pas a sa place au sol', () => {
    const fuyard = {
      id: RAMASSEUR,
      x: 1000 + 3 * ORB_PICKUP_RADIUS,
      y: 1000,
      pickupRadius: ORB_PICKUP_RADIUS,
    };
    const drawn = dessine(
      new DerivedOrbs(MAX_ENTITIES),
      unVol(1000, 1000),
      [fuyard],
      TOUTE_LA_CARTE,
      aLAge(ORB_FLIGHT_LIFETIME_MS),
    )[0];

    expect(Math.hypot((drawn?.x ?? 0) - fuyard.x, (drawn?.y ?? 0) - fuyard.y)).toBeCloseTo(0, 6);
    expect(Math.hypot((drawn?.x ?? 0) - 1000, (drawn?.y ?? 0) - 1000)).toBeCloseTo(
      3 * ORB_PICKUP_RADIUS,
      6,
    );
  });

  /**
   * ⚠️ **Les DEUX axes.** Un decor ou le joueur ne fuit qu'en x laisse
   * `particle.y = fromY` passer pour un vol : c'est la mutation qui a survecu
   * a 289 tests verts a la tache 17, avec l'aimantation.
   */
  it('rejoint aussi en Y : l orbe arrive sur le joueur, pas sur sa colonne', () => {
    const fuyard = {
      id: RAMASSEUR,
      x: 1000 + 2 * ORB_PICKUP_RADIUS,
      y: 1000 - 2 * ORB_PICKUP_RADIUS,
      pickupRadius: ORB_PICKUP_RADIUS,
    };
    const drawn = dessine(
      new DerivedOrbs(MAX_ENTITIES),
      unVol(1000, 1000),
      [fuyard],
      TOUTE_LA_CARTE,
      aLAge(ORB_FLIGHT_LIFETIME_MS),
    )[0];

    expect(drawn?.x).toBeCloseTo(fuyard.x, 6);
    expect(drawn?.y).toBeCloseTo(fuyard.y, 6);
  });

  /**
   * L'image qui compte vraiment : la DERNIERE dessinee avant qu'`OrbFlights.expire`
   * ne retire le vol. A 60 Hz elle tombe une image avant l'echeance, et l'orbe y
   * est deja sur le joueur — a moins d'un demi-diametre, donc invisible a l'oeil.
   */
  it('est deja arrivee a la derniere image dessinee, un rafraichissement avant l echeance', () => {
    const fuyard = {
      id: RAMASSEUR,
      x: 1000 + 3 * ORB_PICKUP_RADIUS,
      y: 1000,
      pickupRadius: ORB_PICKUP_RADIUS,
    };
    const drawn = dessine(
      new DerivedOrbs(MAX_ENTITIES),
      unVol(1000, 1000),
      [fuyard],
      TOUTE_LA_CARTE,
      aLAge(ORB_FLIGHT_LIFETIME_MS - 1000 / 60),
    )[0];

    expect(Math.hypot((drawn?.x ?? 0) - fuyard.x, (drawn?.y ?? 0) - fuyard.y)).toBeLessThan(
      ORB_DIAMETER_PX / 2,
    );
  });

  /**
   * ⚠️ **Le joueur qui l'a RAMASSEE, pas le plus proche.** C'est la difference
   * entre suivre quelqu'un et viser un point : `OrbFlights` porte une identite,
   * relue a chaque image. Viser le plus proche ferait changer l'orbe de cible
   * en plein vol quand deux joueurs se croisent.
   */
  it('vise le joueur qui l a capturee, meme si un autre est plus pres', () => {
    const ramasseur = {
      id: RAMASSEUR,
      x: 1000 + 4 * ORB_PICKUP_RADIUS,
      y: 1000,
      pickupRadius: ORB_PICKUP_RADIUS,
    };
    const voisin = {
      id: RAMASSEUR + 1,
      x: 1000 + ORB_PICKUP_RADIUS,
      y: 1000,
      pickupRadius: ORB_PICKUP_RADIUS,
    };
    const drawn = dessine(
      new DerivedOrbs(MAX_ENTITIES),
      unVol(1000, 1000),
      [voisin, ramasseur],
      TOUTE_LA_CARTE,
      aLAge(ORB_FLIGHT_LIFETIME_MS),
    )[0];

    expect(drawn?.x).toBeCloseTo(ramasseur.x, 6);
  });

  it('ne dessine rien quand le joueur vise n est plus a l ecran', () => {
    const drawn = dessine(new DerivedOrbs(MAX_ENTITIES), unVol(1000, 1000), [
      { id: RAMASSEUR + 1, x: 1000, y: 1000, pickupRadius: ORB_PICKUP_RADIUS },
    ]);

    expect(drawn).toHaveLength(0);
  });

  /**
   * La pulsation est un APPEL — « je suis la, viens me prendre ». Une orbe deja
   * ramassee n'appelle plus : elle est pleine, et c'est ce qui la distingue a
   * l'oeil de celles qui restent au sol : ni pulsation de taille, ni d'opacite.
   *
   * ⚠️ **Sur une particule qui pulsait a l'image d'avant**, et pas sur un
   * calque neuf : le reservoir est REUTILISE d'une image a l'autre, donc une
   * particule qui vient de servir au sol arrive avec l'opacite de sa
   * pulsation. Sur un calque neuf, `alpha` vaut deja 1 par defaut — retirer la
   * ligne de production ne changerait rien, et la mutation survivrait.
   */
  it('ne pulse plus une fois capturee, meme sur une particule qui pulsait a l image d avant', () => {
    const { renderer, particules } = calque();
    const auSol = unOrbe(1000, 1000);
    const cible = { id: RAMASSEUR, x: 1100, y: 1000, pickupRadius: ORB_PICKUP_RADIUS };

    // L'orbe au sol prend la particule du reservoir et la laisse gonflee ou
    // contractee par sa pulsation.
    let creuxMs = -1;
    for (let ms = 0; ms < 2000 && creuxMs < 0; ms += 1) {
      renderer.draw(auSol, new OrbFlights(8), [], TOUTE_LA_CARTE, ms);
      if (Math.abs((particules()[0]?.scaleX ?? ORB_SCALE) - ORB_SCALE) > ORB_SCALE * 0.05) {
        creuxMs = ms;
      }
    }
    expect(creuxMs).toBeGreaterThanOrEqual(0);

    // La MEME particule sert au vol a l'image suivante : elle doit repasser
    // pleine.
    for (const age of [0, ORB_FLIGHT_LIFETIME_MS / 2, ORB_FLIGHT_LIFETIME_MS]) {
      renderer.draw(
        new DerivedOrbs(MAX_ENTITIES),
        unVol(1000, 1000),
        [cible],
        TOUTE_LA_CARTE,
        aLAge(age),
      );
      expect(particules()[0]?.alpha, `a ${age} ms de vol`).toBe(1);
      expect(particules()[0]?.scaleX, `a ${age} ms de vol`).toBe(ORB_SCALE);
    }
  });

  /**
   * ⚠️ **Culle sur la position DESSINEE, pas sur le point de capture.** Un vol
   * ne dans le dos de la camera arrive vers un joueur qui, lui, est a l'ecran :
   * l'ecarter sur son point de depart le ferait manquer tout du long.
   */
  it('apparait quand le vol entre dans le cadre, meme parti de tres loin', () => {
    const vue = new Rectangle(0, 0, 800, 800);
    const depart: [number, number] = [800 + 4 * ORB_PICKUP_RADIUS, 400];
    const cible = { id: RAMASSEUR, x: 400, y: 400, pickupRadius: ORB_PICKUP_RADIUS };

    const auDepart = dessine(
      new DerivedOrbs(MAX_ENTITIES),
      unVol(...depart),
      [cible],
      vue,
      aLAge(0),
    );
    const aLArrivee = dessine(
      new DerivedOrbs(MAX_ENTITIES),
      unVol(...depart),
      [cible],
      vue,
      aLAge(ORB_FLIGHT_LIFETIME_MS),
    );

    expect(auDepart).toHaveLength(0);
    expect(aLArrivee).toHaveLength(1);
    expect(aLArrivee[0]?.x).toBeCloseTo(cible.x, 6);
  });

  /**
   * ⚠️ **Le reservoir couvre les DEUX collections.** Le dimensionner sur les
   * seules orbes au sol laisserait les vols sans particule des que le sol est
   * plein — et un `break` silencieux les ferait disparaitre a la capture.
   */
  it('dessine le sol ET les vols dans la meme image', () => {
    const orbs = new DerivedOrbs(MAX_ENTITIES);
    orbs.spawn(avecOrbe(1), 2000, 2000, 0);
    orbs.spawn(avecOrbe(2), 2100, 2000, 0);
    const flights = new OrbFlights(8);
    flights.spawn(1000, 1000, RAMASSEUR, avecOrbe(1), NAISSANCE);

    const drawn = dessine(
      orbs,
      flights,
      [{ id: RAMASSEUR, x: 1200, y: 1000, pickupRadius: ORB_PICKUP_RADIUS }],
      TOUTE_LA_CARTE,
      aLAge(0),
    );

    expect(drawn).toHaveLength(3);
  });
});

/** Un trace pose sur le canevas : une forme remplie, ou un contour trace. */
interface Trace {
  readonly kind: 'fill' | 'stroke';
  /** Opacite lue dans le `rgba(...)` courant. */
  readonly alpha: number | null;
  /** Le niveau de gris (canal rouge) du `rgba(...)` courant, sur 255. */
  readonly gray: number | null;
  readonly width: number;
  /** Rayon du dernier `arc` decrit (0 pour un polygone). */
  readonly r: number;
  /** Abscisse du dernier point decrit : la case de l'atlas (orbe < 64 <= piece). */
  readonly x: number;
  /** La forme : un arc, une ellipse ou un polygone. */
  readonly shape: 'arc' | 'ellipse' | 'poly';
}

const traces: Trace[] = [];
const dansLOrbe = (t: Trace): boolean => t.x < ORB_TEXTURE_DIAMETER;
const dansLaPiece = (t: Trace): boolean => t.x >= ORB_TEXTURE_DIAMETER;

function canalDe(style: unknown, k: number): number | null {
  if (typeof style !== 'string') {
    return null;
  }
  const parsed = /rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/.exec(style);
  return parsed ? Number(parsed[k + 1]) : null;
}
const alphaDe = (style: unknown): number | null => canalDe(style, 3);

/**
 * Bouchonne le contexte 2D et cuit l'atlas des objets au sol POUR DE VRAI, via
 * `load()`. jsdom ne fournit pas de contexte 2D, et le bouchon ne fait pas
 * rien — il ENREGISTRE chaque forme posee, sa couleur et sa place.
 *
 * ⚠️ **Un bouchon incomplet ne fait pas ROUGIR, il fait DISPARAITRE.** Tout ce
 * que la texture appelle doit exister ici, sinon `load()` leve dans le
 * `beforeAll` et le bloc entier passe « skipped », vert sans rien mesurer.
 */
function bakeDropAtlas(): void {
  traces.length = 0;
  const noop = (): void => undefined;
  let dernierArc = 0;
  let dernierX = 0;
  let forme: Trace['shape'] = 'poly';
  const context = {
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 0,
    lineJoin: '',
    beginPath: noop,
    closePath: noop,
    moveTo: (x: number): void => {
      dernierX = x;
      dernierArc = 0;
      forme = 'poly';
    },
    lineTo: (x: number): void => {
      dernierX = x;
    },
    arc: (x: number, _y: number, r: number): void => {
      dernierX = x;
      dernierArc = r;
      forme = 'arc';
    },
    ellipse: (x: number): void => {
      dernierX = x;
      dernierArc = 0;
      forme = 'ellipse';
    },
    fill(): void {
      traces.push({
        kind: 'fill',
        alpha: alphaDe(context.fillStyle),
        gray: canalDe(context.fillStyle, 0),
        width: 0,
        r: dernierArc,
        x: dernierX,
        shape: forme,
      });
    },
    stroke(): void {
      traces.push({
        kind: 'stroke',
        alpha: alphaDe(context.strokeStyle),
        gray: canalDe(context.strokeStyle, 0),
        width: context.lineWidth,
        r: dernierArc,
        x: dernierX,
        shape: forme,
      });
    },
  };
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: () => unknown };
  proto.getContext = (): unknown => context;

  const renderer = new OrbRenderer();
  renderer.load();
  expect(renderer.loaded).toBe(true);
}

/**
 * L'orbe d'experience, retravaillee au playtest : *« plus de contraste »*. Une
 * GEMME a facettes plutot qu'un disque — ce bloc garde sa FORME par des
 * relations, jamais une recopie des valeurs de production.
 */
describe('l atlas des objets au sol — l orbe est une bille contrastee', () => {
  beforeAll(bakeDropAtlas);

  it('reste RONDE : ni polygone, ni losange', () => {
    const orbe = traces.filter((t) => dansLOrbe(t) && t.shape !== 'ellipse');
    expect(orbe.length).toBeGreaterThan(0);
    expect(orbe.every((t) => t.shape === 'arc')).toBe(true);
  });

  it('pose au moins trois tons opaques DIFFERENTS : du relief, pas un aplat', () => {
    const tons = traces.filter(
      (t) => dansLOrbe(t) && t.kind === 'fill' && t.shape === 'arc' && t.alpha === 1,
    );
    expect(new Set(tons.map((t) => t.gray)).size).toBeGreaterThanOrEqual(3);
    expect(Math.max(...ORB_SHADES) - Math.min(...ORB_SHADES)).toBeGreaterThan(0.3);
  });

  it('cerne la bille d un contour NOIR, opaque et epais, jusqu au bord de la case', () => {
    const contour = traces.find((t) => dansLOrbe(t) && t.kind === 'stroke');
    expect(contour?.alpha).toBe(1);
    expect(contour?.gray ?? 255).toBeLessThan(40);
    expect(contour?.width ?? 0).toBeGreaterThanOrEqual((ORB_TEXTURE_DIAMETER / 2) * 0.1);
    expect((contour?.r ?? 0) + (contour?.width ?? 0) / 2).toBeCloseTo(ORB_TEXTURE_DIAMETER / 2, 6);
  });

  it('pose une ombre douce dessous, noire et translucide', () => {
    const ombre = traces.find((t) => dansLOrbe(t) && t.shape === 'ellipse');
    expect(ombre?.gray).toBe(0);
    expect(ombre?.alpha ?? 1).toBeLessThan(1);
    expect(ombre?.alpha ?? 0).toBeGreaterThan(0);
  });
});

/**
 * La PIECE (etape 6a, tache 14) — *« les monstres ne droppent pas d'or j'ai
 * l'impression, t'as l'icone dans UI Elements/Icons/Icon_03 »*.
 *
 * ⚠️ **Redessinee en code, pas importee.** Aucun asset n'entre dans ce depot
 * (licence Pixel Frog, depot public, la CI echoue sur
 * `git ls-files | grep '^assets/tinyswords'`), et l'atlas des monstres est deja
 * a 9,33 Mpx sur 16,78 — la tache 5 a du y renoncer a cinq elites. Ce bloc
 * garde la FORME frappee : une face, un lisere, un cerne grave.
 */
describe('l atlas des objets au sol — la piece est FRAPPEE, pas un jeton', () => {
  beforeAll(bakeDropAtlas);

  /**
   * ⚠️ **Deux cases, jamais une.** Une seule case rendrait la meme texture aux
   * deux natures et « la piece se dessine comme une piece » n'aurait plus de
   * sens — le calque entier redeviendrait celui d'avant la tache.
   */
  it('cuit DEUX cases cote a cote, et les decoupe a la bonne place', () => {
    expect(dropCellRect(DROP_ORB_CELL)).toEqual({
      x: 0,
      y: 0,
      w: ORB_TEXTURE_DIAMETER,
      h: ORB_TEXTURE_DIAMETER,
    });
    expect(dropCellRect(DROP_COIN_CELL).x).toBe(ORB_TEXTURE_DIAMETER);
    expect(dropCellRect(DROP_COIN_CELL).x).not.toBe(dropCellRect(DROP_ORB_CELL).x);
  });

  /**
   * Le profil de la piece, en RELATIONS et jamais en valeurs recopiees : une
   * face pleine mais sous le bord, un lisere opaque au bord, et un cerne grave
   * PLUS SOMBRE que la face, a l'interieur.
   */
  it('pose une face, un lisere opaque au bord, et un cerne plus sombre dedans', () => {
    // Le premier remplissage est l'orbe (degrade, donc `alpha` nul) ; le second
    // est la face de la piece.
    const remplissages = traces.filter((t) => dansLaPiece(t) && t.kind === 'fill');
    const face = remplissages[0];
    // Le lisere, le cerne, puis le contour sombre de la piece.
    const [lisere, cerne, contour] = traces.filter((t) => dansLaPiece(t) && t.kind === 'stroke');

    expect(remplissages).toHaveLength(1);
    expect(face?.alpha).toBeGreaterThan(0);
    expect(face?.alpha).toBeLessThan(1);

    // Le lisere : opaque, et pose au bord de la piece, DANS le contour.
    expect(lisere?.alpha).toBe(1);
    expect((lisere?.r ?? 0) + (lisere?.width ?? 0) / 2).toBeCloseTo(
      (ORB_TEXTURE_DIAMETER / 2) * (1 - DROP_OUTLINE),
      6,
    );
    // Et le contour sombre, opaque, jusqu'au bord de la case.
    expect(contour?.alpha).toBe(1);
    expect((contour?.r ?? 0) + (contour?.width ?? 0) / 2).toBeCloseTo(ORB_TEXTURE_DIAMETER / 2, 6);

    // Le cerne : plus sombre que la face — sinon il ne se lit pas comme un
    // creux — et franchement a l'interieur, pas colle au lisere.
    expect(cerne?.alpha).toBeLessThan(face?.alpha ?? 0);
    expect(cerne?.r ?? 0).toBeLessThan((lisere?.r ?? 0) - (lisere?.width ?? 0));
    expect(cerne?.r ?? 0).toBeGreaterThan(0);
  });

  /**
   * ⚠️ **En niveaux de gris, comme l'orbe et pour la meme raison** : `tint`
   * MULTIPLIE, donc une piece cuite en or ne pourrait plus etre teintee et
   * `COIN_TINT` ne servirait a rien. Aucun trace n'a de couleur.
   */
  it('cuit la piece en niveaux de gris, la teinte restant a la particule', () => {
    expect(COIN_TINT).not.toBe(0xffffff);
    expect(COIN_TINT).not.toBe(ORB_TINT);
  });

  /**
   * Le profil de la piece est DIFFERENT de celui de l'orbe : les deux se
   * croisent au sol, elles ne doivent pas se distinguer par la seule teinte.
   * L'orbe est creuse au milieu, la piece est pleine.
   */
  it('ne se confond pas avec l orbe : l une est en relief opaque, l autre a une face translucide', () => {
    const tonsOrbe = traces.filter((t) => dansLOrbe(t) && t.kind === 'fill' && t.alpha === 1);
    const facePiece = traces.find((t) => dansLaPiece(t) && t.kind === 'fill');
    expect(tonsOrbe.length).toBeGreaterThanOrEqual(3);
    expect(facePiece?.alpha ?? 1).toBeLessThan(1);
  });
});

/**
 * La piece DESSINEE : sa case, sa taille et sa teinte se deduisent de
 * l'identite du monstre qui l'a laissee — **sans un octet de plus sur le fil**,
 * exactement comme l'existence de l'orbe se derive deja de `DEATHS`.
 */
describe('OrbRenderer.draw — une piece ne se dessine pas comme une orbe', () => {
  /** Une identite dont la mort laisse VRAIMENT une piece. Derivee, jamais recopiee. */
  const avecPiece = (n: number): number => n * COIN_DROP_ONE_IN + COIN_DROP_RESIDUE;

  it('le decor ne ment pas : les deux natures sont disjointes', () => {
    expect(dropsOrb(avecOrbe(3))).toBe(true);
    expect(dropsCoin(avecOrbe(3))).toBe(false);
    expect(dropsCoin(avecPiece(3))).toBe(true);
    expect(dropsOrb(avecPiece(3))).toBe(false);
  });

  it('pose la piece a sa case, a sa taille et a sa teinte', () => {
    const orbs = new DerivedOrbs(MAX_ENTITIES);
    orbs.spawn(avecPiece(1), 2000, 2000, 0);
    const [particule] = drawnOrbs(orbs);

    expect(particule?.tint).toBe(COIN_TINT);
    expect(particule?.scaleX).toBeCloseTo(COIN_SCALE, 6);
    expect(particule?.scaleY).toBeCloseTo(COIN_SCALE, 6);
    expect(particule?.texture.frame.x).toBe(dropCellRect(DROP_COIN_CELL).x);
  });

  /**
   * **L'autre moitie**, sans laquelle « tout est une piece » passerait : une
   * orbe reste une orbe, dans la meme image.
   */
  it('laisse l orbe a sa case, a sa taille et a sa teinte, dans la meme image', () => {
    const orbs = new DerivedOrbs(MAX_ENTITIES);
    orbs.spawn(avecOrbe(1), 2000, 2000, 0);
    orbs.spawn(avecPiece(1), 2400, 2000, 0);
    const dessinees = drawnOrbs(orbs);

    const orbe = dessinees.find((p) => p.x === 2000);
    const piece = dessinees.find((p) => p.x === 2400);
    expect(orbe?.tint).toBe(ORB_TINT);
    expect(orbe?.scaleX).toBeCloseTo(ORB_SCALE, 6);
    expect(orbe?.texture.frame.x).toBe(dropCellRect(DROP_ORB_CELL).x);
    expect(piece?.tint).toBe(COIN_TINT);
    // Non-vacuite : les deux natures ne se dessinent pas pareil, ni en taille
    // ni en case — c'est cela qui rend la mutation « toujours l'orbe » visible.
    expect(COIN_SCALE).not.toBe(ORB_SCALE);
    expect(dropCellRect(DROP_COIN_CELL).x).not.toBe(dropCellRect(DROP_ORB_CELL).x);
  });

  /**
   * ⚠️ **Une piece qui vole reste une piece.** Le vol ne sait rien du sol : sans
   * `OrbFlights.dropId`, la piece capturee redeviendrait une orbe verte a
   * l'instant precis ou elle decolle vers le joueur.
   */
  it('garde son apparence une fois capturee et en vol', () => {
    const flights = new OrbFlights(8);
    flights.spawn(1000, 1000, RAMASSEUR, avecPiece(2), NAISSANCE);
    const dessinees = dessine(
      new DerivedOrbs(MAX_ENTITIES),
      flights,
      [{ id: RAMASSEUR, x: 1200, y: 1000, pickupRadius: ORB_PICKUP_RADIUS }],
      TOUTE_LA_CARTE,
      aLAge(0),
    );

    expect(dessinees).toHaveLength(1);
    expect(dessinees[0]?.tint).toBe(COIN_TINT);
    expect(dessinees[0]?.texture.frame.x).toBe(dropCellRect(DROP_COIN_CELL).x);
  });
});
