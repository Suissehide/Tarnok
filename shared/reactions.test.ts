import { describe, expect, it } from 'vitest';

import { MAX_ARMOR } from './archetypes';
import {
  CHAUX_ARMOR_REDUCTION,
  ECLAT_DE_GEL_DAMAGE,
  FOURNEE_BURN_PER_TICK,
  REACTION_DAMAGE,
  REACTION_RADIUS,
  SUPRACONDUCTION_ARMOR_REDUCTION,
  SURCHAUFFE_ZONE_LIFETIME_TICKS,
  VERGLAS_COLLISION_DAMAGE_PER_TICK,
  VERGLAS_INERTIA_DAMPING,
  ZONE_LIFETIME_TICKS,
} from './constants';
import { ELEMENT, elementOf } from './elements';
import { packElementPair, packZoneKind, unpackElementPair } from './protocol';
import {
  REACTION,
  reactionForPair,
  reactionOfId,
  zoneArmorReduction,
  zoneArmorReductionTotal,
  zoneBurnPerTick,
  zoneCollisionDamage,
  zoneDamageAmpTotal,
  zoneFieldSign,
  zoneInertiaDamping,
  zoneLifetimeTicks,
  zoneSlowFactor,
} from './reactions';

describe('reactionForPair — une table pilotee par la donnee, pas un switch sur la paire', () => {
  it('trouve les CINQ reactions (taches 6, 7 et 8), chacune a son propre couple canonique', () => {
    const surchauffe = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.FOUDRE));
    const embrasement = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.POIX));
    const courtCircuit = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.POIX));
    const supraconduction = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.FOUDRE));
    const verglas = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.POIX));

    expect(surchauffe?.id).toBe(REACTION.SURCHAUFFE);
    expect(embrasement?.id).toBe(REACTION.EMBRASEMENT);
    expect(courtCircuit?.id).toBe(REACTION.COURT_CIRCUIT);
    expect(supraconduction?.id).toBe(REACTION.SUPRACONDUCTION);
    expect(verglas?.id).toBe(REACTION.VERGLAS);
    // Cinq identifiants distincts : une table qui en confondrait deux
    // resoudrait la mauvaise reaction pour au moins un couple.
    expect(
      new Set([surchauffe?.id, embrasement?.id, courtCircuit?.id, supraconduction?.id, verglas?.id])
        .size,
    ).toBe(5);
  });

  it('est INSENSIBLE a l ordre d arrivee, comme `packElementPair`', () => {
    // La paire canonique ne connait pas qui est arrive en premier — un
    // declencheur Braise-puis-Foudre et un Foudre-puis-Braise doivent
    // trouver la MEME reaction.
    const a = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.FOUDRE));
    const b = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.BRAISE));
    expect(a?.id).toBe(REACTION.SURCHAUFFE);
    expect(b?.id).toBe(REACTION.SURCHAUFFE);

    // Meme garde pour Verglas (Givre + Poix) : c est precisement l ordre
    // dont depend le piege de `zoneSlowFactor` plus bas.
    const c = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.POIX));
    const d = reactionForPair(packElementPair(ELEMENT.POIX, ELEMENT.GIVRE));
    expect(c?.id).toBe(REACTION.VERGLAS);
    expect(d?.id).toBe(REACTION.VERGLAS);
  });

  it('rend `undefined` pour un couple SANS effet specifique — Braise+Givre, le Choc thermique generique', () => {
    // Absence delibree de la table : `applyReactions` doit alors retomber
    // sur le comportement generique de l'etape 5a. `undefined`, pas une
    // entree « AUCUNE » : un appelant qui oublierait le fallback rougirait
    // immediatement sur `.id`.
    expect(reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE))).toBeUndefined();
  });
});

describe('reactionOfId', () => {
  it('retrouve chaque reaction par le nibble qu elle empaquette dans `ZoneField.kind`', () => {
    expect(reactionOfId(REACTION.SURCHAUFFE)?.name).toBe('surchauffe');
    expect(reactionOfId(REACTION.EMBRASEMENT)?.name).toBe('embrasement');
    expect(reactionOfId(REACTION.COURT_CIRCUIT)?.name).toBe('court-circuit');
    expect(reactionOfId(REACTION.SUPRACONDUCTION)?.name).toBe('supraconduction');
    expect(reactionOfId(REACTION.VERGLAS)?.name).toBe('verglas');
  });

  it('rend `undefined` pour `REACTION.AUCUNE` (0) : aucune ligne ne le porte', () => {
    expect(reactionOfId(REACTION.AUCUNE)).toBeUndefined();
  });
});

describe('Fournee et Eclat de gel (tache 4 de l etape 5c) — deux lignes de plus, meme table', () => {
  it('trouve Fournee (Braise + Chaux) et Eclat de gel (Givre + Chaux), chacune a son couple canonique', () => {
    const fournee = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.CHAUX));
    const eclatDeGel = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.CHAUX));
    expect(fournee?.id).toBe(REACTION.FOURNEE);
    expect(eclatDeGel?.id).toBe(REACTION.ECLAT_DE_GEL);
    // Sept identifiants distincts au total, exactement comme le test des cinq
    // reactions precedentes : une collision confondrait le mauvais couple.
    const surchauffe = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.FOUDRE));
    const embrasement = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.POIX));
    const courtCircuit = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.POIX));
    const supraconduction = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.FOUDRE));
    const verglas = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.POIX));
    expect(
      new Set([
        surchauffe?.id,
        embrasement?.id,
        courtCircuit?.id,
        supraconduction?.id,
        verglas?.id,
        fournee?.id,
        eclatDeGel?.id,
      ]).size,
    ).toBe(7);
  });

  it('est INSENSIBLE a l ordre d arrivee, comme les cinq reactions precedentes', () => {
    const a = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.CHAUX));
    const b = reactionForPair(packElementPair(ELEMENT.CHAUX, ELEMENT.BRAISE));
    expect(a?.id).toBe(REACTION.FOURNEE);
    expect(b?.id).toBe(REACTION.FOURNEE);

    const c = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.CHAUX));
    const d = reactionForPair(packElementPair(ELEMENT.CHAUX, ELEMENT.GIVRE));
    expect(c?.id).toBe(REACTION.ECLAT_DE_GEL);
    expect(d?.id).toBe(REACTION.ECLAT_DE_GEL);
  });

  it('retrouve les deux par `reactionOfId`, le nibble empaquete dans `ZoneField.kind`', () => {
    expect(reactionOfId(REACTION.FOURNEE)?.name).toBe('fournee');
    expect(reactionOfId(REACTION.ECLAT_DE_GEL)?.name).toBe('eclat-de-gel');
  });

  it('Eclat de gel porte ECLAT_DE_GEL_DAMAGE et un rayon nul : pas de balayage geometrique', () => {
    const def = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.CHAUX));
    expect(def?.damage).toBe(ECLAT_DE_GEL_DAMAGE);
    expect(def?.radius).toBe(0);
  });
});

describe('Vaporisation, Arc caustique et Paratonnerre (tache 5 de l etape 5c) — trois lignes de plus, meme table', () => {
  it('trouve les trois par leur couple canonique, dix identifiants distincts au total', () => {
    const vaporisation = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.VIF_ARGENT));
    const arcCaustique = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.CHAUX));
    const paratonnerre = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.VIF_ARGENT));
    expect(vaporisation?.id).toBe(REACTION.VAPORISATION);
    expect(arcCaustique?.id).toBe(REACTION.ARC_CAUSTIQUE);
    expect(paratonnerre?.id).toBe(REACTION.PARATONNERRE);

    const surchauffe = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.FOUDRE));
    const embrasement = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.POIX));
    const courtCircuit = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.POIX));
    const supraconduction = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.FOUDRE));
    const verglas = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.POIX));
    const fournee = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.CHAUX));
    const eclatDeGel = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.CHAUX));
    // Dix identifiants distincts : une collision confondrait le mauvais
    // couple, exactement comme les deux tests precedents de ce fichier.
    expect(
      new Set([
        surchauffe?.id,
        embrasement?.id,
        courtCircuit?.id,
        supraconduction?.id,
        verglas?.id,
        fournee?.id,
        eclatDeGel?.id,
        vaporisation?.id,
        arcCaustique?.id,
        paratonnerre?.id,
      ]).size,
    ).toBe(10);
  });

  it('est INSENSIBLE a l ordre d arrivee, comme les sept reactions precedentes', () => {
    const a = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.VIF_ARGENT));
    const b = reactionForPair(packElementPair(ELEMENT.VIF_ARGENT, ELEMENT.BRAISE));
    expect(a?.id).toBe(REACTION.VAPORISATION);
    expect(b?.id).toBe(REACTION.VAPORISATION);

    const c = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.CHAUX));
    const d = reactionForPair(packElementPair(ELEMENT.CHAUX, ELEMENT.FOUDRE));
    expect(c?.id).toBe(REACTION.ARC_CAUSTIQUE);
    expect(d?.id).toBe(REACTION.ARC_CAUSTIQUE);

    const e = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.VIF_ARGENT));
    const f = reactionForPair(packElementPair(ELEMENT.VIF_ARGENT, ELEMENT.FOUDRE));
    expect(e?.id).toBe(REACTION.PARATONNERRE);
    expect(f?.id).toBe(REACTION.PARATONNERRE);
  });

  it('retrouve les trois par `reactionOfId`, le nibble empaquete dans `ZoneField.kind`', () => {
    expect(reactionOfId(REACTION.VAPORISATION)?.name).toBe('vaporisation');
    expect(reactionOfId(REACTION.ARC_CAUSTIQUE)?.name).toBe('arc-caustique');
    expect(reactionOfId(REACTION.PARATONNERRE)?.name).toBe('paratonnerre');
  });

  it('Vaporisation reutilise REACTION_RADIUS et REACTION_DAMAGE, meme decision qu Embrasement et Court-circuit', () => {
    const def = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.VIF_ARGENT));
    expect(def?.radius).toBe(REACTION_RADIUS);
    expect(def?.damage).toBe(REACTION_DAMAGE);
  });

  it('Arc caustique et Paratonnerre portent REACTION_DAMAGE par saut, un rayon nul (chaine, pas balayage)', () => {
    const arcCaustique = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.CHAUX));
    const paratonnerre = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.VIF_ARGENT));
    expect(arcCaustique?.damage).toBe(REACTION_DAMAGE);
    expect(arcCaustique?.radius).toBe(0);
    expect(paratonnerre?.damage).toBe(REACTION_DAMAGE);
    expect(paratonnerre?.radius).toBe(0);
  });
});

