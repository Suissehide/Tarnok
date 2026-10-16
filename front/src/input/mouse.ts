/**
 * Lit la position du curseur en coordonnees ECRAN, relatives a un element
 * (le canevas du jeu) — jamais en coordonnees monde.
 *
 * On suit un ETAT (la derniere position connue), pas les evenements :
 * `screenPosition()` s'interroge a tout moment.
 *
 * ⚠️ Ne connait ni la camera ni le monde. La conversion ecran -> monde vit
 * dans `Stage.screenToWorld` (meme camera que le rendu) : la faire ici
 * ferait deriver la visee des que la camera bouge.
 */
export class Mouse {
  #x = 0;
  #y = 0;
  #hasMoved = false;

  /**
   * `target` sert de reference pour les coordonnees rendues (relatives a son
   * coin haut-gauche, comme `Stage.screenToWorld` l'attend) ; `listenOn` est
   * l'element sur lequel on ecoute les evenements — `window` par defaut,
   * pour continuer a suivre le curseur meme s'il quitte momentanement le
   * canevas.
   */
  constructor(
    private readonly target: HTMLElement,
    listenOn: EventTarget = window,
  ) {
    listenOn.addEventListener('mousemove', (e) => {
      const event = e as MouseEvent;
      const rect = this.target.getBoundingClientRect();
      this.#x = event.clientX - rect.left;
      this.#y = event.clientY - rect.top;
      this.#hasMoved = true;
    });
  }

  /**
   * `null` tant que la souris n'a jamais bouge depuis la creation de cet
   * objet — distinct de `(0, 0)`, qui est une position ecran valide (coin
   * haut-gauche du canevas).
   */
  screenPosition(): { x: number; y: number } | null {
    return this.#hasMoved ? { x: this.#x, y: this.#y } : null;
  }
}
