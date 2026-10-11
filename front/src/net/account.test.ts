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
   * ⚠️ **Le coeur du livrable : on ne frappe PAS un second compte.** Sans ce
   * test, un bug qui reappellerait `POST /accounts` a chaque chargement
   * donnerait un compte neuf — et un solde a zero — a chaque visite. « L'or
   * survit » serait faux, et de la facon la plus silencieuse possible.
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
   * `main.ts` compte sur ce rejet pour afficher un message plutot que de
   * bloquer l'ecran d'accueil (voir son docblock) ; si `tokenText` avalait
   * l'erreur ou stockait quand meme, l'ecran se peindrait avec un jeton
   * inutilisable sans que personne ne le sache.
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
   * ⚠️ **Un jeton bien forme mais INCONNU du serveur doit etre remplace, pas
   * conserve.** Ruling P9 du coordinateur.
   *
   * Sans ca, une base reinitialisee — ce qui arrive constamment en
   * developpement — laisse dans le navigateur un jeton mort que rien ne
   * remplace : la socket est fermee a chaque tentative et **le joueur ne peut
   * plus jamais jouer**, sans rien a l'ecran qui le lui dise. Le `401` de
   * `GET /accounts/me` est le signal, et il est deja la : `verify` est ce que
   * `main.ts` branche sur ce `401` sans qu'aucun navigateur ni serveur reel
   * n'ait a tourner pour le prouver ici.
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
   * ⚠️ **Et l'autre moitie de la regle, gardee a cote pour qu'on ne puisse
   * pas satisfaire l'une en cassant l'autre** : un jeton que `verify` ACCEPTE
   * n'est jamais re-frappe. Les deux tests ensemble disent la regle complete
   * — on re-frappe si et seulement si le serveur refuse le jeton.
   */
  it('un jeton bien forme et accepte par verify n est jamais re-frappe', async () => {
    const s = fausseStorage(JETON);
    const mint = vi.fn(async () => 'B'.repeat(43));
    const verify = vi.fn(async () => true);
    expect(await tokenText(s, mint, verify)).toBe(JETON);
    expect(mint).not.toHaveBeenCalled();
  });
});

/**
 * Amendement, point 1 : la lecture HTTP (`GET /accounts/me`) et l'achat
 * (`POST /accounts/me/purchases`) vivent dans la couche RESEAU, pas dans
 * `main.ts` qui dit de lui-meme « le DEMARRAGE, et rien d'autre ».
 */
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
   * ⚠️ **Le code HTTP survit jusqu'a l'appelant, en nombre nu.** C'est
   * `ui/shop.ts#messageAchat` qui le traduit en message (402 contre 409) ;
   * importer ici une constante qu'on viendrait verifier ne verifierait rien
   * (doctrine du depot pour les contrats de fil).
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
