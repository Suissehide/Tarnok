import { EXTRACT_MULTIPLIER_STEP } from '@shared/constants';
import { extractGold } from '@shared/paliers';
import { NO_VOTE, VOTE_CHOICE } from '@shared/protocol';

import { playerColor, remainingSeconds } from './draft';

/**
 * L'ecran du vote d'extraction.
 *
 * 1. **Les votes des autres sont visibles, en continu** — on ne negocie pas un
 *    choix qu'on ne voit pas. **L'abstention aussi** : « n'a pas vote » et
 *    « a vote RESTER » sont deux etats differents.
 * 2. **L'enjeu est chiffre** : ce qu'on gagne en partant MAINTENANT, et ce que
 *    la meme cagnotte vaudrait au portail suivant — qu'on perd entierement si
 *    l'equipe tombe entre les deux.
 * 3. **Le chronometre se derive du TICK**, comme celui du draft.
 *
 * ⚠️ **CE N'EST PAS UN MODALE.** Le draft gele le monde ; **le vote ne gele
 * rien**, le temps est son enjeu. Un voile plein ecran cacherait la horde qui
 * avance pendant qu'on decide : d'ou un bandeau, en bas, qui ne capte le
 * pointeur que sur ses deux boutons.
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
 * Un multiplicateur, en ecriture francaise : `×1,25`. Deux decimales toujours,
 * meme sur `1` : `×1` et `×1,25` cote a cote se liraient comme deux grandeurs
 * differentes.
 */
export function formatMultiplier(multiplier: number): string {
  return `×${multiplier.toFixed(2).replace('.', ',')}`;
}

/**
 * Ce qu'un joueur a decide, en un mot — **l'abstention en est un a part
 * entiere**.
 *
 * ⚠️ **« n'a pas voté » ne doit JAMAIS se confondre avec « reste »** : le
 * serveur ne compte pas l'abstention (`Portal#decide`), et un joueur croirait
 * sinon avoir une majorite acquise alors que des voix manquent.
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
  return "n'a pas voté";
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
 * l'equipe tombe. C'est le texte de `stakeLines` qui porte ce risque.
 */
export function stayGold(gold: number, multiplier: number): number {
  return extractGold(gold, multiplier + EXTRACT_MULTIPLIER_STEP);
}

/**
 * Les deux lignes de l'enjeu : ce qu'on gagne en partant, ce qu'on risque en
 * restant.
 *
 * ⚠️ **DEUX chiffres DIFFERENTS** : ce qui se decide, c'est `×m` maintenant
 * contre `×(m + pas)` plus tard, au risque de tout perdre entre les deux.
 */
export function stakeLines(gold: number, multiplier: number): { leave: string; stay: string } {
  return {
    leave: `Partir maintenant : ${formatGold(leaveGold(gold, multiplier))} or acquis (${formatMultiplier(multiplier)})`,
    stay: `Rester : ${formatGold(stayGold(gold, multiplier))} or au prochain portail (${formatMultiplier(multiplier + EXTRACT_MULTIPLIER_STEP)}) — tout est perdu si l'équipe tombe`,
  };
}

interface ChoiceCell {
  root: HTMLButtonElement;
  choice: number;
}

export class PortalScreen {
  readonly #root: HTMLElement;
  readonly #status: HTMLElement;
  readonly #stakes: HTMLElement;
  readonly #choices: HTMLElement;
  readonly #voters: HTMLElement;
  readonly #source: PortalSource;

  #leaveLine: HTMLElement | null = null;
  #stayLine: HTMLElement | null = null;
  #cells: ChoiceCell[] = [];

  constructor(
    root: HTMLElement,
    status: HTMLElement,
    stakes: HTMLElement,
    choices: HTMLElement,
    voters: HTMLElement,
    source: PortalSource,
  ) {
    this.#root = root;
    this.#status = status;
    this.#stakes = stakes;
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

  /** Les deux boutons, construits une seule fois : deux faces, jamais N cartes. */
  #build(): void {
    this.#choices.replaceChildren();
    this.#cells = [
      { choice: VOTE_CHOICE.LEAVE, label: 'Partir' },
      { choice: VOTE_CHOICE.STAY, label: 'Rester' },
    ].map(({ choice, label }) => {
      const root = document.createElement('button');
      root.type = 'button';
      // Partir quitte la run : le bouton rouge des sorties.
      root.className = `btn btn--tab ol portal-choice${choice === VOTE_CHOICE.LEAVE ? ' btn--red' : ''}`;
      root.dataset.choice = voteState(choice);
      root.textContent = label;
      root.addEventListener('click', () => {
        this.#onVote(choice);
      });
      this.#choices.append(root);
      return { root, choice };
    });

    this.#stakes.replaceChildren();
    const leave = document.createElement('span');
    leave.className = 'portal-stake';
    leave.dataset.stake = 'leave';
    const stay = document.createElement('span');
    stay.className = 'portal-stake';
    stay.dataset.stake = 'stay';
    this.#stakes.append(leave, stay);
    this.#leaveLine = leave;
    this.#stayLine = stay;
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

    // ⚠️ **L'or vient du SNAPSHOT, donc il bouge pendant le vote** (les
    // monstres en laissent toujours tomber). Le multiplicateur vient de
    // l'annonce et ne bouge pas de toute la fenetre.
    const lines = stakeLines(source.gold, source.portalMultiplier);
    if (this.#leaveLine) {
      this.#leaveLine.textContent = lines.leave;
    }
    if (this.#stayLine) {
      this.#stayLine.textContent = lines.stay;
    }

    for (const cell of this.#cells) {
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
      // ⚠️ **Le verdict se LIT, et l'or avec lui.** `PORTAL_RESULT` porte un
      // seul champ d'or dont le sens se lit dans la decision : acquis si
      // l'equipe part, reporte si elle reste (voir `PortalResultMessage`).
      return decision === VOTE_CHOICE.LEAVE
        ? `L'équipe part — ${formatGold(source.portalGold)} or acquis.`
        : `L'équipe reste — ${formatGold(source.portalGold)} or toujours en jeu.`;
    }
    // ⚠️ **Derive du TICK, jamais de l'horloge murale** : c'est le tick que le
    // serveur a date, donc le seul temps que les joueurs partagent.
    // `remainingSeconds` est celle du draft, importee plutot que recopiee.
    const seconds = remainingSeconds(source.portalDeadlineTick, source.hordeTick);
    return `Le portail est ouvert — ${seconds} s`;
  }
}

/**
 * Un votant : l'avatar minimal d'un joueur, a sa couleur d'anneau, et **ce
 * qu'il a decide en toutes lettres**.
 *
 * ⚠️ **Le mot, pas seulement la couleur** : sinon « n'a pas vote » et
 * « reste » se ressembleraient sur un ecran ou l'on regarde surtout la horde.
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
