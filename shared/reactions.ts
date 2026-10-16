import { MAX_ARMOR } from './archetypes';
import {
  ECLAT_DE_GEL_DAMAGE,
  FOURNEE_BURN_PER_TICK,
  REACTION_DAMAGE,
  REACTION_RADIUS,
  SUPRACONDUCTION_ARMOR_REDUCTION,
  SURCHAUFFE_BURN_PER_TICK,
  SURCHAUFFE_ZONE_LIFETIME_TICKS,
  VERGLAS_COLLISION_DAMAGE_PER_TICK,
  VERGLAS_INERTIA_DAMPING,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
} from './constants';
import { ELEMENT, elementOf } from './elements';
import { packElementPair, zoneElement, zoneReaction } from './protocol';

/**
 * Les silhouettes de champ.
 *
 * ⚠️ **Un NOM, jamais un dessin.** Le trace vit cote client
 * (`front/src/render/zone-renderer.ts`) ; `shared/` n'a ni canevas ni
 * `document`.
 *
 * Quatre familles pour quatorze reactions : le joueur lit au sol la FAMILLE
 * d'effet (ce qui brule, englue, eclate, fracture), pas la reaction exacte.
 */
export type ZoneShape = 'rond' | 'lobes' | 'etoile' | 'fracture';

export const REACTION = {
  /** Aucun effet de reaction specifique — le nibble de reaction a zero. */
  AUCUNE: 0,
  SURCHAUFFE: 1,
  EMBRASEMENT: 2,
  COURT_CIRCUIT: 3,
  SUPRACONDUCTION: 4,
  VERGLAS: 5,
  FOURNEE: 6,
  ECLAT_DE_GEL: 7,
  VAPORISATION: 8,
  ARC_CAUSTIQUE: 9,
  PARATONNERRE: 10,
  GEL_PROFOND: 11,
  MORTIER_VIF: 12,
  AVEUGLEMENT: 13,
  /**
   * Amalgame (Poix + Vif-argent).
   *
   * ⚠️ Le nibble de reaction fait 4 bits (`zoneReaction`/`packZoneKind`,
   * `shared/protocol.ts`) : **il reste UNE valeur** (15). Au-dela, le nibble
   * deborde EN SILENCE (`(reaction & 0x0f) << 3` tronque sans lever) et il
   * faudrait un octet de plus sur `ZoneField.kind`. Le describe « invariant de
   * REACTION_DEFS » de `reactions.test.ts` garde cette borne.
   */
  AMALGAME: 14,
} as const;

