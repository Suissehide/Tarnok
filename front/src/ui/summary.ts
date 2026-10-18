import { WIPE_GOLD_KEPT } from '@shared/constants';
import { VOTE_CHOICE } from '@shared/protocol';

import type { RunOverSummary } from '../net/client';
import { formatSummary } from '../render/stage';
import { avatar } from './icons';
import { formatGold } from './portal';

/** Les cases de l'ecran de fin de run, cherchees une fois par `main.ts`. */
export interface SummaryElements {
  root: HTMLElement;
  title: HTMLElement;
  portrait: HTMLImageElement;
  name: HTMLElement;
  time: HTMLElement;
  level: HTMLElement;
  kills: HTMLElement;
  gold: HTMLElement;
  goldLabel: HTMLElement;
}

/**
 * Ce que la fin de run doit dire. **Deux fins, un seul ecran** : l'equipe a vote « partir » au dernier portail — extraction reussie,
 * l'or est acquis (`portalGold`, multiplicateur compris) — ou elle est tombee,
 * et seule la part que l'effacement laisse part sur les comptes.
 *
 * ⚠️ **`gold` est la cagnotte AVANT l'effacement** : `RUN_OVER` arrive avant
 * le snapshot qui porte l'or efface. On applique donc ici la meme regle que
 * `Room#checkRunOver` : a la defaite, l'ecran dit ce qui est PERDU.
 *
 * Le bonus « Fortune » de chacun s'ajoute ensuite, au versement (`Session`),
 * il n'est pas compte ici.
 */
export function summaryTone(
  decision: number | null,
  portalGold: number,
  gold: number,
): { victory: boolean; title: string; goldLabel: string; gold: number } {
  if (decision === VOTE_CHOICE.LEAVE) {
    return {
      victory: true,
      title: 'Extraction réussie',
      goldLabel: 'Or sécurisé',
      gold: portalGold,
    };
  }
  // ponytail: la part gardee (`WIPE_GOLD_KEPT` > 0) ne s'affiche pas, une
  // seconde ligne « Or sécurisé » le jour ou ce reglage quitte 0.
  return {
    victory: false,
    title: 'L’équipe est tombée',
    goldLabel: 'Or perdu',
    gold: gold - Math.round(gold * WIPE_GOLD_KEPT),
  };
}

export function paintSummary(
  el: SummaryElements,
  result: RunOverSummary,
  tone: ReturnType<typeof summaryTone>,
  localId: number | null,
  classId: number | null,
): void {
  const info = formatSummary(result);
  el.root.classList.toggle('veil--defeat', !tone.victory);
  el.root.classList.toggle('veil--victory', tone.victory);
  el.title.textContent = tone.title;
  el.title.classList.toggle('rib--red', !tone.victory);
  el.title.classList.toggle('rib--yellow', tone.victory);
  // Defaite : portrait desature.
  el.portrait.style.filter = tone.victory ? '' : 'grayscale(0.7) brightness(0.8)';
  el.portrait.src = localId === null ? '' : avatar(localId, classId ?? 0);
  el.name.textContent = localId === null ? '' : `Joueur ${localId}`;
  el.time.textContent = info.time;
  el.level.textContent = `${info.level}`;
  el.kills.textContent = formatGold(info.kills);
  el.goldLabel.textContent = tone.goldLabel;
  el.gold.textContent = `${tone.victory ? '+' : '−'} ${formatGold(tone.gold)}`;
  el.root.classList.remove('hidden');
}
