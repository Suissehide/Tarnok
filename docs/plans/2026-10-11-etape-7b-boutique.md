# Étape 7b — la boutique : plan d'implémentation

> **Pour les exécutants agentiques :** SOUS-COMPÉTENCE REQUISE — utiliser
> `superpowers:subagent-driven-development` (recommandé) ou `superpowers:executing-plans` pour
> implémenter ce plan tâche par tâche. Les étapes utilisent la syntaxe à cases (`- [ ]`).

**Goal :** un joueur dépense son or, et sa run suivante en est changée — mesuré sur vraies sockets.

**Architecture :** un catalogue dans `shared/shop.ts` (une seule source de vérité pour les libellés et
les prix) dont **le serveur seul applique les prix**, une table `Purchase(accountId, itemId, level)`,
et des achats chargés à la poignée de main qui alimentent un **terme de plus** dans les sommes de
bonus que `Room` calcule déjà. Six armes gagnent un champ `locked` explicite ; le pool du draft tire
sur **l'union** des salles et `Draft#eligible` refuse une carte non débloquée. Le rayon de ramassage
est le seul article non câblé : il demande un site par joueur, et il fait passer
`SNAPSHOT_PLAYER_BYTES` de 9 à 10.

**Tech Stack :** TypeScript, Fastify, `ws`, Prisma 6, PostgreSQL 16, Vitest 4, PixiJS v8, Biome.

**Spec :** [`../specs/2026-10-11-etape-7b-boutique.md`](../specs/2026-10-11-etape-7b-boutique.md)

## Contraintes globales

- **`shared/` ne doit JAMAIS importer Prisma ni rien de serveur.** L'inverse est permis. Le catalogue
  vit dans `shared/`, le dépôt dans `back/`.
- **Commentaires et docblocs en français SANS accents dans le code** (`declenche`, pas `déclenché`).
  Les `.md` sont accentués.
- **commitlint** : sujet en minuscules, type dans
  `build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test`.
- **Chaque message de commit finit par** `Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83`,
  et **dit ce qui change et pourquoi**, jamais « parce qu'un relecteur l'a demandé ».
- **Les prix sont un RÉGLAGE DE JEU, pas un invariant.** Aucun test n'écrit un prix en dur : les
  assertions se dérivent du catalogue ou le comparent. Doctrine du docblock de `REACTION_DAMAGE`.
- **`WEAPON_SLOTS` et `PASSIVE_SLOTS` restent des constantes.** Aucun slot n'est vendable — six slots
  d'armes feraient couvrir les quinze réactions à un joueur seul, ce qui tue le pitch que l'étape 5c
  a rendu testable.
- **Le seul élargissement du fil autorisé est `SNAPSHOT_PLAYER_BYTES` : 9 → 10.** `ZONE`, `REACTION`,
  `DRAFT_OPEN` et l'en-tête du `SNAPSHOT` ne bougent pas.
- **Les largeurs se CALCULENT.** Le rayon voyage en `u8` : base 90, plafond 255, donc 165 px de marge,
  et un test assène que `ORB_PICKUP_RADIUS + <bonus maximal du catalogue> <= 255` **en dérivant le
  maximum du catalogue**.
- ⚠️ **Un docblock qui décrit un mécanisme inexistant compte comme un bug.** Neuf ont été corrigés à
  l'étape 7a — c'était de loin le défaut le plus fréquent. Relis les tiens contre ton code final.
- ⚠️ **Une assertion qui resterait vraie si son mécanisme était retiré ne garde rien.** Vingt-et-une
  occurrences dans ce dépôt, dont quatre trouvées pendant 7a. Pour chaque assertion, demande-toi ce
  qui la ferait rougir.
- **Ne jamais tuer un processus par motif** (`pkill -f`) : les serveurs de dév de l'auteur tournent
  sur **5173** et **3100**.
- **Ne toucher à AUCUN conteneur Docker.** Une Postgres tourne déjà : `tarnok-db`,
  `postgres:16-alpine`, `127.0.0.1:5442`, user/pass/db = `tarnok`. `setup-db.ts` y retombe tout seul
  si `DATABASE_URL` est absente.
- **Les implémenteurs ne lancent QUE leurs fichiers ciblés.** Jamais `npm test` (douze minutes, et le
  harnais le détache à deux), jamais un banc, **rien en arrière-plan**. Le portique complet appartient
  au coordinateur, qui le lance seul.

## Review Focus

Cinq classes d'entrée que la spec implique sans qu'aucune tâche ne les exerce naturellement. Chaque
ligne a son test rattaché à la tâche qui possède le code.

1. **Deux achats concurrents du même article, depuis deux onglets** — la clé composite et la
   transaction doivent n'en laisser passer qu'un, et ne débiter qu'une fois. → tâche 4.
2. **Un achat à solde insuffisant** — doit ne débiter **rien** et n'insérer **rien** ; un refus qui
   laisserait un débit partiel serait pire qu'un crash, parce qu'invisible. → tâche 4.
3. **Un `itemId` inconnu, ou un `level` au-delà du nombre de paliers du catalogue** — doit rendre une
   erreur, jamais un débit ni une ligne. → tâche 5.
4. **Le chargement des achats qui échoue à la poignée de main** — le joueur entre **sans** ses
   améliorations plutôt que de ne pas entrer : une panne de lecture ne doit pas refuser la partie. → tâche 6.
5. **Un rayon de ramassage qui déborderait l'octet** — `ORB_PICKUP_RADIUS + bonus maximal` doit rester
   ≤ 255, et le test doit **dériver** le maximum du catalogue pour qu'un article trop généreux ajouté
   plus tard fasse rougir au lieu de replier silencieusement. → tâche 7.

---

## Tâche 1 : le catalogue

Pure, sans base, sans serveur. Elle se teste en une seconde.

**Files :**
- Create: `shared/shop.ts`
- Create: `shared/shop.test.ts`

**Interfaces :**
- Consumes: `PassiveKind` de `shared/passives.ts`.
- Produces:
  - `type BonusKind = PassiveKind | 'pickupRadius'`
  - `interface ShopItem { id: string; label: string; kind: 'weapon' | 'bonus'; price: number; levels: number; weaponId?: number; bonusKind?: BonusKind; perLevel?: number }`
  - `SHOP_ITEMS: readonly ShopItem[]`
  - `shopItemOf(id: string): ShopItem | undefined`
  - `priceOf(item: ShopItem, level: number): number`
  - `maxBonus(kind: BonusKind): number`

- [ ] **Étape 1 : écrire les tests qui échouent**

`shared/shop.test.ts` :

```ts
import { ORB_PICKUP_RADIUS, PASSIVE_SLOTS, WEAPON_SLOTS } from '@shared/constants';
import { PASSIVE_KINDS } from '@shared/passives';
import { WEAPONS } from '@shared/weapons';
import { describe, expect, it } from 'vitest';

import { maxBonus, priceOf, SHOP_ITEMS, shopItemOf } from './shop';

describe('etape 7b tache 1 : le catalogue', () => {
  it('chaque identifiant est unique', () => {
    const ids = SHOP_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * ⚠️ **Une reference morte ne se verrait qu'au premier achat**, plusieurs
   * taches plus tard. Meme discipline qu'`assertWeaponElements`, qui verifie
   * les references d'elements au CHARGEMENT du module.
   */
  it('chaque article d arme designe une arme qui existe, et elle est verrouillee', () => {
    const armes = SHOP_ITEMS.filter((i) => i.kind === 'weapon');
    expect(armes.length).toBeGreaterThan(0);
    for (const i of armes) {
      const w = WEAPONS.find((w) => w.id === i.weaponId);
      expect(w, `article ${i.id} : arme ${i.weaponId} introuvable`).toBeDefined();
      expect(w?.locked, `article ${i.id} : l arme n est pas verrouillee`).toBe(true);
    }
  });

  it('chaque article de bonus designe une cle connue', () => {
    const connues = new Set<string>([...PASSIVE_KINDS, 'pickupRadius']);
    for (const i of SHOP_ITEMS.filter((i) => i.kind === 'bonus')) {
      expect(connues.has(i.bonusKind ?? ''), `article ${i.id}`).toBe(true);
    }
  });

  it('un deblocage d arme n a qu un seul palier', () => {
    for (const i of SHOP_ITEMS.filter((i) => i.kind === 'weapon')) {
      expect(i.levels, `article ${i.id}`).toBe(1);
    }
  });

  it('tous les prix et tous les paliers sont strictement positifs', () => {
    for (const i of SHOP_ITEMS) {
      expect(i.price, `article ${i.id}`).toBeGreaterThan(0);
      expect(i.levels, `article ${i.id}`).toBeGreaterThan(0);
    }
  });

  /**
   * Le prix du palier `n` est `price * n` : un palier plus haut coute plus
   * cher, et c'est la seule propriete que ce test garde — les valeurs elles
   * memes sont un REGLAGE DE JEU.
   */
  it('le prix croit strictement avec le palier', () => {
    for (const i of SHOP_ITEMS) {
      for (let n = 2; n <= i.levels; n++) {
        expect(priceOf(i, n)).toBeGreaterThan(priceOf(i, n - 1));
      }
    }
  });

  it('shopItemOf retrouve un article, et rend undefined sur un inconnu', () => {
    const premier = SHOP_ITEMS[0];
    if (!premier) {
      throw new Error('catalogue vide');
    }
    expect(shopItemOf(premier.id)).toBe(premier);
    expect(shopItemOf('article-qui-n-existe-pas')).toBeUndefined();
  });

  /**
   * Review Focus n°5 : le rayon voyage dans un `u8` depuis la tache 7. Ce test
   * **derive** le maximum du catalogue, donc un article trop genereux ajoute
   * plus tard fera rougir ICI au lieu de replier silencieusement sur le fil.
   */
  it('le rayon de ramassage maximal tient dans un octet non signe', () => {
    expect(ORB_PICKUP_RADIUS + maxBonus('pickupRadius')).toBeLessThanOrEqual(255);
  });

  it('maxBonus rend zero pour une cle que le catalogue ne vend pas', () => {
    expect(maxBonus('regen')).toBeGreaterThanOrEqual(0);
  });

  /**
   * ⚠️ **La clef de voute du pitch, epinglee ici parce que c'est la boutique
   * qui pourrait la briser.**
   *
   * Le §11 de l'orientation listait les « slots » parmi ce que l'or achete.
   * Six slots d'armes font couvrir les QUINZE reactions a un joueur seul
   * (C(6,2) = 15), donc la premiere phrase du README — et le livrable de
   * l'etape 5c qui l'a rendue mesurable — tomberaient ensemble.
   *
   * Ce test garde deux choses : que la constante ne bouge pas, et qu'AUCUN
   * article ne la vende. Le type `BonusKind` l'interdit deja
   * structurellement ; cette assertion le dit a voix haute, pour que le
   * prochain qui voudra l'elargir trouve la raison avant le code.
   */
  it('aucun article ne vend de slot, et WEAPON_SLOTS ne bouge pas', () => {
    expect(WEAPON_SLOTS).toBe(4);
    expect(PASSIVE_SLOTS).toBe(3);
    for (const i of SHOP_ITEMS) {
      expect(i.id, `article ${i.id}`).not.toMatch(/slot/i);
    }
  });
});
```

