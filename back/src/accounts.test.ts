import { randomBytes } from 'node:crypto';
import { GOLD_MAX, TOKEN_BYTES } from '@shared/protocol';
import { priceOf, SHOP_ITEMS, type ShopItem } from '@shared/shop';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buyItem,
  createAccount,
  creditAccounts,
  findAccountIdByToken,
  goldOf,
  hashToken,
  newToken,
  prisma,
  purchasesOf,
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
   * cette table ne doit pas suffire a se faire passer pour un joueur.
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
   * La colonne doit tenir ce que le FIL peut transporter. `GOLD_MAX` vaut le
   * plein u32 et depasse deja `Int32` : une colonne Int rougit des le PREMIER
   * credit au plafond, pas apres mille runs.
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
   * ⚠️ **Une seule constante pour une seule grandeur.** `TOKEN_BYTES` borne le
   * fil, et c'est elle qui frappe le jeton. Une seconde qui divergerait ferait
   * refuser tout jeton a l'encodage, avec pour symptome « personne ne peut se
   * connecter », tres loin de sa cause.
   */
  it('le jeton frappe fait exactement TOKEN_BYTES du protocole', () => {
    expect(newToken().length).toBe(TOKEN_BYTES);
  });
});

describe('etape 7b tache 4 : acheter', () => {
  it('un compte neuf n a aucun achat', async () => {
    const { id } = await createAccount();
    expect((await purchasesOf(id)).size).toBe(0);
  });

  it('un achat insere la ligne et debite EXACTEMENT le prix du catalogue', async () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const { id } = await createAccount();
    await creditAccounts([id], BigInt(priceOf(article, 1)));

    expect(await buyItem(id, article.id)).toBe('ok');
    expect(await goldOf(id)).toBe(0n);
    expect((await purchasesOf(id)).get(article.id)).toBe(1);
  });

  /**
   * Un refus doit ne RIEN debiter et n'inserer RIEN. Un
   * debit partiel serait pire qu'un crash, parce qu'invisible — le joueur
   * verrait son or baisser sans rien recevoir.
   */
  it('un achat a solde insuffisant ne debite rien et n insere rien', async () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const { id } = await createAccount();
    const presque = BigInt(priceOf(article, 1)) - 1n;
    await creditAccounts([id], presque);

    expect(await buyItem(id, article.id)).toBe('solde-insuffisant');
    expect(await goldOf(id)).toBe(presque);
    expect((await purchasesOf(id)).size).toBe(0);
  });

  it('un article inconnu est refuse sans rien debiter', async () => {
    const { id } = await createAccount();
    await creditAccounts([id], 100_000n);
    expect(await buyItem(id, 'article-qui-n-existe-pas')).toBe('article-inconnu');
    expect(await goldOf(id)).toBe(100_000n);
    expect((await purchasesOf(id)).size).toBe(0);
  });

  it('acheter un palier de plus monte le niveau et debite le prix du palier', async () => {
    const paliers = SHOP_ITEMS.find((i) => i.levels > 1);
    if (!paliers) {
      throw new Error('aucun article a paliers');
    }
    const { id } = await createAccount();
    await creditAccounts([id], BigInt(priceOf(paliers, 1) + priceOf(paliers, 2)));

    expect(await buyItem(id, paliers.id)).toBe('ok');
    expect(await buyItem(id, paliers.id)).toBe('ok');
    expect((await purchasesOf(id)).get(paliers.id)).toBe(2);
    expect(await goldOf(id)).toBe(0n);
  });

  it('acheter au-dela du dernier palier est refuse', async () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const { id } = await createAccount();
    // Assez pour tous les paliers, et un de plus : seul le palier-max refuse.
    await creditAccounts(
      [id],
      BigInt(priceOf(article, article.levels + 1)) * BigInt(article.levels + 1),
    );

    for (let palier = 1; palier <= article.levels; palier++) {
      expect(await buyItem(id, article.id)).toBe('ok');
    }
    const apres = await goldOf(id);
    expect(await buyItem(id, article.id)).toBe('palier-max');
    expect(await goldOf(id)).toBe(apres);
  });

  /**
   * Deux onglets, le meme article, au meme instant. La cle
   * composite et la transaction doivent n'en laisser passer qu'UN, et ne
   * debiter qu'une fois.
   */
  it('deux achats CONCURRENTS du meme article n en passent qu un', async () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const { id } = await createAccount();
    await creditAccounts([id], BigInt(priceOf(article, 1)) * 2n);

    const [a, b] = await Promise.all([buyItem(id, article.id), buyItem(id, article.id)]);
    const resultats = [a, b].sort();
    expect(resultats).toContain('ok');
    expect(resultats.filter((r) => r === 'ok')).toHaveLength(1);
    expect((await purchasesOf(id)).get(article.id)).toBe(1);
    expect(await goldOf(id)).toBe(BigInt(priceOf(article, 1)));
  });

  /**
   * La cle composite ne protege que la branche `create`. Un compte qui
   * possede DEJA un palier bascule sur `update` : deux transactions
   * concurrentes peuvent lire le MEME `level` avant qu'aucune n'ait commite,
   * et les deux `UPDATE` reussissent sans violer aucune contrainte. Ce test
   * force cette branche (palier 1 possede, deux achats concurrents du
   * palier 2).
   *
   * ⚠️ **Canari probabiliste.** La fenetre de recouvrement est etroite et
   * depend du minutage reseau local : une seule paire passerait le plus
   * souvent sans rien prouver, d'ou la boucle sur des comptes frais. Le `40`
   * est un calage empirique, pas une garantie ; sur une machine rapide le
   * defaut peut passer inapercu. La propriete reelle (le `where` rejette un
   * `level` perime) est fermee SANS alea par le test juste en dessous ;
   * celui-ci reste necessaire car seul lui passe par `buyItem` de bout en bout
   * et verifie que le `catch` annule bien le debit.
   */
  it('deux achats CONCURRENTS du palier suivant n en passent qu un', async () => {
    const paliers = SHOP_ITEMS.find((i) => i.levels >= 2);
    if (!paliers) {
      throw new Error('aucun article a au moins deux paliers');
    }
    const prixPalier2 = BigInt(priceOf(paliers, 2));

    for (let essai = 0; essai < 40; essai++) {
      const { id } = await createAccount();
      await creditAccounts([id], BigInt(priceOf(paliers, 1)) + prixPalier2);
      expect(await buyItem(id, paliers.id)).toBe('ok');

      const [a, b] = await Promise.all([buyItem(id, paliers.id), buyItem(id, paliers.id)]);
      const resultats = [a, b].sort();
      expect(resultats.filter((r) => r === 'ok')).toHaveLength(1);
      expect((await purchasesOf(id)).get(paliers.id)).toBe(2);
      expect(await goldOf(id)).toBe(0n);
    }
  });

  /**
   * Ferme sans aucun alea la propriete du canari ci-dessus : un
   * `prisma.purchase.update` direct, avec un `level` dans le `where` qui ne
   * correspond PLUS a la ligne (elle est a 1, on filtre sur 2). Prisma accepte
   * `level` en PLUS de la cle unique dans `PurchaseWhereUniqueInput` : zero
   * ligne correspond, l'update leve TOUJOURS. C'est le mecanisme que le
   * verrou optimiste de `buyItem` exploite.
   */
  it('un update filtre sur un level perime leve P2025, sans aucune course', async () => {
    const article = SHOP_ITEMS.find((i) => i.levels >= 2);
    if (!article) {
      throw new Error('aucun article a au moins deux paliers');
    }
    const { id } = await createAccount();
    await prisma.purchase.create({ data: { accountId: id, itemId: article.id, level: 1 } });

    await expect(
      prisma.purchase.update({
        where: { accountId_itemId: { accountId: id, itemId: article.id }, level: 2 },
        data: { level: 2 },
      }),
    ).rejects.toMatchObject({ code: 'P2025' });
  });

  /**
   * Les DEUX mecanismes de concurrence ci-dessus sont par ARTICLE (la cle
   * composite sur `[accountId, itemId]`, le verrou optimiste sur le `level` de
   * CETTE ligne). Deux transactions sur deux `itemId` DIFFERENTS liraient le
   * meme solde et passeraient toutes deux `gold < prix` : seule la garde du
   * solde dans le `where` du debit les separe.
   *
   * ⚠️ **Le chemin joueur est reel.** La garde anti-double-clic de la boutique
   * est par BOUTON, et l'etalage ne se repeint qu'au retour de la reponse :
   * deux clics rapides sur deux LIGNES differentes partent en parallele.
   *
   * ⚠️ **La salve porte sur au moins cinq articles, pas sur une paire, et c'est
   * ce qui rend ce test deterministe** : une paire se serialise parfois
   * d'elle-meme et passerait au vert sans rien prouver. Le compte est credite
   * d'UN prix et tous les articles ont le MEME prix (une assertion le garde) :
   * un seul `ok` est possible, quel que soit l'ordre de serialisation.
   *
   * Le verdict des perdantes n'est pas assene a `'conflit'` : une perdante qui
   * relit le solde APRES le commit de la gagnante rend `'solde-insuffisant'`,
   * tout aussi legitime. Ce qui est assene : UN seul `ok`, UN seul achat, et
   * surtout **un solde final jamais a decouvert**.
   */
  it('une salve d achats CONCURRENTS de six articles DIFFERENTS n en passe qu un', async () => {
    // Les articles au prix de premier palier le plus partage du catalogue :
    // il en faut plusieurs au MEME prix (voir ci-dessous).
    const parPrix = new Map<number, ShopItem[]>();
    for (const i of SHOP_ITEMS) {
      parPrix.set(priceOf(i, 1), [...(parPrix.get(priceOf(i, 1)) ?? []), i]);
    }
    const armes = [...parPrix.values()].reduce((a, b) => (b.length > a.length ? b : a));
    if (armes.length < 5) {
      throw new Error('au moins cinq articles au meme prix attendus');
    }
    const prix = BigInt(priceOf(armes[0] as ShopItem, 1));
    // Le MEME prix pour toutes : sinon deux achats successifs du budget
    // seraient legitimes et « exactement un ok » cesserait d'etre la propriete.
    for (const a of armes) {
      expect(BigInt(priceOf(a, 1))).toBe(prix);
    }

    const { id } = await createAccount();
    await creditAccounts([id], prix);

    const verdicts = await Promise.all(armes.map((a) => buyItem(id, a.id)));
    expect(verdicts.filter((r) => r === 'ok')).toHaveLength(1);
    // Le coeur du defaut : sans la garde du solde dans le `where` du debit, ce
    // solde passe a decouvert.
    expect(await goldOf(id)).toBe(0n);
    expect((await purchasesOf(id)).size).toBe(1);
  });
});
