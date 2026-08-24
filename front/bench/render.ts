/**
 * Banc de rendu — combien de sprites a 60 fps, et a quel prix ?
 *
 * Le §4.3 est categorique : chez Riot le goulot client n'etait pas le nombre
 * d'entites mais **les particules, a 34 ms par image**. Et « le GPU se moque de
 * 1 500 quads ; ce qui tue, c'est le cout JavaScript par objet et par
 * transform ». Ce banc mesure donc le cout CPU de soumission d'une image, pas
 * la charge GPU.
 *
 * La comparaison `ParticleContainer` contre autant d'objets `Sprite` est le
 * point du banc : elle doit **chiffrer** l'ecart, pas le supposer. C'est lui qui
 * justifiera de n'ecrire le rendu qu'une fois.
 *
 * Les deux premieres mesures rendent en boucle serree, sans rAF : elles restent
 * valides dans un onglet en arriere-plan, ou rAF est suspendu.
 */

import {
  Application,
  Container,
  Particle,
  ParticleContainer,
  Rectangle,
  Sprite,
  Texture,
} from 'pixi.js';

const SPRITE_COUNTS = [500, 1000, 1500, 3000, 6000];
const PARTICLE_COUNTS = [500, 2000, 5000, 10_000, 20_000];

/**
 * On chronometre des **blocs** d'images, jamais une image isolee.
 *
 * `performance.now()` est volontairement grossi a 100 us dans un navigateur
 * (mitigation Spectre) hors isolation cross-origin. A cette resolution, une
 * image qui coute 0,3 ms se lit « 0 ou 0,1 ms » et la mesure ne veut plus rien
 * dire. Un bloc de 30 images coute des dizaines de millisecondes, soit deux
 * ordres de grandeur au-dessus du grain de l'horloge.
 */
const BLOCK_FRAMES = 30;
const BLOCKS = 12;
const WARMUP_FRAMES = 60;

/** Budget d'une image a 60 fps. */
const FRAME_BUDGET_MS = 1000 / 60;

const WORLD = 4000;

type Mode = 'particles' | 'sprites';

interface Row {
  mode: string;
  count: number;
  medianMs: number;
  p95Ms: number;
  advanceMs: number;
  renderMs: number;
  fpsEquivalent: number;
  withinBudget: boolean;
}

const app = new Application();
await app.init({
  background: 0x14110f,
  resizeTo: window,
  antialias: false,
  preference: 'webgl',
});
document.body.appendChild(app.canvas);
// On pilote le rendu a la main : le ticker fausserait les mesures en rendant
// des images qu'on ne compte pas.
app.ticker.stop();

/** Petit quad blanc : un seul atlas pour tout ce qui est massif (§4.3). */
function makeTexture(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  ctx.fillStyle = '#e0a45e';
  ctx.fillRect(2, 2, 12, 12);
  return Texture.from(canvas);
}

const texture = makeTexture();

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i] ?? 0;
}

/**
 * Une scene mesurable : elle sait bouger toutes ses entites et etre rendue.
 *
 * Le deplacement fait partie de la mesure a dessein — c'est precisement le
 * « cout JavaScript par objet et par transform » du §4.3 qu'on cherche a
 * chiffrer, pas le cout d'un `render()` sur une scene figee.
 */
interface Scene {
  advance(t: number): void;
  destroy(): void;
}

function buildParticleScene(count: number): Scene {
  const container = new ParticleContainer({
    // Seule la position change d'une image a l'autre. Declarer le reste en
    // dynamique ferait re-televerser des donnees identiques a chaque image.
    dynamicProperties: { position: true, rotation: false, color: false, vertex: false },
  });
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const p = new Particle({
      texture,
      x: Math.random() * WORLD,
      y: Math.random() * WORLD,
    });
    particles.push(p);
    container.addParticle(p);
  }
  app.stage.addChild(container);

  return {
    advance(t: number): void {
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (!p) {
          continue;
        }
        p.x += Math.cos(t + i) * 0.5;
        p.y += Math.sin(t + i) * 0.5;
      }
    },
    destroy(): void {
      app.stage.removeChild(container);
      container.destroy();
    },
  };
}

