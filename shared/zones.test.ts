import { describe, expect, it } from 'vitest';

import {
  ZONE_CAPACITY,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
  ZONE_REFRESH_INTERVAL_TICKS,
} from './constants';
import { ELEMENT, elementOf } from './elements';
import { packZoneKind, zoneElement } from './protocol';
import { ZoneField } from './zones';

/**
 * ⚠️ **Aucune assertion de ce fichier n'ecrit 90, 70 ou 128 en dur.** Les
 * trois constantes sont des reglages : `ZONE_LIFETIME_TICKS` et `ZONE_RADIUS`
 * se jugent a l'oeil (tache 11), `ZONE_CAPACITY` bougera avec le budget. Le
 * depot vient de payer l'erreur inverse — deux tests de troncature de vague se
 * fiaient a `WAVE1_MIN_COUNT = 16` et sont devenus intermittents des qu'il est
 * passe a 10.
 */

/** Ecart sur lequel deux zones ne peuvent en aucun cas fusionner ni se recouvrir. */
const BIEN_LOIN = ZONE_RADIUS * 4;

describe('ZoneField — la pose', () => {
  it('pose une zone et porte ses cinq champs', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 12, -34, 3, 7);

    expect(zones.count).toBe(1);
    expect(zones.kind[0]).toBe(ELEMENT.BRAISE);
    expect(zones.x[0]).toBe(12);
    expect(zones.y[0]).toBe(-34);
    expect(zones.by[0]).toBe(3);
    expect(zones.bornTick[0]).toBe(7);
  });

  /**
   * ⚠️ **Les deux moities comptent.** Sans la seconde, une fusion qui avale
   * TOUT — « ne jamais poser au-dela de la premiere zone » — passerait ce
   * test les yeux fermes. C'est le §5.1 bis : le compte devient fonction de la
   * SURFACE couverte, pas de la cadence.
   */
  it('mille poses au meme endroit ne font qu une zone', () => {
    const zones = new ZoneField();
    for (let tick = 0; tick < 1000; tick++) {
      zones.spawn(ELEMENT.BRAISE, 500, 500, 0, tick);
    }

    expect(zones.count).toBe(1);
    expect(zones.truncatedZones).toBe(0);
  });

  it('des poses etalees en font autant de zones', () => {
    const zones = new ZoneField();
    for (let i = 0; i < ZONE_CAPACITY; i++) {
      zones.spawn(ELEMENT.BRAISE, i * BIEN_LOIN, 0, 0, 0);
    }

    expect(zones.count).toBe(ZONE_CAPACITY);
    expect(zones.truncatedZones).toBe(0);
  });

  /**
   * Le rayon de fusion est `ZONE_RADIUS`, pas le diametre : c'est le POINT qui
   * doit tomber dans une zone existante. A la distance exacte, le point est sur
   * le bord, donc dehors — un `<=` ici ferait fusionner deux poses qui ne se
   * couvrent pas.
   */
  it('fusionne a un pixel sous le rayon, plus a la distance exacte', () => {
    const tangent = new ZoneField();
    tangent.spawn(ELEMENT.BRAISE, 0, 0, 0, 0);
    tangent.spawn(ELEMENT.BRAISE, ZONE_RADIUS, 0, 0, 0);
    expect(tangent.count).toBe(2);

    const dedans = new ZoneField();
    dedans.spawn(ELEMENT.BRAISE, 0, 0, 0, 0);
    dedans.spawn(ELEMENT.BRAISE, ZONE_RADIUS - 1, 0, 0, 0);
    expect(dedans.count).toBe(1);
  });

  /**
   * ⚠️ **La fusion est PAR ELEMENT.** Fusionner deux elements differents
   * supprimerait la seconde voie de declenchement du §6.3 de l'orientation —
   * « deux zones au sol se recouvrent » — avant meme qu'elle existe.
   */
  it('ne fusionne pas deux elements differents au meme endroit', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 500, 500, 0, 0);
    zones.spawn(ELEMENT.GIVRE, 500, 500, 1, 0);

    expect(zones.count).toBe(2);
    expect(zones.kind[0]).toBe(ELEMENT.BRAISE);
    expect(zones.kind[1]).toBe(ELEMENT.GIVRE);
  });

  /**
   * ⚠️ **PAR ELEMENT reste vrai meme quand deux octets DIFFERENT** (tache 5 de
   * l'etape 5b). Deux `kind` du meme element mais de types de reaction
   * distincts sont deux octets differents — s'ils n'etaient PAS decodes avant
   * d'etre compares, `spawn` les traiterait comme deux elements differents et
   * poserait une seconde zone au lieu de fusionner. `kind !== element` ici
   * pour chacun des deux appels : un test qui n'empaquetterait qu'avec une
   * reaction nulle ne distinguerait rien d'une fonction identite.
   */
  it('fusionne deux memes elements meme si leurs types de reaction empaquetes different', () => {
    const zones = new ZoneField();
    const premier = packZoneKind(ELEMENT.BRAISE, 3);
    const second = packZoneKind(ELEMENT.BRAISE, 9);
    expect(premier).not.toBe(ELEMENT.BRAISE);
    expect(second).not.toBe(ELEMENT.BRAISE);
    expect(premier).not.toBe(second);

    zones.spawn(premier, 500, 500, 0, 0);
    zones.spawn(second, 500, 500, 1, 0);

    expect(zones.count).toBe(1);
  });

  /**
   * ⚠️ **La pose doit stocker l'octet COMPLET, jamais le seul element decode**
   * — sinon le type de reaction empaquete disparaitrait des la creation, avant
   * meme d'avoir pu voyager. `kind !== element` : un `packZoneKind(x, 0)`
   * n'aurait rien distingue.
   */
  it('stocke le kind empaquete tel quel, reaction comprise', () => {
    const zones = new ZoneField();
    const kind = packZoneKind(ELEMENT.GIVRE, 11);
    expect(kind).not.toBe(ELEMENT.GIVRE);

    const slot = zones.spawn(kind, 500, 500, 0, 0);

    expect(zones.kind[slot]).toBe(kind);
  });

  it('la fusion rafraichit le bornTick, et laisse le poseur d origine', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 500, 500, 2, 0);
    zones.spawn(ELEMENT.BRAISE, 500, 500, 3, ZONE_REFRESH_INTERVAL_TICKS);

    expect(zones.count).toBe(1);
    expect(zones.bornTick[0]).toBe(ZONE_REFRESH_INTERVAL_TICKS);
    expect(zones.by[0]).toBe(2);
  });

  /**
   * **L'annonce EST la verite** (§5.1 bis, tache 10). Une zone n'est prolongee
   * qu'au plus une fois par `ZONE_REFRESH_INTERVAL_TICKS` : entre deux, le
   * serveur ne prolonge PAS non plus, sans quoi il faudrait annoncer chaque
   * fusion et le trafic suivrait la cadence des armes au lieu du nombre de
   * zones (mesure : 9,67 ko/s par client a 30 zones arrosees a chaque tick,
   * contre 1,22 ko/s de trafic total a l'etape 4).
   *
   * ⚠️ **La date exacte compte des deux cotes.** Le client applique ce meme
   * `spawn` : s'il prolongeait un tick plus tot ou plus tard que le serveur,
   * sa zone de Givre mourrait a un autre tick, et le ralentissement — donc le
   * DEPLACEMENT — divergerait. On teste donc le tick d'avant et le tick pile.
   */
  it('ne prolonge pas avant l intervalle, et prolonge pile a l intervalle', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 500, 500, 2, 0);

    expect(zones.spawn(ELEMENT.BRAISE, 500, 500, 2, ZONE_REFRESH_INTERVAL_TICKS - 1)).toBe(0);
    expect(zones.bornTick[0], 'la zone a ete prolongee avant l intervalle').toBe(0);

    expect(zones.spawn(ELEMENT.BRAISE, 500, 500, 2, ZONE_REFRESH_INTERVAL_TICKS)).toBe(0);
    expect(zones.bornTick[0]).toBe(ZONE_REFRESH_INTERVAL_TICKS);
  });

  /**
   * Le chiffre que la parade borne, mis en scene : une zone arrosee a CHAQUE
   * tick pendant plusieurs vies de zone. Les prolongations doivent croitre
   * avec le TEMPS, jamais avec la cadence.
   */
  it('une zone arrosee a chaque tick n est prolongee qu une fois par intervalle', () => {
    const zones = new ZoneField();
    const ticks = ZONE_LIFETIME_TICKS * 4;
    let prolongations = 0;
    for (let tick = 0; tick <= ticks; tick++) {
      zones.expire(tick);
      zones.spawn(ELEMENT.BRAISE, 500, 500, 0, tick);
      if (zones.bornTick[0] === tick && tick > 0) {
        prolongations++;
      }
    }

    // Le decor a bien arrose a chaque tick : sans ce compte, « peu de
    // prolongations » se lirait aussi bien « peu de poses ».
    expect(ticks).toBeGreaterThan(ZONE_REFRESH_INTERVAL_TICKS * 4);
    expect(prolongations).toBe(Math.floor(ticks / ZONE_REFRESH_INTERVAL_TICKS));
  });

  /**
   * Le comportement que la regle de pose promet : « un joueur qui arrose le
   * meme endroit entretient une zone ». Sans le rafraichissement, elle meurt
   * au tick `ZONE_LIFETIME_TICKS` malgre les poses.
   */
  it('une zone entretenue ne meurt pas', () => {
    const zones = new ZoneField();
    for (let tick = 0; tick < ZONE_LIFETIME_TICKS * 3; tick++) {
      zones.expire(tick);
      zones.spawn(ELEMENT.BRAISE, 500, 500, 0, tick);
      expect(zones.count).toBe(1);
    }
  });
});

