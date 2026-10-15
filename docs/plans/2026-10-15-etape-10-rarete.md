# Étape 10 — la rareté, et des passifs qui s'empilent : plan d'implémentation

> **Pour les agents :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou
> superpowers:executing-plans, tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**But :** une carte de l'étalage peut sortir rare ou légendaire et vaut alors deux ou trois cartes ;
quatre passifs empilables (Précision, Férocité, Volée, Ampleur) et trois passifs exclusivement
légendaires (Écho, Moisson, Colosse) font monter le build vers le démesuré.

**Architecture :** la rareté est un octet de plus **par carte de `DRAFT_OPEN`** (jamais par tick) ;
`applyCardToLoadout`, déjà partagée par `Room#grantCard` et le miroir client, applique la carte
autant de fois que son multiplicateur, donc les deux côtés suivent sans code de plus. Volée,
Ampleur, Colosse, Précision et Férocité passent par un nouveau module partagé `shared/firing.ts`
(crans d'arme + crans des passifs, formule de dégâts, critique du tireur) que `Room#fireOne` et
`GameClient#fireOne` appellent tous deux. Écho et Moisson ne vivent que côté serveur (`combat.ts`,
`Room.step`), sur des PV que le serveur arbitre seul.

**Pile :** TypeScript, `ws`, Fastify, Pixi.js v8, Vitest (jsdom côté front), Biome, Prisma/Postgres
pour les tests d'intégration.

**Spec :** [`docs/specs/2026-10-15-etape-10-rarete.md`](../specs/2026-10-15-etape-10-rarete.md)

**Où l'on travaille :** dans un worktree, `main` reçoit des modifications en direct.

```bash
git worktree add ../Tarnok-rarete -b etape-10-rarete
cd ../Tarnok-rarete && npm install
```

Tous les chemins de ce plan sont relatifs à la racine du worktree (`../Tarnok-rarete`).

## Contraintes globales

- Raretés : `RARITY = { COMMUNE: 0, RARE: 1, LEGENDAIRE: 2 }` — commune / rare / légendaire =
  index **0 / 1 / 2**, multiplicateurs **×1 / ×2 / ×3** (`RARITY_MULTIPLIERS = [1, 2, 3]`),
  probabilités **82 / 15 / 3** en constante nommée `RARITY_WEIGHTS = [82, 15, 3]`, dans
  `shared/rarity.ts`. `Card` gagne `rarity?: number` (absent : commune).
- **Une rare vaut deux cartes, et rien de plus** : `applyCardToLoadout` applique ×n ; une arme non
  possédée = acquisition (un seul emplacement) + (n − 1) crans de **son** aspect (`card.upgrade`).
  `canTake` reste la seule règle d'éligibilité, testée sur la première application.
- `DRAFT_CARD_BYTES` passe de **3 à 4** (`nature u8 · refId u8 · upgrade u8 · rarity u8`).
  `DRAFT_OPEN` à deux joueurs : 6 + 5 × 4 = **26** (au lieu de 21). **Zéro octet de plus par
  tick** : `SNAPSHOT` n'est pas touché.
- **Précision** : +0,04 de chance de critique par carte, chance totale `CRIT_CHANCE + 0,04 × n`
  **bornée à 1**. **Férocité** : +0,3 au multiplicateur critique par carte
  (`CRIT_MULTIPLIER + 0,3 × n`), sans plafond, emporté **par projectile**.
- **Volée** : +1 cran de `UPGRADE.SALVO` par carte sur chaque arme de genre `'tir'`, et sur elles
  seules. **Ampleur** : +1 cran de `UPGRADE.ZONE` par carte sur **toutes** les armes.
- Passifs **exclusivement légendaires** (`legendary: true`) : **Écho** (+100 % de dégâts
  instantanés, par carte, aux réactions **déclenchées par le porteur**, `ReactionTrigger.by`),
  **Moisson** (1 PV par ennemi mort à **moins de 300 px**, jamais au-delà du PV max),
  **Colosse** (+1 % de dégâts par tranche de **10** PV max). Appliqués **×1** quelle que soit la
  rareté, ils prennent un emplacement de passif normal (`PASSIVE_SLOTS = 3`) et ne sont tirés
  **que** pour un emplacement qui a tiré légendaire.
- Aucun plafond aux empilements hors Précision ; aucune arme rare ; pas de plancher de rareté
  (étapes 11 et 12).
- Commentaires de code en français **sans accents** ; messages de commit conventionnels en
  français sans accents (`feat(shared): ...`, `test(back): ...`, `docs: ...`).
- **Discipline des sous-agents** : un sous-agent ne lance **que les fichiers de test de sa
  tâche** (`npx vitest run <fichier>`), jamais `npm test`, jamais un banc. Le portique complet est
  lancé par le contrôleur, **seul**, à la tâche 11.
- Commandes de test : tests de `shared/` depuis `back/` (`cd back && npx vitest run
  ../shared/<fichier>`), tests du front depuis `front/` (`cd front && npx vitest run src/...`),
  tests du back depuis `back/`. Les tests `*.integration.test.ts` exigent le Postgres local (il
  tourne déjà ; `setup-db.ts` retombe sur l'URL locale sans `.env`).
- Avant chaque commit : `npx biome check --write <fichiers de la tâche>` (le code du plan n'est pas
  garanti au format Biome ; le hook de commit le refuserait).
- Jamais `pkill -f` : les serveurs de dev de Léo tournent sur 5173 et 3100.

**Écart assumé n° 1 — l'ordre du tirage (§2.3).** La spec dit d'abord « tire la rareté de chaque
carte *après l'avoir choisie* », puis « on tire d'abord la rareté de l'emplacement, puis la carte
parmi le pool qui lui est permis ». Les deux phrases se contredisent ; seule la seconde permet le
pool réservé aux légendaires. Le plan suit la seconde : rareté, puis carte, puis aspect, tous du
même `rng`.

**Écart assumé n° 2 — Moisson ne se branche pas sur « le drain des morts ».** Au moment où
`Room.step` assemble `allDead`, les ennemis sont déjà compactés hors de la horde : leurs positions
sont perdues. Le seul goulot qui voit **chaque** mort **avec sa position** est `OrbField.spawn`
(appelé juste avant chacun des huit `horde.kill` de `combat.ts`). Il note donc la position, et
`Room.step` la vide à chaque tick. Les bornes 299/301 px se testent sur la fonction pure
`resolveHarvest` (`combat.test.ts`) ; le câblage du salon, sur un écart de PV entre deux salons
identiques (`room.test.ts`).

**Écart assumé n° 3 — le critique du client tirait avec `by = 0`.** `front/src/net/client.ts`
l.~3065 appelle `fireSalvoDirected(weapon, tick, x, y, aimX, aimY, damage, count)` **sans** le
tireur : `hashRoll(tick, 0, i)` côté client contre `hashRoll(tick, p.id, i)` côté serveur. Le
critique affiché n'était donc pas celui arbitré, contrairement à ce que la spec §3.2 et
`Projectiles.critAt` affirment. La tâche 6 passe `playerId` — c'est le prérequis de « le critique
est tiré des deux côtés ». (`ownerAt` côté client ne sert qu'à `#markLocally`, dont `by` n'est
relu nulle part : aucun autre effet.)

**Écart assumé n° 4 — Colosse chez les alliés, côté client.** Le client calcule le PV max d'un
joueur comme `PLAYER_MAX_HP + loadout.bonus('maxHp') + this.accountBonuses.maxHp` : les bonus de
compte sont ceux du joueur **local**, appliqués à tous — exactement l'approximation que le miroir
fait déjà pour les dégâts et la cadence (`client.ts` l.~2977, l.~2992). Cosmétique (§5.4).

**Écart assumé n° 5 — `BonusKind` se détache de `PassiveKind`.** `shared/shop.ts` l.12 définit
`BonusKind = PassiveKind | ...` : sept genres de passifs de plus feraient entrer sept clés à zéro
dans `BONUS_ZERO` et dans chaque compte. La boutique ne vend que cinq genres : `BonusKind` devient
`Extract<PassiveKind, 'fireRate' | 'damage' | 'maxHp' | 'speed' | 'regen'> | ...`, et les icônes
sont indexées par `BonusKind | PassiveKind`.

**Écart assumé n° 6 — `shared/firing.ts`, pas `weapons.ts`.** La formule de dégâts et le critique
lisent un `Loadout`, et `loadout.ts` importe déjà `weapons.ts` : y mettre ces fonctions ferait un
cycle.

**Écart assumé n° 7 — le livrable force la rareté par `vi.mock`.** Aucun crochet de production :
`back/src/rarete.integration.test.ts` remplace `rollRarity` du module `@shared/rarity` (Vitest
moque par chemin résolu, donc aussi l'import relatif `./rarity` de `cards.ts`) et vérifie que la
rareté forcée arrive bien sur le fil. « Le miroir décodé par le client » y est reconstitué comme
`GameClient#applyDraftOutcomes` le fait (cartes du `DRAFT_OPEN` décodé, issues du `DRAFT_RESULT`
décodé, `applyCardToLoadout`) ; le `GameClient` lui-même est couvert par `client.test.ts`
(tâche 2).

## Points de vigilance de la revue

1. **Un octet de rareté hors table venu du fil** (3, 200…) : la carte se lit **commune**, ×1, au
   miroir comme à l'écran — jamais `undefined` ni `NaN` → tests tâche 1 (`multiplierOf`), tâche 2
   (le décodeur passe l'octet tel quel), tâche 9 (`data-rarity="0"`).
2. **Une arme rare NOUVELLE sur un arsenal plein** : la première application lève, et
   l'inventaire reste **intact** (aucune application partielle) → test tâche 1.
3. **Un passif exclusivement légendaire qui arrive avec une rareté ≠ 2** (le fil le permet) : il
   s'applique ×1 quand même, et l'écran ne promet pas « ×2 » → tests tâche 3 et tâche 9.
4. **Moisson sur un joueur à terre, et plusieurs morts au même tick** : un mort ne se relève pas ;
   les morts d'un tick s'additionnent mais s'arrêtent au PV max → tests tâche 8.
5. **Précision au-delà de 100 %** : la chance s'arrête à 1 (toute la salve critique), Férocité
   continue d'empiler → tests tâche 6 (`critOf` dans `firing.test.ts`, puis les projectiles).

---

## Carte des fichiers

| Fichier | Rôle |
| --- | --- |
| `shared/rarity.ts` (créé), `shared/rarity.test.ts` (créé) | `RARITY`, poids, multiplicateurs, `rollRarity`, `normalizeRarity`, `multiplierOf` |
| `shared/cards.ts`, `shared/cards.test.ts` | `Card.rarity`, `isLegendaryOnly`, `applicationsOf`, `applyCardToLoadout` ×n, `drawSpread` tire la rareté |
| `shared/passives.ts`, `shared/passives.test.ts` | `Passive.legendary`, sept genres, sept passifs |
| `shared/constants.ts` | `HARVEST_RADIUS = 300`, `COLOSSUS_HP_STEP = 10` |
| `shared/shop.ts` | `BonusKind` détaché des nouveaux genres |
| `shared/protocol.ts`, `shared/protocol.test.ts` | `WireCard.rarity`, `DRAFT_CARD_BYTES = 4` |
| `shared/firing.ts` (créé), `shared/firing.test.ts` (créé) | `weaponUpgrades`, `armedWeapon`, `shotDamage`, `critOf` |
| `shared/projectiles.ts`, `shared/projectiles.test.ts` | `Crit`, `BASE_CRIT`, multiplicateur critique par projectile, `critFactorAt` |
| `back/src/combat.ts`, `back/src/combat.test.ts` | lecteurs du critique, Écho dans `applyReactions`, `OrbField.drainFallen`, `resolveHarvest` |
| `back/src/room.ts`, `back/src/room.test.ts` | `#fireOne` sur `firing.ts`, câblage Écho et Moisson, `DraftOpenEvent.cards: Card[]` |
| `back/src/draft.integration.test.ts`, `back/src/boutique.integration.test.ts` | assertions qui supposaient ×1 et 21 octets |
| `back/src/rarete.integration.test.ts` (créé) | **le livrable** |
| `front/src/net/client.ts`, `front/src/net/client.test.ts` | miroir de tir sur `firing.ts`, tireur passé, lecteur du critique |
| `front/src/ui/draft.ts`, `front/src/ui/draft.test.ts` | unités des nouveaux passifs, bordure et étiquette de rareté |
| `front/src/ui/icons.ts` | icônes des nouveaux genres |
| `front/src/styles/main.css` | gris, bleu, or, reflet légendaire |
| `docs/plans/2026-10-15-etape-10-resultats.md` (créé), `README.md` | le bilan |

---

### Tâche 1 : le modèle de rareté, et une carte rare qui vaut deux cartes

**Fichiers :**
- Créer : `shared/rarity.ts`, `shared/rarity.test.ts`
- Modifier : `shared/cards.ts` (imports l.1-4, `Card` l.~26-35, `applyCardToLoadout` l.~55-66), `shared/passives.ts` (`Passive` l.~36-42)
- Tester : `shared/cards.test.ts`, `back/src/room.test.ts` (nouveau `describe` en fin de fichier)

**Interfaces :**
- Produit : `RARITY = { COMMUNE: 0, RARE: 1, LEGENDAIRE: 2 } as const`,
  `RARITY_MULTIPLIERS: readonly number[]`, `RARITY_WEIGHTS: readonly number[]`,
  `normalizeRarity(rarity: number | undefined): number`,
  `multiplierOf(rarity: number | undefined): number`, `rollRarity(rng: () => number): number` ;
  `Card.rarity?: number` ; `isLegendaryOnly(card: Card): boolean` ;
  `applicationsOf(card: Card): number` ; `Passive.legendary?: boolean`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`shared/rarity.test.ts` :

```ts
import { describe, expect, it } from 'vitest';

import { makeRandom } from './random';
import {
  multiplierOf,
  normalizeRarity,
  RARITY,
  RARITY_MULTIPLIERS,
  RARITY_WEIGHTS,
  rollRarity,
} from './rarity';

describe('etape 10 : la rarete', () => {
  it('trois raretes, dans l ordre du fil, x1 x2 x3, a 82 / 15 / 3', () => {
    expect(RARITY).toEqual({ COMMUNE: 0, RARE: 1, LEGENDAIRE: 2 });
    expect(RARITY_MULTIPLIERS).toEqual([1, 2, 3]);
    expect(RARITY_WEIGHTS).toEqual([82, 15, 3]);
  });

  it('sur un rng scripte, chaque rarete sort', () => {
    expect(rollRarity(() => 0)).toBe(RARITY.COMMUNE);
    expect(rollRarity(() => 0.5)).toBe(RARITY.COMMUNE);
    expect(rollRarity(() => 0.9)).toBe(RARITY.RARE);
    expect(rollRarity(() => 0.99)).toBe(RARITY.LEGENDAIRE);
    expect(rollRarity(() => 0.999_999)).toBe(RARITY.LEGENDAIRE);
  });

  it('suit les poids sur un grand nombre de tirages', () => {
    const rng = makeRandom(0x10_0a_0001);
    const vus = [0, 0, 0];
    const N = 50_000;
    for (let i = 0; i < N; i++) {
      const r = rollRarity(rng);
      vus[r] = (vus[r] ?? 0) + 1;
    }
    expect((vus[0] ?? 0) / N).toBeCloseTo(0.82, 1);
    expect((vus[1] ?? 0) / N).toBeCloseTo(0.15, 1);
    expect((vus[2] ?? 0) / N).toBeGreaterThan(0.02);
    expect((vus[2] ?? 0) / N).toBeLessThan(0.04);
  });

  it('une rarete absente ou hors table se lit commune, x1', () => {
    expect(normalizeRarity(undefined)).toBe(RARITY.COMMUNE);
    expect(normalizeRarity(3)).toBe(RARITY.COMMUNE);
    expect(normalizeRarity(200)).toBe(RARITY.COMMUNE);
    expect(normalizeRarity(-1)).toBe(RARITY.COMMUNE);
    expect(normalizeRarity(RARITY.RARE)).toBe(RARITY.RARE);
    expect(multiplierOf(undefined)).toBe(1);
    expect(multiplierOf(200)).toBe(1);
    expect(multiplierOf(RARITY.RARE)).toBe(2);
    expect(multiplierOf(RARITY.LEGENDAIRE)).toBe(3);
  });
});
```

Ajouter à `shared/cards.test.ts` (importer `applicationsOf`, `applyCardToLoadout` depuis
`./cards`, `RARITY` depuis `./rarity`, et `type Card`) :

```ts
describe('etape 10 : une carte rare vaut deux cartes, et rien de plus', () => {
  const ARME = WEAPONS[3]; // lance-flammes
  if (!ARME) {
    throw new Error('fixture : arme absente');
  }
  const ASPECT = upgradesFor(ARME)[1] ?? -1; // la cadence, toujours proposee

  it('un passif rare donne 2 exemplaires, un legendaire 3, une commune 1', () => {
    for (const [rarity, attendu] of [
      [undefined, 1],
      [RARITY.COMMUNE, 1],
      [RARITY.RARE, 2],
      [RARITY.LEGENDAIRE, 3],
    ] as const) {
      const l = new Loadout();
      applyCardToLoadout(l, { nature: CARD.PASSIVE, refId: 1, rarity });
      expect(l.stacksOf(1)).toBe(attendu);
      // Un seul emplacement, quelle que soit la rarete.
      expect(l.passiveSlotsUsed).toBe(1);
    }
  });

  it('une arme rare NON possedee : l acquisition, plus un cran de SON aspect', () => {
    const l = new Loadout();
    applyCardToLoadout(l, { nature: CARD.WEAPON, refId: ARME.id, upgrade: ASPECT, rarity: RARITY.RARE });
    expect(l.stacksOfWeapon(ARME.id)).toBe(2);
    expect(l.upgradesOf(ARME.id, ASPECT)).toBe(1);
    expect(l.weaponSlotsUsed).toBe(1);
  });

  it('une arme legendaire DEJA possedee : trois crans de son aspect', () => {
    const l = new Loadout();
    l.addWeapon(ARME.id);
    applyCardToLoadout(l, {
      nature: CARD.WEAPON,
      refId: ARME.id,
      upgrade: ASPECT,
      rarity: RARITY.LEGENDAIRE,
    });
    expect(l.stacksOfWeapon(ARME.id)).toBe(4);
    expect(l.upgradesOf(ARME.id, ASPECT)).toBe(3);
  });

  it('une rarete hors table venue du fil s applique une fois', () => {
    const l = new Loadout();
    applyCardToLoadout(l, { nature: CARD.PASSIVE, refId: 1, rarity: 200 });
    expect(l.stacksOf(1)).toBe(1);
  });

  it('canTake se juge sur la PREMIERE application : un arsenal plein leve, et rien n est applique', () => {
    const l = new Loadout();
    for (let i = 0; i < WEAPON_SLOTS; i++) {
      l.addWeapon(i + 1);
    }
    const nouvelle: Card = { nature: CARD.WEAPON, refId: WEAPON_SLOTS + 1, rarity: RARITY.RARE };
    expect(() => applyCardToLoadout(l, nouvelle)).toThrow(/pleins/);
    expect(l.stacksOfWeapon(WEAPON_SLOTS + 1)).toBe(0);
    expect(l.weaponSlotsUsed).toBe(WEAPON_SLOTS);
  });

  it('applicationsOf dit combien de fois la carte s applique', () => {
    expect(applicationsOf({ nature: CARD.PASSIVE, refId: 1 })).toBe(1);
    expect(applicationsOf({ nature: CARD.WEAPON, refId: 2, rarity: RARITY.RARE })).toBe(2);
    expect(applicationsOf({ nature: CARD.PASSIVE, refId: 1, rarity: RARITY.LEGENDAIRE })).toBe(3);
  });
});
```

Ajouter à la fin de `back/src/room.test.ts` (importer `RARITY` depuis `@shared/rarity`) :

```ts
describe('etape 10 : la rarete multiplie la carte, soin de vitalite compris', () => {
  const VITALITE = PASSIVES.find((p) => p.kind === 'maxHp')?.id ?? -1;
  const PAR_CARTE = passiveOf(VITALITE).magnitude;

  it.each([
    [RARITY.RARE, 2],
    [RARITY.LEGENDAIRE, 3],
  ] as const)('une vitalite de rarete %i releve le plafond de %i cartes, et soigne d autant', (rarity, fois) => {
    const room = new Room(0x10_0a_0101);
    room.join(1);
    room.grantCard(1, { nature: CARD.PASSIVE, refId: VITALITE, rarity });
    expect(room.loadoutOf(1)?.stacksOf(VITALITE)).toBe(fois);
    expect(room.maxHpOf(1)).toBe(PLAYER_MAX_HP + fois * PAR_CARTE);
    // Le soin suit : `grantCard` lit l'ecart de PV max avant/apres.
    expect(hpOf(room, 1)).toBe(PLAYER_MAX_HP + fois * PAR_CARTE);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run ../shared/rarity.test.ts ../shared/cards.test.ts src/room.test.ts -t "rarete|rare vaut"`
Attendu : ÉCHEC, `./rarity` introuvable, `applicationsOf` non exporté, `stacksOf` vaut 1 au lieu de 2.

- [ ] **Étape 3 : implémenter**

`shared/rarity.ts` :

```ts
/**
 * La rarete d'une carte de l'etalage (etape 10, §2 de la spec).
 *
 * Une carte rare vaut DEUX cartes, une legendaire TROIS — et rien de plus :
 * aucune regle d'empilement nouvelle, `applyCardToLoadout` applique la carte
 * autant de fois que son multiplicateur. L'index EST l'identifiant, et c'est
 * l'octet du fil (`DRAFT_CARD_BYTES`).
 */
export const RARITY = {
  COMMUNE: 0,
  RARE: 1,
  LEGENDAIRE: 2,
} as const;

/** Combien de fois une carte s'applique, par rarete. */
export const RARITY_MULTIPLIERS: readonly number[] = [1, 2, 3];

/**
 * Le poids de chaque rarete au tirage, en pourcents (82 / 15 / 3).
 *
 * ⚠️ **Un reglage de playtest, pas un invariant** : les legendaires doivent
 * etre assez rares pour faire evenement, assez frequentes pour etre vues.
 */
export const RARITY_WEIGHTS: readonly number[] = [82, 15, 3];

/**
 * Ramene une rarete lue sur le fil dans la table : absente ou inconnue, la
 * carte est commune. Un octet ne peut pas mentir plus loin que ca.
 */
export function normalizeRarity(rarity: number | undefined): number {
  const r = rarity ?? RARITY.COMMUNE;
  return RARITY_MULTIPLIERS[r] === undefined ? RARITY.COMMUNE : r;
}

/** Le multiplicateur d'une rarete, `1` pour tout ce qui n'est pas dans la table. */
export function multiplierOf(rarity: number | undefined): number {
  return RARITY_MULTIPLIERS[normalizeRarity(rarity)] ?? 1;
}

/**
 * Tire une rarete selon `RARITY_WEIGHTS`. `rng` est injecte, comme pour
 * `drawSpread` : `shared/` n'appelle jamais `Math.random`.
 */
export function rollRarity(rng: () => number): number {
  const total = RARITY_WEIGHTS.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let r = 0; r < RARITY_WEIGHTS.length; r++) {
    roll -= RARITY_WEIGHTS[r] ?? 0;
    if (roll < 0) {
      return r;
    }
  }
  return RARITY_WEIGHTS.length - 1;
}
```

Dans `shared/passives.ts`, l'interface `Passive` gagne (après `kind`) :

```ts
  /**
   * Exclusivement legendaire (etape 10, §4) : ne sort au tirage que sur un
   * emplacement legendaire, et s'applique x1 — son effet est deja une regle.
   */
  legendary?: boolean;
```

Dans `shared/cards.ts` :

1. Imports : `import { PASSIVES, passiveOf } from './passives';` et
   `import { multiplierOf } from './rarity';`.
2. `Card` gagne, après `upgrade` :

```ts
  /**
   * La rarete tiree pour cette carte (`RARITY`, etape 10) : elle s'applique
   * autant de fois que son multiplicateur. Absente : commune.
   */
  rarity?: number;
```

3. Avant `applyCardToLoadout` :

```ts
/** Un passif exclusivement legendaire (etape 10, §4) — jamais une arme. */
export function isLegendaryOnly(card: Card): boolean {
  return card.nature === CARD.PASSIVE && passiveOf(card.refId).legendary === true;
}

/**
 * Combien de fois cette carte s'applique : le multiplicateur de sa rarete,
 * sauf un passif exclusivement legendaire, qui s'applique x1 — le triple d'une
 * regle serait du decor (§4 de la spec de l'etape 10).
 */
export function applicationsOf(card: Card): number {
  return isLegendaryOnly(card) ? 1 : multiplierOf(card.rarity);
}
```

4. Le corps de `applyCardToLoadout` devient (garder le docbloc, y ajouter le paragraphe) :

```ts
 * ⚠️ **Une carte rare vaut deux cartes, et rien de plus** (etape 10) : elle
 * s'applique `applicationsOf(card)` fois. Pour une arme non possedee, la
 * premiere application est l'acquisition, les suivantes ameliorent le MEME
 * aspect. `canTake` se juge donc sur la premiere : si elle leve, rien n'est
 * applique ; si elle passe, les suivantes empilent ce qui est deja possede et
 * ne peuvent plus lever.
 */
export function applyCardToLoadout(loadout: Loadout, card: Card): void {
  const fois = applicationsOf(card);
  for (let i = 0; i < fois; i++) {
    switch (card.nature) {
      case CARD.WEAPON:
        loadout.addWeapon(card.refId, card.upgrade);
        break;
      case CARD.PASSIVE:
        loadout.addPassive(card.refId);
        break;
      default:
        break;
    }
  }
}
```

`Room#grantCard` (`back/src/room.ts` l.~2567) **ne change pas** : il lit l'écart de PV max
après `applyCardToLoadout`, donc le soin suit le multiplicateur.

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run ../shared/rarity.test.ts ../shared/cards.test.ts ../shared/loadout.test.ts src/room.test.ts`
Attendu : PASS.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write shared/rarity.ts shared/rarity.test.ts shared/cards.ts shared/cards.test.ts shared/passives.ts back/src/room.test.ts
git add shared/rarity.ts shared/rarity.test.ts shared/cards.ts shared/cards.test.ts shared/passives.ts back/src/room.test.ts
git commit -m "feat(shared): la rarete multiplie une carte, une rare vaut deux cartes"
```

---

### Tâche 2 : le fil porte la rareté, et le miroir client l'applique

**Fichiers :**
- Modifier : `shared/protocol.ts` (`DRAFT_CARD_BYTES` l.~688-689, `WireCard` l.~1527-1531, `encodeDraftOpen` l.~1540-1553, `decodeDraftOpen` l.~1769-1779)
- Tester : `shared/protocol.test.ts` (`describe('DRAFT_OPEN')` l.~738-790), `front/src/net/client.test.ts` (`describe('GameClient — le draft recu et ses effets (tache 9)')` l.~2342), `back/src/boutique.integration.test.ts` (l.~374-398)

**Interfaces :**
- Consomme : `RARITY` (tâche 1).
- Produit : `WireCard.rarity?: number` ; `DRAFT_CARD_BYTES = 4` ; le décodeur rend toujours
  `rarity` (octet brut, `0` pour une commune).

Le client n'a **rien** à changer : `#applyDraftOutcomes` (`client.ts` l.~2448) passe déjà la carte
décodée à `applyCardToLoadout`, qui applique la rareté depuis la tâche 1. Les tests le prouvent.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/protocol.test.ts`, `describe('DRAFT_OPEN')` : la fixture devient

```ts
  const cartes = [
    { nature: 0, refId: 3, upgrade: 2, rarity: 0 },
    { nature: 1, refId: 7, upgrade: 0, rarity: 2 },
    { nature: 0, refId: 8, upgrade: 1, rarity: 1 },
  ];
```

et, dans « a la taille exacte annoncee par ses constantes », remplacer
`expect(DRAFT_CARD_BYTES).toBe(3);` par `expect(DRAFT_CARD_BYTES).toBe(4);` et
`toBe(DRAFT_OPEN_HEADER_BYTES + 9)` par `toBe(DRAFT_OPEN_HEADER_BYTES + 12)`. Mettre à jour le
commentaire de tête du `describe` (« une carte tient en QUATRE octets — le quatrieme est la
rarete »). Puis ajouter dans ce `describe` :

```ts
  it('etape 10 : la rarete est le QUATRIEME octet de chaque carte', () => {
    const buf = encodeDraftOpen(1, cartes);
    const v = new DataView(buf);
    expect(v.getUint8(DRAFT_OPEN_HEADER_BYTES + 3)).toBe(0);
    expect(v.getUint8(DRAFT_OPEN_HEADER_BYTES + DRAFT_CARD_BYTES + 3)).toBe(2);
    expect(v.getUint8(DRAFT_OPEN_HEADER_BYTES + 2 * DRAFT_CARD_BYTES + 3)).toBe(1);
  });

  it('etape 10 : une carte sans rarete part commune, et un octet inconnu revient tel quel', () => {
    const msg = decode(encodeDraftOpen(1, [{ nature: 1, refId: 2 }, { nature: 1, refId: 3, rarity: 200 }]));
    if (msg.type !== MSG.DRAFT_OPEN) {
      throw new Error('type inattendu');
    }
    expect(msg.cards[0]?.rarity).toBe(0);
    // Le fil ne juge pas : c'est `normalizeRarity` qui ramene 200 a commune.
    expect(msg.cards[1]?.rarity).toBe(200);
  });

  it('etape 10 : 6 + 5 x 4 = 26 octets a deux joueurs, un octet de plus par carte et rien d autre', () => {
    const cinq = [...cartes, ...cartes.slice(0, 2)];
    expect(cinq).toHaveLength(5);
    expect(encodeDraftOpen(1, cinq).byteLength).toBe(26);
  });
```

Dans `front/src/net/client.test.ts`, ajouter `import { RARITY } from '@shared/rarity';` puis, dans
`describe('GameClient — le draft recu et ses effets (tache 9)')` :

```ts
  it('etape 10 : une carte RARE gagnee s applique deux fois au miroir, comme au salon', () => {
    const { client, socket } = setup(1);
    socket.emit('message', {
      data: encodeDraftOpen(600, [{ nature: CARD.PASSIVE, refId: FOUGUE, rarity: RARITY.RARE }]),
    });
    socket.emit('message', {
      data: encodeDraftResult(0, [{ playerId: 1, cardIndex: 0, outcome: OUTCOME.WON }]),
    });
    expect(client.loadoutOf(1).stacksOf(FOUGUE)).toBe(2);
  });

  it('etape 10 : une arme LEGENDAIRE servie d office a un allie : acquisition plus deux crans', () => {
    const { client, socket } = setup(1);
    socket.emit('message', {
      data: encodeDraftOpen(600, [
        { nature: CARD.WEAPON, refId: GRENADE, upgrade: 1, rarity: RARITY.LEGENDAIRE },
      ]),
    });
    socket.emit('message', {
      data: encodeDraftResult(0, [{ playerId: 2, cardIndex: 0, outcome: OUTCOME.AUTO }]),
    });
    expect(client.loadoutOf(2).stacksOfWeapon(GRENADE)).toBe(3);
    expect(client.loadoutOf(2).upgradesOf(GRENADE, 1)).toBe(2);
  });
```

(`upgrade: 1` est `UPGRADE.DAMAGE`, proposé par toute arme.)

Dans `back/src/boutique.integration.test.ts` l.~374-398 : remplacer `t === 21` par `t === 26`, et
le commentaire « D'ou vient ce 21 » par « D'ou vient ce 26 » avec
`DRAFT_OPEN_HEADER_BYTES + cartes * DRAFT_CARD_BYTES` (6 + 5 * 4 = 26, voir `shared/protocol.ts`)
et « A quatre joueurs ce serait 6 + 7 * 4 = 34 ». Garder le nombre **nu**.

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run ../shared/protocol.test.ts`
Attendu : ÉCHEC (`DRAFT_CARD_BYTES` vaut 3, `rarity` absent du décodé).
Run : `cd front && npx vitest run src/net/client.test.ts -t "etape 10"`
Attendu : ÉCHEC (`stacksOf` vaut 1 : l'octet de rareté ne passe pas le fil).

- [ ] **Étape 3 : implémenter**

Dans `shared/protocol.ts` :

```ts
/**
 * Une carte : `nature u8 · refId u8 · upgrade u8 · rarity u8`.
 *
 * ⚠️ **Trois octets jusqu'a l'etape 10** : la rarete en ajoute un, dans un
 * message envoye une fois par montee de niveau — jamais par tick.
 */
export const DRAFT_CARD_BYTES = 4;
```

`WireCard` gagne `rarity?: number;` (avec `/** La rarete (`RARITY`, etape 10). Absente : commune. */`).

Dans `encodeDraftOpen`, après `v.setUint8(o + 2, c.upgrade ?? 0);` :

```ts
    v.setUint8(o + 3, c.rarity ?? 0);
```

Dans `decodeDraftOpen`, le `push` devient :

```ts
    cards.push({
      nature: v.getUint8(o),
      refId: v.getUint8(o + 1),
      upgrade: v.getUint8(o + 2),
      rarity: v.getUint8(o + 3),
    });
```

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run ../shared/protocol.test.ts src/boutique.integration.test.ts`
Attendu : PASS.
Run : `cd front && npx vitest run src/net/client.test.ts`
Attendu : PASS.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write shared/protocol.ts shared/protocol.test.ts front/src/net/client.test.ts back/src/boutique.integration.test.ts
git add shared/protocol.ts shared/protocol.test.ts front/src/net/client.test.ts back/src/boutique.integration.test.ts
git commit -m "feat(shared): DRAFT_OPEN porte la rarete, un octet de plus par carte"
```

---

### Tâche 3 : le catalogue — sept passifs, dont trois légendaires

**Fichiers :**
- Modifier : `shared/passives.ts` (`PASSIVE_KINDS` l.~33, fin de `PASSIVE_DEFS` l.~105), `shared/constants.ts` (après `CRIT_MULTIPLIER` l.~604), `shared/shop.ts` (`BonusKind` l.12), `front/src/ui/icons.ts` (l.1, l.35-47), `front/src/ui/draft.ts` (imports l.1-23, `UNITES` l.~230-240)
- Tester : `shared/passives.test.ts`, `shared/cards.test.ts`, `front/src/ui/draft.test.ts`

**Interfaces :**
- Consomme : `Passive.legendary`, `applicationsOf`, `applyCardToLoadout`, `RARITY` (tâche 1).
- Produit : `PassiveKind` gagne `'critChance' | 'critDamage' | 'salvo' | 'zone' | 'echo' |
  'harvest' | 'colossus'` ; passifs `precision` (id 6), `ferocite` (7), `volee` (8),
  `ampleur` (9), `echo` (10, légendaire), `moisson` (11, légendaire), `colosse` (12, légendaire) ;
  `HARVEST_RADIUS = 300`, `COLOSSUS_HP_STEP = 10` dans `shared/constants.ts`. Les tests et le code
  les retrouvent **par genre** (`PASSIVES.find((p) => p.kind === ...)`), jamais par indice.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/passives.test.ts`, remplacer « compte entre quatre et six passifs » par :

```ts
  it('compte dix passifs ordinaires et trois exclusivement legendaires (etape 10)', () => {
    expect(PASSIVES.filter((p) => !p.legendary)).toHaveLength(10);
    expect(PASSIVES.filter((p) => p.legendary).map((p) => p.name)).toEqual([
      'echo',
      'moisson',
      'colosse',
    ]);
  });

  it('etape 10 : les magnitudes par carte de la spec', () => {
    const de = (kind: string): number => PASSIVES.find((p) => p.kind === kind)?.magnitude ?? -1;
    expect(de('critChance')).toBe(0.04);
    expect(de('critDamage')).toBe(0.3);
    expect(de('salvo')).toBe(1);
    expect(de('zone')).toBe(1);
    expect(de('echo')).toBe(1);
    expect(de('harvest')).toBe(1);
    expect(de('colossus')).toBe(0.01);
  });
```

Dans `shared/cards.test.ts`, ajouter (importer `isLegendaryOnly` depuis `./cards`) :

```ts
describe('etape 10 : un passif exclusivement legendaire s applique x1', () => {
  const LEGENDAIRES = PASSIVES.filter((p) => p.legendary);

  it('quelle que soit la rarete que la carte porte, fil compris', () => {
    expect(LEGENDAIRES.length).toBe(3);
    for (const p of LEGENDAIRES) {
      for (const rarity of [RARITY.COMMUNE, RARITY.RARE, RARITY.LEGENDAIRE, 200]) {
        const l = new Loadout();
        const carte: Card = { nature: CARD.PASSIVE, refId: p.id, rarity };
        expect(isLegendaryOnly(carte)).toBe(true);
        expect(applicationsOf(carte)).toBe(1);
        applyCardToLoadout(l, carte);
        expect(l.stacksOf(p.id)).toBe(1);
      }
    }
  });

  it('il occupe un emplacement de passif comme les autres', () => {
    const l = new Loadout();
    l.addPassive(0);
    l.addPassive(1);
    const legendaire = LEGENDAIRES[0];
    if (!legendaire) {
      throw new Error('fixture : aucun legendaire');
    }
    applyCardToLoadout(l, { nature: CARD.PASSIVE, refId: legendaire.id, rarity: RARITY.LEGENDAIRE });
    expect(l.passiveSlotsUsed).toBe(3);
    expect(l.canTake(CARD.PASSIVE, 2)).toBe(false);
  });

  it('une arme n est jamais exclusivement legendaire', () => {
    expect(isLegendaryOnly({ nature: CARD.WEAPON, refId: 10 })).toBe(false);
  });
});
```

Dans le test « offre aussi la dague » de `shared/cards.test.ts`, passer la boucle de
`seed <= 200` à `seed <= 400` : le pool compte sept cartes de plus.

Dans `front/src/ui/draft.test.ts`, ajouter dans `describe('magnitudeLabel — ...')` :

```ts
  it.each([
    ['critChance', '+4 % critique'],
    ['critDamage', '+30 % dégâts critiques'],
    ['salvo', '+1 salve, armes de tir'],
    ['zone', '+1 zone, toutes armes'],
    ['echo', '+100 % dégâts de vos réactions'],
    ['harvest', '+1 PV par mort à 300 px'],
    ['colossus', '+1 % dégâts par 10 PV max'],
  ] as const)('etape 10 : %s se lit « %s »', (kind, attendu) => {
    const passive = PASSIVES.find((p) => p.kind === kind);
    if (!passive) {
      throw new Error(`fixture : aucun passif de genre ${kind}`);
    }
    expect(magnitudeLabel(passive)).toBe(attendu);
  });
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run ../shared/passives.test.ts ../shared/cards.test.ts`
Attendu : ÉCHEC (six passifs, aucun légendaire).
Run : `cd front && npx vitest run src/ui/draft.test.ts -t "etape 10"`
Attendu : ÉCHEC.

- [ ] **Étape 3 : implémenter**

`shared/constants.ts`, après `CRIT_MULTIPLIER` :

```ts
/**
 * Rayon de Moisson (etape 10, §4), en pixels monde : un ennemi qui meurt a
 * MOINS de cette distance du porteur lui rend `magnitude` PV. Strict : a 300
 * pile, rien. Le serveur seul l'applique ; l'ecran le lit pour l'ecrire.
 */
export const HARVEST_RADIUS = 300;

/** Colosse (etape 10, §4) : un bonus de degats par tranche ENTIERE de ce nombre de PV max. */
export const COLOSSUS_HP_STEP = 10;
```

`shared/passives.ts` :

```ts
export const PASSIVE_KINDS = [
  'fireRate',
  'damage',
  'maxHp',
  'speed',
  'regen',
  'critChance',
  'critDamage',
  'salvo',
  'zone',
  'echo',
  'harvest',
  'colossus',
] as const;
```

et, à la fin de `PASSIVE_DEFS` (après `regain`) :

```ts
  // ---- Etape 10 : quatre passifs qui s'empilent SANS PLAFOND (§3) ----------
  {
    // Chance de critique ajoutee par carte, en fraction (0,04 = +4 points).
    // Lue par `critOf` (shared/firing.ts) a l'apparition du projectile, des
    // deux cotes ; la borne a 1 vit la-bas et nulle part ailleurs.
    name: 'precision',
    kind: 'critChance',
    magnitude: 0.04,
  },
  {
    // Ajoute au multiplicateur critique par carte (0,3 : x2 devient x2,3).
    // Emporte PAR PROJECTILE a son apparition (`Projectiles.critFactorAt`).
    name: 'ferocite',
    kind: 'critDamage',
    magnitude: 0.3,
  },
  {
    // Crans de `UPGRADE.SALVO` ajoutes par carte a chaque arme de genre
    // `'tir'`, et a elles seules (`weaponUpgrades`, shared/firing.ts).
    name: 'volee',
    kind: 'salvo',
    magnitude: 1,
  },
  {
    // Crans de `UPGRADE.ZONE` ajoutes par carte a TOUTES les armes.
    name: 'ampleur',
    kind: 'zone',
    magnitude: 1,
  },
  // ---- Etape 10 : trois passifs EXCLUSIVEMENT LEGENDAIRES (§4) -------------
  // Ils changent une regle : s'appliquent x1, ne sortent que sur un
  // emplacement legendaire, prennent un emplacement de passif normal.
  {
    // +100 % des degats INSTANTANES des reactions que le porteur declenche
    // (`ReactionTrigger.by`), par carte. Serveur seul (`applyReactions`).
    name: 'echo',
    kind: 'echo',
    magnitude: 1,
    legendary: true,
  },
  {
    // PV rendus par ennemi mort a moins de `HARVEST_RADIUS` du porteur, quel
    // qu'en soit le tueur. Serveur seul (`resolveHarvest`).
    name: 'moisson',
    kind: 'harvest',
    magnitude: 1,
    legendary: true,
  },
  {
    // Fraction de degats ajoutee par tranche de `COLOSSUS_HP_STEP` PV max
    // (0,01 = +1 % par 10 PV). Lue par `shotDamage`, des deux cotes.
    name: 'colosse',
    kind: 'colossus',
    magnitude: 0.01,
    legendary: true,
  },
```

`shared/shop.ts` l.12 (et la phrase « Les cinq cles de passif » du docbloc reste vraie) :

```ts
/**
 * ...docbloc existant...
 *
 * ⚠️ **Les genres de passif de l'etape 10 n'en font PAS partie** : la
 * boutique ne les vend pas, et les y laisser entrer aurait ajoute sept cles a
 * zero a `BONUS_ZERO` et a chaque compte.
 */
export type BonusKind =
  | Extract<PassiveKind, 'fireRate' | 'damage' | 'maxHp' | 'speed' | 'regen'>
  | 'pickupRadius'
  | 'armor'
  | 'xp'
  | 'gold';
```

`front/src/ui/icons.ts` :

```ts
import type { PassiveKind } from '@shared/passives';
import type { BonusKind } from '@shared/shop';
```

```ts
const BONUS_ICONS: Record<BonusKind | PassiveKind, number> = {
  damage: 5,
  armor: 6,
  maxHp: 4,
  regen: 7,
  speed: 8,
  pickupRadius: 2,
  fireRate: 10,
  xp: 11,
  gold: 3,
  // Etape 10 : un choix d'affichage, comme le reste (douze icones en tout).
  critChance: 9,
  critDamage: 9,
  salvo: 12,
  zone: 1,
  echo: 12,
  harvest: 7,
  colossus: 4,
};

export const bonusIcon = (kind: BonusKind | PassiveKind): string => icon(BONUS_ICONS[kind]);
```

`front/src/ui/draft.ts` : importer `HARVEST_RADIUS, COLOSSUS_HP_STEP` (avec `PASSIVE_SLOTS,
TICK_HZ, WEAPON_SLOTS` depuis `@shared/constants`) et compléter `UNITES` :

```ts
  // Etape 10. ⚠️ Chacun dit OU il agit : « +1 salve » sans « armes de tir »
  // laisserait croire que le halo en profite.
  critChance: (m) => `+${pourcent(m)} % critique`,
  critDamage: (m) => `+${pourcent(m)} % dégâts critiques`,
  salvo: (m) => `+${m} salve, armes de tir`,
  zone: (m) => `+${m} zone, toutes armes`,
  echo: (m) => `+${pourcent(m)} % dégâts de vos réactions`,
  harvest: (m) => `+${m} PV par mort à ${HARVEST_RADIUS} px`,
  colossus: (m) => `+${pourcent(m)} % dégâts par ${COLOSSUS_HP_STEP} PV max`,
```

- [ ] **Étape 4 : les relancer, ils passent ; typecheck des deux côtés**

Run : `npm run typecheck -w back && npm run typecheck -w front`
Attendu : aucune erreur.
Run : `cd back && npx vitest run ../shared/passives.test.ts ../shared/cards.test.ts ../shared/shop.test.ts src/room.test.ts src/draft.test.ts`
Attendu : PASS.
Run : `cd front && npx vitest run src/ui/draft.test.ts src/ui/hud.test.ts src/ui/icons.test.ts`
Attendu : PASS.

> Le pool du tirage grossit de sept cartes : un test **à graine fixe** de `room.test.ts` qui
> drafte peut voir sortir une autre carte. S'il rougit, l'implémenteur cherche pourquoi : si
> l'assertion supposait une carte précise, il la dérive de la carte réellement tirée (jamais en
> changeant la graine pour retrouver l'ancienne), et le dit dans son rapport.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write shared/passives.ts shared/passives.test.ts shared/constants.ts shared/shop.ts shared/cards.test.ts front/src/ui/icons.ts front/src/ui/draft.ts front/src/ui/draft.test.ts
git add shared/passives.ts shared/passives.test.ts shared/constants.ts shared/shop.ts shared/cards.test.ts front/src/ui/icons.ts front/src/ui/draft.ts front/src/ui/draft.test.ts
git commit -m "feat(shared): sept passifs, dont trois exclusivement legendaires"
```

---

### Tâche 4 : le tirage — la rareté de l'emplacement, puis la carte qu'il permet

**Fichiers :**
- Modifier : `shared/cards.ts` (`drawSpread` l.~115-157, imports), `back/src/room.ts` (`DraftOpenEvent` l.~265-268)
- Tester : `shared/cards.test.ts`, `back/src/room.test.ts` (test « la carte disputee ne va qu au gagnant » l.~1549-1599), `back/src/draft.integration.test.ts` (fin du test, l.~485-500)

**Interfaces :**
- Consomme : `rollRarity`, `RARITY` (tâche 1), `isLegendaryOnly`, `applicationsOf` (tâches 1, 3).
- Produit : chaque carte de `drawSpread` porte `rarity` ; `DraftOpenEvent.cards: readonly Card[]`.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/cards.test.ts` (importer `RARITY` si ce n'est fait) :

```ts
describe('drawSpread — la rarete (etape 10)', () => {
  it('chaque carte porte une rarete, et les trois finissent par sortir', () => {
    const vues = new Set<number>();
    for (let seed = 1; seed <= 400; seed++) {
      for (const c of drawSpread(equipe(new Loadout(), new Loadout()), makeRandom(seed))) {
        expect(c.rarity).toBeDefined();
        vues.add(c.rarity ?? -1);
      }
    }
    expect(vues).toEqual(new Set([RARITY.COMMUNE, RARITY.RARE, RARITY.LEGENDAIRE]));
  });

  it('les proportions suivent RARITY_WEIGHTS, a la louche', () => {
    let communes = 0;
    let total = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      for (const c of drawSpread(equipe(new Loadout()), makeRandom(seed))) {
        total++;
        if (c.rarity === RARITY.COMMUNE) {
          communes++;
        }
      }
    }
    expect(communes / total).toBeGreaterThan(0.76);
    expect(communes / total).toBeLessThan(0.88);
  });

  it('un passif exclusivement legendaire ne sort QUE sur un emplacement legendaire', () => {
    let vus = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      for (const c of drawSpread(equipe(new Loadout()), makeRandom(seed))) {
        if (isLegendaryOnly(c)) {
          vus++;
          expect(c.rarity).toBe(RARITY.LEGENDAIRE);
        }
      }
    }
    // Non-vacuite : sans cette ligne, un tirage qui ne les offrirait JAMAIS
    // passerait l'assertion ci-dessus a vide.
    expect(vus).toBeGreaterThan(0);
  });
});
```

Dans le test « offre aussi la dague » : `TAILLE_DU_POOL` devient
`WEAPONS.length + PASSIVES.filter((p) => !p.legendary).length` (doc : « hors passifs
exclusivement legendaires, qui n'ont que 3 % des emplacements »), et la boucle n'ajoute à `vues`
que `if (!isLegendaryOnly(carte))`.

Dans `back/src/room.test.ts`, test « la carte disputee ne va qu au gagnant » (importer
`applicationsOf` avec `CARD, type Card` depuis `@shared/cards`). Juste après la garde
`if (!carte || !inv) { throw ... }`, déclarer :

```ts
    // L'arme du depart (la dague) est deja possedee par LES DEUX joueurs : une
    // carte de dague s'empile dessus. (Le salon est a graine aleatoire : sans
    // ce terme, le test rougissait chaque fois que la carte 0 etait la dague.)
    const deja = carte.nature === CARD.WEAPON && carte.refId === BASE_WEAPON_ID ? 1 : 0;
```

La moitié « perdant », branche arme : `expect(inv.stacksOfWeapon(carte.refId)).toBe(0);` devient
`toBe(deja)`. La moitié « gagnant » devient :

```ts
    // La carte compte autant de fois que sa rarete (etape 10).
    if (carte.nature === CARD.PASSIVE) {
      expect(invGagnant.stacksOf(carte.refId)).toBe(applicationsOf(carte));
    } else {
      expect(invGagnant.stacksOfWeapon(carte.refId)).toBe(deja + applicationsOf(carte));
    }
```

Dans `back/src/draft.integration.test.ts` (importer `applicationsOf` depuis `@shared/cards`), la
fin du test devient :

```ts
      // L'arme du depart, plus la carte gagnee — autant de fois que sa rarete
      // le dit (etape 10) : une rare compte deux exemplaires.
      const carte = spread.cards[granted.get(client.playerId) ?? -1];
      if (!carte) {
        throw new Error(`aucune carte attribuee au joueur ${client.playerId}`);
      }
      expect(cartes, `l inventaire du joueur ${client.playerId} est reste vide`).toBe(
        1 + applicationsOf(carte),
      );
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run ../shared/cards.test.ts`
Attendu : ÉCHEC (`rarity` indéfini, légendaires sur des emplacements communs).

- [ ] **Étape 3 : implémenter**

Dans `shared/cards.ts`, importer `import { multiplierOf, RARITY, rollRarity } from './rarity';`
puis remplacer la boucle de `drawSpread` (et compléter son docbloc) :

```ts
 * ⚠️ **La rarete de l'EMPLACEMENT d'abord, la carte ensuite** (etape 10,
 * §2.3) : un passif exclusivement legendaire n'entre dans le pool QUE pour un
 * emplacement qui vient de tirer legendaire. Tirer la carte d'abord obligerait
 * a retirer, ou a forcer la rarete — deux facons de fausser les 3 %. Rarete,
 * carte, aspect : tout vient du meme `rng`, dans cet ordre.
 */
export function drawSpread(loadouts: ReadonlyMap<number, Loadout>, rng: () => number): Card[] {
  const wanted = loadouts.size + SPREAD_BONUS;
  // (commentaires existants inchanges)
  const team = [...loadouts.values()];
  const pool = buildPool().filter((card) => team.some((l) => l.canTake(card.nature, card.refId)));
  const spread: Card[] = [];
  // (commentaire OWNED_WEIGHT inchange)
  const weights = pool.map((card) => (ownedByAnyone(card, loadouts) ? OWNED_WEIGHT : 1));

  while (spread.length < wanted && pool.length > 0) {
    const rarity = rollRarity(rng);
    const permis = pool.map((card, i) =>
      rarity === RARITY.LEGENDAIRE || !isLegendaryOnly(card) ? (weights[i] ?? 0) : 0,
    );
    let roll = rng() * permis.reduce((a, b) => a + b, 0);
    // ⚠️ `index` suit la derniere carte PERMISE vue : si l'arrondi laisse
    // `roll` a peine positif en fin de boucle, c'est elle qui sort — jamais une
    // carte de poids nul, donc jamais un legendaire sur un emplacement commun.
    let index = -1;
    for (let i = 0; i < pool.length; i++) {
      const w = permis[i] ?? 0;
      if (w <= 0) {
        continue;
      }
      index = i;
      roll -= w;
      if (roll < 0) {
        break;
      }
    }
    // ⚠️ INATTEIGNABLE aujourd'hui, et aucun test ne la garde : il faudrait
    // un pool fait de seuls legendaires, or une arme deja possedee y reste
    // toujours (`canTake`). Gardee parce que sans elle un pool sans carte
    // permise ferait sortir `pool[-1]`.
    if (index < 0) {
      break;
    }
    const [card] = pool.splice(index, 1);
    weights.splice(index, 1);
    if (!card) {
      break;
    }
    if (card.nature === CARD.WEAPON) {
      const options = upgradesFor(weaponOf(card.refId));
      card.upgrade = options[Math.min(options.length - 1, Math.floor(rng() * options.length))];
    }
    card.rarity = rarity;
    spread.push(card);
  }

  return spread;
}
```

(`multiplierOf` est déjà importé depuis la tâche 1 ; garder un seul import de `./rarity`.)

Dans `back/src/room.ts` l.~265, `DraftOpenEvent.cards` devient `readonly Card[]` (le type `Card`
est déjà importé l.27) : l'étalage porte désormais sa rareté et l'aspect jusqu'à l'encodeur.

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run ../shared/cards.test.ts src/room.test.ts src/draft.test.ts src/draft.integration.test.ts src/boutique.integration.test.ts`
Attendu : PASS (le dernier fichier demande Postgres ; le test de draft dure ~30 s).

> Même consigne qu'à la tâche 3 pour un test à graine fixe qui rougirait : dériver l'assertion de
> la carte tirée et de `applicationsOf`, jamais changer la graine, et le signaler.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write shared/cards.ts shared/cards.test.ts back/src/room.ts back/src/room.test.ts back/src/draft.integration.test.ts
git add shared/cards.ts shared/cards.test.ts back/src/room.ts back/src/room.test.ts back/src/draft.integration.test.ts
git commit -m "feat(shared): chaque emplacement tire sa rarete, les legendaires ont leur pool"
```

---

### Tâche 5 : une seule formule de tir pour les deux côtés — Volée, Ampleur, puis Colosse

**Fichiers :**
- Créer : `shared/firing.ts`, `shared/firing.test.ts`
- Modifier : `back/src/room.ts` (imports `@shared/weapons` l.~68-82, `#fireOne` l.~2194-2213), `front/src/net/client.ts` (imports `@shared/weapons` l.~66-79, `#fireOne` l.~2973-2993)
- Tester : `back/src/room.test.ts`, `front/src/net/client.test.ts`

**Interfaces :**
- Consomme : genres `'salvo'`, `'zone'`, `'colossus'`, `COLOSSUS_HP_STEP` (tâche 3).
- Produit (`shared/firing.ts`) :
  `weaponUpgrades(loadout: Loadout, weapon: Weapon): (upgrade: number) => number`,
  `armedWeapon(loadout: Loadout, weaponId: number): Weapon`,
  `shotDamage(weapon: Weapon, loadout: Loadout, accountDamage: number, maxHp: number): number`.

La spec impose de **factoriser avant d'ajouter Colosse** : étapes 1-5 = la factorisation et
Volée/Ampleur (un commit), étapes 6-9 = Colosse (un second commit).

- [ ] **Étape 1 : écrire les tests qui échouent (factorisation, Volée, Ampleur)**

`shared/firing.test.ts` :

```ts
import { describe, expect, it } from 'vitest';

import { armedWeapon, shotDamage, weaponUpgrades } from './firing';
import { Loadout } from './loadout';
import { PASSIVES, type PassiveKind } from './passives';
import {
  DAMAGE_PER_UPGRADE,
  effectRadius,
  salvoCount,
  UPGRADE,
  WEAPONS,
  type Weapon,
  weaponOf,
} from './weapons';

function genre(kind: PassiveKind): number {
  const p = PASSIVES.find((x) => x.kind === kind);
  if (!p) {
    throw new Error(`fixture : aucun passif de genre ${kind}`);
  }
  return p.id;
}

function avec(kind: PassiveKind, cartes: number, ...armes: number[]): Loadout {
  const l = new Loadout();
  for (const a of armes) {
    l.addWeapon(a);
  }
  for (let i = 0; i < cartes; i++) {
    l.addPassive(genre(kind));
  }
  return l;
}

function arme(test: (w: Weapon) => boolean, quoi: string): Weapon {
  const w = WEAPONS.find(test);
  if (!w) {
    throw new Error(`fixture : aucune arme ${quoi}`);
  }
  return w;
}

const TIR = arme((w) => w.kind === 'tir' && w.perks.includes(UPGRADE.SALVO), 'de tir a salve');
const HALO = arme((w) => w.kind === 'halo', 'halo');

describe('etape 10 : crans de l arme + crans des passifs (weaponUpgrades)', () => {
  it('Volee ajoute un cran de salve par carte a une arme de TIR', () => {
    const l = avec('salvo', 2, TIR.id);
    expect(weaponUpgrades(l, TIR)(UPGRADE.SALVO)).toBe(2);
    // Et se cumule aux cartes « salve » de l'arme elle-meme.
    l.addWeapon(TIR.id, UPGRADE.SALVO);
    expect(weaponUpgrades(l, TIR)(UPGRADE.SALVO)).toBe(3);
  });

  it('Volee ne touche PAS un halo', () => {
    const l = avec('salvo', 3, HALO.id);
    expect(weaponUpgrades(l, HALO)(UPGRADE.SALVO)).toBe(0);
  });

  it('Ampleur ajoute un cran de zone par carte a TOUTES les armes', () => {
    const l = avec('zone', 2, TIR.id, HALO.id);
    expect(weaponUpgrades(l, TIR)(UPGRADE.ZONE)).toBe(2);
    expect(weaponUpgrades(l, HALO)(UPGRADE.ZONE)).toBe(2);
    // Et rien d'autre.
    expect(weaponUpgrades(l, HALO)(UPGRADE.PIERCE)).toBe(0);
  });

  it('armedWeapon applique ces crans : salve elargie, cercle elargi', () => {
    expect(armedWeapon(avec('salvo', 1, TIR.id), TIR.id).projectileCount).toBe(salvoCount(TIR, 2));
    expect(armedWeapon(avec('zone', 1, HALO.id), HALO.id).blastRadius).toBeCloseTo(
      effectRadius(HALO, 2),
      6,
    );
  });

  it('sans rien d ameliore, armedWeapon rend l entree du catalogue elle-meme', () => {
    const l = avec('salvo', 0, TIR.id);
    expect(armedWeapon(l, TIR.id)).toBe(weaponOf(TIR.id));
  });
});

describe('etape 10 : la formule de degats partagee (shotDamage)', () => {
  it('somme passifs, compte et cartes « degats » comme le faisaient les deux copies', () => {
    const l = avec('damage', 2, TIR.id);
    l.addWeapon(TIR.id, UPGRADE.DAMAGE);
    const passif = l.bonus('damage');
    expect(passif).toBeGreaterThan(0);
    expect(shotDamage(TIR, l, 0.1, 100)).toBeCloseTo(
      TIR.damage * (1 + passif + 0.1 + DAMAGE_PER_UPGRADE),
      6,
    );
  });
});
```

Dans `back/src/room.test.ts`, ajouter :

```ts
describe('etape 10 : Volee dans le salon', () => {
  const VOLEE = PASSIVES.find((p) => p.kind === 'salvo')?.id ?? -1;

  it('la dague tire une salve elargie d un cran par carte de Volee', () => {
    const room = new Room(0x10_0a_0501);
    room.join(1);
    room.grantCard(1, { nature: CARD.PASSIVE, refId: VOLEE });
    const spy = vi.spyOn(Projectiles.prototype, 'fireSalvoDirected');
    room.applyInput(1, 1, 0, 0, 127, 0);
    room.step(DT);
    const appel = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
    spy.mockRestore();
    const dague = weaponOf(BASE_WEAPON_ID);
    expect(dague.kind).toBe('tir');
    expect(appel?.[7]).toBe(dague.projectileCount + stackGain(dague));
  });
});
```

Dans `front/src/net/client.test.ts`, `describe('GameClient — le draft recu et ses effets (tache
9)')` (importer `PASSIVES` avec `passiveOf`) :

```ts
  it('etape 10 : Volee elargit la salve affichee exactement comme celle du serveur', () => {
    const VOLEE = PASSIVES.find((p) => p.kind === 'salvo')?.id ?? -1;
    const { client, socket } = setup(1);
    grant(socket, { nature: CARD.PASSIVE, refId: VOLEE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
    ]);
    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    run(client, socket, 3, [
      { id: 1, x: 2000, y: 2000, hp: 100, aimX: 127, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS },
    ]);
    const base = weaponOf(BASE_WEAPON_ID);
    const tir = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
    expect(tir?.[7]).toBe(base.projectileCount + stackGain(base));
  });
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run ../shared/firing.test.ts src/room.test.ts -t "etape 10"`
Attendu : ÉCHEC (`./firing` introuvable ; la salve du salon ne voit pas Volée).
Run : `cd front && npx vitest run src/net/client.test.ts -t "Volee"`
Attendu : ÉCHEC.

- [ ] **Étape 3 : implémenter la factorisation**

`shared/firing.ts` :

```ts
import type { Loadout } from './loadout';
import { DAMAGE_PER_UPGRADE, UPGRADE, upgradedWeapon, type Weapon, weaponOf } from './weapons';

/**
 * Ce qu'un tir vaut, calcule UNE fois pour les deux cotes du fil (etape 10).
 *
 * ⚠️ **`Room#fireOne` et `GameClient#fireOne` appellent ces fonctions, jamais
 * deux copies.** La formule de degats existait en deux exemplaires
 * (`room.ts` et `client.ts`) : ils auraient diverge au premier passif ajoute,
 * et le client aurait dessine une salve que le serveur ne tire pas — le meme
 * argument que `applyCardToLoadout` et `cooldownWithBonus`.
 *
 * Hors de `weapons.ts` parce que tout ici lit un `Loadout`, et que
 * `loadout.ts` importe deja `weapons.ts`.
 */

/**
 * Les crans d'un aspect pour CE joueur : ceux de l'arme (ses cartes), plus
 * ceux que ses passifs ajoutent a toutes ses armes — Volee (`salvo`) aux
 * seules armes de tir, Ampleur (`zone`) a toutes (§3.1).
 */
export function weaponUpgrades(loadout: Loadout, weapon: Weapon): (upgrade: number) => number {
  const volee = weapon.kind === 'tir' ? loadout.bonus('salvo') : 0;
  const ampleur = loadout.bonus('zone');
  return (u) =>
    loadout.upgradesOf(weapon.id, u) +
    (u === UPGRADE.SALVO ? volee : 0) +
    (u === UPGRADE.ZONE ? ampleur : 0);
}

/** L'arme telle que CE joueur la tire : `upgradedWeapon` sur `weaponUpgrades`. */
export function armedWeapon(loadout: Loadout, weaponId: number): Weapon {
  const base = weaponOf(weaponId);
  return upgradedWeapon(base, weaponUpgrades(loadout, base));
}

/**
 * Les degats d'un tir : passifs de degats + bonus de compte + cartes
 * « degats » de l'arme.
 *
 * `maxHp` est le PV max du tireur (lu par Colosse).
 */
export function shotDamage(
  weapon: Weapon,
  loadout: Loadout,
  accountDamage: number,
  maxHp: number,
): number {
  void maxHp;
  return (
    weapon.damage *
    (1 +
      loadout.bonus('damage') +
      accountDamage +
      DAMAGE_PER_UPGRADE * loadout.upgradesOf(weapon.id, UPGRADE.DAMAGE))
  );
}
```

> `void maxHp` ne vit que le temps de ce commit : l'étape 7 le remplace par Colosse.

`back/src/room.ts`, `#fireOne` : la première ligne et le calcul de `damage` deviennent

```ts
    // Ses bonus propres ET ceux des passifs (Volee, Ampleur) appliques — la
    // MEME fonction que le miroir client (`shared/firing.ts`).
    const weapon = armedWeapon(p.loadout, weaponId);
```

```ts
    const damage = shotDamage(weapon, p.loadout, p.accountBonuses.damage, p.maxHp);
```

Imports : `import { armedWeapon, shotDamage } from '@shared/firing';` ; retirer
`DAMAGE_PER_UPGRADE` et `upgradedWeapon` de l'import `@shared/weapons` (garder `UPGRADE`,
`FIRE_RATE_PER_UPGRADE`, `weaponOf`, toujours lus).

`front/src/net/client.ts`, `#fireOne` :

```ts
    // La MEME fonction que `Room#fireOne` (`shared/firing.ts`), passifs
    // globaux (Volee, Ampleur) compris.
    const weapon = armedWeapon(loadout, weaponId);
```

```ts
    // ⚠️ Le PV max d'un ALLIE se derive ici avec les bonus de compte du joueur
    // LOCAL — la meme approximation que `accountBonuses.damage` juste a cote.
    // Cosmetique (§5.4).
    const damage = shotDamage(
      weapon,
      loadout,
      this.accountBonuses.damage,
      PLAYER_MAX_HP + loadout.bonus('maxHp') + this.accountBonuses.maxHp,
    );
```

Imports : `import { armedWeapon, shotDamage } from '@shared/firing';` ; retirer
`DAMAGE_PER_UPGRADE` et `upgradedWeapon` de l'import `@shared/weapons`. Mettre à jour le
commentaire « Meme calcul que `Room#fireOne`, meme fonction (`upgradedWeapon`) » en « meme
fonctions (`armedWeapon`, `shotDamage`) ».

- [ ] **Étape 4 : les relancer, ils passent ; rien d'autre ne bouge**

Run : `npm run typecheck -w back && npm run typecheck -w front`
Run : `cd back && npx vitest run ../shared/firing.test.ts src/room.test.ts`
Run : `cd front && npx vitest run src/net/client.test.ts`
Attendu : PASS partout — les tests de dégâts existants (`appel[6]`, `tir?.[6]`) restent verts :
la factorisation ne change aucune valeur.

- [ ] **Étape 5 : commit (la factorisation)**

```bash
npx biome check --write shared/firing.ts shared/firing.test.ts back/src/room.ts back/src/room.test.ts front/src/net/client.ts front/src/net/client.test.ts
git add shared/firing.ts shared/firing.test.ts back/src/room.ts back/src/room.test.ts front/src/net/client.ts front/src/net/client.test.ts
git commit -m "refactor(shared): une seule formule de tir pour le salon et le miroir, Volee et Ampleur y entrent"
```

- [ ] **Étape 6 : écrire les tests de Colosse, qui échouent**

`shared/firing.test.ts` (importer `COLOSSUS_HP_STEP` depuis `./constants`) :

```ts
describe('etape 10 : Colosse, +1 % de degats par tranche de 10 PV max', () => {
  it.each([
    [0, 100, 1],
    [1, 100, 1.1],
    [1, 120, 1.12],
    [1, 129, 1.12],
    [2, 100, 1.2],
  ])('%i carte(s) a %i PV max : x%f', (cartes, maxHp, facteur) => {
    const l = avec('colossus', cartes, TIR.id);
    expect(COLOSSUS_HP_STEP).toBe(10);
    expect(shotDamage(TIR, l, 0, maxHp)).toBeCloseTo(TIR.damage * facteur, 6);
  });

  it('se MULTIPLIE aux autres bonus de degats, il ne s y ajoute pas', () => {
    const l = avec('damage', 1, TIR.id);
    l.addPassive(genre('colossus'));
    expect(shotDamage(TIR, l, 0, 100)).toBeCloseTo(TIR.damage * (1 + l.bonus('damage')) * 1.1, 6);
  });
});
```

Dans `back/src/room.test.ts` :

```ts
describe('etape 10 : Colosse dans le salon', () => {
  const COLOSSE = PASSIVES.find((p) => p.kind === 'colossus')?.id ?? -1;
  const VITALITE = PASSIVES.find((p) => p.kind === 'maxHp')?.id ?? -1;

  function degatsDuPremierTir(vitalites: number): number {
    const room = new Room(0x10_0a_0502);
    room.join(1);
    room.grantCard(1, { nature: CARD.PASSIVE, refId: COLOSSE });
    for (let i = 0; i < vitalites; i++) {
      room.grantCard(1, { nature: CARD.PASSIVE, refId: VITALITE });
    }
    const spy = vi.spyOn(Projectiles.prototype, 'fireSalvoDirected');
    room.applyInput(1, 1, 0, 0, 127, 0);
    room.step(DT);
    const appel = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
    spy.mockRestore();
    return appel?.[6] ?? 0;
  }

  it('lit le PV max DU SALON : 100 PV donnent x1,10, 120 PV x1,12', () => {
    const base = weaponOf(BASE_WEAPON_ID).damage;
    expect(degatsDuPremierTir(0)).toBeCloseTo(base * 1.1, 5);
    expect(degatsDuPremierTir(1)).toBeCloseTo(base * 1.12, 5);
  });
});
```

Dans `front/src/net/client.test.ts` :

```ts
  it('etape 10 : Colosse voyage avec le projectile affiche, comme au salon', () => {
    const COLOSSE = PASSIVES.find((p) => p.kind === 'colossus')?.id ?? -1;
    const { client, socket } = setup(1);
    grant(socket, { nature: CARD.PASSIVE, refId: COLOSSE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
    ]);
    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    run(client, socket, 3, [
      { id: 1, x: 2000, y: 2000, hp: 100, aimX: 127, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS },
    ]);
    const base = weaponOf(BASE_WEAPON_ID);
    const tir = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
    expect(tir?.[6]).toBeCloseTo(base.damage * 1.1, 6);
  });
```

Run : `cd back && npx vitest run ../shared/firing.test.ts src/room.test.ts -t "Colosse"` puis
`cd front && npx vitest run src/net/client.test.ts -t "Colosse"`
Attendu : ÉCHEC (facteur 1).

- [ ] **Étape 7 : implémenter Colosse**

Dans `shared/firing.ts`, importer `import { COLOSSUS_HP_STEP } from './constants';` et remplacer
le corps de `shotDamage` (supprimer `void maxHp`) et compléter son docbloc :

```ts
 * ⚠️ **Colosse MULTIPLIE** (etape 10, §4) : +`magnitude` par tranche ENTIERE
 * de `COLOSSUS_HP_STEP` PV max, applique au total des autres bonus — les
 * passifs de l'etape « se multiplient entre eux ». Les achats de vitalite
 * permanente montent aussi le PV max : c'est voulu (§7, a surveiller).
 */
export function shotDamage(
  weapon: Weapon,
  loadout: Loadout,
  accountDamage: number,
  maxHp: number,
): number {
  const colosse = 1 + loadout.bonus('colossus') * Math.floor(maxHp / COLOSSUS_HP_STEP);
  return (
    weapon.damage *
    (1 +
      loadout.bonus('damage') +
      accountDamage +
      DAMAGE_PER_UPGRADE * loadout.upgradesOf(weapon.id, UPGRADE.DAMAGE)) *
    colosse
  );
}
```

- [ ] **Étape 8 : les relancer, ils passent**

Run : `cd back && npx vitest run ../shared/firing.test.ts src/room.test.ts`
Run : `cd front && npx vitest run src/net/client.test.ts`
Attendu : PASS.

- [ ] **Étape 9 : commit (Colosse)**

```bash
npx biome check --write shared/firing.ts shared/firing.test.ts back/src/room.test.ts front/src/net/client.test.ts
git add shared/firing.ts shared/firing.test.ts back/src/room.test.ts front/src/net/client.test.ts
git commit -m "feat(shared): Colosse, un pour cent de degats par tranche de dix PV max"
```

---

### Tâche 6 : le critique du tireur — Précision et Férocité, emportés par le projectile

**Fichiers :**
- Modifier : `shared/projectiles.ts` (import l.2, `#crit` l.~138-146, constructeur l.~211, `fireSalvoDirected` l.~293-308, `#emit` l.~316-380, `critAt` l.~452-458, `#removeAt` l.~764), `shared/firing.ts`, `back/src/combat.ts` (import l.18, l.~1281, l.~1329), `back/src/room.ts` (`#fireOne`, appel `fireSalvoDirected` l.~2277), `front/src/net/client.ts` (import l.16, l.~2652, `#fireOne` l.~3065)
- Tester : `shared/projectiles.test.ts`, `shared/firing.test.ts`, `back/src/room.test.ts`, `front/src/net/client.test.ts`

**Interfaces :**
- Consomme : genres `'critChance'`, `'critDamage'` (tâche 3), `shared/firing.ts` (tâche 5).
- Produit : `interface Crit { readonly chance: number; readonly multiplier: number }`,
  `BASE_CRIT: Crit` (dans `shared/projectiles.ts`) ;
  `fireSalvoDirected(weapon, tick, x, y, dirX, dirY, damage?, count?, by = 0, crit: Crit = BASE_CRIT)` ;
  `Projectiles.critFactorAt(slot): number` (le multiplicateur emporté, `1` sans critique) ;
  `critOf(loadout: Loadout): Crit` (dans `shared/firing.ts`).

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/projectiles.test.ts`, importer `BASE_CRIT` depuis `./projectiles` et
`CRIT_MULTIPLIER` avec `CRIT_CHANCE`, puis ajouter dans `describe('Projectiles — le coup
critique')` :

```ts
  it('etape 10 : une chance de 1 fait criter toute la salve, 0 aucun projectile', () => {
    const p = new Projectiles(64);
    const arme = { ...SPREAD, projectileCount: 20 };
    p.fireSalvoDirected(arme, 5, 0, 0, 1, 0, arme.damage, 20, 1, { chance: 1, multiplier: 2.3 });
    expect(Array.from({ length: p.count }, (_, i) => p.critAt(i)).every(Boolean)).toBe(true);
    const q = new Projectiles(64);
    q.fireSalvoDirected(arme, 5, 0, 0, 1, 0, arme.damage, 20, 1, { chance: 0, multiplier: 2.3 });
    expect(Array.from({ length: q.count }, (_, i) => q.critAt(i)).some(Boolean)).toBe(false);
    expect(q.critFactorAt(0)).toBe(1);
  });

  it('etape 10 : le projectile EMPORTE le multiplicateur du tireur, compaction comprise', () => {
    const p = new Projectiles(16);
    const arme = { ...SPREAD, projectileCount: 12 };
    p.fireSalvoDirected(arme, 99, 0, 0, 1, 0, arme.damage, 12, 1, { chance: 1, multiplier: 2.6 });
    expect(p.critFactorAt(0)).toBeCloseTo(2.6, 5);
    const horde = new Horde(10);
    addOne(horde, 1, 0, 0);
    p.collide(horde, () => undefined);
    expect(p.critFactorAt(0)).toBeCloseTo(2.6, 5);
  });

  it('etape 10 : sans critique precise, la salve tire au critique de base', () => {
    expect(BASE_CRIT).toEqual({ chance: CRIT_CHANCE, multiplier: CRIT_MULTIPLIER });
    const crit = salve(1234, 3, 8);
    const p = new Projectiles(64);
    const arme = { ...SPREAD, projectileCount: 8 };
    p.fireSalvoDirected(arme, 1234, 0, 0, 1, 0, arme.damage, 8, 3, BASE_CRIT);
    expect(Array.from({ length: p.count }, (_, i) => p.critAt(i))).toEqual(crit);
    for (let i = 0; i < p.count; i++) {
      expect(p.critFactorAt(i)).toBeCloseTo(p.critAt(i) ? CRIT_MULTIPLIER : 1, 5);
    }
  });
```

Dans `shared/firing.test.ts` (importer `critOf`, et `CRIT_CHANCE, CRIT_MULTIPLIER` depuis
`./constants`) :

```ts
describe('etape 10 : le critique du tireur (critOf)', () => {
  it('sans carte : la chance et le multiplicateur de base', () => {
    expect(critOf(new Loadout())).toEqual({ chance: CRIT_CHANCE, multiplier: CRIT_MULTIPLIER });
  });

  it('Precision ajoute 4 points par carte, et s arrete a 100 %', () => {
    expect(critOf(avec('critChance', 1)).chance).toBeCloseTo(CRIT_CHANCE + 0.04, 9);
    expect(critOf(avec('critChance', 30)).chance).toBe(1);
  });

  it('Ferocite ajoute 0,3 au multiplicateur par carte, sans plafond', () => {
    expect(critOf(avec('critDamage', 2)).multiplier).toBeCloseTo(CRIT_MULTIPLIER + 0.6, 9);
    expect(critOf(avec('critDamage', 50)).multiplier).toBeCloseTo(CRIT_MULTIPLIER + 15, 9);
  });
});
```

Dans `back/src/room.test.ts` (ajouter `CRIT_CHANCE, CRIT_MULTIPLIER` à l'import de
`@shared/constants`) :

```ts
describe('etape 10 : le critique du tireur dans le salon', () => {
  it('la salve part avec le tireur et SON critique, Precision et Ferocite comprises', () => {
    const PRECISION = PASSIVES.find((p) => p.kind === 'critChance')?.id ?? -1;
    const FEROCITE = PASSIVES.find((p) => p.kind === 'critDamage')?.id ?? -1;
    const room = new Room(0x10_0a_0601);
    room.join(1);
    room.grantCard(1, { nature: CARD.PASSIVE, refId: PRECISION });
    room.grantCard(1, { nature: CARD.PASSIVE, refId: FEROCITE });
    const spy = vi.spyOn(Projectiles.prototype, 'fireSalvoDirected');
    room.applyInput(1, 1, 0, 0, 127, 0);
    room.step(DT);
    const appel = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
    spy.mockRestore();
    expect(appel?.[8]).toBe(1);
    expect(appel?.[9]?.chance).toBeCloseTo(CRIT_CHANCE + 0.04, 9);
    expect(appel?.[9]?.multiplier).toBeCloseTo(CRIT_MULTIPLIER + 0.3, 9);
  });
});
```

Dans `front/src/net/client.test.ts` (importer `critOf` depuis `@shared/firing`) :

```ts
  it('etape 10 : le miroir tire avec le VRAI tireur et son critique — comme le salon', () => {
    // ⚠️ Avant l'etape 10, le client ne passait pas `by` : son critique etait
    // tire de `hashRoll(tick, 0, i)` quand le serveur tirait
    // `hashRoll(tick, p.id, i)`. Le chiffre dore affiche n'etait pas celui
    // arbitre.
    const FEROCITE = PASSIVES.find((p) => p.kind === 'critDamage')?.id ?? -1;
    const { client, socket } = setup(1);
    grant(socket, { nature: CARD.PASSIVE, refId: FEROCITE }, [
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
    ]);
    const spy = vi.spyOn(client.projectiles, 'fireSalvoDirected');
    run(client, socket, 3, [
      { id: 1, x: 2000, y: 2000, hp: 100, aimX: 127, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS },
    ]);
    const tir = spy.mock.calls.find((c) => c[0].id === BASE_WEAPON_ID);
    expect(tir?.[8]).toBe(1);
    expect(tir?.[9]).toEqual(critOf(client.loadoutOf(1)));
  });
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run ../shared/projectiles.test.ts ../shared/firing.test.ts src/room.test.ts -t "critique|critOf"`
Run : `cd front && npx vitest run src/net/client.test.ts -t "VRAI tireur"`
Attendu : ÉCHEC (`critFactorAt`, `BASE_CRIT`, `critOf` inexistants ; `tir[8]` vaut `undefined`).

- [ ] **Étape 3 : implémenter**

`shared/projectiles.ts` :

1. Import : `import { CRIT_CHANCE, CRIT_MULTIPLIER, PROJECTILE_HIT_RADIUS, VIF_ARGENT_HIT_RADIUS_BONUS } from './constants';`
2. Avant la classe :

```ts
/**
 * Le critique d'un TIREUR (etape 10, §3.2) : sa chance (Precision) et son
 * multiplicateur (Ferocite). Calcule par `critOf` (shared/firing.ts), des
 * deux cotes, et passe a l'emission.
 */
export interface Crit {
  readonly chance: number;
  readonly multiplier: number;
}

/** Le critique sans aucune carte : celui de l'etape 8. */
export const BASE_CRIT: Crit = Object.freeze({ chance: CRIT_CHANCE, multiplier: CRIT_MULTIPLIER });
```

3. `#crit` devient un `Float32Array` (docbloc complété) :

```ts
  /**
   * Le multiplicateur critique EMPORTE par ce projectile : celui de son
   * tireur si le tirage a crite, `1` sinon (etapes 8 et 10).
   *
   * ⚠️ **Decide a l'EMISSION, pas a l'impact.** (paragraphe existant inchange)
   *
   * ⚠️ **Le multiplicateur voyage, pas un booleen** (etape 10) : Ferocite le
   * rend propre au tireur, et les trois lecteurs (deux dans `combat.ts`, un
   * dans `client.ts`) lisent le projectile — plus jamais `CRIT_MULTIPLIER`.
   */
  readonly #crit: Float32Array;
```

et dans le constructeur : `this.#crit = new Float32Array(capacity);`.

4. `fireSalvoDirected` gagne le dernier paramètre `crit: Crit = BASE_CRIT` et le passe :
   `this.#emit(weapon, tick, x, y, Math.atan2(dirY, dirX), damage, count, by, crit);`.
   `#emit` gagne le même dernier paramètre `crit: Crit = BASE_CRIT`, et la ligne du tirage
   devient :

```ts
      // Le critique, tire d'une fonction du TIR et non d'une suite — voir
      // `CRIT_CHANCE` et `hashRoll`. Le rang `i` est ce qui empeche une salve
      // entiere de criter d'un bloc. La chance et le multiplicateur sont ceux
      // du TIREUR (etape 10).
      this.#crit[slot] = hashRoll(tick, by, i) < crit.chance ? crit.multiplier : 1;
```

5. `critAt` et le nouveau lecteur :

```ts
  critAt(slot: number): boolean {
    return (this.#crit[slot] ?? 1) > 1;
  }

  /**
   * Ce qu'un impact de ce projectile multiplie : le multiplicateur de son
   * tireur s'il a crite, `1` sinon. Lu par l'arbitrage (serveur) et par
   * l'affichage des degats (client).
   */
  critFactorAt(slot: number): number {
    return this.#crit[slot] ?? 1;
  }
```

6. Dans `#removeAt` : `this.#crit[slot] = this.#crit[last] ?? 1;`.

`shared/firing.ts` : importer `CRIT_CHANCE, CRIT_MULTIPLIER` (avec `COLOSSUS_HP_STEP`) depuis
`./constants` et `type Crit` depuis `./projectiles`, puis :

```ts
/**
 * Le critique de CE tireur (etape 10, §3.2) : Precision ajoute a la chance,
 * bornee a 1 — une chance au-dela de 100 % ne veut rien dire, c'est le seul
 * plafond de l'etape ; Ferocite ajoute au multiplicateur, sans plafond.
 *
 * Le client le calcule pour TOUS les joueurs : il tient le miroir de leurs
 * inventaires.
 */
export function critOf(loadout: Loadout): Crit {
  return {
    chance: Math.min(1, CRIT_CHANCE + loadout.bonus('critChance')),
    multiplier: CRIT_MULTIPLIER + loadout.bonus('critDamage'),
  };
}
```

`back/src/combat.ts` : retirer `CRIT_MULTIPLIER` de l'import `@shared/constants`, puis

- l.~1281 : `projectiles.damageAt(slot) * projectiles.critFactorAt(slot),`
- l.~1329 : `const coup = damage * ampNeutre * projectiles.critFactorAt(projectileSlot);`

`back/src/room.ts`, `#fireOne`, dernier appel (importer `critOf` avec `armedWeapon, shotDamage`) :

```ts
    this.#projectiles.fireSalvoDirected(
      weapon,
      tick,
      p.x,
      p.y,
      p.aimX,
      p.aimY,
      damage,
      count,
      p.id,
      critOf(p.loadout),
    );
```

`front/src/net/client.ts` : retirer `CRIT_MULTIPLIER` de l'import `@shared/constants` ; l.~2652 :

```ts
          this.projectiles.damageAt(projectileSlot) * this.projectiles.critFactorAt(projectileSlot),
```

et dans `#fireOne` (importer `critOf` avec `armedWeapon, shotDamage`) :

```ts
    // ⚠️ **Le tireur ET son critique**, comme `Room#fireOne` : sans `playerId`
    // le tirage partait de `hashRoll(tick, 0, i)`, et le critique affiche
    // n'etait pas celui que le serveur arbitre (corrige a l'etape 10).
    this.projectiles.fireSalvoDirected(
      weapon,
      tick,
      x,
      y,
      aimX,
      aimY,
      damage,
      count,
      playerId,
      critOf(loadout),
    );
```

- [ ] **Étape 4 : les relancer, ils passent**

Run : `npm run typecheck -w back && npm run typecheck -w front`
Run : `cd back && npx vitest run ../shared/projectiles.test.ts ../shared/firing.test.ts src/combat.test.ts src/room.test.ts`
Run : `cd front && npx vitest run src/net/client.test.ts`
Attendu : PASS.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write shared/projectiles.ts shared/projectiles.test.ts shared/firing.ts shared/firing.test.ts back/src/combat.ts back/src/room.ts back/src/room.test.ts front/src/net/client.ts front/src/net/client.test.ts
git add shared/projectiles.ts shared/projectiles.test.ts shared/firing.ts shared/firing.test.ts back/src/combat.ts back/src/room.ts back/src/room.test.ts front/src/net/client.ts front/src/net/client.test.ts
git commit -m "feat(shared): Precision et Ferocite, le projectile emporte le critique de son tireur"
```

---

### Tâche 7 : Écho — les réactions que tu déclenches frappent deux fois plus fort

**Fichiers :**
- Modifier : `back/src/combat.ts` (`applyReactions` l.~1056-1194), `back/src/room.ts` (appel l.~1553)
- Tester : `back/src/combat.test.ts`, `back/src/room.test.ts`

**Interfaces :**
- Consomme : genre `'echo'` (tâche 3).
- Produit : `applyReactions(horde, orbs, tick, triggers, zones, reactions, echoOf: (playerId: number) => number = () => 0): number[]`
  — `echoOf` rend le `bonus('echo')` du joueur ; chaque dégât **instantané** d'un déclencheur
  `t` est multiplié par `1 + echoOf(t.by)`.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `back/src/combat.test.ts`, dans `describe('applyReactions — la reaction tue par REACTION_RADIUS
(etape 5a, tache 7)')` (qui a `LOURD`, `declencheur(x, y)` avec `markBy: 1, by: 2`) :

```ts
  it('etape 10 : Echo double les degats d une reaction declenchee par son porteur, pas celle d un autre', () => {
    function perte(echoOf: (id: number) => number): number {
      const horde = new Horde(10);
      const cible = addOne(horde, 1, 1000, 1000, LOURD);
      horde.hp[horde.slotOf(cible)] = 1000;
      applyReactions(
        horde,
        new OrbField(10),
        0,
        [declencheur(1000, 1000)],
        new ZoneField(),
        new Reactions(),
        echoOf,
      );
      return 1000 - (horde.hp[horde.slotOf(cible)] ?? 0);
    }
    const seul = perte(() => 0);
    expect(seul).toBeCloseTo(coupSurLourd(REACTION_DAMAGE), 4);
    // Le declencheur (`by: 2`) porte une carte : x2.
    expect(perte((id) => (id === 2 ? 1 : 0))).toBeCloseTo(coupSurLourd(2 * REACTION_DAMAGE), 4);
    // Deux cartes : x3 — « +100 % par carte ».
    expect(perte((id) => (id === 2 ? 2 : 0))).toBeCloseTo(coupSurLourd(3 * REACTION_DAMAGE), 4);
    // Le MARQUEUR (`markBy: 1`) la porte : rien ne change.
    expect(perte((id) => (id === 1 ? 1 : 0))).toBeCloseTo(seul, 4);
  });
```

Dans `describe('applyReactions — Eclat de gel ...')` (qui a `trigger(entityId, x, y)` avec
`by: 2`) :

```ts
  it('etape 10 : Echo double aussi une reaction a effet propre (Eclat de gel)', () => {
    const horde = new Horde(10);
    const cible = addOne(horde, 1, 1000, 1000, LOURD);
    horde.hp[horde.slotOf(cible)] = 1000;
    applyReactions(
      horde,
      new OrbField(10),
      0,
      [trigger(cible, 1000, 1000)],
      new ZoneField(),
      new Reactions(),
      (id) => (id === 2 ? 1 : 0),
    );
    const armureDansLaZone = Math.max(0, HEAVY_ARMOR - CHAUX_ARMOR_REDUCTION);
    expect(horde.hp[horde.slotOf(cible)]).toBeCloseTo(
      1000 - 2 * ECLAT_DE_GEL_DAMAGE * (1 - armureDansLaZone),
      5,
    );
  });
```

Dans `back/src/room.test.ts` :

```ts
describe('etape 10 : Echo dans le salon', () => {
  const ARME_GIVRE = WEAPONS.find((w) => w.element === ELEMENT.GIVRE)?.id ?? -1;
  const LOURD = ARCHETYPES.find((a) => a.hp === HEAVY_HP)?.id ?? 0;
  const ECHO = PASSIVES.find((p) => p.kind === 'echo')?.id ?? -1;

  /**
   * Le decor de « annonce la reaction » : le joueur 1 declenche au Givre, le
   * joueur 2 entretient la marque de Braise. Rend la perte de PV de la cible
   * (indestructible) et le nombre de reactions.
   */
  function scene(porteur: number | null): { perte: number; reactions: number } {
    const room = new Room(0xbaa1_5e10);
    room.join(1);
    room.join(2);
    room.grantCard(1, { nature: CARD.WEAPON, refId: ARME_GIVRE });
    if (porteur !== null) {
      room.grantCard(porteur, { nature: CARD.PASSIVE, refId: ECHO });
    }
    const before = positionOf(room, 1);
    const cible = spawnMonsterAt(room, 700, before.x + 100, before.y, LOURD);
    room.horde.hp[room.horde.slotOf(cible)] = 1e6;
    let reactions = 0;
    for (let i = 0; i < 20; i++) {
      room.horde.applyMark(room.horde.slotOf(cible), ELEMENT.BRAISE, 2, room.tick);
      aimAtNearestMonster(room, 1, i + 1);
      room.step(DT);
      reactions += room.drainReactions().length;
    }
    return { perte: 1e6 - (room.horde.hp[room.horde.slotOf(cible)] ?? 0), reactions };
  }

  it('le salon passe Echo au declencheur, jamais au marqueur', () => {
    const sans = scene(null);
    const declencheur = scene(1);
    const marqueur = scene(2);
    expect(sans.reactions).toBeGreaterThan(0);
    expect(declencheur.reactions).toBe(sans.reactions);
    expect(declencheur.perte).toBeGreaterThan(sans.perte);
    expect(marqueur.perte).toBe(sans.perte);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run src/combat.test.ts src/room.test.ts -t "Echo"`
Attendu : ÉCHEC (le septième argument est ignoré, la perte reste simple).

- [ ] **Étape 3 : implémenter**

Dans `back/src/combat.ts`, `applyReactions` : ajouter au docbloc

```ts
 * ⚠️ **Echo (etape 10, §4) : `echoOf(t.by)` cartes doublent, triplent… les
 * degats INSTANTANES de la reaction** — tous ceux que cette fonction inflige,
 * par le balayage, la chaine ou la cible unique. Le DECLENCHEUR (`by`), jamais
 * le marqueur (`markBy`). Les champs poses au sol ne changent pas : ce ne sont
 * pas des degats instantanes. Serveur seul : ce sont des PV, que le serveur
 * arbitre seul — aucun octet de plus.
```

la signature devient

```ts
export function applyReactions(
  horde: Horde,
  orbs: OrbField,
  tick: number,
  triggers: readonly ReactionTrigger[],
  zones: ZoneField,
  reactions: Reactions,
  echoOf: (playerId: number) => number = () => 0,
): number[] {
```

et dans la seconde boucle, juste après `const def = reactionForPair(t.pair);` :

```ts
    const echo = 1 + echoOf(t.by);
```

puis chaque dégât de la boucle est multiplié par `echo` — sept `def.damage` et le
`REACTION_DAMAGE` du `else` :

| Branche | Avant | Après |
| --- | --- | --- |
| `EMBRASEMENT` | `damageInRadius(horde, t.x, t.y, def.radius, def.damage, zones, tick, dead, ELEMENT.POIX);` | `... def.radius, def.damage * echo, zones, ...` |
| `COURT_CIRCUIT` | `chainWhilePoisoned(horde, t, def.damage, zones, tick, dead);` | `chainWhilePoisoned(horde, t, def.damage * echo, zones, tick, dead);` |
| `ECLAT_DE_GEL` | `appliquerDegats(horde, slot, def.damage, zones, tick, dead);` | `appliquerDegats(horde, slot, def.damage * echo, zones, tick, dead);` |
| `VAPORISATION` | `def.radius,` / `def.damage,` (arguments de `damageInRadius`) | `def.radius,` / `def.damage * echo,` |
| `ARC_CAUSTIQUE` | `appliquerDegats(horde, slot, def.damage, zones, tick, dead);` | `appliquerDegats(horde, slot, def.damage * echo, zones, tick, dead);` |
| `PARATONNERRE` | `chainPreferringLinked(horde, t, def.damage, zones, tick, dead);` | `chainPreferringLinked(horde, t, def.damage * echo, zones, tick, dead);` |
| `AMALGAME` | `shareAmalgameDamage(horde, t, def.damage, zones, tick, dead);` | `shareAmalgameDamage(horde, t, def.damage * echo, zones, tick, dead);` |
| `else` | `damageInRadius(horde, t.x, t.y, REACTION_RADIUS, REACTION_DAMAGE, zones, tick, dead);` | `damageInRadius(horde, t.x, t.y, REACTION_RADIUS, REACTION_DAMAGE * echo, zones, tick, dead);` |

Vérifier ensuite qu'il ne reste **aucun** `def.damage` nu dans la boucle de dégâts :
`grep -n "def.damage" back/src/combat.ts` ne doit plus rien rendre entre `const echo` et
`if (dead.size === 0)` hors commentaires.

Dans `back/src/room.ts` l.~1553 :

```ts
    const reactedIds = applyReactions(
      this.horde,
      this.#orbs,
      this.#tick,
      triggers,
      this.#zones,
      this.#reactions,
      // Echo (etape 10) : les reactions que CE joueur declenche.
      (id) => this.#players.get(id)?.loadout.bonus('echo') ?? 0,
    );
```

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run src/combat.test.ts src/room.test.ts`
Attendu : PASS.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write back/src/combat.ts back/src/combat.test.ts back/src/room.ts back/src/room.test.ts
git add back/src/combat.ts back/src/combat.test.ts back/src/room.ts back/src/room.test.ts
git commit -m "feat(back): Echo, les reactions de son porteur frappent deux fois"
```

---

### Tâche 8 : Moisson — chaque mort proche rend un PV

**Fichiers :**
- Modifier : `back/src/combat.ts` (imports l.~1-31, `OrbField` l.~139-221, après `resolveContact` l.~1675), `back/src/room.ts` (import `./combat` l.~85-103, `Room.step` après `this.#regenerate();` l.~1714)
- Tester : `back/src/combat.test.ts`, `back/src/room.test.ts`

**Interfaces :**
- Consomme : genre `'harvest'`, `HARVEST_RADIUS` (tâche 3).
- Produit : `OrbField.drainFallen(): number[]` (positions `x, y` à plat de chaque mort depuis le
  dernier drainage, orbe ou pas) ;
  `interface HarvestPlayer { readonly x: number; readonly y: number; hp: number; readonly maxHp: number; readonly loadout: Pick<Loadout, 'bonus'> }` ;
  `resolveHarvest(players: Iterable<HarvestPlayer>, fallen: readonly number[]): void`.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `back/src/combat.test.ts` (importer `resolveHarvest`, `type HarvestPlayer` depuis
`./combat`, `HARVEST_RADIUS` depuis `@shared/constants`, `Loadout` depuis `@shared/loadout`,
`PASSIVES` depuis `@shared/passives`) :

```ts
describe('etape 10 : Moisson (resolveHarvest)', () => {
  const MOISSON = PASSIVES.find((p) => p.kind === 'harvest')?.id ?? -1;

  function porteur(hp: number, cartes = 1): HarvestPlayer {
    const loadout = new Loadout();
    for (let i = 0; i < cartes; i++) {
      loadout.addPassive(MOISSON);
    }
    return { x: 1000, y: 1000, hp, maxHp: 100, loadout };
  }

  it('une mort a 299 px soigne d 1 PV, a 301 px non', () => {
    expect(HARVEST_RADIUS).toBe(300);
    const pres = porteur(50);
    resolveHarvest([pres], [1299, 1000]);
    expect(pres.hp).toBe(51);
    const loin = porteur(50);
    resolveHarvest([loin], [1301, 1000]);
    expect(loin.hp).toBe(50);
  });

  it('les morts d un tick s additionnent, et chaque carte compte', () => {
    const p = porteur(50, 2);
    resolveHarvest([p], [1000, 1000, 1100, 1000, 1000, 1200]);
    expect(p.hp).toBe(56);
  });

  it('jamais au-dela du PV max', () => {
    const p = porteur(99.5);
    resolveHarvest([p], [1000, 1000, 1010, 1000, 1020, 1000]);
    expect(p.hp).toBe(100);
  });

  it('un joueur a terre ne se releve pas', () => {
    const p = porteur(0);
    resolveHarvest([p], [1000, 1000]);
    expect(p.hp).toBe(0);
  });

  it('sans Moisson, rien', () => {
    const p = porteur(50, 0);
    resolveHarvest([p], [1000, 1000]);
    expect(p.hp).toBe(50);
  });
});

describe('etape 10 : OrbField note CHAQUE mort, orbe ou pas', () => {
  it('drainFallen rend toutes les positions, puis se vide', () => {
    const orbs = new OrbField(10);
    const sansButin = Array.from({ length: 50 }, (_, i) => entityIdOf(1, i)).find(
      (id) => !leavesDrop(id),
    );
    if (sansButin === undefined) {
      throw new Error('fixture : aucune identite sans butin');
    }
    orbs.spawn(entityIdOf(1, 0), 10, 20);
    orbs.spawn(sansButin, 30, 40);
    // Moisson compte les morts, pas les orbes : celle qui ne laisse rien compte.
    expect(orbs.drainFallen()).toEqual([10, 20, 30, 40]);
    expect(orbs.drainFallen()).toEqual([]);
  });
});
```

Dans `back/src/room.test.ts` :

```ts
describe('etape 10 : Moisson dans le salon', () => {
  const MOISSON = PASSIVES.find((p) => p.kind === 'harvest')?.id ?? -1;

  /**
   * Blesse le joueur au contact, puis fait tuer par sa dague une proie a 100
   * px. Rend ses PV. Deux salons identiques a la carte pres : l'ecart EST ce
   * que Moisson a rendu.
   */
  function pvApresUneMort(avecMoisson: boolean): number {
    const room = new Room(0x10_0a_0801);
    room.join(1);
    const depart = positionOf(room, 1);
    const contact = spawnMonsterAt(room, 700, depart.x, depart.y);
    for (let t = 0; t < 20; t++) {
      room.step(DT);
    }
    // Retire HORS du chemin des morts : ce monstre-ci ne doit rien rendre.
    room.horde.kill([contact]);
    if (avecMoisson) {
      room.grantCard(1, { nature: CARD.PASSIVE, refId: MOISSON });
    }
    const pos = positionOf(room, 1);
    const proie = spawnMonsterAt(room, 701, pos.x + 100, pos.y);
    room.horde.hp[room.horde.slotOf(proie)] = 0.01;
    room.applyInput(1, 1, 0, 0, 127, 0);
    for (let t = 0; t < 30 && room.horde.slotOf(proie) >= 0; t++) {
      room.step(DT);
    }
    expect(room.horde.slotOf(proie)).toBe(-1);
    return hpOf(room, 1);
  }

  it('une mort a 100 px rend exactement 1 PV a qui porte Moisson', () => {
    const sans = pvApresUneMort(false);
    expect(sans).toBeLessThan(PLAYER_MAX_HP - 1);
    expect(pvApresUneMort(true) - sans).toBe(1);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run src/combat.test.ts src/room.test.ts -t "Moisson|CHAQUE mort"`
Attendu : ÉCHEC (`resolveHarvest`, `drainFallen` inexistants ; écart 0).

- [ ] **Étape 3 : implémenter**

Dans `back/src/combat.ts` : importer `HARVEST_RADIUS` avec les constantes et
`import type { Loadout } from '@shared/loadout';`.

Dans `OrbField`, après `truncatedOrbs = 0;` :

```ts
  /**
   * La position (x, y, a plat) de CHAQUE mort depuis le dernier
   * `drainFallen`, qu'elle laisse un orbe ou non — pour Moisson (etape 10).
   *
   * ⚠️ **Ici parce que c'est le seul goulot qui voit chaque mort AVEC sa
   * position** : les huit chemins de mort de ce fichier appellent `spawn`
   * juste avant `horde.kill`, et une fois `kill` passe la horde est compactee
   * — `Room.step` ne connait plus que des identites. `Room.step` vide la file
   * a chaque tick.
   */
  #fallen: number[] = [];

  drainFallen(): number[] {
    const out = this.#fallen;
    this.#fallen = [];
    return out;
  }
```

et `spawn` commence par :

```ts
  spawn(entityId: number, x: number, y: number): void {
    // AVANT la garde du butin : Moisson compte les morts, pas les orbes.
    this.#fallen.push(x, y);
    if (!leavesDrop(entityId)) {
```

Après `resolveContact` :

```ts
/** Ce que Moisson lit d'un joueur — `PlayerState` le satisfait tel quel. */
export interface HarvestPlayer {
  readonly x: number;
  readonly y: number;
  hp: number;
  readonly maxHp: number;
  readonly loadout: Pick<Loadout, 'bonus'>;
}

/**
 * Moisson (etape 10, §4) : chaque ennemi mort a MOINS de `HARVEST_RADIUS` du
 * porteur lui rend `bonus('harvest')` PV, borne par son PV max.
 *
 * ⚠️ **Cooperative par construction** : le serveur n'attribue pas les morts a
 * un tueur, la proximite evite d'avoir a le faire — un allie qui tue pres de
 * toi te soigne aussi.
 *
 * ⚠️ **Un joueur a terre ne se releve pas**, meme garde que `#regenerate` :
 * sans elle, `#checkRunOver` verrait la run repartir.
 */
export function resolveHarvest(players: Iterable<HarvestPlayer>, fallen: readonly number[]): void {
  const r2 = HARVEST_RADIUS * HARVEST_RADIUS;
  for (const p of players) {
    if (p.hp <= 0) {
      continue;
    }
    const parMort = p.loadout.bonus('harvest');
    let gain = 0;
    for (let i = 0; i + 1 < fallen.length; i += 2) {
      const dx = (fallen[i] ?? 0) - p.x;
      const dy = (fallen[i + 1] ?? 0) - p.y;
      if (dx * dx + dy * dy < r2) {
        gain += parMort;
      }
    }
    p.hp = Math.min(p.maxHp, p.hp + gain);
  }
}
```

Dans `back/src/room.ts` : ajouter `resolveHarvest` à l'import de `./combat`, puis juste après
`this.#regenerate();` dans `step` :

```ts
    // Moisson (etape 10) : les morts de CE tick, ou qu'elles viennent. Vide a
    // chaque tick, porteur ou pas : la file ne doit jamais s'accumuler.
    resolveHarvest(this.#players.values(), this.#orbs.drainFallen());
```

- [ ] **Étape 4 : les relancer, ils passent**

Run : `npm run typecheck -w back`
Run : `cd back && npx vitest run src/combat.test.ts src/room.test.ts`
Attendu : PASS.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write back/src/combat.ts back/src/combat.test.ts back/src/room.ts back/src/room.test.ts
git add back/src/combat.ts back/src/combat.test.ts back/src/room.ts back/src/room.test.ts
git commit -m "feat(back): Moisson, chaque mort a moins de 300 px rend un PV"
```

---

### Tâche 9 : l'étalage montre la rareté — bordure, reflet, étiquette

**Fichiers :**
- Modifier : `front/src/ui/draft.ts` (imports l.1-23, après `natureLabel` l.~198, `#build` l.~385-420), `front/src/styles/main.css` (avant `.draft-card[data-state="taken"]` l.~1081)
- Tester : `front/src/ui/draft.test.ts`

**Interfaces :**
- Consomme : `applicationsOf`, `isLegendaryOnly` (tâches 1, 3), `normalizeRarity`, `RARITY` (tâche 1).
- Produit : `rarityLabel(card: Card): string` ; chaque `.draft-card` porte
  `data-rarity="0|1|2"` et un `.draft-card__rarity`.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `front/src/ui/draft.test.ts` (importer `rarityLabel` depuis `./draft`, `RARITY` depuis
`@shared/rarity`) :

```ts
describe('etape 10 : la rarete a l ecran', () => {
  const LEGENDAIRE = PASSIVES.find((p) => p.legendary);
  if (!LEGENDAIRE) {
    throw new Error('fixture : aucun passif legendaire');
  }

  it('rarityLabel : rien pour une commune, le multiplicateur pour rare et legendaire', () => {
    expect(rarityLabel({ nature: CARD.PASSIVE, refId: 1 })).toBe('');
    expect(rarityLabel({ nature: CARD.PASSIVE, refId: 1, rarity: RARITY.RARE })).toBe('Rare ×2');
    expect(rarityLabel({ nature: CARD.WEAPON, refId: 2, rarity: RARITY.LEGENDAIRE })).toBe(
      'Légendaire ×3',
    );
  });

  it('un passif exclusivement legendaire se dit « Légendaire », sans x3 : il s applique une fois', () => {
    expect(
      rarityLabel({ nature: CARD.PASSIVE, refId: LEGENDAIRE.id, rarity: RARITY.LEGENDAIRE }),
    ).toBe('Légendaire');
    // Et s'il arrive avec une autre rarete, il ne promet rien de plus.
    expect(rarityLabel({ nature: CARD.PASSIVE, refId: LEGENDAIRE.id, rarity: RARITY.RARE })).toBe(
      'Rare',
    );
  });

  it('une rarete inconnue venue du fil se lit commune', () => {
    expect(rarityLabel({ nature: CARD.PASSIVE, refId: 1, rarity: 200 })).toBe('');
  });

  it('chaque carte porte sa rarete en data-rarity, et son etiquette', () => {
    const h = harness();
    h.client.draftCards = [
      { nature: CARD.WEAPON, refId: 1 },
      { nature: CARD.PASSIVE, refId: 1, rarity: RARITY.RARE },
      { nature: CARD.WEAPON, refId: 3, rarity: RARITY.LEGENDAIRE },
      { nature: CARD.WEAPON, refId: 2, rarity: 200 },
    ];
    h.screen.update();
    expect(cards(h).map((c) => c.dataset.rarity)).toEqual(['0', '1', '2', '0']);
    expect(cards(h).map((c) => c.querySelector('.draft-card__rarity')?.textContent)).toEqual([
      '',
      'Rare ×2',
      'Légendaire ×3',
      '',
    ]);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/ui/draft.test.ts -t "etape 10 : la rarete"`
Attendu : ÉCHEC (`rarityLabel` non exporté).

- [ ] **Étape 3 : implémenter**

Dans `front/src/ui/draft.ts` : `import { applicationsOf, CARD, type Card } from '@shared/cards';`
et `import { normalizeRarity, RARITY } from '@shared/rarity';`. Après `natureLabel` :

```ts
/** Le nom de chaque rarete, dans l'ordre de `RARITY`. */
const RARITY_NAMES = ['Commune', 'Rare', 'Légendaire'] as const;

/**
 * L'etiquette de rarete (etape 10, §2.5) : le nom ET ce que la carte vaut
 * vraiment — « Rare ×2 », « Légendaire ×3 ».
 *
 * ⚠️ **Le multiplicateur vient de `applicationsOf`, jamais de la table des
 * raretes** : un passif exclusivement legendaire s'applique x1, et lui
 * ecrire « ×3 » serait promettre trois cartes qu'il ne donne pas.
 *
 * Vide pour une commune : la bordure grise dit deja tout.
 */
export function rarityLabel(card: Card): string {
  const rarity = normalizeRarity(card.rarity);
  if (rarity === RARITY.COMMUNE) {
    return '';
  }
  const nom = RARITY_NAMES[rarity] ?? '';
  const fois = applicationsOf(card);
  return fois > 1 ? `${nom} ×${fois}` : nom;
}
```

Dans `#build`, juste après `root.dataset.index = \`${index}\`;` :

```ts
      // La rarete (etape 10) : la bordure et le reflet se lisent en CSS.
      root.dataset.rarity = `${normalizeRarity(card.rarity)}`;
```

et, avant `const nature = ...` :

```ts
      const rarete = document.createElement('span');
      rarete.className = 'draft-card__rarity ol';
      rarete.textContent = rarityLabel(card);
```

puis `root.append(tokens, frame, rarete, nature, name, stacks, detail);`.

Dans `front/src/styles/main.css`, juste **avant** `.draft-card[data-state="taken"]` :

```css
  /* La rarete (etape 10, §2.5) : gris, bleu, or. Declaree AVANT les etats :
     l'illumination et la consomption d'une carte gagnee ou perdue portent la
     meme propriete `animation` que le reflet legendaire, et doivent primer. */
  .draft-card[data-rarity="0"] {
    box-shadow: 0 0 0 5px #8f8f8f;
  }

  .draft-card[data-rarity="1"] {
    box-shadow: 0 0 0 5px #4a8fe0;
  }

  .draft-card[data-rarity="2"] {
    box-shadow: 0 0 0 5px #e8b830;
    animation: draft-legendaire 1800ms ease-in-out infinite;
  }

  .draft-card__rarity {
    min-height: 1em;
    font-family: var(--font-jer);
    font-size: 26px;
    letter-spacing: 2px;
    text-transform: uppercase;
  }

  .draft-card[data-rarity="1"] .draft-card__rarity {
    color: #4a8fe0;
  }

  .draft-card[data-rarity="2"] .draft-card__rarity {
    color: #e8b830;
  }

  @keyframes draft-legendaire {
    50% {
      box-shadow:
        0 0 0 5px #f5d76e,
        0 0 26px 6px rgb(245 215 110 / 0.75);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .draft-card[data-rarity="2"] {
      animation: none;
    }
  }
```

- [ ] **Étape 4 : les relancer, ils passent**

Run : `npm run typecheck -w front && cd front && npx vitest run src/ui/draft.test.ts`
Attendu : PASS.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/ui/draft.ts front/src/ui/draft.test.ts front/src/styles/main.css
git add front/src/ui/draft.ts front/src/ui/draft.test.ts front/src/styles/main.css
git commit -m "feat(front): l etalage montre la rarete, gris, bleu, or"
```

---

### Tâche 10 : le livrable — une carte rare sur vraies sockets

**Fichiers :**
- Créer : `back/src/rarete.integration.test.ts`

**Interfaces :**
- Consomme : tout ce qui précède ; `buildServer({ roomSeed })`, `app.rooms`, `createAccount`,
  `prisma` (comme `draft.integration.test.ts`, dont le harnais est **recopié** : aucun fichier
  d'intégration n'importe un autre).

- [ ] **Étape 1 : écrire le test**

`back/src/rarete.integration.test.ts` :

```ts
import type { AddressInfo } from 'node:net';
import { applicationsOf, applyCardToLoadout, CARD, type Card } from '@shared/cards';
import { ORB_PICKUP_RADIUS, SPREAD_BONUS } from '@shared/constants';
import { Loadout } from '@shared/loadout';
import {
  decode,
  encodeDraftToken,
  encodeHello,
  encodeInput,
  type Message,
  MSG,
  OUTCOME,
  type SnapshotMessage,
} from '@shared/protocol';
import { RARITY } from '@shared/rarity';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { BASE_WEAPON_ID } from '@shared/weapons';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, prisma } from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

/**
 * Le livrable de l'etape 10 (§1 et §6 de la spec) : **sur vraies sockets, une
 * carte rare prise donne exactement deux exemplaires dans l'inventaire
 * arbitre par le salon, et le client en tient le meme miroir ; aucun octet de
 * plus par tick.**
 *
 * ⚠️ **La rarete est FORCEE par `vi.mock`, pas par un crochet de production.**
 * Vitest moque par chemin RESOLU : `@shared/rarity` ici et `./rarity` dans
 * `shared/cards.ts` designent le meme fichier, donc le `drawSpread` du salon
 * tire rare a chaque emplacement. Le test le VERIFIE sur le fil avant tout le
 * reste — un mock qui n'atteindrait pas le serveur ferait passer le reste pour
 * une commune.
 *
 * ⚠️ **« Le miroir decode par le client »** est reconstitue exactement comme
 * `GameClient#applyDraftOutcomes` le fait : les cartes du `DRAFT_OPEN` DECODE,
 * les issues du `DRAFT_RESULT` DECODE, `applyCardToLoadout`. Le `GameClient`
 * lui-meme est couvert par `front/src/net/client.test.ts`.
 *
 * Un seul joueur : en solo, la fenetre se ferme au jeton pose, sans attendre
 * les vingt secondes de l'echeance.
 */
vi.mock('@shared/rarity', async (importOriginal) => {
  const reel = await importOriginal<typeof import('@shared/rarity')>();
  return { ...reel, rollRarity: () => reel.RARITY.RARE };
});

/** Graine imposee au salon : ce test ne doit rien devoir au hasard. */
const ROOM_SEED = 0x0a7e_7e10;
const RING_SIZE = 10;
/** Sous `ORB_PICKUP_RADIUS`, sinon l'experience ne monte jamais (voir `draft.integration.test.ts`). */
const RING_RADIUS = 80;
if (RING_RADIUS >= ORB_PICKUP_RADIUS) {
  throw new Error("l'anneau doit rester dans le rayon de ramassage des orbes");
}

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  /** Tout ce qui est arrive sur CETTE socket, hors snapshots. */
  received: Message[];
  /** La taille BRUTE de chaque `DRAFT_OPEN` recu, en octets. */
  draftOpenBytes: number[];
  seq: number;
}

let app: App;
let port: number;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  await prisma.account.deleteMany();
  app = await buildServer({ roomSeed: ROOM_SEED });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const ws of openSockets.splice(0)) {
    ws.close();
  }
  await app.close();
});

