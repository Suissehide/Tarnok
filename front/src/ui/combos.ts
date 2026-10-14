/**
 * Le panneau d'aide des combinaisons d'elements : une ligne par reaction,
 * `[icone A] + [icone B] → Nom : effet`.
 *
 * ⚠️ **Les textes d'effet sont DERIVES de `shared/reactions.ts`** (les champs
 * et commentaires de chaque ligne de `REACTION_DEFS`), jamais inventes, et
 * sans chiffre : les reglages bougent, la phrase doit rester vraie.
 *
 * ⚠️ **Une ligne de PLUS que `REACTION_DEFS` : le Choc thermique (Braise +
 * Givre).** Cette paire est volontairement ABSENTE de la table — elle rend
 * le comportement generique (`REACTION_DAMAGE` dans `REACTION_RADIUS`, voir
 * l'en-tete de `shared/reactions.ts`) — mais elle reagit bel et bien en jeu :
 * l'aide doit la montrer. Elle porte `REACTION.AUCUNE` (0), le nibble que
 * `postZone` pose justement pour une paire sans effet specifique.
 */

import { ELEMENT } from '@shared/elements';
import { REACTION, REACTION_DEFS } from '@shared/reactions';
import { NEUTRE_MARQUE_AMP } from '@shared/weapons';

import { elementBadge } from './element-icons';

interface ReactionHelp {
  a: number;
  b: number;
  title: string;
  effect: string;
}

const HELP: Record<number, ReactionHelp> = {
  [REACTION.AUCUNE]: {
    a: ELEMENT.BRAISE,
    b: ELEMENT.GIVRE,
    title: 'Choc thermique',
    effect: 'Dégâts en zone autour de l’impact.',
  },
  [REACTION.SURCHAUFFE]: {
    a: ELEMENT.BRAISE,
    b: ELEMENT.FOUDRE,
    title: 'Surchauffe',
    effect: 'Laisse une zone qui brûle fort et longtemps.',
  },
  [REACTION.EMBRASEMENT]: {
    a: ELEMENT.BRAISE,
    b: ELEMENT.POIX,
    title: 'Embrasement',
    effect: 'Dégâts en zone sur tous les ennemis poissés.',
  },
  [REACTION.COURT_CIRCUIT]: {
    a: ELEMENT.FOUDRE,
    b: ELEMENT.POIX,
    title: 'Court-circuit',
    effect: 'Chaîne sans limite tant que les cibles sont poissées.',
  },
  [REACTION.SUPRACONDUCTION]: {
    a: ELEMENT.GIVRE,
    b: ELEMENT.FOUDRE,
    title: 'Supraconduction',
    effect: 'Zone qui fige les ennemis et réduit leur armure.',
  },
  [REACTION.VERGLAS]: {
    a: ELEMENT.GIVRE,
    b: ELEMENT.POIX,
    title: 'Verglas',
    effect: 'Zone glissante : les ennemis dérapent et se percutent.',
  },
  [REACTION.FOURNEE]: {
    a: ELEMENT.BRAISE,
    b: ELEMENT.CHAUX,
    title: 'Fournée',
    effect: 'Zone de brûlure doublée qui annule l’armure.',
  },
  [REACTION.ECLAT_DE_GEL]: {
    a: ELEMENT.GIVRE,
    b: ELEMENT.CHAUX,
    title: 'Éclat de gel',
    effect: 'Dégâts massifs sur la cible touchée.',
  },
  [REACTION.VAPORISATION]: {
    a: ELEMENT.BRAISE,
    b: ELEMENT.VIF_ARGENT,
    title: 'Vaporisation',
    effect: 'Dégâts en zone autour de chaque ennemi lié.',
  },
  [REACTION.ARC_CAUSTIQUE]: {
    a: ELEMENT.FOUDRE,
    b: ELEMENT.CHAUX,
    title: 'Arc caustique',
    effect: 'Chaîne qui laisse une zone corrosive à chaque saut.',
  },
  [REACTION.PARATONNERRE]: {
    a: ELEMENT.FOUDRE,
    b: ELEMENT.VIF_ARGENT,
    title: 'Paratonnerre',
    effect: 'Chaîne qui saute de préférence sur les ennemis liés.',
  },
  [REACTION.GEL_PROFOND]: {
    a: ELEMENT.GIVRE,
    b: ELEMENT.VIF_ARGENT,
    title: 'Gel profond',
    effect: 'Zone qui fige les ennemis, plus longtemps.',
  },
  [REACTION.MORTIER_VIF]: {
    a: ELEMENT.POIX,
    b: ELEMENT.CHAUX,
    title: 'Mortier vif',
    effect: 'Zone qui fige les ennemis et amplifie leurs dégâts subis.',
  },
  [REACTION.AVEUGLEMENT]: {
    a: ELEMENT.CHAUX,
    b: ELEMENT.VIF_ARGENT,
    title: 'Aveuglement',
    effect: 'Zone qui fait fuir les ennemis, plus longtemps.',
  },
  [REACTION.AMALGAME]: {
    a: ELEMENT.POIX,
    b: ELEMENT.VIF_ARGENT,
    title: 'Amalgame',
    effect: 'Les dégâts sur un ennemi lié frappent ses voisins liés.',
  },
};

