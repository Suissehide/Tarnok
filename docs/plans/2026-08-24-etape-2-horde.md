# Étape 2 — la horde : plan d'implémentation

> **Pour un agent exécutant :** SOUS-COMPÉTENCE REQUISE — utiliser
> `superpowers:subagent-driven-development` (recommandé) ou
> `superpowers:executing-plans` pour dérouler ce plan tâche par tâche. Les étapes
> utilisent des cases à cocher (`- [ ]`).

**But :** mille ennemis convergent identiquement sur quatre clients, sans qu'aucune position
de monstre ne transite sur le fil.

**Architecture :** un module de horde dans `shared/`, exécuté à l'identique par le serveur
et par chaque client, piloté par des ordres de vague de 18 octets. L'identité des entités
est arithmétique (donc exacte), leur position est flottante (donc approximative, et bornée
par un test). Les deux côtés calculent le flowfield à partir des positions du tick `T − 3`
pour que leurs entrées soient identiques.

**Stack :** TypeScript, Vitest, PixiJS v8 (`ParticleContainer`), Python 3 + Pillow pour
l'atlas (hors chaîne de build).

**Spec :** [`../specs/2026-08-24-etape-2-horde.md`](../specs/2026-08-24-etape-2-horde.md) —
à lire avant de commencer. Le plan argumente depuis la spec ; les deux voyagent ensemble.

## Contraintes globales

- **Code et identifiants en anglais, commentaires et documentation en français.**
- **Conventional Commits**, imposés par commitlint. `git commit -m "wip"` est refusé.
- **`back/src/room.ts` n'importe ni `ws` ni `fastify`** — une règle Biome le refuse.
- **Aucun fichier dérivé de Tiny Swords n'entre dans le dépôt** — la CI échoue sinon.
  L'atlas produit va sur MinIO, jamais dans `git`.