describe('ZoneField — le plafond', () => {
  it('expose la capacite partagee par les deux cotes du fil', () => {
    expect(new ZoneField().capacity).toBe(ZONE_CAPACITY);
  });

  /**
   * ⚠️ **Une zone qui ne se pose pas est un effet que le joueur a paye et qui
   * ne se voit pas.** Meme motif que `Projectiles.truncatedProjectiles` : sans
   * ce compteur, la zone manquante ne se verrait nulle part.
   */
  it('tronque au plafond et cumule le compte des zones perdues', () => {
    const zones = new ZoneField();
    const perdues = 5;
    for (let i = 0; i < ZONE_CAPACITY + perdues; i++) {
      zones.spawn(ELEMENT.BRAISE, i * BIEN_LOIN, 0, 0, 0);
    }

    expect(zones.count).toBe(ZONE_CAPACITY);
    expect(zones.truncatedZones).toBe(perdues);

    const encore = 3;
    for (let i = 0; i < encore; i++) {
      zones.spawn(ELEMENT.GIVRE, -(i + 1) * BIEN_LOIN, 0, 0, 0);
    }

    expect(zones.count).toBe(ZONE_CAPACITY);
    expect(zones.truncatedZones).toBe(perdues + encore);
  });

  /**
   * La fusion passe AVANT le plafond, et l'ordre des deux gardes se voit :
   * une reserve pleine doit continuer d'entretenir ce qui existe deja, sans
   * compter une troncature qui n'a pas eu lieu — sinon une arme cesse
   * simplement de faire effet des que la carte est bien couverte.
   */
  it('rafraichit encore une zone existante quand la reserve est pleine', () => {
    const zones = new ZoneField();
    for (let i = 0; i < ZONE_CAPACITY; i++) {
      zones.spawn(ELEMENT.BRAISE, i * BIEN_LOIN, 0, 0, 0);
    }
    expect(zones.count).toBe(ZONE_CAPACITY);

    zones.spawn(ELEMENT.BRAISE, 0, 0, 0, ZONE_REFRESH_INTERVAL_TICKS);

    expect(zones.count).toBe(ZONE_CAPACITY);
    expect(zones.truncatedZones).toBe(0);
    expect(zones.bornTick[0]).toBe(ZONE_REFRESH_INTERVAL_TICKS);
  });
});

