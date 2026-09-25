import {
  REACTION_DAMAGE,
  REACTION_RADIUS,
  SUPRACONDUCTION_ARMOR_REDUCTION,
  SURCHAUFFE_BURN_PER_TICK,
  SURCHAUFFE_ZONE_LIFETIME_TICKS,
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
 * champ special) — c'est le cas de Braise+Givre aujourd'hui, et de
 * Givre+Foudre / Givre+Poix tant que les taches 7 et 8 ne les auront pas
 * remplies.
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
  },
  {
    // Embrasement (Braise + Poix) : degats instantanes a tout ennemi POISSE
    // dans un rayon — une seule passe geometrique, voir
    // `damagePoisonedInRadius` (back/src/combat.ts). Reutilise le rayon et le
    // degat generiques de la reaction (comme le Choc thermique) : l'ecart
    // avec le generique est la SELECTIVITE (poisses seulement), pas
    // l'intensite — aucune donnee de jeu ne motive un second chiffre.
    id: REACTION.EMBRASEMENT,
    name: 'embrasement',
    pair: packElementPair(ELEMENT.BRAISE, ELEMENT.POIX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: 0,
    radius: REACTION_RADIUS,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
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
 */
export function zoneSlowFactor(kind: number): number {
  const elementFactor = elementOf(zoneElement(kind)).slowFactor;
  const reactionFactor = reactionOfId(zoneReaction(kind))?.zoneSlowFactor ?? 1;
  return Math.min(elementFactor, reactionFactor);
}

/**
 * L'armure qu'une zone retire, DERIVEE de son `kind` empaquete (0 : aucun
 * effet) — lue par `ZoneField.armorReductionAt` (`shared/zones.ts`), qui ne
 * voyage jamais (voir `armureA`, `back/src/combat.ts`).
 *
 * ⚠️ **Aucune combinaison avec l'element du nibble ici, contrairement a
 * `zoneSlowFactor`.** `Element` ne porte aucun champ d'armure : seule la
 * reaction en decide.
 */
export function zoneArmorReduction(kind: number): number {
  return reactionOfId(zoneReaction(kind))?.zoneArmorReduction ?? 0;
}
