import {
  archetypeOf,
  GUARD_BODY,
  GUARD_HOMING_RANGE,
  GUARD_RING_RADIUS,
  leapFactor,
  PORTEUR_FLEE_RADIUS,
  SHOOTER_RANGE,
  THIEF_FLEE_SPEED,
} from './archetypes';
import { type BossCharge, chargeHoldsAt, chargePointAt } from './boss';
import {
  COIN_DROP_ONE_IN,
  COIN_DROP_RESIDUE,
  CONTACT_RADIUS,
  DEOVERLAP_MAX_PX,
  MAP_SIZE,
  MARK_DURATION_TICKS,
  MAX_ENTITIES,
  MAX_PER_WAVE,
  ORB_DROP_ONE_IN,
  SEPARATION_CELL,
  SEPARATION_RADIUS,
  STEERING_RECOMPUTE_TICKS,
  STEERING_REPULSION_WEIGHT,
  ZONE_RADIUS,
} from './constants';
import { ELEMENT } from './elements';
import type { FlowField } from './flowfield';
import { zoneFieldSign, zoneInertiaDamping, zoneSlowFactor } from './reactions';
import { formationPositions, type WaveOrder } from './waves';
import type { ZoneField } from './zones';

/**
 * Norme sous laquelle le melange champ + repulsion est traite comme nul dans
 * `#recomputeSteering`. Ce n'est pas une tolerance d'arrondi : les deux
 * contributions valent au plus quelques unites (champ unitaire, repulsion
 * plafonnee puis ponderee), donc seule une annulation reelle passe sous `1e-6`.
 */
const STEERING_DEGENERATE_EPSILON = 1e-6;

/** La place d'un gardien sur son anneau : un angle tire de son identite (en degres entiers, puis radians). */
export function guardAngle(entityId: number): number {
  return (((entityId * 137) % 360) * Math.PI) / 180;
}

/**
 * Repousse un joueur hors des gardiens qu'il chevauche, et rend le DECALAGE
 * a appliquer (le serveur et la prediction le passent par `moveOnMap`, pour
 * que le decor bloque aussi). Meme fonction des deux cotes.
 */
export function pushOutOfGuards(
  x: number,
  y: number,
  horde: Horde,
  playerBody: number,
): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  const r = GUARD_BODY + playerBody;
  for (let i = 0; i < horde.count; i++) {
    if (archetypeOf(horde.archetype[i] ?? 0).behavior !== 'gardien') {
      continue;
    }
    const ox = x + dx - (horde.x[i] ?? 0);
    const oy = y + dy - (horde.y[i] ?? 0);
    const d = Math.hypot(ox, oy);
    if (d >= r) {
      continue;
    }
    if (d === 0) {
      dx += r;
      continue;
    }
    dx += (ox / d) * (r - d);
    dy += (oy / d) * (r - d);
  }
  return { dx, dy };
}

/**
 * L'identite est **arithmetique**, pas negociee : deux postes qui recoivent le
 * meme ordre de vague fabriquent les memes identifiants, sans table de
 * correspondance a synchroniser.
 */
export function entityIdOf(waveId: number, index: number): number {
  return waveId * MAX_PER_WAVE + index;
}

/**
 * Cette mort laisse-t-elle un orbe ?
 *
 * ⚠️ **Derive de l'identite, comme `entityIdOf`** : les deux cotes du fil en
 * tirent la meme reponse sans echanger un octet. Le serveur arbitre le
 * ramassage mais n'annonce jamais qu'un orbe existe — le client le derive du
 * seul message `DEATHS` (voir `DerivedOrbs` dans `front/src/net/client.ts`). Un
 * tirage aleatoire ferait diverger les deux cotes ; `shared/` interdit
 * `Math.random` pour cette raison.
 *
 * ⚠️ **Le reste modulo suit l'INDEX DANS LA VAGUE**, puisque `MAX_PER_WAVE`
 * est un multiple de `ORB_DROP_ONE_IN` : une entite sur `ORB_DROP_ONE_IN`
 * exactement, sans variance, ce qui garde l'experience par mort fixe (voir
 * `XP_PER_ORB`).
 *
 * ⚠️ **Piege de test** : un monstre pose a `entityIdOf(waveId, 0)` tombe
 * TOUJOURS sur un orbe. Les tests du taux de chute balaient donc des index
 * CONSECUTIFS, jamais un index unique.
 */
export function dropsOrb(entityId: number): boolean {
  return entityId % ORB_DROP_ONE_IN === 0;
}

/**
 * Cette mort laisse-t-elle une PIECE ? Meme modele que `dropsOrb` : derive de
 * l'identite, le client la deduit du seul message `DEATHS`.
 *
 * ⚠️ **DISJOINT de `dropsOrb`** (voir `COIN_DROP_RESIDUE`) : la nature d'un
 * ramassage se lit ainsi dans l'identite que `PICKUPS` transporte deja, sans
 * champ de plus dans le message.
 *
 * ⚠️ **Piege de test inverse de `dropsOrb`** : un monstre pose a
 * `entityIdOf(waveId, 0)` ne tombe JAMAIS sur une piece. Les tests du taux
 * balaient des index CONSECUTIFS.
 */
export function dropsCoin(entityId: number): boolean {
  return entityId % COIN_DROP_ONE_IN === COIN_DROP_RESIDUE;
}

/**
 * Cette mort laisse-t-elle QUELQUE CHOSE au sol ?
 *
 * ⚠️ **La seule garde du goulot.** `OrbField.spawn` (serveur) et
 * `DerivedOrbs.spawn` (client) posent l'objet sans connaitre sa nature : elle
 * se relit de l'identite a l'affichage et au ramassage. Une seule reserve
 * evite deux capacites, deux compteurs de troncature et deux calques.
 */
export function leavesDrop(entityId: number): boolean {
  return dropsOrb(entityId) || dropsCoin(entityId);
}

/**
 * Instantane de l'etat de la horde, pour `HordeHistory`.
 *
 * **Les QUINZE memes tableaux que `Horde`, sans exception**, plus le compte.
 * `HordeHistory` en alloue un par creneau de son anneau, une seule fois ;
 * `saveState` / `restoreState` y copient par `.set()`, sans allocation par tick.
 *
 * ⚠️ **La liste est la MEME que celle de `#removeAt`, et c'est delibere.**
 * `hp` et la marque ne sont lus que par le serveur, qui ne rejoue rien, mais
 * deux listes differentes a tenir a jour finissent par diverger.
 *
 * ⚠️ **`vx`/`vy` DOIVENT en faire partie** : la vitesse est tenue jusqu'au
 * prochain recalcul, donc un rejeu qui ne la restaurerait pas repartirait dans
 * une direction perimee. Le scenario 9 de `shared/horde.replication.test.ts`
 * (rejeu, derive attendue a 0,000 px) le verifie.
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
  fleeing: Uint8Array;
  hp: Float32Array;
  mark: Uint8Array;
  markBy: Uint8Array;
  markUntil: Float64Array;
  /**
   * Les positions visees du dernier `retarget` (`Horde.aimX`/`aimY`) : le
   * gardien s'en sert pour SE DEPLACER, donc un rejeu doit repartir des
   * memes. ponytail: une copie de quatre nombres par tick enregistre.
   */
  aimX: number[];
  aimY: number[];
}

