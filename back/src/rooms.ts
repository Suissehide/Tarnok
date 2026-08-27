import { randomInt } from 'node:crypto';

import { Room } from './room';

/**
 * Alphabet des codes de salon : 24 lettres, sans I ni O.
 *
 * Un code se dicte a voix haute ou se recopie depuis un message. « I » se lit
 * pour « 1 » et « O » pour « 0 » ; les retirer coute deux combinaisons sur
 * 331 776 et evite une classe entiere de « ca marche pas chez moi ».
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const CODE_LENGTH = 4;

export interface CreatedRoom {
  code: string;
  room: Room;
}

export class RoomRegistry {
  readonly #rooms = new Map<string, Room>();

  get size(): number {
    return this.#rooms.size;
  }

  /**
   * Ouvre un salon. `seed` fixe la graine de sa carte — obstacles, generateur
   * de vagues et tirage du draft en derivent tous (voir `Room.mapSeed`).
   *
   * ⚠️ Sans graine, `Room` en tire une au hasard : c'est ce que fait la route
   * `POST /rooms`. La passer sert le test d'integration a quatre clients, qui
   * serait sinon intermittent — et un test intermittent est pire qu'un test
   * absent.
   */
  create(seed?: number): CreatedRoom {
    const code = this.#freshCode();
    const room = new Room(seed);
    this.#rooms.set(code, room);
    return { code, room };
  }

  get(code: string): Room | undefined {
    return this.#rooms.get(code.toUpperCase());
  }

  delete(code: string): void {
    this.#rooms.delete(code.toUpperCase());
  }

  /** Codes en cours, pour le HUD de debug serveur. */
  entries(): IterableIterator<[string, Room]> {
    return this.#rooms.entries();
  }

  #freshCode(): string {
    // Espace de 24^4 ; on retire jusqu'a epuisement plutot que d'accepter une
    // collision silencieuse, qui enverrait deux equipes dans le meme salon.
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      }
      if (!this.#rooms.has(code)) {
        return code;
      }
    }
    throw new Error('impossible de tirer un code de salon libre');
  }
}
