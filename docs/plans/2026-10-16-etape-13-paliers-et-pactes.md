# Étape 13 — quatre paliers et des légendaires qui coûtent : plan d'implémentation

> **Pour les agents :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou
> superpowers:executing-plans, tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**But :** un étalage tire sur quatre paliers ; les deux plus hauts ne donnent plus des cartes en
plus gros mais des cartes qui changent une règle, et la plus haute se paie d'un malus — jusqu'à
Transcendance, qui échange les PV max contre un bouclier qui se régénère.

**Architecture :** tout passe par de la donnée déjà lue. Un malus est une paire
`{ kind, magnitude }` que `Loadout.bonus(kind)` retranche, donc il traverse `cooldownWithBonus`,
`shotDamage`, `critOf` et les PV max sans qu'aucun appelant soit touché. Une règle (`rule`) est un
discriminant nommé — même idiome que `Weapon.kind` — dont la branche vit à **un seul endroit**,
parce que la somme des PV max, aujourd'hui recopiée côté serveur et côté client, descend d'abord
dans `shared/`. Le bouclier, lui, exige une fusion préalable : les quatre copies de la formule de
dégâts deviennent `hurtPlayer`, sans quoi il serait traversable par trois sources sur quatre.

**Pile :** TypeScript, `ws`, Fastify, Pixi.js v8, Vitest (jsdom côté front pour l'UI), Biome,
Prisma/Postgres pour les tests d'intégration.

**Spec :** [`docs/specs/2026-10-16-etape-13-paliers-et-pactes.md`](../specs/2026-10-16-etape-13-paliers-et-pactes.md)

**Où l'on travaille :** dans le worktree `../Tarnok-pactes`, branche `etape-13-pactes`, **déjà
créé et vérifié** — ne pas le recréer.

Sa base n'est ni `main` ni `etape-11-porteur`, mais les **deux** :

```
etape-11-porteur (3 commits : bestiaire, plancher de rareté, fuite)
  + le Guide et les documents de l'étape 13
  + merge de main (qui contient l'étape 12 : dix armes, dix formes de tir)
```

⚠️ **Pourquoi les deux, et pourquoi ce n'est pas négociable.** Les tâches 1 et 2 ont besoin de
`rollRarity(rng, floor)` et `CHEST_RARITY_FLOOR`, qui ne vivent que dans `etape-11-porteur`
(commit `51fb010`). Et `front/src/ui/guide.ts`, que la tâche 8 modifie, emploie le vocabulaire de
l'étape 12 (`onde`, `motion`, `emission`, `fragments`, `growth`) : sur la seule base de l'étape 11
il ne compile pas. La première tentative de worktree est morte exactement là.

⚠️ **L'étape 11 est EN VOL** (3 tâches sur 11 au moment d'écrire). Cette branche en porte un
instantané. Quand 11 finira et fusionnera, la fusion avec celle-ci se fera sur un ancêtre commun —
mais si le `floor` ou `CHEST_RARITY_FLOOR` changent d'ici là, les tâches 1 et 2 sont à relire.

État vérifié de la base, portique lancé seul : `lint` vert, `tsc` vert, **1496 tests passants**.
C'est le point de départ ; toute régression vient de nous.

## Contraintes globales

