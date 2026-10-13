/**
 * L'habillage des ecrans (kit d'interface, ecran 18 de la maquette) : chaque
 * cadre, bouton, ruban et jauge est RECOLLE dans le navigateur depuis les
 * planches du pack, puis pose en variable CSS (`--k-<cle>`) que `main.css`
 * consomme en `border-image`.
 *
 * ⚠️ **Rien n'est ecrit nulle part.** Le depot est public et la licence Tiny
 * Swords interdit d'y faire entrer un derive (NOTICE-assets.md) : les planches
 * « UI Elements » ne sont pas des 9-slices jointifs (vignettes de 64 px
 * espacees de 128), donc on les recadre a leur emprise peinte et on les recolle
 * bord a bord ici, au chargement.
 *
 * Les rectangles source viennent des marges mesurees du paquet de design
 * (`design_handoff_tarnok_ui/README.md`) : une marge `m` d'une colonne de gauche
 * se lit `[finDeCellule - m, m]`. Si une planche manque, la variable reste
 * absente, `data-skin` n'est pas pose, et `main.css` garde des cadres unis.
 */
const PACK = '/tinyswords/';
const UIE = 'UI%20Elements/UI%20Elements/';

/** Un rectangle source : `[x, y, largeur, hauteur]`. */
type Rect = readonly [number, number, number, number];

/** Neuf cellules, lues de gauche a droite puis de haut en bas. */
interface Nine {
  file: string;
  cells: readonly Rect[];
  /** Indices de cellules a recoudre par rampe (voir `ramp`). */
  ramp?: readonly number[];
}

/** Une grille 3 x 3 a partir de colonnes `[x, w]` et de lignes `[y, h]`. */
function grid(
  cols: readonly (readonly [number, number])[],
  rows: readonly (readonly [number, number])[],
): Rect[] {
  return rows.flatMap(([y, h]) => cols.map(([x, w]) => [x, y, w, h] as const));
}

/** Les planches `UI/` : deja jointives, trois tuiles de 64. */
const JOINTIVE = grid(
  [
    [0, 64],
    [64, 64],
    [128, 64],
  ],
  [
    [0, 64],
    [64, 64],
    [128, 64],
  ],
);

/**
 * Colonnes d'une planche « UI Elements » de 320 px (cellules a 0, 128, 256) :
 * bord gauche `l` et droit `r` mesures, centre de 64.
 */
const cols320 = (l: number, r: number): [number, number][] => [
  [64 - l, l],
  [128, 64],
  [256, r],
];
/** Idem pour les planches de 448 px (cellules a 0..128, 192, 320..448). */
const cols448 = (l: number, r: number): [number, number][] => [
  [128 - l, l],
  [192, 64],
  [320, r],
];

const bigButton = (file: string, t: number, r: number, b: number, l: number): Nine => ({
  file: UIE + file,
  cells: grid(cols320(l, r), cols320(t, b)),
});

const pb = (file: string): Nine => ({
  file: `UI/Buttons/${file}.png`,
  cells: JOINTIVE,
  // Bande basse centrale : marche de 2,6 a 3,5 entre ses deux bords (README).
  ramp: [7],
});

const NINES: Record<string, Nine> = {
  pbblue: pb('Button_Blue_9Slides'),
  pbblueP: pb('Button_Blue_9Slides_Pressed'),
  pbred: pb('Button_Red_9Slides'),
  pbredP: pb('Button_Red_9Slides_Pressed'),
  pbhov: pb('Button_Hover_9Slides'),
  pboff: pb('Button_Disable_9Slides'),
  carved: { file: 'UI/Banners/Carved_9Slides.png', cells: JOINTIVE },
  paperx: { file: `${UIE}Papers/SpecialPaper.png`, cells: grid(cols320(55, 55), cols320(44, 43)) },
  banner: { file: `${UIE}Banners/Banner.png`, cells: grid(cols448(100, 84), cols448(68, 111)) },
  // Le parchemin de la boutique du pack : neuf tuiles de 64, pavees dans les
  // deux sens a l'echelle 1. Les cellules ne sont pas sur une grille reguliere.
  scroll: {
    file: 'UI%20Elements/UI%20Banners%20from%20the%20store%20page/Banner/Banner.png',
    cells: [
      [0, 0, 64, 64],
      [256, 0, 64, 64],
      [640, 0, 64, 64],
      [0, 128, 64, 64],
      [320, 128, 64, 64],
      [640, 128, 64, 64],
      [0, 256, 64, 64],
      [256, 256, 64, 64],
      [640, 256, 64, 64],
    ],
  },
  bbblue: bigButton('Buttons/BigBlueButton_Regular.png', 47, 45, 47, 45),
  bbblueP: bigButton('Buttons/BigBlueButton_Pressed.png', 36, 50, 49, 50),
  bbred: bigButton('Buttons/BigRedButton_Regular.png', 47, 45, 47, 45),
  bbredP: bigButton('Buttons/BigRedButton_Pressed.png', 36, 50, 49, 50),
};

/** Trois tranches horizontales : bouts mesures, centre de 64. */
interface Three {
  file: string;
  cols: readonly (readonly [number, number])[];
  row: readonly [number, number];
}