/**
 * L'etat de la horde, en tableaux typés.
 *
 * Jamais un objet par ennemi : a 1 500 entites, le cout des indirections et de
 * la pression memoire depasse celui de tout le pas de simulation.
 *
 * Le serveur et chaque client executent ce meme code. Les identites et les
 * archetypes sont identiques par arithmetique entiere ; les positions ont le
 * droit de deriver de quelques pixels.
 *
 * ⚠️ **La capacite doit etre identique sur le serveur et sur chaque client.**
 * `spawn` tronque quand elle est atteinte : deux simulations qui tronquent a
 * des endroits differents divergent en silence. La valeur par defaut du
 * constructeur rend le cas nominal correct.
 */
export class Horde {
  readonly x: Float32Array;
  readonly y: Float32Array;
  /**
   * Vitesse tenue, en pixels monde par seconde.
   *
   * Recalculee un tick sur `STEERING_RECOMPUTE_TICKS`, la phase venant de
   * `entityIdAt` (voir `#recomputeSteering`) ; les autres ticks,
   * `#advanceByVelocity` s'en sert telle quelle. Cette conservation empeche une
   * entite de se renverser d'un tick a l'autre dans la foule.
   *
   * ⚠️ **Sa NORME ne depasse jamais `archetypeOf(...).speed`** :
   * `#recomputeSteering` melange les directions du champ et de la repulsion,
   * puis remet a l'echelle de la vitesse propre. La densite ne peut pas
   * propulser un monstre plus vite qu'il ne marche.
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
   * Les positions de joueurs du dernier `retarget` — RETARDEES, donc les memes
   * des deux cotes. Le tireur vise `aimX[targetField[i]]` (`EnemyShots`).
   */
  aimX: number[] = [];
  aimY: number[] = [];
  /**
   * `1` : un voleur qui a touche son joueur et s'enfuit, pour toujours.
   * Decide par `retarget` (meme donnee des deux cotes), donc replique sans
   * octet ; dans l'instantane comme `stopped`.
   */
  readonly fleeing: Uint8Array;
  /**
   * `1` si l'entite ne doit pas avancer : a portee de contact (de tir pour le
   * tireur), porteur qui attend, boss qui charge. DERIVE dans `retarget`, a
   * partir des positions de joueurs retardees : voir sa doc pour pourquoi
   * l'arret est identique des deux cotes.
   *
   * ⚠️ **Simulation, pas rendu** : ce booleen seul decide si une entite avance
   * dans `#advanceByVelocity`. Le rendu (`front/src/render/horde-renderer.ts`)
   * le LIT pour choisir le clip, mais ne le calcule jamais, sans quoi deux
   * clients dessineraient une attaque a des instants differents.
   */
  readonly stopped: Uint8Array;
  /**
   * Les identites dans l'aura d'un chaman ce tick-ci (`Room`, cote SERVEUR
   * seul) : `armureA` les protege. Des IDENTITES, pas des creneaux — la
   * compaction de chaque passe de degats deplace les creneaux, pas les noms.
   * Le client ne la remplit jamais : les PV ennemis ne voyagent pas.
   */
  readonly aura = new Set<number>();
  /**
   * Points de vie restants, poses par `spawn` depuis `archetypeOf(...).hp`.
   *
   * ⚠️ **Seul le serveur les soustrait.** Le client les porte parce que c'est le
   * meme code et que la valeur de depart se derive de l'archetype, sans un octet
   * sur le fil ; il ne les lit jamais et apprend les morts par `DEATHS`.
   *
   * `Float32Array` : les degats sont fractionnaires des que les passifs de
   * degats entrent en jeu (`weapon.damage * (1 + loadout.bonus('damage'))`).
   */
  readonly hp: Float32Array;
  /**
   * Element porte par l'entite — `ELEMENT.NEUTRE` (0) quand elle n'en porte
   * aucun.
   *
   * ⚠️ **Au plus UN element a la fois.** Un ennemi marque Braise que touche du
   * Givre ne cumule pas : il REAGIT et la marque se consomme (cote serveur,
   * pas ici). Un couple demanderait une seconde donnee par entite.
   *
   * ⚠️ **Ne pas le lire directement pour savoir si l'entite est marquee** :
   * la marque expire (voir `markUntil`). `markAt(slot, tick)` est le seul
   * lecteur correct.
   */
  readonly mark: Uint8Array;
  /**
   * Index du joueur qui a pose la marque courante, sans signification quand
   * l'entite n'est pas marquee.
   *
   * ⚠️ **C'est ce tableau qui rend la Synergie possible.** A la reaction, le
   * serveur compare ce joueur a celui du projectile ou de la zone declencheur :
   * differents, l'equipe gagne une charge ; le meme, la reaction ne rapporte
   * rien. Sans lui, reaction a deux et reaction en solo sont indiscernables.
   */
  readonly markBy: Uint8Array;
  /**
   * Tick ABSOLU auquel la marque cesse de valoir (`tick + MARK_DURATION_TICKS`
   * a la pose). `0` si jamais marquee : expiree pour tout tick >= 0.
   *
   * ⚠️ **L'expiration est DERIVEE, jamais annoncee** — meme modele que
   * `ZONE_LIFETIME_TICKS` : les deux cotes comparent ce nombre au tick courant,
   * sans octet sur le fil ni horloge murale.
   *
   * `Float64Array` et pas `Uint32Array` : somme d'un tick absolu et d'une
   * duree, elle doit rester exacte sans jamais reboucler.
   */
  readonly markUntil: Float64Array;

  #count = 0;

  /**
   * Revisions des champs relevees a la fin du dernier `step`. `null` tant que
   * `step` n'a encore jamais tourne : le tout premier ordre d'une horde neuve
   * n'a rien a comparer. Sert de garde-fou a `spawnCatchingUp` — voir la.
   */
  #lastFieldRevisions: Map<FlowField, number> | null = null;

