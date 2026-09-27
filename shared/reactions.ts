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
} from './constants';
import { ELEMENT, elementOf } from './elements';
import { packElementPair, zoneElement, zoneReaction } from './protocol';

/**
 * La table des reactions a effet SPECIFIQUE (tache 6 de l'etape 5b) : meme
 * motif que `ELEMENT_DEFS`, `WEAPONS` et `ARCHETYPES` — une donnee par
 * couple, pas un `switch` sur la paire.
 *
 * ⚠️ **Une paire ABSENTE de cette table n'est pas une erreur.** Elle rend
 * simplement le comportement GENERIQUE de `applyReactions` (le Choc thermique
 * de l'etape 5a : `REACTION_DAMAGE` dans `REACTION_RADIUS`, sans filtre ni
 * champ special) — c'est le cas de Braise+Givre aujourd'hui, la seule paire
 * des cinq de l'etape 5b (§5 de la spec) a rester sans effet specifique.
 *
 * ⚠️ **`id` empaquete le nibble de reaction de `ZoneField.kind`** (bits 3-6,
 * voir `packZoneKind`/`zoneReaction` dans `shared/protocol.ts`) — c'est la
 * meme valeur, jamais une seconde table a tenir synchrone. `postZone`
 * (`back/src/combat.ts`) l'y pose ; `zoneLifetimeTicks`/`zoneBurnPerTick`
 * ci-dessous l'en relisent.
 */
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
   * ⚠️ **Ne PEUT PAS se lire generiquement au site d'application, contrairement
   * a `Element.burnPerTick`.** Le champ que laisse une reaction porte
   * l'element du DECLENCHEUR (voir `ReactionTrigger.element`), qui varie selon
   * l'ordre d'arrivee des deux elements — pour Surchauffe (Braise + Foudre) ca
   * peut etre Foudre, dont `Element.burnPerTick` est nul. Le taux de brulure
   * de la zone doit donc venir du TYPE DE REACTION, jamais de l'element.
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
   * aucun effet propre — la Supraconduction, tache 7 de l'etape 5b, est la
   * seule a en porter un aujourd'hui).
   *
   * ⚠️ **Combine par MINIMUM avec `Element.slowFactor` de l'element porte par
   * le `kind`, jamais lu seul.** Voir `zoneSlowFactor` ci-dessous : le nibble
   * d'element d'une zone de reaction porte celui du DECLENCHEUR
   * (`ReactionTrigger.element`), qui varie selon l'ordre d'arrivee des deux
   * elements — lire `elementOf(zoneElement(kind)).slowFactor` seul rendrait
   * une reponse different selon cet ordre, jamais la meme.
   */
  readonly zoneSlowFactor: number;
  /**
   * Armure SOUSTRAITE (jamais multipliee) a qui se tient dans la zone
   * laissee par cette reaction (0 : aucun effet).
   *
   * ⚠️ **N'a PAS d'equivalent porte par `Element`, contrairement a
   * `zoneSlowFactor`.** Rien a combiner avec le nibble d'element ici : voir
   * `zoneArmorReduction` ci-dessous.
   */
  readonly zoneArmorReduction: number;
  /**
   * Facteur de conservation de la vitesse tenue dans la zone laissee par
   * cette reaction (1 : aucun effet propre — Verglas, tache 8 de l'etape 5b,
   * est la seule a en porter un aujourd'hui). Lu par
   * `Horde#recomputeSteering` (`shared/horde.ts`), qui VOYAGE des deux cotes
   * du fil.
   *
   * ⚠️ **AUCUN equivalent porte par `Element`, contrairement a
   * `zoneSlowFactor` — rien a combiner avec le nibble d'element ici.**
   * L'inertie est une propriete de la REACTION seule : deriver du
   * declencheur (Givre OU Poix selon l'ordre d'arrivee) n'aurait aucun sens,
   * `Element` ne portant aucune notion de friction. Voir
   * `zoneInertiaDamping` ci-dessous.
   */
  readonly zoneInertiaDamping: number;
  /**
   * Degats par tick entre DEUX ennemis qui se tiennent tous deux dans la
   * zone laissee par cette reaction et sont trop proches l'un de l'autre (0 :
   * aucun effet — Verglas, tache 8 de l'etape 5b, est la seule a en porter
   * un aujourd'hui, « ils se percutent »).
   *
   * ⚠️ **Un DEGAT, donc lu SEULEMENT cote serveur** (`resolveVerglasCollisions`,
   * `back/src/combat.ts`), aucune contrainte de replication — le client ne
   * prononce jamais de degat (§2), seules les morts qui en resultent
   * voyagent, et elles voyagent deja par `DEATHS`.
   */
  readonly zoneCollisionDamage: number;
  /**
   * Signe propre a la zone laissee par cette reaction (etape 5c, tache 1) :
   * `+1` aucun effet propre, `-1` inverse la direction du champ. Aucune
   * ligne ne porte `-1` aujourd'hui — la fuite de la Chaux vient de
   * `Element.fieldSign`, lu ici via `zoneFieldSign` ci-dessous.
   *
   * ⚠️ **Meme forme que `zoneSlowFactor` : un PLANCHER que la reaction peut
   * poser pour garantir l'effet quel que soit l'ordre d'arrivee, pas une
   * duplication de l'element.** Aucune des cinq reactions actuelles ne pair
   * la Chaux — celles qui le feront (Fournee, Eclat de gel, Arc caustique,
   * Mortier vif, hors du perimetre de cette tache) devront reprendre ce
   * champ si leur zone doit fuir QUEL QUE SOIT l'element porte par le
   * nibble, exactement comme Verglas l'a fait pour `zoneSlowFactor`.
   */
  readonly zoneFieldSign: number;
}