export interface ReactionDef {
  /** La valeur empaquetee dans le nibble de reaction de `ZoneField.kind`. */
  readonly id: number;
  readonly name: string;
  /** Le couple d'elements, canonicalise par `packElementPair`. */
  readonly pair: number;
  /**
   * Degats par tick que la zone laissee par cette reaction inflige
   * D'ELLE-MEME, independamment de toute marque (0 : la zone ne brule pas).
   *
   * ⚠️ **Ne se lit PAS au travers de l'element, contrairement a
   * `Element.burnPerTick`.** Le champ porte l'element du DECLENCHEUR (voir
   * `ReactionTrigger.element`), qui varie selon l'ordre d'arrivee — pour
   * Surchauffe, ce peut etre Foudre, qui ne brule pas. Ce champ ne combine
   * donc JAMAIS avec l'element, et n'a besoin d'aucun plancher.
   */
  readonly zoneBurnPerTick: number;
  /**
   * Duree de vie de la zone laissee par cette reaction, en ticks (0 : la
   * duree generique `ZONE_LIFETIME_TICKS` s'applique).
   */
  readonly zoneLifetimeTicks: number;
  /** Rayon d'un effet geometrique instantane a la resolution (0 : n/a). */
  readonly radius: number;
  /** Degats d'un effet geometrique ou en chaine instantane (0 : n/a). */
  readonly damage: number;
  /**
   * Facteur de vitesse propre a la zone laissee par cette reaction (1 :
   * aucun effet propre).
   *
   * ⚠️ **Combine par MINIMUM avec `Element.slowFactor` de l'element porte par
   * le `kind`, jamais lu seul** : voir `zoneSlowFactor`.
   */
  readonly zoneSlowFactor: number;
  /**
   * Armure SOUSTRAITE (jamais multipliee) a qui se tient dans la zone
   * laissee par cette reaction (0 : aucun effet). Combinee avec
   * `Element.armorReduction` par `zoneArmorReductionTotal`.
   */
  readonly zoneArmorReduction: number;
  /**
   * Facteur d'amplification des degats propre a la reaction, applique a qui
   * se tient dans la zone laissee (1 : aucun effet propre).
   *
   * ⚠️ Sans ce champ, une reaction appariant la Poix (`damageAmp` 1,5)
   * heriterait l'amplification du DECLENCHEUR — une fois sur deux selon
   * l'ordre d'arrivee. Combine par MAXIMUM (decision de jeu : deux sources
   * d'amplification ne s'additionnent pas) par `zoneDamageAmpTotal`, seule
   * lecture exposee.
   */
  readonly zoneDamageAmp: number;
  /**
   * Facteur de conservation de la vitesse tenue dans la zone laissee par
   * cette reaction (1 : aucun effet propre). Lu par `Horde#recomputeSteering`
   * (`shared/horde.ts`), des deux cotes du fil.
   *
   * Propriete de la REACTION seule : `Element` ne porte aucune notion de
   * friction, rien a combiner (voir `zoneInertiaDamping`).
   */
  readonly zoneInertiaDamping: number;
  /**
   * Degats par tick entre DEUX ennemis qui se tiennent tous deux dans la
   * zone laissee par cette reaction et sont trop proches l'un de l'autre (0 :
   * aucun effet).
   *
   * Un DEGAT, donc lu SEULEMENT cote serveur (`resolveVerglasCollisions`,
   * `back/src/combat.ts`) : les morts voyagent deja par `DEATHS`.
   */
  readonly zoneCollisionDamage: number;
  /**
   * Signe propre a la zone laissee par cette reaction : `+1` aucun effet
   * propre, `-1` inverse la direction du champ (fuite).
   *
   * ⚠️ Combine par MINIMUM avec `Element.fieldSign` (voir `zoneFieldSign`).
   * Les couples de la Chaux le plancheent a `-1` pour que la fuite ne depende
   * pas de l'ordre d'arrivee.
   */
  readonly zoneFieldSign: number;
  /**
   * Vrai si la zone laissee par cette reaction COMPTE COMME DU VIF-ARGENT pour
   * ses deux effets : la liaison (`linkedNeighbours`, `shared/links.ts`) et le
   * rayon de touche elargi (`ZoneField.hitRadiusBonusAt`, `shared/zones.ts`).
   * UN SEUL champ pour DEUX consommateurs : deux predicats separes ont deja
   * diverge.
   *
   * ⚠️ **Seules les reactions qui ont BESOIN du Vif-argent le fournissent** :
   * Vaporisation, Paratonnerre, Amalgame. Gel profond et Aveuglement restent a
   * `false` pour les DEUX effets : leur effet propre (vitesse nulle / fuite)
   * ne depend d'aucun voisin. Le deriver de la paire renverserait ce choix en
   * silence.
   *
   * Un champ de la ligne, lu par `id`, jamais par l'element : independant de
   * l'ordre d'arrivee par construction.
   */
  readonly zoneVifArgent: boolean;
  /**
   * Rayon du champ que cette reaction laisse, en pixels monde. `0` : le rayon
   * generique `ZONE_RADIUS`. Les deux cotes du fil decodent le meme octet de
   * `kind` et obtiennent le meme rayon (voir `zoneRadius`).
   *
   * ⚠️ **Le rayon DESSINE suit celui-ci**, jamais l'inverse : `ZoneRenderer`
   * met l'echelle de chaque disque sur ce que la regle dit. Une zone deux fois
   * plus large qui se dessinerait pareil mentirait sur ce qu'elle ralentit.
   */
  readonly zoneRadius: number;
  /**
   * La silhouette du champ — voir `ZoneShape`.
   *
   * ⚠️ **AUCUN effet de jeu** : la regle reste un disque de `zoneRadius`, et
   * l'encre reste dans ce disque (`RIM_MIN`). La forme dit de QUELLE reaction
   * vient le champ, la teinte dit son element.
   */
  readonly zoneShape: ZoneShape;
}

