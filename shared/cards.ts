import { SPREAD_BONUS } from './constants';
import type { Loadout } from './loadout';
import { PASSIVES, type PassiveTier, passiveOf } from './passives';
import { multiplierOf, RARITY, rollRarity } from './rarity';
import { upgradesFor, WEAPONS, weaponOf } from './weapons';

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
  /**
   * Arme seulement : l'aspect que la carte ameliore chez qui possede deja
   * l'arme (`UPGRADE`, l'un de ses `upgradesFor`). Chez qui ne la possede
   * pas, la carte la donne. Absent : son premier bonus propre.
   */
  upgrade?: number;
  /**
   * La rarete tiree pour cette carte (`RARITY`, etape 10) : elle s'applique
   * autant de fois que son multiplicateur. Absente : commune.
   */
  rarity?: number;
}

/** Le palier reserve de cette carte, `undefined` pour une carte ordinaire. */
export function tierOf(card: Card): PassiveTier | undefined {
  return card.nature === CARD.PASSIVE ? passiveOf(card.refId).tier : undefined;
}

/** La rarete qu'un palier reserve exige, `undefined` pour une carte ordinaire. */
export function rarityForTier(tier: PassiveTier | undefined): number | undefined {
  if (tier === 'epique') {
    return RARITY.EPIQUE;
  }
  return tier === 'legendaire' ? RARITY.LEGENDAIRE : undefined;
}

/**
 * Combien de fois cette carte s'applique : le multiplicateur de sa rarete, et
 * rien d'autre.
 *
 * ⚠️ **Le cas particulier du passif « exclusivement legendaire » a disparu a
 * l'etape 13** : il forcait un legendaire a x1 contre une table qui disait x3.
 * La table dit maintenant x1 elle-meme (`RARITY_MULTIPLIERS`), donc la
 * fonction n'a plus rien a corriger.
 */
