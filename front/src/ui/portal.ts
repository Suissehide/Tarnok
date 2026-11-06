import { EXTRACT_MULTIPLIER_STEP } from '@shared/constants';
import { extractGold } from '@shared/paliers';
import { NO_VOTE, VOTE_CHOICE } from '@shared/protocol';

import { playerColor, remainingSeconds } from './draft';

/**
 * L'ecran du vote d'extraction : une carte compacte, au centre (etape 17).
 *
 * 1. **Les votes des autres sont visibles, en continu** — une pastille par
 *    joueur, a sa couleur. **L'abstention aussi** : « n'a pas vote » et
 *    « a vote RESTER » sont deux etats differents.
 * 2. **Un montant par bouton** : l'or acquis en partant, l'or vise en restant
 *    « si l'equipe tient ». Le multiplicateur ne s'ecrit plus.
 * 3. **Le chronometre se derive du TICK**, comme celui du draft.
 *
 * ⚠️ **Le portail GELE le monde** (`Room#step`, etape 17) : on decide a l'abri,
 * d'ou un voile leger comme l'etalage. Le voile ne capte pas le pointeur ;
 * seule la carte le reprend.
 *
 * ⚠️ **L'ecran ne se cache PAS pour un joueur mort** : tout joueur connecte
 * vote, mort ou vif. Aucune condition a ecrire : `PortalSource` ne porte pas
 * de points de vie.
 */

/** Ce que l'ecran lit — la surface de `GameClient` qui concerne le vote, et rien d'autre. */
export interface PortalSource {
  readonly localId: number | null;
  readonly hordeTick: number;
  readonly portalOpen: boolean;
  readonly portalDeadlineTick: number;
  readonly portalMultiplier: number;
  readonly portalVotes: ReadonlyMap<number, number>;
  readonly portalDecision: number | null;
  readonly portalGold: number;
  /** La cagnotte NON SECURISEE, telle que le snapshot la porte a chaque tick. */
  readonly gold: number;
  castVote(choice: number): void;
}

/**
 * Le separateur des milliers : U+202F, espace fine insecable.
 *
 * ⚠️ **Ecrit par `fromCharCode`, pas comme caractere litteral** : le formateur
 * du depot reecrit `'\u202f'` en caractere reel, une espace INVISIBLE dans la
 * source qu'un editeur pourrait normaliser sans bruit.
 */
export const THIN_SPACE = String.fromCharCode(0x202f);

/**
 * Un montant d'or, groupe par milliers.
 *
 * ⚠️ **Groupe a la main plutot que par `toLocaleString`** : les separateurs
 * d'`Intl` changent d'une version de Node a l'autre, et les tests rougiraient
 * sur une montee de runtime.
 */
export function formatGold(gold: number): string {
  return `${Math.round(gold)}`.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
}

/**
 * Ce qu'un joueur a decide, en un mot court — **l'abstention en est un a part
 * entiere**.
 *
 * ⚠️ **« … » (pas encore vote) ne doit JAMAIS se confondre avec « reste »** :
 * le serveur ne compte pas l'abstention (`Portal#decide`), et un joueur
 * croirait sinon avoir une majorite acquise alors que des voix manquent.
 *
 * Tout ce qui n'est ni `STAY` ni `LEAVE` (`NO_VOTE`, ou un octet fantaisiste)
 * se lit comme une abstention.
 */
export function voteLabel(choice: number): string {
  if (choice === VOTE_CHOICE.LEAVE) {
    return 'part';
  }
  if (choice === VOTE_CHOICE.STAY) {
    return 'reste';
  }
  return '…';
}

/** L'etat d'un votant, tel qu'il s'ecrit dans `data-choice` — donc tel que les tests le lisent. */
export type VoteState = 'leave' | 'stay' | 'none';

export function voteState(choice: number): VoteState {
  if (choice === VOTE_CHOICE.LEAVE) {
    return 'leave';
  }
  return choice === VOTE_CHOICE.STAY ? 'stay' : 'none';
}

/**
 * Ce qu'on ACQUIERT en partant maintenant : la cagnotte, majoree du
 * multiplicateur courant.
 *
 * ⚠️ **Passe par `extractGold`, jamais par une multiplication ecrite ici** :
 * c'est la fonction que `Room#stepPortal` appelle pour l'or reellement verse
 * (arrondi et borne `GOLD_MAX` compris). L'ecran annonce donc ce que le joueur
 * recevra.
 */
export function leaveGold(gold: number, multiplier: number): number {
  return extractGold(gold, multiplier);
}

