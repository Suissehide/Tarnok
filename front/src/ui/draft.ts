import { applicationsOf, CARD, type Card } from '@shared/cards';
import {
  COLOSSUS_HP_STEP,
  HARVEST_RADIUS,
  PASSIVE_SLOTS,
  TICK_HZ,
  WEAPON_SLOTS,
} from '@shared/constants';
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
 * L'ecran de draft (§4.1, §4.2 et §7.2 de la spec de l'etape 4).
 *
 * Deux choses, et une seule d'entre elles est du confort :
 *
 * 1. **Les intentions sont visibles.** Le jeton de chaque joueur se pose sur la
 *    carte qu'il vise, et tout le monde le voit. Le §7.2 point 3 est
 *    categorique — *« sans cette visibilite, la mecanique n'existe pas »* :
 *    sans les jetons des autres a l'ecran, il ne reste qu'un menu ou l'on
 *    clique, et la negociation qui fait tout l'interet du draft n'a aucun
 *    support.
 * 2. **La revelation est asymetrique et simultanee.** La meme carte s'illumine
 *    chez le gagnant et se consume chez les perdants. C'est ce traitement qui
 *    remplace la rotation de priorite supprimee (§9) : il rend la perte
 *    LISIBLE plutot que subie.
 *
 * Depuis la tache 19, la carte porte aussi ce qu'elle VAUT : l'element d'une
 * arme, le bonus par carte d'un passif — voir `cardDetail`.
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
 * tests le lisent, et tel que la CSS l'anime.
 *
 * ⚠️ `lost` n'est pas « pas gagnee » : c'est **ma** carte, celle sur laquelle
 * j'avais pose mon jeton, et qu'un autre a eue. Une carte qu'un autre a prise
 * sans que je la vise est `taken`, et ne doit pas bruler.
 */
/**
 * ⚠️ **`'locked'` a disparu avec `owner`.** Plus aucune carte n'est reservee :
 * toutes sont ouvertes a tout le monde, et une carte deja visee par un allie
 * reste posable — c'est la negociation.
 *
 * - `won` : elle s'illumine, je l'ai eue ;
 * - `lost` : elle se consume, je l'ai perdue ;
 * - `taken` : un autre l'a eue ;
 * - `idle` : rien de decide, elle s'estompe une fois la resolution passee.
 */
export type DraftCardState = 'idle' | 'taken' | 'won' | 'lost';

/** Les memes teintes que les anneaux de joueur du rendu (`stage.ts`) : un joueur, une couleur. */
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
      return weapon.kind === 'tir' && weapon.projectileSpeed > 0
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
      return `+${n} projectile${n > 1 ? 's' : ''}`;
    }
  }
}

/**
 * Pourquoi le joueur ne peut PAS prendre cette carte, ou `null` s'il le peut.
 *
 * ⚠️ **Le serveur refuse le jeton en silence** (`Draft#eligible`) : sans ce
 * message, le clic sur une nouvelle arme aux slots pleins ne fait rien, et se
 * lit comme un bug. On dit donc la raison AVANT le clic, avec le compte des
 * slots. La regle elle-meme reste `canTake` — jamais recopiee ici, sinon
 * l'ecran et le serveur divergeraient a la premiere retouche.
 */
