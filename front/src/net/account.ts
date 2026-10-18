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
 * chargement donnerait un compte neuf, donc un solde a zero, a chaque visite.
 *
 * `storage` est injecte pour tester sans navigateur.
 *
 * ⚠️ **`verify` evite un cul-de-sac.** Un jeton bien forme mais INCONNU du
 * serveur (base reinitialisee, ligne supprimee) resterait sinon stocke pour
 * toujours : la socket serait fermee a chaque tentative, sans rien a l'ecran.
 * Par defaut `verify` accepte tout sans appel reseau.
 *
 * ⚠️ **Le rendu de `mint` est valide avant d'etre stocke.** Une reponse mal
 * formee (`{}`) ecrirait sinon "undefined" dans le `localStorage`. On leve
 * plutot que de stocker.
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
 * Couche RESEAU seulement : elle ne decide rien de l'affichage. `null` sur un
 * refus, levee sur une panne reseau ; `main.ts` traite les deux pareil (un
 * tiret a l'ecran).
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
 * de 409 (conflit : rafraichir et retenter). Voir `buyItem` dans
 * `back/src/accounts.ts`.
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
