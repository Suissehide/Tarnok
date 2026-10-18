import { PORTAL_WINDOW_TICKS } from '@shared/constants';
import { NO_VOTE, VOTE_CHOICE } from '@shared/protocol';

/** Deux etats seulement : il n'y a rien a rechoisir apres un verdict. */
export type PortalPhase = 'closed' | 'open';

/**
 * La machine a etats du vote d'extraction, calquee sur `draft.ts` : ouverture
 * datee, intentions rediffusees, resolution annoncee, absents tranches
 * d'office. Elle **ne connait ni `ws`, ni `fastify`, ni `Room`**.
 *
 * Ce qui change par rapport au draft :
 *
 * | | draft | portail |
 * | --- | --- | --- |
 * | ce qu'on choisit | une carte parmi N | deux faces |
 * | ce qui tranche | un tirage | une **majorite** |
 * | le monde | **gele** | **continue de tourner** |
 *
 * ⚠️ **Le gel n'est pas absent par oubli.** C'est `Room#step` qui gele ou non,
 * mais la raison se lit ici : un choix de carte n'a pas d'enjeu temporel, alors
 * que pour le vote **le temps EST l'enjeu** — la vague suivante approche
 * pendant qu'on negocie.
 *
 * Aucune source aleatoire : l'egalite a une regle (on continue), pas un tirage.
 */
export class Portal {
  #phase: PortalPhase = 'closed';
  #deadlineTick = 0;
  /**
   * Qui vote : tous les joueurs du salon a l'ouverture, **morts ou vifs**.
   *
   * ⚠️ **Cette classe ne sait rien des points de vie** : la mort d'un joueur ne
   * lui coute pas sa voix.
   */
  #pending: number[] = [];
  /**
   * `playerId -> VOTE_CHOICE.STAY | VOTE_CHOICE.LEAVE | NO_VOTE`, pour
   * **chaque** participant des l'ouverture.
   *
   * ⚠️ **L'abstention est une entree, pas une absence d'entree**, a la
   * difference des jetons du draft : les autres doivent voir **qui n'a pas
   * encore tranche**. `NO_VOTE` circule donc dans `VOTES`, sans se compter.
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
   * Le portail s'ouvre a la mort du boss, jamais a un tick fixe : c'est `Room`
   * qui l'appelle. Cette classe date sa fenetre du tick qu'on lui donne.
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
   * ⚠️ **Un vote est REVOCABLE**, comme un jeton du draft : un choix fige
   * transformerait la negociation en course au clic.
   *
   * ⚠️ **Le choix est VALIDE ici, seul endroit qui le puisse.** Il vient du
   * fil : sans ce garde, un octet fantaisiste (`7`) partirait tel quel dans
   * `VOTES` et ne se compterait nulle part, abstention qui ne ressemble pas a
   * `NO_VOTE`.
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
   * comparer a `null`, jamais tester la verite du retour.
   *
   * Le portail se ferme a l'echeance, **ou** des que tous ont vote. Pas plus
   * tot, meme si une majorite semble acquise : les votes sont revocables.
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
    // ⚠️ **Les votes meurent avec la negociation**, comme les jetons du draft :
    // `Session#broadcast` diffuse `VOTES` des que cette table n'est pas vide,
    // et chacun verrait au portail suivant son vote deja pose.
    this.#votes.clear();
    return decision;
  }

  /**
   * Le verdict : **majorite ; egalite = on continue**.
   *
   * ⚠️ **L'abstention ne se compte pas, ni d'un cote ni de l'autre** : c'est
   * pourquoi `NO_VOTE` vaut 255 et non 0, sans quoi les silencieux voteraient
   * « rester ».
   *
   * Tout ce qui n'est pas une majorite stricte de departs — egalite, silence
   * general, salon vide — continue.
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
