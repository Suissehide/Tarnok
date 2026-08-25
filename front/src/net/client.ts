import {
  FLOWFIELD_CELL,
  FLOWFIELD_HZ,
  INPUT_HZ,
  LEVEL_FREEZE_TICKS,
  LEVEL_RESUME_TICKS,
  MAP_SIZE,
  MAX_ENTITIES,
  MAX_PLAYERS,
  ORB_LIFETIME_TICKS,
  TICK_HZ,
} from '@shared/constants';
import { FlowField } from '@shared/flowfield';
import { Horde } from '@shared/horde';
import { HordeHistory } from '@shared/horde-history';
import { PlayerHistory } from '@shared/player-history';
import {
  decode,
  encodeInput,
  MSG,
  type PlayerSnapshot,
  type WaveOrderMessage,
} from '@shared/protocol';
import { SeparationGrid } from '@shared/separation';
import { applyObstacles, generateObstacles } from '@shared/worldmap';

import { SnapshotBuffer } from './interpolation';
import { PredictedPlayer } from './prediction';

export interface InputAxes {
  x: number;
  y: number;
}

export interface RenderState {
  /** Identifiant du joueur local, ou null tant que le WELCOME n'est pas arrive. */
  localId: number | null;
  /** Experience de l'equipe — commune a tous, pas un champ par joueur. */
  xp: number;
  /** Positions a dessiner : les autres interpolees, la sienne predite. */
  players: PlayerSnapshot[];
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

/**
 * Tolerance de retard du compteur de tick local de la horde sur le tick
 * serveur porte par le dernier snapshot recu.
 *
 * Volontairement asymetrique et serree. Etre EN AVANCE du tick serveur connu
 * est le fonctionnement normal — la latence reseau fait que le dernier
 * snapshot recu decrit toujours un instant deja passe — et ne doit jamais
 * declencher de recalage : le faire reviendrait a figer en permanence le
 * compteur local sur un tick perime, annulant l'absorption de latence de
 * `FIELD_INPUT_DELAY_TICKS`. Etre EN RETARD, en revanche, ne devrait jamais
 * arriver en fonctionnement normal — seulement apres une perte de pas (onglet
 * en arriere-plan, §6.1c de la spec) — et doit se corriger immediatement : le
 * flowfield est un champ de directions discret, mesure (voir
 * `shared/horde.replication.test.ts`, scenarios C1) a etre assez sensible
 * pour faire la difference entre 0 et plus de 600 px de derive selon qu'un
 * retard persistant d'un ou de deux ticks est tolere.
 */
const HORDE_TICK_LAG_TOLERANCE = 1;

/** Pas fixe de la simulation de horde, partage entre l'avancement normal et le rejeu. */
const FIXED_DT = 1 / TICK_HZ;

/** Cadence de rafraichissement du champ, en pas : meme calcul que `Room.step` et `Horde.replication.test.ts`. */
const STEPS_PER_FIELD = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));

/** Un lot de morts en attente d'application, tel que recu par `DEATHS` (§3.1). */
interface PendingDeathBatch {
  tick: number;
  ids: number[];
}

/**
 * Orbes vivants, cote client — **derives des morts, jamais transmis** (§6.1 de
 * la spec). Meme raisonnement que `OrbField` cote serveur (`back/src/combat.ts`),
 * duplique ici plutot qu'importe : le client ne peut dependre que de `shared/`,
 * et `back/` connait `ws`/`fastify` (regle Biome, voir `room.ts`).
 *
 * `PICKUPS` dit quelles identites ont ete ramassees ; l'existence et la
 * position de l'orbe, elles, ne transitent jamais — `GameClient` les pose a la
 * position de l'entite au moment de sa mort, lue depuis la horde restauree par
 * `HordeHistory` (voir `GameClient#applyDeaths`), avant compaction par `kill`.
 *
 * Tableaux types, jamais un objet par orbe — meme regle que `Horde` et
 * `Projectiles` (§4.4 de l'orientation).
 */
