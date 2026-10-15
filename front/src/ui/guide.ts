/**
 * Le Guide (ecran 18) : ce que le jeu ne dit nulle part ailleurs — les regles
 * d'empilement, les dix-neuf armes, les douze passifs, les combinaisons et les
 * quatre classes. Accessible depuis le menu principal, hors partie.
 *
 * ⚠️ **Rien n'est ECRIT ici qui vive deja dans une table.** Les noms, les
 * degats, les cadences, les bonus et les effets se DERIVENT de `shared/`
 * (`WEAPONS`, `PASSIVES`, `CLASSES`, `REACTION_DEFS`, `RARITY_MULTIPLIERS`) et
 * des libelles que les autres ecrans emploient deja (`upgradeLabel`,
 * `magnitudeLabel`, `reactionHelp`, `VERB_TEXT`, `TRAIT_TEXT`). Une page d'aide
 * qui recopierait le catalogue mentirait a la premiere retouche d'equilibrage —
 * et personne ne pense a mettre a jour une aide.
 *
 * Les onglets reutilisent `showTab` de l'ecran d'options : meme contrat
 * `[data-tab]` / `[data-panel]` dans le HTML, donc aucun mecanisme de plus.
 */

import { CARD } from '@shared/cards';
import { CLASSES } from '@shared/classes';
import { TICK_HZ, WEAPON_SLOTS } from '@shared/constants';
import { ELEMENT } from '@shared/elements';
import { PASSIVES } from '@shared/passives';
import { RARITY_MULTIPLIERS } from '@shared/rarity';
import { WEAPONS, type Weapon, type WeaponKind } from '@shared/weapons';

import { COMBO_IDS, NEUTRE_HELP, reactionHelp } from './combos';
import { magnitudeLabel, RARITY_NAMES, upgradeLabel } from './draft';
import { elementBadge, elementLabel } from './element-icons';
import { bonusIcon } from './icons';
import { showTab } from './options';
import { TRAIT_TEXT, VERB_TEXT } from './room';

/** L'onglet ouvert a chaque entree dans le Guide. */
export const GUIDE_FIRST_TAB = 'bases';

/** Le nom de chaque famille d'arme. */
const KIND_TEXT: Readonly<Record<WeaponKind, string>> = {
  tir: 'Tir',
  halo: 'Halo',
  faisceau: 'Faisceau',
  invocation: 'Invocation',
  onde: 'Onde',
  frappe: 'Frappe',
};

/**
 * Ce que chaque famille FAIT, en une phrase et sans chiffre (meme discipline
 * que les effets de `combos.ts` : les reglages bougent, la phrase doit rester
 * vraie). Derive des en-tetes de `WeaponKind` et des armes concernees.
 */
const KIND_HELP: Readonly<Record<WeaponKind, string>> = {
  tir: 'Des projectiles partent vers la cible.',
  halo: 'Un cercle autour de vous, qui frappe à chaque pulsation — rien ne part.',
  faisceau: 'Un trait tenu, qui fauche tout ce qui se trouve sur sa ligne.',
  invocation: 'Un corps posé au sol, qui frappe autour de lui jusqu’à sa fin.',
  onde: 'Un anneau part de vous et s’élargit, frappant tout ce qu’il franchit.',
  frappe: 'Des éclairs tombent du ciel sur les ennemis visés, après un court avertissement.',
};

/**
 * Ce que la cadence COMPTE, par famille, AU SINGULIER (`cadence` accorde).
 *
 * ⚠️ **`cooldownTicks` ne mesure pas la meme chose d'une famille a l'autre** :
 * une salve pour un tir, une pulsation pour un halo, une pose pour une
 * invocation. Ecrire « tirs/s » partout dirait qu'un Encensoir lance des
 * projectiles, ce qu'il ne fait pas.
 */
const RATE_WORD: Readonly<Record<WeaponKind, string>> = {
  tir: 'salve',
  halo: 'pulsation',
  faisceau: 'passe',
  invocation: 'pose',
  onde: 'onde',
  frappe: 'frappe',
};

/** La forme d'un tir qui ne va pas droit (etape 12). */
const MOTION_TEXT: Readonly<Partial<Record<NonNullable<Weapon['motion']>, string>>> = {
  orbite: 'Tourne autour de vous',
  boomerang: 'Revient vers vous',
  mortier: 'Passe au-dessus de la horde, explose à l’arrivée',
  sinus: 'Ondule en vol',
};

const WEAPON_KINDS = Object.keys(KIND_TEXT) as WeaponKind[];

/** Au plus une decimale, virgule francaise : une cadence se lit « 7,5 », pas « 7.5 ». */
const nombre = (n: number): string => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

