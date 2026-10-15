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
}

/**
 * Ce que la fin de run doit dire. **Deux fins, un seul ecran** (maquettes 16
 * et 17) : l'equipe a vote « partir » au dernier portail — extraction reussie,
 * l'or est acquis (`portalGold`, multiplicateur compris) — ou elle est tombee,
 * et seule la part que l'effacement laisse (`gold` du dernier snapshot) part
 * sur les comptes. Le bonus « Fortune » de chacun s'ajoute ensuite, au
 * versement (`Session`), il n'est pas compte ici.
 */
export function summaryTone(
  decision: number | null,
  portalGold: number,
  gold: number,
): { victory: boolean; title: string; gold: number } {
  if (decision === VOTE_CHOICE.LEAVE) {
    return { victory: true, title: 'Extraction réussie', gold: portalGold };
  }
  return { victory: false, title: 'L’équipe est tombée', gold };
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
  // Defaite : portrait desature, comme la maquette 16.
  el.portrait.style.filter = tone.victory ? '' : 'grayscale(0.7) brightness(0.8)';
  el.portrait.src = localId === null ? '' : avatar(localId, classId ?? 0);
  el.name.textContent = localId === null ? '' : `Joueur ${localId}`;
  el.time.textContent = info.time;
  el.level.textContent = `${info.level}`;
  el.kills.textContent = formatGold(info.kills);
  el.gold.textContent = `+ ${formatGold(tone.gold)}`;
  el.root.classList.remove('hidden');
}