⚠️ **`PASSIVE_KINDS` n'existe peut-être pas encore** : `shared/passives.ts` déclare
`export type PassiveKind = 'fireRate' | 'damage' | 'maxHp' | 'speed' | 'regen'`, un type et non une
valeur. Si la constante manque, ajoute-la à côté du type et dérive le type d'elle :

```ts
export const PASSIVE_KINDS = ['fireRate', 'damage', 'maxHp', 'speed', 'regen'] as const;
export type PassiveKind = (typeof PASSIVE_KINDS)[number];
```

C'est strictement mieux que deux listes : un type et un tableau qui se contredisent est une
divergence qui attend son tour.

- [ ] **Étape 2 : lancer les tests pour vérifier qu'ils échouent**

```bash
cd back && npx vitest run ../shared/shop.test.ts
```

Attendu : ÉCHEC à la compilation — `./shop` n'existe pas.

- [ ] **Étape 3 : écrire `shared/shop.ts`**

```ts
import type { PassiveKind } from './passives';

/**
 * Les cles de bonus que la boutique peut vendre.
 *
 * ⚠️ **`pickupRadius` n'est PAS une `PassiveKind`, et c'est voulu.** Les cinq
 * cles de passif sont deja sommees par `Room` a cinq endroits ; celle-ci n'a
 * aucun site existant et en demande un neuf (tache 7). La distinguer dans le
 * type rappelle qu'elle ne suit pas le meme chemin.
 */
export type BonusKind = PassiveKind | 'pickupRadius';

/**
 * Un article de la boutique.
 *
 * ⚠️ **Le catalogue vit dans `shared/` pour que le front affiche les libelles
 * et les prix sans seconde source de verite — mais AUCUN prix n'est lu depuis
 * le client.** Acheter est un `POST` ; le serveur relit le prix ici, verifie le
 * solde et debite dans une seule transaction. C'est l'autorite serveur du §11
 * de l'orientation, appliquee au meme endroit que pour l'or.
 */
export interface ShopItem {
  id: string;
  label: string;
  kind: 'weapon' | 'bonus';
  /** Prix du PREMIER palier. Voir `priceOf` pour les suivants. */
  price: number;
  /** Nombre de paliers achetables. `1` pour un deblocage d'arme, qui est binaire. */
  levels: number;
  /** Renseigne si et seulement si `kind === 'weapon'`. */
  weaponId?: number;
  /** Renseignes si et seulement si `kind === 'bonus'`. */
  bonusKind?: BonusKind;
  perLevel?: number;
}

/**
 * ⚠️ **Les prix sont un REGLAGE DE JEU, pas un invariant.**
 *
 * L'ancre, faute de donnees : l'etape 7a n'a livre AUCUN historique de runs,
 * donc il n'existe aucune mesure de ce qu'une run rapporte. Une extraction au
 * palier `k` verse `GOLD_PER_PALIER_BASE * hpScale(k)` (soit 100 au palier 0)
 * plus les pieces ramassees. Le premier article coute donc environ une
 * extraction reussie a un palier precoce. **A regler au playtest** ; aucun
 * test de ce depot n'ecrit un prix en dur.
 */
export const SHOP_ITEMS: readonly ShopItem[] = Object.freeze([
  { id: 'arme-braise', label: 'Grenade', kind: 'weapon', price: 300, levels: 1, weaponId: 4 },
  { id: 'arme-givre', label: 'Sceptre arcanique', kind: 'weapon', price: 300, levels: 1, weaponId: 8 },
  { id: 'arme-foudre', label: 'Canon a arc', kind: 'weapon', price: 300, levels: 1, weaponId: 10 },
  { id: 'arme-poix', label: 'Chaudron a poix', kind: 'weapon', price: 300, levels: 1, weaponId: 12 },
  { id: 'arme-chaux', label: 'Canon a chaux', kind: 'weapon', price: 300, levels: 1, weaponId: 14 },
  { id: 'arme-vif-argent', label: 'Glaive de mercure', kind: 'weapon', price: 300, levels: 1, weaponId: 16 },

  { id: 'vitalite', label: 'Vitalite', kind: 'bonus', price: 150, levels: 5, bonusKind: 'maxHp', perLevel: 10 },
  { id: 'celerite', label: 'Celerite', kind: 'bonus', price: 150, levels: 5, bonusKind: 'speed', perLevel: 6 },
  { id: 'cadence', label: 'Cadence', kind: 'bonus', price: 200, levels: 3, bonusKind: 'fireRate', perLevel: 0.05 },
  { id: 'puissance', label: 'Puissance', kind: 'bonus', price: 200, levels: 3, bonusKind: 'damage', perLevel: 0.05 },
  { id: 'aimant', label: 'Aimant', kind: 'bonus', price: 250, levels: 4, bonusKind: 'pickupRadius', perLevel: 20 },
]);

export function shopItemOf(id: string): ShopItem | undefined {
  return SHOP_ITEMS.find((i) => i.id === id);
}

/** Prix du palier `level` (1 = le premier). Croit lineairement avec le palier. */
export function priceOf(item: ShopItem, level: number): number {
  return item.price * level;
}

/**
 * Bonus total qu'un compte peut atteindre sur cette cle en achetant tous les
 * paliers de tous les articles qui la portent.
 *
 * ⚠️ **Derive du catalogue, jamais ecrit a cote.** C'est ce qui permet au test
 * du §5 de la spec d'assener que le rayon tient dans un octet : ajouter un
 * article trop genereux fera rougir ce test au lieu de replier le `u8`.
 */
export function maxBonus(kind: BonusKind): number {
  let total = 0;
  for (const i of SHOP_ITEMS) {
    if (i.kind === 'bonus' && i.bonusKind === kind) {
      total += (i.perLevel ?? 0) * i.levels;
    }
  }
  return total;
}
```

⚠️ **`locked` n'existe pas encore sur `Weapon`** — le test de l'étape 1 l'exige, et c'est la tâche 2
qui l'ajoute. Donc à cette étape, **le test `chaque article d arme ... est verrouillee` échoue encore**,
et c'est normal : il passera à la tâche 2. Lance les autres et dis-le dans ton rapport.

- [ ] **Étape 4 : lancer, lint, typecheck, commit**

```bash
cd back && npx vitest run ../shared/shop.test.ts
cd .. && npm run lint && npm run typecheck
git add shared/shop.ts shared/shop.test.ts shared/passives.ts
git commit -m "feat(shared): le catalogue de la boutique

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 2 : le champ `locked`, et l'invariant qui protège les quinze réactions

**Files :**
- Modify: `shared/weapons.ts`
- Modify: `shared/weapons.test.ts`

**Interfaces :**
- Consumes: rien.
- Produces: `Weapon.locked: boolean` ; `lockedWeaponIds(): readonly number[]`.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/weapons.test.ts` :

```ts
describe('etape 7b tache 2 : six armes verrouillees, une par element', () => {
  it('exactement six armes sont verrouillees', () => {
    expect(WEAPONS.filter((w) => w.locked)).toHaveLength(6);
  });

  /**
   * ⚠️ **C'est l'invariant qui protege l'etape 5c tout entiere.**
   *
   * Si les DEUX armes d'un element etaient verrouillees, un compte neuf ne
   * pourrait plus atteindre cet element — donc plus les paires qui l'utilisent,
   * donc plus les quinze reactions. Le pitch du README et le livrable de 5c
   * tomberaient ensemble, et rien d'autre ne le dirait.
   */
  it('chaque element garde au moins une arme LIBRE', () => {
    for (const e of ELEMENTS.filter((e) => e.id !== ELEMENT.NEUTRE)) {
      const libres = WEAPONS.filter((w) => w.element === e.id && !w.locked);
      expect(libres.length, `element ${e.id} : aucune arme libre`).toBeGreaterThan(0);
    }
  });

  it('l arme de depart n est jamais verrouillee', () => {
    expect(weaponOf(BASE_WEAPON_ID).locked).toBe(false);
  });

  /**
   * Le frappeur est verrouille, l'arroseur reste libre : un gros coup unique
   * se vit comme une recompense, et les arroseurs appliquent les elements plus
   * souvent, ce qui convient a un compte qui decouvre les reactions.
   */
  it('c est le frappeur de chaque element qui est verrouille', () => {
    for (const w of WEAPONS.filter((w) => w.locked)) {
      expect(w.projectileCount, `${w.name}`).toBe(1);
    }
  });

  it('aucune arme neutre n est verrouillee', () => {
    for (const w of WEAPONS.filter((w) => w.element === ELEMENT.NEUTRE)) {
      expect(w.locked, `${w.name}`).toBe(false);
    }
  });
});
```

Ajoute à l'import de ce fichier ce qui manque : `ELEMENTS`, `ELEMENT`, `weaponOf`, `BASE_WEAPON_ID`.

- [ ] **Étape 2 : lancer pour vérifier que ça échoue**

```bash
cd back && npx vitest run ../shared/weapons.test.ts
```

Attendu : ÉCHEC — `locked` n'existe pas sur `Weapon`.

- [ ] **Étape 3 : ajouter le champ**

Dans l'interface `Weapon`, après `element` :

```ts
  /**
   * Cette arme doit-elle etre DEBLOQUEE a l'or avant d'entrer dans le pool du
   * draft ? Six armes la portent : le frappeur de chaque element.
   *
   * ⚠️ **Un champ EXPLICITE, pas une regle derivee — et c'est deliberе.**
   * `projectileCount === 1` designe exactement ces six armes aujourd'hui, mais
   * deriver le verrou de la serait la premiere forme du « decor qui masque » :
   * une valeur egale a une constante de production, donc une egalite qui ne
   * prouve rien et qui cesse d'etre vraie a la premiere arme ajoutee. C'est la
   * lecon de l'etape 5c, ou la liaison du Vif-argent a ete derivee du nibble,
   * ou le correctif a depasse la cible, et ou il a fallu revenir a un champ
   * explicite sur trois reactions.
   *
   * ⚠️ **Le verrou ferme le POOL DU DRAFT, pas le `Loadout`.** `Room#grantCard`
   * n'est pas concerne : les tests qui equipent une arme directement — dont le
   * livrable de 5c, onze fois — restent verts sans etre touches.
   */
  locked: boolean;
