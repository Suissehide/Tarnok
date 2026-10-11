import { priceOf, SHOP_ITEMS } from '@shared/shop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { creditAccounts, findAccountIdByToken, prisma, textToToken, tokenToText } from './accounts';
import { buildServer } from './server';

type App = Awaited<ReturnType<typeof buildServer>>;

let app: App;

beforeEach(async () => {
  await prisma.account.deleteMany();
  app = await buildServer({ roomSeed: 1 });
});

afterEach(async () => {
  await app.close();
});

describe('etape 7a tache 4 : les deux routes du compte', () => {
  it('POST /accounts frappe un compte et rend son jeton UNE fois', async () => {
    const res = await app.inject({ method: 'POST', url: '/accounts' });
    expect(res.statusCode).toBe(201);
    const { token } = res.json<{ token: string }>();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await prisma.account.count()).toBe(1);
  });

  it('deux appels frappent DEUX comptes differents', async () => {
    const a = (await app.inject({ method: 'POST', url: '/accounts' })).json<{ token: string }>();
    const b = (await app.inject({ method: 'POST', url: '/accounts' })).json<{ token: string }>();
    expect(a.token).not.toBe(b.token);
    expect(await prisma.account.count()).toBe(2);
  });

  it('GET /accounts/me rend le solde du porteur du jeton', async () => {
    const { token } = (await app.inject({ method: 'POST', url: '/accounts' })).json<{
      token: string;
    }>();
    const res = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ gold: string }>().gold).toBe('0');
  });

  /**
   * Review Focus n°3 : les trois formes de « pas de jeton valide » doivent
   * rendre 401, jamais 500, et surtout **jamais un solde de 0** — qui se
   * lirait comme « ton compte est vide » alors que le compte n'a pas ete
   * trouve. Le joueur verrait son or disparaitre.
   */
  it('sans en-tete, avec un en-tete vide, ou avec un jeton inconnu : 401', async () => {
    const sans = await app.inject({ method: 'GET', url: '/accounts/me' });
    expect(sans.statusCode).toBe(401);

    const vide = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: '' },
    });
    expect(vide.statusCode).toBe(401);

    const malForme = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: 'Bearer pas-un-jeton' },
    });
    expect(malForme.statusCode).toBe(401);

    const inconnu = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${tokenToText(new Uint8Array(32))}` },
    });
    expect(inconnu.statusCode).toBe(401);

    for (const res of [sans, vide, malForme, inconnu]) {
      expect(res.body).not.toContain('"gold"');
    }

    // ⚠️ **Les quatre corps doivent etre IDENTIQUES, pas seulement « sans
    // gold ».** Un message different par forme d'echec — « jeton malforme »
    // d'un cote, « jeton inconnu » de l'autre — renseignerait un attaquant sur
    // l'existence d'un compte, et c'est precisement ce que le 401 uniforme
    // interdit. Sans cette assertion, une telle regression resterait verte.
    for (const res of [vide, malForme, inconnu]) {
      expect(res.body).toBe(sans.body);
    }
  });

  /**
   * Review Focus n°4 : `bigint` n'est pas serialisable en JSON. Sans
   * conversion explicite, cette route leverait « Do not know how to serialize
   * a BigInt » et rendrait 500 — pour tout solde, pas seulement les gros.
   */
  it('un solde au-dela d Int32 se serialise, en TEXTE', async () => {
    const { token } = (await app.inject({ method: 'POST', url: '/accounts' })).json<{
      token: string;
    }>();
    // 2^53 + 1 : la plus petite valeur entiere qu'un nombre JSON ne peut pas
    // representer exactement. Avec .toString(), elle voyage exact. Avec un
    // nombre, elle reviendrait arrondie a 9007199254740992.
    const enorme = 9_007_199_254_740_993n;
    await prisma.account.updateMany({ data: { gold: enorme } });

    const res = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    // En TEXTE : un nombre JSON perdrait la precision au-dela de 2^53.
    expect(res.json<{ gold: string }>().gold).toBe('9007199254740993');
  });
});

describe('etape 7b tache 5 : la boutique en http', () => {
  async function compte(): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/accounts' });
    return res.json<{ token: string }>().token;
  }

  it('GET /accounts/me rend desormais les achats, vides au depart', async () => {
    const token = await compte();
    const res = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const corps = res.json<{ gold: string; purchases: Record<string, number> }>();
    expect(corps.gold).toBe('0');
    expect(corps.purchases).toEqual({});
  });

  it('un achat reussi rend le nouveau solde ET les achats a jour', async () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const token = await compte();
    const id = await findAccountIdByToken(textToToken(token));
    if (!id) {
      throw new Error('compte introuvable');
    }
    await creditAccounts([id], BigInt(priceOf(article, 1)));

    const res = await app.inject({
      method: 'POST',
      url: '/accounts/me/purchases',
      headers: { authorization: `Bearer ${token}` },
      payload: { itemId: article.id },
    });
    expect(res.statusCode).toBe(200);
    const corps = res.json<{ gold: string; purchases: Record<string, number> }>();
    expect(corps.gold).toBe('0');
    expect(corps.purchases[article.id]).toBe(1);
  });

  it('un solde insuffisant rend 402, et ne debite rien', async () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const token = await compte();
    const res = await app.inject({
      method: 'POST',
      url: '/accounts/me/purchases',
      headers: { authorization: `Bearer ${token}` },
      payload: { itemId: article.id },
    });
    expect(res.statusCode).toBe(402);
    expect(res.body).not.toContain('"purchases"');
  });

  /** Review Focus n°3 : un `itemId` inconnu, ou absent du corps. */
  it('un article inconnu ou un corps sans itemId rendent 400', async () => {
    const token = await compte();
    for (const payload of [{ itemId: 'rien-du-tout' }, {}, { itemId: 42 }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/accounts/me/purchases',
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('acheter sans jeton valide rend 401, et les trois formes d echec sont indistinguables', async () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const faits = [];
    for (const headers of [{}, { authorization: '' }, { authorization: 'Bearer pas-un-jeton' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/accounts/me/purchases',
        headers,
        payload: { itemId: article.id },
      });
      expect(res.statusCode).toBe(401);
      faits.push(res.body);
    }
    for (const corps of faits.slice(1)) {
      expect(corps).toBe(faits[0]);
    }
  });
});