describe('Gel profond, Mortier vif et Aveuglement (tache 6 de l etape 5c) — trois lignes de plus, meme table', () => {
  it('trouve les trois par leur couple canonique, treize identifiants distincts au total', () => {
    const gelProfond = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.VIF_ARGENT));
    const mortierVif = reactionForPair(packElementPair(ELEMENT.POIX, ELEMENT.CHAUX));
    const aveuglement = reactionForPair(packElementPair(ELEMENT.CHAUX, ELEMENT.VIF_ARGENT));
    expect(gelProfond?.id).toBe(REACTION.GEL_PROFOND);
    expect(mortierVif?.id).toBe(REACTION.MORTIER_VIF);
    expect(aveuglement?.id).toBe(REACTION.AVEUGLEMENT);

    const surchauffe = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.FOUDRE));
    const embrasement = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.POIX));
    const courtCircuit = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.POIX));
    const supraconduction = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.FOUDRE));
    const verglas = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.POIX));
    const fournee = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.CHAUX));
    const eclatDeGel = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.CHAUX));
    const vaporisation = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.VIF_ARGENT));
    const arcCaustique = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.CHAUX));
    const paratonnerre = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.VIF_ARGENT));
    // Treize identifiants distincts : une collision confondrait le mauvais
    // couple, exactement comme les deux tests precedents de ce fichier.
    expect(
      new Set([
        surchauffe?.id,
        embrasement?.id,
        courtCircuit?.id,
        supraconduction?.id,
        verglas?.id,
        fournee?.id,
        eclatDeGel?.id,
        vaporisation?.id,
        arcCaustique?.id,
        paratonnerre?.id,
        gelProfond?.id,
        mortierVif?.id,
        aveuglement?.id,
      ]).size,
    ).toBe(13);
  });

  it('est INSENSIBLE a l ordre d arrivee, comme les dix reactions precedentes', () => {
    const a = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.VIF_ARGENT));
    const b = reactionForPair(packElementPair(ELEMENT.VIF_ARGENT, ELEMENT.GIVRE));
    expect(a?.id).toBe(REACTION.GEL_PROFOND);
    expect(b?.id).toBe(REACTION.GEL_PROFOND);

    const c = reactionForPair(packElementPair(ELEMENT.POIX, ELEMENT.CHAUX));
    const d = reactionForPair(packElementPair(ELEMENT.CHAUX, ELEMENT.POIX));
    expect(c?.id).toBe(REACTION.MORTIER_VIF);
    expect(d?.id).toBe(REACTION.MORTIER_VIF);

    const e = reactionForPair(packElementPair(ELEMENT.CHAUX, ELEMENT.VIF_ARGENT));
    const f = reactionForPair(packElementPair(ELEMENT.VIF_ARGENT, ELEMENT.CHAUX));
    expect(e?.id).toBe(REACTION.AVEUGLEMENT);
    expect(f?.id).toBe(REACTION.AVEUGLEMENT);
  });

  it('retrouve les trois par `reactionOfId`, le nibble empaquete dans `ZoneField.kind`', () => {
    expect(reactionOfId(REACTION.GEL_PROFOND)?.name).toBe('gel-profond');
    expect(reactionOfId(REACTION.MORTIER_VIF)?.name).toBe('mortier-vif');
    expect(reactionOfId(REACTION.AVEUGLEMENT)?.name).toBe('aveuglement');
  });

  it('aucune des trois ne pose d effet geometrique ou en chaine : radius et damage restent nuls', () => {
    // ⚠️ **Verifie, pas suppose.** Les trois sont rangees « zone » au §5 de
    // la spec, contrairement a Embrasement/Vaporisation (geometrique) ou
    // Court-circuit/Arc caustique/Paratonnerre (chaine) : sans branche
    // dediee dans `applyReactions` (`back/src/combat.ts`), elles retombent
    // sur le degat GENERIQUE du Choc thermique (`REACTION_RADIUS`,
    // `REACTION_DAMAGE`), exactement comme Supraconduction, Verglas et
    // Fournee avant elles — voir le commentaire de leur branche par defaut.
    const gelProfond = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.VIF_ARGENT));
    const mortierVif = reactionForPair(packElementPair(ELEMENT.POIX, ELEMENT.CHAUX));
    const aveuglement = reactionForPair(packElementPair(ELEMENT.CHAUX, ELEMENT.VIF_ARGENT));
    expect(gelProfond?.radius).toBe(0);
    expect(gelProfond?.damage).toBe(0);
    expect(mortierVif?.radius).toBe(0);
    expect(mortierVif?.damage).toBe(0);
    expect(aveuglement?.radius).toBe(0);
    expect(aveuglement?.damage).toBe(0);
  });
});

describe('zoneLifetimeTicks — la duree DERIVEE du kind empaquete', () => {
  it('rend la duree GENERIQUE pour un kind de reaction nulle', () => {
    expect(zoneLifetimeTicks(ELEMENT.BRAISE)).toBe(ZONE_LIFETIME_TICKS);
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.GIVRE, REACTION.AUCUNE))).toBe(
      ZONE_LIFETIME_TICKS,
    );
  });

  it('rend une duree PLUS LONGUE pour Surchauffe — §5 de la spec de l etape 5b', () => {
    const kind = packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE);
    expect(zoneLifetimeTicks(kind)).toBeGreaterThan(ZONE_LIFETIME_TICKS);
  });

  it('ignore les autres bits du kind : seul le nibble de reaction compte', () => {
    // Meme reaction, deux elements differents (les deux ordres d arrivee
    // possibles de Surchauffe) : la duree ne doit pas varier avec l element.
    const surBraise = zoneLifetimeTicks(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE));
    const surFoudre = zoneLifetimeTicks(packZoneKind(ELEMENT.FOUDRE, REACTION.SURCHAUFFE));
    expect(surBraise).toBe(surFoudre);
  });

  /**
   * ⚠️ **Embrasement et Court-circuit portent `zoneLifetimeTicks: 0` dans la
   * table — « pas de duree propre », pas « duree nulle ».** Une mutation qui
   * lirait ce zero comme une duree REELLE (`>= 0` au lieu de `> 0`) ferait
   * mourir leur zone au tick meme de sa pose : `aliveAt` y rendrait `false`
   * IMMEDIATEMENT (`tick - born < 0` n'est jamais vrai). Sans ce test, seule
   * une coincidence d'un test d'un autre fichier (`zones.test.ts`, tache 5)
   * la fait rougir — un decor qui masquerait le jour ou cette coincidence
   * disparait.
   */
  it('rend la duree GENERIQUE pour Embrasement et Court-circuit : `zoneLifetimeTicks: 0` n est pas une duree', () => {
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.BRAISE, REACTION.EMBRASEMENT))).toBe(
      ZONE_LIFETIME_TICKS,
    );
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.FOUDRE, REACTION.COURT_CIRCUIT))).toBe(
      ZONE_LIFETIME_TICKS,
    );
  });

  it('rend la duree GENERIQUE pour Fournee et Eclat de gel (tache 4 de l etape 5c) : aucune des deux n allonge sa zone', () => {
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.BRAISE, REACTION.FOURNEE))).toBe(
      ZONE_LIFETIME_TICKS,
    );
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.GIVRE, REACTION.ECLAT_DE_GEL))).toBe(
      ZONE_LIFETIME_TICKS,
    );
  });

  it('rend la duree GENERIQUE pour Vaporisation, Arc caustique et Paratonnerre (tache 5 de l etape 5c) : aucune n allonge sa zone', () => {
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.BRAISE, REACTION.VAPORISATION))).toBe(
      ZONE_LIFETIME_TICKS,
    );
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.FOUDRE, REACTION.ARC_CAUSTIQUE))).toBe(
      ZONE_LIFETIME_TICKS,
    );
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.FOUDRE, REACTION.PARATONNERRE))).toBe(
      ZONE_LIFETIME_TICKS,
    );
  });

  /**
   * ⚠️ **LE chiffre qui distingue Gel profond de la Supraconduction —
   * §5 de la spec : « plus forte ou plus longue ».** `slowFactor: 0` est
   * DEJA un plancher absolu pour les deux reactions (voir leur entree dans
   * `REACTION_DEFS`) : rien ne peut etre « plus fort » que zero, donc la
   * duree est le SEUL levier restant. La Supraconduction n'allonge pas sa
   * zone (`zoneLifetimeTicks: 0` dans sa ligne, duree GENERIQUE) ; Gel
   * profond REUTILISE `SURCHAUFFE_ZONE_LIFETIME_TICKS` (1,5x la duree
   * generique). Ce test assene la valeur EXACTE, pas seulement une
   * inegalite — une assertion « > ZONE_LIFETIME_TICKS » seule laisserait
   * passer n'importe quel reglage futur sans le remarquer.
   */
  it('Gel profond dure SURCHAUFFE_ZONE_LIFETIME_TICKS, strictement plus longtemps que la Supraconduction', () => {
    const gelProfond = zoneLifetimeTicks(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND));
    const supraconduction = zoneLifetimeTicks(
      packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION),
    );
    expect(gelProfond).toBe(SURCHAUFFE_ZONE_LIFETIME_TICKS);
    expect(supraconduction).toBe(ZONE_LIFETIME_TICKS);
    expect(gelProfond).toBeGreaterThan(supraconduction);
    // Ignore l'element porte, meme garde que Surchauffe plus haut.
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.GEL_PROFOND))).toBe(
      gelProfond,
    );
  });

  it('rend la duree GENERIQUE pour Mortier vif : aucune duree propre, contrairement a Gel profond et Aveuglement', () => {
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.POIX, REACTION.MORTIER_VIF))).toBe(
      ZONE_LIFETIME_TICKS,
    );
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.CHAUX, REACTION.MORTIER_VIF))).toBe(
      ZONE_LIFETIME_TICKS,
    );
  });

  /**
   * ⚠️ **LE chiffre qui distingue Aveuglement de la Chaux SEULE —
   * §5 de la spec : « plus forte ou plus longue que la Chaux seule ».**
   * `fieldSign` n'a que deux valeurs (+1/-1) : rien n'est « plus fort » que
   * -1, donc la duree est le SEUL levier ici aussi. Une Chaux seule (sans
   * reaction nommee, `packZoneKind(ELEMENT.CHAUX, REACTION.AUCUNE)`) vit la
   * duree GENERIQUE ; Aveuglement REUTILISE le meme
   * `SURCHAUFFE_ZONE_LIFETIME_TICKS` que Gel profond.
   */
  it('Aveuglement dure SURCHAUFFE_ZONE_LIFETIME_TICKS, strictement plus longtemps que la Chaux seule', () => {
    const aveuglement = zoneLifetimeTicks(packZoneKind(ELEMENT.CHAUX, REACTION.AVEUGLEMENT));
    const chauxSeule = zoneLifetimeTicks(packZoneKind(ELEMENT.CHAUX, REACTION.AUCUNE));
    expect(aveuglement).toBe(SURCHAUFFE_ZONE_LIFETIME_TICKS);
    expect(chauxSeule).toBe(ZONE_LIFETIME_TICKS);
    expect(aveuglement).toBeGreaterThan(chauxSeule);
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT))).toBe(
      aveuglement,
    );
  });
});