describe('ZoneField — l expiration derivee', () => {
  /** Les DEUX bornes : « ca expire un jour » passe avec n'importe quelle duree. */
  it('vit jusqu au dernier tick de sa duree, et pas un de plus', () => {
    const vivante = new ZoneField();
    vivante.spawn(ELEMENT.BRAISE, 0, 0, 0, 10);
    vivante.expire(10 + ZONE_LIFETIME_TICKS - 1);
    expect(vivante.count).toBe(1);

    const morte = new ZoneField();
    morte.spawn(ELEMENT.BRAISE, 0, 0, 0, 10);
    morte.expire(10 + ZONE_LIFETIME_TICKS);
    expect(morte.count).toBe(0);
  });

  /**
   * ⚠️ **Retrait par indice DECROISSANT.** Trois zones, celle du milieu seule
   * survivante : un balayage croissant deplacerait la troisieme (perimee) dans
   * le creneau 0 deja visite et la garderait vivante. Les cinq champs du
   * survivant sont verifies — un `#removeAt` qui oublie d'en recopier un
   * laisserait la zone deplacee porter l'element, la position, le poseur ou la
   * date de la morte.
   */
  it('ne saute jamais une zone deplacee par la compaction', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 0, 0, 0, 0);
    zones.spawn(ELEMENT.GIVRE, BIEN_LOIN, 11, 2, 50);
    zones.spawn(ELEMENT.BRAISE, BIEN_LOIN * 2, 0, 1, 0);
    // Compte le cas qu'on croit avoir cree : trois zones distinctes, aucune
    // fusion. Une fixture qui n'en pose que deux testerait autre chose.
    expect(zones.count).toBe(3);

    zones.expire(ZONE_LIFETIME_TICKS);

    expect(zones.count).toBe(1);
    expect(zones.kind[0]).toBe(ELEMENT.GIVRE);
    expect(zones.x[0]).toBe(BIEN_LOIN);
    expect(zones.y[0]).toBe(11);
    expect(zones.by[0]).toBe(2);
    expect(zones.bornTick[0]).toBe(50);
  });

  /**
   * ⚠️ **La compaction doit deplacer l'octet ENTIER, pas le reconstruire a
   * partir du seul element.** Le test precedent pose des elements bruts
   * (`kind === element`, reaction nulle) : une compaction qui ecrirait
   * `this.kind[slot] = zoneElement(this.kind[last])` passerait quand meme,
   * parce que decoder un octet de reaction nulle rend le meme nombre. Celui-ci
   * empaquette une reaction non nulle sur la zone DEPLACEE pour separer les
   * deux : `kind !== element` la designe sans ambiguite. Meme decor que
   * « ne saute jamais... » ci-dessus — deux zones, la premiere perime, la
   * seconde est deplacee du creneau 1 au creneau 0.
   */
  it('deplace le kind empaquete ENTIER par la compaction, reaction comprise', () => {
    const zones = new ZoneField();
    const kind = packZoneKind(ELEMENT.GIVRE, 13);
    expect(kind).not.toBe(ELEMENT.GIVRE);

    zones.spawn(ELEMENT.BRAISE, 0, 0, 0, 0);
    zones.spawn(kind, BIEN_LOIN, 11, 2, 50);
    expect(zones.count).toBe(2);

    zones.expire(ZONE_LIFETIME_TICKS);

    expect(zones.count).toBe(1);
    expect(zones.kind[0]).toBe(kind);
  });
});

