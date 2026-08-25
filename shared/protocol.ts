/**
 * Protocole binaire, jamais de JSON sur la boucle de jeu (§3.6 de la spec).
 *
 * Le choix est pris des le premier jour parce que retrofitter du binaire sur un
 * protocole JSON coute systematiquement plus cher que de commencer binaire.
 *
 * Tout est en little-endian : c'est l'ordre natif de x86 et d'ARM, donc aucun
 * echange d'octets a l'encodage comme au decodage.
 */

export const MSG = {
  WELCOME: 1,
  SNAPSHOT: 2,
  INPUT: 3,
  WAVE_ORDER: 4,
  DEATHS: 5,
  PICKUPS: 6,
  LEVEL_UP: 7,
  RUN_OVER: 8,
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

/**
 * Position d'un joueur telle qu'elle passe sur le fil : quantifiee a l'entier.
 *
 * `hp` et `xp` n'existent pas encore cote serveur (la tache 9 les fait vivre) :
 * cette version cable seulement le transport, `Room` remplit `hp` avec
 * `PLAYER_MAX_HP` et `xp` avec 0.
 */
export interface PlayerSnapshot {
  id: number;
  x: number;
  y: number;
  /** Points de vie, sur un octet. */
  hp: number;
  /** Experience, sur deux octets. */
  xp: number;
}

export interface WelcomeMessage {
  type: typeof MSG.WELCOME;
  playerId: number;
  tick: number;
  /** Graine de la carte d'obstacles : le client la **regenere**, il ne la recoit pas. */
  mapSeed: number;
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

export interface WaveOrderMessage {
  type: typeof MSG.WAVE_ORDER;
  waveId: number;
  spawnTick: number;
  seed: number;
  archetype: number;
  formation: number;
  anchorX: number;
  anchorY: number;
  count: number;
}

/**
 * S -> C : identites mortes ou ramassees pendant ce tick, batchees.
 *
 * `DEATHS` et `PICKUPS` partagent exactement cette forme (voir `encodeIdBatch`
 * / `decodeIdBatch`) : ils ne different que par leur octet de type. Les
 * identites sont **triees en ordre croissant** — c'est l'ordre canonique
 * d'application, celui qui garantit que deux clients recevant le meme lot en
 * tirent des tableaux identiques.
 */
export interface DeathsMessage {
  type: typeof MSG.DEATHS;
  tick: number;
  ids: number[];
}

export interface PickupsMessage {
  type: typeof MSG.PICKUPS;
  tick: number;
  ids: number[];
}

export type Message =
  | WelcomeMessage
  | SnapshotMessage
  | InputMessage
  | WaveOrderMessage
  | DeathsMessage
  | PickupsMessage;

export const WELCOME_BYTES = 10;
export const INPUT_BYTES = 5;
export const SNAPSHOT_HEADER_BYTES = 6;
export const SNAPSHOT_PLAYER_BYTES = 8;
export const WAVE_ORDER_BYTES = 19;

/** En-tete commun a `DEATHS` et `PICKUPS` : type u8, tick u32, count u16. */
export const DEATHS_HEADER_BYTES = 7;
/** Une identite d'entite, sur le fil : u32. */
export const DEATH_ID_BYTES = 4;

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

/** S -> C : positions des joueurs, 6 octets d'en-tete puis 8 par joueur. */
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
    v.setUint8(o + 5, p.hp);
    v.setUint16(o + 6, p.xp, true);
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
      hp: v.getUint8(o + 5),
      xp: v.getUint16(o + 6, true),
    });
    o += SNAPSHOT_PLAYER_BYTES;
  }

  return { type: MSG.SNAPSHOT, tick: v.getUint32(1, true), players };
}

/**
 * Coeur commun de `DEATHS` et `PICKUPS` : `type u8 · tick u32 · count u16 ·
 * id u32 x count`. Les deux messages ne different que par leur octet de type,
 * factoriser evite de dupliquer un decalage d'octet dans deux fonctions.
 *
 * Les identites sont triees en ordre croissant a l'encodage : c'est l'ordre
 * canonique d'application (voir `DeathsMessage`), impose ici plutot que
 * laisse a la discretion de chaque appelant.
 */
function encodeIdBatch(type: number, tick: number, ids: readonly number[]): ArrayBuffer {
  const sorted = [...ids].sort((a, b) => a - b);
  const buf = new ArrayBuffer(DEATHS_HEADER_BYTES + sorted.length * DEATH_ID_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, type);
  v.setUint32(1, tick >>> 0, true);
  v.setUint16(5, sorted.length, true);
  let o = DEATHS_HEADER_BYTES;
  for (const id of sorted) {
    v.setUint32(o, id >>> 0, true);
    o += DEATH_ID_BYTES;
  }
  return buf;
}