describe('zoneBurnPerTick — le degat de zone DERIVE du kind empaquete', () => {
  it('rend zero pour un kind de reaction nulle : les zones generiques ne brulent pas d elles-memes', () => {
    expect(zoneBurnPerTick(ELEMENT.BRAISE)).toBe(0);
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.GIVRE, REACTION.AUCUNE))).toBe(0);
  });

  it('rend un degat STRICTEMENT positif pour Surchauffe, quel que soit l element porte', () => {
    const surBraise = zoneBurnPerTick(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE));
    const surFoudre = zoneBurnPerTick(packZoneKind(ELEMENT.FOUDRE, REACTION.SURCHAUFFE));
    // ⚠️ **Le point precis du §5 : le degat ne doit PAS dependre de
    // l element porte.** Si `resolveBurn` lisait `elementOf(...).burnPerTick`
    // au lieu de `zoneBurnPerTick`, une zone de Surchauffe portant l element
    // Foudre rendrait zero (`elementOf(FOUDRE).burnPerTick === 0`) — c est
    // exactement ce que ce test separe.
    expect(surBraise).toBeGreaterThan(0);
    expect(surFoudre).toBeGreaterThan(0);
    expect(surBraise).toBe(surFoudre);
  });

  it('Embrasement et Court-circuit ne laissent AUCUN degat de zone : leur effet est instantane, pas persistant', () => {
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.BRAISE, REACTION.EMBRASEMENT))).toBe(0);
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.FOUDRE, REACTION.COURT_CIRCUIT))).toBe(0);
  });

  it('rend FOURNEE_BURN_PER_TICK pour Fournee, quel que soit l element porte (Braise OU Chaux declenche)', () => {
    const braiseDeclenche = zoneBurnPerTick(packZoneKind(ELEMENT.BRAISE, REACTION.FOURNEE));
    const chauxDeclenche = zoneBurnPerTick(packZoneKind(ELEMENT.CHAUX, REACTION.FOURNEE));
    expect(braiseDeclenche).toBeGreaterThan(0);
    expect(chauxDeclenche).toBeGreaterThan(0);
    expect(braiseDeclenche).toBe(chauxDeclenche);
    expect(braiseDeclenche).toBe(FOURNEE_BURN_PER_TICK);
  });

  it('Eclat de gel ne laisse AUCUN degat de zone : son effet est un degat direct sur la cible, pas une zone qui brule', () => {
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.GIVRE, REACTION.ECLAT_DE_GEL))).toBe(0);
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.CHAUX, REACTION.ECLAT_DE_GEL))).toBe(0);
  });

  /**
   * ⚠️ **Vaporisation apparie la Braise (`burnPerTick` non neutre), mais ne
   * porte AUCUN plancher ici — verifie, pas suppose.** `zoneBurnPerTick` ne
   * lit jamais `elementOf(...).burnPerTick` (voir son docbloc) : cette
   * grandeur ne combine structurellement JAMAIS avec l'element, quel que
   * soit le declencheur. Les deux ordres doivent donc rendre zero.
   */
  it('Vaporisation ne laisse AUCUN degat de zone, dans les DEUX ordres : son effet est geometrique, pas persistant', () => {
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.BRAISE, REACTION.VAPORISATION))).toBe(0);
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.VAPORISATION))).toBe(0);
  });

  it('Arc caustique et Paratonnerre ne laissent AUCUN degat de zone : leur effet est la chaine, pas une brulure', () => {
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.FOUDRE, REACTION.ARC_CAUSTIQUE))).toBe(0);
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.CHAUX, REACTION.ARC_CAUSTIQUE))).toBe(0);
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.FOUDRE, REACTION.PARATONNERRE))).toBe(0);
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.PARATONNERRE))).toBe(0);
  });

  it('Gel profond, Mortier vif et Aveuglement ne laissent AUCUN degat de zone : aucune des trois ne brule', () => {
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND))).toBe(0);
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.GEL_PROFOND))).toBe(0);
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.POIX, REACTION.MORTIER_VIF))).toBe(0);
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.CHAUX, REACTION.MORTIER_VIF))).toBe(0);
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.CHAUX, REACTION.AVEUGLEMENT))).toBe(0);
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT))).toBe(0);
  });
});

/**
 * ⚠️ **Embrasement et Court-circuit reutilisent le rayon et le degat
 * GENERIQUES de la reaction** (decision documentee dans `shared/reactions.ts`) :
 * l ecart avec le Choc thermique est la SELECTIVITE (poisses seulement),
 * jamais l intensite. Ce test garde cette decision plutot que de laisser une
 * table qui deriverait en silence vers deux chiffres arbitraires.
 */
describe('Embrasement et Court-circuit reutilisent les grandeurs generiques de la reaction', () => {
  it('Embrasement porte REACTION_RADIUS et REACTION_DAMAGE', () => {
    const def = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.POIX));
    expect(def?.radius).toBe(REACTION_RADIUS);
    expect(def?.damage).toBe(REACTION_DAMAGE);
  });

  it('Court-circuit porte REACTION_DAMAGE par saut', () => {
    const def = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.POIX));
    expect(def?.damage).toBe(REACTION_DAMAGE);
  });
});

/**
 * `zoneSlowFactor` — la tache 7 de l'etape 5b : le facteur de vitesse DERIVE
 * du kind empaquete, lu par `Horde#computeSlow` (`shared/horde.ts`).
 */
