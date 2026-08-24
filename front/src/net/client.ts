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
  /** Positions a dessiner : les autres interpolees, la sienne predite. */
  players: PlayerSnapshot[];
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

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
      const predicted = { id: this.#localId, x: local.renderX, y: local.renderY };
      if (index >= 0) {
        players[index] = predicted;
      } else {
        players.push(predicted);
      }
    }

    return { localId: this.#localId, players };
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

    const mine =
      this.#localId === null ? undefined : msg.players.find((p) => p.id === this.#localId);
    if (!mine) {
      return;
    }
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
    // snapshot recu. Le serveur lira les memes, grace au retard qu'il s'impose.
    const snapshot = this.#buffer.latest();
    if (snapshot) {
      this.#history.record(
        tick,
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
