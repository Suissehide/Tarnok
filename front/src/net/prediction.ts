import { MAP_SIZE, PLAYER_SPEED, RECONCILE_TAU_MS } from '@shared/constants';

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
 *
 * C'est la version naive annoncee au plan. La vraie reconciliation — rejouer
 * les entrees non encore acquittees par-dessus l'etat serveur — appartient a
 * l'etape 2, et elle remplacera ce fichier sans toucher au reste.
 */
export class PredictedPlayer {
  #x: number;
  #y: number;
  /** Ecart entre ce qu'on affiche et ce que la simulation locale croit. */
  #errorX = 0;
  #errorY = 0;

  constructor(x: number, y: number) {
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
   * `moveX` et `moveY` sont normalises dans [-1, 1]. `scale` (tache 24) est le
   * meme facteur que `Room#movementScale` cote serveur : `0` pendant le gel
   * strict de la montee de niveau, une rampe pendant la reprise, `1` par
   * defaut. Ne module QUE le deplacement, jamais l'extinction de l'ecart de
   * reconciliation ci-dessous — celle-ci reste une pure animation d'affichage,
   * sans lien avec la simulation que le serveur gele ou pas.
   *
   * ⚠️ **`speed` est un parametre depuis la tache 9 de l'etape 4, et ce n'est
   * pas une commodite.** Le serveur avance le joueur a
   * `PLAYER_SPEED + loadout.bonus('speed')` (voir `Room.step`) : des la
   * premiere carte « fougue » (+15 px/s), une prediction cablee sur
   * `PLAYER_SPEED` avance moins vite que l'autorite a chaque tick, et le
   * joueur voit une reconciliation permanente — sa position rattrapee en
   * arriere par chaque snapshot. La valeur par defaut reste `PLAYER_SPEED` :
   * c'est exactement ce que vaut un inventaire vide.
   */
  predict(moveX: number, moveY: number, dt: number, scale = 1, speed = PLAYER_SPEED): void {
    let nx = moveX;
    let ny = moveY;
    const len = Math.hypot(nx, ny);
    if (len > 1) {
      nx /= len;
      ny /= len;
    }

    this.#x = clamp(this.#x + nx * speed * dt * scale, 0, MAP_SIZE);
    this.#y = clamp(this.#y + ny * speed * dt * scale, 0, MAP_SIZE);

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
