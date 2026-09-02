/**
 * Banc de la montee au niveau 2 (etape 6a, tache 3, etape 0).
 *
 * Rejoue sur 40 graines de carte le scenario du test « un joueur passif atteint
 * le niveau 2 » de `back/src/room.test.ts` — un joueur IMMOBILE qui vise la
 * menace la plus proche, le pipeline reel, un budget de 100 s — et compte les
 * echecs.
 *
 * ⚠️ **Ce banc existe parce qu'un TEST ne peut pas repondre a la question qu'il
 * pose.** `room.test.ts` joue UNE graine ; ce qu'on veut savoir, c'est la part
 * de graines qui echouent. Les mesures qui ont fixe `HEAVY_FIRST_WAVE` (etape
 * 5a) et `palierHp` (etape 6a) sortent toutes les deux de ce releve, et elles
 * etaient jusqu'ici invérifiables : le script qui les avait produites n'avait
 * pas ete garde (`_probe.ts`, jete a l'etape 3). Celui-ci l'est.
 *
 * | Etat du code | Mediane | Maximum | Echecs |
 * | --- | --- | --- | --- |
 * | avant les paliers (etape 5a) | 40,4 s | 55,1 s | 0/40 |
 * | avec les paliers, sans exemption | 40,9 s | 64,2 s | **1/40** |
 * | avec `palierHp`, boss pas encore reel | 41,3 s | 63,5 s | **0/40** |
 * | + le boss reel a 6 000 PV (tache 3) | 40,8 s | 60,0 s | **3/40** |
 * | **+ les PV par joueur (tache 3 bis, 1 500 PV en solo)** | **40,8 s** | **60,0 s** | **3/40** |
 * | apres la tache 18 (les vagues baissent, la horde encercle) | 42,0 s | 45,3 s | **4/40** |
 * | **+ les cadences accelerees (tache 19)** | **42,5 s** | **45,7 s** | **19/40** |
 *
 * ⚠️ **LA TACHE 19 DEGRADE CE RELEVE, ET SA CAUSE EST MESUREE — ce n'est PAS
 * la cadence.** Le plan attendait l'inverse (*« une cadence plus rapide devrait
 * l'ameliorer — si elle l'aggrave, c'est qu'on a casse autre chose »*). L'autre
 * chose existe, elle est ancienne, et elle n'a rien a voir avec le tir : **une
 * arme plus forte tue PLUS LOIN, et le butin reste ou l'ennemi tombe.** Meme
 * decor qu'ici, dix graines, 45 s, un joueur immobile :
 *
 * | Cadence de la dague | Morts | Distance moyenne de mort | Ramassages | Orbes restes au sol |
 * | --- | --- | --- | --- | --- |
 * | 7 (avant) | 692 | 298 px | **27** | 162 |
 * | 5 | 759 | 326 px | 22 | 189 |
 * | **4 (apres)** | **797** | **341 px** | **15** | **205** |
 *
 * Le joueur tue 15 % de plus et ramasse 44 % de moins : les orbes tombent
 * au-dela d'`ORB_PICKUP_RADIUS` (90 px) et **rien ne va les chercher** — il n'y
 * a aucune aimantation de JEU, la capture de la tache 20 de l'etape 5a est un
 * effet de rendu. Le releve ci-dessus est donc anti-correle a la puissance des
 * armes tant que le joueur ne bouge pas : deja 9/40 a 6 ticks de recharge, soit
 * −14 % de cadence.
 *
 * ⚠️ **La mediane ne bouge pas (42,0 -> 42,5 s), le MAXIMUM non plus (45,3 ->
 * 45,7 s).** Les quinze pertes sont des graines ou le niveau 2 arrivait deja
 * apres 45 s et ou la run se perd a 47-51 s : la queue de la distribution passe
 * de l'autre cote d'une falaise fixee par le calendrier des vagues, pas un
 * ralentissement general. **Signale, pas tranche ici** : ce qui se regle est le
 * RAYON DE RAMASSAGE (ou une aimantation de jeu), pas la cadence, et cela
 * appartient a l'auteur.
 *
 * ⚠️ **Les deux premieres lignes de boss n'ont PAS la meme cause que les
 * precedentes.** `palierHp` solde la marche de durabilite (1/40 -> 0/40, a boss
 * constant). Le 3/40 vient du boss, qui apparait a 30 s sur toutes les graines
 * et que le joueur SEUL prend pour cible — c'est la menace la plus proche.
 *
 * ⚠️ **ET LA TACHE 3 BIS NE LE BOUGE PAS : 3/40 -> 3/40, aux memes graines
 * (8, 10, 31) et a la seconde pres.** Diviser le boss solo par quatre
 * (6 000 -> 1 500 PV) ne change RIEN a ce releve, et il faut le dire plutot que
 * de laisser croire a un correctif : a la dague seule (~21 degats/s au niveau
 * 1), 1 500 PV demandent encore 70 s quand la run est perdue a 50-60 s.
 *
 * **Deux mesures de controle, faites pour ne pas supposer la cause** :
 *
 * | Decor | Echecs |
 * | --- | --- |
 * | aucun boss du tout (`WAVES_PER_PALIER` porte a 1000) | **0/40** |
 * | boss a 100 PV — tue en quelques secondes | **2/40** |
 * | boss a 1 500 PV (solo, aujourd'hui) ou a 6 000 (hier) | **3/40** |
 *
 * ⚠️ **Ce que ces trois lignes disent, et qui contredit le plan** : le plan de
 * la tache 3 bis attribue les trois pertes aux *« 6 000 PV qu'il ne percera
 * pas »*. La mesure dit **deux tiers presence, un tiers reserve** — deux
 * graines sur trois tombent avec un boss qu'on tue en quelques secondes. Ce que
 * coute un boss a un joueur seul, c'est d'abord d'EXISTER : un corps de plus
 * qui capte le tir automatique, et un palier qui avance quand il tombe. La
 * reserve n'ajoute qu'une graine.
 *
 *   npm run bench:niveau2 -w back
 */