describe('ZoneField — le recouvrement', () => {
  /**
   * ⚠️ **Le cas limite est le seul qui distingue un `<` d'un `<=`.** Deux
   * disques exactement tangents partagent un point de mesure nulle : les
   * traiter comme recouvrants ferait reagir deux zones qui ne se voient pas a
   * l'ecran.
   */
  it('ne recouvre pas a la tangence exacte, recouvre a un pixel de moins', () => {
    const diametre = ZONE_RADIUS + ZONE_RADIUS;

    const tangentes = new ZoneField();
    tangentes.spawn(ELEMENT.BRAISE, 0, 0, 0, 0);
    tangentes.spawn(ELEMENT.GIVRE, diametre, 0, 0, 0);
    expect(tangentes.overlaps(0, 1)).toBe(false);

    const secantes = new ZoneField();
    secantes.spawn(ELEMENT.BRAISE, 0, 0, 0, 0);
    secantes.spawn(ELEMENT.GIVRE, diametre - 1, 0, 0, 0);
    expect(secantes.overlaps(0, 1)).toBe(true);
  });

  /** Les deux axes comptent : un `overlaps` qui oublie `dy` recouvre toute une bande. */
  it('mesure la distance sur les deux axes', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 0, 0, 0, 0);
    zones.spawn(ELEMENT.GIVRE, 0, ZONE_RADIUS + ZONE_RADIUS, 0, 0);

    expect(zones.overlaps(0, 1)).toBe(false);
  });
});

