import { describe, expect, it } from 'vitest';

import {
  REACTION_DAMAGE,
  REACTION_RADIUS,
  SUPRACONDUCTION_ARMOR_REDUCTION,
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
  zoneBurnPerTick,
  zoneCollisionDamage,
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

  it('rend VERGLAS_COLLISION_DAMAGE_PER_TICK (> 0) pour Verglas, quel que soit l element porte', () => {
    const givreDeclenche = zoneCollisionDamage(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS));
    const poixDeclenche = zoneCollisionDamage(packZoneKind(ELEMENT.POIX, REACTION.VERGLAS));
    expect(VERGLAS_COLLISION_DAMAGE_PER_TICK).toBeGreaterThan(0);
    expect(givreDeclenche).toBe(VERGLAS_COLLISION_DAMAGE_PER_TICK);
    expect(poixDeclenche).toBe(VERGLAS_COLLISION_DAMAGE_PER_TICK);
  });
});