function buildSpriteScene(count: number): Scene {
  const container = new Container();
  const sprites: Sprite[] = [];
  for (let i = 0; i < count; i++) {
    const s = new Sprite(texture);
    s.x = Math.random() * WORLD;
    s.y = Math.random() * WORLD;
    sprites.push(s);
    container.addChild(s);
  }
  app.stage.addChild(container);

  return {
    advance(t: number): void {
      for (let i = 0; i < sprites.length; i++) {
        const s = sprites[i];
        if (!s) {
          continue;
        }
        s.x += Math.cos(t + i) * 0.5;
        s.y += Math.sin(t + i) * 0.5;
      }
    },
    destroy(): void {
      app.stage.removeChild(container);
      container.destroy({ children: true });
    },
  };
}

/**
 * Scene de horde animee : un seul atlas, chaque particule change d'image.
 *
 * C'est le montage exact du §9 de la spec de l'etape 2. On le prouve ici avant
 * d'ecrire le rendu du jeu, parce que si `uvs` dynamique ne fonctionne pas, la
 * conception du rendu est a refaire.
 */
function buildAnimatedScene(count: number): Scene {
  const FRAMES = 8;
  const CELL = 64;
  // Atlas synthetique : une bande de 8 images de 64, chacune d'une teinte
  // differente pour qu'un defaut d'animation se voie a l'oeil nu.
  const canvas = document.createElement('canvas');
  canvas.width = CELL * FRAMES;
  canvas.height = CELL;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  for (let f = 0; f < FRAMES; f++) {
    ctx.fillStyle = `hsl(${(f * 360) / FRAMES} 70% 55%)`;
    ctx.fillRect(f * CELL + 4, 4, CELL - 8, CELL - 8);
  }
  const atlas = Texture.from(canvas);
  const frames = Array.from(
    { length: FRAMES },
    (_, f) =>
      new Texture({
        source: atlas.source,
        frame: new Rectangle(f * CELL, 0, CELL, CELL),
      }),
  );

  const container = new ParticleContainer({
    dynamicProperties: { position: true, uvs: true, color: false, rotation: false },
  });
  const particles: Particle[] = [];
  const phase: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = new Particle({
      texture: frames[0] as Texture,
      x: Math.random() * WORLD,
      y: Math.random() * WORLD,
    });
    particles.push(p);
    phase.push(Math.floor(Math.random() * FRAMES));
    container.addParticle(p);
  }
  app.stage.addChild(container);

  return {
    advance(t: number): void {
      const base = Math.floor(t * 10);
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (!p) {
          continue;
        }
        p.x += Math.cos(t + i) * 0.5;
        p.y += Math.sin(t + i) * 0.5;
        p.texture = frames[(base + (phase[i] ?? 0)) % FRAMES] as Texture;
      }
    },
    destroy(): void {
      app.stage.removeChild(container);
      container.destroy();
    },
  };
}

interface Measurement {
  /** Image complete : deplacement de toutes les entites, puis rendu. */
  medianMs: number;
  p95Ms: number;
  /** La seule boucle de deplacement, sans rendu. */
  advanceMs: number;
  /** Le rendu seul, par difference. */
  renderMs: number;
}

function measure(scene: Scene): Measurement {
  for (let f = 0; f < WARMUP_FRAMES; f++) {
    scene.advance(f * 0.01);
    app.renderer.render(app.stage);
  }

  // Chaque echantillon est le cout moyen d'une image sur un bloc de 30.
  const perFrame: number[] = [];
  let frame = 0;
  for (let block = 0; block < BLOCKS; block++) {
    const started = performance.now();
    for (let f = 0; f < BLOCK_FRAMES; f++) {
      scene.advance(frame++ * 0.01);
      app.renderer.render(app.stage);
    }
    perFrame.push((performance.now() - started) / BLOCK_FRAMES);
  }
  perFrame.sort((a, b) => a - b);

  // La meme boucle sans rendu : la difference isole le cout du rendu. Sans
  // cette soustraction on ne saurait pas si l'ecart entre ParticleContainer et
  // objets Sprite vient du rendu ou de la mise a jour des transforms — or c'est
  // exactement la question du §4.3.
  const advanceOnly: number[] = [];
  for (let block = 0; block < BLOCKS; block++) {
    const started = performance.now();
    for (let f = 0; f < BLOCK_FRAMES; f++) {
      scene.advance(frame++ * 0.01);
    }
    advanceOnly.push((performance.now() - started) / BLOCK_FRAMES);
  }
  advanceOnly.sort((a, b) => a - b);

  const median = percentile(perFrame, 0.5);
  const advance = percentile(advanceOnly, 0.5);

  return {
    medianMs: median,
    p95Ms: percentile(perFrame, 0.95),
    advanceMs: advance,
    renderMs: Math.max(0, median - advance),
  };
}

