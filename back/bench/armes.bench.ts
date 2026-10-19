/**
 * Banc des armes de depart (etape 15).
 *
 * Le joueur ne commence plus forcement avec la dague : il choisit son arme a
 * la salle d'attente (`startingWeapons`). Chaque arme est donc, a tour de
 * role, TOUTE la puissance de feu d'un joueur seul pendant les premieres
 * minutes — et c'est la qu'il faut les comparer, pas sur leur DPS de
 * catalogue (`damage / cooldownTicks`), qui ne dit rien d'une arme de zone,
 * d'un faisceau ou d'une invocation.
 *
 * Meme decor que `kills.bench.ts`, reduit a UN joueur immobile qui vise la
 * menace la plus proche, avec UNE arme : le pipeline reel, le vrai
 * `WaveDirector`, les vrais orbes. On compte les morts par seconde de jeu.
 *
 * ⚠️ **L'arme est mesuree NUE, au niveau 1, sur un joueur qui ne meurt pas**
 * : trois ecritures de test (`debugSetHp`, `debugSetLevel`,
 * `debugResetLoadout`) tiennent le decor constant, et les ticks de gel
 * (montee de niveau, etalage) sont retires de la duree. Voir `unEssai`.
 *
 * ⚠️ **Le joueur est immobile, et ca penalise les armes a PORTEE FIXE** : une
 * frappe (`Canon a arc`) ou un projectile lobe (`Chaudron a poix`) tombe a
 * `beamRange` du tireur, la ou un joueur qui bouge choisit sa distance. Leurs
 * lignes se lisent comme un plancher, pas comme leur valeur en jeu.
 *
 * ⚠️ **Lire la bande, pas le classement.** Le verdict est la part des armes
 * dont les morts/s tiennent dans ±`BANDE` autour de la MEDIANE. Une arme sous
 * la bande est une arme de depart qui condamne la run ; une arme au-dessus,
 * un choix sans alternative. Le reglage est `damage` dans `shared/weapons.ts`
 * — jamais la cadence, qui porte la nature de l'arme.
 *
 *   npm run bench:armes -w back
 */
import { CARD } from '@shared/cards';
import { TICK_HZ } from '@shared/constants';
import { decodeSnapshot } from '@shared/protocol';
import { WEAPONS } from '@shared/weapons';

import { Room } from '../src/room';

const DT = 1 / TICK_HZ;

/** Duree mesuree, en secondes de jeu. */
const SECONDES = 150;
/** Graines de carte tirees d'avance : `Room.mapSeed` fait varier le resultat. */
const GRAINES = [0x1111_1111, 0x3333_3333, 0x5555_5555, 0x7777_7777, 0x9999_9999, 0xbbbb_bbbb];
/** Demi-largeur de la bande autour de la mediane, en fraction. */
const BANDE = 0.25;

function vise(room: Room, playerId: number, seq: number, px: number, py: number): void {
  let bestSlot = -1;
  let bestDist2 = Number.POSITIVE_INFINITY;
  for (let i = 0; i < room.horde.count; i++) {
    const dx = (room.horde.x[i] ?? 0) - px;
    const dy = (room.horde.y[i] ?? 0) - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestSlot = i;
    }
  }
  if (bestSlot < 0) {
    return;
  }
  const dx = (room.horde.x[bestSlot] ?? 0) - px;
  const dy = (room.horde.y[bestSlot] ?? 0) - py;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return;
  }
  room.applyInput(playerId, seq, 0, 0, (dx / len) * 127, (dy / len) * 127);
}

function position(room: Room): { x: number; y: number } {
  const buffers: ArrayBuffer[] = [];
  room.snapshot({ push: (b: ArrayBuffer) => buffers.push(b) });
  const buf = buffers[0];
  const p = buf ? decodeSnapshot(buf).players[0] : undefined;
  return { x: p?.x ?? 0, y: p?.y ?? 0 };
}

interface Mesure {
  morts: number;
  apparitions: number;
  /** Ticks hors gel : la duree qui compte. */
  actifs: number;
  drafts: number;
}

/** Somme des abscisses de la horde : si elle ne bouge pas d'un tick a l'autre, le monde est gele. */
function empreinte(room: Room): number {
  let s = 0;
  for (let i = 0; i < room.horde.count; i++) {
    s += room.horde.x[i] ?? 0;
  }
  return s;
}

