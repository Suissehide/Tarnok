import type { Card } from '@shared/cards';
import { DRAFT_REPICK_TICKS, DRAFT_WINDOW_TICKS } from '@shared/constants';

/** Ce qui est arrive a un joueur, tel que `DRAFT_RESULT` le transporte. */
export const OUTCOME = {
  /** La carte lui revient — elle s'illumine chez lui. */
  WON: 0,
  /** Il visait une carte qu'un autre a eue — elle se consume chez lui. */
  LOST: 1,
  /** Il n'avait pose aucun jeton : le serveur a tranche pour lui. */
  AUTO: 2,
} as const;

export type DraftPhase = 'closed' | 'open' | 'repick';

export interface DraftOutcome {
  playerId: number;
  cardIndex: number;
  outcome: number;
}

/**
 * La machine a etats du draft (§4 de la spec de l'etape 4).
 *
 * Ne connait ni `ws`, ni `fastify`, ni `Room` : elle recoit des identifiants et
 * des cartes, elle rend des issues. Meme discipline que `combat.ts`.
 *
 * ⚠️ **Le serveur seul l'execute.** Le draft ne participe pas au contrat de
 * replication : rien n'est derive, rien n'est rejoue, aucun client ne refait le
 * tirage. C'est pour ca que `rng` peut etre une vraie source aleatoire et non
 * une graine partagee — contrairement a tout ce qui vit dans `shared/`.
 */
export class Draft {
  #phase: DraftPhase = 'closed';
  #deadlineTick = 0;
  #spread: Card[] = [];
  /** Qui participe encore : au premier tour tout le monde, a la repioche les perdants. */
  #pending: number[] = [];
  /** Cartes deja attribuees, par indice — une carte prise ne se repropose pas. */
  #taken = new Set<number>();
  /** `playerId -> cardIndex`, les jetons poses. */
  #tokens = new Map<number, number>();

  get phase(): DraftPhase {
    return this.#phase;
  }

  /** L'etalage en cours — `Room` en a besoin pour appliquer les cartes obtenues. */
  get spread(): readonly Card[] {
    return this.#spread;
  }

  get deadlineTick(): number {
    return this.#deadlineTick;
  }

  /**
   * Ouvre l'etalage.
   *
   * ⚠️ **Pas de mode solo.** La fenetre se ferme des que TOUS les participants
   * ont pose leur jeton — en solo, « tous » veut dire « lui », donc le clic
   * referme le gel sans qu'aucun drapeau ne soit necessaire. Un parametre
   * `soloMode` a existe ici : la mutation qui le neutralisait ne faisait
   * echouer aucun test, parce qu'il ne pouvait rien changer. Du code que rien
   * ne peut faire echouer est du code que rien ne protege.
   *
   * Le §4.3 de la spec exempte le solo du plafond de 20 s ; cette exemption
   * tombe du mecanisme general au lieu d'etre un cas particulier.
   */
  open(tick: number, spread: Card[], playerIds: readonly number[]): void {
    this.#phase = 'open';
    this.#spread = spread;
    this.#pending = [...playerIds];
    this.#taken.clear();
    this.#tokens.clear();
    this.#deadlineTick = tick + DRAFT_WINDOW_TICKS;
  }

  /**
   * Pose ou deplace le jeton d'un joueur. Rend `false` si le geste est refuse :
   * carte hors etalage, deja attribuee, reservee a un autre, ou joueur qui n'a
   * plus a choisir.
   */
  setToken(playerId: number, cardIndex: number): boolean {
    if (this.#phase === 'closed' || !this.#pending.includes(playerId)) {
      return false;
    }
    const card = this.#spread[cardIndex];
    if (!card || this.#taken.has(cardIndex)) {
      return false;
    }
    // `owner` porte a lui seul l'exclusivite : montees de niveau et evolutions
    // n'ont pas de regle separee (§3.2 de la spec).
    if (card.owner !== 0 && card.owner !== playerId) {
      return false;
    }
    this.#tokens.set(playerId, cardIndex);
    return true;
  }

  intents(): ReadonlyMap<number, number> {
    return this.#tokens;
  }