function runOne(mode: Mode, count: number): Row {
  const scene = mode === 'particles' ? buildParticleScene(count) : buildSpriteScene(count);
  try {
    const m = measure(scene);
    return {
      mode: mode === 'particles' ? 'ParticleContainer' : 'objets Sprite',
      count,
      medianMs: round2(m.medianMs),
      p95Ms: round2(m.p95Ms),
      advanceMs: round2(m.advanceMs),
      renderMs: round2(m.renderMs),
      fpsEquivalent: m.medianMs > 0 ? Math.round(1000 / m.medianMs) : 0,
      withinBudget: m.p95Ms < FRAME_BUDGET_MS,
    };
  } finally {
    scene.destroy();
  }
}

function round2(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export interface SweepResult {
  rows: Row[];
  /** Plus grand nombre de sprites sous le budget de 16,7 ms, par mode. */
  ceilings: Record<string, number>;
  renderer: string;
  userAgent: string;
}

function ceilingsOf(rows: readonly Row[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.withinBudget) {
      out[row.mode] = Math.max(out[row.mode] ?? 0, row.count);
    } else if (out[row.mode] === undefined) {
      out[row.mode] = 0;
    }
  }
  return out;
}

function sweep(): SweepResult {
  const rows: Row[] = [];
  for (const mode of ['particles', 'sprites'] as const) {
    for (const count of SPRITE_COUNTS) {
      rows.push(runOne(mode, count));
    }
  }
  return {
    rows,
    ceilings: ceilingsOf(rows),
    renderer: app.renderer.type === 1 ? 'webgl' : String(app.renderer.type),
    userAgent: navigator.userAgent,
  };
}

/**
 * Budget de particules d'effet.
 *
 * On empile des particules par-dessus une horde de 1 500 entites — la cible du
 * §4.1 — parce que c'est dans ces conditions-la que le budget compte, pas sur
 * une scene vide.
 */
function particleBudget(): SweepResult {
  const horde = buildParticleScene(1500);
  const rows: Row[] = [];
  try {
    for (const count of PARTICLE_COUNTS) {
      const fx = buildParticleScene(count);
      try {
        const m = measure({
          advance: (t) => {
            horde.advance(t);
            fx.advance(t * 3);
          },
          destroy: () => {
            // Les deux scenes sont detruites par les `finally` ci-dessous.
          },
        });
        rows.push({
          mode: '1 500 entites + effets',
          count,
          medianMs: round2(m.medianMs),
          p95Ms: round2(m.p95Ms),
          advanceMs: round2(m.advanceMs),
          renderMs: round2(m.renderMs),
          fpsEquivalent: m.medianMs > 0 ? Math.round(1000 / m.medianMs) : 0,
          withinBudget: m.p95Ms < FRAME_BUDGET_MS,
        });
      } finally {
        fx.destroy();
      }
    }
  } finally {
    horde.destroy();
  }

  return {
    rows,
    ceilings: ceilingsOf(rows),
    renderer: 'webgl',
    userAgent: navigator.userAgent,
  };
}

/** Horde animee : le montage du §9 de la spec, mesure comme les autres. */
function animatedSweep(): SweepResult {
  const rows: Row[] = [];
  for (const count of SPRITE_COUNTS) {
    const scene = buildAnimatedScene(count);
    try {
      const m = measure(scene);
      rows.push({
        mode: 'horde animee (atlas + uvs)',
        count,
        medianMs: round2(m.medianMs),
        p95Ms: round2(m.p95Ms),
        advanceMs: round2(m.advanceMs),
        renderMs: round2(m.renderMs),
        fpsEquivalent: m.medianMs > 0 ? Math.round(1000 / m.medianMs) : 0,
        withinBudget: m.p95Ms < FRAME_BUDGET_MS,
      });
    } finally {
      scene.destroy();
    }
  }
  return { rows, ceilings: ceilingsOf(rows), renderer: 'webgl', userAgent: navigator.userAgent };
}

interface AnimationProof {
  animated: boolean;
  changedPixels: number;
  totalPixels: number;
}

