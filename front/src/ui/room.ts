import { MAX_PLAYERS } from '@shared/constants';
import { elementOf } from '@shared/elements';
import { type LobbyMessage, NO_WEAPON } from '@shared/protocol';
import { startingWeapons, weaponOf } from '@shared/weapons';

import { playerColor } from './draft';
import { avatar } from './icons';

/** Les cases de la salle d'attente, cherchees une fois par `main.ts`. */
export interface RoomElements {
  players: HTMLElement;
  weapons: HTMLElement;
  start: HTMLButtonElement;
  hint: HTMLElement;
}

const weaponLabel = (weaponId: number): string =>
  weaponId === NO_WEAPON ? 'Dague seule' : `Dague + ${weaponOf(weaponId).name}`;

/**
 * Peint la salle d'attente (ecran 14 de la maquette) depuis le dernier `LOBBY`.
 *
 * L'hote est le premier de la liste (le serveur la trie par slot) : seul lui
 * voit « Lancer » actif. Les armes proposees sont `startingWeapons`, la meme
 * regle que le serveur applique a `PICK`. Les places libres restent visibles :
 * c'est ce qui dit qu'on peut encore inviter.
 */
export function renderRoom(
  els: RoomElements,
  lobby: LobbyMessage,
  onPick: (weaponId: number) => void,
): void {
  const hoteId = lobby.players[0]?.playerId;
  const moi = lobby.players.find((p) => p.playerId === lobby.you);

  const cards: HTMLElement[] = lobby.players.map((p) => {
    const card = document.createElement('li');
    card.className = 'k k-banner room-player';
    card.dataset.local = p.playerId === lobby.you ? 'true' : 'false';

    const portrait = document.createElement('div');
    portrait.className = 'k k-paperx room-player__portrait';
    const img = document.createElement('img');
    img.src = avatar(p.playerId);
    img.alt = '';
    img.className = 'h-[96px] w-[96px]';
    portrait.append(img);

    const body = document.createElement('div');
    body.className = 'flex flex-col';
    const name = document.createElement('span');
    name.className = 'room-player__name ol';
    name.textContent = `Joueur ${p.playerId}${p.playerId === lobby.you ? ' (vous)' : ''}`;
    // Le nom porte la couleur du joueur, comme ses jetons de draft.
    name.style.color = playerColor(p.playerId);
    const arme = document.createElement('span');
    arme.className = 'room-player__weapon';
    arme.textContent = weaponLabel(p.weaponId);
    const hote = p.playerId === hoteId;
    const tag = document.createElement('span');
    tag.className = `srib ${hote ? 'srib--yellow' : ''} room-player__tag ol`;
    tag.textContent = hote ? 'Hôte' : 'Prêt';
    body.append(name, arme, tag);

    card.append(portrait, body);
    return card;
  });
  while (cards.length < MAX_PLAYERS) {
    const empty = document.createElement('li');
    empty.className = 'k k-banner room-player';
    empty.dataset.empty = 'true';
    empty.textContent = 'Emplacement libre — partagez le code';
    cards.push(empty);
  }
  els.players.replaceChildren(...cards);

  els.weapons.replaceChildren(
    ...[NO_WEAPON, ...startingWeapons()].map((weaponId) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn--tab room-weapon ol';
      button.dataset.weaponId = String(weaponId);
      button.setAttribute('aria-pressed', moi?.weaponId === weaponId ? 'true' : 'false');
      if (weaponId === NO_WEAPON) {
        // La dague est toujours tenue : ce choix-ci n'ajoute rien a cote.
        button.textContent = 'Dague seule';
        button.title = 'Arme neutre seule';
      } else {
        const w = weaponOf(weaponId);
        button.textContent = w.name;
        button.title = `${w.name} — ${elementOf(w.element).name}`;
      }
      button.addEventListener('click', () => onPick(weaponId));
      return button;
    }),
  );

  const hote = lobby.you === hoteId;
  els.start.disabled = !hote;
  els.hint.textContent = hote
    ? 'Choisissez une arme de départ, puis lancez quand tout le monde est là.'
    : 'En attente du lancement par l’hôte…';
}