- **Jamais un objet par ennemi** — tableaux typés uniquement (§4.4 de l'orientation).
- **Le générateur pseudo-aléatoire ne sert qu'à l'apparition**, jamais par tick.
- Après chaque tâche : `npm run lint && npm run typecheck && npm test` doivent être verts.
- Formater avec `npm run format` avant de committer — `biome check` échoue sur un fichier
  non formaté.

## Structure des fichiers

| Fichier | Responsabilité |
| --- | --- |
| `shared/random.ts` | générateur déterministe, partagé serveur/client |
| `shared/archetypes.ts` | la table du bestiaire : nom, planche, images, vitesse |
| `shared/waves.ts` | type `WaveOrder` et les quatre formations |
| `shared/worldmap.ts` | génération déterministe des obstacles depuis `mapSeed` |
| `shared/horde.ts` | l'état de la horde en tableaux typés, `spawn` et `step` |
| `shared/player-history.ts` | historique court des positions, pour l'alignement `T − K` |
| `shared/protocol.ts` | + `WAVE_ORDER`, + `mapSeed` dans `WELCOME` |
| `shared/constants.ts` | cadences et nouvelles constantes |
| `back/src/wave-director.ts` | décide quand une vague sort et avec quels paramètres |
| `back/src/room.ts` | intègre horde, champs et directeur de vagues |
| `front/src/net/client.ts` | reçoit les ordres, fait tourner la horde locale |
| `front/src/render/horde-renderer.ts` | `ParticleContainer`, animation, tri, culling |
| `tools/build_monster_atlas.py` | construit l'atlas et son `monsters.json` |

---

## Tâche 0 : prouver que `ParticleContainer` sait animer

Le §11 de la spec le désigne comme le seul risque non levé. La documentation de Pixi v8 dit
que `uvs: true` permet l'animation — **c'est de la documentation, pas une mesure.** Si c'est
faux, tout le §9 de la spec est à réécrire, et il vaut mieux l'apprendre maintenant qu'après
avoir écrit le rendu.

**Fichiers :**
- Modifier : `front/bench/render.ts`
- Modifier : `front/bench/render.html`

**Interfaces :**
- Consomme : rien.
- Produit : un bouton « Horde animée » sur la page de banc, et la réponse à la question.

- [ ] **Étape 1 : ajouter une scène animée au banc**

Dans `front/bench/render.ts`, après `buildSpriteScene`, ajouter :

```ts
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
```

Ajouter `Rectangle` à l'import de `pixi.js` en tête de fichier.

- [ ] **Étape 2 : exposer la mesure**

Toujours dans `front/bench/render.ts`, après `particleBudget()` :

```ts
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
```

Puis, à côté des autres `wire(...)` :

```ts
wire('run-animated', 'Horde animée', () => {
  renderTable('Horde animée (un atlas, uvs dynamiques)', animatedSweep().rows);
});
```

Et exposer `animatedSweep` dans `window.__tarnokBench` en l'ajoutant à l'objet et à la
déclaration `declare global`.

- [ ] **Étape 3 : ajouter le bouton**

Dans `front/bench/render.html`, à côté des trois boutons existants :

```html
<button id="run-animated" type="button">Horde animée (atlas + uvs)</button>
```

- [ ] **Étape 4 : vérifier**

```bash
npm run dev -w front
```

Ouvrir `http://localhost:5173/bench/render.html` **au premier plan**, cliquer « Horde
animée ».

Attendu : un tableau avec des temps du même ordre que la ligne `ParticleContainer` du banc
de l'étape 1, et **à l'écran, des carrés qui changent de couleur** en ordre dispersé.

> ⚠️ **Si les carrés ne changent pas de couleur, l'animation par `uvs` ne fonctionne pas.**
> **STOP.** Ne pas continuer le plan : signaler le résultat, le §9 de la spec est à
> reprendre. Le repli connu est un `Mesh` instancié avec un attribut d'index d'image, mais
> c'est une conception différente, pas un correctif.

- [ ] **Étape 5 : commit**

```bash
npm run format && npm run lint
git add front/bench/render.ts front/bench/render.html
git commit -m "bench: prouver que ParticleContainer sait animer depuis un atlas"
```

---

## Tâche 1 : `shared/random.ts`

**Fichiers :**
- Créer : `shared/random.ts`
- Créer : `shared/random.test.ts`
- Modifier : `back/bench/harness.ts` (retirer la copie locale)

**Interfaces :**
- Consomme : rien.
- Produit : `makeRandom(seed: number): () => number`, `randomRange(rng, min, max): number`.

- [ ] **Étape 1 : écrire le test qui échoue**

`shared/random.test.ts` :

```ts
import { describe, expect, it } from 'vitest';

import { makeRandom, randomRange } from './random';

describe('makeRandom', () => {
  it('rend la meme suite pour la meme graine', () => {
    const a = makeRandom(12345);
    const b = makeRandom(12345);
    const suiteA = [a(), a(), a(), a(), a()];
    const suiteB = [b(), b(), b(), b(), b()];

    expect(suiteA).toEqual(suiteB);
  });

  it('rend des suites differentes pour des graines differentes', () => {
    const a = makeRandom(1);
    const b = makeRandom(2);

    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
  });

  it('reste dans [0, 1)', () => {
    const rng = makeRandom(999);
    for (let i = 0; i < 10_000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('ne se bloque pas sur zero', () => {
    // xorshift a un point fixe en 0 : une graine nulle rendrait 0 a l'infini
    // et toutes les formations s'effondreraient sur un point.
    const rng = makeRandom(0);
    const values = new Set([rng(), rng(), rng(), rng()]);

    expect(values.size).toBeGreaterThan(1);
  });
});

describe('randomRange', () => {
  it('reste dans les bornes', () => {
    const rng = makeRandom(7);
    for (let i = 0; i < 1000; i++) {
      const v = randomRange(rng, -50, 50);
      expect(v).toBeGreaterThanOrEqual(-50);
      expect(v).toBeLessThan(50);
    }
  });
});
```

- [ ] **Étape 2 : vérifier que le test échoue**

```bash
npm test -w back
```
Attendu : ÉCHEC, `Cannot find module './random'`.

- [ ] **Étape 3 : implémenter**

`shared/random.ts` :

```ts
/**
 * Generateur pseudo-aleatoire deterministe, partage serveur/client.
 *
 * C'est lui qui transforme la graine d'un ordre de vague en positions de
 * formation, identiquement des deux cotes. Sans determinisme ici, deux clients
 * font apparaitre la meme vague a des endroits differents et tout le §3.3 de
 * l'orientation s'effondre.
 *
 * ⚠️ A n'utiliser qu'a **l'apparition**, jamais par tick : un tirage par tick
 * ferait dependre l'etat du nombre de pas executes, et la moindre difference de
 * cadence divergerait sans retour.
 */
export function makeRandom(seed: number): () => number {
  // xorshift32 a un point fixe en zero : une graine nulle rendrait 0 a
  // l'infini et toutes les formations s'effondreraient sur un point.
  let state = seed >>> 0 || 0x9e37_79b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** Tirage uniforme dans [min, max). */
export function randomRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}
```

- [ ] **Étape 4 : vérifier que le test passe**

```bash
npm test -w back
```
Attendu : SUCCÈS.

- [ ] **Étape 5 : faire pointer le banc sur la version partagée**

Dans `back/bench/harness.ts`, supprimer la fonction `makeRandom` et la remplacer par une
réexportation, pour que le banc et le jeu tirent la même suite :

```ts
export { makeRandom } from '@shared/random';
```

Vérifier que le banc tourne toujours :

```bash
npm run bench:sim -w back
```
Attendu : le tableau s'affiche, avec les mêmes chiffres qu'avant.

- [ ] **Étape 6 : commit**

```bash
npm run format && npm run lint && npm run typecheck
git add shared/random.ts shared/random.test.ts back/bench/harness.ts
git commit -m "feat(shared): generateur pseudo-aleatoire deterministe partage"
```

---

## Tâche 2 : `shared/archetypes.ts`

**Fichiers :**
- Créer : `shared/archetypes.ts`
- Créer : `shared/archetypes.test.ts`

**Interfaces :**
- Consomme : rien.
- Produit : `ARCHETYPES: readonly Archetype[]`, `PIETAILLE_COUNT: number`,
  `archetypeOf(id: number): Archetype`.

- [ ] **Étape 1 : écrire le test qui échoue**

`shared/archetypes.test.ts` :

```ts
import { describe, expect, it } from 'vitest';

import { ARCHETYPES, archetypeOf, PIETAILLE_COUNT } from './archetypes';

describe('ARCHETYPES', () => {
  it('indexe chaque archetype a sa position dans le tableau', () => {
    ARCHETYPES.forEach((a, i) => {
      expect(a.id).toBe(i);
    });
  });

  it('tient sur un octet, puisque le protocole encode l archetype en u8', () => {
    expect(ARCHETYPES.length).toBeLessThanOrEqual(256);
  });

  it('donne une planche et un nombre d images a chaque archetype', () => {
    for (const a of ARCHETYPES) {
      expect(a.sheet).toMatch(/\.png$/);
      expect(a.frames).toBeGreaterThan(0);
      expect(a.cell).toBeGreaterThan(0);
      expect(a.speed).toBeGreaterThan(0);
    }
  });

  it('cable les quatre premiers pour l etape 2', () => {
    expect(ARCHETYPES.slice(0, 4).map((a) => a.name)).toEqual([
      'skull',
      'gnoll',
      'spider',
      'torch-goblin',
    ]);
  });

  it("n'a que des cellules de 192 px en pietaille — c'est ce qui tient dans l'atlas", () => {
    for (let i = 0; i < PIETAILLE_COUNT; i++) {
      expect(archetypeOf(i).cell).toBe(192);
    }
  });
});

describe('archetypeOf', () => {
  it('leve sur un identifiant inconnu plutot que de rendre undefined', () => {
    expect(() => archetypeOf(250)).toThrow(/inconnu/i);
  });
});
```

- [ ] **Étape 2 : vérifier que le test échoue**

```bash
npm test -w back
```
Attendu : ÉCHEC, `Cannot find module './archetypes'`.

- [ ] **Étape 3 : implémenter**

`shared/archetypes.ts` :

```ts
/**
 * Le bestiaire, et son regime de replication.
 *
 * La taille des sprites du pack tombe pile sur la distinction du §3.3 de
 * l'orientation, ce qui n'est pas un hasard : les 192 px n'ont qu'un `Walk`,
 * les gros ont `Windup` / `Attack` / `Recovery`, ce qui est un vocabulaire de
 * boss.
 *
 * - **Pietaille** (192 px) : repliquee par le generateur, rendue en batch.
 * - **Elite** (256 px et plus) : repliquee comme entite, rendue en `Sprite`.
 *   Hors perimetre de l'etape 2, recensee ici pour que l'ajouter soit du
 *   contenu et pas de l'architecture.
 */
export interface Archetype {
  id: number;
  name: string;
  /** Chemin de la planche dans le pack, relatif a `Monsters/`. */
  sheet: string;
  /** Nombre d'images du cycle de deplacement. */
  frames: number;
  /** Cote de la cellule, en pixels. */
  cell: number;
  /** Vitesse de deplacement, en pixels monde par seconde. */
  speed: number;
}

/**
 * Les cellules font toutes 192 px en pietaille : c'est ce qui permet un
 * rangement par etageres quasi optimal dans l'atlas (§9.2 de la spec).
 */
const PIETAILLE: readonly Omit<Archetype, 'id'>[] = [
  { name: 'skull', sheet: 'Skull/Skull_Run.png', frames: 6, cell: 192, speed: 95 },
  { name: 'gnoll', sheet: 'Gnoll/Gnoll_Walk.png', frames: 8, cell: 192, speed: 85 },
  { name: 'spider', sheet: 'Spider/Spider_Run.png', frames: 5, cell: 192, speed: 115 },
  {
    name: 'torch-goblin',
    sheet: 'Torch Goblin/Torch Goblin_Run.png',
    frames: 6,
    cell: 192,
    speed: 100,
  },
  { name: 'lizard', sheet: 'Lizard/Lizard_Run.png', frames: 6, cell: 192, speed: 105 },
  { name: 'snake', sheet: 'Snake/Snake_Run.png', frames: 8, cell: 192, speed: 90 },
  { name: 'gnome', sheet: 'Gnome/Gnome_Run.png', frames: 6, cell: 192, speed: 95 },
  {
    name: 'slingshot-gnome',
    sheet: 'Slingshot Gnome/Slingshot Gnome_Run.png',
    frames: 6,
    cell: 192,
    speed: 90,
  },
  { name: 'thief', sheet: 'Thief/Thief_Run.png', frames: 6, cell: 192, speed: 120 },
  { name: 'giant-bat', sheet: 'Giant Bat/Giant Bat_Move.png', frames: 4, cell: 192, speed: 130 },
  { name: 'bomb-fish', sheet: 'Bomb Fish/Bomb Fish_Run.png', frames: 6, cell: 192, speed: 80 },
  { name: 'hex-shaman', sheet: 'Hex Shaman/Hex Shaman_Run.png', frames: 4, cell: 192, speed: 85 },
  {
    name: 'paddle-shark',
    sheet: 'Paddle Shark/Paddle Shark_Run.png',
    frames: 6,
    cell: 192,
    speed: 100,
  },
  {
    name: 'harpoon-shark',
    sheet: 'Harpoon Shark/Harpoon Shark_Run.png',
    frames: 6,
    cell: 192,
    speed: 95,
  },
];

/** Hors perimetre de l'etape 2 : regime de replication different (§3.3). */
const ELITES: readonly Omit<Archetype, 'id'>[] = [
  {
    name: 'spear-goblin',
    sheet: 'Spear Goblin/Spear Goblin_Run.png',
    frames: 6,
    cell: 256,
    speed: 110,
  },
  { name: 'bear', sheet: 'Bear/Bear_Run.png', frames: 5, cell: 256, speed: 105 },
  { name: 'panda', sheet: 'Panda/Panda_Run.png', frames: 6, cell: 256, speed: 100 },
  { name: 'turtle', sheet: 'Turtle/Turtle_Walk.png', frames: 7, cell: 320, speed: 60 },
  { name: 'minotaur', sheet: 'Minotaur/Minotaur_Walk.png', frames: 8, cell: 320, speed: 80 },
  { name: 'troll', sheet: 'Troll/Troll_Walk.png', frames: 10, cell: 384, speed: 65 },
];

/** Nombre d'archetypes de pietaille. Les elites viennent apres, dans le tableau. */
export const PIETAILLE_COUNT = PIETAILLE.length;

export const ARCHETYPES: readonly Archetype[] = [...PIETAILLE, ...ELITES].map((a, id) => ({
  ...a,
  id,
}));

/** Les quatre cables a l'etape 2, choisis pour leurs silhouettes distinctes. */
export const STEP2_ARCHETYPES = [0, 1, 2, 3] as const;

export function archetypeOf(id: number): Archetype {
  const found = ARCHETYPES[id];
  if (!found) {
    throw new Error(`archetype inconnu : ${id}`);
  }
  return found;
}
```

- [ ] **Étape 4 : vérifier que le test passe**

```bash
npm test -w back
```
Attendu : SUCCÈS.

- [ ] **Étape 5 : commit**

```bash
npm run format && npm run lint && npm run typecheck
git add shared/archetypes.ts shared/archetypes.test.ts
git commit -m "feat(shared): table du bestiaire et regimes de replication"
```

---

## Tâche 3 : `shared/waves.ts` — ordres de vague et formations

**Fichiers :**
- Créer : `shared/waves.ts`
- Créer : `shared/waves.test.ts`

**Interfaces :**
- Consomme : `makeRandom` (tâche 1).
- Produit : `WaveOrder`, `FORMATION`, `formationPositions(order, outX, outY): void`.

- [ ] **Étape 1 : écrire le test qui échoue**

`shared/waves.test.ts` :

```ts
import { describe, expect, it } from 'vitest';

import { FORMATION, formationPositions, type WaveOrder } from './waves';

function order(overrides: Partial<WaveOrder> = {}): WaveOrder {
  return {
    waveId: 1,
    spawnTick: 100,
    seed: 0xabc_def,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: 3000,
    anchorY: 3000,
    count: 200,
    ...overrides,
  };
}

function positionsOf(o: WaveOrder): { x: Float32Array; y: Float32Array } {
  const x = new Float32Array(o.count);
  const y = new Float32Array(o.count);
  formationPositions(o, x, y);
  return { x, y };
}

describe('formationPositions', () => {
  it('rend exactement les memes positions pour la meme graine', () => {
    const a = positionsOf(order());
    const b = positionsOf(order());

    expect([...a.x]).toEqual([...b.x]);
    expect([...a.y]).toEqual([...b.y]);
  });

  it('rend des positions differentes pour une graine differente', () => {
    const a = positionsOf(order({ seed: 1 }));
    const b = positionsOf(order({ seed: 2 }));

    expect([...a.x]).not.toEqual([...b.x]);
  });

  it('remplit toutes les entites demandees', () => {
    const { x } = positionsOf(order({ count: 500 }));

    // Une position non ecrite resterait a 0, tres loin de l'ancre.
    for (let i = 0; i < 500; i++) {
      expect(Math.abs((x[i] ?? 0) - 3000)).toBeLessThan(2000);
    }
  });

  it('groupe RING sur un anneau autour de l ancre', () => {
    const { x, y } = positionsOf(order({ formation: FORMATION.RING, count: 100 }));

    const rayons: number[] = [];
    for (let i = 0; i < 100; i++) {
      rayons.push(Math.hypot((x[i] ?? 0) - 3000, (y[i] ?? 0) - 3000));
    }
    const min = Math.min(...rayons);
    const max = Math.max(...rayons);

    // Un anneau, pas un disque : le rayon varie peu.
    expect(min).toBeGreaterThan(100);
    expect(max - min).toBeLessThan(120);
  });

  it('rend CLUSTER plus dense que SCATTER', () => {
    const scatter = positionsOf(order({ formation: FORMATION.SCATTER, count: 300 }));
    const cluster = positionsOf(order({ formation: FORMATION.CLUSTER, count: 300 }));

    expect(meanNearestNeighbour(cluster)).toBeLessThan(meanNearestNeighbour(scatter));
  });

  it('borne toutes les positions a la carte', () => {
    const { x, y } = positionsOf(order({ anchorX: 20, anchorY: 20, count: 300 }));

    for (let i = 0; i < 300; i++) {
      expect(x[i]).toBeGreaterThanOrEqual(0);
      expect(y[i]).toBeGreaterThanOrEqual(0);
    }
  });
});

/** Distance moyenne au plus proche voisin — une mesure de densite. */
function meanNearestNeighbour(p: { x: Float32Array; y: Float32Array }): number {
  let total = 0;
  for (let i = 0; i < p.x.length; i++) {
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < p.x.length; j++) {
      if (i === j) {
        continue;
      }
      const d = Math.hypot((p.x[i] ?? 0) - (p.x[j] ?? 0), (p.y[i] ?? 0) - (p.y[j] ?? 0));
      if (d < best) {
        best = d;
      }
    }
    total += best;
  }
  return total / p.x.length;
}
```

- [ ] **Étape 2 : vérifier que le test échoue**

```bash
npm test -w back
```
Attendu : ÉCHEC, `Cannot find module './waves'`.

- [ ] **Étape 3 : implémenter**

`shared/waves.ts` :

```ts
import { MAP_SIZE } from './constants';
import { makeRandom } from './random';

/**
 * Un ordre de vague : la seule chose que le serveur decide et diffuse pour la
 * horde. 18 octets, une fois par vague, contre ~150 ko/s si l'on repliquait les
 * positions (§2.1 de la spec de l'etape 2).
 */
export interface WaveOrder {
  waveId: number;
  spawnTick: number;
  seed: number;
  archetype: number;
  formation: number;
  anchorX: number;
  anchorY: number;
  count: number;
}

export const FORMATION = { SCATTER: 0, RING: 1, COLUMN: 2, CLUSTER: 3 } as const;

export type FormationId = (typeof FORMATION)[keyof typeof FORMATION];

const SCATTER_RADIUS = 900;
const RING_RADIUS = 700;
const RING_JITTER = 90;
const COLUMN_LENGTH = 1400;
const COLUMN_WIDTH = 160;
const CLUSTER_COUNT = 5;
const CLUSTER_SPREAD = 800;
const CLUSTER_RADIUS = 170;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Remplit `outX` / `outY` avec les positions d'apparition de la vague.
 *
 * Fonction pure de `(seed, count, formation, ancre)` : c'est elle qui garantit
 * que deux clients font apparaitre la meme vague au meme endroit sans qu'un
 * seul octet de position ne transite.
 */
export function formationPositions(
  order: WaveOrder,
  outX: Float32Array,
  outY: Float32Array,
): void {
  const rng = makeRandom(order.seed);
  const { count, anchorX, anchorY } = order;

  for (let i = 0; i < count; i++) {
    let dx = 0;
    let dy = 0;

    switch (order.formation) {
      case FORMATION.RING: {
        const angle = rng() * Math.PI * 2;
        const radius = RING_RADIUS + (rng() - 0.5) * RING_JITTER;
        dx = Math.cos(angle) * radius;
        dy = Math.sin(angle) * radius;
        break;
      }
      case FORMATION.COLUMN: {
        // L'orientation vient de la graine : deux vagues successives au meme
        // endroit ne se superposent pas.
        const heading = makeRandom(order.seed ^ 0x5f37_1d2b)() * Math.PI * 2;
        const along = (rng() - 0.5) * COLUMN_LENGTH;
        const across = (rng() - 0.5) * COLUMN_WIDTH;
        dx = Math.cos(heading) * along - Math.sin(heading) * across;
        dy = Math.sin(heading) * along + Math.cos(heading) * across;
        break;
      }
      case FORMATION.CLUSTER: {
        // Grappes denses : c'est ce qui fabrique la sensation de masse (§4.1),
        // pas le compteur.
        const cluster = i % CLUSTER_COUNT;
        const clusterRng = makeRandom(order.seed + cluster * 0x9e37_79b9);
        const cx = (clusterRng() - 0.5) * CLUSTER_SPREAD;
        const cy = (clusterRng() - 0.5) * CLUSTER_SPREAD;
        const angle = rng() * Math.PI * 2;
        const radius = Math.sqrt(rng()) * CLUSTER_RADIUS;
        dx = cx + Math.cos(angle) * radius;
        dy = cy + Math.sin(angle) * radius;
        break;
      }
      default: {
        // SCATTER. `sqrt` donne une densite uniforme dans le disque ; sans lui
        // tout s'agglutine au centre.
        const angle = rng() * Math.PI * 2;
        const radius = Math.sqrt(rng()) * SCATTER_RADIUS;
        dx = Math.cos(angle) * radius;
        dy = Math.sin(angle) * radius;
        break;
      }
    }

    outX[i] = clamp(anchorX + dx, 0, MAP_SIZE);
    outY[i] = clamp(anchorY + dy, 0, MAP_SIZE);
  }
}
```

- [ ] **Étape 4 : vérifier que le test passe**

```bash
npm test -w back
```
Attendu : SUCCÈS. Si le test `RING` échoue sur l'écart de rayon, ajuster `RING_JITTER`, pas
le test — c'est le test qui exprime l'intention « un anneau, pas un disque ».

- [ ] **Étape 5 : commit**

```bash
npm run format && npm run lint && npm run typecheck
git add shared/waves.ts shared/waves.test.ts
git commit -m "feat(shared): ordres de vague et quatre formations deterministes"
```

---

## Tâche 4 : `shared/worldmap.ts` — obstacles déterministes

Le flowfield ne donne le même champ des deux côtés que si les deux murent **les mêmes
cellules**. Le client régénère la carte depuis `mapSeed` ; il ne la reçoit pas.

**Fichiers :**
- Créer : `shared/worldmap.ts`
- Créer : `shared/worldmap.test.ts`

**Interfaces :**
- Consomme : `makeRandom` (tâche 1), `FlowField` (existant).
- Produit : `generateObstacles(mapSeed, cols, rows): Uint8Array`,
  `applyObstacles(field: FlowField, mask: Uint8Array): void`.

- [ ] **Étape 1 : écrire le test qui échoue**

`shared/worldmap.test.ts` :

```ts
import { describe, expect, it } from 'vitest';

import { FlowField } from './flowfield';
import { applyObstacles, generateObstacles } from './worldmap';

describe('generateObstacles', () => {
  it('rend exactement la meme carte pour la meme graine', () => {
    const a = generateObstacles(4242, 40, 40);
    const b = generateObstacles(4242, 40, 40);

    expect([...a]).toEqual([...b]);
  });

  it('rend des cartes differentes pour des graines differentes', () => {
    const a = generateObstacles(1, 40, 40);
    const b = generateObstacles(2, 40, 40);

    expect([...a]).not.toEqual([...b]);
  });

  it('mure une part raisonnable de la carte', () => {
    const mask = generateObstacles(7, 60, 60);
    const blocked = mask.reduce((n, v) => n + v, 0);
    const ratio = blocked / mask.length;

    // Assez pour que contourner ait un sens, pas au point d'enfermer la horde.
    expect(ratio).toBeGreaterThan(0.02);
    expect(ratio).toBeLessThan(0.15);
  });

  it('laisse le centre libre : c est la que les joueurs apparaissent', () => {
    const cols = 40;
    const mask = generateObstacles(11, cols, 40);
    const centre = Math.floor(20) * cols + Math.floor(20);

    expect(mask[centre]).toBe(0);
  });
});

describe('applyObstacles', () => {
  it('reporte le masque dans le champ', () => {
    const field = new FlowField(400, 100);
    const mask = new Uint8Array(field.cols * field.rows);
    mask[5] = 1;

    applyObstacles(field, mask);

    expect(field.blocked[5]).toBe(1);
  });

  it('efface les obstacles precedents', () => {
    const field = new FlowField(400, 100);
    field.block(1, 1);
    const vide = new Uint8Array(field.cols * field.rows);

    applyObstacles(field, vide);

    expect(field.blocked[1 * field.cols + 1]).toBe(0);
  });

  it('donne le meme champ a deux instances qui partagent le masque', () => {
    const mask = generateObstacles(303, 60, 60);
    const a = new FlowField(3840, 64);
    const b = new FlowField(3840, 64);
    applyObstacles(a, mask);
    applyObstacles(b, mask);

    a.update(1000, 1000);
    b.update(1000, 1000);

    expect([...a.dirX]).toEqual([...b.dirX]);
  });
});
```

- [ ] **Étape 2 : vérifier que le test échoue**

```bash
npm test -w back
```
Attendu : ÉCHEC, `Cannot find module './worldmap'`.

- [ ] **Étape 3 : implémenter**

`shared/worldmap.ts` :

```ts
import type { FlowField } from './flowfield';
import { makeRandom } from './random';

/**
 * Carte d'obstacles, regeneree a l'identique de chaque cote.
 *
 * Le client **regenere** la carte depuis `mapSeed`, il ne la recoit pas : une
 * carte de 6000 px a 64 px par cellule fait 8836 cellules, et les envoyer
 * couterait plus cher que tout le reste du protocole reuni.
 *
 * Le champ de flux ne concorde entre serveur et client que si les deux murent
 * exactement les memes cellules — c'est la condition du §5.1 de la spec.
 */

/** Part de cellules murees visee. */
const BLOCKED_RATIO = 0.06;

/** Rayon, en cellules, de la zone laissee libre au centre. */
const SPAWN_CLEARANCE = 4;

export function generateObstacles(mapSeed: number, cols: number, rows: number): Uint8Array {
  const rng = makeRandom(mapSeed);
  const mask = new Uint8Array(cols * rows);

  const centreX = Math.floor(cols / 2);
  const centreY = Math.floor(rows / 2);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      // On tire pour **chaque** cellule, y compris celles qu'on laissera
      // libres : sauter un tirage ferait dependre la suite de la geometrie, et
      // deux cartes de tailles differentes ne seraient plus comparables.
      const draw = rng();
      const nearSpawn =
        Math.abs(cx - centreX) <= SPAWN_CLEARANCE && Math.abs(cy - centreY) <= SPAWN_CLEARANCE;
      if (!nearSpawn && draw < BLOCKED_RATIO) {
        mask[cy * cols + cx] = 1;
      }
    }
  }

  return mask;
}

/** Reporte un masque d'obstacles dans un champ, en effacant le precedent. */
export function applyObstacles(field: FlowField, mask: Uint8Array): void {
  field.blocked.fill(0);
  field.blocked.set(mask);
}
```

- [ ] **Étape 4 : vérifier que le test passe**

```bash
npm test -w back
```
Attendu : SUCCÈS.

- [ ] **Étape 5 : commit**

```bash
npm run format && npm run lint && npm run typecheck
git add shared/worldmap.ts shared/worldmap.test.ts
git commit -m "feat(shared): carte d'obstacles regeneree depuis une graine"
```

---

## Tâche 5 : `shared/constants.ts` et le protocole

**Fichiers :**
- Modifier : `shared/constants.ts`
- Modifier : `shared/protocol.ts`
- Modifier : `shared/protocol.test.ts`

**Interfaces :**
- Consomme : `WaveOrder` (tâche 3).
- Produit : `MSG.WAVE_ORDER`, `encodeWaveOrder`, `decodeWaveOrder`,
  `encodeWelcome(playerId, tick, mapSeed)`, `WelcomeMessage.mapSeed`.

- [ ] **Étape 1 : mettre à jour les constantes**

Dans `shared/constants.ts`, remplacer les valeurs de `SNAPSHOT_HZ` et `INTERP_DELAY_MS`, et
ajouter les nouvelles :

```ts
/**
 * Diffusion serveur -> clients.
 *
 * 30 Hz et non les 15-20 du §3.5 de l'orientation. L'ecart est **paye par la
 * mesure** : le banc de l'etape 1 donne 0,47 ko/s par joueur contre 5-15
 * estimes au §3.3. Il fallait cette cadence pour qu'un tampon d'interpolation
 * de 60 ms contienne plus d'un intervalle — a 20 Hz il n'en contenait que 1,2,
 * et la moindre gigue le vidait.
 */
export const SNAPSHOT_HZ = 30;

/**
 * Retard du tampon d'interpolation client.
 *
 * 60 ms plutot que 100 : ca ramene le decalage visuel du corps d'un allie de
 * 26 a 15 px. Tenable seulement parce que la diffusion est passee a 30 Hz.
 */
export const INTERP_DELAY_MS = 60;

/**
 * Retard, en ticks, applique aux positions de joueurs qui alimentent le
 * flowfield — **des deux cotes**.
 *
 * Le serveur s'impose le retard qu'il inflige au client. Sans ca, les deux
 * cotes calculent leur champ a partir d'entrees differentes, les directions
 * divergent, et une erreur de direction ne se rattrape pas : elle s'accumule a
 * chaque pas. Voir §5 de la spec de l'etape 2.
 *
 * Ne coute rien de perceptible : le champ n'est deja recalcule qu'a 10 Hz, soit
 * une granularite de 100 ms.
 */
export const FIELD_INPUT_DELAY_TICKS = 3;

/** Plafond d'entites vivantes par salon. */
export const MAX_ENTITIES = 4000;

/** Identites reservees par vague. Voir `entityIdOf`. */
export const MAX_PER_WAVE = 4096;
```

- [ ] **Étape 2 : écrire les tests de protocole qui échouent**

Dans `shared/protocol.test.ts`, ajouter l'import de `encodeWaveOrder`, `decodeWaveOrder`, et
remplacer le bloc `encodeWelcome / decodeWelcome`, puis ajouter :

```ts
describe('encodeWelcome / decodeWelcome', () => {
  it("rend l'identifiant attribue, le tick courant et la graine de carte", () => {
    expect(decodeWelcome(encodeWelcome(3, 900, 0xdead_beef))).toEqual({
      type: MSG.WELCOME,
      playerId: 3,
      tick: 900,
      mapSeed: 0xdead_beef,
    });
  });
});

describe('encodeWaveOrder / decodeWaveOrder', () => {
  const order = {
    waveId: 7,
    spawnTick: 1234,
    seed: 0x1234_5678,
    archetype: 2,
    formation: 3,
    anchorX: -1200,
    anchorY: 5900,
    count: 1000,
  };

  it("rend exactement l'ordre encode", () => {
    expect(decodeWaveOrder(encodeWaveOrder(order))).toEqual({
      type: MSG.WAVE_ORDER,
      ...order,
    });
  });

  it('tient en 19 octets : 1 de type et 18 de charge utile', () => {
    expect(encodeWaveOrder(order).byteLength).toBe(19);
  });

  it('ne grossit pas avec le nombre d entites — c est tout le sujet du §3.3', () => {
    const petite = encodeWaveOrder({ ...order, count: 10 });
    const enorme = encodeWaveOrder({ ...order, count: 4000 });

    expect(enorme.byteLength).toBe(petite.byteLength);
  });

  it('leve sur un buffer tronque', () => {
    const tronque = encodeWaveOrder(order).slice(0, 12);

    expect(() => decodeWaveOrder(tronque)).toThrow(/tronqu/i);
  });
});
```

Et dans le bloc `decode`, ajouter :

```ts
  it('aiguille aussi sur un ordre de vague', () => {
    const buf = encodeWaveOrder({
      waveId: 1,
      spawnTick: 2,
      seed: 3,
      archetype: 0,
      formation: 0,
      anchorX: 0,
      anchorY: 0,
      count: 5,
    });

    expect(decode(buf)).toMatchObject({ type: MSG.WAVE_ORDER, waveId: 1 });
  });
```

- [ ] **Étape 3 : vérifier que les tests échouent**

```bash
npm test -w back
```
Attendu : ÉCHEC — `encodeWaveOrder` n'existe pas, et `decodeWelcome` ne rend pas `mapSeed`.

- [ ] **Étape 4 : implémenter**

Dans `shared/protocol.ts` :

```ts
export const MSG = { WELCOME: 1, SNAPSHOT: 2, INPUT: 3, WAVE_ORDER: 4 } as const;

export const WELCOME_BYTES = 10;
export const WAVE_ORDER_BYTES = 19;
```

Remplacer `WelcomeMessage`, `encodeWelcome` et `decodeWelcome` :

```ts
export interface WelcomeMessage {
  type: typeof MSG.WELCOME;
  playerId: number;
  tick: number;
  /** Graine de la carte d'obstacles : le client la **regenere**, il ne la recoit pas. */
  mapSeed: number;
}

export function encodeWelcome(playerId: number, tick: number, mapSeed: number): ArrayBuffer {
  const buf = new ArrayBuffer(WELCOME_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.WELCOME);
  v.setUint8(1, playerId);
  v.setUint32(2, tick >>> 0, true);
  v.setUint32(6, mapSeed >>> 0, true);
  return buf;
}

export function decodeWelcome(buf: ArrayBuffer): WelcomeMessage {
  const v = viewOf(buf, WELCOME_BYTES);
  return {
    type: MSG.WELCOME,
    playerId: v.getUint8(1),
    tick: v.getUint32(2, true),
    mapSeed: v.getUint32(6, true),
  };
}
```

Ajouter, avant `decode` :

```ts
export interface WaveOrderMessage {
  type: typeof MSG.WAVE_ORDER;
  waveId: number;
  spawnTick: number;
  seed: number;
  archetype: number;
  formation: number;
  anchorX: number;
  anchorY: number;
  count: number;
}

/**
 * S -> C : l'ordre de faire apparaitre une vague. 19 octets, **quel que soit le
 * nombre d'entites**.
 *
 * C'est la mise en oeuvre du §3.3 : on ne replique pas la horde, on replique
 * son generateur. Repliquer 1 000 ennemis a 30 Hz couterait ~150 ko/s.
 */
export function encodeWaveOrder(order: {
  waveId: number;
  spawnTick: number;
  seed: number;
  archetype: number;
  formation: number;
  anchorX: number;
  anchorY: number;
  count: number;
}): ArrayBuffer {
  const buf = new ArrayBuffer(WAVE_ORDER_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.WAVE_ORDER);
  v.setUint16(1, order.waveId & 0xffff, true);
  v.setUint32(3, order.spawnTick >>> 0, true);
  v.setUint32(7, order.seed >>> 0, true);
  v.setUint8(11, order.archetype);
  v.setUint8(12, order.formation);
  v.setInt16(13, Math.round(order.anchorX), true);
  v.setInt16(15, Math.round(order.anchorY), true);
  v.setUint16(17, order.count & 0xffff, true);
  return buf;
}

export function decodeWaveOrder(buf: ArrayBuffer): WaveOrderMessage {
  const v = viewOf(buf, WAVE_ORDER_BYTES);
  return {
    type: MSG.WAVE_ORDER,
    waveId: v.getUint16(1, true),
    spawnTick: v.getUint32(3, true),
    seed: v.getUint32(7, true),
    archetype: v.getUint8(11),
    formation: v.getUint8(12),
    anchorX: v.getInt16(13, true),
    anchorY: v.getInt16(15, true),
    count: v.getUint16(17, true),
  };
}
```

Étendre `Message` et `decode` :

```ts
export type Message = WelcomeMessage | SnapshotMessage | InputMessage | WaveOrderMessage;
```

et dans le `switch` de `decode` :

```ts
    case MSG.WAVE_ORDER:
      return decodeWaveOrder(buf);
```

- [ ] **Étape 5 : corriger les appelants**

`encodeWelcome` prend un argument de plus. Dans `back/src/server.ts`, `Session.add` :

```ts
    ws.send(encodeWelcome(id, this.room.tick, this.room.mapSeed));
```

`Room` n'a pas encore `mapSeed` — l'ajouter à la tâche 7. En attendant, pour que la tâche 5
compile et que les tests passent, ajouter dès maintenant dans `back/src/room.ts` :

```ts
  /** Graine de la carte d'obstacles, tiree a la creation du salon. */
  readonly mapSeed: number = (Math.random() * 0xffff_ffff) >>> 0;
```

- [ ] **Étape 6 : vérifier que tout passe**

```bash
npm run typecheck && npm test
```
Attendu : SUCCÈS des deux côtés. Les tests front d'interpolation utilisent
`INTERP_DELAY_MS` symboliquement, donc le passage à 60 ms ne les casse pas.

- [ ] **Étape 7 : commit**

```bash
npm run format && npm run lint
git add shared/constants.ts shared/protocol.ts shared/protocol.test.ts back/src/room.ts back/src/server.ts
git commit -m "feat(shared): message WAVE_ORDER, mapSeed au WELCOME, diffusion a 30 Hz"
```

---

## Tâche 6 : `shared/horde.ts`

**Fichiers :**
- Créer : `shared/horde.ts`
- Créer : `shared/horde.test.ts`

**Interfaces :**
- Consomme : `WaveOrder` + `formationPositions` (tâche 3), `archetypeOf` (tâche 2),
  `FlowField` (existant), `MAX_PER_WAVE` (tâche 5).
- Produit : `entityIdOf(waveId, index): number`, `class Horde`.

- [ ] **Étape 1 : écrire le test qui échoue**

`shared/horde.test.ts` :

```ts
import { describe, expect, it } from 'vitest';

import { FlowField } from './flowfield';
import { entityIdOf, Horde } from './horde';
import { FORMATION, type WaveOrder } from './waves';

const DT = 1 / 30;

function order(overrides: Partial<WaveOrder> = {}): WaveOrder {
  return {
    waveId: 1,
    spawnTick: 0,
    seed: 0x1234,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: 1000,
    anchorY: 1000,
    count: 50,
    ...overrides,
  };
}

function fieldsTowards(x: number, y: number): FlowField[] {
  return Array.from({ length: 4 }, () => {
    const f = new FlowField(6000, 64);
    f.update(x, y);
    return f;
  });
}

describe('entityIdOf', () => {
  it('ne produit jamais deux fois le meme identifiant', () => {
    const ids = new Set<number>();
    for (let wave = 0; wave < 50; wave++) {
      for (let i = 0; i < 100; i++) {
        ids.add(entityIdOf(wave, i));
      }
    }

    expect(ids.size).toBe(50 * 100);
  });

  it('ne recycle pas : la vague 2 ne reprend pas les identifiants de la vague 1', () => {
    expect(entityIdOf(2, 0)).toBeGreaterThan(entityIdOf(1, 4095));
  });
});

describe('Horde.spawn', () => {
  it('ajoute exactement le nombre demande', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 250 }));

    expect(horde.count).toBe(250);
  });

  it('cumule les vagues', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 1, count: 100 }));
    horde.spawn(order({ waveId: 2, count: 150 }));

    expect(horde.count).toBe(250);
  });

  it('donne a chaque entite son identite et son archetype', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 3, archetype: 2, count: 10 }));

    expect(horde.entityIdAt(0)).toBe(entityIdOf(3, 0));
    expect(horde.archetype[0]).toBe(2);
  });

  it('disperse les phases d animation : mille crânes ne marchent pas au pas', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 300 }));

    const phases = new Set([...horde.animPhase.slice(0, 300)]);
    expect(phases.size).toBeGreaterThan(3);
  });

  it('refuse de depasser sa capacite au lieu de deborder', () => {
    const horde = new Horde(100);
    horde.spawn(order({ count: 80 }));
    horde.spawn(order({ waveId: 2, count: 80 }));

    expect(horde.count).toBe(100);
  });
});

describe('Horde.step', () => {
  it('fait converger la horde vers la cible du champ', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 100, anchorX: 1000, anchorY: 1000 }));
    const fields = fieldsTowards(4000, 4000);
    horde.retarget([4000, 4000, 4000, 4000], [4000, 4000, 4000, 4000]);

    const avant = meanDistanceTo(horde, 4000, 4000);
    for (let i = 0; i < 300; i++) {
      horde.step(DT, fields);
    }

    expect(meanDistanceTo(horde, 4000, 4000)).toBeLessThan(avant - 500);
  });

  it('est deterministe : deux hordes, memes ordres, memes positions', () => {
    const fields = fieldsTowards(4000, 4000);
    const a = new Horde(1000);
    const b = new Horde(1000);
    for (const h of [a, b]) {
      h.spawn(order({ count: 200 }));
      h.retarget([4000, 4000, 4000, 4000], [4000, 4000, 4000, 4000]);
      for (let i = 0; i < 200; i++) {
        h.step(DT, fields);
      }
    }

    expect([...a.x.slice(0, 200)]).toEqual([...b.x.slice(0, 200)]);
  });

  it('ne sort pas de la carte', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 100 }));
    const fields = fieldsTowards(0, 0);
    horde.retarget([0, 0, 0, 0], [0, 0, 0, 0]);
    for (let i = 0; i < 2000; i++) {
      horde.step(DT, fields);
    }

    for (let i = 0; i < horde.count; i++) {
      expect(horde.x[i]).toBeGreaterThanOrEqual(0);
      expect(horde.y[i]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Horde.retarget', () => {
  it('envoie chaque entite vers le joueur le plus proche', () => {
    const horde = new Horde(10);
    horde.spawn(order({ count: 2, formation: FORMATION.SCATTER }));
    horde.x[0] = 100;
    horde.y[0] = 100;
    horde.x[1] = 5000;
    horde.y[1] = 5000;

    horde.retarget([0, 5900], [0, 5900]);

    expect(horde.targetField[0]).toBe(0);
    expect(horde.targetField[1]).toBe(1);
  });
});

function meanDistanceTo(horde: Horde, x: number, y: number): number {
  let total = 0;
  for (let i = 0; i < horde.count; i++) {
    total += Math.hypot((horde.x[i] ?? 0) - x, (horde.y[i] ?? 0) - y);
  }
  return total / horde.count;
}
```

- [ ] **Étape 2 : vérifier que le test échoue**

```bash
npm test -w back
```
Attendu : ÉCHEC, `Cannot find module './horde'`.

- [ ] **Étape 3 : implémenter**

`shared/horde.ts` :

```ts
import { archetypeOf } from './archetypes';
import { MAP_SIZE, MAX_PER_WAVE } from './constants';
import type { FlowField } from './flowfield';
import { formationPositions, type WaveOrder } from './waves';

/**
 * L'identite est **arithmetique**, pas negociee.
 *
 * Aucun aller-retour, aucun octet : deux clients qui recoivent le meme ordre de
 * vague ne *peuvent pas* fabriquer des identifiants differents. C'est ce qui
 * rendra sensé, a l'etape 3, un message « l'entite 4211 est morte » — il n'y a
 * pas de table de correspondance a synchroniser, donc pas de table a
 * desynchroniser.
 */
export function entityIdOf(waveId: number, index: number): number {
  return waveId * MAX_PER_WAVE + index;
}

/**
 * L'etat de la horde, en tableaux typés.
 *
 * Jamais un objet par ennemi (§4.4 de l'orientation) : a 1 500 entites, le cout
 * des indirections et de la pression memoire depasse celui de tout le pas de
 * simulation.
 *
 * Le serveur et chaque client executent ce meme code. Ce qui doit etre
 * identique — l'ensemble des identites, les archetypes — l'est par arithmetique
 * entiere. Les positions, elles, ont le droit de deriver de quelques pixels
 * (§2.2 de la spec).
 */
export class Horde {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly archetype: Uint8Array;
  readonly waveId: Uint16Array;
  readonly indexInWave: Uint16Array;
  /** Decalage du cycle d'animation. Purement cosmetique, hors contrat. */
  readonly animPhase: Uint8Array;
  /** Index du champ suivi : le joueur le plus proche. */
  readonly targetField: Uint8Array;

  #count = 0;

  constructor(readonly capacity: number) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.archetype = new Uint8Array(capacity);
    this.waveId = new Uint16Array(capacity);
    this.indexInWave = new Uint16Array(capacity);
    this.animPhase = new Uint8Array(capacity);
    this.targetField = new Uint8Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  entityIdAt(slot: number): number {
    return entityIdOf(this.waveId[slot] ?? 0, this.indexInWave[slot] ?? 0);
  }

  /** Fait apparaitre une vague. Tronque plutot que de deborder. */
  spawn(order: WaveOrder): void {
    const room = this.capacity - this.#count;
    const count = Math.min(order.count, room, MAX_PER_WAVE);
    if (count <= 0) {
      return;
    }

    const px = new Float32Array(count);
    const py = new Float32Array(count);
    formationPositions({ ...order, count }, px, py);

    const frames = archetypeOf(order.archetype).frames;

    for (let i = 0; i < count; i++) {
      const slot = this.#count + i;
      this.x[slot] = px[i] ?? 0;
      this.y[slot] = py[i] ?? 0;
      this.archetype[slot] = order.archetype;
      this.waveId[slot] = order.waveId;
      this.indexInWave[slot] = i;
      // La phase se derive de l'index, pas d'un tirage : elle doit etre la meme
      // partout pour qu'une capture d'ecran de debug soit comparable.
      this.animPhase[slot] = (i * 7 + order.waveId * 3) % frames;
    }

    this.#count += count;
  }

  /**
   * Reaffecte chaque entite au joueur le plus proche.
   *
   * Appele a la cadence du flowfield (10 Hz), pas a chaque tick : changer de
   * cible chaque tick fait vibrer les trajectoires.
   */
  retarget(playerX: readonly number[], playerY: readonly number[]): void {
    for (let i = 0; i < this.#count; i++) {
      const ex = this.x[i] ?? 0;
      const ey = this.y[i] ?? 0;
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let p = 0; p < playerX.length; p++) {
        const dx = (playerX[p] ?? 0) - ex;
        const dy = (playerY[p] ?? 0) - ey;
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      this.targetField[i] = best;
    }
  }

  /** Un pas de simulation. `dt` est fixe : 1 / TICK_HZ. */
  step(dt: number, fields: readonly FlowField[]): void {
    for (let i = 0; i < this.#count; i++) {
      const field = fields[this.targetField[i] ?? 0];
      if (!field) {
        continue;
      }
      const speed = archetypeOf(this.archetype[i] ?? 0).speed * dt;
      const ex = this.x[i] ?? 0;
      const ey = this.y[i] ?? 0;
      const cell = field.indexAt(ex, ey);
      this.x[i] = clamp(ex + (field.dirX[cell] ?? 0) * speed, 0, MAP_SIZE);
      this.y[i] = clamp(ey + (field.dirY[cell] ?? 0) * speed, 0, MAP_SIZE);
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
```

- [ ] **Étape 4 : vérifier que le test passe**

```bash
npm test -w back
```
Attendu : SUCCÈS.

- [ ] **Étape 5 : commit**

```bash
npm run format && npm run lint && npm run typecheck
git add shared/horde.ts shared/horde.test.ts
git commit -m "feat(shared): module de horde en tableaux typés, identite arithmetique"
```

---

## Tâche 7 : `shared/player-history.ts` — l'alignement `T − K`

**Fichiers :**
- Créer : `shared/player-history.ts`
- Créer : `shared/player-history.test.ts`

**Interfaces :**
- Consomme : `FIELD_INPUT_DELAY_TICKS` (tâche 5).
- Produit : `class PlayerHistory` avec `record(tick, xs, ys)` et
  `delayed(tick): { x: number[]; y: number[] } | null`.

- [ ] **Étape 1 : écrire le test qui échoue**

`shared/player-history.test.ts` :

```ts
import { FIELD_INPUT_DELAY_TICKS } from './constants';
import { describe, expect, it } from 'vitest';

import { PlayerHistory } from './player-history';

describe('PlayerHistory', () => {
  it('rend les positions du tick retarde, pas celles du tick courant', () => {
    const h = new PlayerHistory();
    for (let tick = 0; tick <= 10; tick++) {
      h.record(tick, [tick * 100], [0]);
    }

    const vu = h.delayed(10);

    expect(vu?.x[0]).toBe((10 - FIELD_INPUT_DELAY_TICKS) * 100);
  });

  it("rend null tant que l'historique n'est pas assez profond", () => {
    const h = new PlayerHistory();
    h.record(0, [0], [0]);

    expect(h.delayed(0)).toBeNull();
  });

  it('ne garde pas un historique sans fin', () => {
    const h = new PlayerHistory();
    for (let tick = 0; tick < 5000; tick++) {
      h.record(tick, [tick], [tick]);
    }

    expect(h.size).toBeLessThanOrEqual(16);
  });

  it('rend le meme resultat aux deux bouts : c est tout le point', () => {
    // Le serveur enregistre a chaque tick ; le client enregistre a la reception
    // des snapshots. Tant que le tick demande est present des deux cotes, ils
    // lisent la meme chose.
    const serveur = new PlayerHistory();
    const client = new PlayerHistory();
    for (let tick = 0; tick <= 20; tick++) {
      serveur.record(tick, [tick * 10, tick * 5], [0, 0]);
    }
    // Le client a recu les memes snapshots, avec du retard.
    for (let tick = 0; tick <= 20; tick++) {
      client.record(tick, [tick * 10, tick * 5], [0, 0]);
    }

    expect(client.delayed(18)).toEqual(serveur.delayed(18));
  });

  it("s'accroche au plus ancien connu plutot que de rendre null si le tick est trop vieux", () => {
    const h = new PlayerHistory();
    for (let tick = 100; tick <= 120; tick++) {
      h.record(tick, [tick], [0]);
    }

    // Tick demande anterieur a tout l'historique : degradation gracieuse.
    expect(h.delayed(101)).not.toBeNull();
  });
});
```

- [ ] **Étape 2 : vérifier que le test échoue**

```bash
npm test -w back
```
Attendu : ÉCHEC, `Cannot find module './player-history'`.

- [ ] **Étape 3 : implémenter**

`shared/player-history.ts` :

```ts
import { FIELD_INPUT_DELAY_TICKS, MAX_PLAYERS } from './constants';

/**
 * Historique court des positions de joueurs, pour alimenter le flowfield.
 *
 * **C'est la piece qui empeche les hordes de diverger.** Le flowfield se
 * calcule a partir des positions des joueurs ; le serveur les connait a
 * l'instant present, le client ne connait celles des autres qu'avec du retard.
 * Deux entrees differentes donnent deux champs differents — et une erreur de
 * *direction* ne se rattrape pas, elle s'accumule a chaque pas.
 *
 * La parade : les deux cotes lisent les positions du tick `T - K`. Le serveur
 * s'impose le retard qu'il inflige au client, et les entrees redeviennent
 * identiques. Voir §5 de la spec de l'etape 2.
 */

/** Profondeur d'historique : de quoi couvrir le retard et un peu de gigue. */
const DEPTH = 16;

export interface PlayerPositions {
  x: number[];
  y: number[];
}

export class PlayerHistory {
  readonly #ticks = new Int32Array(DEPTH).fill(-1);
  readonly #x = new Float32Array(DEPTH * MAX_PLAYERS);
  readonly #y = new Float32Array(DEPTH * MAX_PLAYERS);
  readonly #counts = new Uint8Array(DEPTH);
  #recorded = 0;

  get size(): number {
    return Math.min(this.#recorded, DEPTH);
  }

  record(tick: number, xs: readonly number[], ys: readonly number[]): void {
    const slot = ((tick % DEPTH) + DEPTH) % DEPTH;
    const count = Math.min(xs.length, MAX_PLAYERS);
    this.#ticks[slot] = tick;
    this.#counts[slot] = count;
    for (let p = 0; p < count; p++) {
      this.#x[slot * MAX_PLAYERS + p] = xs[p] ?? 0;
      this.#y[slot * MAX_PLAYERS + p] = ys[p] ?? 0;
    }
    this.#recorded++;
  }

  /**
   * Positions du tick `tick - FIELD_INPUT_DELAY_TICKS`.
   *
   * Rend `null` tant que l'historique n'est pas assez profond — au demarrage.
   * Si le tick vise est sorti de l'historique, s'accroche au plus ancien connu :
   * une degradation gracieuse vaut mieux qu'une horde qui s'arrete.
   */
  delayed(tick: number): PlayerPositions | null {
    const wanted = tick - FIELD_INPUT_DELAY_TICKS;
    const exact = this.#at(wanted);
    if (exact) {
      return exact;
    }

    let bestTick = -1;
    for (let slot = 0; slot < DEPTH; slot++) {
      const t = this.#ticks[slot] ?? -1;
      if (t >= 0 && t <= wanted && t > bestTick) {
        bestTick = t;
      }
    }
    if (bestTick >= 0) {
      return this.#at(bestTick);
    }

    // Rien d'assez ancien : on prend le plus vieux disponible, ou rien.
    let oldest = -1;
    for (let slot = 0; slot < DEPTH; slot++) {
      const t = this.#ticks[slot] ?? -1;
      if (t >= 0 && (oldest < 0 || t < oldest)) {
        oldest = t;
      }
    }
    return oldest >= 0 && oldest <= tick - 1 ? this.#at(oldest) : null;
  }

  #at(tick: number): PlayerPositions | null {
    if (tick < 0) {
      return null;
    }
    const slot = ((tick % DEPTH) + DEPTH) % DEPTH;
    if (this.#ticks[slot] !== tick) {
      return null;
    }
    const count = this.#counts[slot] ?? 0;
    const x: number[] = [];
    const y: number[] = [];
    for (let p = 0; p < count; p++) {
      x.push(this.#x[slot * MAX_PLAYERS + p] ?? 0);
      y.push(this.#y[slot * MAX_PLAYERS + p] ?? 0);
    }
    return { x, y };
  }
}
```

- [ ] **Étape 4 : vérifier que le test passe**

```bash
npm test -w back
```
Attendu : SUCCÈS.

- [ ] **Étape 5 : commit**

```bash
npm run format && npm run lint && npm run typecheck
git add shared/player-history.ts shared/player-history.test.ts
git commit -m "feat(shared): historique de positions pour aligner les entrees du flowfield"
```

---

## Tâche 8 : le test de réplication — **le livrable de l'étape**

Écrit **avant** l'intégration, parce que c'est lui qui définit ce que « convergent
identiquement » veut dire. Il doit échouer tant que rien ne l'alimente.

**Fichiers :**
- Créer : `shared/horde.replication.test.ts`

**Interfaces :**
- Consomme : tout ce qui précède.
- Produit : la définition exécutable du livrable.

- [ ] **Étape 1 : écrire le test**

`shared/horde.replication.test.ts` :

```ts
import { describe, expect, it } from 'vitest';

import { FIELD_INPUT_DELAY_TICKS, FLOWFIELD_CELL, FLOWFIELD_HZ, MAP_SIZE, TICK_HZ } from './constants';
import { FlowField } from './flowfield';
import { Horde } from './horde';
import { PlayerHistory } from './player-history';
import { FORMATION, type WaveOrder } from './waves';
import { applyObstacles, generateObstacles } from './worldmap';

const DT = 1 / TICK_HZ;
const STEPS = 600;
const PARTICIPANTS = 5; // le serveur, plus quatre clients
const ENTITIES = 1000;

/** Seuil de derive tolere, en pixels. Valeur de depart, a confirmer par la mesure. */
const DRIFT_LIMIT_PX = 2;

/**
 * Une instance de simulation : ce que fait le serveur, et ce que fait chaque
 * client. Le code est le meme des deux cotes — c'est tout le sujet.
 */
function makeParticipant(mapSeed: number): {
  horde: Horde;
  fields: FlowField[];
  history: PlayerHistory;
} {
  const horde = new Horde(4000);
  const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
  const mask = generateObstacles(mapSeed, probe.cols, probe.rows);
  const fields = Array.from({ length: 4 }, () => {
    const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    applyObstacles(f, mask);
    return f;
  });
  return { horde, fields, history: new PlayerHistory() };
}

describe("le livrable de l'etape 2", () => {
  it('fait converger 1 000 ennemis identiquement sur cinq simulations', () => {
    const mapSeed = 0xc0ff_ee12;
    const parts = Array.from({ length: PARTICIPANTS }, () => makeParticipant(mapSeed));

    const order: WaveOrder = {
      waveId: 1,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 1200,
      anchorY: 1200,
      count: ENTITIES,
    };
    for (const p of parts) {
      p.horde.spawn(order);
    }

    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    let maxDrift = 0;

    for (let tick = 0; tick < STEPS; tick++) {
      // Les joueurs bougent : un champ fige ne prouverait rien.
      const xs = [0, 1, 2, 3].map((p) => 3000 + Math.cos(tick * 0.02 + p) * 1500);
      const ys = [0, 1, 2, 3].map((p) => 3000 + Math.sin(tick * 0.02 + p) * 1500);

      for (const p of parts) {
        p.history.record(tick, xs, ys);

        if (tick % stepsPerField === 0) {
          // ⚠️ Les positions du tick retarde, pas celles du tick courant.
          const seen = p.history.delayed(tick);
          if (seen) {
            for (let f = 0; f < 4; f++) {
              p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
            }
            p.horde.retarget(seen.x, seen.y);
          }
        }

        p.horde.step(DT, p.fields);
      }

      // 1. L'ensemble des identites doit etre STRICTEMENT egal.
      const reference = parts[0];
      if (!reference) {
        throw new Error('aucun participant');
      }
      for (const p of parts.slice(1)) {
        expect(p.horde.count).toBe(reference.horde.count);
      }

      // 2. La position a le droit de deriver, mais de facon bornee.
      for (const p of parts.slice(1)) {
        for (let i = 0; i < reference.horde.count; i++) {
          const drift = Math.hypot(
            (p.horde.x[i] ?? 0) - (reference.horde.x[i] ?? 0),
            (p.horde.y[i] ?? 0) - (reference.horde.y[i] ?? 0),
          );
          if (drift > maxDrift) {
            maxDrift = drift;
          }
        }
      }
    }

    // Le chiffre est affiche pour etre lisible plutot que cache : c'est lui qui
    // permettra de confirmer ou d'ajuster le seuil (§12 de la spec).
    console.log(`derive maximale observee : ${maxDrift.toFixed(3)} px sur ${STEPS} pas`);

    expect(maxDrift).toBeLessThan(DRIFT_LIMIT_PX);
  });

  it('donne les memes identites a toutes les simulations', () => {
    const parts = Array.from({ length: PARTICIPANTS }, () => makeParticipant(1));
    const order: WaveOrder = {
      waveId: 9,
      spawnTick: 0,
      seed: 42,
      archetype: 1,
      formation: FORMATION.RING,
      anchorX: 2000,
      anchorY: 2000,
      count: 500,
    };
    for (const p of parts) {
      p.horde.spawn(order);
    }

    const reference = parts[0];
    if (!reference) {
      throw new Error('aucun participant');
    }
    const ids = Array.from({ length: reference.horde.count }, (_, i) =>
      reference.horde.entityIdAt(i),
    );

    for (const p of parts.slice(1)) {
      const autres = Array.from({ length: p.horde.count }, (_, i) => p.horde.entityIdAt(i));
      expect(autres).toEqual(ids);
    }
  });
});
```

- [ ] **Étape 2 : exécuter et lire la dérive**

```bash
npm test -w back
```

Attendu : **SUCCÈS**, et une ligne `derive maximale observee : ... px`.

> Toutes les simulations exécutant le même code sur les mêmes entrées, la dérive attendue
> est **exactement 0**. Si elle l'est, c'est normal et c'est même le but : le seuil de 2 px
> est là pour le jour où les entrées cesseront d'être rigoureusement identiques — latence
> réelle, snapshot manquant.
>
> **Si la dérive n'est pas nulle, s'arrêter et comprendre pourquoi avant de continuer.** Ça
> voudrait dire qu'une source de non-déterminisme s'est glissée dans `shared/` (un
> `Math.random`, un `Date.now`, un parcours d'objet dont l'ordre varie).

- [ ] **Étape 3 : commit**

```bash
npm run format && npm run lint && npm run typecheck
git add shared/horde.replication.test.ts
git commit -m "test(shared): le livrable de l'etape 2, cinq simulations et un seuil de derive"
```

---

## Tâche 9 : intégration serveur

**Fichiers :**
- Créer : `back/src/wave-director.ts`
- Créer : `back/src/wave-director.test.ts`
- Modifier : `back/src/room.ts`
- Modifier : `back/src/room.test.ts`
- Modifier : `back/src/server.ts`

**Interfaces :**
- Consomme : `Horde`, `PlayerHistory`, `FlowField`, `encodeWaveOrder`.
- Produit : `class WaveDirector` avec `due(tick): WaveOrder | null` ;
  `Room.mapSeed`, `Room.horde`, `Room.pendingOrders`.

- [ ] **Étape 1 : écrire le test du directeur de vagues**

`back/src/wave-director.test.ts` :

```ts
import { TICK_HZ } from '@shared/constants';
import { describe, expect, it } from 'vitest';

import { WaveDirector } from './wave-director';

describe('WaveDirector', () => {
  it('ne sort rien avant la premiere echeance', () => {
    const d = new WaveDirector(1234);

    expect(d.due(0, [3000], [3000])).toBeNull();
  });

  it('sort une vague a la cadence prevue', () => {
    const d = new WaveDirector(1234);
    let vagues = 0;
    for (let tick = 0; tick < TICK_HZ * 60; tick++) {
      if (d.due(tick, [3000], [3000])) {
        vagues++;
      }
    }

    // Une vague toutes les ~6 s sur une minute.
    expect(vagues).toBeGreaterThanOrEqual(8);
    expect(vagues).toBeLessThanOrEqual(12);
  });

  it('numerote les vagues sans jamais reutiliser un identifiant', () => {
    const d = new WaveDirector(1);
    const ids: number[] = [];
    for (let tick = 0; tick < TICK_HZ * 120; tick++) {
      const o = d.due(tick, [3000], [3000]);
      if (o) {
        ids.push(o.waveId);
      }
    }

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ancre la vague pres d un joueur, pas au hasard sur la carte', () => {
    const d = new WaveDirector(77);
    let order = null;
    for (let tick = 0; tick < TICK_HZ * 60 && !order; tick++) {
      order = d.due(tick, [1000], [1000]);
    }

    expect(order).not.toBeNull();
    expect(Math.hypot((order?.anchorX ?? 0) - 1000, (order?.anchorY ?? 0) - 1000)).toBeLessThan(
      2500,
    );
  });

  it('est deterministe pour une meme graine', () => {
    const a = new WaveDirector(5);
    const b = new WaveDirector(5);
    for (let tick = 0; tick < TICK_HZ * 30; tick++) {
      expect(a.due(tick, [3000], [3000])).toEqual(b.due(tick, [3000], [3000]));
    }
  });
});
```

- [ ] **Étape 2 : vérifier que le test échoue**

```bash
npm test -w back
```
Attendu : ÉCHEC, `Cannot find module './wave-director'`.

- [ ] **Étape 3 : implémenter le directeur**

`back/src/wave-director.ts` :

```ts
import { TICK_HZ } from '@shared/constants';
import { makeRandom } from '@shared/random';
import { FORMATION, type WaveOrder } from '@shared/waves';

/**
 * Decide quand une vague sort, et avec quels parametres.
 *
 * Les vagues sont **pilotees par la donnee, pas par du script** (§9.1 de
 * l'orientation). A l'etape 2, la « donnee » se reduit a des bornes tirees ;
 * l'etape 3 lui donnera de vraies definitions typees.
 *
 * Le directeur ne vit que sur le serveur : c'est lui qui decide, les clients
 * obeissent.
 */

const PERIOD_TICKS = TICK_HZ * 6;
const MIN_COUNT = 120;
const MAX_COUNT = 320;
/** Distance a laquelle une vague apparait autour d'un joueur. */
const ANCHOR_RADIUS = 1800;

/** Les quatre archetypes cables a l'etape 2. */
const ARCHETYPE_POOL = [0, 1, 2, 3];
const FORMATION_POOL = [
  FORMATION.SCATTER,
  FORMATION.RING,
  FORMATION.COLUMN,
  FORMATION.CLUSTER,
];

export class WaveDirector {
  #nextWaveId = 1;
  readonly #rng: () => number;

  constructor(seed: number) {
    this.#rng = makeRandom(seed);
  }

  /** Rend un ordre si une vague est due a ce tick, sinon null. */
  due(tick: number, playerX: readonly number[], playerY: readonly number[]): WaveOrder | null {
    if (tick === 0 || tick % PERIOD_TICKS !== 0 || playerX.length === 0) {
      return null;
    }

    // Ancrage autour d'un joueur : le §8 de l'orientation veut que la densite
    // se calcule par grappe de joueurs proches, pas globalement.
    const target = Math.floor(this.#rng() * playerX.length);
    const angle = this.#rng() * Math.PI * 2;
    const radius = ANCHOR_RADIUS * (0.6 + this.#rng() * 0.4);

    const order: WaveOrder = {
      waveId: this.#nextWaveId++,
      spawnTick: tick,
      seed: (this.#rng() * 0xffff_ffff) >>> 0,
      archetype: ARCHETYPE_POOL[Math.floor(this.#rng() * ARCHETYPE_POOL.length)] ?? 0,
      formation: FORMATION_POOL[Math.floor(this.#rng() * FORMATION_POOL.length)] ?? 0,
      anchorX: Math.round((playerX[target] ?? 0) + Math.cos(angle) * radius),
      anchorY: Math.round((playerY[target] ?? 0) + Math.sin(angle) * radius),
      count: Math.round(MIN_COUNT + this.#rng() * (MAX_COUNT - MIN_COUNT)),
    };
    return order;
  }
}
```

- [ ] **Étape 4 : vérifier que le test passe**

```bash
npm test -w back
```
Attendu : SUCCÈS.

- [ ] **Étape 5 : écrire le test d'intégration de `Room`**

Ajouter à `back/src/room.test.ts` :

```ts
describe('Room et la horde', () => {
  it('fait apparaitre des vagues au fil du temps', () => {
    const room = new Room();
    room.join(1);
    for (let i = 0; i < TICK_HZ * 20; i++) {
      room.step(DT);
    }

    expect(room.horde.count).toBeGreaterThan(0);
  });

  it('met les ordres de vague dans une file que le serveur vide', () => {
    const room = new Room();
    room.join(1);
    for (let i = 0; i < TICK_HZ * 20; i++) {
      room.step(DT);
    }

    const ordres = room.drainWaveOrders();

    expect(ordres.length).toBeGreaterThan(0);
    expect(room.drainWaveOrders()).toHaveLength(0);
  });

  it('alimente son flowfield avec les positions retardees, comme le client', () => {
    // On ne peut pas observer le champ directement ; on verifie que le salon a
    // bien un historique et qu'il ne plante pas avant qu'il soit profond.
    const room = new Room();
    room.join(1);

    expect(() => {
      for (let i = 0; i < 5; i++) {
        room.step(DT);
      }
    }).not.toThrow();
  });

  it('a une graine de carte stable pendant toute la vie du salon', () => {
    const room = new Room();
    const graine = room.mapSeed;
    for (let i = 0; i < 100; i++) {
      room.step(DT);
    }

    expect(room.mapSeed).toBe(graine);
  });
});
```

- [ ] **Étape 6 : vérifier que le test échoue**

```bash
npm test -w back
```
Attendu : ÉCHEC — `room.horde` et `room.drainWaveOrders` n'existent pas.

- [ ] **Étape 7 : intégrer dans `Room`**

Dans `back/src/room.ts`, ajouter aux imports :

```ts
import {
  FLOWFIELD_CELL,
  FLOWFIELD_HZ,
  MAP_SIZE,
  MAX_ENTITIES,
  MAX_PLAYERS,
  PLAYER_SPEED,
  TICK_HZ,
} from '@shared/constants';
import { FlowField } from '@shared/flowfield';
import { Horde } from '@shared/horde';
import { PlayerHistory } from '@shared/player-history';
import { applyObstacles, generateObstacles } from '@shared/worldmap';
import type { WaveOrder } from '@shared/waves';

import { WaveDirector } from './wave-director';
```

> ⚠️ `wave-director.ts` n'importe ni `ws` ni `fastify`, donc la règle Biome sur `room.ts`
> reste satisfaite. Ne jamais importer le serveur ici.

Ajouter les champs et la logique :

```ts
  readonly mapSeed: number = (Math.random() * 0xffff_ffff) >>> 0;
  readonly horde = new Horde(MAX_ENTITIES);
  readonly #fields: FlowField[];
  readonly #history = new PlayerHistory();
  readonly #director: WaveDirector;
  #pendingOrders: WaveOrder[] = [];

  constructor() {
    const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    const mask = generateObstacles(this.mapSeed, probe.cols, probe.rows);
    this.#fields = Array.from({ length: MAX_PLAYERS }, () => {
      const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
      applyObstacles(f, mask);
      return f;
    });
    this.#director = new WaveDirector(this.mapSeed ^ 0x5bf0_3a17);
  }

  /** Ordres de vague a diffuser. Le serveur les vide a chaque tick. */
  drainWaveOrders(): WaveOrder[] {
    const orders = this.#pendingOrders;
    this.#pendingOrders = [];
    return orders;
  }
```

Puis, dans `step(dt)`, après la boucle qui déplace les joueurs :

```ts
    const xs: number[] = [];
    const ys: number[] = [];
    for (const p of this.#players.values()) {
      xs.push(p.x);
      ys.push(p.y);
    }
    this.#history.record(this.#tick, xs, ys);

    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    if (this.#tick % stepsPerField === 0) {
      // ⚠️ Les positions **retardees**, pas les courantes. Le serveur s'impose
      // le retard qu'il inflige au client : c'est ce qui rend les deux champs
      // identiques (§5 de la spec de l'etape 2).
      const seen = this.#history.delayed(this.#tick);
      if (seen) {
        for (let f = 0; f < seen.x.length && f < this.#fields.length; f++) {
          this.#fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
        }
        this.horde.retarget(seen.x, seen.y);
      }
    }

    const order = this.#director.due(this.#tick, xs, ys);
    if (order) {
      this.horde.spawn(order);
      this.#pendingOrders.push(order);
    }

    this.horde.step(dt, this.#fields);
```

- [ ] **Étape 8 : diffuser les ordres depuis le serveur**

Dans `back/src/server.ts`, dans `Session.#broadcast`, avant l'envoi du snapshot :

```ts
    // Les ordres de vague partent avant le snapshot du meme tick : un client
    // doit connaitre la vague avant de voir bouger les joueurs qu'elle vise.
    for (const order of this.room.drainWaveOrders()) {
      const buf = encodeWaveOrder(order);
      for (const ws of this.#clients.values()) {
        if (ws.readyState === ws.OPEN) {
          ws.send(buf);
          this.#wireBytes += buf.byteLength;
        }
      }
    }
```

Ajouter `encodeWaveOrder` à l'import de `@shared/protocol`.

> ⚠️ La diffusion des ordres a lieu dans `#broadcast`, donc à `SNAPSHOT_HZ`, pas à chaque
> tick. Un ordre peut ainsi partir jusqu'à un tick après son `spawnTick` — c'est sans
> conséquence, le client connaît le `spawnTick` et sait quoi en faire.

- [ ] **Étape 9 : vérifier**

```bash
npm run typecheck && npm test
```
Attendu : SUCCÈS. Vérifier aussi que la règle Biome tient :

```bash
npx biome check back/src/room.ts
```
Attendu : aucune erreur.

- [ ] **Étape 10 : commit**

```bash
npm run format && npm run lint
git add back/src/wave-director.ts back/src/wave-director.test.ts back/src/room.ts back/src/room.test.ts back/src/server.ts
git commit -m "feat(back): directeur de vagues et horde autoritaire dans le salon"
```

---

## Tâche 10 : le test d'indépendance réseau

Prouve « sans position sur le fil » de façon qui survit aux refactorisations.

**Fichiers :**
- Modifier : `back/src/server.test.ts`

- [ ] **Étape 1 : écrire le test**

Ajouter à `back/src/server.test.ts` :

```ts
  /**
   * La formulation testable de « sans position sur le fil ».
   *
   * Bien meilleure qu'une inspection de code : elle survit aux
   * refactorisations. Si quelqu'un ajoute un jour des positions de monstres
   * dans le snapshot, ce test le voit tout de suite.
   */
  it('ne fait pas grossir le trafic avec le nombre d ennemis', async () => {
    const code = await createRoomCode();
    const { ws } = await connect(code);

    let octets = 0;
    ws.on('message', (data: ArrayBuffer) => {
      octets += data.byteLength;
    });

    // On laisse tourner assez longtemps pour que des vagues sortent.
    await new Promise((r) => setTimeout(r, 1500));
    const octetsAvant = octets;
    octets = 0;
    await new Promise((r) => setTimeout(r, 1500));
    const octetsApres = octets;

    // Entre les deux fenetres, la horde a grossi de plusieurs centaines
    // d'entites. Le trafic, lui, ne doit pas suivre : il reste domine par les
    // 30 snapshots par seconde de 4 joueurs.
    expect(octetsApres).toBeLessThan(octetsAvant * 2);
  }, 10_000);
```

- [ ] **Étape 2 : exécuter**

```bash
npm test -w back
```
Attendu : SUCCÈS.

- [ ] **Étape 3 : commit**

```bash
npm run format && npm run lint
git add back/src/server.test.ts
git commit -m "test(back): le trafic ne grossit pas avec le nombre d'ennemis"
```

---

## Tâche 11 : `tools/build_monster_atlas.py`

**Fichiers :**
- Créer : `tools/build_monster_atlas.py`

**Interfaces :**
- Consomme : `assets/tinyswords/Monsters/**`, la table de `shared/archetypes.ts`.
- Produit : `assets/tinyswords/derived/monsters.png` et `monsters.json`.

> ⚠️ La sortie est **dérivée du pack**, donc soumise à la licence Pixel Frog : elle va dans
> `assets/tinyswords/`, qui est dans `.gitignore`, et de là sur MinIO. **Ne jamais la
> committer.** La CI échoue si elle entre dans l'historique.

- [ ] **Étape 1 : écrire le script**

`tools/build_monster_atlas.py` :

```python
#!/usr/bin/env python3
"""
Construit l'atlas de la pietaille depuis le pack Tiny Swords.

Le §9.2 de la spec de l'etape 2 impose **une seule texture de base** : un
`ParticleContainer` ne batche que si toutes les particules partagent le meme
atlas, et sans batch tout l'interet disparait.

Les planches sources sont des bandes horizontales dont la cellule est carree,
de cote egal a la hauteur : `Gnoll_Walk.png` en 1536x192 fait 8 images de 192.

Toutes les cellules de pietaille faisant 192 de haut, un rangement par etageres
est quasi optimal : dix rangees de 192 dans 2048 offrent 3,93 Mpx utiles, pour
3,06 Mpx a placer.

    python3 tools/build_monster_atlas.py

Sortie : assets/tinyswords/derived/monsters.png et monsters.json
⚠️ Derivee du pack, donc jamais committee. Voir NOTICE-assets.md.
"""

import json
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow manquant : python3 -m pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
MONSTERS = ROOT / "assets" / "tinyswords" / "Monsters"
OUT_DIR = ROOT / "assets" / "tinyswords" / "derived"

ATLAS_SIZE = 2048

# Doit rester d'accord avec la pietaille de shared/archetypes.ts, dans le meme
# ordre : l'index dans cette liste EST l'identifiant d'archetype.
SHEETS = [
    ("skull", "Skull/Skull_Run.png"),
    ("gnoll", "Gnoll/Gnoll_Walk.png"),
    ("spider", "Spider/Spider_Run.png"),
    ("torch-goblin", "Torch Goblin/Torch Goblin_Run.png"),
    ("lizard", "Lizard/Lizard_Run.png"),
    ("snake", "Snake/Snake_Run.png"),
    ("gnome", "Gnome/Gnome_Run.png"),
    ("slingshot-gnome", "Slingshot Gnome/Slingshot Gnome_Run.png"),
    ("thief", "Thief/Thief_Run.png"),
    ("giant-bat", "Giant Bat/Giant Bat_Move.png"),
    ("bomb-fish", "Bomb Fish/Bomb Fish_Run.png"),
    ("hex-shaman", "Hex Shaman/Hex Shaman_Run.png"),
    ("paddle-shark", "Paddle Shark/Paddle Shark_Run.png"),
    ("harpoon-shark", "Harpoon Shark/Harpoon Shark_Run.png"),
]


def main() -> None:
    if not MONSTERS.is_dir():
        sys.exit(
            f"{MONSTERS} introuvable. Recuperer les assets :\n"
            "  cp deploy/.env.example .env && ./tools/fetch-assets.sh"
        )

    atlas = Image.new("RGBA", (ATLAS_SIZE, ATLAS_SIZE), (0, 0, 0, 0))
    manifest = {"image": "monsters.png", "size": ATLAS_SIZE, "archetypes": []}

    # Rangement par etageres : chaque rangee a la hauteur de sa premiere image.
    x, y, row_height = 0, 0, 0

    for archetype_id, (name, relative) in enumerate(SHEETS):
        path = MONSTERS / relative
        if not path.is_file():
            sys.exit(f"planche manquante : {path}")

        sheet = Image.open(path).convert("RGBA")
        cell = sheet.height
        if sheet.width % cell != 0:
            sys.exit(f"{relative} : largeur {sheet.width} non multiple de {cell}")
        frames = sheet.width // cell

        rects = []
        for f in range(frames):
            if x + cell > ATLAS_SIZE:
                x = 0
                y += row_height
                row_height = 0
            if y + cell > ATLAS_SIZE:
                sys.exit(
                    f"atlas sature a {name} image {f}. "
                    f"Augmenter ATLAS_SIZE ou retirer des archetypes."
                )

            frame = sheet.crop((f * cell, 0, (f + 1) * cell, cell))
            atlas.paste(frame, (x, y))
            rects.append({"x": x, "y": y, "w": cell, "h": cell})

            x += cell
            row_height = max(row_height, cell)

        manifest["archetypes"].append(
            {"id": archetype_id, "name": name, "cell": cell, "frames": frames, "rects": rects}
        )
        print(f"  {name:<18} {frames} images de {cell}px")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    atlas.save(OUT_DIR / "monsters.png")
    (OUT_DIR / "monsters.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")

    used = sum(
        r["w"] * r["h"] for a in manifest["archetypes"] for r in a["rects"]
    )
    print(
        f"\nAtlas ecrit dans {OUT_DIR}\n"
        f"  {len(manifest['archetypes'])} archetypes, "
        f"{used / 1e6:.2f} Mpx utilises sur {ATLAS_SIZE**2 / 1e6:.2f} disponibles"
    )
    print("⚠️ Derive du pack : ne pas committer. Deposer sur MinIO.")


if __name__ == "__main__":
    main()
```

- [ ] **Étape 2 : exécuter**

```bash
python3 -m pip install Pillow    # si absent
python3 tools/build_monster_atlas.py
```

Attendu : quatorze lignes, puis un récapitulatif annonçant ~3,06 Mpx utilisés sur 4,19
disponibles.

- [ ] **Étape 3 : vérifier que la sortie reste hors du dépôt**

```bash
git status --short --untracked-files=all | grep -c derived || echo "OK, rien de derive n'est propose"
```
Attendu : `OK, rien de derive n'est propose`.

- [ ] **Étape 4 : déposer sur MinIO**

```bash
mc cp assets/tinyswords/derived/monsters.png  qwetle/tarnok/derived/monsters.png
mc cp assets/tinyswords/derived/monsters.json qwetle/tarnok/derived/monsters.json
```

Vérifier qu'ils sont lisibles anonymement :

```bash
curl -sI https://s3.qwetle.fr/tarnok/derived/monsters.png | head -1
```
Attendu : `HTTP/2 200`.

- [ ] **Étape 5 : commit**

```bash
npm run format && npm run lint
git add tools/build_monster_atlas.py
git commit -m "feat(tools): construction de l'atlas de pietaille"
```

---

## Tâche 12 : `front/src/render/horde-renderer.ts`

**Fichiers :**
- Créer : `front/src/render/horde-renderer.ts`
- Modifier : `front/src/render/stage.ts`

**Interfaces :**
- Consomme : `Horde` (tâche 6), l'atlas de la tâche 11.
- Produit : `class HordeRenderer` avec `load(): Promise<void>`,
  `attach(parent: Container): void`, `draw(horde: Horde, view: Rectangle, timeMs: number): void`.

- [ ] **Étape 1 : écrire le renderer**

`front/src/render/horde-renderer.ts` :

```ts
import { Container, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';

import type { Horde } from '@shared/horde';

/**
 * Rendu batché de la pietaille.
 *
 * Un seul `ParticleContainer`, un seul atlas. Le §4.3 de l'orientation est
 * categorique : « le GPU se moque de 1 500 quads ; ce qui tue, c'est le cout
 * JavaScript par objet et par transform ». Le banc de l'etape 1 a chiffre
 * l'ecart avec des objets `Sprite` : x6.
 *
 * `uvs` en propriete dynamique permet l'animation ; `color` donnera gratuitement
 * la teinte elementaire du §6.6 a l'etape 5, sans rien reecrire ici.
 */

interface AtlasManifest {
  image: string;
  size: number;
  archetypes: {
    id: number;
    name: string;
    cell: number;
    frames: number;
    rects: { x: number; y: number; w: number; h: number }[];
  }[];
}

/** Images par seconde de l'animation, comme le pack (§12.2 de l'orientation). */
const ANIM_FPS = 10;

/** Hauteur d'une bande de tri. Voir `#depthSort`. */
const DEPTH_BAND = 64;

/** Marge autour de la vue, pour qu'une entite n'apparaisse pas en plein ecran. */
const CULL_MARGIN = 128;

export class HordeRenderer {
  readonly #container = new ParticleContainer({
    dynamicProperties: { position: true, uvs: true, color: false, rotation: false },
  });
  /** Réservoir de particules réutilisées : aucune allocation en régime établi. */
  readonly #pool: Particle[] = [];
  /** `#frames[archetype][image]`. */
  #frames: Texture[][] = [];
  #loaded = false;

  constructor(private readonly assetsBase: string) {}

  async load(): Promise<void> {
    const manifest = (await fetch(`${this.assetsBase}/derived/monsters.json`).then((r) =>
      r.json(),
    )) as AtlasManifest;
    const atlas = await Texture.from(`${this.assetsBase}/derived/${manifest.image}`);

    this.#frames = manifest.archetypes.map((a) =>
      a.rects.map(
        (r) =>
          new Texture({
            source: atlas.source,
            frame: new Rectangle(r.x, r.y, r.w, r.h),
          }),
      ),
    );
    this.#loaded = true;
  }

  attach(parent: Container): void {
    parent.addChild(this.#container);
  }

  /**
   * Dessine les entites visibles.
   *
   * Le client **simule** toute la horde mais ne **dessine** que ce que la
   * camera voit. Le §4.5 rappelle pourquoi la vue de dessus rend ce filtrage
   * trivial : la fenetre visible est un rectangle aligne sur les axes du monde.
   */
  draw(horde: Horde, view: Rectangle, timeMs: number): void {
    if (!this.#loaded) {
      return;
    }

    const minX = view.x - CULL_MARGIN;
    const maxX = view.x + view.width + CULL_MARGIN;
    const minY = view.y - CULL_MARGIN;
    const maxY = view.y + view.height + CULL_MARGIN;
    const animStep = Math.floor((timeMs / 1000) * ANIM_FPS);

    const visible: number[] = [];
    for (let i = 0; i < horde.count; i++) {
      const x = horde.x[i] ?? 0;
      const y = horde.y[i] ?? 0;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        visible.push(i);
      }
    }

    this.#depthSort(horde, visible);
    this.#ensurePool(visible.length);

    const children = this.#container.particleChildren;
    children.length = 0;

    for (let n = 0; n < visible.length; n++) {
      const i = visible[n] ?? 0;
      const particle = this.#pool[n];
      const frames = this.#frames[horde.archetype[i] ?? 0];
      if (!particle || !frames || frames.length === 0) {
        continue;
      }

      particle.x = horde.x[i] ?? 0;
      particle.y = horde.y[i] ?? 0;
      // La phase decale le cycle : sans elle, mille cranes marchent au pas, et
      // ca se voit immediatement.
      particle.texture = frames[(animStep + (horde.animPhase[i] ?? 0)) % frames.length] as Texture;
      children.push(particle);
    }

    this.#container.update();
  }

  destroy(): void {
    this.#container.destroy();
  }

  /**
   * Tri en profondeur par **compartiments**, pas par `sort()` global.
   *
   * Un `ParticleContainer` dessine dans l'ordre du tableau. Le §4.5 tranche
   * deja : a 1 500 entites, c'est la difference entre un tri complet par image
   * et un rangement en compartiments. A l'interieur d'une bande de 64 px,
   * l'ordre est indifferent — c'est la hauteur d'un demi-sprite.
   */
  #depthSort(horde: Horde, visible: number[]): void {
    const bands = new Map<number, number[]>();
    for (const i of visible) {
      const band = Math.floor((horde.y[i] ?? 0) / DEPTH_BAND);
      const bucket = bands.get(band);
      if (bucket) {
        bucket.push(i);
      } else {
        bands.set(band, [i]);
      }
    }

    visible.length = 0;
    for (const band of [...bands.keys()].sort((a, b) => a - b)) {
      for (const i of bands.get(band) ?? []) {
        visible.push(i);
      }
    }
  }

  #ensurePool(needed: number): void {
    const first = this.#frames[0]?.[0];
    if (!first) {
      return;
    }
    while (this.#pool.length < needed) {
      this.#pool.push(new Particle({ texture: first, anchorX: 0.5, anchorY: 0.75 }));
    }
  }
}
```

> `anchorY: 0.75` place les pieds du sprite sur la position logique, pas son centre : c'est
> ce qui fait que le tri par `y` correspond à ce que l'œil attend.

- [ ] **Étape 2 : brancher dans `Stage`**

Dans `front/src/render/stage.ts`, ajouter au constructeur de la classe :

```ts
  readonly #horde: HordeRenderer;