/**
 * La table des reactions a effet SPECIFIQUE : une donnee par couple, jamais
 * un `switch` sur la paire. Exportee pour l'invariant de table de
 * `reactions.test.ts` (`id` et `pair` uniques, `id <= 15`).
 *
 * ⚠️ **Une paire ABSENTE n'est pas une erreur** : elle rend le comportement
 * GENERIQUE de `applyReactions` (le Choc thermique : `REACTION_DAMAGE` dans
 * `REACTION_RADIUS`). C'est le cas de Braise + Givre.
 *
 * ⚠️ **`id` EST le nibble de reaction de `ZoneField.kind`** (voir
 * `packZoneKind`/`zoneReaction`, `shared/protocol.ts`). `postZone`
 * (`back/src/combat.ts`) l'y pose ; les fonctions `zone*` ci-dessous l'en
 * relisent.
 *
 * ⚠️ **Regle des planchers** : le nibble d'element d'une zone de reaction
 * porte le DECLENCHEUR, qui depend de l'ordre d'arrivee des deux projectiles.
 * Une reaction doit donc fixer EXPLICITEMENT toute grandeur combinante
 * (`zoneSlowFactor`, `zoneArmorReduction`, `zoneDamageAmp`, `zoneFieldSign`)
 * pour laquelle L'UN OU L'AUTRE de ses deux elements est non neutre — sinon
 * l'effet change selon le projectile arrive en second. Le plancher reprend la
 * valeur de l'element (`elementOf(...)`, jamais recopiee), sauf quand la
 * reaction impose un effet plus fort. `postZone` pose une zone pour CHAQUE
 * declencheur, y compris les reactions « degat seul » : la regle s'y applique
 * aussi.
 */
