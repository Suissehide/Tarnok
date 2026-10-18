import type { Card } from '@shared/cards';
import { DRAFT_WINDOW_TICKS } from '@shared/constants';
import type { Loadout } from '@shared/loadout';
import { OUTCOME } from '@shared/protocol';

/**
 * Pas de phase de repioche : la resolution est un seul moment. Le perdant voit
 * sa carte bruler et une autre s'illuminer dans la foulee, sans rechoisir.
 */
export type DraftPhase = 'closed' | 'open';

export interface DraftOutcome {
  playerId: number;
  cardIndex: number;
  outcome: number;
}

/**
 * La machine a etats du draft. Ne connait ni `ws`, ni `fastify`, ni `Room` :
 * elle recoit des identifiants et des cartes, elle rend des issues.
 *
 * ⚠️ **Le serveur seul l'execute** : aucun client ne refait le tirage. `rng`
 * peut donc etre une vraie source aleatoire et non une graine partagee,
 * contrairement a tout ce qui vit dans `shared/`.
 */
export class Draft {
  #phase: DraftPhase = 'closed';
  #deadlineTick = 0;
  #spread: Card[] = [];
  /** Qui participe : tous les joueurs du salon a l'ouverture. */
  #pending: number[] = [];
  /**
   * Ce que chacun possede, pour decider ce qu'il peut prendre. L'eligibilite ne
   * voyage pas sur la carte : la meme carte peut etre prenable par l'un et pas
   * par l'autre (`Loadout.canTake`).
   */
  #loadouts: ReadonlyMap<number, Loadout> = new Map();
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
   * ⚠️ **Pas de mode solo, et il n'en faut pas** : la fenetre se ferme des que
   * TOUS les participants ont pose leur jeton, donc en solo au premier clic.
   * L'exemption du solo au plafond de la fenetre tombe du mecanisme general.
   */
  open(
    tick: number,
    spread: Card[],
    playerIds: readonly number[],
    loadouts: ReadonlyMap<number, Loadout> = new Map(),
  ): void {
    this.#phase = 'open';
    this.#spread = spread;
    this.#pending = [...playerIds];
    this.#loadouts = loadouts;
    this.#taken.clear();
    this.#tokens.clear();
    this.#deadlineTick = tick + DRAFT_WINDOW_TICKS;
  }

  /**
   * Pose ou deplace le jeton d'un joueur. Rend `false` si le geste est refuse :
   * carte hors etalage, ou carte que cet inventaire ne peut pas accueillir.
   *
   * ⚠️ **Une carte deja visee par un autre joueur reste posable** : c'est le
   * cœur de la mecanique. Sans ca il n'y a pas de negociation, seulement une
   * course au clic.
   */
  setToken(playerId: number, cardIndex: number): boolean {
    if (this.#phase === 'closed' || !this.#pending.includes(playerId)) {
      return false;
    }
    const card = this.#spread[cardIndex];
    if (!card) {
      return false;
    }
    if (!this.#eligible(playerId, card)) {
      return false;
    }
    this.#tokens.set(playerId, cardIndex);
    return true;
  }

  /** Ce joueur peut-il accueillir cette carte ? Voir `Loadout.canTake`. */
  #eligible(playerId: number, card: Card): boolean {
    const loadout = this.#loadouts.get(playerId);
    return loadout ? loadout.canTake(card.nature, card.refId) : true;
  }

  intents(): ReadonlyMap<number, number> {
    return this.#tokens;
  }

  /**
   * Fait avancer la machine. Rend les issues quand le draft se ferme, `null`
   * tant qu'il faut attendre. **Un seul lot d'issues par draft.**
   *
   * Le draft se ferme a l'echeance, ou des que tous les participants ont pose
   * leur jeton — **en solo, au premier clic** : on monte de niveau souvent, et
   * une run solo passerait sinon l'essentiel du temps figee.
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
    this.#phase = 'closed';
    // ⚠️ **Les jetons meurent avec la negociation.** `Session#broadcast` diffuse
    // `DRAFT_INTENTS` des que `intents()` n'est pas vide : sans ce `clear`, le
    // jeton du tour precedent apparaitrait deja pose sur le nouvel etalage, et
    // cliquer dessus le RETIRERAIT (le reclic est un retrait).
    this.#tokens.clear();

    // ⚠️ **Le perdant n'a rien a rechoisir : on lui donne, tout de suite.** Il
    // recoit DEUX issues : le `LOST` de la carte disputee, puis l'`AUTO` de
    // celle qu'il obtient a la place — l'ecran montre les deux.
    for (const r of issues.filter((x) => x.outcome === OUTCOME.LOST)) {
      const index = this.#autoPick(r.playerId);
      if (index >= 0) {
        this.#taken.add(index);
        issues.push({ playerId: r.playerId, cardIndex: index, outcome: OUTCOME.AUTO });
      }
    }
    return issues;
  }

  /**
   * Tranche un tour : les conflits d'abord, puis l'attribution d'office pour
   * ceux qui n'ont rien pose.
   *
   * ⚠️ **L'ordre compte** : un joueur absent ne prive jamais un joueur present
   * de la carte qu'il vise. Servir les absents d'abord casserait cette regle.
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
   * L'attribution d'office : la premiere carte libre que cet inventaire peut
   * accueillir, dans l'ordre du tirage. L'eligibilite est consultee : un joueur aux slots d'armes pleins ne se
   * voit jamais attribuer d'office une arme qu'il ne possede pas.
   */
  #autoPick(playerId: number): number {
    for (let i = 0; i < this.#spread.length; i++) {
      const card = this.#spread[i];
      if (card && !this.#taken.has(i) && this.#eligible(playerId, card)) {
        return i;
      }
    }
    return -1;
  }
}