```

L'initialiser dans `init`, après `this.#world.addChild(mapBorder())` :

```ts
    this.#horde = new HordeRenderer(ASSETS_BASE);
    this.#horde.attach(this.#world);
    await this.#horde.load();
```

Où `ASSETS_BASE` vaut `'/tinyswords'` — le chemin same-origin servi en dev par le middleware
Vite et en production par le proxy nginx.

Ajouter une méthode :

```ts
  /** Rectangle du monde actuellement visible, pour le culling. */
  viewRect(): Rectangle {
    return new Rectangle(
      -this.#world.x,
      -this.#world.y / VERTICAL_SQUASH,
      this.#app.screen.width,
      this.#app.screen.height / VERTICAL_SQUASH,
    );
  }

  drawHorde(horde: Horde, timeMs: number): void {
    this.#horde.draw(horde, this.viewRect(), timeMs);
  }
```

> ⚠️ Ordre d'affichage : la horde doit être ajoutée **après** la grille et **avant** les
> carrés des joueurs, sinon les joueurs disparaissent sous la horde.

- [ ] **Étape 3 : vérifier la compilation**

```bash
npm run typecheck -w front && npm run build -w front
```
Attendu : SUCCÈS.

- [ ] **Étape 4 : commit**

```bash
npm run format && npm run lint
git add front/src/render/horde-renderer.ts front/src/render/stage.ts
git commit -m "feat(front): rendu batché de la pietaille, anime depuis un atlas"
```

