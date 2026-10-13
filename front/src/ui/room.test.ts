// @vitest-environment jsdom
import { MSG, NO_WEAPON } from '@shared/protocol';
import { startingWeapons } from '@shared/weapons';
import { describe, expect, it } from 'vitest';

import { type RoomElements, renderRoom } from './room';

function cases(): RoomElements {
  return {
    players: document.createElement('ul'),
    weapons: document.createElement('div'),
    start: document.createElement('button'),
    hint: document.createElement('p'),
  };
}

describe('salle d attente', () => {
  const arme = startingWeapons()[0] as number;
  const lobby = {
    type: MSG.LOBBY,
    you: 2,
    players: [
      { playerId: 1, weaponId: NO_WEAPON, classId: 0 },
      { playerId: 2, weaponId: arme, classId: 0 },
    ],
  } as const;

  it('seul l hote peut lancer', () => {
    const els = cases();
    renderRoom(els, { ...lobby, players: [...lobby.players] }, () => undefined);
    expect(els.start.disabled).toBe(true);
    renderRoom(els, { ...lobby, you: 1, players: [...lobby.players] }, () => undefined);
    expect(els.start.disabled).toBe(false);
  });

  it('marque mon choix et rend le clic', () => {
    const els = cases();
    const clics: number[] = [];
    renderRoom(els, { ...lobby, players: [...lobby.players] }, (w) => clics.push(w));
    const choisi = els.weapons.querySelector('[aria-pressed="true"]') as HTMLButtonElement;
    expect(choisi.dataset.weaponId).toBe(String(arme));
    expect(els.weapons.children).toHaveLength(startingWeapons().length + 1);
    (els.weapons.firstElementChild as HTMLButtonElement).click();
    expect(clics).toEqual([NO_WEAPON]);
  });
});
