import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { TOKEN_BYTES } from '@shared/protocol';
import { priceOf, shopItemOf } from '@shared/shop';

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
 * ⚠️ **Le prix est relu DANS LE CATALOGUE, jamais recu de l'appelant** :
 * autorite serveur, un client ne peut pas fabriquer un achat.
 *
 * ⚠️ **Tout se passe dans UNE transaction** : un refus (`solde-insuffisant`,
 * `palier-max`) ne laisse jamais de debit partiel. Mais la transaction seule
 * ne protege pas d'un DOUBLE achat concurrent ; trois gardes s'en chargent :
 *
 * - **Le SOLDE (toutes branches)** : le `where` du debit filtre aussi sur
 *   `gold: { gte: prix }`. La comparaison lue plus haut ne garde rien seule :
 *   deux achats d'articles DIFFERENTS ne se croisent ni sur la cle composite ni
 *   sur le verrou de palier, lisent le meme solde et passent tous deux (le
 *   solde devenait negatif). Avec la garde, le second `UPDATE` bloque sur la
 *   ligne de compte, reevalue son filtre apres le commit du premier et leve
 *   (`P2025`), d'ou `'conflit'`. Le test de la salve des six armes rougit des
 *   que ce `gte` disparait.
 * - **Premier achat d'un article (branche `create`)** : la cle composite
 *   `[accountId, itemId]` de `Purchase` ne laisse passer qu'un `INSERT`.
 * - **Palier suivant (branche `update`)** : la cle composite ne protege rien,
 *   la ligne existe deja. Verrou optimiste : le `where` filtre aussi sur le
 *   `level` lu. Si un achat concurrent l'a fait avancer, Prisma leve (`P2025`)
 *   au lieu d'ecrire un `level` perime et de debiter deux fois pour un niveau.
 *
 * ⚠️ **Le `catch` rend `'conflit'`, jamais `'solde-insuffisant'`** : un echec
 * ici est un conflit de cle ou de verrou (ou une panne de base), et la route
 * HTTP en fait un 409 « rafraichis et retente », pas un 402 « gagne plus
 * d'or ».
 *
 * **La perdante d'une course n'atteint pas TOUJOURS ce `catch`** : si la
 * gagnante commite avant ses lectures, elle rend legitimement `'palier-max'`
 * ou `'solde-insuffisant'`. Seul un vrai recouvrement produit `'conflit'` ;
 * les tests de concurrence n'assenent donc que « le verdict de la perdante
 * n'est pas `'ok'` ».
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

      // Garde du SOLDE dans le `where` : voir le docbloc de buyItem.
      await tx.account.update({
        where: { id: accountId, gold: { gte: prix } },
        data: { gold: { decrement: prix } },
      });
      if (deja) {
        // Verrou optimiste sur le `level` lu : voir le docbloc de buyItem.
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
    // Cle composite ou verrou (P2025) : la transaction entiere est annulee,
    // rien n'a ete debite.
    return 'conflit';
  }
}
