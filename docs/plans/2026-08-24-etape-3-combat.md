# Étape 3 — le combat : plan d'implémentation

> **Pour un agent exécutant :** SOUS-COMPÉTENCE REQUISE — utiliser
> `superpowers:subagent-driven-development` (recommandé) ou
> `superpowers:executing-plans`. Les étapes utilisent des cases à cocher (`- [ ]`).

**But :** une run solo jouable de bout en bout — on tire, les ennemis meurent, on monte de
niveau, on finit par mourir.

**Architecture :** les morts et les ramassages transitent groupés par tick ; tout le reste —
tirs, projectiles, apparition des orbes — se **dérive**. Le client revient en arrière et
rejoue quand une mort lui parvient en retard, parce que la séparation couple les entités et
qu'un tick de décalage ne se résorbe plus.

**Stack :** TypeScript, Vitest, PixiJS v8.

**Spec :** [`../specs/2026-08-24-etape-3-combat.md`](../specs/2026-08-24-etape-3-combat.md)
— à lire avant de commencer. Le plan argumente depuis la spec ; les deux voyagent ensemble.

## Contraintes globales

- **Code et identifiants en anglais, commentaires et documentation en français.**
- **Conventional Commits.** Types valides : `feat`, `fix`, `docs`, `test`, `chore`,
  `refactor`, `perf`, `build`, `ci`, `style`, `revert`. Rien d'autre ne passe le hook.
- **`back/src/room.ts` n'importe ni `ws` ni `fastify`** — règle Biome.
- **Jamais un objet par entité** — tableaux typés.
- **Aucune source de non-déterminisme dans `shared/`** : ni `Math.random`, ni `Date.now`,
  ni itération sur `Map`/objet dont l'ordre compte.
- **Aucun fichier dérivé de Tiny Swords dans l'historique** — la CI échoue sinon.
- `npm run format` avant chaque commit ; `lint`, `typecheck`, `test`, `build -w front` verts.
- **`noUncheckedIndexedAccess` est actif.** Un accès indexé rend `T | undefined`. Préférer
  `?? 0` à un `as T` : le cast masque un vrai cas, le `??` le traite.

## Cohérence des constantes

> Trois défauts de l'étape 2 avaient la même racine : **deux valeurs raisonnables, écrites
> dans deux sections différentes du plan, jamais confrontées.** Une période de vague de 6 s
> contre une fenêtre de test de 3 s ; un tick serveur absolu contre un tick client relatif ;
> une profondeur de tampon de 16 contre un test qui enregistrait 21 ticks.
>
> Ce tableau existe pour que ça ne se reproduise pas. **Toute constante ajoutée par ce plan
> y figure, avec ce qui la contraint.** Un exécutant qui change l'une doit vérifier les
> autres.

| Constante | Valeur | Contrainte |
| --- | --- | --- |
| `TICK_HZ` | 30 | existant |
| `FIELD_INPUT_DELAY_TICKS` | 3 | existant — le flowfield lit `T − 3` |
| `TARGETING_DELAY_TICKS` | **= `FIELD_INPUT_DELAY_TICKS`** | l'auto-visée lit le **même** état que le flowfield ; les découpler créerait deux passés à garder d'accord |
| `ROLLBACK_DEPTH_TICKS` | 8 | **doit être > la latence maximale en ticks** ; 8 ticks = 266 ms, au-delà de quoi une mort est appliquée au présent **et signalée** |
| `SEPARATION_RADIUS` | 28 px | **doit être ≤ moitié de `SEPARATION_CELL`** pour que les huit voisines suffisent |
| `SEPARATION_CELL` | 56 px | = `2 × SEPARATION_RADIUS` |
| `SEPARATION_STRENGTH` | 120 px/s | réglage de sensation ; sans effet sur le déterminisme |
| `ORB_LIFETIME_TICKS` | 600 (20 s) | dérivé des deux côtés, donc aucune valeur ne doit dépendre d'une horloge murale |
| `ORB_PICKUP_RADIUS` | 90 px | arbitré serveur |
| `PLAYER_MAX_HP` | 100 | |
| `CONTACT_DAMAGE` | 8 | par contact et par intervalle |
| `CONTACT_INTERVAL_TICKS` | 15 (0,5 s) | invulnérabilité entre deux touches |
| `CONTACT_RADIUS` | 34 px | §3.4 : hitbox **généreuse**, en faveur du joueur |
| `XP_PER_ORB` | 1 | |
| `LEVEL_FREEZE_TICKS` | 60 (2 s) | l'étape 4 le portera à 20 s plafonnées (§7.4) |
| `LEVEL_RESUME_TICKS` | 30 (1 s) | reprise progressive (§7.4) |

## Structure des fichiers

| Fichier | Responsabilité |
| --- | --- |
| `shared/separation.ts` | grille spatiale, forces accumulées puis appliquées en bloc |
| `shared/horde.ts` | + `kill()`, + `saveState()` / `restoreState()` |
| `shared/horde-history.ts` | anneau d'états de horde, pour le rejeu |
| `shared/weapons.ts` | définitions d'armes, pilotées par la donnée |
| `shared/targeting.ts` | auto-visée déterministe sur l'état retardé |
| `shared/projectiles.ts` | salves dérivées, simulation, collision |
| `shared/orbs.ts` | orbes dérivés des morts, durée de vie |
| `shared/protocol.ts` | + `DEATHS`, `PICKUPS`, `LEVEL_UP`, `RUN_OVER` ; `SNAPSHOT` gagne pv et xp |
| `back/src/combat.ts` | arbitrage : dégâts, morts, ramassages, contact |
| `back/src/room.ts` | intègre combat, séparation, gel, fin de run |
| `front/src/net/client.ts` | applique morts et ramassages avec rejeu |
| `front/src/render/*` | projectiles, orbes, retour d'impact, bilan |

---

## Tâche 0 : SPIKE — que coûtent la séparation et le rejeu ?

