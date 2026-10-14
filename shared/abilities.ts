import type { VerbKind } from './classes';
import { TICK_HZ } from './constants';

/**
 * Les identifiants de verbe sur le fil.
 *
 * ⚠️ **Nombres, pas chaines, et l'ordre est fige** : `ABILITY_USED` les porte
 * en `u8`. Ajouter un verbe se fait a la FIN.
 */
export const VERB_IDS: Readonly<Record<VerbKind, number>> = Object.freeze({
  amorce: 0,
  rempart: 1,
  appat: 2,
  relais: 3,
});

/**
 * Recharge de chaque verbe, en ticks.
 *
 * ⚠️ **Reglages d'equilibrage, a confronter au playtest** (§11 de la spec).
 * Ils sont ici, nommes et en un seul endroit, pour qu'une partie puisse les
 * bouger sans fouiller le code. **Aucun test ne doit les coder en dur** : ils
 * se lisent d'ici.
 */
export const ABILITY_COOLDOWN_TICKS: Readonly<Record<VerbKind, number>> = Object.freeze({
  amorce: 6 * TICK_HZ,
  rempart: 12 * TICK_HZ,
  appat: 15 * TICK_HZ,
  relais: 10 * TICK_HZ,
});

/** Rayon de la zone d'Amorce et de Rempart, en pixels monde. */
export const ABILITY_ZONE_RADIUS = 160;

/**
 * Duree de vie d'une zone de Rempart, en ticks. Reglage d'equilibrage, comme
 * les recharges : a confronter au playtest.
 */
export const REMPART_LIFETIME_TICKS = 5 * TICK_HZ;

/** Duree de vie d'un leurre, en ticks. */
export const DECOY_LIFETIME_TICKS = 5 * TICK_HZ;

/** Portee d'un Relais : au-dela, l'allie est hors d'atteinte. */
export const RELAIS_RANGE = 1800;

/** Duree d'intangibilite offerte par le trait `relaisIntangible`, en ticks. */
export const RELAIS_INTANGIBLE_TICKS = Math.round(0.5 * TICK_HZ);

/**
 * Reduction de degats offerte par une zone de Rempart.
 *
 * ⚠️ **Elle se combine avec l'armure du compte par le MAXIMUM, jamais par une
 * somme** (§6.2 de la spec). La boutique vend `Armure` sur cinq paliers : une
 * somme ferait de « cinq paliers plus un Rempart » une quasi-immunite, et
 * l'abus se paierait en or donc se verrait mal.
 */
export const REMPART_ARMOR = 0.25;

/** Distance en deca de laquelle un allie est « adjacent », pour le trait `remparteAllie`. */
export const ADJACENT_RANGE = 120;

/**
 * Ce que le salon ANNONCE quand il accepte un verbe. Jamais l'effet, seulement son declenchement.
 */
export interface AbilityUsed {
  readonly tick: number;
  readonly playerId: number;
  readonly verb: number;
  readonly x: number;
  readonly y: number;
  /** La cible d'un Relais ; `0` pour les verbes qui n'en ont pas. */
  readonly targetId: number;
}