/**
 * Preuve programmatique — pas visuelle — que `uvs` dynamique anime les particules.
 *
 * `measure()` boucle en synchrone : le navigateur ne peint jamais entre deux
 * appels a `render()`, et la scene mesuree est detruite juste apres. Une
 * capture d'ecran ne peut donc structurellement rien montrer. On compare ici
 * les pixels rendus avant et apres un changement de texture ; c'est
 * verifiable sans jamais afficher l'image a l'ecran, et reproductible.
 *
 * Les particules restent a position fixe (`advance()` n'est pas appele) : on
 * isole ainsi l'effet du changement de texture de celui d'un deplacement, qui
 * rendrait la comparaison de pixels ininterpretable.
 */
function proveAnimation(): AnimationProof {
  const FRAMES = 8;
  const CELL = 64;
  const COLS = 5;
  const ROWS = 2;
  const COUNT = COLS * ROWS;

  const canvas = document.createElement('canvas');
  canvas.width = CELL * FRAMES;
  canvas.height = CELL;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d indisponible');
  }
  for (let f = 0; f < FRAMES; f++) {
    ctx.fillStyle = `hsl(${(f * 360) / FRAMES} 70% 55%)`;
    ctx.fillRect(f * CELL + 4, 4, CELL - 8, CELL - 8);
  }
  const atlas = Texture.from(canvas);
  const frames = Array.from(
    { length: FRAMES },
    (_, f) =>
      new Texture({
        source: atlas.source,
        frame: new Rectangle(f * CELL, 0, CELL, CELL),
      }),
  );

  const container = new ParticleContainer({
    dynamicProperties: { position: true, uvs: true, color: false, rotation: false },
  });
  const particles: Particle[] = [];
  // Grille fixe, pas de dispersion aleatoire : la preuve doit etre rejouable
  // a l'identique, et ne faire varier qu'une seule chose a la fois.
  for (let i = 0; i < COUNT; i++) {
    const p = new Particle({
      texture: frames[0] as Texture,
      x: (i % COLS) * CELL,
      y: Math.floor(i / COLS) * CELL,
    });
    particles.push(p);
    container.addParticle(p);
  }
  app.stage.addChild(container);

  // ParticleContainer ne calcule pas ses bornes (cout de performance) : sans
  // `boundsArea` explicite, `bounds` reste un rectangle vide (0,0,0,0) et
  // `extract.pixels()` n'extrait qu'un seul pixel — ce n'est pas l'animation
  // qui serait en cause, seulement l'extraction. Une marge d'une cellule de
  // chaque cote absorbe un eventuel anchor centre (0.5) sur les particules.
  container.boundsArea = new Rectangle(
    -CELL,
    -CELL,
    COLS * CELL + 2 * CELL,
    ROWS * CELL + 2 * CELL,
  );

  try {
    app.renderer.render(app.stage);
    const before = app.renderer.extract.pixels({ target: container });

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p) {
        continue;
      }
      // Une autre image de l'atlas : teinte differente garantie par construction.
      p.texture = frames[(i + 1) % FRAMES] as Texture;
    }
    container.update();
    app.renderer.render(app.stage);
    const after = app.renderer.extract.pixels({ target: container });

    const totalPixels = before.width * before.height;
    let changedPixels = 0;
    for (let px = 0; px < before.pixels.length; px += 4) {
      if (
        before.pixels[px] !== after.pixels[px] ||
        before.pixels[px + 1] !== after.pixels[px + 1] ||
        before.pixels[px + 2] !== after.pixels[px + 2] ||
        before.pixels[px + 3] !== after.pixels[px + 3]
      ) {
        changedPixels++;
      }
    }

    // Seuil derive de la geometrie, pas choisi a l'instinct : chaque
    // particule repeint le rectangle plein dessine dans l'atlas (`CELL - 8`
    // de cote, pas la cellule entiere qui inclut une bordure transparente
    // inchangee) ; on exige qu'au moins la moitie de cette aire cumulee ait
    // change de couleur pour parler d'animation.
    const paintedAreaPerParticle = (CELL - 8) * (CELL - 8);
    const expectedPaintedArea = COUNT * paintedAreaPerParticle;
    const animatedThreshold = expectedPaintedArea / 2;

    return {
      animated: changedPixels > animatedThreshold,
      changedPixels,
      totalPixels,
    };
  } finally {
    app.stage.removeChild(container);
    container.destroy();
  }
}