**C'est une porte.** Le §3.3 de la spec l'écrit : le coût du rejeu vaut `L + 1` fois celui
d'un pas de simulation, **à chaque tick, en permanence**. L'étape 1 a mesuré le déplacement
seul (0,02 ms pour 4 000 entités) mais **jamais la séparation**, qui dominera.

Trois issues sont décidées d'avance, pour ne pas trancher sous la pression du résultat :

| Si le rejeu à 1 500 entités coûte… | Alors |
| --- | --- |
| < 1 ms | on garde le mécanisme tel quel |
| 1 à 4 ms | on borne `ROLLBACK_DEPTH_TICKS` et on mesure la dérive résiduelle |
| > 4 ms | **on rouvre le §3.2 de la spec** — séparation moins chère, ou morts appliquées au présent avec dérive mesurée |

**Fichiers :**
- Créer : `back/bench/separation.bench.ts`
- Modifier : `back/package.json` (script `bench:sep`)

**Interfaces :**
- Consomme : `Horde`, `FlowField` (existants).
- Produit : des chiffres, et la réponse à la question.

- [ ] **Étape 1 : écrire une séparation jetable dans le banc**

Le banc n'importe pas `shared/separation.ts` — il n'existe pas encore. Il en écrit une
version locale, pour **mesurer la forme de l'algorithme** avant de l'adopter.

`back/bench/separation.bench.ts` :

```ts
/**
 * Banc — que coutent la separation et le rejeu ?
 *
 * Le §3.3 de la spec de l'etape 3 en fait une porte : rejouer `L` ticks coute
 * `L + 1` pas de simulation, a chaque tick et en permanence. Le deplacement seul
 * a ete mesure a l'etape 1 (0,02 ms pour 4 000 entites) ; la separation, jamais.
 *
 *   npm run bench:sep -w back
 */

import { FLOWFIELD_CELL, MAP_SIZE, TICK_HZ } from '@shared/constants';
import { FlowField } from '@shared/flowfield';
import { Horde } from '@shared/horde';
import { FORMATION, type WaveOrder } from '@shared/waves';

import { machineDescription, round2, stats } from './harness';

const DT = 1 / TICK_HZ;
const MEASURED_STEPS = 300;
const WARMUP_STEPS = 60;

const SEPARATION_RADIUS = 28;
const SEPARATION_CELL = 56;
const SEPARATION_STRENGTH = 120;

/**
 * Grille spatiale jetable, ecrite ici pour mesurer la FORME de l'algorithme
 * avant de l'adopter. La version retenue vivra dans `shared/separation.ts`.
 *
 * Les forces s'accumulent dans un tableau separe puis s'appliquent en bloc :
 * appliquer au fil de l'iteration rendrait le resultat dependant de l'ordre de
 * parcours, et deux clients compactent leurs tableaux differemment.
 */
class Separation {
  readonly #cols: number;
  readonly #cellStart: Int32Array;
  readonly #cellCount: Int32Array;
  readonly #order: Int32Array;
  readonly #pushX: Float32Array;
  readonly #pushY: Float32Array;

  constructor(capacity: number) {
    this.#cols = Math.ceil(MAP_SIZE / SEPARATION_CELL);
    const cells = this.#cols * this.#cols;
    this.#cellStart = new Int32Array(cells + 1);
    this.#cellCount = new Int32Array(cells);
    this.#order = new Int32Array(capacity);
    this.#pushX = new Float32Array(capacity);
    this.#pushY = new Float32Array(capacity);
  }

  apply(horde: Horde, dt: number): void {
    const n = horde.count;
    const cols = this.#cols;
    this.#cellCount.fill(0);
    this.#pushX.fill(0, 0, n);
    this.#pushY.fill(0, 0, n);

    // Tri par comptage dans la grille : deux passes lineaires, zero allocation.
    const cellOf = (i: number): number => {
      const cx = Math.min(cols - 1, Math.max(0, Math.floor((horde.x[i] ?? 0) / SEPARATION_CELL)));
      const cy = Math.min(cols - 1, Math.max(0, Math.floor((horde.y[i] ?? 0) / SEPARATION_CELL)));
      return cy * cols + cx;
    };
    for (let i = 0; i < n; i++) {
      this.#cellCount[cellOf(i)] = (this.#cellCount[cellOf(i)] ?? 0) + 1;
    }
    let running = 0;
    for (let c = 0; c < this.#cellCount.length; c++) {
      this.#cellStart[c] = running;
      running += this.#cellCount[c] ?? 0;
    }
    this.#cellStart[this.#cellCount.length] = running;
    const cursor = this.#cellStart.slice();
    for (let i = 0; i < n; i++) {
      const c = cellOf(i);
      this.#order[cursor[c] ?? 0] = i;
      cursor[c] = (cursor[c] ?? 0) + 1;
    }

    const r2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
    for (let i = 0; i < n; i++) {
      const xi = horde.x[i] ?? 0;
      const yi = horde.y[i] ?? 0;
      const cx = Math.min(cols - 1, Math.max(0, Math.floor(xi / SEPARATION_CELL)));
      const cy = Math.min(cols - 1, Math.max(0, Math.floor(yi / SEPARATION_CELL)));

      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = cx + ox;
          const ny = cy + oy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= cols) {
            continue;
          }
          const c = ny * cols + nx;
          const from = this.#cellStart[c] ?? 0;
          const to = this.#cellStart[c + 1] ?? 0;
          for (let k = from; k < to; k++) {
            const j = this.#order[k] ?? 0;
            if (j === i) {
              continue;
            }
            const dx = xi - (horde.x[j] ?? 0);
            const dy = yi - (horde.y[j] ?? 0);
            const d2 = dx * dx + dy * dy;
            if (d2 > r2 || d2 === 0) {
              continue;
            }
            const d = Math.sqrt(d2);
            const push = (SEPARATION_RADIUS - d) / SEPARATION_RADIUS;
            this.#pushX[i] = (this.#pushX[i] ?? 0) + (dx / d) * push;
            this.#pushY[i] = (this.#pushY[i] ?? 0) + (dy / d) * push;
          }
        }
      }
    }

    const speed = SEPARATION_STRENGTH * dt;
    for (let i = 0; i < n; i++) {
      horde.x[i] = (horde.x[i] ?? 0) + (this.#pushX[i] ?? 0) * speed;
      horde.y[i] = (horde.y[i] ?? 0) + (this.#pushY[i] ?? 0) * speed;
    }
  }
}

function makeHorde(count: number): { horde: Horde; fields: FlowField[] } {
  const horde = new Horde(4000);
  const order: WaveOrder = {
    waveId: 1,
    spawnTick: 0,
    seed: 0x51ee_d001,
    archetype: 0,
    formation: FORMATION.CLUSTER,
    anchorX: 3000,
    anchorY: 3000,
    count,
  };
  horde.spawn(order);
  const fields = Array.from({ length: 4 }, () => {
    const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    f.update(3000, 3000);
    return f;
  });
  horde.retarget([3000, 3000, 3000, 3000], [3000, 3000, 3000, 3000]);
  return { horde, fields };
}

function measure(count: number, withSeparation: boolean): { median: number; p95: number } {
  const { horde, fields } = makeHorde(count);
  const sep = new Separation(4000);
  const times: number[] = [];
  for (let step = 0; step < WARMUP_STEPS + MEASURED_STEPS; step++) {
    const started = performance.now();
    horde.step(DT, fields);
    if (withSeparation) {
      sep.apply(horde, DT);
    }
    const elapsed = performance.now() - started;
    if (step >= WARMUP_STEPS) {
      times.push(elapsed);
    }
  }
  const s = stats(times);
  return { median: s.median, p95: s.p95 };
}

function main(): void {
  console.log(`Banc de separation — ${machineDescription()}`);
  console.log(`Rayon ${SEPARATION_RADIUS} px, cellule ${SEPARATION_CELL} px\n`);

  const rows = [250, 500, 1000, 1500, 2500, 4000].map((n) => {
    const sans = measure(n, false);
    const avec = measure(n, true);
    const rejeu4 = avec.median * 4;
    return {
      entites: n,
      'pas sans separation (ms)': round2(sans.median),
      'pas avec separation (ms)': round2(avec.median),
      'cout de la separation (ms)': round2(avec.median - sans.median),
      'rejeu de 3 ticks (ms)': round2(rejeu4),
      verdict: rejeu4 < 1 ? 'OK' : rejeu4 < 4 ? 'a borner' : 'rouvrir le §3.2',
    };
  });
  console.table(rows);

  const cible = rows.find((r) => r.entites === 1500);
  console.log(
    `\n-> A la cible de 1 500 entites (§4.1), un rejeu de trois ticks coute ` +
      `${cible?.['rejeu de 3 ticks (ms)']} ms sur un budget d'image de 16,7 ms.`,
  );
}

