import { WEAPON_MAX_LEVEL } from './constants';
import { passiveOf } from './passives';

/**
 * Les armes, pilotees par la donnee (§5.1 de la spec).
 *
 * Meme principe que `shared/archetypes.ts`, et meme raison : le §9.1 rappelle
 * que Riot a deplace son spawn du script vers de la donnee pour tenir la
 * charge. Un systeme unique lit cette table ; ajouter une arme au pool des
 * quarante du §6.2 sera du contenu, pas de l'architecture.
 *
 * Depuis l'etape 4 (§3.3, §7.5) : une arme MONTE de niveau jusqu'a
 * `maxLevel`, puis la carte proposee devient l'evolution — a condition que
 * `evolutionPassiveId` soit deja possede. C'est la distinction structurante
 * avec un passif, qui lui s'empile sans jamais monter de niveau (voir
 * `shared/passives.ts`).
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
  /**
   * Niveau maximum de cette arme (§7.5). Vaut `WEAPON_MAX_LEVEL` pour toute
   * arme draftable ; l'arme neutre de base (hors slots, §6.1) ne monte jamais
   * de niveau et vaut 1 par construction — jamais consultee par le draft.
   */
  maxLevel: number;
  /**
   * Passif requis pour proposer l'evolution une fois `maxLevel` atteint
   * (§7.5). -1 : cette arme n'evolue pas.
   *
   * ⚠️ Quand ce champ n'est pas -1, il DOIT designer un passif existant de
   * `PASSIVES` : une reference morte ne se verrait nulle part avant qu'un
   * joueur drafte cette arme au niveau maximum, plusieurs taches plus tard.
   * C'est pourquoi la construction de `WEAPONS` ci-dessous verifie chaque
   * reference au chargement du module plutot que d'attendre le draft.
   */
  evolutionPassiveId: number;
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
    //
    // ⚠️ Reglage mesure, tache 14 : voir le rapport pour les chiffres. Ces
    // valeurs restaient celles de l'etape 2 — 2 morts/s theoriques contre
    // ~37 apparitions/s en moyenne, la montee de niveau (10 orbes) etait
    // inatteignable avant que le joueur ne meure encercle. La portee et la
    // cadence montent : la portee pour engager la horde plus tot (elle met
    // plusieurs secondes a traverser `ANCHOR_RADIUS`), la cadence pour que le
    // rythme de mise a mort suive celui de la premiere vague, desormais
    // ramenee par `WaveDirector` (voir `waveCountBounds`).
    //
    // Hors slots (§6.1) : ne monte jamais de niveau via le draft, `maxLevel`
    // vaut 1 par construction et n'est jamais lu par `Loadout`.
    name: 'dague',
    cooldownTicks: 7,
    damage: 5,
    projectileSpeed: 650,
    projectileLifeTicks: 28,
    projectileCount: 1,
    spreadRadians: 0.05,
    maxLevel: 1,
    evolutionPassiveId: -1,
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
    maxLevel: WEAPON_MAX_LEVEL,
    evolutionPassiveId: -1,
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
    maxLevel: WEAPON_MAX_LEVEL,
    evolutionPassiveId: -1,
  },
  {
    // Cadence tres rapide, courte portee : un cone continu au contact.
    name: 'lance-flammes',
    cooldownTicks: 5,
    damage: 3,
    projectileSpeed: 300,
    projectileLifeTicks: 10,
    projectileCount: 3,
    spreadRadians: 0.6,
    maxLevel: WEAPON_MAX_LEVEL,
    evolutionPassiveId: -1,
  },
  {
    // Cadence tres lente, degats massifs : l'extreme oppose du lance-flammes.
    name: 'grenade',
    cooldownTicks: 75,
    damage: 40,
    projectileSpeed: 350,
    projectileLifeTicks: 45,
    projectileCount: 1,
    spreadRadians: 0.05,
    maxLevel: WEAPON_MAX_LEVEL,
    evolutionPassiveId: -1,
  },
  {
    // Milieu de gamme, sert de reference pour les armes voisines.
    name: 'chakram',
    cooldownTicks: 35,
    damage: 12,
    projectileSpeed: 500,
    projectileLifeTicks: 35,
    projectileCount: 1,
    spreadRadians: 0.05,
    maxLevel: WEAPON_MAX_LEVEL,
    evolutionPassiveId: -1,
  },
  {
    // Deux projectiles paralleles, dispersion etroite.
    name: 'fleches-jumelles',
    cooldownTicks: 20,
    damage: 7,
    projectileSpeed: 600,
    projectileLifeTicks: 25,
    projectileCount: 2,
    spreadRadians: 0.15,
    maxLevel: WEAPON_MAX_LEVEL,
    evolutionPassiveId: -1,
  },
  {
    // Salve tres large a courte portee : l'autre extreme de la dispersion,
    // face a `eventail`.
    name: 'canon-a-mitraille',
    cooldownTicks: 50,
    damage: 6,
    projectileSpeed: 550,
    projectileLifeTicks: 8,
    projectileCount: 8,
    spreadRadians: Math.PI / 2,
    maxLevel: WEAPON_MAX_LEVEL,
    evolutionPassiveId: -1,
  },
  {
    // Seule arme du catalogue a evoluer (§7.5) : au niveau maximum, un joueur
    // qui possede deja le passif « puissance » (id 2, degats) se voit
    // proposer l'evolution plutot qu'une nouvelle carte de niveau.
    name: 'sceptre-arcanique',
    cooldownTicks: 40,
    damage: 10,
    projectileSpeed: 480,
    projectileLifeTicks: 30,
    projectileCount: 1,
    spreadRadians: 0.05,
    maxLevel: WEAPON_MAX_LEVEL,
    evolutionPassiveId: 2,
  },
];