  /**
   * Grille de recherche de voisins (tri par comptage), partagee par
   * `#recomputeSteering` et `#applyDeoverlap`. Pre-allouee une fois, jamais
   * reconstruite : `#buildNeighbourGrid` reste hors du ramasse-miettes.
   */
  readonly #gridCols: number;
  readonly #cellStart: Int32Array;
  readonly #cellCount: Int32Array;
  readonly #cursor: Int32Array;
  readonly #cellIdx: Int32Array;
  readonly #order: Int32Array;

  /**
   * Accumulateur de la correction de position de `#applyDeoverlap`,
   * pre-alloue. Une entite y somme ses chevauchements avec tous ses voisins
   * AVANT que rien ne soit ecrit dans `x`/`y` : corriger au fil de la boucle
   * ferait dependre le resultat de l'ordre du tableau, que deux clients
   * compactent differemment apres des morts (`#removeAt`).
   *
   * Pour une paire donnee, seule l'entite DERRIERE (voir `#isBehind`) accumule.
   */
  readonly #correctionX: Float32Array;
  readonly #correctionY: Float32Array;

  /**
   * Cache de priorite : la distance-cellule au champ vise de chaque entite,
   * recalculee UNE FOIS par tick par `#buildPriorityCache`, jamais par paire.
   *
   * ⚠️ **Sans ce cache, `#isBehind` coute cher** : relire le flowfield a chaque
   * visite de voisin dans `#recomputeSteering` et `#applyDeoverlap` refait le
   * meme calcul des dizaines de fois par tick, et ralentit le pas au banc
   * (`bench:sep`).
   */
  readonly #priorityDist: Float32Array;

  /**
   * Tampon de sortie de `FlowField.sampleDirection`, partage par `spawn` et
   * `#recomputeSteering` : ecrit puis lu immediatement, jamais conserve.
   */
  readonly #dirSample: Float32Array = new Float32Array(2);

  /**
   * Tampon de sortie de `chargePointAt`, meme discipline que `#dirSample`.
   *
   * ⚠️ **Un tampon, PAS un etat.** La charge arrive en parametre de `step`,
   * comme les zones : c'est l'appelant qui sait ce que le serveur a annonce.
   * Rien a sauvegarder dans `HordeState` : la position se REDERIVE a chaque pas
   * rejoue.
   */
  readonly #chargeSample: Float32Array = new Float32Array(2);

  /**
   * Facteur de vitesse par entite pour le pas courant, `1` partout quand
   * aucune zone ne ralentit personne.
   *
   * ⚠️ **Recalcule a CHAQUE avancement, jamais conserve** (voir `#computeSlow`) :
   * un intermediaire du pas, donc ni dans `HordeState` ni dans `#removeAt`. Le
   * rejeu le recalcule a partir des zones et du tick.
   *
   * `Float64Array` : garde le facteur exactement tel que la table le donne
   * (`Element.slowFactor`, un double).
   */
  readonly #slow: Float64Array;
  /** Le masque du decor au pas courant (`fields[0]`), pour `#moveOnLand`. */
  #ground: FlowField | null = null;

