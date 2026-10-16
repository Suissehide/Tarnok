import { TICK_HZ } from './constants';

/**
 * Les evenements bonus (etape 14) : ce que le serveur ET le client doivent
 * connaitre — le genre, l'issue, la duree, la cadence du fil, les rayons
 * dessines. Le reste (placement, regles, PV du chariot) vit au serveur seul,
 * `back/src/evenement.ts` : aucun client ne derive un evenement, il le lit.
 */

/** Le genre, l'octet `genre` d'`EVENT_START`. L'index EST l'identifiant. */
export const EVENT_KIND = {
  SCEAUX: 0,
  FORGE: 1,
  CONVOI: 2,
} as const;

/** L'issue, l'octet d'`EVENT_END`. Expire et detruit ne coutent rien : seule la recompense est perdue. */
export const EVENT_OUTCOME = {
  REUSSI: 0,
  EXPIRE: 1,
  DETRUIT: 2,
} as const;

/**
 * 60 s pour reussir, en ticks VIVANTS.
 *
 * ⚠️ **L'evenement dort pendant tout gel ET pendant la rampe de reprise**
 * (§2.4) : c'est ce qui rend juste, sans un octet, le compte a rebours que le
 * client pose sur `pingClock` — qui dort exactement quand lui dort.
 */
export const EVENT_DURATION_TICKS = 60 * TICK_HZ;

/** Un `EVENT_STATE` tous les 6 ticks vivants : 5 Hz, et seulement pendant un evenement. */
export const EVENT_STATE_PERIOD_TICKS = TICK_HZ / 5;

/** Rayon d'un sceau : un joueur vivant a cette distance ou moins l'occupe. */
export const SCEAU_RADIUS = 120;
/** Rayon de la forge : un joueur vivant et IMMOBILE dedans la canalise. */
export const FORGE_RADIUS = 90;
/** Un joueur vivant a cette distance du chariot l'escorte : il avance. */
export const CONVOI_ESCORT_RADIUS = 150;
/** Le corps dessine du chariot ; son rayon de contact en derive au serveur. */
export const CONVOI_RADIUS = 32;