export class DerivedOrbs {
  /** Identite du monstre qui a laisse l'orbe. */
  readonly id: Uint32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Tick de la mort qui a fait apparaitre l'orbe : sert au calcul de peremption. */
  readonly bornTick: Uint32Array;
  #count = 0;

  constructor(readonly capacity: number) {
    this.id = new Uint32Array(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.bornTick = new Uint32Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  /** Fait apparaitre un orbe. Ignore silencieusement si la capacite (tres large) est atteinte. */
  spawn(entityId: number, x: number, y: number, tick: number): void {
    if (this.#count >= this.capacity) {
      return;
    }
    const slot = this.#count++;
    this.id[slot] = entityId;
    this.x[slot] = x;
    this.y[slot] = y;
    this.bornTick[slot] = tick;
  }

  /** Retire les orbes ramasses : identites recues par `PICKUPS`. */
  remove(entityIds: readonly number[]): void {
    for (const entityId of entityIds) {
      const slot = this.#slotOf(entityId);
      if (slot >= 0) {
        this.#removeAt(slot);
      }
    }
  }

  /**
   * Retire les orbes dont la duree de vie a expire — calcul DERIVE (§6.1),
   * identique des deux cotes a partir du seul `tick - bornTick`, jamais
   * transmis ni arbitre par un message.
   */
  expire(tick: number): void {
    for (let i = this.#count - 1; i >= 0; i--) {
      if (tick - (this.bornTick[i] ?? 0) >= ORB_LIFETIME_TICKS) {
        this.#removeAt(i);
      }
    }
  }

  #slotOf(entityId: number): number {
    for (let i = 0; i < this.#count; i++) {
      if (this.id[i] === entityId) {
        return i;
      }
    }
    return -1;
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.id[slot] = this.id[last] ?? 0;
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
      this.bornTick[slot] = this.bornTick[last] ?? 0;
    }
    this.#count = last;
  }
}

/**
 * Le client de jeu : une socket, un tampon d'interpolation, une prediction.
 *
 * Il ne dessine rien et ne lit pas le clavier — il recoit une fonction qui lui
 * rend les axes courants. C'est ce qui permet de le tester sans navigateur, et
 * ce qui evite que le rendu et le reseau se contaminent.
 */
export class GameClient {
  #ws: WebSocket | null = null;
  #inputTimer: ReturnType<typeof setInterval> | null = null;
  readonly #buffer = new SnapshotBuffer();
  #local: PredictedPlayer | null = null;
  #localId: number | null = null;
  /**
   * Derniers pv (personnels) connus du joueur local, tels que portes par le
   * dernier snapshot : la prediction ne simule que la position, pas les pv.
   */
  #localHp = 0;
  /** Experience de l'equipe, telle que portee par le dernier snapshot. */
  #teamXp = 0;
  #seq = 0;
  #status: ConnectionStatus = 'closed';

  readonly horde = new Horde(MAX_ENTITIES);
  #fields: FlowField[] = [];
  readonly #history = new PlayerHistory();
  /** Accumulateur de pas fixes : la horde avance a 30 Hz, comme le serveur. */
  #hordeAcc = 0;
  #lastHordeTick = 0;

  /** Separation de la horde (etape 7 de la sequence serveur), rejouee a l'identique. */
  readonly #separation = new SeparationGrid(MAX_ENTITIES);
  /** Anneau d'etats de horde, pour le rejeu des morts en retard (§3.2). */
  readonly #hordeHistory = new HordeHistory(MAX_ENTITIES);
  /** Orbes derives des morts (§6.1), jamais transmis. Lecture publique pour le rendu et le HUD. */
  readonly orbs = new DerivedOrbs(MAX_ENTITIES);

  /**
   * Nombre cumule d'identites tuees en dehors de la portee de `HordeHistory`
   * (`ROLLBACK_DEPTH_TICKS`) : appliquees au present plutot qu'au tick de la
   * mort, faute de pouvoir revenir en arriere. Lecture seule, pour le HUD de
   * debug (§4.6 de l'orientation demande un HUD, pas des logs) et pour les tests.
   */
  #lateDeaths = 0;

