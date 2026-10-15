/**
 * Les options du joueur (maquette 07), gardees dans CE navigateur.
 *
 * ⚠️ **Seulement ce qui marche.** La maquette montre aussi une secousse de
 * camera, des degats affiches et une langue : le jeu n'a ni secousse, ni
 * chiffres de degats, ni traduction. Une option qui ne fait rien ment ; ces
 * lignes viendront avec ce qu'elles reglent.
 *
 * `localStorage` peut manquer ou lever (navigation privee, stockage bloque) :
 * chaque acces est garde, et les valeurs par defaut s'appliquent alors.
 */
export interface Settings {
  /** L'aide des combinaisons est depliee en debut de partie. */
  combosOpen: boolean;
  /** La mini-carte est affichee. */
  minimap: boolean;
  /** Volumes, de 0 a 100 (`audio/audio.ts`). */
  master: number;
  music: number;
  sfx: number;
}

export const DEFAULT_SETTINGS: Settings = {
  combosOpen: false,
  minimap: true,
  master: 80,
  music: 50,
  sfx: 80,
};

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
      master: volume(parsed.master, DEFAULT_SETTINGS.master),
      music: volume(parsed.music, DEFAULT_SETTINGS.music),
      sfx: volume(parsed.sfx, DEFAULT_SETTINGS.sfx),
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

/** Un volume garde, borne a [0, 100] ; sinon la valeur par defaut. */
function volume(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(100, Math.max(0, Math.round(v)))
    : fallback;
}

const PICK_KEY = 'tarnok.pick';

/** Le dernier couple (arme, classe) choisi en salle d'attente, ou null. Le serveur revalide chacun. */
export function loadPick(
  storage: Pick<Storage, 'getItem'> | null = safeStorage(),
): { weaponId: number; classId: number } | null {
  try {
    const p = JSON.parse(storage?.getItem(PICK_KEY) ?? 'null') as Record<string, unknown> | null;
    return p && Number.isInteger(p.weaponId) && Number.isInteger(p.classId)
      ? { weaponId: p.weaponId as number, classId: p.classId as number }
      : null;
  } catch {
    return null;
  }
}

export function savePick(
  weaponId: number,
  classId: number,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  try {
    storage?.setItem(PICK_KEY, JSON.stringify({ weaponId, classId }));
  } catch {
    // Stockage refuse : le choix vaut pour ce salon seulement.
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