/**
 * Ce que la MEME cagnotte vaudrait au portail suivant, si l'equipe reste et
 * tient le palier.
 *
 * ⚠️ **Le multiplicateur suivant se DERIVE, il ne voyage pas** : `PORTAL_OPEN`
 * porte le courant, le suivant vaut `+ EXTRACT_MULTIPLIER_STEP`, constante
 * partagee que `Room#stepPortal` ajoute aussi.
 *
 * ⚠️ **Ce n'est PAS une promesse** : la cagnotte peut grossir, ou se perdre si
 * l'equipe tombe. C'est le « si l'equipe tient » sous le bouton qui le dit.
 */
export function stayGold(gold: number, multiplier: number): number {
  return extractGold(gold, multiplier + EXTRACT_MULTIPLIER_STEP);
}

/**
 * La touche d'un vote : `1` part, `2` reste — rangee du haut ou pave
 * numerique, lus sur `KeyboardEvent.code` (la touche PHYSIQUE : en AZERTY, `1`
 * sans majuscule donne « & »). `null` pour toute autre touche.
 *
 * ⚠️ **`blocked` vient de `main.ts`** : menu Echap ouvert, bilan affiche, HUD
 * cache, ou touche tenue (`repeat`, qui ferait clignoter la voix). Il est
 * ICI, et pas seulement dans `main.ts`, pour qu'un test le tienne.
 */
export function portalKeyChoice(code: string, blocked: boolean): number | null {
  if (blocked) {
    return null;
  }
  if (code === 'Digit1' || code === 'Numpad1') {
    return VOTE_CHOICE.LEAVE;
  }
  if (code === 'Digit2' || code === 'Numpad2') {
    return VOTE_CHOICE.STAY;
  }
  return null;
}

interface ChoiceCell {
  root: HTMLButtonElement;
  choice: number;
  /** Le montant affiche sous le bouton. */
  gold: HTMLElement;
}

/** Les deux faces, dans l'ordre affiche, avec leur touche (voir `portalKeyChoice`). */
const FACES = [
  { choice: VOTE_CHOICE.LEAVE, label: 'Partir', key: '1' },
  { choice: VOTE_CHOICE.STAY, label: 'Rester', key: '2' },
] as const;

export class PortalScreen {
  readonly #root: HTMLElement;
  readonly #status: HTMLElement;
  readonly #choices: HTMLElement;
  readonly #voters: HTMLElement;
  readonly #source: PortalSource;

  #cells: ChoiceCell[] = [];

  constructor(
    root: HTMLElement,
    status: HTMLElement,
    choices: HTMLElement,
    voters: HTMLElement,
    source: PortalSource,
  ) {
    this.#root = root;
    this.#status = status;
    this.#choices = choices;
    this.#voters = voters;
    this.#source = source;
  }

  /** A appeler a chaque image : l'ecran n'a pas d'horloge propre, il lit le client. */
  update(): void {
    const source = this.#source;
    const visible = source.portalOpen;
    this.#root.classList.toggle('hidden', !visible);
    this.#root.classList.toggle('flex', visible);
    if (!visible) {
      return;
    }
    if (this.#cells.length === 0) {
      this.#build();
    }
    this.#paint();
  }

  /**
   * Vote au clavier (voir `portalKeyChoice`) : la MEME regle que le clic —
   * rappuyer sur la touche de sa voix la retire.
   *
   * ⚠️ **Inerte hors d'un vote ouvert et non tranche** : apres le verdict, le
   * portail est ferme cote serveur, et un `VOTE` y serait refuse ; sans portail,
   * `1` et `2` ne veulent rien dire.
   */
  vote(choice: number): void {
    const source = this.#source;
    if (!source.portalOpen || source.portalDecision !== null) {
      return;
    }
    this.#onVote(choice);
  }

  /**
   * Les deux faces, construites une seule fois : un bouton (libelle et
   * touche), son montant dessous, et « si l'equipe tient » sous Rester.
   */
  #build(): void {
    this.#choices.replaceChildren();
    this.#cells = FACES.map(({ choice, label, key }) => {
      const state = voteState(choice);
      const option = document.createElement('div');
      option.className = 'portal-option';

      const root = document.createElement('button');
      root.type = 'button';
      // Partir quitte la run : le bouton rouge des sorties.
      root.className = `btn btn--tab ol portal-choice${choice === VOTE_CHOICE.LEAVE ? ' btn--red' : ''}`;
      root.dataset.choice = state;
      // Raccourci porte par le bouton : un lecteur d'ecran l'annonce sans
      // avoir besoin du `<kbd>` visuel, masque ci-dessous.
      root.setAttribute('aria-keyshortcuts', key);
      const text = document.createElement('b');
      text.className = 'portal-choice__label';
      text.textContent = label;
      const hint = document.createElement('kbd');
      hint.className = 'portal-choice__key';
      hint.textContent = key;
      // Masque : l'info est deja sur le bouton via `aria-keyshortcuts`, la
      // repeter doublerait l'annonce du lecteur d'ecran.
      hint.setAttribute('aria-hidden', 'true');
      root.append(text, hint);
      root.addEventListener('click', () => {
        this.#onVote(choice);
      });