  /**
   * Fait avancer la machine. Rend les issues quand une phase se ferme, `null`
   * tant qu'il faut attendre.
   *
   * Une phase se ferme a l'echeance, ou des que tous les participants ont pose
   * leur jeton — ce qui, **en solo, arrive au premier clic** : le §4.3 de la
   * spec exempte le solo du plafond de 20 s, parce qu'on monte de niveau
   * toutes les ~14 s et qu'une run solo passerait sinon l'essentiel du temps
   * figee.
   */
  step(tick: number, rng: () => number): DraftOutcome[] | null {
    if (this.#phase === 'closed') {
      return null;
    }
    const tousPoses = this.#pending.every((id) => this.#tokens.has(id));
    const echu = tick >= this.#deadlineTick;
    if (!tousPoses && !echu) {
      return null;
    }

    const issues = this.#resolve(rng);
    const perdants = issues.filter((r) => r.outcome === OUTCOME.LOST).map((r) => r.playerId);

    // ⚠️ **La repioche ne peut pas boucler** : elle n'a lieu qu'une fois. Un
    // reconflit au second tour se tranche et se termine — sans cette borne,
    // des joueurs obstines figeraient la partie (§4.4 de la spec).
    if (perdants.length > 0 && this.#phase === 'open') {
      this.#phase = 'repick';
      this.#pending = perdants;
      this.#tokens.clear();
      this.#deadlineTick = tick + DRAFT_REPICK_TICKS;
    } else {
      this.#phase = 'closed';
    }
    return issues;
  }

  /**
   * Tranche un tour : les conflits d'abord, puis l'attribution d'office pour
   * ceux qui n'ont rien pose.
   *
   * ⚠️ **L'ordre compte, et c'est ce qui garantit la propriete du §4.4** : un
   * joueur absent ne prive jamais un joueur present de la carte qu'il vise.
   * Servir les absents d'abord la casserait sans qu'aucun test de la regle
   * elle-meme ne s'en apercoive.
   */
  #resolve(rng: () => number): DraftOutcome[] {
    const issues: DraftOutcome[] = [];

    // 1. Les jetons poses, groupes par carte.
    const parCarte = new Map<number, number[]>();
    for (const id of this.#pending) {
      const index = this.#tokens.get(id);
      if (index === undefined) {
        continue;
      }
      const liste = parCarte.get(index);
      if (liste) {
        liste.push(id);
      } else {
        parCarte.set(index, [id]);
      }
    }

    // ⚠️ Parcours par indice de carte croissant, jamais par ordre d'insertion
    // dans la `Map` : l'ordre d'insertion depend de l'ordre d'arrivee des
    // messages, donc de la latence.
    for (const index of [...parCarte.keys()].sort((a, b) => a - b)) {
      const pretendants = parCarte.get(index) ?? [];
      const gagnant =
        pretendants[Math.min(pretendants.length - 1, Math.floor(rng() * pretendants.length))];
      for (const id of pretendants) {
        if (id === gagnant) {
          issues.push({ playerId: id, cardIndex: index, outcome: OUTCOME.WON });
          this.#taken.add(index);
        } else {
          issues.push({ playerId: id, cardIndex: index, outcome: OUTCOME.LOST });
        }
      }
    }

    // 2. Les absents, servis ensuite — donc jamais au detriment d'un present.
    for (const id of this.#pending) {
      if (this.#tokens.has(id)) {
        continue;
      }
      const index = this.#autoPick(id);
      if (index >= 0) {
        this.#taken.add(index);
        issues.push({ playerId: id, cardIndex: index, outcome: OUTCOME.AUTO });
      }
    }

    return issues;
  }

  /**
   * L'attribution d'office du §4.4 :
   *
   * 1. la carte dont il est le **seul eligible**, s'il y en a une — c'est une
   *    montee de niveau ou une evolution, personne d'autre n'en veut ;
   * 2. sinon la premiere carte libre, dans l'ordre du tirage.
   */
  #autoPick(playerId: number): number {
    for (let i = 0; i < this.#spread.length; i++) {
      const card = this.#spread[i];
      if (card && !this.#taken.has(i) && card.owner === playerId) {
        return i;
      }
    }
    for (let i = 0; i < this.#spread.length; i++) {
      const card = this.#spread[i];
      if (card && !this.#taken.has(i) && card.owner === 0) {
        return i;
      }
    }
    return -1;
  }
}