  /** Lots de morts recus mais pas encore appliques. Meme discipline que `#pendingOrders`. */
  readonly #pendingDeaths: PendingDeathBatch[] = [];

  /**
   * Dernier tick du gel courant (inclus), et dernier tick de la reprise
   * progressive qui suit. `-1` hors gel — et non `0` comme cote serveur
   * (`Room` commence son compteur a 1, jamais `GameClient`, dont le tout
   * premier tick reel peut valoir `0` — voir `#onFrame`/WELCOME). Avec `0`
   * comme sentinelle, `#movementScale(0)` rendrait `0` (gel) des le tout
   * premier tick d'une connexion fraiche, sans qu'aucun `LEVEL_UP` ne soit
   * jamais arrive : `-1` ecarte ce cas plutot que de le tolerer.
   */
  #freezeUntilTick = -1;
  #resumeEndTick = -1;

  /**
   * Ordres recus mais pas encore appliques.
   *
   * Le gestionnaire de message ne fait QUE empiler. L'application a lieu dans
   * `#advanceHorde`, avant le rafraichissement du champ — l'ordre inverse
   * multiplie la derive par trente-cinq (§6.2 de la spec).
   */
  readonly #pendingOrders: WaveOrderMessage[] = [];

  constructor(
    private readonly url: string,
    private readonly readInput: () => InputAxes,
    private readonly onStatusChange: (status: ConnectionStatus) => void,
  ) {}

  get status(): ConnectionStatus {
    return this.#status;
  }

  get localId(): number | null {
    return this.#localId;
  }

  /**
   * Tick courant de la horde locale. Expose pour l'observabilite, comme
   * `Room.fieldInputTick` cote serveur : c'est ce qui permet de verrouiller
   * par test que le compteur reste aligne sur le tick absolu recu au WELCOME,
   * puis recale en continu sur celui des snapshots recus (voir `#onFrame`) —
   * sans quoi il resterait en permanence en retard du temps de trajet du
   * WELCOME, pour toute la vie de la connexion (constat C1.b).
   */
  get hordeTick(): number {
    return this.#lastHordeTick;
  }

  /**
   * Nombre cumule de morts appliquees au present, faute d'anneau assez
   * profond pour les rejouer (`ROLLBACK_DEPTH_TICKS`). Lecture seule : voir
   * `#lateDeaths`.
   */
  get lateDeaths(): number {
    return this.#lateDeaths;
  }

