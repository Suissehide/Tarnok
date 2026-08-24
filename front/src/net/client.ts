import { INPUT_HZ } from '@shared/constants';
import { decode, encodeInput, MSG, type PlayerSnapshot } from '@shared/protocol';

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

  #setStatus(status: ConnectionStatus): void {
    if (this.#status !== status) {
      this.#status = status;
      this.onStatusChange(status);
    }
  }
}