      const gold = document.createElement('span');
      gold.className = 'portal-option__gold f-jer ol';
      gold.dataset.gold = state;
      option.append(root, gold);

      if (choice === VOTE_CHOICE.STAY) {
        const note = document.createElement('span');
        note.className = 'portal-option__note';
        note.textContent = 'si l’équipe tient';
        option.append(note);
      }
      this.#choices.append(option);
      return { root, choice, gold };
    });
  }

  /**
   * **Cliquer une face EST le vote**, comme le jeton du draft.
   *
   * Recliquer la face choisie la **retire** (`NO_VOTE`) : une voix qu'on ne
   * pourrait plus reprendre ferait de la negociation une course au clic. C'est
   * aussi le seul geste qui dise « je vous laisse decider ».
   *
   * ⚠️ **On lit le vote du SERVEUR, jamais un vote local optimiste** : le
   * client envoie, et affiche ce que `VOTES` rediffuse.
   */
  #onVote(choice: number): void {
    const mine = this.#source.localId;
    const already = mine === null ? undefined : this.#source.portalVotes.get(mine);
    this.#source.castVote(already === choice ? NO_VOTE : choice);
  }

  #paint(): void {
    const source = this.#source;
    const mine = source.localId;
    const decision = source.portalDecision;
    const settled = decision !== null;

    this.#root.dataset.settled = settled ? 'true' : 'false';
    this.#status.textContent = this.#statusLine(decision);

    for (const cell of this.#cells) {
      // L'or vient du SNAPSHOT ; le monde est gele pendant le vote, mais
      // l'ecran ne decide rien : il relit a chaque image.
      const montant =
        cell.choice === VOTE_CHOICE.LEAVE
          ? leaveGold(source.gold, source.portalMultiplier)
          : stayGold(source.gold, source.portalMultiplier);
      cell.gold.textContent = `${formatGold(montant)} or`;
      cell.root.dataset.mine =
        mine !== null && source.portalVotes.get(mine) === cell.choice ? 'true' : 'false';
      // Cliquable tant que le verdict n'est pas tombe : ensuite le portail est
      // ferme cote serveur, et un `VOTE` serait refuse.
      cell.root.disabled = settled;
    }

    // ⚠️ Tri par identifiant : l'ordre d'iteration d'une `Map` suit l'ordre
    // d'arrivee des messages, donc la latence. Les votants sauteraient de place
    // a chaque rafraichissement.
    const voters = [...source.portalVotes].sort((a, b) => a[0] - b[0]);
    this.#voters.replaceChildren(
      ...voters.map(([playerId, choice]) => voterFor(playerId, choice, playerId === mine)),
    );
  }

  #statusLine(decision: number | null): string {
    const source = this.#source;
    if (decision !== null) {
      // ⚠️ **Le verdict se LIT** jusqu'a la disparition de la carte
      // (`#portalCloseTick`). `PORTAL_RESULT` porte un seul champ d'or dont le
      // sens se lit dans la decision : on ne l'affiche que s'il est ACQUIS.
      return decision === VOTE_CHOICE.LEAVE
        ? `L’équipe part — ${formatGold(source.portalGold)} or`
        : 'L’équipe reste';
    }
    // ⚠️ **Derive du TICK, jamais de l'horloge murale** : c'est le tick que le
    // serveur a date, donc le seul temps que les joueurs partagent.
    // `remainingSeconds` est celle du draft, importee plutot que recopiee.
    const seconds = remainingSeconds(source.portalDeadlineTick, source.hordeTick);
    return `Portail — ${seconds} s`;
  }
}

/**
 * Un votant : une pastille a la couleur du joueur, son numero, et **ce qu'il a
 * decide en un mot court**.
 *
 * ⚠️ **Le mot, pas seulement la couleur** : sinon « pas encore vote » et
 * « reste » se ressembleraient. La pastille creuse (CSS, `data-choice="none"`)
 * le redit.
 */
function voterFor(playerId: number, choice: number, isLocal: boolean): HTMLElement {
  const voter = document.createElement('span');
  voter.className = 'portal-voter';
  voter.dataset.player = `${playerId}`;
  voter.dataset.choice = voteState(choice);
  voter.dataset.local = isLocal ? 'true' : 'false';
  voter.style.borderColor = playerColor(playerId);

  const badge = document.createElement('i');
  badge.className = 'portal-voter__badge';
  badge.style.background = playerColor(playerId);
  badge.textContent = `${playerId}`;

  const label = document.createElement('b');
  label.className = 'portal-voter__label';
  label.textContent = voteLabel(choice);

  voter.append(badge, label);
  return voter;
}
