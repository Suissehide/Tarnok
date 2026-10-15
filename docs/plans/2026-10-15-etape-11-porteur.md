# Étape 11 — le porteur de coffre : plan d'implémentation

> **Pour les agents :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou
> superpowers:executing-plans, tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**But :** une fois par palier (et au plus une fois toutes les cinquante vagues), un porteur de
coffre doré — un voleur agrandi — apparaît à ~1 500 px de l'équipe et la fuit ; l'abattre ouvre un
étalage d'équipe dont toutes les cartes sont rares ou légendaires.

**Architecture :** le porteur est un archétype de plus (id 20, après le troll), demandé par le
directeur comme un **ordre de vague ordinaire** ajouté en dernier au groupe de la 2ᵉ vague du
palier, sans tirage de plus dans son générateur. Sa fuite se décide dans `Horde.retarget` sur les
positions **retardées** que serveur et clients passent déjà au flowfield : elle se dérive des deux
côtés au pixel près. Sa mort met un coffre en file dans `Room` ; `#openDraft` consomme un coffre
avant un niveau et passe un plancher de rareté à `drawSpread`. Le client reconnaît le coffre en
voyant naître (`WAVE_ORDER`) puis mourir (`DEATHS`) le porteur avant le `LEVEL_UP` suivant :
**ni message, ni champ, ni octet par tick de plus.**