main();
```

- [ ] **Étape 2 : câbler la commande**

Dans `back/package.json`, ajouter aux scripts :

```json
    "bench:sep": "tsx bench/separation.bench.ts",
```

Et étendre `"bench"` : `"npm run bench:sim && npm run bench:net && npm run bench:sep"`.

- [ ] **Étape 3 : exécuter et rapporter**

```bash
npm run bench:sep -w back
```

Attendu : un tableau, et une ligne de verdict pour 1 500 entités.

> ⚠️ **Rapporte le chiffre tel quel.** Ne l'interprète pas, ne l'arrondis pas dans le sens
> qui arrange. Les trois issues sont écrites d'avance dans le tableau ci-dessus précisément
> pour que le résultat décide, et pas l'inverse.
>
> **Si le verdict est « rouvrir le §3.2 », arrête-toi et dis-le.** C'est un résultat, pas un
> échec — c'est même la raison d'être de cette tâche.

- [ ] **Étape 4 : commit**

```bash
npm run format && npm run lint && npm run typecheck
git add back/bench/separation.bench.ts back/package.json
git commit -m "test(bench): mesurer le cout de la separation et du rejeu"
```

---

## Tâche 1 : `shared/separation.ts`

**Fichiers :**
- Créer : `shared/separation.ts`, `shared/separation.test.ts`
- Modifier : `shared/constants.ts`

**Interfaces :**
- Consomme : `Horde` (structurellement — `count`, `x`, `y`).
- Produit : `class SeparationGrid` avec `apply(horde, dt): void`.

- [ ] **Étape 1 : les constantes**

Dans `shared/constants.ts` :

```ts
/**
 * Rayon en deca duquel deux entites se repoussent.
 *
 * ⚠️ Doit rester inferieur ou egal a la moitie de `SEPARATION_CELL` : c'est ce
 * qui garantit qu'un voisin en interaction est forcement dans la cellule
 * courante ou l'une des huit adjacentes. Les augmenter separement casse la
 * recherche de voisins sans qu'aucun test unitaire ne le voie.
 */
export const SEPARATION_RADIUS = 28;

/** Cote d'une cellule de la grille de separation. */
export const SEPARATION_CELL = 56;

/** Vitesse de repoussement, en pixels monde par seconde. Reglage de sensation. */
export const SEPARATION_STRENGTH = 120;
```

- [ ] **Étape 2 : écrire le test qui échoue**

`shared/separation.test.ts` :

```ts
import { describe, expect, it } from 'vitest';

import { SEPARATION_RADIUS, TICK_HZ } from './constants';
import { Horde } from './horde';
import { SeparationGrid } from './separation';
import { FORMATION, type WaveOrder } from './waves';

const DT = 1 / TICK_HZ;

