import { archetypeOf, leapFactor, SHOOTER_RANGE, THIEF_FLEE_SPEED } from './archetypes';
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
 * Cette mort laisse-t-elle un orbe ? Etape 5a, tache 17 : *« moins d'xp qui
 * tombe »*.
 *
 * ⚠️ **Vit ICI, colle a `entityIdOf`, parce que c'est la MEME idee** :
 * l'identite est arithmetique, donc les deux cotes du fil en tirent la meme
 * reponse sans echanger un octet. Le serveur arbitre le ramassage, mais il
 * n'annonce jamais qu'un orbe existe — le client le DERIVE du seul message
 * `DEATHS` (voir `DerivedOrbs` dans `front/src/net/client.ts`). Un tirage
 * aleatoire ferait apparaitre chez l'un ce que l'autre n'a pas, et `shared/`
 * interdit `Math.random` pour cette raison exacte.
 *
 * ⚠️ **Le reste modulo suit l'INDEX DANS LA VAGUE**, puisque `MAX_PER_WAVE`
 * est un multiple de `ORB_DROP_ONE_IN` : une entite sur quatre exactement,
 * sans variance, et non « une sur quatre en moyenne ». C'est ce qui laisse
 * l'experience par mort strictement inchangee (voir `XP_PER_ORB`) au lieu de
 * la laisser flotter d'une run a l'autre.
 *
 * ⚠️ **Le piege du decor, dit plutot que cache** : un test qui pose son
 * monstre avec `entityIdOf(waveId, 0)` tombe TOUJOURS sur un orbe, quel que
 * soit ce reglage. C'est la « fixture qui masque » du depot, huitieme
 * occurrence — les tests du taux de chute balaient donc des index
 * CONSECUTIFS, jamais un index unique.
 */
export function dropsOrb(entityId: number): boolean {
  return entityId % ORB_DROP_ONE_IN === 0;
}

/**
 * Cette mort laisse-t-elle une PIECE ? Etape 6a, tache 14 : *« les monstres ne
 * droppent pas d'or j'ai l'impression »*.
 *
 * ⚠️ **Meme modele que `dropsOrb`, au mot pres, et c'est le point** : la
 * decision se lit dans l'IDENTITE, donc les deux cotes du fil en tirent la meme
 * reponse sans echanger un octet. Le serveur arbitre le ramassage et crediter
 * l'or, mais il n'annonce jamais qu'une piece existe — le client la derive du
 * seul message `DEATHS`, comme il derive deja les orbes.
 *
 * ⚠️ **DISJOINT de `dropsOrb`** : voir `COIN_DROP_RESIDUE`. C'est ce qui permet
 * de lire la nature d'un ramassage dans l'identite que `PICKUPS` transporte
 * deja, au lieu d'ajouter un champ au message.
 *
 * ⚠️ **Le meme piege de decor que `dropsOrb`, en pire** : un test qui pose son
 * monstre a `entityIdOf(waveId, 0)` ne tombe JAMAIS sur une piece, quel que
 * soit ce reglage — la ou il tombait toujours sur une orbe. Les tests du taux
 * balaient donc des index CONSECUTIFS, jamais un index unique.
 */
export function dropsCoin(entityId: number): boolean {
  return entityId % COIN_DROP_ONE_IN === COIN_DROP_RESIDUE;
}

/**
 * Cette mort laisse-t-elle QUELQUE CHOSE au sol ?
 *
 * ⚠️ **LA garde du goulot, et il n'y en a qu'une.** `OrbField.spawn` (serveur)
 * et `DerivedOrbs.spawn` (client) posent l'objet sans savoir sa nature : elle
 * se relit de l'identite au moment ou elle sert — a l'affichage pour le dessin,
 * au ramassage pour l'experience ou l'or. Deux reserves separees auraient
 * demande deux capacites, deux compteurs de troncature et deux calques ; une
 * seule, plus une lecture arithmetique, n'en demande aucun.
 */
export function leavesDrop(entityId: number): boolean {
  return dropsOrb(entityId) || dropsCoin(entityId);
}