export const WEAPONS: readonly Weapon[] = WEAPON_DEFS.map((w, id) => ({ ...w, id }));

/**
 * L'arme neutre de base du §6.1 : celle avec laquelle toute run commence.
 *
 * ⚠️ **Elle vit HORS des slots.** Elle ne figure dans aucun `Loadout`, n'est
 * jamais proposee par le draft (voir `buildPool`), ne monte jamais de niveau,
 * et tire quand meme a chaque tick. Ce n'est pas un detail de reglage : si le
 * draft la proposait, la prendre occuperait un slot pour une arme deja
 * possedee et la ferait tirer DEUX fois par tick.
 */
export const BASE_WEAPON_ID = 0;

// Garde-fou : une reference d'evolution vers un passif inexistant resterait
// invisible jusqu'a ce qu'un joueur drafte cette arme au niveau maximum
// (tache 3, plusieurs taches plus tard). `passiveOf` leve immediatement si
// l'id est incorrect : une table mal formee casse au CHARGEMENT du module,
// jamais silencieusement en jeu.
for (const w of WEAPONS) {
  if (w.evolutionPassiveId !== -1) {
    passiveOf(w.evolutionPassiveId);
  }
}

export function weaponOf(id: number): Weapon {
  const found = WEAPONS[id];
  if (!found) {
    throw new Error(`arme inconnue : ${id}`);
  }
  return found;
}

/**
 * Reduction maximale de cadence, toutes cartes « cadence » confondues.
 *
 * ⚠️ Le bonus est une FRACTION retiree (0,08 par carte) : treize cartes
 * donneraient 1,04, donc une recharge negative — l'arme tirerait a chaque
 * tick, et une quatorzieme ne changerait plus rien puisque le plancher d'un
 * tick est deja atteint. Plafonner ici garde la courbe lisible et laisse la
 * derniere carte utile.
 */
export const MAX_FIRE_RATE_BONUS = 0.75;

/**
 * Recharge d'une arme apres application des passifs de cadence.
 *
 * Le plancher d'UN tick n'est pas cosmetique : a zero, `tick - lastFireTick`
 * vaut toujours au moins la recharge et l'arme tirerait plusieurs fois par
 * tick si la boucle changeait.
 *
 * ⚠️ **Vit dans `shared/` et pas dans `back/src/room.ts`, ou elle est nee a la
 * tache 8.** Le client la lit aussi, depuis la tache 9 : `GameClient#fireWeapons`
 * est le miroir cosmetique de `Room#fireWeapons`, et deux copies de cette
 * formule divergeraient des la premiere retouche — les projectiles affiches ne
 * partiraient plus a la cadence de ceux que le serveur arbitre. Le client ne
 * peut pas importer `back/` (regle Biome, voir `room.ts`), donc la fonction
 * descend ici plutot que d'etre recopiee.
 */
export function cooldownWithBonus(base: number, bonus: number): number {
  const reduction = Math.min(Math.max(bonus, 0), MAX_FIRE_RATE_BONUS);
  return Math.max(1, Math.round(base * (1 - reduction)));
}