  connect(): void {
    this.#setStatus('connecting');
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;

    ws.addEventListener('open', () => {
      this.#setStatus('open');
      // Cadence d'envoi, pas cadence de simulation : un peu de gigue ici n'a
      // aucune consequence, le serveur horodate par son propre tick.
      this.#inputTimer = setInterval(() => {
        this.#sendInput();
      }, 1000 / INPUT_HZ);
    });

    ws.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
      this.#onFrame(event.data);
    });

    ws.addEventListener('close', () => {
      this.disconnect();
    });
  }

  disconnect(): void {
    if (this.#inputTimer !== null) {
      clearInterval(this.#inputTimer);
      this.#inputTimer = null;
    }
    this.#ws?.close();
    this.#ws = null;
    this.#setStatus('closed');
  }

  /**
   * Une image de rendu. `now` est l'horloge du navigateur, `dt` le temps ecoule
   * depuis l'image precedente, en secondes.
   */
  update(now: number, dt: number): RenderState {
    const axes = this.readInput();
    this.#local?.predict(axes.x, axes.y, dt);

    // La horde avance au **pas fixe** du serveur, pas au rythme des images :
    // deux clients a 60 et 144 fps appliqueraient sinon des suites de `dt`
    // differentes, et la derive serait proportionnelle au temps de vie.
    const STEP = 1 / TICK_HZ;
    this.#hordeAcc += dt;
    let steps = 0;
    while (this.#hordeAcc >= STEP && steps < 5) {
      this.#advanceHorde(STEP);
      this.#hordeAcc -= STEP;
      steps++;
    }
    if (steps === 5) {
      this.#hordeAcc = 0;
    }

    const players = this.#buffer.sample(now);
    const local = this.#local;
    if (local && this.#localId !== null) {
      const index = players.findIndex((p) => p.id === this.#localId);
      const predicted = {
        id: this.#localId,
        x: local.renderX,
        y: local.renderY,
        hp: this.#localHp,
      };
      if (index >= 0) {
        players[index] = predicted;
      } else {
        players.push(predicted);
      }
    }

    return { localId: this.#localId, xp: this.#teamXp, players };
  }

  #sendInput(): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const axes = this.readInput();
    this.#seq = (this.#seq + 1) & 0xffff;
    ws.send(encodeInput(this.#seq, axes.x * 127, axes.y * 127));
  }

  #onFrame(data: ArrayBuffer): void {
    const msg = decode(data);

    if (msg.type === MSG.WELCOME) {
      this.#localId = msg.playerId;
      // Le tick du salon est ABSOLU et grandit pendant toute sa vie. Sans cet
      // alignement, `spawnTick - tickLocal` serait negatif pour tout joueur qui
      // rejoint apres le premier, le rattrapage ne s'executerait jamais, et le
      // rafraichissement du champ serait dephase de facon permanente par
      // rapport au serveur.
      this.#lastHordeTick = msg.tick;
      // Le client **regenere** la carte depuis la graine, il ne la recoit pas :
      // envoyer 8 836 cellules couterait plus cher que tout le protocole.
      const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
      const mask = generateObstacles(msg.mapSeed, probe.cols, probe.rows);
      this.#fields = Array.from({ length: MAX_PLAYERS }, () => {
        const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
        applyObstacles(f, mask);
        return f;
      });
      return;
    }
    if (msg.type === MSG.WAVE_ORDER) {
      this.#pendingOrders.push(msg);
      return;
    }
    if (msg.type === MSG.DEATHS) {
      // Comme les ordres de vague : le gestionnaire ne fait QU'empiler,
      // l'application (restauration, rejeu) a lieu dans `#advanceHorde`, au
      // tick local qui vient d'etre simule — voir `#applyDeaths`.
      this.#pendingDeaths.push({ tick: msg.tick, ids: msg.ids });
      return;
    }
    if (msg.type === MSG.PICKUPS) {
      // Pur retrait derive : aucune position ni existence d'orbe ne transite,
      // seules les identites ramassees le font (voir `DerivedOrbs`).
      this.orbs.remove(msg.ids);
      return;
    }
    if (msg.type === MSG.LEVEL_UP) {
      // ⚠️ `msg.tick` est le tick auquel le gel PREND EFFET, pas celui de
      // l'emission (voir `LevelUpMessage`) : geler a la reception ferait geler
      // chaque client a un tick different selon sa latence, et le gel
      // deviendrait une source de divergence au lieu d'une pause commune.
      this.#freezeUntilTick = msg.tick + LEVEL_FREEZE_TICKS - 1;
      this.#resumeEndTick = this.#freezeUntilTick + LEVEL_RESUME_TICKS;
      return;
    }
    if (msg.type !== MSG.SNAPSHOT) {
      return;
    }

    this.#buffer.push(msg, performance.now());

    // Recalage continu (constat C1.b/c) : sans lui, le compteur reste calé
    // sur le retard du WELCOME pour toute la vie de la connexion, et un
    // onglet remis au premier plan après une pause ne rattrape jamais les pas
    // perdus. Voir `HORDE_TICK_LAG_TOLERANCE`.
    if (msg.tick - this.#lastHordeTick > HORDE_TICK_LAG_TOLERANCE) {
      this.#lastHordeTick = msg.tick;
    }

    // `xp` est celui de l'equipe : porte par le snapshot entier, pas par un
    // bloc joueur — on le lit a chaque snapshot, meme si `mine` reste
    // introuvable ci-dessous.
    this.#teamXp = msg.xp;

    const mine =
      this.#localId === null ? undefined : msg.players.find((p) => p.id === this.#localId);
    if (!mine) {
      return;
    }
    // Pas predit, contrairement a la position : on prend simplement la
    // derniere valeur connue du serveur.
    this.#localHp = mine.hp;
    if (this.#local === null) {
      // Premier snapshot ou l'on se voit : on se pose la, sans adoucissement.
      this.#local = new PredictedPlayer(mine.x, mine.y);
    } else {
      this.#local.reconcile(mine.x, mine.y);
    }
  }

  #advanceHorde(dt: number): void {
    if (this.#fields.length === 0) {
      return;
    }
    const tick = this.#lastHordeTick++;

    // ⚠️ LES ORDRES EN ATTENTE S'APPLIQUENT ICI, EN PREMIER — avant le
    // rafraichissement du champ plus bas. Mesure (§6.2 de la spec) : dans cet
    // ordre, la derive due a la latence reste bornee autour de 20 a 50 px ;
    // dans l'ordre inverse, elle monte a 782 px, soit pire que de ne pas
    // rattraper du tout. C'est la seule raison pour laquelle les ordres sont
    // mis en file plutot qu'appliques a la reception.
    while (this.#pendingOrders.length > 0) {
      const order = this.#pendingOrders.shift();
      if (order) {
        // Les pas que le serveur a deja fait faire pendant que l'ordre voyageait.
        const missed = Math.max(0, tick - order.spawnTick);
        this.horde.spawnCatchingUp(order, missed, dt, this.#fields);
      }
    }

    // Les positions telles que le client les connait : celles du dernier
    // snapshot recu, enregistrees sous le tick SERVEUR auquel elles ont ete
    // calculees — jamais sous le tick local `tick` (constat C1.a). Le serveur
    // enregistre les siennes sous son propre tick reel ; si le client
    // enregistrait les memes positions sous une cle differente, `delayed()`
    // ne lirait plus la meme chose des deux cotes, meme quand le compteur
    // local est par ailleurs bien recale.
    //
    // ⚠️ Non gate par le gel : le serveur continue d'emettre des snapshots
    // pendant le gel (positions inchangees mais tick qui avance), donc cet
    // enregistrement reste la verite du serveur, gel ou pas. Le gater
    // ouvrirait un trou dans l'anneau court de `PlayerHistory` pour rien.
    const snapshot = this.#buffer.latest();
    if (snapshot) {
      this.#history.record(
        snapshot.tick,
        snapshot.players.map((p) => p.x),
        snapshot.players.map((p) => p.y),
      );
    }

    // Le rafraichissement du champ et le reciblage, eux, SONT gates par le
    // gel : le serveur ne les execute pas non plus pendant le gel (`Room.step`
    // revient avant d'y arriver). Sans ce garde, le client rafraichirait un
    // champ — et reciblerait la horde — a un instant ou le serveur ne l'a pas
    // fait, ce qui desynchronise `targetField` independamment de toute
    // difference de position.
    if (tick > this.#freezeUntilTick && tick % STEPS_PER_FIELD === 0) {
      const seen = this.#history.delayed(tick);
      if (seen) {
        for (let f = 0; f < seen.x.length && f < this.#fields.length; f++) {
          this.#fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
        }
        this.horde.retarget(seen.x, seen.y);
      }
    }

    // Le mouvement (horde ET separation) est module par `#movementScale` :
    // `0` pendant le gel strict, une rampe pendant la reprise, `1` sinon —
    // exactement le facteur que `Room.step` applique a son propre `dt`. A `0`
    // le pas ne fait litteralement rien (deplacement nul, poussees de
    // separation nulles) : inutile de le sauter par un `if` separe.
    const scale = this.#movementScale(tick);
    this.horde.step(dt * scale, this.#fields);
    this.#separation.apply(this.horde, dt * scale);

    // Instantane pour le rejeu (§3.2) : DOIT etre pris a chaque tick, gel ou
    // pas, sans quoi une mort qui viserait un tick gele serait « trop vieille »
    // a tort — l'anneau la jugerait absente plutot que simplement inchangee.
    this.#hordeHistory.record(tick, this.horde);
    // Peremption des orbes : calcul DERIVE (§6.1), jamais arbitre — voir
    // `DerivedOrbs.expire`.
    this.orbs.expire(tick);
    this.#drainPendingDeaths(tick);
  }

  /**
   * Applique tous les lots de morts recus mais pas encore traites, au tick
   * local `currentTick` — celui que `#advanceHorde` vient tout juste de
   * simuler et d'enregistrer dans `#hordeHistory`.
   *
   * ⚠️ Suppose que la file reste dans l'ordre chronologique des ticks
   * SERVEUR des lots, pas seulement dans l'ordre de leur reception. Deux
   * faits, tous deux vrais aujourd'hui et tous deux necessaires, portent
   * cette hypothese :
   *   1. `Room.step` (voir `room.ts`) n'empile jamais qu'UN SEUL `DEATHS` par
   *      tick, dans le tableau `#pendingDeaths` du serveur, donc l'emission
   *      elle-meme est deja triee par tick croissant, sans jamais interfoliation.
   *   2. WebSocket, sur une MEME connexion TCP, livre les trames dans leur
   *      ordre d'emission — jamais de reordonnancement, jamais de duplication.
   * Aucune des deux n'est reverifiee ici : ce n'est pas une garde, c'est une
   * hypothese documentee, dont la rupture romprait un invariant que rien
   * dans ce fichier ne produit aujourd'hui (voir le rapport de la tache 10,
   * qui explique pourquoi une garde contre un desordre que rien ne cause n'a
   * pas ete ajoutee). Rejouer un lot plus recent AVANT un lot plus ancien
   * effacerait la correction du second par le rejeu du premier.
   */
  #drainPendingDeaths(currentTick: number): void {
    while (this.#pendingDeaths.length > 0) {
      const batch = this.#pendingDeaths.shift();
      if (batch) {
        this.#applyDeaths(batch.tick, batch.ids, currentTick);
      }
    }
  }

  /**
   * Applique un lot de morts par rejeu (§3.2) : restaure la horde au tick de
   * la mort, tue, rejoue jusqu'au present. Appliquer directement au present
   * laisserait un ecart d'un ou plusieurs ticks s'installer — et la
   * separation (tache 1) le propage a des dizaines de voisines plutot que de
   * l'absorber : mesure a l'etape 2, l'equivalent sans rejeu croit sans borne
   * jusqu'a 694 px en dix secondes (scenario 8 de `horde.replication.test.ts`).
   *
   * Les orbes sont derives ICI, a la position lue dans la horde restauree —
   * juste avant `kill`, comme `resolveProjectileDamage` cote serveur lit la
   * position juste avant sa propre compaction (voir `back/src/combat.ts`).
   *
   * ⚠️ Le rejeu ne rejoue QUE le mouvement — champ, horde, separation — jamais
   * l'arbitrage (degats, contact, ramassages) : ce sont les etapes 8 a 10 de
   * `Room.step`, prerogative exclusive du serveur. Un client qui les rejouerait
   * prononcerait des morts que le serveur n'a pas decidees, et divergerait
   * precisement la ou le rejeu cherche a converger.
   */
  #applyDeaths(deathTick: number, ids: readonly number[], currentTick: number): void {
    if (!this.#hordeHistory.restore(deathTick, this.horde)) {
      // Trop vieux pour l'anneau (`ROLLBACK_DEPTH_TICKS`) : applique au
      // present, et SIGNALE — une degradation silencieuse est un piege (§4.6
      // de l'orientation demande un HUD, pas des logs). Scenario 10 de
      // `horde.replication.test.ts` mesure la derive residuelle de ce chemin.
      this.#spawnOrbs(ids, deathTick);
      this.#lateDeaths += ids.length;
      this.horde.kill(ids);
      return;
    }
    this.#spawnOrbs(ids, deathTick);
    this.horde.kill(ids);
    // ⚠️ Le champ de flux n'est pas dans l'anneau : `HordeHistory.restore`
    // remet la HORDE au tick de la mort, mais `FlowField` est un objet mutable
    // PARTAGE que l'anneau ne sauvegarde jamais. Sans ce reamorcage, le rejeu
    // demarrerait avec le contenu du DERNIER rafraichissement reel — celui du
    // tick present, plusieurs generations plus frais que ce que le serveur
    // avait sous les yeux au tick restaure. Mesure a la tache 8 : 79 px de
    // derive residuelle sur un scenario qui aurait du rendre zero.
    this.#primeFieldForReplay(deathTick);
    for (let t = deathTick + 1; t <= currentTick; t++) {
      this.#replayTick(t);
    }
  }

  /** Fait apparaitre un orbe par identite morte, a sa position dans la horde COURANTE (avant `kill`). */
  #spawnOrbs(ids: readonly number[], tick: number): void {
    for (const id of ids) {
      const slot = this.horde.slotOf(id);
      if (slot >= 0) {
        this.orbs.spawn(id, this.horde.x[slot] ?? 0, this.horde.y[slot] ?? 0, tick);
      }
    }
  }

  /**
   * Remet le champ a son contenu du dernier rafraichissement du a `atTick` ou
   * avant — jamais `atTick` lui-meme, sauf s'il tombe pile sur une frontiere.
   * Version de reference : `primeFieldForReplay` de `shared/horde.replication.test.ts`.
   */
  #primeFieldForReplay(atTick: number): void {
    const lastDue = atTick - (((atTick % STEPS_PER_FIELD) + STEPS_PER_FIELD) % STEPS_PER_FIELD);
    const seen = this.#history.delayed(lastDue);
    if (seen) {
      for (let f = 0; f < seen.x.length && f < this.#fields.length; f++) {
        this.#fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
      }
    }
  }

  /**
   * Un pas de rejeu : rafraichit le champ si du, avance la horde, applique la
   * separation — les etapes 4, 6, 7 de la sequence serveur, jamais
   * l'arbitrage (8 a 10). Reecrit aussi l'anneau pour ce tick : une mort
   * suivante qui viserait l'un de ces ticks doit restaurer la version
   * rejouee, pas l'ancienne version d'avant correction.
   */
  #replayTick(tick: number): void {
    if (tick > this.#freezeUntilTick && tick % STEPS_PER_FIELD === 0) {
      const seen = this.#history.delayed(tick);
      if (seen) {
        for (let f = 0; f < seen.x.length && f < this.#fields.length; f++) {
          this.#fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
        }
        this.horde.retarget(seen.x, seen.y);
      }
    }
    const scale = this.#movementScale(tick);
    this.horde.step(FIXED_DT * scale, this.#fields);
    this.#separation.apply(this.horde, FIXED_DT * scale);
    this.#hordeHistory.record(tick, this.horde);
  }

  /**
   * Facteur applique au `dt` de tout ce qui bouge (horde, separation) : `0`
   * pendant le gel strict, une rampe de `0` (exclu) a `1` pendant les
   * `LEVEL_RESUME_TICKS` qui suivent, `1` en fonctionnement normal. Miroir
   * exact de `Room#movementScale` cote serveur — necessaire pour que le rejeu
   * d'un tick gele ou en reprise avance exactement comme le serveur l'a fait.
   */
  #movementScale(tick: number): number {
    if (tick > this.#resumeEndTick) {
      return 1;
    }
    const sinceFreezeEnd = tick - this.#freezeUntilTick;
    return Math.min(1, Math.max(0, sinceFreezeEnd / LEVEL_RESUME_TICKS));
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status !== status) {
      this.#status = status;
      this.onStatusChange(status);
    }
  }
}