const REACTION_DEFS: readonly ReactionDef[] = [
  {
    // Surchauffe (Braise + Foudre) : une zone qui brule d'elle-meme, plus
    // fort et plus longtemps que le champ generique — voir
    // `resolveBurn` (back/src/combat.ts) et `zoneLifetimeTicks` ci-dessous.
    id: REACTION.SURCHAUFFE,
    name: 'surchauffe',
    pair: packElementPair(ELEMENT.BRAISE, ELEMENT.FOUDRE),
    zoneBurnPerTick: SURCHAUFFE_BURN_PER_TICK,
    zoneLifetimeTicks: SURCHAUFFE_ZONE_LIFETIME_TICKS,
    radius: 0,
    damage: 0,
    // Ni ralentissement ni reduction d'armure propres : Surchauffe agit par
    // la brulure, pas par le deplacement ou la defense.
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
  },
  {
    // Embrasement (Braise + Poix) : degats instantanes a tout ennemi POISSE
    // dans un rayon — une seule passe geometrique, voir `damageInRadius`
    // (`markFilter`, back/src/combat.ts). Reutilise le rayon et le degat
    // generiques de la reaction (comme le Choc thermique) : l'ecart avec le
    // generique est la SELECTIVITE (poisses seulement), pas l'intensite —
    // aucune donnee de jeu ne motive un second chiffre.
    id: REACTION.EMBRASEMENT,
    name: 'embrasement',
    pair: packElementPair(ELEMENT.BRAISE, ELEMENT.POIX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: 0,
    radius: REACTION_RADIUS,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
  },
  {
    // Court-circuit (Foudre + Poix) : `chainTargets` (shared/chain.ts),
    // jumps non borne, tant que les cibles restent poissees — voir
    // `chainWhilePoisoned` (back/src/combat.ts). Meme degat generique que la
    // reaction, par saut.
    id: REACTION.COURT_CIRCUIT,
    name: 'court-circuit',
    pair: packElementPair(ELEMENT.FOUDRE, ELEMENT.POIX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: 0,
    radius: 0,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
  },
  {
    // Supraconduction (Givre + Foudre, tache 7 de l'etape 5b) : vitesse
    // NULLE et armure rabotee dans la zone laissee — ni brulure ni effet
    // geometrique instantane, donc les quatre premiers champs restent a leur
    // valeur neutre. Voir `Horde#computeSlow` (shared/horde.ts, le MINIMUM
    // qui la fait voyager) et `armureA` (back/src/combat.ts, le MAXIMUM qui
    // ne la fait pas voyager) pour les deux chemins qui la lisent.
    id: REACTION.SUPRACONDUCTION,
    name: 'supraconduction',
    pair: packElementPair(ELEMENT.GIVRE, ELEMENT.FOUDRE),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: 0,
    radius: 0,
    damage: 0,
    // 0 : gel total, quel que soit l'element porte par le nibble (Givre OU
    // Foudre selon l'ordre d'arrivee du declencheur) — voir `zoneSlowFactor`.
    zoneSlowFactor: 0,
    zoneArmorReduction: SUPRACONDUCTION_ARMOR_REDUCTION,
    // Ni inertie ni collision propres : la Supraconduction agit par le gel,
    // pas par la perte de controle.
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
  },
  {
    // Verglas (Givre + Poix, tache 8 de l'etape 5b) : friction REDUITE dans
    // la zone laissee — les ennemis gardent leur trajectoire au lieu de la
    // corriger (`zoneInertiaDamping`, `Horde#recomputeSteering`, ce qui
    // VOYAGE) et se percutent en glissant (`zoneCollisionDamage`,
    // `resolveVerglasCollisions` dans `back/src/combat.ts`, ce qui ne
    // voyage PAS — un degat, serveur seul). Ni brulure ni effet geometrique
    // instantane propres.
    id: REACTION.VERGLAS,
    name: 'verglas',
    pair: packElementPair(ELEMENT.GIVRE, ELEMENT.POIX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: 0,
    radius: 0,
    damage: 0,
    // ⚠️ **EXPLICITE, jamais neutre (1) — voir le docbloc de `zoneSlowFactor`
    // plus bas.** Un facteur neutre laisserait l'element du DECLENCHEUR
    // (Givre OU Poix selon l'ordre d'arrivee) fuiter au travers du minimum :
    // min(0,6, 1) = 0,6 si Givre declenche, min(1, 1) = 1 si Poix declenche —
    // la meme Verglas glisserait ou pas selon quel projectile a touche en
    // second. Fixe a la valeur de Givre (jamais recopiee — voir
    // `elementOf`) : le minimum rend alors 0,6 dans les DEUX cas
    // (min(0,6, 0,6) = 0,6, min(1, 0,6) = 0,6), ni plus ni moins que le
    // Givre seul — Verglas n'AJOUTE aucun ralentissement, elle en garantit
    // un, quel que soit l'ordre.
    zoneSlowFactor: elementOf(ELEMENT.GIVRE).slowFactor,
    zoneArmorReduction: 0,
    zoneInertiaDamping: VERGLAS_INERTIA_DAMPING,
    zoneCollisionDamage: VERGLAS_COLLISION_DAMAGE_PER_TICK,
    zoneFieldSign: 1,
  },
  {
    // Fournee (Braise + Chaux, tache 4 de l'etape 5c) : la combustion double
    // (`FOURNEE_BURN_PER_TICK`, deux fois `SURCHAUFFE_BURN_PER_TICK`) ET
    // l'armure tombe a zero dans la zone (`zoneArmorReduction: MAX_ARMOR`,
    // voir `armureA` dans `back/src/combat.ts` : borne par le bas a zero, donc
    // MAX_ARMOR suffit a annuler n'importe quelle armure d'archetype, jamais
    // superieure a MAX_ARMOR elle-meme).
    //
    // ⚠️ **`zoneArmorReduction` ET `zoneFieldSign` sont EXPLICITES, jamais
    // heritees de l'element — le piege des DEUX planchers.** Cette paire
    // apparie la Chaux, qui porte DEUX proprietes non neutres
    // (`armorReduction` et `fieldSign: -1`, voir `shared/elements.ts`) : le
    // nibble d'element de la zone porte le DECLENCHEUR (Braise OU Chaux selon
    // l'ordre d'arrivee), donc lire l'une ou l'autre grandeur SEULE au
    // travers de l'element rendrait Fournee corrosive une fois sur deux
    // (`zoneArmorReductionTotal` combine par MAXIMUM) et fuyante une fois sur
    // deux (`zoneFieldSign` combine par MINIMUM). `MAX_ARMOR` domine
    // n'importe quelle contribution de l'element (`CHAUX_ARMOR_REDUCTION`
    // dessous), et `elementOf(ELEMENT.CHAUX).fieldSign` (-1) domine le
    // neutre (+1) de la Braise par le minimum : les deux plafonds/planchers
    // rendent le resultat le MEME quel que soit l'ordre. Voir le test
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
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: elementOf(ELEMENT.CHAUX).fieldSign,
  },
  {
    // Eclat de gel (Givre + Chaux, tache 4 de l'etape 5c) : degats bruts
    // massifs sur la SEULE cible qui declenche la reaction (`ECLAT_DE_GEL_DAMAGE`),
    // pas un effet de zone — voir la branche dediee d'`applyReactions`
    // (`back/src/combat.ts`), qui lit `damage` directement au lieu du
    // balayage generique. `radius: 0` documente ce choix : AUCUN effet
    // geometrique, contrairement a Embrasement.
    //
    // ⚠️ **`zoneArmorReduction` ET `zoneFieldSign` restent EXPLICITES, MEME
    // pour une reaction dont l'effet reel n'est PAS porte par la zone.** Le
    // meme piege que Fournee ci-dessus s'applique : `postZone`
    // (`back/src/combat.ts`) pose une zone pour CHAQUE declencheur, sans
    // exception pour les reactions « degat seul » — la zone laissee par Eclat
    // de gel existe donc bel et bien, et son element porte le DECLENCHEUR
    // (Givre OU Chaux selon l'ordre). Sans plancher explicite, la corrosion et
    // la fuite de la Chaux qu'elle porte fuiteraient une fois sur deux,
    // exactement comme pour Fournee. La reduction choisie ici est
    // `elementOf(ELEMENT.CHAUX).armorReduction` — pas `MAX_ARMOR` — parce
    // qu'Eclat de gel ne PRETEND a aucun effet d'armure propre (a la
    // difference de Fournee) : le plancher garantit seulement ce qu'une Chaux
    // SEULE laisserait deja, ni plus ni moins, quel que soit l'ordre.
    id: REACTION.ECLAT_DE_GEL,
    name: 'eclat-de-gel',
    pair: packElementPair(ELEMENT.GIVRE, ELEMENT.CHAUX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: 0,
    radius: 0,
    damage: ECLAT_DE_GEL_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: elementOf(ELEMENT.CHAUX).armorReduction,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: elementOf(ELEMENT.CHAUX).fieldSign,
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
 * La duree de vie qu'une zone doit tenir, DERIVEE de son `kind` empaquete —
 * `ZONE_LIFETIME_TICKS` par defaut, la duree propre a sa reaction si elle en
 * porte une (Surchauffe aujourd'hui).
 *
 * ⚠️ **Lue des DEUX cotes du fil**, par `ZoneField.aliveAt`/`expire`
 * (`shared/zones.ts`) : le client et le serveur decodent le meme octet et
 * obtiennent la meme reponse, sans rien annoncer de plus.
 */
export function zoneLifetimeTicks(kind: number): number {
  const def = reactionOfId(zoneReaction(kind));
  return def && def.zoneLifetimeTicks > 0 ? def.zoneLifetimeTicks : ZONE_LIFETIME_TICKS;
}

/** Le degat par tick qu'une zone inflige d'elle-meme, derive de son `kind` empaquete (0 : elle ne brule pas). */
export function zoneBurnPerTick(kind: number): number {
  return reactionOfId(zoneReaction(kind))?.zoneBurnPerTick ?? 0;
}

/**
 * Le facteur de vitesse qu'une zone impose, DERIVE de son `kind` empaquete —
 * lu par `Horde#computeSlow` (`shared/horde.ts`), qui VOYAGE des deux cotes
 * du fil.
 *
 * ⚠️ **Le MINIMUM de l'element porte ET de la reaction, jamais l'un seul.**
 * Le nibble d'element d'une zone de reaction porte celui du DECLENCHEUR
 * (`ReactionTrigger.element`), qui varie selon l'ordre d'arrivee des deux
 * elements. Pour la Supraconduction (Givre + Foudre), le nibble d'element
 * porte Givre OU Foudre selon cet ordre — `elementOf(zoneElement(kind)).slowFactor`
 * seul rendrait donc 0,6 (Givre) ou 1 (Foudre), jamais le gel total que la
 * reaction impose. Combiner par minimum avec `ReactionDef.zoneSlowFactor`
 * (0 pour la Supraconduction) rend le resultat INDEPENDANT de cet ordre :
 * `min(0,6, 0)` et `min(1, 0)` valent tous deux 0.
 *
 * ⚠️ **Meme raison arithmetique que le minimum de `Horde#computeSlow`, pas
 * une decision de jeu** — voir son docbloc : cette grandeur voyage, et
 * l'ordre d'iteration des zones n'est pas garanti identique des deux cotes du
 * fil, donc seule une combinaison exactement commutative et associative
 * survit.
 *
 * ⚠️ **Le piege que la revue de la tache 7 a vu venir pour Verglas (tache 8),
 * et qui NE se serait PAS resolu de lui-meme.** Pour la Supraconduction,
 * `reactionFactor = 0` est un PLANCHER ABSOLU : `min(x, 0) = 0` quel que
 * soit `x`. Verglas n'a pas ce luxe — si sa ligne avait laisse
 * `zoneSlowFactor: 1` (neutre, comme les trois reactions de la tache 6),
 * `min(elementFactor, 1) = elementFactor` aurait rendu 0,6 (Givre declenche)
 * OU 1 (Poix declenche), et la meme Verglas aurait glisse ou pas selon quel
 * projectile a touche en second. Sa ligne porte donc un facteur EXPLICITE
 * (`elementOf(ELEMENT.GIVRE).slowFactor`, pas une reference neutre), choisi
 * pour etre un plancher aussi — voir le commentaire de son entree dans
 * `REACTION_DEFS`.
 */
export function zoneSlowFactor(kind: number): number {
  const elementFactor = elementOf(zoneElement(kind)).slowFactor;
  const reactionFactor = reactionOfId(zoneReaction(kind))?.zoneSlowFactor ?? 1;
  return Math.min(elementFactor, reactionFactor);
}

/**
 * La MOITIE reaction de la reduction d'armure d'une zone, DERIVEE de son
 * `kind` empaquete (0 : aucun effet) — la Supraconduction (tache 7 de
 * l'etape 5b) est la seule reaction a en porter une aujourd'hui.
 *
 * ⚠️ **N'est plus la grandeur COMPLETE depuis la tache 1 de l'etape 5c.**
 * `Element` porte desormais aussi un `armorReduction` (la Chaux) : c'est
 * `zoneArmorReductionTotal`, juste en dessous, qui combine les deux, exactement
 * comme `zoneSlowFactor` combine `Element.slowFactor` et
 * `ReactionDef.zoneSlowFactor`. Cette fonction-ci reste la lecture NUE de la
 * table des reactions, inchangee depuis la tache 7 — `ZoneField.armorReductionAt`
 * lit desormais `zoneArmorReductionTotal`, jamais celle-ci directement.
 */
export function zoneArmorReduction(kind: number): number {
  return reactionOfId(zoneReaction(kind))?.zoneArmorReduction ?? 0;
}

/**
 * La reduction d'armure qu'une zone impose, ELEMENT et REACTION confondus —
 * lue par `ZoneField.armorReductionAt` (`shared/zones.ts`), qui ne voyage
 * jamais (voir `armureA`, `back/src/combat.ts`).
 *
 * ⚠️ **Meme raison d'etre que `zoneSlowFactor`** : le nibble d'element d'une
 * zone de reaction porte celui du DECLENCHEUR, qui varie selon l'ordre
 * d'arrivee. Deriver de l'element seul rendrait l'effet dependant de cet
 * ordre — le bug que l'etape 5b a paye deux fois (voir le docbloc du
 * module).
 *
 * ⚠️ **Un MAXIMUM entre les deux contributions, jamais une somme — decision
 * de jeu, pas contrainte arithmetique.** Deux sources de corrosion ne
 * s'additionnent pas, comme deux flaques de Poix n'additionnent pas leur
 * amplification (`ZoneField.ampAt`) : c'est la MEME raison que le maximum
 * d'`ampAt`/`armorReductionAt`/`collisionDamageAt`/`burnAt`, PAS celle,
 * arithmetique, du minimum de `Horde#computeSlow` (ou de `zoneSlowFactor`
 * ci-dessus, qui partage sa raison). Ne pas confondre les deux dans un futur
 * commentaire : voir le docbloc de `ZoneField.ampAt` pour la distinction
 * complete.
 */
export function zoneArmorReductionTotal(kind: number): number {
  const elementReduction = elementOf(zoneElement(kind)).armorReduction;
  const reactionReduction = zoneArmorReduction(kind);
  return Math.max(elementReduction, reactionReduction);
}

/**
 * Le facteur de conservation de vitesse qu'une zone impose, DERIVE de son
 * `kind` empaquete (1 : aucun effet) — lu par `Horde#recomputeSteering`
 * (`shared/horde.ts`), qui VOYAGE des deux cotes du fil.
 *
 * ⚠️ **Aucune combinaison avec l'element du nibble ici, contrairement a
 * `zoneSlowFactor`.** `Element` ne porte aucune notion de friction ou
 * d'inertie : seule la reaction en decide, et Verglas (tache 8 de l'etape
 * 5b) est aujourd'hui la seule a en porter une.
 */
export function zoneInertiaDamping(kind: number): number {
  return reactionOfId(zoneReaction(kind))?.zoneInertiaDamping ?? 1;
}

/**
 * Le degat par tick entre deux ennemis qui se percutent dans une zone,
 * DERIVE de son `kind` empaquete (0 : aucun effet) — lu par
 * `resolveVerglasCollisions` (`back/src/combat.ts`), qui ne voyage JAMAIS
 * (un degat, comme `zoneArmorReduction` : seul le serveur le lit).
 */
export function zoneCollisionDamage(kind: number): number {
  return reactionOfId(zoneReaction(kind))?.zoneCollisionDamage ?? 0;
}

/**
 * Le signe qu'une zone impose a la direction du champ de deplacement,
 * ELEMENT et REACTION confondus : `-1` la zone inverse la direction (fuite),
 * `+1` elle ne la touche pas. Lu par `Horde` (etape 5c, tache 1), qui VOYAGE
 * des deux cotes du fil — meme raisonnement que `zoneSlowFactor`, dont cette
 * fonction reprend exactement la forme.
 *
 * ⚠️ **Meme piege d'ordre que `zoneArmorReductionTotal` et `zoneSlowFactor`,
 * et le MEME remede : le MINIMUM entre les deux contributions.** Le nibble
 * d'element d'une zone de reaction porte celui du DECLENCHEUR, qui varie
 * selon l'ordre d'arrivee — deriver de l'element seul rendrait la fuite
 * dependante de cet ordre. Le minimum sur le domaine `{+1, -1}` implemente
 * une regle "OR" : `-1` (fuite) l'emporte des qu'UNE des deux contributions
 * l'impose, exactement comme `reactionFactor = 0` emporte tout sur
 * `zoneSlowFactor`.
 *
 * ⚠️ **Aujourd'hui, seul `Element.fieldSign` (la Chaux) porte un `-1` — aucune
 * ligne de `REACTION_DEFS` ne surcharge encore `zoneFieldSign`.** Une zone de
 * Chaux SANS reaction nommee (le Choc thermique generique, le seul cas
 * possible tant que les taches 4 a 7 de l'etape 5c n'ont pas cable Fournee,
 * Eclat de gel, Arc caustique et Mortier vif) fuit donc uniquement quand
 * CHAUX est l'element porte par le nibble — c'est-a-dire uniquement quand la
 * Chaux est arrivee EN SECOND. C'est le meme etat transitoire, ORDRE-DEPENDANT,
 * que `zoneArmorReductionTotal` traverse avant que Fournee ne lui donne un
 * plancher explicite (voir son test « ne depend pas de l'ordre d'arrivee »,
 * `shared/reactions.test.ts`) : une future tache qui cable un couple de la
 * Chaux devra decider si sa reaction doit ELLE AUSSI garantir la fuite —
 * en portant `zoneFieldSign: -1` — quel que soit l'element du nibble.
 */
export function zoneFieldSign(kind: number): number {
  const elementSign = elementOf(zoneElement(kind)).fieldSign;
  const reactionSign = reactionOfId(zoneReaction(kind))?.zoneFieldSign ?? 1;
  return Math.min(elementSign, reactionSign);
}
