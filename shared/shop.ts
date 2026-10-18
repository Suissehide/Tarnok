import type { PassiveKind } from './passives';

/**
 * Les cles de bonus que la boutique peut vendre.
 *
 * ⚠️ **Les quatre dernieres ne sont PAS des `PassiveKind`, et c'est voulu.**
 * Les cinq cles de passif sont sommees par `Room` aux memes endroits que les
 * cartes ; chacune des autres a son site unique : `pickupRadius` dans
 * `Room#pickupRadius`, `armor` dans `combat.ts` (contact et charge), `xp` dans
 * `Room#gainXp` (moyenne d'equipe), `gold` au versement (`Session`).
 *
 * ⚠️ **Les autres genres de passif n'en font PAS partie** : la boutique ne
 * les vend pas, et les y laisser entrer ajouterait des cles a zero a
 * `BONUS_ZERO` et a chaque compte.
 */
export type BonusKind =
  | Extract<PassiveKind, 'fireRate' | 'damage' | 'maxHp' | 'speed' | 'regen'>
  | 'pickupRadius'
  | 'armor'
  | 'xp'
  | 'gold';

/**
 * Un article de la boutique.
 *
 * ⚠️ **Le catalogue vit dans `shared/` pour que le front affiche les libelles
 * et les prix sans seconde source de verite — mais AUCUN prix n'est lu depuis
 * le client.** Acheter est un `POST` ; le serveur relit le prix ici, verifie le
 * solde et debite dans une seule transaction.
 */
export interface ShopItem {
  id: string;
  label: string;
  /** Prix du PREMIER palier. Voir `priceOf` pour les suivants. */
  price: number;
  /** Nombre de paliers achetables. */
  levels: number;
  bonusKind: BonusKind;
  /** Bonus apporte par CHAQUE palier. */
  perLevel: number;
}

/**
 * ⚠️ **Les prix sont un REGLAGE DE JEU, pas un invariant.**
 *
 * L'ancre : une extraction au palier `k` verse
 * `GOLD_PER_PALIER_BASE * hpScale(k)` (soit 100 au palier 0) plus les pieces
 * ramassees, donc le premier article coute environ une extraction reussie a un
 * palier precoce. **A regler au playtest** ; aucun test n'ecrit un prix en dur.
 */
export const SHOP_ITEMS: readonly ShopItem[] = Object.freeze([
  // Inspire du catalogue de *Swarm* (LoL). Ecartes, parce que le client DERIVE
  // les salves de tous les joueurs sans connaitre leurs achats : zone, duree,
  // projectiles et critique.
  bonus('puissance', 'Puissance', 'damage', 0.1, 8, 150),
  bonus('armure', 'Armure', 'armor', 0.04, 5, 150),
  bonus('vitalite', 'Vitalité', 'maxHp', 10, 5, 150),
  // 0,2 PV/s par palier, comme la carte.
  bonus('regain', 'Régénération', 'regen', 0.2, 5, 150),
  bonus('celerite', 'Célérité', 'speed', 13, 4, 150),
  bonus('aimant', 'Aimant', 'pickupRadius', 22, 3, 200),
  bonus('cadence', 'Hâte', 'fireRate', 0.05, 5, 200),
  bonus('savoir', 'Savoir', 'xp', 0.05, 5, 200),
  bonus('fortune', 'Fortune', 'gold', 0.15, 3, 300),
]);

function bonus(
  id: string,
  label: string,
  bonusKind: BonusKind,
  perLevel: number,
  levels: number,
  price: number,
): ShopItem {
  return { id, label, price, levels, bonusKind, perLevel };
}

/**
 * Bonus permanents d'un compte sans aucun achat.
 *
 * ⚠️ **Partage, pas duplique.** `Room.join` s'en sert comme valeur par defaut
 * d'un joueur sans compte resolu ; `GameClient` comme valeur par defaut de son
 * miroir de prediction. Deux copies divergeraient a la premiere cle ajoutee a
 * `BonusKind`, et la divergence serait exactement celle que ce module existe
 * pour empecher.
 */
export const BONUS_ZERO: Readonly<Record<BonusKind, number>> = Object.freeze({
  fireRate: 0,
  damage: 0,
  maxHp: 0,
  speed: 0,
  regen: 0,
  pickupRadius: 0,
  armor: 0,
  xp: 0,
  gold: 0,
});

/**
 * Les bonus permanents d'un compte, par cle, sommes sur ses paliers.
 *
 * ⚠️ **Vit dans `shared/` pour que le miroir de prediction du client ajoute
 * les memes bonus de compte que `Room`** : sans eux, sa cadence, sa vitesse et
 * ses degats divergent (l'arrondi de `cooldownWithBonus` amplifie l'ecart sur
 * une recharge courte). Elle n'a besoin que du catalogue : ni Prisma, ni
 * serveur.
 */
export function bonusesOf(purchases: ReadonlyMap<string, number>): Record<BonusKind, number> {
  const out: Record<BonusKind, number> = { ...BONUS_ZERO };
  for (const [itemId, level] of purchases) {
    const item = shopItemOf(itemId);
    if (item) {
      out[item.bonusKind] += item.perLevel * level;
    }
  }
  return out;
}

export function shopItemOf(id: string): ShopItem | undefined {
  return SHOP_ITEMS.find((i) => i.id === id);
}

/** Prix du palier `level` (1 = le premier). Croit lineairement avec le palier. */
export function priceOf(item: ShopItem, level: number): number {
  return item.price * level;
}

/**
 * Bonus total qu'un compte peut atteindre sur cette cle en achetant tous les
 * paliers de tous les articles qui la portent.
 *
 * ⚠️ **Derive du catalogue, jamais ecrit a cote.** C'est ce qui permet a un
 * test d'assener que le rayon tient dans un octet : ajouter un
 * article trop genereux fera rougir ce test au lieu de replier le `u8`.
 */
export function maxBonus(kind: BonusKind): number {
  let total = 0;
  for (const i of SHOP_ITEMS) {
    if (i.bonusKind === kind) {
      total += i.perLevel * i.levels;
    }
  }
  return total;
}
