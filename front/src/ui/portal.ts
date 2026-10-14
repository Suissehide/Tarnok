import { EXTRACT_MULTIPLIER_STEP } from '@shared/constants';
import { extractGold } from '@shared/paliers';
import { NO_VOTE, VOTE_CHOICE } from '@shared/protocol';

import { playerColor, remainingSeconds } from './draft';

/**
 * L'ecran du vote d'extraction (§5 et §6 de la spec de l'etape 6a).
 *
 * Trois choses, et aucune des trois n'est du confort :
 *
 * 1. **Les votes des autres sont visibles, en continu.** Le §7.2 de l'etape 4
 *    l'a etabli pour les jetons du draft — *« sans cette visibilite, la
 *    mecanique n'existe pas »* — et le §6 le dit plus fort encore : on ne
 *    negocie pas un choix qu'on ne voit pas. **Et l'abstention est visible
 *    AUSSI** : « n'a pas vote » et « a vote RESTER » sont deux etats
 *    differents, les confondre fausserait la negociation.
 * 2. **L'enjeu est chiffre.** Un vote dont on ne voit pas l'enjeu n'est pas un
 *    vote : l'ecran dit ce qu'on gagne en partant MAINTENANT, et ce que la
 *    meme cagnotte vaudrait au portail suivant — celle-la meme qu'on perd
 *    entierement si l'equipe tombe entre les deux.
 * 3. **Le chronometre se derive du TICK**, pas de l'horloge murale. Comme
 *    celui du draft, et pour la meme raison : c'est le tick que le serveur a
 *    date, donc le seul temps que les quatre joueurs partagent.
 *
 * ⚠️ **CE N'EST PAS UN MODALE, et c'est la difference structurante avec
 * l'etalage de cartes.** Le draft GELE le monde, donc il peut occuper l'ecran
 * entier ; **le vote ne gele rien** (§6 : *« le temps EST son enjeu »*). Un
 * voile plein ecran cacherait la horde qui avance pendant qu'on decide,
 * c'est-a-dire exactement la pression que la fenetre existe pour produire.
 * D'ou un bandeau, en bas, qui ne capte le pointeur que sur ses deux boutons.
 *
 * ⚠️ **L'ecran ne se cache PAS pour un joueur mort.** Le §6 fait voter *« tout
 * joueur connecte, mort ou vif »*, et le §9.3 dit que la mort d'un seul ne
 * coute rien — donc elle ne coute ni la voix ni l'ecran. Il n'y a aucune
 * condition a ecrire ici : `PortalSource` ne porte pas de points de vie, et
 * c'est la forme que prend la regle. Un filtre a `false` serait une garde
 * qu'aucune mutation ne pourrait tuer.
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
 * Un montant d'or, groupe par milliers.
 *
 * ⚠️ **Groupe a la main plutot que par `toLocaleString`.** Les separateurs
 * d'`Intl` changent d'une version de Node a l'autre (espace insecable, espace
 * fine insecable), et un test qui assene un montant se mettrait a rougir sur
 * une montee de runtime sans qu'une ligne de ce depot ait bouge. Ici le
 * separateur est choisi et il ne bouge pas.
 */
/**
 * Le separateur des milliers : U+202F, espace fine insecable.
 *
 * ⚠️ **Ecrit par `fromCharCode`, pas comme caractere litteral.** Le formateur
 * du depot reecrit les sequences d'echappement des chaines en caracteres
 * reels : `'\u202f'` deviendrait un espace INVISIBLE dans la source, qu'une
 * relecture prendrait pour une espace ordinaire et qu'un editeur pourrait
 * normaliser sans bruit. Ici, il est nomme.
 */
export const THIN_SPACE = String.fromCharCode(0x202f);

export function formatGold(gold: number): string {
  return `${Math.round(gold)}`.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
}

/**
 * Un multiplicateur, en ecriture francaise : `×1,25`.
 *
 * Deux decimales toujours, meme sur `1` : `×1` et `×1,25` cote a cote se
 * lisent comme deux grandeurs differentes, alors que c'est la MEME et que
 * c'est precisement sa progression qui est en jeu.
 */
export function formatMultiplier(multiplier: number): string {
  return `×${multiplier.toFixed(2).replace('.', ',')}`;
}

/**
 * Ce qu'un joueur a decide, en un mot — et **l'abstention en est un a part
 * entiere**.
 *
 * ⚠️ **« n'a pas voté » ne doit JAMAIS se confondre avec « reste ».** Le
 * serveur ne compte pas l'abstention (`NO_VOTE = 255`, et `Portal#decide` ne
 * l'additionne d'aucun cote) ; l'ecran doit la montrer telle quelle, sans quoi
 * un joueur croirait avoir une majorite acquise alors que deux voix
 * manquent — et la negociation porterait sur un decompte faux.
 *
 * Tout ce qui n'est ni `STAY` ni `LEAVE` se lit comme une abstention : c'est
 * ce que `NO_VOTE` vaut, et un octet fantaisiste (le serveur en refuse
 * l'enregistrement, mais l'ecran est une fonction de ce qui arrive sur le fil)
 * n'est pas davantage une voix.
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
 * ⚠️ **Passe par `extractGold`, jamais par une multiplication ecrite ici.**
 * C'est la fonction que `Room#stepPortal` appelle pour calculer l'or reellement
 * verse : l'arrondi et la borne du fil (`GOLD_MAX`) vivent avec elle. Une
 * multiplication de plus dans ce fichier ferait annoncer a l'ecran un montant
 * different de celui que le joueur recevrait — un mensonge, exactement la ou
 * il se paie le plus cher.
 */
