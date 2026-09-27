import { describe, expect, it } from 'vitest';

import {
  CHAUX_ARMOR_REDUCTION,
  SUPRACONDUCTION_ARMOR_REDUCTION,
  SURCHAUFFE_BURN_PER_TICK,
  SURCHAUFFE_ZONE_LIFETIME_TICKS,
  VERGLAS_COLLISION_DAMAGE_PER_TICK,
  VIF_ARGENT_HIT_RADIUS_BONUS,
  ZONE_CAPACITY,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
  ZONE_REFRESH_INTERVAL_TICKS,
} from './constants';
import { ELEMENT, elementOf } from './elements';
import { packZoneKind, zoneElement } from './protocol';
import { REACTION } from './reactions';
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
   * ⚠️ **NE fusionne PAS deux `kind` de MEME element mais de types de
   * reaction DIFFERENTS — corrige a la revue de la tache 6.** La version
   * precedente de ce test affirmait l'inverse (« fusionne... meme si ...
   * different »), et le code le faisait : le predicat de fusion ne comparait
   * que `zoneElement`, donc une Surchauffe et un Choc thermique generique,
   * tous deux BRAISE, se confondaient en un seul objet — et LEQUEL des deux
   * octets survivait dependait de l'ORDRE d'arrivee (voir le docbloc de
   * `spawn`, `shared/zones.ts`, pour la mesure : soit Surchauffe ne brule
   * jamais, soit un Choc thermique ordinaire brule 4,5 s pour des joueurs qui
   * n'ont jamais fait Braise+Foudre).
   *
   * ⚠️ **Les DEUX ordres sont testes.** Un test a un seul ordre passerait
   * avec un predicat qui retiendrait toujours le PREMIER ou toujours le
   * SECOND `kind` — un decor qui masquerait exactement le defaut que la
   * revue a mesure en execution. Ici, les deux octets sont geometriquement
   * DISTINCTS (des zones qui ne fusionnent jamais), donc le decor ne peut pas
   * se contenter d'un seul ordre pour le prouver.
   */
  it('ne fusionne pas deux `kind` du meme element mais de reactions differentes — dans les DEUX ordres', () => {
    const genericPuisSurchauffe = new ZoneField();
    const generique = packZoneKind(ELEMENT.BRAISE, 0);
    const surchauffe = packZoneKind(ELEMENT.BRAISE, 3);
    expect(generique).not.toBe(surchauffe);
    genericPuisSurchauffe.spawn(generique, 500, 500, 0, 0);
    genericPuisSurchauffe.spawn(surchauffe, 500 + 10, 500, 1, 0);
    expect(genericPuisSurchauffe.count).toBe(2);
    expect([...genericPuisSurchauffe.kind.slice(0, 2)].sort()).toEqual(
      [generique, surchauffe].sort(),
    );

    const surchauffePuisGenerique = new ZoneField();
    surchauffePuisGenerique.spawn(surchauffe, 500, 500, 1, 0);
    surchauffePuisGenerique.spawn(generique, 500 + 10, 500, 0, 0);
    expect(surchauffePuisGenerique.count).toBe(2);
    expect([...surchauffePuisGenerique.kind.slice(0, 2)].sort()).toEqual(
      [generique, surchauffe].sort(),
    );
  });

  /**
   * ⚠️ **Deux `kind` de reaction NON nulle mais DIFFERENTE ne fusionnent pas
   * non plus** — meme element (BRAISE), deux nibbles de reaction distincts,
   * ni l'un ni l'autre nul. Le cas precedent pourrait laisser croire que
   * seule « generique contre non-generique » compte ; celui-ci ferme
   * l'hypothese.
   */
  it('ne fusionne pas deux `kind` de MEME element et de DEUX reactions non nulles', () => {
    const zones = new ZoneField();
    const surchauffe = packZoneKind(ELEMENT.BRAISE, 3);
    const embrasement = packZoneKind(ELEMENT.BRAISE, 9);
    expect(surchauffe).not.toBe(embrasement);

    zones.spawn(surchauffe, 500, 500, 0, 0);
    zones.spawn(embrasement, 500 + 10, 500, 1, 0);

    expect(zones.count).toBe(2);
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

/**
 * ⚠️ **Surchauffe (tache 6 de l'etape 5b) fait tenir `aliveAt`/`expire` PLUS
 * LONGTEMPS que la duree generique, DERIVEE du nibble de reaction empaquete
 * dans `kind`.** Le decor compare toujours deux zones au MEME `bornTick`,
 * l'une de reaction nulle et l'autre de Surchauffe, pour que la seule
 * variable soit le nibble — jamais un chiffre recopie de
 * `SURCHAUFFE_ZONE_LIFETIME_TICKS`, un reglage de jeu que ce fichier ne doit
 * pas figer.
 */
describe('ZoneField — Surchauffe allonge la duree de vie de sa zone (tache 6)', () => {
  it('tient encore au tick ou une zone generique du MEME bornTick est deja perimee', () => {
    const generique = new ZoneField();
    generique.spawn(ELEMENT.BRAISE, 0, 0, 0, 10);
    const surchauffe = new ZoneField();
    surchauffe.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 0, 0, 0, 10);

    const tickPerimeGenerique = 10 + ZONE_LIFETIME_TICKS;
    expect(generique.aliveAt(0, tickPerimeGenerique)).toBe(false);
    // ⚠️ **La ligne qui separe les deux comportements.** Une lecture qui
    // ignorerait le nibble de reaction rendrait `false` ici aussi.
    expect(surchauffe.aliveAt(0, tickPerimeGenerique)).toBe(true);
  });

  it('finit elle aussi par expirer — et `expire()` la retire au bon tick, pas au tick generique', () => {
    const surchauffe = new ZoneField();
    surchauffe.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SURCHAUFFE), 0, 0, 0, 0);

    // Au tick generique, elle survit encore : `expire` ne doit PAS la retirer.
    surchauffe.expire(ZONE_LIFETIME_TICKS);
    expect(surchauffe.count).toBe(1);

    // A SA propre echeance, plus longue, elle disparait bien.
    const tickPerimeSurchauffe = 0 + SURCHAUFFE_ZONE_LIFETIME_TICKS;
    expect(tickPerimeSurchauffe).toBeGreaterThan(ZONE_LIFETIME_TICKS);
    surchauffe.expire(tickPerimeSurchauffe);
    expect(surchauffe.count).toBe(0);
  });

  it('une zone de reaction nulle garde la duree GENERIQUE — non-regression', () => {
    // Le decor a deux zones, la Surchauffe posee en second : la tache 4 a
    // laisse vivante une mutation d'`ampAt` parce que, dans son decor, le
    // plus fort etait toujours pose en second. Inverser l'ordre ici tient le
    // meme risque a distance.
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), BIEN_LOIN, 0, 0, 0);
    zones.spawn(ELEMENT.GIVRE, 0, 0, 0, 0);

    zones.expire(ZONE_LIFETIME_TICKS);

    expect(zones.count).toBe(1);
    expect(zoneElement(zones.kind[0] ?? 0)).toBe(ELEMENT.BRAISE);
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

  it('rend 1 dans une zone des trois elements neutres d aujourd hui — leur `damageAmp` vaut 1', () => {
    // ⚠️ **Le decor n'est pas creux, et c'est ce qui le rend lisible.** Le
    // point est BIEN dedans (distance nulle), donc le 1 rendu vient de la table
    // des elements, pas d'un balayage qui n'aurait rien trouve. La Poix, elle,
    // rend autre chose — voir le describe suivant.
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
    // ⚠️ **Ce que ce test ne separe PAS** : `Math.max` et `Math.min` rendent
    // le meme 1 tant que les deux zones valent 1. Le describe suivant
    // (« la Poix ferme le maximum contre le minimum ET le produit ») ferme
    // cette mutation-la, avec `damageAmp > 1` sur la Poix.
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
    // ⚠️ **7, pas 6, depuis la tache 2 de l'etape 5c — et pas 99, depuis la
    // tache 5 de l'etape 5b.** `zones.kind` porte un octet EMPAQUETE
    // (`packZoneKind`) : l'element n'occupe que les bits 0-2, et 99
    // (0b1100011) s'y decode en 3 — Foudre, un element bien REEL, qui
    // casserait ce test. **6 a ete CORRIGE ICI** : ce fichier le tenait pour
    // inconnu « pour toujours » (le §6.3 de l'orientation en comptait six au
    // total, ids 0 a 5), mais le Vif-argent (tache 2 de l'etape 5c) occupe
    // precisement cet id — un catalogue complet a SEPT entrees (neutre + six
    // elements), ids 0 a 6. **7 reste le seul id hors table aux 3 bits
    // pleins** : le domaine d'un nibble de 3 bits va jusqu'a 7, et la table
    // n'ira jamais au-dela de sept entrees (le §6.3 de l'orientation les
    // compte toutes). Ce test a ete corrige par la tache 2, pas contourne —
    // voir son rapport.
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 0, 0, 0, 0);
    zones.kind[0] = 7;

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

/**
 * ⚠️ **Ce describe ferme les deux mutations laissees VERTES par la tache 1**
 * (M9 et M19 de son rapport) — la Poix est la PREMIERE ligne de la table a
 * porter `damageAmp > 1`, ce qui rend enfin le maximum distinguable du
 * minimum ET de la somme ET du produit. M19 (la valeur consommee cote
 * degats, pas seulement l'appel) se ferme, lui, dans `combat.test.ts` — voir
 * son describe « la Poix amplifie reellement les degats retires ».
 */
describe('ZoneField.ampAt — la Poix ferme le maximum contre le minimum ET le produit (tache 4)', () => {
  it('rend le `damageAmp` de la Poix dans sa flaque, strictement plus que 1', () => {
    // ⚠️ **Le test le plus etroit qui ferme deja M9.** `ampAt` part d'un
    // `amp` neutre (1) et ne le releve QUE si `factor > amp`. Avec le
    // minimum (`factor < amp`), 1,5 < 1 est faux : `amp` resterait a 1 au
    // lieu de monter a 1,5. Une seule flaque suffit a separer les deux
    // operateurs, sans recouvrement.
    const zones = new ZoneField();
    expect(zones.spawn(ELEMENT.POIX, 500, 500, 0, 0)).toBe(0);
    expect(elementOf(ELEMENT.POIX).damageAmp).toBeGreaterThan(1);
    expect(zones.ampAt(500, 500, 0)).toBe(elementOf(ELEMENT.POIX).damageAmp);
  });

  it('POIX (amp > 1) puis BRAISE (amp neutre) qui se recouvrent : le plus FORT gagne, jamais le plus faible', () => {
    // ⚠️ **Le test qui tue le minimum sur un recouvrement reel — ET
    // l'affectation inconditionnelle (revue de la tache 7).** Deux zones
    // d'amplifications DIFFERENTES : le minimum rendrait 1 (celui de la
    // Braise), exactement comme si la Poix n'etait pas la — un bug invisible
    // en jeu, une flaque de Poix qui n'amplifierait plus rien des qu'une
    // autre zone la recouvre. Le maximum rend celui de la Poix.
    //
    // ⚠️ **La Poix est posee EN PREMIER ici, deliberement — pas en second
    // comme le reste du fichier.** Remplacer `if (factor > amp) { amp =
    // factor; }` par une affectation inconditionnelle `amp = factor;` dans
    // `ampAt` survivait a toute la suite avant cette inversion : les deux
    // AUTRES tests a deux zones de ce fichier posent toujours la zone la
    // plus forte en SECOND, si bien que la derniere ecriture coincidait avec
    // le vrai maximum. Ici, la zone la plus forte (Poix) est ecrasee en
    // dernier par la plus faible (Braise) si l'affectation est
    // inconditionnelle : le resultat tomberait a 1 au lieu de 1,5, et cette
    // assertion rougirait. Verifie par application de la mutation, pas
    // raisonne (rapport de la tache 7).
    //
    // Deux elements DIFFERENTS, comme le test voisin plus haut : deux zones
    // du meme element au meme point fusionneraient (voir `spawn`).
    const zones = new ZoneField();
    expect(zones.spawn(ELEMENT.POIX, 100, 0, 0, 0)).toBe(0);
    expect(zones.spawn(ELEMENT.BRAISE, 100, 0, 0, 0)).toBe(1);
    expect(zones.count).toBe(2);

    expect(zones.ampAt(100, 0, 0)).toBe(elementOf(ELEMENT.POIX).damageAmp);
  });

  it('DEUX flaques de POIX qui se recouvrent ne cumulent pas : le maximum, jamais la somme ni le produit', () => {
    // ⚠️ **Le test demande par le brief de la tache 4, et celui qui tue le
    // produit.** Deux zones du MEME element et du MEME facteur : la somme
    // (1,5 + 1,5 = 3) ET le produit (1,5 x 1,5 = 2,25) different tous les
    // deux du maximum (1,5) — c'est le seul des trois tests de ce bloc ou
    // ces deux mutations-la se separent l'une de l'autre en plus du
    // maximum.
    //
    // ⚠️ **Deux zones qui ne FUSIONNENT pas, et c'est geometrique, pas un
    // hasard.** `spawn` fusionne deux zones du MEME element si le nouveau
    // centre tombe a MOINS de `ZONE_RADIUS` d'un centre existant (voir son
    // docbloc) — ici, exactement `ZONE_RADIUS`, donc la borne stricte de la
    // fusion n'est PAS franchie et les deux zones restent DISTINCTES. Leur
    // point milieu, lui, tombe a `ZONE_RADIUS / 2` de CHAQUE centre — donc
    // strictement DANS les deux disques, qui se recouvrent bien.
    const zones = new ZoneField();
    expect(zones.spawn(ELEMENT.POIX, 0, 0, 0, 0)).toBe(0);
    expect(zones.spawn(ELEMENT.POIX, ZONE_RADIUS, 0, 0, 0)).toBe(1);
    expect(zones.count).toBe(2); // pas de fusion : bien deux flaques distinctes

    expect(zones.ampAt(ZONE_RADIUS / 2, 0, 0)).toBe(elementOf(ELEMENT.POIX).damageAmp);
  });
});

/**
 * `ZoneField.armorReductionAt` — la tache 7 de l'etape 5b : meme FORME
 * qu'`ampAt` ci-dessus (meme balayage, meme `aliveAt`, meme MAXIMUM), pour
 * une raison DIFFERENTE — voir son docbloc. La Supraconduction (Givre +
 * Foudre) est la seule reaction a porter un `zoneArmorReduction` non nul
 * aujourd'hui.
 */
describe('ZoneField.armorReductionAt — la reduction d armure (etape 5b, tache 7)', () => {
  it('rend 0 sur un sol nu : aucune zone, aucune reduction', () => {
    const zones = new ZoneField();
    expect(zones.armorReductionAt(0, 0, 0)).toBe(0);
    expect(zones.armorReductionAt(-1234.5, 678.9, 42)).toBe(0);
  });

  it('rend 0 dans une zone de reaction nulle, ou des trois reactions de la tache 6 : aucune ne rabote l armure', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 100, 0, 0, 0);
    zones.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 300, 0, 0, 0);
    zones.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.EMBRASEMENT), 500, 0, 0, 0);
    zones.spawn(packZoneKind(ELEMENT.FOUDRE, REACTION.COURT_CIRCUIT), 700, 0, 0, 0);

    expect(zones.armorReductionAt(100, 0, 0)).toBe(0);
    expect(zones.armorReductionAt(300, 0, 0)).toBe(0);
    expect(zones.armorReductionAt(500, 0, 0)).toBe(0);
    expect(zones.armorReductionAt(700, 0, 0)).toBe(0);
  });

  it('rend SUPRACONDUCTION_ARMOR_REDUCTION dans sa zone, strictement positif', () => {
    const zones = new ZoneField();
    expect(zones.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 500, 500, 0, 0)).toBe(
      0,
    );
    expect(SUPRACONDUCTION_ARMOR_REDUCTION).toBeGreaterThan(0);
    expect(zones.armorReductionAt(500, 500, 0)).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);
  });

  it('ne consulte que les zones qui couvrent le point, et au tick ou elles vivent', () => {
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 0, 0, 0, 0);

    // Dedans : la zone porte.
    expect(zones.armorReductionAt(ZONE_RADIUS - 1, 0, 0)).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);
    // Pile sur le cercle : la borne est STRICTE, comme `ampAt` et `slowsAt`.
    expect(zones.armorReductionAt(ZONE_RADIUS, 0, 0)).toBe(0);
    // Perimee : `aliveAt` la saute, meme au centre exact.
    expect(zones.armorReductionAt(0, 0, ZONE_LIFETIME_TICKS)).toBe(0);
    // Et elle vit encore au dernier tick de sa duree de vie.
    expect(zones.armorReductionAt(0, 0, ZONE_LIFETIME_TICKS - 1)).toBe(
      SUPRACONDUCTION_ARMOR_REDUCTION,
    );
  });

  /**
   * ⚠️ **Deux zones qui se recouvrent rendent le MAXIMUM, jamais la
   * somme — meme raisonnement qu'`ampAt`, et posees dans les DEUX ordres**
   * (regle generale de cette etape des qu'un decor superpose deux elements,
   * voir le rapport de la tache 7 sur la mutation d'`ampAt`) : une zone
   * neutre (reduction 0) et une de Supraconduction (reduction
   * `SUPRACONDUCTION_ARMOR_REDUCTION`), dans chaque ordre de pose.
   */
  it('DEUX zones qui se recouvrent ne CUMULENT pas : le maximum, jamais la somme, dans les deux ordres de pose', () => {
    const neutrePuisSupra = new ZoneField();
    expect(neutrePuisSupra.spawn(ELEMENT.BRAISE, 100, 0, 0, 0)).toBe(0);
    expect(
      neutrePuisSupra.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 100, 0, 0, 0),
    ).toBe(1);
    expect(neutrePuisSupra.count).toBe(2);
    expect(neutrePuisSupra.armorReductionAt(100, 0, 0)).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);

    const supraPuisNeutre = new ZoneField();
    expect(
      supraPuisNeutre.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 100, 0, 0, 0),
    ).toBe(0);
    expect(supraPuisNeutre.spawn(ELEMENT.BRAISE, 100, 0, 0, 0)).toBe(1);
    expect(supraPuisNeutre.count).toBe(2);
    expect(supraPuisNeutre.armorReductionAt(100, 0, 0)).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);
  });

  /**
   * ⚠️ **Tache 1 de l'etape 5c : la Chaux rabote l'armure PAR ELLE-MEME**
   * (`Element.armorReduction`), sans aucune reaction specifique — une zone
   * generique (`packZoneKind(element, 0) === element`) qui porte l'element
   * Chaux suffit desormais, la ou seule une reaction (Supraconduction) le
   * pouvait avant cette tache.
   */
  it('rend CHAUX_ARMOR_REDUCTION dans une zone de Chaux SANS reaction, strictement positif', () => {
    const zones = new ZoneField();
    expect(zones.spawn(ELEMENT.CHAUX, 500, 500, 0, 0)).toBe(0);
    expect(CHAUX_ARMOR_REDUCTION).toBeGreaterThan(0);
    expect(zones.armorReductionAt(500, 500, 0)).toBe(CHAUX_ARMOR_REDUCTION);
  });

  /**
   * ⚠️ **Meme regle « poser dans les DEUX ordres » que le test
   * Supraconduction/Braise ci-dessus, avec la Chaux cette fois** : une zone
   * de Chaux (reduction `CHAUX_ARMOR_REDUCTION`) et une de Supraconduction
   * (reduction `SUPRACONDUCTION_ARMOR_REDUCTION`, strictement plus forte)
   * qui se recouvrent ne doivent JAMAIS additionner leurs reductions.
   */
  it('une zone de Chaux et une de Supraconduction qui se recouvrent ne CUMULENT pas, dans les deux ordres de pose', () => {
    expect(CHAUX_ARMOR_REDUCTION).toBeLessThan(SUPRACONDUCTION_ARMOR_REDUCTION);

    const chauxPuisSupra = new ZoneField();
    expect(chauxPuisSupra.spawn(ELEMENT.CHAUX, 100, 0, 0, 0)).toBe(0);
    expect(
      chauxPuisSupra.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 100, 0, 0, 0),
    ).toBe(1);
    expect(chauxPuisSupra.armorReductionAt(100, 0, 0)).not.toBe(
      CHAUX_ARMOR_REDUCTION + SUPRACONDUCTION_ARMOR_REDUCTION,
    );
    expect(chauxPuisSupra.armorReductionAt(100, 0, 0)).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);

    const supraPuisChaux = new ZoneField();
    expect(
      supraPuisChaux.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 100, 0, 0, 0),
    ).toBe(0);
    expect(supraPuisChaux.spawn(ELEMENT.CHAUX, 100, 0, 0, 0)).toBe(1);
    expect(supraPuisChaux.armorReductionAt(100, 0, 0)).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);
  });

  /**
   * L'AUTRE sens de la domination : une reaction SANS effet d'armure propre
   * (Surchauffe) superposee a une zone de Chaux doit laisser passer la
   * contribution de l'ELEMENT — sans quoi `armorReductionAt` ne lirait que
   * la reaction et perdrait la moitie de la tache 1.
   */
  it('la contribution de la Chaux survit face a une reaction sans effet d armure propre, dans les deux ordres', () => {
    const chauxPuisSurchauffe = new ZoneField();
    expect(chauxPuisSurchauffe.spawn(ELEMENT.CHAUX, 100, 0, 0, 0)).toBe(0);
    expect(
      chauxPuisSurchauffe.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 100, 0, 0, 0),
    ).toBe(1);
    expect(chauxPuisSurchauffe.armorReductionAt(100, 0, 0)).toBe(CHAUX_ARMOR_REDUCTION);

    const surchauffePuisChaux = new ZoneField();
    expect(
      surchauffePuisChaux.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 100, 0, 0, 0),
    ).toBe(0);
    expect(surchauffePuisChaux.spawn(ELEMENT.CHAUX, 100, 0, 0, 0)).toBe(1);
    expect(surchauffePuisChaux.armorReductionAt(100, 0, 0)).toBe(CHAUX_ARMOR_REDUCTION);
  });
});

