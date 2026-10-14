/**
 * L'ecran de chargement (maquette 03) : il couvre l'attente entre « Lancer la
 * partie » et la premiere image ou le joueur se voit — la latence du salon,
 * la generation de l'ile, le telechargement des planches. Sans lui, l'ecran
 * restait noir, ou montrait une carte a moitie habillee.
 *
 * Ce module est PUR : `loadingProgress` dit ou en est le chargement a partir
 * de ce que `main.ts` observe, `paintLoading` l'ecrit. L'ecran ne decide rien.
 */

export interface LoadingState {
  /** L'hote a lance, ou le salon a annonce le depart : on attend le serveur. */
  launched: boolean;
  /** Le WELCOME est arrive : la graine est la, l'ile est generee. */
  mapReady: boolean;
  /** Planches prechargees, sur le total a charger (`preloadTerrain`). */
  assetsLoaded: number;
  assetsTotal: number;
  /** Le terrain est pose dans la scene (`Stage.drawObstacles` resolu). */
  terrainReady: boolean;
  /** Le premier instantane ou le joueur local apparait est arrive. */
  firstSnapshot: boolean;
}

export interface LoadingView {
  label: string;
  /** Dans `[0, 1]`. */
  ratio: number;
  /** Tout est la : l'ecran peut s'effacer. */
  done: boolean;
}

/**
 * Ou en est le chargement. Les etapes se suivent dans l'ordre du depart ; la
 * jauge ne recule jamais d'une etape a la suivante, et la part des planches
 * avance avec leur nombre.
 */
export function loadingProgress(s: LoadingState): LoadingView {
  if (s.terrainReady && s.firstSnapshot) {
    return { label: 'En route !', ratio: 1, done: true };
  }
  if (s.terrainReady) {
    return { label: 'Arrivée sur l’île…', ratio: 0.95, done: false };
  }
  if (s.mapReady) {
    const part = s.assetsTotal > 0 ? Math.min(1, s.assetsLoaded / s.assetsTotal) : 1;
    return { label: 'Habillage de l’île…', ratio: 0.3 + 0.6 * part, done: false };
  }
  if (s.launched) {
    return { label: 'Connexion au salon…', ratio: 0.12, done: false };
  }
  return { label: 'Préparation…', ratio: 0, done: false };
}

/** Les conseils de l'encart, un par chargement. */
export const TIPS: readonly string[] = [
  'Deux éléments différents sur le même ennemi déclenchent une réaction. Combinez vos armes avec celles de l’équipe.',
  'Une arme neutre ne réagit pas, mais elle frappe plus fort les ennemis déjà marqués par un allié.',
  'Les arbres, les rochers et les falaises bloquent la horde… et la charge du boss.',
  'L’or ramassé n’est à vous qu’une fois la partie extraite. Mourir en garde une petite part.',
  'Appuyez sur Espace pour le verbe de votre classe : il vise votre curseur.',
  'Le Rempart protège les alliés dans sa zone, l’Appât détourne la horde vers un leurre.',
];

/** Un conseil, choisi par `seed` (le code du salon, par exemple). */
export function tipFor(seed: string): string {
  let h = 0;
  for (const ch of seed) {
    h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return TIPS[h % TIPS.length] ?? TIPS[0] ?? '';
}

export interface LoadingElements {
  root: HTMLElement;
  label: HTMLElement;
  percent: HTMLElement;
  fill: HTMLElement;
}

export function paintLoading(el: LoadingElements, view: LoadingView): void {
  el.label.textContent = view.label;
  el.percent.textContent = `${Math.round(view.ratio * 100)} %`;
  el.fill.style.setProperty('--v', `${view.ratio}`);
}
