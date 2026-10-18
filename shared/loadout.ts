import { PLAYER_MAX_HP, SHIELD_POOL, TRANSCENDANCE_MAX_HP, WEAPON_SLOTS } from './constants';

/**
 * Duplique `CARD.WEAPON` de `cards.ts`.
 *
 * ⚠️ Pas d'import : `cards.ts` importe deja `loadout.ts` (pour le type
 * `Loadout`), et l'importer en retour ferait un cycle. La valeur est gardee par
 * un test d'egalite dans `loadout.test.ts` — une constante recopiee sans garde
 * est exactement ce qui derive en silence.
 */
const CARD_WEAPON = 0;

import { PASSIVES, type PassiveKind, type PassiveRule, passiveOf } from './passives';
import { UPGRADE_KINDS, upgradesFor, WEAPONS, weaponOf } from './weapons';

/**
 * Ce qu'un joueur possede : ses armes et ses passifs, chacun avec son nombre
 * d'exemplaires.
 *
 * ⚠️ **Les deux natures se comportent PAREIL, et c'est le modele du draft** :
 * tout s'empile, rien ne monte de niveau (modele Risk of Rain). Une arme
 * reprise ameliore UN aspect — celui que porte la carte (`UPGRADE`) ; un
 * passif pris deux fois ajoute deux fois sa `magnitude`.
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

  /**
   * Nombre de passifs DISTINCTS possedes.
   *
   * ⚠️ **Pas une consommation d'emplacements** : les passifs n'ont pas de
   * limite, seules les armes en ont une. Le HUD s'en sert pour savoir combien
   * de cadres peindre.
   */
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
   * Empile un passif. Aucune limite : seul un identifiant inconnu fait lever.
   */
  addPassive(passiveId: number): void {
    const stacks = this.stacksOf(passiveId);
    passiveOf(passiveId); // leve si l'identifiant n'existe pas
    this.#passiveStacks[passiveId] = stacks + 1;
  }

  /**
   * Ce joueur peut-il prendre cette carte ?
   *
   * ⚠️ L'eligibilite ne se transporte pas sur la carte (pas d'`owner`) : elle
   * se DERIVE de l'inventaire de chacun, donc la meme carte
   * peut etre prenable par l'un et pas par l'autre sans que l'etalage ait a le
   * savoir. Une seule regle : on ne peut pas ouvrir un slot qu'on n'a plus.
   * Empiler ce qu'on possede deja reste toujours possible — c'est le modele.
   */
  canTake(nature: number, refId: number): boolean {
    if (nature === CARD_WEAPON) {
      return this.stacksOfWeapon(refId) > 0 || this.#weaponOrder.length < WEAPON_SLOTS;
    }
    // Un passif n'est jamais refuse. Le parametre reste pour que la signature
    // serve les deux natures.
    return true;
  }

  /** Ce joueur porte-t-il au moins un exemplaire d'une carte a cette regle ? */
  hasRule(rule: PassiveRule): boolean {
    for (let id = 0; id < this.#passiveStacks.length; id++) {
      if ((this.#passiveStacks[id] ?? 0) > 0 && PASSIVES[id]?.rule === rule) {
        return true;
      }
    }
    return false;
  }

  /** Somme des `magnitude` possedees de ce genre, MOINS les malus du meme genre. */
  bonus(kind: PassiveKind): number {
    let total = 0;
    for (let id = 0; id < this.#passiveStacks.length; id++) {
      const stacks = this.#passiveStacks[id] ?? 0;
      if (stacks === 0) {
        continue;
      }
      const p = PASSIVES[id];
      if (!p) {
        continue;
      }
      if (p.kind === kind) {
        total += p.magnitude * stacks;
      }
      if (p.malus?.kind === kind) {
        total -= p.malus.magnitude * stacks;
      }
    }
    return total;
  }
}

/**
 * Les PV max d'un joueur : la base, les cartes, les achats — **et la seule
 * ecriture de cette somme dans le depot**.
 *
 * ⚠️ **Lue par `Room#grantCard`, `GameClient#localMaxHp` et
 * `GameClient#fireOne`** (le `maxHp` qu'echelonne Colosse) : des copies
 * divergeraient a la premiere regle qui touche au plafond.
 */
export function maxHpOf(loadout: Loadout, accountMaxHp: number): number {
  // ⚠️ **La regle passe EN DERNIER**, apres les cartes et les achats : c'est
  // exactement ce qui la rend insensible a Vitalite et aux achats du compte.
  // Consequence assumee : Vitalite et Regain deviennent inertes chez un
  // porteur de Transcendance.
  if (loadout.hasRule('transcendance')) {
    return TRANSCENDANCE_MAX_HP;
  }
  return PLAYER_MAX_HP + loadout.bonus('maxHp') + accountMaxHp;
}

/**
 * La reserve de bouclier ouverte par les regles possedees : `SHIELD_POOL`
 * chez un porteur de Transcendance, `0` sinon.
 *
 * ⚠️ **Tout debordement de cette reserve tue** : derriere elle, il ne reste
 * que `TRANSCENDANCE_MAX_HP` (1) point de vie (voir `hurtPlayer`,
 * `back/src/combat.ts`).
 */
export function maxShieldOf(loadout: Loadout): number {
  return loadout.hasRule('transcendance') ? SHIELD_POOL : 0;
}
