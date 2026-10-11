import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { TOKEN_BYTES } from '@shared/protocol';
import { type BonusKind, priceOf, shopItemOf } from '@shared/shop';

/**
 * ⚠️ **Un seul client pour tout le processus.** Chaque `new PrismaClient()`
 * ouvre son propre pool de connexions ; en ouvrir un par salon epuiserait les
 * connexions de la base bien avant d'epuiser la memoire.
 */
export const prisma = new PrismaClient();

/** 32 octets de hasard cryptographique. */
export function newToken(): Uint8Array {
  return new Uint8Array(randomBytes(TOKEN_BYTES));
}

/**
 * Le sha256 du jeton, en hexadecimal.
 *
 * ⚠️ **C'est la SEULE forme du jeton qui touche la base.** Un jeton en clair
 * stocke ferait d'un dump de table une liste de comptes utilisables.
 */
export function hashToken(token: Uint8Array): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Le jeton tel qu'il voyage en HTTP et vit dans `localStorage` : base64url. */
export function tokenToText(token: Uint8Array): string {
  return Buffer.from(token).toString('base64url');
}

/**
 * L'inverse, qui **leve** plutot que de rendre un jeton tronque.
 *
 * Sans cette garde, un en-tete `Authorization` mal forme produirait un jeton
 * court, donc un hache valide, donc un « compte inconnu » — un 401 correct
 * pour une mauvaise raison, et indebuggable.
 */
export function textToToken(text: string): Uint8Array {
  const buf = Buffer.from(text, 'base64url');
  if (buf.length !== TOKEN_BYTES) {
    throw new Error(`jeton de ${buf.length} octets, ${TOKEN_BYTES} attendus`);
  }
  return new Uint8Array(buf);
}

/** Frappe un compte et rend son jeton — la SEULE fois ou il est lisible. */
export async function createAccount(): Promise<{ id: string; token: Uint8Array }> {
  const token = newToken();
  const row = await prisma.account.create({
    data: { tokenHash: hashToken(token) },
    select: { id: true },
  });
  return { id: row.id, token };
}

export async function findAccountIdByToken(token: Uint8Array): Promise<string | null> {
  const row = await prisma.account.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true },
  });
  return row?.id ?? null;
}

export async function goldOf(accountId: string): Promise<bigint> {
  const row = await prisma.account.findUnique({
    where: { id: accountId },
    select: { gold: true },
  });
  return row?.gold ?? 0n;
}

/**
 * Ajoute `amount` au solde de CHACUN des comptes donnes.
 *
 * ⚠️ **Un `increment`, jamais un lire-modifier-ecrire.** Le meme jeton peut
 * etre ouvert dans deux onglets, donc dans deux salons : deux runs peuvent
 * finir au meme instant sur le meme compte. Un increment est juste sous
 * concurrence ; relire puis ecrire perdrait silencieusement l'un des deux.
 */
export async function creditAccounts(accountIds: readonly string[], amount: bigint): Promise<void> {
  if (accountIds.length === 0 || amount === 0n) {
    return;
  }
  await prisma.account.updateMany({
    where: { id: { in: [...accountIds] } },
    data: { gold: { increment: amount } },
  });
}

/** Les achats d'un compte : itemId -> palier atteint. */
export async function purchasesOf(accountId: string): Promise<Map<string, number>> {
  const lignes = await prisma.purchase.findMany({
    where: { accountId },
    select: { itemId: true, level: true },
  });
  return new Map(lignes.map((l) => [l.itemId, l.level]));
}

