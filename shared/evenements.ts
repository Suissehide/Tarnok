import { TICK_HZ } from './constants';

/**
 * Les evenements bonus (etape 14) : ce que le serveur ET le client doivent
 * connaitre — le genre, l'issue, la duree, la cadence du fil, les rayons
 * dessines. Le reste (placement, regles, PV du chariot) vit au serveur seul,
 * `back/src/evenement.ts` : aucun client ne derive un evenement, il le lit.
 */

/**
 * Le genre, l'octet `genre` d'`EVENT_START` (ses 7 bits bas ; le bit haut dit
 * « solo », `EVENT_SOLO_FLAG`). L'index EST l'identifiant : les quatre genres
 * de l'etape 16 viennent APRES les trois de l'etape 14, qui ne bougent pas.
 */
export const EVENT_KIND = {
  SCEAUX: 0,
  FORGE: 1,
  CONVOI: 2,
  SIEGE: 3,
  RELIQUE: 4,
  CHASSE: 5,
  NOIR: 6,
} as const;

/** Le nombre de genres : `placeEvent` lit `seed % EVENT_KIND_COUNT`. */
export const EVENT_KIND_COUNT = Object.keys(EVENT_KIND).length;

/**
 * Le bit haut de l'octet de genre d'`EVENT_START` : « un seul vivant au
 * depart ». Zero octet de plus — le client en a besoin pour predire la
 * vitesse du porteur de relique et dessiner la lumiere (etape 16, §7.1).
 */
export const EVENT_SOLO_FLAG = 0x80;

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

/** Le siege (etape 16, §3) : le corps dessine du totem ; son rayon de contact en derive au serveur. */
export const TOTEM_RADIUS = 28;
/** Un joueur vivant a cette distance du totem le defend : le compte avance. */
export const SIEGE_DEFEND_RADIUS = 150;
/** La relique (§4) : son porteur avance a cette part de sa vitesse, et ne tire pas. */
export const RELIQUE_CARRIER_SPEED = 0.6;
export const RELIQUE_CARRIER_SPEED_SOLO = 0.8;
/** Le porteur a cette distance de l'autel livre la relique. */
export const RELIQUE_ALTAR_RADIUS = 80;
/** Le noir (§6) : le rayon de la lumiere autour du porteur de lanterne. */
export const NOIR_LIGHT_RADIUS = 350;
export const NOIR_LIGHT_RADIUS_SOLO = 500;

/**
 * Le facteur de vitesse du porteur de relique. UNE fonction pour le salon
 * (`EventRun#speedFactorOf`) et la prediction (`GameClient#localSpeed`) : deux
 * copies divergeraient a la premiere retouche.
 */
export function relicSpeedFactor(solo: boolean): number {
  return solo ? RELIQUE_CARRIER_SPEED_SOLO : RELIQUE_CARRIER_SPEED;
}

/** Le rayon de la lumiere du noir, au salon (`inDark`) comme a l'ecran. */
export function lightRadius(solo: boolean): number {
  return solo ? NOIR_LIGHT_RADIUS_SOLO : NOIR_LIGHT_RADIUS;
}
