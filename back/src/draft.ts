import { CARD, type Card } from '@shared/cards';
import { DRAFT_WINDOW_TICKS } from '@shared/constants';
import type { Loadout } from '@shared/loadout';
import { OUTCOME } from '@shared/protocol';
import { weaponOf } from '@shared/weapons';

/**
 * ⚠️ **Il y avait un troisieme etat, `'repick'`.** La repioche a disparu : la
 * resolution est un seul moment. Le perdant voit sa carte bruler et une autre
 * s'illuminer dans la foulee, sans rechoisir.
 */
export type DraftPhase = 'closed' | 'open';

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
  /** Qui participe : tous les joueurs du salon a l'ouverture. */
  #pending: number[] = [];
  /**
   * Ce que chacun possede, pour derider ce qu'il peut prendre.
   *
   * ⚠️ **C'est ce qui remplace `owner`.** L'eligibilite ne voyage plus sur la
   * carte : la meme carte peut etre prenable par l'un et pas par l'autre, et
   * c'est l'inventaire qui le dit (`Loadout.canTake`).
   */
  #loadouts: ReadonlyMap<number, Loadout> = new Map();
  /**
   * Ce que chacun a debloque, pour fermer le pool a CE joueur.
   *
   * ⚠️ **N'influence QUE le draft, pas le `Loadout`.** `Room#grantCard` ne
   * consulte jamais cette table : une arme deja equipee directement (hors
   * draft, comme le fait le livrable de l'etape 5c) reste jouable que le
   * verrou soit leve ou non. Le verrou ferme la PORTE, pas l'inventaire.
   */
  #unlockedByPlayer: ReadonlyMap<number, ReadonlySet<number>> = new Map();
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
  open(
    tick: number,
    spread: Card[],
    playerIds: readonly number[],
    loadouts: ReadonlyMap<number, Loadout> = new Map(),
    unlockedByPlayer: ReadonlyMap<number, ReadonlySet<number>> = new Map(),
  ): void {
    this.#phase = 'open';
    this.#spread = spread;
    this.#pending = [...playerIds];
    this.#loadouts = loadouts;
    this.#unlockedByPlayer = unlockedByPlayer;
    this.#taken.clear();
    this.#tokens.clear();
    this.#deadlineTick = tick + DRAFT_WINDOW_TICKS;
  }

  /**
   * Pose ou deplace le jeton d'un joueur. Rend `false` si le geste est refuse :
   * carte hors etalage, ou carte que cet inventaire ne peut pas accueillir.
   *
   * ⚠️ **Une carte deja visee par un autre joueur reste posable.** C'est le
   * cœur de la mecanique : *« quand un joueur a selectionne une carte, je peux
   * poser mon jeton dessus »*. Sans ca il n'y a pas de negociation, seulement
   * une course au clic.
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

  /**
   * Ce joueur peut-il accueillir cette carte ? Voir `Loadout.canTake` ET le
   * verrou de deblocage, consultes dans cet ordre.
   *
   * ⚠️ **Le deblocage se verifie AVANT le `Loadout`, et c'est un refus d'une
   * autre nature.** Le `Loadout` dit « tu n'as plus de place », le deblocage
   * dit « cette arme n'est pas a toi ». Les confondre ferait croire a un slot
   * plein la ou il manque un achat — c'est pour ca que le test de la tache 3
   * assene les deux cotes separement : `canTake` vrai ET `setToken` refuse.
   */
  #eligible(playerId: number, card: Card): boolean {
    if (card.nature === CARD.WEAPON) {
      const arme = weaponOf(card.refId);
      const debloquees = this.#unlockedByPlayer.get(playerId);
      if (arme.locked && !debloquees?.has(card.refId)) {
        return false;
      }
    }
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
    this.#phase = 'closed';
    // ⚠️ **Les jetons meurent avec la negociation.** Sans cette ligne, ils
    // survivaient a la fermeture : `Session#broadcast` diffuse `DRAFT_INTENTS`
    // des que `intents()` n'est pas vide, donc le serveur rediffusait le jeton
    // du tour precedent **a chaque tick** jusqu'a l'ouverture suivante. Le
    // joueur voyait son propre jeton deja pose sur une carte du nouvel
    // etalage, et cliquer dessus le RETIRAIT au lieu de le poser (le §4.1 fait
    // du reclic un retrait). Signale par l'auteur en jouant.
    this.#tokens.clear();

    // ⚠️ **Le perdant n'a rien a rechoisir : on lui donne, tout de suite.**
    // *« Si a la fin du timer on s'est pas departage, ca brule la carte si je
    // l'ai pas eu et ca en illumine une autre. »* Il y avait ici une fenetre de
    // repioche de 5 s ; elle a disparu, et la resolution est desormais un seul
    // moment.
    //
    // Le joueur recoit DEUX issues : le `LOST` de la carte disputee, puis
    // l'`AUTO` de celle qu'il obtient a la place. C'est ce que l'ecran doit
    // raconter — on voit ce qu'on perd, on voit ce qu'on obtient a la place.
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
   * L'attribution d'office : la premiere carte libre que cet inventaire peut
   * accueillir, dans l'ordre du tirage.
   *
   * ⚠️ Il y avait une premiere regle avant celle-ci — « la carte dont il est le
   * seul eligible » — qui servait les montees de niveau et les evolutions.
   * Elles n'existent plus, et avec elles la notion de carte reservee.
   *
   * L'eligibilite reste consultee : un joueur aux slots d'armes pleins ne se
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
