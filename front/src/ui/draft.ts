import { applicationsOf, CARD, type Card } from '@shared/cards';
import { COLOSSUS_HP_STEP, TICK_HZ, WEAPON_SLOTS } from '@shared/constants';
import { elementOf } from '@shared/elements';
import type { Loadout } from '@shared/loadout';
import { PASSIVES, type Passive, type PassiveKind, passiveOf } from '@shared/passives';
import { NO_TOKEN, OUTCOME } from '@shared/protocol';
import { normalizeRarity, RARITY } from '@shared/rarity';
import {
  CALIBRE_PER_UPGRADE,
  DAMAGE_PER_UPGRADE,
  EFFECT_RADIUS_PER_STACK,
  FIRE_RATE_PER_UPGRADE,
  PIERCE_PER_UPGRADE,
  RANGE_PER_UPGRADE,
  RICOCHET_PER_UPGRADE,
  stackGain,
  UPGRADE,
  VELOCITY_PER_UPGRADE,
  VENOM_PER_UPGRADE,
  weaponOf,
} from '@shared/weapons';

import { elementBadge } from './element-icons';
import { bonusIcon, ICON_WEAPON } from './icons';

/**
 * L'ecran de draft.
 *
 * 1. **Les intentions sont visibles.** Le jeton de chaque joueur se pose sur la
 *    carte qu'il vise, et tout le monde le voit : sans cela, il ne reste qu'un
 *    menu, et la negociation qui fait l'interet du draft n'a aucun support.
 * 2. **La revelation est asymetrique et simultanee.** La meme carte s'illumine
 *    chez le gagnant et se consume chez les perdants : la perte se lit au lieu
 *    d'etre subie.
 *
 * La carte porte aussi ce qu'elle vaut (element d'une arme, bonus d'un
 * passif) — voir `cardDetail`.
 */

/** Ce que l'ecran lit — la surface de `GameClient` qui concerne le draft, et rien d'autre. */
export interface DraftSource {
  readonly localId: number | null;
  readonly hordeTick: number;
  readonly draftCards: readonly Card[];
  readonly draftDeadlineTick: number;
  readonly draftIntents: ReadonlyMap<number, number>;
  readonly draftOutcomes: readonly DraftOutcomeView[];
  readonly draftSettled: boolean;
  readonly isFrozen: boolean;
  /** Le niveau atteint, pour le ruban de titre. Optionnel : les doubles de test s'en passent. */
  readonly level?: number;
  /** L'etalage est un coffre : le ruban dit « Coffre ». Optionnel, comme `level`. */
  readonly draftIsChest?: boolean;
  /** Le miroir d'inventaire, pour l'indicateur d'empilement de chaque carte. */
  loadoutOf?(playerId: number): Loadout;
  placeToken(cardIndex: number): void;
}

export interface DraftOutcomeView {
  playerId: number;
  cardIndex: number;
  outcome: number;
}

/**
 * L'etat d'une carte, tel qu'il s'ecrit dans `data-state` — donc tel que les
 * tests le lisent et que la CSS l'anime.
 *
 * - `won` : elle s'illumine, je l'ai eue ;
 * - `lost` : elle se consume — **ma** carte, celle ou j'avais pose mon jeton,
 *   qu'un autre a eue ;
 * - `taken` : un autre l'a eue sans que je la vise (elle ne brule pas) ;
 * - `idle` : rien de decide, elle s'estompe une fois la resolution passee.
 *
 * Aucune carte n'est reservee : une carte deja visee par un allie reste
 * posable — c'est la negociation.
 */
export type DraftCardState = 'idle' | 'taken' | 'won' | 'lost';

/** Jaune, bleu, rouge, violet : la couleur des unites du pack (`render/player-renderer.ts`). */
const PLAYER_COLORS = ['#e0b84e', '#6fa8dc', '#e06666', '#c27ba0'];

export function playerColor(playerId: number): string {
  return PLAYER_COLORS[(playerId - 1) % PLAYER_COLORS.length] ?? '#ffffff';
}

