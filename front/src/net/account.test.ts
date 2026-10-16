import { TOKEN_BYTES } from '@shared/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { acheter, fetchCompte, STORAGE_KEY, tokenBytes, tokenText } from './account';

function fausseStorage(initial?: string): Pick<Storage, 'getItem' | 'setItem'> & {
  lu: Record<string, string>;
} {
  const lu: Record<string, string> = initial ? { [STORAGE_KEY]: initial } : {};
  return {
    lu,
    getItem: (k: string) => lu[k] ?? null,
    setItem: (k: string, v: string) => {
      lu[k] = v;
    },
  };
}

const JETON = 'A'.repeat(43);

describe('etape 7a tache 7 : le jeton du client', () => {
  it('frappe un jeton au PREMIER chargement, et le garde', async () => {
    const s = fausseStorage();
    const mint = vi.fn(async () => JETON);
    expect(await tokenText(s, mint)).toBe(JETON);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(s.lu[STORAGE_KEY]).toBe(JETON);
  });

  /**
   * ⚠️ **On ne frappe PAS un second compte.** Reappeler `POST /accounts` a
   * chaque chargement donnerait un compte neuf, et un solde a zero, a chaque
   * visite.
   */
  it('ne frappe RIEN si un jeton est deja la', async () => {
    const s = fausseStorage(JETON);
    const mint = vi.fn(async () => 'B'.repeat(43));
    expect(await tokenText(s, mint)).toBe(JETON);
    expect(mint).not.toHaveBeenCalled();
  });

  it('un jeton stocke mal forme est remplace plutot que de tout casser', async () => {
    const s = fausseStorage('pas-un-jeton');
    const mint = vi.fn(async () => JETON);
    expect(await tokenText(s, mint)).toBe(JETON);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('le texte se convertit en TOKEN_BYTES octets', () => {
    expect(tokenBytes(JETON).length).toBe(TOKEN_BYTES);
  });

  it('un texte de mauvaise longueur leve', () => {
    expect(() => tokenBytes('court')).toThrow();
  });

  /**
   * ⚠️ **Un `mint` qui echoue (base injoignable) ne doit RIEN stocker.**
   * `main.ts` compte sur ce rejet pour afficher un message ; avaler l'erreur
   * laisserait un jeton inutilisable sans que personne ne le sache.
   */
  it('un mint qui leve ne stocke rien et laisse le stockage intact', async () => {
    const s = fausseStorage();
    const mint = vi.fn(async () => {
      throw new Error('POST /accounts : 500');
    });
    await expect(tokenText(s, mint)).rejects.toThrow('POST /accounts : 500');
    expect(s.lu[STORAGE_KEY]).toBeUndefined();
  });

  it('un mint qui rend un jeton mal forme leve et ne stocke rien', async () => {
    const s = fausseStorage();
    const mint = vi.fn(async () => undefined as unknown as string);
    await expect(tokenText(s, mint)).rejects.toThrow();
    expect(s.lu[STORAGE_KEY]).toBeUndefined();
  });

  /**
   * ⚠️ **Un jeton bien forme mais INCONNU du serveur doit etre remplace.**
   * Sinon une base reinitialisee laisse un jeton mort : la socket est fermee a
   * chaque tentative et le joueur ne peut plus jouer, sans rien a l'ecran.
   * `main.ts` branche `verify` sur le `401` de `GET /accounts/me`.
   */
  it('un jeton bien forme mais refuse par verify est remplace', async () => {
    const s = fausseStorage(JETON);
    const neuf = 'B'.repeat(43);
    const mint = vi.fn(async () => neuf);
    const verify = vi.fn(async () => false);
    expect(await tokenText(s, mint, verify)).toBe(neuf);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(s.lu[STORAGE_KEY]).toBe(neuf);
    expect(verify).toHaveBeenCalledWith(JETON);
  });

  /**
   * L'autre moitie de la regle : on re-frappe si et seulement si le serveur
   * refuse le jeton.
   */
  it('un jeton bien forme et accepte par verify n est jamais re-frappe', async () => {
    const s = fausseStorage(JETON);
    const mint = vi.fn(async () => 'B'.repeat(43));
    const verify = vi.fn(async () => true);
    expect(await tokenText(s, mint, verify)).toBe(JETON);
    expect(mint).not.toHaveBeenCalled();
  });
});

describe('etape 7b tache 8 : la lecture et l achat, cote reseau', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchCompte rend le solde et les achats sur une reponse OK', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ gold: '1234', purchases: { vitalite: 2 } }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const compte = await fetchCompte('http://api.test', JETON);

    expect(compte).toEqual({ gold: '1234', purchases: { vitalite: 2 } });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/accounts/me',
      expect.objectContaining({ headers: { Authorization: `Bearer ${JETON}` } }),
    );
  });

  it('fetchCompte rend null sur une reponse qui n est pas OK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'jeton absent ou inconnu' }), { status: 401 }),
      ),
    );

    expect(await fetchCompte('http://api.test', JETON)).toBeNull();
  });

  it('acheter rend le nouvel etat du compte sur un achat reussi', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ gold: '900', purchases: { vitalite: 1 } }), {
            status: 200,
          }),
      ),
    );

    const reponse = await acheter('http://api.test', JETON, 'vitalite');

    expect(reponse).toEqual({ ok: true, gold: '900', purchases: { vitalite: 1 } });
  });

  /**
   * ⚠️ **Le code HTTP survit jusqu'a l'appelant, en nombre nu** :
   * `ui/shop.ts#messageAchat` le traduit (402 contre 409). Un nombre nu, pas
   * une constante importee : la constante ne verifierait rien.
   */
  it('acheter rend le code HTTP du refus, sans le traduire', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ error: 'solde-insuffisant' }), { status: 402 }),
      ),
    );

    expect(await acheter('http://api.test', JETON, 'vitalite')).toEqual({ ok: false, status: 402 });
  });

  it('acheter distingue un conflit (409) d un refus de solde (402)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'conflit' }), { status: 409 })),
    );

    expect(await acheter('http://api.test', JETON, 'vitalite')).toEqual({ ok: false, status: 409 });
  });
});