export const REACTION_DEFS: readonly ReactionDef[] = [
  {
    // Surchauffe (Braise + Foudre) : une zone qui brule d'elle-meme, plus
    // fort et plus longtemps que le champ generique — voir `resolveBurn`
    // (back/src/combat.ts).
    id: REACTION.SURCHAUFFE,
    name: 'surchauffe',
    pair: packElementPair(ELEMENT.BRAISE, ELEMENT.FOUDRE),
    zoneBurnPerTick: SURCHAUFFE_BURN_PER_TICK,
    zoneLifetimeTicks: SURCHAUFFE_ZONE_LIFETIME_TICKS,
    radius: 0,
    damage: 0,
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 0.8),
    zoneShape: 'etoile',
  },
  {
    // Embrasement (Braise + Poix) : degats instantanes a tout ennemi POISSE
    // dans un rayon (`damageInRadius` avec `markFilter`, back/src/combat.ts).
    // Rayon et degat generiques : l'ecart avec le Choc thermique est la
    // SELECTIVITE, pas l'intensite.
    id: REACTION.EMBRASEMENT,
    name: 'embrasement',
    pair: packElementPair(ELEMENT.BRAISE, ELEMENT.POIX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: Math.round(ZONE_LIFETIME_TICKS * 0.7),
    radius: REACTION_RADIUS,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 1.3),
    zoneShape: 'etoile',
  },
  {
    // Court-circuit (Foudre + Poix) : `chainTargets` (shared/chain.ts) tant
    // que les cibles restent poissees, borne par `COURT_CIRCUIT_MAX_JUMPS` —
    // voir `chainWhilePoisoned` (back/src/combat.ts). Degat generique par saut.
    id: REACTION.COURT_CIRCUIT,
    name: 'court-circuit',
    pair: packElementPair(ELEMENT.FOUDRE, ELEMENT.POIX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: Math.round(ZONE_LIFETIME_TICKS * 0.55),
    radius: 0,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 0.65),
    zoneShape: 'fracture',
  },
  {
    // Supraconduction (Givre + Foudre) : vitesse NULLE et armure rabotee dans
    // la zone. Lue par `Horde#computeSlow` (shared/horde.ts, minimum, voyage)
    // et `armureA` (back/src/combat.ts, maximum, ne voyage pas).
    id: REACTION.SUPRACONDUCTION,
    name: 'supraconduction',
    pair: packElementPair(ELEMENT.GIVRE, ELEMENT.FOUDRE),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: 0,
    radius: 0,
    damage: 0,
    // 0 : gel total quel que soit l'element porte par le nibble.
    zoneSlowFactor: 0,
    zoneArmorReduction: SUPRACONDUCTION_ARMOR_REDUCTION,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 1.15),
    zoneShape: 'fracture',
  },
  {
    // Verglas (Givre + Poix) : les ennemis gardent leur trajectoire au lieu
    // de la corriger (`zoneInertiaDamping`, `Horde#recomputeSteering`, voyage)
    // et se percutent en glissant (`zoneCollisionDamage`,
    // `resolveVerglasCollisions` dans `back/src/combat.ts`, serveur seul).
    id: REACTION.VERGLAS,
    name: 'verglas',
    pair: packElementPair(ELEMENT.GIVRE, ELEMENT.POIX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: Math.round(ZONE_LIFETIME_TICKS * 1.4),
    radius: 0,
    damage: 0,
    // ⚠️ Plancher : neutre (1), la zone ralentirait si Givre declenche et pas
    // si Poix declenche. Fixe a la valeur du Givre, le minimum rend la meme
    // chose dans les deux cas — Verglas n'ajoute aucun ralentissement, elle
    // garantit celui du Givre.
    zoneSlowFactor: elementOf(ELEMENT.GIVRE).slowFactor,
    zoneArmorReduction: 0,
    zoneDamageAmp: 1,
    zoneInertiaDamping: VERGLAS_INERTIA_DAMPING,
    zoneCollisionDamage: VERGLAS_COLLISION_DAMAGE_PER_TICK,
    zoneFieldSign: 1,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 1.45),
    zoneShape: 'lobes',
  },
  {
    // Fournee (Braise + Chaux) : combustion doublee ET armure annulee dans la
    // zone. `armureA` (back/src/combat.ts) borne l'armure a zero par le bas,
    // donc `MAX_ARMOR` suffit a annuler n'importe quelle armure.
    //
    // ⚠️ Planchers de la Chaux (`armorReduction`, `fieldSign: -1`) : sans eux,
    // Fournee serait corrosive et fuyante une fois sur deux. Voir le test
    // « Fournee ne depend pas de l'ordre d'arrivee (armure ET fuite) »,
    // `shared/reactions.test.ts`.
    id: REACTION.FOURNEE,
    name: 'fournee',
    pair: packElementPair(ELEMENT.BRAISE, ELEMENT.CHAUX),
    zoneBurnPerTick: FOURNEE_BURN_PER_TICK,
    zoneLifetimeTicks: 0,
    radius: 0,
    damage: 0,
    zoneSlowFactor: 1,
    zoneArmorReduction: MAX_ARMOR,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: elementOf(ELEMENT.CHAUX).fieldSign,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 1.1),
    zoneShape: 'rond',
  },
  {
    // Eclat de gel (Givre + Chaux) : degats bruts sur la SEULE cible qui
    // declenche (branche dediee d'`applyReactions`, `back/src/combat.ts`, qui
    // lit `damage` sans balayage). `radius: 0` : aucun effet geometrique.
    //
    // ⚠️ TROIS planchers : la zone existe bel et bien (`postZone` en pose une
    // pour chaque declencheur), et les deux elements sont non neutres — le
    // Givre sur `slowFactor`, la Chaux sur `armorReduction` et `fieldSign`.
    // L'armure reprend celle de la Chaux seule (pas `MAX_ARMOR` : aucun effet
    // d'armure propre). Voir le test « Eclat de gel ne depend plus de l'ordre
    // d'arrivee (armure, fuite ET ralentissement) », `shared/reactions.test.ts`.
    id: REACTION.ECLAT_DE_GEL,
    name: 'eclat-de-gel',
    pair: packElementPair(ELEMENT.GIVRE, ELEMENT.CHAUX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: 0,
    radius: 0,
    damage: ECLAT_DE_GEL_DAMAGE,
    zoneSlowFactor: elementOf(ELEMENT.GIVRE).slowFactor,
    zoneArmorReduction: elementOf(ELEMENT.CHAUX).armorReduction,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: elementOf(ELEMENT.CHAUX).fieldSign,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 0.7),
    zoneShape: 'etoile',
  },
  {
    // Vaporisation (Braise + Vif-argent) : degats dans un rayon autour de
    // chaque ennemi LIE au declencheur (branche dediee d'`applyReactions`,
    // `back/src/combat.ts`, via `damageInRadius` et `linkedNeighbours`). Rayon
    // et degat generiques : l'ecart avec le Choc thermique est le choix des
    // centres. Aucun plancher : Braise ne porte que `burnPerTick`, qui ne
    // combine pas, et Vif-argent est neutre partout.
    id: REACTION.VAPORISATION,
    name: 'vaporisation',
    pair: packElementPair(ELEMENT.BRAISE, ELEMENT.VIF_ARGENT),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: Math.round(ZONE_LIFETIME_TICKS * 1.2),
    radius: REACTION_RADIUS,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: true,
    zoneRadius: Math.round(ZONE_RADIUS * 1.25),
    zoneShape: 'lobes',
  },
  {
    // Arc caustique (Foudre + Chaux) : la chaine de Foudre ordinaire
    // (`CHAIN_RADIUS`/`CHAIN_JUMPS`), degat generique par saut, PLUS une zone
    // corrosive posee a CHAQUE maillon (branche dediee d'`applyReactions`,
    // qui rappelle `postZone`).
    //
    // ⚠️ Planchers de la Chaux, comme Fournee ; Foudre est neutre. L'armure
    // reprend `SUPRACONDUCTION_ARMOR_REDUCTION` : comme la Supraconduction,
    // une reaction a deux elements dont l'armure est l'effet principal.
    id: REACTION.ARC_CAUSTIQUE,
    name: 'arc-caustique',
    pair: packElementPair(ELEMENT.FOUDRE, ELEMENT.CHAUX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: 0,
    radius: 0,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: SUPRACONDUCTION_ARMOR_REDUCTION,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: elementOf(ELEMENT.CHAUX).fieldSign,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 0.85),
    zoneShape: 'fracture',
  },
  {
    // Paratonnerre (Foudre + Vif-argent) : `chainTargets` avec `exclude`
    // pre-rempli des ennemis NON LIES — voir `chainPreferringLinked`
    // (`back/src/combat.ts`). C'est la chaine ordinaire (`CHAIN_JUMPS`) qui
    // PREFERE les lies : `jumps` est deja petit, pas besoin d'un plafond de
    // cout comme `COURT_CIRCUIT_MAX_JUMPS`. Aucun plancher : les deux
    // elements sont neutres.
    id: REACTION.PARATONNERRE,
    name: 'paratonnerre',
    pair: packElementPair(ELEMENT.FOUDRE, ELEMENT.VIF_ARGENT),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: Math.round(ZONE_LIFETIME_TICKS * 1.6),
    radius: 0,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: true,
    zoneRadius: Math.round(ZONE_RADIUS * 0.6),
    zoneShape: 'fracture',
  },
  {
    // Gel profond (Givre + Vif-argent) : vitesse NULLE, comme la
    // Supraconduction. Rien n'est plus fort que zero, donc c'est la DUREE qui
    // la distingue (celle de Surchauffe, plutot qu'un chiffre de plus).
    // `zoneSlowFactor: 0` domine le Givre par le minimum : aucun autre
    // plancher. Ne lie pas et n'elargit pas le rayon de touche (voir
    // `zoneVifArgent`).
    id: REACTION.GEL_PROFOND,
    name: 'gel-profond',
    pair: packElementPair(ELEMENT.GIVRE, ELEMENT.VIF_ARGENT),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: SURCHAUFFE_ZONE_LIFETIME_TICKS,
    radius: 0,
    damage: 0,
    zoneSlowFactor: 0,
    zoneArmorReduction: 0,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 1.35),
    zoneShape: 'lobes',
  },
  {
    // Mortier vif (Poix + Chaux) : « scelles et fragiles » — vitesse NULLE
    // (effet propre : ni la Poix ni la Chaux ne ralentissent) ET amplification
    // des degats.
    //
    // ⚠️ Planchers : `zoneDamageAmp` reprend celui de la Poix (sinon fragile
    // une fois sur deux), `zoneArmorReduction` et `zoneFieldSign` ceux de la
    // Chaux, sans effet d'armure propre.
    //
    // ⚠️ **Artefact connu, non tranche : la horde scellee gicle en arriere
    // quand la zone expire.** `#advanceByVelocity` (`shared/horde.ts`) module
    // le PAS par `#slow`, pas la vitesse tenue : pendant la zone, `vx`/`vy`
    // continuent d'etre recalcules dans la direction fuyante (`fieldSign: -1`).
    // A l'expiration, `#slow` repasse a 1 avant le recalcul suivant, et
    // l'entite fuit plein pot jusqu'a `STEERING_RECOMPUTE_TICKS - 1` ticks. Le
    // plancher reste requis : sans lui, ce recul dependrait EN PLUS de l'ordre
    // d'arrivee. Voir le test « gicle en arriere a l'expiration … » dans
    // `shared/horde.test.ts`.
    id: REACTION.MORTIER_VIF,
    name: 'mortier-vif',
    pair: packElementPair(ELEMENT.POIX, ELEMENT.CHAUX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: Math.round(ZONE_LIFETIME_TICKS * 0.6),
    radius: 0,
    damage: 0,
    zoneSlowFactor: 0,
    zoneArmorReduction: elementOf(ELEMENT.CHAUX).armorReduction,
    zoneDamageAmp: elementOf(ELEMENT.POIX).damageAmp,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: elementOf(ELEMENT.CHAUX).fieldSign,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 0.75),
    zoneShape: 'rond',
  },
  {
    // Aveuglement (Chaux + Vif-argent) : la fuite, PLUS LONGUE que la Chaux
    // seule. `fieldSign` ne va pas plus loin que -1, donc c'est la DUREE qui
    // la distingue (celle de Surchauffe). La fuite plutot que l'errance : une
    // horde qui erre perd sa pression, et la pression fait le genre.
    //
    // ⚠️ Planchers de la Chaux ; Vif-argent est neutre. Ne lie pas et
    // n'elargit pas le rayon de touche (voir `zoneVifArgent`).
    id: REACTION.AVEUGLEMENT,
    name: 'aveuglement',
    pair: packElementPair(ELEMENT.CHAUX, ELEMENT.VIF_ARGENT),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: SURCHAUFFE_ZONE_LIFETIME_TICKS,
    radius: 0,
    damage: 0,
    zoneSlowFactor: 1,
    zoneArmorReduction: elementOf(ELEMENT.CHAUX).armorReduction,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: elementOf(ELEMENT.CHAUX).fieldSign,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 1.2),
    zoneShape: 'lobes',
  },
  {
    // Amalgame (Poix + Vif-argent) : « les degats subis par un ennemi lie
    // frappent aussi ses voisins ». Serveur seul — voir `shareAmalgameDamage`
    // (`back/src/combat.ts`) : `damage` frappe le declencheur PUIS, une fois
    // chacun et sans recursion, ses voisins LIES (`linkedNeighbours`). Ni
    // rayon ni chaine : `radius` reste a 0.
    //
    // ⚠️ Seul plancher : `zoneDamageAmp`, celui de la Poix (son unique
    // grandeur non neutre ; Vif-argent est neutre partout). Voir le test « le
    // plancher de zoneDamageAmp d'Amalgame reste un PLAFOND … »,
    // `shared/reactions.test.ts`.
    id: REACTION.AMALGAME,
    name: 'amalgame',
    pair: packElementPair(ELEMENT.POIX, ELEMENT.VIF_ARGENT),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: 0,
    radius: 0,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneDamageAmp: elementOf(ELEMENT.POIX).damageAmp,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: true,
    zoneRadius: Math.round(ZONE_RADIUS * 0.9),
    zoneShape: 'rond',
  },
];