/**
 * L'indicateur d'empilement : combien d'exemplaires de CETTE carte le joueur
 * local possede deja. Vide sans miroir d'inventaire ou avant le WELCOME.
 */
export function stacksLabel(
  card: Card,
  source: Pick<DraftSource, 'localId' | 'loadoutOf'>,
): string {
  if (source.localId === null || !source.loadoutOf) {
    return '';
  }
  const loadout = source.loadoutOf(source.localId);
  const owned =
    card.nature === CARD.PASSIVE
      ? loadout.stacksOf(card.refId)
      : loadout.stacksOfWeapon(card.refId);
  if (owned === 0) {
    return 'Nouveau';
  }
  return card.nature === CARD.PASSIVE ? `Possédé ×${owned}` : upgradeLabel(card);
}

/** Ce qu'une carte d'arme ameliore chez qui la possede deja — voir `UPGRADE`. */
export function upgradeLabel(card: Card): string {
  const pct = (f: number): string => `${Math.round(f * 100)} %`;
  const weapon = weaponOf(card.refId);
  switch (card.upgrade ?? weapon.perks[0]) {
    case UPGRADE.DAMAGE:
      return `+${pct(DAMAGE_PER_UPGRADE)} dégâts`;
    case UPGRADE.FIRE_RATE:
      return `+${pct(FIRE_RATE_PER_UPGRADE)} cadence`;
    case UPGRADE.ZONE:
      return weapon.kind === 'faisceau'
        ? `+${pct(EFFECT_RADIUS_PER_STACK)} largeur`
        : `+${pct(EFFECT_RADIUS_PER_STACK)} zone`;
    case UPGRADE.PIERCE:
      return `Transperce +${PIERCE_PER_UPGRADE}`;
    case UPGRADE.RANGE:
      // La frappe vise a portee : la carte l'eloigne, comme un tir.
      return (weapon.kind === 'tir' || weapon.kind === 'frappe') && weapon.projectileSpeed > 0
        ? `+${pct(RANGE_PER_UPGRADE)} portée`
        : `+${pct(RANGE_PER_UPGRADE)} durée`;
    case UPGRADE.CALIBRE:
      return `+${pct(CALIBRE_PER_UPGRADE)} calibre`;
    case UPGRADE.VELOCITY:
      return `+${pct(VELOCITY_PER_UPGRADE)} vitesse`;
    case UPGRADE.DETONATION:
      return 'Explose à l’impact';
    case UPGRADE.VENOM:
      return `Venin ${pct(VENOM_PER_UPGRADE)}`;
    case UPGRADE.RICOCHET:
      return `Ricochet +${RICOCHET_PER_UPGRADE}`;
    case UPGRADE.HOMING:
      return 'Guidage +';
    default: {
      const n = stackGain(weapon);
      // Une frappe ne tire pas de projectile : SALVO lui ajoute un eclair.
      const unite = weapon.kind === 'frappe' ? 'éclair' : 'projectile';
      return `+${n} ${unite}${n > 1 ? 's' : ''}`;
    }
  }
}

/**
 * Pourquoi le joueur ne peut PAS prendre cette carte, ou `null` s'il le peut.
 *
 * ⚠️ **Le serveur refuse le jeton en silence** (`Draft#eligible`) : sans ce
 * message, le clic sur une arme aux slots pleins ne fait rien et se lit comme
 * un bug. La regle reste `canTake`, jamais recopiee ici, pour que l'ecran et
 * le serveur ne divergent pas.
 *
 * Un passif n'est jamais bloque (`canTake` rend toujours `true`) : seule une
 * arme a une raison de refus.
 */
export function blockedReason(card: Card, loadout: Loadout): string | null {
  if (loadout.canTake(card.nature, card.refId)) {
    return null;
  }
  return `Arsenal complet — ${loadout.weaponSlotsUsed}/${WEAPON_SLOTS} armes`;
}

/**
 * Le rappel de ce qui occupe deja les slots de cette nature : le joueur bloque
 * voit tout de suite quelles cartes de l'etalage, elles, s'empileraient.
 */
