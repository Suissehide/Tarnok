import { PORTAL_WINDOW_TICKS } from '@shared/constants';
import { NO_VOTE, VOTE_CHOICE } from '@shared/protocol';

/**
 * ⚠️ **Deux etats, et il n'y en aura jamais un troisieme.** Le draft en a eu
 * un (`'repick'`) avant de le perdre : la resolution est un seul moment. Ici
 * c'est vrai par construction — il n'y a rien a rechoisir apres un verdict.
 */
export type PortalPhase = 'closed' | 'open';

/**
 * La machine a etats du vote d'extraction (§6 de la spec de l'etape 6a).
 *
 * Calquee sur `back/src/draft.ts`, qui est eprouve sur deux etapes : ouverture
 * datee, intentions rediffusees, resolution annoncee, absents tranches
 * d'office. Elle **ne connait ni `ws`, ni `fastify`, ni `Room`** : elle recoit
 * des identifiants et des choix, elle rend un verdict.
 *
 * Ce qui change par rapport au draft, et c'est tout :
 *
 * | | draft | portail |
 * | --- | --- | --- |
 * | ce qu'on choisit | une carte parmi N | deux faces |
 * | ce qui tranche | un tirage | une **majorite** |
 * | le monde | **gele** | **continue de tourner** |
 *
 * ⚠️ **Le gel n'est pas absent par oubli.** Cette classe ne le decide pas plus
 * que `Draft` ne le decidait — c'est `Room#step` qui gele ou non — mais c'est
 * ICI que la raison se lit : le draft gele parce qu'un choix de carte n'a pas
 * d'enjeu temporel ; le vote ne gele pas parce que **le temps EST son enjeu**
 * (§6). La vague suivante approche pendant qu'on negocie.
 *
 * ⚠️ **Aucune source aleatoire.** Le draft en prend une pour departager les
 * pretendants d'une meme carte ; ici l'egalite a une regle, pas un tirage —
 * elle continue. Une `rng` de plus serait un parametre que rien ne peut faire
 * rougir.
 */
export class Portal {
  #phase: PortalPhase = 'closed';
  #deadlineTick = 0;
  /**
   * Qui vote : tous les joueurs du salon a l'ouverture, **morts ou vifs**.
   *
   * ⚠️ **Cette classe ne sait rien des points de vie, et c'est la forme que
   * prend la regle du §9.3.** *« La mort d'un seul joueur ne coute rien »* —
   * donc elle ne coute pas la voix non plus. Le filtre n'existe pas plutot
   * que d'exister a `false` : il n'y a aucun endroit ou l'ecrire.
   */
  #pending: number[] = [];
  /**
   * `playerId -> VOTE_CHOICE.STAY | VOTE_CHOICE.LEAVE | NO_VOTE`, pour
   * **chaque** participant des l'ouverture.
   *
   * ⚠️ **L'abstention est une entree, pas une absence d'entree** — a la
   * difference des jetons du draft, ou un joueur sans jeton ne figure pas dans
   * la `Map`. Le §6 veut que les votes soient visibles *en continu* : les
   * autres doivent voir **qui n'a pas encore tranche**, c'est la matiere de la
   * negociation. `NO_VOTE` circule donc dans `VOTES` (voir sa doc dans
   * `shared/protocol.ts`), et il ne se compte pas pour autant.
   */
  #votes = new Map<number, number>();

  get phase(): PortalPhase {
    return this.#phase;
  }

  get deadlineTick(): number {
    return this.#deadlineTick;
  }

  /**
   * Ouvre le portail pour `PORTAL_WINDOW_TICKS` ticks.
   *
   * ⚠️ **Le portail s'ouvre a une MORT, jamais a un tick** — c'est `Room` qui
   * l'appelle, quand le boss tombe (§2 : le palier se termine a la mort du
   * boss). Cette classe n'en sait rien et n'a pas a en savoir : elle date sa
   * fenetre a partir du tick qu'on lui donne.
   */
  open(tick: number, playerIds: readonly number[]): void {
    this.#phase = 'open';
    this.#pending = [...playerIds];
    this.#votes.clear();
    for (const id of playerIds) {
      this.#votes.set(id, NO_VOTE);
    }
    this.#deadlineTick = tick + PORTAL_WINDOW_TICKS;
  }

