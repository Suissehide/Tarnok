import { archetypeOf } from './archetypes';
import { MAP_SIZE, MAX_ENTITIES, MAX_PER_WAVE } from './constants';
import type { FlowField } from './flowfield';
import { formationPositions, type WaveOrder } from './waves';

/**
 * L'identite est **arithmetique**, pas negociee.
 *
 * Aucun aller-retour, aucun octet : deux clients qui recoivent le meme ordre de
 * vague ne *peuvent pas* fabriquer des identifiants differents. C'est ce qui
 * rendra sensé, a l'etape 3, un message « l'entite 4211 est morte » — il n'y a
 * pas de table de correspondance a synchroniser, donc pas de table a
 * desynchroniser.
 */
export function entityIdOf(waveId: number, index: number): number {
  return waveId * MAX_PER_WAVE + index;
}

/**
 * L'etat de la horde, en tableaux typés.
 *
 * Jamais un objet par ennemi (§4.4 de l'orientation) : a 1 500 entites, le cout
 * des indirections et de la pression memoire depasse celui de tout le pas de
 * simulation.
 *
 * Le serveur et chaque client executent ce meme code. Ce qui doit etre
 * identique — l'ensemble des identites, les archetypes — l'est par arithmetique
 * entiere. Les positions, elles, ont le droit de deriver de quelques pixels
 * (§2.2 de la spec).
 *
 * ⚠️ **La capacite doit etre identique sur le serveur et sur chaque client.**
 * `spawn` tronque quand elle est atteinte ; deux simulations qui tronquent a des
 * endroits differents n'ont plus le meme ensemble d'entites, et rien ne le
 * signalerait — ni erreur, ni test rouge, juste des ennemis qui different d'un
 * poste a l'autre. La valeur par defaut du constructeur est la pour que le cas
 * nominal soit correct sans que personne n'ait a y penser.
 */
export class Horde {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly archetype: Uint8Array;
  readonly waveId: Uint16Array;
  readonly indexInWave: Uint16Array;
  /** Decalage du cycle d'animation. Purement cosmetique, hors contrat. */
  readonly animPhase: Uint8Array;
  /** Index du champ suivi : le joueur le plus proche. */
  readonly targetField: Uint8Array;

  #count = 0;

  /**
   * Revisions des champs relevees a la fin du dernier `step`. `null` tant que
   * `step` n'a encore jamais tourne : le tout premier ordre d'une horde neuve
   * n'a rien a comparer. Sert de garde-fou a `spawnCatchingUp` — voir la.
   */
  #lastFieldRevisions: Map<FlowField, number> | null = null;

  constructor(readonly capacity: number = MAX_ENTITIES) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.archetype = new Uint8Array(capacity);
    this.waveId = new Uint16Array(capacity);
    this.indexInWave = new Uint16Array(capacity);
    this.animPhase = new Uint8Array(capacity);
    this.targetField = new Uint8Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  entityIdAt(slot: number): number {
    return entityIdOf(this.waveId[slot] ?? 0, this.indexInWave[slot] ?? 0);
  }

  /** Fait apparaitre une vague. Tronque plutot que de deborder. */
  spawn(order: WaveOrder): void {
    const room = this.capacity - this.#count;
    const count = Math.min(order.count, room, MAX_PER_WAVE);
    if (count <= 0) {
      return;
    }

    const px = new Float32Array(count);
    const py = new Float32Array(count);
    formationPositions({ ...order, count }, px, py);

    const frames = archetypeOf(order.archetype).frames;

    for (let i = 0; i < count; i++) {
      const slot = this.#count + i;
      this.x[slot] = px[i] ?? 0;
      this.y[slot] = py[i] ?? 0;
      this.archetype[slot] = order.archetype;
      this.waveId[slot] = order.waveId;
      this.indexInWave[slot] = i;
      // La phase se derive de l'index, pas d'un tirage : elle doit etre la meme
      // partout pour qu'une capture d'ecran de debug soit comparable.
      this.animPhase[slot] = (i * 7 + order.waveId * 3) % frames;
      // Remis a zero explicitement (constat I3) : aujourd'hui inoffensif, les
      // creneaux n'etant jamais reutilises tant que rien ne meurt. A l'etape
      // 3, un compactage apres une mort reutilisera ce creneau, et sans cette
      // ligne une entite neuve heriterait de la cible du mort qu'elle remplace.
      this.targetField[slot] = 0;
    }

    this.#count += count;
  }