---

## Tâche 13 : intégration client

**Fichiers :**
- Modifier : `front/src/net/client.ts`
- Modifier : `front/src/main.ts`

**Interfaces :**
- Consomme : tout ce qui précède.
- Produit : `GameClient.horde: Horde`, la horde locale avancée à pas fixe.

- [ ] **Étape 1 : faire tourner la horde dans le client**

Dans `front/src/net/client.ts`, ajouter aux imports :

```ts
import {
  FLOWFIELD_CELL,
  FLOWFIELD_HZ,
  INPUT_HZ,
  MAP_SIZE,
  MAX_ENTITIES,
  MAX_PLAYERS,
  TICK_HZ,
} from '@shared/constants';
import { FlowField } from '@shared/flowfield';
import { Horde } from '@shared/horde';
import { PlayerHistory } from '@shared/player-history';
import { applyObstacles, generateObstacles } from '@shared/worldmap';
```

Ajouter les champs :

```ts
  readonly horde = new Horde(MAX_ENTITIES);
  #fields: FlowField[] = [];
  readonly #history = new PlayerHistory();
  /** Accumulateur de pas fixes : la horde avance a 30 Hz, comme le serveur. */
  #hordeAcc = 0;
  #lastHordeTick = 0;
```

- [ ] **Étape 2 : régénérer la carte à la réception du WELCOME**