  /**
   * Enregistre le vote d'un joueur, ou le retire (`NO_VOTE`). Rend `false` si
   * le geste est refuse : portail ferme, joueur etranger au vote, ou choix qui
   * n'existe pas.
   *
   * ⚠️ **Un vote est REVOCABLE, exactement comme un jeton du draft.** On
   * negocie pendant vingt secondes en voyant les autres : un choix qu'on ne
   * pourrait plus changer transformerait la negociation en course au clic.
   *
   * ⚠️ **Le choix est VALIDE ici, et c'est le seul endroit qui le puisse.**
   * Il vient du fil, donc d'un client quelconque : sans ce garde, un octet
   * fantaisiste (`7`) entrerait dans la `Map`, partirait tel quel dans `VOTES`
   * et ne se compterait nulle part — une abstention silencieuse qui ne
   * ressemblerait pas a `NO_VOTE`. Le serveur arbitre (§7.2 de l'etape 4).
   */
  setVote(playerId: number, choice: number): boolean {
    if (this.#phase === 'closed' || !this.#pending.includes(playerId)) {
      return false;
    }
    if (choice !== VOTE_CHOICE.STAY && choice !== VOTE_CHOICE.LEAVE && choice !== NO_VOTE) {
      return false;
    }
    this.#votes.set(playerId, choice);
    return true;
  }

  /** Qui a vote quoi — ce que `VOTES` rediffuse. Vide hors vote. */
  votes(): ReadonlyMap<number, number> {
    return this.#votes;
  }

  /**
   * Fait avancer la machine. Rend le verdict quand le portail se ferme, `null`
   * tant qu'il faut attendre. **Un seul verdict par portail.**
   *
   * ⚠️ **`null` et `VOTE_CHOICE.STAY` sont tous deux faux en JS** : se
   * comparer a `null`, jamais tester la verite du retour. C'est la meme
   * chausse-trappe que `NO_TOKEN` et `NO_VOTE` evitent sur le fil — « rester »
   * vaut zero parce que c'est la valeur par defaut du jeu, pas parce que c'est
   * une absence.
   *
   * Le portail se ferme a l'echeance, **ou** des que tous les participants ont
   * vote — et la seconde condition n'est pas un raccourci de confort : les
   * votes etant revocables, c'est le seul moment ou le decompte est stable
   * avant l'echeance. Une fermeture anticipee des qu'une majorite semble
   * « acquise » serait fausse, puisqu'un votant peut encore changer d'avis.
   */
  step(tick: number): number | null {
    if (this.#phase === 'closed') {
      return null;
    }
    const tousVotes = this.#pending.every((id) => this.#votes.get(id) !== NO_VOTE);
    const echu = tick >= this.#deadlineTick;
    if (!tousVotes && !echu) {
      return null;
    }

    const decision = this.#decide();
    this.#phase = 'closed';
    // ⚠️ **Les votes meurent avec la negociation**, comme les jetons du draft
    // — et pour la meme raison, payee une fois la-bas : `Session#broadcast`
    // diffuse `VOTES` des que cette table n'est pas vide, donc les voix du
    // palier precedent seraient rediffusees a chaque tick jusqu'au portail
    // suivant, et chacun y verrait son vote deja pose avant d'avoir decide.
    this.#votes.clear();
    return decision;
  }

  /**
   * Le verdict : **majorite ; egalite = on continue** (§6).
   *
   * ⚠️ **L'abstention ne se compte pas, ni d'un cote ni de l'autre.** C'est ce
   * que `NO_VOTE = 255` rend possible : a zero, les silencieux voteraient tous
   * « rester » et deux abstentions plus un depart rendraient une majorite pour
   * rester au lieu d'une majorite pour partir. La regle d'egalite porte deja
   * ce que l'abstention doit produire ; une sentinelle n'a pas a le porter une
   * seconde fois.
   *
   * ⚠️ **L'egalite n'est pas un cas particulier, c'est le DEFAUT.** Une seule
   * comparaison stricte suffit : tout ce qui n'est pas une majorite de
   * departs — egalite, silence general, salon vide — continue.
   */
  #decide(): number {
    let rester = 0;
    let partir = 0;
    for (const id of this.#pending) {
      const choice = this.#votes.get(id);
      if (choice === VOTE_CHOICE.LEAVE) {
        partir++;
      } else if (choice === VOTE_CHOICE.STAY) {
        rester++;
      }
    }
    return partir > rester ? VOTE_CHOICE.LEAVE : VOTE_CHOICE.STAY;
  }
}