/**
 * `ZoneField.collisionDamageAt` — la tache 8 de l'etape 5b : meme FORME
 * qu'`ampAt`/`armorReductionAt` ci-dessus (meme balayage, meme `aliveAt`,
 * meme MAXIMUM). Verglas (Givre + Poix) est la seule reaction a porter un
 * `zoneCollisionDamage` non nul aujourd'hui.
 */
describe('ZoneField.collisionDamageAt — le degat de collision (etape 5b, tache 8)', () => {
  it('rend 0 sur un sol nu : aucune zone, aucun degat', () => {
    const zones = new ZoneField();
    expect(zones.collisionDamageAt(0, 0, 0)).toBe(0);
    expect(zones.collisionDamageAt(-1234.5, 678.9, 42)).toBe(0);
  });

  it('rend 0 dans une zone de reaction nulle, ou des quatre reactions des taches 6 et 7 : aucune n a d effet de collision', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 100, 0, 0, 0);
    zones.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 300, 0, 0, 0);
    zones.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.EMBRASEMENT), 500, 0, 0, 0);
    zones.spawn(packZoneKind(ELEMENT.FOUDRE, REACTION.COURT_CIRCUIT), 700, 0, 0, 0);
    zones.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 900, 0, 0, 0);

    expect(zones.collisionDamageAt(100, 0, 0)).toBe(0);
    expect(zones.collisionDamageAt(300, 0, 0)).toBe(0);
    expect(zones.collisionDamageAt(500, 0, 0)).toBe(0);
    expect(zones.collisionDamageAt(700, 0, 0)).toBe(0);
    expect(zones.collisionDamageAt(900, 0, 0)).toBe(0);
  });

  it('rend VERGLAS_COLLISION_DAMAGE_PER_TICK dans sa zone, strictement positif', () => {
    const zones = new ZoneField();
    expect(zones.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS), 500, 500, 0, 0)).toBe(0);
    expect(VERGLAS_COLLISION_DAMAGE_PER_TICK).toBeGreaterThan(0);
    expect(zones.collisionDamageAt(500, 500, 0)).toBe(VERGLAS_COLLISION_DAMAGE_PER_TICK);
  });

  it('ne consulte que les zones qui couvrent le point, et au tick ou elles vivent', () => {
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS), 0, 0, 0, 0);

    expect(zones.collisionDamageAt(ZONE_RADIUS - 1, 0, 0)).toBe(VERGLAS_COLLISION_DAMAGE_PER_TICK);
    // Pile sur le cercle : la borne est STRICTE, comme `ampAt` et `slowsAt`.
    expect(zones.collisionDamageAt(ZONE_RADIUS, 0, 0)).toBe(0);
    // Perimee : `aliveAt` la saute, meme au centre exact.
    expect(zones.collisionDamageAt(0, 0, ZONE_LIFETIME_TICKS)).toBe(0);
    // Et elle vit encore au dernier tick de sa duree de vie.
    expect(zones.collisionDamageAt(0, 0, ZONE_LIFETIME_TICKS - 1)).toBe(
      VERGLAS_COLLISION_DAMAGE_PER_TICK,
    );
  });

  /**
   * ⚠️ **Deux zones qui se recouvrent rendent le MAXIMUM, jamais la
   * somme — posees dans les DEUX ordres**, meme regle que le reste de cette
   * etape des qu'un decor superpose deux elements.
   */
  it('DEUX zones qui se recouvrent ne CUMULENT pas : le maximum, jamais la somme, dans les deux ordres de pose', () => {
    const neutrePuisVerglas = new ZoneField();
    expect(neutrePuisVerglas.spawn(ELEMENT.BRAISE, 100, 0, 0, 0)).toBe(0);
    expect(
      neutrePuisVerglas.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS), 100, 0, 0, 0),
    ).toBe(1);
    expect(neutrePuisVerglas.count).toBe(2);
    expect(neutrePuisVerglas.collisionDamageAt(100, 0, 0)).toBe(VERGLAS_COLLISION_DAMAGE_PER_TICK);

    const verglasPuisNeutre = new ZoneField();
    expect(
      verglasPuisNeutre.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS), 100, 0, 0, 0),
    ).toBe(0);
    expect(verglasPuisNeutre.spawn(ELEMENT.BRAISE, 100, 0, 0, 0)).toBe(1);
    expect(verglasPuisNeutre.count).toBe(2);
    expect(verglasPuisNeutre.collisionDamageAt(100, 0, 0)).toBe(VERGLAS_COLLISION_DAMAGE_PER_TICK);
  });
});