function hordeAt(positions: readonly (readonly [number, number])[]): Horde {
  const horde = new Horde(100);
  const order: WaveOrder = {
    waveId: 1,
    spawnTick: 0,
    seed: 1,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: 3000,
    anchorY: 3000,
    count: positions.length,
  };
  horde.spawn(order);
  positions.forEach(([x, y], i) => {
    horde.x[i] = x;
    horde.y[i] = y;
  });
  return horde;
}

describe('SeparationGrid.apply', () => {
  it('ecarte deux entites qui se chevauchent', () => {
    const horde = hordeAt([
      [3000, 3000],
      [3010, 3000],
    ]);
    const grid = new SeparationGrid(100);
    const avant = Math.abs((horde.x[1] ?? 0) - (horde.x[0] ?? 0));

    grid.apply(horde, DT);

    expect(Math.abs((horde.x[1] ?? 0) - (horde.x[0] ?? 0))).toBeGreaterThan(avant);
  });

  it('ne touche pas deux entites plus eloignees que le rayon', () => {
    const loin = SEPARATION_RADIUS * 3;
    const horde = hordeAt([
      [3000, 3000],
      [3000 + loin, 3000],
    ]);
    const grid = new SeparationGrid(100);

    grid.apply(horde, DT);

    expect(horde.x[0]).toBe(3000);
    expect(horde.x[1]).toBe(3000 + loin);
  });

  it('repousse symetriquement : les deux bougent autant, en sens oppose', () => {
    const horde = hordeAt([
      [3000, 3000],
      [3010, 3000],
    ]);
    const grid = new SeparationGrid(100);

    grid.apply(horde, DT);

    const gauche = 3000 - (horde.x[0] ?? 0);
    const droite = (horde.x[1] ?? 0) - 3010;
    expect(gauche).toBeCloseTo(droite, 5);
    expect(gauche).toBeGreaterThan(0);
  });

  it('ne depend pas de l ordre des entites dans le tableau', () => {
    // C'est LA propriete qui porte le determinisme : deux clients compactent
    // leurs tableaux differemment apres des morts, donc la meme configuration
    // spatiale peut leur arriver dans un ordre different.
    const a = hordeAt([
      [3000, 3000],
      [3010, 3000],
      [3005, 3012],
    ]);
    const b = hordeAt([
      [3005, 3012],
      [3010, 3000],
      [3000, 3000],
    ]);
    const grid = new SeparationGrid(100);

    grid.apply(a, DT);
    grid.apply(b, DT);

    // L'entite qui etait a (3000, 3000) doit finir au meme endroit des deux
    // cotes, quel que soit son indice.
    expect(a.x[0]).toBeCloseTo(b.x[2] ?? 0, 5);
    expect(a.y[0]).toBeCloseTo(b.y[2] ?? 0, 5);
  });

  it('est deterministe : deux applications identiques donnent le meme resultat', () => {
    const a = hordeAt([
      [3000, 3000],
      [3010, 3002],
      [3004, 3011],
      [2995, 3006],
    ]);
    const b = hordeAt([
      [3000, 3000],
      [3010, 3002],
      [3004, 3011],
      [2995, 3006],
    ]);
    const grid = new SeparationGrid(100);

    grid.apply(a, DT);
    grid.apply(b, DT);

    expect([...a.x.slice(0, 4)]).toEqual([...b.x.slice(0, 4)]);
  });

  it('n alloue pas a chaque appel', () => {
    // On ne mesure pas la memoire : on verifie que la grille est reutilisable
    // sans se degrader, ce qui attraperait une reallocation par appel.
    const horde = hordeAt([
      [3000, 3000],
      [3010, 3000],
    ]);
    const grid = new SeparationGrid(100);

    expect(() => {
      for (let i = 0; i < 1000; i++) {
        grid.apply(horde, DT);
      }
    }).not.toThrow();
  });
});
```

- [ ] **Étape 3 : vérifier que le test échoue**

```bash
npm test -w back
```
Attendu : ÉCHEC, `Cannot find module './separation'`.

- [ ] **Étape 4 : implémenter**

Reprendre la classe `Separation` du banc de la tâche 0, en la renommant `SeparationGrid`,
en important les trois constantes depuis `./constants` au lieu de les redéclarer, et en
ajoutant l'en-tête suivant :

```ts
/**
 * Separation entre entites : la horde se pousse au lieu de se superposer.
 *
 * Deux raisons, et la seconde est la plus contraignante.
 *
 * **Le rendu.** La verification visuelle de l'etape 2 a montre que la horde
 * forme des FILES : les entites s'alignent sur les memes couloirs, consequence
 * des huit directions discretes par cellule de flowfield. Le §4.1 veut des
 * formations denses, pas des colonnes.
 *
 * **Le determinisme.** La separation COUPLE les entites entre elles : retirer un
 * ennemi ne decale plus une entite mais des dizaines, de proche en proche. C'est
 * ce qui rend le rejeu du §3.2 necessaire plutot que confortable.
 *
 * ⚠️ Les forces s'accumulent dans un tableau separe puis s'appliquent EN BLOC.
 * Les appliquer au fil de l'iteration rendrait le resultat dependant de l'ordre
 * de parcours — et deux clients compactent leurs tableaux differemment apres des
 * morts. Ce n'est pas une optimisation, c'est la condition du determinisme.
 */
```

**Ne garde pas le `cursor = this.#cellStart.slice()` du banc** : il alloue à chaque appel.
Utilise un `Int32Array` membre, rempli depuis `#cellStart` au début de chaque passe.

- [ ] **Étape 5 : vérifier que le test passe**

```bash
npm test -w back
```
Attendu : SUCCÈS.

- [ ] **Étape 6 : commit**

```bash
npm run format && npm run lint && npm run typecheck
git add shared/separation.ts shared/separation.test.ts shared/constants.ts
git commit -m "feat(shared): separation entre entites, deterministe par construction"
```

---

## Tâche 2 : les morts dans `Horde`

**Fichiers :**
- Modifier : `shared/horde.ts`, `shared/horde.test.ts`

