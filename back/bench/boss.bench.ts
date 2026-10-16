/**
 * Banc du boss — combien de temps quatre joueurs mettent a tuer le boss du
 * palier 0. Les trois issues sont fixees AVANT la mesure :
 *
 * | Issue | Ce qu'on fait |
 * | --- | --- |
 * | il meurt en **30 a 90 s** | **on garde** |
 * | moins de **15 s** | on monte `BOSS_HP_PER_PLAYER`, **pas la formule** |
 * | plus de **3 min** | on baisse `BOSS_HP_PER_PLAYER`, **et on rouvre `PALIER_HP_SCALE`** |
 *
 * ⚠️ **UN BANC QUI NE PEUT RIEN MESURER REND ZERO ET PARAIT VERT.** Ce banc
 * mesure donc DEUX scenarios, et le premier existe pour valider le second :
 *
 * - **le duel** : le boss seul, la horde balayee a chaque tick, quatre joueurs
 *   qui ne visent que lui. C'est le PLANCHER — la mise a mort la plus rapide
 *   que ce jeu puisse produire au palier 0. Si ce chiffre etait nul ou infini,
 *   rien de ce qui suit n'aurait de sens ;
 * - **la melee** : le pipeline reel, vrai `WaveDirector`, vraies vagues qui
 *   continuent de tomber pendant le combat, vrais orbes, vrais
 *   drafts. C'est LUI qui repond a la porte, parce que c'est lui qui decrit un
 *   palier.
 *
 * Chaque ligne porte de quoi refuser le chiffre : les PV du boss a
 * l'apparition, ceux qu'il lui reste a la fin, et si la run a ete perdue en
 * route. **Une ligne dont le boss n'a pas perdu de PV n'est pas une mesure
 * rapide, c'est une mesure fausse.**
 *
 *   npm run bench:boss -w back
 */
import { archetypeOf, BOSS_ARCHETYPE, BOSS_HP_PER_PLAYER } from '@shared/archetypes';
import { CARD } from '@shared/cards';
import { MAP_SIZE, MAX_ENTITIES, TICK_HZ } from '@shared/constants';
import { entityIdOf } from '@shared/horde';
import { bossHp, palierHp, waveCountScale } from '@shared/paliers';
import { PASSIVES } from '@shared/passives';
import { decodeSnapshot } from '@shared/protocol';
import { FORMATION } from '@shared/waves';

import { Room } from '../src/room';
import { waveCountBounds } from '../src/wave-director';

const DT = 1 / TICK_HZ;

/** Plafond de patience, en secondes de jeu : bien au-dela des 3 min de la porte. */
const SECONDES_MAX = 300;

/** Graines de carte tirees d'avance — meme convention que `kills.bench.ts`. */
const GRAINES = [
  0x1111_1111, 0x2222_2222, 0x3333_3333, 0x4444_4444, 0x5555_5555, 0x6666_6666, 0x7777_7777,
  0x8888_8888,
];

const JOUEURS = [1, 2, 3, 4];

/**
 * Cartes de vitalite posees d'office sur chaque joueur du scenario de melee.
 *
 * ⚠️ **LES JOUEURS SONT INCREVABLES, ET C'EST UNE DECISION DE DECOR.** La
 * question est *« combien de temps pour tuer le boss »*, pas *« survivent-ils »*.
 * Sans ces cartes, quatre joueurs IMMOBILES perdent leur run avant que le boss
 * ne tombe sur toutes les graines. Un vrai joueur se deplace ; ce banc ne sait
 * pas le faire, alors il enleve la mort du chemin.
 *
 * ⚠️ **La vitalite ne touche QUE `maxHp`** (`shared/passives.ts`) : ni la
 * cadence, ni les degats, ni la vitesse. Le rythme de mise a mort mesure donc
 * bien l'arsenal reel, pas un arsenal dope par le decor.
 */
const VITALITE = PASSIVES.find((p) => p.kind === 'maxHp')?.id ?? -1;
const CARTES_DE_VITALITE = 500;