  /**
   * Signe du champ par entite pour le pas courant : `-1` sous une zone de
   * fuite, `+1` sinon, jamais une valeur intermediaire.
   *
   * ⚠️ **Recalcule a CHAQUE avancement, jamais conserve** (voir
   * `#computeFieldSign`) : comme `#slow`, ni dans `HordeState` ni dans
   * `#removeAt`.
   */
  readonly #fieldSign: Int8Array;

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
    this.fleeing = new Uint8Array(capacity);
    this.hp = new Float32Array(capacity);
    this.mark = new Uint8Array(capacity);
    this.markBy = new Uint8Array(capacity);
    this.markUntil = new Float64Array(capacity);
    this.#slow = new Float64Array(capacity);
    this.#fieldSign = new Int8Array(capacity);

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
   * entite en plein mur. N'importe lequel des champs convient : ils partagent
   * le meme masque d'obstacles.
   *
   * ⚠️ **`field` pose AUSSI la vitesse initiale** : la direction du champ au
   * point de naissance, a la vitesse de l'archetype, sans quoi l'entite reste
   * figee jusqu'a son premier recalcul de phase. Sans repulsion : elle depend
   * des positions des AUTRES entites, qui peuvent deja differer entre serveur
   * et client en retard (voir `spawnCatchingUp`), alors que la position de
   * naissance ne depend que de `order.seed`. Sans `field` (tests qui ne
   * testent pas le mouvement) : `vx = vy = 0`.
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
    const hp = archetype.hp;

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
      // Remis a zero explicitement : la compaction apres une mort recycle les
      // creneaux, et une entite neuve heriterait sinon de la cible du mort.
      this.targetField[slot] = 0;
      // Meme raison : un `stopped = 1` herite traverserait le joueur sans
      // l'attaquer jusqu'au prochain `retarget`.
      this.stopped[slot] = 0;
      this.fleeing[slot] = 0;
      // PV derives de l'archetype, identiques des deux cotes ; ecrits sans
      // condition pour la meme raison de recyclage.
      this.hp[slot] = hp;
      // Aucune marque a la naissance. Le cas le plus vicieux du recyclage : sans
      // ces trois lignes, un monstre naitrait marque PAR un joueur qu'il n'a
      // jamais croise, pret a declencher une reaction et une charge de Synergie.
      this.mark[slot] = ELEMENT.NEUTRE;
      this.markBy[slot] = 0;
      this.markUntil[slot] = 0;
      // `targetField` vaut 0, donc c'est bien `field` (le champ 0) qui sert ici,
      // sans repulsion (voir la doc de la methode).
      if (field) {
        // Direction interpolee, lue comme partout (`FlowField.sampleDirection`),
        // sans quoi serveur et client naitraient avec des vitesses differentes.
        field.sampleDirection(ex, ey, this.#dirSample);
        this.vx[slot] = (this.#dirSample[0] ?? 0) * speed;
        this.vy[slot] = (this.#dirSample[1] ?? 0) * speed;
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
   * Copie l'etat courant dans `out`, pre-alloue par l'appelant
   * (`HordeHistory.record`, a chaque tick) : aucune allocation ici.
   *
   * ⚠️ Les QUINZE tableaux, plus le compte — voir `HordeState`. En oublier un
   * laisse la suite verte jusqu'a ce qu'un rejeu s'appuie dessus.
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
    out.fleeing.set(this.fleeing);
    out.hp.set(this.hp);
    out.mark.set(this.mark);
    out.markBy.set(this.markBy);
    out.markUntil.set(this.markUntil);
    out.aimX = this.aimX.slice();
    out.aimY = this.aimY.slice();
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
    this.fleeing.set(state.fleeing);
    this.hp.set(state.hp);
    this.mark.set(state.mark);
    this.markBy.set(state.markBy);
    this.markUntil.set(state.markUntil);
    this.aimX = state.aimX.slice();
    this.aimY = state.aimY.slice();
  }

  /**
   * Pose une marque elementaire sur le creneau `slot`. `applyMark` et pas
   * `mark` : le nom est pris par le tableau.
   *
   * ⚠️ **Ecrase la marque precedente sans rien arbitrer.** C'est l'appelant
   * (`back/src/combat.ts`) qui decide, AVANT, s'il rafraichit une marque de
   * meme element ou declenche une reaction.
   *
   * ⚠️ **Appeler avec le tick ABSOLU de la simulation**, jamais un compteur
   * local : `markAt` le compare au meme tick absolu des deux cotes du fil.
   */
  applyMark(slot: number, element: number, playerId: number, tick: number): void {
    this.mark[slot] = element;
    this.markBy[slot] = playerId;
    this.markUntil[slot] = tick + MARK_DURATION_TICKS;
  }

  /**
   * L'element porte par le creneau `slot` au tick `tick`, ou `ELEMENT.NEUTRE`
   * si la marque a expire (ou n'a jamais ete posee).
   *
   * ⚠️ **L'expiration est DERIVEE ICI** : aucune passe n'efface les marques
   * perimees, aucun message ne les annonce. Borne STRICTE : une marque posee
   * au tick `T` vaut exactement `MARK_DURATION_TICKS` ticks, jusqu'a
   * `T + MARK_DURATION_TICKS - 1` inclus.
   */
  markAt(slot: number, tick: number): number {
    return tick < (this.markUntil[slot] ?? 0)
      ? (this.mark[slot] ?? ELEMENT.NEUTRE)
      : ELEMENT.NEUTRE;
  }

  /**
   * Deplace la derniere entite dans le creneau libere.
   *
   * ⚠️ **LES QUINZE TABLEAUX, sans exception.** En oublier un laisse l'entite
   * deplacee avec une propriete du mort — ses PV, ou sa marque et le joueur qui
   * l'a posee, de quoi declencher une reaction indue. Le test « emmene toutes
   * les proprietes » de `horde.test.ts` enumere une liste unique ET verifie
   * qu'elle couvre tous les tableaux de l'instance : en ajouter un a `Horde`
   * sans l'ajouter ici le fait rougir.
   */
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
      this.fleeing[slot] = this.fleeing[last] ?? 0;
      this.hp[slot] = this.hp[last] ?? 0;
      this.mark[slot] = this.mark[last] ?? 0;
      this.markBy[slot] = this.markBy[last] ?? 0;
      this.markUntil[slot] = this.markUntil[last] ?? 0;
    }
    this.#count = last;
  }

  /**
   * Reaffecte chaque entite au joueur le plus proche, et decide si elle
   * s'arrete (`stopped`) ou fuit (`fleeing`).
   *
   * Appele a la cadence du flowfield (10 Hz), pas a chaque tick : changer de
   * cible chaque tick fait vibrer les trajectoires. `playerX`/`playerY` sont
   * les positions RETARDEES lues dans `PlayerHistory`, les memes des deux
   * cotes : decider l'arret ici garantit qu'un serveur et un client s'arretent
   * au meme tick (test « Horde s'arrete au contact de facon deterministe »).
   *
   * ⚠️ Ne PAS relire les positions de joueurs courantes ici, meme plus a jour :
   * ca romprait la replication. L'arbitrage des degats reste au serveur, sur
   * les positions courantes (`resolveContact`, `back/src/combat.ts`).
   */
  retarget(playerX: readonly number[], playerY: readonly number[]): void {
    this.aimX = [...playerX];
    this.aimY = [...playerY];
    const contactR2 = CONTACT_RADIUS * CONTACT_RADIUS;
    const shooterR2 = SHOOTER_RANGE * SHOOTER_RANGE;
    const porteurR2 = PORTEUR_FLEE_RADIUS * PORTEUR_FLEE_RADIUS;
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
      // Le tireur s'arrete a portee de tir, pas au contact : meme donnee, meme
      // cadence, donc le meme arret des deux cotes.
      const behavior = archetypeOf(this.archetype[i] ?? 0).behavior;
      // Le porteur fuit le joueur le plus proche sous `PORTEUR_FLEE_RADIUS`,
      // sans etre collant comme le voleur. Hors du rayon il ATTEND (`stopped`) :
      // sinon il avancerait jusqu'au bord du rayon puis reculerait, en oscillant.
      if (behavior === 'porteur') {
        this.fleeing[i] = bestDist <= porteurR2 ? 1 : 0;
        this.stopped[i] = this.fleeing[i] === 1 ? 0 : 1;
        continue;
      }
      const stopR2 = behavior === 'tir' ? shooterR2 : contactR2;
      // Le voleur qui touche son joueur ne s'arrete pas : il vole et s'enfuit,
      // pour toujours (le serveur preleve l'or a ce meme passage).
      if (behavior === 'voleur' && bestDist <= contactR2) {
        this.fleeing[i] = 1;
      }
      this.stopped[i] = this.fleeing[i] === 0 && bestDist <= stopR2 ? 1 : 0;
    }
  }

  /**
   * Un pas de simulation. `dt` est fixe : 1 / TICK_HZ. `tick` est le tick
   * ABSOLU (`Room.tick` cote serveur, le compteur aligne dessus cote client) :
   * via `entityIdAt`, il decide quelles entites recalculent leur trajectoire.
   * Un rejeu (`HordeHistory`) doit rappeler `step` avec le MEME tick absolu.
   *
   * Ordre : recalcul de trajectoire des entites en phase, avancement le long
   * de la vitesse tenue, puis correction des chevauchements (`#applyDeoverlap`)
   * sur la geometrie apres avancement.
   *
   * ⚠️ **`#applyDeoverlap` s'execute a CHAQUE tick**, pas seulement au
   * recalcul : un chevauchement est un fait du present, et le geler laisserait
   * des entites `stopped` empilees au meme point pendant un cycle de recalcul.
   *
   * ⚠️ **`charge` REMPLACE le deplacement du boss, il ne s'y ajoute pas** —
   * voir `#applyCharge`, qui s'execute en DERNIER pour cette raison.
   *
   * ⚠️ **`dt <= 0` est un NO-OP STRICT, y compris pour `vx`/`vy`.** Pendant le
   * gel, `GameClient` appelle `step` avec un `dt` nul alors que `Room.step` ne
   * l'appelle pas du tout. Or `#recomputeSteering` ecrit `vx`/`vy`
   * independamment de `dt` : sans ce garde, le client recalculerait les
   * vitesses pendant le gel et divergerait du serveur a la reprise (scenario 9
   * de `shared/horde.replication.test.ts`).
   */
  step(
    dt: number,
    fields: readonly FlowField[],
    tick: number,
    zones?: ZoneField,
    charge?: BossCharge | null,
  ): void {
    this.#ground = fields[0] ?? null;
    if (dt > 0) {
      // #computeFieldSign AVANT #recomputeSteering : voir son docbloc, la
      // fuite doit etre connue au moment ou fx/fy se calculent.
      this.#computeFieldSign(zones, tick);
      this.#recomputeSteering(tick, fields, 0, this.#count, zones);
      this.#computeSlow(zones, tick);
      this.#advanceByVelocity(0, this.#count, dt, tick);
      this.#applyDeoverlap(0, this.#count);
      this.#applyCharge(charge, tick);
    }
    this.#recordFieldRevisions(fields);
  }