export function ownedNames(nature: number, loadout: Loadout): string {
  if (nature === CARD.PASSIVE) {
    return PASSIVES.filter((p) => loadout.stacksOf(p.id) > 0)
      .map((p) => p.label)
      .join(', ');
  }
  return loadout.weaponIds.map((id) => weaponOf(id).name).join(', ');
}

/** Secondes restantes avant l'echeance, jamais negatives. */
export function remainingSeconds(deadlineTick: number, hordeTick: number): number {
  return Math.max(0, Math.ceil((deadlineTick - hordeTick) / TICK_HZ));
}

/** La nature de la carte, en un mot — c'est elle qui dit ce qu'on gagne. */
export function natureLabel(nature: number): string {
  switch (nature) {
    case CARD.WEAPON:
      return 'Arme';
    case CARD.PASSIVE:
      return 'Passif';
    default:
      return '?';
  }
}

/** Le nom de chaque rarete, dans l'ordre de `RARITY`. */
export const RARITY_NAMES = ['Commune', 'Rare', 'Épique', 'Légendaire'] as const;

/**
 * L'etiquette de rarete : le nom ET ce que la carte vaut vraiment —
 * « Rare ×2 », et « Épique » ou « Légendaire » tout court.
 *
 * ⚠️ **Le ×N n'apparait que s'il y a plus d'une carte a promettre.** Les deux
 * paliers hauts sont des cartes de regle, a x1 : un « ×3 » promettrait des
 * cartes qu'ils ne donnent pas. Le compte vient de `applicationsOf`, jamais
 * d'une seconde table ici.
 *
 * Vide pour une commune : la bordure grise dit deja tout.
 */
export function rarityLabel(card: Card): string {
  const rarity = normalizeRarity(card.rarity);
  if (rarity === RARITY.COMMUNE) {
    return '';
  }
  const nom = RARITY_NAMES[rarity] ?? '';
  const fois = applicationsOf(card);
  return fois > 1 ? `${nom} ×${fois}` : nom;
}

/**
 * Le nom de ce que la carte porte.
 *
 * `refId` indexe `WEAPONS` ou `PASSIVES` **selon la nature** : se tromper de
 * table donnerait un nom plausible et faux, ce qui est le pire des cas pour un
 * ecran de choix.
 */
export function cardName(card: Card): string {
  return card.nature === CARD.PASSIVE ? passiveOf(card.refId).label : weaponOf(card.refId).name;
}

/**
 * L'unite dans laquelle se lit la `magnitude` d'un passif, par genre.
 *
 * ⚠️ **Les magnitudes sont heterogenes** : points bruts (`maxHp`), pixels par
 * seconde (`speed`), fractions (`fireRate`, `damage`). Sans unite, « 20 » et
 * « 0,08 » cote a cote ne veulent rien dire.
 *
 * ⚠️ **`fireRate` retire une fraction de la RECHARGE**, il n'ajoute pas une
 * fraction de cadence (voir `cooldownWithBonus`) : « +8 % de cadence » serait
 * faux.
 */
const UNITES: Record<PassiveKind, (magnitude: number) => string> = {
  maxHp: (m) => `+${m} PV max`,
  speed: (m) => `+${m} px/s`,
  damage: (m) => `+${pourcent(m)} % dégâts`,
  fireRate: (m) => `−${pourcent(m)} % recharge`,
  // ⚠️ Seule unite de DEBIT du catalogue : PV par seconde. « +2 PV » se lirait
  // comme un gain unique, ce que fait « vitalite » et pas cette carte.
  regen: (m) => `+${m.toLocaleString('fr-FR')} PV/s`,
  // ⚠️ Chacun dit OU il agit : « +1 salve » sans « armes de tir » laisserait
  // croire que le halo en profite.
  critChance: (m) => `+${pourcent(m)} % critique`,
  critDamage: (m) => `+${pourcent(m)} % dégâts critiques`,
  salvo: (m) => `+${m} salve, armes de tir`,
  zone: (m) => `+${m} zone, toutes armes`,
  echo: (m) => `+${pourcent(m)} % dégâts de vos réactions`,
  colossus: (m) => `+${pourcent(m)} % dégâts par ${COLOSSUS_HP_STEP} PV max`,
  // Seule Hâte funeste porte ce genre, et en MALUS (voir `armorOf`). L'unite
  // dit donc son EFFET au joueur — des degats SUBIS en plus, ce que
  // `hurtPlayer` applique (`back/src/combat.ts`) : un libelle qui est deja un
  // cout, d'ou `COUT_SANS_RETOURNEMENT`.
  armor: (m) => `+${pourcent(m)} % dégâts subis`,
};

