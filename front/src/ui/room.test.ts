// @vitest-environment jsdom
import { CLASSES, DEFAULT_CLASS_ID } from '@shared/classes';
import { ELEMENTS } from '@shared/elements';
import { MSG, NO_WEAPON } from '@shared/protocol';
import { BASE_WEAPON_ID, startingWeapons, WEAPONS, weaponOf } from '@shared/weapons';
import { describe, expect, it } from 'vitest';

import indexHtml from '../../index.html?raw';
import { type RoomElements, type RoomStep, renderClasses, renderRoom, renderWeapons } from './room';

function cases(): RoomElements {
  return {
    players: document.createElement('ul'),
    stepClass: document.createElement('button'),
    stepWeapon: document.createElement('button'),
    classes: document.createElement('div'),
    weapons: document.createElement('div'),
    start: document.createElement('button'),
    hint: document.createElement('p'),
  };
}

const arme = startingWeapons()[0] as number;
const lobby = (you: number) => ({
  type: MSG.LOBBY,
  you,
  players: [
    { playerId: 1, weaponId: NO_WEAPON, classId: 1 },
    { playerId: 2, weaponId: arme, classId: 3 },
  ],
});
const rien = (): void => undefined;

describe('etape 8 tache 8 : le choix de classe a l ecran', () => {
  it('affiche les quatre classes, avec leur verbe', () => {
    const racine = document.createElement('div');
    renderClasses(racine, DEFAULT_CLASS_ID, rien);
    expect(racine.querySelectorAll('[data-classe]').length).toBe(CLASSES.length);
    for (const c of CLASSES) {
      expect(racine.textContent).toContain(c.label);
    }
  });

  it('marque la classe choisie, et une seule', () => {
    const racine = document.createElement('div');
    renderClasses(racine, 2, rien);
    const choisies = racine.querySelectorAll('[data-choisie="true"]');
    expect(choisies.length).toBe(1);
    expect((choisies[0] as HTMLElement).dataset.classe).toBe('2');
  });

  it('un clic rend l identifiant de la classe cliquee', () => {
    const racine = document.createElement('div');
    const vus: number[] = [];
    renderClasses(racine, DEFAULT_CLASS_ID, (id) => vus.push(id));
    racine.querySelector<HTMLElement>('[data-classe="3"]')?.click();
    expect(vus).toEqual([3]);
  });

  it('les doublons ne sont PAS interdits a l ecran', () => {
    // Deux joueurs sur la meme classe : les deux lignes restent cliquables.
    const racine = document.createElement('div');
    renderClasses(racine, DEFAULT_CLASS_ID, rien, [0, 0]);
    for (const el of racine.querySelectorAll('button[data-classe]')) {
      expect((el as HTMLButtonElement).disabled).toBe(false);
    }
    expect(racine.querySelector('[data-classe="0"]')?.textContent).toContain('2 alliés');
  });

  /**
   * Le CABLAGE, pas seulement la logique : `main.ts` cherche ces identifiants
   * dans le vrai `index.html`, et un ecran parfait branche sur un `id`
   * inexistant est vert et mort (doctrine de `hud.test.ts`).
   */
  it('trouve dans index.html les cases que main.ts va chercher', () => {
    document.body.innerHTML = indexHtml;
    for (const id of [
      'room-players',
      'room-step-class',
      'room-step-weapon',
      'room-classes',
      'room-weapons',
      'room-start',
      'room-hint',
    ]) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });
});

describe('la classe d abord, l arme ensuite', () => {
  it('a l etape classe, seules les classes sont visibles', () => {
    const els = cases();
    renderRoom(els, lobby(2), 'classe', rien, rien);
    expect(els.classes.classList.contains('hidden')).toBe(false);
    expect(els.weapons.classList.contains('hidden')).toBe(true);
    expect(els.stepClass.getAttribute('aria-pressed')).toBe('true');
  });

  it('choisir une classe envoie le couple complet, puis passe a l arme', () => {
    const els = cases();
    const choix: [number, number][] = [];
    const etapes: RoomStep[] = [];
    renderRoom(
      els,
      lobby(2),
      'classe',
      (w, c) => choix.push([w, c]),
      (s) => etapes.push(s),
    );
    els.classes.querySelector<HTMLElement>('[data-classe="1"]')?.click();
    expect(choix).toEqual([[arme, 1]]);
    expect(etapes).toEqual(['arme']);
  });

  it('choisir une arme garde la classe deja choisie', () => {
    const els = cases();
    const choix: [number, number][] = [];
    renderRoom(els, lobby(2), 'arme', (w, c) => choix.push([w, c]), rien);
    els.weapons.querySelector<HTMLElement>(`[data-weapon-id="${NO_WEAPON}"]`)?.click();
    expect(choix).toEqual([[NO_WEAPON, 3]]);
  });

  it('seul l hote peut lancer', () => {
    const els = cases();
    renderRoom(els, lobby(2), 'classe', rien, rien);
    expect(els.start.disabled).toBe(true);
    renderRoom(els, lobby(1), 'classe', rien, rien);
    expect(els.start.disabled).toBe(false);
  });
});

describe('les armes, rangees par element', () => {
  it('une famille par element, chaque arme dans la famille de son element', () => {
    const racine = document.createElement('div');
    renderWeapons(racine, NO_WEAPON, rien);
    expect(racine.querySelectorAll('.weapon-family')).toHaveLength(ELEMENTS.length);
    for (const button of racine.querySelectorAll<HTMLElement>('[data-weapon-id]')) {
      const id = Number(button.dataset.weaponId);
      const famille = button.closest<HTMLElement>('.weapon-family')?.dataset.element;
      expect(famille).toBe(`${weaponOf(id === NO_WEAPON ? BASE_WEAPON_ID : id).element}`);
    }
    // Toutes les armes, la dague comprise : aucune ne manque, aucune en double.
    expect(racine.querySelectorAll('[data-weapon-id]')).toHaveLength(WEAPONS.length);
  });

  it('marque mon arme, et la dague vaut « rien choisi »', () => {
    const racine = document.createElement('div');
    renderWeapons(racine, NO_WEAPON, rien);
    const choisie = racine.querySelector<HTMLElement>('[aria-pressed="true"]');
    expect(choisie?.dataset.weaponId).toBe(`${NO_WEAPON}`);
    expect(choisie?.textContent).toBe(weaponOf(BASE_WEAPON_ID).name);
  });
});