  /**
   * Retire des entites par identite, et rend combien ont ete retirees.
   *
   * La compaction deplace la derniere entite dans le trou — `O(1)` par mort. Ce
   * qui compte pour la replication : **le resultat ne doit pas dependre de
   * l'ordre de la liste**. On retire donc par indice decroissant, ce qui rend
   * l'operation commutative : une entite deplacee ne peut jamais l'etre vers un
   * trou qu'on va rouvrir ensuite.
   *
   * Sans ca, deux clients recevant les memes morts dans un ordre different
   * finiraient avec des tableaux differemment agences, et l'indice `i` cesserait
   * de designer la meme entite — l'invariant que le test de replication verifie
   * par comparaison d'identites.
   */
  kill(entityIds: readonly number[]): number {
    const slots: number[] = [];
    for (const id of entityIds) {
      const slot = this.slotOf(id);
      if (slot >= 0) {
        slots.push(slot);
      }
    }
    slots.sort((a, b) => b - a);

    let removed = 0;
    for (const slot of slots) {
      this.#removeAt(slot);
      removed++;
    }
    return removed;
  }

  /** Index du creneau portant cette identite, ou -1. */
  slotOf(entityId: number): number {
    for (let i = 0; i < this.#count; i++) {
      if (this.entityIdAt(i) === entityId) {
        return i;
      }
    }
    return -1;
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
      this.archetype[slot] = this.archetype[last] ?? 0;
      this.waveId[slot] = this.waveId[last] ?? 0;
      this.indexInWave[slot] = this.indexInWave[last] ?? 0;
      this.animPhase[slot] = this.animPhase[last] ?? 0;
      this.targetField[slot] = this.targetField[last] ?? 0;
    }
    this.#count = last;
  }

  /**
   * Reaffecte chaque entite au joueur le plus proche.
   *
   * Appele a la cadence du flowfield (10 Hz), pas a chaque tick : changer de
   * cible chaque tick fait vibrer les trajectoires.
   */
  retarget(playerX: readonly number[], playerY: readonly number[]): void {
    for (let i = 0; i < this.#count; i++) {
      const ex = this.x[i] ?? 0;
      const ey = this.y[i] ?? 0;
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let p = 0; p < playerX.length; p++) {
        const dx = (playerX[p] ?? 0) - ex;
        const dy = (playerY[p] ?? 0) - ey;
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      this.targetField[i] = best;
    }
  }

  /** Un pas de simulation. `dt` est fixe : 1 / TICK_HZ. */
  step(dt: number, fields: readonly FlowField[]): void {
    this.#advance(0, this.#count, dt, fields);
    this.#recordFieldRevisions(fields);
  }

  /**
   * Fait apparaitre une vague en rattrapant les pas manques.
   *
   * Un client ne peut pas appliquer un ordre au meme tick que le serveur :
   * l'ordre voyage sur le reseau. Sans rattrapage, ses entites restent
   * definitivement un ou deux pas en arriere — et cet ecart ne reste PAS
   * borne : le flowfield etant un champ de directions discret, deux entites
   * decalees d'un pas franchissent les frontieres de cellules a des instants
   * differents et prennent des routes differentes. Mesure : la derive croit
   * lineairement a ~70 px/s, soit 694 px apres dix secondes.
   *
   * Avec rattrapage, elle devient constante a ~20 px — l'erreur residuelle de
   * fraicheur du champ, le client rattrapant avec son champ courant la ou le
   * serveur a utilise celui d'il y a un ou deux ticks.
   *
   * ⚠️ **Ordre d'appel.** `fields` doit etre le champ tel qu'il existait
   * *avant* le rafraichissement periodique du tick courant, pas apres.
   * Rattraper avec un champ deja rafraichi ce tick-la revient a utiliser une
   * entree que le serveur, lui, n'a vue qu'au tick suivant, et rouvre la
   * sensibilite aux frontieres de cellules que le rattrapage cherche a
   * eviter : mesure, l'erreur repasse alors dans les centaines de pixels
   * selon l'alignement entre le tick d'apparition et celui du prochain
   * rafraichissement. Concretement : appeler `spawnCatchingUp` a la reception
   * du `WAVE_ORDER` (`#onFrame`), *avant* l'avancement par tick de la horde
   * (`#advanceHorde`) — pas apres.
   *
   * `missedTicks` vaut `tickCourant - order.spawnTick`, borne a zero.
   *
   * ⚠️ Leve si un champ a ete rafraichi entre le dernier `step` et cet appel
   * — le garde-fou qui transforme l'erreur d'ordre ci-dessus en echec net
   * plutot qu'en derive silencieuse. Voir `#assertFieldsNotRefreshed`.
   */
  spawnCatchingUp(
    order: WaveOrder,
    missedTicks: number,
    dt: number,
    fields: readonly FlowField[],
  ): void {
    if (missedTicks > 0) {
      this.#assertFieldsNotRefreshed(fields);
    }

    const before = this.#count;
    this.spawn(order);
    for (let step = 0; step < missedTicks; step++) {
      this.#advance(before, this.#count, dt, fields);
    }
  }

  /**
   * Avance le creneau `[from, to)` d'un pas. Factorise pour que `step` et
   * `spawnCatchingUp` partagent la meme logique de deplacement — sans ca,
   * les deux copies divergeraient tot ou tard.
   */
  #advance(from: number, to: number, dt: number, fields: readonly FlowField[]): void {
    for (let i = from; i < to; i++) {
      const field = fields[this.targetField[i] ?? 0];
      if (!field) {
        continue;
      }
      const speed = archetypeOf(this.archetype[i] ?? 0).speed * dt;
      const ex = this.x[i] ?? 0;
      const ey = this.y[i] ?? 0;
      const cell = field.indexAt(ex, ey);
      this.x[i] = clamp(ex + (field.dirX[cell] ?? 0) * speed, 0, MAP_SIZE);
      this.y[i] = clamp(ey + (field.dirY[cell] ?? 0) * speed, 0, MAP_SIZE);
    }
  }

  /** Releve la revision courante de chaque champ. Appele a la fin de `step`. */
  #recordFieldRevisions(fields: readonly FlowField[]): void {
    const revisions = this.#lastFieldRevisions ?? new Map<FlowField, number>();
    for (const field of fields) {
      if (field) {
        revisions.set(field, field.revision);
      }
    }
    this.#lastFieldRevisions = revisions;
  }

  /**
   * Refuse un rattrapage qui arriverait trop tard.
   *
   * Dans l'ordre correct d'un tick — rattrapage, puis rafraichissement
   * periodique du flowfield, puis `step` — un champ vu ici porte encore la
   * revision relevee au dernier `step`. Si elle a change, c'est qu'un
   * `update` a eu lieu entre-temps : le rattrapage consommerait un champ plus
   * frais que celui que le serveur a utilise pour les ticks manques, ce qui
   * rouvre la sensibilite aux frontieres de cellules que le rattrapage
   * cherche justement a eviter (mesure : la derive repasse de ~20 a ~780 px,
   * voir le test de replication). Ne s'applique que si la horde a deja ete
   * avancee au moins une fois — le tout premier ordre n'a rien a comparer.
   */
  #assertFieldsNotRefreshed(fields: readonly FlowField[]): void {
    if (!this.#lastFieldRevisions) {
      return;
    }
    for (const field of fields) {
      const seen = this.#lastFieldRevisions.get(field);
      if (seen !== undefined && seen !== field.revision) {
        throw new Error(
          'spawnCatchingUp appele apres le rafraichissement du champ : les pas rattrapes ' +
            'utiliseraient un champ plus frais que celui du serveur, et la derive passe de ' +
            '~20 a ~780 px. Appliquer les ordres en attente EN TETE de tick, avant tout ' +
            'appel a FlowField.update.',
        );
      }
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
