/**
 * Les options du joueur (maquette 07), gardees dans CE navigateur.
 *
 * ⚠️ **Seulement ce qui marche.** La maquette montre des volumes, une
 * secousse de camera, des degats affiches et une langue : le jeu n'a ni son,
 * ni secousse, ni chiffres de degats, ni traduction. Une option qui ne fait
 * rien ment ; ces lignes viendront avec ce qu'elles reglent.
 *
 * `localStorage` peut manquer ou lever (navigation privee, stockage bloque) :
 * chaque acces est garde, et les valeurs par defaut s'appliquent alors.
 */
export interface Settings {
  /** L'aide des combinaisons est depliee en debut de partie. */
  combosOpen: boolean;
  /** La mini-carte est affichee. */
  minimap: boolean;
}

export const DEFAULT_SETTINGS: Settings = { combosOpen: false, minimap: true };

const KEY = 'tarnok.settings';

/** Lit les options gardees, completees par les valeurs par defaut. */
export function loadSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Settings {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    const parsed = JSON.parse(raw) as Partial<Record<keyof Settings, unknown>>;
    return {
      combosOpen:
        typeof parsed.combosOpen === 'boolean' ? parsed.combosOpen : DEFAULT_SETTINGS.combosOpen,
      minimap: typeof parsed.minimap === 'boolean' ? parsed.minimap : DEFAULT_SETTINGS.minimap,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Garde les options ; rend faux si le navigateur l'a refuse. */
export function saveSettings(
  settings: Settings,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): boolean {
  try {
    storage?.setItem(KEY, JSON.stringify(settings));
    return storage !== null;
  } catch {
    return false;
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Les touches du jeu, pour l'onglet Commandes. */
export const CONTROLS: readonly { action: string; keys: string }[] = [
  { action: 'Se déplacer', keys: 'ZQSD · WASD · flèches' },
  { action: 'Viser', keys: 'Souris' },
  { action: 'Verbe de la classe', keys: 'Espace' },
  { action: 'Aide des combinaisons', keys: 'H' },
  { action: 'Menu', keys: 'Échap' },
];