interface Position {
  x: number;
  y: number;
}

/** Positions des joueurs, lues une fois au depart (ils ne bougent jamais). */
function positions(room: Room): Position[] {
  const buffers: ArrayBuffer[] = [];
  room.snapshot({ push: (b: ArrayBuffer) => buffers.push(b) });
  const buf = buffers[0];
  return buf ? decodeSnapshot(buf).players.map((p) => ({ x: p.x, y: p.y })) : [];
}

/**
 * Vise une entite precise si elle vit, la menace la plus proche sinon.
 *
 * ⚠️ **Viser le boss est le geste qu'on mesure, et il faut le dire** : un
 * projectile est consomme par la PREMIERE entite qu'il rencontre sur son
 * segment (`Projectiles.collide`), donc la horde entre le joueur et le boss en
 * absorbe une partie. C'est voulu — c'est ce qu'est un combat de boss dans un
 * bullet heaven — et c'est exactement l'ecart que le scenario du duel isole.
 */
function vise(room: Room, playerId: number, seq: number, p: Position, cible: number | null): void {
  let slot = cible === null ? -1 : room.horde.slotOf(cible);
  if (slot < 0) {
    let bestDist2 = Number.POSITIVE_INFINITY;
    for (let i = 0; i < room.horde.count; i++) {
      const dx = (room.horde.x[i] ?? 0) - p.x;
      const dy = (room.horde.y[i] ?? 0) - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        slot = i;
      }
    }
  }
  if (slot < 0) {
    return;
  }
  const dx = (room.horde.x[slot] ?? 0) - p.x;
  const dy = (room.horde.y[slot] ?? 0) - p.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return;
  }
  room.applyInput(playerId, seq, 0, 0, (dx / len) * 127, (dy / len) * 127);
}

/**
 * Ferme l'etalage, sinon on mesure un monde GELE : un draft gele le monde
 * jusqu'a l'echeance, 20 s plus tard.
 */
function fermerLesDrafts(room: Room): void {
  for (const ouverture of room.drainDraftOpens()) {
    const cartes = ouverture.cards.length;
    for (let k = 0; k < JOUEURS.length && cartes > 0; k++) {
      room.setDraftToken(JOUEURS[k] ?? 0, k % cartes);
    }
  }
  room.drainDraftResults();
}

/** Retire de la horde tout sauf `garder` — `Horde.kill` court-circuite le salon. */
function viderSauf(room: Room, garder: number): void {
  const ids: number[] = [];
  for (let i = 0; i < room.horde.count; i++) {
    const id = room.horde.entityIdAt(i);
    if (id !== garder) {
      ids.push(id);
    }
  }
  if (ids.length > 0) {
    room.horde.kill(ids);
  }
}

function pvDuBoss(room: Room, bossId: number): number {
  const slot = room.horde.slotOf(bossId);
  return slot < 0 ? 0 : (room.horde.hp[slot] ?? 0);
}

interface Mesure {
  /** Secondes de jeu entre l'apparition du boss et sa mort. `-1` : jamais mort. */
  secondes: number;
  pvApparition: number;
  pvRestants: number;
  /** Morts de pietaille pendant le combat — dit ce que la melee a coute en tirs. */
  mortsAutour: number;
  /** Effectif moyen de la horde pendant le combat. */
  hordeMoyenne: number;
  runPerdue: boolean;
}

/**
 * SCENARIO A — le duel. Le boss seul, pose a portee, la horde balayee a chaque
 * tick. **Le plancher**, et la preuve que ce decor sait tuer un boss.
 */