/**
 * `ZoneField.burnAt` — ajoutee a la revue finale de l'etape 5b (B2) : meme
 * FORME qu'`ampAt`/`armorReductionAt`/`collisionDamageAt` ci-dessus (meme
 * balayage, meme `aliveAt`, meme MAXIMUM). Surchauffe (Braise + Foudre) est
 * la seule reaction a porter un `zoneBurnPerTick` non nul aujourd'hui.
 *
 * ⚠️ **La brulure de zone etait, avant cette revue, la SEULE des quatre
 * grandeurs de `ZoneField` a se CUMULER au lieu de prendre le maximum** —
 * `resolveBurn` (`back/src/combat.ts`) appelait `appliquerDegats` une fois
 * PAR ZONE couvrant l'ennemi, au lieu d'une fois par ennemi. Mesure : 0,300
 * PV/tick pour une zone, 0,600 pour deux superposees a declencheurs opposes,
 * 1,200 pour quatre — soit 72 PV/s, `HEAVY_HP` (20) en 0,28 s. Ce fichier
 * porte deja trois tests « ne CUMULENT pas : le maximum, jamais la somme »
 * pour les trois grandeurs voisines ; celui-ci est le QUATRIEME de la
 * famille.
 */
describe('ZoneField.burnAt — le degat de brulure de zone (revue finale de l etape 5b, B2)', () => {
  it('rend 0 sur un sol nu : aucune zone, aucune brulure', () => {
    const zones = new ZoneField();
    expect(zones.burnAt(0, 0, 0)).toBe(0);
    expect(zones.burnAt(-1234.5, 678.9, 42)).toBe(0);
  });

  it('rend 0 dans une zone de reaction nulle, ou des quatre autres reactions de cette etape : aucune n a de brulure de zone', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 100, 0, 0, 0);
    zones.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.EMBRASEMENT), 300, 0, 0, 0);
    zones.spawn(packZoneKind(ELEMENT.FOUDRE, REACTION.COURT_CIRCUIT), 500, 0, 0, 0);
    zones.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 700, 0, 0, 0);
    zones.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS), 900, 0, 0, 0);

    expect(zones.burnAt(100, 0, 0)).toBe(0);
    expect(zones.burnAt(300, 0, 0)).toBe(0);
    expect(zones.burnAt(500, 0, 0)).toBe(0);
    expect(zones.burnAt(700, 0, 0)).toBe(0);
    expect(zones.burnAt(900, 0, 0)).toBe(0);
  });

  it('rend SURCHAUFFE_BURN_PER_TICK dans sa zone, strictement positif', () => {
    const zones = new ZoneField();
    expect(zones.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 500, 500, 0, 0)).toBe(0);
    expect(SURCHAUFFE_BURN_PER_TICK).toBeGreaterThan(0);
    expect(zones.burnAt(500, 500, 0)).toBe(SURCHAUFFE_BURN_PER_TICK);
  });

  it('brule MEME quand la zone porte l element FOUDRE (le declencheur) : le taux vient de la reaction, pas de l element', () => {
    // ⚠️ Meme test que `resolveBurn` (`back/src/combat.test.ts`), mais au
    // niveau de `ZoneField` seul : `elementOf(FOUDRE).burnPerTick` vaut zero,
    // une lecture generique ne brulerait jamais ici.
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.FOUDRE, REACTION.SURCHAUFFE), 500, 500, 0, 0);
    expect(elementOf(ELEMENT.FOUDRE).burnPerTick).toBe(0);
    expect(zones.burnAt(500, 500, 0)).toBe(SURCHAUFFE_BURN_PER_TICK);
  });

  it('ne consulte que les zones qui couvrent le point, et au tick ou elles vivent', () => {
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 0, 0, 0, 0);

    // Dedans : la zone porte.
    expect(zones.burnAt(ZONE_RADIUS - 1, 0, 0)).toBe(SURCHAUFFE_BURN_PER_TICK);
    // Pile sur le cercle : la borne est STRICTE, comme `ampAt` et `slowsAt`.
    expect(zones.burnAt(ZONE_RADIUS, 0, 0)).toBe(0);
    // Perimee : `aliveAt` la saute, meme au centre exact — Surchauffe
    // ALLONGE sa PROPRE duree de vie (voir le describe dedie plus haut),
    // donc la borne est `SURCHAUFFE_ZONE_LIFETIME_TICKS`, pas
    // `ZONE_LIFETIME_TICKS`.
    expect(zones.burnAt(0, 0, SURCHAUFFE_ZONE_LIFETIME_TICKS)).toBe(0);
    // Et elle vit encore au dernier tick de sa duree de vie.
    expect(zones.burnAt(0, 0, SURCHAUFFE_ZONE_LIFETIME_TICKS - 1)).toBe(SURCHAUFFE_BURN_PER_TICK);
  });

  /**
   * ⚠️ **Le test demande par la revue finale de l'etape 5b (B2), portant les
   * DEUX decors MESURES avant la correction de `resolveBurn`.**
   *
   * Cas 1 : deux zones de MEME reaction (Surchauffe) a DECLENCHEURS OPPOSES
   * — Braise (`kind` 9) et Foudre (`kind` 11), les deux valeurs que
   * `ReactionTrigger.element` peut porter pour cette reaction — aux MEMES
   * coordonnees. Mesure en execution avant cette revue : 0,600 PV/tick au
   * lieu de 0,300.
   *
   * Cas 2 : deux zones du MEME `kind`, centres ecartes de `1,2 x ZONE_RADIUS`
   * — au-dela de la borne de fusion de `spawn` (`< ZONE_RADIUS`), donc deux
   * zones bien DISTINCTES, mais en-deca de `2 x ZONE_RADIUS`, donc deux
   * disques qui se RECOUVRENT sans fusionner.
   *
   * Dans les deux cas, `burnAt` doit rendre `SURCHAUFFE_BURN_PER_TICK`,
   * jamais son double.
   */
  it('DEUX zones de Surchauffe qui se recouvrent ne CUMULENT pas : le maximum, jamais la somme', () => {
    // Cas 1 : memes coordonnees, declencheurs OPPOSES.
    const declencheursOpposes = new ZoneField();
    expect(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE)).toBe(9);
    expect(packZoneKind(ELEMENT.FOUDRE, REACTION.SURCHAUFFE)).toBe(11);
    expect(
      declencheursOpposes.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 100, 0, 0, 0),
    ).toBe(0);
    expect(
      declencheursOpposes.spawn(packZoneKind(ELEMENT.FOUDRE, REACTION.SURCHAUFFE), 100, 0, 0, 0),
    ).toBe(1);
    expect(declencheursOpposes.count).toBe(2);
    // ⚠️ **Le test qui tue la somme.** Avec `burn += facteur`, ce point
    // rendrait `2 x SURCHAUFFE_BURN_PER_TICK` (0,600) au lieu de
    // `SURCHAUFFE_BURN_PER_TICK` (0,300) — la mutation mesuree en execution.
    expect(declencheursOpposes.burnAt(100, 0, 0)).toBe(SURCHAUFFE_BURN_PER_TICK);

    // Cas 2 : MEME kind, centres ecartes de 1,2 x ZONE_RADIUS.
    const ECART = 1.2 * ZONE_RADIUS;
    expect(ECART).toBeGreaterThan(ZONE_RADIUS); // au-dela de la fusion
    expect(ECART).toBeLessThan(2 * ZONE_RADIUS); // les deux disques se recouvrent
    const disquesRecouverts = new ZoneField();
    expect(
      disquesRecouverts.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), 0, 0, 0, 0),
    ).toBe(0);
    expect(
      disquesRecouverts.spawn(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE), ECART, 0, 0, 0),
    ).toBe(1);
    expect(disquesRecouverts.count).toBe(2); // pas de fusion : bien deux zones distinctes

    // Le point milieu tombe strictement DANS les deux disques (ECART / 2
    // < ZONE_RADIUS).
    expect(disquesRecouverts.burnAt(ECART / 2, 0, 0)).toBe(SURCHAUFFE_BURN_PER_TICK);
  });
});

