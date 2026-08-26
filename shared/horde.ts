import { archetypeOf } from './archetypes';
import {
  CONTACT_RADIUS,
  DEOVERLAP_MAX_PX,
  MAP_SIZE,
  MAX_ENTITIES,
  MAX_PER_WAVE,
  SEPARATION_CELL,
  SEPARATION_RADIUS,
  STEERING_RECOMPUTE_TICKS,
  STEERING_REPULSION_WEIGHT,
} from './constants';
import type { FlowField } from './flowfield';
import { formationPositions, type WaveOrder } from './waves';

/**
 * Marge sous laquelle la norme du melange (direction du champ + repulsion
 * ponderee) est traitee comme nulle, dans `#recomputeSteering` (tache 21).
 *
 * Bien au-dessus de l'epsilon flottant : ce n'est pas une tolerance
 * d'arrondi, c'est le seuil qui distingue « le vecteur s'annule vraiment »
 * (retomber sur la direction du champ) de « il est juste tres court »
 * (le normaliser normalement). Les deux contributions melangees sont chacune
 * de norme au plus quelques unites (direction de champ unitaire, repulsion
 * plafonnee a 1 puis ponderee par `STEERING_REPULSION_WEIGHT`), donc `1e-6`
 * ne peut etre franchi que par une annulation reelle, jamais par du bruit
 * d'arrondi ordinaire.
 */
const STEERING_DEGENERATE_EPSILON = 1e-6;

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
 * Instantane de l'etat de la horde, pour `HordeHistory` (§3.2).
 *
 * Les NEUF memes tableaux que `Horde` (`stopped` depuis la tache 17.2, `vx`/`vy`
 * depuis la tache 19), plus le compte. `HordeHistory` en alloue un par creneau
 * de son anneau, une seule fois, et `saveState` / `restoreState` s'en servent
 * comme tampons a copier par `.set()` — jamais de nouveau tableau a chaque tick.
 *
 * ⚠️ **`vx`/`vy` DOIVENT faire partie de cet instantane.** Une entite qui vient
 * de recalculer sa trajectoire (tache 19) tient sa vitesse jusqu'a `K` ticks
 * plus tard : un rejeu qui restaurerait tout SAUF la vitesse ferait repartir
 * une entite dans une direction perimee, ou nulle, a la place de celle qu'elle
 * tenait reellement au tick restaure. Le scenario 9 de
 * `shared/horde.replication.test.ts` — rejeu, derive attendue a 0,000 px — est
 * l'endroit exact ou l'oubli se verrait.
 */
export interface HordeState {
  count: number;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  archetype: Uint8Array;
  waveId: Uint16Array;
  indexInWave: Uint16Array;
  animPhase: Uint8Array;
  targetField: Uint8Array;
  stopped: Uint8Array;
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
  /**
   * Vitesse tenue, en pixels monde par seconde — tache 19.
   *
   * Recalculee un tick sur `STEERING_RECOMPUTE_TICKS`, la phase venant de
   * `entityIdAt` (voir `#recomputeSteering`) ; tous les autres ticks,
   * `#advanceByVelocity` s'en sert telle quelle. C'est cette conservation —
   * pas de recalcul, pas de renversement possible d'un tick a l'autre — qui
   * remplace la force de separation appliquee en continu (`shared/separation.ts`,
   * supprime) : voir le rapport de la tache 19 pour les quatre principes
   * mesures avant celui-ci.
   *
   * ⚠️ **Depuis la tache 21, sa NORME ne depasse jamais `archetypeOf(...).speed`.**
   * `#recomputeSteering` melange la direction du champ et celle de la
   * repulsion PUIS remet a l'echelle de la vitesse propre — il ne les ADDITIONNE
   * plus. Un monstre ne peut donc plus etre propulse plus vite qu'il ne
   * marche, quelle que soit la densite autour de lui.
   */
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly archetype: Uint8Array;
  readonly waveId: Uint16Array;
  readonly indexInWave: Uint16Array;
  /** Decalage du cycle d'animation. Purement cosmetique, hors contrat. */
  readonly animPhase: Uint8Array;
  /** Index du champ suivi : le joueur le plus proche. */
  readonly targetField: Uint8Array;
  /**
   * `1` si l'entite est a portee de contact (`CONTACT_RADIUS`) du joueur
   * qu'elle vise, `0` sinon — tache 17.2. DERIVE dans `retarget`, a partir des
   * positions de joueurs deja retardees que l'appelant lui passe : voir sa
   * doc pour pourquoi c'est ce qui rend l'arret identique des deux cotes.
   *
   * ⚠️ **Simulation, pas rendu** : c'est ce booleen, et lui seul, qui doit
   * decider si une entite avance encore dans `#advance`. Le rendu (choix du
   * clip course/attaque, `front/src/render/horde-renderer.ts`) le LIT mais ne
   * le calcule jamais — sans quoi deux clients dessineraient une attaque a
   * des instants differents pour une raison qui n'aurait plus rien de
   * cosmetique.
   */
  readonly stopped: Uint8Array;

  #count = 0;

  /**
   * Revisions des champs relevees a la fin du dernier `step`. `null` tant que
   * `step` n'a encore jamais tourne : le tout premier ordre d'une horde neuve
   * n'a rien a comparer. Sert de garde-fou a `spawnCatchingUp` — voir la.
   */
  #lastFieldRevisions: Map<FlowField, number> | null = null;