/**
 * Achete le palier suivant d'un article du catalogue.
 *
 * ⚠️ **Le prix est relu DANS LE CATALOGUE, jamais recu de l'appelant.** C'est
 * l'autorite serveur du §11 : un client ne peut pas plus fabriquer un achat
 * qu'il ne pouvait fabriquer de l'or.
 *
 * ⚠️ **Tout se passe dans UNE transaction**, et c'est ce qui garantit qu'un
 * REFUS ne laisse jamais de debit partiel : la lecture du solde, le debit et
 * l'ecriture de la ligne sont atomiques, donc un `solde-insuffisant` ou un
 * `palier-max` renvoie la transaction entiere sans rien ecrire. Mais la
 * transaction seule ne protege pas contre un DOUBLE achat concurrent — ca,
 * c'est le travail de deux mecanismes distincts, un par branche d'ecriture :
 *
 * - **Premier achat d'un article (branche `create`)** : la cle composite
 *   `[accountId, itemId]` du modele `Purchase` l'interdit STRUCTURELLEMENT.
 *   Deux transactions qui lisent toutes deux `deja === null` avant qu'aucune
 *   n'ait commite peuvent toutes les deux tenter l'`INSERT` ; Postgres n'en
 *   laisse passer qu'une, la seconde leve une violation de cle.
 * - **Palier suivant d'un article deja possede (branche `update`)** : la cle
 *   composite ne protege RIEN ici, puisque la ligne existe deja des les deux
 *   cotes et qu'un `UPDATE` ne viole aucune contrainte d'unicite. C'est donc
 *   un VERROU OPTIMISTE qui protege cette branche : le `where` du `update`
 *   filtre aussi sur le `level` LU plus haut (`deja.level`). Si un achat
 *   concurrent a deja fait avancer ce palier entre notre lecture et notre
 *   ecriture, aucune ligne ne correspond plus a ce `where` et Prisma leve
 *   (`P2025`, « no record found for an update ») au lieu d'ecrire en silence
 *   un `level` perime. **Mesure (Ronde de correction 1/5) : sans ce verrou,
 *   deux achats concurrents du palier suivant passaient TOUS LES DEUX,
 *   debitant deux fois le prix pour ne gagner qu'un seul niveau** — reproduit
 *   de facon fiable par le test de ce fichier avant le correctif, jamais
 *   apres.
 *
 * ⚠️ **Le `catch` rend `'conflit'`, jamais `'solde-insuffisant'`.** La cause
 * reelle d'un echec ici est un CONFLIT (de cle ou de verrou optimiste), pour
 * la branche qui ATTEINT ce `catch` precisement — jamais un solde insuffisant,
 * qui est deja rendu plus haut par la branche qui compare le solde au prix. Un
 * `catch` nu attrape aussi une panne de base, pour laquelle « rafraichir et
 * retenter » est de toute facon le bon conseil. La route HTTP (etape 7b tache
 * 5) distingue les deux : un `'conflit'` rend 409, pas 402, parce que l'action
 * correcte du client n'est pas la meme — « gagne plus d'or » contre
 * « rafraichis et retente ».
 *
 * **La perdante d'une course n'atteint pas TOUJOURS ce `catch`.** Mesure :
 * quand la transaction gagnante commite avant que la perdante ne relise
 * `deja`/le solde, la perdante voit l'etat deja a jour et rend un verdict
 * tout aussi legitime par la voie normale — `'palier-max'` (branche `create`,
 * ~1 fois sur 6 mesure localement) ou `'solde-insuffisant'` (branche
 * `update`, observe de facon systematique dans ce depot). Seule la fenetre de
 * VRAI recouvrement (les deux lectures avant que l'une n'ait commite) produit
 * `'conflit'`. C'est pourquoi les deux tests de concurrence (Review Focus
 * n°1, branches `create` et `update`) n'assenent que « le verdict de la
 * perdante n'est pas `'ok'` » — assener qu'il est exactement `'conflit'`
 * serait faux, mesure a l'appui : reproduit a volonte en relancant ce fichier.
 */
export async function buyItem(
  accountId: string,
  itemId: string,
): Promise<'ok' | 'solde-insuffisant' | 'article-inconnu' | 'palier-max' | 'conflit'> {
  const item = shopItemOf(itemId);
  if (!item) {
    return 'article-inconnu';
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const deja = await tx.purchase.findUnique({
        where: { accountId_itemId: { accountId, itemId } },
        select: { level: true },
      });
      const palier = (deja?.level ?? 0) + 1;
      if (palier > item.levels) {
        return 'palier-max' as const;
      }

      const prix = BigInt(priceOf(item, palier));
      const compte = await tx.account.findUnique({
        where: { id: accountId },
        select: { gold: true },
      });
      if ((compte?.gold ?? 0n) < prix) {
        return 'solde-insuffisant' as const;
      }

      await tx.account.update({ where: { id: accountId }, data: { gold: { decrement: prix } } });
      if (deja) {
        // Verrou optimiste : le `where` filtre aussi sur le `level` LU plus
        // haut. Si un achat concurrent a deja fait avancer ce palier entre
        // notre lecture et notre ecriture, aucune ligne ne correspond plus et
        // Prisma leve ; voir la mesure dans le docbloc de buyItem.
        await tx.purchase.update({
          where: { accountId_itemId: { accountId, itemId }, level: deja.level },
          data: { level: palier },
        });
      } else {
        await tx.purchase.create({ data: { accountId, itemId, level: palier } });
      }
      return 'ok' as const;
    });
  } catch {
    // Conflit mesure : soit la cle composite a refuse un doublon cree par un
    // `create` concurrent, soit le verrou optimiste ci-dessus (Prisma P2025,
    // "no record found for an update") a vu le `level` bouger entre notre
    // lecture et notre ecriture. Dans les deux cas la transaction entiere est
    // annulee, rien n'a ete debite. Voir le docbloc de buyItem pour la mesure
    // qui justifie ce verdict precis.
    return 'conflit';
  }
}

/** Les bonus permanents d'un compte, par cle, sommes sur ses paliers. */
export function bonusesOf(purchases: ReadonlyMap<string, number>): Record<BonusKind, number> {
  const out: Record<BonusKind, number> = {
    fireRate: 0,
    damage: 0,
    maxHp: 0,
    speed: 0,
    regen: 0,
    pickupRadius: 0,
  };
  for (const [itemId, level] of purchases) {
    const item = shopItemOf(itemId);
    if (item?.kind === 'bonus' && item.bonusKind) {
      out[item.bonusKind] += (item.perLevel ?? 0) * level;
    }
  }
  return out;
}

/** Les identifiants d'armes que ces achats debloquent. */
export function unlockedWeaponsOf(purchases: ReadonlyMap<string, number>): Set<number> {
  const out = new Set<number>();
  for (const itemId of purchases.keys()) {
    const item = shopItemOf(itemId);
    if (item?.kind === 'weapon' && item.weaponId !== undefined) {
      out.add(item.weaponId);
    }
  }
  return out;
}