describe('ZoneField — les deux predicats de temps (tache 6)', () => {
  /**
   * ⚠️ **`aliveAt` et `slowsAt` ne different que par leur borne BASSE**, et
   * les confondre coute un tick de decalage sur le deplacement — le pendant
   * temporel du facteur 2 entre fusion et recouvrement (§5.1 bis).
   */
  it('aliveAt vaut des le tick de la pose, slowsAt seulement a partir du suivant', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 100, 100, 0, 42);

    expect(zones.aliveAt(0, 42)).toBe(true);
    expect(zones.slowsAt(0, 42)).toBe(false);
    expect(zones.aliveAt(0, 43)).toBe(true);
    expect(zones.slowsAt(0, 43)).toBe(true);
  });

  it('les deux tombent au meme tick de peremption, pas un de plus', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 100, 100, 0, 0);

    expect(zones.aliveAt(0, ZONE_LIFETIME_TICKS - 1)).toBe(true);
    expect(zones.slowsAt(0, ZONE_LIFETIME_TICKS - 1)).toBe(true);
    expect(zones.aliveAt(0, ZONE_LIFETIME_TICKS)).toBe(false);
    expect(zones.slowsAt(0, ZONE_LIFETIME_TICKS)).toBe(false);
  });

  it('ni l un ni l autre ne vaut pour un tick ANTERIEUR a la pose', () => {
    // ⚠️ C'est ce que « date par tick » veut dire cote client : une zone
    // annoncee au tick 50 et rejouee depuis le tick 40 ne doit rien ralentir
    // entre 40 et 50, sans quoi le rejeu corrigerait la latence en inventant
    // un effet que le serveur n'a jamais applique.
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 100, 100, 0, 50);

    expect(zones.aliveAt(0, 49)).toBe(false);
    expect(zones.slowsAt(0, 49)).toBe(false);
  });
});

