import { MAP_SIZE, TICK_HZ } from './constants';

/**
 * Les quatre intentions de la roue de ping (etape 9, levier 6 du §8 de
 * l'orientation). L'index EST l'identifiant sur le fil, comme partout dans
 * `shared/`.
 */
export const PING_INTENTS = ['viens', 'danger', 'boss', 'jePrends'] as const;
export type PingIntent = (typeof PING_INTENTS)[number];

/** Duree d'affichage d'un ping, en ticks de horde (4 s). */
export const PING_LIFE_TICKS = 4 * TICK_HZ;
/** Pings acceptes par joueur dans une fenetre de `PING_WINDOW_TICKS`. */
export const PING_BURST = 3;
/** Fenetre de l'anti-spam, en ticks de salon (2 s). */
export const PING_WINDOW_TICKS = 2 * TICK_HZ;

/** Ramene une coordonnee dans la carte : un client peut envoyer n'importe quoi. */
export function clampToMap(v: number): number {
  return Math.min(MAP_SIZE, Math.max(0, Math.round(v)));
}