describe('zoneSlowFactor — le facteur de vitesse DERIVE du kind empaquete', () => {
  it('rend le facteur de l element seul quand la zone ne porte aucune reaction', () => {
    expect(zoneSlowFactor(ELEMENT.GIVRE)).toBe(elementOf(ELEMENT.GIVRE).slowFactor);
    expect(zoneSlowFactor(packZoneKind(ELEMENT.BRAISE, REACTION.AUCUNE))).toBe(
      elementOf(ELEMENT.BRAISE).slowFactor,
    );
  });

  it('rend le facteur de l element seul pour les trois reactions de la tache 6 : aucune n a d effet propre', () => {
    expect(zoneSlowFactor(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE))).toBe(
      elementOf(ELEMENT.BRAISE).slowFactor,
    );
    expect(zoneSlowFactor(packZoneKind(ELEMENT.BRAISE, REACTION.EMBRASEMENT))).toBe(
      elementOf(ELEMENT.BRAISE).slowFactor,
    );
    expect(zoneSlowFactor(packZoneKind(ELEMENT.FOUDRE, REACTION.COURT_CIRCUIT))).toBe(
      elementOf(ELEMENT.FOUDRE).slowFactor,
    );
  });

  it('rend 1 (aucun ralentissement) pour Fournee, dans les DEUX ordres : ni Braise ni Chaux ne ralentissent', () => {
    // ⚠️ Ni Braise ni Chaux ne portent de `slowFactor` non neutre (voir
    // `shared/elements.ts`) : contrairement a Eclat de gel juste en dessous,
    // Fournee n'a donc AUCUN piege d'ordre a fermer ici — les deux
    // contributions restent neutres quel que soit le declencheur.
    expect(zoneSlowFactor(packZoneKind(ELEMENT.BRAISE, REACTION.FOURNEE))).toBe(1);
    expect(zoneSlowFactor(packZoneKind(ELEMENT.CHAUX, REACTION.FOURNEE))).toBe(1);
  });

  /**
   * ⚠️ **La TROISIEME grandeur piegee, trouvee par la revue apres coup —
   * ma propre regle de « deux planchers » etait incomplete.** Eclat de gel
   * (Givre + Chaux) laissait `zoneSlowFactor` a sa valeur NEUTRE : le Givre,
   * lui, porte un `slowFactor` non neutre (0,6), donc la zone ralentissait si
   * Givre avait declenche, mais pas si Chaux avait declenche — exactement le
   * meme piege d'ordre que `zoneArmorReductionTotal`/`zoneFieldSign`
   * referment pour la Chaux. Corrige en reprenant le plancher de Verglas
   * (`elementOf(ELEMENT.GIVRE).slowFactor`) : Eclat de gel garde la morsure
   * du froid quel que soit l'ordre, comme les deux autres grandeurs.
   */
  it('Eclat de gel ne depend plus de l ordre d arrivee : le ralentissement vaut celui du Givre dans les deux ordres', () => {
    const givreDeclenche = zoneSlowFactor(packZoneKind(ELEMENT.GIVRE, REACTION.ECLAT_DE_GEL));
    const chauxDeclenche = zoneSlowFactor(packZoneKind(ELEMENT.CHAUX, REACTION.ECLAT_DE_GEL));
    expect(elementOf(ELEMENT.GIVRE).slowFactor).toBeLessThan(1);
    expect(givreDeclenche).toBe(chauxDeclenche);
    expect(givreDeclenche).toBe(elementOf(ELEMENT.GIVRE).slowFactor);
  });

  /**
   * ⚠️ **Le test qui separe la combinaison par minimum d'une simple lecture
   * de l'element.** Le nibble d'element d'une zone de Supraconduction porte
   * celui du DECLENCHEUR (Givre OU Foudre selon l'ordre d'arrivee) —
   * `elementOf(zoneElement(kind)).slowFactor` seul rendrait 0,6 ou 1, jamais
   * 0. Les deux ordres doivent pourtant rendre EXACTEMENT le meme gel total.
   */
  it('rend 0 (gel total) pour la Supraconduction, quel que soit l element porte par le nibble', () => {
    const givreDeclenche = zoneSlowFactor(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION));
    const foudreDeclenche = zoneSlowFactor(packZoneKind(ELEMENT.FOUDRE, REACTION.SUPRACONDUCTION));
    // Non-vacuite : si le nibble d'element etait lu seul, les deux vaudraient
    // 0,6 et 1 — deux nombres DIFFERENTS, et aucun des deux ne serait 0.
    expect(elementOf(ELEMENT.GIVRE).slowFactor).not.toBe(0);
    expect(elementOf(ELEMENT.FOUDRE).slowFactor).not.toBe(0);
    expect(givreDeclenche).toBe(0);
    expect(foudreDeclenche).toBe(0);
  });

  /**
   * ⚠️ **LE piege de la tache 8, signale par la revue de la tache 7 (R13)
   * avant meme que le code n'existe.** Pour la Supraconduction,
   * `reactionFactor = 0` est un PLANCHER ABSOLU : `min(x, 0) = 0` quel que
   * soit `x`. Verglas n'a pas ce luxe : si sa ligne portait `zoneSlowFactor:
   * 1` (neutre, comme les trois reactions de la tache 6), ce test rendrait
   * `0,6` quand Givre declenche et `1` quand Poix declenche — deux nombres
   * DIFFERENTS, et la meme Verglas glisserait ou pas selon quel projectile a
   * touche en second. La ligne de Verglas doit donc porter un facteur
   * EXPLICITE qui reste un plancher dans les deux cas.
   */
  it('rend le MEME facteur pour Verglas, quel que soit l element porte par le nibble (Givre OU Poix declenche)', () => {
    const givreDeclenche = zoneSlowFactor(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS));
    const poixDeclenche = zoneSlowFactor(packZoneKind(ELEMENT.POIX, REACTION.VERGLAS));
    // Non-vacuite : Givre et Poix n'ont PAS le meme `slowFactor` — sans
    // combinaison EXPLICITE au niveau de la reaction, les deux lignes
    // ci-dessous rendraient des valeurs differentes.
    expect(elementOf(ELEMENT.GIVRE).slowFactor).not.toBe(elementOf(ELEMENT.POIX).slowFactor);
    expect(givreDeclenche).toBe(poixDeclenche);
    // Et ce facteur COMMUN est bien celui du Givre : Verglas ne fait que
    // GARANTIR ce ralentissement quel que soit l'ordre, elle n'en ajoute pas
    // un second.
    expect(givreDeclenche).toBe(elementOf(ELEMENT.GIVRE).slowFactor);
  });

  /**
   * ⚠️ **L'invariant dont R13 depend, ASSENE — pas seulement observe.**
   * `zoneSlowFactor` combine par MINIMUM (`Math.min(elementFactor,
   * reactionFactor)`) : l'independance a l'ordre du declencheur que le test
   * ci-dessus MESURE ne tient QUE SI `reactionFactor` reste un PLANCHER —
   * inferieur ou egal au `slowFactor` de CHAQUE element qui peut apparaitre
   * dans le nibble. Le test precedent verifie que Givre et Poix rendent le
   * MEME nombre aujourd'hui ; il ne dit PAS pourquoi, et ne rougirait pas si
   * la tache 12 donnait un jour a la Poix un `slowFactor` propre INFERIEUR
   * a celui du Givre — le minimum redeviendrait alors dependant de l'ordre,
   * exactement le bug que R13 visait a eliminer, et rien ne le verrait.
   *
   * ⚠️ **Ni Givre ni Poix ne sont ecrits en dur ici.** La paire se DECODE de
   * la table elle-meme (`unpackElementPair(def.pair)`), pas devinee — la
   * propriete reste donc vraie si la tache 12 retouche `ELEMENT_DEFS`, ou si
   * Verglas se declenchait un jour d'un troisieme couple. C'est la meme
   * discipline que la garde de `CARD_WEAPON` dans `shared/loadout.ts` :
   * une constante recopiee SANS garde derive en silence ; ici la garde
   * protege une INEGALITE, pas une simple egalite de nom.
   */
  it('le facteur de Verglas reste un PLANCHER pour les deux elements de sa propre paire', () => {
    const def = reactionOfId(REACTION.VERGLAS);
    expect(def).toBeDefined();
    const [a, b] = unpackElementPair(def?.pair ?? 0);
    for (const element of [a, b]) {
      expect(def?.zoneSlowFactor).toBeLessThanOrEqual(elementOf(element).slowFactor);
    }
  });

  /**
   * ⚠️ **Vaporisation, Arc caustique et Paratonnerre (tache 5 de l etape 5c)
   * n ont AUCUN plancher a fermer ici — verifie, pas suppose.** Aucun des
   * six elements en jeu (Braise, Vif-argent, Foudre, Chaux) ne porte de
   * `slowFactor` non neutre (seul le Givre en porte un, voir
   * `ELEMENT_DEFS`) : les deux ordres de chaque paire doivent donc rendre 1
   * (aucun ralentissement), sans qu aucune ligne de `REACTION_DEFS` n ait
   * besoin d un `zoneSlowFactor` explicite.
   */
  it('rend 1 (aucun ralentissement) pour Vaporisation, Arc caustique et Paratonnerre, dans les DEUX ordres', () => {
    expect(zoneSlowFactor(packZoneKind(ELEMENT.BRAISE, REACTION.VAPORISATION))).toBe(1);
    expect(zoneSlowFactor(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.VAPORISATION))).toBe(1);
    expect(zoneSlowFactor(packZoneKind(ELEMENT.FOUDRE, REACTION.ARC_CAUSTIQUE))).toBe(1);
    expect(zoneSlowFactor(packZoneKind(ELEMENT.CHAUX, REACTION.ARC_CAUSTIQUE))).toBe(1);
    expect(zoneSlowFactor(packZoneKind(ELEMENT.FOUDRE, REACTION.PARATONNERRE))).toBe(1);
    expect(zoneSlowFactor(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.PARATONNERRE))).toBe(1);
  });

  /**
   * ⚠️ **Gel profond (Givre + Vif-argent) : gel TOTAL, meme mecanisme que la
   * Supraconduction — `reactionFactor = 0` est un plancher ABSOLU
   * (`min(x, 0) = 0` quel que soit `x`), donc les deux ordres (Givre 0,6,
   * Vif-argent 1) rendent le MEME zero.**
   */
  it('rend 0 (gel total) pour Gel profond, quel que soit l element porte par le nibble (Givre OU Vif-argent declenche)', () => {
    const givreDeclenche = zoneSlowFactor(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND));
    const vifArgentDeclenche = zoneSlowFactor(
      packZoneKind(ELEMENT.VIF_ARGENT, REACTION.GEL_PROFOND),
    );
    // Non-vacuite : si le nibble d'element etait lu seul, les deux
    // vaudraient 0,6 et 1 — deux nombres DIFFERENTS, aucun des deux 0.
    expect(elementOf(ELEMENT.GIVRE).slowFactor).not.toBe(0);
    expect(elementOf(ELEMENT.VIF_ARGENT).slowFactor).not.toBe(0);
    expect(givreDeclenche).toBe(0);
    expect(vifArgentDeclenche).toBe(0);
  });

  /**
   * ⚠️ **Mortier vif (Poix + Chaux) : gel TOTAL, propre a la reaction — NI
   * la Poix NI la Chaux ne portent de `slowFactor` non neutre (voir
   * `ELEMENT_DEFS`), donc `zoneSlowFactor: 0` de sa ligne n'est PAS un
   * plancher qui protege d'un ordre d'arrivee, c'est l'effet lui-meme
   * (« scelles »). Les deux ordres rendent quand meme le MEME zero.**
   */
  it('rend 0 (gel total) pour Mortier vif, dans les DEUX ordres (Poix OU Chaux declenche)', () => {
    const poixDeclenche = zoneSlowFactor(packZoneKind(ELEMENT.POIX, REACTION.MORTIER_VIF));
    const chauxDeclenche = zoneSlowFactor(packZoneKind(ELEMENT.CHAUX, REACTION.MORTIER_VIF));
    expect(poixDeclenche).toBe(0);
    expect(chauxDeclenche).toBe(0);
  });

  it('rend 1 (aucun ralentissement) pour Aveuglement, dans les DEUX ordres : ni la Chaux ni le Vif-argent ne ralentissent', () => {
    expect(zoneSlowFactor(packZoneKind(ELEMENT.CHAUX, REACTION.AVEUGLEMENT))).toBe(1);
    expect(zoneSlowFactor(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT))).toBe(1);
  });
});