describe('ZoneField — la pose rend le creneau touche (tache 6)', () => {
  it('rend le creneau cree, puis le MEME creneau quand elle rafraichit', () => {
    // Le serveur annonce le centre STOCKE (§5.3) : sans ce retour, il n'aurait
    // aucun moyen de dire quelle zone une pose vient de rafraichir, et le
    // client verrait la sienne mourir avant celle du serveur.
    const zones = new ZoneField();
    const premier = zones.spawn(ELEMENT.GIVRE, 0, 0, 0, 0);
    const ailleurs = zones.spawn(ELEMENT.GIVRE, BIEN_LOIN, 0, 0, 0);
    expect(premier).toBe(0);
    expect(ailleurs).toBe(1);

    // ⚠️ **Le creneau est rendu meme quand la zone n'est PAS prolongee** —
    // c'est ce que `postZone` distingue par le COMPTE, pas par ce retour. Une
    // pose sous l'intervalle touche bien une zone existante ; elle ne la
    // prolonge simplement pas, et n'a donc rien a annoncer.
    expect(zones.spawn(ELEMENT.GIVRE, ZONE_RADIUS - 1, 0, 0, 5)).toBe(premier);
    expect(zones.count).toBe(2);
    expect(zones.bornTick[premier]).toBe(0);

    expect(zones.spawn(ELEMENT.GIVRE, ZONE_RADIUS - 1, 0, 0, ZONE_REFRESH_INTERVAL_TICKS)).toBe(
      premier,
    );
    expect(zones.count).toBe(2);
    expect(zones.bornTick[premier]).toBe(ZONE_REFRESH_INTERVAL_TICKS);
  });

  it('rend -1 quand la reserve est pleine', () => {
    const zones = new ZoneField();
    for (let i = 0; i < ZONE_CAPACITY; i++) {
      zones.spawn(ELEMENT.GIVRE, i * BIEN_LOIN, 0, 0, 0);
    }
    expect(zones.spawn(ELEMENT.GIVRE, ZONE_CAPACITY * BIEN_LOIN, 0, 0, 0)).toBe(-1);
    expect(zones.truncatedZones).toBe(1);
  });

  it('ne fusionne PAS avec une zone perimee laissee dans la reserve : elle en cree une neuve', () => {
    // ⚠️ Le cas du CLIENT, qui garde ses zones mortes `ROLLBACK_DEPTH_TICKS`
    // ticks pour pouvoir rejouer. Sans le filtre `aliveAt` dans `spawn`, il
    // rafraichirait un cadavre la ou le serveur a cree une zone neuve — deux
    // reserves qui divergent, et un ralentissement qui ne tombe plus au meme
    // endroit.
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 0, 0, 0, 0);
    // Aucun `expire` : la zone morte reste dans la reserve, exactement comme
    // chez le client.
    const neuve = zones.spawn(ELEMENT.GIVRE, 0, 0, 0, ZONE_LIFETIME_TICKS);

    expect(neuve).toBe(1);
    expect(zones.count).toBe(2);
    // L'ancienne garde son `bornTick` : elle n'a pas ete rafraichie.
    expect(zones.bornTick[0]).toBe(0);
  });
});