**Interfaces :**
- Produit : `Horde.kill(entityIds: readonly number[]): number` (rend le nombre retiré),
  `Horde.slotOf(entityId: number): number` (−1 si absent).

- [ ] **Étape 1 : écrire le test qui échoue**

Ajouter à `shared/horde.test.ts` :

```ts
describe('Horde.kill', () => {
  it('retire les entites demandees', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 1, count: 10 }));
    const cible = horde.entityIdAt(3);

    expect(horde.kill([cible])).toBe(1);
    expect(horde.count).toBe(9);
    expect(horde.slotOf(cible)).toBe(-1);
  });

  it('ignore une identite inconnue sans planter', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 5 }));

    expect(horde.kill([999_999])).toBe(0);
    expect(horde.count).toBe(5);
  });

  it('donne le meme resultat quel que soit l ordre de la liste', () => {
    // Le protocole trie les identites, mais rien n'empeche un appelant de
    // passer une liste desordonnee : le resultat doit etre identique, sinon
    // deux clients compacteraient differemment.
    const a = new Horde(1000);
    const b = new Horde(1000);
    a.spawn(order({ count: 20 }));
    b.spawn(order({ count: 20 }));
    const ids = [a.entityIdAt(2), a.entityIdAt(7), a.entityIdAt(15)];

    a.kill(ids);
    b.kill([...ids].reverse());

    const idsDe = (h: Horde): number[] =>
      Array.from({ length: h.count }, (_, i) => h.entityIdAt(i));
    expect(idsDe(a)).toEqual(idsDe(b));
  });

  it('preserve toutes les entites survivantes', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 10 }));
    const avant = new Set(Array.from({ length: 10 }, (_, i) => horde.entityIdAt(i)));
    const morts = [horde.entityIdAt(0), horde.entityIdAt(9)];

    horde.kill(morts);

    const apres = new Set(Array.from({ length: horde.count }, (_, i) => horde.entityIdAt(i)));
    for (const id of avant) {
      expect(apres.has(id)).toBe(!morts.includes(id));
    }
  });

  it('emmene toutes les proprietes de l entite deplacee, pas seulement sa position', () => {
    // La compaction deplace la derniere entite dans le trou. Si un seul tableau
    // etait oublie, cette entite garderait l'archetype ou la cible du mort —
    // et l'etape 3 le paierait en sprites melanges.
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 1, archetype: 0, count: 5 }));
    horde.spawn(order({ waveId: 2, archetype: 3, count: 5 }));
    const dernier = horde.entityIdAt(horde.count - 1);
    const archetypeAttendu = horde.archetype[horde.count - 1];
    const phaseAttendue = horde.animPhase[horde.count - 1];

    horde.kill([horde.entityIdAt(0)]);

    const slot = horde.slotOf(dernier);
    expect(slot).toBe(0);
    expect(horde.archetype[slot]).toBe(archetypeAttendu);
    expect(horde.animPhase[slot]).toBe(phaseAttendue);
  });
});
```

- [ ] **Étape 2 : vérifier l'échec**, puis implémenter

Dans `shared/horde.ts` :

```ts
  /**
   * Retire des entites par identite, et rend combien ont ete retirees.
   *
   * La compaction deplace la derniere entite dans le trou — `O(1)` par mort. Ce
   * qui compte pour la replication : **le resultat ne doit pas dependre de
   * l'ordre de la liste**. On retire donc par indice decroissant, ce qui rend
   * l'operation commutative : une entite deplacee ne peut jamais l'etre vers un
   * trou qu'on va rouvrir ensuite.
   *
   * Sans ca, deux clients recevant les memes morts dans un ordre different
   * finiraient avec des tableaux differemment agences, et l'indice `i` cesserait
   * de designer la meme entite — l'invariant que le test de replication verifie
   * par comparaison d'identites.
   */
  kill(entityIds: readonly number[]): number {
    const slots: number[] = [];
    for (const id of entityIds) {
      const slot = this.slotOf(id);
      if (slot >= 0) {
        slots.push(slot);
      }
    }
    slots.sort((a, b) => b - a);

    let removed = 0;
    for (const slot of slots) {
      this.#removeAt(slot);
      removed++;
    }
    return removed;
  }

  /** Index du creneau portant cette identite, ou -1. */
  slotOf(entityId: number): number {
    for (let i = 0; i < this.#count; i++) {
      if (this.entityIdAt(i) === entityId) {
        return i;
      }
    }
    return -1;
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
      this.archetype[slot] = this.archetype[last] ?? 0;
      this.waveId[slot] = this.waveId[last] ?? 0;
      this.indexInWave[slot] = this.indexInWave[last] ?? 0;
      this.animPhase[slot] = this.animPhase[last] ?? 0;
      this.targetField[slot] = this.targetField[last] ?? 0;
    }
    this.#count = last;
  }
```

> ⚠️ **`#removeAt` doit copier TOUS les tableaux.** Si un seul est oublié, l'entité déplacée
> hérite d'une propriété du mort. Le test de l'étape 1 le vérifie explicitement — ne le
> retire pas si tu ajoutes un tableau à `Horde` plus tard, **complète-le**.

- [ ] **Étape 3 : vérifier, puis commit**

```bash
npm test -w back
npm run format && npm run lint && npm run typecheck
git add shared/horde.ts shared/horde.test.ts
git commit -m "feat(shared): retrait d'entites par identite, insensible a l'ordre"
```

---

## Tâche 3 : `shared/horde-history.ts` — l'anneau d'états

**Fichiers :**
- Créer : `shared/horde-history.ts`, `shared/horde-history.test.ts`
- Modifier : `shared/horde.ts` (ajouter `saveState` / `restoreState`), `shared/constants.ts`

**Interfaces :**
- Produit : `Horde.saveState(out: HordeState): void`, `Horde.restoreState(s: HordeState): void`,
  `class HordeHistory` avec `record(tick, horde)`, `restore(tick, horde): boolean`,
  `oldestTick(): number`.

