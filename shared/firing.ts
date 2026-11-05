import { COLOSSUS_HP_STEP, CRIT_CHANCE, CRIT_MULTIPLIER } from './constants';
import type { Loadout } from './loadout';
import type { Crit } from './projectiles';
import {
  cooldownWithBonus,
  DAMAGE_PER_UPGRADE,
  FIRE_RATE_PER_UPGRADE,
  UPGRADE,
  upgradedWeapon,
  type Weapon,
  weaponOf,
} from './weapons';

/**
 * Ce qu'un tir vaut, calcule UNE fois pour les deux cotes du fil.
 *
 * ⚠️ **`Room#fireOne` et `GameClient#fireOne` appellent ces fonctions, jamais
 * deux copies** : deux exemplaires divergeraient au premier passif ajoute, et
 * le client dessinerait une salve que le serveur ne tire pas.
 *
 * Hors de `weapons.ts` parce que tout ici lit un `Loadout`, et que
 * `loadout.ts` importe deja `weapons.ts`.
 */

/**
 * Les crans d'un aspect pour CE joueur : ceux de l'arme (ses cartes), plus
 * ceux que ses passifs ajoutent a toutes ses armes — Volee (`salvo`) aux
 * seules armes de tir et de frappe, Ampleur (`zone`) a toutes.
 */
export function weaponUpgrades(loadout: Loadout, weapon: Weapon): (upgrade: number) => number {
  // La frappe compte ses eclairs dans `projectileCount` : Volee
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
 * Les degats d'un tir : (passifs de degats + bonus de compte) x cartes
 * « degats » de l'arme, COMPOSEES.
 *
 * `maxHp` est le PV max du tireur (lu par Colosse).
 *
 * ⚠️ **Les cartes « degats » de l'arme se COMPOSENT** (etape 15) :
 * `(1 + DAMAGE_PER_UPGRADE)^n`, pas `1 + n x DAMAGE_PER_UPGRADE`. Additive, la
 * huitieme carte ne valait plus que +7 % relatifs et les chiffres restaient
 * petits ; composee, chaque carte vaut +25 % de ce que l'arme fait DEJA, et
 * huit cartes font x6 au lieu de x3. C'est le levier des gros chiffres de fin
 * de run, face a des monstres dont les PV montent avec le niveau
 * (`monsterHp`). Les passifs (Puissance, Acier) restent additifs entre eux :
 * modele Risk of Rain, une pile, pas une multiplication.
 *
 * ⚠️ **Colosse MULTIPLIE** : +`magnitude` par tranche ENTIERE de
 * `COLOSSUS_HP_STEP` PV max, applique au total des autres bonus. Les achats
 * de vitalite permanente montent aussi le PV max : c'est voulu.
 */
export function shotDamage(
  weapon: Weapon,
  loadout: Loadout,
  accountDamage: number,
  maxHp: number,
): number {
  const colosse = 1 + loadout.bonus('colossus') * Math.floor(maxHp / COLOSSUS_HP_STEP);
  const cartes = (1 + DAMAGE_PER_UPGRADE) ** loadout.upgradesOf(weapon.id, UPGRADE.DAMAGE);
  return weapon.damage * (1 + loadout.bonus('damage') + accountDamage) * cartes * colosse;
}

/**
 * Le point a `distance` du tireur dans la direction visee.
 *
 * ⚠️ **La visee n'est PAS unitaire** : ce sont les octets quantifies (±127) de
 * `applyInput`, que les projectiles ne lisent que par `atan2`. Multiplier une
 * portee par ces octets la multiplierait par ~127. Une seule fonction pour le
 * serveur et le miroir. Visee nulle : le tireur lui-meme (`#fireWeapons`
 * l'ecarte de toute facon).
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
 * Le critique de CE tireur : Precision ajoute a la chance, bornee a 1 ;
 * Ferocite ajoute au multiplicateur, sans plafond.
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

/**
 * La recharge d'une arme pour CE joueur, en ticks : cartes de cadence, bonus
 * de compte, aspects « cadence » de l'arme. L'expression etait ecrite deux
 * fois (`Room#fireOne`, `GameClient#fireOne`) ; le recalage du porteur de
 * relique (etape 16, §8.3) en fait une troisieme lecture.
 */
export function fireCooldown(loadout: Loadout, weaponId: number, accountFireRate: number): number {
  return cooldownWithBonus(
    armedWeapon(loadout, weaponId).cooldownTicks,
    loadout.bonus('fireRate') +
      accountFireRate +
      FIRE_RATE_PER_UPGRADE * loadout.upgradesOf(weaponId, UPGRADE.FIRE_RATE),
  );
}

/**
 * La derniere salve tiree AVANT `nextTick` par une arme muette jusqu'a
 * `from` (le porteur de relique livre ou tombe a `from - 1`), si elle visait
 * sans arret : la premiere salve part a `max(from, last + cooldown)`, les
 * suivantes tous les `cooldown`. Rend `last` si aucune n'est encore partie.
 *
 * C'est le calendrier exact de `Room#fireOne` (tick - last >= cooldown) ; le
 * client s'y recale quand il apprend la fin du port EN RETARD (etape 16,
 * §8.3, ecart n° 6 du plan) — `last = from` seul garderait une phase decalee
 * des que le retard depasse une recharge.
 */
export function lastFireAfterCarry(
  last: number,
  from: number,
  nextTick: number,
  cooldown: number,
): number {
  const first = Math.max(from, last + cooldown);
  if (first >= nextTick) {
    return last;
  }
  return first + Math.floor((nextTick - 1 - first) / cooldown) * cooldown;
}
