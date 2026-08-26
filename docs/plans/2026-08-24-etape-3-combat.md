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
| ~~`TARGETING_DELAY_TICKS`~~ | **supprimée** | l'auto-visée lit l'état courant des deux côtés — voir ci-dessous |
| `ROLLBACK_DEPTH_TICKS` | 8 | **doit être > la latence maximale en ticks** ; 8 ticks = 266 ms, au-delà de quoi une mort est appliquée au présent **et signalée** |
| `SEPARATION_RADIUS` | 28 px | **doit être ≤ moitié de `SEPARATION_CELL`** pour que les huit voisines suffisent |
| `SEPARATION_CELL` | 56 px | = `2 × SEPARATION_RADIUS` |
| `SEPARATION_STRENGTH` | **1200 px/s** | **le principal levier de coût**, pas un réglage de sensation — voir ci-dessous |
| `ORB_LIFETIME_TICKS` | 600 (20 s) | dérivé des deux côtés, donc aucune valeur ne doit dépendre d'une horloge murale |
| `ORB_PICKUP_RADIUS` | 90 px | arbitré serveur |
| `PLAYER_MAX_HP` | 100 | |
| `CONTACT_DAMAGE` | 8 | par contact et par intervalle |
| `CONTACT_INTERVAL_TICKS` | 15 (0,5 s) | invulnérabilité entre deux touches |
| `CONTACT_RADIUS` | 34 px | §3.4 : hitbox **généreuse**, en faveur du joueur |
| `XP_PER_ORB` | 1 | |
| `LEVEL_FREEZE_TICKS` | 60 (2 s) | l'étape 4 le portera à 20 s plafonnées (§7.4) |
| `LEVEL_RESUME_TICKS` | 30 (1 s) | reprise progressive (§7.4) |
| `PROJECTILE_HIT_RADIUS` | 32 px | rayon de touche, **sans contrainte de vitesse** — la collision balaie le segment, voir ci-dessous |
| `LEVEL_XP_BASE` | à fixer par la tâche 9 | seuil du premier niveau ; l'étape 4 le multipliera par N joueurs (§5 de l'orientation) |

> ### Pourquoi l'auto-visée ne lit PAS un état retardé
>
> Le §5.3 de la spec d'étape demande `T − K` des deux côtés « pour que la direction visée soit
> identique ». L'intention est bonne, le moyen ne marche pas ici, et la tâche 9 l'a montré.
>
> Le retard `T − K` fonctionne pour le flowfield parce qu'il porte sur les **positions des
> joueurs**, qui sont répliquées avec un délai connu : les deux côtés peuvent donc s'accorder
> exactement. Le ciblage, lui, dépend de la **horde**, qui est *dérivée* et non répliquée. Son
> désaccord ne vient pas de la latence d'entrée mais de la **propagation des morts** — et
> retarder la lecture n'y change rien tant que le serveur devrait, pour s'aligner, tenir un
> second anneau d'états complet (`.set()` sur sept tableaux de `MAX_ENTITIES` à chaque tick,
> jamais budgété par le banc de la tâche 0).
>
> **Décision : les deux côtés visent sur l'état courant**, et la divergence transitoire est
> acceptée — c'est la même que celle déjà documentée sur `fireSalvo`. Les projectiles ne sont
> pas répliqués et les dégâts sont arbitrés par le serveur : l'écart est visuel et se résorbe
> au rejeu.
>
> `TARGETING_DELAY_TICKS` est donc **supprimée** plutôt que laissée inutilisée. Une constante
> qui nomme un mécanisme absent est pire qu'aucune constante.
>
> ⚠️ **À rouvrir si la vérification manuelle de la tâche 12 rend l'écart visible** — un tir qui
> part vers un monstre déjà mort se remarque. C'est là qu'on le saura, pas ici.

> ### La collision balaie le segment, elle n'échantillonne pas le point d'arrivée
>
> Première version : `collide` comparait la distance entre l'ennemi et la position **d'arrivée**
> du projectile. On avait alors ajouté une contrainte `PROJECTILE_HIT_RADIUS ≥
> max(projectileSpeed) / TICK_HZ`, en croyant qu'elle empêchait le tunnel. **Elle ne
> l'empêchait pas.** Cas mesuré, avec l'arme à 900 px/s (30 px par tick) et un rayon de 32 :
>
> - le projectile va de `(0, 0)` à `(30, 0)` en un tick ;
> - un ennemi en `(15, 30)` est à 30 px du segment — **dans le rayon** ;
> - mais il est à 33,5 px de *chacune des deux extrémités* — **hors du rayon**.
>
> Aucune touche. La contrainte protégeait seulement les cibles pile sur l'axe de tir ; celles
> qui passaient sur le côté, au milieu du pas, étaient traversées en silence. Et le défaut
> empirait avec la vitesse, c'est-à-dire là où la contrainte prétendait protéger.
>
> ⚠️ **La parade est géométrique, pas numérique** : `collide` mesure la distance de l'ennemi
> au **segment parcouru** — `step` conserve la position précédente dans `#prevX` / `#prevY`, et
> `collide` s'en sert. Le tunnel devient alors impossible quelle que soit la vitesse.
>
> **La contrainte de vitesse est donc supprimée**, et le test qui la vérifiait avec elle : il
> garderait un proxy devenu inutile, et bloquerait une arme rapide parfaitement légitime. À sa
> place, un test qui reproduit le cas ci-dessus — deux extrémités hors du rayon, segment
> dedans — et exige la touche. Il teste la protection réelle au lieu de son approximation.

> ### Pourquoi `SEPARATION_STRENGTH` n'est pas un réglage de sensation
>
> La première version de ce tableau la donnait à 120 px/s en la qualifiant de « réglage de
> sensation, sans effet sur le déterminisme ». La seconde moitié est vraie ; la première a
> fait échouer la porte de la tâche 0, et la mesure explique pourquoi.
>
> Cette constante fixe la **densité d'équilibre** de la horde, et le coût de la séparation
> croît avec le carré de cette densité. À 120 px/s la répulsion perd contre le flowfield :
> l'équilibre n'est jamais atteint, la densité continue de monter tant que des monstres
> arrivent, et l'on paie plein tarif pour un entassement à ~11 px d'écart alors que le rayon
> en demande 28. Mesuré à 1 500 entités, entre le tick 60 et le tick 360 :
>
> | Force | Voisins à t60 → t360 | Pas (ms) | Rejeu de 3 ticks |
> | --- | --- | --- | --- |
> | 120 | 11,5 → **29,0** — jamais stable | 0,94 | 3,8 ms |
> | 600 | 5,5 → 8,3 | 0,46 | 1,8 ms |
> | **1200** | **3,5 → 4,0 — stable** | **0,33** | **1,3 ms** |
> | 2000 | 2,3 → 2,3 | 0,27 | 1,1 ms |
>
> 1200 px/s n'est pas une vitesse : c'est une **raideur**, multipliée par la fraction de
> recouvrement `(R − d) / R`. Deux entités à 27 px l'une de l'autre se poussent de 1,4 px par
> tick ; seules celles qui se superposent vraiment reçoivent une grosse impulsion. Le
> mécanisme s'auto-limite.
>
> ⚠️ **Ne pas plafonner le déplacement par tick.** Essayé à `R / 2` : le coût *empire* (47
> voisins au lieu de 37 à 4 000 entités), parce que brider la poussée empêche l'entassement
> de se relâcher. Le remède aggrave le mal.

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
const SEPARATION_STRENGTH = 1200;

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
  readonly #cursor: Int32Array;
  readonly #cellIdx: Int32Array;
  readonly #order: Int32Array;
  readonly #pushX: Float32Array;
  readonly #pushY: Float32Array;

  constructor(capacity: number) {
    this.#cols = Math.ceil(MAP_SIZE / SEPARATION_CELL);
    const cells = this.#cols * this.#cols;
    this.#cellStart = new Int32Array(cells + 1);
    this.#cellCount = new Int32Array(cells);
    this.#cursor = new Int32Array(cells + 1);
    this.#cellIdx = new Int32Array(capacity);
    this.#order = new Int32Array(capacity);
    this.#pushX = new Float32Array(capacity);
    this.#pushY = new Float32Array(capacity);
  }

  apply(horde: Horde, dt: number): void {
    const n = horde.count;
    const cols = this.#cols;
    const hx = horde.x;
    const hy = horde.y;
    this.#cellCount.fill(0);
    this.#pushX.fill(0, 0, n);
    this.#pushY.fill(0, 0, n);

    // Tri par comptage dans la grille : deux passes lineaires, zero allocation.
    // La cellule de chaque entite est calculee UNE fois et memorisee.
    for (let i = 0; i < n; i++) {
      const cx = Math.min(cols - 1, Math.max(0, Math.floor((hx[i] ?? 0) / SEPARATION_CELL)));
      const cy = Math.min(cols - 1, Math.max(0, Math.floor((hy[i] ?? 0) / SEPARATION_CELL)));
      const c = cy * cols + cx;
      this.#cellIdx[i] = c;
      this.#cellCount[c] = (this.#cellCount[c] ?? 0) + 1;
    }
    let running = 0;
    for (let c = 0; c < this.#cellCount.length; c++) {
      this.#cellStart[c] = running;
      this.#cursor[c] = running;
      running += this.#cellCount[c] ?? 0;
    }
    this.#cellStart[this.#cellCount.length] = running;
    for (let i = 0; i < n; i++) {
      const c = this.#cellIdx[i] ?? 0;
      this.#order[this.#cursor[c] ?? 0] = i;
      this.#cursor[c] = (this.#cursor[c] ?? 0) + 1;
    }

    // Chaque paire est examinee UNE fois (j > i) et la force appliquee aux deux
    // entites, egale et opposee. Visiter (i, j) puis (j, i) doublerait le travail
    // pour recalculer exactement la meme chose au signe pres.
    const r2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
    for (let i = 0; i < n; i++) {
      const xi = hx[i] ?? 0;
      const yi = hy[i] ?? 0;
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
            if (j <= i) {
              continue;
            }
            const dx = xi - (hx[j] ?? 0);
            const dy = yi - (hy[j] ?? 0);
            const d2 = dx * dx + dy * dy;
            if (d2 > r2 || d2 === 0) {
              continue;
            }
            const d = Math.sqrt(d2);
            const push = (SEPARATION_RADIUS - d) / SEPARATION_RADIUS;
            const ux = (dx / d) * push;
            const uy = (dy / d) * push;
            this.#pushX[i] = (this.#pushX[i] ?? 0) + ux;
            this.#pushY[i] = (this.#pushY[i] ?? 0) + uy;
            this.#pushX[j] = (this.#pushX[j] ?? 0) - ux;
            this.#pushY[j] = (this.#pushY[j] ?? 0) - uy;
          }
        }
      }
    }

    const speed = SEPARATION_STRENGTH * dt;
    for (let i = 0; i < n; i++) {
      hx[i] = (hx[i] ?? 0) + (this.#pushX[i] ?? 0) * speed;
      hy[i] = (hy[i] ?? 0) + (this.#pushY[i] ?? 0) * speed;
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

/**
 * Nombre moyen de voisins dans le rayon, par force brute.
 *
 * ⚠️ C'est la mesure de controle, et elle n'est pas decorative. Le cout de la
 * separation croit avec le CARRE de la densite : une horde qui s'entasse a 29
 * voisins par entite au lieu de 4 coute huit fois plus cher, sans qu'aucune
 * ligne de code soit en cause. La premiere execution de ce banc a franchi la
 * porte du §3.3 pour exactement cette raison — une force de repulsion trop
 * faible pour atteindre son equilibre. Sans cette colonne, on aurait conclu que
 * l'architecture etait trop chere.
 *
 * Se lit par paire avec la stabilite : si la densite a la fin depasse nettement
 * celle du milieu, l'equilibre n'est pas atteint et le chiffre de cout ne veut
 * rien dire — il ne mesure qu'un instantane d'un entassement qui grossit encore.
 */
function meanNeighbours(horde: Horde): number {
  const n = horde.count;
  const r2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
  let total = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        continue;
      }
      const dx = (horde.x[i] ?? 0) - (horde.x[j] ?? 0);
      const dy = (horde.y[i] ?? 0) - (horde.y[j] ?? 0);
      if (dx * dx + dy * dy <= r2) {
        total++;
      }
    }
  }
  return total / n;
}