function duel(seed: number): Mesure {
  const room = new Room(seed);
  for (const id of JOUEURS) {
    room.join(id);
  }
  const p = positions(room);
  const ancre = p[0] ?? { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };

  const bossId = entityIdOf(9000, 0);
  room.horde.spawn({
    waveId: 9000,
    spawnTick: room.tick,
    seed: 7,
    archetype: BOSS_ARCHETYPE,
    formation: FORMATION.CLUSTER,
    anchorX: Math.round(ancre.x),
    anchorY: Math.round(ancre.y),
    count: 1,
  });
  // ⚠️ **`Horde.spawn` court-circuite le salon, donc l'echelle du palier ET la
  // multiplication par le nombre de joueurs.** Sans cette ligne, le duel
  // mesurerait un boss de `BOSS_HP_PER_PLAYER` — le quart de celui que la
  // melee affronte — et son « plancher » ne serait plus le plancher de rien.
  const slotNeuf = room.horde.slotOf(bossId);
  room.horde.hp[slotNeuf] = bossHp(0, JOUEURS.length);
  const pvApparition = pvDuBoss(room, bossId);

  let ticks = 0;
  const plafond = SECONDES_MAX * TICK_HZ;
  while (ticks < plafond && room.horde.slotOf(bossId) >= 0) {
    // ⚠️ **Le boss est REPOSE a distance de tir a chaque tick** : sinon il
    // marche sur les joueurs, les tue, et le banc mesure une fin de run.
    const slot = room.horde.slotOf(bossId);
    room.horde.x[slot] = ancre.x + 120;
    room.horde.y[slot] = ancre.y;
    viderSauf(room, bossId);
    for (let k = 0; k < JOUEURS.length; k++) {
      const pos = p[k];
      if (pos) {
        vise(room, JOUEURS[k] ?? 0, ticks + 1, pos, bossId);
      }
    }
    room.step(DT);
    room.drainDeaths();
    room.drainPickups();
    fermerLesDrafts(room);
    ticks++;
  }

  return {
    secondes: room.horde.slotOf(bossId) >= 0 ? -1 : ticks / TICK_HZ,
    pvApparition,
    pvRestants: pvDuBoss(room, bossId),
    mortsAutour: 0,
    hordeMoyenne: 1,
    runPerdue: false,
  };
}

/**
 * SCENARIO B — la melee. **C'est lui qui repond a la porte.** Pipeline reel de
 * bout en bout : rien n'est pose a la main, le boss arrive quand le directeur
 * le decide, et les vagues continuent de tomber pendant le combat.
 */
function melee(seed: number): Mesure {
  const room = new Room(seed);
  for (const id of JOUEURS) {
    room.join(id);
    for (let n = 0; n < CARTES_DE_VITALITE; n++) {
      room.grantCard(id, { nature: CARD.PASSIVE, refId: VITALITE });
    }
  }
  const p = positions(room);

  let bossId: number | null = null;
  let pvApparition = 0;
  let tickApparition = -1;
  let mortsAutour = 0;
  let sommeHorde = 0;
  let ticksDeCombat = 0;
  let runPerdue = false;
  let tickMort = -1;

  const plafond = SECONDES_MAX * TICK_HZ;
  for (let t = 0; t < plafond && tickMort < 0 && !runPerdue; t++) {
    for (let k = 0; k < JOUEURS.length; k++) {
      const pos = p[k];
      if (pos) {
        vise(room, JOUEURS[k] ?? 0, t + 1, pos, bossId);
      }
    }
    room.step(DT);

    const lot = room.drainDeaths().reduce((n, d) => n + d.ids.length, 0);
    room.drainPickups();
    fermerLesDrafts(room);
    if (room.drainRunOver()) {
      runPerdue = true;
    }

    // L'apparition se lit APRES `step` : c'est `step` qui fait naitre le boss.
    if (bossId === null && room.bossEntityId !== null) {
      bossId = room.bossEntityId;
      pvApparition = pvDuBoss(room, bossId);
      tickApparition = t;
    } else if (bossId !== null) {
      mortsAutour += lot;
      sommeHorde += room.horde.count;
      ticksDeCombat++;
      if (room.horde.slotOf(bossId) < 0) {
        tickMort = t;
      }
    }
  }

  return {
    secondes: tickMort < 0 ? -1 : (tickMort - tickApparition) / TICK_HZ,
    pvApparition,
    pvRestants: bossId === null ? 0 : pvDuBoss(room, bossId),
    mortsAutour,
    hordeMoyenne: ticksDeCombat > 0 ? sommeHorde / ticksDeCombat : 0,
    runPerdue,
  };
}

