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
  ZONE_RADIUS,
} from './constants';
import { ELEMENT, elementOf } from './elements';
import { packElementPair, packZoneKind, unpackElementPair, zoneReaction } from './protocol';
import {
  REACTION,
  REACTION_DEFS,
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
  zoneRadius,
  zoneShape,
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
    // Absence deliberee de la table : `applyReactions` retombe alors sur le
    // comportement generique. `undefined`, pas une entree « AUCUNE » : un
    // appelant qui oublierait le fallback rougirait immediatement sur `.id`.
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
    // Sept identifiants distincts : une collision confondrait le mauvais couple.
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
    // Dix identifiants distincts : une collision confondrait le mauvais couple.
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
    // Treize identifiants distincts : une collision confondrait le mauvais couple.
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
    // ⚠️ Les trois sont des reactions de « zone », contrairement a
    // Embrasement/Vaporisation (geometrique) ou Court-circuit/Arc
    // caustique/Paratonnerre (chaine) : sans branche dediee dans
    // `applyReactions` (`back/src/combat.ts`), elles retombent sur le degat
    // GENERIQUE du Choc thermique, comme Supraconduction, Verglas et Fournee.
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

describe('Amalgame (tache 7 de l etape 5c) — la quatorzieme ligne, meme table', () => {
  it('trouve Amalgame (Poix + Vif-argent) par son couple canonique, quatorze identifiants distincts au total', () => {
    const amalgame = reactionForPair(packElementPair(ELEMENT.POIX, ELEMENT.VIF_ARGENT));
    expect(amalgame?.id).toBe(REACTION.AMALGAME);

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
    const gelProfond = reactionForPair(packElementPair(ELEMENT.GIVRE, ELEMENT.VIF_ARGENT));
    const mortierVif = reactionForPair(packElementPair(ELEMENT.POIX, ELEMENT.CHAUX));
    const aveuglement = reactionForPair(packElementPair(ELEMENT.CHAUX, ELEMENT.VIF_ARGENT));
    // Quatorze identifiants distincts. Le describe « invariant de
    // REACTION_DEFS » plus bas derive la meme garde de la table elle-meme.
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
        amalgame?.id,
      ]).size,
    ).toBe(14);
  });

  it('est INSENSIBLE a l ordre d arrivee, comme les treize reactions precedentes', () => {
    const a = reactionForPair(packElementPair(ELEMENT.POIX, ELEMENT.VIF_ARGENT));
    const b = reactionForPair(packElementPair(ELEMENT.VIF_ARGENT, ELEMENT.POIX));
    expect(a?.id).toBe(REACTION.AMALGAME);
    expect(b?.id).toBe(REACTION.AMALGAME);
  });

  it('retrouve Amalgame par `reactionOfId`, le nibble empaquete dans `ZoneField.kind`', () => {
    expect(reactionOfId(REACTION.AMALGAME)?.name).toBe('amalgame');
  });

  it('Amalgame ne pose aucun effet geometrique ou en chaine propre a la table : radius nul, damage reutilise REACTION_DAMAGE', () => {
    // ⚠️ `shareAmalgameDamage` (`back/src/combat.ts`) est une branche DEDIEE
    // qui lit `def.damage` directement, contrairement a Gel profond/Mortier
    // vif/Aveuglement qui retombent sur le Choc thermique generique.
    const amalgame = reactionForPair(packElementPair(ELEMENT.POIX, ELEMENT.VIF_ARGENT));
    expect(amalgame?.radius).toBe(0);
    expect(amalgame?.damage).toBe(REACTION_DAMAGE);
  });
});

/**
 * ⚠️ `REACTION_DEFS` empaquete son `id` dans un nibble de 4 bits
 * (`packZoneKind`/`zoneReaction`, `shared/protocol.ts`) : QUINZE valeurs sont
 * occupees (`AUCUNE` + quatorze reactions) sur SEIZE. Une reaction de trop
 * deborderait le nibble EN SILENCE (`(reaction & 0x0f) << 3` tronque, ne leve
 * jamais) : ces tests la refusent, et gardent l'unicite des `id` et des `pair`.
 */