/** La reaction specifique du couple `pair`, ou `undefined` : le Choc thermique generique s'applique alors. */
export function reactionForPair(pair: number): ReactionDef | undefined {
  return REACTION_DEFS.find((r) => r.pair === pair);
}

/** La reaction portant l'identifiant `id` (le nibble de reaction d'un `ZoneField.kind`), ou `undefined`. */
export function reactionOfId(id: number): ReactionDef | undefined {
  return REACTION_DEFS.find((r) => r.id === id);
}

/**
 * Vrai si la zone COMPTE COMME DU VIF-ARGENT — lit `ReactionDef.zoneVifArgent`
 * (voir son docbloc). Seul critere pour la liaison (`linkedNeighbours`,
 * `shared/links.ts`) ET le rayon de touche elargi
 * (`ZoneField.hitRadiusBonusAt`, `shared/zones.ts`).
 *
 * Une zone SANS reaction n'a pas de ligne dans `REACTION_DEFS` : elle ne porte
 * qu'un element, qui decide seul. Cas absent en production (`postZone` ne pose
 * jamais de zone de Vif-argent sans reaction) mais que l'API de `ZoneField`
 * permet et que les tests utilisent.
 */
export function zoneVifArgent(kind: number): boolean {
  const reactionId = zoneReaction(kind);
  if (reactionId === 0) {
    return zoneElement(kind) === ELEMENT.VIF_ARGENT;
  }
  return reactionOfId(reactionId)?.zoneVifArgent ?? false;
}

