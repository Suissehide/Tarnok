import type { BonusKind } from '@shared/shop';

/**
 * Les icones et portraits du pack, servis tels quels sous `/tinyswords/`, et
 * l'emplacement d'objet que HUD, menu et etalage partagent.
 *
 * ⚠️ **Les correspondances sont un choix d'affichage, pas un sens du pack** :
 * il n'a que douze icones generiques. Une icone par CLE de bonus — la meme
 * dans la boutique, sur une carte de passif et dans le HUD — c'est ce qui
 * compte pour la lecture.
 */
const UIE = '/tinyswords/UI%20Elements/UI%20Elements/';

export const icon = (n: number): string => `${UIE}Icons/Icon_${String(n).padStart(2, '0')}.png`;

/** Le portrait d'un joueur : un par slot, le meme partout (salon, HUD, bilan). */
export const avatar = (playerId: number): string =>
  `${UIE}Human%20Avatars/Avatars_${String(playerId).padStart(2, '0')}.png`;

export const ICON_GOLD = icon(3);
export const ICON_WEAPON = icon(5);

const BONUS_ICONS: Record<BonusKind, number> = {
  damage: 5,
  armor: 6,
  maxHp: 4,
  regen: 7,
  speed: 8,
  pickupRadius: 2,
  fireRate: 10,
  xp: 11,
  gold: 3,
};

export const bonusIcon = (kind: BonusKind): string => icon(BONUS_ICONS[kind]);

/**
 * Un emplacement : cadre `paperx` (objets) ou `carved` (passifs), icone au
 * centre, compte d'empilements en coin. `null` : emplacement vide.
 */
export function slot(
  frame: 'paperx' | 'carved',
  sizeClass: string,
  content: { src: string; count: number; title: string } | null,
): HTMLElement {
  const box = document.createElement('div');
  box.className = `k k-${frame} slot ${sizeClass}`;
  if (content) {
    box.title = content.title;
    const img = document.createElement('img');
    img.src = content.src;
    img.alt = content.title;
    img.style.width = '60%';
    img.style.height = '60%';
    const count = document.createElement('span');
    count.className = 'slot__count f-jer ol';
    count.textContent = `${content.count}`;
    box.append(img, count);
  }
  return box;
}