/**
 * `ZoneField.hitRadiusBonusAt` — la tache 3 de l'etape 5c : cinquieme FORME
 * de la meme famille qu'`ampAt`/`armorReductionAt`/`collisionDamageAt`/`burnAt`
 * ci-dessus (meme balayage, meme `aliveAt`, meme MAXIMUM) — pour une raison de
 * JEU cette fois (deux zones de Vif-argent qui se recouvrent ne doublent pas
 * le rayon de touche), pas la raison arithmetique du minimum de
 * `Horde#computeSlow`.
 *
 * ⚠️ **Structurelle, comme `linkedNeighbours` (`shared/links.ts`) : lit
 * `zoneElement(kind) === ELEMENT.VIF_ARGENT` directement, jamais un champ de
 * `Element` ni de `ReactionDef`.** Le Vif-argent est, comme la Foudre, un
 * element dont l'effet reel ne vit pas dans ces tables (voir le docbloc de
 * `hitRadiusBonusAt` dans `shared/zones.ts`) — les decors ci-dessous
 * construisent donc des `kind` avec `packZoneKind(ELEMENT.VIF_ARGENT, ...)`
 * plutot que de piocher dans `REACTION_DEFS`.
 */
describe('ZoneField.hitRadiusBonusAt — le rayon de touche elargi (etape 5c, tache 3)', () => {
  it('rend 0 sur un sol nu : aucune zone, aucun bonus', () => {
    const zones = new ZoneField();
    expect(zones.hitRadiusBonusAt(0, 0, 0)).toBe(0);
    expect(zones.hitRadiusBonusAt(-1234.5, 678.9, 42)).toBe(0);
  });

  it('rend 0 dans une zone de n importe quel AUTRE element : seul le Vif-argent porte un bonus', () => {
    const zones = new ZoneField();
    const autres = [
      ELEMENT.NEUTRE,
      ELEMENT.BRAISE,
      ELEMENT.GIVRE,
      ELEMENT.FOUDRE,
      ELEMENT.POIX,
      ELEMENT.CHAUX,
    ];
    autres.forEach((element, i) => {
      expect(zones.spawn(element, i * BIEN_LOIN, 0, 0, 0)).toBe(i);
    });
    autres.forEach((element, i) => {
      expect(zones.hitRadiusBonusAt(i * BIEN_LOIN, 0, 0), elementOf(element).name).toBe(0);
    });
  });

  it('rend VIF_ARGENT_HIT_RADIUS_BONUS dans sa zone, strictement positif', () => {
    const zones = new ZoneField();
    expect(zones.spawn(ELEMENT.VIF_ARGENT, 500, 500, 0, 0)).toBe(0);
    expect(VIF_ARGENT_HIT_RADIUS_BONUS).toBeGreaterThan(0);
    expect(zones.hitRadiusBonusAt(500, 500, 0)).toBe(VIF_ARGENT_HIT_RADIUS_BONUS);
  });

  it('ne consulte que les zones qui couvrent le point, et au tick ou elles vivent', () => {
    const zones = new ZoneField();
    zones.spawn(ELEMENT.VIF_ARGENT, 0, 0, 0, 0);

    expect(zones.hitRadiusBonusAt(ZONE_RADIUS - 1, 0, 0)).toBe(VIF_ARGENT_HIT_RADIUS_BONUS);
    // Pile sur le cercle : la borne est STRICTE, comme `ampAt` et `slowsAt`.
    expect(zones.hitRadiusBonusAt(ZONE_RADIUS, 0, 0)).toBe(0);

    expect(zones.hitRadiusBonusAt(0, 0, ZONE_LIFETIME_TICKS)).toBe(0);
    expect(zones.hitRadiusBonusAt(0, 0, ZONE_LIFETIME_TICKS - 1)).toBe(VIF_ARGENT_HIT_RADIUS_BONUS);
  });

  /**
   * ⚠️ **Correctif de revue sur la tache 3 (etape 5c) — decouvert en
   * recoupant le §5 de la spec, pas le §3.** *Gel profond* (Givre +
   * Vif-argent) et *Aveuglement* (Chaux + Vif-argent) y sont ranges parmi
   * les reactions PORTEES PAR UNE ZONE (taches 5 et 8, hors perimetre ici) :
   * leur champ porte l'element du DECLENCHEUR, Vif-argent OU son partenaire
   * selon l'ordre d'arrivee des deux projectiles. Sans le filtre
   * `zoneReaction(kind) === 0`, une zone de Gel profond dont le Vif-argent
   * serait arrive EN SECOND aurait `zoneElement(kind) === ELEMENT.VIF_ARGENT`
   * et elargirait a tort — une fois sur deux, ATTEIGNABLE des la tache 6.
   *
   * ⚠️ **Les DEUX declencheurs possibles**, meme discipline que les tests
   * « ne cumulent pas » ci-dessous : le second `kind` (Givre declenche)
   * etait deja exclu par le filtre PRECEDENT (element), donc lui seul ne
   * testerait rien de neuf — mais l'assener quand meme documente que le
   * nouveau filtre n'a RIEN change pour ce cas.
   */
  it('ne majore rien a travers une zone de REACTION appariant le Vif-argent, quel que soit le declencheur', () => {
    // Fictif : aucune reaction ne pair le Vif-argent aujourd'hui (§5 arrive
    // aux taches 5-8) — seul le MECANISME (element du declencheur variable)
    // est teste ici, pas une reaction reelle.
    const kindVifArgentDeclenche = packZoneKind(ELEMENT.VIF_ARGENT, REACTION.SUPRACONDUCTION);
    const kindAutreDeclenche = packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION);

    const zonesA = new ZoneField();
    expect(zonesA.spawn(kindVifArgentDeclenche, 500, 500, 0, 0)).toBe(0);
    expect(zonesA.hitRadiusBonusAt(500, 500, 0)).toBe(0);

    const zonesB = new ZoneField();
    expect(zonesB.spawn(kindAutreDeclenche, 500, 500, 0, 0)).toBe(0);
    expect(zonesB.hitRadiusBonusAt(500, 500, 0)).toBe(0);
  });

  /**
   * ⚠️ **Les DEUX decors de `burnAt`, adaptes — et dans les DEUX ordres,
   * l asymetrie relevee a la re-revue finale de l etape 5b sur `burnAt` (un
   * seul ordre teste) n est PAS reproduite ici.**
   *
   * Cas 1 : une zone de Vif-argent PUR (`kind` eligible) et une zone de
   * REACTION appariant le Vif-argent (`kind` FILTRE par
   * `zoneReaction(kind) === 0`, voir le test precedent), aux MEMES
   * coordonnees — jamais fusionnees puisque `spawn` compare le `kind`
   * COMPLET. Verifie que le filtre et le maximum cooperent : la contribution
   * FILTREE ne compte jamais, seule celle qui reste rend
   * `VIF_ARGENT_HIT_RADIUS_BONUS` — jamais son double, jamais zero.
   *
   * Cas 2 : deux zones du MEME `kind`, centres ecartes de `1,2 x ZONE_RADIUS`
   * — au-dela de la fusion, en-deca du recouvrement.
   *
   * Dans les deux cas et les deux ordres, `hitRadiusBonusAt` doit rendre
   * `VIF_ARGENT_HIT_RADIUS_BONUS`, jamais son double.
   */
  it('DEUX zones de Vif-argent qui se recouvrent ne CUMULENT pas : le maximum, jamais la somme, dans les deux ordres', () => {
    const kindPur = ELEMENT.VIF_ARGENT;
    const kindFiltre = packZoneKind(ELEMENT.VIF_ARGENT, REACTION.SUPRACONDUCTION);
    expect(kindPur).not.toBe(kindFiltre);
    expect(zoneElement(kindPur)).toBe(ELEMENT.VIF_ARGENT);
    expect(zoneElement(kindFiltre)).toBe(ELEMENT.VIF_ARGENT);

    // Cas 1, ordre pur puis filtre.
    const purPuisFiltre = new ZoneField();
    expect(purPuisFiltre.spawn(kindPur, 100, 0, 0, 0)).toBe(0);
    expect(purPuisFiltre.spawn(kindFiltre, 100, 0, 0, 0)).toBe(1);
    expect(purPuisFiltre.count).toBe(2);
    expect(purPuisFiltre.hitRadiusBonusAt(100, 0, 0)).toBe(VIF_ARGENT_HIT_RADIUS_BONUS);

    // Cas 1, ordre filtre puis pur — l asymetrie que `burnAt` n a jamais testee.
    const filtrePuisPur = new ZoneField();
    expect(filtrePuisPur.spawn(kindFiltre, 100, 0, 0, 0)).toBe(0);
    expect(filtrePuisPur.spawn(kindPur, 100, 0, 0, 0)).toBe(1);
    expect(filtrePuisPur.count).toBe(2);
    expect(filtrePuisPur.hitRadiusBonusAt(100, 0, 0)).toBe(VIF_ARGENT_HIT_RADIUS_BONUS);

    // Cas 2, MEME kind, centres ecartes de 1,2 x ZONE_RADIUS, dans les deux ordres.
    const ECART = 1.2 * ZONE_RADIUS;
    expect(ECART).toBeGreaterThan(ZONE_RADIUS);
    expect(ECART).toBeLessThan(2 * ZONE_RADIUS);

    const gauchePuisDroite = new ZoneField();
    expect(gauchePuisDroite.spawn(ELEMENT.VIF_ARGENT, 0, 0, 0, 0)).toBe(0);
    expect(gauchePuisDroite.spawn(ELEMENT.VIF_ARGENT, ECART, 0, 0, 0)).toBe(1);
    expect(gauchePuisDroite.count).toBe(2);
    expect(gauchePuisDroite.hitRadiusBonusAt(ECART / 2, 0, 0)).toBe(VIF_ARGENT_HIT_RADIUS_BONUS);

    const droitePuisGauche = new ZoneField();
    expect(droitePuisGauche.spawn(ELEMENT.VIF_ARGENT, ECART, 0, 0, 0)).toBe(0);
    expect(droitePuisGauche.spawn(ELEMENT.VIF_ARGENT, 0, 0, 0, 0)).toBe(1);
    expect(droitePuisGauche.count).toBe(2);
    expect(droitePuisGauche.hitRadiusBonusAt(ECART / 2, 0, 0)).toBe(VIF_ARGENT_HIT_RADIUS_BONUS);
  });
});