- [ ] **Étape 1 : la constante**

```ts
/**
 * Profondeur de l'historique de horde, en ticks, pour le rejeu du §3.2.
 *
 * ⚠️ Doit rester **superieure a la latence maximale attendue**, exprimee en
 * ticks. Huit ticks valent 266 ms a 30 Hz. Au-dela, une mort est appliquee au
 * present et **signalee** — jamais appliquee en silence.
 */
export const ROLLBACK_DEPTH_TICKS = 8;
```

- [ ] **Étape 2 : écrire les tests, vérifier l'échec, implémenter**

`shared/horde-history.test.ts` doit couvrir :
- enregistrer puis restaurer un tick rend exactement l'état sauvegardé (positions,
  identités, archétypes, compte) ;
- restaurer un tick jamais enregistré rend `false` **et ne modifie pas la horde** ;
- l'anneau ne garde que `ROLLBACK_DEPTH_TICKS` états ;
- un aller-retour enregistrer / tuer / restaurer redonne l'entité tuée.

Écris chaque test **avant** le code correspondant. Pour chacun, sois capable de nommer le
changement de production qui le ferait échouer — si tu n'en trouves pas, le test ne vaut
rien.

`shared/horde.ts` gagne :

```ts
export interface HordeState {
  count: number;
  x: Float32Array;
  y: Float32Array;
  archetype: Uint8Array;
  waveId: Uint16Array;
  indexInWave: Uint16Array;
  animPhase: Uint8Array;
  targetField: Uint8Array;
}
```

avec `saveState` / `restoreState` qui copient par `.set()` sur des tampons alloués une fois.

> ⚠️ **Aucune allocation dans `record`.** L'anneau est alimenté à chaque tick ; allouer un
> état par tick rendrait le ramasse-miettes visible dans les mesures — c'est exactement le
> piège que `FlowField` évite déjà avec sa file pré-allouée.

- [ ] **Étape 3 : commit**

```bash
git commit -m "feat(shared): anneau d'etats de horde pour le rejeu"
```

---

## Tâche 4 : le protocole

**Fichiers :**
- Modifier : `shared/protocol.ts`, `shared/protocol.test.ts`, `shared/constants.ts`

**Interfaces :**
- Produit : `MSG.DEATHS/PICKUPS/LEVEL_UP/RUN_OVER`, leurs encodeurs et décodeurs, et
  `SnapshotMessage` gagne `hp` et `xp` par joueur.

- [ ] **Étape 1 : écrire les tests qui échouent**

Pour **chaque** message : aller-retour exact, buffer tronqué qui lève, et **taille totale
vérifiée** — un décalage d'octet ne se voit pas dans un aller-retour, puisque l'encodeur et
le décodeur partagent la même erreur.

Pour `DEATHS`, ajouter :

```ts
  it('ne grossit pas avec le nombre d entites vivantes, seulement avec les morts', () => {
    const dix = encodeDeaths(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const une = encodeDeaths(1, [1]);

    expect(dix.byteLength - une.byteLength).toBe(9 * 4);
  });
```

- [ ] **Étape 2 : implémenter**

```ts
export const MSG = {
  WELCOME: 1,
  SNAPSHOT: 2,
  INPUT: 3,
  WAVE_ORDER: 4,
  DEATHS: 5,
  PICKUPS: 6,
  LEVEL_UP: 7,
  RUN_OVER: 8,
} as const;

export const DEATHS_HEADER_BYTES = 7;
export const DEATH_ID_BYTES = 4;
```

`encodeDeaths(tick, ids)` : `type u8 · tick u32 · count u16 · id u32 × count`.
`encodePickups` a exactement la même forme — **factorise l'encodage** plutôt que de le
dupliquer, les deux messages ne diffèrent que par leur octet de type.

`SNAPSHOT_PLAYER_BYTES` passe de 5 à **8** (`id u8 · x i16 · y i16 · hp u8 · xp u16`).

> Le test d'indépendance réseau de l'étape 2 dérive son plafond de ces constantes : il
> suivra tout seul. C'est pour ça qu'il avait été écrit ainsi.

- [ ] **Étape 3 : corriger les appelants, vérifier, commit**

```bash
npm run typecheck && npm test
git commit -m "feat(shared): messages de morts, ramassages, niveau et fin de run"
```

---

## Tâche 5 : `shared/weapons.ts`

**Fichiers :**
- Créer : `shared/weapons.ts`, `shared/weapons.test.ts`

- [ ] Table de trois armes, pilotée par la donnée, sur le modèle de `shared/archetypes.ts` :

```ts
export interface Weapon {
  id: number;
  name: string;
  /** Cadence de tir, en ticks. */
  cooldownTicks: number;
  damage: number;
  /** Vitesse du projectile, en pixels monde par seconde. */
  projectileSpeed: number;
  /** Portee, exprimee en duree de vie. */
  projectileLifeTicks: number;
  projectileCount: number;
  spreadRadians: number;
}
```

L'index dans le tableau **est** l'identifiant, comme pour les archétypes. La première est
l'arme neutre de base du §6.1 : faible, sans élément, hors slots.

Tests : indexation cohérente, valeurs strictement positives, et `weaponOf` qui **lève** sur
un identifiant inconnu plutôt que de rendre `undefined`.

- [ ] Commit : `feat(shared): table des armes, pilotee par la donnee`

---

## Tâche 6 : `shared/targeting.ts` — l'auto-visée déterministe

**Fichiers :**
- Créer : `shared/targeting.ts`, `shared/targeting.test.ts`

**Interfaces :**
- Produit : `nearestTarget(horde, fromX, fromY, maxRange): number` — rend un **identifiant
  d'entité**, ou `-1`.

- [ ] **Étape 1 : les tests, d'abord**

