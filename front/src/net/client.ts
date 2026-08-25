import {
  FLOWFIELD_CELL,
  FLOWFIELD_HZ,
  INPUT_HZ,
  MAP_SIZE,
  MAX_ENTITIES,
  MAX_PLAYERS,
  TICK_HZ,
} from '@shared/constants';
import { FlowField } from '@shared/flowfield';
import { Horde } from '@shared/horde';
import { PlayerHistory } from '@shared/player-history';
import {
  decode,
  encodeInput,
  MSG,
  type PlayerSnapshot,
  type WaveOrderMessage,
} from '@shared/protocol';
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
    const snapshot = this.#buffer.latest();
    if (snapshot) {
      this.#history.record(
        snapshot.tick,
        snapshot.players.map((p) => p.x),
        snapshot.players.map((p) => p.y),
      );
    }

    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    if (tick % stepsPerField === 0) {
      const seen = this.#history.delayed(tick);
      if (seen) {
        for (let f = 0; f < seen.x.length && f < this.#fields.length; f++) {
          this.#fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
        }
        this.horde.retarget(seen.x, seen.y);
      }
    }

    this.horde.step(dt, this.#fields);
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status !== status) {
      this.#status = status;
      this.onStatusChange(status);
    }
  }
}
