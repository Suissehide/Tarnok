import { describe, expect, it } from 'vitest';

import {
  REACTION_DAMAGE,
  REACTION_RADIUS,
  SUPRACONDUCTION_ARMOR_REDUCTION,
  ZONE_LIFETIME_TICKS,
} from './constants';
import { ELEMENT, elementOf } from './elements';
import { packElementPair, packZoneKind } from './protocol';
import {
  REACTION,
  reactionForPair,
  reactionOfId,
  zoneArmorReduction,
  zoneBurnPerTick,
  zoneLifetimeTicks,
  zoneSlowFactor,
} from './reactions';

describe('reactionForPair — une table pilotee par la donnee, pas un switch sur la paire', () => {
  it('trouve les QUATRE reactions (taches 6 et 7), chacune a son propre couple canonique', () => {
    const surchauffe = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.FOUDRE));
    const embrasement = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.POIX));
    const courtCircuit = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.POIX));
    const supraconduction = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.FOUDRE));

    expect(surchauffe?.id).toBe(REACTION.SURCHAUFFE);
    expect(embrasement?.id).toBe(REACTION.EMBRASEMENT);
    expect(courtCircuit?.id).toBe(REACTION.COURT_CIRCUIT);
    expect(supraconduction?.id).toBe(REACTION.SUPRACONDUCTION);
    // Quatre identifiants distincts : une table qui en confondrait deux
    // resoudrait la mauvaise reaction pour au moins un couple.
    expect(
      new Set([surchauffe?.id, embrasement?.id, courtCircuit?.id, supraconduction?.id]).size,
    ).toBe(4);
  });

  it('est INSENSIBLE a l ordre d arrivee, comme `packElementPair`', () => {
    // La paire canonique ne connait pas qui est arrive en premier — un
    // declencheur Braise-puis-Foudre et un Foudre-puis-Braise doivent
    // trouver la MEME reaction.
    const a = reactionForPair(packElementPair(ELEMENT.BRAISE, ELEMENT.FOUDRE));
    const b = reactionForPair(packElementPair(ELEMENT.FOUDRE, ELEMENT.BRAISE));
    expect(a?.id).toBe(REACTION.SURCHAUFFE);
    expect(b?.id).toBe(REACTION.SURCHAUFFE);
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
  });

  it('rend `undefined` pour `REACTION.AUCUNE` (0) : aucune ligne ne le porte', () => {
    expect(reactionOfId(REACTION.AUCUNE)).toBeUndefined();
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
});