/**
 * La duree de vie d'une zone, DERIVEE de son `kind` — `ZONE_LIFETIME_TICKS`
 * par defaut, la duree propre a sa reaction si elle en porte une.
 *
 * ⚠️ **Lue des DEUX cotes du fil** (`ZoneField.aliveAt`/`expire`,
 * `shared/zones.ts`) : le meme octet donne la meme reponse, sans rien
 * annoncer.
 */
export function zoneLifetimeTicks(kind: number): number {
  const def = reactionOfId(zoneReaction(kind));
  return def && def.zoneLifetimeTicks > 0 ? def.zoneLifetimeTicks : ZONE_LIFETIME_TICKS;
}

/**
 * Le rayon d'une zone, DERIVE de son `kind` — `ZONE_RADIUS` par defaut, le
 * rayon propre a sa reaction si elle en porte un.
 *
 * ⚠️ **Lu des DEUX cotes du fil** : par `ZoneField` pour decider qui est
 * dedans, par `ZoneRenderer` pour le dessin. C'est ce qui permet de faire
 * varier la taille des champs sans toucher au protocole.
 */
export function zoneRadius(kind: number): number {
  const def = reactionOfId(zoneReaction(kind));
  return def && def.zoneRadius > 0 ? def.zoneRadius : ZONE_RADIUS;
}