function unEssai(seed: number, weaponId: number): Mesure {
  const room = new Room(seed);
  room.join(1, undefined, weaponId);
  const p = position(room);

  let morts = 0;
  let apparitions = 0;
  let actifs = 0;
  let drafts = 0;
  let avantEmpreinte = Number.NaN;
  const ticks = SECONDES * TICK_HZ;
  for (let t = 0; t < ticks; t++) {
    // ⚠️ **Trois ecritures de test qui ISOLENT l'arme** : le joueur ne meurt
    // pas (un joueur immobile seul meurt vers 30 s, et un mort ne tue plus),
    // le niveau reste a 1 (les PV des monstres suivent le niveau depuis
    // l'etape 15 : une arme qui tue vite monterait vite et affronterait des
    // monstres plus gros, ce qui comprimerait les ecarts), et chaque carte
    // draftee est reprise (voir plus bas).
    room.debugSetHp(1, room.maxHpOf(1));
    room.debugSetLevel(1);
    vise(room, 1, t + 1, p.x, p.y);
    const avant = room.horde.count;
    room.step(DT);
    const lot = room.drainDeaths().reduce((n, d) => n + d.ids.length, 0);
    morts += lot;
    apparitions += Math.max(0, room.horde.count - avant + lot);
    // Un tick ou la horde n'a pas bouge est un tick de GEL (montee de niveau,
    // etalage) : il ne compte pas dans la duree mesuree, sinon l'arme qui tue
    // le plus serait celle qui gele le plus.
    const e = empreinte(room);
    if (room.horde.count === 0 || e !== avantEmpreinte) {
      actifs++;
    }
    avantEmpreinte = e;
    room.drainPickups();
    room.drainLevelUps();
    for (const _ of room.drainDraftOpens()) {
      drafts++;
      room.setDraftToken(1, 0);
    }
    if (room.drainDraftResults().length > 0) {
      // La carte prise est reprise : l'arsenal revient a l'arme nue.
      room.debugResetLoadout(1);
      room.grantCard(1, { nature: CARD.WEAPON, refId: weaponId });
    }
    room.drainRunOver();
  }
  return { morts, apparitions, actifs, drafts };
}

interface Ligne {
  arme: string;
  'morts/s': number;
  'morts/app.': number;
  's actives': number;
  drafts: number;
}

function uneArme(weaponId: number): Ligne {
  let morts = 0;
  let apparitions = 0;
  let actifs = 0;
  let drafts = 0;
  for (const seed of GRAINES) {
    const m = unEssai(seed, weaponId);
    morts += m.morts;
    apparitions += m.apparitions;
    actifs += m.actifs;
    drafts += m.drafts;
  }
  const secondes = actifs / TICK_HZ;
  return {
    arme: WEAPONS[weaponId]?.name ?? `#${weaponId}`,
    'morts/s': +(morts / Math.max(1e-9, secondes)).toFixed(2),
    'morts/app.': +(morts / Math.max(1, apparitions)).toFixed(2),
    's actives': Math.round(secondes),
    drafts,
  };
}

function main(): void {
  console.log(
    `Banc des armes de depart — 1 joueur immobile, une arme, ${SECONDES} s de jeu, ` +
      `${GRAINES.length} graines de carte.\n`,
  );
  const lignes = WEAPONS.map((w) => uneArme(w.id));
  const tries = lignes.map((l) => l['morts/s']).sort((a, b) => a - b);
  const mediane = tries[Math.floor(tries.length / 2)] ?? 0;
  const bas = mediane * (1 - BANDE);
  const haut = mediane * (1 + BANDE);
  console.table(
    lignes.map((l) => ({
      ...l,
      bande: l['morts/s'] < bas ? 'sous' : l['morts/s'] > haut ? 'au-dessus' : 'dans',
    })),
  );
  const dedans = lignes.filter((l) => l['morts/s'] >= bas && l['morts/s'] <= haut).length;
  console.log(
    `-> Mediane : ${mediane.toFixed(2)} morts/s — bande [${bas.toFixed(2)}, ${haut.toFixed(2)}] ` +
      `(±${Math.round(BANDE * 100)} %) : ${dedans}/${lignes.length} armes dedans.`,
  );
}

main();
