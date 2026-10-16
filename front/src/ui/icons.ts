import type { PassiveKind } from '@shared/passives';
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

/**
 * Les portraits du pack vont par cinq, une couleur par rangee : bleu, rouge,
 * jaune, violet, noir. La rangee de chaque joueur, dans l'ordre de `UNIT_COLORS`
 * (jaune, bleu, rouge, violet).
 */
const AVATAR_ROW_OF_PLAYER = [2, 0, 1, 3] as const;
/** Le portrait de chaque classe dans sa rangee, comme `UNIT_OF_CLASS` : Archer, Warrior, Lancer, Monk. */
const AVATAR_OF_CLASS = [2, 0, 1, 3] as const;

/** Le portrait d'un joueur : la tete de son unite, dans sa couleur — le meme partout (salon, HUD, bilan). */
export const avatar = (playerId: number, classId: number): string => {
  const row = AVATAR_ROW_OF_PLAYER[(playerId - 1 + 4) % 4] ?? 0;
  const n = row * 5 + (AVATAR_OF_CLASS[classId] ?? AVATAR_OF_CLASS[0]) + 1;
  return `${UIE}Human%20Avatars/Avatars_${String(n).padStart(2, '0')}.png`;
};

export const ICON_GOLD = icon(3);
export const ICON_WEAPON = icon(5);

const BONUS_ICONS: Record<BonusKind | PassiveKind, number> = {
  damage: 5,
  armor: 6,
  maxHp: 4,
  regen: 7,
  speed: 8,
  pickupRadius: 2,
  fireRate: 10,
  xp: 11,
  gold: 3,
  // Etape 10 : un choix d'affichage, comme le reste (douze icones en tout).
  critChance: 9,
  critDamage: 9,
  salvo: 12,
  zone: 1,
  echo: 12,
  colossus: 4,
};

export const bonusIcon = (kind: BonusKind | PassiveKind): string => icon(BONUS_ICONS[kind]);

/**
 * Un emplacement a l'echelle 1, icone au centre, compte d'empilements en coin
 * (`count: null` : aucun) ; `null` : emplacement vide.
 *
 * - `'carved'` : la case de bois du pack, 64 x 64 (`.slot-tile`) — passifs ;
 * - `'paperx'` : la case ardoise, 88 x 87 (`.slot-x`) — armes, comme la maquette.
 */
export function slot(
  className: string,
  content: { src: string; count: number | null; title: string } | null,
  frame: 'carved' | 'paperx' = 'carved',
): HTMLElement {
  const box = document.createElement('div');
  box.className = `${frame === 'paperx' ? 'slot-x' : 'slot-tile'} ${className}`.trim();
  if (content) {
    box.title = content.title;
    const img = document.createElement('img');
    img.src = content.src;
    img.alt = content.title;
    img.className = frame === 'paperx' ? 'h-[52px] w-[52px]' : 'h-[44px] w-[44px]';
    box.append(img);
    if (content.count !== null) {
      const count = document.createElement('span');
      count.className = 'slot__count f-jer ol';
      count.textContent = `${content.count}`;
      box.append(count);
    }
  }
  return box;
}
