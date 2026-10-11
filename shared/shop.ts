import type { PassiveKind } from './passives';

/**
 * Les cles de bonus que la boutique peut vendre.
 *
 * ⚠️ **`pickupRadius` n'est PAS une `PassiveKind`, et c'est voulu.** Les cinq
 * cles de passif sont deja sommees par `Room` a cinq endroits ; celle-ci n'a
 * aucun site existant et en demande un neuf (tache 7). La distinguer dans le
 * type rappelle qu'elle ne suit pas le meme chemin.
 */
export type BonusKind = PassiveKind | 'pickupRadius';

/**
 * Un article de la boutique.
 *
 * ⚠️ **Le catalogue vit dans `shared/` pour que le front affiche les libelles
 * et les prix sans seconde source de verite — mais AUCUN prix n'est lu depuis
 * le client.** Acheter est un `POST` ; le serveur relit le prix ici, verifie le
 * solde et debite dans une seule transaction. C'est l'autorite serveur du §11
 * de l'orientation, appliquee au meme endroit que pour l'or.
 */
export interface ShopItem {
  id: string;
  label: string;
  kind: 'weapon' | 'bonus';
  /** Prix du PREMIER palier. Voir `priceOf` pour les suivants. */
  price: number;
  /** Nombre de paliers achetables. `1` pour un deblocage d'arme, qui est binaire. */
  levels: number;
  /** Renseigne si et seulement si `kind === 'weapon'`. */
  weaponId?: number;
  /** Renseignes si et seulement si `kind === 'bonus'`. */
  bonusKind?: BonusKind;
  perLevel?: number;
}

/**
 * ⚠️ **Les prix sont un REGLAGE DE JEU, pas un invariant.**
 *
 * L'ancre, faute de donnees : l'etape 7a n'a livre AUCUN historique de runs,
 * donc il n'existe aucune mesure de ce qu'une run rapporte. Une extraction au
 * palier `k` verse `GOLD_PER_PALIER_BASE * hpScale(k)` (soit 100 au palier 0)
 * plus les pieces ramassees. Le premier article coute donc environ une
 * extraction reussie a un palier precoce. **A regler au playtest** ; aucun
 * test de ce depot n'ecrit un prix en dur.
 */
export const SHOP_ITEMS: readonly ShopItem[] = Object.freeze([
  { id: 'arme-braise', label: 'Grenade', kind: 'weapon', price: 300, levels: 1, weaponId: 4 },
  {
    id: 'arme-givre',
    label: 'Sceptre arcanique',
    kind: 'weapon',
    price: 300,
    levels: 1,
    weaponId: 8,
  },
  { id: 'arme-foudre', label: 'Canon a arc', kind: 'weapon', price: 300, levels: 1, weaponId: 10 },
  {
    id: 'arme-poix',
    label: 'Chaudron a poix',
    kind: 'weapon',
    price: 300,
    levels: 1,
    weaponId: 12,
  },
  { id: 'arme-chaux', label: 'Canon a chaux', kind: 'weapon', price: 300, levels: 1, weaponId: 14 },
  {
    id: 'arme-vif-argent',
    label: 'Glaive de mercure',
    kind: 'weapon',
    price: 300,
    levels: 1,
    weaponId: 16,
  },

  {
    id: 'vitalite',
    label: 'Vitalite',
    kind: 'bonus',
    price: 150,
    levels: 5,
    bonusKind: 'maxHp',
    perLevel: 10,
  },
  {
    id: 'celerite',
    label: 'Celerite',
    kind: 'bonus',
    price: 150,
    levels: 5,
    bonusKind: 'speed',
    perLevel: 6,
  },
  {
    id: 'cadence',
    label: 'Cadence',
    kind: 'bonus',
    price: 200,
    levels: 3,
    bonusKind: 'fireRate',
    perLevel: 0.05,
  },
  {
    id: 'puissance',
    label: 'Puissance',
    kind: 'bonus',
    price: 200,
    levels: 3,
    bonusKind: 'damage',
    perLevel: 0.05,
  },
  {
    id: 'aimant',
    label: 'Aimant',
    kind: 'bonus',
    price: 250,
    levels: 4,
    bonusKind: 'pickupRadius',
    perLevel: 20,
  },
]);

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
});

/**
 * Les bonus permanents d'un compte, par cle, sommes sur ses paliers.
 *
 * ⚠️ **Vit dans `shared/`, et c'est la revue finale de l'etape 7b qui l'y a
 * descendue.** Elle vivait dans `back/src/accounts.ts`, donc hors de portee du
 * front : le miroir de prediction du client derivait sa cadence, sa vitesse et
 * ses degats du seul inventaire de draft, sans les bonus de compte que `Room`
 * ajoute a cinq endroits. Mesure du defaut : avec Cadence au maximum, l'arme
 * neutre affichait 225 salves sur 30 s la ou le serveur en tirait 300 — 25% de
 * perte, parce que l'arrondi de `cooldownWithBonus` amplifie le bonus sur une
 * recharge de 4 ticks. Les deux cotes la lisent desormais de la MEME source.
 *
 * Elle n'a besoin que du catalogue (`shopItemOf`) : aucune dependance a Prisma
 * ni au serveur n'est descendue avec elle.
 */
export function bonusesOf(purchases: ReadonlyMap<string, number>): Record<BonusKind, number> {
  const out: Record<BonusKind, number> = { ...BONUS_ZERO };
  for (const [itemId, level] of purchases) {
    const item = shopItemOf(itemId);
    if (item?.kind === 'bonus' && item.bonusKind) {
      out[item.bonusKind] += (item.perLevel ?? 0) * level;
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
 * ⚠️ **Derive du catalogue, jamais ecrit a cote.** C'est ce qui permet au test
 * du §5 de la spec d'assener que le rayon tient dans un octet : ajouter un
 * article trop genereux fera rougir ce test au lieu de replier le `u8`.
 */
export function maxBonus(kind: BonusKind): number {
  let total = 0;
  for (const i of SHOP_ITEMS) {
    if (i.kind === 'bonus' && i.bonusKind === kind) {
      total += (i.perLevel ?? 0) * i.levels;
    }
  }
  return total;
}
