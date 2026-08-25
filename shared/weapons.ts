/**
 * Les armes, pilotees par la donnee (§5.1 de la spec).
 *
 * Meme principe que `shared/archetypes.ts`, et meme raison : le §9.1 rappelle
 * que Riot a deplace son spawn du script vers de la donnee pour tenir la
 * charge. Un systeme unique lit cette table ; ajouter une arme au pool des
 * quarante du §6.2 sera du contenu, pas de l'architecture.
 */
export interface Weapon {
  id: number;
  name: string;
  /** Cadence de tir, en ticks. */
  cooldownTicks: number;
  /** Degats par projectile. */
  damage: number;
  /** Vitesse du projectile, en pixels monde par seconde. */
  projectileSpeed: number;
  /** Portee, exprimee en duree de vie du projectile, en ticks. */
  projectileLifeTicks: number;
  /** Nombre de projectiles par salve. */
  projectileCount: number;
  /**
   * Largeur angulaire totale de la salve, en radians, repartie
   * symetriquement de part et d'autre de la direction visee.
   *
   * Sans effet quand `projectileCount` vaut 1 : un seul projectile part droit
   * sur la cible, la valeur reste renseignee pour que tous les champs soient
   * strictement positifs quelle que soit l'arme (voir le test).
   */
  spreadRadians: number;
}

/**
 * L'index dans le tableau **est** l'identifiant, comme pour `ARCHETYPES` :
 * aucune table de correspondance a synchroniser entre serveur et clients.
 *
 * La premiere entree est l'arme neutre de base du §6.1 : faible, sans
 * element, hors slots — celle avec laquelle une run commence toujours.
 */
const WEAPON_DEFS: readonly Omit<Weapon, 'id'>[] = [
  {
    // Arme neutre de base (§6.1) : faible, sans element, hors slots.
    name: 'dague',
    cooldownTicks: 15,
    damage: 5,
    projectileSpeed: 500,
    projectileLifeTicks: 20,
    projectileCount: 1,
    spreadRadians: 0.05,
  },
  {
    // Plusieurs projectiles en eventail : prouve que la dispersion tient,
    // pas seulement le tir a projectile unique.
    name: 'eventail',
    cooldownTicks: 45,
    damage: 4,
    projectileSpeed: 420,
    projectileLifeTicks: 12,
    projectileCount: 5,
    spreadRadians: Math.PI / 3,
  },
  {
    // Cadence lente, degats et portee eleves : prouve que la forme couvre
    // aussi l'extreme oppose du DPS instantane.
    name: 'arc-lourd',
    cooldownTicks: 60,
    damage: 25,
    projectileSpeed: 900,
    projectileLifeTicks: 40,
    projectileCount: 1,
    spreadRadians: 0.05,
  },
];

export const WEAPONS: readonly Weapon[] = WEAPON_DEFS.map((w, id) => ({ ...w, id }));

export function weaponOf(id: number): Weapon {
  const found = WEAPONS[id];
  if (!found) {
    throw new Error(`arme inconnue : ${id}`);
  }
  return found;
}