function ligne(seed: number, m: Mesure): Record<string, unknown> {
  return {
    graine: `0x${seed.toString(16)}`,
    's pour tuer le boss': m.secondes < 0 ? '— (jamais)' : +m.secondes.toFixed(1),
    'PV a l apparition': Math.round(m.pvApparition),
    'PV restants': Math.round(m.pvRestants),
    'morts autour': m.mortsAutour,
    'horde moyenne': Math.round(m.hordeMoyenne),
    'run perdue': m.runPerdue ? 'OUI' : '',
  };
}

function resume(nom: string, mesures: Mesure[]): number {
  const valides = mesures.filter((m) => m.secondes >= 0 && !m.runPerdue);
  if (valides.length === 0) {
    console.log(`-> ${nom} : AUCUNE MESURE VALIDE — le decor n'a rien produit.`);
    return Number.NaN;
  }
  const temps = valides.map((m) => m.secondes).sort((a, b) => a - b);
  const mediane = temps[Math.floor(temps.length / 2)] ?? Number.NaN;
  console.log(
    `-> ${nom} : mediane ${mediane.toFixed(1)} s, min ${temps[0]?.toFixed(1)} s, ` +
      `max ${temps[temps.length - 1]?.toFixed(1)} s, sur ${valides.length}/${mesures.length} mesures valides`,
  );
  return mediane;
}

function verdict(mediane: number): void {
  if (Number.isNaN(mediane)) {
    console.log('VERDICT : indeterminable — le banc ne mesure rien, ne pas croire son chiffre.');
    return;
  }
  if (mediane < 15) {
    console.log(
      `VERDICT : ${mediane.toFixed(1)} s < 15 s -> ON MONTE BOSS_HP_PER_PLAYER, pas la formule.`,
    );
  } else if (mediane > 180) {
    console.log(
      `VERDICT : ${mediane.toFixed(1)} s > 3 min -> ON BAISSE BOSS_HP_PER_PLAYER, et on rouvre PALIER_HP_SCALE.`,
    );
  } else if (mediane >= 30 && mediane <= 90) {
    console.log(`VERDICT : ${mediane.toFixed(1)} s, dans la bande 30-90 s -> ON GARDE.`);
  } else {
    console.log(
      `VERDICT : ${mediane.toFixed(1)} s — hors de la bande 30-90 s mais dans aucune des deux ` +
        'issues correctives (15 s - 3 min). Le §7 ne tranche pas ce cas : a signaler.',
    );
  }
}

function main(): void {
  console.log(
    `Banc du boss — 4 joueurs immobiles, palier 0, ${GRAINES.length} graines de carte.\n` +
      `BOSS_HP_PER_PLAYER = ${BOSS_HP_PER_PLAYER} par joueur, soit ` +
      `${bossHp(0, JOUEURS.length)} PV a ${JOUEURS.length} joueurs au palier 0 ` +
      `(${bossHp(0, JOUEURS.length) / archetypeOf(0).hp}x la pietaille legere, ` +
      `archetype ${BOSS_ARCHETYPE} « ${archetypeOf(BOSS_ARCHETYPE).name} »).\n`,
  );

  console.log('--- SCENARIO A : le duel (plancher, et validation du decor)');
  const duels = GRAINES.map((s) => {
    const m = duel(s);
    return { s, m };
  });
  console.table(duels.map(({ s, m }) => ligne(s, m)));
  const medianeDuel = resume(
    'duel',
    duels.map(({ m }) => m),
  );

  console.log('\n--- SCENARIO B : la melee (LA PORTE)');
  const melees = GRAINES.map((s) => {
    const m = melee(s);
    return { s, m };
  });
  console.table(melees.map(({ s, m }) => ligne(s, m)));
  const medianeMelee = resume(
    'melee',
    melees.map(({ m }) => m),
  );

  // ⚠️ **Le controle du decor, ecrit et pas suppose.** Si le boss ne perdait
  // pas de PV en melee, la porte lirait un « jamais mort » qu'elle prendrait
  // pour une difficulte, alors que ce serait un banc aveugle.
  const entames = melees.filter(({ m }) => m.pvApparition > 0 && m.pvRestants < m.pvApparition);
  console.log(
    `\nControle de decor : le boss est entame sur ${entames.length}/${melees.length} graines ; ` +
      `plancher du duel ${Number.isNaN(medianeDuel) ? '—' : `${medianeDuel.toFixed(1)} s`}.`,
  );

  console.log('');
  verdict(medianeMelee);

  // --- La divergence sur dix paliers, sans jouer.
  console.log('\n--- Divergence sur dix paliers (effectif et PV totaux, sans jouer)');
  divergence();
}

