import {
  MAP_SIZE,
  ROLLBACK_DEPTH_TICKS,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
} from '@shared/constants';
import { ELEMENT } from '@shared/elements';
import { ZoneField } from '@shared/zones';
import { describe, expect, it } from 'vitest';

import { selectZones, ZONE_TEXTURE_DIAMETER, ZoneRenderer, zoneScale } from './zone-renderer';

/** Une vue qui couvre toute la carte : le culling ne doit alors rien retirer. */
const TOUTE_LA_CARTE = { x: 0, y: 0, width: MAP_SIZE, height: MAP_SIZE };

/**
 * Étape 5a, §9 / §6.6 de l'orientation : *« zone au sol : grand quad teinte,
 * additif »*.
 *
 * Le rendu proprement dit n'est pas observable en test — `load()` a besoin
 * d'un canevas 2D que ni `node` ni jsdom (sans le paquet `canvas`) ne
 * fournissent. Ce qui l'est, c'est la DECISION que ce renderer prend avant de
 * dessiner : quelles zones, a quelle taille, et dans quel mode de fusion.
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
