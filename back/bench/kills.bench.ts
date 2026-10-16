/**
 * Banc du rythme de mise a mort.
 *
 * Donner des points de vie a la pietaille reduit MECANIQUEMENT le rythme de
 * mise a mort : si les apparitions le depassent trop, la montee de niveau
 * devient inatteignable avant que le joueur ne meure encercle. `sim` ne tue
 * rien ; ce banc mesure le pipeline REEL : quatre joueurs immobiles qui visent
 * la menace la plus proche, le vrai `WaveDirector`, les vrais orbes. On compte
 * les morts par seconde de jeu.
 *
 * Deux decors, parce que quatre joueurs immobiles n'ouvrent jamais d'etalage
 * en 60 s (colonne « drafts ») : sans arme donnee d'avance, le banc ne mesure
 * que la dague. Le decor « arsenal plein » donne `WEAPON_SLOTS` armes du
 * catalogue a chaque joueur, comme `slots.bench.ts`, et c'est le seul qui
 * reponde pour la cadence DU CATALOGUE.
 *
 *   npm run bench:kills -w back
 */
import { archetypeOf, HEAVY_HP } from '@shared/archetypes';
import { CARD } from '@shared/cards';
import { TICK_HZ, WEAPON_SLOTS } from '@shared/constants';
import { decodeSnapshot } from '@shared/protocol';
import { BASE_WEAPON_ID, WEAPONS } from '@shared/weapons';

import { Room } from '../src/room';

const DT = 1 / TICK_HZ;

/**
 * Les deux decors mesures. `armes` est le nombre d'armes DRAFTEES donnees a
 * chaque joueur en plus de l'arme neutre, qui vit hors des slots.
 *
 * ⚠️ Les armes se prennent dans le CATALOGUE, jamais par indice recopie : un
 * `refId` en dur meurt au premier changement de `WEAPON_SLOTS`.
 */
const DECORS = [
  { nom: 'dague seule', armes: 0 },
  { nom: 'arsenal plein', armes: WEAPON_SLOTS },
] as const;

/** Duree mesuree, en secondes de jeu. */
const SECONDES = 60;
/** Graines de carte tirees d'avance : `Room.mapSeed` fait varier le resultat. */
const GRAINES = [
  0x1111_1111, 0x2222_2222, 0x3333_3333, 0x4444_4444, 0x5555_5555, 0x6666_6666, 0x7777_7777,
  0x8888_8888, 0x9999_9999, 0xaaaa_aaaa, 0xbbbb_bbbb, 0xcccc_cccc,
];

/**
 * Vise la menace la plus proche, sans bouger les pieds — le meme geste que le
 * test « un joueur passif atteint le niveau 2 » de `room.test.ts`. La visee est
 * une entree joueur : sans elle, personne ne tire.
 */
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

interface Mesure {
  morts: number;
  apparitions: number;
  hordeFinale: number;
  /** Part de pietaille lourde dans la horde encore debout a la fin. */
  partLourde: number;
  premiereMort: number;
  /**
   * Objets au sol au pic de la fenetre mesuree, et objets qu'une reserve pleine
   * a refuses. `OrbField` tient orbes ET pieces : le pic compte tout ce qui
   * traine, ce que la capacite doit couvrir.
   *
   * ⚠️ C'est ce banc, et lui seul, qui dit si la CAPACITE tient : sans
   * expiration, elle est la seule borne de `OrbField`, et elle tronque en
   * silence.
   */
  orbesMax: number;
  orbesTronques: number;
  /**
   * Salves qu'une file de projectiles pleine a refusees, et pic de projectiles
   * vivants.
   *
   * ⚠️ **La cadence est le levier de premier ordre de ces deux nombres** :
   * `PROJECTILE_CAPACITY` est dimensionnee sur
   * `salvoCount × ceil(vie / cadence)`, donc diviser la cadence par deux double
   * le produit. Sans ce releve, une acceleration du catalogue pourrait tronquer
   * des salves en silence — une carte payee pour rien.
   */
  projectilesMax: number;
  projectilesTronques: number;
  /**
   * Etalages ouverts pendant la fenetre mesuree.
   *
   * ⚠️ Il vaut ZERO en pratique, et c'est pourquoi il est affiche : tant qu'il
   * vaut 0, aucune arme draftee ni aucun passif n'entre dans la mesure — d'ou
   * le decor « arsenal plein ».
   */
  drafts: number;
}

