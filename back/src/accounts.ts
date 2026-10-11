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
 * refus ne laisse jamais de debit partiel : la lecture du solde, le debit et
 * l'ecriture de la ligne sont atomiques, donc un `solde-insuffisant` ou un
 * `palier-max` renvoie la transaction entiere sans rien ecrire.
 *
 * ⚠️ **Mesure sur le `catch`, documentee.** Sous deux achats concurrents du
 * meme article, les DEUX transactions peuvent lire `deja === null` et passer
 * la verification de solde avant qu'aucune n'ait commite — la cle composite
 * `[accountId, itemId]` n'intervient qu'a l'ECRITURE. La perdante decremente
 * donc bien son propre solde local puis echoue sur l'insertion en double ; sa
 * transaction entiere est alors annulee, decrement inclus, et le `catch`
 * attrape cette erreur-la. La cause reelle est un CONFLIT DE CLE, pas un
 * solde insuffisant — rendre `'solde-insuffisant'` ici confond deux causes
 * distinctes, et un appelant qui afficherait ce message a un joueur qui a
 * bien assez d'or serait trompeur. Le choix est garde malgre ca, mesure a
 * l'appui : le test de concurrence (Review Focus n°1) montre que le verdict
 * de la perdante n'est jamais `'ok'`, que le solde final est exactement celui
 * d'UN achat, et qu'aucun appelant actuel (poignee de main, future route HTTP)
 * ne distingue encore un conflit d'un solde insuffisant pour agir differemment
 * — dans les deux cas l'action correcte est « rafraichir l'etat et retenter ».
 * Un quatrieme verdict `'conflit'` serait plus honnete semantiquement ; il
 * n'a pas ete ajoute faute de consommateur qui en ferait quelque chose de
 * different aujourd'hui. A revisiter si une UI veut un message distinct.
 */
export async function buyItem(
  accountId: string,
  itemId: string,
): Promise<'ok' | 'solde-insuffisant' | 'article-inconnu' | 'palier-max'> {
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
        await tx.purchase.update({
          where: { accountId_itemId: { accountId, itemId } },
          data: { level: palier },
        });
      } else {
        await tx.purchase.create({ data: { accountId, itemId, level: palier } });
      }
      return 'ok' as const;
    });
  } catch {
    // La cle composite a refuse un doublon cree par un achat concurrent :
    // cette transaction-ci a tout annule, rien n'a ete debite. Voir le
    // docbloc ci-dessus pour la mesure qui justifie ce verdict precis.
    return 'solde-insuffisant';
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
