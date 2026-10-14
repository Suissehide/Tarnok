import { CONTROLS, type Settings } from './settings';

/**
 * L'ecran d'options (maquette 07) : un brouillon que les bascules modifient,
 * et que seul « Appliquer » garde (`saveSettings`). Ce module peint ; il ne
 * garde rien lui-meme.
 */

/** Peint l'etat de chaque bascule : le bouton de la valeur courante est enfonce. */
export function paintToggles(root: HTMLElement, draft: Settings): void {
  for (const group of root.querySelectorAll<HTMLElement>('[data-setting]')) {
    const key = group.dataset.setting as keyof Settings;
    for (const b of group.querySelectorAll<HTMLButtonElement>('[data-value]')) {
      b.setAttribute('aria-pressed', String(b.dataset.value === String(draft[key])));
    }
  }
}

/** Montre l'onglet `tab`, enfonce son bouton. */
export function showTab(root: HTMLElement, tab: string): void {
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
  }
  for (const p of root.querySelectorAll<HTMLElement>('[data-panel]')) {
    p.classList.toggle('hidden', p.dataset.panel !== tab);
  }
}

/** Remplit la liste des commandes. */
export function renderControls(list: HTMLElement): void {
  list.replaceChildren(
    ...CONTROLS.map(({ action, keys }) => {
      const li = document.createElement('li');
      li.className = 'options-row';
      const label = document.createElement('span');
      label.className = 'options-label';
      label.textContent = action;
      const k = document.createElement('span');
      k.className = 'f-mono text-[24px] text-[color:var(--color-ink)]';
      k.textContent = keys;
      li.append(label, k);
      return li;
    }),
  );
}

/**
 * Branche l'ecran : onglets, bascules, plein ecran. `onApply` recoit le
 * brouillon a garder ; `onBack` ferme sans garder.
 */
export function wireOptions(
  root: HTMLElement,
  current: () => Settings,
  onApply: (draft: Settings) => void,
  onBack: () => void,
): { open: () => void } {
  let draft: Settings = current();
  const list = root.querySelector<HTMLElement>('#options-controls');
  if (list) {
    renderControls(list);
  }
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    b.addEventListener('click', () => showTab(root, b.dataset.tab ?? 'jeu'));
  }
  for (const group of root.querySelectorAll<HTMLElement>('[data-setting]')) {
    const key = group.dataset.setting as keyof Settings;
    for (const b of group.querySelectorAll<HTMLButtonElement>('[data-value]')) {
      b.addEventListener('click', () => {
        draft = { ...draft, [key]: b.dataset.value === 'true' };
        paintToggles(root, draft);
      });
    }
  }
  root.querySelector('#options-fullscreen')?.addEventListener('click', () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen?.();
    }
  });
  root.querySelector('#options-apply')?.addEventListener('click', () => onApply(draft));
  root.querySelector('#options-back')?.addEventListener('click', onBack);
  return {
    open: () => {
      draft = current();
      paintToggles(root, draft);
      showTab(root, 'jeu');
    },
  };
}
