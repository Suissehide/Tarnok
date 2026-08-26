import { SPREAD_BONUS, WEAPON_MAX_LEVEL } from './constants';
import type { Loadout } from './loadout';
import { PASSIVES } from './passives';
import { BASE_WEAPON_ID, WEAPONS } from './weapons';

/**
 * Les quatre natures de carte du §7.5 de l'orientation.
 *
 * L'index EST l'identifiant, comme partout ailleurs dans `shared/`.
 */
export const CARD = {
  NEW_WEAPON: 0,
  WEAPON_LEVEL: 1,
  PASSIVE: 2,
  EVOLUTION: 3,
} as const;

/**
 * Une carte de l'etalage.
 *
 * `owner` porte a lui seul toute l'exclusivite du draft : `0` signifie
 * « ouvert a tous », sinon c'est le SEUL joueur eligible. Le serveur n'a donc
 * pas de regle separee pour les montees de niveau et les evolutions — il
 * refuse une selection dont `owner` ne correspond pas.
 *
 * ⚠️ Aucun joueur ne porte l'identifiant `0` : c'est ce qui rend la sentinelle
 * utilisable.
 */
export interface Card {
  nature: number;
  /** Index dans `WEAPONS` ou dans `PASSIVES`, selon `nature`. */
  refId: number;
  owner: number;
}

/** Clef d'unicite d'une carte dans un etalage. */
function keyOf(c: Card): string {
  return `${c.nature}:${c.refId}:${c.owner}`;
}

/**
 * Construit la reserve de cartes possibles, avant tirage.
 *
 * Trois regles d'exclusion, et une seule non-exclusion qui compte :
 *
 * - une arme portee par **n'importe quel** membre de l'equipe ne peut plus
 *   etre offerte en arme neuve : le §6.2 rend l'exclusivite binaire et
 *   valable pour toute la run, pas « moins probable » ;
 * - un joueur dont les slots d'armes sont pleins n'en recoit plus — pour lui
 *   seul, les autres continuent d'en voir ;
 * - une evolution exige l'arme au niveau maximum **et** le passif associe
 *   (§7.5).
 *
 * ⚠️ **Les passifs ne s'excluent jamais.** Ils s'empilent (modele Risk of
 * Rain), donc un passif deja possede reste desirable — c'est ce qui fait que
 * toute carte de passif est convoitee par tous les joueurs en permanence, et
 * donc que le conflit est le regime normal du draft plutot qu'un accident.
 */
function buildPool(loadouts: ReadonlyMap<number, Loadout>): Card[] {
  const pool: Card[] = [];

  const portees = new Set<number>();
  for (const loadout of loadouts.values()) {
    for (const id of loadout.weaponIds) {
      portees.add(id);
    }
  }

  // Armes neuves : ouvertes a tous, sauf si l'equipe les porte deja.
  //
  // ⚠️ L'arme neutre est exclue du pool : elle vit hors des slots (§6.1) et
  // tout le monde l'a des le depart. La proposer gaspillerait une carte, et la
  // prendre occuperait un slot pour rien tout en la faisant tirer deux fois par
  // tick (voir `BASE_WEAPON_ID` et `Room#fireWeapons`).
  for (const w of WEAPONS) {
    if (w.id !== BASE_WEAPON_ID && !portees.has(w.id)) {
      pool.push({ nature: CARD.NEW_WEAPON, refId: w.id, owner: 0 });
    }
  }

  // Passifs : toujours ouverts, jamais exclus.
  for (const p of PASSIVES) {
    pool.push({ nature: CARD.PASSIVE, refId: p.id, owner: 0 });
  }

  // Montees de niveau et evolutions : un seul eligible, son porteur.
  for (const [playerId, loadout] of loadouts) {
    for (const weaponId of loadout.weaponIds) {
      const level = loadout.levelOf(weaponId);
      if (level < WEAPON_MAX_LEVEL) {
        pool.push({ nature: CARD.WEAPON_LEVEL, refId: weaponId, owner: playerId });
        continue;
      }
      const weapon = WEAPONS[weaponId];
      if (
        weapon &&
        weapon.evolutionPassiveId >= 0 &&
        loadout.stacksOf(weapon.evolutionPassiveId) > 0
      ) {
        pool.push({ nature: CARD.EVOLUTION, refId: weaponId, owner: playerId });
      }
    }
  }

  return pool;
}

/**
 * Tire l'etalage d'un niveau : `joueurs + SPREAD_BONUS` cartes distinctes
 * (§7.2 point 1).
 *
 * ⚠️ `rng` est **injecte**. `shared/` interdit `Math.random` — non par
 * principe, mais parce que tout ce qui vit ici tourne des deux cotes du fil.
 * Le draft, lui, n'est calcule que par le serveur (§2 de la spec de l'etape
 * 4) : l'injection sert donc surtout a rendre le tirage testable a graine
 * fixe.
 *
 * ⚠️ **Les cartes sont distinctes.** Deux cartes identiques dans un meme
 * etalage rendraient un conflit illisible : deux joueurs poseraient sur « la
 * meme » carte sans etre en conflit. Le tirage est donc sans remise.
 */
export function drawSpread(loadouts: ReadonlyMap<number, Loadout>, rng: () => number): Card[] {
  const wanted = loadouts.size + SPREAD_BONUS;
  const pool = buildPool(loadouts);
  const spread: Card[] = [];
  const vues = new Set<string>();

  while (spread.length < wanted && pool.length > 0) {
    const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    const [card] = pool.splice(index, 1);
    if (!card) {
      break;
    }
    const key = keyOf(card);
    if (vues.has(key)) {
      continue;
    }
    vues.add(key);
    spread.push(card);
  }

  return spread;
}