/**
 * Une fraction en points de pourcentage, a une decimale au plus.
 *
 * `0.08 * 100` vaut `8.000000000000002` en virgule flottante : sans cet
 * arrondi, la carte « cadence » afficherait dix-sept chiffres.
 */
function pourcent(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}`;
}

/**
 * Le bonus qu'apporte UNE carte de ce passif, unite comprise.
 *
 * ⚠️ **Par carte, jamais un total** : c'est ce que le joueur gagne en prenant
 * celle-ci. La colonne des passifs dit deja combien d'exemplaires il possede.
 */
export function magnitudeLabel(passive: Passive): string {
  // Une carte de REGLE (Contagion, Transcendance) a une magnitude nulle par
  // convention et un `kind` decoratif (voir `Passive.rule`) : « +0 zone »
  // se lirait comme un bonus mesure.
  if (passive.magnitude === 0) {
    return '';
  }
  return UNITES[passive.kind](passive.magnitude);
}

/**
 * Les genres dont l'unite dit DEJA le cout : leur signe ne se retourne pas.
 *
 * ⚠️ Retourner le `+` dit vrai pour `maxHp` (« −40 PV max ») mais ment pour
 * `armor`, deja ecrit comme un cout : « −50 % dégâts subis » dirait le
 * contraire de ce que Hâte funeste fait subir.
 */
const COUT_SANS_RETOURNEMENT: ReadonlySet<PassiveKind> = new Set(['armor']);

/**
 * Ce que la carte COUTE, ou `null` si elle ne coute rien. Reutilise `UNITES` :
 * malus et bonus d'un meme genre se lisent dans la meme unite.
 */
export function malusLabel(passive: Passive): string | null {
  const m = passive.malus;
  if (!m) {
    return null;
  }
  const texte = UNITES[m.kind](m.magnitude);
  return COUT_SANS_RETOURNEMENT.has(m.kind) ? texte : texte.replace(/^\+/, '−');
}

/**
 * Ce que la carte dit EN PLUS de son nom : l'element pour une arme (le nom
 * seul ne dit pas si elle COMPLETE ce qu'un allie vient de prendre), la valeur
 * pour un passif.
 *
 * Une arme neutre se lit « neutre » : `ELEMENT.NEUTRE` est une entree de la
 * table comme les autres, pas une ligne manquante.
 *
 * `color` est la teinte de l'element, lue dans `ELEMENTS` : la meme que
 * l'anneau de marque et la zone au sol. Nulle pour un passif.
 */
export function cardDetail(card: Card): { text: string; color: string | null } {
  if (card.nature === CARD.PASSIVE) {
    return { text: magnitudeLabel(passiveOf(card.refId)), color: null };
  }
  const element = elementOf(weaponOf(card.refId).element);
  return { text: element.name, color: cssColor(element.tint) };
}

/**
 * Une teinte `0xRRGGBB` en couleur CSS.
 *
 * ⚠️ **Prend le nombre en parametre plutot que de lire `ELEMENTS`** : ainsi le
 * test peut exercer le remplissage a six chiffres sur une teinte sombre
 * (`0x00aabb` s'ecrirait sinon « #aabb », que le navigateur ignore).
 */
export function cssColor(tint: number): string {
  return `#${tint.toString(16).padStart(6, '0')}`;
}

interface CardCell {
  root: HTMLButtonElement;
  tokens: HTMLElement;
  /** Le joueur local ne peut pas accueillir cette carte — fige a la construction, l'inventaire ne bouge pas pendant un draft. */
  blocked: boolean;
}