export function applicationsOf(card: Card): number {
  return multiplierOf(card.rarity);
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
 *
 * ⚠️ **Une carte rare vaut deux cartes, et rien de plus** (etape 10) : elle
 * s'applique `applicationsOf(card)` fois. Pour une arme non possedee, la
 * premiere application est l'acquisition, les suivantes ameliorent le MEME
 * aspect. `canTake` se juge donc sur la premiere : si elle leve, rien n'est
 * applique ; si elle passe, les suivantes empilent ce qui est deja possede et
 * ne peuvent plus lever.
 */
export function applyCardToLoadout(loadout: Loadout, card: Card): void {
  const fois = applicationsOf(card);
  for (let i = 0; i < fois; i++) {
    switch (card.nature) {
      case CARD.WEAPON:
        loadout.addWeapon(card.refId, card.upgrade);
        break;
      case CARD.PASSIVE:
        loadout.addPassive(card.refId);
        break;
      default:
        break;
    }
  }
}

/**
 * Construit la reserve de cartes possibles, avant tirage.
 *
 * ⚠️ **Aucune exclusivite d'equipe.** Si un allie porte deja le
 * lance-flammes, la carte reste offerte : *« si quelqu'un a deja pris
 * lance-flammes, je peux lui voler la carte la prochaine fois »*. Ce n'est pas
 * un vol au sens propre — chacun garde le sien — mais la carte de CET
 * etalage-ci se dispute. Armes et passifs s'empilent pareil : rien ne s'exclut
 * d'etre deja possede, c'est ce qui fait du conflit le regime NORMAL du draft.
 *
 * La dague en fait partie : c'est une arme comme les autres, dans les slots,
 * que le draft ameliore en l'empilant.
 */
export function buildPool(): Card[] {
  const pool: Card[] = [];

  for (const w of WEAPONS) {
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
 *
 * ⚠️ **La rarete de l'EMPLACEMENT d'abord, la carte ensuite** (etape 10,
 * §2.3) : une carte de palier n'entre dans le pool QUE pour un emplacement qui
 * vient de tirer SON palier. Tirer la carte d'abord obligerait a retirer, ou a
 * forcer la rarete — deux facons de fausser les poids. Rarete, carte, aspect :
 * tout vient du meme `rng`, dans cet ordre.
 *
 * ⚠️ **Un palier, un pool (etape 13, §2.2), et ces pools sont PETITS.** Le
 * filtre n'est plus « legendaire ou carte ordinaire » mais une egalite stricte
 * entre le palier de la carte et celui de l'emplacement. Comme le tirage est
 * SANS REMISE (`pool.splice`), un palier qui a donne toutes ses cartes n'en a
 * plus a offrir : c'est pour ca que la descente ci-dessous existe.
 *
 * `floor` (etape 11) : le plancher de rarete de CHAQUE emplacement, passe tel
 * quel a `rollRarity` — `CHEST_RARITY_FLOOR` pour un coffre. La descente le
 * respecte : elle ne passe JAMAIS dessous.
 */
export function drawSpread(
  loadouts: ReadonlyMap<number, Loadout>,
  rng: () => number,
  floor: number = RARITY.COMMUNE,
): Card[] {
  const wanted = loadouts.size + SPREAD_BONUS;
  // ⚠️ **Une carte que PERSONNE ne peut prendre ne s'offre plus** : une fois
  // l'arsenal de chacun complet, une arme que nul ne possede n'est qu'une case
  // grisee pour tout le salon. `canTake` reste la seule regle.
  const team = [...loadouts.values()];
  const pool = buildPool().filter((card) => team.some((l) => l.canTake(card.nature, card.refId)));
  const spread: Card[] = [];
  // ⚠️ **Ce qu'un joueur possede deja revient plus souvent** (retour de
  // playtest : *« je dois pouvoir reprendre la meme arme pour l'ameliorer »*).
  // Tirage uniforme sur ~20 cartes, une arme possedee ne revenait presque
  // jamais ; c'est le poids `OWNED_WEIGHT` des survivor-likes.
  const weights = pool.map((card) => (ownedByAnyone(card, loadouts) ? OWNED_WEIGHT : 1));

  /** Les poids des cartes que CE palier permet, et leur somme. */
  const permisAt = (rarity: number): { poids: number[]; total: number } => {
    const attendu = rarity === RARITY.EPIQUE || rarity === RARITY.LEGENDAIRE ? rarity : undefined;
    const poids = pool.map((card, i) =>
      rarityForTier(tierOf(card)) === attendu ? (weights[i] ?? 0) : 0,
    );
    return { poids, total: poids.reduce<number>((a, b) => a + b, 0) };
  };

  while (spread.length < wanted && pool.length > 0) {
    // ⚠️ **La descente de palier (etape 13, §2.3).** Un palier dont aucune
    // carte n'est plus prenable — ses quelques cartes sont deja dans
    // l'etalage, le tirage est sans remise — redescend d'un cran, jusqu'au
    // `floor` de l'emplacement et JAMAIS en dessous. Sans elle, la boucle
    // sortait et l'etalage avait MOINS de cartes que de joueurs : le `break`
    // plus bas, documente « INATTEIGNABLE » a l'etape 10, cesse de l'etre des
    // qu'un palier a son propre pool.
    //
    // ⚠️ **`rng` est consomme EXACTEMENT une fois par emplacement pour la
    // rarete**, descente comprise : elle decremente, elle ne retire pas. C'est
    // ce qui garde le tirage reproductible a graine fixe, et plusieurs tests
    // herites en dependent.
    let rarity = rollRarity(rng, floor);
    let permis = permisAt(rarity);
    while (permis.total === 0 && rarity > floor) {
      rarity--;
      permis = permisAt(rarity);
    }
    let roll = rng() * permis.total;
    // ⚠️ `index` suit la derniere carte PERMISE vue : si l'arrondi laisse
    // `roll` a peine positif en fin de boucle, c'est elle qui sort — jamais une
    // carte de poids nul, donc jamais une carte de palier hors de son palier.
    let index = -1;
    for (let i = 0; i < pool.length; i++) {
      const w = permis.poids[i] ?? 0;
      if (w <= 0) {
        continue;
      }
      index = i;
      roll -= w;
      if (roll < 0) {
        break;
      }
    }
    // ⚠️ Atteignable seulement si MEME le plancher ne permet rien : un pool
    // qui ne contiendrait plus que des cartes de palier, sur un plancher
    // epique ou legendaire deja vide. Sans elle, `pool[-1]` sortirait.
    if (index < 0) {
      break;
    }
    const [card] = pool.splice(index, 1);
    weights.splice(index, 1);
    if (!card) {
      break;
    }
    if (card.nature === CARD.WEAPON) {
      const options = upgradesFor(weaponOf(card.refId));
      card.upgrade = options[Math.min(options.length - 1, Math.floor(rng() * options.length))];
    }
    card.rarity = rarity;
    spread.push(card);
  }

  return spread;
}

/** Le poids d'une carte deja possedee par un joueur du salon, contre 1 pour les autres. */
export const OWNED_WEIGHT = 4;

function ownedByAnyone(card: Card, loadouts: ReadonlyMap<number, Loadout>): boolean {
  for (const l of loadouts.values()) {
    const owned =
      card.nature === CARD.PASSIVE ? l.stacksOf(card.refId) : l.stacksOfWeapon(card.refId);
    if (owned > 0) {
      return true;
    }
  }
  return false;
}
