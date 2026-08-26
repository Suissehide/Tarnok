import { PASSIVE_SLOTS, WEAPON_MAX_LEVEL, WEAPON_SLOTS } from './constants';
import { PASSIVES, type PassiveKind, passiveOf } from './passives';
import { WEAPONS } from './weapons';

/**
 * Ce qu'un joueur possede : ses armes avec leur niveau, ses passifs avec leur
 * nombre d'exemplaires.
 *
 * Les deux natures ne se comportent pas pareil, et c'est la distinction
 * structurante du draft (§3.3 de la spec de l'etape 4) :
 *
 * - une **arme** monte en niveau, bornee par `WEAPON_MAX_LEVEL`, puis evolue.
 *   Elle est **exclusive a l'echelle de l'equipe** (§6.2 de l'orientation) —
 *   mais `Loadout` ne connait qu'un joueur, donc c'est `drawSpread` qui fait
 *   respecter l'exclusivite entre joueurs ; ici on ne refuse qu'un doublon
 *   chez le meme porteur.
 * - un **passif s'empile** : chaque carte prise ajoute sa `magnitude`, sans
 *   borne. Modele Risk of Rain.
 *
 * ⚠️ **Un passif deja possede ne consomme pas un second slot.** Seul un passif
 * NOUVEAU en prend un. Compter un slot par carte remplirait l'inventaire en
 * trois cartes, la ou le design attend qu'on empile le meme passif des
 * dizaines de fois sur une run — et l'etalage ne cesserait jamais de proposer
 * des passifs, puisqu'il n'en exclut aucun.
 *
 * Tableaux types indexes par identifiant, jamais un objet par entree : le
 * catalogue est petit et fixe.
 */
export class Loadout {
  /** `#weaponLevel[id]` : niveau de l'arme, `0` si non possedee. */
  readonly #weaponLevel = new Uint8Array(WEAPONS.length);
  /** `#passiveStacks[id]` : nombre de cartes prises, `0` si aucune. */
  readonly #passiveStacks = new Uint16Array(PASSIVES.length);
  /** Ordre d'acquisition — l'ordre des slots, pas l'ordre des identifiants. */
  readonly #weaponOrder: number[] = [];

  /** Les armes possedees, dans l'ordre ou elles ont ete draftees. */
  get weaponIds(): readonly number[] {
    return this.#weaponOrder;
  }

  /** Niveau d'une arme, ou `0` si le joueur ne la possede pas. */
  levelOf(weaponId: number): number {
    return this.#weaponLevel[weaponId] ?? 0;
  }

  /** Nombre de cartes prises pour ce passif, ou `0`. */
  stacksOf(passiveId: number): number {
    return this.#passiveStacks[passiveId] ?? 0;
  }

  get weaponSlotsUsed(): number {
    return this.#weaponOrder.length;
  }

  /** Nombre de passifs DISTINCTS possedes — jamais le nombre de cartes prises. */
  get passiveSlotsUsed(): number {
    let n = 0;
    for (let id = 0; id < this.#passiveStacks.length; id++) {
      if ((this.#passiveStacks[id] ?? 0) > 0) {
        n++;
      }
    }
    return n;
  }

  addWeapon(weaponId: number): void {
    if (this.levelOf(weaponId) > 0) {
      throw new Error(`arme deja possedee : ${weaponId}`);
    }
    if (this.#weaponOrder.length >= WEAPON_SLOTS) {
      throw new Error(`slots d'armes pleins (${WEAPON_SLOTS})`);
    }
    this.#weaponLevel[weaponId] = 1;
    this.#weaponOrder.push(weaponId);
  }

  levelUpWeapon(weaponId: number): void {
    const level = this.levelOf(weaponId);
    if (level === 0) {
      throw new Error(`arme non possedee : ${weaponId}`);
    }
    if (level >= WEAPON_MAX_LEVEL) {
      throw new Error(`arme deja au niveau maximum : ${weaponId}`);
    }
    this.#weaponLevel[weaponId] = level + 1;
  }

  /**
   * Empile un passif. Ne consomme un slot que si le joueur ne le possedait
   * PAS encore — voir la doc de la classe.
   */
  addPassive(passiveId: number): void {
    const stacks = this.stacksOf(passiveId);
    if (stacks === 0 && this.passiveSlotsUsed >= PASSIVE_SLOTS) {
      throw new Error(`slots de passifs pleins (${PASSIVE_SLOTS})`);
    }
    passiveOf(passiveId); // leve si l'identifiant n'existe pas
    this.#passiveStacks[passiveId] = stacks + 1;
  }

  /** Somme des `magnitude` de tous les exemplaires possedes de ce genre. */
  bonus(kind: PassiveKind): number {
    let total = 0;
    for (let id = 0; id < this.#passiveStacks.length; id++) {
      const stacks = this.#passiveStacks[id] ?? 0;
      if (stacks === 0) {
        continue;
      }
      const p = PASSIVES[id];
      if (p && p.kind === kind) {
        total += p.magnitude * stacks;
      }
    }
    return total;
  }
}
