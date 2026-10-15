import { COLOSSUS_HP_STEP } from './constants';
import type { Loadout } from './loadout';
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
 * seules armes de tir, Ampleur (`zone`) a toutes (§3.1).
 */
export function weaponUpgrades(loadout: Loadout, weapon: Weapon): (upgrade: number) => number {
  const volee = weapon.kind === 'tir' ? loadout.bonus('salvo') : 0;
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
