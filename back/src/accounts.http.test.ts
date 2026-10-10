import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prisma, tokenToText } from './accounts';
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
    const enorme = 9_000_000_000n;
    await prisma.account.updateMany({ data: { gold: enorme } });

    const res = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    // En TEXTE : un nombre JSON perdrait la precision au-dela de 2^53.
    expect(res.json<{ gold: string }>().gold).toBe('9000000000');
  });
});