/**
 * Instantane de l'etat de la horde, pour `HordeHistory` (§3.2).
 *
 * **Les QUINZE memes tableaux que `Horde`, sans exception** (`fleeing`, `stopped`
 * depuis la tache 17.2, `vx`/`vy` depuis la tache 19, `hp` puis
 * `mark`/`markBy`/`markUntil` depuis l'etape 5a), plus le compte.
 * `HordeHistory` en alloue un par creneau de son anneau, une seule fois, et
 * `saveState` / `restoreState` s'en servent comme tampons a copier par
 * `.set()` — jamais de nouveau tableau a chaque tick.
 *
 * ⚠️ **La liste est la MEME que celle de `#removeAt`, et c'est delibere.**
 * `hp` et la marque ne sont lus que par le serveur, qui ne rejoue rien : les
 * laisser hors de l'instantane aurait « marche » aujourd'hui. Ce sont alors
 * DEUX listes a tenir a jour au lieu d'une, et le dossier de ce depot dit ce
 * que ca coute — le test « emmene toutes les proprietes » de l'etape 3 en
 * verifiait deux sur sept. Le cout de l'inclure est de `ROLLBACK_DEPTH_TICKS`
 * (8) tampons de `Float32Array(capacity)`, soit ~128 ko cote client.
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
  fleeing: Uint8Array;
  hp: Float32Array;
  mark: Uint8Array;
  markBy: Uint8Array;
  markUntil: Float64Array;
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
  readonly stopped: Uint8Array;
  /**
   * Les identites dans l'aura d'un chaman ce tick-ci (`Room`, cote SERVEUR
   * seul) : `armureA` les protege. Des IDENTITES, pas des creneaux — la
   * compaction de chaque passe de degats deplace les creneaux, pas les noms.
   * Le client ne la remplit jamais : les PV ennemis ne voyagent pas.
   */
  readonly aura = new Set<number>();
  /**
   * Reserve de points de vie restante, posee par `spawn` depuis
   * `archetypeOf(...).hp` — etape 5a, §3.2 de la spec.
   *
   * ⚠️ **Seul le serveur la soustrait.** Le client la porte quand meme, parce
   * que c'est le MEME code qui tourne des deux cotes et que la valeur de
   * depart se derive de l'archetype, qui voyage deja dans l'ordre de vague :
   * la remplir ne coute pas un octet sur le fil. Rien cote client ne la lit —
   * il apprend qui meurt par `DEATHS`, exactement comme depuis l'etape 3
   * (§2 de la spec).
   *
   * `Float32Array` et pas un entier : les degats sont fractionnaires des que
   * le passif « puissance » ou « acier » entre en jeu
   * (`weapon.damage * (1 + loadout.bonus('damage'))`).
   */
  readonly hp: Float32Array;
  /**
   * Element porte par l'entite — `ELEMENT.NEUTRE` (0) quand elle n'en porte
   * aucun. Etape 5a, §4.3 de la spec.
   *
   * ⚠️ **Au plus UN element a la fois, et c'est delibere.** Un ennemi marque
   * Braise que touche du Givre ne devient pas « Braise + Givre » : il REAGIT,
   * et la marque se consomme (taches 6 et 7 — rien ne la consomme encore
   * ici). Stocker un couple demanderait une seconde donnee par entite, ce que
   * cette etape refuse explicitement (§11 : le gel sur accumulation est
   * reporte pour exactement cette raison).
   *
   * ⚠️ **Ne pas le lire directement pour savoir si l'entite est marquee** :
   * la marque expire, et son expiration est DERIVEE (voir `markUntil`).
   * `markAt(slot, tick)` est le seul lecteur correct.
   */
  readonly mark: Uint8Array;
  /**
   * Index du joueur qui a pose la marque courante (`markBy[slot]`), sans
   * signification quand l'entite n'est pas marquee.
   *
   * ⚠️ **C'est CE tableau qui rend la Synergie possible** (§7 de la spec, et
   * le §6.5 de l'orientation qui l'appelle *« le coeur du projet »*). A la
   * reaction, le serveur compare ce joueur a celui du projectile ou de la
   * zone qui la declenche : differents, l'equipe gagne une charge ; le meme,
   * la reaction a lieu mais ne rapporte rien. Sans lui, une reaction entre
   * deux joueurs et une reaction en solo sont litteralement indiscernables,
   * et il n'y a plus rien a compter.
   */
  readonly markBy: Uint8Array;
  /**
   * Tick ABSOLU auquel la marque cesse de valoir — `tick + MARK_DURATION_TICKS`
   * au moment de la pose. `0` quand l'entite n'a jamais ete marquee, ce qui la
   * rend expiree pour tout tick >= 0 sans cas particulier.
   *
   * ⚠️ **L'expiration est DERIVEE, jamais annoncee** — meme modele que
   * `ZONE_LIFETIME_TICKS` pour les zones au sol (§5.1) : les deux cotes
   * comparent ce nombre au tick courant et obtiennent la meme reponse, sans un
   * octet sur le fil et sans qu'aucune horloge murale n'entre dans le calcul.
   *
   * `Float64Array` et pas `Uint32Array` : c'est une SOMME d'un tick absolu et
   * d'une duree, donc elle doit rester exacte au-dela de ce que le tick lui-
   * meme atteint, sans reboucler a zero — un `markUntil` qui deborderait
   * rendrait une entite marquee eternellement.
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

  /**
   * Tampon de sortie pour `FlowField.sampleDirection` (tache 25) — deux
   * flottants, jamais reconstruits, reutilises a chaque lecture de direction
   * (`spawn` comme `#recomputeSteering`). Ecrit puis lu immediatement, jamais
   * conserve entre deux appels : la lecture suivante ecrase la precedente
   * avant que quoi que ce soit d'autre ne s'execute (JS est mono-thread),
   * donc le partager entre les deux appelants ne cree aucune interference.
   */
  readonly #dirSample: Float32Array = new Float32Array(2);

  /**
   * Tampon de sortie pour `chargePointAt` (etape 6a, tache 5 bis) — deux
   * flottants, jamais reconstruits, meme discipline que `#dirSample` : ecrit
   * puis lu immediatement, jamais conserve d'un pas a l'autre.
   *
   * ⚠️ **Un tampon, PAS un etat.** La charge elle-meme n'est pas un champ de
   * cette classe : elle arrive en parametre de `step`, comme les zones et pour
   * la meme raison — c'est l'appelant (le salon, ou le client) qui sait ce que
   * le serveur a annonce, et la horde n'a rien a en retenir d'un tick a
   * l'autre. C'est aussi ce qui la garde hors de `HordeState` : rien a
   * sauvegarder, rien a restaurer, la position se REDERIVE a chaque pas
   * rejoue.
   */
  readonly #chargeSample: Float32Array = new Float32Array(2);

  /**
   * Facteur de vitesse par entite pour le pas courant — etape 5a, tache 6.
   * `1` partout quand aucune zone ne ralentit personne, ce qui est le cas de
   * la quasi-totalite des ticks.
   *
   * ⚠️ **Recalcule a CHAQUE avancement, jamais conserve** (voir
   * `#computeSlow`) : c'est un intermediaire du pas, pas un etat de l'entite.
   * Il n'est donc NI dans `HordeState`, NI dans `#removeAt` — il n'y a rien a
   * compacter, puisque rien ne survit au pas qui l'a produit. C'est aussi ce
   * qui le rend inoffensif pour le rejeu : `HordeHistory` restaure des
   * positions, et le facteur du tick rejoue se recalcule a partir des zones
   * et du tick, jamais d'une valeur sauvegardee.
   *
   * `Float64Array` et pas `Float32Array` : la valeur lue vient de
   * `Element.slowFactor`, un double. La stocker en simple precision
   * l'arrondirait — sans consequence tant que les deux cotes arrondissent
   * pareil, mais le double garde le facteur EXACTEMENT tel que la table le
   * donne, et supprime la question.
   */
  readonly #slow: Float64Array;
  /** Le masque du decor au pas courant (`fields[0]`), pour `#moveOnLand`. */
  #ground: FlowField | null = null;

  /**
   * Signe du champ par entite pour le pas courant — etape 5c, tache 1. `+1`
   * partout quand aucune zone n'inverse personne, ce qui est le cas de la
   * quasi-totalite des ticks — meme motif que `#slow` juste au-dessus.
   *
   * ⚠️ **Recalcule a CHAQUE avancement, jamais conserve** (voir
   * `#computeFieldSign`) : un intermediaire du pas, pas un etat de l'entite.
   * NI dans `HordeState`, NI dans `#removeAt`, meme raisonnement que `#slow`
   * — rien ne survit au pas qui l'a produit, donc rien a compacter ni a
   * rejouer depuis une valeur sauvegardee.
   *
   * ⚠️ **Toujours `+1` ou `-1`, jamais une valeur intermediaire.**
   * Contrairement a `#slow` (un facteur continu lu dans `Element.slowFactor`),
   * cette grandeur est un DRAPEAU de direction — `Int8Array` suffit, aucun
   * arrondi a eviter.
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
      // Remis a zero explicitement (constat I3) : aujourd'hui inoffensif, les
      // creneaux n'etant jamais reutilises tant que rien ne meurt. A l'etape
      // 3, un compactage apres une mort reutilisera ce creneau, et sans cette
      // ligne une entite neuve heriterait de la cible du mort qu'elle remplace.
      this.targetField[slot] = 0;
      // Meme raisonnement (tache 17.2) : une entite neuve qui heriterait de
      // `stopped = 1` d'un mort qui occupait ce creneau traverserait le
      // joueur sans jamais l'attaquer, jusqu'au prochain `retarget`.
      this.stopped[slot] = 0;
      this.fleeing[slot] = 0;
      // Etape 5a : la reserve de PV se derive de l'archetype, donc les deux
      // cotes posent la meme valeur de depart sans un octet de plus. Ecrite
      // sans condition, pour la meme raison que `targetField` et `stopped`
      // ci-dessus : un creneau recycle apres une mort garderait sinon les PV
      // entames du monstre qu'il remplace.
      this.hp[slot] = hp;
      // Etape 5a : une entite neuve ne porte aucune marque. Meme raisonnement
      // que `targetField`, `stopped` et `hp` ci-dessus, et c'est le cas le
      // plus vicieux des quatre : sans ces trois lignes, un creneau recycle
      // apres une mort ferait naitre un monstre deja marque Braise PAR un
      // joueur qu'il n'a jamais croise, donc capable de declencher une
      // reaction — et une charge de Synergie — au premier projectile Givre.
      this.mark[slot] = ELEMENT.NEUTRE;
      this.markBy[slot] = 0;
      this.markUntil[slot] = 0;
      // Tache 20 : direction du champ (`targetField` vaut 0 ci-dessus, donc
      // c'est bien `field` — le champ 0 — qui doit servir ici), sans
      // repulsion (voir la doc de la methode). Zero si aucun champ n'est
      // fourni : meme comportement qu'avant cette tache.
      if (field) {
        // Tache 25 : direction interpolee, pas la lecture par cellule — les
        // deux DOIVENT lire de la meme facon partout (`FlowField.sampleDirection`),
        // sans quoi serveur et client apparaitraient avec des vitesses
        // initiales differentes.
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
   * Copie l'etat courant dans `out`, un instantane pre-alloue par l'appelant.
   *
   * Sert `HordeHistory.record`, appele a chaque tick : recevoir le tampon en
   * parametre plutot que d'en allouer un ici est ce qui garde cette methode
   * hors du ramasse-miettes.
   *
   * ⚠️ Les QUINZE tableaux, plus le compte (`fleeing` des voleurs, `stopped` depuis la tache 17.2,
   * `vx`/`vy` depuis la tache 19, `hp` puis `mark`/`markBy`/`markUntil` depuis
   * l'etape 5a). Meme piege que
   * `#removeAt` : en oublier un laisse la suite verte jusqu'a ce qu'un rejeu
   * s'appuie dessus — voir l'avertissement sur `HordeState` pour `vx`/`vy`
   * specifiquement.
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
  }

  /**
   * Pose une marque elementaire sur le creneau `slot` — etape 5a, §4.3.
   *
   * ⚠️ **S'appelle `applyMark` et pas `mark`, contrairement au plan.** Le plan
   * de l'etape 5a demande a la fois un TABLEAU `Horde.mark` et une METHODE
   * `mark(slot, element, playerId, tick)` : les deux ne peuvent pas coexister
   * sur la meme classe. Les noms de tableaux l'emportent — ils sont la
   * convention de toute cette classe et la liste unique du test
   * « emmene toutes les proprietes » les enumere — donc c'est la methode qui
   * est renommee.
   *
   * ⚠️ **Ecrase la marque precedente sans rien arbitrer.** Un ennemi porte au
   * plus UN element (§4.3) : c'est l'appelant (tache 6, `back/src/combat.ts`)
   * qui decide, AVANT d'appeler, s'il rafraichit une marque de meme element ou
   * s'il declenche une reaction pour un element different. Cette methode ne
   * fait que poser la donnee — rien ici ne consomme la marque.
   *
   * ⚠️ **Appeler avec le tick ABSOLU de la simulation**, jamais un compteur
   * local : `markUntil` est compare au meme tick absolu par `markAt`, des deux
   * cotes du fil, exactement comme le `bornTick` d'un orbe.
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
   * ⚠️ **L'expiration est DERIVEE ICI, elle n'est jamais annoncee ni
   * balayee.** Aucune passe ne parcourt la horde pour effacer les marques
   * perimees, et aucun message ne dit qu'une marque est tombee : les deux
   * cotes comparent `markUntil` au tick courant et obtiennent la meme reponse.
   * Meme partage que `ZONE_LIFETIME_TICKS` (§5.1 de l'etape 5a).
   *
   * La borne est STRICTE des deux cotes, et c'est ce qui rend la duree
   * exacte : une marque posee au tick `T` vaut encore au tick
   * `T + MARK_DURATION_TICKS - 1` et plus au tick `T + MARK_DURATION_TICKS`,
   * soit exactement `MARK_DURATION_TICKS` ticks de validite.
   */
  markAt(slot: number, tick: number): number {
    return tick < (this.markUntil[slot] ?? 0)
      ? (this.mark[slot] ?? ELEMENT.NEUTRE)
      : ELEMENT.NEUTRE;
  }

  /**
   * Deplace la derniere entite dans le creneau libere.
   *
   * ⚠️ **LES QUINZE TABLEAUX, sans exception.** En oublier un laisse
   * l'entite deplacee avec une propriete du mort qu'elle remplace — a l'etape
   * 5a, ses PV entames, ou **la marque elementaire de celui qui vient de
   * mourir**, avec le joueur qui l'avait posee : un monstre indemne devient
   * alors capable de declencher une reaction, et une charge de Synergie, pour
   * un element que personne ne lui a jamais applique. Le defaut ne se voit ni
   * au type ni au lint : il se voit au
   * test « emmene toutes les proprietes » de `horde.test.ts`, qui enumere
   * depuis une liste unique ET verifie que cette liste couvre bien tous les
   * tableaux de l'instance. Ajouter un tableau a `Horde` sans l'ajouter ici le
   * fait rougir.
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
    this.aimX = [...playerX];
    this.aimY = [...playerY];
    const contactR2 = CONTACT_RADIUS * CONTACT_RADIUS;
    const shooterR2 = SHOOTER_RANGE * SHOOTER_RANGE;
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
   * ⚠️ **`charge` REMPLACE le deplacement du boss, il ne s'y ajoute pas** —
   * voir `#applyCharge`, qui s'execute en DERNIER pour cette raison exacte.
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
   * ne s'y ajoute pas** (etape 6a, tache 5 bis).
   *
   * ⚠️ **EN DERNIER DU PAS, et c'est TOUTE la mecanique du remplacement.** Le
   * boss est une entite de la horde comme les autres : `#advanceByVelocity` l'a
   * deja avance le long de sa vitesse tenue, et `#applyDeoverlap` l'a deja
   * pousse hors de ses voisins. Ecrire sa position ICI, apres les deux, efface
   * leur effet sur lui — un boss qui subirait les deux avancerait DEUX FOIS, et
   * la separation le pousserait pendant qu'il charge. Aucune des deux passes
   * n'a besoin d'apprendre a l'eviter : c'est la derniere ecriture qui gagne, et
   * c'est celle-ci.
   *
   * ⚠️ **DANS le garde `dt > 0` de `step`, jamais dehors.** Pendant le gel de
   * niveau, le serveur ne fait pas avancer sa horde du tout (`Room.step` revient
   * avant) et le client appelle `step` avec un `dt` nul : deriver la position de
   * la charge hors de ce garde ferait avancer le boss chez le client pendant que
   * le serveur le laisse sur place — exactement le genre de divergence
   * silencieuse que le scenario 9 de `shared/horde.replication.test.ts` existe
   * pour attraper. Les deux cotes sautent donc les memes ticks, et la charge
   * reprend a la position du tick courant a la reprise.
   *
   * ⚠️ **`stopped = 1` est pose pour le CLIP, pas pour le deplacement.**
   * L'ecriture de position ci-dessus suffit deja a annuler l'avancement ; ce
   * booleen sert a `selectClip` (`front/src/render/horde-renderer.ts`), qui
   * bascule sur l'animation d'attaque quand une entite est marquee arretee —
   * **le boss qui charge est une entite qui joue son clip d'attaque**, et ce
   * sont ses six images qui montrent la rotation. Rien ne fait tourner le sprite
   * en code. Comme tout le reste ici, il se REDERIVE a chaque pas : `retarget`
   * le remet a la portee de contact dix fois par seconde, et le pas suivant le
   * repose — des deux cotes, aux memes ticks.
   *
   * Cout : un `slotOf` (balayage lineaire) par tick, et seulement pendant les
   * ~48 ticks d'une charge. Meme ordre que le `slotOf` que `bossBarLayout` fait
   * deja par IMAGE cote client.
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
    // Meme bornage que `#advanceByVelocity` : le couloir peut viser hors carte,
    // et un boss hors carte serait invisible et increvable.
    //
    // ⚠️ **Et il s'arrete au rivage** : le couloir est une droite, et la
    // suivre le jetait a l'eau — un boss au large, hors de l'ile, que personne
    // ne peut aller chercher. Il garde sa place des que le point suivant est
    // bloque (`#onLand`), et le couloir continue de blesser sans lui.
    //
    // ⚠️ **Le segment, pas seulement son bout** : une charge avance de plus
    // d'une cellule par tick, et sauterait un mur d'une cellule. On le
    // parcourt par demi-cellules et on s'arrete au dernier point libre.
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
   * Remplit `#slow` : pour chaque entite, le plus petit `slowFactor` des zones
   * qui la couvrent au tick `tick` — `1` si aucune. Etape 5a, tache 6.
   *
   * ⚠️ **L'effet porte sur la ZONE, jamais sur la marque, et c'est ce qui le
   * rend replicable.** La marque ne voyage pas : un client ne pourrait pas
   * savoir qui est ralenti, et le premier effet touchant le DEPLACEMENT ferait
   * tomber le contrat de replication a 0,000 px que le projet tient depuis
   * l'etape 2. Les zones, elles, sont ANNONCEES et leur mort est DERIVEE
   * (§5.3) : les deux cotes connaissent les memes disques, aux memes ticks, et
   * comparent des positions bit-identiques — le predicat `dx² + dy² < r²` rend
   * donc le meme booleen des deux cotes, pour zero octet de plus.
   *
   * ⚠️ **Le MINIMUM, jamais le produit.** Deux zones de Givre qui se
   * recouvrent doivent rendre le meme facteur quel que soit l'ordre du
   * tableau — et l'ordre, lui, n'est PAS garanti identique des deux cotes :
   * `#removeAt` compacte en echangeant avec le dernier, et le client expire
   * ses zones plus tard que le serveur (voir `ZoneField.aliveAt`). Le minimum
   * est commutatif et associatif exactement ; un produit de flottants ne l'est
   * pas.
   *
   * ⚠️ **`slowsAt`, pas `aliveAt`** — voir `ZoneField.slowsAt` : une zone
   * posee au tick `T` ne ralentit qu'a partir de `T + 1`, parce que le serveur
   * fait avancer la horde AVANT de poser ses zones.
   *
   * Cout : O(zones x entites), le prix annonce par le §5.2 de la spec. Le
   * remplissage a `1` a lieu meme sans zones — c'est ce qui rend un
   * `spawnCatchingUp` sans zones exactement equivalent a l'ancien code plutot
   * que de lui laisser le facteur du pas precedent.
   *
   * ⚠️ **Le facteur PAR ZONE n'est plus `Element.slowFactor` seul depuis la
   * tache 7 de l'etape 5b.** `zoneSlowFactor` (`shared/reactions.ts`) le
   * combine deja avec ce que sa reaction impose (0, gel total, pour la
   * Supraconduction) — necessaire parce que le nibble d'element d'une zone de
   * reaction porte celui du DECLENCHEUR, qui varie selon l'ordre d'arrivee.
   * Cette fonction ne fait toujours que prendre le MINIMUM entre zones, pour
   * la raison arithmetique ci-dessus ; c'est `zoneSlowFactor` qui derive
   * chaque facteur avant qu'elle ne les compare.
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
   * Chaux, etape 5c tache 1) la couvre au tick `tick`, `+1` sinon.
   *
   * ⚠️ **Meme MINIMUM, meme raison arithmetique que `#computeSlow` juste
   * au-dessus, et pour la meme cause : cette grandeur VOYAGE** (elle inverse
   * `fx`/`fy` dans `#recomputeSteering`, qui determinent `vx`/`vy` puis
   * `x`/`y`), et l'ordre d'iteration des zones n'est pas garanti identique
   * des deux cotes du fil (`#removeAt` compacte en echangeant avec la
   * derniere, et le client garde ses zones mortes plus longtemps). Le
   * minimum sur `{+1, -1}` est commutatif et associatif exactement : `-1`
   * gagne des qu'UNE zone l'impose, quel que soit l'ordre de balayage.
   *
   * ⚠️ **Ne PAS confondre avec le gel de `#computeSlow` — et ne pas y
   * meler leurs raisons dans un commentaire futur.** Les deux se lisent
   * INDEPENDAMMENT : une entite gelee (`#slow` a 0) ET fuyante (`#fieldSign`
   * a -1) reste immobile, parce que `#advanceByVelocity` multiplie `vx`/`vy`
   * par `#slow` APRES que `#recomputeSteering` a deja fige leur DIRECTION —
   * inverser une direction dont la norme finale sera nulle ne change rien.
   * Le gel gagne donc SUR la fuite PAR CONSTRUCTION (point de revue n°4 du
   * plan de l'etape 5c), jamais par une regle de priorite ecrite ici.
   *
   * ⚠️ **PRIVE, recalcule chaque tick, jamais dans `HordeState` ni
   * `#removeAt`** — meme raisonnement que `#slow` : rien ne survit au pas
   * qui l'a produit, donc rien a synchroniser aux quatre sites qui tiennent
   * les quatorze tableaux par entite.
   *
   * ⚠️ **Appelee AVANT `#recomputeSteering`, contrairement a `#computeSlow`
   * (qui la suit) — voir l'ordre dans `step`/`spawnCatchingUp`.**
   * `#recomputeSteering` lit `fx`/`fy` et doit deja connaitre le signe au
   * moment ou elle les calcule ; `#computeSlow`, lui, n'est consulte que par
   * `#advanceByVelocity`, plus tard dans le meme pas.
   *
   * ⚠️ **`slowsAt`, pas `aliveAt` — meme raison que `#computeSlow` : le
   * deplacement du tick courant est pilote par les zones deja posees, le
   * serveur faisant avancer la horde AVANT de poser celles du tick.
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
   * Le facteur de conservation de vitesse au point `(x, y)` au tick `tick` :
   * le plus PETIT `zoneInertiaDamping` parmi les zones qui RALENTISSENT ce
   * point (voir `ZoneField.slowsAt`), et `1` s'il n'y en a aucune — Verglas,
   * tache 8 de l'etape 5b.
   *
   * ⚠️ **Appele PAR ENTITE, depuis `#recomputeSteering`, pas une fois par
   * tick pour toute la horde comme `#computeSlow`.** Seules les entites dont
   * c'est le tour de recalcul ce tick-ci ont besoin de la reponse ; balayer
   * les zones pour les `#count - (#count / K)` autres serait du travail
   * perdu, puisque leur vitesse ne change de toute facon pas ce tick-la.
   *
   * ⚠️ **`slowsAt`, pas `aliveAt` — meme raison que `#computeSlow`.** Cette
   * grandeur pilote `vx`/`vy`, donc le DEPLACEMENT : une zone posee au tick
   * `T` ne doit l'affecter qu'a partir de `T + 1`, le serveur faisant avancer
   * la horde avant de poser ses zones.
   *
   * ⚠️ **Le MINIMUM entre zones, jamais un produit — meme raison
   * arithmetique que `#computeSlow`.** Cette grandeur voyage (elle determine
   * `vx`/`vy`, qui determinent `x`/`y` au pas suivant), et l'ordre
   * d'iteration des zones n'est pas garanti identique des deux cotes.
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
    zones?: ZoneField,
    charge?: BossCharge | null,
  ): void {
    if (missedTicks > 0) {
      this.#assertFieldsNotRefreshed(fields);
    }

    const before = this.#count;
    this.#ground = fields[0] ?? null;
    // `fields[0]` : n'importe lequel des quatre porte le meme masque
    // d'obstacles (voir la doc de `spawn`) ; le rattrapage cliente doit eviter
    // les murs exactement comme le fait `Room.step` cote serveur. C'est aussi
    // ce meme appel qui pose desormais la vitesse initiale de ces entites
    // (voir la doc de `spawn`) : identique a celle que le serveur leur a
    // posee, puisque c'est la MEME fonction, appelee avec le MEME champ gele.
    this.spawn(order, fields[0]);
    for (let step = 0; step < missedTicks; step++) {
      const tick = order.spawnTick + step;
      // ⚠️ **`zones` passe ICI aussi (tache 8 de l'etape 5b), pas seulement
      // a `#computeSlow` en dessous.** Le derapage du Verglas est pose par
      // `#recomputeSteering` lui-meme desormais — l'omettre ferait rattraper
      // une entite nee dans une flaque de Verglas comme si le sol tenait,
      // exactement le defaut que ce trio existe pour eviter.
      //
      // #computeFieldSign AVANT #recomputeSteering, meme ordre que `step`
      // (tache 1 de l'etape 5c) : sans cet appel, une entite rattrapee dans
      // une flaque de Chaux ne fuirait pas, exactement le meme defaut que le
      // paragraphe ci-dessus decrit pour le Verglas.
      this.#computeFieldSign(zones, tick);
      this.#recomputeSteering(tick, fields, before, this.#count, zones);
      // Meme trio que `step`, dans le meme ordre : rattraper un pas manque
      // doit reproduire EXACTEMENT ce que le serveur a fait ce tick-la, et
      // depuis la tache 6 ca inclut le ralentissement. Sans cet appel,
      // `#slow` porterait encore les valeurs du DERNIER `step` — un etat
      // rémanent appliqué a des entites qui viennent de naitre.
      this.#computeSlow(zones, tick);
      this.#advanceByVelocity(before, this.#count, dt, tick);
      this.#applyDeoverlap(before, this.#count);
      // Meme quatuor que `step`, dans le meme ordre : un pas rattrape doit
      // reproduire EXACTEMENT ce que le serveur a fait ce tick-la, charge du
      // boss comprise. Le cas est rare — il faudrait qu'une charge soit
      // annoncee moins de `missedTicks` apres l'apparition de la vague qui
      // porte le boss — mais l'omettre laisserait le client avancer le boss par
      // sa vitesse la ou le serveur le derivait le long du couloir, et
      // l'ecart serait definitif.
      this.#applyCharge(charge, tick);
    }
  }

  /**
   * Avance le creneau `[from, to)` d'un pas le long de sa vitesse TENUE
   * (`vx`/`vy`) — le chemin normal de `step`, tache 19. Ne touche jamais aux
   * champs : toute la direction est deja capturee dans la vitesse par
   * `#recomputeSteering`.
   */
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
   * Deplace l'entite `i` vers `(nx, ny)`, bornee a la carte ET au decor : un
   * pas qui entrerait dans une cellule bloquee (eau, falaise, arbre) glisse sur
   * l'axe encore libre, ou s'annule. Une entite DEJA dans le decor (une
   * naissance tronquee, une charge) en sort librement — c'est le role de
   * `#carveExitsFromWalls`, qui ne doit pas etre contrarie ici.
   *
   * ⚠️ **Avant, seule la carte bornait la horde** : la separation poussait des
   * monstres a l'eau, et le boss y partait en charge. Meme regle que
   * `moveOnMap` pour les joueurs, appelee des deux cotes avec le meme masque.
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

  #advanceByVelocity(from: number, to: number, dt: number, tick: number): void {
    for (let i = from; i < to; i++) {
      // Tache 17.2 : une entite a portee de contact s'arrete plutot que de
      // traverser le joueur, quelle que soit la vitesse qu'elle tient par
      // ailleurs.
      if (this.stopped[i]) {
        continue;
      }
      const ex = this.x[i] ?? 0;
      const ey = this.y[i] ?? 0;
      // Tache 6 (etape 5a) : le Givre ralentit. Le facteur module le PAS, pas
      // la vitesse tenue — `vx`/`vy` restent la trajectoire voulue, recalculee
      // une fois tous les `STEERING_RECOMPUTE_TICKS`, alors qu'entrer dans une
      // zone ou en sortir doit se voir au tick meme. A facteur `1` (le cas
      // general, et le seul avant cette tache) la multiplication est exacte :
      // le chemin sans zones reste bit-identique a celui d'avant.
      // Le bondisseur avance par bonds (`leapFactor`) : un facteur du PAS, comme
      // le Givre, derive du tick et de l'identite — identique partout.
      const bond =
        archetypeOf(this.archetype[i] ?? 0).behavior === 'bond'
          ? leapFactor(this.entityIdAt(i), tick)
          : 1;
      // Le voleur en fuite remonte sa trajectoire : il s'eloigne du joueur
      // que le flowfield lui designe.
      const fuite = this.fleeing[i] === 1 ? -THIEF_FLEE_SPEED : 1;
      const slow = (this.#slow[i] ?? 1) * bond * fuite;
      this.#moveOnLand(i, ex + (this.vx[i] ?? 0) * dt * slow, ey + (this.vy[i] ?? 0) * dt * slow);
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
      this.#moveOnLand(i, (this.x[i] ?? 0) + cx, (this.y[i] ?? 0) + cy);
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
   *
   * ⚠️ **Verglas (tache 8 de l'etape 5b) intercepte AVANT tout le reste,
   * pour l'entite dont c'est le tour.** Au lieu de melanger champ et
   * repulsion, une entite dans une zone de Verglas GARDE sa vitesse
   * precedente, amortie d'un facteur (`#inertiaDampingAt`,
   * `zoneInertiaDamping` de `shared/reactions.ts`) — « friction reduite » du
   * §5 de la spec de l'etape 5b : elle ne CORRIGE plus sa trajectoire a
   * l'occasion ou elle le ferait normalement, elle continue sur sa lancee.
   *
   * ⚠️ **Derivable des deux cotes, zero octet.** L'appartenance a la zone se
   * derive du meme predicat que le ralentissement (`ZoneField.slowsAt`), et
   * la vitesse amortie se derive de `vx`/`vy` que les DEUX cotes possedent
   * deja — ils simulent tous deux depuis la naissance de l'entite. Rien de
   * plus n'est annonce, et cette grandeur VOYAGE (elle determine `x`/`y` au
   * pas suivant) : c'est pour ca que la combinaison entre plusieurs zones
   * qui se recouvrent doit rester un MINIMUM, jamais un produit — meme
   * raison arithmetique que le minimum de `#computeSlow`.
   *
   * ⚠️ **La Chaux (tache 1 de l'etape 5c) intercepte APRES la lecture du
   * champ, PAS avant comme Verglas.** Une entite en zone de Chaux melange
   * toujours repulsion et champ normalement — seul le VECTEUR DE CHAMP lu ce
   * tick-la est inverse (`#fieldSign`, rempli par `#computeFieldSign` avant
   * cet appel), pas la vitesse tenue. La separation entre voisins continue
   * de jouer sans modification : la Chaux brouille la poursuite du joueur,
   * jamais la cohesion locale de la horde.
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

      // ⚠️ **Verglas (tache 8 de l'etape 5b) : « les ennemis derapent ».**
      // A l'occasion meme ou cette entite recalculerait sa trajectoire, le
      // Verglas la lui retire : au lieu de la direction fraiche du champ,
      // elle GARDE sa vitesse precedente, amortie de `damping`. Voir le
      // docbloc de la methode pour la raison de replication ; voir
      // `#inertiaDampingAt` pour la combinaison entre zones.
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
        // Tache 25 : meme lecture interpolee que dans `spawn` — voir sa doc.
        field.sampleDirection(xi, yi, this.#dirSample);
        fx = this.#dirSample[0] ?? 0;
        fy = this.#dirSample[1] ?? 0;
      }

      // Chaux (etape 5c, tache 1) : une SUBSTITUTION de direction, jamais
      // une ecriture dans `targetField` (voir le docbloc de
      // `#computeFieldSign`) — inverse le vecteur de champ, et LUI SEUL,
      // avant qu'il ne se melange a la repulsion : une entite en zone de
      // fuite continue de se separer normalement de ses voisines, seule sa
      // poursuite du joueur s'inverse.
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
