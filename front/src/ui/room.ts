import { CLASSES, classOf, DEFAULT_CLASS_ID, type TraitKind, type VerbKind } from '@shared/classes';
import { MAX_PLAYERS } from '@shared/constants';
import { ELEMENT, ELEMENTS } from '@shared/elements';
import { type LobbyMessage, NO_WEAPON } from '@shared/protocol';
import { BASE_WEAPON_ID, startingWeapons, weaponOf } from '@shared/weapons';

import { NEUTRE_HELP } from './combos';
import { playerColor } from './draft';
import { elementBadge, elementLabel } from './element-icons';
import { avatar } from './icons';

/** Les cases de la salle d'attente, cherchees une fois par `main.ts`. */
export interface RoomElements {
  players: HTMLElement;
  /** Les onglets des deux etapes : la classe, puis l'arme. */
  stepClass: HTMLButtonElement;
  stepWeapon: HTMLButtonElement;
  classes: HTMLElement;
  weapons: HTMLElement;
  start: HTMLButtonElement;
  hint: HTMLElement;
}

/**
 * **La classe d'abord, l'arme ensuite** — deux etapes, jamais les deux d'un
 * coup. La classe donne le verbe (le role dans l'equipe), l'arme donne
 * l'element : choisir le role avant l'element, c'est negocier la couverture
 * avant les reactions.
 */
export type RoomStep = 'classe' | 'arme';

/** Ce que fait le verbe de chaque classe, en une phrase (§6 de la spec de l'etape 8). */
export const VERB_TEXT: Readonly<Record<VerbKind, string>> = {
  amorce: 'Pose l’élément de votre arme en zone, sans dégâts.',
  rempart: 'Pose une zone où les alliés encaissent moins.',
  appat: 'Plante un leurre que les monstres ciblent.',
  relais: 'Se téléporte vers un allié, ou l’attire à soi.',
};

/** Ce que change le trait : une regle, jamais un nombre (§6.1). */
export const TRAIT_TEXT: Readonly<Record<TraitKind, string>> = {
  residuPartout: 'Toute réaction déclenchée dans vos zones laisse un effet au sol.',
  remparteAllie: 'Votre protection couvre aussi l’allié adjacent.',
  leurreElementaire: 'Votre leurre porte l’élément de votre arme.',
  relaisIntangible: 'L’allié rejoint est brièvement intangible.',
};

/** Une seule arme au depart : la dague tant que rien n'est choisi, sinon l'arme choisie. */
export const weaponLabel = (weaponId: number): string =>
  weaponOf(weaponId === NO_WEAPON ? BASE_WEAPON_ID : weaponId).name;

/**
 * Etape 1 : les quatre classes, leur verbe et leur trait.
 *
 * ⚠️ **Les doublons sont libres** (§4 de la spec) : rien n'est desactive parce
 * qu'un autre joueur a pris la meme classe. `others` ne sert qu'a l'afficher —
 * la negociation porte sur la couverture, « deux Remparts et aucune Amorce ».
 */
export function renderClasses(
  root: HTMLElement,
  chosen: number,
  onPick: (classId: number) => void,
  others: readonly number[] = [],
): void {
  root.replaceChildren(
    ...CLASSES.map((c) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'k k-paperx class-card';
      card.dataset.classe = `${c.id}`;
      card.dataset.choisie = c.id === chosen ? 'true' : 'false';

      const head = document.createElement('span');
      head.className = 'flex items-center justify-between gap-[8px]';
      const name = document.createElement('span');
      name.className = 'class-card__name f-meta ol';
      name.textContent = c.label;
      head.append(name);
      const deja = others.filter((id) => id === c.id).length;
      if (deja > 0) {
        const tag = document.createElement('span');
        tag.className = 'class-card__taken';
        tag.textContent = deja === 1 ? 'déjà prise par 1 allié' : `déjà prise par ${deja} alliés`;
        head.append(tag);
      }

      const verb = document.createElement('span');
      verb.className = 'class-card__verb';
      verb.textContent = VERB_TEXT[c.verb];
      const trait = document.createElement('span');
      trait.className = 'class-card__trait';
      trait.textContent = `Trait : ${TRAIT_TEXT[c.trait]}`;

      card.append(head, verb, trait);
      card.addEventListener('click', () => onPick(c.id));
      return card;
    }),
  );
}

/**
 * Etape 2 : les armes, **rangees par element**, chaque famille annoncee par
 * son icone et sa couleur. La dague est la premiere arme neutre : la choisir,
 * c'est ne rien choisir (`NO_WEAPON`).
 */