/**
 * La silhouette d'une zone, DERIVEE de son `kind` — `'rond'` pour une zone
 * sans reaction, celle de sa reaction sinon.
 */
export function zoneShape(kind: number): ZoneShape {
  return reactionOfId(zoneReaction(kind))?.zoneShape ?? 'rond';
}

/** Le degat par tick qu'une zone inflige d'elle-meme, derive de son `kind` empaquete (0 : elle ne brule pas). */
export function zoneBurnPerTick(kind: number): number {
  return reactionOfId(zoneReaction(kind))?.zoneBurnPerTick ?? 0;
}

/**
 * Le facteur de vitesse qu'une zone impose, DERIVE de son `kind` — lu par
 * `Horde#computeSlow` (`shared/horde.ts`), des deux cotes du fil.
 *
 * ⚠️ **Le MINIMUM de l'element porte ET de la reaction, jamais l'un seul.**
 * Le nibble d'element porte le DECLENCHEUR : pour la Supraconduction, Givre
 * (0,6) ou Foudre (1) selon l'ordre d'arrivee. Le minimum avec
 * `ReactionDef.zoneSlowFactor` (0) rend 0 dans les deux cas. Une reaction
 * dont le facteur propre est neutre doit donc poser un plancher explicite
 * (voir Verglas).
 *
 * Le minimum est une contrainte ARITHMETIQUE, pas une decision de jeu : cette
 * grandeur voyage, et seule une combinaison commutative et associative
 * survit a un ordre d'iteration des zones different des deux cotes (voir
 * `Horde#computeSlow`).
 */
export function zoneSlowFactor(kind: number): number {
  const elementFactor = elementOf(zoneElement(kind)).slowFactor;
  const reactionFactor = reactionOfId(zoneReaction(kind))?.zoneSlowFactor ?? 1;
  return Math.min(elementFactor, reactionFactor);
}