export class DraftScreen {
  readonly #root: HTMLElement;
  readonly #status: HTMLElement;
  /** Le ruban « Niveau N », s'il existe dans la racine (`#draft-title`). */
  readonly #title: HTMLElement | null;
  readonly #list: HTMLElement;
  readonly #source: DraftSource;

  /** L'etalage actuellement dessine — sert d'identite : `GameClient` en cree un neuf a chaque `DRAFT_OPEN`. */
  #spread: readonly Card[] = [];
  #cells: CardCell[] = [];

  /**
   * Les issues **cumulees** du draft en cours, repioche comprise ; remises a
   * zero au prochain etalage.
   *
   * ⚠️ **`GameClient.draftOutcomes` ne porte que le DERNIER message** : le
   * `DRAFT_RESULT` de la repioche remplacerait les issues du premier tour, et
   * la carte du gagnant s'eteindrait au moment ou elle doit confirmer. Le
   * cumul laisse aussi au perdant sa carte brulee ET sa carte de repioche
   * allumee.
   */
  #outcomes: DraftOutcomeView[] = [];
  #lastOutcomesSeen: readonly DraftOutcomeView[] = [];

  constructor(root: HTMLElement, status: HTMLElement, list: HTMLElement, source: DraftSource) {
    this.#root = root;
    this.#title = root.querySelector('#draft-title');
    this.#status = status;
    this.#list = list;
    this.#source = source;
  }

  /** A appeler a chaque image : l'ecran n'a pas d'horloge propre, il lit le client. */
  update(): void {
    const source = this.#source;
    const spread = source.draftCards;

    if (spread !== this.#spread) {
      this.#spread = spread;
      this.#outcomes = [];
      this.#lastOutcomesSeen = source.draftOutcomes;
      this.#build(spread);
    }

    // Identite, pas contenu : `GameClient` decode un tableau neuf a chaque
    // `DRAFT_RESULT`, donc un changement de reference EST un nouveau message.
    if (source.draftOutcomes !== this.#lastOutcomesSeen) {
      this.#lastOutcomesSeen = source.draftOutcomes;
      this.#outcomes.push(...source.draftOutcomes);
    }

    // ⚠️ **L'etalage survit a la fermeture** (`draftSettled`) : l'ecran reste
    // jusqu'a la fin de la rampe de reprise (`isFrozen` couvre le gel ET sa
    // rampe), le temps que le monde redemarre.
    const visible = spread.length > 0 && (!source.draftSettled || source.isFrozen);
    this.#root.classList.toggle('hidden', !visible);
    this.#root.classList.toggle('flex', visible);
    if (!visible) {
      return;
    }

    this.#paint(spread);
  }

  /** Reconstruit les cartes. Une seule fois par etalage : le reste n'est que des attributs. */
  #build(spread: readonly Card[]): void {
    this.#list.replaceChildren();
    this.#cells = spread.map((card, index) => {
      const root = document.createElement('button');
      root.type = 'button';
      root.className = 'k k-banner draft-card';
      root.dataset.index = `${index}`;
      // La rarete : la bordure et le reflet se lisent en CSS.
      root.dataset.rarity = `${normalizeRarity(card.rarity)}`;

      // Le cadre d'icone : la cle du passif, ou l'epee pour toute arme —
      // l'element se lit dans le detail, en couleur.
      const frame = document.createElement('span');
      frame.className = 'k k-paperx slot h-[150px] w-[150px]';
      const img = document.createElement('img');
      img.src = card.nature === CARD.PASSIVE ? bonusIcon(passiveOf(card.refId).kind) : ICON_WEAPON;
      img.alt = '';
      img.className = 'h-[96px] w-[96px]';
      frame.append(img);
      // La famille de l'arme, en coin du cadre : l'element se lit avant le nom.
      if (card.nature === CARD.WEAPON) {
        const badge = elementBadge(weaponOf(card.refId).element, 40);
        badge.classList.add('draft-card__element');
        frame.append(badge);
      }

      const rarete = document.createElement('span');
      rarete.className = 'draft-card__rarity ol';
      rarete.textContent = rarityLabel(card);