  /**
   * Grille de recherche de voisins pour `#recomputeSteering` (tache 19) —
   * memes cinq tableaux et meme tri par comptage que l'ancien
   * `SeparationGrid`, desormais internes a `Horde` puisque la repulsion
   * alimente directement `vx`/`vy` plutot que de deplacer une position a
   * part. Pre-alloues une fois, jamais reconstruits : c'est ce qui garde
   * `#buildNeighbourGrid` hors du ramasse-miettes.
   */
  readonly #gridCols: number;
  readonly #cellStart: Int32Array;
  readonly #cellCount: Int32Array;
  readonly #cursor: Int32Array;
  readonly #cellIdx: Int32Array;
  readonly #order: Int32Array;

  /**
   * Tampon d'accumulation de la correction de position (tache 22,
   * `#applyDeoverlap`) — pre-alloue une fois, jamais un objet par entite ni
   * un tableau reconstruit a chaque tick. Une entite ACCUMULE ici la somme de
   * ses chevauchements avec chaque voisin AVANT que quoi que ce soit ne soit
   * ecrit dans `x`/`y` : appliquer une correction des qu'elle est calculee,
   * pendant la meme boucle, ferait deja bouger le voisin j avant que i ait fini
   * de considerer TOUS ses voisins, et le resultat dependrait de l'ordre du
   * tableau — deux clients qui compactent differemment apres des morts
   * (`#removeAt`) obtiendraient alors des positions differentes pour un
   * chevauchement pourtant identique. Voir `#applyDeoverlap`.
   *
   * ⚠️ **Depuis la tache 23, l'accumulation est PAR PRIORITE, plus symetrique.**
   * Une entite n'accumule ici une correction que contre les voisins dont elle
   * est DERRIERE (voir `#isBehind`) — celle de devant n'accumule rien pour
   * cette paire. Le meme tampon, la meme discipline « accumuler puis
   * appliquer en bloc », mais chaque paire n'est plus visitee que par CELUI
   * qui cede.
   */
  readonly #correctionX: Float32Array;
  readonly #correctionY: Float32Array;

  /**
   * Cache de priorite (tache 23) : la distance-cellule au champ vise de
   * chaque entite, pour les `#count` entites, recalculee UNE FOIS par tick
   * par `#buildPriorityCache` — jamais par paire.
   *
   * ⚠️ **Sans ce cache, `#isBehind` coute cher au mauvais endroit.** Une
   * premiere version appelait `#fieldDistAt` directement dans les boucles de
   * voisins de `#recomputeSteering` ET `#applyDeoverlap` : chaque VISITE d'un
   * voisin (pas chaque entite) refaisait le meme calcul de cellule pour ce
   * voisin, potentiellement des dizaines de fois par tick au lieu d'une
   * seule. Mesure au banc (`bench:sep`) : le pas simple passait de 4,13 a
   * 6,08 ms a 4000 entites (plus cher qu'avant la tache 23) MALGRE une
   * densite de voisins divisee par plus de deux — la priorite gagnait sur un
   * axe et perdait sur l'autre. Precalculer une fois par entite, puis lire
   * un flottant dans ce tableau a chaque visite, elimine cette redondance.
   * Pre-alloue une fois, jamais reconstruit : meme discipline que le reste
   * de cette classe.
   */
  readonly #priorityDist: Float32Array;

  constructor(readonly capacity: number = MAX_ENTITIES) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.archetype = new Uint8Array(capacity);
    this.waveId = new Uint16Array(capacity);
    this.indexInWave = new Uint16Array(capacity);
    this.animPhase = new Uint8Array(capacity);
    this.targetField = new Uint8Array(capacity);
    this.stopped = new Uint8Array(capacity);

    this.#gridCols = Math.ceil(MAP_SIZE / SEPARATION_CELL);
    const cells = this.#gridCols * this.#gridCols;
    this.#cellStart = new Int32Array(cells + 1);
    this.#cellCount = new Int32Array(cells);
    this.#cursor = new Int32Array(cells + 1);
    this.#cellIdx = new Int32Array(capacity);
    this.#order = new Int32Array(capacity);

    this.#correctionX = new Float32Array(capacity);
    this.#correctionY = new Float32Array(capacity);

