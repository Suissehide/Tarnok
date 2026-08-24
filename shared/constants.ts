/** Simulation serveur, en pas par seconde. §3.5 : 20 Hz reste possible si la sensation tient. */
export const TICK_HZ = 30;

/** Diffusion serveur -> clients. Volontairement plus basse que la simulation. */
export const SNAPSHOT_HZ = 20;

/** Entrees client -> serveur. */
export const INPUT_HZ = 30;

/**
 * Retard du tampon d'interpolation client. Sans lui, le rendu tremble : il faut
 * toujours avoir deux snapshots encadrant l'instant qu'on affiche.
 */
export const INTERP_DELAY_MS = 100;

/**
 * Constante de temps de la reconciliation client, en millisecondes.
 *
 * Quand le serveur contredit la prediction locale, on ne teleporte pas : on
 * laisse l'ecart s'eteindre exponentiellement. A 33 ms, il est retombe a 5 %
 * apres une centaine de millisecondes — le « ~100 ms » du plan.
 *
 * Reconciliation naive, volontairement : le rejeu d'entrees appartient a
 * l'etape 2.
 */
export const RECONCILE_TAU_MS = 33;

/**
 * Cote de la carte, en pixels monde. Provisoire : le §15.2 de la spec dit que ce
 * chiffre se tranche avec le resultat du banc de l'etape 1, parce que le cout du
 * flowfield est en O(cellules).
 *
 * Contrainte dure : les positions passent en int16 sur le fil (§3.6), donc la
 * carte ne peut pas depasser 32767.
 */
export const MAP_SIZE = 6000;

export const MAX_PLAYERS = 4;

/** Vitesse d'un joueur, en pixels monde par seconde. */
export const PLAYER_SPEED = 260;

/** Cote d'une cellule de flowfield, en pixels monde. §4.2 : « environ 64 px ». */
export const FLOWFIELD_CELL = 64;

/** Recalcul du flowfield, en passes par seconde. §3.5 : 5 a 10 Hz. */
export const FLOWFIELD_HZ = 10;
