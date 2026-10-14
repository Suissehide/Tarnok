/**
 * Une icone par element, en SVG inline dessine a la main : net a toute
 * taille, aucun fichier d'image dans le depot (licence Tiny Swords).
 *
 * Grille 16x16, contour sombre epais, remplissage a la teinte de l'element
 * (`Element.tint`). Les formes a traits (flocon, anneaux) sont tracees deux
 * fois : un trait sombre large dessous, le trait teinte plus fin dessus —
 * le meme contour que les formes pleines.
 */

import { ELEMENT, elementOf } from '@shared/elements';

const CONTOUR = '#221111';

/**
 * Le neutre a pour teinte le blanc (identite Pixi) : gris pour l'icone.
 * Meme conversion que `cssColor` de `draft.ts`, recopiee plutot qu'importee :
 * `draft.ts` importera ce module, l'inverse ferait un cycle.
 */
function fillOf(elementId: number): string {
  if (elementId === ELEMENT.NEUTRE) {
    return '#a8a8a8';
  }
  return `#${elementOf(elementId).tint.toString(16).padStart(6, '0')}`;
}

function plein(d: string, fill: string): string {
  return `<path d="${d}" fill="${fill}" stroke="${CONTOUR}" stroke-width="1.4" stroke-linejoin="round"/>`;
}

function traits(d: string, fill: string): string {
  return (
    `<path d="${d}" fill="none" stroke="${CONTOUR}" stroke-width="4" stroke-linecap="round"/>` +
    `<path d="${d}" fill="none" stroke="${fill}" stroke-width="1.8" stroke-linecap="round"/>`
  );
}

const DESSINS: Record<number, (fill: string) => string> = {
  // Une lame courte : l'arme sans element.
  [ELEMENT.NEUTRE]: (f) =>
    plein('M11.5 1.5 L14.5 4.5 L6 13 L3 13 L3 10 Z', f) +
    plein('M2 11 L5 14 L3.5 15.5 L0.5 12.5 Z', f),
  [ELEMENT.BRAISE]: (f) =>
    plein(
      'M8 1 C10.5 4 13.5 6.5 13.5 10.5 A5.5 5 0 0 1 2.5 10.5 C2.5 8 4 6.5 5 5.5 C5.5 7 6 8 7 8.5 C6.5 6 7 3.5 8 1 Z',
      f,
    ) + plein('M8 9 C9.5 10.5 10.5 11.5 10 13 A2 2 0 0 1 6 13 C6 11.5 7 10.5 8 9 Z', '#ffe08a'),
  [ELEMENT.GIVRE]: (f) =>
    traits(
      'M8 1.5 V14.5 M2.4 4.75 L13.6 11.25 M2.4 11.25 L13.6 4.75 M6 2.5 L8 4.5 L10 2.5 M6 13.5 L8 11.5 L10 13.5',
      f,
    ),
  [ELEMENT.FOUDRE]: (f) => plein('M10 0.8 L3 9 H7.2 L5.6 15.2 L13 6.5 H8.8 Z', f),
  [ELEMENT.POIX]: (f) =>
    plein('M8 1 C9.5 4 13.5 7.5 13.5 10.5 A5.5 5 0 0 1 2.5 10.5 C2.5 7.5 6.5 4 8 1 Z', f) +
    '<ellipse cx="5.8" cy="10.2" rx="1" ry="1.8" fill="#8a6a4f"/>',
  // Un petit nuage de poudre.
  [ELEMENT.CHAUX]: (f) =>
    `<circle cx="5" cy="10" r="3.5" fill="${f}" stroke="${CONTOUR}" stroke-width="1.4"/>` +
    `<circle cx="11" cy="9.5" r="3" fill="${f}" stroke="${CONTOUR}" stroke-width="1.4"/>` +
    `<circle cx="8.5" cy="4.5" r="2.5" fill="${f}" stroke="${CONTOUR}" stroke-width="1.4"/>` +
    `<circle cx="13.5" cy="3" r="1.2" fill="${f}" stroke="${CONTOUR}" stroke-width="1"/>`,
  // Deux anneaux lies : le Vif-argent lie les ennemis.
  [ELEMENT.VIF_ARGENT]: (f) =>
    traits('M9.5 6 A3.5 3.5 0 1 0 9.5 10 M6.5 6 A3.5 3.5 0 1 1 6.5 10', f),
};

/** Le markup `<svg>` de l'icone de l'element, carre de `size` pixels. */
export function elementIconSvg(elementId: number, size = 28): string {
  const dessin = DESSINS[elementId];
  if (!dessin) {
    throw new Error(`element inconnu : ${elementId}`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${dessin(fillOf(elementId))}</svg>`;
}

/** « vif-argent » -> « Vif-argent » : le nom de la table, capitalise. */
export function elementLabel(elementId: number): string {
  const name = elementOf(elementId).name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** L'icone dans un `<span class="element-badge">`, nom de l'element en infobulle. */
export function elementBadge(elementId: number, size = 28): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'element-badge inline-flex shrink-0';
  badge.title = elementLabel(elementId);
  badge.dataset.element = String(elementId);
  badge.innerHTML = elementIconSvg(elementId, size);
  return badge;
}
