import { randomBytes } from 'node:crypto';
import { GOLD_MAX, TOKEN_BYTES } from '@shared/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createAccount,
  creditAccounts,
  findAccountIdByToken,
  goldOf,
  hashToken,
  newToken,
  prisma,
  textToToken,
  tokenToText,
} from './accounts';

beforeEach(async () => {
  await prisma.account.deleteMany();
});

describe('etape 7a tache 2 : le compte, et son jeton jamais stocke en clair', () => {
  it('un compte se cree, et son jeton le retrouve', async () => {
    const { id, token } = await createAccount();
    expect(await findAccountIdByToken(token)).toBe(id);
  });

  it('un jeton inconnu ne retrouve rien', async () => {
    await createAccount();
    expect(await findAccountIdByToken(newToken())).toBeNull();
  });

  /**
   * ⚠️ **La ligne en base ne doit porter AUCUNE trace du jeton.** Un dump de
   * cette table ne doit pas suffire a se faire passer pour un joueur. C'est la
   * propriete du §2 de la spec, et la mutation « stocker le jeton en clair »
   * doit rougir ICI.
   */
  it('la base stocke le HACHE, jamais le jeton', async () => {
    const { token } = await createAccount();
    const lignes = await prisma.account.findMany();
    expect(lignes).toHaveLength(1);
    const ligne = lignes[0];
    if (!ligne) {
      throw new Error('une ligne attendue');
    }
    expect(ligne.tokenHash).toBe(hashToken(token));
    expect(ligne.tokenHash).not.toBe(tokenToText(token));
    // 64 caracteres hexadecimaux : un sha256, pas le jeton.
    expect(ligne.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('un compte neuf part a zero', async () => {
    const { id } = await createAccount();
    expect(await goldOf(id)).toBe(0n);
  });

  it('crediter ajoute, et crediter deux fois cumule', async () => {
    const { id } = await createAccount();
    await creditAccounts([id], 120n);
    expect(await goldOf(id)).toBe(120n);
    await creditAccounts([id], 80n);
    expect(await goldOf(id)).toBe(200n);
  });

  it('crediter plusieurs comptes les sert tous, du MEME montant', async () => {
    const a = await createAccount();
    const b = await createAccount();
    const c = await createAccount();
    await creditAccounts([a.id, b.id, c.id], 1200n);
    expect(await goldOf(a.id)).toBe(1200n);
    expect(await goldOf(b.id)).toBe(1200n);
    expect(await goldOf(c.id)).toBe(1200n);
  });

  /**
   * Review Focus n°4 : la colonne doit tenir ce que le FIL peut transporter.
   * `GOLD_MAX` vaut le plein u32 et depasse deja `Int32` : la mutation
   * « colonne Int » rougit ici, et elle rougit au PREMIER credit au plafond,
   * pas apres mille runs.
   */
  it('un solde au-dela d Int32 se reecrit et se relit sans perte', async () => {
    const INT32_MAX = 2_147_483_647n;
    expect(BigInt(GOLD_MAX)).toBeGreaterThan(INT32_MAX);

    const { id } = await createAccount();
    await creditAccounts([id], BigInt(GOLD_MAX));
    expect(await goldOf(id)).toBe(BigInt(GOLD_MAX));

    // Et une seconde run au plafond : largement au-dela d'Int32.
    await creditAccounts([id], BigInt(GOLD_MAX));
    expect(await goldOf(id)).toBe(BigInt(GOLD_MAX) * 2n);
  });

  it('le jeton fait l aller-retour en base64url', () => {
    const t = newToken();
    expect(tokenToText(t)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([...textToToken(tokenToText(t))]).toEqual([...t]);
  });

  it('un texte qui n est pas un jeton leve plutot que de rendre n importe quoi', () => {
    expect(() => textToToken('trop-court')).toThrow();
    expect(() => textToToken(tokenToText(randomBytes(16)))).toThrow();
  });

  /**
   * ⚠️ **Deux constantes pour une seule grandeur, c'est une divergence qui
   * attend son tour.** `TOKEN_BYTES` borne le fil, et c'est elle qui frappe le
   * jeton. Si une seconde apparaissait un jour et divergeait, tout jeton frappe
   * serait refuse a l'encodage — et le symptome serait « personne ne peut se
   * connecter », tres loin de sa cause.
   */
  it('le jeton frappe fait exactement TOKEN_BYTES du protocole', () => {
    expect(newToken().length).toBe(TOKEN_BYTES);
  });
});