Dans `#onFrame`, dans la branche `MSG.WELCOME` :

```ts
    if (msg.type === MSG.WELCOME) {
      this.#localId = msg.playerId;
      // Le client **regenere** la carte depuis la graine, il ne la recoit pas :
      // envoyer 8 836 cellules couterait plus cher que tout le protocole.
      const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
      const mask = generateObstacles(msg.mapSeed, probe.cols, probe.rows);
      this.#fields = Array.from({ length: MAX_PLAYERS }, () => {
        const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
        applyObstacles(f, mask);
        return f;
      });
      return;
    }
```

- [ ] **Étape 3 : appliquer les ordres de vague**

Toujours dans `#onFrame`, avant le test `msg.type !== MSG.SNAPSHOT` :

```ts
    if (msg.type === MSG.WAVE_ORDER) {
      this.horde.spawn(msg);
      return;
    }
```

- [ ] **Étape 4 : avancer la horde à pas fixe**

Dans `update(now, dt)`, après la prédiction du joueur local :

```ts
    // La horde avance au **pas fixe** du serveur, pas au rythme des images :
    // deux clients a 60 et 144 fps appliqueraient sinon des suites de `dt`
    // differentes, et la derive serait proportionnelle au temps de vie.
    const STEP = 1 / TICK_HZ;
    this.#hordeAcc += dt;
    let steps = 0;
    while (this.#hordeAcc >= STEP && steps < 5) {
      this.#advanceHorde(STEP);
      this.#hordeAcc -= STEP;
      steps++;
    }
    if (steps === 5) {
      this.#hordeAcc = 0;
    }
```