  /**
   * Pose la position du boss qui charge — **elle REMPLACE son deplacement, elle
   * ne s'y ajoute pas**.
   *
   * ⚠️ **EN DERNIER DU PAS, et c'est toute la mecanique du remplacement.**
   * `#advanceByVelocity` et `#applyDeoverlap` ont deja bouge le boss comme
   * n'importe quelle entite ; ecrire sa position apres efface leur effet. La
   * derniere ecriture gagne.
   *
   * ⚠️ **DANS le garde `dt > 0` de `step`, jamais dehors.** Pendant le gel, le
   * serveur n'avance pas sa horde et le client appelle `step` avec un `dt`
   * nul : deriver la charge hors du garde ferait avancer le boss chez le seul
   * client (scenario 9 de `shared/horde.replication.test.ts`).
   *
   * ⚠️ **`stopped = 1` est pose pour le CLIP, pas pour le deplacement** :
   * `selectClip` (`front/src/render/horde-renderer.ts`) joue alors le clip
   * d'attaque, dont les images montrent la rotation du boss qui charge. Comme
   * le reste, il se rederive a chaque pas, des deux cotes.
   *
   * Cout : un `slotOf` (balayage lineaire) par tick, seulement pendant une
   * charge.
   */
  #applyCharge(charge: BossCharge | null | undefined, tick: number): void {
    if (!charge || !chargeHoldsAt(charge, tick)) {
      return;
    }
    const slot = this.slotOf(charge.entityId);
    if (slot < 0) {
      // Le boss est mort en pleine charge : il n'y a plus rien a deplacer. Les
      // deux cotes l'apprennent par le meme lot `DEATHS`, donc les deux
      // s'arretent au meme tick.
      return;
    }
    chargePointAt(charge, tick, this.#chargeSample);
    // Borne a la carte comme `#advanceByVelocity` : un boss hors carte serait
    // invisible et increvable.
    //
    // ⚠️ **Et il s'arrete au rivage** : le couloir est une droite qui peut
    // traverser l'eau. Le boss garde sa place des que le point suivant est
    // bloque (`#onLand`), et le couloir continue de blesser sans lui.
    //
    // ⚠️ **Le segment, pas seulement son bout** : une charge avance de plus
    // d'une cellule par tick et sauterait un mur fin. On le parcourt par
    // demi-cellules et on s'arrete au dernier point libre.
    const cx = clamp(this.#chargeSample[0] ?? 0, 0, MAP_SIZE);
    const cy = clamp(this.#chargeSample[1] ?? 0, 0, MAP_SIZE);
    const ox = this.x[slot] ?? 0;
    const oy = this.y[slot] ?? 0;
    if (!this.#onLand(ox, oy) || !this.#ground) {
      this.x[slot] = cx;
      this.y[slot] = cy;
    } else {
      const pas = this.#ground.cellSize / 2;
      const n = Math.max(1, Math.ceil(Math.hypot(cx - ox, cy - oy) / pas));
      for (let k = 1; k <= n; k++) {
        const px = ox + ((cx - ox) * k) / n;
        const py = oy + ((cy - oy) * k) / n;
        if (!this.#onLand(px, py)) {
          break;
        }
        this.x[slot] = px;
        this.y[slot] = py;
      }
    }
    this.stopped[slot] = 1;
  }

  /**
   * Remplit `#slow` : pour chaque entite, le plus petit facteur de
   * ralentissement des zones qui la couvrent au tick `tick` (`1` si aucune).
   *
   * ⚠️ **L'effet porte sur la ZONE, jamais sur la marque, et c'est ce qui le
   * rend replicable.** La marque ne voyage pas ; les zones sont annoncees et
   * leur mort est derivee, donc les deux cotes testent les memes disques sur
   * des positions bit-identiques, pour zero octet de plus.
   *
   * ⚠️ **Le MINIMUM, jamais le produit.** L'ordre des zones n'est pas garanti
   * identique des deux cotes (compaction, et le client expire ses zones plus
   * tard, voir `ZoneField.aliveAt`). Le minimum est exactement commutatif et
   * associatif ; un produit de flottants ne l'est pas.
   *
   * ⚠️ **`slowsAt`, pas `aliveAt`** — voir `ZoneField.slowsAt` : une zone
   * posee au tick `T` ne ralentit qu'a partir de `T + 1`, parce que le serveur
   * fait avancer la horde AVANT de poser ses zones.
   *
   * Le facteur de chaque zone vient de `zoneSlowFactor` (`shared/reactions.ts`),
   * qui tient compte de sa reaction (0, gel total, pour la Supraconduction).
   * Cout : O(zones x entites). Le remplissage a `1` a lieu meme sans zones,
   * pour ne jamais garder le facteur du pas precedent.
   */
  #computeSlow(zones: ZoneField | undefined, tick: number): void {
    this.#slow.fill(1, 0, this.#count);
    if (!zones) {
      return;
    }
    const r2 = ZONE_RADIUS * ZONE_RADIUS;
    for (let z = 0; z < zones.count; z++) {
      if (!zones.slowsAt(z, tick)) {
        continue;
      }
      const factor = zoneSlowFactor(zones.kind[z] ?? 0);
      const zx = zones.x[z] ?? 0;
      const zy = zones.y[z] ?? 0;
      for (let i = 0; i < this.#count; i++) {
        const dx = (this.x[i] ?? 0) - zx;
        const dy = (this.y[i] ?? 0) - zy;
        if (dx * dx + dy * dy < r2 && factor < (this.#slow[i] ?? 1)) {
          this.#slow[i] = factor;
        }
      }
    }
  }

  /**
   * Remplit `#fieldSign` : pour chaque entite, `-1` si une zone de fuite (la
   * Chaux) la couvre au tick `tick`, `+1` sinon.
   *
   * ⚠️ **Meme MINIMUM que `#computeSlow`, pour la meme raison** : cette grandeur
   * determine `vx`/`vy` puis `x`/`y`, et l'ordre des zones peut differer entre
   * les deux cotes. `-1` gagne des qu'UNE zone l'impose.
   *
   * ⚠️ **Independant du gel de `#computeSlow`.** Une entite gelee ET fuyante
   * reste immobile : `#advanceByVelocity` multiplie la vitesse par `#slow`
   * apres que `#recomputeSteering` en a fixe la direction. Le gel gagne par
   * construction, sans regle de priorite ecrite ici.
   *
   * ⚠️ **Appelee AVANT `#recomputeSteering`**, qui lit le signe en calculant
   * `fx`/`fy`. Meme usage de `slowsAt` que `#computeSlow`.
   */
  #computeFieldSign(zones: ZoneField | undefined, tick: number): void {
    this.#fieldSign.fill(1, 0, this.#count);
    if (!zones) {
      return;
    }
    const r2 = ZONE_RADIUS * ZONE_RADIUS;
    for (let z = 0; z < zones.count; z++) {
      if (!zones.slowsAt(z, tick)) {
        continue;
      }
      const sign = zoneFieldSign(zones.kind[z] ?? 0);
      if (sign >= 1) {
        // Optimisation, meme motif que `#inertiaDampingAt` : une zone sans
        // effet propre ne peut jamais faire baisser un `#fieldSign` deja au
        // plancher (-1), inutile de balayer la horde pour elle.
        continue;
      }
      const zx = zones.x[z] ?? 0;
      const zy = zones.y[z] ?? 0;
      for (let i = 0; i < this.#count; i++) {
        const dx = (this.x[i] ?? 0) - zx;
        const dy = (this.y[i] ?? 0) - zy;
        if (dx * dx + dy * dy < r2 && sign < (this.#fieldSign[i] ?? 1)) {
          this.#fieldSign[i] = sign;
        }
      }
    }
  }

  /**
   * Le facteur de conservation de vitesse (Verglas) au point `(x, y)` : le plus
   * PETIT `zoneInertiaDamping` des zones qui ralentissent ce point
   * (`ZoneField.slowsAt`), `1` s'il n'y en a aucune.
   *
   * Appele PAR ENTITE depuis `#recomputeSteering`, seulement pour celles qui
   * recalculent ce tick : balayer les zones pour les autres serait perdu.
   * `slowsAt` et MINIMUM pour les memes raisons que `#computeSlow`.
   */
  #inertiaDampingAt(zones: ZoneField | undefined, tick: number, x: number, y: number): number {
    if (!zones) {
      return 1;
    }
    const r2 = ZONE_RADIUS * ZONE_RADIUS;
    let damping = 1;
    for (let z = 0; z < zones.count; z++) {
      if (!zones.slowsAt(z, tick)) {
        continue;
      }
      const factor = zoneInertiaDamping(zones.kind[z] ?? 0);
      if (factor >= damping) {
        continue;
      }
      const dx = (zones.x[z] ?? 0) - x;
      const dy = (zones.y[z] ?? 0) - y;
      if (dx * dx + dy * dy < r2) {
        damping = factor;
      }
    }
    return damping;
  }

  /**
   * Fait apparaitre une vague en rattrapant les pas manques.
   *
   * Un client recoit l'ordre apres le tick ou le serveur l'a applique. Sans
   * rattrapage, ses entites restent un ou deux pas en arriere, et l'ecart ne
   * reste PAS borne : decalees d'un pas, elles franchissent les frontieres de
   * cellules du flowfield a des instants differents et prennent des routes
   * differentes.
   *
   * ⚠️ **Un seul modele de mouvement.** Chaque pas rattrape reproduit EXACTEMENT
   * ce que `step` aurait fait : signe du champ, recalcul de trajectoire en
   * phase, ralentissement, avancement par vitesse, correction des
   * chevauchements, charge du boss. Une physique differente diverge des le
   * premier tick. Restreint a `[before, #count)` : les entites deja presentes
   * ont deja ete avancees par leurs propres `step`.
   *
   * Le pas `step` (0-indexe) simule le tick absolu `order.spawnTick + step`,
   * celui auquel le serveur a reellement avance ces entites.
   *
   * Residu irreductible : la repulsion voit les voisins preexistants a leur
   * position ACTUELLE, pas a celle des ticks manques. Sans horde preexistante,
   * le rattrapage est exact.
   *
   * ⚠️ **Ordre d'appel.** `fields` doit etre le champ d'AVANT le
   * rafraichissement periodique du tick courant : un champ deja rafraichi est
   * une entree que le serveur n'a vue qu'au tick suivant, et la derive repasse
   * dans les centaines de pixels. Concretement : appeler a la reception du
   * `WAVE_ORDER` (`#onFrame`), *avant* `#advanceHorde`.
   *
   * `missedTicks` vaut `tickCourant - order.spawnTick`, borne a zero.
   *
   * ⚠️ Leve si un champ a ete rafraichi entre le dernier `step` et cet appel :
   * l'erreur d'ordre ci-dessus devient un echec net plutot qu'une derive
   * silencieuse. Voir `#assertFieldsNotRefreshed`.
   */
  spawnCatchingUp(
    order: WaveOrder,
    missedTicks: number,
    dt: number,
    fields: readonly FlowField[],
    zones?: ZoneField,
    charge?: BossCharge | null,
  ): void {
    if (missedTicks > 0) {
      this.#assertFieldsNotRefreshed(fields);
    }

    const before = this.#count;
    this.#ground = fields[0] ?? null;
    // `fields[0]` : tous les champs portent le meme masque d'obstacles. Le meme
    // appel pose la vitesse initiale, identique a celle du serveur (meme
    // fonction, meme champ gele).
    this.spawn(order, fields[0]);
    for (let step = 0; step < missedTicks; step++) {
      const tick = order.spawnTick + step;
      // `zones` passe aussi a `#computeFieldSign` (fuite de la Chaux) et a
      // `#recomputeSteering` (derapage du Verglas) : sans eux, une entite
      // rattrapee dans une flaque se comporterait comme sur sol nu.
      this.#computeFieldSign(zones, tick);
      this.#recomputeSteering(tick, fields, before, this.#count, zones);
      // Sans cet appel, `#slow` porterait encore les valeurs du dernier `step`,
      // appliquees a des entites qui viennent de naitre.
      this.#computeSlow(zones, tick);
      this.#advanceByVelocity(before, this.#count, dt, tick);
      this.#applyDeoverlap(before, this.#count);
      // Charge du boss comprise : rare (une charge annoncee moins de
      // `missedTicks` apres l'apparition du boss), mais l'omettre laisserait un
      // ecart definitif.
      this.#applyCharge(charge, tick);
    }
  }

  /** Vrai si `(x, y)` tombe sur une cellule libre du masque (ou sans masque). */
  #onLand(x: number, y: number): boolean {
    const g = this.#ground;
    if (!g) {
      return true;
    }
    const cx = Math.floor(x / g.cellSize);
    const cy = Math.floor(y / g.cellSize);
    if (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) {
      return false;
    }
    return g.blocked[cy * g.cols + cx] !== 1;
  }