export function blockedReason(card: Card, loadout: Loadout): string | null {
  if (loadout.canTake(card.nature, card.refId)) {
    return null;
  }
  return card.nature === CARD.PASSIVE
    ? `Passifs complets — ${loadout.passiveSlotsUsed}/${PASSIVE_SLOTS}`
    : `Arsenal complet — ${loadout.weaponSlotsUsed}/${WEAPON_SLOTS} armes`;
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
export const RARITY_NAMES = ['Commune', 'Rare', 'Légendaire'] as const;

/**
 * L'etiquette de rarete (etape 10, §2.5) : le nom ET ce que la carte vaut
 * vraiment — « Rare ×2 », « Légendaire ×3 ».
 *
 * ⚠️ **Le multiplicateur vient de `applicationsOf`, jamais de la table des
 * raretes** : un passif exclusivement legendaire s'applique x1, et lui
 * ecrire « ×3 » serait promettre trois cartes qu'il ne donne pas.
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
 * ⚠️ **Une valeur affichee sans son unite ne veut rien dire.** Les magnitudes
 * du catalogue sont heterogenes par construction : `maxHp` vaut 20 **points
 * bruts**, `speed` 15 **pixels par seconde**, `fireRate` 0,08 et `damage` 0,10
 * qui sont des **fractions**. Un ecran qui afficherait « 20 », « 15 », « 0,08 »
 * et « 0,1 » cote a cote laisserait croire que le premier est mille fois
 * meilleur que le troisieme.
 *
 * ⚠️ **`fireRate` retire une fraction de la RECHARGE**, il n'ajoute pas une
 * fraction de cadence (voir `cooldownWithBonus`) : l'ecrire « +8 % de cadence »
 * serait faux d'un demi-point et, surtout, dirait le contraire de ce que le
 * nombre fait.
 */
const UNITES: Record<PassiveKind, (magnitude: number) => string> = {
  maxHp: (m) => `+${m} PV max`,
  speed: (m) => `+${m} px/s`,
  damage: (m) => `+${pourcent(m)} % dégâts`,
  fireRate: (m) => `−${pourcent(m)} % recharge`,
  // ⚠️ **« /s », et c'est la seule unite de DEBIT du catalogue.** La magnitude
  // de « regain » est en points de vie par seconde ; l'ecrire « +2 PV »
  // laisserait croire a un gain unique, c'est-a-dire exactement ce que
  // « vitalite » fait deja et que cette carte ne fait pas.
  regen: (m) => `+${m.toLocaleString('fr-FR')} PV/s`,
  // Etape 10. ⚠️ Chacun dit OU il agit : « +1 salve » sans « armes de tir »
  // laisserait croire que le halo en profite.
  critChance: (m) => `+${pourcent(m)} % critique`,
  critDamage: (m) => `+${pourcent(m)} % dégâts critiques`,
  salvo: (m) => `+${m} salve, armes de tir`,
  zone: (m) => `+${m} zone, toutes armes`,
  echo: (m) => `+${pourcent(m)} % dégâts de vos réactions`,
  // ⚠️ **« rendu », et le mot n'est pas decoratif** : « +1 PV par mort » se
  // lit comme « +1 PV MAX par mort », c'est-a-dire l'inverse de ce que
  // `resolveHarvest` fait — il SOIGNE, et son gain est meme PLAFONNE par les
  // PV max (`Math.min(p.maxHp, ...)`). Seul « colosse », juste en dessous,
  // parle vraiment du plafond.
  harvest: (m) => `+${m} PV rendu${m > 1 ? 's' : ''} par mort à ${HARVEST_RADIUS} px`,
  colossus: (m) => `+${pourcent(m)} % dégâts par ${COLOSSUS_HP_STEP} PV max`,
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
 * ⚠️ **Par carte, jamais un total.** C'est la doc de `Passive.magnitude`, et
 * c'est ce que le joueur gagne en prenant CETTE carte-ci. Afficher le cumul de
 * son inventaire mentirait sur l'empilement — la colonne des passifs (tache
 * 18) dit deja combien d'exemplaires il possede, et les deux lectures se
 * completent : « +20 PV max » sur la carte, « vitalite ×4 » dans le coin.
 */
export function magnitudeLabel(passive: Passive): string {
  return UNITES[passive.kind](passive.magnitude);
}

/**
 * Ce que la carte dit EN PLUS de son nom : l'element pour une arme, la valeur
 * pour un passif.
 *
 * **L'element sur les armes** (§6.5, *« le coeur du projet »*) : le nom seul ne
 * dit pas si l'arme sert la Braise ou le Givre, donc pas si elle COMPLETE ce
 * qu'un allie vient de prendre — or c'est exactement la negociation que
 * l'etalage existe pour produire.
 *
 * ⚠️ **Une arme neutre se lit « neutre »**, elle ne se lit pas comme une carte
 * a qui il manque une ligne. `ELEMENT.NEUTRE` est une entree de la table comme
 * les autres (§4 de la spec de l'etape 5a), pas un cas particulier : cinq armes
 * du catalogue sur neuf sont neutres et le restent — *« un socle pour les
 * joueurs qui ne veulent pas jouer le systeme »*.
 *
 * `color` est la teinte de l'element, lue dans `ELEMENTS` et jamais recopiee :
 * c'est la MEME que celle de l'anneau de marque et de la zone au sol, donc la
 * carte annonce la couleur qu'on verra au sol en tirant. Nulle pour un passif,
 * qui n'a pas d'element a porter.
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
 * ⚠️ **Prend le nombre en parametre plutot que de lire `ELEMENTS`**, pour la
 * meme raison que `assertWeaponElements` : les trois teintes du catalogue
 * commencent toutes par un chiffre non nul, donc le remplissage a six chiffres
 * ne s'y exerce jamais et sa mutation survivait a toute la suite. Avec un
 * parametre, le test lui donne une teinte sombre — `0x00aabb` s'ecrirait
 * « #aabb », que le navigateur ignore, et la carte perdrait sa couleur le jour
 * ou la Poix ou le Vif-argent entreront au catalogue (§6.3 de l'orientation).
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
   * Les issues **cumulees** du draft en cours, repioche comprise.
   *
   * ⚠️ **`GameClient.draftOutcomes` ne porte que le DERNIER message.** Un
   * joueur qui gagne au premier tour voit sa carte s'illuminer a la phase 1,
   * puis le `DRAFT_RESULT` de phase 0 — celui de la repioche, qui ne le
   * concerne pas — remplacerait ses issues par celles des autres, et sa carte
   * s'eteindrait **au moment meme ou elle doit confirmer** (§4.2).
   *
   * On cumule donc ici, et on ne remet a zero qu'au prochain etalage. C'est ce
   * qui permet aussi au perdant du premier tour de voir, a la fin, sa carte
   * brulee ET sa carte de repioche allumee — « on voit ce qu'on perd, on voit
   * ce qu'on obtient a la place ».
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

    // ⚠️ **L'etalage survit a la fermeture** (`draftSettled` ne veut pas dire
    // « il n'y a plus rien a montrer »), et c'est l'ecran qui decide quand il
    // arrete de dessiner. Il s'arrete a la fin de la rampe de reprise :
    // `isFrozen` couvre le gel ET sa rampe, donc la revelation finale tient
    // l'ecran exactement le temps que le monde met a redemarrer.
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
      // La rarete (etape 10) : la bordure et le reflet se lisent en CSS.
      root.dataset.rarity = `${normalizeRarity(card.rarity)}`;

      // Le cadre d'icone de la maquette (ecran 05) : la cle du passif, ou
      // l'epee pour toute arme — l'element se lit dans le detail, en couleur.
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

      // Tache 19 : l'element sur les armes, la valeur sur les passifs.
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

      // Une carte que mon inventaire refuse : simplement GRISEE et inerte
      // (retour de playtest : un bandeau en plus chargeait la carte). La raison
      // reste au survol. Les jetons des autres restent affiches : elle reste
      // disputable par eux.
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

  /**
   * Le geste du §4.1 : **poser un jeton EST la selection**, pas de survol puis
   * validation.
   *
   * Recliquer la carte ou mon jeton est deja pose le **retire** (`NO_TOKEN`).
   * Ce n'est pas de la symetrie gratuite : un jeton retire fait passer le
   * joueur par l'attribution d'office, qui par construction ne prend jamais la
   * carte d'un joueur qui en vise une (§4.4). C'est donc le seul geste qui
   * exprime « vas-y, prends-la » — de la negociation, ce que l'etalage existe
   * pour produire.
   *
   * ⚠️ **On lit l'intention du serveur, pas une intention locale.** Le client
   * n'affiche jamais un jeton de facon optimiste ; le bref aller-retour ou
   * deux clics rapides envoient deux fois le meme indice est sans consequence
   * (le serveur idempote `setToken`) et reste borne par le nombre de clics
   * humains — c'est ce qui repond a la question laissee ouverte par la tache 9
   * sur l'etranglement de `DRAFT_TOKEN`.
   */
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
      // Cliquable tant que la negociation est ouverte : une resolution
      // fermee desactive le bouton nativement, aucun clic n'atteint `#onPick`.
      // Une carte bloquee l'est aussi nativement : aucun jeton refuse en
      // silence par le serveur ne part sur le fil.
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
    if (this.#title && source.level !== undefined) {
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
        // `Draft#resolve` emet toujours exactement un `WON` par carte
        // contestee, donc toute carte portant un `LOST` porte aussi un
        // gagnant : neutraliser cette condition ne change rien A CE QUE LE
        // SERVEUR PRODUIT — la mutation « `else` sans condition » survit a un
        // test de bout en bout, et c'est le motif R8/R10 du registre.
        //
        // Elle est gardee quand meme, et testee sur l'entree qu'elle decrit :
        // l'ecran est une fonction de ce qui arrive sur le fil, pas de ce que
        // `back/src/draft.ts` se trouve emettre ce mois-ci. Le §4.4 de la spec
        // veut d'ailleurs que les perdants d'un reconflit recoivent une
        // attribution d'office — le jour ou ce sera vrai, un `LOST` pourra
        // cotoyer une carte encore libre.
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
    // ⚠️ Plus aucune carte n'est reservee : toutes sont ouvertes a tout le
    // monde. L'etat `'locked'` a disparu avec `owner`, et une carte deja visee
    // par un allie reste posable — c'est la negociation.
    void card;
    return 'idle';
  }

  #statusLine(spread: readonly Card[], mine: number | null, settled: boolean): string {
    if (settled) {
      const gagnee = this.#outcomes.find((o) => o.playerId === mine && o.outcome !== OUTCOME.LOST);
      const card = gagnee ? spread[gagnee.cardIndex] : undefined;
      // ⚠️ On cherche l'issue qui n'est PAS un `LOST` : le perdant d'un conflit
      // en a deux — la carte disputee qu'il perd, puis celle qu'il obtient a la
      // place. C'est la seconde qui se lit ici.
      //
      // Le cas sans carte reste possible : l'etalage peut n'avoir plus rien que
      // cet inventaire puisse accueillir. Le dire vaut mieux qu'un ecran muet.
      return card ? `Vous obtenez : ${cardName(card)}` : 'Rien cette fois.';
    }
    const seconds = remainingSeconds(this.#source.draftDeadlineTick, this.#source.hordeTick);
    // ⚠️ **« Rien », pas « attribution d'office ».** `Draft#autoPick` ne sert
    // qu'une carte que l'inventaire peut accueillir : si aucune ne rentre, le
    // joueur repart les mains vides. Promettre une attribution serait faux.
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