      const nature = document.createElement('span');
      nature.className = 'draft-card__nature';
      nature.textContent = natureLabel(card.nature);

      const name = document.createElement('span');
      name.className = 'draft-card__name ol';
      name.textContent = cardName(card);

      const detail = document.createElement('span');
      detail.className = 'draft-card__detail';
      const { text, color } = cardDetail(card);
      detail.textContent = text;
      if (color !== null) {
        // Une teinte d'element sur parchemin ne se lit qu'avec le contour.
        detail.classList.add('ol');
        detail.style.color = color;
      }

      // Rien ne monte de niveau : ce qu'on possede deja se compte en exemplaires.
      const stacks = document.createElement('span');
      stacks.className = 'draft-card__stacks';
      stacks.textContent = stacksLabel(card, this.#source);

      const tokens = document.createElement('span');
      tokens.className = 'draft-card__tokens';

      root.append(tokens, frame, rarete, nature, name, stacks, detail);

      // Ce que la carte COUTE, sous sa magnitude.
      if (card.nature === CARD.PASSIVE) {
        const cout = malusLabel(passiveOf(card.refId));
        if (cout !== null) {
          const malus = document.createElement('span');
          malus.className = 'draft-card__malus';
          malus.textContent = cout;
          root.append(malus);
        }
      }

      // Une carte que mon inventaire refuse : GRISEE et inerte, la raison au
      // survol (un bandeau chargeait trop la carte). Les jetons des autres
      // restent affiches : elle reste disputable par eux.
      const reason = this.#blockedReason(card);
      root.dataset.blocked = reason === null ? 'false' : 'true';
      if (reason !== null) {
        root.title = `${reason} — ${this.#ownedReminder(card)}`;
      }

      root.addEventListener('click', () => {
        this.#onPick(index);
      });
      this.#list.append(root);
      return { root, tokens, blocked: reason !== null };
    });
  }

  #blockedReason(card: Card): string | null {
    const { localId } = this.#source;
    if (localId === null || !this.#source.loadoutOf) {
      return null;
    }
    return blockedReason(card, this.#source.loadoutOf(localId));
  }

  #ownedReminder(card: Card): string {
    const { localId } = this.#source;
    if (localId === null || !this.#source.loadoutOf) {
      return '';
    }
    const names = ownedNames(card.nature, this.#source.loadoutOf(localId));
    return card.nature === CARD.PASSIVE ? `Vos passifs : ${names}` : `Vos armes : ${names}`;
  }

  /**
   * **Poser un jeton EST la selection**, sans survol puis validation.
   *
   * Recliquer la carte ou mon jeton est pose le **retire** (`NO_TOKEN`) : le
   * joueur passe alors par l'attribution d'office, qui ne prend jamais la carte
   * d'un joueur qui en vise une. C'est le seul geste qui dit « prends-la ».
   *
   * ⚠️ **On lit l'intention du serveur, jamais une intention locale** : pas de
   * jeton optimiste. Deux clics rapides envoient deux fois le meme indice, sans
   * consequence (le serveur idempote `setToken`) ; inutile d'etrangler
   * `DRAFT_TOKEN`.
   */
  #onPick(index: number): void {
    const source = this.#source;
    const mine = source.localId;
    const already = mine === null ? undefined : source.draftIntents.get(mine);
    source.placeToken(already === index ? NO_TOKEN : index);
  }

  #paint(spread: readonly Card[]): void {
    const source = this.#source;
    const mine = source.localId;
    const settled = source.draftSettled;

    this.#root.dataset.settled = settled ? 'true' : 'false';

    const byCard = new Map<number, number[]>();
    for (const [playerId, cardIndex] of source.draftIntents) {
      const list = byCard.get(cardIndex);
      if (list) {
        list.push(playerId);
      } else {
        byCard.set(cardIndex, [playerId]);
      }
    }

    spread.forEach((card, index) => {
      const cell = this.#cells[index];
      if (!cell) {
        return;
      }
      const state = this.#stateOf(card, index, mine);
      cell.root.dataset.state = state;
      // Desactive nativement une fois la resolution fermee, ou si la carte est
      // bloquee : aucun jeton que le serveur refuserait ne part sur le fil.
      cell.root.disabled = settled || cell.blocked;
      cell.root.dataset.mine =
        mine !== null && source.draftIntents.get(mine) === index ? 'true' : 'false';

      // ⚠️ Tri par identifiant : l'ordre d'iteration d'une `Map` suit l'ordre
      // d'arrivee des messages, donc la latence. Les jetons sauteraient de
      // place a chaque rafraichissement.
      const holders = (byCard.get(index) ?? []).slice().sort((a, b) => a - b);
      cell.tokens.replaceChildren(...holders.map((id) => tokenFor(id, id === mine)));
    });

    this.#status.textContent = this.#statusLine(spread, mine, settled);
    if (this.#title && source.draftIsChest) {
      this.#title.textContent = 'Coffre';
    } else if (this.#title && source.level !== undefined) {
      this.#title.textContent = `Niveau ${source.level}`;
    }
  }

  #stateOf(card: Card, index: number, mine: number | null): DraftCardState {
    let mineWon = false;
    let mineLost = false;
    let takenByOther = false;
    for (const issue of this.#outcomes) {
      if (issue.cardIndex !== index) {
        continue;
      }
      if (issue.playerId === mine) {
        if (issue.outcome === OUTCOME.LOST) {
          mineLost = true;
        } else {
          mineWon = true;
        }
      } else if (issue.outcome !== OUTCOME.LOST) {
        // ⚠️ **La perte d'un autre ne prend pas la carte.** Aujourd'hui
        // `Draft#resolve` emet toujours un `WON` par carte contestee, donc la
        // condition semble inutile ; elle est gardee (et testee directement)
        // parce que l'ecran depend du fil, pas de ce que `back/src/draft.ts`
        // emet aujourd'hui : un `LOST` pourra un jour cotoyer une carte libre.
        takenByOther = true;
      }
    }
    // La carte que J'AI obtenue prime sur celle que j'ai perdue, qui prime sur
    // « quelqu'un l'a prise » : c'est mon sort qui se lit, pas l'inventaire de
    // l'equipe.
    if (mineWon) {
      return 'won';
    }
    if (mineLost) {
      return 'lost';
    }
    if (takenByOther) {
      return 'taken';
    }
    void card;
    return 'idle';
  }

  #statusLine(spread: readonly Card[], mine: number | null, settled: boolean): string {
    if (settled) {
      const gagnee = this.#outcomes.find((o) => o.playerId === mine && o.outcome !== OUTCOME.LOST);
      const card = gagnee ? spread[gagnee.cardIndex] : undefined;
      // ⚠️ L'issue qui n'est PAS un `LOST` : le perdant d'un conflit en a deux,
      // la carte perdue puis celle obtenue a la place.
      //
      // Sans carte : l'etalage n'avait rien que l'inventaire puisse accueillir.
      return card ? `Vous obtenez : ${cardName(card)}` : 'Rien cette fois.';
    }
    const seconds = remainingSeconds(this.#source.draftDeadlineTick, this.#source.hordeTick);
    // ⚠️ **« Rien », pas « attribution d'office »** : `Draft#autoPick` ne sert
    // qu'une carte que l'inventaire peut accueillir.
    if (this.#cells.length > 0 && this.#cells.every((c) => c.blocked)) {
      return `Rien ne rentre dans votre inventaire — vous ne recevrez rien cette fois (${seconds} s)`;
    }
    return `Posez votre jeton — ${seconds} s`;
  }
}

/** Un jeton : l'avatar minimal d'un joueur, a sa couleur d'anneau. */
function tokenFor(playerId: number, isLocal: boolean): HTMLElement {
  const token = document.createElement('i');
  token.className = 'draft-token';
  token.dataset.player = `${playerId}`;
  token.dataset.local = isLocal ? 'true' : 'false';
  token.style.background = playerColor(playerId);
  token.textContent = `${playerId}`;
  return token;
}