describe('ZoneField.ampAt — l amplification des degats (etape 5b, tache 1)', () => {
  it('rend 1 sur un sol nu : aucune zone, aucune amplification', () => {
    const zones = new ZoneField();
    expect(zones.ampAt(0, 0, 0)).toBe(1);
    expect(zones.ampAt(-1234.5, 678.9, 42)).toBe(1);
  });

  it('rend 1 dans une zone des trois elements d aujourd hui — leur `damageAmp` vaut 1', () => {
    // ⚠️ **Le decor n'est pas creux, et c'est ce qui le rend lisible.** Le
    // point est BIEN dedans (distance nulle), donc le 1 rendu vient de la table
    // des elements, pas d'un balayage qui n'aurait rien trouve. La Poix (tache
    // 4) sera la premiere ligne a rendre autre chose.
    for (const element of [ELEMENT.NEUTRE, ELEMENT.BRAISE, ELEMENT.GIVRE]) {
      const zones = new ZoneField();
      expect(zones.spawn(element, 500, 500, 0, 0)).toBe(0);
      expect(elementOf(element).damageAmp).toBe(1);
      expect(zones.ampAt(500, 500, 0), elementOf(element).name).toBe(1);
    }
  });

  it('DEUX zones qui se recouvrent ne CUMULENT pas : le maximum, jamais la somme', () => {
    // ⚠️ **Le test qui tue la somme.** Avec `amp += facteur`, deux zones
    // rendraient 2 et trois zones 3, et l'empilement de Poix deviendrait la
    // seule strategie du jeu (tache 4). Le maximum de deux 1 vaut 1, la somme
    // vaut 2 : la mutation rougit ici des aujourd'hui, avant meme qu'un element
    // n'amplifie quoi que ce soit.
    //
    // ⚠️ **Ce que ce test NE peut PAS separer, dit franchement** : `Math.max`
    // et `Math.min` rendent le meme 1 tant que toute la table vaut 1. C'est la
    // tache 4, avec `damageAmp > 1` sur la Poix, qui fermera cette mutation.
    //
    // Deux elements DIFFERENTS : deux zones du meme element au meme point
    // fusionneraient (voir `spawn`), et il n'y en aurait qu'une a balayer.
    const zones = new ZoneField();
    expect(zones.spawn(ELEMENT.BRAISE, 100, 0, 0, 0)).toBe(0);
    expect(zones.spawn(ELEMENT.GIVRE, 100, 0, 0, 0)).toBe(1);
    expect(zones.count).toBe(2);

    expect(zones.ampAt(100, 0, 0)).toBe(1);
  });

  it('ne consulte QUE les zones qui couvrent le point, et au tick ou elles vivent', () => {
    // ⚠️ **Le seul levier qui rend ce balayage observable avant la Poix, et il
    // faut le dire.** Toute la table vaut `damageAmp: 1` : dedans comme dehors,
    // `ampAt` rend 1, et un `return 1` en dur passerait toutes les autres
    // assertions de ce fichier. Un element INCONNU, lui, fait lever
    // `elementOf` — la reponse devient alors « leve » ou « rend 1 », et ces
    // deux-la se distinguent.
    //
    // ⚠️ **6, pas 99, depuis la tache 5 de l'etape 5b.** `zones.kind` porte
    // desormais un octet EMPAQUETE (`packZoneKind`) : l'element n'occupe que
    // les bits 0-2, et 99 (0b1100011) s'y decode en 3 — Foudre, un element
    // bien REEL, qui casserait ce test. 6 reste un element inconnu meme aux
    // 3 bits pleins : le §6.3 de l'orientation en compte six au total (0 a
    // 5), et 6/7 n'en feront jamais partie.
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 0, 0, 0, 0);
    zones.kind[0] = 6;

    // Dedans : la zone est consultee, donc `elementOf` leve.
    expect(() => zones.ampAt(ZONE_RADIUS - 1, 0, 0)).toThrow(/element inconnu/);
    // Pile sur le cercle : la borne est STRICTE, comme `markInZones` et
    // `slowsAt`. La zone est sautee, rien n'est consulte.
    expect(zones.ampAt(ZONE_RADIUS, 0, 0)).toBe(1);
    // Perimee : `aliveAt` la saute, meme au centre exact.
    expect(zones.ampAt(0, 0, ZONE_LIFETIME_TICKS)).toBe(1);
    // Et elle vit encore au dernier tick de sa duree de vie — sinon
    // l'assertion du dessus dirait seulement « le balayage ne trouve jamais
    // rien ».
    expect(() => zones.ampAt(0, 0, ZONE_LIFETIME_TICKS - 1)).toThrow(/element inconnu/);
  });

  /**
   * ⚠️ **Le test qui separe `ampAt` decodant de `ampAt` lisant l'octet
   * brut.** `packZoneKind(FOUDRE, reaction)` avec `reaction > 0` vaut au
   * moins 8 des que `reaction >= 1` — hors de portee d'`ELEMENTS` (4
   * entrees aujourd'hui, six au plus au §6.3) tant que l'element occupe 3
   * bits. Un `ampAt` qui lirait `this.kind[z]` sans le decoder recevrait
   * cet octet directement et leverait ; le vrai code le decode et rend le
   * `damageAmp` de la Foudre, 1 — sans lever.
   */
  it('decode l element AVANT de le donner a `elementOf`, meme quand une reaction est empaquetee dessus', () => {
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.FOUDRE, 5), 500, 500, 0, 0);
    // Le decor n'est pas creux : l'octet stocke porte bien les DEUX moities,
    // et elles different — sinon ce test passerait avec une fonction
    // identite a la place de `packZoneKind`.
    expect(zones.kind[0]).not.toBe(zoneElement(zones.kind[0] ?? 0));

    expect(() => zones.ampAt(500, 500, 0)).not.toThrow();
    expect(zones.ampAt(500, 500, 0)).toBe(elementOf(ELEMENT.FOUDRE).damageAmp);
  });
});