Et la méthode :

```ts
  #advanceHorde(dt: number): void {
    if (this.#fields.length === 0) {
      return;
    }
    const tick = this.#lastHordeTick++;

    // Les positions telles que le client les connait : celles du dernier
    // snapshot recu. Le serveur lira les memes, grace au retard qu'il s'impose.
    const snapshot = this.#buffer.latest();
    if (snapshot) {
      this.#history.record(
        tick,
        snapshot.players.map((p) => p.x),
        snapshot.players.map((p) => p.y),
      );
    }

    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    if (tick % stepsPerField === 0) {
      const seen = this.#history.delayed(tick);
      if (seen) {
        for (let f = 0; f < seen.x.length && f < this.#fields.length; f++) {
          this.#fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
        }
        this.horde.retarget(seen.x, seen.y);
      }
    }

    this.horde.step(dt, this.#fields);
  }
```

- [ ] **Étape 5 : exposer le dernier snapshot**

`SnapshotBuffer` n'expose pas encore le dernier reçu. Dans
`front/src/net/interpolation.ts`, ajouter :

```ts
  /** Le snapshot le plus recent, sans interpolation ni retard. */
  latest(): { players: readonly PlayerSnapshot[] } | null {
    const newest = this.#samples[this.#samples.length - 1];
    return newest ? { players: newest.players } : null;
  }
```