function unEssai(seed: number, armes: number): Mesure {
  const room = new Room(seed);
  const joueurs = [1, 2, 3, 4];
  for (const id of joueurs) {
    room.join(id);
  }
  const arsenal = WEAPONS.filter((w) => w.id !== BASE_WEAPON_ID)
    .slice(0, armes)
    .map((w) => w.id);
  for (const id of joueurs) {
    for (const arme of arsenal) {
      room.grantCard(id, { nature: CARD.WEAPON, refId: arme });
    }
  }
  // Positions de naissance, relevees une fois : les joueurs ne bougent pas.
  const snap = positions(room);

  let morts = 0;
  let apparitions = 0;
  let premiereMort = -1;
  let orbesMax = 0;
  let projectilesMax = 0;
  let drafts = 0;
  const ticks = SECONDES * TICK_HZ;
  for (let t = 0; t < ticks; t++) {
    for (let k = 0; k < joueurs.length; k++) {
      const p = snap[k];
      if (p) {
        vise(room, joueurs[k] ?? 0, t + 1, p.x, p.y);
      }
    }
    const avant = room.horde.count;
    room.step(DT);
    const lot = room.drainDeaths().reduce((n, d) => n + d.ids.length, 0);
    morts += lot;
    apparitions += Math.max(0, room.horde.count - avant + lot);
    room.drainPickups();
    room.drainLevelUps();
    // ⚠️ **Fermer l'etalage, sinon on mesure un monde GELE.** Un draft gele le
    // monde jusqu'a ce que tout le monde ait pose son jeton, ou jusqu'a
    // l'echeance, 20 s plus tard.
    for (const ouverture of room.drainDraftOpens()) {
      drafts++;
      const cartes = ouverture.cards.length;
      for (let k = 0; k < joueurs.length && cartes > 0; k++) {
        room.setDraftToken(joueurs[k] ?? 0, k % cartes);
      }
    }
    room.drainDraftResults();
    if (premiereMort < 0 && room.drainRunOver()) {
      premiereMort = t;
    }
    if (room.orbCount > orbesMax) {
      orbesMax = room.orbCount;
    }
    if (room.projectileCount > projectilesMax) {
      projectilesMax = room.projectileCount;
    }
  }
  let lourds = 0;
  for (let i = 0; i < room.horde.count; i++) {
    if (archetypeOf(room.horde.archetype[i] ?? 0).hp === HEAVY_HP) {
      lourds++;
    }
  }
  return {
    morts,
    apparitions,
    hordeFinale: room.horde.count,
    partLourde: room.horde.count > 0 ? lourds / room.horde.count : 0,
    premiereMort,
    orbesMax,
    orbesTronques: room.orbesTronquees,
    projectilesMax,
    projectilesTronques: room.projectilesTronques,
    drafts,
  };
}

/** Positions des joueurs, lues une fois au depart (ils ne bougent jamais). */
function positions(room: Room): { x: number; y: number }[] {
  const buffers: ArrayBuffer[] = [];
  room.snapshot({ push: (b: ArrayBuffer) => buffers.push(b) });
  const buf = buffers[0];
  return buf ? decodeSnapshot(buf).players.map((p) => ({ x: p.x, y: p.y })) : [];
}

function unDecor(nom: string, armes: number): void {
  console.log(`\n=== Decor « ${nom} » — ${armes + 1} arme(s) par joueur ===`);
  const lignes: Record<string, unknown>[] = [];
  let totalMorts = 0;
  let totalApparitions = 0;
  let orbesMax = 0;
  let orbesTronques = 0;
  let projectilesMax = 0;
  let projectilesTronques = 0;
  let drafts = 0;
  for (const seed of GRAINES) {
    const m = unEssai(seed, armes);
    totalMorts += m.morts;
    totalApparitions += m.apparitions;
    orbesMax = Math.max(orbesMax, m.orbesMax);
    orbesTronques += m.orbesTronques;
    projectilesMax = Math.max(projectilesMax, m.projectilesMax);
    projectilesTronques += m.projectilesTronques;
    drafts += m.drafts;
    lignes.push({
      graine: `0x${seed.toString(16)}`,
      'morts/s': +(m.morts / SECONDES).toFixed(2),
      'apparitions/s': +(m.apparitions / SECONDES).toFixed(2),
      'horde finale': m.hordeFinale,
      'dont lourds': `${Math.round(m.partLourde * 100)} %`,
      'fin de run (tick)': m.premiereMort < 0 ? '—' : m.premiereMort,
      'orbes au sol (pic)': m.orbesMax,
      'orbes tronques': m.orbesTronques,
      'projectiles (pic)': m.projectilesMax,
      drafts: m.drafts,
    });
  }
  console.table(lignes);

  const mortsParSeconde = totalMorts / (SECONDES * GRAINES.length);
  const apparitionsParSeconde = totalApparitions / (SECONDES * GRAINES.length);
  console.log(`-> [${nom}] Rythme de mise a mort : ${mortsParSeconde.toFixed(2)} morts/s`);
  console.log(`-> [${nom}] Apparitions           : ${apparitionsParSeconde.toFixed(2)} /s`);
  console.log(
    `-> [${nom}] Rapport morts/apparitions : ${(mortsParSeconde / Math.max(1e-9, apparitionsParSeconde)).toFixed(2)}`,
  );
  console.log(`-> [${nom}] Orbes au sol, pic : ${orbesMax} — tronques : ${orbesTronques}`);
  console.log(
    `-> [${nom}] Projectiles vivants, pic : ${projectilesMax} — salves tronquees : ${projectilesTronques}`,
  );
  console.log(`-> [${nom}] Etalages ouverts : ${drafts}`);
}

function main(): void {
  console.log(
    `Banc du rythme de mise a mort — 4 joueurs immobiles, ${SECONDES} s de jeu, ` +
      `${GRAINES.length} graines de carte.`,
  );
  for (const decor of DECORS) {
    unDecor(decor.nom, decor.armes);
  }
}

main();
