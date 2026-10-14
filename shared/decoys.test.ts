import { describe, expect, it } from 'vitest';

import { DECOY_LIFETIME_TICKS } from './abilities';
import { type Decoy, substituteDecoys } from './decoys';

describe('etape 8 tache 6 : la substitution du leurre', () => {
  it('remplace la position de son lanceur, et laisse les autres intactes', () => {
    const d: Decoy = { playerId: 2, x: 500, y: 600, bornTick: 10 };
    const r = substituteDecoys([1, 2, 3], [0, 100, 200], [0, 100, 200], [d], 10);
    expect(r.x).toEqual([0, 500, 200]);
    expect(r.y).toEqual([0, 600, 200]);
  });

  /**
   * ⚠️ **LE test de cette tache.** `seen.x` est indexe par l'ordre d'iteration
   * des joueurs, pas par identifiant : quand un joueur part, les indices de
   * ceux qui restent BOUGENT. Un leurre qui retiendrait un indice suivrait le
   * mauvais joueur, et un cran de decalage reassigne TOUTE la horde.
   */
  it('suit son lanceur quand les indices bougent, parce qu il retient un ID', () => {
    const d: Decoy = { playerId: 3, x: 500, y: 600, bornTick: 0 };
    // Le joueur 1 est parti : 3 n'est plus au deuxieme rang mais au premier.
    const r = substituteDecoys([3, 4], [10, 20], [10, 20], [d], 0);
    expect(r.x).toEqual([500, 20]);
    expect(r.y).toEqual([600, 20]);
  });

  it('n allonge ni ne raccourcit les tableaux', () => {
    const d: Decoy = { playerId: 2, x: 500, y: 600, bornTick: 0 };
    const r = substituteDecoys([1, 2, 3, 4], [0, 1, 2, 3], [0, 1, 2, 3], [d], 0);
    expect(r.x.length).toBe(4);
    expect(r.y.length).toBe(4);
  });

  it('un leurre expire cesse de substituer, exactement a sa date', () => {
    const d: Decoy = { playerId: 1, x: 500, y: 600, bornTick: 0 };
    const dernier = DECOY_LIFETIME_TICKS - 1;
    expect(substituteDecoys([1], [0], [0], [d], dernier).x).toEqual([500]);
    expect(substituteDecoys([1], [0], [0], [d], DECOY_LIFETIME_TICKS).x).toEqual([0]);
  });

  /**
   * ⚠️ **Un leurre n'agit pas AVANT sa naissance**, et c'est ce qui tient les
   * deux cotes ensemble. L'entree du champ est lue au tick RETARDE : le
   * serveur, qui connait le leurre des sa pose, ne doit pas l'appliquer a des
   * positions plus anciennes que lui — le client, qui l'apprend plus tard,
   * ne le ferait pas.
   */
  it('un leurre ne substitue pas a des positions plus anciennes que lui', () => {
    const d: Decoy = { playerId: 1, x: 500, y: 600, bornTick: 10 };
    expect(substituteDecoys([1], [0], [0], [d], 9).x).toEqual([0]);
    expect(substituteDecoys([1], [0], [0], [d], 10).x).toEqual([500]);
  });

  /** Review Focus n°5 : un leurre dont le lanceur est mort ou deconnecte. */
  it('un leurre dont le lanceur n est plus dans la salle ne corrompt rien', () => {
    const d: Decoy = { playerId: 7, x: 500, y: 600, bornTick: 0 };
    const r = substituteDecoys([1, 2], [0, 1], [0, 1], [d], 0);
    expect(r.x).toEqual([0, 1]);
    expect(r.y).toEqual([0, 1]);
  });

  it('sans aucun leurre, rend exactement ce qu on lui donne', () => {
    const r = substituteDecoys([1, 2], [3, 4], [5, 6], [], 0);
    expect(r.x).toEqual([3, 4]);
    expect(r.y).toEqual([5, 6]);
  });
});