- **Discipline de sous-agent (règle d'étape, établie en 5b et confirmée en 5c).** Un sous-agent qui
  implémente une tâche ne lance **que ses fichiers ciblés**, **jamais `npm test`**, **jamais un
  banc**.
  ⚠️ **Les tests de `shared/` se lancent depuis `back/`** : `cd back && npx vitest run
  ../shared/<fichier>.test.ts`. Seul `back/vitest.config.ts` câble `../shared/**/*.test.ts` ;
  `front/vitest.config.ts` n'inclut que `src/**`, donc un `--config front/...` sur un fichier de
  `shared/` ne collecte **rien** et rend un faux vert. Les tests du front se lancent depuis
  `front/` : `npx vitest run src/ui/<fichier>.test.ts`. Le portique complet et toute
  mesure chiffrée sont au contrôleur, qui les lance **seuls, rien d'autre en vol** — un chiffre
  mesuré pendant qu'autre chose tourne est faux.
- **Jamais `pkill -f`.** Les serveurs de développement de Léo tournent sur **5173** et **3100**, et
  il joue dessus. Viser un PID précis, ou ne rien tuer.
- Constantes, valeurs de la spec, **jamais un nombre en dur ailleurs** :
  - `shared/rarity.ts` : `RARITY = { COMMUNE: 0, RARE: 1, EPIQUE: 2, LEGENDAIRE: 3 }` ;
    `RARITY_MULTIPLIERS = [1, 2, 1, 1]` ; `RARITY_WEIGHTS = [72, 20, 6, 2]`.
  - `shared/constants.ts` : `SHIELD_POOL = 60` ; `SHIELD_CALM_TICKS = 90` (3 s à 30 Hz) ;
    `SHIELD_REGEN_PER_SEC = 20` ; `TRANSCENDANCE_MAX_HP = 1`.
  - `shared/passives.ts` : Fournaise `damage +0.6` / `malus { maxHp, 40 }` ; Hâte funeste
    `fireRate 0.5` / `malus { armor, 0.5 }` ; Contagion, Écho, Colosse en `tier: 'epique'`.
- **Un seul octet de fil en plus** : `SNAPSHOT_PLAYER_BYTES` passe de **10 à 11** (`shield u8`).
  `DRAFT_CARD_BYTES` ne bouge pas — quatre paliers tiennent dans l'octet `rarity` de l'étape 10.
  Aucun message nouveau.
- **Tous les chiffres d'équilibrage sont des molettes de playtest**, commentées comme telles dans
  la table, jamais dérivées d'autre chose.
- **`PASSIVE_SLOTS` n'existe plus** (§2.0 de la spec) : un passif est toujours prenable.
  `WEAPON_SLOTS = 4` ne bouge pas.
- **Le français des libellés est celui du jeu** : accents, apostrophes typographiques (`’`), et les
  identifiants de code restent sans accent (`name: 'hate-funeste'`, `label: 'Hâte funeste'`).

## Points de vigilance de la revue

Cinq entrées que la spec implique sans qu'aucune tâche ne les exerce spontanément. Chacune a son
test, rattaché à la tâche qui possède le code.

1. **Un maximum de PV qui BAISSE pendant que le joueur est blessé le tue.** `room.ts:2587` fait
   `player.hp += nouveauMax - player.maxHp` : à 30 PV, prendre Fournaise (−40 max) donne
   `hp = -10`, donc une mort à l'acceptation de la carte. Transcendance (max → 1) tue tout joueur
   sous 100 PV. Le delta doit être borné dans `[1, nouveauMax]` tant que le joueur est vivant →
   **test tâche 4**.
2. **Une armure qui sort de ses bornes.** Deux Hâte funeste donnent `bonus('armor') = -1` donc un
   facteur `1 − (−1) = 2` (voulu, un pacte s'empile) ; mais une armure de boutique > 1 rendrait le
   facteur négatif et **soignerait** au lieu de blesser. `hurtPlayer` borne le facteur à ≥ 0 →
   **test tâche 3**.
3. **Un palier tiré dont le pool est ÉPUISÉ dans le même étalage.** `drawSpread` tire sans remise
   et il n'y a que trois épiques : au quatrième emplacement épique d'un étalage à quatre joueurs,
   plus aucune carte n'est permise et `drawSpread` sortirait avec moins de cartes que de joueurs.
   (La cause « emplacements de passifs pleins » disparaît avec la tâche 0 ; celle-ci reste.) La
   descente s'arrête au plancher de l'emplacement → **test tâche 2**.
4. **Un bouclier qui déborde ou qui descend sous zéro.** Coup de 50 sur une réserve de 40 : la
   réserve tombe à 0 (pas à −10) et les 10 restants mordent les PV ; une régénération ne dépasse
   jamais `SHIELD_POOL` → **test tâche 5**.
5. **Un client qui reçoit un bouclier pour un joueur dont il ignore l'inventaire** (arrivé en
   cours de partie, ou allié dont il n'a pas vu le `DRAFT_RESULT`) : la barre se peint depuis le
   snapshot seul, sans jamais lire le miroir d'inventaire, donc elle ne ment pas → **test tâche 8**.

---

## Carte des fichiers

| Fichier | Rôle |
| --- | --- |
| `shared/constants.ts`, `shared/loadout.ts`, `front/src/ui/{draft,hud,guide}.ts` | **Tâche 0** : la limite de passifs disparaît |
| `shared/rarity.ts`, `shared/rarity.test.ts` | Les quatre paliers, les multiplicateurs, les poids |
| `shared/cards.ts`, `shared/cards.test.ts` | `tierOf`, l'exclusivité par palier, la descente de palier |
| `shared/passives.ts`, `shared/passives.test.ts` | `tier`, `malus`, `rule`, le genre `armor`, le contenu, la suppression de Moisson |
| `shared/loadout.ts`, `shared/loadout.test.ts` | `bonus(kind)` retranche le malus ; `maxHpOf` partagé |
| `shared/constants.ts` | `SHIELD_*`, `TRANSCENDANCE_MAX_HP` ; suppression de `HARVEST_RADIUS` |
| `shared/protocol.ts`, `shared/protocol.test.ts` | `SNAPSHOT_PLAYER_BYTES` 10 → 11, `shield u8` |
| `back/src/combat.ts`, `back/src/combat.test.ts` | `hurtPlayer` (fusion des 4 sites) ; suppression de `resolveHarvest` ; Contagion |
| `back/src/room.ts`, `back/src/room.test.ts` | `shield`, `shieldCalmTicks`, la régénération, le recalcul borné des PV max |
| `front/src/net/client.ts`, `front/src/net/client.test.ts` | `localMaxHp` via `maxHpOf` ; le bouclier lu du snapshot |
| `front/src/ui/draft.ts`, `front/src/ui/draft.test.ts` | `RARITY_NAMES` à quatre, la ligne de malus |
| `front/src/ui/guide.ts`, `front/src/ui/guide.test.ts` | Le palier épique dans les bases, le malus sur les passifs |
| `front/src/ui/hud.ts`, `front/src/ui/hud.test.ts`, `front/index.html`, `front/src/styles/main.css` | La barre de bouclier, la bordure du palier 3 |
| `back/src/pactes.integration.test.ts` (créé) | **le livrable** |
| `docs/plans/2026-10-16-etape-13-resultats.md` (créé), `README.md` | le bilan |

### Aides de test à créer

Elles n'existent pas dans le dépôt : chaque tâche crée celles qu'elle emploie, dans son propre
fichier de test, à côté des aides déjà présentes.

| Aide | Fichier | Rôle |
| --- | --- | --- |
| `salonSolo()`, `idDe(name)` | `back/src/room.test.ts` | Un salon d'un joueur ; l'id d'un passif par son `name` |
| `debugSetHp`, `debugHurt`, `debugGrant`, `debugSteps`, `debugFreeze`, `shieldOf` | `back/src/room.ts` | Crochets de test, **à côté de `debugKill`/`debugRevive` qui existent déjà** et sur le même modèle |
| `hordeDe(entites)` | `back/src/combat.test.ts` | Une horde minuscule de positions et de marques |
| `unJoueur(partiel)` | `shared/protocol.test.ts` | Un enregistrement de snapshot aux champs par défaut |
| `hudElementsDeTest()`, `sourceVide()` | `front/src/ui/hud.test.ts` | Les cases du HUD et une source neutre |
| `equipe(...loadouts)` | `shared/cards.test.ts` | **Existe déjà** (étape 10) : une `Map` d'inventaires |

Pourquoi ce découpage : le modèle de paliers (1) ne dépend de rien ; le tirage (2) en dépend seul ;
`hurtPlayer` (3) est un **refactor à comportement identique** qu'un relecteur peut accepter sans
rien connaître du reste, et il doit précéder le malus d'armure comme le bouclier ; le malus (4) et
le bouclier (5) sont deux mécaniques indépendantes ; Transcendance (6) a besoin des deux ; le
contenu (7) a besoin de tout ; l'écran (8) lit ce que les autres produisent ; le livrable (9)
vient quand tout est là ; le portique (10) est au contrôleur.

---

### Tâche 0 : les passifs n'ont plus de limite

Décidée par Léo pendant l'exécution, avant toute dispatch. **Elle précède la tâche 1** parce que la
tâche 2 écrit des tests sur la prenabilité des passifs.

**Fichiers :**
- Modifier : `shared/constants.ts` (`PASSIVE_SLOTS` l.~422), `shared/loadout.ts` (l.1, l.118-119,
  l.138), `front/src/ui/draft.ts` (l.5, l.180), `front/src/ui/hud.ts` (l.2, l.142, l.160),
  `front/src/ui/guide.ts` (l.20, l.268)
- Tester : `shared/loadout.test.ts`, `front/src/ui/draft.test.ts`, `front/src/ui/hud.test.ts`,
  `front/src/ui/guide.test.ts`

**Interfaces :**
- Produit : `PASSIVE_SLOTS` **supprimé** ; `Loadout.canTake(CARD.PASSIVE, …)` rend toujours `true` ;
  `Loadout.addPassive` ne lève plus ; `blockedReason` rend `null` pour tout passif.
- ⚠️ `passiveSlotsUsed` **reste** : il compte les passifs distincts possédés, et le HUD s'en sert
  pour savoir combien de cadres peindre. Il n'est simplement plus comparé à une borne.

- [ ] **Étape 1 : écrire les tests qui échouent**

```ts
describe('etape 13 : les passifs ne sont plus limites', () => {
  it('on peut empiler plus de passifs distincts qu il n y avait d emplacements', () => {
    const l = new Loadout();
    const distincts = PASSIVES.filter((p) => !p.tier).slice(0, 8);
    expect(distincts.length).toBeGreaterThan(3);
    for (const p of distincts) {
      expect(l.canTake(CARD_PASSIVE, p.id)).toBe(true);
      expect(() => l.addPassive(p.id)).not.toThrow();
    }
    expect(l.passiveSlotsUsed).toBe(distincts.length);
  });

  /** ⚠️ Les ARMES gardent leur limite : c'est elle qui porte le renoncement. */
  it('l arsenal reste borne a WEAPON_SLOTS', () => {
    const l = new Loadout();
    for (let i = 0; i < WEAPON_SLOTS; i++) {
      l.addWeapon(i);
    }
    expect(l.canTake(CARD_WEAPON, WEAPON_SLOTS + 1)).toBe(false);
  });
});
```

Dans `front/src/ui/draft.test.ts` :

```ts
it('etape 13 : une carte de passif n est jamais bloquee', () => {
  const l = new Loadout();
  for (const p of PASSIVES.filter((x) => !x.tier)) {
    l.addPassive(p.id);
  }
  expect(blockedReason({ nature: CARD.PASSIVE, refId: 0 }, l)).toBeNull();
});
```

Dans `front/src/ui/hud.test.ts` :

```ts
it('etape 13 : la colonne des passifs suit ce qui est possede, sans cadre vide', () => {
  const el = hudElementsDeTest();
  const l = new Loadout();
  l.addPassive(0);
  l.addPassive(1);
  paintPassives(el.passiveList, l);
  expect(el.passiveList.children).toHaveLength(2);
});
```

- [ ] **Étape 2 : lancer les tests pour les voir échouer**

Run : `cd back && npx vitest run ../shared/loadout.test.ts` puis
`cd front && npx vitest run src/ui/draft.test.ts src/ui/hud.test.ts`
Attendu : ÉCHEC — `addPassive` lève au 4ᵉ passif distinct, le HUD peint 3 cadres.

- [ ] **Étape 3 : retirer la limite**

Supprimer `PASSIVE_SLOTS` de `shared/constants.ts`. Dans `shared/loadout.ts` :

```ts
  /**
   * Nombre de passifs DISTINCTS possedes.
   *
   * ⚠️ **Ce n'est plus une consommation d'emplacements** (etape 13, §2.0) : la
   * limite de passifs a ete levee, les armes gardent la leur. Le compte reste
   * utile — le HUD s'en sert pour savoir combien de cadres peindre.
   */
  get passiveSlotsUsed(): number { /* inchange */ }
```

`addPassive` perd son `throw`, et `canTake` :

```ts
  canTake(nature: number, refId: number): boolean {
    if (nature === CARD_WEAPON) {
      return this.stacksOfWeapon(refId) > 0 || this.#weaponOrder.length < WEAPON_SLOTS;
    }
    // ⚠️ **Toujours vrai depuis l'etape 13** : un passif ne peut plus etre
    // refuse. Le parametre reste pour que la signature serve les deux natures.
    return true;
  }
```

- [ ] **Étape 4 : les trois écrans**

- `draft.ts` : `blockedReason` rend `null` pour `CARD.PASSIVE` sans condition ; son docbloc dit
  pourquoi (la règle `canTake` n'a plus de refus pour cette nature).
- `hud.ts` : `paintPassives` peint `passiveSlotsUsed` cadres et plus de remplissage jusqu'à une
  borne ; son docbloc perd la mention des cadres toujours visibles.
- `guide.ts` : la règle « Emplacements » devient
  `` `${WEAPON_SLOTS} armes au maximum. Les passifs, eux, ne sont pas limités.` ``

- [ ] **Étape 5 : lancer les tests pour les voir passer**

Run : `cd back && npx vitest run ../shared/loadout.test.ts ../shared/cards.test.ts`
puis `cd front && npx vitest run src/ui/`
Attendu : SUCCÈS. Les tests de l'étape 10 qui vérifiaient le refus d'un 4ᵉ passif disparaissent
avec la règle — les supprimer, pas les contourner.

- [ ] **Étape 6 : committer**

```bash
git add shared/constants.ts shared/loadout.ts shared/loadout.test.ts front/src/ui
git commit -m "feat: les passifs ne sont plus limites, l arsenal si"
```

---

### Tâche 1 : quatre paliers

**Fichiers :**
- Modifier : `shared/rarity.ts` (`RARITY` l.~9, `RARITY_MULTIPLIERS` l.~17, `RARITY_WEIGHTS` l.~23)
- Tester : `shared/rarity.test.ts`

**Interfaces :**
- Consomme : `rollRarity(rng, floor)` et `CHEST_RARITY_FLOOR`, de l'étape 11.
- Produit : `RARITY.EPIQUE = 2`, `RARITY.LEGENDAIRE = 3` ; `RARITY_MULTIPLIERS = [1, 2, 1, 1]` ;
  `RARITY_WEIGHTS = [72, 20, 6, 2]`.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/rarity.test.ts`, en fin de fichier :

```ts
describe('etape 13 : quatre paliers', () => {
  it('epique s intercale, legendaire monte a 3', () => {
    expect(RARITY.EPIQUE).toBe(2);
    expect(RARITY.LEGENDAIRE).toBe(3);
  });

  /**
   * ⚠️ Les deux paliers hauts valent 1 : une carte de REGLE ne se multiplie
   * jamais. C'est la table qui le dit, plus un cas particulier dans `cards.ts`.
   */
  it('seule la rare multiplie', () => {
    expect(RARITY_MULTIPLIERS).toEqual([1, 2, 1, 1]);
    expect(multiplierOf(RARITY.EPIQUE)).toBe(1);
    expect(multiplierOf(RARITY.LEGENDAIRE)).toBe(1);
  });

  it('les poids couvrent les quatre paliers et somment a 100', () => {
    expect(RARITY_WEIGHTS).toHaveLength(4);
    expect(RARITY_WEIGHTS.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('normalise ramene un octet hors table a commune, 3 compris desormais', () => {
    expect(normalizeRarity(3)).toBe(RARITY.LEGENDAIRE);
    expect(normalizeRarity(4)).toBe(RARITY.COMMUNE);
    expect(normalizeRarity(undefined)).toBe(RARITY.COMMUNE);
  });

  it('tire les quatre paliers a leurs poids', () => {
    const rng = makeRandom(0x13_0a_0001);
    const vus = [0, 0, 0, 0];
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const r = rollRarity(rng);
      vus[r] = (vus[r] ?? 0) + 1;
    }
    expect((vus[RARITY.COMMUNE] ?? 0) / N).toBeCloseTo(0.72, 2);
    expect((vus[RARITY.RARE] ?? 0) / N).toBeCloseTo(0.2, 2);
    expect((vus[RARITY.EPIQUE] ?? 0) / N).toBeCloseTo(0.06, 2);
    expect((vus[RARITY.LEGENDAIRE] ?? 0) / N).toBeCloseTo(0.02, 2);
  });

  /** Le plancher du coffre (etape 11) renormalise sur {20, 6, 2} = 28. */
  it('au plancher du coffre : 71 % rare, 21 % epique, 7 % legendaire', () => {
    const rng = makeRandom(0x13_0a_0002);
    const vus = [0, 0, 0, 0];
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const r = rollRarity(rng, CHEST_RARITY_FLOOR);
      vus[r] = (vus[r] ?? 0) + 1;
    }
    expect(vus[RARITY.COMMUNE]).toBe(0);
    expect((vus[RARITY.RARE] ?? 0) / N).toBeCloseTo(20 / 28, 2);
    expect((vus[RARITY.EPIQUE] ?? 0) / N).toBeCloseTo(6 / 28, 2);
    expect((vus[RARITY.LEGENDAIRE] ?? 0) / N).toBeCloseTo(2 / 28, 2);
  });
});
```

- [ ] **Étape 2 : lancer les tests pour les voir échouer**

Run : `cd shared/.. && cd back && npx vitest run ../shared/rarity.test.ts`
Attendu : ÉCHEC — `RARITY.EPIQUE` vaut `undefined`.

- [ ] **Étape 3 : écrire la table**

Dans `shared/rarity.ts`, remplacer les trois constantes :

```ts
/**
 * La rarete d'une carte de l'etalage (etape 13, §2 de la spec).
 *
 * ⚠️ **Deux familles, pas quatre.** COMMUNE et RARE MULTIPLIENT une carte
 * ordinaire ; EPIQUE et LEGENDAIRE sont des cartes de REGLE, exclusives a leur
 * palier (`Passive.tier`) et appliquees une seule fois. L'index EST
 * l'identifiant, et c'est l'octet du fil (`DRAFT_CARD_BYTES`, inchange).
 */
export const RARITY = {
  COMMUNE: 0,
  RARE: 1,
  EPIQUE: 2,
  LEGENDAIRE: 3,
} as const;

/**
 * Combien de fois une carte s'applique, par rarete.
 *
 * ⚠️ **1 pour les deux paliers hauts, et ce n'est pas un oubli** : le triple
 * d'une regle serait du decor. C'etait un cas particulier (`isLegendaryOnly`)
 * jusqu'a l'etape 13 ; la table le dit maintenant elle-meme.
 */
export const RARITY_MULTIPLIERS: readonly number[] = [1, 2, 1, 1];

/**
 * Le poids de chaque rarete au tirage, en pourcents (72 / 20 / 6 / 2).
 *
 * ⚠️ **Un reglage de playtest, pas un invariant.**
 */
export const RARITY_WEIGHTS: readonly number[] = [72, 20, 6, 2];
```

- [ ] **Étape 4 : lancer les tests pour les voir passer**

Run : `cd back && npx vitest run ../shared/rarity.test.ts`
Attendu : SUCCÈS. Les tests de `rarity.test.ts` hérités de l'étape 11 (suite relevée à graine
fixe) **vont rougir** : les poids ont changé, donc la suite tirée aussi. Relever la nouvelle suite
et remplacer le tableau attendu, en notant dans le test que l'étape 13 l'a refait.

- [ ] **Étape 5 : committer**

```bash
git add shared/rarity.ts shared/rarity.test.ts
git commit -m "feat(shared): la rarete compte quatre paliers, epique entre rare et legendaire"
```

---

### Tâche 2 : l'exclusivité par palier, et la descente

**Fichiers :**
- Modifier : `shared/passives.ts` (champ `tier` dans `Passive`), `shared/cards.ts`
  (`isLegendaryOnly` → `tierOf`, `applicationsOf`, le filtre et la boucle de `drawSpread`)
- Tester : `shared/cards.test.ts`

**Interfaces :**
- Consomme : `RARITY`, `RARITY_MULTIPLIERS` (tâche 1).
- Produit : `type PassiveTier = 'epique' | 'legendaire'` ;
  `Passive.tier?: PassiveTier` ; `tierOf(card: Card): PassiveTier | undefined` ;
  `rarityForTier(tier: PassiveTier | undefined): number | undefined`.
  `isLegendaryOnly` est **supprimé**.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/cards.test.ts`, en fin de fichier :

```ts
describe('etape 13 : un palier, un pool', () => {
  /** Fixture : trois passifs de palier existent au catalogue (voir tache 7). */
  const epiques = PASSIVES.filter((p) => p.tier === 'epique');
  const legendaires = PASSIVES.filter((p) => p.tier === 'legendaire');

  it('le catalogue a de quoi remplir les deux paliers hauts', () => {
    expect(epiques.length).toBeGreaterThan(0);
    expect(legendaires.length).toBeGreaterThan(0);
  });

  it('une carte de palier ne sort que sur son palier, sur 500 graines', () => {
    for (let seed = 1; seed <= 500; seed++) {
      for (const c of drawSpread(equipe(new Loadout(), new Loadout()), makeRandom(seed))) {
        const tier = tierOf(c);
        if (c.rarity === RARITY.EPIQUE) {
          expect(tier).toBe('epique');
        } else if (c.rarity === RARITY.LEGENDAIRE) {
          expect(tier).toBe('legendaire');
        } else {
          expect(tier).toBeUndefined();
        }
      }
    }
  });

  it('une carte de palier s applique une seule fois, jamais deux', () => {
    const l = new Loadout();
    const epique = PASSIVES.find((p) => p.tier === 'epique');
    if (!epique) {
      throw new Error('fixture : aucun epique au catalogue');
    }
    applyCardToLoadout(l, { nature: CARD.PASSIVE, refId: epique.id, rarity: RARITY.EPIQUE });
    expect(l.stacksOf(epique.id)).toBe(1);
  });

  /**
   * ⚠️ **Le risque principal de l'etape.** Le `break` de `drawSpread` etait
   * documente « INATTEIGNABLE » ; avec un filtre strict par palier il devient
   * courant, et l'etalage sortirait avec MOINS de cartes que de joueurs.
   */
  /**
   * ⚠️ **La cause est l'EPUISEMENT DU POOL, pas des emplacements pleins** (la
   * tache 0 a leve la limite de passifs). `drawSpread` tire sans remise et il
   * n'y a que trois epiques : au quatrieme emplacement epique, plus rien n'est
   * permis. On force le cas avec un rng qui tire TOUJOURS epique.
   */
  it('pool de palier epuise : l etalage sort quand meme au complet', () => {
    // ⚠️ **Un `rng` CONSTANT a 0,8, pas un mock.** Avec les poids
    // {72, 20, 6, 2}, `rollRarity` lit `0,8 x 100 = 80`, qui tombe dans la
    // bande epique (72 <= 80 < 92) : chaque emplacement tire epique, a chaque
    // fois, et le pool des trois epiques s'epuise des le quatrieme.
    const toujoursEpique = (): number => 0.8;
    const loadouts = equipe(new Loadout(), new Loadout(), new Loadout(), new Loadout());
    const spread = drawSpread(loadouts, toujoursEpique);
    expect(spread).toHaveLength(loadouts.size + SPREAD_BONUS);
    const epiquesAuCatalogue = PASSIVES.filter((p) => p.tier === 'epique').length;
    expect(spread.filter((c) => c.rarity === RARITY.EPIQUE)).toHaveLength(epiquesAuCatalogue);
    // Les emplacements au-dela du pool ont REDESCENDU, ils n'ont pas disparu.
    expect(spread.filter((c) => c.rarity !== RARITY.EPIQUE).length).toBe(
      loadouts.size + SPREAD_BONUS - epiquesAuCatalogue,
    );
  });

  it('la descente s arrete au plancher : jamais de commune sous plancher rare', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const loadouts = equipe(new Loadout(), new Loadout(), new Loadout(), new Loadout());
      for (const c of drawSpread(loadouts, makeRandom(seed), RARITY.RARE)) {
        expect(c.rarity ?? RARITY.COMMUNE).toBeGreaterThanOrEqual(RARITY.RARE);
      }
    }
  });
});
```

- [ ] **Étape 2 : lancer les tests pour les voir échouer**

Run : `cd back && npx vitest run ../shared/cards.test.ts`
Attendu : ÉCHEC — `tierOf` n'existe pas.

- [ ] **Étape 3 : le champ sur le passif**

Dans `shared/passives.ts`, remplacer `legendary?: boolean` :

```ts
/** Les deux paliers reserves a des cartes de REGLE (etape 13, §2.2). */
export type PassiveTier = 'epique' | 'legendaire';
```

et dans `interface Passive` :

```ts
  /**
   * Le palier qui lui est RESERVE. Absent : carte ordinaire, qui ne sort que
   * sur un emplacement commun ou rare.
   *
   * ⚠️ **Remplace `legendary?: boolean` (etape 10).** Un booleen ne pouvait pas
   * dire « epique », et surtout il laissait la REGLE du x1 dans `cards.ts` au
   * lieu de la mettre dans la table des raretes.
   */
  tier?: PassiveTier;
```

- [ ] **Étape 4 : le tirage**

Dans `shared/cards.ts`, supprimer `isLegendaryOnly` et le remplacer :

```ts
/** Le palier reserve de cette carte, `undefined` pour une carte ordinaire. */
export function tierOf(card: Card): PassiveTier | undefined {
  return card.nature === CARD.PASSIVE ? passiveOf(card.refId).tier : undefined;
}

/** La rarete qu'un palier reserve exige, `undefined` pour une carte ordinaire. */
export function rarityForTier(tier: PassiveTier | undefined): number | undefined {
  if (tier === 'epique') {
    return RARITY.EPIQUE;
  }
  return tier === 'legendaire' ? RARITY.LEGENDAIRE : undefined;
}
```

`applicationsOf` perd son cas particulier :

```ts
/**
 * Combien de fois cette carte s'applique : le multiplicateur de sa rarete, et
 * rien d'autre.
 *
 * ⚠️ **Le cas particulier `isLegendaryOnly` a disparu a l'etape 13** : il
 * forcait un legendaire a x1 contre une table qui disait x3. La table dit
 * maintenant x1 elle-meme (`RARITY_MULTIPLIERS`), donc la fonction n'a plus
 * rien a corriger.
 */
export function applicationsOf(card: Card): number {
  return multiplierOf(card.rarity);
}
```

Dans `drawSpread`, le filtre devient une égalité, et le palier **redescend** plutôt que de rompre :

```ts
  while (spread.length < wanted && pool.length > 0) {
    // ⚠️ **La descente de palier (etape 13, §2.3).** Un palier dont aucune
    // carte n'est prenable — trois emplacements de passifs pleins, aucun epique
    // deja possede — redescend d'un cran, jusqu'au `floor` de l'emplacement et
    // JAMAIS en dessous. Sans elle, la boucle sortait et l'etalage avait moins
    // de cartes que de joueurs : le `break` plus bas, documente
    // « INATTEIGNABLE » a l'etape 10, cesse de l'etre des qu'un palier a son
    // propre pool.
    let rarity = rollRarity(rng, floor);
    let permis = permisAt(rarity);
    while (permis.total === 0 && rarity > floor) {
      rarity--;
      permis = permisAt(rarity);
    }
    if (permis.total === 0) {
      break;
    }
    let roll = rng() * permis.total;
    // … (inchange : `index` suit la derniere carte permise vue)
```

avec, juste au-dessus de la boucle :

```ts
  /** Les poids des cartes que CE palier permet, et leur somme. */
  const permisAt = (rarity: number): { poids: number[]; total: number } => {
    const attendu = rarity === RARITY.EPIQUE || rarity === RARITY.LEGENDAIRE ? rarity : undefined;
    const poids = pool.map((card, i) =>
      rarityForTier(tierOf(card)) === attendu ? (weights[i] ?? 0) : 0,
    );
    return { poids, total: poids.reduce<number>((a, b) => a + b, 0) };
  };
```

⚠️ **`rng` est consommé exactement une fois par emplacement pour la rareté**, descente comprise :
la descente ne retire pas, elle décrémente. C'est ce qui garde le tirage reproductible à graine
fixe.

- [ ] **Étape 5 : lancer les tests pour les voir passer**

Run : `cd back && npx vitest run ../shared/cards.test.ts`
Attendu : SUCCÈS. Les tests de l'étape 10 qui citent `isLegendaryOnly` doivent être réécrits avec
`tierOf` — les supprimer serait perdre leur garde.

- [ ] **Étape 6 : committer**

```bash
git add shared/cards.ts shared/cards.test.ts shared/passives.ts
git commit -m "feat(shared): un palier, un pool, et un palier vide redescend"
```

---

### Tâche 3 : `hurtPlayer`, le point de passage unique

**Refactor à comportement identique.** Aucun test existant ne doit changer de valeur attendue.

**Fichiers :**
- Modifier : `back/src/combat.ts` (`:622` kamikaze, `:1737` contact, `:1856` charge),
  `back/src/room.ts` (`:1711` tir d'ennemi)
- Tester : `back/src/combat.test.ts`

**Interfaces :**
- Produit : `hurtPlayer(p: HurtablePlayer, degats: number): void` ;
  `interface HurtablePlayer { hp: number; readonly armor?: number }`.
- ⚠️ **La tâche 5 ÉLARGIT cette interface** (`shield`, `shieldCalmTicks`, tous deux requis) et
  met donc à jour les fixtures écrites ici — `{ hp: 100, armor: 0.5 }` y devient
  `{ hp: 100, armor: 0.5, shield: 0, shieldCalmTicks: 0 }`. C'est prévu, pas une reprise.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `back/src/combat.test.ts` :

```ts
describe('etape 13 : hurtPlayer, le point de passage unique', () => {
  it('applique l armure avant les PV', () => {
    const p = { hp: 100, armor: 0.5 };
    hurtPlayer(p, 40);
    expect(p.hp).toBe(80);
  });

  it('ne descend jamais sous zero', () => {
    const p = { hp: 5 };
    hurtPlayer(p, 999);
    expect(p.hp).toBe(0);
  });

  /**
   * ⚠️ Vigilance 2 : une armure > 1 rendrait le facteur negatif et SOIGNERAIT.
   * Le facteur est borne a zero, ici et nulle part ailleurs.
   */
  it('une armure superieure a 1 ne soigne pas', () => {
    const p = { hp: 50, armor: 1.5 };
    hurtPlayer(p, 40);
    expect(p.hp).toBe(50);
  });

  /** Une armure NEGATIVE (malus Hate funeste) fait mal davantage — c'est voulu. */
  it('une armure negative augmente les degats', () => {
    const p = { hp: 100, armor: -0.5 };
    hurtPlayer(p, 40);
    expect(p.hp).toBe(40);
  });
});
```

- [ ] **Étape 2 : lancer les tests pour les voir échouer**

Run : `cd back && npx vitest run src/combat.test.ts -t "hurtPlayer"`
Attendu : ÉCHEC — `hurtPlayer` n'est pas défini.

- [ ] **Étape 3 : écrire la fonction**

Dans `back/src/combat.ts` :

```ts
/** Ce qu'il faut d'un joueur pour lui faire mal. `PlayerState` le satisfait. */
export interface HurtablePlayer {
  hp: number;
  /** Fraction des degats absorbee. Absente : 0. Negative (malus) : il encaisse plus. */
  readonly armor?: number;
}

/**
 * Inflige `degats` a un joueur — **le SEUL endroit du depot ou les PV d'un
 * joueur baissent**.
 *
 * ⚠️ **Il y en avait QUATRE copies** jusqu'a l'etape 13 : le tir d'ennemi
 * (`room.ts`), le kamikaze, le contact et la charge du boss. Fusionner n'est
 * pas du rangement : c'est la condition pour que le bouclier (tache 5) ne soit
 * pas traversable par trois sources sur quatre — un bug qu'on ne decouvrirait
 * qu'au boss.
 *
 * ⚠️ **Le facteur est borne a zero.** `armor` depasse 1 chez un compte tres
 * ameliore ; sans cette borne, un coup SOIGNERAIT. La borne vit ici, donc une
 * fois.
 */
export function hurtPlayer(p: HurtablePlayer, degats: number): void {
  const facteur = Math.max(0, 1 - (p.armor ?? 0));
  p.hp = Math.max(0, p.hp - degats * facteur);
}
```

- [ ] **Étape 4 : router les quatre sites**

Remplacer, à l'identique de sens :

```ts
// back/src/combat.ts:622 (kamikaze)
hurtPlayer(p, KAMIKAZE_PLAYER_DAMAGE);

// back/src/combat.ts:1737 (contact)
hurtPlayer(player, CONTACT_DAMAGE);
player.contactInvulnTicks = CONTACT_INTERVAL_TICKS;

// back/src/combat.ts:1856 (charge du boss)
hurtPlayer(player, BOSS_CHARGE_DAMAGE);

// back/src/room.ts:1711 (tir d'ennemi)
hurtPlayer(p, SHOT_DAMAGE);
```

- [ ] **Étape 5 : lancer les tests de combat et de salon**

Run : `cd back && npx vitest run src/combat.test.ts src/room.test.ts`
Attendu : SUCCÈS, **sans qu'aucune valeur attendue ait changé**. Si un test rougit, le refactor a
changé un comportement : le corriger, pas le test.

- [ ] **Étape 6 : committer**

```bash
git add back/src/combat.ts back/src/combat.test.ts back/src/room.ts
git commit -m "refactor(back): un seul point d encaissement, hurtPlayer"
```

---

### Tâche 4 : le malus, et les PV max partagés

**Fichiers :**
- Modifier : `shared/passives.ts` (`malus`, `PASSIVE_KINDS` + `armor`), `shared/loadout.ts`
  (`bonus`, `maxHpOf`), `back/src/room.ts` (`:1142`, `:2586`), `front/src/net/client.ts` (`:1803`)
- Tester : `shared/loadout.test.ts`, `back/src/room.test.ts`

**Interfaces :**
- Consomme : `PassiveTier` (tâche 2).
- Produit : `Passive.malus?: { kind: PassiveKind; magnitude: number }` ;
  `PASSIVE_KINDS` contient `'armor'` ;
  `maxHpOf(loadout: Loadout, accountMaxHp: number): number` dans `shared/loadout.ts`.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/loadout.test.ts` :

```ts
describe('etape 13 : un malus est un bonus negatif', () => {
  const avecMalus = PASSIVES.find((p) => p.malus !== undefined);

  it('le catalogue a au moins une carte a malus', () => {
    expect(avecMalus).toBeDefined();
  });

  it('bonus() rend le NET, et le malus s empile comme le bonus', () => {
    if (!avecMalus?.malus) {
      throw new Error('fixture');
    }
    const l = new Loadout();
    l.addPassive(avecMalus.id);
    expect(l.bonus(avecMalus.malus.kind)).toBeCloseTo(-avecMalus.malus.magnitude, 6);
    l.addPassive(avecMalus.id);
    expect(l.bonus(avecMalus.malus.kind)).toBeCloseTo(-2 * avecMalus.malus.magnitude, 6);
  });

  it('maxHpOf est la meme somme des deux cotes', () => {
    const l = new Loadout();
    expect(maxHpOf(l, 0)).toBe(PLAYER_MAX_HP);
    expect(maxHpOf(l, 25)).toBe(PLAYER_MAX_HP + 25);
  });
});
```

Dans `back/src/room.test.ts` :

```ts
describe('etape 13 : un maximum qui baisse ne tue pas', () => {
  /**
   * ⚠️ Vigilance 1. `hp += nouveauMax - maxHp` donnait `hp = -10` a un joueur
   * a 30 PV qui prend Fournaise (-40 max) : il MOURAIT en acceptant sa carte.
   */
  it('un joueur blesse qui prend une carte a malus de PV max reste vivant', () => {
    const room = salonSolo();
    room.debugSetHp(1, 30);
    room.debugGrant(1, { nature: CARD.PASSIVE, refId: idDe('fournaise'), rarity: RARITY.LEGENDAIRE });
    expect(room.hpOf(1)).toBeGreaterThan(0);
    expect(room.hpOf(1)).toBeLessThanOrEqual(room.maxHpOf(1));
  });

  it('un joueur a plein garde le plein apres une carte a malus', () => {
    const room = salonSolo();
    room.debugGrant(1, { nature: CARD.PASSIVE, refId: idDe('fournaise'), rarity: RARITY.LEGENDAIRE });
    expect(room.hpOf(1)).toBe(room.maxHpOf(1));
  });
});
```

- [ ] **Étape 2 : lancer les tests pour les voir échouer**

Run : `cd back && npx vitest run ../shared/loadout.test.ts` puis
`cd back && npx vitest run src/room.test.ts -t "maximum qui baisse"`
Attendu : ÉCHEC — `maxHpOf` absent, et le joueur blessé meurt.

- [ ] **Étape 3 : le champ, le genre, la somme**

Dans `shared/passives.ts`, ajouter `'armor'` à `PASSIVE_KINDS` :

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
  'colossus',
  // Etape 13 : le genre existait deja cote boutique (`BonusKind`) et cote
  // combat (`p.armor`) ; il n'etait simplement pas atteignable par une carte.
  // Une carte ne s'en sert aujourd'hui que pour un MALUS (Hate funeste).
  'armor',
] as const;
```

et le champ dans `Passive` :

```ts
  /**
   * Ce que la carte COUTE, dans les memes genres que ce qu'elle donne
   * (etape 13, §3.1). `Loadout.bonus` le retranche.
   *
   * ⚠️ **Une magnitude POSITIVE qui se retranche**, pas une magnitude negative
   * qui s'ajoute : la carte dit « je coute 40 PV max », et l'ecran l'affiche
   * tel quel. Un signe porte par la donnee se perdrait au premier affichage.
   */
  malus?: { kind: PassiveKind; magnitude: number };
```

Dans `shared/loadout.ts`, `bonus` retranche, et la somme des PV max descend ici :

```ts
  /** Somme des `magnitude` possedees de ce genre, MOINS les malus du meme genre. */
  bonus(kind: PassiveKind): number {
    let total = 0;
    for (let id = 0; id < this.#passiveStacks.length; id++) {
      const stacks = this.#passiveStacks[id] ?? 0;
      if (stacks === 0) {
        continue;
      }
      const p = PASSIVES[id];
      if (!p) {
        continue;
      }
      if (p.kind === kind) {
        total += p.magnitude * stacks;
      }
      if (p.malus?.kind === kind) {
        total -= p.malus.magnitude * stacks;
      }
    }
    return total;
  }
```

```ts
/**
 * Les PV max d'un joueur : la base, les cartes, les achats — **et la seule
 * ecriture de cette somme dans le depot**.
 *
 * ⚠️ **Elle etait recopiee aux deux bouts** : `Room#grantCard`
 * (`back/src/room.ts`) et `GameClient#localMaxHp` (`front/src/net/client.ts`).
 * Deux copies divergeraient a la premiere regle qui touche au plafond — et
 * l'etape 13 en ajoute justement une (Transcendance, tache 6).
 */
export function maxHpOf(loadout: Loadout, accountMaxHp: number): number {
  return PLAYER_MAX_HP + loadout.bonus('maxHp') + accountMaxHp;
}
```

- [ ] **Étape 4 : les deux appelants, et la borne qui sauve le blessé**

Dans `back/src/room.ts:2583-2588` :

```ts
      const nouveauMax = maxHpOf(player.loadout, player.accountBonuses.maxHp);
      // ⚠️ **Borne, depuis l'etape 13.** Le delta brut (`hp += nouveauMax -
      // maxHp`) TUAIT un joueur blesse des qu'un maximum BAISSE : a 30 PV,
      // Fournaise (-40 max) donnait -10. Un vivant reste vivant.
      const vivant = player.hp > 0;
      player.hp = player.hp + (nouveauMax - player.maxHp);
      player.hp = Math.min(nouveauMax, player.hp);
      if (vivant) {
        player.hp = Math.max(1, player.hp);
      }
      player.maxHp = nouveauMax;
```

et `room.ts:1142-1143` ainsi que `front/src/net/client.ts:1803` appellent `maxHpOf`.

- [ ] **Étape 5 : lancer les tests pour les voir passer**

Run : `cd back && npx vitest run ../shared/loadout.test.ts` puis
`cd back && npx vitest run src/room.test.ts` puis `cd front && npx vitest run src/net/client.test.ts`
Attendu : SUCCÈS aux trois.

- [ ] **Étape 6 : committer**

```bash
git add shared/passives.ts shared/loadout.ts shared/loadout.test.ts back/src/room.ts back/src/room.test.ts front/src/net/client.ts
git commit -m "feat(shared): un malus se retranche, et les PV max ont une seule somme"
```

---

### Tâche 5 : le bouclier

**Fichiers :**
- Modifier : `shared/constants.ts`, `shared/protocol.ts` (`SNAPSHOT_PLAYER_BYTES`,
  `encodeSnapshot`, le décodage côté client), `back/src/combat.ts` (`hurtPlayer`),
  `back/src/room.ts` (`PlayerState`, la régénération dans `step`)
- Tester : `shared/protocol.test.ts`, `back/src/combat.test.ts`, `back/src/room.test.ts`

**Interfaces :**
- Consomme : `hurtPlayer` (tâche 3).
- Produit : `SHIELD_POOL = 60`, `SHIELD_CALM_TICKS = 90`, `SHIELD_REGEN_PER_SEC = 20` ;
  `HurtablePlayer` gagne `shield: number` et `shieldCalmTicks: number` ;
  `PlayerState` gagne en plus `maxShield: number` ; `SNAPSHOT_PLAYER_BYTES = 11`.
- ⚠️ **`maxShield` vaut `0` partout tant que la tâche 6 n'est pas faite**, et c'est volontaire :
  cette tâche livre un bouclier complet et inerte, que `maxShieldOf` (tâche 6) viendra ouvrir.
  Un relecteur peut donc l'accepter sans Transcendance. Les tests d'ici posent `maxShield`
  à la main.
- ⚠️ **Mettre à jour les fixtures de la tâche 3** (`shield: 0, shieldCalmTicks: 0`) dans le même
  commit, sinon `tsc` rougit.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `back/src/combat.test.ts` :

```ts
describe('etape 13 : le bouclier absorbe avant les PV', () => {
  const joueur = (shield: number, hp = 100) => ({ hp, shield, shieldCalmTicks: 0 });

  it('un coup plus petit que la reserve ne touche pas les PV', () => {
    const p = joueur(40);
    hurtPlayer(p, 10);
    expect(p.shield).toBe(30);
    expect(p.hp).toBe(100);
  });

  /** ⚠️ Vigilance 4 : la reserve tombe a 0, pas a -10, et le reste mord. */
  it('le debordement mord les PV, et la reserve ne passe pas sous zero', () => {
    const p = joueur(40);
    hurtPlayer(p, 50);
    expect(p.shield).toBe(0);
    expect(p.hp).toBe(90);
  });

  it('l armure s applique AVANT le bouclier', () => {
    const p = { hp: 100, shield: 40, shieldCalmTicks: 0, armor: 0.5 };
    hurtPlayer(p, 40);
    expect(p.shield).toBe(20);
    expect(p.hp).toBe(100);
  });

  it('tout degat remet le calme a zero', () => {
    const p = joueur(40);
    p.shieldCalmTicks = 999;
    hurtPlayer(p, 1);
    expect(p.shieldCalmTicks).toBe(0);
  });
});
```

Dans `back/src/room.test.ts` :

```ts
describe('etape 13 : la regeneration du bouclier', () => {
  it('ne regenere pas avant le calme, puis remonte sans depasser la reserve', () => {
    const room = salonSoloAvecBouclier();
    room.debugHurt(1, 30);
    const apresCoup = room.shieldOf(1);
    room.debugSteps(SHIELD_CALM_TICKS - 1);
    expect(room.shieldOf(1)).toBe(apresCoup);
    room.debugSteps(SHIELD_CALM_TICKS + TICK_HZ * 10);
    expect(room.shieldOf(1)).toBe(SHIELD_POOL);
  });

  /**
   * ⚠️ Le gel ne demande AUCUN cas particulier : `step` retourne avant tout
   * degat pendant le gel et pendant un etalage ouvert, donc la regeneration,
   * qui vit apres ce retour, ne tourne pas non plus. Ce test garde la
   * propriete, pas une ligne de code.
   */
  it('ne regenere pas pendant le gel de niveau', () => {
    const room = salonSoloAvecBouclier();
    room.debugHurt(1, 30);
    const apresCoup = room.shieldOf(1);
    room.debugFreeze(SHIELD_CALM_TICKS + TICK_HZ * 10);
    expect(room.shieldOf(1)).toBe(apresCoup);
  });
});
```

Dans `shared/protocol.test.ts` :

```ts
describe('etape 13 : le bouclier sur le fil', () => {
  it('un octet de plus par joueur, pas deux', () => {
    expect(SNAPSHOT_PLAYER_BYTES).toBe(11);
  });

  it('aller-retour, et borne a 255', () => {
    const buf = encodeSnapshot(7, 0, 0, [unJoueur({ id: 1, shield: 42 })], null, 0n);
    expect(decodeSnapshot(buf).players[0]?.shield).toBe(42);
    const haut = encodeSnapshot(7, 0, 0, [unJoueur({ id: 1, shield: 9999 })], null, 0n);
    expect(decodeSnapshot(haut).players[0]?.shield).toBe(255);
  });
});
```

- [ ] **Étape 2 : lancer les tests pour les voir échouer**

Run : `cd back && npx vitest run src/combat.test.ts -t "bouclier"` et
`cd back && npx vitest run ../shared/protocol.test.ts -t "bouclier"`
Attendu : ÉCHEC — `shield` inconnu, `SNAPSHOT_PLAYER_BYTES` vaut 10.

- [ ] **Étape 3 : les constantes**

Dans `shared/constants.ts` :

```ts
/**
 * La reserve de bouclier de Transcendance (etape 13), en points.
 *
 * ⚠️ **FIXE, elle n'echelle pas sur les PV max** — c'est ce qui rend le
 * `shield u8` du snapshot honnete, et ce qui empeche Vitalite de la gonfler
 * chez un porteur dont le plafond vaut 1.
 *
 * ⚠️ **Molette de playtest.** Repere : le contact coute `CONTACT_DAMAGE` (8)
 * toutes les `CONTACT_INTERVAL_TICKS` (15), soit 16 PV/s — la reserve tient
 * moins de quatre secondes dans la horde.
 */
export const SHIELD_POOL = 60;
/** Ticks sans degat avant que le bouclier reprenne. Molette de playtest. */
export const SHIELD_CALM_TICKS = 90;
/** Points rendus par seconde une fois le calme atteint. Molette de playtest. */
export const SHIELD_REGEN_PER_SEC = 20;
```

- [ ] **Étape 4 : `hurtPlayer` absorbe**

```ts
export interface HurtablePlayer {
  hp: number;
  /** Reserve de bouclier restante. `0` chez qui ne porte pas Transcendance. */
  shield: number;
  /** Ticks ecoules sans degat — remis a zero par tout coup recu. */
  shieldCalmTicks: number;
  readonly armor?: number;
}

export function hurtPlayer(p: HurtablePlayer, degats: number): void {
  const recu = degats * Math.max(0, 1 - (p.armor ?? 0));
  if (recu <= 0) {
    return;
  }
  // ⚠️ **Tout degat RECU remet le calme a zero**, meme entierement absorbe :
  // sinon un joueur grignote sa reserve indefiniment sans jamais retarder sa
  // recharge, et le bouclier devient une reduction de degats permanente.
  p.shieldCalmTicks = 0;
  const absorbe = Math.min(p.shield, recu);
  p.shield -= absorbe;
  p.hp = Math.max(0, p.hp - (recu - absorbe));
}
```

- [ ] **Étape 5 : l'état et la régénération**

`PlayerState` gagne `shield: number` et `shieldCalmTicks: number`, initialisés à `0`. Dans
`Room#step`, **après** le retour du gel et du draft :

```ts
    // ⚠️ **Apres le retour du gel, et c'est tout ce qu'il faut.** `step`
    // retourne plus haut pendant le gel et pendant un etalage ouvert : la
    // regeneration ne tourne donc pas pendant une montee de niveau, sans une
    // ligne pour le dire.
    for (const p of this.#players.values()) {
      if (p.hp <= 0 || p.maxShield === 0) {
        continue;
      }
      p.shieldCalmTicks++;
      if (p.shieldCalmTicks >= SHIELD_CALM_TICKS && p.shield < p.maxShield) {
        p.shield = Math.min(p.maxShield, p.shield + SHIELD_REGEN_PER_SEC / TICK_HZ);
      }
    }
```

`maxShield` vaut `SHIELD_POOL` chez un porteur de Transcendance et `0` sinon ; il se recalcule au
même endroit que `maxHp` (tâche 4, étape 4), donc à l'acceptation d'une carte.

- [ ] **Étape 6 : le fil**

```ts
/**
 * `id u8 · x i16 · y i16 · hp u16 · aimX i8 · aimY i8 · pickupRadius u8 ·
 * shield u8` — tache 7 de l'etape 7b : 9 -> 10 ; etape 13 : 10 -> 11.
 *
 * ⚠️ **L'octet est ASSUME, et deux variantes moins cheres ont ete ecartees
 * par ecrit** (§3.4 de la spec) : un `u16` doublerait le cout pour une reserve
 * plafonnee, et reutiliser `hp` (chez un porteur, `maxHp` vaut 1, donc
 * `hp + bouclier` est decodable) marcherait mais serait l'astuce qu'on
 * dechiffre a 3 h du matin en se demandant pourquoi la barre d'un allie ment.
 *
 * ⚠️ **Pas « seulement pour le porteur »** : `encodeSnapshot` construit UN
 * tampon pousse une fois pour tout le salon, donc un champ local demanderait
 * un encodage par client — du CPU par tick contre un octet par joueur.
 */
export const SNAPSHOT_PLAYER_BYTES = 11;
```

et dans `encodeSnapshot`, à l'offset 10 : `v.setUint8(o + 10, Math.min(255, Math.max(0, Math.round(p.shield))))`.

- [ ] **Étape 7 : lancer les tests pour les voir passer**

Run : `cd back && npx vitest run src/combat.test.ts src/room.test.ts` puis
`cd back && npx vitest run ../shared/protocol.test.ts`
Attendu : SUCCÈS.

- [ ] **Étape 8 : committer**

```bash
git add shared/constants.ts shared/protocol.ts shared/protocol.test.ts back/src/combat.ts back/src/combat.test.ts back/src/room.ts back/src/room.test.ts
git commit -m "feat: un bouclier qui absorbe avant les PV et se regenere au calme"
```

---

### Tâche 6 : Transcendance

**Fichiers :**
- Modifier : `shared/passives.ts` (`rule`), `shared/loadout.ts` (`maxHpOf`, `maxShieldOf`)
- Tester : `shared/loadout.test.ts`, `back/src/room.test.ts`

**Interfaces :**
- Consomme : `maxHpOf` (tâche 4), `SHIELD_POOL` (tâche 5).
- Produit : `Passive.rule?: 'transcendance'` ; `maxShieldOf(loadout: Loadout): number`.

- [ ] **Étape 1 : écrire les tests qui échouent**

```ts
describe('etape 13 : Transcendance', () => {
  const id = (): number => {
    const p = PASSIVES.find((x) => x.rule === 'transcendance');
    if (!p) {
      throw new Error('fixture : Transcendance absente du catalogue');
    }
    return p.id;
  };

  it('ramene les PV max a 1, et resiste a Vitalite', () => {
    const l = new Loadout();
    l.addPassive(id());
    expect(maxHpOf(l, 0)).toBe(TRANSCENDANCE_MAX_HP);
    for (let i = 0; i < 5; i++) {
      l.addPassive(PASSIVES.findIndex((p) => p.name === 'vitalite'));
    }
    expect(maxHpOf(l, 0)).toBe(TRANSCENDANCE_MAX_HP);
  });

  it('resiste aussi aux achats du compte', () => {
    const l = new Loadout();
    l.addPassive(id());
    expect(maxHpOf(l, 60)).toBe(TRANSCENDANCE_MAX_HP);
  });

  it('ouvre la reserve de bouclier, et elle seule', () => {
    const l = new Loadout();
    expect(maxShieldOf(l)).toBe(0);
    l.addPassive(id());
    expect(maxShieldOf(l)).toBe(SHIELD_POOL);
  });

  it('Regain ne peut plus soigner au-dela de 1', () => {
    const room = salonSolo();
    room.debugGrant(1, { nature: CARD.PASSIVE, refId: id(), rarity: RARITY.LEGENDAIRE });
    room.debugGrant(1, { nature: CARD.PASSIVE, refId: idDe('regain'), rarity: RARITY.COMMUNE });
    room.debugSteps(TICK_HZ * 10);
    expect(room.hpOf(1)).toBe(TRANSCENDANCE_MAX_HP);
  });
});
```

- [ ] **Étape 2 : lancer les tests pour les voir échouer**

Run : `cd back && npx vitest run ../shared/loadout.test.ts -t "Transcendance"`
Attendu : ÉCHEC — `maxShieldOf` absent.

- [ ] **Étape 3 : la règle, et son unique branche par côté**

```ts
/**
 * Une REGLE portee par une carte — ce qu'un malus chiffre ne peut pas dire.
 *
 * ⚠️ **« PV max -> 1 » n'est PAS `malus: { maxHp, 99 }`** : il doit resister a
 * Vitalite et aux achats du compte, qui s'ajoutent apres. Meme idiome que
 * `Weapon.kind` : un discriminant nomme dont la branche vit a un seul endroit.
 */
export type PassiveRule = 'transcendance';
```

Dans `shared/loadout.ts` :

```ts
export function maxHpOf(loadout: Loadout, accountMaxHp: number): number {
  // ⚠️ **La regle passe EN DERNIER**, apres les cartes et les achats : c'est
  // exactement ce qui la rend insensible a Vitalite.
  if (loadout.hasRule('transcendance')) {
    return TRANSCENDANCE_MAX_HP;
  }
  return PLAYER_MAX_HP + loadout.bonus('maxHp') + accountMaxHp;
}

/** La reserve de bouclier ouverte par les regles possedees. `0` sans Transcendance. */
export function maxShieldOf(loadout: Loadout): number {
  return loadout.hasRule('transcendance') ? SHIELD_POOL : 0;
}
```

avec, dans `Loadout` :

```ts
  /** Ce joueur porte-t-il au moins un exemplaire d'une carte a cette regle ? */
  hasRule(rule: PassiveRule): boolean {
    for (let id = 0; id < this.#passiveStacks.length; id++) {
      if ((this.#passiveStacks[id] ?? 0) > 0 && PASSIVES[id]?.rule === rule) {
        return true;
      }
    }
    return false;
  }
```

⚠️ **Le client n'a rien à brancher** : `GameClient#localMaxHp` appelle déjà `maxHpOf` depuis la
tâche 4.

- [ ] **Étape 4 : lancer les tests pour les voir passer**

Run : `cd back && npx vitest run ../shared/loadout.test.ts` puis
`cd back && npx vitest run src/room.test.ts -t "Transcendance"`
Attendu : SUCCÈS.

- [ ] **Étape 5 : committer**

```bash
git add shared/passives.ts shared/loadout.ts shared/loadout.test.ts back/src/room.test.ts
git commit -m "feat: Transcendance echange les PV max contre un bouclier"
```

---

### Tâche 7 : le contenu

**Fichiers :**
- Modifier : `shared/passives.ts` (la table), `shared/constants.ts` (supprimer `HARVEST_RADIUS`),
  `back/src/combat.ts` (supprimer `resolveHarvest`, ajouter Contagion), `back/src/room.ts`
  (l'appel à `resolveHarvest`)
- Tester : `shared/passives.test.ts`, `back/src/combat.test.ts`

**Interfaces :**
- Consomme : `tier` (tâche 2), `malus` (tâche 4), `rule` (tâche 6).
- Produit : la table finale des passifs ; `spreadMarkOnDeath(horde, morts)` dans `combat.ts`.

- [ ] **Étape 1 : écrire les tests qui échouent**

```ts
describe('etape 13 : le catalogue des paliers', () => {
  it('Moisson a disparu, et le genre harvest avec elle', () => {
    expect(PASSIVES.some((p) => p.name === 'moisson')).toBe(false);
    expect(PASSIVE_KINDS).not.toContain('harvest');
  });

  it('trois epiques, trois legendaires', () => {
    expect(PASSIVES.filter((p) => p.tier === 'epique').map((p) => p.name)).toEqual([
      'echo',
      'colosse',
      'contagion',
    ]);
    expect(PASSIVES.filter((p) => p.tier === 'legendaire').map((p) => p.name)).toEqual([
      'transcendance',
      'fournaise',
      'hate-funeste',
    ]);
  });

  /** La regle de selection de l'etape : un palier haut ne recoupe aucune commune. */
  it('aucune carte de palier ne partage son genre avec une carte ordinaire', () => {
    const ordinaires = new Set(PASSIVES.filter((p) => !p.tier).map((p) => p.kind));
    for (const p of PASSIVES.filter((x) => x.tier)) {
      if (p.rule === undefined && p.kind !== 'echo' && p.kind !== 'colossus') {
        expect(ordinaires.has(p.kind)).toBe(false);
      }
    }
  });

  it('chaque legendaire coute quelque chose', () => {
    for (const p of PASSIVES.filter((x) => x.tier === 'legendaire')) {
      expect(p.malus !== undefined || p.rule !== undefined).toBe(true);
    }
  });

  it('aucun epique ne coute rien', () => {
    for (const p of PASSIVES.filter((x) => x.tier === 'epique')) {
      expect(p.malus).toBeUndefined();
    }
  });
});
```

Et pour Contagion, dans `back/src/combat.test.ts` :

```ts
describe('etape 13 : Contagion', () => {
  it('la marque d un mort saute sur le vivant le plus proche', () => {
    const horde = hordeDe([
      { x: 0, y: 0, mark: ELEMENT.BRAISE },
      { x: 50, y: 0, mark: ELEMENT.NEUTRE },
      { x: 900, y: 0, mark: ELEMENT.NEUTRE },
    ]);
    spreadMarkOnDeath(horde, [0]);
    expect(horde.mark[1]).toBe(ELEMENT.BRAISE);
    expect(horde.mark[2]).toBe(ELEMENT.NEUTRE);
  });

  it('un mort sans marque ne propage rien', () => {
    const horde = hordeDe([
      { x: 0, y: 0, mark: ELEMENT.NEUTRE },
      { x: 50, y: 0, mark: ELEMENT.NEUTRE },
    ]);
    spreadMarkOnDeath(horde, [0]);
    expect(horde.mark[1]).toBe(ELEMENT.NEUTRE);
  });

  it('sans voisin vivant, la marque meurt avec lui — jamais de NaN ni de boucle', () => {
    const horde = hordeDe([{ x: 0, y: 0, mark: ELEMENT.BRAISE }]);
    expect(() => spreadMarkOnDeath(horde, [0])).not.toThrow();
  });
});
```

- [ ] **Étape 2 : lancer les tests pour les voir échouer**

Run : `cd back && npx vitest run ../shared/passives.test.ts` et
`cd back && npx vitest run src/combat.test.ts -t "Contagion"`
Attendu : ÉCHEC.

- [ ] **Étape 3 : la table**

Supprimer l'entrée `moisson`, basculer Écho et Colosse, ajouter les quatre nouvelles :

```ts
  // ---- Etape 13 : trois EPIQUES — une regle, gratuite (§4.1) --------------
  {
    name: 'echo',
    label: 'Écho',
    kind: 'echo',
    magnitude: 1,
    tier: 'epique',
  },
  {
    name: 'colosse',
    label: 'Colosse',
    kind: 'colossus',
    magnitude: 0.01,
    tier: 'epique',
  },
  {
    // ⚠️ La seule carte de l'etape qui coute du code neuf : une branche a la
    // resolution des morts (`spreadMarkOnDeath`). Elle fait vivre l'element
    // plus longtemps que sa cible, donc elle enchaine les reactions.
    name: 'contagion',
    label: 'Contagion',
    kind: 'zone',
    magnitude: 0,
    tier: 'epique',
  },
  // ---- Etape 13 : trois LEGENDAIRES — une regle enorme, payee (§4.2) ------
  {
    name: 'transcendance',
    label: 'Transcendance',
    kind: 'maxHp',
    magnitude: 0,
    tier: 'legendaire',
    rule: 'transcendance',
  },
  {
    // Molettes de playtest : +60 % de degats pour 40 PV max.
    name: 'fournaise',
    label: 'Fournaise',
    kind: 'damage',
    magnitude: 0.6,
    tier: 'legendaire',
    malus: { kind: 'maxHp', magnitude: 40 },
  },
  {
    // Molettes de playtest : la recharge de moitie, les degats subis de moitie
    // en plus. L'armure negative mord les QUATRE sources, parce que
    // `hurtPlayer` est le point de passage unique (tache 3).
    name: 'hate-funeste',
    label: 'Hâte funeste',
    kind: 'fireRate',
    magnitude: 0.5,
    tier: 'legendaire',
    malus: { kind: 'armor', magnitude: 0.5 },
  },
```

⚠️ **`magnitude: 0` sur Contagion et Transcendance n'est pas un trou** : leur effet est la règle,
pas le nombre. L'écran n'affiche une magnitude que si elle est non nulle (tâche 8).

- [ ] **Étape 4 : Contagion, et la suppression de Moisson**

Supprimer `resolveHarvest`, `HarvestPlayer`, `HARVEST_RADIUS` et leur appel dans `Room#step`.
Ajouter :

```ts
/**
 * Contagion (etape 13) : la marque d'un ennemi qui meurt passe au vivant le
 * plus proche. Appelee par `Room#step` avec le lot de morts du tick, et
 * seulement si un joueur porte la carte.
 *
 * ⚠️ **Une seule passe, pas de cascade.** Une marque transmise ne se
 * retransmet pas au meme tick : sinon une vague de morts repeindrait la horde
 * entiere d'un coup, et le cout serait quadratique.
 */
export function spreadMarkOnDeath(horde: Horde, morts: readonly number[]): void {
  for (const slot of morts) {
    const mark = horde.mark[slot] ?? ELEMENT.NEUTRE;
    if (mark === ELEMENT.NEUTRE) {
      continue;
    }
    let meilleur = -1;
    let d2 = CONTAGION_RADIUS * CONTAGION_RADIUS;
    for (let i = 0; i < horde.count; i++) {
      if (i === slot || (horde.hp[i] ?? 0) <= 0) {
        continue;
      }
      const dx = (horde.x[i] ?? 0) - (horde.x[slot] ?? 0);
      const dy = (horde.y[i] ?? 0) - (horde.y[slot] ?? 0);
      const d = dx * dx + dy * dy;
      if (d < d2) {
        d2 = d;
        meilleur = i;
      }
    }
    if (meilleur >= 0) {
      horde.mark[meilleur] = mark;
    }
  }
}
```

avec `CONTAGION_RADIUS = 220` dans `shared/constants.ts` (molette de playtest).

- [ ] **Étape 5 : lancer les tests pour les voir passer**

Run : `cd back && npx vitest run ../shared/passives.test.ts` puis
`cd back && npx vitest run src/combat.test.ts src/room.test.ts`
Attendu : SUCCÈS. Les tests de l'étape 10 qui citent `moisson` ou `harvest` disparaissent avec
elle ; ceux qui comptent les passifs changent de nombre.

- [ ] **Étape 6 : committer**

```bash
git add shared/passives.ts shared/passives.test.ts shared/constants.ts back/src/combat.ts back/src/combat.test.ts back/src/room.ts
git commit -m "feat: trois epiques, trois legendaires, et Moisson s en va"
```

---

### Tâche 8 : l'écran

**Fichiers :**
- Modifier : `front/src/ui/draft.ts` (`RARITY_NAMES`, `magnitudeLabel`, la ligne de malus),
  `front/src/ui/guide.ts`, `front/src/ui/hud.ts`, `front/index.html`,
  `front/src/styles/main.css`
- Tester : `front/src/ui/draft.test.ts`, `front/src/ui/guide.test.ts`, `front/src/ui/hud.test.ts`

**Interfaces :**
- Consomme : `RARITY_NAMES` à quatre entrées ; `Passive.malus` ; `shield` du snapshot.
- Produit : `malusLabel(passive: Passive): string | null`.

- [ ] **Étape 1 : écrire les tests qui échouent**

```ts
describe('etape 13 : l ecran des quatre paliers', () => {
  it('quatre noms de rarete', () => {
    expect(RARITY_NAMES).toEqual(['Commune', 'Rare', 'Épique', 'Légendaire']);
  });

  it('seule une rare affiche un multiplicateur', () => {
    expect(rarityLabel({ nature: CARD.PASSIVE, refId: 0, rarity: RARITY.RARE })).toBe('Rare ×2');
    expect(rarityLabel({ nature: CARD.PASSIVE, refId: 0, rarity: RARITY.EPIQUE })).toBe('Épique');
    expect(rarityLabel({ nature: CARD.PASSIVE, refId: 0, rarity: RARITY.LEGENDAIRE })).toBe('Légendaire');
  });

  it('le cout s affiche, signe compris', () => {
    const fournaise = PASSIVES.find((p) => p.name === 'fournaise');
    if (!fournaise) {
      throw new Error('fixture');
    }
    expect(malusLabel(fournaise)).toBe('−40 PV max');
  });

  it('une carte sans cout n affiche pas de ligne de cout', () => {
    const vitalite = PASSIVES.find((p) => p.name === 'vitalite');
    if (!vitalite) {
      throw new Error('fixture');
    }
    expect(malusLabel(vitalite)).toBeNull();
  });
});
```

Et pour le HUD, la vigilance 5 :

```ts
describe('etape 13 : la barre de bouclier', () => {
  /**
   * ⚠️ Vigilance 5 : elle se peint depuis le SNAPSHOT seul. Un client qui
   * ignore l'inventaire d'un joueur (arrive en cours de partie) doit quand
   * meme afficher la bonne barre.
   */
  it('se peint sans lire le miroir d inventaire', () => {
    const el = hudElementsDeTest();
    paintHud(el, { ...sourceVide(), shield: 30, shieldPool: 60 });
    expect(el.shieldFill.style.getPropertyValue('--v')).toBe('0.5');
  });

  it('reste masquee sans bouclier', () => {
    const el = hudElementsDeTest();
    paintHud(el, { ...sourceVide(), shield: 0, shieldPool: 0 });
    expect(el.shield.classList.contains('hidden')).toBe(true);
  });
});
```

- [ ] **Étape 2 : lancer les tests pour les voir échouer**

Run : `cd front && npx vitest run src/ui/draft.test.ts src/ui/hud.test.ts`
Attendu : ÉCHEC — `malusLabel` absent, `RARITY_NAMES` à trois entrées.

- [ ] **Étape 3 : les libellés**

Dans `front/src/ui/draft.ts` :

```ts
export const RARITY_NAMES = ['Commune', 'Rare', 'Épique', 'Légendaire'] as const;

/**
 * Ce que la carte COUTE, ou `null` si elle ne coute rien.
 *
 * ⚠️ **Le signe est pose ICI, pas dans la table.** La donnee dit « je coute
 * 40 PV max » avec une magnitude positive (voir `Passive.malus`) ; c'est
 * l'ecran qui choisit de l'ecrire « −40 ». Un signe dans la donnee se perdrait
 * au premier affichage qui l'oublierait.
 */
export function malusLabel(passive: Passive): string | null {
  const m = passive.malus;
  if (!m) {
    return null;
  }
  return UNITES[m.kind](m.magnitude).replace(/^\+/, '−');
}
```

avec `armor` ajouté à `UNITES` :

```ts
  // Etape 13. Lu comme un COUT : la table le retranche, l'ecran l'ecrit « − ».
  armor: (m) => `+${pourcent(m)} % dégâts subis`,
```

- [ ] **Étape 4 : la carte, le Guide, la barre**

- `draft.ts` : sous la ligne de magnitude, une `span.draft-card__malus` quand `malusLabel` rend
  une chaîne ; la magnitude ne s'affiche que si elle est non nulle.
- `guide.ts` : la même ligne dans `renderGuidePassives`, et le palier dans la méta
  (`'Épique — change une règle'` / `'Légendaire — change une règle, et se paie'`).
- `index.html` : une `<i id="hud-shield-fill" class="bar__fill bar__fill--shield">` dans la barre
  de PV existante, sous un conteneur `#hud-shield` masquable.
- `main.css` : `.bar__fill--shield` (teinte propre, posée **par-dessus** le remplissage de PV) et
  `.draft-card[data-rarity="3"]` (bordure du légendaire), `[data-rarity="2"]` pour l'épique.
- `.draft-card__malus` : la couleur rouge du dépôt (`.btn--red` / `#c9645c`).

- [ ] **Étape 5 : lancer les tests pour les voir passer**

Run : `cd front && npx vitest run src/ui/`
Attendu : SUCCÈS — `guide.test.ts` compris, dont le test « chaque passif a une entrée » couvre
automatiquement les quatre cartes nouvelles.

- [ ] **Étape 6 : committer**

```bash
git add front/src/ui front/index.html front/src/styles/main.css
git commit -m "feat(front): quatre paliers a l ecran, le cout en rouge, la barre de bouclier"
```

---

### Tâche 9 : le livrable, sur vraies sockets

**Fichiers :**
- Créer : `back/src/pactes.integration.test.ts`

- [ ] **Étape 1 : écrire le test du livrable**

Même ossature que `back/src/rarete.integration.test.ts` (étape 10) : `buildServer`,
`createAccount`, une vraie `WebSocket`, et la rareté **forcée par `vi.mock` du module résolu** —
`@shared/rarity` ici et `./rarity` dans `shared/cards.ts` désignent le même fichier, donc le
`drawSpread` du salon tire le palier voulu. Un seul joueur : en solo la fenêtre se ferme au jeton
posé, sans attendre l'échéance.

```ts
/**
 * Le livrable de l'etape 13 : **sur vraies sockets, un emplacement legendaire
 * ne propose qu'une carte de regle ; Transcendance ramene les PV max a 1 des
 * deux cotes ; et le bouclier encaisse un coup que les PV seuls
 * n'encaisseraient pas.**
 */
vi.mock('@shared/rarity', async (importOriginal) => {
  const reel = await importOriginal<typeof import('@shared/rarity')>();
  return { ...reel, rollRarity: () => reel.RARITY.LEGENDAIRE };
});

describe('etape 13 : le livrable', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let port: number;

  beforeEach(async () => {
    app = await buildServer();
    await app.listen({ port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await app.close();
  });

  it('un emplacement legendaire ne propose QUE des cartes de regle', async () => {
    const { ws, messages } = await rejoindreEtMonterDUnNiveau(port);
    const ouverture = messages.find((m): m is DraftOpenMessage => m.type === MSG.DRAFT_OPEN);
    expect(ouverture).toBeDefined();
    // ⚠️ Le mock doit avoir ATTEINT le serveur : sans cette assertion, un mock
    // qui n'arrive pas ferait passer des communes pour le livrable.
    for (const carte of ouverture?.cards ?? []) {
      expect(carte.rarity).toBe(RARITY.LEGENDAIRE);
      expect(carte.nature).toBe(CARD.PASSIVE);
      expect(passiveOf(carte.refId).tier).toBe('legendaire');
    }
    ws.close();
  });

  it('Transcendance ramene les PV max a 1 des deux cotes, sans octet de plus', async () => {
    const { ws, room, messages } = await prendreLaCarte(port, 'transcendance');
    expect(room.maxHpOf(1)).toBe(TRANSCENDANCE_MAX_HP);
    // Le miroir du client, reconstitue comme `GameClient` le fait.
    const miroir = new Loadout();
    for (const c of cartesGagnees(messages)) {
      applyCardToLoadout(miroir, c);
    }
    expect(maxHpOf(miroir, 0)).toBe(TRANSCENDANCE_MAX_HP);
    const snap = messages.findLast((m): m is SnapshotMessage => m.type === MSG.SNAPSHOT);
    expect(snap?.players[0]?.shield).toBe(SHIELD_POOL);
    ws.close();
  });

  it('le bouclier encaisse un coup mortel pour les PV seuls, puis le suivant tue', async () => {
    const { ws, room } = await prendreLaCarte(port, 'transcendance');
    room.debugHurt(1, SHIELD_POOL - 10);
    expect(room.hpOf(1)).toBe(TRANSCENDANCE_MAX_HP);
    expect(room.shieldOf(1)).toBe(10);
    room.debugHurt(1, 50);
    expect(room.hpOf(1)).toBe(0);
    ws.close();
  });

  it('Fournaise baisse les PV max sans tuer un joueur blesse', async () => {
    const { ws, room } = await prendreLaCarte(port, 'fournaise', (r) => r.debugSetHp(1, 30));
    expect(room.maxHpOf(1)).toBe(PLAYER_MAX_HP - 40);
    expect(room.hpOf(1)).toBeGreaterThan(0);
    ws.close();
  });
});
```

Les trois aides (`rejoindreEtMonterDUnNiveau`, `prendreLaCarte`, `cartesGagnees`) vivent en tête de
ce fichier ; elles reprennent la poignée de main et la pose de jeton de
`rarete.integration.test.ts`, avec `room` récupéré comme ce fichier le fait déjà.

- [ ] **Étape 2 : le faire passer**

Run : `cd back && npx vitest run src/pactes.integration.test.ts`
Attendu : SUCCÈS.

- [ ] **Étape 3 : committer**

```bash
git add back/src/pactes.integration.test.ts
git commit -m "test(back): le livrable de l etape 13 sur vraies sockets"
```

---

### Tâche 10 : le portique et le bilan (contrôleur, seul)

⚠️ **Pour le contrôleur uniquement, et rien d'autre en vol.**

- [ ] **Étape 1 : committer avant toute campagne de mutation** (elle restaure par `git checkout`
      et effacerait le travail non committé).

- [ ] **Étape 2 : le portique complet, seul**

```bash
npm run lint && npm run typecheck && npm test
```

- [ ] **Étape 3 : relever le trafic**

Mesurer le coût réel du `shield u8` (octets/s par joueur) et le comparer au relevé de l'étape 3
(1,09 ko/s par joueur). **Lancer seul** : un chiffre mesuré pendant qu'autre chose tourne est faux.

- [ ] **Étape 4 : écrire `docs/plans/2026-10-16-etape-13-resultats.md`**

Y consigner, en plus du bilan ordinaire :
- le trafic relevé à l'étape 3 ci-dessus ;
- **l'effet de bord sur le coffre de l'étape 11** (71 / 21 / 7 au lieu de 83 / 17), qui demande une
  note dans le document de résultats de l'étape 11 ;
- **la contrainte posée à l'étape des événements** (le plancher « ≥ légendaire » n'est plus tenable
  tel quel) ;
- une section **« vérification manuelle » laissée OUVERTE**, avec les points précis à regarder :
  la générosité du bouclier, la lisibilité de la barre chez un porteur à 1 PV, la fréquence
  ressentie des paliers, et si les trois légendaires donnent envie.

- [ ] **Étape 5 : committer et fusionner**

```bash
git add docs/plans/2026-10-16-etape-13-resultats.md README.md
git commit -m "docs: le bilan de l etape 13"
```