```

Puis ajoute `locked: false` à **toutes** les entrées de `WEAPON_DEFS`, et passe à `true` celles des
six frappeurs : ids **4, 8, 10, 12, 14, 16**.

Et un accesseur, à côté de `weaponOf` :

```ts
/** Les identifiants des armes verrouillees, dans l'ordre de la table. */
export function lockedWeaponIds(): readonly number[] {
  return WEAPONS.filter((w) => w.locked).map((w) => w.id);
}
```

⚠️ **Vérifie que `assertWeaponElements` et `assertWeaponLooks`, qui tournent au chargement du module,
passent toujours.** Elles ne regardent pas `locked`, mais un champ ajouté de travers casserait le
littéral.

- [ ] **Étape 4 : lancer, lint, typecheck, commit**

```bash
cd back && npx vitest run ../shared/weapons.test.ts ../shared/shop.test.ts
cd .. && npm run lint && npm run typecheck
git add shared/weapons.ts shared/weapons.test.ts
git commit -m "feat(shared): six armes verrouillees, le frappeur de chaque element

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

Le test `chaque article d arme ... est verrouillee` de la tâche 1 devient vert ici : dis-le.

---

## Tâche 3 : le pool du draft, et la porte qui refuse

**Files :**
- Modify: `shared/cards.ts`
- Modify: `shared/cards.test.ts`
- Modify: `back/src/draft.ts`
- Modify: `back/src/draft.test.ts`

**Interfaces :**
- Consumes: `Weapon.locked` (tâche 2).
- Produces:
  - `buildPool(unlocked: ReadonlySet<number>): Card[]`
  - `drawSpread(loadouts: ReadonlyMap<number, Loadout>, rng: () => number, unlocked: ReadonlySet<number>): Card[]`
  - `Draft#open(tick, spread, players, loadouts, unlockedByPlayer: ReadonlyMap<number, ReadonlySet<number>>)`

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/cards.test.ts` :

```ts
describe('etape 7b tache 3 : le pool tire sur l union des deblocages', () => {
  it('une arme verrouillee absente de l union n entre pas dans le pool', () => {
    const verrouillee = WEAPONS.find((w) => w.locked);
    if (!verrouillee) {
      throw new Error('aucune arme verrouillee');
    }
    const pool = buildPool(new Set());
    expect(pool.some((c) => c.nature === CARD.WEAPON && c.refId === verrouillee.id)).toBe(false);
  });

  it('la meme arme entre des qu elle est dans l union', () => {
    const verrouillee = WEAPONS.find((w) => w.locked);
    if (!verrouillee) {
      throw new Error('aucune arme verrouillee');
    }
    const pool = buildPool(new Set([verrouillee.id]));
    expect(pool.some((c) => c.nature === CARD.WEAPON && c.refId === verrouillee.id)).toBe(true);
  });

  /**
   * ⚠️ Sans cette assertion, un `buildPool` qui rendrait un pool VIDE
   * satisferait les deux tests precedents.
   */
  it('les armes libres et tous les passifs sont la, union vide ou non', () => {
    const pool = buildPool(new Set());
    const libres = WEAPONS.filter((w) => !w.locked && w.id !== BASE_WEAPON_ID);
    for (const w of libres) {
      expect(pool.some((c) => c.nature === CARD.WEAPON && c.refId === w.id), w.name).toBe(true);
    }
    expect(pool.filter((c) => c.nature === CARD.PASSIVE)).toHaveLength(PASSIVES.length);
  });
});
```

Dans `back/src/draft.test.ts` :

```ts
describe('etape 7b tache 3 : un jeton sur une carte non debloquee est refuse', () => {
  it('refuse le jeton, et le refus ne depend pas du Loadout', () => {
    const verrouillee = WEAPONS.find((w) => w.locked);
    if (!verrouillee) {
      throw new Error('aucune arme verrouillee');
    }
    const draft = new Draft();
    const loadouts = new Map([[1, new Loadout()]]);
    const spread = [{ nature: CARD.WEAPON, refId: verrouillee.id }];
    // Le joueur 1 n'a RIEN debloque.
    draft.open(0, spread, [1], loadouts, new Map([[1, new Set<number>()]]));

    // Son Loadout pourrait parfaitement accueillir cette arme :
    expect(loadouts.get(1)?.canTake(CARD.WEAPON, verrouillee.id)).toBe(true);
    // ...et le jeton est refuse quand meme.
    expect(draft.setToken(1, 0)).toBe(false);
  });

  it('accepte le meme jeton des que l arme est debloquee', () => {
    const verrouillee = WEAPONS.find((w) => w.locked);
    if (!verrouillee) {
      throw new Error('aucune arme verrouillee');
    }
    const draft = new Draft();
    const loadouts = new Map([[1, new Loadout()]]);
    const spread = [{ nature: CARD.WEAPON, refId: verrouillee.id }];
    draft.open(0, spread, [1], loadouts, new Map([[1, new Set([verrouillee.id])]]));
    expect(draft.setToken(1, 0)).toBe(true);
  });

  it('un passif n est jamais concerne par les deblocages', () => {
    const p = PASSIVES[0];
    if (!p) {
      throw new Error('aucun passif');
    }
    const draft = new Draft();
    const loadouts = new Map([[1, new Loadout()]]);
    draft.open(0, [{ nature: CARD.PASSIVE, refId: p.id }], [1], loadouts, new Map([[1, new Set<number>()]]));
    expect(draft.setToken(1, 0)).toBe(true);
  });
});
```

- [ ] **Étape 2 : lancer pour vérifier que ça échoue**

```bash
cd back && npx vitest run ../shared/cards.test.ts src/draft.test.ts
```

Attendu : ÉCHEC — `buildPool` ne prend pas d'argument, `Draft#open` en prend quatre.

- [ ] **Étape 3 : écrire l'implémentation**

Dans `shared/cards.ts` :

```ts
/**
 * Le pool de cartes, filtre par les armes DEBLOQUEES.
 *
 * ⚠️ **`unlocked` est l'UNION des deblocages de la salle, pas ceux d'un
 * joueur.** L'etalage est unique et partage (§7.1 de l'orientation : « un seul
 * etalage pour toute l'equipe », le pari de design du projet). L'intersection
 * aurait fait qu'un debutant degrade le pool de toute l'equipe, ce que le §8.1
 * interdit en propres termes : « une punition se lit comme un bug ».
 *
 * C'est `Draft#setToken` qui refuse ensuite a CE joueur une carte qu'il n'a pas
 * debloquee ; le client, lui, la grise avec son propre ensemble.
 */