    this.#priorityDist = new Float32Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  entityIdAt(slot: number): number {
    return entityIdOf(this.waveId[slot] ?? 0, this.indexInWave[slot] ?? 0);
  }

  /**
   * Fait apparaitre une vague. Tronque plutot que de deborder.
   *
   * `field`, si fourni, empeche `formationPositions` de faire naitre une
   * entite en plein mur (tache 18) — voir sa doc. N'importe lequel des quatre
   * champs de flux convient : ils partagent tous le meme masque, pose une
   * seule fois par `applyObstacles` a la construction de la salle/du client.
   *
   * ⚠️ **`field` sert AUSSI a poser la vitesse initiale (tache 20).** Avant
   * cette tache, une entite naissait avec `vx = vy = 0` et restait
   * visuellement figee jusqu'a `STEERING_RECOMPUTE_TICKS - 1` pas (300 ms) —
   * le temps que sa phase de recalcul arrive. Ca se voyait a l'ecran et
   * n'avait aucune raison d'etre : desormais, si un champ est fourni, chaque
   * entite recoit d'emblee la direction du champ (mise a l'echelle de sa
   * vitesse d'archetype) a l'endroit meme ou elle apparait — la MEME formule
   * que la contribution « champ » de `#recomputeSteering`, sans la
   * repulsion : celle-ci depend des positions des AUTRES entites, qui
   * peuvent avoir deja derive differemment entre le serveur et un client en
   * retard (§ voir `spawnCatchingUp`), alors que la position de naissance,
   * elle, est une fonction pure de `order.seed` — identique partout, quel
   * que soit le moment ou `spawn` est appele. Sans `field` (beaucoup de
   * tests unitaires, qui ne testent pas le mouvement), le comportement
   * reste : `vx = vy = 0`.
   */
  spawn(order: WaveOrder, field?: FlowField): void {
    const room = this.capacity - this.#count;
    const count = Math.min(order.count, room, MAX_PER_WAVE);
    if (count <= 0) {
      return;
    }

    const px = new Float32Array(count);
    const py = new Float32Array(count);
    formationPositions({ ...order, count }, px, py, field);

    const archetype = archetypeOf(order.archetype);
    const frames = archetype.frames;
    const speed = archetype.speed;

    for (let i = 0; i < count; i++) {
      const slot = this.#count + i;
      const ex = px[i] ?? 0;
      const ey = py[i] ?? 0;
      this.x[slot] = ex;
      this.y[slot] = ey;
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
      // Meme raisonnement (tache 17.2) : une entite neuve qui heriterait de
      // `stopped = 1` d'un mort qui occupait ce creneau traverserait le
      // joueur sans jamais l'attaquer, jusqu'au prochain `retarget`.
      this.stopped[slot] = 0;
      // Tache 20 : direction du champ (`targetField` vaut 0 ci-dessus, donc
      // c'est bien `field` — le champ 0 — qui doit servir ici), sans
      // repulsion (voir la doc de la methode). Zero si aucun champ n'est
      // fourni : meme comportement qu'avant cette tache.
      if (field) {
        const cell = field.indexAt(ex, ey);
        this.vx[slot] = (field.dirX[cell] ?? 0) * speed;
        this.vy[slot] = (field.dirY[cell] ?? 0) * speed;
      } else {
        this.vx[slot] = 0;
        this.vy[slot] = 0;
      }
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
    let previous = -1;
    for (const slot of slots) {
      // Une identite listee deux fois designe le meme creneau. Le retirer deux
      // fois supprimerait l'entite VIVANTE que la premiere passe vient d'y
      // deplacer — un monstre disparait sans que rien ne le signale, et les
      // clients divergent en silence. Le tri decroissant met les doublons cote
      // a cote, donc un seul test suffit.
      if (slot === previous) {
        continue;
      }
      previous = slot;
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

  /**
   * Copie l'etat courant dans `out`, un instantane pre-alloue par l'appelant.
   *
   * Sert `HordeHistory.record`, appele a chaque tick : recevoir le tampon en
   * parametre plutot que d'en allouer un ici est ce qui garde cette methode
   * hors du ramasse-miettes.
   *
   * ⚠️ Les NEUF tableaux, plus le compte (`stopped` depuis la tache 17.2,
   * `vx`/`vy` depuis la tache 19). Meme piege que `#removeAt` : en oublier un
   * laisse la suite verte jusqu'a ce qu'un rejeu s'appuie dessus — voir
   * l'avertissement sur `HordeState` pour `vx`/`vy` specifiquement.
   */
  saveState(out: HordeState): void {
    out.count = this.#count;
    out.x.set(this.x);
    out.y.set(this.y);
    out.vx.set(this.vx);
    out.vy.set(this.vy);
    out.archetype.set(this.archetype);
    out.waveId.set(this.waveId);
    out.indexInWave.set(this.indexInWave);
    out.animPhase.set(this.animPhase);
    out.targetField.set(this.targetField);
    out.stopped.set(this.stopped);
  }

  /** Inverse de `saveState` : remplace l'etat courant par `state`. */
  restoreState(state: HordeState): void {
    this.#count = state.count;
    this.x.set(state.x);
    this.y.set(state.y);
    this.vx.set(state.vx);
    this.vy.set(state.vy);
    this.archetype.set(state.archetype);
    this.waveId.set(state.waveId);
    this.indexInWave.set(state.indexInWave);
    this.animPhase.set(state.animPhase);
    this.targetField.set(state.targetField);
    this.stopped.set(state.stopped);
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
      this.vx[slot] = this.vx[last] ?? 0;
      this.vy[slot] = this.vy[last] ?? 0;
      this.archetype[slot] = this.archetype[last] ?? 0;
      this.waveId[slot] = this.waveId[last] ?? 0;
      this.indexInWave[slot] = this.indexInWave[last] ?? 0;
      this.animPhase[slot] = this.animPhase[last] ?? 0;
      this.targetField[slot] = this.targetField[last] ?? 0;
      this.stopped[slot] = this.stopped[last] ?? 0;
    }
    this.#count = last;
  }

  /**
   * Reaffecte chaque entite au joueur le plus proche, et decide si elle est
   * a portee de contact (tache 17.2).
   *
   * Appele a la cadence du flowfield (10 Hz), pas a chaque tick : changer de
   * cible chaque tick fait vibrer les trajectoires. C'est aussi, DELIBEREMENT,
   * la cadence a laquelle `stopped` se met a jour : `playerX`/`playerY` sont
   * deja les positions RETARDEES que l'appelant lit dans `PlayerHistory`
   * (§5 de la spec) pour alimenter le flowfield — les memes des deux cotes,
   * par construction. Decider l'arret ici, a partir de cette meme donnee,
   * plutot que dans `#advance` a partir d'on ne sait quoi, c'est ce qui
   * garantit qu'un serveur et un client s'arretent au meme tick : voir le
   * test « Horde s'arrete au contact de facon deterministe ».
   *
   * ⚠️ Ne PAS relire les positions de joueurs courantes ici, meme si elles
   * semblent plus a jour — c'est exactement ce qui romprait la replication
   * (meme piege que `spawnCatchingUp`, documente plus haut). L'arbitrage des
   * degats, lui, reste au serveur et sur les positions courantes
   * (`resolveContact`, `back/src/combat.ts`) : le leger decalage entre
   * « s'arrete » et « touche » est sans consequence, le serveur tranche.
   */
  retarget(playerX: readonly number[], playerY: readonly number[]): void {
    const contactR2 = CONTACT_RADIUS * CONTACT_RADIUS;
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
      this.stopped[i] = bestDist <= contactR2 ? 1 : 0;
    }
  }

  /**
   * Un pas de simulation. `dt` est fixe : 1 / TICK_HZ. `tick` est le tick
   * ABSOLU de la simulation (`Room.tick` cote serveur, le compteur local
   * aligne dessus cote client) — jamais un compteur qui repartirait de zero
   * par horde, puisque c'est lui qui decide, via `entityIdAt`, quelles
   * entites recalculent leur trajectoire ce tick (tache 19). Un rejeu
   * (`HordeHistory`) doit rappeler `step` avec le MEME tick absolu que celui
   * qu'il rejoue, pas avec un compteur local au rejeu : sans ca, une entite
   * ne recalculerait pas a la meme phase que la simulation d'origine, et le
   * rejeu cesserait de reproduire exactement ce qui s'est passe.
   *
   * Recalcule d'abord la trajectoire (direction du champ melangee a la
   * repulsion, puis remise a l'echelle de la vitesse propre — tache 21) des
   * entites dont c'est le tour, PUIS avance tout le monde le long de sa
   * vitesse tenue, PUIS defait les chevauchements restants par une correction
   * de position bornee (tache 22, `#applyDeoverlap`) — dans cet ordre, pour
   * que l'avancement de ce tick utilise deja la vitesse fraichement
   * recalculee plutot que celle d'il y a `STEERING_RECOMPUTE_TICKS` pas, et
   * que la correction de chevauchement s'applique a la geometrie REELLE du
   * tick (positions apres avancement), pas a celle d'avant.
   *
   * ⚠️ **`#applyDeoverlap` s'execute a CHAQUE tick, jamais seulement au
   * recalcul de trajectoire.** Un chevauchement est un fait geometrique du
   * PRESENT, pas une decision tenue `STEERING_RECOMPUTE_TICKS` pas comme la
   * direction de pilotage : le geler jusqu'au prochain recalcul laisserait
   * des entites deja arretees (`stopped`, tache 17.2) empilees au meme point
   * jusqu'a 300 ms, exactement le symptome que la tache 22 corrige.
   *
   * ⚠️ **`dt <= 0` est un NO-OP STRICT, y compris pour `vx`/`vy`.** Avant la
   * tache 19, un `dt` nul rendait deja `#advance` sans effet (vitesse
   * multipliee par `dt`), donc peu importait que `GameClient` appelle `step`
   * pendant le gel (`dt * movementScale = 0`) alors que `Room.step`, cote
   * serveur, ne l'appelle JAMAIS pendant le gel strict (retour anticipe avant
   * meme de calculer `scaledDt`) : les deux ne faisaient rien, de toute facon.
   * Mais `#recomputeSteering` ecrit `vx`/`vy` INDEPENDAMMENT de `dt` — sans ce
   * garde, le client continuerait de recalculer la vitesse des entites en
   * phase PENDANT le gel, alors que le serveur, lui, ne touche pas du tout a
   * la horde ce tick-la : `vx`/`vy` divergeraient en silence des la reprise,
   * exactement le genre de defaut que le scenario 9 de
   * `shared/horde.replication.test.ts` existe pour attraper. Ce garde retablit
   * l'invariant que tout le reste de ce fichier suppose deja : `dt <= 0` ne
   * fait litteralement rien.
   */
  step(dt: number, fields: readonly FlowField[], tick: number): void {
    if (dt > 0) {
      this.#recomputeSteering(tick, fields);
      this.#advanceByVelocity(0, this.#count, dt);
      this.#applyDeoverlap(0, this.#count);
    }
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
   * ⚠️ **Un seul modele de mouvement (tache 20, etendu tache 22).** Rattraper
   * un pas manque doit reproduire EXACTEMENT ce que `step` aurait fait ce
   * tick-la pour ces memes entites : recalculer leur trajectoire si c'est leur
   * tour de phase (`#recomputeSteering`), avancer selon la vitesse tenue
   * (`#advanceByVelocity`), PUIS defaire les chevauchements restants
   * (`#applyDeoverlap`, tache 22 — s'applique a CHAQUE pas rattrape, pas
   * seulement au dernier) — jamais une avance directe le long du champ
   * (`#advanceAlongField`, supprimee). Avant la tache 19, les deux chemins
   * (le rattrapage et la boucle normale) suivaient tous deux le champ : ils
   * coincidaient par construction. Depuis que la boucle normale tient une
   * vitesse entre deux recalculs de phase, un rattrapage qui continuait a
   * suivre le champ directement appliquait une PHYSIQUE DIFFERENTE de celle
   * du reste de la horde, et divergeait des le premier tick — mesure,
   * jusqu'a 1220 px sur ce seul mecanisme. Restreint a `[before, #count)` —
   * seules les entites que CET APPEL vient de faire naitre : les entites
   * deja presentes ont deja ete avancees par leurs propres appels a `step`,
   * les re-avancer ici les ferait avancer deux fois.
   *
   * Le tick simule pour le pas `step` (0-indexe) du rattrapage est
   * `order.spawnTick + step` : c'est le tick ABSOLU auquel le serveur, lui,
   * a reellement appele `step` pour faire avancer ces entites — celui qui
   * decide, via `entityIdAt`, qui recalcule sa trajectoire ce pas-la (meme
   * raisonnement que le parametre `tick` de `step`, voir sa doc).
   *
   * Ce que le rattrapage reste incapable de reproduire, meme ainsi : les
   * POSITIONS des voisins deja presents au moment ou `#recomputeSteering`
   * calcule leur repulsion. Le serveur, a chaque tick manque, voyait ces
   * voisins a LEUR position d'alors ; le rattrapage, execute d'un coup au
   * present, ne voit que leur position ACTUELLE. Pour la horde neuve elle-
   * meme (aucune entite preexistante dans `[before, #count)` au moment ou
   * elle apparait), ce n'est pas une approximation : rien d'autre n'existe
   * encore dans cette plage, donc la repulsion s'y calcule sur des positions
   * aussi fraiches que la simulation de reference. C'est seulement quand le
   * rattrapage doit aussi composer avec une horde deja peuplee que ce residu
   * (documente historiquement a ~20 px) peut reapparaitre.
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
    // `fields[0]` : n'importe lequel des quatre porte le meme masque
    // d'obstacles (voir la doc de `spawn`) ; le rattrapage cliente doit eviter
    // les murs exactement comme le fait `Room.step` cote serveur. C'est aussi
    // ce meme appel qui pose desormais la vitesse initiale de ces entites
    // (voir la doc de `spawn`) : identique a celle que le serveur leur a
    // posee, puisque c'est la MEME fonction, appelee avec le MEME champ gele.
    this.spawn(order, fields[0]);
    for (let step = 0; step < missedTicks; step++) {
      const tick = order.spawnTick + step;
      this.#recomputeSteering(tick, fields, before, this.#count);
      this.#advanceByVelocity(before, this.#count, dt);
      this.#applyDeoverlap(before, this.#count);
    }
  }

  /**
   * Avance le creneau `[from, to)` d'un pas le long de sa vitesse TENUE
   * (`vx`/`vy`) — le chemin normal de `step`, tache 19. Ne touche jamais aux
   * champs : toute la direction est deja capturee dans la vitesse par
   * `#recomputeSteering`.
   */
  #advanceByVelocity(from: number, to: number, dt: number): void {
    for (let i = from; i < to; i++) {
      // Tache 17.2 : une entite a portee de contact s'arrete plutot que de
      // traverser le joueur, quelle que soit la vitesse qu'elle tient par
      // ailleurs.
      if (this.stopped[i]) {
        continue;
      }
      const ex = this.x[i] ?? 0;
      const ey = this.y[i] ?? 0;
      this.x[i] = clamp(ex + (this.vx[i] ?? 0) * dt, 0, MAP_SIZE);
      this.y[i] = clamp(ey + (this.vy[i] ?? 0) * dt, 0, MAP_SIZE);
    }
  }

  /**
   * Correction de position BORNEE qui defait les chevauchements entre voisins
   * (tache 22) — jamais une force ajoutee a la vitesse comme l'ancienne
   * `STEERING_REPULSION_STRENGTH` (tache 19, additive, supprimee) : ceci
   * deplace directement `x`/`y`, borne a `DEOVERLAP_MAX_PX` PAR ENTITE ET PAR
   * TICK, en plus de l'avancement par vitesse que `#advanceByVelocity` vient
   * de faire.
   *
   * ⚠️ **Depuis la tache 23, la correction se decide PAR PRIORITE, plus par
   * symetrie.** Avant, CHAQUE membre d'une paire en chevauchement calculait
   * sa propre moitie de la correction (`overlap * 0.5`), et les deux moities
   * combinees ecartaient la paire de `overlap` au total. Desormais, seule
   * l'entite DERRIERE (voir `#isBehind` — le plus grand `dist` au champ vise,
   * departage par le plus petit identifiant) accumule une correction contre
   * un voisin donne, et elle encaisse l'ecart EN ENTIER (`overlap`, sans
   * `* 0.5`) : celle de devant n'accumule rien pour cette paire, et ne bouge
   * donc pas d'un pixel a cause d'elle. Le total ecarte la paire de la meme
   * distance qu'avant (`overlap`), mais un seul des deux le calcule — d'ou le
   * gain de cout mesure au banc (`bench:sep`, rapport de la tache 23).
   *
   * ⚠️ **Reutilise la grille de voisins DEJA construite par `#recomputeSteering`
   * au meme tick** (voir `step`/`spawnCatchingUp`, qui appellent toujours les
   * deux dans cet ordre) — jamais reconstruite ici. Cette grille reflete les
   * positions D'AVANT `#advanceByVelocity` ; l'ecart entre la cellule d'un
   * voisin et sa position reelle apres ce pas est de l'ordre de sa vitesse
   * propre par tick, tres en-deca de `SEPARATION_CELL` : sans consequence
   * pratique, et reconstruire doublerait le cout de cette passe pour rien
   * (voir le rapport de la tache 22, `bench:sep`).
   *
   * ⚠️ **Accumule dans `#correctionX`/`#correctionY` PUIS applique en bloc** —
   * jamais position par position pendant le calcul : sans quoi une entite j
   * deja deplacee changerait la correction que i, visite ensuite, calculerait
   * pour le MEME chevauchement, et le resultat dependrait de l'ordre du
   * tableau. Deux clients qui compactent differemment apres des morts
   * (`#removeAt`) verraient alors deux resultats differents pour un
   * chevauchement pourtant identique — la meme discipline que le reste de ce
   * fichier (`kill`, `#recomputeSteering`).
   *
   * S'applique aussi aux entites `stopped` (tache 17.2) : DELIBEREMENT,
   * puisque ce sont precisement elles qui, sans cette correction, restent
   * empilees au meme point apres etre arrivees a portee de contact (462 sur
   * 800, mesure). Les repousser les unes des autres, bornees, est ce qui
   * forme un ANNEAU autour du joueur au lieu d'un tas. `#advanceByVelocity`
   * continue, lui, de ne jamais faire AVANCER une entite arretee : les deux
   * regles ne se contredisent pas — l'une porte sur le deplacement par
   * vitesse, l'autre sur la resolution d'un chevauchement geometrique du
   * present.
   *
   * `from`/`to` restreint QUELLES entites RECOIVENT une correction ce tick-la
   * — meme convention que `#advanceByVelocity` et `#recomputeSteering` : les
   * entites hors plage restent des voisins valides (on peut se pousser LOIN
   * D'ELLES), seule LEUR PROPRE position ne change pas via cet appel.
   *
   * ⚠️ **Lit `#priorityDist` (distance-cellule au champ vise), jamais
   * `fields` directement.** Ce cache est rempli UNE FOIS par tick par
   * `#recomputeSteering` (`#buildPriorityCache`), toujours appele juste
   * avant (voir `step`/`spawnCatchingUp`) — la meme reutilisation que la
   * grille de voisins ci-dessus, pour la meme raison : relire le flowfield
   * ICI, par paire visitee, ferait le meme calcul en double pour chaque
   * voisin (mesure au banc, voir la doc de `#priorityDist`). La distance
   * elle-meme ne sert QU'A decider qui, d'une paire, est derriere — jamais a
   * orienter la correction, qui reste purement geometrique (`dx`/`dy` entre
   * les deux positions).
   */
  #applyDeoverlap(from: number, to: number): void {
    if (to <= from) {
      return;
    }
    this.#correctionX.fill(0, from, to);
    this.#correctionY.fill(0, from, to);

    const r = SEPARATION_RADIUS;
    const r2 = r * r;
    const cols = this.#gridCols;

    for (let i = from; i < to; i++) {
      const xi = this.x[i] ?? 0;
      const yi = this.y[i] ?? 0;
      const idI = this.entityIdAt(i);
      const distI = this.#priorityDist[i] ?? 0;
      let pushX = 0;
      let pushY = 0;

      const cx = Math.min(cols - 1, Math.max(0, Math.floor(xi / SEPARATION_CELL)));
      const cy = Math.min(cols - 1, Math.max(0, Math.floor(yi / SEPARATION_CELL)));
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = cx + ox;
          const ny = cy + oy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= cols) {
            continue;
          }
          const c = ny * cols + nx;
          const cellFrom = this.#cellStart[c] ?? 0;
          const cellTo = this.#cellStart[c + 1] ?? 0;
          for (let k = cellFrom; k < cellTo; k++) {
            const j = this.#order[k] ?? 0;
            if (j === i) {
              continue;
            }
            // Tache 23 : verifie la priorite AVANT toute geometrie — le cas
            // le moins cher (comparer deux entiers) elimine la moitie des
            // paires sans jamais calculer de racine carree pour celle de
            // devant, qui n'a rien a accumuler contre ce voisin-la.
            if (!this.#isBehind(distI, idI, this.#priorityDist[j] ?? 0, this.entityIdAt(j))) {
              continue;
            }
            const dx = xi - (this.x[j] ?? 0);
            const dy = yi - (this.y[j] ?? 0);
            const d2 = dx * dx + dy * dy;
            // `d2 === 0` : meme convention que `#recomputeSteering` — un
            // chevauchement EXACTEMENT total n'a pas de direction a en
            // deduire sans arbitraire, voir sa doc pour le meme choix.
            if (d2 > r2 || d2 === 0) {
              continue;
            }
            const d = Math.sqrt(d2);
            const overlap = r - d;
            // Tache 23 : celui de derriere encaisse TOUT l'ecart — plus de
            // `* 0.5`, puisque celui de devant, lui, n'accumule rien pour
            // cette paire (voir le garde-fou de priorite ci-dessus).
            pushX += (dx / d) * overlap;
            pushY += (dy / d) * overlap;
          }
        }
      }
      this.#correctionX[i] = pushX;
      this.#correctionY[i] = pushY;
    }

    for (let i = from; i < to; i++) {
      let cx = this.#correctionX[i] ?? 0;
      let cy = this.#correctionY[i] ?? 0;
      const mag = Math.sqrt(cx * cx + cy * cy);
      if (mag > DEOVERLAP_MAX_PX) {
        const scale = DEOVERLAP_MAX_PX / mag;
        cx *= scale;
        cy *= scale;
      }
      this.x[i] = clamp((this.x[i] ?? 0) + cx, 0, MAP_SIZE);
      this.y[i] = clamp((this.y[i] ?? 0) + cy, 0, MAP_SIZE);
    }
  }

  /**
   * Recalcule `vx`/`vy` des entites dont c'est le tour ce tick (tache 19) :
   * direction du champ vise, MELANGEE (pas additionnee, tache 21) a la
   * repulsion sommee sur TOUS les voisins dans `SEPARATION_RADIUS` — celle-ci
   * plafonnee comme un seul voisin en recouvrement total (meme raisonnement
   * que l'ancien `SeparationGrid`, tache 18) puis ponderee par
   * `STEERING_REPULSION_WEIGHT` — avant de normaliser le tout et de remettre a
   * l'echelle de la vitesse propre de l'archetype.
   *
   * ⚠️ **Dévier, pas propulser (tache 21).** Additionner la repulsion a la
   * vitesse (l'ancienne formule, tache 19) laissait le total depasser
   * largement la vitesse propre — mesure jusqu'a plusieurs dizaines de px par
   * tick, une entite manifestement PROPULSEE plutot que gênee. Melanger les
   * DIRECTIONS puis ne remettre a l'echelle qu'UNE SEULE fois, par la vitesse
   * propre, rend ce depassement structurellement impossible : `Math.hypot(vx,
   * vy)` ne peut plus jamais exceder `archetypeOf(...).speed`, quelle que soit
   * la densite de voisins. Voir `STEERING_REPULSION_WEIGHT` pour le reglage
   * choisi et le rapport de la tache 21 pour la mesure.
   *
   * ⚠️ **Cas degenere : ne JAMAIS normaliser un vecteur nul.** Si la direction
   * du champ et la repulsion ponderee s'annulent presque exactement (un
   * monstre parfaitement entoure, ou immobile sur sa cible et symetriquement
   * serre), leur somme a une norme quasi nulle — la diviser produirait `NaN`,
   * qui se propagerait en silence dans `x`/`y` puis dans toute la horde (rien
   * qui ne verifie que des magnitudes ne le verrait). Dans ce cas, on retombe
   * sur la direction du champ SEULE (deja unitaire, ou nulle si l'entite est
   * sur sa cible) plutot que de diviser par cette norme quasi nulle.
   *
   * ⚠️ **La phase choisit l'entite qui recalcule, pas la paire qui interagit.**
   * L'ancien `SeparationGrid` visitait chaque PAIRE une fois (`j > i`) et
   * appliquait la force aux deux membres a la fois — une optimisation valide
   * tant que tout le monde recalcule a chaque tick. Ici, une entite qui
   * recalcule doit voir TOUS ses voisins, actifs ou non, meme ceux qui ne
   * recalculent pas ce tick-ci : leur position courante est toujours un
   * intrant valide, seule LEUR PROPRE vitesse ne change pas maintenant. Le
   * parcours symetrique casserait cette independance (une entite hors phase
   * verrait sa vitesse modifiee hors de son propre tick de recalcul) ; il
   * disparait donc, au prix de visiter deux fois plus de paires — largement
   * compense par le fait qu'un seul tick sur `STEERING_RECOMPUTE_TICKS`
   * declenche la recherche de voisins par entite (le gain mesure, voir le
   * rapport de la tache 19).
   *
   * ⚠️ **Depuis la tache 23, la repulsion sommee ne porte plus que sur les
   * voisins dont l'entite est DERRIERE** (voir `#isBehind` : le plus grand
   * `dist` au champ vise est le plus loin derriere, departage par le plus
   * petit identifiant). Une entite EN AVANT d'un voisin n'accumule rien
   * contre lui — c'est ce voisin, derriere, qui devie pour l'eviter, jamais
   * l'inverse. Ce n'est pas le meme axe que la phase ci-dessus : la phase dit
   * QUI recalcule ce tick, la priorite dit QUELS voisins, parmi ceux vus,
   * comptent dans la somme.
   *
   * `from`/`to` restreignent QUELLES entites peuvent recalculer ce tick-la —
   * la grille de voisins, elle, reste TOUJOURS construite sur les `#count`
   * entites entieres, actives ou non dans cette plage : une entite hors
   * plage reste un intrant valide pour la repulsion de celles qui recalculent
   * (tache 19), seule SA PROPRE vitesse a elle ne doit pas changer. Par
   * defaut `[0, #count)` — le comportement de `step`, tout le monde eligible.
   * `spawnCatchingUp` (tache 20) restreint a `[before, #count)` : seules les
   * entites qu'IL vient de faire naitre peuvent recalculer, jamais celles
   * deja presentes, deja avancees par leurs propres appels a `step`.
   */
  #recomputeSteering(
    tick: number,
    fields: readonly FlowField[],
    from = 0,
    to: number = this.#count,
  ): void {
    const n = this.#count;
    if (n === 0) {
      return;
    }
    this.#buildNeighbourGrid(n);
    // Tache 23 : une lecture de flowfield par entite, ici, pas par paire
    // visitee plus bas — voir la doc de `#priorityDist`.
    this.#buildPriorityCache(n, fields);

    const K = STEERING_RECOMPUTE_TICKS;
    const phase = ((tick % K) + K) % K;
    const r2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
    const cols = this.#gridCols;

    for (let i = from; i < to; i++) {
      const idI = this.entityIdAt(i);
      if (idI % K !== phase) {
        continue;
      }

      const xi = this.x[i] ?? 0;
      const yi = this.y[i] ?? 0;
      const distI = this.#priorityDist[i] ?? 0;

      let pushX = 0;
      let pushY = 0;
      const cx = Math.min(cols - 1, Math.max(0, Math.floor(xi / SEPARATION_CELL)));
      const cy = Math.min(cols - 1, Math.max(0, Math.floor(yi / SEPARATION_CELL)));
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = cx + ox;
          const ny = cy + oy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= cols) {
            continue;
          }
          const c = ny * cols + nx;
          const from = this.#cellStart[c] ?? 0;
          const to = this.#cellStart[c + 1] ?? 0;
          for (let k = from; k < to; k++) {
            const j = this.#order[k] ?? 0;
            if (j === i) {
              continue;
            }
            // Tache 23 : ne compter, dans la somme, que les voisins dont je
            // suis DERRIERE — voir la doc de la methode.
            if (!this.#isBehind(distI, idI, this.#priorityDist[j] ?? 0, this.entityIdAt(j))) {
              continue;
            }
            const dx = xi - (this.x[j] ?? 0);
            const dy = yi - (this.y[j] ?? 0);
            const d2 = dx * dx + dy * dy;
            if (d2 > r2 || d2 === 0) {
              continue;
            }
            const d = Math.sqrt(d2);
            const push = (SEPARATION_RADIUS - d) / SEPARATION_RADIUS;
            pushX += (dx / d) * push;
            pushY += (dy / d) * push;
          }
        }
      }

      const mag = Math.sqrt(pushX * pushX + pushY * pushY);
      if (mag > 1) {
        pushX /= mag;
        pushY /= mag;
      }

      // Direction du champ, UNITAIRE (jamais mise a l'echelle ici) : c'est ce
      // qui permet de la MELANGER avec la repulsion avant de ne remettre a
      // l'echelle qu'UNE SEULE fois, par la vitesse propre, plus bas.
      let fx = 0;
      let fy = 0;
      const field = fields[this.targetField[i] ?? 0];
      if (field) {
        const cell = field.indexAt(xi, yi);
        fx = field.dirX[cell] ?? 0;
        fy = field.dirY[cell] ?? 0;
      }

      const speed = archetypeOf(this.archetype[i] ?? 0).speed;
      const blendX = fx + pushX * STEERING_REPULSION_WEIGHT;
      const blendY = fy + pushY * STEERING_REPULSION_WEIGHT;
      const blendMag = Math.sqrt(blendX * blendX + blendY * blendY);

      if (blendMag > STEERING_DEGENERATE_EPSILON) {
        this.vx[i] = (blendX / blendMag) * speed;
        this.vy[i] = (blendY / blendMag) * speed;
      } else {
        // Cas degenere (voir la doc de la methode) : la somme s'annule, on ne
        // la divise JAMAIS — on retombe sur la direction du champ seule, deja
        // unitaire (ou nulle si l'entite est pile sur sa cible).
        this.vx[i] = fx * speed;
        this.vy[i] = fy * speed;
      }
    }
  }

  /**
   * Distance de l'entite `i` au champ qu'elle vise, en cellules de flowfield
   * (tache 23) — la mesure de priorite : le plus grand `dist` est le plus
   * loin derriere le joueur vise, donc c'est cette entite qui cede (voir
   * `#isBehind`).
   *
   * ⚠️ **Traite comme « infiniment derriere » (jamais comme « devant ») :**
   * - un champ absent (`fields[targetField[i]]` indefini — jamais en
   *   production, seulement dans des tests qui n'en fournissent aucun) ;
   * - une cellule inatteignable (`FlowField.dist` vaut `-1` — voir sa doc,
   *   `UNREACHED`).
   * Une entite sans mesure de distance fiable ne doit jamais, par un -1 ou un
   * 0 par defaut, sembler PLUS PRES du joueur qu'un voisin correctement
   * repere, et donc l'empecher a tort de ceder a sa place.
   */
  #fieldDistAt(i: number, fields: readonly FlowField[]): number {
    const field = fields[this.targetField[i] ?? 0];
    if (!field) {
      return Number.POSITIVE_INFINITY;
    }
    const cell = field.indexAt(this.x[i] ?? 0, this.y[i] ?? 0);
    const raw = field.dist[cell] ?? 0;
    return raw < 0 ? Number.POSITIVE_INFINITY : raw;
  }

  /**
   * Vrai si l'entite de priorite (`distSelf`, `idSelf`) doit CEDER face a
   * celle de priorite (`distOther`, `idOther`) — tache 23, la regle centrale
   * de l'evitement par priorite.
   *
   * Le plus grand `dist` (le plus loin du joueur vise) est derriere, donc
   * cede. **A egalite exacte de distance, le plus petit identifiant gagne** —
   * meme convention que `nearestTarget` et `Projectiles.collide` : le
   * resultat ne doit jamais dependre de l'ordre du tableau, faute de quoi
   * deux clients qui compactent differemment apres des morts (`#removeAt`)
   * decideraient differemment qui cede pour un chevauchement pourtant
   * identique.
   */
  #isBehind(distSelf: number, idSelf: number, distOther: number, idOther: number): boolean {
    return distSelf > distOther || (distSelf === distOther && idSelf > idOther);
  }

  /**
   * Remplit `#priorityDist` pour les `n` premieres entites (tache 23) — une
   * seule lecture de flowfield par entite, jamais par paire. Appele UNE FOIS
   * par tick, juste apres `#buildNeighbourGrid` dans `#recomputeSteering` —
   * jamais dans `#applyDeoverlap`, qui reutilise ce meme cache, exactement
   * comme il reutilise deja la grille de voisins (voir sa doc).
   */
  #buildPriorityCache(n: number, fields: readonly FlowField[]): void {
    for (let i = 0; i < n; i++) {
      this.#priorityDist[i] = this.#fieldDistAt(i, fields);
    }
  }

  /**
   * Construit la grille de recherche de voisins pour les `n` premieres
   * entites, par tri par comptage (deux passes lineaires, zero allocation) —
   * repris tel quel de l'ancien `SeparationGrid.apply`.
   */
  #buildNeighbourGrid(n: number): void {
    const cols = this.#gridCols;
    this.#cellCount.fill(0);

    for (let i = 0; i < n; i++) {
      const cx = Math.min(cols - 1, Math.max(0, Math.floor((this.x[i] ?? 0) / SEPARATION_CELL)));
      const cy = Math.min(cols - 1, Math.max(0, Math.floor((this.y[i] ?? 0) / SEPARATION_CELL)));
      const c = cy * cols + cx;
      this.#cellIdx[i] = c;
      this.#cellCount[c] = (this.#cellCount[c] ?? 0) + 1;
    }
    let running = 0;
    for (let c = 0; c < this.#cellCount.length; c++) {
      this.#cellStart[c] = running;
      this.#cursor[c] = running;
      running += this.#cellCount[c] ?? 0;
    }
    this.#cellStart[this.#cellCount.length] = running;
    for (let i = 0; i < n; i++) {
      const c = this.#cellIdx[i] ?? 0;
      this.#order[this.#cursor[c] ?? 0] = i;
      this.#cursor[c] = (this.#cursor[c] ?? 0) + 1;
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
