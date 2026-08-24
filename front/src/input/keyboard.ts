import type { InputAxes } from '../net/client';

/**
 * Lit le clavier et rend deux axes dans [-1, 1].
 *
 * On suit les touches enfoncees plutot que les evenements : un `keydown` ne se
 * repete pas a la cadence du jeu, et se caler dessus donne un deplacement
 * hache.
 */
export class Keyboard {
  readonly #pressed = new Set<string>();

  constructor(target: EventTarget = window) {
    target.addEventListener('keydown', (e) => {
      this.#pressed.add(normalize((e as KeyboardEvent).key));
    });
    target.addEventListener('keyup', (e) => {
      this.#pressed.delete(normalize((e as KeyboardEvent).key));
    });
    // Sans ca, une touche enfoncee au moment ou l'onglet perd le focus reste
    // « appuyee » pour toujours et le personnage part tout seul.
    window.addEventListener('blur', () => {
      this.#pressed.clear();
    });
  }

  axes(): InputAxes {
    const left = this.#pressed.has('arrowleft') || this.#pressed.has('a') || this.#pressed.has('q');
    const right = this.#pressed.has('arrowright') || this.#pressed.has('d');
    const up = this.#pressed.has('arrowup') || this.#pressed.has('w') || this.#pressed.has('z');
    const down = this.#pressed.has('arrowdown') || this.#pressed.has('s');

    return {
      x: (right ? 1 : 0) - (left ? 1 : 0),
      y: (down ? 1 : 0) - (up ? 1 : 0),
    };
  }
}

function normalize(key: string): string {
  return key.toLowerCase();
}