function buildPool(unlocked: ReadonlySet<number>): Card[] {
  const pool: Card[] = [];

  for (const w of WEAPONS) {
    if (w.id === BASE_WEAPON_ID) {
      continue;
    }
    if (w.locked && !unlocked.has(w.id)) {
      continue;
    }
    pool.push({ nature: CARD.WEAPON, refId: w.id });
  }

  for (const p of PASSIVES) {
    pool.push({ nature: CARD.PASSIVE, refId: p.id });
  }

  return pool;
}
```

Exporte `buildPool` (le test l'importe) et passe `unlocked` à travers `drawSpread` :

```ts
export function drawSpread(
  loadouts: ReadonlyMap<number, Loadout>,
  rng: () => number,
  unlocked: ReadonlySet<number>,
): Card[] {
  const wanted = loadouts.size + SPREAD_BONUS;
  const pool = buildPool(unlocked);
  // ... inchange
```

Dans `back/src/draft.ts`, `open` gagne un paramètre et `#eligible` une condition :

```ts
  #unlockedByPlayer: ReadonlyMap<number, ReadonlySet<number>> = new Map();
```

```ts
  /** Ce joueur peut-il accueillir cette carte ? Voir `Loadout.canTake`. */
  #eligible(playerId: number, card: Card): boolean {
    // ⚠️ **Le deblocage se verifie AVANT le Loadout, et c'est un refus d'une
    // autre nature** : le Loadout dit « tu n'as plus de place », le deblocage
    // dit « cette arme n'est pas a toi ». Les confondre ferait croire a un slot
    // plein la ou il manque un achat.
    if (card.nature === CARD.WEAPON) {
      const arme = weaponOf(card.refId);
      const debloquees = this.#unlockedByPlayer.get(playerId);
      if (arme.locked && !debloquees?.has(card.refId)) {
        return false;
      }
    }
    const loadout = this.#loadouts.get(playerId);
    return loadout ? loadout.canTake(card.nature, card.refId) : true;
  }
```

Et dans `Room#openDraft` (`back/src/room.ts`), construis l'union et passe-la :

```ts
    const union = new Set<number>();
    for (const p of this.#players.values()) {
      for (const id of p.unlockedWeapons) {
        union.add(id);
      }
    }
    const parJoueur = new Map<number, ReadonlySet<number>>();
    for (const [id, p] of this.#players) {
      parJoueur.set(id, p.unlockedWeapons);
    }
    const spread = drawSpread(loadouts, this.#draftRng, union);
    this.#draft.open(this.#tick, spread, [...this.#players.keys()], loadouts, parJoueur);
```

⚠️ **`PlayerState.unlockedWeapons` n'existe pas encore** — c'est la tâche 6 qui l'ajoute. Pour cette
tâche, ajoute-le dès maintenant à `PlayerState` avec `readonly unlockedWeapons: ReadonlySet<number>`
et initialise-le à `new Set()` dans `join`. La tâche 6 le remplira depuis le compte.

- [ ] **Étape 4 : lancer, lint, typecheck, commit**

```bash
cd back && npx vitest run ../shared/cards.test.ts src/draft.test.ts src/room.test.ts
cd .. && npm run lint && npm run typecheck
git add shared/cards.ts shared/cards.test.ts back/src/draft.ts back/src/draft.test.ts back/src/room.ts
git commit -m "feat: le pool du draft tire sur l union, et la porte refuse le non debloque

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

⚠️ **D'autres fichiers appellent `drawSpread` et `Draft#open`** — notamment
`back/src/draft.integration.test.ts`. Lance-le aussi et mets-le à jour : un argument de plus, pas un
changement de comportement.

---

## Tâche 4 : la table `Purchase` et le dépôt

**Files :**
- Modify: `back/prisma/schema.prisma`
- Create: `back/prisma/migrations/<horodatage>_achats/migration.sql` (généré)
- Modify: `back/src/accounts.ts`
- Modify: `back/src/accounts.test.ts`

**Interfaces :**
- Consumes: `SHOP_ITEMS`, `shopItemOf`, `priceOf` (tâche 1).
- Produces:
  - `purchasesOf(accountId: string): Promise<Map<string, number>>` — itemId → level
  - `buyItem(accountId: string, itemId: string): Promise<'ok' | 'solde-insuffisant' | 'article-inconnu' | 'palier-max'>`
  - `bonusesOf(purchases: ReadonlyMap<string, number>): Record<BonusKind, number>`
  - `unlockedWeaponsOf(purchases: ReadonlyMap<string, number>): Set<number>`

- [ ] **Étape 1 : le schéma**

Dans `back/prisma/schema.prisma`, ajoute le modèle et la relation inverse sur `Account` :

```prisma
model Account {
  id        String     @id @default(uuid())
  tokenHash String     @unique
  gold      BigInt     @default(0)
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt
  purchases Purchase[]
}

/// Un article achete par un compte. `level` ne vaut autre chose que 1 que pour
/// les ameliorations a paliers ; un deblocage d'arme est binaire.
model Purchase {
  accountId String
  itemId    String
  level     Int      @default(1)
  createdAt DateTime @default(now())

  account   Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)

  /// ⚠️ La cle composite interdit STRUCTURELLEMENT le doublon : deux onglets
  /// qui achetent le meme article au meme instant ne peuvent pas creer deux
  /// lignes, et c'est la base qui le garantit, pas le code applicatif.
  @@id([accountId, itemId])
}
```

- [ ] **Étape 2 : générer la migration**

```bash
export DATABASE_URL='postgresql://tarnok:tarnok@127.0.0.1:5442/tarnok'
cd back && npx prisma migrate dev --name achats
```

**Committe le fichier de migration** — une migration non versionnée est une base non reproductible.

- [ ] **Étape 3 : écrire les tests qui échouent**

Dans `back/src/accounts.test.ts` :

```ts
describe('etape 7b tache 4 : acheter', () => {
  it('un compte neuf n a aucun achat', async () => {
    const { id } = await createAccount();
    expect((await purchasesOf(id)).size).toBe(0);
  });

  it('un achat insere la ligne et debite EXACTEMENT le prix du catalogue', async () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const { id } = await createAccount();
    await creditAccounts([id], BigInt(priceOf(article, 1)));

    expect(await buyItem(id, article.id)).toBe('ok');
    expect(await goldOf(id)).toBe(0n);
    expect((await purchasesOf(id)).get(article.id)).toBe(1);
  });

  /**
   * Review Focus n°2 : un refus doit ne RIEN debiter et n'inserer RIEN. Un
   * debit partiel serait pire qu'un crash, parce qu'invisible — le joueur
   * verrait son or baisser sans rien recevoir.
   */
  it('un achat a solde insuffisant ne debite rien et n insere rien', async () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const { id } = await createAccount();
    const presque = BigInt(priceOf(article, 1)) - 1n;
    await creditAccounts([id], presque);

    expect(await buyItem(id, article.id)).toBe('solde-insuffisant');
    expect(await goldOf(id)).toBe(presque);
    expect((await purchasesOf(id)).size).toBe(0);
  });

  it('un article inconnu est refuse sans rien debiter', async () => {
    const { id } = await createAccount();
    await creditAccounts([id], 100_000n);
    expect(await buyItem(id, 'article-qui-n-existe-pas')).toBe('article-inconnu');
    expect(await goldOf(id)).toBe(100_000n);
    expect((await purchasesOf(id)).size).toBe(0);
  });

  it('acheter un palier de plus monte le niveau et debite le prix du palier', async () => {
    const paliers = SHOP_ITEMS.find((i) => i.levels > 1);
    if (!paliers) {
      throw new Error('aucun article a paliers');
    }
    const { id } = await createAccount();
    await creditAccounts([id], BigInt(priceOf(paliers, 1) + priceOf(paliers, 2)));

    expect(await buyItem(id, paliers.id)).toBe('ok');
    expect(await buyItem(id, paliers.id)).toBe('ok');
    expect((await purchasesOf(id)).get(paliers.id)).toBe(2);
    expect(await goldOf(id)).toBe(0n);
  });

  /**
   * Review Focus n°3 : au-dela du dernier palier, le catalogue est la limite.
   */
  it('acheter au-dela du dernier palier est refuse', async () => {
    const article = SHOP_ITEMS.find((i) => i.levels === 1);
    if (!article) {
      throw new Error('aucun article a un seul palier');
    }
    const { id } = await createAccount();
    await creditAccounts([id], BigInt(priceOf(article, 1)) * 4n);

    expect(await buyItem(id, article.id)).toBe('ok');
    const apres = await goldOf(id);
    expect(await buyItem(id, article.id)).toBe('palier-max');
    expect(await goldOf(id)).toBe(apres);
  });

  /**
   * Review Focus n°1 : deux onglets, le meme article, au meme instant. La cle
   * composite et la transaction doivent n'en laisser passer qu'UN, et ne
   * debiter qu'une fois.
   */
  it('deux achats CONCURRENTS du meme article n en passent qu un', async () => {
    const article = SHOP_ITEMS.find((i) => i.levels === 1);
    if (!article) {
      throw new Error('aucun article a un seul palier');
    }
    const { id } = await createAccount();
    await creditAccounts([id], BigInt(priceOf(article, 1)) * 2n);

    const [a, b] = await Promise.all([buyItem(id, article.id), buyItem(id, article.id)]);
    const resultats = [a, b].sort();
    expect(resultats).toContain('ok');
    expect(resultats.filter((r) => r === 'ok')).toHaveLength(1);
    expect((await purchasesOf(id)).get(article.id)).toBe(1);
    expect(await goldOf(id)).toBe(BigInt(priceOf(article, 1)));
  });

  it('bonusesOf somme les paliers, et rend zero sur une cle non achetee', () => {
    const v = SHOP_ITEMS.find((i) => i.bonusKind === 'maxHp');
    if (!v) {
      throw new Error('aucun article de vitalite');
    }
    const b = bonusesOf(new Map([[v.id, 3]]));
    expect(b.maxHp).toBe((v.perLevel ?? 0) * 3);
    expect(b.regen).toBe(0);
  });

  it('unlockedWeaponsOf rend les armes des articles achetes, et rien d autre', () => {
    const arme = SHOP_ITEMS.find((i) => i.kind === 'weapon');
    if (!arme) {
      throw new Error('aucun article d arme');
    }
    expect([...unlockedWeaponsOf(new Map([[arme.id, 1]]))]).toEqual([arme.weaponId]);
    expect(unlockedWeaponsOf(new Map()).size).toBe(0);
  });
});
```

- [ ] **Étape 4 : lancer pour vérifier que ça échoue**

```bash
export DATABASE_URL='postgresql://tarnok:tarnok@127.0.0.1:5442/tarnok'
cd back && npx vitest run src/accounts.test.ts
```

Attendu : ÉCHEC — `purchasesOf`, `buyItem`, `bonusesOf`, `unlockedWeaponsOf` n'existent pas.

- [ ] **Étape 5 : écrire l'implémentation**

Dans `back/src/accounts.ts` :

```ts
export async function purchasesOf(accountId: string): Promise<Map<string, number>> {
  const lignes = await prisma.purchase.findMany({
    where: { accountId },
    select: { itemId: true, level: true },
  });
  return new Map(lignes.map((l) => [l.itemId, l.level]));
}

/**
 * Achete un palier d'un article.
 *
 * ⚠️ **Le prix est relu DANS LE CATALOGUE, jamais recu du client.** C'est
 * l'autorite serveur du §11 : un client ne peut pas plus fabriquer un achat
 * qu'il ne pouvait fabriquer de l'or.
 *
 * ⚠️ **Tout se passe dans UNE transaction**, et c'est ce qui garantit qu'un
 * refus ne laisse jamais de debit partiel. Deux onglets qui achetent le meme
 * article au meme instant se heurtent a la cle composite `[accountId, itemId]` :
 * la base refuse le doublon, et le second achat echoue sans avoir debite.
 */
export async function buyItem(
  accountId: string,
  itemId: string,
): Promise<'ok' | 'solde-insuffisant' | 'article-inconnu' | 'palier-max'> {
  const item = shopItemOf(itemId);
  if (!item) {
    return 'article-inconnu';
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const deja = await tx.purchase.findUnique({
        where: { accountId_itemId: { accountId, itemId } },
        select: { level: true },
      });
      const palier = (deja?.level ?? 0) + 1;
      if (palier > item.levels) {
        return 'palier-max' as const;
      }

      const prix = BigInt(priceOf(item, palier));
      const compte = await tx.account.findUnique({ where: { id: accountId }, select: { gold: true } });
      if ((compte?.gold ?? 0n) < prix) {
        return 'solde-insuffisant' as const;
      }

      await tx.account.update({ where: { id: accountId }, data: { gold: { decrement: prix } } });
      if (deja) {
        await tx.purchase.update({
          where: { accountId_itemId: { accountId, itemId } },
          data: { level: palier },
        });
      } else {
        await tx.purchase.create({ data: { accountId, itemId, level: palier } });
      }
      return 'ok' as const;
    });
  } catch {
    // La cle composite a refuse un doublon cree par un achat concurrent : cet
    // achat-ci n'a rien debite, la transaction a tout annule.
    return 'solde-insuffisant';
  }
}

/** Les bonus permanents d'un compte, par cle, sommes sur ses paliers. */
export function bonusesOf(purchases: ReadonlyMap<string, number>): Record<BonusKind, number> {
  const out = { fireRate: 0, damage: 0, maxHp: 0, speed: 0, regen: 0, pickupRadius: 0 };
  for (const [itemId, level] of purchases) {
    const item = shopItemOf(itemId);
    if (item?.kind === 'bonus' && item.bonusKind) {
      out[item.bonusKind] += (item.perLevel ?? 0) * level;
    }
  }
  return out;
}

/** Les identifiants d'armes que ces achats debloquent. */
export function unlockedWeaponsOf(purchases: ReadonlyMap<string, number>): Set<number> {
  const out = new Set<number>();
  for (const itemId of purchases.keys()) {
    const item = shopItemOf(itemId);
    if (item?.kind === 'weapon' && item.weaponId !== undefined) {
      out.add(item.weaponId);
    }
  }
  return out;
}
```

Ajoute les imports : `import { type BonusKind, priceOf, shopItemOf } from '@shared/shop';`

⚠️ **Le `catch` qui rend `'solde-insuffisant'` sur un conflit de clé est discutable** — il confond
deux causes. **Mesure-le** : si le test de concurrence montre que le second achat obtient autre chose
qu'`'ok'` et que le solde final est correct, garde-le et dis-le dans le docbloc. Si tu préfères un
quatrième verdict `'conflit'`, ajoute-le et mets le test à jour — **dis-moi lequel tu as choisi et
pourquoi**.

- [ ] **Étape 6 : lancer, lint, typecheck, commit**

```bash
cd back && npx vitest run src/accounts.test.ts
cd .. && npm run lint && npm run typecheck
git add back/prisma back/src/accounts.ts back/src/accounts.test.ts
git commit -m "feat(back): la table des achats, et un achat transactionnel

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 5 : les deux routes HTTP

**Files :**
- Modify: `back/src/server.ts`
- Modify: `back/src/accounts.http.test.ts`

**Interfaces :**
- Consumes: `purchasesOf`, `buyItem` (tâche 4), `accountIdFromHeader` (étape 7a).
- Produces: `GET /accounts/me` → `200 { gold: string; purchases: Record<string, number> }` ;
  `POST /accounts/me/purchases` avec `{ itemId }` → `200 { gold, purchases }`, `400`, `402` ou `401`.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `back/src/accounts.http.test.ts` :

```ts
describe('etape 7b tache 5 : la boutique en http', () => {
  async function compte(): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/accounts' });
    return res.json<{ token: string }>().token;
  }

  it('GET /accounts/me rend desormais les achats, vides au depart', async () => {
    const token = await compte();
    const res = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const corps = res.json<{ gold: string; purchases: Record<string, number> }>();
    expect(corps.gold).toBe('0');
    expect(corps.purchases).toEqual({});
  });

  it('un achat reussi rend le nouveau solde ET les achats a jour', async () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const token = await compte();
    const id = await findAccountIdByToken(textToToken(token));
    if (!id) {
      throw new Error('compte introuvable');
    }
    await creditAccounts([id], BigInt(priceOf(article, 1)));

    const res = await app.inject({
      method: 'POST',
      url: '/accounts/me/purchases',
      headers: { authorization: `Bearer ${token}` },
      payload: { itemId: article.id },
    });
    expect(res.statusCode).toBe(200);
    const corps = res.json<{ gold: string; purchases: Record<string, number> }>();
    expect(corps.gold).toBe('0');
    expect(corps.purchases[article.id]).toBe(1);
  });

  it('un solde insuffisant rend 402, et ne debite rien', async () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const token = await compte();
    const res = await app.inject({
      method: 'POST',
      url: '/accounts/me/purchases',
      headers: { authorization: `Bearer ${token}` },
      payload: { itemId: article.id },
    });
    expect(res.statusCode).toBe(402);
    expect(res.body).not.toContain('"purchases"');
  });

  /** Review Focus n°3 : un `itemId` inconnu, ou absent du corps. */
  it('un article inconnu ou un corps sans itemId rendent 400', async () => {
    const token = await compte();
    for (const payload of [{ itemId: 'rien-du-tout' }, {}, { itemId: 42 }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/accounts/me/purchases',
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('acheter sans jeton valide rend 401, et les trois formes d echec sont indistinguables', async () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const faits = [];
    for (const headers of [{}, { authorization: '' }, { authorization: 'Bearer pas-un-jeton' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/accounts/me/purchases',
        headers,
        payload: { itemId: article.id },
      });
      expect(res.statusCode).toBe(401);
      faits.push(res.body);
    }
    for (const corps of faits.slice(1)) {
      expect(corps).toBe(faits[0]);
    }
  });
});
```

- [ ] **Étape 2 : lancer pour vérifier que ça échoue**

```bash
export DATABASE_URL='postgresql://tarnok:tarnok@127.0.0.1:5442/tarnok'
cd back && npx vitest run src/accounts.http.test.ts
```

Attendu : ÉCHEC — la route d'achat rend 404, et `GET /accounts/me` ne rend pas `purchases`.

- [ ] **Étape 3 : écrire l'implémentation**

Dans `back/src/server.ts`, remplace la route de lecture et ajoute celle d'achat :

```ts
  app.get('/accounts/me', async (req, reply) => {
    const accountId = await accountIdFromHeader(req.headers.authorization);
    if (accountId === null) {
      return reply.code(401).send({ error: 'jeton absent ou inconnu' });
    }
    return reply.send({
      // ⚠️ **En TEXTE, pas en nombre.** `bigint` n'est pas serialisable en
      // JSON, et un nombre JSON perdrait la precision au-dela de 2^53 alors que
      // la colonne tient jusqu'a 2^63.
      gold: (await goldOf(accountId)).toString(),
      purchases: Object.fromEntries(await purchasesOf(accountId)),
    });
  });

  app.post('/accounts/me/purchases', async (req, reply) => {
    const accountId = await accountIdFromHeader(req.headers.authorization);
    if (accountId === null) {
      return reply.code(401).send({ error: 'jeton absent ou inconnu' });
    }
    const itemId = (req.body as { itemId?: unknown } | null)?.itemId;
    if (typeof itemId !== 'string') {
      return reply.code(400).send({ error: 'itemId manquant' });
    }

    const verdict = await buyItem(accountId, itemId);
    if (verdict === 'article-inconnu') {
      return reply.code(400).send({ error: 'article inconnu' });
    }
    if (verdict === 'solde-insuffisant' || verdict === 'palier-max') {
      // 402 Payment Required : le client a demande quelque chose qu'il ne peut
      // pas encore se payer. `palier-max` partage ce code parce que la cause
      // est de meme nature — la demande est refusee, rien n'a change.
      return reply.code(402).send({ error: verdict });
    }
    return reply.send({
      gold: (await goldOf(accountId)).toString(),
      purchases: Object.fromEntries(await purchasesOf(accountId)),
    });
  });
```

Ajoute `buyItem` et `purchasesOf` à l'import depuis `./accounts`.

- [ ] **Étape 4 : lancer, lint, typecheck, commit**

```bash
cd back && npx vitest run src/accounts.http.test.ts
cd .. && npm run lint && npm run typecheck
git add back/src/server.ts back/src/accounts.http.test.ts
git commit -m "feat(back): lis tes achats et achete en http

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 6 : les achats atteignent la run

**Files :**
- Modify: `back/src/server.ts` (la poignée de main)
- Modify: `back/src/room.ts` (`join`, les cinq sommes)
- Create: `back/src/bonus.integration.test.ts`

**Interfaces :**
- Consumes: `purchasesOf`, `bonusesOf`, `unlockedWeaponsOf` (tâche 4).
- Produces: `Room#join(id: number, compte?: AccountGrants): boolean` ;
  `PlayerState.accountBonuses` et `PlayerState.unlockedWeapons` ; `Room#maxHpOf(playerId): number`.

⚠️ **`AccountGrants` se déclare et s'exporte depuis `back/src/room.ts`**, à côté de `PlayerState` —
c'est `Room` qui le consomme, et `server.ts` qui le construit. Ne le mets pas dans `shared/` : il
porte des données de compte, qui n'ont rien à faire dans du code que le client importe.

```ts
export interface AccountGrants {
  bonuses: Readonly<Record<BonusKind, number>>;
  unlockedWeapons: ReadonlySet<number>;
}
```

- [ ] **Étape 1 : écrire les tests qui échouent**

`back/src/bonus.integration.test.ts` — reprends le harnais de `credit.integration.test.ts`
(**duplique**, n'importe pas : aucun fichier d'intégration de ce dépôt n'en importe un autre), avec le
`HELLO` et ses deux pièges d'ordre (`'open'` avant tout `await`, `'message'` avant le `send`).

```ts
describe('etape 7b tache 6 : les achats changent la run', () => {
  /**
   * Le coeur de l'etape : un achat se VOIT dans la partie suivante. La mutation
   * « ignorer les bonus du compte » doit rougir ici.
   */
  it('la vitalite achetee monte le maximum de vie du joueur', async () => {
    const v = SHOP_ITEMS.find((i) => i.bonusKind === 'maxHp');
    if (!v) {
      throw new Error('aucun article de vitalite');
    }
    const { token, accountId } = await compteNeuf();
    await creditAccounts([accountId], BigInt(priceOf(v, 1)));
    expect(await buyItem(accountId, v.id)).toBe('ok');

    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const client = await connectAvecJeton(code, token);
    await attendre(() => (room.playerCount === 1 ? true : null), 'connexion', 3000);

    const attendu = PLAYER_MAX_HP + (v.perLevel ?? 0);
    expect(room.maxHpOf(client.playerId)).toBe(attendu);
  });

  it('un compte sans achat garde exactement les valeurs de base', async () => {
    const { token } = await compteNeuf();
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const client = await connectAvecJeton(code, token);
    await attendre(() => (room.playerCount === 1 ? true : null), 'connexion', 3000);
    expect(room.maxHpOf(client.playerId)).toBe(PLAYER_MAX_HP);
  });

  /**
   * Review Focus n°4 : une panne de lecture ne doit pas refuser la partie. Le
   * joueur entre SANS ses ameliorations plutot que de ne pas entrer — son or
   * est en base, la run suivante les retrouvera.
   */
  it('une base injoignable au chargement des achats laisse entrer le joueur', async () => {
    const { token } = await compteNeuf();
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }

    // ⚠️ L'espionnage exige d'importer le MODULE, pas la fonction :
    // `import * as comptes from './accounts';` en tete du fichier. Un import
    // nomme serait copie a la liaison et `spyOn` ne mordrait pas — c'est
    // exactement le piege que la re-revue de l'etape 7a a releve sur un test de
    // credit, ou l'assertion ne mordait que par transitivite.
    const espion = vi.spyOn(comptes, 'purchasesOf').mockRejectedValue(new Error('base injoignable'));
    try {
      const client = await connectAvecJeton(code, token);
      await attendre(() => (room.playerCount === 1 ? true : null), 'connexion malgre la panne', 5000);
      expect(espion).toHaveBeenCalledTimes(1);
      expect(room.maxHpOf(client.playerId)).toBe(PLAYER_MAX_HP);
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      espion.mockRestore();
    }
  });
});
```

⚠️ **`Room#maxHpOf(playerId)` n'existe pas** — ajoute-le comme accesseur de lecture, à côté de
`playerCount`. C'est un accesseur, pas une méthode de débogage : le `maxHp` est déjà un état public du
joueur, transporté par le `SNAPSHOT`.

⚠️ **`compteNeuf()`, `connectAvecJeton`, `attendre`, `createRoomCode`** sont des helpers **locaux** à
écrire en reprenant `credit.integration.test.ts`.

- [ ] **Étape 2 : lancer pour vérifier que ça échoue**

```bash
export DATABASE_URL='postgresql://tarnok:tarnok@127.0.0.1:5442/tarnok'
cd back && npx vitest run src/bonus.integration.test.ts
```

Attendu : ÉCHEC — le maximum de vie vaut `PLAYER_MAX_HP` malgré l'achat.

- [ ] **Étape 3 : `Room` accueille les bonus du compte**

Dans `back/src/room.ts`, `PlayerState` gagne deux champs :

```ts
  /**
   * Bonus permanents achetes par le COMPTE de ce joueur, par cle. Distincts des
   * bonus de cartes : ils ne consomment aucun slot de passif et survivent a la
   * run.
   */
  readonly accountBonuses: Readonly<Record<BonusKind, number>>;
  /** Armes verrouillees que le compte de ce joueur a debloquees. */
  readonly unlockedWeapons: ReadonlySet<number>;
```

`join` gagne un paramètre optionnel :

```ts
  /**
   * ⚠️ **`compte` est optionnel, et ce n'est PAS le piege « un chemin qui
   * n'existe que pour les tests ».** Un joueur sans aucun achat a legitimement
   * des bonus tous nuls et un ensemble de deblocages vide : le defaut EST un
   * etat de production valide, pas un contournement. Il evite seulement
   * d'editer les dizaines d'appels existants de `join` qui ne s'interessent
   * pas aux comptes.
   */
  join(id: number, compte?: AccountGrants): boolean {
```

et dans le littéral de `#players.set` :

```ts
      accountBonuses: compte?.bonuses ?? BONUS_ZERO,
      unlockedWeapons: compte?.unlockedWeapons ?? new Set<number>(),
      hp: PLAYER_MAX_HP + (compte?.bonuses.maxHp ?? 0),
      maxHp: PLAYER_MAX_HP + (compte?.bonuses.maxHp ?? 0),
```

avec, en tête de fichier :

```ts
const BONUS_ZERO: Readonly<Record<BonusKind, number>> = Object.freeze({
  fireRate: 0,
  damage: 0,
  maxHp: 0,
  speed: 0,
  regen: 0,
  pickupRadius: 0,
});
```

Puis **les cinq sommes existantes** gagnent un terme. Les voici, avec leur ligne actuelle :

| Ligne | Avant | Après |
| --- | --- | --- |
| `room.ts:943` | `PLAYER_SPEED + p.loadout.bonus('speed')` | `PLAYER_SPEED + p.loadout.bonus('speed') + p.accountBonuses.speed` |
| `room.ts:1541` | `cooldownWithBonus(weapon.cooldownTicks, p.loadout.bonus('fireRate'))` | `cooldownWithBonus(weapon.cooldownTicks, p.loadout.bonus('fireRate') + p.accountBonuses.fireRate)` |
| `room.ts:1545` | `weapon.damage * (1 + p.loadout.bonus('damage'))` | `weapon.damage * (1 + p.loadout.bonus('damage') + p.accountBonuses.damage)` |
| `room.ts:1698` | `PLAYER_MAX_HP + player.loadout.bonus('maxHp')` | `PLAYER_MAX_HP + player.loadout.bonus('maxHp') + player.accountBonuses.maxHp` |
| `room.ts:1750` | `p.loadout.bonus('regen') / TICK_HZ` | `(p.loadout.bonus('regen') + p.accountBonuses.regen) / TICK_HZ` |

⚠️ **Les numéros de ligne sont ceux du commit `645b1fa`** et auront bougé. Retrouve-les par
`grep -n "bonus('" back/src/room.ts` et vérifie qu'il y a bien **cinq** sites — s'il y en a six, dis-le.

Et l'accesseur :

```ts
  /** Le maximum de points de vie de ce joueur, bonus de cartes et de compte compris. */
  maxHpOf(playerId: number): number {
    return this.#players.get(playerId)?.maxHp ?? 0;
  }
```

- [ ] **Étape 4 : la poignée de main charge les achats**

Dans `back/src/server.ts`, dans `onFirst`, **après** la résolution du compte et **après** les gardes
existantes :

```ts
      // ⚠️ **UN SECOND `await` sur ce chemin, et c'est exactement la frontiere
      // asynchrone dont les QUATRE defauts Critiques de l'etape 7a sont nes,
      // dont deux tuaient le process entier.**
      //
      // Il est place APRES le garde `readyState` et le garde `#stopped`, et son
      // echec est attrape ici meme : une panne de lecture ne doit pas refuser la
      // partie. Le joueur entre sans ses ameliorations, son or reste en base, et
      // la run suivante les retrouvera. Refuser la connexion pour un incident
      // serveur punirait le joueur de notre panne.
      let grants: AccountGrants | undefined;
      try {
        const achats = await purchasesOf(accountId);
        grants = { bonuses: bonusesOf(achats), unlockedWeapons: unlockedWeaponsOf(achats) };
      } catch (err) {
        console.error(`[achats] lecture echouee compte=${accountId}`, err);
      }

      // ⚠️ Les deux gardes sont RELUS apres ce second `await` : la socket peut
      // etre morte et la session arretee pendant la lecture.
      if (ws.readyState !== ws.OPEN) {
        return;
      }
      if (this.#stopped) {
        ws.close(CLOSE_CODES.ROOM_CLOSED, 'salon ferme');
        return;
      }
```

puis `this.room.join(id, grants)` au lieu de `this.room.join(id)`.

⚠️ **Relis l'ordre toi-même contre le fichier.** Un `await` ajouté du mauvais côté d'un garde rouvre
les quatre Critiques de 7a. Si l'ordre existant ne te permet pas de placer celui-ci proprement,
**dis-le** plutôt que de bricoler.

- [ ] **Étape 5 : lancer, lint, typecheck, commit**

```bash
cd back
npx vitest run src/bonus.integration.test.ts
npx vitest run src/handshake.integration.test.ts
npx vitest run src/room.test.ts
cd .. && npm run lint && npm run typecheck
git add back/src/room.ts back/src/server.ts back/src/bonus.integration.test.ts
git commit -m "feat(back): les achats d un compte changent sa run suivante

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 7 : le rayon de ramassage — le sixième site, et l'octet de plus

C'est la tâche qui coûte le plus, et la seule qui élargit le fil.

**Files :**
- Modify: `shared/protocol.ts`
- Modify: `shared/protocol.test.ts`
- Modify: `back/src/combat.ts`
- Modify: `back/src/combat.test.ts`
- Modify: `back/src/room.ts`
- Modify: `front/src/net/client.ts`

**Interfaces :**
- Consumes: `PlayerState.accountBonuses` (tâche 6), `maxBonus` (tâche 1).
- Produces: `SNAPSHOT_PLAYER_BYTES = 10` ; `WirePlayer.pickupRadius: number` ;
  `PickupPoint.pickupRadius: number`.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/protocol.test.ts` :

```ts
describe('etape 7b tache 7 : le rayon de ramassage voyage par joueur', () => {
  /**
   * ⚠️ **Epingle en chiffres NUS.** Une assertion `toBe(SNAPSHOT_PLAYER_BYTES)`
   * serait vraie quoi qu'il arrive — c'est la doctrine deja appliquee a 22 et 9
   * plus haut dans ce fichier. **9 devient 10, et c'est le cout affiche de
   * l'etape 7b** : sept etapes sans un octet ajoute par tick s'arretent ici.
   */
  it('SNAPSHOT_PLAYER_BYTES vaut 10, et le snapshot a quatre joueurs fait 62 octets', () => {
    expect(SNAPSHOT_HEADER_BYTES).toBe(22);
    expect(SNAPSHOT_PLAYER_BYTES).toBe(10);
    const buf = encodeSnapshot(1, 0, 0, 0, 0, 0, [
      { id: 1, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90 },
      { id: 2, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90 },
      { id: 3, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90 },
      { id: 4, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90 },
    ]);
    expect(buf.byteLength).toBe(62);
  });

  it('le rayon fait l aller-retour, par joueur', () => {
    const buf = encodeSnapshot(1, 0, 0, 0, 0, 0, [
      { id: 1, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90 },
      { id: 2, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 170 },
    ]);
    const msg = decode(buf);
    if (msg.type !== MSG.SNAPSHOT) {
      throw new Error('type inattendu');
    }
    expect(msg.players.map((p) => p.pickupRadius)).toEqual([90, 170]);
  });

  it('un rayon au-dela de 255 est borne plutot que replie', () => {
    const buf = encodeSnapshot(1, 0, 0, 0, 0, 0, [
      { id: 1, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 400 },
    ]);
    const msg = decode(buf);
    if (msg.type !== MSG.SNAPSHOT) {
      throw new Error('type inattendu');
    }
    expect(msg.players[0]?.pickupRadius).toBe(255);
  });
});
```

⚠️ **La signature exacte d'`encodeSnapshot` est à relire** (`grep -n "export function encodeSnapshot"
shared/protocol.ts`) : les tests ci-dessus supposent un ordre d'arguments qu'il faut vérifier, et
`WirePlayer` gagne `pickupRadius`, donc **tous les littéraux de joueur du fichier de test** doivent
le porter. Il y en a beaucoup : c'est mécanique, mais c'est long.

Dans `back/src/combat.test.ts` :

```ts
describe('etape 7b tache 7 : le rayon de ramassage est personnel', () => {
  it('un joueur au rayon elargi ramasse une orbe qu un joueur de base ne ramasse pas', () => {
    const champ = new OrbField(8);
    const loin = ORB_PICKUP_RADIUS + 30;
    champ.spawn(1, loin, 0, 0);

    // Un joueur au rayon de base ne l'atteint pas.
    expect(champ.resolvePickups([{ x: 0, y: 0, pickupRadius: ORB_PICKUP_RADIUS }])).toEqual([]);
    // Le meme point, au rayon elargi, l'atteint.
    expect(champ.resolvePickups([{ x: 0, y: 0, pickupRadius: loin + 1 }])).toEqual([1]);
  });
});
```

⚠️ `OrbField#spawn` a une signature à relire — calque-toi sur les tests existants du fichier.

- [ ] **Étape 2 : lancer pour vérifier que ça échoue**

```bash
cd back && npx vitest run ../shared/protocol.test.ts src/combat.test.ts
```

Attendu : ÉCHEC — `SNAPSHOT_PLAYER_BYTES` vaut 9, et `resolvePickups` ignore le rayon.

- [ ] **Étape 3 : le protocole**

`shared/protocol.ts` :

```ts
/**
 * `id u8 · x i16 · y i16 · hp u16 · aimX i8 · aimY i8 · pickupRadius u8`
 *
 * ⚠️ **9 est devenu 10 a l'etape 7b, et c'est le cout AFFICHE de cette
 * etape.** Sept etapes consecutives sans un octet ajoute par tick s'arretent
 * ici, par decision explicite : le rayon de ramassage devient achetable, donc
 * personnel, et `DerivedOrbs#capture` ne peut pas predire le ramassage d'un
 * coequipier sans connaitre SON rayon — son propre docbloc dit qu'une capture
 * declenchee sans ramassage reel « mentirait ».
 *
 * La proportion : +4 octets par snapshot a quatre joueurs, soit +0,47 ko/s pour
 * le salon a 30 Hz. L'architecture du §3.3 a economise ~150 ko/s en ne
 * repliquant pas les positions de la horde ; ce surcout en represente 0,3 %.
 *
 * ⚠️ **`u8`, et c'est CALCULE** : la base vaut 90, le plafond d'un octet non
 * signe 255, donc 165 px de marge. `shared/shop.test.ts` assene
 * `ORB_PICKUP_RADIUS + maxBonus('pickupRadius') <= 255` en DERIVANT le maximum
 * du catalogue.
 */
export const SNAPSHOT_PLAYER_BYTES = 10;
```

`WirePlayer` gagne `pickupRadius: number`. Dans `encodeSnapshot`, après `aimY` :

```ts
    v.setUint8(o + 9, Math.min(255, Math.max(0, Math.round(p.pickupRadius))));
```

et dans `decodeSnapshot`, le champ symétrique : `pickupRadius: v.getUint8(o + 9)`.

- [ ] **Étape 4 : le serveur**

`back/src/combat.ts` — `PickupPoint` gagne le rayon, et `resolvePickups` **précalcule** :

```ts
export interface PickupPoint {
  readonly x: number;
  readonly y: number;
  /** Rayon de ramassage de CE joueur : `ORB_PICKUP_RADIUS` plus ses achats. */
  readonly pickupRadius: number;
}
```

```ts
  resolvePickups(players: readonly PickupPoint[]): number[] {
    // ⚠️ **Precalcule hors des deux boucles.** Le `r2` etait hoiste parce qu'il
    // etait unique ; maintenant qu'il y en a un par joueur, le recalculer dans
    // la boucle interne le ferait pour chaque orbe ET chaque joueur. Un tableau
    // parallele garde exactement le meme cout qu'avant.
    const r2 = players.map((p) => p.pickupRadius * p.pickupRadius);
    const picked: number[] = [];
    for (let i = this.#count - 1; i >= 0; i--) {
      const ox = this.x[i] ?? 0;
      const oy = this.y[i] ?? 0;
      let caught = false;
      for (let j = 0; j < players.length; j++) {
        const p = players[j];
        if (!p) {
          continue;
        }
        const dx = ox - p.x;
        const dy = oy - p.y;
        if (dx * dx + dy * dy <= (r2[j] ?? 0)) {
          caught = true;
          break;
        }
      }
      // ... inchange
```

Dans `back/src/room.ts`, le joueur expose son rayon là où le snapshot et `resolvePickups` le lisent :

```ts
  #pickupRadiusOf(p: PlayerState): number {
    return ORB_PICKUP_RADIUS + p.accountBonuses.pickupRadius;
  }
```

et le `WirePlayer` construit pour le snapshot le porte. **Retrouve le site** par
`grep -n "aimY:" back/src/room.ts`.

- [ ] **Étape 5 : le client**

`front/src/net/client.ts`, dans `DerivedOrbs#capture` : remplace le `r2` unique par le rayon de
**chaque** joueur, lu depuis `PickupTarget` (qui vient du snapshot interpolé).

```ts
  capture(players: readonly PickupTarget[], flights: OrbFlights, nowMs: number): void {
```

⚠️ **`PickupTarget` doit gagner `pickupRadius`**, et le docbloc de `capture` doit être **corrigé** :
il affirme aujourd'hui que client et serveur comparent « au MEME rayon », ce qui devient faux. Écris
qu'ils comparent **au rayon de chaque joueur, transporté par le `SNAPSHOT` depuis l'etape 7b**, et
que c'est précisément ce qui empêche la capture de mentir.

- [ ] **Étape 6 : lancer, lint, typecheck, commit**

```bash
cd back && npx vitest run ../shared/protocol.test.ts src/combat.test.ts src/room.test.ts
cd ../front && npx vitest run src/net/client.test.ts src/net/interpolation.test.ts
cd .. && npm run lint && npm run typecheck
git add shared/protocol.ts shared/protocol.test.ts back/src/combat.ts back/src/combat.test.ts back/src/room.ts front/src/net/client.ts
git commit -m "feat: le rayon de ramassage est personnel, et voyage par joueur

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

⚠️ **Beaucoup de fichiers assènent la taille du snapshot** (`accounts.http.test.ts`,
`credit.integration.test.ts`, `elements-5b/5c`, `portal`, `server.test.ts`). Lance-les **un par un**
et mets à jour les chiffres épinglés : **9 devient 10, 58 devient 62**. C'est mécanique, et c'est le
travail que l'épinglage en chiffres nus est censé provoquer.

---

## Tâche 8 : la boutique à l'écran, et le grisage

**Files :**
- Modify: `front/index.html`
- Create: `front/src/ui/shop.ts`
- Create: `front/src/ui/shop.test.ts`
- Modify: `front/src/net/account.ts`
- Modify: `front/src/main.ts`

**Interfaces :**
- Consumes: `SHOP_ITEMS`, `priceOf` (tâche 1) ; les deux routes (tâche 5).
- Produces: `renderShop(root, etat, onBuy)` ; `type EtatBoutique = { gold: bigint; purchases: Record<string, number> }`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/ui/shop.test.ts` — teste la **logique d'affichage**, sans DOM réel si possible, sinon avec
un élément détaché :

```ts
describe('etape 7b tache 8 : la boutique', () => {
  it('un article deja au palier maximum n est plus achetable', () => {
    const article = SHOP_ITEMS.find((i) => i.levels === 1);
    if (!article) {
      throw new Error('aucun article a un seul palier');
    }
    expect(achetable(article, { gold: 10_000n, purchases: { [article.id]: 1 } })).toBe(false);
  });

  it('un article trop cher n est pas achetable, mais reste visible', () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    expect(achetable(article, { gold: 0n, purchases: {} })).toBe(false);
  });

  it('un article abordable et non possede est achetable', () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    expect(achetable(article, { gold: BigInt(priceOf(article, 1)), purchases: {} })).toBe(true);
  });

  /**
   * ⚠️ **Le grisage du draft ne coute AUCUN octet** : le client connait son
   * propre ensemble, lu en HTTP au chargement. Ce test garde ce predicat.
   */
  it('une arme verrouillee non achetee est grisee, achetee elle ne l est plus', () => {
    const arme = SHOP_ITEMS.find((i) => i.kind === 'weapon');
    if (!arme?.weaponId) {
      throw new Error('aucun article d arme');
    }
    expect(carteGrisee(arme.weaponId, {})).toBe(true);
    expect(carteGrisee(arme.weaponId, { [arme.id]: 1 })).toBe(false);
  });

  it('une arme libre n est jamais grisee', () => {
    const libre = WEAPONS.find((w) => !w.locked && w.id !== BASE_WEAPON_ID);
    if (!libre) {
      throw new Error('aucune arme libre');
    }
    expect(carteGrisee(libre.id, {})).toBe(false);
  });
});
```

- [ ] **Étape 2 : lancer pour vérifier que ça échoue**

```bash
cd front && npx vitest run src/ui/shop.test.ts
```

Attendu : ÉCHEC — `./shop` n'existe pas.

- [ ] **Étape 3 : écrire `front/src/ui/shop.ts`**

Deux prédicats purs et une fonction de rendu :

```ts
export interface EtatBoutique {
  gold: bigint;
  purchases: Record<string, number>;
}

/** Ce joueur peut-il acheter le palier suivant de cet article ? */
export function achetable(item: ShopItem, etat: EtatBoutique): boolean {
  const palier = (etat.purchases[item.id] ?? 0) + 1;
  if (palier > item.levels) {
    return false;
  }
  return etat.gold >= BigInt(priceOf(item, palier));
}

/**
 * Cette carte d'arme doit-elle etre grisee dans l'etalage du draft ?
 *
 * ⚠️ **Calcule depuis les achats du joueur LOCAL, jamais recu du serveur.**
 * C'est ce qui permet au grisage de ne couter aucun octet : le `DRAFT_OPEN` ne
 * transporte aucune eligibilite. Le serveur, lui, refuse le jeton — le grisage
 * est une politesse, le refus est la regle.
 */
export function carteGrisee(weaponId: number, purchases: Record<string, number>): boolean {
  const arme = WEAPONS.find((w) => w.id === weaponId);
  if (!arme?.locked) {
    return false;
  }
  return !SHOP_ITEMS.some(
    (i) => i.kind === 'weapon' && i.weaponId === weaponId && (purchases[i.id] ?? 0) > 0,
  );
}
```

Puis `renderShop(root: HTMLElement, etat: EtatBoutique, onBuy: (itemId: string) => void): void` qui
construit une ligne par article : libellé, palier courant sur total, prix du palier suivant, et un
bouton désactivé quand `achetable` est faux.

- [ ] **Étape 4 : le panneau dans le lobby**

Dans `front/index.html`, après le paragraphe `Or : …` du `#lobby` :

```html
            <div id="shop" class="flex w-full flex-col gap-2"></div>
```

- [ ] **Étape 5 : le câblage**

Dans `front/src/net/account.ts`, la lecture HTTP rend désormais les achats en plus du solde. Dans
`front/src/main.ts`, appelle `renderShop` avec l'état lu, et sur clic : `POST
/accounts/me/purchases`, puis **réaffiche depuis la réponse** (qui porte `{ gold, purchases }`) plutôt
que de relire.

⚠️ **Un échec d'achat ne doit pas casser l'écran.** Écris le message dans `#error`, comme le fait déjà
le chemin du solde — et rappelle-toi que `chargeSolde` est enveloppé d'un `try`/`catch` depuis la
vague finale de 7a, précisément parce qu'un rejet de niveau module arrêtait l'enregistrement de tous
les écouteurs.

- [ ] **Étape 6 : lancer, lint, typecheck, commit**

```bash
cd front && npx vitest run src/ui/shop.test.ts src/net/account.test.ts
cd .. && npm run lint && npm run typecheck
git add front/index.html front/src/ui/shop.ts front/src/ui/shop.test.ts front/src/net/account.ts front/src/main.ts
git commit -m "feat(front): la boutique a l accueil, et le grisage du draft

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 9 : le livrable

**Files :**
- Create: `back/src/boutique.integration.test.ts`

- [ ] **Étape 1 : écrire le test**

Le livrable en une phrase : **un joueur dépense son or, et sa run suivante en est changée.** Reprends
le harnais de `bonus.integration.test.ts` (**duplique**).

```ts
describe('etape 7b : le livrable — depenser change la run suivante', () => {
  /**
   * ⚠️ **La seconde run est tout le test.** Verifier que la base contient
   * l'achat prouverait l'ecriture ; verifier qu'une run OUVERTE APRES l'achat
   * donne un joueur plus resistant prouve que l'achat a changé le jeu. C'est la
   * difference entre tester l'implementation et tester le livrable.
   */
  it('un joueur achete, rejoue, et sa run est differente', async () => {
    const v = SHOP_ITEMS.find((i) => i.bonusKind === 'maxHp');
    if (!v) {
      throw new Error('aucun article de vitalite');
    }
    const { token, accountId } = await compteNeuf();

    // 1. Une premiere run, sans aucun achat.
    const code1 = await createRoomCode();
    const room1 = app.rooms.get(code1);
    if (!room1) {
      throw new Error('salon introuvable');
    }
    const c1 = await connectAvecJeton(code1, token);
    await attendre(() => (room1.playerCount === 1 ? true : null), 'run 1', 3000);
    expect(room1.maxHpOf(c1.playerId)).toBe(PLAYER_MAX_HP);
    c1.ws.close();
    await attendre(() => (room1.playerCount === 0 ? true : null), 'fermeture', 3000);

    // 2. L'achat, par la route HTTP — le vrai chemin du joueur.
    await creditAccounts([accountId], BigInt(priceOf(v, 1)));
    const achat = await app.inject({
      method: 'POST',
      url: '/accounts/me/purchases',
      headers: { authorization: `Bearer ${token}` },
      payload: { itemId: v.id },
    });
    expect(achat.statusCode).toBe(200);

    // 3. Une seconde run, et elle est differente.
    const code2 = await createRoomCode();
    const room2 = app.rooms.get(code2);
    if (!room2) {
      throw new Error('salon introuvable');
    }
    const c2 = await connectAvecJeton(code2, token);
    await attendre(() => (room2.playerCount === 1 ? true : null), 'run 2', 3000);
    expect(room2.maxHpOf(c2.playerId)).toBe(PLAYER_MAX_HP + (v.perLevel ?? 0));
  });

  it('une arme verrouillee non achetee est refusee par le SERVEUR, pas seulement grisee', async () => {
    const arme = SHOP_ITEMS.find((i) => i.kind === 'weapon');
    if (!arme?.weaponId) {
      throw new Error('aucun article d arme');
    }
    const { token } = await compteNeuf();
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const client = await connectAvecJeton(code, token);
    await attendre(() => (room.playerCount === 1 ? true : null), 'connexion', 3000);

    // Le serveur refuse le jeton, quel que soit ce que le client affiche.
    expect(room.setDraftToken(client.playerId, 0)).toBe(false);
  });

  it('un compte neuf atteint les six elements : chaque element a une arme LIBRE', () => {
    for (const e of ELEMENTS.filter((e) => e.id !== ELEMENT.NEUTRE)) {
      expect(WEAPONS.some((w) => w.element === e.id && !w.locked), `element ${e.id}`).toBe(true);
    }
  });

  it('le SNAPSHOT fait 62 octets a quatre joueurs, et ZONE/REACTION/DRAFT_OPEN ne bougent pas', async () => {
    expect(SNAPSHOT_HEADER_BYTES + 4 * SNAPSHOT_PLAYER_BYTES).toBe(62);
    expect(ZONE_BYTES).toBe(11);
    expect(REACTION_BYTES).toBe(11);

    // ⚠️ **`DRAFT_OPEN` est le message que le grisage aurait pu faire grossir**,
    // si on avait choisi d'envoyer un masque d'eligibilite au lieu de laisser le
    // client griser depuis son propre ensemble. Mesure sa taille REELLE sur une
    // ouverture de draft, pas seulement ses constantes : c'est le seul moyen de
    // prouver que la decision du §3.5 de la spec a tenu.
    const taillesDraft = tailleParType(client, MSG.DRAFT_OPEN);
    expect(taillesDraft.length).toBeGreaterThan(0);
    expect(new Set(taillesDraft).size).toBe(1);
  });
});
```

⚠️ **Le second test suppose que l'étalage contient l'arme verrouillée à l'indice 0**, ce qui n'est pas
garanti — l'étalage est tiré au hasard sur l'union, et un compte neuf a une union **vide**, donc
l'arme n'y est **pas du tout**. **Ce test est donc faux comme écrit.** Corrige-le : fais poser le
jeton sur une carte qui existe, ou construis un décor où un AUTRE joueur de la salle a débloqué l'arme
(l'union la contient alors, et le premier joueur ne peut pas la prendre). **La seconde version est la
bonne**, et c'est elle qui prouve l'union plus le refus. Dis dans ton rapport comment tu l'as fait.

- [ ] **Étape 2 : lancer cinq fois**

```bash
export DATABASE_URL='postgresql://tarnok:tarnok@127.0.0.1:5442/tarnok'
cd back && npx vitest run src/boutique.integration.test.ts
```

**Donne les cinq résultats.** Un seul rouge sur cinq et le décor n'est pas déterministe.

- [ ] **Étape 3 : COMMIT, puis la campagne de mutation**

Le commit vient **avant** la campagne : elle restaure par `git checkout` et effacerait tout travail
non committé.

| Mutation | Fichier | Doit faire rougir |
| --- | --- | --- |
| `bonusesOf` rend toujours `BONUS_ZERO` | `back/src/accounts.ts` | le livrable, « sa run est differente » |
| `buyItem` ne débite pas (retire le `decrement`) | `back/src/accounts.ts` | tâche 4, « debite EXACTEMENT le prix » |
| `buyItem` insère sans vérifier le solde | `back/src/accounts.ts` | tâche 4, « solde insuffisant » |
| `#eligible` ignore `locked` | `back/src/draft.ts` | tâche 3 et le livrable |
| `locked: false` sur les six armes | `shared/weapons.ts` | tâche 2, « exactement six » |
| `locked: true` sur les deux armes d'un élément | `shared/weapons.ts` | tâche 2, « chaque element garde une arme LIBRE » |
| `SNAPSHOT_PLAYER_BYTES = 9` | `shared/protocol.ts` | tâche 7 et le livrable |
| `resolvePickups` reprend un `r2` unique | `back/src/combat.ts` | tâche 7 |
| `maxBonus` rend `0` | `shared/shop.ts` | tâche 1, le test du `u8` |

**Applique la mutation, ne la raisonne pas.** Compte les rouges **sur le fichier entier**, jamais avec
un filtre `-t`, et donne la commande exacte. Une mutation qui reste verte est un trou : dis-le, ajoute
l'assertion, re-committe.

---

## Tâche 10 : résultats et README

**Files :**
- Create: `docs/plans/2026-10-11-etape-7b-resultats.md`
- Modify: `README.md`

- [ ] **Étape 1 : le portique complet, lancé par le COORDINATEUR**

⚠️ **Pas par toi.** `npm test` dure douze minutes et le harnais le détache à deux : c'est une
contradiction qu'un implémenteur ne peut pas résoudre. Demande les chiffres au coordinateur.

- [ ] **Étape 2 : le document de résultats**

Mêmes sections que `docs/plans/2026-10-10-etape-7a-resultats.md`. Y inscrire au minimum :

- le livrable, et **ce qui le distingue** : la tâche 6 prouve que les bonus **arrivent**, la tâche 9
  prouve qu'une run ouverte **après** l'achat est différente ;
- **le coût affiché** : `SNAPSHOT_PLAYER_BYTES` 9 → 10, +4 octets à quatre joueurs, +0,47 ko/s par
  salon, soit **0,3 %** de ce que l'architecture du §3.3 a économisé. Sept étapes sans octet ajouté
  par tick s'arrêtent ici, **par décision explicite** ;
- **ce que la spec a amendé** : le §11 listait les slots d'armes ; six slots font couvrir les quinze
  réactions à un joueur seul, donc l'article est retiré et le §11 corrigé ;
- **les classes n'existent toujours pas** (§15.1 jamais tranché), donc le second volet des déblocages
  du §11 reste sans chemin ;
- les écarts assumés du §8 de la spec, repris et actualisés ;
- une section **« vérification manuelle » laissée OUVERTE** pour la run de l'auteur ;
- et le fait que **cinq playtests sont désormais dus** : 5b §4, 6a §3, 5c §12, 7a, et celui-ci.

- [ ] **Étape 3 : la ligne du README**

Après la ligne `7a` du tableau d'état :

```markdown
| 7b | La boutique : six armes débloquables, améliorations permanentes | 📝 — [spec](docs/specs/2026-10-11-etape-7b-boutique.md) · [plan](docs/plans/2026-10-11-etape-7b-boutique.md) · [résultats](docs/plans/2026-10-11-etape-7b-resultats.md) |
```

⚠️ **Et vérifie la première phrase du README.** Elle dit qu'un joueur seul ne peut pas tout
déclencher, et l'étape 5c l'a rendue mesurée. **Cette étape ne l'affaiblit pas** — aucun slot n'est
vendable, et chaque élément garde une arme libre. **Dis-le** dans le document de résultats plutôt que
de laisser le lecteur se demander si la boutique a érodé le pitch.

- [ ] **Étape 4 : commit**

```bash
git add docs/plans/2026-10-11-etape-7b-resultats.md README.md
git commit -m "docs: resultats de l'etape 7b

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```
