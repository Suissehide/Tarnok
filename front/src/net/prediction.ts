import { MAP_SIZE, PLAYER_SPEED, RECONCILE_TAU_MS } from '@shared/constants';
import { moveOnMap } from '@shared/worldmap';

/** Le masque que le serveur applique au deplacement (`Room.step`), meme geometrie. */
export interface MoveMap {
  mask: Uint8Array;
  cols: number;
  rows: number;
  cellSize: number;
}

/**
 * Prediction locale du joueur, et reconciliation avec l'autorite serveur.
 *
 * Le joueur voit sa commande prendre effet a l'image suivante, sans attendre
 * l'aller-retour reseau — sans ca, le personnage traine derriere la manette et
 * le jeu se sent mou quelle que soit la qualite du reste.
 *
 * Quand le serveur contredit la prediction, on ne teleporte pas. On accepte la
 * position serveur dans la simulation, et on garde l'ecart de cote pour le
 * laisser s'eteindre exponentiellement a l'ecran : la correction devient une
 * derive de quelques pixels au lieu d'un saut.
 */
export class PredictedPlayer {
  #x: number;
  #y: number;
  /** Ecart entre ce qu'on affiche et ce que la simulation locale croit. */
  #errorX = 0;
  #errorY = 0;
  /** La poussee des gardiens (`pushOutOfGuards` sur la horde locale) ; absente en test. */
  guards: ((x: number, y: number) => { dx: number; dy: number }) | null = null;

  /**
   * `map` : le decor qui bloque le joueur, le MEME que celui du serveur. Sans
   * lui (tests, avant le WELCOME), seuls les bords de la carte bloquent.
   */
  constructor(
    x: number,
    y: number,
    private readonly map: MoveMap | null = null,
  ) {
    this.#x = x;
    this.#y = y;
  }

  /** Position retenue par la simulation locale, deja recalee sur le serveur. */
  get simX(): number {
    return this.#x;
  }

  get simY(): number {
    return this.#y;
  }

  /** Position a dessiner : la simulation, plus l'ecart en cours d'extinction. */
  get renderX(): number {
    return this.#x + this.#errorX;
  }

  get renderY(): number {
    return this.#y + this.#errorY;
  }

  /**
   * `moveX` et `moveY` sont normalises dans [-1, 1]. `scale` est le meme
   * facteur que `Room#movementScale` cote serveur (`0` pendant le gel de la
   * montee de niveau, une rampe a la reprise). Il ne module QUE le
   * deplacement, jamais l'extinction de l'ecart, pure animation d'affichage.
   *
   * ⚠️ **`speed` doit valoir celle du serveur** :
   * `PLAYER_SPEED + loadout.bonus('speed') + accountBonuses.speed` (voir
   * `Room.step`). Une prediction qui omet un terme avance moins vite que
   * l'autorite, et chaque snapshot ramene le joueur en arriere.
   * `GameClient#localSpeed` somme les trois termes ; le defaut `PLAYER_SPEED`
   * vaut un inventaire vide sur un compte sans achat.
   */
  predict(moveX: number, moveY: number, dt: number, scale = 1, speed = PLAYER_SPEED): void {
    let nx = moveX;
    let ny = moveY;
    const len = Math.hypot(nx, ny);
    if (len > 1) {
      nx /= len;
      ny /= len;
    }

    const dx = nx * speed * dt * scale;
    const dy = ny * speed * dt * scale;
    if (this.map) {
      const m = this.map;
      const pos = moveOnMap(this.#x, this.#y, dx, dy, m.mask, m.cols, m.rows, m.cellSize, MAP_SIZE);
      this.#x = pos.x;
      this.#y = pos.y;
    } else {
      this.#x = clamp(this.#x + dx, 0, MAP_SIZE);
      this.#y = clamp(this.#y + dy, 0, MAP_SIZE);
    }
    // Les gardiens font mur, comme sur le serveur (`Room.step`).
    const pousse = this.guards?.(this.#x, this.#y);
    if (pousse && (pousse.dx !== 0 || pousse.dy !== 0)) {
      const m = this.map;
      const pos = m
        ? moveOnMap(
            this.#x,
            this.#y,
            pousse.dx,
            pousse.dy,
            m.mask,
            m.cols,
            m.rows,
            m.cellSize,
            MAP_SIZE,
          )
        : {
            x: clamp(this.#x + pousse.dx, 0, MAP_SIZE),
            y: clamp(this.#y + pousse.dy, 0, MAP_SIZE),
          };
      this.#x = pos.x;
      this.#y = pos.y;
    }

    // Extinction exponentielle : monotone par construction, donc jamais
    // d'oscillation autour de la position serveur, et independante de la
    // cadence d'appel — ce qui compte quand le rendu est a 60 fps et la
    // simulation a 30 Hz.
    const decay = Math.exp((-dt * 1000) / RECONCILE_TAU_MS);
    this.#errorX *= decay;
    this.#errorY *= decay;
  }

  /** Le serveur a parle. On le croit, mais on ne le montre pas d'un coup. */
  reconcile(serverX: number, serverY: number): void {
    this.#errorX += this.#x - serverX;
    this.#errorY += this.#y - serverY;
    this.#x = serverX;
    this.#y = serverY;
  }

  /** Recale sans adoucir : a la connexion, il n'y a rien a corriger. */
  teleport(x: number, y: number): void {
    this.#x = x;
    this.#y = y;
    this.#errorX = 0;
    this.#errorY = 0;
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