/** fps reels sur la duree demandee. Exige un onglet au premier plan. */
async function fpsRun(count: number, seconds: number): Promise<Record<string, number | string>> {
  const scene = buildParticleScene(count);
  const frames: number[] = [];
  const start = performance.now();
  let last = start;

  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      scene.advance(now * 0.001);
      app.renderer.render(app.stage);
      if (now - start < seconds * 1000) {
        requestAnimationFrame(tick);
      } else {
        resolve();
      }
    };
    requestAnimationFrame(tick);
  });
  scene.destroy();

  const sorted = frames.slice(1).sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  return {
    sprites: count,
    secondes: round2((performance.now() - start) / 1000),
    images: frames.length,
    'fps median': median > 0 ? Math.round(1000 / median) : 0,
    'fps au p95 des images':
      percentile(sorted, 0.95) > 0 ? Math.round(1000 / percentile(sorted, 0.95)) : 0,
  };
}

// ── Interface de la page ─────────────────────────────────────────────────────

const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');

function setStatus(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function renderTable(title: string, rows: readonly object[]): void {
  if (!resultsEl || rows.length === 0) {
    return;
  }
  const first = rows[0];
  if (!first) {
    return;
  }
  const keys = Object.keys(first);
  const head = keys.map((k) => `<th>${k}</th>`).join('');
  const body = rows
    .map((row) => {
      const cells = keys
        .map((k) => {
          const v = (row as Record<string, unknown>)[k];
          if (typeof v === 'boolean') {
            return `<td class="${v ? 'ok' : 'ko'}">${v ? 'OK' : 'hors budget'}</td>`;
          }
          return `<td>${String(v)}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  resultsEl.insertAdjacentHTML(
    'beforeend',
    `<div><strong>${title}</strong><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
  );
}

function wire(id: string, label: string, action: () => Promise<void> | void): void {
  const button = document.getElementById(id) as HTMLButtonElement | null;
  button?.addEventListener('click', async () => {
    button.disabled = true;
    setStatus(`${label} en cours…`);
    // Une image laissee au navigateur pour qu'il repeigne le bouton desactive
    // avant que la boucle serree ne monopolise le fil principal.
    await new Promise((r) => setTimeout(r, 50));
    await action();
    setStatus('prêt.');
    button.disabled = false;
  });
}

wire('run-sweep', 'Balayage', () => {
  const result = sweep();
  renderTable('Coût par image', result.rows);
  renderTable('Plafonds à 60 fps', [result.ceilings]);
});

wire('run-particles', "Budget d'effets", () => {
  const result = particleBudget();
  renderTable("Budget de particules d'effet", result.rows);
});

wire('run-animated', 'Horde animée', () => {
  renderTable('Horde animée (un atlas, uvs dynamiques)', animatedSweep().rows);
});

wire('run-fps', 'Mesure fps', async () => {
  const rows: Record<string, number | string>[] = [];
  for (const count of [1500, 3000, 6000]) {
    rows.push(await fpsRun(count, 20));
  }
  renderTable('fps réels sur 20 s', rows);
});

// Cablage dedie plutot qu'un `wire(...)` : le resultat doit rester lisible
// dans la ligne de statut, alors que `wire` l'ecrase par « prêt. » a la fin
// de chaque action.
const proveButton = document.getElementById('run-prove') as HTMLButtonElement | null;
proveButton?.addEventListener('click', () => {
  proveButton.disabled = true;
  const result = proveAnimation();
  setStatus(
    `preuve : ${result.animated ? 'animation confirmee' : 'AUCUN CHANGEMENT — uvs dynamique ne fonctionne pas'} — ${result.changedPixels}/${result.totalPixels} pixels changés.`,
  );
  proveButton.disabled = false;
});

// Point d'entree pour piloter le banc depuis la console ou un outil : il rend
// du JSON, ce qui permet de recuperer les chiffres sans lire le tableau.
declare global {
  interface Window {
    __tarnokBench: {
      sweep: () => SweepResult;
      particleBudget: () => SweepResult;
      animatedSweep: () => SweepResult;
      proveAnimation: () => AnimationProof;
      fpsRun: (count: number, seconds: number) => Promise<Record<string, number | string>>;
    };
  }
}

window.__tarnokBench = { sweep, particleBudget, animatedSweep, proveAnimation, fpsRun };
setStatus('prêt.');