/**
 * `zoneArmorReduction` — la tache 7 de l'etape 5b : l'armure SOUSTRAITE,
 * DERIVEE du kind empaquete, lue par `ZoneField.armorReductionAt`
 * (`shared/zones.ts`).
 */
describe('zoneArmorReduction — l armure retiree, DERIVEE du kind empaquete', () => {
  it('rend zero pour un kind de reaction nulle : les zones generiques ne rabotent aucune armure', () => {
    expect(zoneArmorReduction(ELEMENT.GIVRE)).toBe(0);
    expect(zoneArmorReduction(packZoneKind(ELEMENT.GIVRE, REACTION.AUCUNE))).toBe(0);
  });

  it('rend zero pour les trois reactions de la tache 6 : aucune n a d effet sur l armure', () => {
    expect(zoneArmorReduction(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE))).toBe(0);
    expect(zoneArmorReduction(packZoneKind(ELEMENT.BRAISE, REACTION.EMBRASEMENT))).toBe(0);
    expect(zoneArmorReduction(packZoneKind(ELEMENT.FOUDRE, REACTION.COURT_CIRCUIT))).toBe(0);
  });

  it('rend SUPRACONDUCTION_ARMOR_REDUCTION pour la Supraconduction, quel que soit l element porte', () => {
    const surGivre = zoneArmorReduction(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION));
    const surFoudre = zoneArmorReduction(packZoneKind(ELEMENT.FOUDRE, REACTION.SUPRACONDUCTION));
    expect(SUPRACONDUCTION_ARMOR_REDUCTION).toBeGreaterThan(0);
    expect(surGivre).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);
    expect(surFoudre).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);
  });

  it('rend zero pour Verglas : elle agit par la vitesse et la collision, pas par l armure', () => {
    const surGivre = zoneArmorReduction(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS));
    const surPoix = zoneArmorReduction(packZoneKind(ELEMENT.POIX, REACTION.VERGLAS));
    expect(surGivre).toBe(0);
    expect(surPoix).toBe(0);
  });

  it('rend zero pour Vaporisation et Paratonnerre : ni l une ni l autre n a d effet sur l armure', () => {
    expect(zoneArmorReduction(packZoneKind(ELEMENT.BRAISE, REACTION.VAPORISATION))).toBe(0);
    expect(zoneArmorReduction(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.VAPORISATION))).toBe(0);
    expect(zoneArmorReduction(packZoneKind(ELEMENT.FOUDRE, REACTION.PARATONNERRE))).toBe(0);
    expect(zoneArmorReduction(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.PARATONNERRE))).toBe(0);
  });

  /**
   * ⚠️ **Arc caustique REUTILISE `SUPRACONDUCTION_ARMOR_REDUCTION`, jamais
   * recopiee.** Voir son entree dans `REACTION_DEFS` (`shared/reactions.ts`) :
   * deux reactions a deux elements dont l armure est l effet propre
   * principal partagent le meme reglage plutot que d en inventer un
   * troisieme non motive.
   */
  it('rend SUPRACONDUCTION_ARMOR_REDUCTION pour Arc caustique, quel que soit l element porte', () => {
    const surFoudre = zoneArmorReduction(packZoneKind(ELEMENT.FOUDRE, REACTION.ARC_CAUSTIQUE));
    const surChaux = zoneArmorReduction(packZoneKind(ELEMENT.CHAUX, REACTION.ARC_CAUSTIQUE));
    expect(SUPRACONDUCTION_ARMOR_REDUCTION).toBeGreaterThan(0);
    expect(surFoudre).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);
    expect(surChaux).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);
  });

  it('rend zero pour Gel profond, dans les DEUX ordres : elle agit par la vitesse, pas par l armure', () => {
    expect(zoneArmorReduction(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND))).toBe(0);
    expect(zoneArmorReduction(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.GEL_PROFOND))).toBe(0);
  });

  /**
   * ⚠️ **Mortier vif et Aveuglement REUTILISENT `elementOf(ELEMENT.CHAUX).armorReduction`
   * (donc `CHAUX_ARMOR_REDUCTION`), pas `MAX_ARMOR` comme Fournee — meme
   * choix qu Eclat de gel : ni l une ni l autre ne PRETEND a un effet
   * d armure propre au §5 de la spec, le plancher garantit seulement ce
   * qu une Chaux SEULE laisserait deja.**
   */
  it('rend CHAUX_ARMOR_REDUCTION pour Mortier vif, dans les DEUX ordres (Poix OU Chaux declenche)', () => {
    const poixDeclenche = zoneArmorReduction(packZoneKind(ELEMENT.POIX, REACTION.MORTIER_VIF));
    const chauxDeclenche = zoneArmorReduction(packZoneKind(ELEMENT.CHAUX, REACTION.MORTIER_VIF));
    expect(CHAUX_ARMOR_REDUCTION).toBeGreaterThan(0);
    expect(poixDeclenche).toBe(CHAUX_ARMOR_REDUCTION);
    expect(chauxDeclenche).toBe(CHAUX_ARMOR_REDUCTION);
  });

  it('rend CHAUX_ARMOR_REDUCTION pour Aveuglement, dans les DEUX ordres (Chaux OU Vif-argent declenche)', () => {
    const chauxDeclenche = zoneArmorReduction(packZoneKind(ELEMENT.CHAUX, REACTION.AVEUGLEMENT));
    const vifArgentDeclenche = zoneArmorReduction(
      packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT),
    );
    expect(chauxDeclenche).toBe(CHAUX_ARMOR_REDUCTION);
    expect(vifArgentDeclenche).toBe(CHAUX_ARMOR_REDUCTION);
  });
});

/**
 * `zoneArmorReductionTotal` — la tache 1 de l'etape 5c : combine
 * `zoneArmorReduction` (la reaction) et `Element.armorReduction` (la Chaux)
 * par un MAXIMUM, lue par `ZoneField.armorReductionAt` (`shared/zones.ts`).
 */
