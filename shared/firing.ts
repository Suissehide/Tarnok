import { COLOSSUS_HP_STEP, CRIT_CHANCE, CRIT_MULTIPLIER } from './constants';
import type { Loadout } from './loadout';
import type { Crit } from './projectiles';
import { DAMAGE_PER_UPGRADE, UPGRADE, upgradedWeapon, type Weapon, weaponOf } from './weapons';

/**
 * Ce qu'un tir vaut, calcule UNE fois pour les deux cotes du fil (etape 10).
 *
 * ⚠️ **`Room#fireOne` et `GameClient#fireOne` appellent ces fonctions, jamais
 * deux copies.** La formule de degats existait en deux exemplaires
 * (`room.ts` et `client.ts`) : ils auraient diverge au premier passif ajoute,
 * et le client aurait dessine une salve que le serveur ne tire pas — le meme
 * argument que `applyCardToLoadout` et `cooldownWithBonus`.
 *
 * Hors de `weapons.ts` parce que tout ici lit un `Loadout`, et que
 * `loadout.ts` importe deja `weapons.ts`.
 */

/**
 * Les crans d'un aspect pour CE joueur : ceux de l'arme (ses cartes), plus
 * ceux que ses passifs ajoutent a toutes ses armes — Volee (`salvo`) aux
 * seules armes de tir et de frappe, Ampleur (`zone`) a toutes (§3.1).
 */
export function weaponUpgrades(loadout: Loadout, weapon: Weapon): (upgrade: number) => number {
  // La frappe (etape 12) compte ses eclairs dans `projectileCount` : Volee
  // en ajoute, comme a une salve.
  const volee = weapon.kind === 'tir' || weapon.kind === 'frappe' ? loadout.bonus('salvo') : 0;
  const ampleur = loadout.bonus('zone');
  return (u) =>
    loadout.upgradesOf(weapon.id, u) +
    (u === UPGRADE.SALVO ? volee : 0) +
    (u === UPGRADE.ZONE ? ampleur : 0);
}

/** L'arme telle que CE joueur la tire : `upgradedWeapon` sur `weaponUpgrades`. */
export function armedWeapon(loadout: Loadout, weaponId: number): Weapon {
  const base = weaponOf(weaponId);
  return upgradedWeapon(base, weaponUpgrades(loadout, base));
}

/**
 * Les degats d'un tir : passifs de degats + bonus de compte + cartes
 * « degats » de l'arme.
 *
 * `maxHp` est le PV max du tireur (lu par Colosse).
 *
 * ⚠️ **Colosse MULTIPLIE** (etape 10, §4) : +`magnitude` par tranche ENTIERE
 * de `COLOSSUS_HP_STEP` PV max, applique au total des autres bonus — les
 * passifs de l'etape « se multiplient entre eux ». Les achats de vitalite
 * permanente montent aussi le PV max : c'est voulu (§7, a surveiller).
 */
export function shotDamage(
  weapon: Weapon,
  loadout: Loadout,
  accountDamage: number,
  maxHp: number,
): number {
  const colosse = 1 + loadout.bonus('colossus') * Math.floor(maxHp / COLOSSUS_HP_STEP);
  return (
    weapon.damage *
    (1 +
      loadout.bonus('damage') +
      accountDamage +
      DAMAGE_PER_UPGRADE * loadout.upgradesOf(weapon.id, UPGRADE.DAMAGE)) *
    colosse
  );
}

/**
 * Le point a `distance` du tireur dans la direction visee.
 *
 * ⚠️ **La visee n'est PAS unitaire** : ce sont les octets quantifies (±127) de
 * `applyInput`, que les projectiles ne lisent que par `atan2`. Multiplier une
 * portee par ces octets la multipliait par ~127 — le faisceau de l'etape 8 a
 * vecu avec un trait de plusieurs dizaines de milliers de pixels. Une seule
 * fonction pour le serveur et le miroir, pour que la regle ne diverge plus.
 * Visee nulle : le tireur lui-meme (`#fireWeapons` l'ecarte de toute facon).
 */
export function aimPoint(
  x: number,
  y: number,
  aimX: number,
  aimY: number,
  distance: number,
): { x: number; y: number } {
  const n = Math.hypot(aimX, aimY);
  if (n === 0) {
    return { x, y };
  }
  return { x: x + (aimX / n) * distance, y: y + (aimY / n) * distance };
}

/**
 * Le critique de CE tireur (etape 10, §3.2) : Precision ajoute a la chance,
 * bornee a 1 — une chance au-dela de 100 % ne veut rien dire, c'est le seul
 * plafond de l'etape ; Ferocite ajoute au multiplicateur, sans plafond.
 *
 * Le client le calcule pour TOUS les joueurs : il tient le miroir de leurs
 * inventaires.
 */
export function critOf(loadout: Loadout): Crit {
  return {
    chance: Math.min(1, CRIT_CHANCE + loadout.bonus('critChance')),
    multiplier: CRIT_MULTIPLIER + loadout.bonus('critDamage'),
  };
}