import { TICK_HZ } from '@shared/constants';
import { decodeSnapshot } from '@shared/protocol';

import { Room } from '../src/room';

const DT = 1 / TICK_HZ;
const BUDGET = TICK_HZ * 100;

function positionOf(room: Room, id: number): { x: number; y: number } {
  const buffers: ArrayBuffer[] = [];
  room.snapshot({ push: (b: ArrayBuffer) => buffers.push(b) });
  const buf = buffers[0];
  const found = buf ? decodeSnapshot(buf).players.find((p) => p.id === id) : undefined;
  return { x: found?.x ?? 0, y: found?.y ?? 0 };
}

function vise(room: Room, playerId: number, seq: number): void {
  const pos = positionOf(room, playerId);
  let bestSlot = -1;
  let bestDist2 = Number.POSITIVE_INFINITY;
  for (let i = 0; i < room.horde.count; i++) {
    const dx = (room.horde.x[i] ?? 0) - pos.x;
    const dy = (room.horde.y[i] ?? 0) - pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestSlot = i;
    }
  }
  if (bestSlot < 0) {
    return;
  }
  const dx = (room.horde.x[bestSlot] ?? 0) - pos.x;
  const dy = (room.horde.y[bestSlot] ?? 0) - pos.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return;
  }
  room.applyInput(playerId, seq, 0, 0, (dx / len) * 127, (dy / len) * 127);
}

interface Essai {
  ticks: number;
  palier: number;
  perdue: boolean;
  /** Tick auquel le boss du palier 0 est apparu, `-1` s'il n'est jamais venu. */
  tickBoss: number;
  /** Tick auquel la run a ete perdue, `-1` sinon. */
  tickPerte: number;
}

function unEssai(seed: number): Essai {
  const room = new Room(seed);
  room.join(1);
  let perdue = false;
  let tickBoss = -1;
  let tickPerte = -1;
  for (let i = 0; i < BUDGET; i++) {
    vise(room, 1, i + 1);
    room.step(DT);
    room.drainDeaths();
    room.drainPickups();
    if (tickBoss < 0 && room.bossEntityId !== null) {
      tickBoss = i + 1;
    }
    if (room.drainRunOver()) {
      perdue = true;
      tickPerte = i + 1;
    }
    const ups = room.drainLevelUps();
    if (ups.length > 0) {
      return { ticks: i + 1, palier: room.palier, perdue, tickBoss, tickPerte };
    }
  }
  return { ticks: -1, palier: room.palier, perdue, tickBoss, tickPerte };
}

const lignes: Record<string, unknown>[] = [];
const temps: number[] = [];
let echecs = 0;
for (let seed = 1; seed <= 40; seed++) {
  const m = unEssai(seed);
  if (m.ticks < 0) {
    echecs++;
  } else {
    temps.push(m.ticks / TICK_HZ);
  }
  lignes.push({
    graine: seed,
    's jusqu au niveau 2': m.ticks < 0 ? 'ECHEC' : +(m.ticks / TICK_HZ).toFixed(1),
    palier: m.palier,
    'boss a (s)': m.tickBoss < 0 ? '—' : +(m.tickBoss / TICK_HZ).toFixed(1),
    'run perdue a (s)': m.tickPerte < 0 ? '' : +(m.tickPerte / TICK_HZ).toFixed(1),
  });
}
console.table(lignes);
temps.sort((a, b) => a - b);
const mediane = temps.length > 0 ? temps[Math.floor(temps.length / 2)] : Number.NaN;
console.log(
  `-> echecs ${echecs}/40 — mediane ${mediane?.toFixed(1)} s, maximum ${temps[temps.length - 1]?.toFixed(1)} s`,
);