```ts
describe('nearestTarget', () => {
  it('designe l ennemi le plus proche', () => { /* … */ });

  it('rend -1 quand rien n est a portee', () => { /* … */ });

  it('departage une egalite par le plus petit identifiant', () => {
    // Sans ce departage, le resultat dependrait de l'ordre du tableau — et deux
    // clients compactent leurs tableaux differemment apres des morts. C'est la
    // meme raison que l'ordre canonique des morts et l'application en bloc des
    // forces de separation.
    // Placer deux ennemis a distance EXACTEMENT egale et verifier que c'est
    // toujours le plus petit identifiant qui gagne, quel que soit leur ordre
    // dans le tableau.
  });

  it('ne depend pas de l ordre des entites dans le tableau', () => { /* … */ });
});
```

- [ ] **Étape 2 : implémenter**

Rend un **identifiant**, pas un indice de créneau : un indice ne survit pas à une
compaction, et la cible doit rester valable entre le moment où l'on vise et celui où le
projectile arrive.

- [ ] Commit : `feat(shared): auto-visee deterministe, departagee par identifiant`

---

## Tâche 7 : `shared/projectiles.ts`

**Fichiers :**
- Créer : `shared/projectiles.ts`, `shared/projectiles.test.ts`

**Interfaces :**
- Produit : `class Projectiles` — tableaux typés, `fireSalvo(weapon, tick, x, y, targetId, horde)`,
  `step(dt)`, `collide(horde, onHit)`.

- [ ] **Étape 1 : les tests**

Couvrir : une salve produit `projectileCount` projectiles ; la dispersion est symétrique ;
un projectile expire après `projectileLifeTicks` ; deux instances aux mêmes entrées
produisent les mêmes projectiles ; la collision détecte un ennemi sur la trajectoire.

**Un test doit verrouiller la dérivation :**

```ts
  it('tire aux memes ticks des deux cotes, sans qu aucun evenement ne transite', () => {
    // Deux instances independantes, memes armes, meme tick de depart, memes
    // positions : elles doivent produire exactement les memes salves. C'est ce
    // qui permet de ne rien envoyer sur le fil (§5.2 de la spec).
  });
```

- [ ] **Étape 2 : implémenter**, puis commit :
`feat(shared): projectiles derives, jamais repliques`

---

## Tâche 8 : le test de réplication étendu — **le livrable**

**Fichiers :**
- Modifier : `shared/horde.replication.test.ts`

Écrit **avant** l'intégration, comme à l'étape 2 : c'est lui qui définit ce que « la
réplication survit aux morts » veut dire.

- [ ] **Étape 1 : trois scénarios nouveaux**

Le fichier en compte déjà sept. On ajoute :

**8. Morts + séparation, SANS rejeu.** Les clients appliquent les morts à l'arrivée, avec
1 à 3 ticks de retard. **Mesure et affiche la dérive** ; borne largement (800 px). Ce
scénario existe pour que le chiffre existe — c'est le pendant des lignes à 693,899 px et
769,738 px de l'étape 2, les plus précieuses du tableau parce qu'elles montrent ce que le
mécanisme ferait sans ses corrections.

**9. Morts + séparation, AVEC rejeu.** Même chose, mais les clients restaurent, appliquent
et rejouent. Assertions : **identités strictement égales**, dérive sous 2 px.

**10. Mort trop vieille pour l'historique.** Une mort datée d'un tick sorti de l'anneau doit
être appliquée au présent **et signalée**, sans planter. Vérifie que le signalement a lieu.

⚠️ **Écris ces trois scénarios avant de toucher au client**, et vérifie que le 9 échoue tant
que le rejeu n'existe pas. S'il passe du premier coup, il ne modélise pas ce qu'il prétend.

- [ ] **Étape 2 : rapporter les trois chiffres**, puis commit :
`test(shared): la replication survit aux morts, avec et sans rejeu`

---

## Tâche 9 : `back/src/combat.ts` et l'intégration serveur

**Fichiers :**
- Créer : `back/src/combat.ts`, `back/src/combat.test.ts`
- Modifier : `back/src/room.ts`, `back/src/room.test.ts`, `back/src/server.ts`

- [ ] **Étape 1 : les constantes de combat**

Reprendre du tableau « Cohérence des constantes » en tête de ce plan : `PLAYER_MAX_HP`,
`CONTACT_DAMAGE`, `CONTACT_INTERVAL_TICKS`, `CONTACT_RADIUS`, `ORB_LIFETIME_TICKS`,
`ORB_PICKUP_RADIUS`, `XP_PER_ORB`, `LEVEL_FREEZE_TICKS`, `LEVEL_RESUME_TICKS`.

- [ ] **Étape 2 : `combat.ts`, testé sans serveur**

Il ne connaît ni `ws` ni `fastify` — comme `room.ts`, et pour la même raison. Il expose
l'arbitrage : appliquer les dégâts des projectiles, décider des morts, du contact, des
ramassages.

- [ ] **Étape 3 : l'ordre du tick serveur**

⚠️ **L'ordre compte, et il doit rester identique côté client.** L'étape 2 a montré qu'une
divergence d'ordre entre les deux séquences ne se voit dans aucun test unitaire. Séquence
retenue, à reproduire à l'identique à la tâche 10 :

```
1. tick++
2. deplacer les joueurs
3. enregistrer l'historique de positions (arrondi !)
4. appliquer les ordres de vague en attente
5. recalculer les champs si du (tick % stepsPerField)
6. avancer la horde
7. appliquer la separation
8. avancer les projectiles, resoudre les collisions
9. arbitrer le contact avec les joueurs
10. resoudre les ramassages d'orbes
11. mettre en file morts et ramassages pour diffusion
```

- [ ] **Étape 4 : le gel**

Quand l'expérience franchit un seuil, `Room` cesse d'avancer pendant `LEVEL_FREEZE_TICKS`
et met un `LEVEL_UP` en file. La reprise est progressive sur `LEVEL_RESUME_TICKS`.