async function createRoomCode(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/rooms' });
  return res.json<{ code: string }>().code;
}

async function connect(code: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  openSockets.push(ws);
  // L'ecoute de 'open' AVANT tout `await` (voir `draft.integration.test.ts`).
  const ouverte = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const client: Client = { ws, playerId: 0, received: [], draftOpenBytes: [], seq: 0 };
  ws.on('message', (data: ArrayBuffer) => {
    const msg = decode(data);
    if (msg.type === MSG.WELCOME) {
      client.playerId = msg.playerId;
    }
    if (msg.type === MSG.DRAFT_OPEN) {
      client.draftOpenBytes.push(data.byteLength);
    }
    if (msg.type !== MSG.SNAPSHOT) {
      client.received.push(msg);
    }
  });
  const { token } = await createAccount();
  await ouverte;
  ws.send(encodeHello(token));
  await waitFor(() => (client.playerId !== 0 ? client.playerId : null), 'WELCOME', 3000);
  return client;
}

async function waitFor<T>(probe: () => T | null, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`${what} : rien en ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 8));
  }
}

function firstSnapshot(ws: WebSocket): Promise<SnapshotMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('aucun snapshot en 3000 ms'));
    }, 3000);
    function cleanup(): void {
      clearTimeout(timer);
      ws.off('message', onMessage);
    }
    function onMessage(data: ArrayBuffer): void {
      const msg = decode(data);
      if (msg.type === MSG.SNAPSHOT && msg.players.length === 1) {
        cleanup();
        resolve(msg);
      }
    }
    ws.on('message', onMessage);
  });
}

function spawnMonsterAt(room: Room, waveId: number, x: number, y: number): void {
  const order: WaveOrder = {
    waveId,
    spawnTick: room.tick,
    seed: 1,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: x,
    anchorY: y,
    count: 1,
  };
  room.horde.spawn(order);
  const slot = room.horde.count - 1;
  room.horde.x[slot] = x;
  room.horde.y[slot] = y;
}

/** Un anneau de monstres renouvele, et la visee sur le plus proche, PAR LA SOCKET. */
function startCombatDriver(room: Room, pos: { x: number; y: number }, client: Client): () => void {
  let waveId = 9000;
  const refill = (): void => {
    for (let i = 0; i < RING_SIZE; i++) {
      const angle = (i / RING_SIZE) * Math.PI * 2;
      spawnMonsterAt(
        room,
        waveId++,
        pos.x + Math.cos(angle) * RING_RADIUS,
        pos.y + Math.sin(angle) * RING_RADIUS,
      );
    }
  };
  const timer = setInterval(() => {
    if (room.horde.count === 0) {
      refill();
    }
    let bestDist2 = Number.POSITIVE_INFINITY;
    let bestSlot = -1;
    for (let i = 0; i < room.horde.count; i++) {
      const dx = (room.horde.x[i] ?? 0) - pos.x;
      const dy = (room.horde.y[i] ?? 0) - pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        bestSlot = i;
      }
    }
    if (bestSlot < 0) {
      return;
    }
    const dx = (room.horde.x[bestSlot] ?? 0) - pos.x;
    const dy = (room.horde.y[bestSlot] ?? 0) - pos.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) {
      return;
    }
    client.seq++;
    client.ws.send(
      encodeInput(client.seq, 0, 0, Math.round((dx / len) * 127), Math.round((dy / len) * 127)),
    );
  }, 10);
  refill();
  return () => {
    clearInterval(timer);
  };
}

/** Exemplaires possedes de la chose que porte cette carte. */
function possede(l: Loadout, c: Card): number {
  return c.nature === CARD.PASSIVE ? l.stacksOf(c.refId) : l.stacksOfWeapon(c.refId);
}

describe('etape 10 : une carte rare vaut deux cartes, sur vraies sockets (le livrable)', () => {
  it('la rare prise donne 2 exemplaires au salon ET au miroir decode, un octet par carte et rien par tick', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('le registre de salons doit etre accessible depuis l app');
    }
    const a = await connect(code);
    const snap = await firstSnapshot(a.ws);
    const moi = snap.players.find((p) => p.id === a.playerId);
    if (!moi) {
      throw new Error('le joueur est absent du snapshot');
    }

    const stop = startCombatDriver(room, { x: moi.x, y: moi.y }, a);
    const open = await waitFor(
      () => a.received.find((m) => m.type === MSG.DRAFT_OPEN) ?? null,
      'DRAFT_OPEN',
      20_000,
    );
    stop();
    if (open.type !== MSG.DRAFT_OPEN) {
      throw new Error('DRAFT_OPEN attendu');
    }

    // ---- 1. La rarete forcee a bien atteint le salon, et le fil ----------
    expect(open.cards).toHaveLength(1 + SPREAD_BONUS);
    expect(open.cards.every((c) => c.rarity === RARITY.RARE)).toBe(true);

    // ---- 2. Un octet par carte, et rien d'autre : 6 + 4 x 4 = 22 ---------
    // ⚠️ Nu, jamais recalcule avec `DRAFT_CARD_BYTES` : une constante qui
    // mentirait mentirait aux deux cotes de l'egalite.
    expect(a.draftOpenBytes[0]).toBe(22);

    // ---- 3. On prend une carte que le joueur ne possede PAS ---------------
    const serveur = room.loadoutOf(a.playerId);
    if (!serveur) {
      throw new Error('inventaire du salon absent');
    }
    const index = open.cards.findIndex((c) => possede(serveur, c) === 0);
    const carte = open.cards[index];
    if (!carte) {
      throw new Error('aucune carte nouvelle dans l etalage');
    }
    expect(applicationsOf(carte)).toBe(2);
    a.ws.send(encodeDraftToken(index));

    const result = await waitFor(
      () => a.received.find((m) => m.type === MSG.DRAFT_RESULT) ?? null,
      'DRAFT_RESULT',
      5000,
    );
    if (result.type !== MSG.DRAFT_RESULT) {
      throw new Error('DRAFT_RESULT attendu');
    }
    const issue = result.outcomes.find((o) => o.playerId === a.playerId);
    expect(issue?.cardIndex).toBe(index);
    expect(issue?.outcome).toBe(OUTCOME.WON);

    // ---- 4. Le salon : exactement deux exemplaires ------------------------
    expect(possede(serveur, carte)).toBe(2);
    if (carte.nature === CARD.WEAPON) {
      // Une arme : l'acquisition, plus UN cran de son aspect.
      expect(serveur.upgradesOf(carte.refId, carte.upgrade ?? -1)).toBe(1);
      expect(serveur.weaponSlotsUsed).toBe(2);
    }

    // ---- 5. Le miroir decode : le meme chemin que `#applyDraftOutcomes` ---
    const miroir = new Loadout();
    miroir.addWeapon(BASE_WEAPON_ID);
    for (const o of result.outcomes) {
      if (o.outcome === OUTCOME.LOST) {
        continue;
      }
      const c = open.cards[o.cardIndex];
      if (c) {
        applyCardToLoadout(miroir, c);
      }
    }
    expect(possede(miroir, carte)).toBe(2);
    if (carte.nature === CARD.WEAPON) {
      expect(miroir.upgradesOf(carte.refId, carte.upgrade ?? -1)).toBe(1);
    }
  }, 60_000);
});
```

- [ ] **Étape 2 : le lancer, il passe**

Run : `cd back && npx vitest run src/rarete.integration.test.ts`
Attendu : PASS. Puis **contre-épreuve** : remplacer temporairement `RARITY.RARE` par
`RARITY.COMMUNE` dans le `vi.mock` → le test doit rougir à l'étape 1 (`every(... RARE)`) ; et,
la valeur remise, remplacer temporairement la boucle de `applyCardToLoadout` par une seule
application → il doit rougir à l'étape 4. Annuler les deux mutations (`git diff` vide hors du
nouveau fichier).

- [ ] **Étape 3 : commit**

```bash
npx biome check --write back/src/rarete.integration.test.ts
git add back/src/rarete.integration.test.ts
git commit -m "test(back): le livrable, une carte rare sur vraies sockets vaut deux cartes"
```

---

### Tâche 11 : le portique et le bilan (contrôleur, seul)

**Fichiers :**
- Créer : `docs/plans/2026-10-15-etape-10-resultats.md`
- Modifier : `README.md` (ligne de l'étape 10, l.33)

- [ ] **Étape 1 : le portique complet, rien d'autre en vol**

Run : `npm run lint && npm run typecheck && npm test`
Attendu : tout vert. Noter le nombre de tests front et back **de cette exécution seule**.

- [ ] **Étape 2 : mettre le graphe à jour**

Run : `graphify update .`

- [ ] **Étape 3 : écrire le bilan**

`docs/plans/2026-10-15-etape-10-resultats.md`, sur le modèle de
`2026-10-15-etape-9-resultats.md` : livré, nombre de tests (de l'étape 1), coût sur le fil
(`DRAFT_CARD_BYTES` 3 → 4, `DRAFT_OPEN` 21 → 26 octets à deux joueurs, **zéro octet par tick**),
les sept écarts assumés de ce plan (dont le critique du client qui tirait avec `by = 0`, corrigé),
et la section **« Vérification manuelle — ouverte »** avec les quatre points du §6 de la spec :

- la rareté se lit-elle d'un coup d'œil dans l'étalage ?
- 82 / 15 / 3 : les légendaires sont-elles assez rares pour être un événement, assez fréquentes
  pour être vues ?
- Volée à +1 cran par carte commune : jusqu'où l'écran tient-il (lisibilité, et budget de
  projectiles — `truncatedProjectiles`) ?
- un build Précision + Férocité devient-il trop dominant ?

Plus les risques du §7 à surveiller : Colosse qui convertit les achats de vitalité en dégâts, et
le draft auto qui ne regarde pas la rareté.

- [ ] **Étape 4 : le README**

Ligne de l'étape 10 : ajouter `· [plan](docs/plans/2026-10-15-etape-10-rarete.md) · [résultats](docs/plans/2026-10-15-etape-10-resultats.md)`.

- [ ] **Étape 5 : commit**

```bash
git add docs/plans/2026-10-15-etape-10-resultats.md README.md
git commit -m "docs: le bilan de l etape 10"
```

---
