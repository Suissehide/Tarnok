/**
 * L'ecran de chargement : il couvre l'attente entre « Lancer la partie » et la
 * premiere image ou le joueur se voit — latence du salon, generation de l'ile,
 * telechargement des planches.
 *
 * Module PUR : `loadingProgress` dit ou en est le chargement a partir de ce
 * que `main.ts` observe, `paintLoading` l'ecrit.
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

/**
 * Les phrases de l'attente, en GROUPE NOMINAL comme les ecrans de chargement
 * des classiques (la « Réticulation des splines » des Sims) : elles defilent
 * sous la jauge pendant que le chargement avance (`FUNNY_LINE_MS` chacune).
 */
export const FUNNY_LINES: readonly string[] = [
  'Réticulation des splines…',
  'Affûtage des dagues…',
  'Recensement des gobelins, un par un…',
  'Négociation avec le syndicat des squelettes…',
  'Réveil du boss…',
  'Polissage des cristaux d’expérience…',
  'Vérification que l’eau mouille…',
  'Graissage des catapultes…',
  'Persuasion des moutons…',
  'Équilibrage des dégâts au doigt mouillé…',
  'Plantation de buissons stratégiques…',
  'Recherche du marteau du forgeron…',
  'Génération de citrouilles décoratives…',
  'Raccommodage des drapeaux…',
  'Entraînement du Rempart à l’immobilité…',
  'Tirage au sort de la météo…',
];

/** Duree d'affichage d'une phrase, en ms. */
export const FUNNY_LINE_MS = 1400;

/** La phrase affichee `elapsedMs` apres l'ouverture, en partant de `start` (le salon). */
export function funnyLine(elapsedMs: number, start: number): string {
  const i = (start + Math.floor(Math.max(0, elapsedMs) / FUNNY_LINE_MS)) % FUNNY_LINES.length;
  return FUNNY_LINES[i] ?? FUNNY_LINES[0] ?? '';
}

/** L'ecran reste au moins ce temps : sinon un chargement local est un clignotement. */
export const LOADING_MIN_MS = 2000;

/**
 * La jauge AFFICHEE, qui court vers la valeur reelle sans jamais sauter :
 * elle rattrape `target` en douceur et, tant qu'une etape attend, grignote
 * encore un peu vers la suivante (jamais au-dela de `target + CREEP_MAX`) —
 * une barre figee se lit comme un jeu plante.
 */
export const CREEP_MAX = 0.06;
export function easeBar(shown: number, target: number, dtMs: number): number {
  // Constante de temps de 500 ms : meme un chargement deja fini se voit
  // remplir, en un peu moins de deux secondes.
  const catchUp = 1 - Math.exp(-dtMs / 500);
  let next = shown + (target - shown) * catchUp;
  if (next >= target - 0.002 && target < 1) {
    // L'etape attend : on avance doucement, sans depasser le plafond.
    next = Math.min(target + CREEP_MAX, Math.max(next, shown) + dtMs * 0.00002);
  }
  return Math.min(1, Math.max(shown, next));
}