export function renderWeapons(
  root: HTMLElement,
  chosen: number,
  onPick: (weaponId: number) => void,
): void {
  const ids = [BASE_WEAPON_ID, ...startingWeapons()];
  root.replaceChildren(
    ...ELEMENTS.map((element) => {
      const row = document.createElement('div');
      row.className = 'weapon-family';
      row.dataset.element = `${element.id}`;
      row.style.setProperty('--tint', `#${element.tint.toString(16).padStart(6, '0')}`);
      // Une teinte sombre (la Poix) se confond avec le contour sombre : elle
      // prend un contour clair.
      const r = (element.tint >> 16) & 0xff;
      const g = (element.tint >> 8) & 0xff;
      const b = element.tint & 0xff;
      row.dataset.dark = 0.299 * r + 0.587 * g + 0.114 * b < 96 ? 'true' : 'false';

      const head = document.createElement('span');
      head.className = 'weapon-family__head';
      const label = document.createElement('span');
      label.className = 'f-meta ol';
      label.textContent = elementLabel(element.id);
      head.append(elementBadge(element.id, 32), label);

      const list = document.createElement('span');
      list.className = 'weapon-family__list';
      for (const id of ids.filter((w) => weaponOf(w).element === element.id)) {
        const value = id === BASE_WEAPON_ID ? NO_WEAPON : id;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn--tab room-weapon ol';
        button.dataset.weaponId = `${value}`;
        button.setAttribute('aria-pressed', value === chosen ? 'true' : 'false');
        button.textContent = weaponOf(id).name;
        button.title = `${weaponOf(id).name} — ${elementLabel(element.id)}`;
        button.addEventListener('click', () => onPick(value));
        list.append(button);
      }
      row.append(head, list);
      if (element.id === ELEMENT.NEUTRE) {
        const note = document.createElement('span');
        note.className = 'weapon-family__note';
        note.textContent = `Ne combine rien : ${NEUTRE_HELP}.`;
        row.append(note);
      }
      return row;
    }),
  );
}

/**
 * Peint la salle d'attente (ecran 14 de la maquette) depuis le dernier `LOBBY`.
 *
 * L'hote est le premier de la liste (le serveur la trie par slot) : seul lui
 * voit « Lancer » actif. Chaque choix renvoie le couple complet (arme,
 * classe), puisque `PICK` porte les deux.
 */
export function renderRoom(
  els: RoomElements,
  lobby: LobbyMessage,
  step: RoomStep,
  onPick: (weaponId: number, classId: number) => void,
  onStep: (step: RoomStep) => void,
): void {
  const hoteId = lobby.players[0]?.playerId;
  const moi = lobby.players.find((p) => p.playerId === lobby.you);
  const monArme = moi?.weaponId ?? NO_WEAPON;
  const maClasse = moi?.classId ?? DEFAULT_CLASS_ID;

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
    const classe = document.createElement('span');
    classe.className = 'room-player__class f-meta';
    classe.textContent = classOf(p.classId)?.label ?? '—';
    const arme = document.createElement('span');
    arme.className = 'room-player__weapon flex items-center gap-[6px]';
    const armeId = p.weaponId === NO_WEAPON ? BASE_WEAPON_ID : p.weaponId;
    arme.append(elementBadge(weaponOf(armeId).element, 22), weaponLabel(p.weaponId));
    const hote = p.playerId === hoteId;
    const tag = document.createElement('span');
    tag.className = `srib ${hote ? 'srib--yellow' : ''} room-player__tag ol`;
    tag.textContent = hote ? 'Hôte' : 'Joueur';
    body.append(name, classe, arme, tag);

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

  // Les deux etapes : un onglet chacune, l'etape courante seule visible.
  els.stepClass.setAttribute('aria-pressed', step === 'classe' ? 'true' : 'false');
  els.stepWeapon.setAttribute('aria-pressed', step === 'arme' ? 'true' : 'false');
  els.stepClass.textContent = 'Classes';
  els.stepWeapon.textContent = 'Armes';
  els.stepClass.onclick = () => onStep('classe');
  els.stepWeapon.onclick = () => onStep('arme');
  els.classes.classList.toggle('hidden', step !== 'classe');
  els.weapons.classList.toggle('hidden', step !== 'arme');

  const autres = lobby.players.filter((p) => p.playerId !== lobby.you).map((p) => p.classId);
  renderClasses(
    els.classes,
    maClasse,
    (classId) => {
      onPick(monArme, classId);
      // La classe choisie, on passe a l'arme.
      onStep('arme');
    },
    autres,
  );
  renderWeapons(els.weapons, monArme, (weaponId) => onPick(weaponId, maClasse));

  const hote = lobby.you === hoteId;
  els.start.disabled = !hote;
  els.hint.textContent = hote
    ? 'Choisissez votre classe, puis votre arme, et lancez quand tout le monde est là.'
    : 'Choisissez votre classe, puis votre arme. L’hôte lance la partie.';
}