describe('zoneArmorReductionTotal — l armure retiree, ELEMENT et REACTION confondus', () => {
  it('rend zero pour un kind de reaction nulle sur un element sans effet propre', () => {
    expect(zoneArmorReductionTotal(ELEMENT.GIVRE)).toBe(0);
    expect(zoneArmorReductionTotal(packZoneKind(ELEMENT.BRAISE, REACTION.AUCUNE))).toBe(0);
  });

  it('rend CHAUX_ARMOR_REDUCTION pour un kind de reaction nulle porte par la Chaux : l element SEUL suffit', () => {
    // ⚠️ C'est le chemin que traverse une zone de Chaux tant qu'aucune
    // reaction nommee ne pair encore cet element (taches 4 a 7 de l'etape
    // 5c, hors perimetre) — la reaction generique (Choc thermique) laisse
    // `zoneArmorReduction` a zero, et c'est l'element seul qui porte l'effet.
    expect(CHAUX_ARMOR_REDUCTION).toBeGreaterThan(0);
    expect(zoneArmorReductionTotal(ELEMENT.CHAUX)).toBe(CHAUX_ARMOR_REDUCTION);
    expect(zoneArmorReductionTotal(packZoneKind(ELEMENT.CHAUX, REACTION.AUCUNE))).toBe(
      CHAUX_ARMOR_REDUCTION,
    );
  });

  it('rend toujours SUPRACONDUCTION_ARMOR_REDUCTION pour la Supraconduction : la reaction seule y suffit deja', () => {
    // Non-regression : la Supraconduction ne pair ni Braise ni Chaux, donc
    // la contribution ELEMENT reste nulle des deux cotes — seule celle de
    // la reaction doit compter, exactement comme avant cette tache.
    const surGivre = zoneArmorReductionTotal(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION));
    const surFoudre = zoneArmorReductionTotal(
      packZoneKind(ELEMENT.FOUDRE, REACTION.SUPRACONDUCTION),
    );
    expect(surGivre).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);
    expect(surFoudre).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);
  });

  /**
   * ⚠️ **LE test de l'etape 3 du brief — et une substitution assumee.** Le
   * brief cite `REACTION.FOURNEE` (Braise + Chaux) pour ce test : cette
   * reaction n'existe pas encore, elle nait a la tache 4 de l'etape 5c, HORS
   * du perimetre de cette tache-ci. `REACTION.SUPRACONDUCTION` la remplace
   * ici — n'importe quelle reaction dont `zoneArmorReduction` DOMINE la
   * contribution de la Chaux demontre exactement la meme invariant
   * (l'assertion de plancher juste en dessous rend cette substitution
   * verifiable, pas suppose). Voir le rapport de cette tache pour la
   * discussion complete.
   *
   * Meme motif que « la reduction d armure d une zone ne depend pas de
   * l ordre d arrivee » exige par le brief : la MEME reaction, les deux
   * ordres de declencheur (Braise, qui n a pas d effet propre, puis Chaux,
   * qui en a un) doivent rendre la MEME reduction — sans quoi une zone de
   * cette forme corroderait ou pas selon quel projectile a touche en second.
   */
  it('la reduction d armure d une zone ne depend pas de l ordre d arrivee', () => {
    // ⚠️ Garde de plancher : c'est cette inegalite, et NON une coincidence
    // de couple, qui rend le test suivant valide. Une tache 12 qui
    // changerait l'une des deux constantes sans preserver ce plancher ferait
    // rougir ICI, avec un message qui pointe la cause, plutot que de laisser
    // l'egalite d'apres echouer pour une raison illisible.
    expect(CHAUX_ARMOR_REDUCTION).toBeLessThanOrEqual(SUPRACONDUCTION_ARMOR_REDUCTION);

    const a = zoneArmorReductionTotal(packZoneKind(ELEMENT.BRAISE, REACTION.SUPRACONDUCTION));
    const b = zoneArmorReductionTotal(packZoneKind(ELEMENT.CHAUX, REACTION.SUPRACONDUCTION));
    expect(a).toBe(b);
    // ⚠️ Et une garde de non-vacuite : si les deux valaient 0, l'egalite
    // serait vraie et ne prouverait rien.
    expect(a).toBeGreaterThan(0);
  });

  /**
   * ⚠️ **LE test reel de l'etape 3 du brief, cette fois avec Fournee
   * elle-meme** — plus une substitution, la reaction existe. Fournee pousse
   * `zoneArmorReduction` a `MAX_ARMOR`, qui domine n'importe quelle
   * contribution de l'element (`CHAUX_ARMOR_REDUCTION`, tres en dessous) :
   * les deux ordres de declencheur (Braise, qui n'a pas d'effet d'armure
   * propre, puis Chaux, qui en a un) doivent donc rendre la MEME reduction.
   */
  it('Fournee ne depend pas de l ordre d arrivee : l armure retiree vaut MAX_ARMOR dans les deux ordres', () => {
    expect(CHAUX_ARMOR_REDUCTION).toBeLessThan(MAX_ARMOR);

    const braiseDeclenche = zoneArmorReductionTotal(packZoneKind(ELEMENT.BRAISE, REACTION.FOURNEE));
    const chauxDeclenche = zoneArmorReductionTotal(packZoneKind(ELEMENT.CHAUX, REACTION.FOURNEE));
    expect(braiseDeclenche).toBe(chauxDeclenche);
    expect(braiseDeclenche).toBe(MAX_ARMOR);
  });

  /**
   * ⚠️ **Eclat de gel n'a pourtant AUCUN effet d'armure « a elle », et porte
   * quand meme un plancher explicite** — voir le commentaire de son entree
   * dans `REACTION_DEFS` (`shared/reactions.ts`) : la zone qu'elle laisse
   * (posee par `postZone` pour CHAQUE declencheur, sans exception) porterait
   * sinon la fuite de la Chaux une fois sur deux. Le plancher choisi
   * (`elementOf(ELEMENT.CHAUX).armorReduction`) ne fait que garantir ce
   * qu'une Chaux SEULE laisserait deja.
   */
  it('Eclat de gel ne depend pas de l ordre d arrivee : l armure retiree vaut CHAUX_ARMOR_REDUCTION dans les deux ordres', () => {
    const givreDeclenche = zoneArmorReductionTotal(
      packZoneKind(ELEMENT.GIVRE, REACTION.ECLAT_DE_GEL),
    );
    const chauxDeclenche = zoneArmorReductionTotal(
      packZoneKind(ELEMENT.CHAUX, REACTION.ECLAT_DE_GEL),
    );
    expect(givreDeclenche).toBe(chauxDeclenche);
    expect(givreDeclenche).toBe(CHAUX_ARMOR_REDUCTION);
    expect(givreDeclenche).toBeGreaterThan(0);
  });

  it('rend zero pour Vaporisation et Paratonnerre, dans les DEUX ordres : ni la Braise ni le Vif-argent n ont d effet d armure', () => {
    const braiseDeclenche = zoneArmorReductionTotal(
      packZoneKind(ELEMENT.BRAISE, REACTION.VAPORISATION),
    );
    const vifArgentDeclenche = zoneArmorReductionTotal(
      packZoneKind(ELEMENT.VIF_ARGENT, REACTION.VAPORISATION),
    );
    expect(braiseDeclenche).toBe(0);
    expect(vifArgentDeclenche).toBe(0);

    const foudreDeclenche = zoneArmorReductionTotal(
      packZoneKind(ELEMENT.FOUDRE, REACTION.PARATONNERRE),
    );
    const vifArgentDeclenche2 = zoneArmorReductionTotal(
      packZoneKind(ELEMENT.VIF_ARGENT, REACTION.PARATONNERRE),
    );
    expect(foudreDeclenche).toBe(0);
    expect(vifArgentDeclenche2).toBe(0);
  });

  /**
   * ⚠️ **Arc caustique apparie la Chaux : le plancher explicite
   * (`SUPRACONDUCTION_ARMOR_REDUCTION`) doit dominer `CHAUX_ARMOR_REDUCTION`
   * pour rendre les deux ordres identiques — meme garde de plancher que
   * Fournee et Supraconduction ci-dessus.**
   */
  it('Arc caustique ne depend pas de l ordre d arrivee : l armure retiree vaut SUPRACONDUCTION_ARMOR_REDUCTION dans les deux ordres', () => {
    expect(CHAUX_ARMOR_REDUCTION).toBeLessThanOrEqual(SUPRACONDUCTION_ARMOR_REDUCTION);

    const foudreDeclenche = zoneArmorReductionTotal(
      packZoneKind(ELEMENT.FOUDRE, REACTION.ARC_CAUSTIQUE),
    );
    const chauxDeclenche = zoneArmorReductionTotal(
      packZoneKind(ELEMENT.CHAUX, REACTION.ARC_CAUSTIQUE),
    );
    expect(foudreDeclenche).toBe(chauxDeclenche);
    expect(foudreDeclenche).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);
    expect(foudreDeclenche).toBeGreaterThan(0);
  });

  it('rend zero pour Gel profond, dans les DEUX ordres : ni le Givre ni le Vif-argent n ont d effet d armure', () => {
    expect(zoneArmorReductionTotal(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND))).toBe(0);
    expect(zoneArmorReductionTotal(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.GEL_PROFOND))).toBe(0);
  });

  /**
   * ⚠️ **Mortier vif et Aveuglement ne dependent pas de l ordre d arrivee :
   * l armure retiree vaut CHAUX_ARMOR_REDUCTION dans les deux ordres —
   * meme raisonnement qu Eclat de gel (le plancher garantit ce qu une Chaux
   * SEULE laisserait deja, il ne l AUGMENTE pas).**
   */
  it('Mortier vif ne depend pas de l ordre d arrivee : l armure retiree vaut CHAUX_ARMOR_REDUCTION dans les deux ordres', () => {
    const poixDeclenche = zoneArmorReductionTotal(packZoneKind(ELEMENT.POIX, REACTION.MORTIER_VIF));
    const chauxDeclenche = zoneArmorReductionTotal(
      packZoneKind(ELEMENT.CHAUX, REACTION.MORTIER_VIF),
    );
    expect(poixDeclenche).toBe(chauxDeclenche);
    expect(poixDeclenche).toBe(CHAUX_ARMOR_REDUCTION);
    expect(poixDeclenche).toBeGreaterThan(0);
  });

  it('Aveuglement ne depend pas de l ordre d arrivee : l armure retiree vaut CHAUX_ARMOR_REDUCTION dans les deux ordres', () => {
    const chauxDeclenche = zoneArmorReductionTotal(
      packZoneKind(ELEMENT.CHAUX, REACTION.AVEUGLEMENT),
    );
    const vifArgentDeclenche = zoneArmorReductionTotal(
      packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT),
    );
    expect(chauxDeclenche).toBe(vifArgentDeclenche);
    expect(chauxDeclenche).toBe(CHAUX_ARMOR_REDUCTION);
    expect(chauxDeclenche).toBeGreaterThan(0);
  });
});

/**
 * `zoneInertiaDamping` — la tache 8 de l'etape 5b : le facteur de
 * conservation de vitesse DERIVE du kind empaquete, lu par
 * `Horde#recomputeSteering` (`shared/horde.ts`), qui VOYAGE.
 */
