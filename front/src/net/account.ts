import { TOKEN_BYTES } from '@shared/protocol';

/** La cle du `localStorage` qui porte le jeton de compte. */
export const STORAGE_KEY = 'tarnok.account.token';

/** Longueur du jeton en base64url : 32 octets -> 43 caracteres. */
const TEXT_LENGTH = 43;

function bienForme(text: string | null): text is string {
  return text !== null && /^[A-Za-z0-9_-]{43}$/.test(text);
}

/**
 * Le jeton de ce navigateur, frappe au besoin.
 *
 * ⚠️ **`mint` n'est appele QUE si le stockage n'en porte pas deja un de bonne
 * forme, OU que `verify` refuse celui qui y est.** Rappeler `mint` a chaque
 * chargement donnerait un compte neuf — donc un solde a zero — a chaque
 * visite, et « l'or survit a la fermeture du navigateur » serait faux de la
 * facon la plus silencieuse possible.
 *
 * `storage` est injecte plutot que lu globalement : c'est ce qui rend cette
 * fonction testable sans navigateur.
 *
 * ⚠️ **`verify` ferme le cul-de-sac du ruling P9.** Un jeton bien forme mais
 * INCONNU du serveur — base reinitialisee en developpement, ligne
 * supprimee — resterait sinon stocke pour toujours : la socket serait fermee
 * a chaque tentative et le joueur ne pourrait plus jamais jouer, sans rien a
 * l'ecran qui le lui dise. Par defaut `verify` accepte tout sans appel
 * reseau, pour que les sites qui ne passent pas cet argument (y compris les
 * tests qui testaient cette fonction avant que ce parametre n'existe)
 * gardent exactement le meme comportement.
 */
export async function tokenText(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  mint: () => Promise<string>,
  verify: (text: string) => Promise<boolean> = () => Promise.resolve(true),
): Promise<string> {
  const existant = storage.getItem(STORAGE_KEY);
  if (bienForme(existant) && (await verify(existant))) {
    return existant;
  }
  const neuf = await mint();
  storage.setItem(STORAGE_KEY, neuf);
  return neuf;
}

/** Le jeton en octets, pour `encodeHello`. Leve si le texte est mal forme. */
export function tokenBytes(text: string): Uint8Array {
  if (text.length !== TEXT_LENGTH) {
    throw new Error(`jeton de ${text.length} caracteres, ${TEXT_LENGTH} attendus`);
  }
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  if (out.length !== TOKEN_BYTES) {
    throw new Error(`jeton de ${out.length} octets, ${TOKEN_BYTES} attendus`);
  }
  return out;
}