  /**
   * Le gardien pres de sa place y va tout droit, puis la tient. Rend `false`
   * s'il en est encore loin : il suit alors le flowfield comme tout le monde.
   */
  #guardStep(i: number, pas: number): boolean {
    const t = this.targetField[i] ?? 0;
    const ax = this.aimX[t];
    const ay = this.aimY[t];
    if (ax === undefined || ay === undefined) {
      return false;
    }
    const angle = guardAngle(this.entityIdAt(i));
    const dx = ax + Math.cos(angle) * GUARD_RING_RADIUS - (this.x[i] ?? 0);
    const dy = ay + Math.sin(angle) * GUARD_RING_RADIUS - (this.y[i] ?? 0);
    const d = Math.hypot(dx, dy);
    if (d > GUARD_HOMING_RANGE) {
      return false;
    }
    if (d > 0) {
      const k = Math.min(1, pas / d);
      this.#moveOnLand(i, (this.x[i] ?? 0) + dx * k, (this.y[i] ?? 0) + dy * k);
    }
    return true;
  }

  /**
   * Deplace l'entite `i` vers `(nx, ny)`, bornee a la carte ET au decor : un
   * pas qui entrerait dans une cellule bloquee glisse sur l'axe encore libre,
   * ou s'annule. Une entite DEJA dans le decor (naissance tronquee, charge) en
   * sort librement, pour ne pas contrarier `#carveExitsFromWalls`. Meme regle
   * que `moveOnMap` pour les joueurs.
   */
  #moveOnLand(i: number, nx: number, ny: number): void {
    const ox = this.x[i] ?? 0;
    const oy = this.y[i] ?? 0;
    const tx = clamp(nx, 0, MAP_SIZE);
    const ty = clamp(ny, 0, MAP_SIZE);
    if (!this.#onLand(ox, oy) || this.#onLand(tx, ty)) {
      this.x[i] = tx;
      this.y[i] = ty;
    } else if (this.#onLand(tx, oy)) {
      this.x[i] = tx;
    } else if (this.#onLand(ox, ty)) {
      this.y[i] = ty;
    }
  }

  /**
   * Avance `[from, to)` d'un pas le long de la vitesse TENUE (`vx`/`vy`) :
   * toute la direction est deja dans la vitesse (`#recomputeSteering`).
   */
  #advanceByVelocity(from: number, to: number, dt: number, tick: number): void {
    for (let i = from; i < to; i++) {
      // Une entite arretee n'avance pas, quelle que soit sa vitesse tenue.
      if (this.stopped[i]) {
        continue;
      }
      const ex = this.x[i] ?? 0;
      const ey = this.y[i] ?? 0;
      // Le Givre module le PAS, pas la vitesse tenue : `vx`/`vy` ne changent
      // qu'au recalcul, alors qu'entrer dans une zone doit se voir au tick meme.
      // A facteur `1`, la multiplication est exacte. Le bondisseur avance par
      // bonds (`leapFactor`), autre facteur du pas derive du tick et de l'identite.
      const arch = archetypeOf(this.archetype[i] ?? 0);
      if (
        arch.behavior === 'gardien' &&
        this.#guardStep(i, arch.speed * dt * (this.#slow[i] ?? 1))
      ) {
        continue;
      }
      const bond = arch.behavior === 'bond' ? leapFactor(this.entityIdAt(i), tick) : 1;
      // En fuite, le voleur remonte le flowfield a `THIEF_FLEE_SPEED` ; le
      // porteur a sa vitesse propre, qui est deja sa vitesse de fuite.
      const fuite =
        this.fleeing[i] === 1 ? (arch.behavior === 'porteur' ? -1 : -THIEF_FLEE_SPEED) : 1;
      const slow = (this.#slow[i] ?? 1) * bond * fuite;
      this.#moveOnLand(i, ex + (this.vx[i] ?? 0) * dt * slow, ey + (this.vy[i] ?? 0) * dt * slow);
    }
  }

  /**
   * Correction de position BORNEE qui defait les chevauchements entre voisins :
   * deplace directement `x`/`y`, au plus `DEOVERLAP_MAX_PX` par entite et par
   * tick, apres l'avancement par vitesse.
   *
   * ⚠️ **Par priorite, pas par symetrie.** Pour une paire, seule l'entite
   * DERRIERE (`#isBehind`) se corrige, de tout l'ecart (`overlap`, sans
   * `* 0.5`) ; celle de devant ne bouge pas a cause d'elle. Un seul calcul par
   * paire au lieu de deux.
   *
   * ⚠️ **Reutilise la grille de voisins et `#priorityDist` construits par
   * `#recomputeSteering` au meme tick**, toujours appele avant. La grille date
   * d'avant l'avancement, mais l'ecart (une vitesse par tick) reste tres en
   * deca de `SEPARATION_CELL` ; reconstruire doublerait le cout pour rien. La
   * distance ne sert qu'a decider qui cede, jamais a orienter la correction,
   * purement geometrique.
   *
   * ⚠️ **Accumule dans `#correctionX`/`#correctionY` PUIS applique en bloc**,
   * pour que le resultat ne depende pas de l'ordre du tableau (voir ces
   * tampons).
   *
   * S'applique DELIBEREMENT aux entites `stopped` : c'est ce qui les etale en
   * ANNEAU autour du joueur au lieu d'un tas. `#advanceByVelocity`, lui, ne les
   * fait jamais avancer.
   *
   * `from`/`to` restreint les entites qui RECOIVENT une correction ; celles
   * hors plage restent des voisins valides.
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
            // La priorite d'abord, le test le moins cher : il elimine la moitie
            // des paires avant toute racine carree.
            if (!this.#isBehind(distI, idI, this.#priorityDist[j] ?? 0, this.entityIdAt(j))) {
              continue;
            }
            const dx = xi - (this.x[j] ?? 0);
            const dy = yi - (this.y[j] ?? 0);
            const d2 = dx * dx + dy * dy;
            // `d2 === 0` : un recouvrement exact n'a pas de direction, meme
            // convention que `#recomputeSteering`.
            if (d2 > r2 || d2 === 0) {
              continue;
            }
            const d = Math.sqrt(d2);
            const overlap = r - d;
            // Celui de derriere encaisse TOUT l'ecart : celui de devant
            // n'accumule rien pour cette paire.
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
      this.#moveOnLand(i, (this.x[i] ?? 0) + cx, (this.y[i] ?? 0) + cy);
    }
  }

  /**
   * Recalcule `vx`/`vy` des entites en phase ce tick : direction du champ vise,
   * MELANGEE a la repulsion sommee sur les voisins dans `SEPARATION_RADIUS`
   * (plafonnee a 1, puis ponderee par `STEERING_REPULSION_WEIGHT`), le tout
   * normalise puis remis a l'echelle de la vitesse propre de l'archetype.
   *
   * ⚠️ **Devier, pas propulser.** Additionner la repulsion a la vitesse
   * laisserait la densite propulser une entite bien au-dela de sa vitesse
   * propre ; melanger les DIRECTIONS puis remettre a l'echelle une seule fois
   * garantit `Math.hypot(vx, vy) <= archetypeOf(...).speed`.
   *
   * ⚠️ **Cas degenere : ne JAMAIS normaliser un vecteur nul.** Si champ et
   * repulsion s'annulent (monstre symetriquement cerne), diviser produirait
   * `NaN`, qui se propagerait en silence a toute la horde. On retombe alors sur
   * la direction du champ seule.
   *
   * ⚠️ **La phase choisit QUI recalcule, la priorite QUELS voisins comptent.**
   * Une entite en phase voit tous ses voisins, en phase ou non (leur position
   * est un intrant valide, seule leur vitesse ne change pas) : pas de parcours
   * symetrique par paire, qui modifierait des entites hors de leur tick. Parmi
   * ces voisins, seuls ceux dont l'entite est DERRIERE (`#isBehind`) entrent
   * dans la somme : c'est celui de derriere qui devie.
   *
   * `from`/`to` restreignent QUI peut recalculer (`spawnCatchingUp` : les
   * seules entites qu'il vient de faire naitre) ; la grille est toujours
   * construite sur les `#count` entites.
   *
   * ⚠️ **Verglas : intercepte AVANT tout le reste.** Une entite en zone de
   * Verglas GARDE sa vitesse precedente, amortie (`#inertiaDampingAt`) : elle
   * ne corrige plus sa trajectoire, elle derape. Derivable des deux cotes sans
   * octet : la zone suit `ZoneField.slowsAt`, et `vx`/`vy` sont deja connus.
   *
   * ⚠️ **Chaux : intercepte APRES la lecture du champ.** Seul le vecteur de
   * champ lu ce tick est inverse (`#fieldSign`) ; la separation entre voisins
   * joue normalement. La Chaux brouille la poursuite, pas la cohesion.
   */
  #recomputeSteering(
    tick: number,
    fields: readonly FlowField[],
    from = 0,
    to: number = this.#count,
    zones?: ZoneField,
  ): void {
    const n = this.#count;
    if (n === 0) {
      return;
    }
    this.#buildNeighbourGrid(n);
    // Une lecture de flowfield par entite, pas par paire (voir `#priorityDist`).
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

      // ⚠️ Verglas : au lieu de la direction fraiche du champ, l'entite GARDE
      // sa vitesse precedente, amortie de `damping` (voir la doc de la methode).
      const damping = this.#inertiaDampingAt(zones, tick, xi, yi);
      if (damping < 1) {
        this.vx[i] = (this.vx[i] ?? 0) * damping;
        this.vy[i] = (this.vy[i] ?? 0) * damping;
        continue;
      }

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
            // Seuls les voisins dont je suis DERRIERE comptent.
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
        // Meme lecture interpolee que `spawn`.
        field.sampleDirection(xi, yi, this.#dirSample);
        fx = this.#dirSample[0] ?? 0;
        fy = this.#dirSample[1] ?? 0;
      }

      // Chaux : inverse le vecteur de champ, et LUI SEUL, avant le melange ;
      // jamais une ecriture dans `targetField`. La separation reste normale.
      const sign = this.#fieldSign[i] ?? 1;
      fx *= sign;
      fy *= sign;

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
   * Distance de l'entite `i` au champ qu'elle vise, en cellules de flowfield :
   * la mesure de priorite de `#isBehind`.
   *
   * ⚠️ **Champ absent (tests seulement) ou cellule inatteignable (`dist` a
   * `-1`, voir `UNREACHED`) : « infiniment derriere ».** Une entite sans mesure
   * fiable ne doit jamais sembler plus pres du joueur qu'un voisin bien repere,
   * et echapper ainsi a son tour de ceder.
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
   * Vrai si l'entite (`distSelf`, `idSelf`) doit CEDER face a (`distOther`,
   * `idOther`) : le plus grand `dist` est derriere. **A egalite, le plus petit
   * identifiant gagne** — meme convention que `nearestTarget` et
   * `Projectiles.collide` : le resultat ne doit jamais dependre de l'ordre du
   * tableau, que deux clients compactent differemment.
   */
  #isBehind(distSelf: number, idSelf: number, distOther: number, idOther: number): boolean {
    return distSelf > distOther || (distSelf === distOther && idSelf > idOther);
  }

  /**
   * Remplit `#priorityDist` pour les `n` premieres entites, une lecture de
   * flowfield par entite. Appele une fois par tick par `#recomputeSteering` ;
   * `#applyDeoverlap` reutilise le cache.
   */
  #buildPriorityCache(n: number, fields: readonly FlowField[]): void {
    for (let i = 0; i < n; i++) {
      this.#priorityDist[i] = this.#fieldDistAt(i, fields);
    }
  }

  /**
   * Construit la grille de voisins des `n` premieres entites par tri par
   * comptage (deux passes lineaires, zero allocation).
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
   * Dans l'ordre correct d'un tick (rattrapage, rafraichissement du flowfield,
   * `step`), un champ vu ici porte encore la revision relevee au dernier
   * `step`. Sinon, le rattrapage consommerait un champ plus frais que celui du
   * serveur, et la derive exploserait (voir le test de replication). Inactif
   * tant que la horde n'a jamais avance.
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