describe('zoneInertiaDamping — le facteur d inertie DERIVE du kind empaquete', () => {
  it('rend 1 (aucun effet) pour un kind de reaction nulle', () => {
    expect(zoneInertiaDamping(ELEMENT.GIVRE)).toBe(1);
    expect(zoneInertiaDamping(packZoneKind(ELEMENT.GIVRE, REACTION.AUCUNE))).toBe(1);
  });

  it('rend 1 pour les quatre reactions des taches 6 et 7 : aucune n a d effet d inertie', () => {
    expect(zoneInertiaDamping(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE))).toBe(1);
    expect(zoneInertiaDamping(packZoneKind(ELEMENT.BRAISE, REACTION.EMBRASEMENT))).toBe(1);
    expect(zoneInertiaDamping(packZoneKind(ELEMENT.FOUDRE, REACTION.COURT_CIRCUIT))).toBe(1);
    expect(zoneInertiaDamping(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION))).toBe(1);
  });

  it('rend 1 pour Fournee et Eclat de gel (tache 4 de l etape 5c) : ni l une ni l autre n a d effet d inertie', () => {
    expect(zoneInertiaDamping(packZoneKind(ELEMENT.BRAISE, REACTION.FOURNEE))).toBe(1);
    expect(zoneInertiaDamping(packZoneKind(ELEMENT.GIVRE, REACTION.ECLAT_DE_GEL))).toBe(1);
  });

  it('rend 1 pour Vaporisation, Arc caustique et Paratonnerre (tache 5 de l etape 5c) : aucune n a d effet d inertie', () => {
    expect(zoneInertiaDamping(packZoneKind(ELEMENT.BRAISE, REACTION.VAPORISATION))).toBe(1);
    expect(zoneInertiaDamping(packZoneKind(ELEMENT.FOUDRE, REACTION.ARC_CAUSTIQUE))).toBe(1);
    expect(zoneInertiaDamping(packZoneKind(ELEMENT.FOUDRE, REACTION.PARATONNERRE))).toBe(1);
  });

  it('rend VERGLAS_INERTIA_DAMPING (< 1) pour Verglas, quel que soit l element porte par le nibble', () => {
    const givreDeclenche = zoneInertiaDamping(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS));
    const poixDeclenche = zoneInertiaDamping(packZoneKind(ELEMENT.POIX, REACTION.VERGLAS));
    expect(VERGLAS_INERTIA_DAMPING).toBeLessThan(1);
    expect(givreDeclenche).toBe(VERGLAS_INERTIA_DAMPING);
    expect(poixDeclenche).toBe(VERGLAS_INERTIA_DAMPING);
  });
});

/**
 * `zoneCollisionDamage` — la tache 8 de l'etape 5b : le degat de collision
 * DERIVE du kind empaquete, lu par `resolveVerglasCollisions`
 * (`back/src/combat.ts`), qui ne voyage JAMAIS (un degat, serveur seul).
 */
describe('zoneCollisionDamage — le degat de collision DERIVE du kind empaquete', () => {
  it('rend zero pour un kind de reaction nulle', () => {
    expect(zoneCollisionDamage(ELEMENT.GIVRE)).toBe(0);
    expect(zoneCollisionDamage(packZoneKind(ELEMENT.GIVRE, REACTION.AUCUNE))).toBe(0);
  });

  it('rend zero pour les quatre reactions des taches 6 et 7 : aucune n a d effet de collision', () => {
    expect(zoneCollisionDamage(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE))).toBe(0);
    expect(zoneCollisionDamage(packZoneKind(ELEMENT.BRAISE, REACTION.EMBRASEMENT))).toBe(0);
    expect(zoneCollisionDamage(packZoneKind(ELEMENT.FOUDRE, REACTION.COURT_CIRCUIT))).toBe(0);
    expect(zoneCollisionDamage(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION))).toBe(0);
  });

  it('rend zero pour Fournee et Eclat de gel (tache 4 de l etape 5c) : ni l une ni l autre n a d effet de collision', () => {
    expect(zoneCollisionDamage(packZoneKind(ELEMENT.BRAISE, REACTION.FOURNEE))).toBe(0);
    expect(zoneCollisionDamage(packZoneKind(ELEMENT.GIVRE, REACTION.ECLAT_DE_GEL))).toBe(0);
  });

  it('rend zero pour Vaporisation, Arc caustique et Paratonnerre (tache 5 de l etape 5c) : aucune n a d effet de collision', () => {
    expect(zoneCollisionDamage(packZoneKind(ELEMENT.BRAISE, REACTION.VAPORISATION))).toBe(0);
    expect(zoneCollisionDamage(packZoneKind(ELEMENT.FOUDRE, REACTION.ARC_CAUSTIQUE))).toBe(0);
    expect(zoneCollisionDamage(packZoneKind(ELEMENT.FOUDRE, REACTION.PARATONNERRE))).toBe(0);
  });

  it('rend VERGLAS_COLLISION_DAMAGE_PER_TICK (> 0) pour Verglas, quel que soit l element porte', () => {
    const givreDeclenche = zoneCollisionDamage(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS));
    const poixDeclenche = zoneCollisionDamage(packZoneKind(ELEMENT.POIX, REACTION.VERGLAS));
    expect(VERGLAS_COLLISION_DAMAGE_PER_TICK).toBeGreaterThan(0);
    expect(givreDeclenche).toBe(VERGLAS_COLLISION_DAMAGE_PER_TICK);
    expect(poixDeclenche).toBe(VERGLAS_COLLISION_DAMAGE_PER_TICK);
  });
});

/**
 * `zoneFieldSign` — la tache 1 de l'etape 5c : le signe de direction DERIVE
 * du kind empaquete, lu par `Horde` (`shared/horde.ts`), qui VOYAGE.
 */
describe('zoneFieldSign — le signe de direction, ELEMENT et REACTION confondus', () => {
  it('rend +1 (aucun effet) pour un kind de reaction nulle sur un element sans effet propre', () => {
    expect(zoneFieldSign(ELEMENT.GIVRE)).toBe(1);
    expect(zoneFieldSign(packZoneKind(ELEMENT.BRAISE, REACTION.AUCUNE))).toBe(1);
  });

  it('rend -1 pour un kind de reaction nulle porte par la Chaux : l element SEUL suffit', () => {
    // Meme chemin transitoire que `zoneArmorReductionTotal` avant Fournee :
    // tant qu'aucune reaction nommee ne pair la Chaux (taches 4 a 7, hors
    // perimetre), c'est l'element seul qui porte la fuite.
    expect(zoneFieldSign(ELEMENT.CHAUX)).toBe(-1);
    expect(zoneFieldSign(packZoneKind(ELEMENT.CHAUX, REACTION.AUCUNE))).toBe(-1);
  });

  it('rend +1 pour les cinq reactions existantes quand aucun element du nibble ne fuit', () => {
    expect(zoneFieldSign(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE))).toBe(1);
    expect(zoneFieldSign(packZoneKind(ELEMENT.BRAISE, REACTION.EMBRASEMENT))).toBe(1);
    expect(zoneFieldSign(packZoneKind(ELEMENT.FOUDRE, REACTION.COURT_CIRCUIT))).toBe(1);
    expect(zoneFieldSign(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION))).toBe(1);
    expect(zoneFieldSign(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS))).toBe(1);
  });

  /**
   * ⚠️ **Le piege transitoire que le docbloc de `zoneFieldSign` documente.**
   * Aucune des cinq reactions existantes ne pair la Chaux, donc AUCUNE ne
   * porte encore de `zoneFieldSign: -1` explicite qui garantirait la fuite
   * quel que soit l'element du nibble. Ce test rend ce fait EXPLICITE plutot
   * que de le laisser en silence : packe la Chaux avec une reaction
   * existante (un cas qui n'arrive jamais en jeu tel quel, mais qui exerce
   * le meme mecanisme qu'un futur couple de la Chaux) et constate que seul
   * l'ordre ou la Chaux est LE DECLENCHEUR fuit.
   */
  it('reste ORDRE-DEPENDANT tant qu aucune reaction ne porte un plancher explicite pour la Chaux', () => {
    const chauxDeclenche = zoneFieldSign(packZoneKind(ELEMENT.CHAUX, REACTION.SUPRACONDUCTION));
    const givreDeclenche = zoneFieldSign(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION));
    expect(chauxDeclenche).toBe(-1);
    expect(givreDeclenche).toBe(1);
  });

  /**
   * ⚠️ **Fournee et Eclat de gel FERMENT le piege transitoire ci-dessus,
   * pour leurs deux couples.** Toutes deux portent `zoneFieldSign: -1`
   * EXPLICITE dans `REACTION_DEFS` (`shared/reactions.ts`) — jamais heritee
   * de l'element — donc les deux ordres de declencheur rendent desormais la
   * MEME reponse, -1, exactement le remede que Verglas a deja applique pour
   * `zoneSlowFactor`.
   */
  it('Fournee ne depend plus de l ordre d arrivee : -1 que Braise ou Chaux declenche', () => {
    const braiseDeclenche = zoneFieldSign(packZoneKind(ELEMENT.BRAISE, REACTION.FOURNEE));
    const chauxDeclenche = zoneFieldSign(packZoneKind(ELEMENT.CHAUX, REACTION.FOURNEE));
    expect(braiseDeclenche).toBe(-1);
    expect(chauxDeclenche).toBe(-1);
  });

  it('Eclat de gel ne depend pas non plus de l ordre d arrivee : -1 que Givre ou Chaux declenche', () => {
    const givreDeclenche = zoneFieldSign(packZoneKind(ELEMENT.GIVRE, REACTION.ECLAT_DE_GEL));
    const chauxDeclenche = zoneFieldSign(packZoneKind(ELEMENT.CHAUX, REACTION.ECLAT_DE_GEL));
    expect(givreDeclenche).toBe(-1);
    expect(chauxDeclenche).toBe(-1);
  });

  it('rend +1 pour Vaporisation et Paratonnerre, dans les DEUX ordres : ni l un ni l autre ne pair la Chaux', () => {
    expect(zoneFieldSign(packZoneKind(ELEMENT.BRAISE, REACTION.VAPORISATION))).toBe(1);
    expect(zoneFieldSign(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.VAPORISATION))).toBe(1);
    expect(zoneFieldSign(packZoneKind(ELEMENT.FOUDRE, REACTION.PARATONNERRE))).toBe(1);
    expect(zoneFieldSign(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.PARATONNERRE))).toBe(1);
  });

  /**
   * ⚠️ **Arc caustique FERME le meme piege transitoire, pour son propre
   * couple.** Porte `zoneFieldSign: elementOf(ELEMENT.CHAUX).fieldSign`
   * EXPLICITE dans `REACTION_DEFS` — jamais heritee de l'element — donc les
   * deux ordres de declencheur (Foudre, qui n'a pas d'effet propre, puis
   * Chaux, qui en a un) rendent desormais la MEME reponse, -1.
   */
  it('Arc caustique ne depend pas de l ordre d arrivee : -1 que Foudre ou Chaux declenche', () => {
    const foudreDeclenche = zoneFieldSign(packZoneKind(ELEMENT.FOUDRE, REACTION.ARC_CAUSTIQUE));
    const chauxDeclenche = zoneFieldSign(packZoneKind(ELEMENT.CHAUX, REACTION.ARC_CAUSTIQUE));
    expect(foudreDeclenche).toBe(-1);
    expect(chauxDeclenche).toBe(-1);
  });

  it('rend +1 pour Gel profond, dans les DEUX ordres : ni le Givre ni le Vif-argent ne fuient', () => {
    expect(zoneFieldSign(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND))).toBe(1);
    expect(zoneFieldSign(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.GEL_PROFOND))).toBe(1);
  });

  /**
   * ⚠️ **Mortier vif FERME le meme piege transitoire que Fournee/Eclat de
   * gel/Arc caustique, pour son propre couple.** Porte
   * `zoneFieldSign: elementOf(ELEMENT.CHAUX).fieldSign` EXPLICITE dans
   * `REACTION_DEFS` — jamais heritee de l'element — donc les deux ordres de
   * declencheur (Poix, qui n'a pas d'effet propre, puis Chaux, qui en a un)
   * rendent desormais la MEME reponse, -1. L'effet PRATIQUE est masque par
   * le gel total de `zoneSlowFactor` (voir le point de revue n°4,
   * `shared/horde.test.ts`), mais l'OCTET, lui, ne doit pas dependre de
   * l'ordre.
   */
  it('Mortier vif ne depend pas de l ordre d arrivee : -1 que Poix ou Chaux declenche', () => {
    const poixDeclenche = zoneFieldSign(packZoneKind(ELEMENT.POIX, REACTION.MORTIER_VIF));
    const chauxDeclenche = zoneFieldSign(packZoneKind(ELEMENT.CHAUX, REACTION.MORTIER_VIF));
    expect(poixDeclenche).toBe(-1);
    expect(chauxDeclenche).toBe(-1);
  });

  /**
   * ⚠️ **Aveuglement FERME le meme piege transitoire pour son propre
   * couple — LA raison d'etre de la reaction.** Vif-argent est neutre sur
   * `fieldSign` : sans le plancher explicite, une zone d'Aveuglement
   * fuirait uniquement quand la Chaux est arrivee EN SECOND, exactement le
   * meme etat transitoire documente par le docbloc de `zoneFieldSign` avant
   * Fournee.
   */
  it('Aveuglement ne depend pas de l ordre d arrivee : -1 que Chaux ou Vif-argent declenche', () => {
    const chauxDeclenche = zoneFieldSign(packZoneKind(ELEMENT.CHAUX, REACTION.AVEUGLEMENT));
    const vifArgentDeclenche = zoneFieldSign(
      packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT),
    );
    expect(chauxDeclenche).toBe(-1);
    expect(vifArgentDeclenche).toBe(-1);
  });
});