Et son test, dans `front/src/net/interpolation.test.ts` :

```ts
describe('SnapshotBuffer.latest', () => {
  it('rend le dernier snapshot recu, sans retard', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(1, [{ id: 1, x: 0, y: 0 }]), 0);
    buffer.push(snapshot(2, [{ id: 1, x: 100, y: 0 }]), 50);

    expect(buffer.latest()?.players[0]?.x).toBe(100);
  });

  it('rend null quand rien n est arrive', () => {
    expect(new SnapshotBuffer().latest()).toBeNull();
  });
});
```

- [ ] **Étape 6 : dessiner la horde**

Dans `front/src/main.ts`, dans `join`, remplacer :

```ts
  stage.run((now, dt) => client.update(now, dt));
```

par :

```ts
  stage.run((now, dt) => {
    const state = client.update(now, dt);
    stage.drawHorde(client.horde, now);
    return state;
  });
```

- [ ] **Étape 7 : vérifier**

```bash
npm run typecheck && npm test && npm run build -w front
```
Attendu : SUCCÈS partout.

- [ ] **Étape 8 : commit**

```bash
npm run format && npm run lint
git add front/src/net/client.ts front/src/net/interpolation.ts front/src/net/interpolation.test.ts front/src/main.ts
git commit -m "feat(front): horde locale a pas fixe, alimentee par les ordres de vague"
```

