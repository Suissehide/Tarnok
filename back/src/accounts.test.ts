import { randomBytes } from 'node:crypto';
import { GOLD_MAX, TOKEN_BYTES } from '@shared/protocol';
import { priceOf, SHOP_ITEMS, type ShopItem } from '@shared/shop';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  bonusesOf,
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
  unlockedWeaponsOf,
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
   * Review Focus n°2 : un refus doit ne RIEN debiter et n'inserer RIEN. Un
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

  /**
   * Review Focus n°3 : au-dela du dernier palier, le catalogue est la limite.
   */
  it('acheter au-dela du dernier palier est refuse', async () => {
    const article = SHOP_ITEMS.find((i) => i.levels === 1);
    if (!article) {
      throw new Error('aucun article a un seul palier');
    }
    const { id } = await createAccount();
    await creditAccounts([id], BigInt(priceOf(article, 1)) * 4n);

    expect(await buyItem(id, article.id)).toBe('ok');
    const apres = await goldOf(id);
    expect(await buyItem(id, article.id)).toBe('palier-max');
    expect(await goldOf(id)).toBe(apres);
  });

  /**
   * Review Focus n°1 : deux onglets, le meme article, au meme instant. La cle
   * composite et la transaction doivent n'en laisser passer qu'UN, et ne
   * debiter qu'une fois.
   */
  it('deux achats CONCURRENTS du meme article n en passent qu un', async () => {
    const article = SHOP_ITEMS.find((i) => i.levels === 1);
    if (!article) {
      throw new Error('aucun article a un seul palier');
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
   * Ronde de correction 1/5 : la cle composite ne protege que la branche
   * `create`. Un compte qui possede DEJA un palier bascule sur `update`, que
   * la cle composite ne peut pas refuser en double puisque la ligne existe
   * deja des les deux cotes : deux transactions concurrentes peuvent lire le
   * MEME `level` avant qu'aucune n'ait commite, et les deux `UPDATE` reussissent
   * alors chacun isolement, sans violer aucune contrainte. Ce test force cette
   * branche (palier 1 deja possede, deux achats concurrents du palier 2) pour
   * que la garantie de concurrence couvre aussi les cinq articles a paliers du
   * catalogue, pas seulement les six armes a `levels: 1`.
   *
   * ⚠️ **La fenetre de recouvrement est etroite et depend du minutage reel des
   * allers-retours reseau** (mesure : la mettre en evidence a demande une
   * quarantaine d'essais sur cette machine, contre une poignee pour la branche
   * `create`). Une seule paire concurrente serait donc un test intermittent au
   * sens ou la MAJORITE de ses essais passeraient sans rien prouver. Boucler
   * sur des comptes frais multiplie les tirages pour que le test entier
   * rougisse de facon fiable des que le defaut existe, sans pour autant tester
   * autre chose que la scene exacte du Review Focus n°1 : deux achats
   * VRAIMENT concurrents du meme palier.
   *
   * ⚠️ **Le `40` ci-dessous n'est PAS une garantie, c'est un calage empirique.**
   * Mesure locale : ~7% de recouvrement reel par PAIRE sur cette machine, donc
   * ~4,3% de chance qu'une execution de ce test passe au vert alors que le
   * defaut existe (`1 - 0.93^40`). Ce taux depend du minutage reseau local —
   * sur une machine plus rapide (recouvrement mesure a 0,5% dans la revue),
   * cette MEME boucle aurait ~82% de chance de rater le defaut. **Ce canari
   * est donc probabiliste par construction : ne monte PAS ce nombre pour
   * "gagner du temps", et ne le crois PAS suffisant seul.** La propriete
   * reelle — que le `where` filtre rejette un `level` perime — est fermee
   * SANS alea par le test deterministe juste en dessous, qui appelle
   * `prisma.purchase.update` directement et n'a besoin d'aucune course pour
   * rougir. Ce test-ci reste necessaire a cote : seul lui passe par `buyItem`
   * de bout en bout et verifie que le `catch` annule bien le debit.
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
   * Ronde de correction 2/5 : le canari ci-dessus est probabiliste (~4,3% de
   * faux vert mesure sur cette machine, voir son docbloc). Ce test-ci ferme
   * la MEME propriete sans aucun alea : il appelle `prisma.purchase.update`
   * directement, hors de `buyItem`, avec un `level` dans le `where` qui ne
   * correspond PLUS a la ligne (elle est a 1, on filtre sur 2). Prisma 6.19.3
   * accepte `level` en PLUS de la cle unique dans `PurchaseWhereUniqueInput`
   * (`Prisma.AtLeast<{ accountId_itemId, ..., level, ... }, "accountId_itemId">`,
   * verifie dans le type genere) : zero ligne correspond, donc l'update leve
   * TOUJOURS, deterministe. C'est exactement le mecanisme que le verrou
   * optimiste de `buyItem` exploite pour refuser un achat concurrent qui a
   * deja fait avancer le palier.
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
   * Ronde de correction de la revue finale : les DEUX mecanismes de
   * concurrence ci-dessus sont par ARTICLE — la cle composite sur
   * `[accountId, itemId]`, le verrou optimiste sur le `level` de CETTE ligne.
   * Deux transactions qui visent deux `itemId` DIFFERENTS ne se croisaient donc
   * nulle part : elles lisaient le meme solde, passaient toutes deux la
   * comparaison `gold < prix`, et les deux `decrement` s'appliquaient. Le
   * `where` du debit ne filtrait que sur l'identite du compte.
   *
   * ⚠️ **Le chemin joueur est reel.** Le grisage et la garde anti-double-clic
   * de la boutique sont par BOUTON, et l'etalage ne se repeint qu'au retour de
   * la reponse : deux clics rapides sur deux LIGNES differentes partent en
   * parallele. Le cas du meme article (teste plus haut) est justement celui que
   * l'interface ferme deja — ce qui faisait de ce cas-ci le seul encore
   * atteignable depuis la vraie interface.
   *
   * ⚠️ **La salve porte sur les SIX armes, pas sur une paire, et c'est ce qui
   * rend ce test deterministe.** Mesure sur cette machine, avant correctif :
   * une PAIRE d'articles differents passait `ok`/`ok` 19 fois sur 20 (une fois
   * sur vingt, les deux transactions se serialisent d'elles-memes et la seconde
   * rend `'solde-insuffisant'` par la voie normale) — donc ~5% de faux vert
   * comme canari de mutation. La salve des six armes, elle, a rendu **au moins
   * deux `ok` 20 fois sur 20, dont 19 fois les SIX, pour un solde de `-1500`**
   * (le joueur encaissait 1800 d'or de marchandise pour 300). Le compte est
   * credite du prix d'UNE seule arme et les six ont le MEME prix — une
   * assertion du test le garde — donc apres correctif un seul `ok` est
   * possible, quel que soit l'ordre dans lequel Postgres serialise les six
   * transactions.
   *
   * Le verdict des perdantes n'est pas assene a `'conflit'` exactement, et pour
   * la meme raison que les deux tests ci-dessus : une perdante qui relit le
   * solde APRES le commit de la gagnante rend `'solde-insuffisant'` par la voie
   * normale, un verdict tout aussi legitime. Ce qui est assene, et qui est le
   * defaut mesure : UN seul `ok`, UN seul achat, et surtout **un solde final
   * jamais a decouvert**.
   */
  it('une salve d achats CONCURRENTS de six articles DIFFERENTS n en passe qu un', async () => {
    const armes = SHOP_ITEMS.filter((i) => i.levels === 1);
    if (armes.length < 2) {
      throw new Error('au moins deux articles a un seul palier attendus');
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
    // solde valait `-1500`.
    expect(await goldOf(id)).toBe(0n);
    expect((await purchasesOf(id)).size).toBe(1);
  });

  it('bonusesOf somme les paliers, et rend zero sur une cle non achetee', () => {
    const v = SHOP_ITEMS.find((i) => i.bonusKind === 'maxHp');
    if (!v) {
      throw new Error('aucun article de vitalite');
    }
    const b = bonusesOf(new Map([[v.id, 3]]));
    expect(b.maxHp).toBe((v.perLevel ?? 0) * 3);
    expect(b.regen).toBe(0);
  });

  it('unlockedWeaponsOf rend les armes des articles achetes, et rien d autre', () => {
    const arme = SHOP_ITEMS.find((i) => i.kind === 'weapon');
    if (!arme) {
      throw new Error('aucun article d arme');
    }
    expect([...unlockedWeaponsOf(new Map([[arme.id, 1]]))]).toEqual([arme.weaponId]);
    expect(unlockedWeaponsOf(new Map()).size).toBe(0);
  });
});