function decodeIdBatch(buf: ArrayBuffer): { tick: number; ids: number[] } {
  const head = viewOf(buf, DEATHS_HEADER_BYTES);
  const count = head.getUint16(5, true);
  // Comme pour le snapshot : on confronte le compte annonce a la taille
  // reelle du buffer avant de boucler, plutot que de lire hors des bornes.
  const v = viewOf(buf, DEATHS_HEADER_BYTES + count * DEATH_ID_BYTES);

  const ids: number[] = [];
  let o = DEATHS_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    ids.push(v.getUint32(o, true));
    o += DEATH_ID_BYTES;
  }

  return { tick: v.getUint32(1, true), ids };
}

/** S -> C : identites mortes ce tick. Voir `encodeIdBatch`. */
export function encodeDeaths(tick: number, ids: readonly number[]): ArrayBuffer {
  return encodeIdBatch(MSG.DEATHS, tick, ids);
}

export function decodeDeaths(buf: ArrayBuffer): DeathsMessage {
  return { type: MSG.DEATHS, ...decodeIdBatch(buf) };
}

/** S -> C : orbes ramasses ce tick. Voir `encodeIdBatch`. */
export function encodePickups(tick: number, ids: readonly number[]): ArrayBuffer {
  return encodeIdBatch(MSG.PICKUPS, tick, ids);
}

export function decodePickups(buf: ArrayBuffer): PickupsMessage {
  return { type: MSG.PICKUPS, ...decodeIdBatch(buf) };
}

/**
 * S -> C, a la connexion : l'identifiant attribue, le tick courant du salon et
 * la graine de la carte d'obstacles.
 */
export function encodeWelcome(playerId: number, tick: number, mapSeed: number): ArrayBuffer {
  const buf = new ArrayBuffer(WELCOME_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.WELCOME);
  v.setUint8(1, playerId);
  v.setUint32(2, tick >>> 0, true);
  v.setUint32(6, mapSeed >>> 0, true);
  return buf;
}

export function decodeWelcome(buf: ArrayBuffer): WelcomeMessage {
  const v = viewOf(buf, WELCOME_BYTES);
  return {
    type: MSG.WELCOME,
    playerId: v.getUint8(1),
    tick: v.getUint32(2, true),
    mapSeed: v.getUint32(6, true),
  };
}

/**
 * S -> C : l'ordre de faire apparaitre une vague. 19 octets, **quel que soit le
 * nombre d'entites**.
 *
 * C'est la mise en oeuvre du §3.3 : on ne replique pas la horde, on replique
 * son generateur. Repliquer 1 000 ennemis a 30 Hz couterait ~150 ko/s.
 *
 * Le parametre est un type structurel inline plutot que `WaveOrder` de
 * `shared/waves.ts` : le protocole ne doit pas dependre du module de vagues.
 */
export function encodeWaveOrder(order: {
  waveId: number;
  spawnTick: number;
  seed: number;
  archetype: number;
  formation: number;
  anchorX: number;
  anchorY: number;
  count: number;
}): ArrayBuffer {
  const buf = new ArrayBuffer(WAVE_ORDER_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.WAVE_ORDER);
  v.setUint16(1, order.waveId & 0xffff, true);
  v.setUint32(3, order.spawnTick >>> 0, true);
  v.setUint32(7, order.seed >>> 0, true);
  v.setUint8(11, order.archetype);
  v.setUint8(12, order.formation);
  v.setInt16(13, Math.round(order.anchorX), true);
  v.setInt16(15, Math.round(order.anchorY), true);
  v.setUint16(17, order.count & 0xffff, true);
  return buf;
}

export function decodeWaveOrder(buf: ArrayBuffer): WaveOrderMessage {
  const v = viewOf(buf, WAVE_ORDER_BYTES);
  return {
    type: MSG.WAVE_ORDER,
    waveId: v.getUint16(1, true),
    spawnTick: v.getUint32(3, true),
    seed: v.getUint32(7, true),
    archetype: v.getUint8(11),
    formation: v.getUint8(12),
    anchorX: v.getInt16(13, true),
    anchorY: v.getInt16(15, true),
    count: v.getUint16(17, true),
  };
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
    case MSG.WAVE_ORDER:
      return decodeWaveOrder(buf);
    case MSG.DEATHS:
      return decodeDeaths(buf);
    case MSG.PICKUPS:
      return decodePickups(buf);
    default:
      throw new Error(`type de message inconnu : ${type}`);
  }
}