/** Les identifiants affiches, dans l'ordre : le Choc thermique, puis la table. */
export const COMBO_IDS: readonly number[] = [REACTION.AUCUNE, ...REACTION_DEFS.map((r) => r.id)];

export function reactionHelp(id: number): ReactionHelp {
  const help = HELP[id];
  if (!help) {
    throw new Error(`reaction sans aide : ${id}`);
  }
  return help;
}

/**
 * Remplit `root` d'une ligne par reaction. `known` : les elements que
 * l'equipe possede ; une reaction dont les DEUX elements y sont est mise en
 * avant (`data-active="true"`), les autres attenuees.
 */
export function renderCombos(root: HTMLElement, known: ReadonlySet<number>): void {
  root.replaceChildren(
    ...COMBO_IDS.map((id) => {
      const { a, b, title, effect } = reactionHelp(id);
      const active = known.has(a) && known.has(b);
      // Un seul des deux elements tenu : la reaction qu'un allie peut completer.
      // Elle reste lisible ; seules celles ou l'equipe n'a rien s'attenuent.
      const partial = !active && (known.has(a) || known.has(b));
      const row = document.createElement('div');
      row.className = 'combo flex items-center gap-[6px] text-[19px] leading-[1.3]';
      row.dataset.reaction = String(id);
      row.dataset.active = String(active);
      row.dataset.partial = String(partial);

      const plus = document.createElement('span');
      plus.className = 'f-jer ol';
      plus.textContent = '+';
      const arrow = document.createElement('span');
      arrow.className = 'f-jer ol';
      arrow.textContent = '→';

      const text = document.createElement('span');
      text.className = 'min-w-0';
      const name = document.createElement('span');
      name.className = 'f-meta ol';
      name.textContent = title;
      text.append(name, ` : ${effect}`);

      row.append(elementBadge(a, 24), plus, elementBadge(b, 24), arrow, text);
      return row;
    }),
    neutreRow(),
  );
}

/** Ce que fait une arme neutre, dit au salon comme en jeu. */
export const NEUTRE_HELP = `+${Math.round((NEUTRE_MARQUE_AMP - 1) * 100)} % de dégâts sur un ennemi marqué`;

/** La derniere ligne : le neutre ne combine rien, il amplifie ce que l'equipe marque. */
function neutreRow(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'combo-neutre flex items-center gap-[6px] text-[19px] leading-[1.3]';
  const name = document.createElement('span');
  name.className = 'f-meta ol';
  name.textContent = 'Neutre';
  const text = document.createElement('span');
  text.className = 'min-w-0';
  text.append(name, ` : ${NEUTRE_HELP}`);
  row.append(elementBadge(ELEMENT.NEUTRE, 24), text);
  return row;
}
