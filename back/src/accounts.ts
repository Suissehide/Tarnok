import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { TOKEN_BYTES } from '@shared/protocol';

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
