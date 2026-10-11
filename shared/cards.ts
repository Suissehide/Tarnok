import { SPREAD_BONUS } from './constants';
import type { Loadout } from './loadout';
import { PASSIVES } from './passives';
import { BASE_WEAPON_ID, WEAPONS } from './weapons';

/**
 * Les deux natures de carte.
 *
 * ⚠️ **Il y en avait quatre.** `WEAPON_LEVEL` et `EVOLUTION` ont ete retires :
 * une arme ne monte pas de niveau, elle s'empile comme un passif. Voir le §9
 * de la spec. L'index EST l'identifiant, comme partout ailleurs dans `shared/`.
 */
export const CARD = {
  WEAPON: 0,
  PASSIVE: 1,
} as const;

/**
 * Une carte de l'etalage.
 *
 * ⚠️ **Il n'y a plus d'`owner`.** Il portait l'exclusivite des cartes reservees
 * a leur porteur — montees de niveau, evolutions — qui n'existent plus. Toute
 * carte est ouverte a tout le monde, sans exception : c'est ce qui fait du
 * conflit le regime normal du draft plutot qu'un accident.
 */
export interface Card {
  nature: number;
  /** Index dans `WEAPONS` ou dans `PASSIVES`, selon `nature`. */
  refId: number;
}

/**
 * Range une carte dans un inventaire — la SEULE traduction « nature de carte
 * → mutation d'inventaire » du depot.
 *
 * ⚠️ **Serveur et client lisent cette fonction, pas deux copies.** Le serveur
 * l'appelle depuis `Room#grantCard` (qui y ajoute le soin de « vitalite »,
 * hors inventaire) ; le client l'appelle a la reception de `DRAFT_RESULT` pour
 * tenir son miroir des inventaires — dont il derive les armes qui tirent et la
 * vitesse de sa propre prediction. Deux traductions divergeraient a la
 * premiere nature de carte ajoutee, et le client afficherait un arsenal que le
 * serveur n'arbitre pas.
 *
 * Leve exactement comme `Loadout` leve : slots pleins, identifiant inconnu.
 * C'est l'appelant qui decide quoi en faire — le serveur ne devrait jamais en
 * produire une, le client peut en recevoir une pour un joueur dont il n'a pas
 * vu tout l'historique.
 */
export function applyCardToLoadout(loadout: Loadout, card: Card): void {
  switch (card.nature) {
    case CARD.WEAPON:
      loadout.addWeapon(card.refId);
      break;
    case CARD.PASSIVE:
      loadout.addPassive(card.refId);
      break;
    default:
      break;
  }
}

/**
 * Construit la reserve de cartes possibles, avant tirage, filtree par les
 * armes DEBLOQUEES.
 *
 * ⚠️ **`unlocked` est l'UNION des deblocages de la salle, pas ceux d'un
 * joueur.** L'etalage est unique et partage (§7.1 de l'orientation : « un seul
 * etalage pour toute l'equipe », le pari de design du projet). L'intersection
 * aurait fait qu'un debutant degrade le pool de toute l'equipe, ce que le §8.1
 * interdit en propres termes : « une punition se lit comme un bug ».
 *
 * C'est `Draft#setToken` qui refuse ensuite a CE joueur une carte qu'il n'a pas
 * debloquee ; le client, lui, la grise avec son propre ensemble.
 *
 * ⚠️ **Aucune exclusivite d'equipe, par ailleurs.** Si un allie porte deja le
 * lance-flammes, la carte reste offerte : *« si quelqu'un a deja pris
 * lance-flammes, je peux lui voler la carte la prochaine fois »*. Ce n'est pas
 * un vol au sens propre — chacun garde le sien — mais la carte de CET
 * etalage-ci se dispute. Armes et passifs s'empilent pareil : rien ne s'exclut
 * d'etre deja possede, c'est ce qui fait du conflit le regime NORMAL du draft.
 *
 * L'arme neutre est le seul retrait inconditionnel : elle vit hors des slots
 * (§6.1), tout le monde l'a des le depart, et la proposer l'empilerait sur
 * elle-meme.
 */
export function buildPool(unlocked: ReadonlySet<number>): Card[] {
  const pool: Card[] = [];

  for (const w of WEAPONS) {
    if (w.id === BASE_WEAPON_ID) {
      continue;
    }
    if (w.locked && !unlocked.has(w.id)) {
      continue;
    }
    pool.push({ nature: CARD.WEAPON, refId: w.id });
  }

  for (const p of PASSIVES) {
    pool.push({ nature: CARD.PASSIVE, refId: p.id });
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
 * meme » carte sans etre en conflit.
 *
 * Ce sont le `splice` et un pool sans doublon qui le garantissent, a eux deux.
 * Un `Set` des cartes deja vues doublait cette garde ici : chacune survivait
 * seule a sa mutation, seule leur suppression conjointe faisait rougir la
 * suite. **Deux gardes qui se couvrent l'une l'autre ne sont gardees par aucun
 * test** — c'est la cinquieme occurrence de ce motif dans cette etape.
 */
export function drawSpread(
  loadouts: ReadonlyMap<number, Loadout>,
  rng: () => number,
  unlocked: ReadonlySet<number>,
): Card[] {
  const wanted = loadouts.size + SPREAD_BONUS;
  const pool = buildPool(unlocked);
  const spread: Card[] = [];

  while (spread.length < wanted && pool.length > 0) {
    const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    const [card] = pool.splice(index, 1);
    if (!card) {
      break;
    }
    spread.push(card);
  }

  return spread;
}