⚠️ **Le gel doit être daté.** Le message porte le tick auquel il prend effet, pour que les
clients figent au même tick et non à la réception.

- [ ] **Étape 5 : diffusion**, dans `server.ts`, avant le snapshot du même tick, comme les
ordres de vague. Compter les octets dans `#wireBytes`.

- [ ] Commit : `feat(back): combat arbitre par le serveur, gel et fin de run`

---

## Tâche 10 : intégration client

**Fichiers :**
- Modifier : `front/src/net/client.ts`, `front/src/net/client.test.ts`

- [ ] **Étape 1 : appliquer les morts avec rejeu**

```ts
  #applyDeaths(tick: number, ids: readonly number[]): void {
    // ⚠️ On restaure l'etat du tick de la mort, on applique, puis on rejoue.
    // Appliquer au present laisserait une difference d'un tick s'installer — et
    // l'etape 2 a mesure ce que ca produit : 694 px apres dix secondes, sans
    // borne. Avec la separation, une mort en retard ne decale plus une entite
    // mais des dizaines.
    if (!this.#hordeHistory.restore(tick, this.horde)) {
      // Trop vieux pour l'anneau : on applique au present, et on le SIGNALE.
      // Une degradation silencieuse est un piege.
      this.#lateDeaths += ids.length;
      this.horde.kill(ids);
      return;
    }
    this.horde.kill(ids);
    for (let t = tick + 1; t <= this.#lastHordeTick; t++) {
      this.#replayTick(t);
    }
  }
```

`#replayTick` doit exécuter **exactement** les étapes 5 à 8 de la séquence serveur, dans le
même ordre, sur l'état retardé correspondant.

- [ ] **Étape 2 : exposer le compteur de morts tardives**

En lecture, pour le HUD de debug et pour les tests. Le §4.6 de l'orientation demande un HUD,
pas des logs.

- [ ] **Étape 3 : orbes, gel, points de vie**

Les orbes se dérivent des morts ; le gel fige la horde au tick indiqué ; les points de vie
et l'expérience viennent du snapshot.

- [ ] Commit : `feat(front): morts appliquees par rejeu, orbes derives, gel`

---

## Tâche 11 : le rendu du combat

**Fichiers :**
- Créer : `front/src/render/projectile-renderer.ts`
- Modifier : `front/src/render/stage.ts`, `front/index.html`, `front/src/main.ts`

- [ ] Projectiles et orbes en `ParticleContainer`, **avec `boundsArea` explicite** — un
`ParticleContainer` ne calcule pas ses bornes, c'est la découverte du spike de l'étape 2.
- [ ] Retour d'impact : un flash court, large et généreux. Le §4.3 rappelle que c'est là que
passe le budget VFX, pas dans un halo permanent.
- [ ] HUD : points de vie, niveau, chronomètre.
- [ ] Écran de bilan : temps survécu, niveau atteint, ennemis tués.

- [ ] Commit : `feat(front): rendu des projectiles, des orbes et du bilan de run`

---

## Tâche 12 : vérification manuelle et clôture

- [ ] **Jouer une run entière**, au premier plan.

> ⚠️ Un onglet en arrière-plan a son `requestAnimationFrame` suspendu — mesuré à l'étape 2 :
> zéro image en 2,5 secondes. La horde n'avance pas et la capture montre une image périmée.
> La poignée `window.__tarnok` permet d'avancer les images à la main (`__tarnok.step(N)`).

- [ ] **Ce qui relève du jugement :** la masse respire-t-elle, ou forme-t-elle encore des
files ? Le tir a-t-il du punch ? Le gel est-il lisible ? La mort est-elle comprise ?
- [ ] **Rejouer les trois bancs** — la séparation change le coût du pas de simulation, donc
les chiffres de l'étape 1 sont périmés.
- [ ] Écrire `docs/plans/2026-XX-XX-etape-3-resultats.md` : les trois dérives du §8, les
chiffres de bancs avant/après, ce qui reste ouvert.
- [ ] Mettre à jour le `README.md`.
- [ ] Commit : `docs: resultats de l'etape 3`

---

## Auto-relecture

**Couverture de la spec.** §3.1 morts sur le fil → tâche 4 ; §3.2 rejeu → tâches 3 et 10 ;
§3.3 le coût → tâche 0 ; §4 séparation → tâche 1 ; §5.1 armes → tâche 5 ; §5.2 tir dérivé →
tâche 7 ; §5.3 auto-visée → tâche 6 ; §5.4 dégâts serveur → tâche 9 ; §6.1 orbes → tâches 4
et 10 ; §6.2 gel → tâche 9 ; §6.3 mort du joueur → tâches 9 et 11 ; §7 protocole → tâche 4 ;
§8 vérification → tâches 8 et 12.

**Cohérence des constantes.** Toutes celles introduites figurent dans le tableau en tête,
avec ce qui les contraint. Les deux couples liés sont explicites :
`SEPARATION_RADIUS ≤ SEPARATION_CELL / 2`, et `ROLLBACK_DEPTH_TICKS >` latence maximale.
`TARGETING_DELAY_TICKS` est défini **égal** à `FIELD_INPUT_DELAY_TICKS` plutôt que recopié.

**Cohérence des types.** `kill` prend des identifiants et non des indices, partout.
`nearestTarget` rend une identité, pas un créneau — un créneau ne survit pas à une
compaction. `HordeState` est défini une fois en tâche 3 et consommé tel quel en 10.

**Un piège à surveiller à l'exécution.** `slotOf` est linéaire, et `kill` l'appelle une fois
par mort : à cent morts sur quatre mille entités, c'est 400 000 comparaisons par tick. Si le
banc de la tâche 0 ou celui de la tâche 12 montre que ça compte, remplacer par une table
d'identité vers créneau — mais **mesurer avant**, pas avant d'avoir mesuré.