/**
 * La MOITIE reaction de la reduction d'armure d'une zone (0 : aucun effet) :
 * la lecture nue de la table. La grandeur complete, combinee avec l'element,
 * est `zoneArmorReductionTotal`, que lit `ZoneField.armorReductionAt`.
 */
export function zoneArmorReduction(kind: number): number {
  return reactionOfId(zoneReaction(kind))?.zoneArmorReduction ?? 0;
}

/**
 * La reduction d'armure qu'une zone impose, ELEMENT et REACTION confondus —
 * lue par `ZoneField.armorReductionAt` (`shared/zones.ts`), qui ne voyage
 * jamais (voir `armureA`, `back/src/combat.ts`).
 *
 * ⚠️ **Un MAXIMUM, jamais une somme — decision de jeu** : deux sources de
 * corrosion ne s'additionnent pas, comme le maximum de
 * `ampAt`/`armorReductionAt`/`collisionDamageAt`/`burnAt`. Ne pas le
 * confondre avec le minimum, arithmetique, de `zoneSlowFactor` : voir le
 * docbloc de `ZoneField.ampAt`.
 */
export function zoneArmorReductionTotal(kind: number): number {
  const elementReduction = elementOf(zoneElement(kind)).armorReduction;
  const reactionReduction = zoneArmorReduction(kind);
  return Math.max(elementReduction, reactionReduction);
}

/**
 * L'amplification des degats qu'une zone impose, ELEMENT et REACTION
 * confondus — lue par `ZoneField.ampAt` (`shared/zones.ts`), qui ne voyage
 * jamais (le client ne prononce aucun degat).
 *
 * ⚠️ **Un MAXIMUM, jamais une somme ni un produit — decision de jeu**, la
 * meme que `zoneArmorReductionTotal` et que le maximum de `ZoneField.ampAt`
 * entre deux zones qui se recouvrent.
 */
export function zoneDamageAmpTotal(kind: number): number {
  const elementFactor = elementOf(zoneElement(kind)).damageAmp;
  const reactionFactor = reactionOfId(zoneReaction(kind))?.zoneDamageAmp ?? 1;
  return Math.max(elementFactor, reactionFactor);
}

/**
 * Le facteur de conservation de vitesse qu'une zone impose, DERIVE de son
 * `kind` (1 : aucun effet) — lu par `Horde#recomputeSteering`
 * (`shared/horde.ts`), des deux cotes du fil. Aucune combinaison avec
 * l'element : seule la reaction en decide.
 */
export function zoneInertiaDamping(kind: number): number {
  return reactionOfId(zoneReaction(kind))?.zoneInertiaDamping ?? 1;
}

/**
 * Le degat par tick entre deux ennemis qui se percutent dans une zone,
 * DERIVE de son `kind` (0 : aucun effet) — lu par `resolveVerglasCollisions`
 * (`back/src/combat.ts`), serveur seul.
 */
export function zoneCollisionDamage(kind: number): number {
  return reactionOfId(zoneReaction(kind))?.zoneCollisionDamage ?? 0;
}

/**
 * Le signe qu'une zone impose a la direction du champ de deplacement,
 * ELEMENT et REACTION confondus : `-1` fuite, `+1` aucun effet. Lu par
 * `Horde`, des deux cotes du fil.
 *
 * ⚠️ **Le MINIMUM des deux contributions**, comme `zoneSlowFactor` : sur
 * `{+1, -1}`, c'est un « OU » — la fuite l'emporte des qu'une contribution
 * l'impose, quel que soit l'ordre d'arrivee. Les couples reels de la Chaux
 * plancheent tous `zoneFieldSign` ; seule une zone de Chaux sans reaction
 * nommee le derive de l'element seul. Le test qui exerce encore le cas
 * dependant de l'ordre dans `shared/reactions.test.ts` le fait sur un couple
 * FICTIF.
 */
export function zoneFieldSign(kind: number): number {
  const elementSign = elementOf(zoneElement(kind)).fieldSign;
  const reactionSign = reactionOfId(zoneReaction(kind))?.zoneFieldSign ?? 1;
  return Math.min(elementSign, reactionSign);
}
