import { RECONNECT_GRACE_MS } from '@shared/constants';
import { CLOSE_CODES } from '@shared/protocol';

/**
 * Etape 18 : la reprise automatique apres une coupure en run.
 *
 * La page se RECHARGE (un `GameClient` et un `Stage` neufs, gratuitement) et
 * laisse un mot dans `sessionStorage` : le code du salon et l'heure de la
 * coupure. Au demarrage suivant, si la fenetre de grace court encore, `main.ts`
 * rejoint tout seul ; le serveur rend le slot et un `RESYNC` remplit le client.
 *
 * `sessionStorage`, pas `localStorage` : il est PAR ONGLET, deux onglets du
 * meme compte rejoignent chacun leur salon. Chaque acces est sous `try/catch`
 * (navigation privee stricte) : sans mot, pas de reprise automatique, le joueur
 * retape le code — et reprend quand meme son slot, le serveur n'en depend pas.
 */

export const REJOIN_KEY = 'tarnok.rejoin';
/** Entre deux tentatives pendant la reprise (serveur encore injoignable). */
export const REJOIN_RETRY_MS = 2_000;

/** Les fermetures qui ne se retentent pas : le serveur a repondu, et c'est non. */
export const DEFINITIVE_CLOSE_CODES: ReadonlySet<number> = new Set([
  CLOSE_CODES.UNKNOWN_ROOM,
  CLOSE_CODES.ROOM_FULL,
  CLOSE_CODES.UNKNOWN_TOKEN,
  CLOSE_CODES.ROOM_CLOSED,
  CLOSE_CODES.NO_HELLO,
  CLOSE_CODES.BAD_FRAME,
]);

/**
 * Faut-il recharger et rejoindre ? En run, sans l'avoir demande, et sur une
 * fermeture qui n'est pas un refus du serveur (`undefined` : fermee sans code).
 */
export function shouldRejoin(
  code: number | undefined,
  inRun: boolean,
  voluntary: boolean,
): boolean {
  return inRun && !voluntary && (code === undefined || !DEFINITIVE_CLOSE_CODES.has(code));
}

type RejoinStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function rememberRejoin(storage: RejoinStorage, code: string, now: number): void {
  try {
    storage.setItem(REJOIN_KEY, JSON.stringify({ code, since: now }));
  } catch {
    // Stockage indisponible : pas de reprise automatique, et rien de casse.
  }
}

/** Le code a rejoindre si la fenetre court encore ; sinon `null`, et le mot est efface. */
export function readRejoin(storage: RejoinStorage, now: number): string | null {
  try {
    const raw = storage.getItem(REJOIN_KEY);
    if (!raw) {
      return null;
    }
    const mot = JSON.parse(raw) as { code?: unknown; since?: unknown };
    if (
      typeof mot.code === 'string' &&
      typeof mot.since === 'number' &&
      now - mot.since < RECONNECT_GRACE_MS
    ) {
      return mot.code;
    }
    storage.removeItem(REJOIN_KEY);
    return null;
  } catch {
    return null;
  }
}

export function forgetRejoin(storage: RejoinStorage): void {
  try {
    storage.removeItem(REJOIN_KEY);
  } catch {
    // Idem : un stockage qui leve n'empeche pas de quitter.
  }
}

/**
 * « Rejouer ensemble » : au `LOBBY` recu sur le bilan, la page se recharge
 * (un client et une scene neufs, comme la reprise) avec le code du salon ;
 * `main.ts` le lit, l'efface et rejoint. Pas de fenetre : le serveur tient le
 * salon `REPLAY_HOLD_MS`, et un salon ferme repond `UNKNOWN_ROOM` comme a la main.
 */
export const REPLAY_KEY = 'tarnok.replay';

export function writeReplay(storage: RejoinStorage, code: string): void {
  try {
    storage.setItem(REPLAY_KEY, code);
  } catch {
    // Sans mot, le joueur retape le code : le serveur garde son slot.
  }
}

/** Le code a rejoindre, et le mot est efface ; `null` sans mot. */
export function readReplay(storage: RejoinStorage): string | null {
  try {
    const code = storage.getItem(REPLAY_KEY);
    storage.removeItem(REPLAY_KEY);
    return code || null;
  } catch {
    return null;
  }
}