export function leaveGold(gold: number, multiplier: number): number {
  return extractGold(gold, multiplier);
}

/**
 * Ce que la MEME cagnotte vaudrait au portail suivant, si l'equipe reste et
 * tient le palier.
 *
 * ⚠️ **Le multiplicateur suivant se DERIVE, il ne voyage pas.** `PORTAL_OPEN`
 * porte celui qui s'applique maintenant ; le suivant vaut
 * `+ EXTRACT_MULTIPLIER_STEP`, constante partagee que les deux cotes lisent
 * (`Room#stepPortal` l'ajoute avec la meme). Le porter aussi serait un second
 * exemplaire d'un nombre que le premier suffit a donner.
 *
 * ⚠️ **Ce n'est PAS une promesse.** Entre les deux portails la cagnotte peut
 * grossir (les monstres laissent de l'or) et surtout **tout se perdre** :
 * l'effacement de l'equipe garde `WIPE_GOLD_KEPT` de la mise, soit rien. C'est
 * le texte qui porte cette moitie-la, pas le chiffre — voir `stakeLines`.
 */
export function stayGold(gold: number, multiplier: number): number {
  return extractGold(gold, multiplier + EXTRACT_MULTIPLIER_STEP);
}

/**
 * Les deux lignes de l'enjeu : ce qu'on gagne en partant, ce qu'on risque en
 * restant.
 *
 * ⚠️ **DEUX chiffres, et ils doivent etre DIFFERENTS.** Une version qui aurait
 * mis la meme cagnotte des deux cotes, avec seulement les mots qui changent,
 * n'aurait rien fait voir : ce qui se decide, c'est la difference entre
 * `×m` maintenant et `×(m + pas)` plus tard, contre la perte totale entre les
 * deux.
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

  /**
   * A appeler a chaque image : l'ecran n'a pas d'horloge propre, il lit le
   * client — exactement comme `DraftScreen.update`.
   */
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
   * Les deux boutons, une seule fois. **Deux faces, jamais N cartes** : c'est
   * ce qui distingue ce vote du draft, ou le nombre de cartes depend du nombre
   * de joueurs et impose une reconstruction par etalage.
   */
  #build(): void {
    this.#choices.replaceChildren();
    this.#cells = [
      { choice: VOTE_CHOICE.LEAVE, label: 'Partir' },
      { choice: VOTE_CHOICE.STAY, label: 'Rester' },
    ].map(({ choice, label }) => {
      const root = document.createElement('button');
      root.type = 'button';
      // Partir quitte la run : le bouton rouge des sorties (ecran 06).
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
   * Le geste : **cliquer une face EST le vote**, pas de survol puis
   * validation — le meme parti que le jeton du draft.
   *
   * Recliquer la face qu'on a deja choisie la **retire** (`NO_VOTE`). Ce n'est
   * pas de la symetrie gratuite : le §6 veut qu'on negocie vingt secondes en
   * voyant les autres, et une voix qu'on ne pourrait plus reprendre
   * transformerait la negociation en course au clic. C'est aussi le seul geste
   * qui dise « je vous laisse decider ».
   *
   * ⚠️ **On lit le vote du SERVEUR, jamais un vote local optimiste.** Le client
   * ne decide rien (§7.2 de l'etape 4) : il envoie, et il affiche ce que
   * `VOTES` rediffuse.
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

    // ⚠️ **L'or vient du SNAPSHOT, donc il bouge a chaque image** — les
    // monstres continuent d'en laisser tomber pendant qu'on vote (tache 14).
    // Le multiplicateur, lui, vient de l'annonce et ne bouge pas de toute la
    // fenetre : c'est pour ca qu'il n'est pas dans le snapshot.
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
      // Cliquable tant que le verdict n'est pas tombe. Apres, il n'y a plus
      // rien a negocier : le portail est ferme cote serveur, et un `VOTE` de
      // plus serait refuse de toute facon.
      cell.root.disabled = settled;
    }

    // ⚠️ Tri par identifiant : l'ordre d'iteration d'une `Map` suit l'ordre
    // d'arrivee des messages, donc la latence. Les votants sauteraient de place
    // a chaque rafraichissement — la lecon des jetons du draft.
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
    // serveur a date, donc le seul temps que les quatre joueurs partagent.
    // `remainingSeconds` est celle du draft, importee plutot que recopiee — une
    // seconde version de la meme formule finirait par en dire une autre.
    const seconds = remainingSeconds(source.portalDeadlineTick, source.hordeTick);
    return `Le portail est ouvert — ${seconds} s`;
  }
}

/**
 * Un votant : l'avatar minimal d'un joueur, a sa couleur d'anneau, et **ce
 * qu'il a decide en toutes lettres**.
 *
 * ⚠️ **Le mot, pas seulement la couleur.** Un `data-choice` que seule la CSS
 * lirait laisserait « n'a pas vote » et « reste » se ressembler sur un ecran de
 * jeu ou l'on regarde surtout la horde. Le §6 veut qu'on VOIE les votes.
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
