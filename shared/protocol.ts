/**
 * Protocole binaire, jamais de JSON sur la boucle de jeu (§3.6 de la spec).
 *
 * Le choix est pris des le premier jour parce que retrofitter du binaire sur un
 * protocole JSON coute systematiquement plus cher que de commencer binaire.
 *
 * Tout est en little-endian : c'est l'ordre natif de x86 et d'ARM, donc aucun
 * echange d'octets a l'encodage comme au decodage.
 */

export const MSG = { WELCOME: 1, SNAPSHOT: 2, INPUT: 3 } as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

/** Position d'un joueur telle qu'elle passe sur le fil : quantifiee a l'entier. */
export interface PlayerSnapshot {
  id: number;
  x: number;
  y: number;
}

export interface WelcomeMessage {
  type: typeof MSG.WELCOME;
  playerId: number;
  tick: number;
}

export interface SnapshotMessage {
  type: typeof MSG.SNAPSHOT;
  tick: number;
  players: PlayerSnapshot[];
}

export interface InputMessage {
  type: typeof MSG.INPUT;
  seq: number;
  moveX: number;
  moveY: number;
}

export type Message = WelcomeMessage | SnapshotMessage | InputMessage;

export const WELCOME_BYTES = 6;
export const INPUT_BYTES = 5;
export const SNAPSHOT_HEADER_BYTES = 6;
export const SNAPSHOT_PLAYER_BYTES = 5;

/**
 * Ouvre une vue sur le buffer en exigeant une taille minimale.
 *
 * C'est le seul endroit ou l'on refuse un buffer court, et il n'existe que pour
 * ca : un decodeur qui lit au-dela de la fin rend des valeurs fantaisistes au
 * lieu de lever, et on passe ensuite des heures a chercher une bogue de gameplay
 * la ou il y a une bogue de cadrage reseau.
 */
function viewOf(buf: ArrayBuffer, minBytes: number): DataView {
  if (buf.byteLength < minBytes) {
    throw new Error(`message tronque : ${buf.byteLength} octets recus, ${minBytes} attendus`);
  }
  return new DataView(buf);
}

function clampAxis(v: number): number {
  const r = Math.round(v);
  if (r > 127) {
    return 127;
  }
  if (r < -127) {
    return -127;
  }
  return r;
}

/** C -> S : une entree, 5 octets. */
export function encodeInput(seq: number, moveX: number, moveY: number): ArrayBuffer {
  const buf = new ArrayBuffer(INPUT_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.INPUT);
  v.setUint16(1, seq & 0xffff, true);
  v.setInt8(3, clampAxis(moveX));
  v.setInt8(4, clampAxis(moveY));
  return buf;
}

export function decodeInput(buf: ArrayBuffer): InputMessage {
  const v = viewOf(buf, INPUT_BYTES);
  return {
    type: MSG.INPUT,
    seq: v.getUint16(1, true),
    moveX: v.getInt8(3),
    moveY: v.getInt8(4),
  };
}

/** S -> C : positions des joueurs, 6 octets d'en-tete puis 5 par joueur. */
export function encodeSnapshot(tick: number, players: readonly PlayerSnapshot[]): ArrayBuffer {
  const buf = new ArrayBuffer(SNAPSHOT_HEADER_BYTES + players.length * SNAPSHOT_PLAYER_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint32(1, tick >>> 0, true);
  v.setUint8(5, players.length);
  let o = SNAPSHOT_HEADER_BYTES;
  for (const p of players) {
    v.setUint8(o, p.id);
    v.setInt16(o + 1, Math.round(p.x), true);
    v.setInt16(o + 3, Math.round(p.y), true);
    o += SNAPSHOT_PLAYER_BYTES;
  }
  return buf;
}

export function decodeSnapshot(buf: ArrayBuffer): SnapshotMessage {
  const head = viewOf(buf, SNAPSHOT_HEADER_BYTES);
  const count = head.getUint8(5);
  // Le nombre de joueurs vient du buffer : on le confronte a sa taille reelle
  // avant de boucler, sinon un en-tete menteur fait lire hors des bornes.
  const v = viewOf(buf, SNAPSHOT_HEADER_BYTES + count * SNAPSHOT_PLAYER_BYTES);

  const players: PlayerSnapshot[] = [];
  let o = SNAPSHOT_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    players.push({
      id: v.getUint8(o),
      x: v.getInt16(o + 1, true),
      y: v.getInt16(o + 3, true),
    });
    o += SNAPSHOT_PLAYER_BYTES;
  }

  return { type: MSG.SNAPSHOT, tick: v.getUint32(1, true), players };
}

/** S -> C, a la connexion : l'identifiant attribue et le tick courant du salon. */
export function encodeWelcome(playerId: number, tick: number): ArrayBuffer {
  const buf = new ArrayBuffer(WELCOME_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.WELCOME);
  v.setUint8(1, playerId);
  v.setUint32(2, tick >>> 0, true);
  return buf;
}

export function decodeWelcome(buf: ArrayBuffer): WelcomeMessage {
  const v = viewOf(buf, WELCOME_BYTES);
  return { type: MSG.WELCOME, playerId: v.getUint8(1), tick: v.getUint32(2, true) };
}

/** Lit le premier octet et aiguille. */
export function decode(buf: ArrayBuffer): Message {
  const v = viewOf(buf, 1);
  const type = v.getUint8(0);
  switch (type) {
    case MSG.WELCOME:
      return decodeWelcome(buf);
    case MSG.SNAPSHOT:
      return decodeSnapshot(buf);
    case MSG.INPUT:
      return decodeInput(buf);
    default:
      throw new Error(`type de message inconnu : ${type}`);
  }
}