**Pile :** TypeScript, `ws`, Fastify, Pixi.js v8, Vitest (jsdom côté front pour l'UI), Biome,
Prisma/Postgres pour les tests d'intégration.

**Spec :** [`docs/specs/2026-10-15-etape-11-porteur.md`](../specs/2026-10-15-etape-11-porteur.md)

**Où l'on travaille :** dans un worktree — `main` reçoit des modifications en direct.

```bash
git worktree add ../Tarnok-porteur -b etape-11-porteur
cd ../Tarnok-porteur && npm ci && npm run db:generate -w back
cp ../Tarnok/back/.env back/.env && cp ../Tarnok/front/.env front/.env
```

Tous les chemins de ce plan sont relatifs à la racine du worktree (`../Tarnok-porteur`). Les
ancres `l.~N` sont celles du commit `c22200e` (la base du worktree), pas celles de la copie de
travail de `main`.

## Contraintes globales

- Constantes, valeurs de la spec, **jamais un nombre en dur ailleurs** :
  - `shared/archetypes.ts` : `PORTEUR_NAME = 'porteur'` ; `PORTEUR_HP_MULTIPLE = 10`
    (`PORTEUR_HP = HEAVY_HP × 10 = 200` au palier 0) ; `PORTEUR_FLEE_RADIUS = 400` (px) ;
    `PORTEUR_SPEED_FACTOR = 0.9` (`speed = round(PLAYER_SPEED × 0,9) = 234` px/s) ;
    `PORTEUR_BODY_SCALE = 1.6` ; `PORTEUR_ARCHETYPE` **dérivé du nom** (`archetypeIdOf`), comme
    `BOSS_ARCHETYPE` — jamais un `20` en dur.
  - `back/src/wave-director.ts` : `PORTEUR_WAVE_IN_PALIER = 2` ; `PORTEUR_MIN_GAP_WAVES = 50`
    (50 × 6 s = 5 min) ; `PORTEUR_SPAWN_DISTANCE = 1500` (px).
  - `shared/rarity.ts` : `CHEST_RARITY_FLOOR = RARITY.RARE` — au plancher, rare 15/18 ≈ 83 %,
    légendaire 3/18 ≈ 17 %.
  - `front/src/net/client.ts` : `PORTEUR_BANNER_MS = 4000`.
  - Rendu : anneau de rayon **46 px**, trait **4 px** en `COIN_TINT` (`0xf5c542`), rempli à
    **20 %** ; coffre centré **60 px** au-dessus, **22 × 15 px** en `COIN_TINT`, contour et
    couvercle `0x5a3a1a` **2 px**, serrure **4 px** ; point de mini-carte or `#f5c542` de **6 px**.
- **Zéro message nouveau, zéro champ nouveau, zéro octet de plus par tick.** Le porteur voyage
  dans un `WAVE_ORDER` de 19 octets existant ; `SNAPSHOT` n'est pas touché ; `DRAFT_OPEN` garde
  ses 4 octets par carte.
- **Aucun tirage de plus dans le générateur du directeur** : la graine et l'angle du porteur se
  dérivent de la graine de l'ordre principal (`(seed ^ 0x5f3a_c0f1) >>> 0`). Les ordres
  ordinaires restent bit-identiques ; seuls les `waveId` qui suivent un porteur se décalent.
- **Le voleur ordinaire ne change pas** : archétype 8, comportement `'voleur'`, fuite collante à
  `-THIEF_FLEE_SPEED`, vol d'or. Le porteur ne partage avec lui que des textures, côté rendu.
- **Aucun actif nouveau, aucune reconstruction d'atlas** : le porteur emprunte les textures du
  voleur par alias dans `HordeRenderer.adoptAtlas`.
- Commentaires de code en français **sans accents** ; messages de commit conventionnels en
  français sans accents, sujet en minuscules (commitlint `subject-case`) : `feat(shared): ...`,
  `test(back): ...`, `docs: ...`.
- **Discipline des sous-agents** : un sous-agent ne lance **que les fichiers de test de sa
  tâche** (`npx vitest run <fichier>`), jamais `npm test`, jamais un banc. Le portique complet est
  lancé par le contrôleur, **seul**, à la tâche 11.
- Commandes de test : tests de `shared/` depuis `back/` (`cd back && npx vitest run
  ../shared/<fichier>`), tests du front depuis `front/` (`cd front && npx vitest run src/...`),
  tests du back depuis `back/`. Les `*.integration.test.ts` exigent le Postgres local (il tourne
  déjà).
- Avant chaque commit : `npx biome check --write <fichiers de la tâche>` (le code de ce plan n'est
  pas garanti au format Biome ; le hook de commit le refuserait).
- **Des commits NOUVEAUX seulement** : jamais `--amend`, jamais `rebase`, jamais `reset`.
- Jamais `pkill -f` : les serveurs de dev de Léo tournent sur 5173 et 3100.
- **Fusion à anticiper.** Sur `main`, en ce moment même, quelqu'un modifie `front/index.html`,
  `front/src/main.ts`, `front/src/styles/main.css`, `front/src/ui/draft.ts`,
  `front/src/ui/draft.test.ts` (et crée `front/src/ui/guide.ts`) ; la copie de travail de `main`
  touche aussi `front/src/net/client.ts`, `front/src/render/frame.ts`,
  `front/src/render/frame.test.ts`, `front/src/render/stage.ts`. Les tâches 6, 7 et 9 touchent ces
  fichiers ; chacune le dit en tête. Les zones modifiées ici sont petites et éloignées de celles
  de `main` (vérifié sur le diff du 15 octobre) : un conflit éventuel se résout à la main, en
  gardant les deux côtés.

**Écart assumé n° 1 — la hitbox du porteur grossit, elle aussi (spec §3.4).** La spec dit que
`PROJECTILE_HIT_RADIUS` ne varie pas par archétype (en citant le commentaire de
`shared/archetypes.ts` l.71-78). Le code dit l'inverse depuis l'étape du colosse :
`shared/projectiles.ts` l.65-79 bâtit `HIT_R_BY_ARCHETYPE = PROJECTILE_HIT_RADIUS × bodyScale`.
Donner `bodyScale = 1,6` au porteur lui donne donc aussi une hitbox de 51,2 px au lieu de 32, des
deux côtés (le module est partagé : aucune divergence). Le plan suit le code : un corps et une
hitbox qui coïncident, comme pour le boss et le colosse. Le commentaire périmé de
`archetypes.ts` n'est pas réécrit (hors périmètre), le bilan le signale.

**Écart assumé n° 2 — le coffre est dessiné SOUS les créatures (spec §5.1).** Le calque des
comportements est posé sous la horde (`front/src/render/stage.ts` l.~147-149, « au sol, sous les
creatures »). Le corps du porteur fait 2 × 32 × 1,25 × 1,6 = 128 px dans sa plus grande dimension :
un coffre centré à 60 px peut être en partie masqué par la tête. Le plan garde les 60 px de la
spec (un réglage de sensation) et l'ajoute à la vérification manuelle ; monter l'icône dans un
calque au-dessus de la horde serait un calque de plus pour un pixel de réglage.

**Écart assumé n° 3 — une fonction de dessin partagée, `drawChest` (spec §5.3 : « aucune
fonction nouvelle »).** L'icône de coffre est dessinée deux fois — au-dessus du porteur
(`BehaviorRenderer`) et en retrait de la flèche de bord (`PingRenderer`). Plutôt que deux copies
de six lignes de `Graphics`, `behavior-renderer.ts` exporte `drawChest(g, x, y, scale)` et
`ping-renderer.ts` l'importe. `edgeArrow` et `drawArrow`, eux, sont réutilisés tels quels.

**Écart assumé n° 4 — « son `GameClient` dit `draftIsChest` », dans le livrable, est rejoué.** Le
back ne peut pas importer le front (aucun alias `@front`). Comme à l'étape 10, le livrable
(`back/src/porteur.integration.test.ts`) rejoue sur les messages **décodés** la règle exacte de
`GameClient` (`drapeauxDeCoffre`, trois lignes) ; le `GameClient` lui-même est couvert par
`front/src/net/client.test.ts` (tâche 6), sur les mêmes encodeurs.

**Écart assumé n° 5 — « le coffre attend un étalage déjà ouvert » ne peut pas se produire, et le
livrable force donc le seul cas réel.** Pendant un étalage le monde est gelé (`room.ts`
l.1305-1308) : aucune mort, donc aucun porteur ne tombe pendant qu'un étalage est ouvert — c'est
le §4.1 de la spec, tenu par construction. Le seul cas de file réel est « coffre et niveau dus au
même tick ». Le livrable le provoque sur vraies sockets en enveloppant `room.step` : au tick où le
porteur quitte la horde, il appelle `room.debugOweLevels(1)`, une **nouvelle écriture de test**
de `Room` (même statut que `debugSetGold`/`debugSetLevel`, tâche 5). Les tests de `room.test.ts`
le prouvent aussi, à graine fixe.

**Écart assumé n° 6 — trois tests existants supposaient « le boss est la seule exception ».**
`shared/archetypes.test.ts` l.92-101 (PV de chacun = PV de son rôle, sauf le boss) et l.218-230
(corps de chacun = corps de son rôle, sauf le boss) rougiraient : le porteur est une seconde
exception, nommée. `back/src/wave-director.test.ts` l.~590 (« tous les ordres d'une vague naissent
à la même ancre ») rougirait aussi : l'ordre du porteur a **son** ancre, à 1 500 px. Les trois
sont ajustés dans la tâche qui les fait rougir, l'exception écrite en clair.

**Écart assumé n° 7 — des champs optionnels là où la spec écrit des champs.** `MinimapView.porteur`
(spec §5.2), `FrameClient.porteur`, `HudSource.draftIsChest`/`porteurBannerOn` et
`DraftSource.draftIsChest` sont **optionnels** (`?`) : les doubles de test existants
(`minimap.test.ts`, `frame.test.ts`, `hud.test.ts`, `draft.test.ts`) compilent sans être touchés,
exactement comme `DraftSource.level` l'est déjà. `CueSnapshot.porteurs`, lui, est obligatoire
(un seul double, mis à jour).

**Écart assumé n° 8 — le bandeau de gel change de texte dans `paintHud`, pas dans `index.html`.**
La spec (§4.3) bascule « Niveau supérieur — pause… » en « Coffre — pause… ». `hud-freeze` reste un
seul élément ; `paintHud` (`front/src/ui/hud.ts` l.281) écrit son texte selon
`source.draftIsChest`. Seul le bandeau du porteur (`hud-porteur`, §5.4) entre dans `index.html`.

**Écart assumé n° 9 — les PV du porteur se testent au palier 0.** « 200 × 1,12^k » (spec §7) : le
porteur passe par `#scalePalierHp`, le chemin générique déjà testé sur tous les paliers
(`room.test.ts`, étape 6a). Le test de la tâche 5 vérifie que le porteur **y passe** —
`palierHp(PORTEUR_HP, room.palier)`, soit 200 au palier 0 — sans rejouer dix boss pour atteindre
`k > 0`.

**Écart assumé n° 10 — les tests de fuite vivent dans `shared/horde.test.ts`**, comme la spec le
demande, alors que ceux du voleur vivent dans `back/src/comportements.test.ts`. Le test du voleur
existant n'est pas déplacé ; le nouveau bloc le recoupe (fuite collante, facteur 1,3).

## Points de vigilance de la revue

1. **Un porteur demandé près d'un coin ou d'un bord** : l'ancre (joueur + 1 500 px) sort de la
   carte, mais l'entité naît **dans** la carte (`formationPositions` borne, puis sort des murs) et
   l'ancre tient dans un `int16` → test tâche 4.
2. **La horde est pleine quand l'ordre du porteur tombe** : rien ne naît, `porteurGone()` est
   appelé, le salon ne garde pas d'identité fantôme, aucun coffre n'est dû → test tâche 5.
3. **Le porteur est retiré hors du lot de morts** (bancs, `horde.kill`) : pas de coffre, mais le
   directeur est relâché — sinon plus aucun porteur pour toute la run → test tâche 5.
4. **Un client qui n'a pas vu l'ordre du porteur** (arrivé après, ou mort d'une identité
   inconnue) : pas de coffre reconnu, titre « Niveau N », et aucun coffre « dû » ne fuit sur le
   `LEVEL_UP` suivant → test tâche 6.
5. **Aucun joueur à portée, ou aucun joueur du tout** (`retarget([], [])`, tout le monde mort) :
   le porteur attend sur place (`stopped = 1`), jamais de `NaN`, jamais de fuite fantôme → test
   tâche 3.

---

## Carte des fichiers

| Fichier | Rôle |
| --- | --- |
| `shared/archetypes.ts`, `shared/archetypes.test.ts` | `Behavior` gagne `'porteur'` ; constantes `PORTEUR_*` ; l'entrée du bestiaire (id 20) ; `PORTEUR_ARCHETYPE` |
| `shared/rarity.ts`, `shared/rarity.test.ts` | `CHEST_RARITY_FLOOR` ; `rollRarity(rng, floor)` renormalisé |
| `shared/cards.ts`, `shared/cards.test.ts` | `drawSpread(loadouts, rng, floor)` |
| `shared/horde.ts`, `shared/horde.test.ts`, `shared/horde.replication.test.ts` | la règle de fuite du porteur, et sa preuve à 0,000 px |
| `back/src/wave-director.ts`, `back/src/wave-director.test.ts` | la demande du porteur (2ᵉ vague du palier, plancher de 50 vagues, `porteurGone`) |
| `back/src/room.ts`, `back/src/room.test.ts` | `#porteur`, `#chestsOwed`, l'ouverture coffre-d'abord, le plancher, `debugOweLevels` |
| `front/src/net/client.ts`, `front/src/net/client.test.ts` | `draftIsChest`, `porteur`, `porteurCount`, `porteurBannerOn`, `PORTEUR_BANNER_MS` |
| `front/src/audio/audio.ts`, `front/src/audio/audio.test.ts` | l'effet `'porteur'` |
| `front/src/ui/hud.ts`, `front/src/ui/hud.test.ts`, `front/index.html` | « Coffre — pause… », bandeau `hud-porteur` |
| `front/src/ui/draft.ts`, `front/src/ui/draft.test.ts` | titre « Coffre » |
| `front/src/main.ts` | câblage : bandeau, effet, mini-carte |
| `front/src/render/horde-renderer.ts`, `front/src/render/horde-renderer.test.ts` | l'alias de textures du voleur, l'attente sur une image |
| `front/src/render/behavior-renderer.ts`, `front/src/render/behavior-renderer.test.ts` | forme `'coffre'` : l'anneau et l'icône ; `drawChest` |
| `front/src/ui/minimap.ts`, `front/src/ui/minimap.test.ts` | le point or |
| `front/src/render/ping-renderer.ts`, `front/src/render/ping-renderer.test.ts`, `front/src/render/stage.ts`, `front/src/render/frame.ts`, `front/src/render/frame.test.ts` | la flèche de bord or |
| `back/src/porteur.integration.test.ts` (créé) | **le livrable** |
| `docs/plans/2026-10-15-etape-11-resultats.md` (créé), `README.md` | le bilan |

Pourquoi ce découpage : le modèle (tâches 1-2) précède tout ; la fuite (3) et la demande (4) sont
deux règles partagées indépendantes, chacune avec sa preuve ; le salon (5) n'a de sens qu'avec
les deux ; côté client, la **reconnaissance** du coffre (6) est de la logique testable seule,
l'**annonce** (7) est de l'UI qui la lit ; le dessin au sol (8) et le suivi hors champ (9) sont
deux calques qu'un relecteur peut accepter l'un sans l'autre ; le livrable (10) vient quand tout
est là.

---

### Tâche 1 : le porteur entre au bestiaire

**Fichiers :**
- Modifier : `shared/archetypes.ts` (import en tête ; `Behavior` l.347-357 ; après
  `THIEF_FLEE_SPEED` l.387 ; `hpOf` l.466-468 ; `bodyScaleOf` l.471-473 ; entre `ELITES` l.617 et
  `FOOTSOLDIER_COUNT` l.620 ; `ARCHETYPES` l.631-635 ; fin de fichier après `archetypeIdOf`
  l.678-684)
- Tester : `shared/archetypes.test.ts` (imports l.3-21 ; tests l.92-101 et l.218-230 ; nouveau
  `describe` en fin de fichier)

**Interfaces :**
- Produit : `Behavior` gagne `'porteur'` ; `PORTEUR_NAME = 'porteur'`, `PORTEUR_HP_MULTIPLE = 10`,
  `PORTEUR_HP = 200`, `PORTEUR_FLEE_RADIUS = 400`, `PORTEUR_SPEED_FACTOR = 0.9`,
  `PORTEUR_BODY_SCALE = 1.6`, `PORTEUR_ARCHETYPE: number` (= `BOSS_ARCHETYPE + 1` = 20), tous
  exportés de `shared/archetypes.ts`. L'archétype : rôle `'troupe'`, comportement `'porteur'`,
  `speed` 234, `hp` 200, `armor` 0, `bodyScale` 1,6, `countFactor` 1, planche du voleur.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/archetypes.test.ts`, ajouter aux imports de `./archetypes` : `archetypeIdOf`,
`PORTEUR_ARCHETYPE`, `PORTEUR_BODY_SCALE`, `PORTEUR_HP`, `PORTEUR_HP_MULTIPLE`, `PORTEUR_NAME`,
`PORTEUR_SPEED_FACTOR` ; et à l'import de `./constants` : `PLAYER_SPEED`.

Le test l.92 « donne a chaque pietaille les PV de son role, le boss seul faisant exception »
devient :

```ts
  it('donne a chaque pietaille les PV de son role, le boss et le porteur seuls faisant exception', () => {
    // Quatre brutes a `HEAVY_HP`, comme les quatre lourdes d'avant.
    expect(ARCHETYPES.filter((a) => a.hp === HEAVY_HP)).toHaveLength(4);
    for (const a of ARCHETYPES) {
      // ⚠️ **Deux exceptions, et elles sont nommees** (le porteur depuis
      // l'etape 11) : comparer a l'identifiant dit qu'il n'y en a pas d'autre.
      const attendu =
        a.id === BOSS_ARCHETYPE
          ? BOSS_HP_PER_PLAYER
          : a.id === PORTEUR_ARCHETYPE
            ? PORTEUR_HP
            : ROLES[a.role].hp;
      expect(a.hp, a.name).toBe(attendu);
    }
  });
```

Dans le test l.218 « a son PROPRE facteur de corps, plus gros que tout le bestiaire », la boucle
devient :

```ts
    for (const a of ARCHETYPES) {
      if (a.id === BOSS_ARCHETYPE) {
        continue;
      }
      // Le porteur (etape 11) a SON facteur, lui aussi — sous celui du boss.
      const attendu = a.id === PORTEUR_ARCHETYPE ? PORTEUR_BODY_SCALE : ROLES[a.role].bodyScale;
      expect(a.bodyScale, a.name).toBe(attendu);
      expect(a.bodyScale).toBeLessThan(BOSS_BODY_SCALE);
    }
```

Ajouter en fin de fichier :

```ts
describe('etape 11 : le porteur de coffre', () => {
  const PORTEUR = archetypeOf(PORTEUR_ARCHETYPE);
  const VOLEUR = archetypeOf(archetypeIdOf('thief'));

  it('vient APRES le troll : aucun identifiant existant ne bouge', () => {
    expect(PORTEUR.name).toBe(PORTEUR_NAME);
    expect(PORTEUR_ARCHETYPE).toBe(BOSS_ARCHETYPE + 1);
    expect(ARCHETYPES[PORTEUR_ARCHETYPE - 1]?.name).toBe('troll');
    expect(ARCHETYPES).toHaveLength(PORTEUR_ARCHETYPE + 1);
  });

  it('a son propre comportement, et n est jamais tire au hasard', () => {
    expect(PORTEUR.behavior).toBe('porteur');
    expect(STEP2_ARCHETYPES).not.toContain(PORTEUR_ARCHETYPE);
    // Le voleur ordinaire ne change pas.
    expect(VOLEUR.behavior).toBe('voleur');
    expect(VOLEUR.id).toBe(8);
  });

  it('PV = HEAVY_HP x PORTEUR_HP_MULTIPLE, armure nulle, role troupe', () => {
    expect(PORTEUR_HP).toBe(HEAVY_HP * PORTEUR_HP_MULTIPLE);
    expect(PORTEUR.hp).toBe(200);
    expect(PORTEUR.armor).toBe(0);
    expect(PORTEUR.role).toBe('troupe');
    expect(PORTEUR.countFactor).toBe(1);
  });

  it('un peu moins vite qu un joueur : round(PLAYER_SPEED x 0,9) = 234 px/s', () => {
    expect(PORTEUR.speed).toBe(Math.round(PLAYER_SPEED * PORTEUR_SPEED_FACTOR));
    expect(PORTEUR.speed).toBe(234);
    expect(PORTEUR.speed).toBeLessThan(PLAYER_SPEED);
  });

  it('porte la planche du voleur, 1,6 fois plus grand', () => {
    expect(PORTEUR.sheet).toBe(VOLEUR.sheet);
    expect(PORTEUR.frames).toBe(VOLEUR.frames);
    expect(PORTEUR.cell).toBe(VOLEUR.cell);
    expect(PORTEUR.bodyScale).toBe(PORTEUR_BODY_SCALE);
    expect(VOLEUR.bodyScale).toBe(1);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run ../shared/archetypes.test.ts`
Attendu : ÉCHEC — `PORTEUR_ARCHETYPE` et consorts ne sont pas exportés.

- [ ] **Étape 3 : implémenter**

Dans `shared/archetypes.ts`, en tête de fichier (il n'importe rien aujourd'hui ;
`shared/constants.ts` n'importe rien non plus, aucun cycle) :

```ts
import { PLAYER_SPEED } from './constants';
```

`Behavior` (l.347) gagne une ligne, et son docbloc une puce :

```ts
 * - `porteur` : le porteur de coffre (etape 11) — attend loin de l'equipe,
 *   fuit le joueur le plus proche a `PORTEUR_FLEE_RADIUS`.
```

```ts
  | 'gardien'
  | 'porteur';
```

Après `THIEF_FLEE_SPEED` (l.387) :

```ts
/**
 * Le porteur de coffre (etape 11, §3.1 de la spec) : une elite d'UN
 * exemplaire, que le directeur demande une fois par palier et que le hasard
 * ne tire jamais (il n'est pas dans `STEP2_ARCHETYPES`). Un voleur agrandi,
 * avec SA regle de fuite (`Horde.retarget`) : il n'en partage que les textures.
 */
export const PORTEUR_NAME = 'porteur';
/** Ses PV, en multiple de `HEAVY_HP` comme le boss : 200 au palier 0, puis `palierHp`. */
export const PORTEUR_HP_MULTIPLE = 10;
export const PORTEUR_HP = HEAVY_HP * PORTEUR_HP_MULTIPLE;
/**
 * Il fuit si le joueur le plus proche — positions RETARDEES, celles du
 * flowfield — est a cette distance ou moins. Hors du rayon, il attend.
 *
 * ⚠️ **Le reglage du §8 de la spec** : la plupart des armes portent au-dela
 * de 400 px ; un tireur qui s'arrete a 450 px le crible pendant qu'il attend.
 * Si c'est trop facile au playtest, c'est ce nombre (ou les PV) qu'on monte.
 */
export const PORTEUR_FLEE_RADIUS = 400;
/** Sa vitesse en part de `PLAYER_SPEED` : un peu moins vite qu'un joueur. */
export const PORTEUR_SPEED_FACTOR = 0.9;
/**
 * Dessine 1,6 fois plus gros qu'un voleur ordinaire — et TOUCHE 1,6 fois plus
 * large : `shared/projectiles.ts` multiplie la hitbox par `bodyScale`.
 */
export const PORTEUR_BODY_SCALE = 1.6;
```

`hpOf` et `bodyScaleOf` (l.466-473) deviennent :

```ts
function hpOf(name: string, role: Role): number {
  if (name === PORTEUR_NAME) {
    return PORTEUR_HP;
  }
  return name === BOSS_NAME ? BOSS_HP_PER_PLAYER : ROLES[role].hp;
}

/** Le facteur de corps du role ; le boss et le porteur debordent davantage. Voir `Archetype.bodyScale`. */
function bodyScaleOf(name: string, role: Role): number {
  if (name === PORTEUR_NAME) {
    return PORTEUR_BODY_SCALE;
  }
  return name === BOSS_NAME ? BOSS_BODY_SCALE : ROLES[role].bodyScale;
}
```

Entre la fin de `ELITES` (l.617) et `FOOTSOLDIER_COUNT` (l.620) :

```ts
/**
 * Le porteur de coffre (etape 11) : la planche, le cycle et la cellule du
 * voleur (`thief`), sa vitesse a lui. Range APRES le troll, pour qu'aucun
 * identifiant existant ne bouge — le fil, l'atlas et les tests en dependent.
 */
const PORTEUR: Omit<Archetype, 'id' | 'hp' | 'armor' | 'bodyScale' | 'countFactor'> = {
  name: PORTEUR_NAME,
  sheet: 'Thief/Thief_Run.png',
  frames: 6,
  cell: 192,
  speed: Math.round(PLAYER_SPEED * PORTEUR_SPEED_FACTOR),
  role: 'troupe',
  behavior: 'porteur',
};
```

Le tableau source de `ARCHETYPES` (l.631-635) devient :

```ts
export const ARCHETYPES: readonly Archetype[] = [
  ...FOOTSOLDIERS,
  // Les elites ne sont jamais tirees (le boss mis a part) : role neutre.
  ...ELITES.map((e) => ({ ...e, role: 'troupe' as Role })),
  // Etape 11 : le porteur, en DERNIER.
  PORTEUR,
].map((a, id) => ({
```

(le corps du `.map` ne change pas : il lit déjà `'behavior' in a`).

En fin de fichier, après `archetypeIdOf` :

```ts
/**
 * Identifiant du porteur de coffre (etape 11), **derive du nom** comme
 * `BOSS_ARCHETYPE` : un `20` en dur pointerait sur un autre monstre le jour
 * ou un archetype serait insere avant lui.
 */
export const PORTEUR_ARCHETYPE: number = archetypeIdOf(PORTEUR_NAME);
```

- [ ] **Étape 4 : les relancer, ils passent ; typecheck des deux côtés**

Run : `cd back && npx vitest run ../shared/archetypes.test.ts ../shared/paliers.test.ts ../shared/projectiles.test.ts`
Attendu : PASS.
Run : `npm run typecheck -w back && npm run typecheck -w front`
Attendu : aucune erreur.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write shared/archetypes.ts shared/archetypes.test.ts
git add shared/archetypes.ts shared/archetypes.test.ts
git commit -m "feat(shared): le porteur de coffre entre au bestiaire, apres le troll"
```

---

### Tâche 2 : le plancher de rareté

**Fichiers :**
- Modifier : `shared/rarity.ts` (après `RARITY_WEIGHTS` l.24 ; `rollRarity` l.40-54),
  `shared/cards.ts` (docbloc l.~145-150 et signature de `drawSpread` l.151 ; appel l.166)
- Tester : `shared/rarity.test.ts`, `shared/cards.test.ts` (nouveaux `describe` en fin de
  fichier)

**Interfaces :**
- Produit : `CHEST_RARITY_FLOOR: number` (= `RARITY.RARE`) ;
  `rollRarity(rng: () => number, floor: number = RARITY.COMMUNE): number` ;
  `drawSpread(loadouts: ReadonlyMap<number, Loadout>, rng: () => number, floor: number = RARITY.COMMUNE): Card[]`.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/rarity.test.ts`, ajouter `CHEST_RARITY_FLOOR` à l'import de `./rarity`, puis en fin
de fichier :

```ts
describe('etape 11 : le plancher de rarete', () => {
  it('le coffre est au plancher rare', () => {
    expect(CHEST_RARITY_FLOOR).toBe(RARITY.RARE);
  });

  /**
   * ⚠️ **La suite RELEVEE sur main avant l'etape** (graine 0x110a0001, 40
   * tirages) : sans plancher, une montee de niveau ne doit voir AUCUNE
   * difference — ni de rarete, ni de consommation du `rng`.
   */
  it('sans plancher, le meme rng rend la meme suite qu avant l etape', () => {
    const r = makeRandom(0x11_0a_0001);
    expect(Array.from({ length: 40 }, () => rollRarity(r))).toEqual([
      0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 1, 0, 0, 0, 0, 0,
    ]);
  });

  it('au plancher rare, sur un rng scripte : 15/18 rare, 3/18 legendaire', () => {
    expect(rollRarity(() => 0, RARITY.RARE)).toBe(RARITY.RARE);
    // 0,83 x 18 = 14,94 < 15 : encore rare ; 0,84 x 18 = 15,12 : legendaire.
    expect(rollRarity(() => 0.83, RARITY.RARE)).toBe(RARITY.RARE);
    expect(rollRarity(() => 0.84, RARITY.RARE)).toBe(RARITY.LEGENDAIRE);
    expect(rollRarity(() => 0.999_999, RARITY.RARE)).toBe(RARITY.LEGENDAIRE);
  });

  it('au plancher rare, jamais commune, et encore legendaire ~17 % du temps', () => {
    const rng = makeRandom(0x11_0a_0002);
    const vus = [0, 0, 0];
    const N = 50_000;
    for (let i = 0; i < N; i++) {
      const r = rollRarity(rng, CHEST_RARITY_FLOOR);
      vus[r] = (vus[r] ?? 0) + 1;
    }
    expect(vus[RARITY.COMMUNE]).toBe(0);
    expect((vus[RARITY.LEGENDAIRE] ?? 0) / N).toBeCloseTo(3 / 18, 1);
    expect((vus[RARITY.RARE] ?? 0) / N).toBeCloseTo(15 / 18, 1);
  });
});
```

Dans `shared/cards.test.ts`, ajouter `isLegendaryOnly` à l'import de `./cards` s'il n'y est pas,
`CHEST_RARITY_FLOOR` à l'import de `./rarity`, puis en fin de fichier :

```ts
describe('etape 11 : drawSpread au plancher du coffre', () => {
  it('aucune carte commune sur 500 graines, des legendaires, et les exclusifs restent legendaires', () => {
    let legendaires = 0;
    for (let seed = 1; seed <= 500; seed++) {
      for (const c of drawSpread(equipe(new Loadout(), new Loadout()), makeRandom(seed), CHEST_RARITY_FLOOR)) {
        expect(c.rarity ?? RARITY.COMMUNE).toBeGreaterThanOrEqual(RARITY.RARE);
        if (c.rarity === RARITY.LEGENDAIRE) {
          legendaires++;
        }
        if (isLegendaryOnly(c)) {
          expect(c.rarity).toBe(RARITY.LEGENDAIRE);
        }
      }
    }
    // Non-vacuite : un plancher qui ne rendrait QUE du rare passerait le reste.
    expect(legendaires).toBeGreaterThan(0);
  });

  it('sans plancher, l etalage est exactement celui du plancher commun', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const l = new Loadout();
      l.addWeapon(BASE_WEAPON_ID);
      expect(drawSpread(equipe(l, new Loadout()), makeRandom(seed))).toEqual(
        drawSpread(equipe(l, new Loadout()), makeRandom(seed), RARITY.COMMUNE),
      );
    }
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run ../shared/rarity.test.ts ../shared/cards.test.ts -t "etape 11"`
Attendu : ÉCHEC — `CHEST_RARITY_FLOOR` non exporté ; au plancher, `rollRarity(() => 0, 1)` rend
`0`.

- [ ] **Étape 3 : implémenter**

Dans `shared/rarity.ts`, après `RARITY_WEIGHTS` :

```ts
/**
 * Le plancher de rarete d'un COFFRE (etape 11, §4.2) : toutes ses cartes sont
 * au moins rares. Le tirage RENORMALISE au-dessus du plancher (15/18 rare,
 * 3/18 legendaire) — un `Math.max(plancher, tirage)` aurait laisse la
 * legendaire a 3 % et ote au coffre sa raison d'etre un evenement.
 */
export const CHEST_RARITY_FLOOR: number = RARITY.RARE;
```

`rollRarity` devient (garder le docbloc, y ajouter le paragraphe) :

```ts
 *
 * `floor` (etape 11) : ne tire que parmi les raretes `>= floor`, a leurs poids
 * relatifs. ⚠️ **Au plancher par defaut, le calcul est EXACTEMENT celui
 * d'avant** — meme somme dans le meme ordre, un seul `rng()` : une montee de
 * niveau ne voit aucune difference.
 */
export function rollRarity(rng: () => number, floor: number = RARITY.COMMUNE): number {
  let total = 0;
  for (let r = floor; r < RARITY_WEIGHTS.length; r++) {
    total += RARITY_WEIGHTS[r] ?? 0;
  }
  let roll = rng() * total;
  for (let r = floor; r < RARITY_WEIGHTS.length; r++) {
    roll -= RARITY_WEIGHTS[r] ?? 0;
    if (roll < 0) {
      return r;
    }
  }
  return RARITY_WEIGHTS.length - 1;
}
```

Dans `shared/cards.ts`, compléter le docbloc de `drawSpread` (avant `*/`) :

```ts
 *
 * `floor` (etape 11) : le plancher de rarete de CHAQUE emplacement, passe tel
 * quel a `rollRarity` — `CHEST_RARITY_FLOOR` pour un coffre. Rien d'autre ne
 * change : un passif exclusivement legendaire n'entre toujours que sur un
 * emplacement legendaire.
```

la signature devient :

```ts
export function drawSpread(
  loadouts: ReadonlyMap<number, Loadout>,
  rng: () => number,
  floor: number = RARITY.COMMUNE,
): Card[] {
```

et, dans la boucle, `const rarity = rollRarity(rng);` devient
`const rarity = rollRarity(rng, floor);`.

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run ../shared/rarity.test.ts ../shared/cards.test.ts`
Attendu : PASS (les tests de l'étape 10 compris : sans plancher, rien n'a bougé).

- [ ] **Étape 5 : commit**

```bash
npx biome check --write shared/rarity.ts shared/rarity.test.ts shared/cards.ts shared/cards.test.ts
git add shared/rarity.ts shared/rarity.test.ts shared/cards.ts shared/cards.test.ts
git commit -m "feat(shared): un plancher de rarete pour le tirage, renormalise au-dessus"
```

---

### Tâche 3 : la fuite du porteur, dérivée des deux côtés au pixel près

**Fichiers :**
- Modifier : `shared/horde.ts` (import l.1-9 ; `retarget` l.846-877 ; `#advanceByVelocity`
  l.1416-1419)
- Tester : `shared/horde.test.ts` (import l.3 ; nouveau `describe` en fin de fichier),
  `shared/horde.replication.test.ts` (import l.4 ; nouveau `describe` en fin de fichier)

**Interfaces :**
- Consomme : `PORTEUR_ARCHETYPE`, `PORTEUR_FLEE_RADIUS`, `Behavior` `'porteur'` (tâche 1).
- Produit : pour une entité `'porteur'`, `retarget` pose `fleeing = (dist² au plus proche ≤
  400²) ? 1 : 0` (non collant) et `stopped = 1 − fleeing` ; `#advanceByVelocity` applique `-1`
  (et non `-THIEF_FLEE_SPEED`) à un porteur en fuite.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/horde.test.ts`, l'import l.3 devient
`import { ARCHETYPES, archetypeOf, HEAVY_HP, LIGHT_HP, PORTEUR_ARCHETYPE, PORTEUR_FLEE_RADIUS, THIEF_FLEE_SPEED } from './archetypes';`
(`CONTACT_RADIUS` est déjà importé de `./constants`), puis en fin de fichier :

```ts
describe('etape 11 : la fuite du porteur', () => {
  const VOLEUR = ARCHETYPES.findIndex((a) => a.behavior === 'voleur');

  /** Une horde d'une seule entite, posee en (1000, 1000). Meme `waveId` partout : meme phase de pilotage. */
  function seul(archetype: number): Horde {
    const h = new Horde(4);
    h.spawn(order({ archetype, count: 1, formation: FORMATION.POINT }));
    h.x[0] = 1000;
    h.y[0] = 1000;
    return h;
  }

  it('joueur (retarde) a 399 px : il fuit ; a 400 aussi ; a 401 : il attend sur place', () => {
    const h = seul(PORTEUR_ARCHETYPE);
    h.retarget([1000 + PORTEUR_FLEE_RADIUS - 1], [1000]);
    expect(h.fleeing[0]).toBe(1);
    expect(h.stopped[0]).toBe(0);
    h.retarget([1000 + PORTEUR_FLEE_RADIUS], [1000]);
    expect(h.fleeing[0]).toBe(1);
    // ⚠️ **Pas collant**, contrairement au voleur : le joueur s'eloigne, la
    // fuite s'arrete et il attend de nouveau.
    h.retarget([1000 + PORTEUR_FLEE_RADIUS + 1], [1000]);
    expect(h.fleeing[0]).toBe(0);
    expect(h.stopped[0]).toBe(1);
  });

  it('c est le joueur le PLUS PROCHE qui decide ; sans joueur du tout, il attend', () => {
    const h = seul(PORTEUR_ARCHETYPE);
    h.retarget([2500, 1300], [1000, 1000]);
    expect(h.fleeing[0]).toBe(1);
    expect(h.targetField[0]).toBe(1);
    h.retarget([], []);
    expect(h.fleeing[0]).toBe(0);
    expect(h.stopped[0]).toBe(1);
    // Il attend : un pas ne le deplace pas.
    h.vx[0] = 100;
    h.step(DT, [], 1);
    expect(h.x[0]).toBe(1000);
    expect(Number.isNaN(h.x[0])).toBe(false);
  });

  it('en fuite il s eloigne a SA vitesse ; le voleur ordinaire, lui, a THIEF_FLEE_SPEED et pour toujours', () => {
    const p = seul(PORTEUR_ARCHETYPE);
    const v = seul(VOLEUR);
    p.retarget([1300], [1000]);
    v.retarget([1000 + CONTACT_RADIUS - 1], [1000]);
    // Le voleur ne change pas : loin du joueur, il reste en fuite.
    v.retarget([5000], [5000]);
    expect(v.fleeing[0]).toBe(1);
    expect(p.fleeing[0]).toBe(1);
    // Sans champ, `step` remet la vitesse a zero quand il la recalcule : on la
    // repose a chaque pas (meme recette que `comportements.test.ts`). Meme
    // vitesse posee, meme phase : l'ecart ne vient QUE du facteur de fuite.
    for (let t = 1; t <= 10; t++) {
      for (const h of [p, v]) {
        h.vx[0] = 100;
        h.vy[0] = 0;
        h.step(DT, [], t);
      }
    }
    const dp = 1000 - (p.x[0] ?? 0);
    const dv = 1000 - (v.x[0] ?? 0);
    expect(dp).toBeGreaterThan(0);
    expect(dv / dp).toBeCloseTo(THIEF_FLEE_SPEED, 3);
  });

  it('un voleur ordinaire hors de portee de contact ne fuit pas, porteur ou non a cote', () => {
    const v = seul(VOLEUR);
    v.retarget([1000 + PORTEUR_FLEE_RADIUS - 1], [1000]);
    expect(v.fleeing[0]).toBe(0);
  });
});
```

Dans `shared/horde.replication.test.ts`, l'import l.4 devient
`import { archetypeOf, PORTEUR_ARCHETYPE } from './archetypes';`, puis en fin de fichier :

```ts
/**
 * Etape 11, §3.2 : la fuite du porteur se decide dans `retarget`, sur les
 * positions RETARDEES — les memes des deux cotes, a la meme cadence. Ce
 * scenario le prouve sur une vraie poursuite : un porteur, une foule autour,
 * et deux chasseurs qui le prennent en tenaille. Serveur et client doivent
 * rester bit-identiques sur TOUTE la poursuite, attente comprise.
 */
describe('etape 11 : la fuite du porteur se derive a l identique', () => {
  it('un porteur chasse par deux joueurs : 0,000 px de derive, attente et fuite comprises', () => {
    const mapSeed = 0x11_f1_ee01;
    const parts = [makeParticipant(mapSeed), makeParticipant(mapSeed)];
    const porteur: WaveOrder = {
      waveId: 1,
      spawnTick: 0,
      seed: 0x9047_e0f1,
      archetype: PORTEUR_ARCHETYPE,
      formation: FORMATION.POINT,
      anchorX: 3000,
      anchorY: 3000,
      count: 1,
    };
    // Une foule autour : la fuite doit traverser du monde, pas un desert.
    const foule: WaveOrder = {
      waveId: 2,
      spawnTick: 0,
      seed: 0x51ee_d011,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 3000,
      anchorY: 3000,
      count: 300,
    };
    for (const p of parts) {
      p.horde.spawn(porteur, p.fields[0]);
      p.horde.spawn(foule, p.fields[0]);
    }
    const [serveur, client] = parts;
    if (!serveur || !client) {
      throw new Error('deux participants attendus');
    }
    const id = entityIdOf(1, 0);
    const depart = {
      x: serveur.horde.x[serveur.horde.slotOf(id)] ?? 0,
      y: serveur.horde.y[serveur.horde.slotOf(id)] ?? 0,
    };
    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    let maxDrift = 0;
    let mismatches = 0;
    let vuAttendre = false;
    let vuFuir = false;

    for (let tick = 0; tick < 600; tick++) {
      // La tenaille : deux chasseurs partis a 1 200 px de part et d'autre,
      // qui se referment en douze secondes jusqu'a 100 px de son point de depart.
      const k = Math.min(1, tick / 360);
      const xs = [depart.x - 1200 + 1100 * k, depart.x + 1200 - 1100 * k];
      const ys = [depart.y, depart.y + 40];
      for (const p of parts) {
        p.history.record(tick, xs, ys);
        if (tick % stepsPerField === 0) {
          const seen = p.history.delayed(tick);
          if (seen) {
            for (let f = 0; f < 2; f++) {
              p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
            }
            p.horde.retarget(seen.x, seen.y);
          }
        }
        p.horde.step(DT, p.fields, tick);
      }

      expect(client.horde.count).toBe(serveur.horde.count);
      for (let i = 0; i < serveur.horde.count; i++) {
        const drift = Math.hypot(
          (client.horde.x[i] ?? 0) - (serveur.horde.x[i] ?? 0),
          (client.horde.y[i] ?? 0) - (serveur.horde.y[i] ?? 0),
        );
        maxDrift = Math.max(maxDrift, drift);
        if (client.horde.entityIdAt(i) !== serveur.horde.entityIdAt(i)) {
          mismatches++;
        }
      }
      const s = serveur.horde.slotOf(id);
      if (s >= 0 && serveur.horde.fleeing[s] === 1) {
        vuFuir = true;
      } else if (s >= 0 && serveur.horde.stopped[s] === 1) {
        vuAttendre = true;
      }
    }

    process.stdout.write(`etape 11 : derive de la poursuite du porteur ${maxDrift.toFixed(3)} px\n`);
    expect(mismatches).toBe(0);
    expect(maxDrift).toBe(0);
    // ⚠️ **Le decor produit-il ce qu'il pretend mesurer ?** Sans ces trois
    // lignes, un porteur qui n'aurait jamais attendu, jamais fui ou jamais
    // bouge passerait la derive nulle sans rien prouver.
    expect(vuAttendre).toBe(true);
    expect(vuFuir).toBe(true);
    const fin = serveur.horde.slotOf(id);
    expect(
      Math.hypot((serveur.horde.x[fin] ?? 0) - depart.x, (serveur.horde.y[fin] ?? 0) - depart.y),
    ).toBeGreaterThan(50);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run ../shared/horde.test.ts -t "etape 11"`
Attendu : ÉCHEC — le porteur suit la règle commune (il ne fuit pas, `stopped` reste 0 hors du
contact).
Run : `cd back && npx vitest run ../shared/horde.replication.test.ts -t "etape 11"`
Attendu : ÉCHEC sur `vuFuir` (la dérive, elle, est déjà nulle : c'est la non-vacuité qui garde).

- [ ] **Étape 3 : implémenter**

Dans `shared/horde.ts`, ajouter `PORTEUR_FLEE_RADIUS` à l'import de `./archetypes` (l.1-9).

Dans `retarget`, après `const shooterR2 = SHOOTER_RANGE * SHOOTER_RANGE;` (l.~850) :

```ts
    const porteurR2 = PORTEUR_FLEE_RADIUS * PORTEUR_FLEE_RADIUS;
```

et, juste après `const behavior = archetypeOf(this.archetype[i] ?? 0).behavior;` (l.868) :

```ts
      // Etape 11, §3.2 : le porteur fuit le joueur le plus proche a
      // `PORTEUR_FLEE_RADIUS` — sur `bestDist`, donc sur les positions
      // RETARDEES, la meme decision au meme tick des deux cotes. PAS collant,
      // contrairement au voleur. Hors du rayon il ATTEND (`stopped`) : sans ca
      // il marcherait jusqu'a 400 px puis reculerait, en oscillant au bord.
      if (behavior === 'porteur') {
        this.fleeing[i] = bestDist <= porteurR2 ? 1 : 0;
        this.stopped[i] = this.fleeing[i] === 1 ? 0 : 1;
        continue;
      }
```

Dans `#advanceByVelocity`, la ligne `const fuite = ...` (l.1418) et son commentaire deviennent :

```ts
      // Le voleur en fuite remonte sa trajectoire : il s'eloigne du joueur
      // que le flowfield lui designe. Le porteur aussi (etape 11), mais a SA
      // vitesse : ses 234 px/s SONT sa vitesse de fuite, sans le facteur du voleur.
      const fuite =
        this.fleeing[i] === 1 ? (arch.behavior === 'porteur' ? -1 : -THIEF_FLEE_SPEED) : 1;
```

`fleeing` et `stopped` sont déjà dans les quinze tableaux de l'historique (`horde.ts` l.168,
l.709-731) : le rejeu les restaure sans rien apprendre.

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run ../shared/horde.test.ts src/comportements.test.ts`
Attendu : PASS (le voleur de `comportements.test.ts` n'a pas bougé).
Run : `cd back && npx vitest run ../shared/horde.replication.test.ts -t "etape 11"`
Attendu : PASS, et la ligne `etape 11 : derive de la poursuite du porteur 0.000 px`.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write shared/horde.ts shared/horde.test.ts shared/horde.replication.test.ts
git add shared/horde.ts shared/horde.test.ts shared/horde.replication.test.ts
git commit -m "feat(shared): le porteur fuit le joueur le plus proche, derive au pixel pres"
```

---

### Tâche 4 : le directeur demande le porteur

**Fichiers :**
- Modifier : `back/src/wave-director.ts` (imports l.1-11 ; après `BOSS_WAVE_COUNT` l.341 ; champs
  l.344-366 ; `bossDefeated` l.397-403 ; après `bossMissing` l.416-419 ; `dueWave` l.474-475,
  l.500, l.532-536)
- Tester : `back/src/wave-director.test.ts` (imports l.1-19 ; test « suit un cycle » l.~562-592 ;
  nouveau `describe` en fin de fichier)

**Interfaces :**
- Consomme : `PORTEUR_ARCHETYPE` (tâche 1).
- Produit : `PORTEUR_WAVE_IN_PALIER = 2`, `PORTEUR_MIN_GAP_WAVES = 50`,
  `PORTEUR_SPAWN_DISTANCE = 1500` exportés de `back/src/wave-director.ts` ;
  `WaveDirector.porteurGone(): void`. L'ordre du porteur est le **dernier** du groupe que
  `dueWave` rend : `archetype = PORTEUR_ARCHETYPE`, `formation = FORMATION.POINT`, `count = 1`,
  `seed = (seed du premier ordre du groupe ^ 0x5f3a_c0f1) >>> 0`, ancre = position (arrondie) du
  joueur ciblé + `PORTEUR_SPAWN_DISTANCE` dans la direction `seed / 2³² × 2π`.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `back/src/wave-director.test.ts` : ajouter `PORTEUR_ARCHETYPE` à l'import de
`@shared/archetypes`, `MAP_SIZE` à celui de `@shared/constants`,
`import { Horde } from '@shared/horde';`, et `PORTEUR_MIN_GAP_WAVES`, `PORTEUR_SPAWN_DISTANCE`,
`PORTEUR_WAVE_IN_PALIER` à l'import de `./wave-director`.

Dans le test « suit un cycle : nuee, troupe, pic, repit, puis le boss — et melange les roles »,
la ligne `groupes.push(g);` devient :

```ts
      if (g.length > 0) {
        // ⚠️ L'ordre du porteur (etape 11) a SON ancre, a 1 500 px : il n'est
        // pas une escorte, et ce test parle des vagues ordinaires.
        groupes.push(g.filter((o) => o.archetype !== PORTEUR_ARCHETYPE));
      }
```

Puis en fin de fichier :

```ts
describe('etape 11 : le directeur demande le porteur de coffre', () => {
  const estPorteur = (o: WaveOrder): boolean => o.archetype === PORTEUR_ARCHETYPE;

  /** FNV-1a 32 bits : une empreinte du flux, comparee a celle relevee sur main. */
  function fnv1a(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  /**
   * Les `vagues` premiers groupes d'un directeur. Le boss tombe a son
   * apparition ; le porteur rend la main (`porteurGone`) a la sienne si `rendre`.
   */
  function groupes(
    seed: number,
    vagues: number,
    rendre: boolean,
    xs: readonly number[] = [3000],
    ys: readonly number[] = [3000],
  ): WaveOrder[][] {
    const d = new WaveDirector(seed);
    const out: WaveOrder[][] = [];
    for (let tick = 0; out.length < vagues; tick++) {
      const g = d.dueWave(tick, xs, ys);
      if (g.length === 0) {
        continue;
      }
      out.push(g);
      if (d.bossWaveId === g[0]?.waveId) {
        d.bossDefeated();
      }
      if (rendre && g.some(estPorteur)) {
        d.porteurGone();
      }
    }
    return out;
  }

  it('un porteur a la 2e vague du palier 0, en dernier : POINT, count 1, a PORTEUR_SPAWN_DISTANCE de son joueur', () => {
    expect(PORTEUR_WAVE_IN_PALIER).toBe(2);
    const g = groupes(5, 2, true);
    expect(g[0]?.some(estPorteur)).toBe(false);
    const groupe = g[1] ?? [];
    const p = groupe[groupe.length - 1];
    if (!p || !estPorteur(p)) {
      throw new Error('le porteur doit etre le DERNIER ordre de la 2e vague');
    }
    expect(groupe.filter(estPorteur)).toHaveLength(1);
    expect(p.formation).toBe(FORMATION.POINT);
    expect(p.count).toBe(1);
    expect(p.spawnTick).toBe(groupe[0]?.spawnTick);
    expect(p.seed).toBe(((groupe[0]?.seed ?? 0) ^ 0x5f3a_c0f1) >>> 0);
    // L'ancre arrondie au pixel : a moins d'un pixel de 1 500.
    expect(Math.abs(Math.hypot(p.anchorX - 3000, p.anchorY - 3000) - PORTEUR_SPAWN_DISTANCE)).toBeLessThan(1);
  });

  it('un par palier, jamais deux a moins de PORTEUR_MIN_GAP_WAVES vagues : aux vagues 2, 52 et 102', () => {
    // Le boss tombe a chaque apparition : un palier toutes les cinq vagues. Sa
    // 2e vague est la 5p + 2 ; le plancher de 50 ecarte toutes celles d'avant 52.
    expect(PORTEUR_MIN_GAP_WAVES).toBe(50);
    const g = groupes(5, 120, true);
    const numeros = g.flatMap((gr, i) => (gr.some(estPorteur) ? [i + 1] : []));
    expect(numeros).toEqual([2, 52, 102]);
  });

  it('pas de second porteur tant que porteurGone n est pas venu', () => {
    const g = groupes(5, 120, false);
    expect(g.flatMap((gr, i) => (gr.some(estPorteur) ? [i + 1] : []))).toEqual([2]);
  });

  /**
   * ⚠️ **Aucun tirage de plus** (§2.2 de la spec) : l'empreinte des ordres
   * ORDINAIRES — tick, graine, archetype, formation, ancre, effectif, tout sauf
   * `waveId` — a ete RELEVEE sur main avant l'etape, avec exactement ce decor.
   * Un porteur qui consommerait un seul `rng()` la ferait mentir.
   */
  it('les ordres ordinaires sont bit-identiques a ceux d avant l etape', () => {
    const d = new WaveDirector(5);
    const rows: number[][] = [];
    let porteurs = 0;
    for (let tick = 0; tick < TICK_HZ * 600; tick++) {
      const g = d.dueWave(tick, [3000, 2000], [3000, 4000], 1 + Math.floor(rows.length / 3));
      if (g.length > 0 && d.bossWaveId === g[0]?.waveId) {
        d.bossDefeated();
      }
      if (g.some(estPorteur)) {
        porteurs++;
        d.porteurGone();
      }
      for (const o of g.filter((x) => !estPorteur(x))) {
        rows.push([o.spawnTick, o.seed, o.archetype, o.formation, o.anchorX, o.anchorY, o.count]);
      }
    }
    // Non-vacuite : des porteurs sont bien sortis pendant la mesure.
    expect(porteurs).toBeGreaterThanOrEqual(2);
    expect(rows).toHaveLength(159);
    expect(fnv1a(JSON.stringify(rows))).toBe(761_168_326);
  });

  it('pres d un coin, l ancre peut sortir de la carte, mais le porteur nait dedans', () => {
    let dehors = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const p = groupes(seed, 2, true, [50], [50])[1]?.find(estPorteur);
      if (!p) {
        throw new Error(`graine ${seed} : pas de porteur a la 2e vague`);
      }
      // L'ancre voyage en int16 (`shared/protocol.ts`).
      expect(p.anchorX).toBeGreaterThanOrEqual(-32_768);
      expect(p.anchorX).toBeLessThanOrEqual(32_767);
      if (p.anchorX < 0 || p.anchorY < 0) {
        dehors++;
      }
      const h = new Horde(4);
      h.spawn(p);
      expect(h.count).toBe(1);
      expect(h.x[0]).toBeGreaterThanOrEqual(0);
      expect(h.x[0]).toBeLessThanOrEqual(MAP_SIZE);
      expect(h.y[0]).toBeGreaterThanOrEqual(0);
      expect(h.y[0]).toBeLessThanOrEqual(MAP_SIZE);
    }
    // Non-vacuite : le cas « hors carte » s'est bien presente.
    expect(dehors).toBeGreaterThan(0);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run src/wave-director.test.ts -t "etape 11"`
Attendu : ÉCHEC — `PORTEUR_WAVE_IN_PALIER` non exporté, aucun porteur. (Dans le test
d'empreinte, les deux lignes `rows`/`fnv1a` passeraient déjà — c'est voulu, elles gardent ce qui
ne doit pas bouger ; seule la ligne de non-vacuité `porteurs >= 2` y rougit.)

- [ ] **Étape 3 : implémenter**

Dans `back/src/wave-director.ts`, ajouter `PORTEUR_ARCHETYPE` à l'import de `@shared/archetypes`.

Après `BOSS_WAVE_COUNT` (l.341) :

```ts
/**
 * Le porteur de coffre (etape 11, §2 de la spec) : demande a la 2e vague
 * (groupe) de chaque palier...
 */
export const PORTEUR_WAVE_IN_PALIER = 2;

/**
 * ...mais jamais a moins de 50 vagues (50 x 6 s = 5 min) du precedent.
 *
 * ⚠️ **« Un par palier » ne voulait pas dire « toutes les cinq minutes ».**
 * Un boss sort toutes les `WAVES_PER_PALIER` vagues qu'un autre vive ou non,
 * et CHAQUE boss abattu fait monter le palier : une equipe qui les tue a
 * mesure change de palier toutes les 30 a 90 s. Un palier qui passe sa 2e
 * vague sans porteur (plancher pas atteint, porteur precedent vivant) n'en
 * aura pas : rien ne se rattrape.
 */
export const PORTEUR_MIN_GAP_WAVES = 50;

/**
 * Distance entre le joueur cible par la vague et l'ancre du porteur. La
 * formation `POINT` le pose a 40 px pres ; pres d'un bord, `formationPositions`
 * le ramene dans la carte, donc PLUS PRES — c'est le « ~ » du design.
 */
export const PORTEUR_SPAWN_DISTANCE = 1500;
```

Après `#bossWaveId` (l.366) :

```ts
  /** Vagues (groupes) emises depuis le debut du palier ; remis a zero par `bossDefeated`. */
  #wavesSincePalier = 0;
  /** `#waveNumber` du dernier porteur demande. */
  #lastPorteurWave = Number.NEGATIVE_INFINITY;
  /**
   * Vrai entre la demande d'un porteur et `porteurGone` : un porteur en vie
   * bloque le suivant (§6 de la spec, pas deux a la fois).
   */
  #porteurEnJeu = false;
```

Dans `bossDefeated`, après `this.#palier++;` :

```ts
    this.#wavesSincePalier = 0;
```

Après `bossMissing` (l.416-419) :

```ts
  /**
   * Le porteur demande n'est plus en jeu : il est mort, ou son ordre n'a rien
   * fait naitre (horde pleine), ou il a ete retire hors du lot de morts.
   *
   * ⚠️ **La SEULE sortie de `#porteurEnJeu`**, sur le modele de `bossMissing` :
   * une methode pour tous les cas, le directeur n'a pas a savoir lequel. Sans
   * elle, plus aucun porteur pour le reste de la run.
   */
  porteurGone(): void {
    this.#porteurEnJeu = false;
  }

  /**
   * Ajoute l'ordre du porteur EN DERNIER a `groupe` s'il est du — boss
   * compris. ⚠️ **Aucun tirage dans `#rng`** : sa graine et sa direction se
   * DERIVENT de la graine du premier ordre, deja tiree. Les ordres ordinaires
   * restent bit-identiques ; seuls les `waveId` qui suivent se decalent.
   * L'ancre voyage en int16 : le client ne derive pas l'angle, il la lit.
   */
  #avecPorteur(groupe: WaveOrder[], tick: number, anchorX: number, anchorY: number): WaveOrder[] {
    const principal = groupe[0];
    if (
      !principal ||
      this.#wavesSincePalier !== PORTEUR_WAVE_IN_PALIER ||
      this.#waveNumber - this.#lastPorteurWave < PORTEUR_MIN_GAP_WAVES ||
      this.#porteurEnJeu
    ) {
      return groupe;
    }
    const seed = (principal.seed ^ 0x5f3a_c0f1) >>> 0;
    const angle = (seed / 0x1_0000_0000) * Math.PI * 2;
    this.#lastPorteurWave = this.#waveNumber;
    this.#porteurEnJeu = true;
    groupe.push({
      waveId: this.#nextWaveId++,
      spawnTick: tick,
      seed,
      archetype: PORTEUR_ARCHETYPE,
      formation: FORMATION.POINT,
      anchorX: Math.round(anchorX + Math.cos(angle) * PORTEUR_SPAWN_DISTANCE),
      anchorY: Math.round(anchorY + Math.sin(angle) * PORTEUR_SPAWN_DISTANCE),
      count: 1,
    });
    return groupe;
  }
```

Dans `dueWave`, après `this.#waveNumber++;` (l.474) :

```ts
    this.#wavesSincePalier++;
```

`return [boss];` (l.500) devient :

```ts
      return this.#avecPorteur([boss], tick, anchorX, anchorY);
```

et le `return out;` final (l.536) devient :

```ts
    return this.#avecPorteur(out, tick, anchorX, anchorY);
```

Le salon fait déjà naître chaque ordre d'un groupe dans l'ordre (`room.ts` l.1412-1469), les
clients aussi : rien à changer de ce côté (la tâche 5 y ajoute la reconnaissance du porteur).

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run src/wave-director.test.ts`
Attendu : PASS (les tests existants compris : `due` rend `[0]`, jamais le porteur).

- [ ] **Étape 5 : commit**

```bash
npx biome check --write back/src/wave-director.ts back/src/wave-director.test.ts
git add back/src/wave-director.ts back/src/wave-director.test.ts
git commit -m "feat(back): le directeur demande un porteur par palier, sans tirage de plus"
```

---

### Tâche 5 : le salon — la mort du porteur doit un coffre, servi avant le niveau

**Fichiers :**
- Modifier : `back/src/room.ts` (import `@shared/archetypes` l.13-25 ; après l.66 ;
  `#pendingLevels` l.472 ; `#bosses` l.554 ; `debugSetLevel` l.1093-1096 ; ouverture l.1299-1302 ;
  boucle des ordres l.1464-1466 ; lot de morts l.1673-1685 ; garde l.1689-1691 ; `#openDraft`
  l.2310-2320)
- Tester : `back/src/room.test.ts` (imports l.2-9 et l.79 ; nouveau `describe` en fin de fichier)

**Interfaces :**
- Consomme : `PORTEUR_ARCHETYPE`, `PORTEUR_HP` (tâche 1) ; `CHEST_RARITY_FLOOR`, `drawSpread(…,
  floor)` (tâche 2) ; `WaveDirector.porteurGone()` (tâche 4).
- Produit : `Room.debugOweLevels(n: number): void` (écriture de test : `n` niveaux montés et dus,
  comme si l'XP venait de franchir `n` seuils) ; un étalage de coffre est un
  `LevelUpEvent` (niveau inchangé) suivi d'un `DraftOpenEvent` dont toutes les cartes ont
  `rarity >= RARITY.RARE` ; quand coffre et niveau sont dus au même tick, **le coffre d'abord**.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `back/src/room.test.ts` : ajouter `PORTEUR_ARCHETYPE` et `PORTEUR_HP` à l'import de
`@shared/archetypes` (l.2-9), et `import { WaveDirector } from './wave-director';` après l'import
de `./room` (l.79). `entityIdOf`, `palierHp`, `RARITY`, `MAX_ENTITIES`, `FORMATION`, `vi` sont déjà
importés. Puis en fin de fichier :

```ts
describe('etape 11 : le porteur de coffre dans le salon', () => {
  /**
   * Retire tout sauf `garder`, HORS du lot de morts : ni XP, ni or, ni joueur
   * submerge. Le decor mesure le coffre, pas la survie d'un joueur passif.
   */
  function viderSauf(room: Room, garder: number | null): void {
    const ids: number[] = [];
    for (let i = 0; i < room.horde.count; i++) {
      const id = room.horde.entityIdAt(i);
      if (id !== garder) {
        ids.push(id);
      }
    }
    if (ids.length > 0) {
      room.horde.kill(ids);
    }
  }

  /** Avance jusqu'a l'ordre du porteur (2e vague, tick 360) ; rend son identite. */
  function jusquAuPorteur(room: Room): number {
    for (let t = 0; t < 30 * TICK_HZ; t++) {
      room.step(DT);
      const ordre = room.drainWaveOrders().find((o) => o.archetype === PORTEUR_ARCHETYPE);
      if (ordre) {
        const id = entityIdOf(ordre.waveId, 0);
        viderSauf(room, id);
        return id;
      }
      viderSauf(room, null);
    }
    throw new Error('aucun porteur en 30 s');
  }

  /** Le pose a 60 px du joueur 1, presque mort, et le fait abattre par la visee. */
  function abattrePorteur(room: Room, id: number): void {
    const slot = room.horde.slotOf(id);
    const pos = positionOf(room, 1);
    room.horde.x[slot] = pos.x + 60;
    room.horde.y[slot] = pos.y;
    room.horde.hp[slot] = 0.001;
    for (let t = 0; t < 4 * TICK_HZ; t++) {
      const s = room.horde.slotOf(id);
      if (s >= 0) {
        const p = positionOf(room, 1);
        const dx = (room.horde.x[s] ?? 0) - p.x;
        const dy = (room.horde.y[s] ?? 0) - p.y;
        const n = Math.hypot(dx, dy) || 1;
        room.applyInput(1, room.tick + 1, 0, 0, (dx / n) * 127, (dy / n) * 127);
      }
      room.step(DT);
      const morts = room.drainDeaths();
      viderSauf(room, id);
      if (morts.some((m) => m.ids.includes(id))) {
        return;
      }
    }
    throw new Error('le porteur n est pas tombe en 4 s');
  }

  it('nait a la 2e vague avec PORTEUR_HP a l echelle du palier : 200 au palier 0', () => {
    const room = new Room(0x11_0b_0001);
    room.join(1);
    const id = jusquAuPorteur(room);
    const slot = room.horde.slotOf(id);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(room.horde.archetype[slot]).toBe(PORTEUR_ARCHETYPE);
    expect(room.palier).toBe(0);
    expect(room.horde.hp[slot]).toBe(palierHp(PORTEUR_HP, room.palier));
    expect(room.horde.hp[slot]).toBe(200);
  });

  it('sa mort ouvre au tick suivant un etalage gele dont TOUTES les cartes sont au moins rares', () => {
    const room = new Room(0x11_0b_0002);
    room.join(1);
    const id = jusquAuPorteur(room);
    abattrePorteur(room, id);
    room.drainLevelUps();
    room.step(DT);
    const ups = room.drainLevelUps();
    const opens = room.drainDraftOpens();
    expect(ups).toHaveLength(1);
    // Un coffre n'est pas un niveau : le niveau annonce ne monte pas.
    expect(ups[0]?.level).toBe(1);
    expect(opens).toHaveLength(1);
    const cartes = opens[0]?.cards ?? [];
    expect(cartes.length).toBeGreaterThanOrEqual(2);
    for (const c of cartes) {
      expect(c.rarity ?? RARITY.COMMUNE).toBeGreaterThanOrEqual(RARITY.RARE);
    }
  });

  it('coffre et niveau dus au MEME tick : le coffre d abord, le niveau ensuite, dans la meme file', () => {
    const room = new Room(0x11_0b_0003);
    room.join(1);
    const id = jusquAuPorteur(room);
    abattrePorteur(room, id);
    // Le tick ou le porteur est tombe vient de finir : un niveau devient du
    // AVANT que rien ne s'ouvre — exactement « les deux dus au meme tick ».
    room.debugOweLevels(1);
    room.step(DT);
    const premier = room.drainDraftOpens();
    expect(premier).toHaveLength(1);
    for (const c of premier[0]?.cards ?? []) {
      expect(c.rarity ?? RARITY.COMMUNE).toBeGreaterThanOrEqual(RARITY.RARE);
    }
    expect(room.setDraftToken(1, 0)).toBe(true);
    room.step(DT);
    expect(room.drainDraftResults()).toHaveLength(1);
    room.step(DT);
    // Le niveau attendait : il s'ouvre au tick suivant, sans plancher.
    expect(room.drainDraftOpens()).toHaveLength(1);
    expect(room.drainLevelUps()).toHaveLength(2);
  });

  it('horde pleine a l ordre du porteur : porteurGone, aucune entite, aucun coffre', () => {
    const relache = vi.spyOn(WaveDirector.prototype, 'porteurGone');
    try {
      const room = new Room(0x11_0b_0004);
      room.join(1);
      // Juste apres la 1re vague (tick 180), avant la 2e (tick 360).
      while (room.tick < 200) {
        room.step(DT);
        viderSauf(room, null);
      }
      room.horde.spawn({
        waveId: 999,
        spawnTick: room.tick,
        seed: 0x51ee_d001,
        archetype: 0,
        formation: FORMATION.SCATTER,
        anchorX: 0,
        anchorY: 0,
        count: MAX_ENTITIES,
      });
      expect(room.horde.count).toBe(MAX_ENTITIES);
      let ordre = false;
      while (room.tick <= 360) {
        room.step(DT);
        ordre ||= room.drainWaveOrders().some((o) => o.archetype === PORTEUR_ARCHETYPE);
      }
      // L'ordre part quand meme (les clients, pleins aussi, ne feront rien naitre).
      expect(ordre).toBe(true);
      expect(relache).toHaveBeenCalledTimes(1);
      for (let i = 0; i < room.horde.count; i++) {
        expect(room.horde.archetype[i]).not.toBe(PORTEUR_ARCHETYPE);
      }
      viderSauf(room, null);
      room.step(DT);
      expect(room.drainDraftOpens()).toEqual([]);
    } finally {
      relache.mockRestore();
    }
  });

  it('retire hors du lot de morts (bancs) : pas de coffre, mais le directeur est relache', () => {
    const relache = vi.spyOn(WaveDirector.prototype, 'porteurGone');
    try {
      const room = new Room(0x11_0b_0005);
      room.join(1);
      const id = jusquAuPorteur(room);
      room.horde.kill([id]);
      room.step(DT);
      expect(relache).toHaveBeenCalledTimes(1);
      room.step(DT);
      expect(room.drainDraftOpens()).toEqual([]);
    } finally {
      relache.mockRestore();
    }
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run src/room.test.ts -t "etape 11"`
Attendu : ÉCHEC — `debugOweLevels` n'existe pas ; aucun étalage à la mort du porteur ;
`porteurGone` jamais appelé.

- [ ] **Étape 3 : implémenter**

Dans `back/src/room.ts` :

1. Ajouter `PORTEUR_ARCHETYPE` à l'import de `@shared/archetypes` (l.13-25), et après
   l'import de `@shared/random` (l.66) :

```ts
import { CHEST_RARITY_FLOOR, RARITY } from '@shared/rarity';
```

2. Après `#pendingLevels = 0;` (l.472) :

```ts
  /**
   * Les coffres dus (etape 11, §4.1) : un par porteur abattu. Un coffre est un
   * etalage d'equipe comme un niveau — meme gel, memes jetons, memes conflits —
   * au plancher `CHEST_RARITY_FLOOR`. `#openDraft` en consomme un AVANT tout
   * niveau : c'est ce qui laisse le client le reconnaitre sans octet (§4.3).
   */
  #chestsOwed = 0;
```

3. Après `#bosses: number[] = [];` (l.554) :

```ts
  /**
   * Le porteur de coffre vivant (etape 11), par IDENTITE comme `#bosses` —
   * `null` s'il n'y en a pas. Le directeur n'en demande pas d'autre tant que
   * `porteurGone` n'est pas venu.
   */
  #porteur: number | null = null;
```

4. Après `debugSetLevel` (l.1093-1096) :

```ts
  /**
   * Ecriture de test, meme statut que `debugSetGold` : `n` niveaux montes et
   * dus, comme si l'XP venait de franchir `n` seuils. Sert a provoquer « un
   * coffre et un niveau dus au meme tick » (etape 11), que le jeu ne produit
   * qu'au hasard d'une orbe.
   */
  debugOweLevels(n: number): void {
    this.#level += n;
    this.#pendingLevels += n;
  }
```

5. L'ouverture (l.1299-1302) devient :

```ts
    // Un coffre ou un niveau attend, et aucun etalage n'est ouvert : on ouvre.
    if (this.#draft.phase === 'closed' && (this.#chestsOwed > 0 || this.#pendingLevels > 0)) {
      this.#openDraft();
    }
```

6. Dans la boucle des ordres, la branche `else { this.#scalePalierHp(before); }` (l.1464-1466)
   devient :

```ts
      } else {
        this.#scalePalierHp(before);
        // Etape 11 : le porteur passe par le chemin ordinaire des PV
        // (`palierHp`), puis le salon retient son identite. Horde pleine : il
        // n'existe pas, et le directeur doit le savoir (meme parade que
        // `bossMissing`).
        if (order.archetype === PORTEUR_ARCHETYPE) {
          if (this.horde.count > before) {
            this.#porteur = entityIdOf(order.waveId, 0);
          } else {
            this.#director.porteurGone();
          }
        }
      }
```

7. Dans le lot de morts, après la boucle des boss (l.1673-1684, avant l'accolade qui ferme
   `if (allDead.length > 0)`) :

```ts
      // Etape 11 : le porteur tombe dans CE lot, le seul du tick (meme regle
      // que le boss). Il doit un coffre ; `step` l'ouvrira au tick suivant.
      if (this.#porteur !== null && allDead.includes(this.#porteur)) {
        this.#porteur = null;
        this.#chestsOwed++;
        this.#director.porteurGone();
      }
```

8. Après le garde des boss (l.1689-1691) :

```ts
    // Meme garde pour le porteur : retire hors du lot (bancs, tests), il ne
    // doit AUCUN coffre — mais le directeur doit etre relache, sinon plus
    // aucun porteur pour le reste de la run.
    if (this.#porteur !== null && this.horde.slotOf(this.#porteur) < 0) {
      this.#porteur = null;
      this.#director.porteurGone();
    }
```

9. `#openDraft` (l.2310-2320) devient (compléter le docbloc) :

```ts
   *
   * ⚠️ **Un coffre du passe AVANT un niveau** (etape 11, §4.1). Pendant un
   * etalage le monde est gele, donc un porteur ne meurt jamais pendant qu'un
   * etalage est ouvert ; le seul cas de file est « coffre et niveau dus au
   * meme tick ». Coffre d'abord : le client sait alors, sans octet, que le
   * premier `LEVEL_UP` apres la mort du porteur est le coffre.
   */
  #openDraft(): void {
    const coffre = this.#chestsOwed > 0;
    if (coffre) {
      this.#chestsOwed--;
    } else {
      this.#pendingLevels--;
    }
    const loadouts = new Map<number, Loadout>();
    for (const [id, p] of this.#players) {
      loadouts.set(id, p.loadout);
    }
    const spread = drawSpread(
      loadouts,
      this.#draftRng,
      coffre ? CHEST_RARITY_FLOOR : RARITY.COMMUNE,
    );
    this.#draft.open(this.#tick, spread, [...this.#players.keys()], loadouts);
    // Le niveau ne monte pas pour un coffre : `#level` est celui d'avant, et
    // `cuesBetween` ne joue le son de niveau que s'il augmente.
    this.#pendingLevelUps.push({ tick: this.#tick, level: this.#level });
    this.#pendingDraftOpens.push({ deadlineTick: this.#draft.deadlineTick, cards: spread });
  }
```

Les morts sont diffusées avant les `LEVEL_UP` du même envoi (`back/src/server.ts` l.579 puis
l.624) : rien à changer côté serveur réseau.

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run src/room.test.ts src/comportements.test.ts src/draft.test.ts src/wave-director.test.ts`
Attendu : PASS.

> Le porteur sort désormais à la 2ᵉ vague de toute partie. Un test de `room.test.ts` qui compte
> les ordres, les entités ou les PV d'une vague **précise** peut voir passer l'ordre du porteur.
> S'il rougit, l'implémenteur cherche pourquoi : si l'assertion supposait « tous les ordres sont
> ordinaires », il exclut nommément `PORTEUR_ARCHETYPE` (comme la tâche 4 l'a fait pour le cycle),
> jamais en changeant la graine, et le dit dans son rapport.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write back/src/room.ts back/src/room.test.ts
git add back/src/room.ts back/src/room.test.ts
git commit -m "feat(back): la mort du porteur doit un coffre, ouvert avant le niveau au plancher rare"
```

---

### Tâche 6 : le client reconnaît le coffre, sans un octet

> ⚠️ **Fusion à anticiper** : `front/src/net/client.ts` est modifié sur `main` en ce moment (import
> de `Projectiles` l.40, `ChainFlashes`, `#fireOne` vers l.3050). Les zones de cette tâche (imports
> l.7 et l.36, champs l.~1349, getters l.~1882, gestionnaires l.2207-2291) n'en recouvrent aucune.

**Fichiers :**
- Modifier : `front/src/net/client.ts` (import l.7 et l.36 ; après `BLAST_FLASH_MS` l.237 ;
  après `#pingCount = 0;` l.1349 ; après `get pingCount()` l.1882-1884 ; `WAVE_ORDER`
  l.2207-2220 ; `DEATHS` l.2221-2227 ; `LEVEL_UP` l.2274-2291)
- Tester : `front/src/net/client.test.ts` (imports l.1, l.27, l.71-82 ; nouveau `describe` en fin
  de fichier)

**Interfaces :**
- Consomme : `PORTEUR_ARCHETYPE` (tâche 1).
- Produit : `export const PORTEUR_BANNER_MS = 4000` ; getters de `GameClient` :
  `draftIsChest: boolean`, `porteur: { x: number; y: number } | null`, `porteurCount: number`
  (annonces reçues), `porteurBannerOn: boolean` (vrai pendant `PORTEUR_BANNER_MS` après la
  dernière annonce, horloge `performance.now()`).

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `front/src/net/client.test.ts` : l'import l.1 devient
`import { archetypeIdOf, NECRO_CHILD, PORTEUR_ARCHETYPE, SPLIT_CHILD } from '@shared/archetypes';`
et ajouter `PORTEUR_BANNER_MS` à l'import de `./client` (l.71-82). `entityIdOf`, `encodeDeaths`,
`encodeLevelUp`, `encodeWaveOrder`, `encodeWelcome`, `encodeSnapshot`, `FORMATION`, `WaveOrder`,
`ORB_PICKUP_RADIUS`, `STEP` (l.465) et `latestSocket` sont déjà là. Puis en fin de fichier :

```ts
describe('etape 11 : le client reconnait un coffre sans un octet de plus', () => {
  const ORDRE: WaveOrder = {
    waveId: 4242,
    spawnTick: 0,
    seed: 7,
    archetype: PORTEUR_ARCHETYPE,
    formation: FORMATION.POINT,
    anchorX: 4500,
    anchorY: 3000,
    count: 1,
  };
  const PORTEUR_ID = entityIdOf(4242, 0);

  function setup(): { client: GameClient; socket: FakeSocket } {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0x11_c0ff) });
    return { client, socket };
  }

  it('l ordre du porteur, puis sa mort, puis LEVEL_UP : ce LEVEL_UP est un coffre', () => {
    const { client, socket } = setup();
    socket.emit('message', { data: encodeWaveOrder(ORDRE) });
    socket.emit('message', { data: encodeDeaths(30, [PORTEUR_ID]) });
    socket.emit('message', { data: encodeLevelUp(31, 1) });
    expect(client.draftIsChest).toBe(true);
    // Le niveau affiche n'a pas bouge : un coffre n'est pas un niveau.
    expect(client.level).toBe(1);
  });

  it('un LEVEL_UP seul n est pas un coffre', () => {
    const { client, socket } = setup();
    socket.emit('message', { data: encodeLevelUp(31, 2) });
    expect(client.draftIsChest).toBe(false);
    expect(client.level).toBe(2);
  });

  it('un coffre du se consomme une fois : le LEVEL_UP suivant est un niveau', () => {
    const { client, socket } = setup();
    socket.emit('message', { data: encodeWaveOrder(ORDRE) });
    socket.emit('message', { data: encodeDeaths(30, [PORTEUR_ID]) });
    const second: WaveOrder = { ...ORDRE, waveId: 5000 };
    socket.emit('message', { data: encodeWaveOrder(second) });
    socket.emit('message', { data: encodeDeaths(40, [entityIdOf(5000, 0)]) });
    const drapeaux: boolean[] = [];
    for (const tick of [41, 42, 43]) {
      socket.emit('message', { data: encodeLevelUp(tick, 2) });
      drapeaux.push(client.draftIsChest);
    }
    expect(drapeaux).toEqual([true, true, false]);
  });

  it('une mort d identite inconnue, ou un porteur jamais annonce, ne fait pas de coffre', () => {
    const { client, socket } = setup();
    // Un client arrive apres l'ordre : il voit la mort, pas la naissance.
    socket.emit('message', { data: encodeDeaths(30, [PORTEUR_ID]) });
    socket.emit('message', { data: encodeLevelUp(31, 2) });
    expect(client.draftIsChest).toBe(false);
    // Et une mort ORDINAIRE apres l'annonce ne consomme pas le porteur.
    socket.emit('message', { data: encodeWaveOrder(ORDRE) });
    socket.emit('message', { data: encodeDeaths(32, [entityIdOf(77, 0)]) });
    socket.emit('message', { data: encodeLevelUp(33, 3) });
    expect(client.draftIsChest).toBe(false);
  });

  it('annonce : un compteur, et un bandeau de PORTEUR_BANNER_MS', () => {
    const horloge = vi.spyOn(performance, 'now').mockReturnValue(10_000);
    try {
      const { client, socket } = setup();
      expect(client.porteurCount).toBe(0);
      expect(client.porteurBannerOn).toBe(false);
      socket.emit('message', { data: encodeWaveOrder(ORDRE) });
      expect(client.porteurCount).toBe(1);
      expect(client.porteurBannerOn).toBe(true);
      horloge.mockReturnValue(10_000 + PORTEUR_BANNER_MS - 1);
      expect(client.porteurBannerOn).toBe(true);
      horloge.mockReturnValue(10_000 + PORTEUR_BANNER_MS);
      expect(client.porteurBannerOn).toBe(false);
    } finally {
      horloge.mockRestore();
    }
  });

  it('porteur : sa position tant qu il est dans la horde du client, null des sa mort recue', () => {
    const { client, socket } = setup();
    expect(client.porteur).toBeNull();
    socket.emit('message', { data: encodeWaveOrder(ORDRE) });
    // Un tick fait naitre l'ordre (les ordres s'appliquent en tete d'`#advanceHorde`).
    socket.emit('message', {
      data: encodeSnapshot(0, 0, 0, [
        { id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS },
      ]),
    });
    client.update(0, STEP);
    const slot = client.horde.slotOf(PORTEUR_ID);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(client.porteur).toEqual({ x: client.horde.x[slot], y: client.horde.y[slot] });
    socket.emit('message', { data: encodeDeaths(1, [PORTEUR_ID]) });
    expect(client.porteur).toBeNull();
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/net/client.test.ts -t "etape 11"`
Attendu : ÉCHEC — `PORTEUR_BANNER_MS` non exporté, `draftIsChest` indéfini.

- [ ] **Étape 3 : implémenter**

Dans `front/src/net/client.ts` :

1. Imports : l.7 devient
   `import { archetypeIdOf, archetypeOf, NECRO_CHILD, PORTEUR_ARCHETYPE } from '@shared/archetypes';`
   et l.36 `import { entityIdOf, Horde, leavesDrop, pushOutOfGuards } from '@shared/horde';`.

2. Après `BLAST_FLASH_MS` (l.237) :

```ts
/**
 * Duree du bandeau « Un porteur de coffre est apparu ! » (etape 11, §5.4), en
 * horloge murale depuis la RECEPTION de son ordre — quelques ticks avant sa
 * naissance, au meme moment chez chacun.
 */
export const PORTEUR_BANNER_MS = 4000;
```

3. Après `#pingCount = 0;` (l.1349) :

```ts
  /**
   * Le porteur de coffre annonce et pas encore mort (etape 11), par identite.
   * Reconnu a son `archetype` dans `WAVE_ORDER`, oublie a sa mort dans `DEATHS`.
   */
  #porteurId: number | null = null;
  /** Ordres de porteur recus depuis la connexion : l'audio en deduit quand sonner. */
  #porteurCount = 0;
  /** Horloge murale de la derniere annonce, pour le bandeau. */
  #porteurAnnouncedMs = Number.NEGATIVE_INFINITY;
  /**
   * Coffres dus : un par porteur dont `DEATHS` a annonce la mort, consommes un
   * par un au `LEVEL_UP` suivant. Le serveur ouvre un coffre du AVANT tout
   * niveau et diffuse les morts AVANT les `LEVEL_UP` (§4.3 de la spec).
   */
  #chestsOwed = 0;
  #draftIsChest = false;
```

4. Après `get pingCount()` (l.1882-1884) :

```ts
  /** L'etalage courant est-il un coffre (etape 11) ? Fige au `LEVEL_UP` qui l'annonce. */
  get draftIsChest(): boolean {
    return this.#draftIsChest;
  }

  /** Ordres de porteur recus depuis la connexion (etape 11) : l'audio en deduit quand sonner. */
  get porteurCount(): number {
    return this.#porteurCount;
  }

  /** Le bandeau du porteur est-il allume (`PORTEUR_BANNER_MS` apres l'annonce) ? */
  get porteurBannerOn(): boolean {
    return performance.now() - this.#porteurAnnouncedMs < PORTEUR_BANNER_MS;
  }

  /**
   * Position du porteur dans la horde DU CLIENT, `null` s'il n'est pas, ou
   * plus, dans la horde. Un `slotOf` par appel : le meme balayage que la barre
   * du boss, une fois par image.
   */
  get porteur(): { x: number; y: number } | null {
    if (this.#porteurId === null) {
      return null;
    }
    const slot = this.horde.slotOf(this.#porteurId);
    if (slot < 0) {
      return null;
    }
    return { x: this.horde.x[slot] ?? 0, y: this.horde.y[slot] ?? 0 };
  }
```

5. Dans le gestionnaire `WAVE_ORDER` (l.2207-2220), avant le `return;` :

```ts
      // Etape 11 : le porteur se reconnait a son archetype, comme le releve du
      // necromancien juste au-dessus. Annonce a la RECEPTION.
      if (msg.archetype === PORTEUR_ARCHETYPE) {
        this.#porteurId = entityIdOf(msg.waveId, 0);
        this.#porteurCount++;
        this.#porteurAnnouncedMs = performance.now();
      }
```

6. Dans le gestionnaire `DEATHS` (l.2221-2227), avant le `return;` :

```ts
      // Etape 11 : lu A LA RECEPTION, sur les identites du message — sans
      // attendre que le rejeu l'applique. Le `LEVEL_UP` qui suit est le coffre.
      if (this.#porteurId !== null && msg.ids.includes(this.#porteurId)) {
        this.#chestsOwed++;
        this.#porteurId = null;
      }
```

7. Dans le gestionnaire `LEVEL_UP` (l.2274-2291), avant le `return;` :

```ts
      // Etape 11 : un coffre du est TOUJOURS le premier `LEVEL_UP` qui suit la
      // mort du porteur — le salon l'ouvre avant tout niveau.
      this.#draftIsChest = this.#chestsOwed > 0;
      if (this.#draftIsChest) {
        this.#chestsOwed--;
      }
```

- [ ] **Étape 4 : les relancer, ils passent ; typecheck**

Run : `cd front && npx vitest run src/net/client.test.ts`
Attendu : PASS.
Run : `npm run typecheck -w front`
Attendu : aucune erreur.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/net/client.ts front/src/net/client.test.ts
git add front/src/net/client.ts front/src/net/client.test.ts
git commit -m "feat(front): le client reconnait le coffre a la mort du porteur, sans octet"
```

---

### Tâche 7 : l'annonce — titre « Coffre », bandeaux, son

> ⚠️ **Fusion à anticiper** : `front/index.html`, `front/src/main.ts`, `front/src/ui/draft.ts` et
> `front/src/ui/draft.test.ts` sont modifiés sur `main` en ce moment (le Guide, l'étiquette de
> Moisson). Zones de cette tâche : `index.html` juste après `hud-freeze` (l.378-383 au commit de
> base) ; `main.ts` `hudElements` (l.~201) et `CueSnapshot` (l.~792-793) ; `draft.ts`
> `DraftSource` (l.53-67) et le titre (l.585-587) ; `draft.test.ts` `FakeClient` (l.36-46) et fin
> de fichier.

**Fichiers :**
- Modifier : `front/src/audio/audio.ts` (`Cue` l.17-31 ; `CueSnapshot` l.34-48 ; `cuesBetween`
  l.55-96 ; `MIN_GAP_S` l.105-120 ; `play`, après `'levelup'` l.254-258),
  `front/src/ui/hud.ts` (`HudSource` l.91-109 ; `HudElements` l.202-223 ; `paintHud` l.281),
  `front/src/ui/draft.ts` (`DraftSource` l.53-67 ; titre l.585-587), `front/index.html`
  (après `hud-freeze` l.378-383), `front/src/main.ts` (`hudElements` l.~201 ; `CueSnapshot`
  l.~781-794)
- Tester : `front/src/audio/audio.test.ts` (fixture `calme` l.5-17 ; nouveau test),
  `front/src/ui/hud.test.ts` (câblage l.50-66 ; `hudElements()` l.146-169 ; `FakeSource`
  l.~186-221 ; nouveaux tests dans `describe('paintHud ...')`), `front/src/ui/draft.test.ts`
  (`FakeClient` l.36-46 ; nouveau `describe`)

**Interfaces :**
- Consomme : `GameClient.draftIsChest`, `porteurCount`, `porteurBannerOn` (tâche 6).
- Produit : `Cue` gagne `'porteur'` ; `CueSnapshot.porteurs: number` ;
  `HudSource.draftIsChest?: boolean`, `HudSource.porteurBannerOn?: boolean` ;
  `HudElements.porteur?: HTMLElement` ; `DraftSource.draftIsChest?: boolean` ; élément
  `#hud-porteur` dans `index.html`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/audio/audio.test.ts` : la fixture `calme` gagne `porteurs: 0,` (après
`lastPingIntent: -1,`), puis dans `describe('cuesBetween ...')` :

```ts
  it('etape 11 : le porteur annonce sonne une fois, et le coffre ne joue pas le son de niveau', () => {
    expect(cuesBetween(calme, { ...calme, porteurs: 1 })).toEqual(['porteur']);
    expect(cuesBetween({ ...calme, porteurs: 1 }, { ...calme, porteurs: 1 })).toEqual([]);
    // Le LEVEL_UP d'un coffre ne monte pas le niveau : rien a jouer.
    expect(cuesBetween(calme, { ...calme, level: calme.level })).toEqual([]);
  });
```

`front/src/ui/hud.test.ts` :

- dans « trouve les deux elements que main.ts va chercher », ajouter
  `expect(document.getElementById('hud-porteur')).not.toBeNull();` ;
- `hudElements()` gagne `porteur: pick('hud-porteur'),` ;
- `FakeSource` gagne `draftIsChest = false;` et `porteurBannerOn = false;` ;
- dans `describe('paintHud — chaque case du HUD recoit son ecriture')` :

```ts
  it('etape 11 : le bandeau de gel dit « Coffre » pendant un coffre, « Niveau superieur » sinon', () => {
    source.draftIsChest = true;
    paintHud(el, { ...INFO, frozen: true }, 0, 0, source);
    expect(el.freeze.textContent).toBe('Coffre — pause…');
    source.draftIsChest = false;
    paintHud(el, { ...INFO, frozen: true }, 0, 0, source);
    expect(el.freeze.textContent).toBe('Niveau supérieur — pause…');
  });

  it('etape 11 : le bandeau du porteur suit porteurBannerOn', () => {
    source.porteurBannerOn = true;
    paintHud(el, INFO, 0, 0, source);
    expect(el.porteur?.classList.contains('hidden')).toBe(false);
    expect(el.porteur?.textContent?.trim()).toBe('Un porteur de coffre est apparu !');
    source.porteurBannerOn = false;
    paintHud(el, INFO, 0, 0, source);
    expect(el.porteur?.classList.contains('hidden')).toBe(true);
  });
```

`front/src/ui/draft.test.ts` : `FakeClient` gagne deux champs (après `isFrozen = false;`) :

```ts
  level?: number;
  draftIsChest?: boolean;
```

puis en fin de fichier :

```ts
describe('etape 11 : le titre d un coffre', () => {
  it('« Coffre » pour un etalage de coffre, « Niveau N » sinon', () => {
    const h = harness();
    // `DraftScreen` cherche `#draft-title` a sa construction : on le pose avant.
    const titre = document.createElement('span');
    titre.id = 'draft-title';
    h.root.prepend(titre);
    const ecran = new DraftScreen(h.root, h.status, h.list, h.client);
    h.client.draftCards = spread();
    h.client.level = 7;
    h.client.draftIsChest = false;
    ecran.update();
    expect(titre.textContent).toBe('Niveau 7');
    h.client.draftIsChest = true;
    ecran.update();
    expect(titre.textContent).toBe('Coffre');
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/audio/audio.test.ts src/ui/hud.test.ts src/ui/draft.test.ts`
Attendu : ÉCHEC — `porteurs` inconnu de `CueSnapshot`, `hud-porteur` absent, titre « Niveau 7 »
pour un coffre.

- [ ] **Étape 3 : implémenter**

`front/src/audio/audio.ts` :

- `Cue` gagne `| 'porteur'` (après `'ping-jePrends'`) ;
- `CueSnapshot` gagne, après `lastPingIntent` :

```ts
  /** Porteurs de coffre annonces depuis la connexion (etape 11). */
  porteurs: number;
```

- dans `cuesBetween`, avant `return out;` :

```ts
  if (cur.porteurs > prev.porteurs) {
    out.push('porteur');
  }
```

- `MIN_GAP_S` gagne `porteur: 1,` ;
- dans `play`, après le `case 'levelup'` :

```ts
      case 'porteur':
        // Un arpege ASCENDANT et brillant, plus haut et plus serre que
        // `levelup` : « quelque chose a chasser », pas « un palier franchi ».
        [0, 4, 7, 12, 16].forEach((s, k) => {
          tone('square', hz(19 + s), hz(19 + s), k * 0.06, 0.16, 0.06);
        });
        break;
```

`front/src/ui/hud.ts` :

- `HudSource` gagne, avant `loadoutOf` :

```ts
  /** L'etalage en cours est un coffre (etape 11) : le bandeau de gel le dit. Absent : non. */
  readonly draftIsChest?: boolean;
  /** Le bandeau « un porteur est apparu » est-il allume (etape 11) ? Absent : non. */
  readonly porteurBannerOn?: boolean;
```

- `HudElements` gagne, après `freeze: HTMLElement;` :

```ts
  /** Le bandeau du porteur de coffre (etape 11). Optionnel : les anciens HUD de test n'en ont pas. */
  porteur?: HTMLElement;
```

- dans `paintHud`, la dernière ligne `el.freeze.classList.toggle('hidden', !info.frozen);`
  devient :

```ts
  el.freeze.classList.toggle('hidden', !info.frozen);
  // Etape 11 : un coffre gele comme un niveau, mais il le dit.
  el.freeze.textContent = source.draftIsChest ? 'Coffre — pause…' : 'Niveau supérieur — pause…';
  el.porteur?.classList.toggle('hidden', source.porteurBannerOn !== true);
```

`front/src/ui/draft.ts` :

- `DraftSource` gagne, après `level?: number;` :

```ts
  /** L'etalage est un coffre (etape 11) : le ruban dit « Coffre ». Optionnel, comme `level`. */
  readonly draftIsChest?: boolean;
```

- le titre (l.585-587) devient :

```ts
    if (this.#title && source.draftIsChest) {
      this.#title.textContent = 'Coffre';
    } else if (this.#title && source.level !== undefined) {
      this.#title.textContent = `Niveau ${source.level}`;
    }
```

`front/index.html`, juste après la `div` `hud-freeze` (l.378-383 au commit de base) :

```html
            <div
              id="hud-porteur"
              class="k k-carved3 f-meta ol mt-[10px] hidden text-[24px]"
            >
              Un porteur de coffre est apparu !
            </div>
```

`front/src/main.ts` :

- `hudElements` gagne, après `freeze: hudFreeze,` : `porteur: el('hud-porteur'),` ;
- le `CueSnapshot` de `renderFrame` gagne, après `lastPingIntent: client.lastPingIntent,` :
  `porteurs: client.porteurCount,`.

(`GameClient` est passé tel quel comme `HudSource` et `DraftSource` : ses getters
`draftIsChest` et `porteurBannerOn` de la tâche 6 suffisent.)

- [ ] **Étape 4 : les relancer, ils passent ; typecheck**

Run : `cd front && npx vitest run src/audio/audio.test.ts src/ui/hud.test.ts src/ui/draft.test.ts`
Attendu : PASS.
Run : `npm run typecheck -w front`
Attendu : aucune erreur.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/audio/audio.ts front/src/audio/audio.test.ts front/src/ui/hud.ts front/src/ui/hud.test.ts front/src/ui/draft.ts front/src/ui/draft.test.ts front/index.html front/src/main.ts
git add front/src/audio/audio.ts front/src/audio/audio.test.ts front/src/ui/hud.ts front/src/ui/hud.test.ts front/src/ui/draft.ts front/src/ui/draft.test.ts front/index.html front/src/main.ts
git commit -m "feat(front): le coffre s annonce, titre, bandeaux et arpege du porteur"
```

---

### Tâche 8 : au sol — le voleur agrandi, l'anneau et le coffre

**Fichiers :**
- Modifier : `front/src/render/horde-renderer.ts` (import l.1 ; `adoptAtlas` l.590-596),
  `front/src/render/behavior-renderer.ts` (imports l.1-13 ; `BehaviorShape` l.22-31 ;
  `behaviorShapes` l.45-78 ; `draw` l.244-253)
- Tester : `front/src/render/horde-renderer.test.ts` (import l.1 ; nouveau `describe`),
  `front/src/render/behavior-renderer.test.ts` (nouveau `describe`)

**Interfaces :**
- Consomme : `PORTEUR_ARCHETYPE`, `PORTEUR_BODY_SCALE`, `archetypeIdOf` (tâche 1) ; `stopped`
  du porteur qui attend (tâche 3).
- Produit : `BehaviorShape.kind` gagne `'coffre'` ; `export const PORTEUR_RING_RADIUS = 46` ;
  `export function drawChest(g: Graphics, x: number, y: number, scale: number): void` (dans
  `behavior-renderer.ts`, réutilisée par la tâche 9).

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/render/horde-renderer.test.ts` : l'import l.1 devient
`import { ARCHETYPES, archetypeIdOf, BOSS_ARCHETYPE, BOSS_BODY_SCALE, PORTEUR_ARCHETYPE, PORTEUR_BODY_SCALE } from '@shared/archetypes';`,
puis en fin de fichier :

```ts
/**
 * Etape 11, §3.4 : l'atlas n'a PAS d'entree pour le porteur. Sans l'alias de
 * `adoptAtlas`, il serait simule et tuable mais jamais dessine, en silence —
 * le defaut que l'etape 6a a connu avec le boss. L'atlas synthetique ne range
 * ici QUE le voleur : tout ce que le porteur dessine vient de l'alias.
 */
describe('etape 11 : le porteur emprunte le voleur, en plus grand', () => {
  const VOLEUR = archetypeIdOf('thief');

  it('dessine le porteur avec les textures du voleur', () => {
    const horde = twoEnemies(PORTEUR_ARCHETYPE);
    expect(drawnParticles(horde, VOLEUR)).toHaveLength(2);
  });

  it('a l arret il attend sur la PREMIERE image de sa course, jamais sur l attaque du voleur', () => {
    const horde = twoEnemies(PORTEUR_ARCHETYPE);
    horde.stopped[0] = 1;
    horde.stopped[1] = 1;
    const particule = particleOf(drawnParticles(horde, VOLEUR), horde, 0);
    expect(particule.texture.frame.x).toBe(FIXTURE_RUN_X);
  });

  it('a 1,6 fois l echelle du voleur', () => {
    const porteurs = twoEnemies(PORTEUR_ARCHETYPE);
    const voleurs = twoEnemies(VOLEUR);
    const p = particleOf(drawnParticles(porteurs, VOLEUR), porteurs, 0);
    const v = particleOf(drawnParticles(voleurs, VOLEUR), voleurs, 0);
    expect(p.scaleY / v.scaleY).toBeCloseTo(PORTEUR_BODY_SCALE, 5);
  });
});
```

`front/src/render/behavior-renderer.test.ts` : ajouter `PORTEUR_RING_RADIUS` à l'import de
`./behavior-renderer`, puis en fin de fichier :

```ts
describe('etape 11 : l or du porteur', () => {
  const view = new Rectangle(0, 0, 800, 600);

  it('un anneau et un coffre par porteur dans le cadre, aucun hors du cadre', () => {
    const horde = hordeAt([
      { x: 100, y: 100, behavior: 'porteur' },
      { x: 9000, y: 9000, behavior: 'porteur' },
    ]);
    expect(behaviorShapes(horde, [], view, 0)).toEqual([
      { kind: 'coffre', x: 100, y: 100, radius: PORTEUR_RING_RADIUS, alpha: 1 },
    ]);
  });

  it('en permanence : a l arret comme en fuite', () => {
    const horde = hordeAt([{ x: 100, y: 100, behavior: 'porteur' }]);
    horde.fleeing[0] = 1;
    expect(behaviorShapes(horde, [], view, 0).map((s) => s.kind)).toEqual(['coffre']);
  });

  it('un voleur ordinaire n a pas de coffre, et son butin ne sort toujours qu en fuite', () => {
    const horde = hordeAt([{ x: 100, y: 100, behavior: 'voleur' }]);
    expect(behaviorShapes(horde, [], view, 0)).toEqual([]);
    horde.fleeing[0] = 1;
    expect(behaviorShapes(horde, [], view, 0).map((s) => s.kind)).toEqual(['butin']);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/render/horde-renderer.test.ts src/render/behavior-renderer.test.ts -t "etape 11"`
Attendu : ÉCHEC — aucune particule pour le porteur ; aucune forme `'coffre'`.

- [ ] **Étape 3 : implémenter**

`front/src/render/horde-renderer.ts` : l'import l.1 devient
`import { ARCHETYPES, archetypeIdOf, PORTEUR_ARCHETYPE } from '@shared/archetypes';`.
Dans `adoptAtlas`, entre la fin de la boucle sur le manifeste (l.590) et le commentaire des trous
de `sizesPx` (l.591) :

```ts
    // ⚠️ **Etape 11 : le porteur de coffre n'a PAS d'entree dans l'atlas** —
    // c'est un voleur agrandi (§3.4 de la spec), aucun actif nouveau. Sans cet
    // alias, `draw` le sauterait en silence faute de textures. Sa taille passe
    // par le mecanisme du boss : `bodyScale` (1,6) multiplie la taille de
    // contenu du voleur dans `archetypeScales`. Son clip d'« attaque » est la
    // PREMIERE image de la course, figee : `selectClip` le montre quand
    // `stopped` vaut 1, c'est-a-dire quand il attend — avec le vrai clip
    // d'attaque du voleur, il frapperait dans le vide.
    const voleur = archetypeIdOf('thief');
    this.#runFrames[PORTEUR_ARCHETYPE] = this.#runFrames[voleur] ?? [];
    this.#attackFrames[PORTEUR_ARCHETYPE] = this.#runFrames[voleur]?.slice(0, 1) ?? [];
    sizesPx[PORTEUR_ARCHETYPE] = sizesPx[voleur] ?? 0;
```

`front/src/render/behavior-renderer.ts` :

- imports : ajouter `import { COIN_TINT } from './orb-renderer';` après celui de
  `./player-renderer` ; le type `Graphics` est déjà importé de `pixi.js` (comme valeur).
- `BehaviorShape.kind` gagne `| 'coffre'` (après `'butin'`).
- après la déclaration de `BehaviorShape` :

```ts
/**
 * Le porteur de coffre (etape 11, §5.1) : un anneau dore sous ses pieds — ce
 * rayon —, et un coffre au-dessus. Le corps reste celui d'un voleur (le
 * `ParticleContainer` ne televerse pas la couleur) : l'or est AUTOUR.
 */
export const PORTEUR_RING_RADIUS = 46;
/** Hauteur du coffre au-dessus du porteur, en px monde. */
const CHEST_LIFT = 60;
/** Le brun du contour, du couvercle et de la serrure. */
const CHEST_BROWN = 0x5a3a1a;

/**
 * Un petit coffre procedural centre sur (x, y) : 22 x 15 px a l'echelle 1,
 * dore, contoure de brun, couvercle au tiers haut, serrure au centre. Aucun
 * fichier d'image. Partage avec la fleche de bord (`PingRenderer`).
 */
export function drawChest(g: Graphics, x: number, y: number, scale: number): void {
  const w = 22 * scale;
  const h = 15 * scale;
  const left = x - w / 2;
  const top = y - h / 2;
  g.rect(left, top, w, h).fill(COIN_TINT).stroke({ color: CHEST_BROWN, width: 2 });
  // `moveTo` d'abord : sans lui, Pixi relierait le couvercle a la forme precedente.
  g.moveTo(left, top + h / 3)
    .lineTo(left + w, top + h / 3)
    .stroke({ color: CHEST_BROWN, width: 2 });
  const k = 4 * scale;
  g.rect(x - k / 2, y - k / 2, k, k).fill(CHEST_BROWN);
}
```

- dans `behaviorShapes`, le filtre (l.48-56) gagne `behavior !== 'porteur' &&` (avant
  `!enFuite`), et la cascade (l.67-78) gagne, avant le `else` final du butin :

```ts
    } else if (behavior === 'porteur') {
      // En permanence, a l'arret comme en fuite : c'est ce qui le distingue
      // d'un voleur ordinaire d'un coup d'oeil, avec sa taille.
      out.push({ kind: 'coffre', x, y, radius: PORTEUR_RING_RADIUS, alpha: 1 });
```

- dans `draw`, avant `} else if (s.kind === 'butin') {` (l.244) :

```ts
      } else if (s.kind === 'coffre') {
        // L'anneau dore sous ses pieds, rempli a 20 %, puis le coffre au-dessus.
        g.circle(s.x, s.y, s.radius).fill({ color: COIN_TINT, alpha: 0.2 });
        g.circle(s.x, s.y, s.radius).stroke({ color: COIN_TINT, width: 4 });
        drawChest(g, s.x, s.y - CHEST_LIFT, 1);
```

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd front && npx vitest run src/render/horde-renderer.test.ts src/render/behavior-renderer.test.ts`
Attendu : PASS (dont « donne son facteur au boss, et a chacun le sien » : le porteur a bien
`spriteScale × 1,6`, sous celui du boss).

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/render/horde-renderer.ts front/src/render/horde-renderer.test.ts front/src/render/behavior-renderer.ts front/src/render/behavior-renderer.test.ts
git add front/src/render/horde-renderer.ts front/src/render/horde-renderer.test.ts front/src/render/behavior-renderer.ts front/src/render/behavior-renderer.test.ts
git commit -m "feat(front): le porteur porte le voleur en grand, un anneau dore et un coffre"
```

---

### Tâche 9 : le suivre hors champ — mini-carte et flèche de bord

> ⚠️ **Fusion à anticiper** : `front/src/main.ts`, `front/src/render/frame.ts`,
> `front/src/render/frame.test.ts` et `front/src/render/stage.ts` sont modifiés sur `main` en ce
> moment (le Guide ; `drawChain` reçoit les joueurs). Zones de cette tâche : `main.ts`
> `minimap.draw` (l.729-738) ; `frame.ts` `FrameClient` (l.~112), `FrameStage.drawPings`
> (l.195-202), l'appel l.319 ; `frame.test.ts` `RecordingClient` (l.~140) et l'assertion des
> pings (l.~440-449) ; `stage.ts` `drawPings` (l.499-519). Aucune ne recoupe `drawChain`.

**Fichiers :**
- Modifier : `front/src/ui/minimap.ts` (`MinimapView` l.32-41 ; après le boss l.121-126 ;
  constantes l.28-30), `front/src/render/ping-renderer.ts` (import ; `draw` l.145-185),
  `front/src/render/stage.ts` (`drawPings` l.499-519), `front/src/render/frame.ts` (`FrameClient`
  l.~112 ; `FrameStage.drawPings` l.195-202 ; appel l.319), `front/src/main.ts` (`minimap.draw`
  l.729-738)
- Tester : `front/src/ui/minimap.test.ts`, `front/src/render/ping-renderer.test.ts`,
  `front/src/render/frame.test.ts`

**Interfaces :**
- Consomme : `GameClient.porteur` (tâche 6) ; `drawChest` (tâche 8) ; `COIN_TINT`.
- Produit : `MinimapView.porteur?: { x: number; y: number } | null` ;
  `PingRenderer.draw(..., porteur: { x: number; y: number } | null = null)` ;
  `Stage.drawPings(..., porteur: { x: number; y: number } | null = null)` ;
  `FrameClient.porteur?: { x: number; y: number } | null` ; `FrameStage.drawPings` gagne ce
  sixième paramètre.

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/ui/minimap.test.ts`, dans `describe('mini-carte')` :

```ts
  it('etape 11 : le porteur, un point or de 6 px, sous les joueurs ; rien sans porteur', () => {
    const calls: { style: string; x: number; y: number; w: number; h: number }[] = [];
    const ctx = {
      fillStyle: '',
      fillRect(x: number, y: number, w: number, h: number) {
        calls.push({ style: this.fillStyle, x, y, w, h });
      },
    };
    const canvas = { width: 100, height: 100, getContext: () => ctx } as unknown as HTMLCanvasElement;
    const map = new Minimap(canvas);
    const base = {
      localId: 1,
      players: [{ id: 1, x: 0, y: 0, hp: 10 }],
      enemies: { count: 0, x: new Float32Array(0), y: new Float32Array(0) },
      boss: null,
      pings: [],
      blinkOn: true,
    };
    map.draw({ ...base, porteur: { x: MAP_SIZE / 2, y: MAP_SIZE / 2 } });
    const or = calls.findIndex((c) => c.style === '#f5c542');
    expect(calls[or]).toEqual({ style: '#f5c542', x: 47, y: 47, w: 6, h: 6 });
    // Sous les joueurs : le joueur local est dessine APRES.
    expect(calls.findIndex((c) => c.style === playerColor(1))).toBeGreaterThan(or);
    calls.length = 0;
    map.draw({ ...base, porteur: null });
    expect(calls.filter((c) => c.style === '#f5c542')).toHaveLength(0);
  });
```

`front/src/render/ping-renderer.test.ts` : ajouter
`import { Container, type Graphics } from 'pixi.js';`, `import { COIN_TINT } from './orb-renderer';`
et `PingRenderer` à l'import de `./ping-renderer`, puis en fin de fichier :

```ts
describe('etape 11 : la fleche du porteur', () => {
  /** Les remplissages OR poses sur le calque ECRAN par un `draw` sans ping ni allie. */
  function remplissagesOr(porteur: { x: number; y: number } | null): number {
    const r = new PingRenderer(() => 0xffffff);
    const ecran = new Container();
    r.attachScreen(ecran);
    r.draw([], [], (x, y) => ({ x, y }), 800, 600, porteur);
    const g = ecran.children[0] as Graphics;
    return g.context.instructions.filter(
      (i) => i.action === 'fill' && (i.data as { style: { color: number } }).style.color === COIN_TINT,
    ).length;
  }

  it('une fleche or, au bord, pour un porteur hors champ', () => {
    expect(remplissagesOr({ x: 5000, y: 300 })).toBeGreaterThan(0);
  });

  it('rien pour un porteur dans le champ, rien sans porteur', () => {
    expect(remplissagesOr({ x: 400, y: 300 })).toBe(0);
    expect(remplissagesOr(null)).toBe(0);
  });
});
```

`front/src/render/frame.test.ts` : `RecordingClient` gagne, après `readonly pingClock = 55;` :

```ts
  /** Le porteur (etape 11) : une position qui ne ressemble a rien d'autre du decor. */
  readonly porteur = { x: 4321, y: 1234 };
```

et l'assertion du test « les pings recoivent la carte du client... » devient :

```ts
    expect(stage.argsOf('pings')).toEqual([
      client.pings,
      state.players,
      state.localId,
      client.pingClock,
      NOW,
      client.porteur,
    ]);
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/ui/minimap.test.ts src/render/ping-renderer.test.ts src/render/frame.test.ts`
Attendu : ÉCHEC — aucun point or ; `draw` ignore son sixième argument ; `drawPings` reçoit cinq
arguments.

- [ ] **Étape 3 : implémenter**

`front/src/ui/minimap.ts` :

- après `const BOSS = '#ff2020';` : `const PORTEUR = '#f5c542';` ;
- `MinimapView` gagne, après `boss` :

```ts
  /** Le porteur de coffre (etape 11), un point or. Absent ou `null` : rien. */
  porteur?: { x: number; y: number } | null;
```

- après le bloc `if (view.boss) { ... }` :

```ts
    // Etape 11 : le porteur, au-dessus des ennemis et sous les joueurs.
    if (view.porteur) {
      ctx.fillStyle = PORTEUR;
      ctx.fillRect(
        toMinimap(view.porteur.x, MAP_SIZE, w) - 3,
        toMinimap(view.porteur.y, MAP_SIZE, h) - 3,
        6,
        6,
      );
    }
```

`front/src/render/ping-renderer.ts` :

- imports : `import { drawChest } from './behavior-renderer';` et
  `import { COIN_TINT } from './orb-renderer';` ;
- `draw` gagne un sixième paramètre `porteur: { x: number; y: number } | null = null,` et, après
  la boucle des alliés :

```ts
    // Etape 11 : le porteur hors champ — une fleche OR au bord, et le petit
    // coffre en retrait comme l'icone d'une intention. Dans le champ, rien :
    // l'anneau et le coffre au sol suffisent.
    if (porteur) {
      const sp = toScreen(porteur.x, porteur.y);
      const a = edgeArrow(w, h, sp.x, sp.y, MARGIN);
      if (a) {
        drawArrow(s, a, 1.2, COIN_TINT, 1);
        drawChest(s, a.x - Math.cos(a.angle) * 26, a.y - Math.sin(a.angle) * 26, 0.6);
      }
    }
```

`front/src/render/stage.ts`, `drawPings` (l.499-519) : ajouter le paramètre
`porteur: { x: number; y: number } | null = null,` après `_timeMs: number,`, et passer `porteur`
en sixième argument à `this.#pings.draw(...)`.

`front/src/render/frame.ts` :

- `FrameClient` gagne, après `readonly pingClock: number;` :

```ts
  /**
   * Le porteur de coffre (etape 11), ou `null` — voir `GameClient.porteur`.
   * Optionnel : les doubles qui n'en ont pas passent `null`.
   */
  readonly porteur?: { x: number; y: number } | null;
```

- `FrameStage.drawPings` gagne `porteur: { x: number; y: number } | null,` après `timeMs: number,` ;
- l'appel l.319 devient
  `stage.drawPings(client.pings, state.players, state.localId, client.pingClock, now, client.porteur ?? null);`.

`front/src/main.ts`, `minimap.draw({...})` (l.729-738) : ajouter `porteur: client.porteur,`
après `boss: null,`.

- [ ] **Étape 4 : les relancer, ils passent ; typecheck**

Run : `cd front && npx vitest run src/ui/minimap.test.ts src/render/ping-renderer.test.ts src/render/frame.test.ts src/render/behavior-renderer.test.ts`
Attendu : PASS.
Run : `npm run typecheck -w front`
Attendu : aucune erreur.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/ui/minimap.ts front/src/ui/minimap.test.ts front/src/render/ping-renderer.ts front/src/render/ping-renderer.test.ts front/src/render/stage.ts front/src/render/frame.ts front/src/render/frame.test.ts front/src/main.ts
git add front/src/ui/minimap.ts front/src/ui/minimap.test.ts front/src/render/ping-renderer.ts front/src/render/ping-renderer.test.ts front/src/render/stage.ts front/src/render/frame.ts front/src/render/frame.test.ts front/src/main.ts
git commit -m "feat(front): le porteur sur la mini-carte et en fleche doree au bord"
```

---

### Tâche 10 : le livrable — le porteur sur vraies sockets

**Fichiers :**
- Créer : `back/src/porteur.integration.test.ts`

**Interfaces :**
- Consomme : `PORTEUR_ARCHETYPE` (tâche 1) ; `Room.debugOweLevels` (tâche 5) ; le directeur
  (tâche 4) ; tout le salon (tâches 2, 3, 5).

Le harnais est celui de `back/src/rarete.integration.test.ts` (même `buildServer({ roomSeed })`,
même `connect`, même `waitFor`), à deux sockets et **sans** `vi.mock` : la rareté n'est pas
forcée, c'est le plancher qu'on mesure.

- [ ] **Étape 1 : écrire le test**

`back/src/porteur.integration.test.ts` :

```ts
import type { AddressInfo } from 'node:net';
import { PORTEUR_ARCHETYPE } from '@shared/archetypes';
import { entityIdOf } from '@shared/horde';
import {
  decode,
  encodeDraftToken,
  encodeHello,
  encodeInput,
  type Message,
  MSG,
} from '@shared/protocol';
import { RARITY } from '@shared/rarity';
import { FORMATION } from '@shared/waves';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, prisma } from './accounts';
import { buildServer } from './server';

/**
 * Le livrable de l'etape 11 (§1 de la spec) : **sur deux vraies sockets,
 * l'ordre du porteur arrive aux deux clients, sa mort leur ouvre un
 * `DRAFT_OPEN` dont chaque carte est au moins rare, et chaque client sait que
 * cet etalage est un coffre sans un octet de plus.**
 *
 * ⚠️ **Le seul cas de file reel est force** (ecart n° 5 du plan) : pendant un
 * etalage le monde est gele, donc le porteur ne meurt jamais derriere un
 * etalage ouvert. `room.step` est enveloppe : au tick ou le porteur quitte la
 * horde, un niveau devient du AU MEME TICK (`debugOweLevels`). Le coffre doit
 * passer d'abord, le niveau ensuite.
 *
 * ⚠️ **« Son `GameClient` dit `draftIsChest` »** est rejoue par
 * `drapeauxDeCoffre`, la regle exacte de `GameClient` (ecart n° 4) : le back
 * n'importe pas le front. `client.test.ts` couvre le `GameClient` lui-meme.
 *
 * ⚠️ **La pietaille est retiree HORS du lot de morts** a chaque tick : ni XP
 * (donc aucun niveau parasite), ni joueur submerge. Le decor mesure le coffre.
 */

const ROOM_SEED = 0x11_c0_ff3e;
/** 22 octets d'en-tete + 2 joueurs x 10 : ecrit NU, jamais recalcule (voir l'etape 10). */
const SNAPSHOT_A_DEUX = 42;

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  /** Tout ce qui est arrive sur CETTE socket, hors snapshots. */
  received: Message[];
  /** Les tailles BRUTES des snapshots recus. */
  snapshotBytes: Set<number>;
  /** La taille BRUTE de chaque ordre de porteur recu. */
  porteurOrderBytes: number[];
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
  const client: Client = {
    ws,
    playerId: 0,
    received: [],
    snapshotBytes: new Set(),
    porteurOrderBytes: [],
    seq: 0,
  };
  ws.on('message', (data: ArrayBuffer) => {
    const msg = decode(data);
    if (msg.type === MSG.WELCOME) {
      client.playerId = msg.playerId;
    }
    if (msg.type === MSG.SNAPSHOT) {
      client.snapshotBytes.add(data.byteLength);
      return;
    }
    if (msg.type === MSG.WAVE_ORDER && msg.archetype === PORTEUR_ARCHETYPE) {
      client.porteurOrderBytes.push(data.byteLength);
    }
    client.received.push(msg);
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

/**
 * La regle de `GameClient` (etape 11, §4.3), rejouee sur les messages DECODES,
 * dans l'ordre d'arrivee : un drapeau « coffre ? » par `LEVEL_UP`.
 */
function drapeauxDeCoffre(recus: readonly Message[]): boolean[] {
  let porteur: number | null = null;
  let dus = 0;
  const out: boolean[] = [];
  for (const m of recus) {
    if (m.type === MSG.WAVE_ORDER && m.archetype === PORTEUR_ARCHETYPE) {
      porteur = entityIdOf(m.waveId, 0);
    } else if (m.type === MSG.DEATHS && porteur !== null && m.ids.includes(porteur)) {
      dus++;
      porteur = null;
    } else if (m.type === MSG.LEVEL_UP) {
      out.push(dus > 0);
      if (dus > 0) {
        dus--;
      }
    }
  }
  return out;
}

describe('etape 11 : le porteur de coffre, sur vraies sockets (le livrable)', () => {
  it('l ordre arrive aux deux ; sa mort ouvre, AVANT le niveau du meme tick, un etalage tout rare ; zero octet de plus', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('le registre de salons doit etre accessible depuis l app');
    }
    const a = await connect(code);
    const b = await connect(code);
    // A un seul joueur, le snapshot fait 32 octets : on ne mesure qu'a deux.
    a.snapshotBytes.clear();
    b.snapshotBytes.clear();

    let porteurId: number | null = null;
    let dette = false;
    const pas = room.step.bind(room);
    room.step = (dt: number): void => {
      pas(dt);
      const autres: number[] = [];
      for (let i = 0; i < room.horde.count; i++) {
        const id = room.horde.entityIdAt(i);
        if ((room.horde.archetype[i] ?? 0) !== PORTEUR_ARCHETYPE) {
          autres.push(id);
        } else if (porteurId === null) {
          // Il vient de naitre a ~1 500 px : on le pose a 60 px du joueur A,
          // presque mort, pour que le test ne dure pas une battue entiere.
          porteurId = id;
          const pos = room.positionOf(a.playerId);
          room.horde.x[i] = (pos?.x ?? 0) + 60;
          room.horde.y[i] = pos?.y ?? 0;
          room.horde.hp[i] = 0.001;
        }
      }
      if (autres.length > 0) {
        room.horde.kill(autres);
      }
      // Il vient de tomber dans le lot de CE tick : un niveau devient du au
      // meme tick, avant que rien ne s'ouvre.
      if (porteurId !== null && !dette && room.horde.slotOf(porteurId) < 0) {
        dette = true;
        room.debugOweLevels(1);
      }
    };

    // A vise le porteur, PAR LA SOCKET, tant qu'il vit.
    const visee = setInterval(() => {
      if (porteurId === null) {
        return;
      }
      const s = room.horde.slotOf(porteurId);
      const pos = room.positionOf(a.playerId);
      if (s < 0 || !pos) {
        return;
      }
      const dx = (room.horde.x[s] ?? 0) - pos.x;
      const dy = (room.horde.y[s] ?? 0) - pos.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) {
        return;
      }
      a.seq++;
      a.ws.send(
        encodeInput(a.seq, 0, 0, Math.round((dx / len) * 127), Math.round((dy / len) * 127)),
      );
    }, 10);

    try {
      // ---- 1. L'ordre du porteur arrive aux DEUX, en 19 octets -------------
      const ordres = await Promise.all(
        [a, b].map((c) =>
          waitFor(
            () =>
              c.received.find(
                (m) => m.type === MSG.WAVE_ORDER && m.archetype === PORTEUR_ARCHETYPE,
              ) ?? null,
            `ordre du porteur (joueur ${c.playerId})`,
            30_000,
          ),
        ),
      );
      const [oa, ob] = ordres;
      if (oa?.type !== MSG.WAVE_ORDER || ob?.type !== MSG.WAVE_ORDER) {
        throw new Error('WAVE_ORDER attendu');
      }
      expect(ob.waveId).toBe(oa.waveId);
      expect(oa.formation).toBe(FORMATION.POINT);
      expect(oa.count).toBe(1);
      // ⚠️ Nu : la taille d'un ordre de vague ordinaire, rien de plus.
      expect(a.porteurOrderBytes).toEqual([19]);
      expect(b.porteurOrderBytes).toEqual([19]);

      // ---- 2. Il tombe : un DRAFT_OPEN tout rare chez les deux --------------
      const coffres = await Promise.all(
        [a, b].map((c) =>
          waitFor(
            () => c.received.find((m) => m.type === MSG.DRAFT_OPEN) ?? null,
            `DRAFT_OPEN du coffre (joueur ${c.playerId})`,
            20_000,
          ),
        ),
      );
      for (const open of coffres) {
        if (open.type !== MSG.DRAFT_OPEN) {
          throw new Error('DRAFT_OPEN attendu');
        }
        expect(open.cards.length).toBeGreaterThanOrEqual(2);
        for (const carte of open.cards) {
          expect(carte.rarity).toBeGreaterThanOrEqual(RARITY.RARE);
        }
      }
      // Dans l'ordre : la mort du porteur, puis LEVEL_UP, puis DRAFT_OPEN.
      for (const c of [a, b]) {
        const mort = c.received.findIndex(
          (m) => m.type === MSG.DEATHS && porteurId !== null && m.ids.includes(porteurId),
        );
        const up = c.received.findIndex((m) => m.type === MSG.LEVEL_UP);
        const open = c.received.findIndex((m) => m.type === MSG.DRAFT_OPEN);
        expect(mort).toBeGreaterThanOrEqual(0);
        expect(up).toBeGreaterThan(mort);
        expect(open).toBeGreaterThan(up);
      }

      // ---- 3. Le niveau attendait : jetons poses, il s'ouvre ensuite --------
      a.ws.send(encodeDraftToken(0));
      b.ws.send(encodeDraftToken(1));
      await Promise.all(
        [a, b].map((c) =>
          waitFor(
            () => (c.received.filter((m) => m.type === MSG.DRAFT_OPEN).length >= 2 ? true : null),
            `DRAFT_OPEN du niveau (joueur ${c.playerId})`,
            10_000,
          ),
        ),
      );

      // ---- 4. Chacun sait lequel etait le coffre, sans un octet -------------
      expect(drapeauxDeCoffre(a.received)).toEqual([true, false]);
      expect(drapeauxDeCoffre(b.received)).toEqual([true, false]);

      // ---- 5. Rien de plus par tick ----------------------------------------
      expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
      expect([...b.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
    } finally {
      clearInterval(visee);
    }
  }, 60_000);
});
```

- [ ] **Étape 2 : le lancer, il passe**

Run : `cd back && npx vitest run src/porteur.integration.test.ts`
Attendu : PASS (~15 s : la 2ᵉ vague tombe au tick 360, soit 12 s de temps réel).

Puis **contre-épreuve**, une mutation à la fois, chacune annulée avant la suivante :

1. dans `Room#openDraft`, passer `RARITY.COMMUNE` au lieu de `CHEST_RARITY_FLOOR` → le test doit
   rougir à l'étape 2 (une carte commune, graine fixe) ;
2. dans `Room#openDraft`, consommer le niveau d'abord
   (`const coffre = this.#chestsOwed > 0 && this.#pendingLevels === 0;`) → il doit rougir à
   l'étape 2 (le premier étalage est celui du niveau) ;
3. dans le lot de morts de `Room.step`, retirer `this.#chestsOwed++` → il doit rougir à l'étape 2
   (le seul étalage est celui du niveau, sans plancher).

`git diff` doit être vide hors du nouveau fichier.

- [ ] **Étape 3 : commit**

```bash
npx biome check --write back/src/porteur.integration.test.ts
git add back/src/porteur.integration.test.ts
git commit -m "test(back): le livrable, le coffre du porteur sur vraies sockets"
```

---

### Tâche 11 : le portique et le bilan (contrôleur, seul)

**Fichiers :**
- Créer : `docs/plans/2026-10-15-etape-11-resultats.md`
- Modifier : `README.md` (ligne de l'étape 11, l.34)

- [ ] **Étape 1 : le portique complet, rien d'autre en vol**

Run : `npm run lint && npm run typecheck && npm test`
Attendu : tout vert. Noter le nombre de tests front et back **de cette exécution seule**, et la
ligne `etape 11 : derive de la poursuite du porteur 0.000 px`.

- [ ] **Étape 2 : mettre le graphe à jour**

Run : `graphify update .`

- [ ] **Étape 3 : écrire le bilan**

`docs/plans/2026-10-15-etape-11-resultats.md`, sur le modèle de
`2026-10-15-etape-10-resultats.md` : livré (le porteur, sa fuite, le coffre au plancher rare, la
reconnaissance sans octet, le suivi), nombre de tests (de l'étape 1), dérive mesurée de la fuite
(0,000 px), coût sur le fil (**zéro** : un `WAVE_ORDER` de 19 octets existant, au plus une fois
par 50 vagues ; aucun message, aucun champ, aucun octet par tick), les dix écarts assumés de ce
plan — dont la hitbox ×1,6 (`shared/projectiles.ts` l.65-79, le commentaire de
`shared/archetypes.ts` l.71-78 est périmé) et le coffre dessiné sous les créatures —, puis la
section **« Vérification manuelle — ouverte »** avec les points du §7 de la spec :

- le porteur se distingue-t-il d'un coup d'œil d'un voleur ordinaire (taille, anneau, coffre), en
  pleine horde ? **Le coffre à 60 px est-il masqué par la tête** (écart n° 2) ?
- seul, est-il vraiment dur à prendre ? à deux, la tenaille marche-t-elle ?
- 234 px/s contre 260 : l'écart est-il le bon ?
- 200 × 1,12^k PV : assez pour qu'on ne le fonde pas de loin (§8 : un tireur à 450 px le crible
  pendant qu'il attend) ?
- 83 % rare / 17 % légendaire : le coffre fait-il événement ?
- le bandeau et l'arpège se remarquent-ils en pleine horde, sans gêner ?
- une fois toutes les cinq minutes au plus : trop rare, trop fréquent ?

Plus les risques du §8 à surveiller : la fuite à la distance et non aux dégâts, le Givre qui rend
la battue facile, la cadence en temps de jeu (pas de vague pendant un gel).

- [ ] **Étape 4 : le README**

Ligne de l'étape 11 (l.34) : après `[spec](docs/specs/2026-10-15-etape-11-porteur.md)`, ajouter
` · [plan](docs/plans/2026-10-15-etape-11-porteur.md) · [résultats](docs/plans/2026-10-15-etape-11-resultats.md)`.

- [ ] **Étape 5 : commit**

```bash
git add docs/plans/2026-10-15-etape-11-resultats.md README.md
git commit -m "docs: le bilan de l etape 11"
```

---