/**
 * La cadence, accordee. Le pluriel francais ne part qu'a DEUX : « 1,3 salve/s »
 * et « 2,5 salves/s » — et la moitie du catalogue tire a moins d'un coup par
 * seconde, donc « 1 salves/s » se lisait sur la moitie de l'ecran.
 */
const cadence = (weapon: Weapon): string => {
  const parSeconde = TICK_HZ / weapon.cooldownTicks;
  return `${nombre(parSeconde)} ${RATE_WORD[weapon.kind]}${parSeconde >= 2 ? 's' : ''}/s`;
};

/** Une entree du Guide : un intitule, des lignes de contexte, des lignes de fond. */
function entry(head: (string | Node)[], meta: string[], lines: string[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'guide-entry';
  const title = document.createElement('span');
  title.className = 'guide-entry__head f-meta';
  title.append(...head);
  row.append(title);
  for (const [className, texts] of [
    ['guide-entry__meta', meta],
    ['guide-entry__line', lines],
  ] as const) {
    for (const text of texts) {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      row.append(span);
    }
  }
  return row;
}

/**
 * Ce que l'arme sait faire SANS carte : seulement ce qui sort de l'ordinaire,
 * donc la ligne vide est le cas courant (seize armes sur dix-neuf n'ont ni
 * perforation, ni souffle, ni ricochet, ni guidage).
 */
export function weaponTraits(weapon: Weapon): string[] {
  const traits: string[] = [];
  if (weapon.pierce > 0) {
    traits.push(`Transperce ${weapon.pierce} ennemi${weapon.pierce > 1 ? 's' : ''}`);
  }
  // Pour un halo, un faisceau ou une invocation, `blastRadius` EST la portee :
  // l'annoncer comme une explosion serait faux.
  if (weapon.kind === 'tir' && weapon.blastRadius > 0) {
    traits.push('Explose à l’impact');
  }
  if (weapon.bounces > 0) {
    traits.push(`Ricoche ${weapon.bounces} fois`);
  }
  if (weapon.homing > 0) {
    traits.push('Guidé');
  }
  // `projectileCount` est inerte hors des tirs (voir le catalogue).
  if (weapon.kind === 'tir' && weapon.projectileCount > 1) {
    traits.push(`${weapon.projectileCount} projectiles par salve`);
  }
  // La forme du tir (etape 12) : ce qui distingue une arme des autres au premier regard.
  const forme = weapon.motion ? MOTION_TEXT[weapon.motion] : undefined;
  if (forme) {
    traits.push(forme);
  }
  if (weapon.emission === 'spirale') {
    traits.push('Tire en spirale autour de vous');
  }
  if ((weapon.fragments ?? 0) > 0) {
    traits.push(`Éclate en ${weapon.fragments} éclats`);
  }
  if ((weapon.growth ?? 0) > 0) {
    traits.push('Grossit en vol');
  }
  if (weapon.kind === 'frappe' && weapon.projectileCount > 1) {
    traits.push(`${weapon.projectileCount} éclairs par frappe`);
  }
  return traits;
}

/** Les dix-neuf armes, rangees par element puis par ordre de catalogue. */
export function renderGuideWeapons(root: HTMLElement): void {
  root.replaceChildren(
    ...[...WEAPONS]
      .sort((a, b) => a.element - b.element || a.id - b.id)
      .map((weapon) => {
        const traits = weaponTraits(weapon);
        const cartes = weapon.perks.map((upgrade) =>
          upgradeLabel({ nature: CARD.WEAPON, refId: weapon.id, upgrade }),
        );
        const row = entry(
          [elementBadge(weapon.element, 24), weapon.name],
          [
            `${elementLabel(weapon.element)} · ${KIND_TEXT[weapon.kind]}`,
            `${weapon.damage} dégâts · ${cadence(weapon)}`,
          ],
          [...(traits.length > 0 ? [traits.join(' · ')] : []), `Cartes : ${cartes.join(', ')}`],
        );
        row.dataset.weaponId = String(weapon.id);
        return row;
      }),
  );
}

/** Les passifs, l'empilement dit sur chacun — c'est la regle qui compte. */
export function renderGuidePassives(root: HTMLElement): void {
  root.replaceChildren(
    ...PASSIVES.map((passive) => {
      const img = document.createElement('img');
      img.src = bonusIcon(passive.kind);
      img.alt = '';
      img.className = 'h-[28px] w-[28px]';
      // L'empilement est la regle de TOUS les passifs, et l'onglet « Bases »
      // la pose une fois : la repeter douze fois noierait la seule ligne qui
      // distingue vraiment une carte, celle de l'exception legendaire.
      const row = entry(
        [img, passive.label],
        passive.legendary
          ? ['Légendaire — ne sort que sur un emplacement légendaire, et s’applique une fois']
          : [],
        [`${magnitudeLabel(passive)} par carte`],
      );
      row.dataset.passiveId = String(passive.id);
      return row;
    }),
  );
}

/** Les combinaisons, effet VISIBLE — en jeu l'aide est compacte et le cache au survol. */
export function renderGuideCombos(root: HTMLElement): void {
  const neutre = entry(
    [elementBadge(ELEMENT.NEUTRE, 24), 'Neutre'],
    ['Ne combine rien'],
    [`${NEUTRE_HELP}.`],
  );
  neutre.dataset.reaction = 'neutre';
  root.replaceChildren(
    ...COMBO_IDS.map((id) => {
      const { a, b, title, effect } = reactionHelp(id);
      const plus = document.createElement('span');
      plus.textContent = '+';
      const row = entry(
        [elementBadge(a, 24), plus, elementBadge(b, 24), title],
        [`${elementLabel(a)} + ${elementLabel(b)}`],
        [effect],
      );
      row.dataset.reaction = String(id);
      return row;
    }),
    neutre,
  );
}

/** Les quatre classes : leur verbe et leur trait, les memes textes qu'au salon. */
export function renderGuideClasses(root: HTMLElement): void {
  root.replaceChildren(
    ...CLASSES.map((c) => {
      const row = entry(
        [c.label],
        ['Verbe — touche ESPACE'],
        [VERB_TEXT[c.verb], `Trait : ${TRAIT_TEXT[c.trait]}`],
      );
      row.dataset.classe = String(c.id);
      return row;
    }),
  );
}

/** Les regles que rien n'affiche en jeu, chacune derivee de sa constante. */
export function guideRules(): { titre: string; lignes: string[] }[] {
  return [
    {
      titre: 'Tout s’empile',
      lignes: [
        'Une carte prise ajoute un exemplaire : ni les armes ni les passifs ne montent de niveau.',
        'C’est l’accumulation qui fait la puissance — et une carte déjà possédée reste convoitée.',
      ],
    },
    {
      titre: 'Emplacements',
      lignes: [
        `${WEAPON_SLOTS} armes au maximum. Les passifs, eux, ne sont pas limités.`,
        'Empiler ce que vous possédez déjà ne prend aucun emplacement de plus.',
      ],
    },
    {
      titre: 'Rareté',
      lignes: [
        RARITY_MULTIPLIERS.map((m, r) => `${RARITY_NAMES[r]} ×${m}`).join(' · '),
        'Une carte s’applique autant de fois que son multiplicateur.',
      ],
    },
    {
      titre: 'Éléments',
      lignes: [
        'Une arme élémentaire marque l’ennemi touché et laisse une zone de son élément.',
        'Deux éléments différents sur la même cible déclenchent une combinaison.',
      ],
    },
    {
      titre: 'Armes neutres',
      lignes: ['Elles ne marquent rien et ne posent aucune zone.', `${NEUTRE_HELP}.`],
    },
    {
      titre: 'Familles d’armes',
      lignes: WEAPON_KINDS.map((k) => `${KIND_TEXT[k]} — ${KIND_HELP[k]}`),
    },
    {
      titre: 'Synergie',
      lignes: [
        'La jauge du haut monte quand deux joueurs différents déclenchent une réaction ensemble.',
      ],
    },
  ];
}

function renderGuideRules(root: HTMLElement): void {
  root.replaceChildren(...guideRules().map((r) => entry([r.titre], [], r.lignes)));
}

const panel = (root: HTMLElement, id: string): HTMLElement => {
  const found = root.querySelector<HTMLElement>(`#${id}`);
  if (!found) {
    throw new Error(`guide : ${id} absent du HTML`);
  }
  return found;
};

/** Remplit les cinq panneaux depuis les catalogues. Rien ne depend d'une partie. */
export function renderGuide(root: HTMLElement): void {
  renderGuideRules(panel(root, 'guide-bases'));
  renderGuideWeapons(panel(root, 'guide-weapons'));
  renderGuidePassives(panel(root, 'guide-passives'));
  renderGuideCombos(panel(root, 'guide-combos'));
  renderGuideClasses(panel(root, 'guide-classes'));
}

/**
 * Peint et branche l'ecran, une fois pour toutes : le contenu ne bouge jamais,
 * donc aucune raison de le repeindre a chaque ouverture.
 */
export function wireGuide(root: HTMLElement): void {
  renderGuide(root);
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    b.addEventListener('click', () => showTab(root, b.dataset.tab ?? GUIDE_FIRST_TAB));
  }
  showTab(root, GUIDE_FIRST_TAB);
}