describe('invariant de table sur REACTION_DEFS (tache 7 de l etape 5c)', () => {
  // ⚠️ **La borne se DERIVE de la vraie largeur du nibble, jamais ecrite en
  // dur.** `zoneReaction` masque a `0x0f` : un `kind` dont tous les bits
  // valent 1 rend la valeur MAXIMALE du nibble : si ce champ s'elargit dans
  // `shared/protocol.ts`, la borne suit.
  const maxReactionId = zoneReaction(0xffffffff);

  it('la borne se derive bien a 15 aujourd hui : un nibble de 4 bits, seize valeurs', () => {
    expect(maxReactionId).toBe(15);
  });

  it('tous les `id` de REACTION_DEFS sont dans [0, maxReactionId] et STRICTEMENT uniques', () => {
    const ids = REACTION_DEFS.map((r) => r.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThanOrEqual(maxReactionId);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tous les `pair` de REACTION_DEFS sont STRICTEMENT uniques — deux reactions sur la meme paire seraient indetectables autrement', () => {
    const pairs = REACTION_DEFS.map((r) => r.pair);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('Amalgame occupe l avant-derniere valeur representable : quinze reactions sur seize, une de reste', () => {
    // AUCUNE (0) + les quatorze reactions nommees (1 a 14, dont Amalgame,
    // 14) = quinze valeurs occupees sur seize ; 15 reste libre.
    expect(REACTION.AMALGAME).toBe(maxReactionId - 1);
    const idsAvecAucune = new Set([REACTION.AUCUNE, ...REACTION_DEFS.map((r) => r.id)]);
    expect(idsAvecAucune.size).toBe(maxReactionId); // 15 valeurs occupees.
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
   * Ces trois cas gardent la MECANIQUE, pas la valeur de chaque ligne : la
   * duree sort du `kind` seul, elle tient dans une fourchette lisible, et `0`
   * veut dire « la generique ».
   */
  it('rend une duree a chaque reaction, dans une fourchette lisible', () => {
    for (const def of REACTION_DEFS) {
      const vie = zoneLifetimeTicks(packZoneKind(ELEMENT.BRAISE, def.id));
      expect(vie, def.name).toBeGreaterThanOrEqual(ZONE_LIFETIME_TICKS / 2);
      expect(vie, def.name).toBeLessThanOrEqual(ZONE_LIFETIME_TICKS * 2);
    }
  });

  it('fait VARIER la duree d une reaction a l autre : deux bornes distinctes au moins', () => {
    const vies = new Set(
      REACTION_DEFS.map((def) => zoneLifetimeTicks(packZoneKind(ELEMENT.BRAISE, def.id))),
    );
    // Trois valeurs distinctes au moins : sans ca, « des durees differentes »
    // serait vrai sur le papier et faux a l'ecran.
    expect(vies.size).toBeGreaterThanOrEqual(3);
    expect(Math.min(...vies)).toBeLessThan(ZONE_LIFETIME_TICKS);
    expect(Math.max(...vies)).toBeGreaterThan(ZONE_LIFETIME_TICKS);
  });

  it('garde `0` comme « la generique », pour les lignes qui ne tranchent pas', () => {
    // ⚠️ `0` veut dire « pas de duree propre », pas « duree nulle » : lu comme
    // une duree reelle, il ferait mourir la zone au tick meme de sa pose.
    const sansDuree = REACTION_DEFS.filter((def) => def.zoneLifetimeTicks === 0);
    for (const def of sansDuree) {
      expect(zoneLifetimeTicks(packZoneKind(ELEMENT.BRAISE, def.id)), def.name).toBe(
        ZONE_LIFETIME_TICKS,
      );
    }
  });

  /**
   * ⚠️ **LE chiffre qui distingue Gel profond de la Supraconduction** (« plus
   * forte ou plus longue »). `slowFactor: 0` est DEJA un plancher absolu pour
   * les deux : la duree est le SEUL levier restant. La Supraconduction garde
   * la duree GENERIQUE ; Gel profond REUTILISE
   * `SURCHAUFFE_ZONE_LIFETIME_TICKS`. Valeur EXACTE, pas une inegalite : un
   * reglage futur ne doit pas passer inapercu.
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

  it('donne a Mortier vif une zone BREVE, la ou Gel profond et Aveuglement durent', () => {
    // ⚠️ Ce que ce cas garde, c'est l'ECART entre une reaction qui pose un
    // champ durable et une qui ne fait que passer. L'element porte reste sans
    // effet, comme partout ailleurs.
    const mortier = zoneLifetimeTicks(packZoneKind(ELEMENT.POIX, REACTION.MORTIER_VIF));
    expect(mortier).toBeLessThan(ZONE_LIFETIME_TICKS);
    expect(mortier).toBeLessThan(
      zoneLifetimeTicks(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND)),
    );
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.CHAUX, REACTION.MORTIER_VIF))).toBe(mortier);
  });

  /**
   * ⚠️ **LE chiffre qui distingue Aveuglement de la Chaux SEULE** (« plus
   * forte ou plus longue »). `fieldSign` n'a que deux valeurs (+1/-1) : rien
   * n'est « plus fort » que -1, donc la duree est le SEUL levier ici aussi.
   * Une Chaux seule (`packZoneKind(ELEMENT.CHAUX, REACTION.AUCUNE)`) vit la
   * duree GENERIQUE ; Aveuglement REUTILISE `SURCHAUFFE_ZONE_LIFETIME_TICKS`.
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

  it('rend la duree GENERIQUE pour Amalgame : aucune duree propre, rien au §5 de la spec ne motive un allongement', () => {
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.POIX, REACTION.AMALGAME))).toBe(
      ZONE_LIFETIME_TICKS,
    );
    expect(zoneLifetimeTicks(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AMALGAME))).toBe(
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
    // ⚠️ **Le degat ne doit PAS dependre de l element porte.** Si
    // `resolveBurn` lisait `elementOf(...).burnPerTick` au lieu de
    // `zoneBurnPerTick`, une zone de Surchauffe portant l element Foudre
    // rendrait zero : c est ce que ce test separe.
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

  it('Amalgame ne laisse AUCUN degat de zone, dans les DEUX ordres : son effet est le partage, pas la brulure', () => {
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.POIX, REACTION.AMALGAME))).toBe(0);
    expect(zoneBurnPerTick(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AMALGAME))).toBe(0);
  });
});

/**
 * ⚠️ **Embrasement et Court-circuit reutilisent le rayon et le degat
 * GENERIQUES de la reaction** (voir `shared/reactions.ts`) : l ecart avec le
 * Choc thermique est la SELECTIVITE (poisses seulement), jamais l intensite.
 * Ce test empeche la table de deriver en silence vers deux chiffres
 * arbitraires.
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
 * `zoneSlowFactor` : le facteur de vitesse DERIVE du kind empaquete, lu par
 * `Horde#computeSlow` (`shared/horde.ts`).
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
   * ⚠️ **La TROISIEME grandeur piegee par l'ordre d'arrivee.** Le Givre porte
   * un `slowFactor` non neutre (0,6), pas la Chaux : sans plancher, une zone
   * d'Eclat de gel ralentirait si Givre a declenche, mais pas si Chaux a
   * declenche (le meme piege que `zoneArmorReductionTotal`/`zoneFieldSign`
   * referment pour la Chaux). Eclat de gel reprend donc le plancher de
   * Verglas (`elementOf(ELEMENT.GIVRE).slowFactor`).
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
   * ⚠️ **LE piege d'ordre de Verglas.** Pour la Supraconduction,
   * `reactionFactor = 0` est un PLANCHER ABSOLU : `min(x, 0) = 0` quel que
   * soit `x`. Verglas n'a pas ce luxe : avec `zoneSlowFactor: 1` (neutre), ce
   * test rendrait `0,6` quand Givre declenche et `1` quand Poix declenche, et
   * la meme Verglas glisserait ou pas selon quel projectile a touche en
   * second. Sa ligne porte donc un facteur EXPLICITE qui reste un plancher
   * dans les deux cas.
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
   * ⚠️ **L'invariant dont le test precedent depend, ASSENE.** `zoneSlowFactor`
   * combine par MINIMUM : l'independance a l'ordre ne tient QUE SI
   * `reactionFactor` reste inferieur ou egal au `slowFactor` de CHAQUE
   * element de la paire. Le test precedent ne rougirait pas si la Poix
   * recevait un jour un `slowFactor` INFERIEUR a celui du Givre : le minimum
   * redeviendrait dependant de l'ordre, et rien ne le verrait.
   *
   * ⚠️ **Ni Givre ni Poix ne sont ecrits en dur ici** : la paire se DECODE de
   * la table (`unpackElementPair(def.pair)`), et la propriete reste vraie si
   * `ELEMENT_DEFS` change.
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
   * ⚠️ **Vaporisation, Arc caustique et Paratonnerre n ont AUCUN plancher a
   * fermer ici, verifie, pas suppose.** Aucun des elements de leurs paires
   * ne porte de `slowFactor` non neutre (seul le Givre en porte un, voir
   * `ELEMENT_DEFS`) : les deux ordres de chaque paire rendent 1 sans
   * `zoneSlowFactor` explicite.
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

  it('rend 1 (aucun ralentissement) pour Amalgame, dans les DEUX ordres : ni la Poix ni le Vif-argent ne ralentissent', () => {
    expect(zoneSlowFactor(packZoneKind(ELEMENT.POIX, REACTION.AMALGAME))).toBe(1);
    expect(zoneSlowFactor(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AMALGAME))).toBe(1);
  });
});

/**
 * `zoneArmorReduction` : l'armure SOUSTRAITE, DERIVEE du kind empaquete, lue
 * par `ZoneField.armorReductionAt` (`shared/zones.ts`).
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
   * (donc `CHAUX_ARMOR_REDUCTION`), pas `MAX_ARMOR` comme Fournee**, meme
   * choix qu Eclat de gel : ni l une ni l autre n a d effet d armure propre,
   * le plancher garantit seulement ce qu une Chaux SEULE laisserait deja.
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

  it('rend zero pour Amalgame, dans les DEUX ordres : ni la Poix ni le Vif-argent n ont d effet sur l armure', () => {
    expect(zoneArmorReduction(packZoneKind(ELEMENT.POIX, REACTION.AMALGAME))).toBe(0);
    expect(zoneArmorReduction(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AMALGAME))).toBe(0);
  });
});

/**
 * `zoneArmorReductionTotal` : combine `zoneArmorReduction` (la reaction) et
 * `Element.armorReduction` (la Chaux) par un MAXIMUM, lue par
 * `ZoneField.armorReductionAt` (`shared/zones.ts`).
 */
describe('zoneArmorReductionTotal — l armure retiree, ELEMENT et REACTION confondus', () => {
  it('rend zero pour un kind de reaction nulle sur un element sans effet propre', () => {
    expect(zoneArmorReductionTotal(ELEMENT.GIVRE)).toBe(0);
    expect(zoneArmorReductionTotal(packZoneKind(ELEMENT.BRAISE, REACTION.AUCUNE))).toBe(0);
  });

  it('rend CHAUX_ARMOR_REDUCTION pour un kind de reaction nulle porte par la Chaux : l element SEUL suffit', () => {
    // ⚠️ Le chemin d'une zone de Chaux sans reaction nommee : la reaction
    // generique (Choc thermique) laisse `zoneArmorReduction` a zero, et c'est
    // l'element seul qui porte l'effet.
    expect(CHAUX_ARMOR_REDUCTION).toBeGreaterThan(0);
    expect(zoneArmorReductionTotal(ELEMENT.CHAUX)).toBe(CHAUX_ARMOR_REDUCTION);
    expect(zoneArmorReductionTotal(packZoneKind(ELEMENT.CHAUX, REACTION.AUCUNE))).toBe(
      CHAUX_ARMOR_REDUCTION,
    );
  });

  it('rend toujours SUPRACONDUCTION_ARMOR_REDUCTION pour la Supraconduction : la reaction seule y suffit deja', () => {
    // La Supraconduction ne pair ni Braise ni Chaux : la contribution ELEMENT
    // reste nulle des deux cotes, seule celle de la reaction compte.
    const surGivre = zoneArmorReductionTotal(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION));
    const surFoudre = zoneArmorReductionTotal(
      packZoneKind(ELEMENT.FOUDRE, REACTION.SUPRACONDUCTION),
    );
    expect(surGivre).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);
    expect(surFoudre).toBe(SUPRACONDUCTION_ARMOR_REDUCTION);
  });

  /**
   * ⚠️ Une reaction dont `zoneArmorReduction` DOMINE la contribution de la
   * Chaux (ici la Supraconduction, sur un `kind` construit pour l'occasion)
   * rend la MEME reduction dans les deux ordres de declencheur (Braise, sans
   * effet propre, puis Chaux, qui en a un). Sinon une zone de cette forme
   * corroderait ou pas selon quel projectile a touche en second. Fournee,
   * le cas reel, a son propre test plus bas.
   */
  it('la reduction d armure d une zone ne depend pas de l ordre d arrivee', () => {
    // ⚠️ Garde de plancher : c'est cette inegalite, et NON une coincidence de
    // couple, qui rend l'egalite suivante valide. Changer l'une des deux
    // constantes sans preserver ce plancher fait rougir ICI, avec un message
    // qui pointe la cause.
    expect(CHAUX_ARMOR_REDUCTION).toBeLessThanOrEqual(SUPRACONDUCTION_ARMOR_REDUCTION);

    const a = zoneArmorReductionTotal(packZoneKind(ELEMENT.BRAISE, REACTION.SUPRACONDUCTION));
    const b = zoneArmorReductionTotal(packZoneKind(ELEMENT.CHAUX, REACTION.SUPRACONDUCTION));
    expect(a).toBe(b);
    // ⚠️ Et une garde de non-vacuite : si les deux valaient 0, l'egalite
    // serait vraie et ne prouverait rien.
    expect(a).toBeGreaterThan(0);
  });

  /**
   * ⚠️ **Le meme test avec Fournee elle-meme.** Fournee pousse
   * `zoneArmorReduction` a `MAX_ARMOR`, qui domine la contribution de
   * l'element (`CHAUX_ARMOR_REDUCTION`) : les deux ordres de declencheur
   * doivent donc rendre la MEME reduction.
   */
  it('Fournee ne depend pas de l ordre d arrivee : l armure retiree vaut MAX_ARMOR dans les deux ordres', () => {
    expect(CHAUX_ARMOR_REDUCTION).toBeLessThan(MAX_ARMOR);

    const braiseDeclenche = zoneArmorReductionTotal(packZoneKind(ELEMENT.BRAISE, REACTION.FOURNEE));
    const chauxDeclenche = zoneArmorReductionTotal(packZoneKind(ELEMENT.CHAUX, REACTION.FOURNEE));
    expect(braiseDeclenche).toBe(chauxDeclenche);
    expect(braiseDeclenche).toBe(MAX_ARMOR);
  });

  /**
   * ⚠️ **Eclat de gel n'a AUCUN effet d'armure « a elle », et porte quand meme
   * un plancher explicite** (voir son entree dans `REACTION_DEFS`) : la zone
   * qu'elle laisse (posee par `postZone` pour CHAQUE declencheur) porterait
   * sinon l'effet de la Chaux une fois sur deux. Le plancher
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
   * ⚠️ **Arc caustique apparie la Chaux : son plancher explicite
   * (`SUPRACONDUCTION_ARMOR_REDUCTION`) doit dominer `CHAUX_ARMOR_REDUCTION`
   * pour rendre les deux ordres identiques.**
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
   * ⚠️ **Mortier vif et Aveuglement** : meme raisonnement qu Eclat de gel, le
   * plancher garantit ce qu une Chaux SEULE laisserait deja, il ne l AUGMENTE
   * pas.
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

  it('rend zero pour Amalgame, dans les DEUX ordres : ni la Poix ni le Vif-argent n ont d effet d armure', () => {
    expect(zoneArmorReductionTotal(packZoneKind(ELEMENT.POIX, REACTION.AMALGAME))).toBe(0);
    expect(zoneArmorReductionTotal(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AMALGAME))).toBe(0);
  });
});

/**
 * `zoneInertiaDamping` : le facteur de conservation de vitesse DERIVE du kind
 * empaquete, lu par `Horde#recomputeSteering` (`shared/horde.ts`), qui VOYAGE.
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
 * `zoneCollisionDamage` : le degat de collision DERIVE du kind empaquete, lu
 * par `resolveVerglasCollisions` (`back/src/combat.ts`), qui ne voyage JAMAIS
 * (un degat, serveur seul).
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
 * `zoneFieldSign` : le signe de direction DERIVE du kind empaquete, lu par
 * `Horde` (`shared/horde.ts`), qui VOYAGE.
 */
describe('zoneFieldSign — le signe de direction, ELEMENT et REACTION confondus', () => {
  it('rend +1 (aucun effet) pour un kind de reaction nulle sur un element sans effet propre', () => {
    expect(zoneFieldSign(ELEMENT.GIVRE)).toBe(1);
    expect(zoneFieldSign(packZoneKind(ELEMENT.BRAISE, REACTION.AUCUNE))).toBe(1);
  });

  it('rend -1 pour un kind de reaction nulle porte par la Chaux : l element SEUL suffit', () => {
    // Une zone de Chaux sans reaction nommee : c'est l'element seul qui porte
    // la fuite.
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
   * ⚠️ **Ce test garde le MECANISME, pas un etat de production.** Les cinq
   * couples reels de la Chaux (Fournee, Eclat de gel, Arc caustique, Mortier
   * vif, Aveuglement) portent tous `zoneFieldSign: -1` explicite, chacun avec
   * son test « ne depend pas de l'ordre d'arrivee » plus bas.
   *
   * Ce qui reste vrai : `zoneFieldSign(kind) = Math.min(elementSign,
   * reactionSign)`, avec `reactionSign` a `1` par defaut, reste
   * ORDRE-DEPENDANT pour une paire de la Chaux SANS plancher.
   * `REACTION.SUPRACONDUCTION` (Givre + Foudre) ne peut jamais pairer la
   * Chaux : c'est un `kind` FICTIF qui exerce la combinaison sans plancher.
   * Une SIXIEME reaction de la Chaux sans plancher ne serait donc PAS
   * attrapee ici : seuls sa ligne de `REACTION_DEFS` et son propre test la
   * protegeraient.
   */
  it('le mecanisme reste ORDRE-DEPENDANT sans plancher explicite — plus aucun couple REEL de la Chaux n est dans cet etat', () => {
    const chauxDeclenche = zoneFieldSign(packZoneKind(ELEMENT.CHAUX, REACTION.SUPRACONDUCTION));
    const givreDeclenche = zoneFieldSign(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION));
    expect(chauxDeclenche).toBe(-1);
    expect(givreDeclenche).toBe(1);
  });

  /**
   * ⚠️ **Fournee et Eclat de gel ferment ce piege pour leurs deux couples** :
   * toutes deux portent `zoneFieldSign: -1` EXPLICITE dans `REACTION_DEFS`,
   * jamais herite de l'element, donc les deux ordres rendent -1 (le remede de
   * Verglas pour `zoneSlowFactor`).
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
   * ⚠️ **Arc caustique ferme le meme piege** : `zoneFieldSign:
   * elementOf(ELEMENT.CHAUX).fieldSign` EXPLICITE, donc les deux ordres
   * (Foudre, sans effet propre, puis Chaux) rendent -1.
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
   * ⚠️ **Mortier vif ferme le meme piege** : `zoneFieldSign:
   * elementOf(ELEMENT.CHAUX).fieldSign` EXPLICITE, donc les deux ordres (Poix
   * puis Chaux) rendent -1. L'effet PRATIQUE est masque par le gel total de
   * `zoneSlowFactor` (voir `shared/horde.test.ts`), mais l'OCTET ne doit pas
   * dependre de l'ordre.
   */
  it('Mortier vif ne depend pas de l ordre d arrivee : -1 que Poix ou Chaux declenche', () => {
    const poixDeclenche = zoneFieldSign(packZoneKind(ELEMENT.POIX, REACTION.MORTIER_VIF));
    const chauxDeclenche = zoneFieldSign(packZoneKind(ELEMENT.CHAUX, REACTION.MORTIER_VIF));
    expect(poixDeclenche).toBe(-1);
    expect(chauxDeclenche).toBe(-1);
  });

  /**
   * ⚠️ **Aveuglement ferme le meme piege, et c'est sa raison d'etre.**
   * Vif-argent est neutre sur `fieldSign` : sans le plancher explicite, une
   * zone d'Aveuglement ne ferait fuir que si la Chaux est arrivee EN SECOND.
   */
  it('Aveuglement ne depend pas de l ordre d arrivee : -1 que Chaux ou Vif-argent declenche', () => {
    const chauxDeclenche = zoneFieldSign(packZoneKind(ELEMENT.CHAUX, REACTION.AVEUGLEMENT));
    const vifArgentDeclenche = zoneFieldSign(
      packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT),
    );
    expect(chauxDeclenche).toBe(-1);
    expect(vifArgentDeclenche).toBe(-1);
  });

  it('rend +1 pour Amalgame, dans les DEUX ordres : ni la Poix ni le Vif-argent ne fuient', () => {
    expect(zoneFieldSign(packZoneKind(ELEMENT.POIX, REACTION.AMALGAME))).toBe(1);
    expect(zoneFieldSign(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AMALGAME))).toBe(1);
  });
});

/**
 * `zoneDamageAmpTotal` : l'amplification des degats, ELEMENT et REACTION
 * confondus, lue par `ZoneField.ampAt` (`shared/zones.ts`). Voir le docbloc
 * du champ `zoneDamageAmp` dans `shared/reactions.ts`.
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
   * de l element.** Le nibble d'element d'une zone de Mortier vif porte celui
   * du DECLENCHEUR (Poix OU Chaux selon l'ordre d'arrivee) :
   * `elementOf(zoneElement(kind)).damageAmp` seul rendrait 1,5 ou 1. Le
   * plancher explicite (`zoneDamageAmp: elementOf(ELEMENT.POIX).damageAmp`)
   * rend les deux ordres identiques.
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
   * ⚠️ **L'invariant dont le test precedent depend, ASSENE.**
   * `zoneDamageAmpTotal` combine par MAXIMUM : l'independance a l'ordre ne
   * tient QUE SI `reactionFactor` reste superieur ou egal au `damageAmp` de
   * CHAQUE element de la paire.
   */
  it('le plancher de Mortier vif reste un PLAFOND pour les deux elements de sa propre paire', () => {
    const def = reactionOfId(REACTION.MORTIER_VIF);
    expect(def).toBeDefined();
    const [a, b] = unpackElementPair(def?.pair ?? 0);
    for (const element of [a, b]) {
      expect(def?.zoneDamageAmp).toBeGreaterThanOrEqual(elementOf(element).damageAmp);
    }
  });

  /**
   * ⚠️ **Amalgame (Poix + Vif-argent) reclame le MEME plancher que Mortier
   * vif** : la Poix est l'unique moitie non neutre du couple. Sans plancher
   * explicite, `elementOf(zoneElement(kind)).damageAmp` seul rendrait 1,5
   * (Poix declenche) OU 1 (Vif-argent declenche).
   */
  it('rend le damageAmp de la Poix pour Amalgame, dans les DEUX ordres (Poix OU Vif-argent declenche)', () => {
    const poixDeclenche = zoneDamageAmpTotal(packZoneKind(ELEMENT.POIX, REACTION.AMALGAME));
    const vifArgentDeclenche = zoneDamageAmpTotal(
      packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AMALGAME),
    );
    // Non-vacuite : Poix (1,5) et Vif-argent (1, neutre) n'ont PAS le meme
    // damageAmp — sans plancher EXPLICITE, les deux lignes ci-dessous
    // rendraient des valeurs differentes.
    expect(elementOf(ELEMENT.POIX).damageAmp).not.toBe(elementOf(ELEMENT.VIF_ARGENT).damageAmp);
    expect(poixDeclenche).toBe(vifArgentDeclenche);
    expect(poixDeclenche).toBe(elementOf(ELEMENT.POIX).damageAmp);
  });

  /** ⚠️ L'invariant dont le test precedent depend, ASSENE (comme pour Mortier vif). */
  it('le plancher d Amalgame reste un PLAFOND pour les deux elements de sa propre paire', () => {
    const def = reactionOfId(REACTION.AMALGAME);
    expect(def).toBeDefined();
    const [a, b] = unpackElementPair(def?.pair ?? 0);
    for (const element of [a, b]) {
      expect(def?.zoneDamageAmp).toBeGreaterThanOrEqual(elementOf(element).damageAmp);
    }
  });
});

/**
 * **Les champs varient** en taille, duree et forme. Les trois se derivent du
 * MEME octet de `kind`, donc sans rien annoncer de plus sur le fil.
 */
describe('zoneRadius et zoneShape — ce qui distingue un champ d un autre', () => {
  it('rend le rayon GENERIQUE pour un kind sans reaction', () => {
    expect(zoneRadius(ELEMENT.BRAISE)).toBe(ZONE_RADIUS);
    expect(zoneRadius(packZoneKind(ELEMENT.GIVRE, REACTION.AUCUNE))).toBe(ZONE_RADIUS);
  });

  it('donne a chaque reaction un rayon, dans une fourchette lisible', () => {
    for (const def of REACTION_DEFS) {
      const r = zoneRadius(packZoneKind(ELEMENT.BRAISE, def.id));
      expect(r, def.name).toBeGreaterThanOrEqual(ZONE_RADIUS / 2);
      expect(r, def.name).toBeLessThanOrEqual(ZONE_RADIUS * 2);
    }
  });

  it('fait VARIER le rayon d une reaction a l autre, des deux cotes du generique', () => {
    const rayons = new Set(
      REACTION_DEFS.map((def) => zoneRadius(packZoneKind(ELEMENT.BRAISE, def.id))),
    );
    expect(rayons.size).toBeGreaterThanOrEqual(5);
    expect(Math.min(...rayons)).toBeLessThan(ZONE_RADIUS);
    expect(Math.max(...rayons)).toBeGreaterThan(ZONE_RADIUS);
  });

  it('ignore les autres bits du kind : seul le nibble de reaction compte', () => {
    // Meme regle que pour la duree : l'element porte est celui du
    // DECLENCHEUR, il ne doit pas changer la taille du champ.
    const a = packZoneKind(ELEMENT.BRAISE, REACTION.VERGLAS);
    const b = packZoneKind(ELEMENT.POIX, REACTION.VERGLAS);
    expect(zoneRadius(a)).toBe(zoneRadius(b));
    expect(zoneShape(a)).toBe(zoneShape(b));
  });

  it('donne une silhouette a chaque reaction, et s en sert de plus d une', () => {
    const formes = new Set(
      REACTION_DEFS.map((def) => zoneShape(packZoneKind(ELEMENT.BRAISE, def.id))),
    );
    expect(formes.size).toBeGreaterThanOrEqual(3);
    // Une zone sans reaction garde la silhouette ronde.
    expect(zoneShape(ELEMENT.BRAISE)).toBe('rond');
  });
});