const THREES: Record<string, Three> = {
  barbig: { file: `${UIE}Bars/BigBar_Base.png`, cols: cols320(24, 24), row: [9, 51] },
  barsml: { file: `${UIE}Bars/SmallBar_Base.png`, cols: cols320(15, 15), row: [22, 19] },
  // Le remplissage n'a qu'une tranche, pavee au pas de 64.
  fillbig: { file: `${UIE}Bars/BigBar_Fill.png`, cols: [[0, 64]], row: [20, 24] },
  fillsml: { file: `${UIE}Bars/SmallBar_Fill.png`, cols: [[0, 64]], row: [29, 5] },
};
for (let i = 0; i < 5; i++) {
  // Ligne i : 0 bleu, 1 rouge, 2 jaune, 3 violet, 4 ardoise.
  THREES[`rib${i}`] = {
    file: `${UIE}Ribbons/BigRibbons.png`,
    cols: cols448(98, 97),
    row: [i * 128 + 20, 103],
  };
  // Chaque ligne de `SmallRibbons` porte DEUX rubans (bout fourchu en haut,
  // pointu en bas) : on ne garde que celui du bas, complet de y+68 a y+122.
  THREES[`srib${i}`] = {
    file: `${UIE}Ribbons/SmallRibbons.png`,
    cols: cols320(62, 62),
    row: [i * 128 + 68, 54],
  };
}

/**
 * Rampe correctrice du README : sur chaque ligne, l'ecart entre la premiere et
 * la derniere colonne est reparti sur toute la largeur, pour que la tuile se
 * raccorde a elle-meme sans marche quand elle est pavee. Alpha intact, pixels
 * transparents ignores.
 */
export function ramp(px: Uint8ClampedArray, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    const first = y * w * 4;
    const last = first + (w - 1) * 4;
    if (px[first + 3] === 0 || px[last + 3] === 0) {
      continue;
    }
    for (let k = 0; k < 3; k++) {
      const delta = (px[first + k] as number) - (px[last + k] as number);
      for (let x = 0; x < w; x++) {
        const i = first + x * 4;
        if (px[i + 3] !== 0) {
          px[i + k] = (px[i + k] as number) + (delta * x) / (w - 1);
        }
      }
    }
  }
}

const sheets = new Map<string, Promise<HTMLImageElement>>();
function sheet(file: string): Promise<HTMLImageElement> {
  let p = sheets.get(file);
  if (!p) {
    const img = new Image();
    img.src = PACK + file;
    p = img.decode().then(() => img);
    sheets.set(file, p);
  }
  return p;
}

/** Recolle les `cells` en grille `cols x rows` et rend une URL `data:`. */
async function paste(
  file: string,
  cells: readonly Rect[],
  perRow: number,
  rampCells: readonly number[] = [],
): Promise<string> {
  const img = await sheet(file);
  const widths = cells.slice(0, perRow).map((c) => c[2]);
  const heights = cells.filter((_, i) => i % perRow === 0).map((c) => c[3]);
  const canvas = document.createElement('canvas');
  canvas.width = widths.reduce((a, b) => a + b, 0);
  canvas.height = heights.reduce((a, b) => a + b, 0);
  const g = canvas.getContext('2d', { willReadFrequently: rampCells.length > 0 });
  if (!g) {
    throw new Error('canvas 2d indisponible');
  }
  let y = 0;
  cells.forEach(([sx, sy, w, h], i) => {
    const col = i % perRow;
    const x = widths.slice(0, col).reduce((a, b) => a + b, 0);
    g.drawImage(img, sx, sy, w, h, x, y, w, h);
    if (rampCells.includes(i)) {
      const data = g.getImageData(x, y, w, h);
      ramp(data.data, w, h);
      g.putImageData(data, x, y);
    }
    if (col === perRow - 1) {
      y += h;
    }
  });
  return `url(${canvas.toDataURL()})`;
}

function makeAll(): [string, Promise<string>][] {
  return [
    ...Object.entries(NINES).map(
      ([k, n]) => [k, paste(n.file, n.cells, 3, n.ramp)] as [string, Promise<string>],
    ),
    ...Object.entries(THREES).map(
      ([k, t]) =>
        [
          k,
          paste(
            t.file,
            t.cols.map(([x, w]) => [x, t.row[0], w, t.row[1]] as const),
            t.cols.length,
          ),
        ] as [string, Promise<string>],
    ),
  ];
}

/**
 * Pose chaque planche recollee sur `:root` (`--k-<cle>`), puis `data-skin`
 * pour que les regles qui en dependent s'allument d'un bloc — jamais un bouton
 * habille a cote d'un panneau qui ne l'est pas. Ne leve jamais.
 */
export async function applySkin(root: HTMLElement = document.documentElement): Promise<void> {
  try {
    const all = await Promise.all(makeAll().map(async ([k, p]) => [k, await p] as const));
    for (const [k, url] of all) {
      root.style.setProperty(`--k-${k}`, url);
    }
    root.dataset.skin = 'on';
  } catch (cause) {
    console.warn('[skin] planches UI indisponibles, cadres unis', cause);
  }
}
