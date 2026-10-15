import { PASSIVE_SLOTS, WEAPON_SLOTS } from './constants';

/**
 * Duplique `CARD.WEAPON` de `cards.ts`.
 *
 * ⚠️ Pas d'import : `cards.ts` importe deja `loadout.ts` (pour le type
 * `Loadout`), et l'importer en retour ferait un cycle. La valeur est gardee par
 * un test d'egalite dans `loadout.test.ts` — une constante recopiee sans garde
 * est exactement ce qui derive en silence.
 */
const CARD_WEAPON = 0;

import { PASSIVES, type PassiveKind, passiveOf } from './passives';
import { UPGRADE_KINDS, upgradesFor, WEAPONS, weaponOf } from './weapons';

/**
 * Ce qu'un joueur possede : ses armes et ses passifs, chacun avec son nombre
 * d'exemplaires.
 *
 * ⚠️ **Les deux natures se comportent PAREIL, et c'est le modele du draft** :
 * tout s'empile, rien ne monte de niveau. *« C'est l'accumulation des cartes
 * qui fait la puissance. »* Une arme reprise ameliore UN aspect — celui que
 * porte la carte (`UPGRADE`) ; un passif pris deux fois ajoute deux fois sa `magnitude`. Modele
 * Risk of Rain, applique aux deux.
 *
 * Les niveaux d'arme et les evolutions ont existe un temps dans cette etape,
 * puis ont ete retires — voir le §9 de la spec.
 *
 * ⚠️ **Une carte deja possedee ne consomme pas un second slot.** Seule une
 * carte NOUVELLE en prend un. Compter un slot par carte remplirait l'inventaire
 * en trois cartes, la ou le design attend qu'on empile le meme objet des
 * dizaines de fois sur une run — et l'etalage n'exclut jamais rien.
 *
 * ⚠️ **Aucune exclusivite d'equipe.** Si un allie a deja pris le lance-flammes,
 * je peux le prendre aussi : c'est mon propre exemplaire, pas le sien. Le
 * conflit ne porte que sur la carte de CET etalage-ci.
 *
 * Tableaux types indexes par identifiant, jamais un objet par entree : le
 * catalogue est petit et fixe.
 */
export class Loadout {
  /** `#weaponStacks[id]` : nombre de cartes prises pour cette arme, `0` si aucune. */
  readonly #weaponStacks = new Uint16Array(WEAPONS.length);
  /** `#passiveStacks[id]` : nombre de cartes prises, `0` si aucune. */
  readonly #passiveStacks = new Uint16Array(PASSIVES.length);
  /** Ordre d'acquisition — l'ordre des slots, pas l'ordre des identifiants. */
  readonly #weaponOrder: number[] = [];
  /** `#upgrades[id * UPGRADE_KINDS + aspect]` : cartes prises sur cet aspect, la premiere (l'acquisition) exclue. */
  readonly #upgrades = new Uint16Array(WEAPONS.length * UPGRADE_KINDS);

  /** Cartes prises sur cet aspect de cette arme (voir `UPGRADE`), l'acquisition exclue. */
  upgradesOf(weaponId: number, upgrade: number): number {
    return this.#upgrades[weaponId * UPGRADE_KINDS + upgrade] ?? 0;
  }

  /** Les armes possedees, dans l'ordre ou elles ont ete draftees. */
  get weaponIds(): readonly number[] {
    return this.#weaponOrder;
  }

  /** Nombre de cartes prises pour cette arme, ou `0` si elle n'est pas possedee. */
  stacksOfWeapon(weaponId: number): number {
    return this.#weaponStacks[weaponId] ?? 0;
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
    for (const stacks of this.#passiveStacks) {
      if (stacks > 0) {
        n++;
      }
    }
    return n;
  }

  /**
   * Empile une arme. Ne consomme un slot que si le joueur ne la possedait PAS
   * encore — exactement comme `addPassive`, et pour la meme raison.
   *
   * La premiere carte donne l'arme ; chacune des suivantes n'ameliore que son
   * `upgrade` (voir `UPGRADE`), qui doit etre l'un des `upgradesFor` de l'arme.
   */
  addWeapon(weaponId: number, upgrade?: number): void {
    const stacks = this.stacksOfWeapon(weaponId);
    if (stacks === 0 && this.#weaponOrder.length >= WEAPON_SLOTS) {
      throw new Error(`slots d'armes pleins (${WEAPON_SLOTS})`);
    }
    const weapon = weaponOf(weaponId); // leve si l'identifiant n'existe pas
    // Sans aspect : le premier bonus propre de l'arme.
    upgrade ??= weapon.perks[0] ?? upgradesFor(weapon)[0] ?? 0;
    if (!upgradesFor(weapon).includes(upgrade)) {
      throw new Error(`amelioration inconnue pour ${weapon.name} : ${upgrade}`);
    }
    this.#weaponStacks[weaponId] = stacks + 1;
    if (stacks === 0) {
      this.#weaponOrder.push(weaponId);
    } else {
      this.#upgrades[weaponId * UPGRADE_KINDS + upgrade] = this.upgradesOf(weaponId, upgrade) + 1;
    }
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

  /**
   * Ce joueur peut-il prendre cette carte ?
   *
   * ⚠️ **C'est ce qui remplace `owner`.** L'eligibilite ne se transporte plus
   * sur la carte : elle se DERIVE de l'inventaire de chacun, donc la meme carte
   * peut etre prenable par l'un et pas par l'autre sans que l'etalage ait a le
   * savoir. Une seule regle : on ne peut pas ouvrir un slot qu'on n'a plus.
   * Empiler ce qu'on possede deja reste toujours possible — c'est le modele.
   */
  canTake(nature: number, refId: number): boolean {
    if (nature === CARD_WEAPON) {
      return this.stacksOfWeapon(refId) > 0 || this.#weaponOrder.length < WEAPON_SLOTS;
    }
    return this.stacksOf(refId) > 0 || this.passiveSlotsUsed < PASSIVE_SLOTS;
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