/**
 * `zoneDamageAmpTotal` — la tache 6 de l'etape 5c : l'amplification des
 * degats, ELEMENT et REACTION confondus, lue par `ZoneField.ampAt`
 * (`shared/zones.ts`). La piece qui manquait (voir le docbloc du champ
 * `zoneDamageAmp` dans `shared/reactions.ts`) — Mortier vif (Poix + Chaux)
 * est la premiere ligne de `REACTION_DEFS` a le porter.
 */
describe('zoneDamageAmpTotal — l amplification des degats, ELEMENT et REACTION confondus', () => {
  it('rend 1 pour un kind de reaction nulle sur un element sans effet propre', () => {
    expect(zoneDamageAmpTotal(ELEMENT.GIVRE)).toBe(1);
    expect(zoneDamageAmpTotal(packZoneKind(ELEMENT.BRAISE, REACTION.AUCUNE))).toBe(1);
  });

  it('rend le damageAmp de la Poix pour un kind de reaction nulle porte par la Poix : l element SEUL suffit', () => {
    expect(elementOf(ELEMENT.POIX).damageAmp).toBeGreaterThan(1);
    expect(zoneDamageAmpTotal(ELEMENT.POIX)).toBe(elementOf(ELEMENT.POIX).damageAmp);
    expect(zoneDamageAmpTotal(packZoneKind(ELEMENT.POIX, REACTION.AUCUNE))).toBe(
      elementOf(ELEMENT.POIX).damageAmp,
    );
  });

  it('rend 1 pour les dix reactions precedentes, sur un element neutre : aucune ne porte de zoneDamageAmp', () => {
    expect(zoneDamageAmpTotal(packZoneKind(ELEMENT.BRAISE, REACTION.SURCHAUFFE))).toBe(1);
    expect(zoneDamageAmpTotal(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION))).toBe(1);
    expect(zoneDamageAmpTotal(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS))).toBe(1);
    expect(zoneDamageAmpTotal(packZoneKind(ELEMENT.BRAISE, REACTION.FOURNEE))).toBe(1);
    expect(zoneDamageAmpTotal(packZoneKind(ELEMENT.GIVRE, REACTION.ECLAT_DE_GEL))).toBe(1);
    expect(zoneDamageAmpTotal(packZoneKind(ELEMENT.FOUDRE, REACTION.ARC_CAUSTIQUE))).toBe(1);
    expect(zoneDamageAmpTotal(packZoneKind(ELEMENT.FOUDRE, REACTION.PARATONNERRE))).toBe(1);
  });

  it('rend 1 pour Gel profond et Aveuglement, dans les DEUX ordres chacune : ni l une ni l autre n apparie la Poix', () => {
    expect(zoneDamageAmpTotal(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND))).toBe(1);
    expect(zoneDamageAmpTotal(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.GEL_PROFOND))).toBe(1);
    expect(zoneDamageAmpTotal(packZoneKind(ELEMENT.CHAUX, REACTION.AVEUGLEMENT))).toBe(1);
    expect(zoneDamageAmpTotal(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT))).toBe(1);
  });

  /**
   * ⚠️ **LE test qui separe la combinaison par maximum d une simple lecture
   * de l element — meme forme que le test equivalent de `zoneSlowFactor`
   * pour la Supraconduction.** Le nibble d'element d'une zone de Mortier vif
   * porte celui du DECLENCHEUR (Poix OU Chaux selon l'ordre d'arrivee) :
   * `elementOf(zoneElement(kind)).damageAmp` seul rendrait 1,5 (Poix) ou 1
   * (Chaux), deux nombres DIFFERENTS. Le plancher explicite
   * (`ReactionDef.zoneDamageAmp: elementOf(ELEMENT.POIX).damageAmp`) rend
   * les deux ordres identiques.
   */
  it('rend le damageAmp de la Poix pour Mortier vif, dans les DEUX ordres (Poix OU Chaux declenche)', () => {
    const poixDeclenche = zoneDamageAmpTotal(packZoneKind(ELEMENT.POIX, REACTION.MORTIER_VIF));
    const chauxDeclenche = zoneDamageAmpTotal(packZoneKind(ELEMENT.CHAUX, REACTION.MORTIER_VIF));
    // Non-vacuite : Poix et Chaux n'ont PAS le meme damageAmp — sans
    // plancher EXPLICITE, les deux lignes ci-dessous rendraient des valeurs
    // differentes.
    expect(elementOf(ELEMENT.POIX).damageAmp).not.toBe(elementOf(ELEMENT.CHAUX).damageAmp);
    expect(poixDeclenche).toBe(chauxDeclenche);
    expect(poixDeclenche).toBe(elementOf(ELEMENT.POIX).damageAmp);
  });

  /**
   * ⚠️ **L'invariant dont le test precedent depend, ASSENE — pas seulement
   * observe, meme discipline que le test equivalent de Verglas pour
   * `zoneSlowFactor`.** `zoneDamageAmpTotal` combine par MAXIMUM
   * (`Math.max(elementFactor, reactionFactor)`) : l'independance a l'ordre
   * ne tient QUE SI `reactionFactor` reste un PLAFOND — superieur ou egal au
   * `damageAmp` de CHAQUE element qui peut apparaitre dans le nibble.
   */
  it('le plancher de Mortier vif reste un PLAFOND pour les deux elements de sa propre paire', () => {
    const def = reactionOfId(REACTION.MORTIER_VIF);
    expect(def).toBeDefined();
    const [a, b] = unpackElementPair(def?.pair ?? 0);
    for (const element of [a, b]) {
      expect(def?.zoneDamageAmp).toBeGreaterThanOrEqual(elementOf(element).damageAmp);
    }
  });
});