/**
 * **La difficulte diverge-t-elle ?**
 *
 * Effectif et PV totaux d'une vague au plafond, palier par palier. Le plafond
 * d'effectif est `waveCountBounds(waveNumber).max` en regime etabli, deja
 * borne a `MAX_ENTITIES` AVANT l'echelle du palier — c'est donc bien
 * `waveCountScale` qui peut le faire deborder, et le test
 * `back/src/wave-director.test.ts` mesure a quel palier.
 *
 * ⚠️ **Les PV totaux ne suivent PAS `hpScale` sur la pietaille legere** : c'est
 * `palierHp` qui decide, d'ou le melange leger/lourd ci-dessous. Une table a un
 * seul archetype ferait croire a une divergence deux fois plus raide, ou deux
 * fois plus plate.
 */
function divergence(): void {
  const LEGER = 0;
  const LOURD = 1;
  const bornes = waveCountBounds(1000);
  // Effectif MOYEN d'une vague en regime etabli — c'est lui qui donne la
  // charge d'un palier ; le plafond, lui, dit ce qui peut deborder au pire.
  const moyen = (bornes.min + bornes.max) / 2;
  const lignes: Record<string, unknown>[] = [];
  for (let k = 0; k <= 10; k++) {
    const echelle = waveCountScale(k);
    const plafond = Math.round(bornes.max * echelle);
    const effectif = moyen * echelle;
    // Mix reel du generateur : une vague sur cinq est lourde (HEAVY_WAVE_SHARE).
    const pvParVague =
      effectif *
      (0.8 * palierHp(archetypeOf(LEGER).hp, k) + 0.2 * palierHp(archetypeOf(LOURD).hp, k));
    lignes.push({
      palier: k,
      'effectif moyen/vague': Math.round(effectif),
      'effectif au plafond': plafond,
      'plafond / MAX_ENTITIES': `${Math.round((100 * plafond) / MAX_ENTITIES)} %`,
      'PV du boss': Math.round(bossHp(k, JOUEURS.length)),
      'PV du palier (4 vagues + boss)': Math.round(4 * pvParVague + bossHp(k, JOUEURS.length)),
      'x palier 0': +((4 * pvParVague + bossHp(k, JOUEURS.length)) / reference(bornes)).toFixed(2),
    });
  }
  console.table(lignes);
  console.log(
    `MAX_ENTITIES = ${MAX_ENTITIES}. Le plafond d'une vague au palier 10 vaut ` +
      `${Math.round(bornes.max * waveCountScale(10))} : le plafond de ` +
      "`waveCountBounds` n'est PAS atteint sur les dix paliers mesures. Ce qui peut " +
      "saturer, c'est la horde ACCUMULEE (voir `RoomMetrics.truncatedSpawns`), pas une vague seule.",
  );
}

/** Charge d'un palier 0, pour la colonne « x palier 0 ». */
function reference(bornes: { min: number; max: number }): number {
  const moyen = (bornes.min + bornes.max) / 2;
  return (
    4 * moyen * (0.8 * archetypeOf(0).hp + 0.2 * archetypeOf(1).hp) + bossHp(0, JOUEURS.length)
  );
}

main();