interface Measurement {
  median: number;
  p95: number;
  /** Voisins moyens juste apres la chauffe. */
  neighboursEarly: number;
  /** Voisins moyens a la fin — doit rester proche du precedent. */
  neighboursLate: number;
}

function measure(count: number, withSeparation: boolean): Measurement {
  const { horde, fields } = makeHorde(count);
  const sep = new Separation(4000);
  const times: number[] = [];
  let neighboursEarly = 0;
  for (let step = 0; step < WARMUP_STEPS + MEASURED_STEPS; step++) {
    const started = performance.now();
    horde.step(DT, fields);
    if (withSeparation) {
      sep.apply(horde, DT);
    }
    const elapsed = performance.now() - started;
    if (step === WARMUP_STEPS) {
      neighboursEarly = meanNeighbours(horde);
    }
    if (step >= WARMUP_STEPS) {
      times.push(elapsed);
    }
  }
  const s = stats(times);
  return {
    median: s.median,
    p95: s.p95,
    neighboursEarly,
    neighboursLate: meanNeighbours(horde),
  };
}

function main(): void {
  console.log(`Banc de separation — ${machineDescription()}`);
  console.log(`Rayon ${SEPARATION_RADIUS} px, cellule ${SEPARATION_CELL} px\n`);

  const rows = [250, 500, 1000, 1500, 2500, 4000].map((n) => {
    const sans = measure(n, false);
    const avec = measure(n, true);
    const rejeu4 = avec.median * 4;
    // Densite stable = l'equilibre est atteint et le cout veut dire quelque chose.
    //
    // ⚠️ Le seuil absolu n'est pas une commodite. Un rapport debut/fin sur une
    // valeur proche de 1 mesure du bruit : a 250 entites la densite passe de 0,9
    // a 2,2 voisins, soit un facteur 2,4 — pour un pas a 0,12 ms. Signaler ca
    // comme « mesure invalide » rendrait la colonne rouge en permanence, et une
    // alerte qu'on apprend a ignorer ne protege plus de rien.
    //
    // La question posee est « ce chiffre de cout veut-il dire quelque chose ? ».
    // Une horde a moins de 8 voisins par entite reste dans un regime bon marche :
    // meme mal stabilisee, elle ne peut pas rendre le verdict faux.
    //
    // ⚠️ Le OU court-circuite : une trajectoire 1,0 -> 7,9 voisins passe pour
    // « atteint » alors qu'elle est clairement encore en transitoire. C'est
    // assume — a cette densite le pas coute ~0,4 ms et le verdict ne change pas
    // de bande. Mais la ligne qui porte la porte (1 500 entites) ne s'appuie PAS
    // sur ce plancher : elle passe le test de rapport toute seule, 3,4 -> 4,0
    // voisins. Si un jour ce n'est plus vrai, resserrer le plancher.
    const stable = avec.neighboursLate < 8 || avec.neighboursLate <= avec.neighboursEarly * 1.5;
    return {
      entites: n,
      'pas sans separation (ms)': round2(sans.median),
      'pas avec separation (ms)': round2(avec.median),
      'cout de la separation (ms)': round2(avec.median - sans.median),
      'voisins (debut)': round2(avec.neighboursEarly),
      'voisins (fin)': round2(avec.neighboursLate),
      equilibre: stable ? 'atteint' : 'NON ATTEINT',
      'rejeu de 3 ticks (ms)': round2(rejeu4),
      verdict: !stable ? 'mesure invalide' : rejeu4 < 1 ? 'OK' : rejeu4 < 4 ? 'a borner' : 'rouvrir le §3.2',
    };
  });
  console.table(rows);

  const cible = rows.find((r) => r.entites === 1500);
  console.log(
    `\n-> A la cible de 1 500 entites (§4.1), un rejeu de trois ticks coute ` +
      `${cible?.['rejeu de 3 ticks (ms)']} ms sur un budget d'image de 16,7 ms.`,
  );
  console.log(
    `   Densite : ${cible?.['voisins (debut)']} -> ${cible?.['voisins (fin)']} voisins ` +
      `(${cible?.equilibre}).`,
  );
  if (rows.some((r) => r.equilibre !== 'atteint')) {
    console.log(
      `\n⚠️  Un effectif au moins n'a PAS atteint son equilibre de densite. Son chiffre de\n` +
        `   cout ne mesure pas l'algorithme, il mesure un entassement qui grossit encore.\n` +
        `   Corriger SEPARATION_STRENGTH avant de lire le verdict.`,
    );
  }
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
> ⚠️ **Mais lis d'abord la colonne « équilibre ».** Si un effectif affiche `NON ATTEINT`, son
> chiffre de coût ne mesure pas l'algorithme — il mesure un entassement qui grossit encore, et
> le verdict qui en découle ne veut rien dire. C'est exactement ce qui s'est produit à la
> première exécution de ce banc.
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

/**
 * Raideur de la repulsion, en pixels monde par seconde, multipliee par la
 * fraction de recouvrement `(R - d) / R`.
 *
 * ⚠️ **Ce n'est pas un reglage de sensation.** Cette constante fixe la densite
 * d'equilibre de la horde, et le cout de la separation croit avec le CARRE de
 * cette densite. A 120 px/s la repulsion perd contre le flowfield : l'equilibre
 * n'est jamais atteint et le banc de la tache 0 franchit la porte du §3.3 pour
 * cette seule raison. A 1200 px/s la horde se stabilise a ~4 voisins par entite
 * au lieu de ~29, et le rejeu passe de 3,8 ms a 1,3 ms.
 *
 * La baisser est un choix de performance avant d'etre un choix de sensation.
 */
export const SEPARATION_STRENGTH = 1200;
```

- [ ] **Étape 2 : écrire le test qui échoue**

`shared/separation.test.ts` :

```ts
import { describe, expect, it } from 'vitest';

import { SEPARATION_CELL, SEPARATION_RADIUS, TICK_HZ } from './constants';
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
    // ⚠️ L'ecart est choisi STRICTEMENT entre le rayon (28) et la cellule (56).
    //
    // La premiere version de ce test les placait a 84 px. A cette distance la
    // paire tombe a deux cellules d'ecart, donc la recherche sur les neuf
    // cellules voisines ne l'examine meme pas : le test passait par le
    // decoupage de la grille, sans jamais atteindre la comparaison de rayon
    // qu'il pretend couvrir. Verifie en supprimant `d2 > r2` de la production —
    // les cinq tests passaient toujours.
    //
    // A 42 px la paire EST examinee, et seule la comparaison de rayon la rejette.
    const ecart = (SEPARATION_RADIUS + SEPARATION_CELL) / 2;
    const horde = hordeAt([
      [3000, 3000],
      [3000 + ecart, 3000],
    ]);
    const grid = new SeparationGrid(100);

    grid.apply(horde, DT);

    expect(horde.x[0]).toBe(3000);
    expect(horde.x[1]).toBe(3000 + ecart);
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

  // ⚠️ Il n'y a PAS de test « n'alloue pas a chaque appel ». La premiere version
  // de ce plan en contenait un — mille appels enveloppes dans `not.toThrow()`,
  // avec un commentaire affirmant qu'il « attraperait une reallocation par
  // appel ». Il ne l'attrapait pas : verifie en reintroduisant le
  // `this.#cellStart.slice()` par appel, les six tests passaient toujours.
  //
  // L'absence d'allocation est une propriete de PERFORMANCE, et un test unitaire
  // ne sait pas l'observer sans exposer les tableaux prives — c'est-a-dire sans
  // ajouter du code de test dans une classe de production. Son gardien est le
  // banc (`npm run bench:sep -w back`), ou une allocation par appel se verrait
  // dans l'ecart entre mediane et p95.
  //
  // Un test qui ne teste rien est pire que pas de test : il fabrique de la
  // confiance. On le supprime plutot que de le maquiller.
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

Le banc de la tâche 0 contient déjà la version corrigée : **parcours symétrique** (`j > i`,
force appliquée aux deux entités, égale et opposée), cellule calculée une seule fois par
entité et mémorisée dans `#cellIdx`, curseur pré-alloué dans `#cursor` plutôt qu'un
`this.#cellStart.slice()` qui allouerait à chaque appel, et tableaux `hx`/`hy` hissés hors
de la boucle interne. Reprends-la telle quelle.

> ⚠️ **Le parcours symétrique est une optimisation, et rien d'autre** (~1,4× sur le pas
> complet). Une version antérieure de ce plan affirmait qu'il rendait en plus la symétrie
> « exacte plutôt qu'approchée ». C'est faux, et ça a été vérifié en retirant le garde
> `j > i` : les six tests passaient toujours, au bit près. La raison est que la soustraction
> IEEE 754 est exactement anti-symétrique — `xi - xj` et `xj - xi` sont opposés sans erreur,
> donc les deux parcours calculent les mêmes forces.
>
> Le test « repousse symétriquement » garde donc quelque chose de plus modeste et de plus
> utile : **une erreur de signe** dans l'application des forces. Vérifié aussi : celle-là le
> fait bien échouer.

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

  // ⚠️ Note sur le test ci-dessous : il compare deux executions du MEME code,
  // donc il prouve qu'un tri deterministe existe, pas qu'il est decroissant.
  // C'est « preserve toutes les entites survivantes » qui porte cette
  // exigence — verifie : passer le tri en croissant le fait echouer, et lui
  // seul. Les deux se tiennent ; ne pas supprimer l'un en gardant l'autre.
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

  it('ne retire qu une fois une identite listee deux fois', () => {
    // Rien dans le protocole ne garantit l'unicite : deux armes qui achevent la
    // meme entite au meme tick peuvent l'inscrire deux fois dans le lot. Sans
    // garde, la seconde passe supprime l'entite vivante deplacee dans le trou.
    const horde = new Horde(1000);
    horde.spawn(order({ count: 10 }));
    const cible = horde.entityIdAt(3);
    const survivants = new Set(
      Array.from({ length: 10 }, (_, i) => horde.entityIdAt(i)).filter((id) => id !== cible),
    );

    expect(horde.kill([cible, cible])).toBe(1);
    expect(horde.count).toBe(9);

    const apres = new Set(Array.from({ length: horde.count }, (_, i) => horde.entityIdAt(i)));
    expect(apres).toEqual(survivants);
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
    // et l'etape 3 le paierait en sprites melanges, ou pire en monstres qui
    // poursuivent le champ de flux d'un autre joueur.
    //
    // ⚠️ Les SEPT tableaux sont verifies, un par un. Une premiere version de ce
    // test n'en verifiait que deux — `archetype` et `animPhase` — alors que son
    // nom promet « pas seulement sa position ». Verifie : supprimer la copie de
    // `x`, de `y` ou de `targetField` laissait les 26 tests verts.
    //
    // Si un tableau est ajoute a `Horde`, il doit apparaitre ICI et dans
    // `#removeAt`. Les deux listes se tiennent.
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 1, archetype: 0, count: 5 }));
    horde.spawn(order({ waveId: 2, archetype: 3, count: 5 }));
    const last = horde.count - 1;
    // Valeurs distinctives : deux entites qui partagent deja une valeur ne
    // prouveraient rien d'une copie manquante.
    horde.x[last] = 1234.5;
    horde.y[last] = 6789.5;
    horde.targetField[last] = 3;
    const attendu = {
      entityId: horde.entityIdAt(last),
      x: horde.x[last],
      y: horde.y[last],
      archetype: horde.archetype[last],
      waveId: horde.waveId[last],
      indexInWave: horde.indexInWave[last],
      animPhase: horde.animPhase[last],
      targetField: horde.targetField[last],
    };

    horde.kill([horde.entityIdAt(0)]);

    const slot = horde.slotOf(attendu.entityId);
    expect(slot).toBe(0);
    expect(horde.x[slot]).toBe(attendu.x);
    expect(horde.y[slot]).toBe(attendu.y);
    expect(horde.archetype[slot]).toBe(attendu.archetype);
    expect(horde.waveId[slot]).toBe(attendu.waveId);
    expect(horde.indexInWave[slot]).toBe(attendu.indexInWave);
    expect(horde.animPhase[slot]).toBe(attendu.animPhase);
    expect(horde.targetField[slot]).toBe(attendu.targetField);
  });

  it('ignore une identite inconnue melangee a une connue', () => {
    // ⚠️ C'est le seul cas qui rende le filtre `slot >= 0` porteur. Avec une
    // identite inconnue SEULE, le garde de doublon la confond avec `previous`
    // initialise a -1 et masque le defaut par hasard : la mutation passe. Une
    // inconnue melangee a une connue ne beneficie plus de cette coincidence.
    //
    // Sans le filtre, `#removeAt(-1)` decremente `#count` en ecrivant dans le
    // vide — l'ecriture a un indice negatif sur un tableau type est un no-op
    // silencieux — et une entite vivante disparait du compte.
    const horde = new Horde(1000);
    horde.spawn(order({ count: 10 }));
    const cible = horde.entityIdAt(4);

    expect(horde.kill([cible, 999_999])).toBe(1);
    expect(horde.count).toBe(9);
    expect(horde.slotOf(cible)).toBe(-1);
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
    let previous = -1;
    for (const slot of slots) {
      // Une identite listee deux fois designe le meme creneau. Le retirer deux
      // fois supprimerait l'entite VIVANTE que la premiere passe vient d'y
      // deplacer — un monstre disparait sans que rien ne le signale, et les
      // clients divergent en silence. Le tri decroissant met les doublons cote
      // a cote, donc un seul test suffit.
      if (slot === previous) {
        continue;
      }
      previous = slot;
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

`LEVEL_UP` et `RUN_OVER` sont **datés** eux aussi, et leur contenu vient du §7 de la spec :

| Message | Disposition | Octets |
| --- | --- | --- |
| `LEVEL_UP` | `type u8 · tick u32 · level u8` | 6 |
| `RUN_OVER` | `type u8 · tick u32 · survivedTicks u32 · level u8 · kills u32` | 14 |

> ⚠️ **`LEVEL_UP` ne porte pas d'identifiant de joueur, et c'est structurel.** Le §2 de la
> spec d'orientation est explicite : « **L'expérience est globale** : ce qu'un joueur ramasse
> fait monter toute l'équipe, en même temps », et « un seul étalage de cartes pour toute
> l'équipe ». Personne ne monte de niveau individuellement — c'est l'équipe qui monte, et le
> gel est commun. Un `playerId` ici inviterait à croire le contraire.

> ⚠️ **Le tick de `LEVEL_UP` est celui où le gel prend effet, pas celui de l'émission.** Le
> §6.2 de la spec l'exige : sans lui, chaque client figerait à la réception, donc à un tick
> différent selon sa latence — et le gel deviendrait une source de divergence au lieu d'une
> pause commune. C'est la même raison qui date les morts.
>
> `kills` tient sur 32 bits et non 16 : une run longue dépasse 65 535 ennemis tués, et le
> message ne part qu'une fois par run — l'économie de deux octets ne se discute pas.

Le `SNAPSHOT` gagne les points de vie et l'expérience, **mais pas au même endroit** :

| Bloc | Disposition | Octets |
| --- | --- | --- |
| En-tête | `type u8 · tick u32 · playerCount u8 · xp u16` | 6 → **8** |
| Par joueur | `id u8 · x i16 · y i16 · hp u8` | 5 → **6** |

> ⚠️ **L'expérience est dans l'en-tête, pas dans le bloc joueur.** Les points de vie sont
> personnels, l'expérience est celle de l'équipe. La mettre par joueur créerait **deux
> sources de vérité pour un seul nombre** — et le jour où elles divergent, un joueur voit le
> niveau 4 pendant que son voisin voit le niveau 3, sans qu'aucun test unitaire ne l'ait vu.
>
> Accessoirement c'est moins cher : à quatre joueurs, `8 + 4 × 6 = 32` octets contre
> `6 + 4 × 8 = 38`.

> ⚠️ **`hp` et `xp` n'existent pas encore côté serveur** — c'est la tâche 9 qui les fait
> vivre. Cette tâche câble le transport : `Room` remplit `hp` avec `PLAYER_MAX_HP` et `xp`
> avec `0`. Ne pas inventer de comptabilité ici. `hp` tient sur un octet (`PLAYER_MAX_HP` vaut
> 100), `xp` sur deux — vérifier les bornes dans les tests d'encodage.

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

> ⚠️ `step` conserve la position d'avant le déplacement dans `#prevX` / `#prevY`, et `collide`
> mesure la distance de l'ennemi au **segment** `prev → courant`, jamais au seul point
> d'arrivée. Deux tableaux de plus, et le tunnel devient impossible quelle que soit la vitesse
> de l'arme. Voir la note sur `PROJECTILE_HIT_RADIUS` en tête de plan pour le cas mesuré qui
> l'impose.

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
être appliquée au présent, **signalée**, sans planter — et **la dérive qui en résulte doit
être mesurée et affichée**.

> Ce dernier point n'est pas décoratif : c'est l'obligation que la porte de la tâche 0 a
> laissée derrière elle. Son verdict est tombé dans la bande « à borner », dont la contrepartie
> écrite d'avance est « on borne `ROLLBACK_DEPTH_TICKS` **et on mesure la dérive résiduelle** ».
> La borne est `ROLLBACK_DEPTH_TICKS = 8` ; ce scénario est l'endroit où l'on paie l'autre
> moitié. Sans le chiffre, la porte n'est qu'à demi franchie.

> ⚠️ Ce fichier modélise ses clients **lui-même**, comme à l'étape 2 — il n'importe pas
> `GameClient`. Le signalement testé ici est donc un compteur dans la boucle client du test,
> et la latence doit **dépasser `ROLLBACK_DEPTH_TICKS` (8)** pour que le scénario morde : à
> 1-3 ticks, l'anneau absorbe tout et le test ne prouve rien. La tâche 10 recâblera le même
> signal dans `GameClient`.

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
4. rafraichir les champs si du (tick % stepsPerField)
5. appliquer les ordres de vague en attente
6. avancer la horde
7. appliquer la separation
8. tirer les salves dues, avancer les projectiles, resoudre les collisions
9. arbitrer le contact avec les joueurs
10. resoudre les ramassages d'orbes
11. mettre en file morts et ramassages pour diffusion
```

> ⚠️ **Étapes 4 et 5 : rafraîchir AVANT d'engendrer.** Une version antérieure de ce plan les
> donnait dans l'ordre inverse. C'était une erreur : `back/src/room.ts` et le test de
> réplication — celui qui mesure 0,000 px — font tous deux le rafraîchissement d'abord, depuis
> l'étape 2. L'ordre écrit ici est celui du code éprouvé, pas l'inverse.

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

`#replayTick` exécute les étapes **4, 6 et 7** de la séquence serveur — rafraîchir le champ si
dû, avancer la horde, appliquer la séparation — dans cet ordre.

> ⚠️ **Le rejeu ne déplace PAS les projectiles.** Une version antérieure de ce plan le
> demandait. C'était une erreur.
>
> La position d'un projectile ne dépend que de sa propre vitesse, jamais de la horde :
> contrairement au mouvement des monstres, une mort tardive n'a rien à y corriger. Les rejouer
> les ferait donc avancer **deux fois** sur les ticks déjà simulés en temps réel — une fois à
> l'aller, une fois au rejeu. Une régression silencieuse, pas une amélioration.
>
> La collision, elle, lit bien la horde : le client a donc pu enregistrer un impact cosmétique
> sur une entité que le serveur avait déjà tuée. Ce n'est pas rattrapé, et c'est **accepté** —
> même raisonnement que sur `fireSalvo` : les projectiles ne sont pas répliqués et les dégâts
> sont arbitrés par le serveur.

> ⚠️ **Le champ de flux n'est pas dans l'anneau, et il faut le réamorcer avant de rejouer.**
> Ce piège a été mesuré à la tâche 8, où il coûtait **79 px** de dérive résiduelle sur un
> scénario qui aurait dû rendre zéro.
>
> `HordeHistory.restore` remet la *horde* à l'état du tick de la mort. Mais `FlowField` est un
> objet **mutable et partagé**, que l'anneau ne sauvegarde jamais : au moment où le rejeu
> démarre, il porte encore le contenu du **dernier rafraîchissement réel** — celui du tick
> présent, plusieurs générations plus frais que ce que le serveur avait sous les yeux au tick
> restauré. Et comme le rejeu ne rafraîchit qu'aux ticks effectivement dus
> (`tick % stepsPerField === 0`), il avance avec un champ trop frais jusqu'à en croiser un.
>
> C'est exactement le défaut déjà documenté sur `Horde.spawnCatchingUp` à l'étape 2 : le bon
> mécanisme dans le mauvais ordre est pire que rien.
>
> Avant la première itération du rejeu, il faut donc **revenir au dernier rafraîchissement dû
> à ce tick ou avant** :
>
> ```ts
> const lastDue = atTick - (((atTick % stepsPerField) + stepsPerField) % stepsPerField);
> const seen = this.#playerHistory.delayed(lastDue);
> if (seen) {
>   for (let f = 0; f < MAX_PLAYERS; f++) {
>     this.#fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
>   }
> }
> ```
>
> `shared/horde.replication.test.ts` en contient la version de référence, sous le nom
> `primeFieldForReplay`. **Lis-la avant d'écrire celle du client** : le test est le contrat, et
> il mesure 0,000 px.

> ⚠️ **Le rejeu client ne rejoue PAS l'arbitrage.** Les étapes 8 (dégâts), 9 (contact) et 10
> (ramassage) appartiennent au serveur : le client qui les rejouerait déciderait de morts que
> le serveur n'a pas prononcées, et divergerait précisément là où on cherche à converger. Le
> client rejoue le **mouvement** — horde, séparation, projectiles — et rien d'autre. Les morts
> lui arrivent, il ne les invente pas.

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
- [ ] Écrire `docs/plans/2026-08-24-etape-3-resultats.md` : les trois dérives du §8, les
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

---

# Addendum — ce que la vérification manuelle a trouvé

La tâche 12 a été jouée par l'auteur du jeu, au premier plan, sur une vraie run. Verdict en
trois points :

- **la masse respire** — la séparation fait son travail, les files de l'étape 2 ont disparu ;
- **le tir est faible et ne suit pas le curseur** ;
- **impossible de tester la montée de niveau : trop de monstres.**

Le premier point valide la tâche 1. Les deux autres ouvrent les tâches 13 et 14.

> **Ce qu'aucun test ne pouvait voir.** La réplication est à 0,000 px, le combat est arbitré,
> 266 tests sont verts — et le jeu est injouable. Le générateur de vagues est resté celui de
> l'étape 2, calibré pour un test de charge de rendu à 1000 entités : **~37 apparitions par
> seconde contre 2 morts par seconde**, un facteur 18. Ajouter le combat n'a retouché aucun de
> ces réglages, et rien dans la suite ne pouvait le signaler.
>
> C'est la justification de la tâche 12 telle qu'elle était écrite, et elle vaut d'être notée :
> la vérification manuelle n'est pas une formalité de clôture, c'est le seul instrument qui
> mesure cette classe de défaut.

---

## Tâche 13 : la visée suit le curseur

**Décision de l'auteur**, contre le §5.3 de la spec d'étape et le §5 de l'orientation, qui
partaient tous deux sur une visée automatique. La cadence reste automatique ; c'est la
**direction** qui devient une entrée joueur.

**Ce que ça change au contrat.** La direction de tir cesse d'être *dérivable* : elle vient de
la souris, donc elle doit transiter. Deux ajouts, et une discipline.

| Message | Ajout | Octets |
| --- | --- | --- |
| `INPUT` | `aimX i8 · aimY i8` | 5 → **7** |
| `SNAPSHOT`, bloc joueur | `aimX i8 · aimY i8` | 6 → **8** |

`INPUT` porte la visée du joueur local vers le serveur. Le `SNAPSHOT` la redistribue à tous,
**parce que chaque client dérive aussi les salves des alliés** pour les afficher : sans leur
visée, il ne saurait pas où dessiner leurs projectiles.

Coût : 4 joueurs × 2 octets × 30 Hz = 240 o/s. Sans rapport avec le nombre d'entités, donc le
test d'indépendance réseau reste valide.

> ⚠️ **La quantification doit être identique des deux côtés.** La direction part quantifiée sur
> un `i8` (−127 à 127). Le client doit tirer avec **les valeurs qu'il a envoyées**, jamais avec
> son flottant d'origine — sinon les deux côtés visent à une fraction de degré près et les
> salves divergent systématiquement, pas transitoirement.
>
> C'est exactement la discipline déjà appliquée aux positions des joueurs pour le flowfield :
> le serveur s'impose l'arrondi qu'il inflige au client (`Math.round` avant
> `PlayerHistory.record`). Même raison, même remède.

> ⚠️ **Direction nulle = pas de tir.** Curseur pile sur le joueur, ou souris jamais bougée :
> `(0, 0)` n'a pas de direction. Ne pas tirer est déterministe — les deux côtés voient le même
> zéro. Choisir une direction par défaut ne le serait pas.

**Fichiers :**
- Modifier : `shared/protocol.ts`, `shared/projectiles.ts` (tir par direction),
  `front/src/input/` (capture souris), `front/src/net/client.ts`, `back/src/room.ts`
- Modifier : les tests de chacun

**Interfaces :**
- Produit : `Projectiles.fireSalvoDirected(weapon, tick, x, y, dirX, dirY): void` — une salve
  dans une direction donnée, sans cible ni horde. `fireSalvo` (par cible) reste, mais
  **plus personne ne l'appelle pour l'arme de base** : dire dans le rapport si elle et
  `nearestTarget` deviennent du code mort, et proposer.

- [ ] **Étape 1 : le protocole**, en suivant la discipline de la tâche 4 — aller-retour,
  **taille totale exacte** contre les constantes, tampon tronqué qui lève. Un aller-retour seul
  n'attrape pas un décalage d'octet, encodeur et décodeur partageant la faute.

- [ ] **Étape 2 : la capture souris.** La position du curseur en monde, moins celle du joueur,
  normalisée, quantifiée. Le curseur vit en coordonnées écran : la conversion passe par la même
  caméra que le rendu, sinon la visée dérive quand la caméra bouge.

- [ ] **Étape 3 : le tir par direction**, serveur et client, en miroir exact.

- [ ] **Étape 4 : vérifier que la réplication n'a pas bougé** — 750,039 / 0,000 / 433,988 px.

- [ ] **Étape 5 : commit**

```bash
git commit -m "feat: la visee suit le curseur"
```

---

## Tâche 14 : rendre la run jouable

Le générateur de vagues n'a jamais été retouché depuis l'étape 2, où il servait à charger le
rendu. Chiffres actuels, solo :

| | |
| --- | --- |
| Vagues | 120 à 320 monstres toutes les 6 s → **~37/s** |
| Dague de base | 15 ticks de cooldown, 1 projectile → **2 morts/s** |
| Contact | 8 dégâts toutes les 0,5 s sur 100 pv → **mort en ~6 s** encerclé |
| Niveau 2 | 10 orbes — inatteignable à ce rythme |

**Ce qu'on cherche**, et c'est un objectif de sensation, pas une formule : au début, tuer à peu
près aussi vite que ça apparaît ; ensuite se faire déborder progressivement. Le fantasme du
genre est d'être submergé **après** avoir été à l'aise, pas dès la première vague.

- [ ] **Étape 1 : faire monter les vagues** au lieu de partir au maximum. Le générateur doit
  croître avec le numéro de vague, borné par `MAX_ENTITIES`. Un test doit vérifier que la
  progression est **monotone et bornée** — pas la valeur exacte, qui est un réglage.

- [ ] **Étape 2 : muscler l'arme de base**, pour que la montée de niveau soit atteignable.

- [ ] **Étape 3 : vérifier que la montée de niveau arrive.** Un test d'intégration serveur qui
  joue assez de ticks pour atteindre le niveau 2 et l'assène. Sans lui, on règle à l'aveugle.

> ⚠️ **Ne pas régler en aveugle.** Chaque changement de constante doit s'accompagner du chiffre
> qu'il vise — apparitions par seconde, morts par seconde, temps jusqu'au niveau 2. Le rapport
> les donne. C'est la seule façon de savoir si le réglage suivant va dans le bon sens.

- [ ] **Étape 4 : commit**

```bash
git commit -m "feat(back): faire monter les vagues, rendre la run jouable"
```

---

## Tâche 15 : les monstres sortent de la carte

**Deux symptômes rapportés, une seule cause.** « Certains monstres apparaissent mais ne bougent
jamais » et « un gros souci de clignotement avec le z-index ».

### Ce que la mesure dit

Run réelle, générateur de vagues, obstacles, joueur près d'un bord, 1200 ticks :

```
MAP_SIZE = 6000, bandes de tri valides : 0..93
x dans [-6579.8, 8485.8]
y dans [-8612.0, 7665.8]
echantillons hors bande : 2718
```

**Rien ne borne la position des entités.** La séparation à 1200 px/s pousse plus fort que le
champ de flux ne tire dès qu'un entassement se forme contre un bord, et les entités giclent
hors du monde. La force a été portée à cette valeur pour passer la porte de la tâche 0 ; le
coût caché apparaît ici.

### Pourquoi le rendu se casse en silence

`bandOf(y) = Math.floor(y / DEPTH_BAND)` sort de la plage `[0, BAND_COUNT)`. L'écriture
`counts[band]` sur un `Int32Array` hors bornes est un **no-op silencieux** — la même propriété
du langage qui avait déjà mordu à la tâche 7 sur la troncature de capacité.

Conséquence en chaîne : les sommes préfixées sont fausses ; en seconde passe,
`offsets[band] ?? 0` rend `0` pour ces entités, qui s'écrivent donc toutes au curseur de la
bande 0 et **s'écrasent mutuellement** ; des cases de `#sorted` ne sont jamais écrites de
l'image et **conservent l'indice de l'image précédente**.

D'où les deux symptômes exactement : un sprite qui affiche une entité qui n'est plus à cet
indice paraît **figé**, et l'ordre de dessin change d'une image à l'autre sans raison —
**clignotement**.

> ⚠️ Ce n'est **pas** un défaut de réplication : les deux côtés exécutent le même code et
> sortent de la carte identiquement. Le test de réplication ne pouvait pas le voir, et sa horde
> centrée ne s'approche jamais d'un bord.

### Les deux correctifs, et pourquoi les deux

- [ ] **Étape 1 : borner les positions dans `shared/`.** Après le déplacement et après la
  séparation, contraindre `x` et `y` à `[0, MAP_SIZE]`. Dans `shared/`, donc appliqué
  identiquement des deux côtés — un clamp côté client seul créerait la divergence qu'il
  prétend éviter.

  Test : une horde poussée contre un bord ne sort jamais de `[0, MAP_SIZE]`, quel que soit le
  nombre de ticks. Vérifier par mutation que le retrait du clamp le fait échouer.

- [ ] **Étape 2 : rendre `bandOf` incapable de sortir de la plage**, par `Math.min` /
  `Math.max` sur `[0, BAND_COUNT - 1]`.

  ⚠️ **Faire les deux, pas l'un ou l'autre.** L'étape 1 supprime la cause d'aujourd'hui ;
  l'étape 2 fait que la même cause, réapparue autrement demain, dégrade l'ordre de dessin au
  lieu de corrompre le tampon. Un tri par comptage qui fait confiance à sa clé est une bombe à
  retardement, et celle-ci a déjà explosé une fois.

  Test : `bandOf` sur des valeurs hors carte — négatives, au-delà de `MAP_SIZE` — reste dans la
  plage. Et un test de rendu qui dessine une horde dont une entité est hors carte, vérifiant
  qu'aucun indice de `#sorted` n'est périmé.

- [ ] **Étape 3 : vérifier que la réplication n'a pas bougé** — 750,039 / 0,000 / 433,988 px.
  Le clamp modifie les trajectoires près des bords ; si ces chiffres changent, comprendre
  pourquoi avant d'aller plus loin.

- [ ] **Étape 4 : commit**

```bash
git commit -m "fix(shared): borner les entites a la carte, et le tri de profondeur a ses bandes"
```

---

## Tâche 16 : les sprites ne correspondent à rien

Quatre retours de jeu, une racine commune pour les deux premiers : **rien ne relie la taille
dessinée d'un monstre à la taille que la simulation lui prête.**

### Mesuré

| | Taille à l'écran |
| --- | --- |
| Sprite de monstre | **192 × 192 px** (taille native de l'atlas, dessinée 1:1) |
| Joueur | 36 × 36 px (`PLAYER_RADIUS = 18`) |
| Hitbox de contact | 68 px de diamètre (`CONTACT_RADIUS = 34`) |
| Hitbox de tir | 64 px (`PROJECTILE_HIT_RADIUS = 32`) |
| Séparation | 56 px (`SEPARATION_RADIUS = 28`) |
| Portée d'un tir | 333 px, sur une vue de 1728 px |

Un monstre est donc **trois fois sa propre hitbox** et **cinq fois le joueur**. On tire sur le
corps, le projectile passe au travers : la hitbox est un disque aux pieds du sprite.

- [ ] **Étape 1 : dériver l'échelle des sprites de la hitbox, pas l'inverse.** La constante qui
  fait foi est `PROJECTILE_HIT_RADIUS` ; l'échelle de dessin s'en déduit. Écrire l'inverse —
  une échelle réglée à la main à côté d'une hitbox réglée à la main — c'est exactement ce qui a
  produit ce défaut, et ce que le tableau « Cohérence des constantes » existe pour empêcher.

  Un test doit vérifier la relation, pas les valeurs : la largeur dessinée d'un monstre reste
  du même ordre que sa hitbox. Il doit échouer si l'une bouge sans l'autre.

- [ ] **Étape 2 : orienter les sprites.** Ils ne se retournent pas vers leur cible. Le
  `ParticleContainer` de la horde déclare `dynamicProperties: { position: true }` ; le retournement
  passe par `scaleX = ±1`, qui appartient à `vertex`. Le conteneur des flashs utilise déjà
  `scaleX`, donc le chemin est connu.

  ⚠️ **C'est du rendu pur, et ça ne doit pas devenir de la simulation.** L'orientation se déduit
  de ce que le client a déjà sous la main — pas d'un nouveau champ dans `Horde`, pas d'un octet
  de plus sur le fil.

- [ ] **Étape 3 : des projectiles nets et d'une portée lisible.** La texture est un dégradé
  radial : le projectile *est* une tache floue. Et 333 px de portée font un cinquième de
  l'écran. Donner un chiffre visé, pas un ressenti.

- [ ] **Étape 4 : vérifier que la réplication n'a pas bougé** — 750,039 / 0,000 / 433,988 px.
  Rien ici ne devrait la toucher : si elle bouge, c'est que du rendu a fui dans la simulation.

- [ ] **Étape 5 : commit**

```bash
git commit -m "fix(front): accorder la taille des sprites a celle des hitbox"
```

---

## Tâche 17 : la créature, pas sa cellule — et l'attaque au contact

Deux retours de jeu, deux causes distinctes qui se règlent au même endroit : **l'atlas**.

### 17.1 Les monstres sont minuscules

La tâche 16 a dérivé l'échelle de dessin de `PROJECTILE_HIT_RADIUS`, ce qui était le bon
principe — mais elle ramène la **cellule d'atlas** à 64 px. Or une cellule de 192 px de Tiny
Swords est en grande partie **vide** : la créature n'en occupe qu'une fraction. Ramener la
cellule à la taille de la hitbox rend donc la créature bien plus petite qu'elle.

Le principe reste juste, la grandeur mesurée était fausse. **La hitbox représente le corps du
monstre, donc c'est au corps qu'il faut l'accorder** — pas au cadre qui l'entoure.

Le constructeur d'atlas doit émettre, par archétype, la **boîte englobante du contenu non
transparent**, et l'échelle s'en déduit. Ça reste mécanique : aucun nombre choisi au ressenti.

### 17.2 Les monstres traversent le joueur sans jamais l'attaquer

Ils devraient **s'arrêter et jouer leur animation d'attaque** dès qu'ils sont à portée.

Les planches existent déjà dans les assets — `_Run.png`, `_Attack.png`, `_Idle.png` par
monstre — mais `tools/build_monster_atlas.py` n'embarque que la course.

> ⚠️ **L'arrêt est de la simulation, donc il se réplique.** Les deux côtés doivent décider
> l'arrêt à partir de la **même** donnée : les positions retardées, celles qui alimentent déjà
> le flowfield, et non les positions courantes. Sinon un monstre s'arrête chez l'un et avance
> chez l'autre, et la dérive repart.
>
> L'arbitrage des dégâts, lui, reste au serveur et sur les positions courantes. Le léger
> décalage entre « s'arrête » et « touche » est sans conséquence : le serveur tranche.

> ⚠️ **Le choix de l'animation est du rendu**, et se déduit de l'état d'arrêt déjà simulé.

- [ ] **Étape 1 : l'atlas embarque course + attaque**, et publie la boîte englobante du contenu
  par archétype. Le manifeste gagne de quoi distinguer les deux clips.

- [ ] **Étape 2 : l'échelle se dérive du contenu**, pas de la cellule. Le test de relation de la
  tâche 16 doit suivre — et vérifier la **relation**, jamais les valeurs du jour.

- [ ] **Étape 3 : l'arrêt au contact, dans `shared/`**, sur les positions retardées. Test : un
  monstre arrivé à portée cesse d'avancer, et les deux côtés s'arrêtent au même tick.

- [ ] **Étape 4 : l'animation d'attaque** quand le monstre est arrêté, la course sinon.

- [ ] **Étape 5 : vérifier la réplication** — 750,039 / 0,000 / 433,988 px. Ces chiffres vont
  probablement **bouger** : l'arrêt change les trajectoires. C'est légitime — mais le scénario 9
  doit rester à **0,000 px**, sans quoi l'arrêt n'est pas déterministe.

- [ ] **Étape 6 : commit**

```bash
git commit -m "feat: les monstres s'arretent et attaquent au contact"
```

> 📤 **L'atlas régénéré doit être re-téléversé sur MinIO** (`monsters.png`, `monsters.json`) :
> en production l'application les charge de là, et l'ancien atlas n'aura ni les clips d'attaque
> ni les boîtes englobantes.

---

## Tâche 18 : les monstres se téléportent, et finissent dans les murs

Deux symptômes rapportés — « les monstres se téléportent dans tous les sens quand il y a un
gros groupe » et « plein de petits paquets de 1, 2 ou 3 mobs qui ne bougent pas » — reliés par
la mesure.

### Ce que la mesure dit

```
force = 1200 px/s, rayon = 28 px
poussée d'UN voisin en recouvrement total : 40,0 px/tick

déplacements dus à la SEULE séparation, 1500 ticks :
  médiane 9,2 px   p95 32,7 px   p99 45,2 px   MAXIMUM 96,8 px en un tick

horde finale 489 :
  entrées dans un obstacle pendant la séparation : 48
  entités actuellement DANS un obstacle          : 185
  entités immobiles depuis 300+ ticks            : 12, dont 12 dans un obstacle
```

**Les douze immobiles sont les douze dans un mur.** Corrélation totale.

Trois défauts qui s'enchaînent :

1. **Les forces de séparation s'additionnent sans borne.** Un voisin en recouvrement total
   pousse de 40 px par tick ; dix voisins poussent dix fois plus. D'où 96,8 px en un tick —
   2900 px/s, **onze fois la vitesse du joueur**. C'est la téléportation.
2. **Rien n'empêche d'engendrer une vague dans un obstacle.** 185 entités dans les murs pour
   48 franchissements : l'essentiel y est né. `formationPositions` ne consulte pas le masque.
3. **Une cellule bloquée n'a aucune direction**, donc une entité qui s'y trouve — quelle qu'en
   soit la raison — y reste pour toujours.

### Les trois correctifs, et pourquoi les trois

- [ ] **Étape 1 : borner la poussée accumulée**, par entité et par tick. La borne naturelle est
  déjà dans les constantes : **la poussée d'un seul voisin en recouvrement total**,
  `SEPARATION_STRENGTH / TICK_HZ`. Elle se lit « quel que soit l'entassement, on ne pousse
  jamais plus fort qu'une paire collée ». Dérivée, pas choisie au ressenti.

  ⚠️ **Mesurer l'effet sur la densité d'équilibre.** Un essai antérieur de plafonnement, à
  force 120, avait *empiré* le coût (47 voisins au lieu de 37) : brider la poussée empêchait
  l'entassement de se relâcher. À 1200 l'équilibre est atteint et la médiane est à 9 px, donc
  le plafond ne devrait mordre que sur la queue — **mais il faut le vérifier**, pas le
  supposer. Le banc `bench:sep` donne la réponse.

- [ ] **Étape 2 : ne pas faire naître dans un mur.** Dans `shared/`, donc identiquement des deux
  côtés. Un décalage déterministe vers la cellule libre la plus proche, jamais un tirage.

- [ ] **Étape 3 : une cellule bloquée doit offrir une sortie.** C'est le filet, et c'est lui qui
  rend la classe entière impossible : quelle que soit la façon dont une entité arrive dans un
  mur, elle doit pouvoir en sortir. Un second parcours depuis les cellules atteintes vers les
  bloquées, en `O(cellules)` comme le premier.

  Les étapes 1 et 2 suppriment les causes connues ; l'étape 3 fait qu'une cause inconnue, plus
  tard, dégrade au lieu de figer. Faire les trois.

- [ ] **Étape 4 : vérifier.** Aucune entité immobile plus de N ticks hors de la cellule du
  joueur ; aucun déplacement de séparation au-delà du plafond. Et la réplication : le scénario 9
  doit rester à **0,000 px** — les autres chiffres peuvent bouger.

- [ ] **Étape 5 : commit**

```bash
git commit -m "fix(shared): borner la poussee de separation et sortir des murs"
```

---

## Tâche 19 : chaque entité recalcule sa trajectoire par intervalle

**Origine : l'analyse de l'auteur.** « Sur Swarm, les monstres se déplacent par petits à-coups
et pas en même temps » puis « chaque entité recalcule sa trajectoire tous les x secondes ». La
mesure lui donne raison, largement.

### Quatre principes mesurés avant celui-ci

| Principe | Saut max | Voisins | Rejeu ×4 @4000 | Verdict |
| --- | --- | --- | --- | --- |
| Force sommée, plafond 40 px (actuel) | 40,0 px | 8,6 | 4,53 ms | téléporte et vibre |
| Relaxation en position (½ pénétration) | **102,3 px** | — | 5,52 ms | pire : les corrections s'additionnent aussi |
| Relaxation **moyennée** | 5,9 px | **959** | 100 ms | ne sépare plus du tout |
| Répulsion décalée un tick sur 3 | 14,0 px | 17,9 | 2,97 ms | bon, mais moins bon que la suite |

La relaxation moyennée échoue pour une raison qui vaut d'être retenue : **au milieu d'un tas
uniforme, la poussée moyenne est nulle par symétrie.** Seule la *somme* pousse les entités
intérieures vers l'extérieur.

### Ce qui gagne

Chaque entité recalcule sa **vitesse** — direction du champ *plus* répulsion — un tick sur `K`,
sa phase venant de son **identité**. Entre deux recalculs elle **conserve sa vitesse** et se
contente d'avancer.

| | Actuel | **K = 9 (300 ms), plafond 14** |
| --- | --- | --- |
| 1500 — rejeu ×4 | 1,31 ms | **0,21 ms** |
| 4000 — rejeu ×4 | 4,53 ms | **0,74 ms** |
| Saut maximal | 40,0 px | **17,2 px** |
| Voisins @4000 | 8,6 | 11,1 |

**Six fois moins cher**, et l'oscillation disparaît *par construction* : une entité engagée sur
une vitesse ne peut plus renverser sa direction d'un tick à l'autre. Le sprite qui bat
gauche-droite s'éteint sans qu'on ait à le traiter au rendu.

> ⚠️ **Ne pas juger ce choix sur une métrique d'efficacité.** Une entité poussée de côté qui
> tient son cap 300 ms parcourt du chemin sans se rapprocher du joueur — « inefficace » au
> compteur, et parfaitement lisse à l'œil. C'est précisément le petit à-coup recherché.

### Ce que ça coûte, et qu'il faut assumer

- **`vx` et `vy` deviennent de l'état de horde.** Donc deux tableaux de plus dans `HordeState`,
  dans l'anneau de rejeu, et dans la compaction de `#removeAt`. Le test qui vérifie les sept
  tableaux devient un test à neuf — **il doit être étendu, pas contourné** : c'est exactement le
  défaut R13, où trois tableaux sur sept n'étaient pas couverts.
- **Une entité réagit jusqu'à 300 ms en retard.** C'est le prix du procédé, et c'est ce que fait
  le jeu de référence.

- [ ] **Étape 1 : la vitesse rejoint l'état.** `vx`, `vy` dans `Horde`, dans `HordeState`, dans
  `saveState`/`restoreState`, dans `#removeAt`. Étendre le test des sept tableaux à neuf.

- [ ] **Étape 2 : le recalcul par phase.** `entityIdAt(i) % K === tick % K`. Aucune table, aucun
  tirage. Le parcours symétrique `j > i` disparaît : une entité qui recalcule doit voir *tous*
  ses voisins, actifs ou non.

- [ ] **Étape 3 : régler `K` et le plafond ensemble**, jamais séparément, et les publier tous
  deux au banc.

- [ ] **Étape 4 : vérifier.** `bench:sep` avec saut maximal en colonne ; le scénario 9 de la
  réplication doit rester à **0,000 px** — une vitesse conservée qui ne serait pas restaurée au
  rejeu se verrait immédiatement là.

- [ ] **Étape 5 : commit**

```bash
git commit -m "feat(shared): chaque entite recalcule sa trajectoire par intervalle"
```

---

## Tâche 20 : le rattrapage ne suit plus le même modèle de mouvement

**Régression introduite par la tâche 19, et mesurée :**

```
derive due a une apparition tardive, avec rattrapage : 1220,431 px   ← valait 0,000
derive serveur vs client                             : 1220,431 px   ← valait 0,000
```

C'était le livrable de l'étape 2. Le rejeu sur mort tient toujours (scénario 9 à 0,000), mais
le rattrapage à l'apparition est cassé.

### La cause, et elle n'est pas subtile

`spawn` pose `vx = vy = 0`. `spawnCatchingUp` rattrape les ticks manqués en avançant **le long
du champ** (`#advanceAlongField`), alors que la boucle normale avance **selon la vitesse
tenue** (`#advanceByVelocity`).

Avant la tâche 19, les deux chemins suivaient le champ : ils coïncidaient. Depuis, ils
appliquent deux physiques différentes, donc ils divergent **dès le premier tick** — par
structure, pas par approximation.

La tâche 19 avait tranché de laisser le rattrapage « délibérément hors du mécanisme de phase »,
en jugeant le gain nul. **La mesure dit 1220 px.**

### Un corollaire de jeu, à traiter en même temps

Puisque `spawn` pose une vitesse nulle, **un monstre qui apparaît reste immobile jusqu'à
`STEERING_RECOMPUTE_TICKS - 1` ticks** — 300 ms — le temps que sa phase arrive. Ça se voit à
l'écran et ça n'a aucune raison d'être.

- [ ] **Étape 1 : un seul modèle de mouvement.** Le rattrapage doit simuler exactement ce que
  fait la boucle normale — vitesse tenue, recalcul sur phase — et non une approximation le long
  du champ. Supprimer `#advanceAlongField` si plus rien ne l'appelle : un chemin de code qui
  applique une physique que le jeu n'a plus est pire que pas de chemin du tout.

- [ ] **Étape 2 : une entité naît avec sa vitesse.** `spawn` calcule son orientation initiale
  au lieu de la laisser à zéro. Test : une entité fraîchement apparue se déplace dès le tick
  suivant.

- [ ] **Étape 3 : les seuils élargis par la tâche 19 reviennent à leur valeur.** Ils avaient été
  ouverts pour absorber cette régression ; ils doivent se refermer. **Si un test ne repasse pas
  à 0,000 px, c'est le correctif qui est incomplet — pas le seuil qui est trop strict.**

- [ ] **Étape 4 : vérifier.** `apparition tardive avec rattrapage` et `serveur vs client` à
  **0,000 px**, scénario 9 toujours à **0,000 px**, et le banc `bench:sep` pour confirmer que le
  gain de la tâche 19 n'est pas perdu.

- [ ] **Étape 5 : commit**

```bash
git commit -m "fix(shared): un seul modele de mouvement pour le rattrapage"
```

---

## Tâche 21 : dévier, ne pas propulser

**Origine : l'auteur.** « Ils continuent de se pousser dans tous les sens, il faudrait peut-être
juste qu'ils changent légèrement de trajectoire au lieu d'être propulsés ? Comment font-ils dans
les autres jeux ? »

C'est la formulation exacte du comportement de pilotage à la Reynolds, celui qu'emploient les
RTS et les MOBA.

### La différence, en une ligne de code

Aujourd'hui, la répulsion **s'ajoute** à la vitesse :

```
v = direction_du_champ × vitesse_propre  +  poussée × STEERING_REPULSION_STRENGTH
```

Le total peut donc dépasser largement la vitesse du monstre — mesuré à **62-70 px par tick**
pour une vitesse propre de 3,2 px. C'est la propulsion.

Le pilotage mélange les **directions**, puis ramène à la vitesse propre :

```
v = normaliser(direction_du_champ + poussée × poids) × vitesse_propre
```

| | Saut max par tick | Voisins @4000 | Coût @4000 |
| --- | --- | --- | --- |
| Additif (actuel) | 62 à 70 px | 7,0 | 0,15 ms |
| **Pilotage, poids 4** | **3,2 px** | 15,9 | 0,21 ms |

**3,2 px est exactement la vitesse propre du squelette.** La borne cesse d'être une constante à
régler : elle devient **intrinsèque**. Un monstre ne peut plus aller plus vite qu'il ne marche.

### Ce que ça simplifie, et ce que ça coûte

`STEERING_REPULSION_STRENGTH` — une force en px/s qui couplait au coût *et* à la stabilité, et
qui a produit à elle seule les tâches 18, 19 et 20 — disparaît au profit d'un **poids sans
dimension**. Il dit « à quel point j'évite mes voisins » et ne peut structurellement plus
affecter la vitesse.

Contrepartie assumée : les monstres se chevauchent davantage (15,9 voisins contre 7,0). C'est ce
que font les bullet heavens du genre, et c'est le prix de ne jamais être éjecté.

- [ ] **Étape 1 : mélanger les directions, normaliser, multiplier par la vitesse propre.**
  Supprimer `STEERING_REPULSION_STRENGTH` et le plafond de déplacement : tous deux deviennent
  sans objet. Une constante qui nomme un mécanisme absent est pire qu'aucune constante.

  ⚠️ **Cas dégénéré** : si la somme des directions s'annule (`m ≈ 0`), retomber sur la direction
  du champ. Ne jamais normaliser un vecteur nul.

- [ ] **Étape 2 : un test qui verrouille la borne intrinsèque.** Aucune entité ne se déplace de
  plus que sa vitesse propre en un tick, **quelle que soit la densité**. Le monter avec un tas
  volontairement dense — sinon il ne prouve rien. Mutation : revenir à l'addition le fait
  échouer.

- [ ] **Étape 3 : vérifier la réplication.** `apparition tardive avec rattrapage`,
  `serveur vs client`, et le scénario 9 doivent **tous rester à 0,000 px**. Les chiffres « sans
  correction » peuvent bouger.

- [ ] **Étape 4 : commit**

```bash
git commit -m "feat(shared): la repulsion devie la trajectoire au lieu de propulser"
```

---

## Tâche 22 : ils reculent, et ils s'empilent

**Trois retours de l'auteur, une mesure qui les explique ensemble :** « ils s'arrêtent de bouger
un instant », « si je ne bouge plus, plus aucun monstre ne bouge », « quand ils se contournent,
souvent ils reculent au lieu de venir vers moi ».

### Ce que la mesure dit

800 entités dispersées autour du joueur, 10 s :

| Poids de répulsion | Approche | Reculent | Distance finale |
| --- | --- | --- | --- |
| **4** (actuel) | 41 % de la vitesse propre | **289 / 800** | **209 px — ils n'arrivent jamais** |
| 1 | 56 % | 223 | 62 px |
| **0,5** | 58 % | 155 | 42 px |

À poids 4 la répulsion domine le champ **4 contre 1** : le monstre privilégie l'évitement de ses
voisins sur le fait de rejoindre le joueur. **36 % de la horde s'éloigne à tout instant**, et
elle se stabilise à 209 px sans jamais arriver.

Et « plus rien ne bouge » n'est pas un blocage : à poids 0,5, **462 monstres sur 800 se
retrouvent à moins de 34 px du joueur** — donc arrêtés par la règle de contact, en train
d'attaquer. Sauf que 462 corps dans un disque de 34 px font 8 px² chacun : ils sont empilés au
même point. **Le pilotage dévie mais ne résout jamais un chevauchement.**

### Une piste écartée par la mesure

Propager l'arrêt de proche en proche — s'arrêter si un voisin arrêté nous touche — pour former
un mur. Résultat : **les 800 s'arrêtent**, à 300 px de rayon médian. L'arrêt se propage à
travers toute la horde et fige tout le monde, y compris très loin du joueur. Ne pas y revenir.

### Ce qui marche

Pilotage pour la direction, **plus** une correction de position **bornée** pour défaire les
chevauchements — la combinaison qu'emploient les jeux du genre.

| Poids / correction | Saut max | Dans 34 px | Rayon médian | Reculent |
| --- | --- | --- | --- | --- |
| 4 / — (actuel) | 3,2 px | 66 | 209 px | 289 |
| 0,5 / — | 3,2 px | **462 empilés** | 33 px | 155 |
| **0,5 / 4 px** | **7,2 px** | **51** | **116 px** | **23** |

Les monstres forment un **anneau** autour du joueur au lieu d'un tas, et les fuyards tombent de
155 à 23. Le déplacement maximal reste 7,2 px — la vitesse propre plus la borne de correction.
Toujours aucune propulsion.

- [ ] **Étape 1 : `STEERING_REPULSION_WEIGHT` passe de 4 à 0,5.** Le champ doit dominer la
  répulsion, pas l'inverse : un monstre dévie pour éviter ses voisins, il ne renonce pas à sa
  cible.

- [ ] **Étape 2 : une correction de position bornée**, accumulée puis appliquée **en bloc**
  comme le reste (sinon le résultat dépend de l'ordre du tableau, et deux clients compactent
  différemment). Bornée à 4 px par entité et par tick — la borne est ce qui interdit la
  propulsion, elle n'est pas négociable.

  ⚠️ Elle s'applique **à chaque tick**, pas seulement au recalcul de trajectoire : un
  chevauchement est un fait géométrique du présent, pas une décision tenue 300 ms.

- [ ] **Étape 3 : deux tests.** Le déplacement total d'une entité ne dépasse jamais sa vitesse
  propre plus la borne, à n'importe quelle densité. Et une horde lâchée sur un joueur immobile
  forme un anneau : moins de N entités dans le rayon de contact après 10 s, là où l'empilement
  en mettait 462.

- [ ] **Étape 4 : la réplication.** `apparition tardive avec rattrapage`, `serveur vs client` et
  le scénario 9 doivent **tous rester à 0,000 px**.

- [ ] **Étape 5 : commit**

```bash
git commit -m "fix(shared): la horde forme un anneau au lieu de s'empiler"
```

---

## Tâche 23 : celui de derrière cède

**Origine : l'auteur, troisième observation juste d'affilée.** « Quand deux monstres vont se
chevaucher, celui derrière dévie légèrement vers l'extérieur, j'ai l'impression. »

C'est l'évitement **par priorité**, et il bat la répulsion symétrique sur tous les axes.

| | Symétrique (tâche 22) | **Priorité** |
| --- | --- | --- |
| Empilés dans 34 px | 51 | **16** |
| Reculent | 23 | **12** |
| Rayon médian | 116 px | **189 px** |
| Coût | 0,31 ms | **0,23 ms** |
| Saut max | 7,2 px | 7,2 px |

Moins cher, parce qu'**un seul des deux** calcule sa correction. Et moitié moins de fuyards,
parce que le rang de devant n'encaisse plus rien : ce n'est plus une question de réglage, c'est
structurellement impossible.

> **Ce que ça dit sur la démarche.** Quatre principes de répulsion ont été mesurés avant
> celui-ci — force sommée, relaxation, relaxation moyennée, correction bornée — et tous
> cherchaient la bonne **loi de force**. Le problème n'en était pas une : c'était une question
> de **priorité**. Aucune valeur de constante ne pouvait y répondre.

### Qui est devant ?

Le champ de flux le sait déjà : `dist` est la distance au joueur en cellules. Le plus grand
`dist` est derrière, donc il cède. Égalité départagée par le plus petit identifiant — comme
l'ordre des morts et le départage de l'auto-visée.

**Rien à ajouter à l'état, rien sur le fil.**

- [ ] **Étape 1 : la priorité, dans le pilotage et dans le dé-chevauchement.** Une entité
  n'accumule une correction que contre les voisins dont elle est **derrière**. Celui de derrière
  encaisse tout l'écart, pas la moitié.

- [ ] **Étape 2 : le parcours symétrique `j > i` disparaît définitivement.** La relation n'est
  plus symétrique : chaque entité doit voir tous ses voisins pour savoir desquels elle est
  derrière.

- [ ] **Étape 3 : trois tests.** Deux entités qui se chevauchent — seule celle de derrière
  bouge, celle de devant ne bouge **pas d'un pixel**. Le départage à égalité de rang tient sur
  l'identifiant, quel que soit l'ordre du tableau. Et le déplacement total reste borné par la
  vitesse propre plus la correction.

- [ ] **Étape 4 : la réplication.** `apparition tardive avec rattrapage`, `serveur vs client` et
  le scénario 9 à **0,000 px**.

- [ ] **Étape 5 : commit**

```bash
git commit -m "feat(shared): l'evitement se decide par priorite, celui de derriere cede"
```

---

## Tâche 24 : le gel de niveau ne gèle pas le joueur, côté client

**Symptôme rapporté :** « il y a parfois de mini freezes de tous les monstres uniquement — plus
personne ne se déplace — pendant 1 s ».

**Ce n'est pas un bug aléatoire : c'est le gel de montée de niveau**, incomplet côté client.

`Room.step` retourne tôt pendant le gel (`back/src/room.ts:360`), donc le serveur fige
**tout**, joueur compris. Mais `GameClient` prédit le déplacement local **sans condition**
(`front/src/net/client.ts:466`, `this.#local?.predict(...)`). Pendant les deux secondes de gel,
les monstres s'arrêtent — correctement — pendant que le personnage continue d'avancer en local,
puis se fait remettre en place par le snapshot suivant.

Le joueur voit donc « les monstres se figent » et un retour élastique de son propre personnage.

- [ ] **Étape 1 : la prédiction locale honore le gel.** Elle doit appliquer le même facteur que
  `Room#movementScale` — zéro pendant le gel strict, rampe pendant la reprise. Le client connaît
  déjà `#freezeUntilTick` et `#resumeEndTick` : ils servent déjà à la horde, ligne 715.

- [ ] **Étape 2 : le gel doit se voir.** Deux secondes où plus rien ne bouge, sans explication à
  l'écran, se lisent comme un plantage. Le §7 de l'orientation prévoit l'étalage de cartes à
  l'étape 4 ; d'ici là, une indication minimale suffit — mais il en faut une.

- [ ] **Étape 3 : test.** Une entrée de déplacement envoyée pendant le gel ne déplace pas le
  joueur prédit ; la même entrée après la reprise le déplace. Les deux moitiés, sinon un gel
  permanent passerait.

- [ ] **Étape 4 : commit**

```bash
git commit -m "fix(front): la prediction locale honore le gel de niveau"
```

---

## Piste écartée : l'évitement latéral

L'auteur décrivait « dévie légèrement vers l'extérieur ». J'en ai déduit qu'il fallait ne garder
que la composante **perpendiculaire** au cap — contourner sans jamais reculer. **Mesuré, c'est
franchement pire :**

| | Actuel | Latéral seul |
| --- | --- | --- |
| Reculent | 7 / 800 | **185** |
| Empilés dans 34 px | 19 | **243** |
| Rayon médian | 160 px | 54 px |

En supprimant la composante arrière, l'évitement ne peut plus **extraire** une entité d'un tas.
Elles s'empilent, et le pilotage se dégrade ensuite. Ne pas y revenir sans une idée neuve.

## Reste ouvert : les groupes bloqués

Mesuré : **314 entités sur 800 n'approchent pas de 20 px en dix secondes.** Le symptôme est
réel et massif.

Mais la métrique confond deux populations : celles qui sont arrivées à l'anneau et y stationnent
légitimement, et celles qui sont réellement coincées. **Tant qu'on ne sait pas les séparer, on
ne peut pas proposer de correctif** — on réglerait à l'aveugle sur un chiffre qui mélange un
comportement voulu et un défaut.

Prochaine étape sur ce point : une métrique qui distingue « stationne près du joueur » de
« oscille loin de lui sans progresser ».

---

## Tâche 25 : le champ de flux est discret, et c'est lui qui fait osciller

**Origine : l'auteur.** « Il y a encore des mobs isolés qui oscillent sur place sur de petites
distances, et certains dans la masse qui font demi-tour sans collision ni raison apparente. »

**« Isolé » est le mot qui tranche.** Un monstre sans voisin ne subit aucune répulsion : ni le
poids, ni la priorité, ni le dé-chevauchement ne peuvent l'expliquer. Il ne reste que le champ.

### Mesuré, un monstre seul, aucun voisin

| | Demi-tours / 400 trajets | Oscillants | N'arrivent jamais |
| --- | --- | --- | --- |
| **Actuel** — une direction par cellule | **1282** | 53 | 15 |
| **Bilinéaire** — direction interpolée | **165** | 28 | 1 |

Une seule direction par cellule de 64 px : franchir une frontière peut retourner la direction
de 180°. Avec une vitesse tenue `STEERING_RECOMPUTE_TICKS`, le monstre dépasse, recalcule dans
la cellule voisine, et repart en arrière. Va-et-vient.

C'est la cause racine que l'étape 2 avait **déjà nommée** — « le flowfield étant un champ de
directions discret, les trajectoires sont sensibles aux conditions initiales » — sans jamais la
traiter : elle avait été contournée par le rattrapage à l'apparition.

Interpoler la lit comme un champ continu, et la sensibilité s'effondre avec.

- [ ] **Étape 1 : échantillonnage bilinéaire de la direction.** Les quatre cellules entourant la
  position, pondérées par la distance, puis renormalisées.

  ⚠️ **Les cellules bloquées ne doivent pas entrer dans le mélange.** Leur direction vaut
  `(0, 0)` : les inclure tirerait la direction *vers* le mur au lieu de le longer. Les exclure
  et renormaliser les poids restants. Si les quatre sont bloquées, retomber sur la lecture par
  cellule.

- [ ] **Étape 2 : le coût.** Quatre lectures au lieu d'une, mais **seulement au recalcul de
  trajectoire** — une entité sur `STEERING_RECOMPUTE_TICKS`. Confirmer au banc que ça ne se voit
  pas ; si ça se voit, le dire.

- [ ] **Étape 3 : la réplication.** L'interpolation change les trajectoires, donc les chiffres
  « sans correction » bougeront. **`apparition tardive avec rattrapage`, `serveur vs client` et
  le scénario 9 doivent rester à 0,000 px.**

  Elle devrait même *aider* : une position légèrement différente donnait une direction
  radicalement différente, elle donnera désormais une direction légèrement différente. C'est
  toute la sensibilité aux conditions initiales qui baisse.

- [ ] **Étape 4 : un test qui verrouille la propriété.** Deux positions distantes d'un pixel de
  part et d'autre d'une frontière de cellule donnent des directions **proches**, là où la
  lecture par cellule pouvait les donner opposées. Mutation : revenir à la lecture par cellule
  le fait échouer.

- [ ] **Étape 5 : commit**

```bash
git commit -m "feat(shared): lire le champ de flux par interpolation"
```