---

## Tâche 14 : vérification manuelle et clôture

**Fichiers :**
- Modifier : `README.md`
- Créer : `docs/plans/2026-XX-XX-etape-2-resultats.md`

- [ ] **Étape 1 : lancer le jeu**

```bash
npm run dev -w back
npm run dev -w front
```

Ouvrir `http://localhost:5173`, créer un salon, **garder l'onglet au premier plan**.

> ⚠️ Ne pas juger la réplication sur deux onglets : un onglet en arrière-plan a son
> `requestAnimationFrame` suspendu et sa capture montre une image périmée. C'est le faux
> bug de l'étape 0. **La réplication est prouvée par le test de la tâche 8**, pas à l'œil.

- [ ] **Étape 2 : vérifier ce qui relève du jugement**

À l'œil, sur l'onglet au premier plan :

- [ ] Les vagues apparaissent toutes les ~6 secondes.
- [ ] La horde converge vers le joueur.
- [ ] Les quatre silhouettes se distinguent en mêlée.
- [ ] **Les ennemis ne marchent pas au pas** — les phases d'animation sont dispersées.
- [ ] Le tri en profondeur est correct : un ennemi plus bas passe devant un plus haut.
- [ ] Les ennemis passent devant la grille, derrière les carrés des joueurs.
- [ ] Le HUD serveur affiche des ko/s stables malgré la horde qui grossit.

- [ ] **Étape 3 : mesurer avec la horde**

Relancer le banc de simulation, qui mesure désormais le vrai code de horde :

```bash
npm run bench -w back
```

Noter les chiffres : c'est le moment de vérifier que la ligne « dont déplacement » n'a pas
explosé maintenant que chaque entité lit sa vitesse dans la table d'archétypes.

- [ ] **Étape 4 : écrire les résultats**

Créer `docs/plans/2026-XX-XX-etape-2-resultats.md` (date du jour) avec :

- la dérive maximale observée par le test de la tâche 8 ;
- les chiffres du banc, avant et après ;
- le verdict sur `K = 3` et sur le seuil de 2 px (§12 de la spec) ;
- ce qui reste ouvert pour l'étape 3.

- [ ] **Étape 5 : mettre à jour le README**

Dans le tableau d'état, passer l'étape 2 à ✅ et ajouter le lien vers les résultats.

- [ ] **Étape 6 : commit**

```bash
npm run format && npm run lint && npm run typecheck && npm test
git add README.md docs/plans/
git commit -m "docs: resultats de l'etape 2"
```

---

## Auto-relecture

**Couverture de la spec.** Chaque section a sa tâche : §2 contrat → tâches 6 et 8 ; §3
ordres de vague → tâches 3 et 5 ; §4 module partagé → tâche 6 ; §5 alignement `T − K` →
tâche 7, appliqué en 9 et 13 ; §5.1 carte d'obstacles → tâche 4 ; §6 lignes de temps →
tâches 5 et 13 ; §7 protocole → tâche 5 ; §8 bestiaire → tâche 2 ; §9 rendu → tâches 11 et
12 ; §10 vérification → tâches 8, 10 et 14 ; §11 risque `ParticleContainer` → tâche 0.

**Cohérence des types.** `WaveOrder` est défini une fois (tâche 3) et consommé tel quel par
le protocole (5), la horde (6) et le directeur (9). `entityIdOf` a la même signature en
tâches 6 et 8. `PlayerHistory.delayed` rend `PlayerPositions | null` partout.

**Un écart à surveiller à l'exécution.** La tâche 5 ajoute `mapSeed` à `Room` de façon
provisoire, et la tâche 9 le reprend dans un constructeur. L'exécutant de la tâche 9 doit
**supprimer** la ligne provisoire plutôt que d'en laisser deux.
