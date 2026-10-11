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
 *
 * ⚠️ **Le rendu de `mint` est valide avant d'etre stocke.** Une reponse
 * serveur mal formee (`{}`, par exemple) ecrirait sinon la chaine litterale
 * "undefined" dans le `localStorage` du joueur, ce qui `bienForme` detecte
 * mais ne corrigerait plus jamais tant que le navigateur garderait cette
 * valeur. On leve plutot que de stocker.
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
  if (!bienForme(neuf)) {
    throw new Error('mint a rendu un jeton mal forme');
  }
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

/**
 * L'etat d'un compte tel que le serveur le rend (`GET /accounts/me`,
 * `POST /accounts/me/purchases`).
 *
 * ⚠️ **`gold` en TEXTE, jamais en nombre.** `bigint` n'est pas serialisable en
 * JSON, et un nombre JSON perdrait la precision au-dela de 2^53 alors que la
 * colonne tient jusqu'a 2^63. C'est a l'appelant de convertir en `bigint`
 * pour comparer un prix (voir `EtatBoutique` dans `ui/shop.ts`).
 */
export interface CompteEtat {
  gold: string;
  purchases: Record<string, number>;
}

/**
 * Lit le solde et les achats du compte.
 *
 * ⚠️ **Couche RESEAU, et rien d'autre.** `main.ts` dit de lui-meme « le
 * DEMARRAGE, et rien d'autre » : un `fetch` y est mal place. Cette fonction
 * ne decide rien — ni ce qui s'affiche sur un refus (`null`), ni ce qui se
 * passe sur une panne reseau (elle leve, l'appelant decide).
 *
 * `null` sur un `!res.ok` plutot qu'une levee : `main.ts` traite deja une
 * reponse non-OK et une panne reseau de la meme facon (un tiret a l'ecran),
 * donc cette distinction n'a pas besoin de survivre jusqu'a l'appelant.
 */
export async function fetchCompte(apiUrl: string, token: string): Promise<CompteEtat | null> {
  const res = await fetch(`${apiUrl}/accounts/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok ? ((await res.json()) as CompteEtat) : null;
}

/**
 * Le resultat d'un achat : soit le nouvel etat du compte, soit le CODE HTTP
 * du refus — jamais traduit ici en message, c'est `ui/shop.ts#messageAchat`
 * qui distingue 402 (solde insuffisant ou palier maximum : gagner plus d'or)
 * de 409 (conflit : rafraichir et retenter). Voir la doc de `buyItem`
 * (`back/src/accounts.ts`) pour le raisonnement complet.
 */
export type ReponseAchat = ({ ok: true } & CompteEtat) | { ok: false; status: number };

/** Achete le palier suivant d'un article du catalogue (`POST /accounts/me/purchases`). */
export async function acheter(
  apiUrl: string,
  token: string,
  itemId: string,
): Promise<ReponseAchat> {
  const res = await fetch(`${apiUrl}/accounts/me/purchases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ itemId }),
  });
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  const body = (await res.json()) as CompteEtat;
  return { ok: true, gold: body.gold, purchases: body.purchases };
}
