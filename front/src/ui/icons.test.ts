import { describe, expect, it } from 'vitest';

import { avatar } from './icons';

describe('avatar — la tete de l unite, dans la couleur du joueur', () => {
  it('change avec la classe, pas seulement avec le slot', () => {
    // Joueur 1 jaune (rangee 11-15) : Archer, Warrior, Lancer, Monk.
    expect([0, 1, 2, 3].map((c) => avatar(1, c).slice(-6, -4))).toEqual(['13', '11', '12', '14']);
  });
  it('suit la couleur du joueur : bleu, rouge, violet', () => {
    expect([2, 3, 4].map((p) => avatar(p, 1).slice(-6, -4))).toEqual(['01', '06', '16']);
  });
});
