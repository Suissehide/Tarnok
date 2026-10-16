# Étape 14 — les événements bonus : plan d'implémentation

> **Pour les agents :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou
> superpowers:executing-plans, tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**But :** toutes les quatre minutes au plus (et pas avant 2 min de jeu), un objectif apparaît à
~1 200 px de l'équipe — trois sceaux à tenir ensemble, une forge où rester immobile, un chariot à
escorter — et le réussir en 60 s vivantes ouvre un étalage d'équipe dont toutes les cartes sont
**au moins épiques** (des cartes de règle).

**Architecture :** le directeur **marque** la 3ᵉ vague d'un palier (à partir de la vague 20, au
moins 40 vagues après le précédent) d'une graine dérivée de l'ordre principal, sans un tirage ni un
`waveId` de plus ; le salon la lit après la boucle des ordres et confie le placement et les règles
à un module pur serveur (`back/src/evenement.ts`). L'événement vit dans `Room` (`#event`), dort
pendant tout gel **et** la rampe, parle aux clients par trois messages nouveaux (`EVENT_START`,
`EVENT_STATE` à 5 Hz, `EVENT_END`) diffusés avant `LEVEL_UP` ; sa réussite doit un étalage, servi
après un coffre et avant un niveau, au plancher `EVENT_RARITY_FLOOR`. Le client tient un miroir
affiché (bandeau, HUD, zones au sol, chariot interpolé, flèches de bord) et reconnaît l'étalage
d'événement **sans octet**, par la même priorité fixe que le salon.

**Pile :** TypeScript, `ws`, Fastify, Pixi.js v8, Vitest (jsdom côté front pour l'UI), Biome,
Prisma/Postgres pour les tests qui ouvrent de vraies sockets.

**Spec :** [`docs/specs/2026-10-16-etape-14-evenements.md`](../specs/2026-10-16-etape-14-evenements.md)

**Où l'on travaille :** dans un worktree — `main` reçoit des modifications en direct.

```bash
git worktree add ../Tarnok-evenements -b etape-14-evenements
cd ../Tarnok-evenements && npm ci && npm run db:generate -w back
cp ../Tarnok/back/.env back/.env && cp ../Tarnok/front/.env front/.env
```

Tous les chemins de ce plan sont relatifs à la racine du worktree (`../Tarnok-evenements`). Les
ancres `l.~N` sont celles du commit `76613ab` (`main` **après** la fusion des pactes), pas celles
de la spec, écrite avant cette fusion (voir l'écart n° 1).

## Contraintes globales

- Constantes, valeurs de la spec, **jamais un nombre en dur ailleurs** :
  - `shared/evenements.ts` (créé) : `EVENT_KIND = { SCEAUX: 0, FORGE: 1, CONVOI: 2 }` ;
    `EVENT_OUTCOME = { REUSSI: 0, EXPIRE: 1, DETRUIT: 2 }` ;
    `EVENT_DURATION_TICKS = 60 × TICK_HZ` = **1 800** (ticks **vivants**) ;
    `EVENT_STATE_PERIOD_TICKS = TICK_HZ / 5` = **6** (5 Hz) ; `SCEAU_RADIUS = 120` ;
    `FORGE_RADIUS = 90` ; `CONVOI_ESCORT_RADIUS = 150` ; `CONVOI_RADIUS = 32` (px).
  - `shared/rarity.ts` : `EVENT_RARITY_FLOOR = RARITY.EPIQUE` — au plancher, `{6, 2}` renormalisé :
    **75 % épique, 25 % légendaire** par emplacement, un seul `rng()`.
  - `back/src/wave-director.ts` : `EVENT_WAVE_IN_PALIER = 3` ; `EVENT_MIN_GAP_WAVES = 40`
    (40 × 6 s = 4 min) ; `EVENT_FIRST_WAVE = Math.ceil((120 × TICK_HZ) / PERIOD_TICKS)` = **20**
    (écrit en formule). Graine : `(principal.seed ^ 0x2c9e_7d43) >>> 0`.
  - `back/src/evenement.ts` (créé) : `EVENT_SPAWN_DISTANCE = 1200` ; `SCEAUX_SPACING = 800` ;
    `SCEAUX_HOLD_TICKS = 600` (20 s) ; `FORGE_HOLD_TICKS = 900` (30 s) ;
    `FORGE_HOLD_TICKS_SOLO = 450` (15 s) ; `FORGE_STILL_SPEED = 20` (px/s, lu sur l'**entrée**) ;
    `CONVOI_DISTANCE = 1500` ; `CONVOI_SPEED = 60` (px/s) ; `CONVOI_HP = 400` ;
    `CONVOI_HP_SOLO = 800` ; `CONVOI_CONTACT_RADIUS = CONVOI_RADIUS + CONTACT_RADIUS / 2` = **49** ;
    `CONVOI_CONTACT_DAMAGE = CONTACT_DAMAGE` = **8** toutes les `CONTACT_INTERVAL_TICKS` = 15 ;
    `CONVOI_MAX_HITTERS = 5` ; `CONVOI_ARRIVAL_RADIUS = 32`.
  - `front/src/net/client.ts` : `EVENT_BANNER_MS = 4000` ; interpolation du chariot sur une période
    d'`EVENT_STATE` (`1000 × EVENT_STATE_PERIOD_TICKS / TICK_HZ` = 200 ms).
  - Rendu : `COIN_TINT` (`0xf5c542`) pour tout l'or ; forge `0xff8a3d` ; chariot `0x7a4e2a`
    48 × 30 px, roues de 8 px, barre de PV 48 × 5 px ; anneau de progression à `r + 10`, trait 6 px.
- **Trois messages nouveaux, et seulement eux.** `MSG` s'arrête à `PING_SHOWN: 27`
  (`shared/protocol.ts` l.38) ; 28, 29 et 30 sont libres sur `main` après les pactes (vérifié) :

  | Message | Id | Octets | Disposition (petit-boutiste) |
  | --- | --- | --- | --- |
  | `EVENT_START` | **28** | **5 + 4n** (9, 13, 21) | `type u8 · genre u8 · durée u16 (ticks vivants) · n u8 · n × (x i16, y i16)` |
  | `EVENT_STATE` | **29** | **7** | `type u8 · progression u8 · chariot x i16 · chariot y i16 · PV chariot u8` (zéros hors convoi) |
  | `EVENT_END` | **30** | **2** | `type u8 · issue u8` |

  `EVENT_START_HEADER_BYTES = 5`, `EVENT_POINT_BYTES = 4`, `EVENT_STATE_BYTES = 7`,
  `EVENT_END_BYTES = 2`. Progression `floor(255 × fraction)` ; PV `ceil(255 × pv / pvMax)`.
- **Rien d'ajouté aux messages par tick.** `SNAPSHOT` garde `SNAPSHOT_HEADER_BYTES` (22) +
  `SNAPSHOT_PLAYER_BYTES` (**11** depuis le bouclier des pactes) par joueur : **44 octets à deux**.
  `EVENT_STATE` ne part que pendant un événement, 5 fois par seconde de jeu vivant.
- **Aucun tirage de plus, aucun `waveId` de plus dans le directeur** : les ordres rendus par
  `dueWave` restent bit-identiques, `waveId` compris.
- **La récompense** : un étalage d'équipe au plancher `EVENT_RARITY_FLOOR`, par la machine du
  coffre (étape 11). Priorité fixe des deux côtés : **coffre > événement > niveau**.
- **L'événement dort tant que `#tick <= #resumeEndTick`** côté salon (étalage, gel **et** rampe) ;
  le client compte son échéance sur `pingClock`, qui dort pendant `isFrozen` (gel **et** rampe).
- Commentaires de code en français **sans accents** ; textes affichés avec leurs accents ;
  messages de commit conventionnels en français sans accents, sujet en minuscules (commitlint
  `subject-case`) : `feat(shared): ...`, `test(back): ...`, `docs: ...`.
- **Discipline des sous-agents** : un sous-agent ne lance **que les fichiers de test de sa tâche**
  (`npx vitest run <fichier>`), jamais `npm test`, jamais un banc. Le portique complet et les
  bancs sont au contrôleur, **seul**, à la tâche 12.
- Commandes de test : tests de `shared/` depuis `back/` (`cd back && npx vitest run
  ../shared/<fichier>`), tests du back depuis `back/`, tests du front depuis `front/`
  (`cd front && npx vitest run src/...`).
- **Postgres local.** `back/src/server.test.ts` et les `*.integration.test.ts` ouvrent de vraies
  sockets et créent des comptes : ils exigent le Postgres local (il tourne). ⚠️ Une autre session
  peut lancer des tests d'intégration **sur la même base au même moment** (`deleteMany` en
  `beforeEach`) : un échec isolé de compte ou de crédit (`createAccount`, jeton refusé, WELCOME
  absent) se **relance une fois** avant d'en conclure quoi que ce soit.
- Avant chaque commit : `npx biome check --write <fichiers de la tâche>` (le code de ce plan n'est
  pas garanti au format Biome ; le hook de commit le refuserait).
- **Des commits NOUVEAUX seulement** : jamais `--amend`, jamais `rebase`, jamais `reset`, jamais
  `checkout` d'un autre commit.
- Jamais `pkill -f` : les serveurs de dev de Léo tournent sur 5173 et 3100.
- **Copie de travail de `main` en cours d'édition** par une autre session :
  `assets/placeholder/*` (suppressions), `front/src/styles/main.css`, `NOTICE-assets.md`,
  `tools/build_iso_atlas.py`. **Aucune tâche de ce plan ne touche ces fichiers** — le HUD réutilise
  les classes Tailwind de `hud-porteur`, donc `main.css` ne change pas. Si un implémenteur croit
  devoir y toucher, il s'arrête et le dit : ce serait au plus un bloc **ajouté en fin de fichier**.

**Écart assumé n° 1 — la spec a été écrite avant la fusion des pactes ; ses ancres de `room.ts`,
`client.ts`, `index.html`, `main.ts`, `combat.ts`, `protocol.ts`, `cards.ts` ont bougé.** Les
règles qu'elle décrit tiennent (vérifié contre `76613ab`) ; ce plan cite partout les lignes
actuelles. Les principales : ouverture d'un étalage `room.ts` l.1426-1429 (spec : 1335-1338) ;
`dueWave` dans le salon l.1539 (1448) ; fin de la boucle des ordres l.1600 ; `#checkRunOver()`
l.1940 (1833) ; `#openDraft` l.2587-2617 (2479-2508) ; `#stepDraft` l.2631-2652 (2523-2544) ;
`#movementScale` l.2997-3003 (2842-2848) ; `#endRun` l.3099-3107 (2934-2942) ; `#chestsOwed`
l.506 (491) ; `#draftRng`/masque au constructeur l.612-620 (597-603) ; `applyInput` l.1296-1315
(1205-1222) ; `resolveContact` `back/src/combat.ts` l.1951-1977 (1850-1876) ; `SPREAD_BONUS`
`shared/constants.ts` l.435 (445) ; `CHEST_RARITY_FLOOR` `shared/rarity.ts` l.38 (32) ;
`drawSpread` `shared/cards.ts` l.173-251 ; `viewOf` `shared/protocol.ts` l.957-962 (936-941),
`decode` l.1501 (1466) ; `PORTEUR_BANNER_MS` `client.ts` l.253 (254), `pingClock` l.1703,
`isFrozen` l.1851-1858, `update` l.2201-2203, gestionnaires l.2346-2437 ; `hud-porteur`
`index.html` l.457-462 (384-389) ; `main.ts` l.217 (202) et l.799-812 (784-797) ; `formatTimer`
`stage.ts` l.802 (787) ; bandeau de gel `hud.ts` l.304-307 (286-290) ; titre `draft.ts`
l.649-653 (590-594).

**Écart assumé n° 2 — la remontée de palier est bien nécessaire, et un test des pactes doit être
réécrit.** Vérifié contre le `drawSpread` fusionné (`shared/cards.ts` l.223-226 la descente,
l.244-246 le `break`) : au plancher épique, un emplacement qui tire épique quand les trois épiques
sont sorties ne descend pas (`rarity > floor` faux) et arrête l'étalage. **Mesuré sur `76613ab`**,
graines 1-200, plancher épique : en solo 92 étalages de 3 cartes (au lieu de 4), à quatre joueurs
**3 / 4 / 5 / 6 cartes = 92 / 62 / 31 / 15** — jamais 7, souvent moins de cartes que de joueurs.
(La spec estimait 0,75⁴ ≈ 32 % en solo ; mesuré 46 %.) Avec la boucle de remontée de la spec
(verbatim : mêmes noms `rarity`, `permis`, `permisAt`), **mesuré** : `min(N + 3, 6)` cartes sur
500 graines pour N = 1 à 4, aucune sous épique, et l'empreinte des étalages aux planchers commun et
rare **inchangée** (`2_604_871_415`). Le test des pactes « plancher épique : l'étalage se
raccourcit » (`shared/cards.test.ts` l.540-566) **reste vert** (6 < 7) mais son commentaire
(« deux ou trois cartes, 111 et 89 ») est déjà faux sur `main` et devient trompeur : la tâche 1 le
réécrit.

**Écart assumé n° 3 — l'empreinte « `waveId` compris » est une variante nouvelle.** Le test cité
par la spec (`back/src/wave-director.test.ts` l.718-738) n'empreinte **pas** le `waveId` ni l'ordre
du porteur. La tâche 3 garde ce test tel quel et ajoute une variante qui empreinte **tous** les
ordres, `waveId` compris, relevée sur `76613ab` avec le même décor : **161 lignes,
FNV-1a `3_330_581_021`**.

**Écart assumé n° 4 — « un seul événement en jeu sur 20 min simulées » ne se teste pas dans le
salon.** Un salon d'épreuve retire sa horde hors du lot de morts (sinon le joueur passif meurt) :
son boss ne meurt donc jamais, `#wavesSincePalier` ne repasse jamais par 3 après la vague 3, et le
salon ne verrait **aucun** événement en 20 min. L'invariant est prouvé où il vit : le directeur
(tâche 3 : événements aux vagues 23, 63, 103 quand les boss tombent ; deux événements toujours
séparés de plus d'`EVENT_DURATION_TICKS` ticks), et le câblage salon ↔ directeur par un espion de
`takeEventSeed` (tâche 5).

**Écart assumé n° 5 — trois écritures et une lecture de test sur `Room`.** `debugStartEvent(seed)`
(attendre la vague 20 coûterait 2 min de temps réel par test d'intégration), `debugOweChests(n)`
(provoquer « coffre, événement et niveau dus au même tick ») et la lecture étroite `eventPoints`
(comme `positionOf` : les tests posent les joueurs sur les points sans voler la file de
diffusion). Même statut que `debugOweLevels`.

**Écart assumé n° 6 — `placeEvent` reçoit `this.#convoiField`, pas `this.#fields[0]`.**
`#fields[0]` est typé `FlowField | undefined` (`room.ts` l.395, l.1461 le teste) ; `#convoiField`
porte **le même masque** (même `applyObstacles` au constructeur), n'est jamais `undefined`, et un
BFS ne touche pas `blocked`.

**Écart assumé n° 7 — `nudgeOutOfObstacle` écrit dans des `Float32Array`.** Sa signature
(`shared/waves.ts` l.112-160 : `(obstacles, x, y, outX, outY, i)`) ne rend pas de point ; la spec
l'utilise comme si. Elle gagne `export` (spec) et `back/src/evenement.ts` l'enveloppe dans une
fonction `poser` de six lignes (bornage, sortie du mur, arrondi au pixel pour l'`int16`).

**Écart assumé n° 8 — le chariot suit le champ de flux ET glisse par `moveOnMap`.** La spec ne
donne que `sampleDirection`. L'échantillonnage bilinéaire peut viser un coin de mur ; passer le pas
par `moveOnMap` (la règle des joueurs, `shared/worldmap.ts` l.245) garantit qu'il n'entre jamais
dans un mur, et le champ garantit qu'il ne s'y coince pas.

**Écart assumé n° 9 — `HudSource.event` (la vue) plutôt qu'`eventStatus` (le texte).** Le
`GameClient` est passé tel quel comme `HudSource` : lui faire formater « La forge — 62 % — 0:41 »
mettrait du texte d'écran et `formatTimer` (`render/stage.ts`) dans le client réseau. `hud.ts`
exporte `eventStatusText(event)`, pure et testée ; elle importe `formatTimer` de
`render/stage.ts` comme `ui/summary.ts` y importe déjà `formatSummary` (l.5).

**Écart assumé n° 10 — les tests du miroir client vivent dans `front/src/net/evenement.test.ts`**
(créé), sur le patron de `front/src/net/ping.test.ts` (son `FakeSocket`, son `connecte()`), plutôt
qu'au bout des 5 200 lignes de `client.test.ts`.

**Écart assumé n° 11 — « chaque `GameClient` dit `draftIsEvent` », dans le livrable, est rejoué**
par `drapeauxDEvenement` (la règle exacte, cinq lignes), comme à l'étape 11 : le back n'importe pas
le front. Le `GameClient` lui-même est couvert par la tâche 7, sur les mêmes encodeurs.

**Écart assumé n° 12 — le §10 de la spec contredit son §6.5 ; le plan suit le §6.5.** Le §6.5
compte un étalage d'événement à **tout** `EVENT_END` réussi reçu ; un client arrivé en cours
d'événement reçoit cet `EVENT_END`, donc son étalage s'intitule bien « Événement » (le §10 disait
« Niveau N »). Seul ce qu'il n'a pas vu (le départ, les états) lui manque.

**Écart assumé n° 13 — le README n'a pas de ligne pour les étapes 12 et 13.** La dernière ligne du
tableau est celle de l'étape 11 (`README.md` l.34) : la ligne de l'étape 14 vient juste après elle.

**Écart assumé n° 14 — un test d'ordre de diffusion en plus.** La spec (§6.4) fait de « `EVENT_*`
avant `LEVEL_UP` » la garantie du client, mais aucun test de son §9 ne la tient (dans le livrable,
`EVENT_END` et `LEVEL_UP` partent presque toujours dans deux envois distincts). La tâche 6 la
prouve dans `back/src/server.test.ts`, dans un même envoi forcé.

## Points de vigilance de la revue

1. **Personne debout quand la graine tombe** (toute l'équipe à terre au tick de la 3ᵉ vague) :
   aucun événement, aucun message, jamais un centre en `NaN` → test tâche 5 (et `placeEvent` sans
   vivant reste défini → tâche 4).
2. **Un site près d'un bord, d'un coin, ou dans un mur** : chaque point est dans la carte, hors
   mur, entier (il voyage en `int16`) ; l'arrivée du convoi reste dans la carte → tests tâche 4.
3. **Un client arrivé en cours d'événement** : un `EVENT_STATE` sans départ est ignoré (pas de
   chariot fantôme en (0, 0)), et son `EVENT_END` réussi compte quand même l'étalage → test tâche 7.
4. **La run s'achève pendant un événement** (équipe effacée) : plus aucun `EVENT_*` après
   `RUN_OVER`, aucun étalage dû → test tâche 5.
5. **Un joueur part (ou meurt) pendant les sceaux** : N reste figé, rien ne plante, l'événement
   s'éteint à 60 s sans étalage → test tâche 5.

---

## Carte des fichiers

| Fichier | Rôle |
| --- | --- |
| `shared/evenements.ts` (créé) | genres, issues, durée, cadence, rayons dessinés |
| `shared/rarity.ts`, `shared/rarity.test.ts` | `EVENT_RARITY_FLOOR` |
| `shared/cards.ts`, `shared/cards.test.ts` | la remontée de palier dans `drawSpread` |
| `shared/protocol.ts`, `shared/protocol.test.ts` | `EVENT_START` / `EVENT_STATE` / `EVENT_END`, `encodeEvent` |
| `back/src/wave-director.ts`, `back/src/wave-director.test.ts` | `#marquerEvenement`, `takeEventSeed` |
| `shared/waves.ts` | `nudgeOutOfObstacle` exportée |
| `back/src/evenement.ts`, `back/src/evenement.test.ts` (créés) | `placeEvent`, `EventRun` : placement et règles, purs, serveur seul |
| `back/src/room.ts`, `back/src/room.test.ts` | `#event`, `#eventDraftsOwed`, `#convoiField`, `drainEvents`, ouverture coffre > événement > niveau |
| `back/src/server.ts`, `back/src/server.test.ts` | diffusion des `EVENT_*` après `PICKUPS`, avant `LEVEL_UP` |
| `front/src/net/client.ts`, `front/src/net/evenement.test.ts` (créé) | miroir : `event`, `eventCount`, `eventBanner`, `draftIsEvent` |
| `front/src/audio/audio.ts`, `front/src/audio/audio.test.ts` | l'effet `'evenement'` |
| `front/src/ui/hud.ts`, `front/src/ui/hud.test.ts`, `front/index.html` | « Événement — pause… », `hud-evenement`, `hud-evenement-etat` |
| `front/src/ui/draft.ts`, `front/src/ui/draft.test.ts` | titre « Événement » |
| `front/src/main.ts` | câblage HUD et son |
| `front/src/render/behavior-renderer.ts`, `…/behavior-renderer.test.ts` | `eventShapes` et leur dessin procédural |
| `front/src/render/ping-renderer.ts`, `…/ping-renderer.test.ts` | flèches or de bord |
| `front/src/render/stage.ts`, `front/src/render/frame.ts`, `front/src/render/frame.test.ts` | câblage des deux calques |
| `back/src/evenement.integration.test.ts` (créé) | **le livrable** |
| `docs/plans/2026-10-16-etape-14-resultats.md` (créé), `README.md` | le bilan |

Pourquoi ce découpage : le modèle partagé et la récompense (1) précèdent tout ; le fil (2) et le
moment (3) sont deux contrats indépendants, chacun avec sa preuve ; les règles (4) sont pures et se
testent sans salon ; le salon (5) les assemble ; l'ordre de diffusion (6) est une garantie
réseau qu'un relecteur peut juger seule ; côté client, le **miroir** (7) est de la logique, l'**annonce**
(8) est de l'UI qui le lit, le **sol** (9) et le **hors-champ** (10) sont deux calques qu'on peut
accepter l'un sans l'autre (comme à l'étape 11) ; le livrable (11) vient quand tout est là ; le
portique (12) est au contrôleur.

---

### Tâche 1 : le modèle partagé et la récompense épique

**Fichiers :**
- Créer : `shared/evenements.ts`
- Modifier : `shared/rarity.ts` (après `CHEST_RARITY_FLOOR` l.38), `shared/cards.ts` (import
  l.4 ; docbloc de `drawSpread` l.169-172 ; boucle de descente l.223-226 ; commentaire du `break`
  l.241-246)
- Tester : `shared/rarity.test.ts` (import l.4-12 ; nouveau `describe` en fin de fichier),
  `shared/cards.test.ts` (import l.17 ; test l.540-566 réécrit ; nouveau `describe` en fin de
  fichier)

**Interfaces :**
- Consomme : rien.
- Produit : `shared/evenements.ts` exporte `EVENT_KIND`, `EVENT_OUTCOME`, `EVENT_DURATION_TICKS`
  (1 800), `EVENT_STATE_PERIOD_TICKS` (6), `SCEAU_RADIUS` (120), `FORGE_RADIUS` (90),
  `CONVOI_ESCORT_RADIUS` (150), `CONVOI_RADIUS` (32) ; `shared/rarity.ts` exporte
  `EVENT_RARITY_FLOOR: number` (= `RARITY.EPIQUE`) ; `drawSpread(loadouts, rng, EVENT_RARITY_FLOOR)`
  rend `min(N + SPREAD_BONUS, 6)` cartes, toutes `>= RARITY.EPIQUE`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`shared/rarity.test.ts` : ajouter `EVENT_RARITY_FLOOR` à l'import de `./rarity`, puis en fin de
fichier :

```ts
describe('etape 14 : le plancher d un evenement', () => {
  it('est epique', () => {
    expect(EVENT_RARITY_FLOOR).toBe(RARITY.EPIQUE);
  });

  /** {6, 2} renormalise : epique sous 6/8 = 0,75, legendaire au-dela. */
  it('frontiere : epique sous 0,75, legendaire au-dela', () => {
    expect(rollRarity(() => 0, EVENT_RARITY_FLOOR)).toBe(RARITY.EPIQUE);
    expect(rollRarity(() => 0.74, EVENT_RARITY_FLOOR)).toBe(RARITY.EPIQUE);
    expect(rollRarity(() => 0.76, EVENT_RARITY_FLOOR)).toBe(RARITY.LEGENDAIRE);
    expect(rollRarity(() => 0.999_999, EVENT_RARITY_FLOOR)).toBe(RARITY.LEGENDAIRE);
  });

  it('ne rend qu epique ou legendaire, a 75 / 25, sur 50 000 tirages', () => {
    const rng = makeRandom(0x14_0a_0001);
    const vus = [0, 0, 0, 0];
    const N = 50_000;
    for (let i = 0; i < N; i++) {
      const r = rollRarity(rng, EVENT_RARITY_FLOOR);
      vus[r] = (vus[r] ?? 0) + 1;
    }
    expect(vus[RARITY.COMMUNE]).toBe(0);
    expect(vus[RARITY.RARE]).toBe(0);
    expect((vus[RARITY.EPIQUE] ?? 0) / N).toBeCloseTo(0.75, 1);
    expect((vus[RARITY.LEGENDAIRE] ?? 0) / N).toBeCloseTo(0.25, 1);
  });

  it('consomme UN seul rng() par tirage, comme tout plancher', () => {
    let appels = 0;
    rollRarity(() => {
      appels++;
      return 0.5;
    }, EVENT_RARITY_FLOOR);
    expect(appels).toBe(1);
  });
});
```

`shared/cards.test.ts` : l'import l.17 devient
`import { CHEST_RARITY_FLOOR, EVENT_RARITY_FLOOR, RARITY } from './rarity';`.

Le test `plancher epique : l etalage se raccourcit plutot que de descendre sous le plancher`
(l.540-566, docbloc compris) est **remplacé** par :

```ts
  /**
   * ⚠️ **Le plancher passe AVANT l'etalage complet.** Sous plancher rare la
   * descente trouve toujours des cartes ordinaires, donc le `> floor` de la
   * boucle ne se distingue pas d'un `> 0` : il fallait un plancher que les
   * seuls paliers ne peuvent pas servir jusqu'au bout pour l'eprouver.
   *
   * ⚠️ **Etape 14 : au plancher epique, l'etalage plafonne aux SIX cartes de
   * regle.** Avant la remontee, un emplacement qui tirait epique apres les
   * trois epiques arretait l'etalage (mesure sur 200 graines a quatre joueurs :
   * 3, 4, 5 ou 6 cartes, 92 / 62 / 31 / 15). Depuis, il remonte au legendaire :
   * six cartes a chaque graine — une de moins que voulu a quatre, assume — et
   * aucune ne passe sous le plancher.
   */
  it('plancher epique : jamais sous le plancher, et six cartes de regle au plus', () => {
    const loadouts = equipe(new Loadout(), new Loadout(), new Loadout(), new Loadout());
    const voulu = loadouts.size + SPREAD_BONUS;
    for (let seed = 1; seed <= 200; seed++) {
      const spread = drawSpread(loadouts, makeRandom(seed), RARITY.EPIQUE);
      for (const c of spread) {
        expect(c.rarity ?? RARITY.COMMUNE).toBeGreaterThanOrEqual(RARITY.EPIQUE);
      }
      expect(spread.length).toBeLessThan(voulu);
      expect(spread.length).toBe(epiques.length + legendaires.length);
    }
  });
```

Puis en fin de fichier :

```ts
describe('etape 14 : drawSpread au plancher d un evenement — la remontee', () => {
  /** FNV-1a 32 bits : une empreinte du flux, comparee a celle relevee sur main. */
  function fnv1a(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }
  const regles = PASSIVES.filter((p) => p.tier !== undefined).length;
  const joueurs = (n: number): Map<number, Loadout> =>
    equipe(...Array.from({ length: n }, () => new Loadout()));

  it('six cartes de regle au catalogue, la limite de tout etalage d evenement', () => {
    expect(regles).toBe(6);
  });

  it('min(N + 3, 6) cartes, toutes epiques ou legendaires et chacune chez elle, N = 1 a 4, 300 graines', () => {
    for (let n = 1; n <= 4; n++) {
      for (let seed = 1; seed <= 300; seed++) {
        const spread = drawSpread(joueurs(n), makeRandom(seed), EVENT_RARITY_FLOOR);
        expect(spread).toHaveLength(Math.min(n + SPREAD_BONUS, regles));
        for (const c of spread) {
          expect(c.rarity).toBeGreaterThanOrEqual(RARITY.EPIQUE);
          expect(c.rarity).toBe(rarityForTier(tierOf(c)));
        }
      }
    }
  });

  /**
   * ⚠️ **La graine 1 en solo est le cas de la spec, mesure sur main avant
   * l'etape** : trois epiques, puis un quatrieme emplacement qui tire epique
   * — palier vide, plancher atteint, `break` : 3 cartes pour un etalage de 4.
   */
  it('graine 1 en solo : la quatrieme carte REMONTE en legendaire au lieu d arreter l etalage', () => {
    const spread = drawSpread(joueurs(1), makeRandom(1), EVENT_RARITY_FLOOR);
    expect(spread.map((c) => c.rarity)).toEqual([
      RARITY.EPIQUE,
      RARITY.EPIQUE,
      RARITY.EPIQUE,
      RARITY.LEGENDAIRE,
    ]);
  });

  /**
   * Une carte de regle coute deux `rng()` (rarete, carte) ; la remontee,
   * aucun. N = 1 a 3 seulement : a quatre, un septieme emplacement ne trouve
   * plus rien (six cartes de regle) et coute ses deux `rng()` avant le `break`.
   */
  it('la remontee ne consomme aucun rng() de plus', () => {
    for (const n of [1, 2, 3]) {
      for (let seed = 1; seed <= 100; seed++) {
        const source = makeRandom(seed);
        let appels = 0;
        const spread = drawSpread(
          joueurs(n),
          () => {
            appels++;
            return source();
          },
          EVENT_RARITY_FLOOR,
        );
        expect(spread).toHaveLength(n + SPREAD_BONUS);
        expect(appels).toBe(2 * spread.length);
      }
    }
  });

  /**
   * ⚠️ **Le niveau et le coffre ne voient AUCUNE difference.** Empreinte des
   * etalages aux planchers commun et rare, N = 1 a 4, graines 1 a 100,
   * RELEVEE sur `76613ab` avant l'etape : la remontee ne se declenche que si
   * le plancher lui-meme est vide, ce qui n'arrive pas tant qu'une carte
   * ordinaire reste prenable.
   */
  it('aux planchers commun et rare, les etalages sont bit-identiques a ceux d avant l etape', () => {
    const rows: unknown[] = [];
    for (const floor of [RARITY.COMMUNE, RARITY.RARE]) {
      for (let n = 1; n <= 4; n++) {
        for (let seed = 1; seed <= 100; seed++) {
          rows.push(drawSpread(joueurs(n), makeRandom(seed), floor));
        }
      }
    }
    expect(fnv1a(JSON.stringify(rows))).toBe(2_604_871_415);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run ../shared/rarity.test.ts ../shared/cards.test.ts`
Attendu : ÉCHEC — `EVENT_RARITY_FLOOR` non exporté. (Une fois la constante posée seule, la
« graine 1 en solo », « min(N + 3, 6) » et « aucun rng() de plus » rougiraient encore : 3 cartes
au lieu de 4. L'empreinte commun/rare passerait déjà — voulu, elle garde ce qui ne doit pas
bouger.)

- [ ] **Étape 3 : implémenter**

`shared/evenements.ts` (créé) :

```ts
import { TICK_HZ } from './constants';

/**
 * Les evenements bonus (etape 14) : ce que le serveur ET le client doivent
 * connaitre — le genre, l'issue, la duree, la cadence du fil, les rayons
 * dessines. Le reste (placement, regles, PV du chariot) vit au serveur seul,
 * `back/src/evenement.ts` : aucun client ne derive un evenement, il le lit.
 */

/** Le genre, l'octet `genre` d'`EVENT_START`. L'index EST l'identifiant. */
export const EVENT_KIND = {
  SCEAUX: 0,
  FORGE: 1,
  CONVOI: 2,
} as const;

/** L'issue, l'octet d'`EVENT_END`. Expire et detruit ne coutent rien : seule la recompense est perdue. */
export const EVENT_OUTCOME = {
  REUSSI: 0,
  EXPIRE: 1,
  DETRUIT: 2,
} as const;

/**
 * 60 s pour reussir, en ticks VIVANTS.
 *
 * ⚠️ **L'evenement dort pendant tout gel ET pendant la rampe de reprise**
 * (§2.4) : c'est ce qui rend juste, sans un octet, le compte a rebours que le
 * client pose sur `pingClock` — qui dort exactement quand lui dort.
 */
export const EVENT_DURATION_TICKS = 60 * TICK_HZ;

/** Un `EVENT_STATE` tous les 6 ticks vivants : 5 Hz, et seulement pendant un evenement. */
export const EVENT_STATE_PERIOD_TICKS = TICK_HZ / 5;

/** Rayon d'un sceau : un joueur vivant a cette distance ou moins l'occupe. */
export const SCEAU_RADIUS = 120;
/** Rayon de la forge : un joueur vivant et IMMOBILE dedans la canalise. */
export const FORGE_RADIUS = 90;
/** Un joueur vivant a cette distance du chariot l'escorte : il avance. */
export const CONVOI_ESCORT_RADIUS = 150;
/** Le corps dessine du chariot ; son rayon de contact en derive au serveur. */
export const CONVOI_RADIUS = 32;
```

`shared/rarity.ts`, après `CHEST_RARITY_FLOOR` (l.38) :

```ts
/**
 * Le plancher d'un etalage d'EVENEMENT (etape 14, §5.2) : toutes ses cartes
 * sont des cartes de REGLE, epiques ou legendaires — {6, 2} renormalise, soit
 * 75 % / 25 % par emplacement, un seul `rng()`. Aucune arme : elles plafonnent
 * a rare. Pas « tout legendaire » : ce seraient toujours les trois memes
 * pactes, tous payants.
 */
export const EVENT_RARITY_FLOOR: number = RARITY.EPIQUE;
```

`shared/cards.ts` :

- l'import l.4 devient `import { multiplierOf, RARITY, RARITY_WEIGHTS, rollRarity } from './rarity';` ;
- le docbloc de `drawSpread`, dernier paragraphe (l.169-172), devient :

```ts
 * `floor` (etape 11) : le plancher de rarete de CHAQUE emplacement, passe tel
 * quel a `rollRarity` — `CHEST_RARITY_FLOOR` pour un coffre,
 * `EVENT_RARITY_FLOOR` pour un evenement. La descente le respecte : elle ne
 * passe JAMAIS dessous ; au plancher vide, l'emplacement REMONTE (etape 14).
```

- après la boucle de descente (l.223-226, `while (permis.total === 0 && rarity > floor) {...}`) :

```ts
    // ⚠️ **La remontee (etape 14, §5.2).** Au plancher EPIQUE, un emplacement
    // qui tire epique apres les trois epiques arretait l'etalage, meme s'il
    // restait des legendaires : un evenement a quatre offrait parfois trois
    // cartes. Au plancher vide, on monte d'un cran plutot que de s'arreter.
    // Aucun `rng()` de plus : on change de palier, on ne retire pas. Elle ne
    // se declenche jamais aux planchers commun et rare — la carte ordinaire
    // d'une arme possedee y reste toujours permise —, donc le niveau et le
    // coffre ne voient aucune difference (empreinte relevee, `cards.test.ts`).
    while (permis.total === 0 && rarity < RARITY_WEIGHTS.length - 1) {
      rarity++;
      permis = permisAt(rarity);
    }
```

- le commentaire du `break` (l.241-243) devient :

```ts
    // ⚠️ Atteignable seulement si AUCUN palier a partir du plancher ne permet
    // plus rien : au plancher epique, les six cartes de regle deja sorties
    // (etape 14). Sans elle, `pool[-1]` sortirait.
```

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run ../shared/rarity.test.ts ../shared/cards.test.ts`
Attendu : PASS (tous les tests de ces deux fichiers, ceux des étapes 10, 11 et 13 compris).

- [ ] **Étape 5 : commit**

```bash
npx biome check --write shared/evenements.ts shared/rarity.ts shared/rarity.test.ts shared/cards.ts shared/cards.test.ts
git add shared/evenements.ts shared/rarity.ts shared/rarity.test.ts shared/cards.ts shared/cards.test.ts
git commit -m "feat(shared): le plancher epique des evenements, et un palier vide remonte"
```

---

### Tâche 2 : le fil — EVENT_START, EVENT_STATE, EVENT_END

**Fichiers :**
- Modifier : `shared/protocol.ts` (`MSG` l.11-39 ; union `Message` l.360-387 ; `decode` l.1501-1563 ;
  nouveaux blocs en fin de fichier, après `decodePingShown`)
- Tester : `shared/protocol.test.ts` (import l.15-96 ; nouveau `describe` en fin de fichier)

**Interfaces :**
- Consomme : `EVENT_KIND`, `EVENT_OUTCOME`, `EVENT_DURATION_TICKS` (tâche 1), dans les tests.
- Produit : `MSG.EVENT_START = 28`, `MSG.EVENT_STATE = 29`, `MSG.EVENT_END = 30` ;
  `EventStartMessage { type; kind: number; durationTicks: number; points: { x: number; y: number }[] }` ;
  `EventStateMessage { type; progress: number; cartX: number; cartY: number; cartHp: number }`
  (octets déjà quantifiés) ; `EventEndMessage { type; outcome: number }` ;
  `type EventMessage = EventStartMessage | EventStateMessage | EventEndMessage` ;
  `encodeEvent(msg: EventMessage): ArrayBuffer` ; `decode` rend les trois ;
  `EVENT_START_HEADER_BYTES = 5`, `EVENT_POINT_BYTES = 4`, `EVENT_STATE_BYTES = 7`,
  `EVENT_END_BYTES = 2`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`shared/protocol.test.ts` : ajouter
`import { EVENT_DURATION_TICKS, EVENT_KIND, EVENT_OUTCOME } from './evenements';` après l'import de
`./elements`, et à l'import de `./protocol` : `encodeEvent`, `EVENT_END_BYTES`,
`EVENT_POINT_BYTES`, `EVENT_START_HEADER_BYTES`, `EVENT_STATE_BYTES`, `type EventMessage`. Puis en
fin de fichier :

```ts
describe('etape 14 : EVENT_START, EVENT_STATE, EVENT_END', () => {
  it('trois identifiants neufs, juste apres PING_SHOWN', () => {
    expect([MSG.EVENT_START, MSG.EVENT_STATE, MSG.EVENT_END]).toEqual([28, 29, 30]);
  });

  it('le genre et l issue ont leurs valeurs du fil', () => {
    expect(EVENT_KIND).toEqual({ SCEAUX: 0, FORGE: 1, CONVOI: 2 });
    expect(EVENT_OUTCOME).toEqual({ REUSSI: 0, EXPIRE: 1, DETRUIT: 2 });
  });

  it('EVENT_START fait 5 + 4n octets — 9, 13, 21 — et revient a l identique', () => {
    expect(EVENT_START_HEADER_BYTES).toBe(5);
    expect(EVENT_POINT_BYTES).toBe(4);
    const tailles: number[] = [];
    for (const n of [1, 2, 4]) {
      const msg: EventMessage = {
        type: MSG.EVENT_START,
        kind: EVENT_KIND.SCEAUX,
        durationTicks: EVENT_DURATION_TICKS,
        points: Array.from({ length: n }, (_, i) => ({ x: 1000 + 800 * i, y: 5999 - i })),
      };
      const buf = encodeEvent(msg);
      tailles.push(buf.byteLength);
      expect(decode(buf)).toEqual(msg);
    }
    expect(tailles).toEqual([9, 13, 21]);
  });

  it('positions negatives et au plafond de l int16', () => {
    const msg: EventMessage = {
      type: MSG.EVENT_START,
      kind: EVENT_KIND.CONVOI,
      durationTicks: EVENT_DURATION_TICKS,
      points: [
        { x: -32_768, y: 32_767 },
        { x: 0, y: -1 },
      ],
    };
    expect(decode(encodeEvent(msg))).toEqual(msg);
  });

  it('EVENT_STATE fait 7 octets et revient a l identique', () => {
    expect(EVENT_STATE_BYTES).toBe(7);
    const msg: EventMessage = {
      type: MSG.EVENT_STATE,
      progress: 254,
      cartX: -12,
      cartY: 5999,
      cartHp: 1,
    };
    const buf = encodeEvent(msg);
    expect(buf.byteLength).toBe(7);
    expect(decode(buf)).toEqual(msg);
  });

  it('EVENT_END fait 2 octets et revient a l identique', () => {
    expect(EVENT_END_BYTES).toBe(2);
    const msg: EventMessage = { type: MSG.EVENT_END, outcome: EVENT_OUTCOME.DETRUIT };
    const buf = encodeEvent(msg);
    expect(buf.byteLength).toBe(2);
    expect(decode(buf)).toEqual(msg);
  });

  it('un EVENT_START tronque au milieu d un point leve, il ne rend pas des points fantaisistes', () => {
    const buf = encodeEvent({
      type: MSG.EVENT_START,
      kind: EVENT_KIND.SCEAUX,
      durationTicks: EVENT_DURATION_TICKS,
      points: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    });
    expect(() => decode(buf.slice(0, 11))).toThrow(/tronque/);
    expect(() => decode(buf.slice(0, 4))).toThrow(/tronque/);
  });

  it('EVENT_STATE et EVENT_END tronques levent aussi', () => {
    const etat = encodeEvent({ type: MSG.EVENT_STATE, progress: 1, cartX: 2, cartY: 3, cartHp: 4 });
    expect(() => decode(etat.slice(0, 6))).toThrow(/tronque/);
    const fin = encodeEvent({ type: MSG.EVENT_END, outcome: 0 });
    expect(() => decode(fin.slice(0, 1))).toThrow(/tronque/);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run ../shared/protocol.test.ts -t "etape 14"`
Attendu : ÉCHEC — `encodeEvent` non exporté, `MSG.EVENT_START` indéfini.

- [ ] **Étape 3 : implémenter**

`shared/protocol.ts` :

1. `MSG`, après `PING_SHOWN: 27,` :

```ts
  EVENT_START: 28,
  EVENT_STATE: 29,
  EVENT_END: 30,
```

2. Union `Message`, après `| PingShownMessage` : `| EventStartMessage | EventStateMessage | EventEndMessage`
   (le `;` final reste à la dernière ligne).

3. Dans `decode`, avant `default:` :

```ts
    case MSG.EVENT_START:
      return decodeEventStart(buf);
    case MSG.EVENT_STATE:
      return decodeEventState(buf);
    case MSG.EVENT_END:
      return decodeEventEnd(buf);
```

4. En fin de fichier :

```ts
/**
 * S -> C : un evenement bonus commence (etape 14, §6.1), `5 + 4n` octets.
 *
 * `type u8 · genre u8 · duree u16 · n u8 · n x (x i16, y i16)`
 *
 * ⚠️ **Une DUREE en ticks vivants, jamais une echeance datee.** Le tick du
 * salon avance pendant le gel, l'evenement non : une echeance absolue serait
 * fausse des le premier etalage. Le client pose la sienne sur `pingClock`, qui
 * dort exactement quand l'evenement dort.
 *
 * Les points : les sceaux, la forge, ou le depart puis l'arrivee du convoi. Le
 * client ne recalcule aucun placement. Aucun tick dans ces trois messages : ils
 * ne touchent pas la simulation du client, ils s'affichent a la reception.
 */
export interface EventStartMessage {
  type: typeof MSG.EVENT_START;
  /** `EVENT_KIND`. */
  kind: number;
  durationTicks: number;
  points: { x: number; y: number }[];
}

/**
 * S -> C : ou en est l'evenement, a 5 Hz et seulement pendant un evenement, 7
 * octets. `type u8 · progression u8 · chariot x i16 · chariot y i16 · pv u8`.
 * Octets DEJA quantifies par le salon : progression `floor(255 x fraction)`,
 * PV `ceil(255 x pv / pvMax)` (0 seulement detruit). Zeros hors convoi : un
 * format fixe vaut mieux que trois.
 */
export interface EventStateMessage {
  type: typeof MSG.EVENT_STATE;
  progress: number;
  cartX: number;
  cartY: number;
  cartHp: number;
}

/** S -> C : l'evenement s'acheve, 2 octets. `outcome` : `EVENT_OUTCOME`. */
export interface EventEndMessage {
  type: typeof MSG.EVENT_END;
  outcome: number;
}

export type EventMessage = EventStartMessage | EventStateMessage | EventEndMessage;

export const EVENT_START_HEADER_BYTES = 5;
export const EVENT_POINT_BYTES = 4;
export const EVENT_STATE_BYTES = 7;
export const EVENT_END_BYTES = 2;

/** Encode l'un des trois messages d'evenement : le salon les met en file tels quels. */
export function encodeEvent(msg: EventMessage): ArrayBuffer {
  if (msg.type === MSG.EVENT_START) {
    const buf = new ArrayBuffer(EVENT_START_HEADER_BYTES + msg.points.length * EVENT_POINT_BYTES);
    const v = new DataView(buf);
    v.setUint8(0, MSG.EVENT_START);
    v.setUint8(1, msg.kind);
    v.setUint16(2, msg.durationTicks, true);
    v.setUint8(4, msg.points.length);
    msg.points.forEach((p, i) => {
      const o = EVENT_START_HEADER_BYTES + i * EVENT_POINT_BYTES;
      v.setInt16(o, Math.round(p.x), true);
      v.setInt16(o + 2, Math.round(p.y), true);
    });
    return buf;
  }
  if (msg.type === MSG.EVENT_STATE) {
    const buf = new ArrayBuffer(EVENT_STATE_BYTES);
    const v = new DataView(buf);
    v.setUint8(0, MSG.EVENT_STATE);
    v.setUint8(1, msg.progress);
    v.setInt16(2, Math.round(msg.cartX), true);
    v.setInt16(4, Math.round(msg.cartY), true);
    v.setUint8(6, msg.cartHp);
    return buf;
  }
  const buf = new ArrayBuffer(EVENT_END_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.EVENT_END);
  v.setUint8(1, msg.outcome);
  return buf;
}

function decodeEventStart(buf: ArrayBuffer): EventStartMessage {
  // L'en-tete d'abord, puis la longueur qu'il ANNONCE : un message tronque au
  // milieu d'un point leve au lieu de rendre des positions fantaisistes.
  const head = viewOf(buf, EVENT_START_HEADER_BYTES);
  const n = head.getUint8(4);
  const v = viewOf(buf, EVENT_START_HEADER_BYTES + n * EVENT_POINT_BYTES);
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const o = EVENT_START_HEADER_BYTES + i * EVENT_POINT_BYTES;
    points.push({ x: v.getInt16(o, true), y: v.getInt16(o + 2, true) });
  }
  return {
    type: MSG.EVENT_START,
    kind: v.getUint8(1),
    durationTicks: v.getUint16(2, true),
    points,
  };
}

function decodeEventState(buf: ArrayBuffer): EventStateMessage {
  const v = viewOf(buf, EVENT_STATE_BYTES);
  return {
    type: MSG.EVENT_STATE,
    progress: v.getUint8(1),
    cartX: v.getInt16(2, true),
    cartY: v.getInt16(4, true),
    cartHp: v.getUint8(6),
  };
}

function decodeEventEnd(buf: ArrayBuffer): EventEndMessage {
  const v = viewOf(buf, EVENT_END_BYTES);
  return { type: MSG.EVENT_END, outcome: v.getUint8(1) };
}
```

- [ ] **Étape 4 : les relancer, ils passent ; typecheck**

Run : `cd back && npx vitest run ../shared/protocol.test.ts ../shared/lobby.test.ts`
Attendu : PASS (`lobby.test.ts` garde « les identifiants de message restent deux à deux
distincts »).
Run : `npm run typecheck`
Attendu : aucune erreur.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write shared/protocol.ts shared/protocol.test.ts
git add shared/protocol.ts shared/protocol.test.ts
git commit -m "feat(shared): trois messages pour les evenements, depart, etat et fin"
```

---

### Tâche 3 : le directeur marque l'événement, sans un tirage de plus

**Fichiers :**
- Modifier : `back/src/wave-director.ts` (après `PORTEUR_SPAWN_DISTANCE` l.367 ; champs après
  `#porteurEnJeu` l.402 ; après `#avecPorteur` l.477-502 ; `dueWave` l.584 et l.620)
- Tester : `back/src/wave-director.test.ts` (imports l.1-24 ; nouveau `describe` en fin de fichier)

**Interfaces :**
- Consomme : `EVENT_DURATION_TICKS` (tâche 1), dans le test.
- Produit : `EVENT_WAVE_IN_PALIER = 3`, `EVENT_MIN_GAP_WAVES = 40`, `EVENT_FIRST_WAVE` (= 20)
  exportés de `back/src/wave-director.ts` ; `WaveDirector.takeEventSeed(): number | null` (rend la
  graine de l'événement dû à la dernière vague, `(principal.seed ^ 0x2c9e_7d43) >>> 0`, puis
  l'oublie).

- [ ] **Étape 1 : écrire les tests qui échouent**

`back/src/wave-director.test.ts` : ajouter `import { EVENT_DURATION_TICKS } from '@shared/evenements';`
après l'import de `@shared/constants`, et `EVENT_FIRST_WAVE`, `EVENT_MIN_GAP_WAVES`,
`EVENT_WAVE_IN_PALIER` à l'import de `./wave-director`. Puis en fin de fichier :

```ts
describe('etape 14 : le directeur marque les evenements, sans tirage de plus', () => {
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

  interface Marque {
    /** Numero de la vague (1 pour la premiere). */
    numero: number;
    tick: number;
    graine: number;
    /** Graine de l'ordre principal de la vague. */
    principal: number;
  }

  /**
   * Les `vagues` premieres vagues d'un directeur, boss abattu a son
   * apparition, porteur rendu a la sienne : les evenements marques. Hors
   * vague, `takeEventSeed` doit rendre `null`.
   */
  function marques(seed: number, vagues: number): Marque[] {
    const d = new WaveDirector(seed);
    const out: Marque[] = [];
    let n = 0;
    for (let tick = 0; n < vagues; tick++) {
      const g = d.dueWave(tick, [3000], [3000]);
      if (g.length === 0) {
        expect(d.takeEventSeed()).toBeNull();
        continue;
      }
      n++;
      if (d.bossWaveId === g[0]?.waveId) {
        d.bossDefeated();
      }
      if (g.some(estPorteur)) {
        d.porteurGone();
      }
      const graine = d.takeEventSeed();
      if (graine !== null) {
        out.push({ numero: n, tick, graine, principal: g[0]?.seed ?? 0 });
      }
    }
    return out;
  }

  it('les constantes de la spec, le seuil de 2 min ecrit en formule', () => {
    expect(EVENT_WAVE_IN_PALIER).toBe(3);
    expect(EVENT_MIN_GAP_WAVES).toBe(40);
    expect(EVENT_FIRST_WAVE).toBe(20);
  });

  /**
   * Le boss tombe a son apparition : un palier toutes les cinq vagues, sa 3e
   * vague est la 5p + 3. Rien aux vagues 3, 8, 13 et 18 (avant la 20e), puis
   * la premiere 3e vague a partir de 20 — la 23e —, puis rien avant 40 vagues.
   */
  it('aux vagues 23, 63 et 103 : jamais avant la 20e, jamais a moins de 40 vagues', () => {
    expect(marques(5, 120).map((m) => m.numero)).toEqual([23, 63, 103]);
  });

  it('la graine se DERIVE de l ordre principal, par un autre masque que le porteur', () => {
    const ms = marques(5, 70);
    expect(ms.length).toBeGreaterThan(0);
    for (const m of ms) {
      expect(m.graine).toBe((m.principal ^ 0x2c9e_7d43) >>> 0);
      expect(m.graine).not.toBe((m.principal ^ 0x5f3a_c0f1) >>> 0);
    }
  });

  it('takeEventSeed rend la graine une fois, null a la seconde lecture', () => {
    const d = new WaveDirector(5);
    let vues = 0;
    for (let tick = 0; vues === 0 && tick < 200 * TICK_HZ; tick++) {
      const g = d.dueWave(tick, [3000], [3000]);
      if (g.length > 0 && d.bossWaveId === g[0]?.waveId) {
        d.bossDefeated();
      }
      if (g.some(estPorteur)) {
        d.porteurGone();
      }
      if (d.takeEventSeed() !== null) {
        vues++;
        expect(d.takeEventSeed()).toBeNull();
      }
    }
    expect(vues).toBe(1);
  });

  /**
   * ⚠️ **Au plus un a la fois, par le seul plancher** (§2.1) : un evenement
   * dure au plus `EVENT_DURATION_TICKS` ticks vivants, et les vagues ne
   * tombent que sur des ticks vivants (pas pendant un gel). Deux marques
   * sont donc toujours separees de plus que cette duree.
   */
  it('deux evenements sont separes de plus d EVENT_DURATION_TICKS ticks : jamais deux en jeu', () => {
    const ms = marques(5, 200);
    expect(ms.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < ms.length; i++) {
      expect((ms[i]?.tick ?? 0) - (ms[i - 1]?.tick ?? 0)).toBeGreaterThan(EVENT_DURATION_TICKS);
    }
  });

  /**
   * ⚠️ **Aucun tirage, aucun `waveId` de plus** (§2.1) : l'empreinte de TOUS
   * les ordres — `waveId` et porteur compris — a ete RELEVEE sur `76613ab`
   * avant l'etape, avec exactement ce decor (celui du test d'empreinte de
   * l'etape 11, qui, lui, laisse le `waveId` de cote).
   */
  it('tous les ordres, waveId compris, sont bit-identiques a ceux d avant l etape', () => {
    const d = new WaveDirector(5);
    const rows: number[][] = [];
    let ordinaires = 0;
    let evenements = 0;
    for (let tick = 0; tick < TICK_HZ * 600; tick++) {
      const g = d.dueWave(tick, [3000, 2000], [3000, 4000], 1 + Math.floor(ordinaires / 3));
      if (g.length > 0 && d.bossWaveId === g[0]?.waveId) {
        d.bossDefeated();
      }
      if (g.some(estPorteur)) {
        d.porteurGone();
      }
      if (d.takeEventSeed() !== null) {
        evenements++;
      }
      for (const o of g) {
        rows.push([
          o.waveId,
          o.spawnTick,
          o.seed,
          o.archetype,
          o.formation,
          o.anchorX,
          o.anchorY,
          o.count,
        ]);
      }
      ordinaires += g.filter((o) => !estPorteur(o)).length;
    }
    // Non-vacuite : des evenements sont bien sortis pendant la mesure.
    expect(evenements).toBeGreaterThanOrEqual(2);
    expect(rows).toHaveLength(161);
    expect(fnv1a(JSON.stringify(rows))).toBe(3_330_581_021);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run src/wave-director.test.ts -t "etape 14"`
Attendu : ÉCHEC — `EVENT_WAVE_IN_PALIER` non exporté, `takeEventSeed` n'existe pas.

- [ ] **Étape 3 : implémenter**

`back/src/wave-director.ts`, après `PORTEUR_SPAWN_DISTANCE` (l.367) :

```ts
/**
 * Les evenements bonus (etape 14, §2.1) : marques a la 3e vague (groupe) d'un
 * palier, boss compris dans le compte — le porteur vient a la 2e.
 */
export const EVENT_WAVE_IN_PALIER = 3;

/** ...jamais a moins de 40 vagues (40 x 6 s = 4 min) du precedent. */
export const EVENT_MIN_GAP_WAVES = 40;

/**
 * ...et pas avant la vague qui tombe, au plus tot, a 2 min de jeu (decision
 * de Leo). Une vague n tombe au plus tot au tick `n x PERIOD_TICKS` ; un gel
 * retarde les vagues, jamais ne les avance. ⚠️ **Ecrit en formule** : si la
 * cadence des vagues change, le seuil suit. C'est un MINIMUM : le premier
 * evenement est a la premiere 3e vague de palier a partir de celle-ci.
 */
export const EVENT_FIRST_WAVE = Math.ceil((120 * TICK_HZ) / PERIOD_TICKS);
```

Après `#porteurEnJeu = false;` (l.402) :

```ts
  /** `#waveNumber` du dernier evenement marque. */
  #lastEventWave = Number.NEGATIVE_INFINITY;
  /**
   * La graine de l'evenement du a la derniere vague, lue UNE fois par le
   * salon (`takeEventSeed`). ⚠️ **Pas de `#evenementEnJeu`, contrairement au
   * porteur** : un evenement dure au plus `EVENT_DURATION_TICKS` ticks
   * vivants (11 vagues au plus), loin des 40 du plancher — un second garde
   * serait de ceux qu'aucun test ne tient.
   */
  #eventSeed: number | null = null;
```

Après `#avecPorteur` (fin l.502) :

```ts
  /**
   * Marque un evenement si la vague qui sort le doit. ⚠️ **Aucun tirage dans
   * `#rng`, et pas meme un `waveId`** : un evenement n'est pas un ordre de
   * vague, et sa graine se DERIVE de celle de l'ordre principal, deja tiree,
   * par un autre masque que celui du porteur. Le lieu, le genre et l'etat
   * vivent dans le salon, qui seul connait les joueurs vivants et les murs.
   */
  #marquerEvenement(principal: WaveOrder | undefined): void {
    if (
      !principal ||
      this.#waveNumber < EVENT_FIRST_WAVE ||
      this.#wavesSincePalier !== EVENT_WAVE_IN_PALIER ||
      this.#waveNumber - this.#lastEventWave < EVENT_MIN_GAP_WAVES
    ) {
      return;
    }
    this.#lastEventWave = this.#waveNumber;
    this.#eventSeed = (principal.seed ^ 0x2c9e_7d43) >>> 0;
  }

  /** La graine de l'evenement du a cette vague, ou `null` ; la lit et l'oublie. */
  takeEventSeed(): number | null {
    const s = this.#eventSeed;
    this.#eventSeed = null;
    return s;
  }
```

Dans `dueWave`, `return this.#avecPorteur([boss], tick, anchorX, anchorY);` (l.584) devient :

```ts
      this.#marquerEvenement(boss);
      return this.#avecPorteur([boss], tick, anchorX, anchorY);
```

et `return this.#avecPorteur(out, tick, anchorX, anchorY);` (l.620) devient :

```ts
    this.#marquerEvenement(out[0]);
    return this.#avecPorteur(out, tick, anchorX, anchorY);
```

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run src/wave-director.test.ts`
Attendu : PASS — le test d'empreinte de l'étape 11 (`761_168_326`) compris.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write back/src/wave-director.ts back/src/wave-director.test.ts
git add back/src/wave-director.ts back/src/wave-director.test.ts
git commit -m "feat(back): le directeur marque un evenement a la 3e vague du palier, sans tirage de plus"
```

---

### Tâche 4 : les règles — placement et pas des trois événements, purs

**Fichiers :**
- Créer : `back/src/evenement.ts`, `back/src/evenement.test.ts`
- Modifier : `shared/waves.ts` (`function nudgeOutOfObstacle` l.112 devient `export function`)

**Interfaces :**
- Consomme : `EVENT_KIND`, `EVENT_OUTCOME`, `EVENT_DURATION_TICKS`, `SCEAU_RADIUS`,
  `FORGE_RADIUS`, `CONVOI_ESCORT_RADIUS`, `CONVOI_RADIUS` (tâche 1).
- Produit (`back/src/evenement.ts`) : les constantes serveur des Contraintes globales ;
  `interface EventPoint { x: number; y: number }` ;
  `interface EventPlan { kind: number; points: EventPoint[]; solo: boolean }` ;
  `interface EventPlayer { readonly x; readonly y; readonly hp; readonly moveX; readonly moveY }`
  (tous `number` — `PlayerState` les a) ;
  `interface EventHorde { readonly count: number; readonly x: Float32Array; readonly y: Float32Array }`
  (`Horde` la satisfait) ;
  `placeEvent(seed: number, vivants: readonly { x: number; y: number }[], obstacles: ObstacleField): EventPlan` ;
  `class EventRun` : `constructor(plan: EventPlan, field: FlowField)` (un convoi y fait son BFS
  unique), `readonly kind`, `readonly points`, `readonly cart: EventPoint`, `readonly cartHpMax`,
  `get elapsed(): number`, `get cartHp(): number`, `get progress(): number` (0-1),
  `step(players: readonly EventPlayer[], horde: EventHorde, dt: number): number | null`
  (`null` tant qu'il continue, sinon une `EVENT_OUTCOME`),
  `wireState(): { progress: number; cartX: number; cartY: number; cartHp: number }` (octets).

- [ ] **Étape 1 : écrire les tests qui échouent**

`back/src/evenement.test.ts` (créé) :

```ts
import { FLOWFIELD_CELL, MAP_SIZE, TICK_HZ } from '@shared/constants';
import {
  CONVOI_ESCORT_RADIUS,
  EVENT_DURATION_TICKS,
  EVENT_KIND,
  EVENT_OUTCOME,
  FORGE_RADIUS,
  SCEAU_RADIUS,
} from '@shared/evenements';
import { FlowField } from '@shared/flowfield';
import { describe, expect, it } from 'vitest';

import {
  CONVOI_CONTACT_RADIUS,
  CONVOI_DISTANCE,
  CONVOI_HP,
  CONVOI_HP_SOLO,
  CONVOI_SPEED,
  EVENT_SPAWN_DISTANCE,
  type EventHorde,
  type EventPlan,
  type EventPlayer,
  EventRun,
  FORGE_HOLD_TICKS,
  FORGE_HOLD_TICKS_SOLO,
  placeEvent,
  SCEAUX_HOLD_TICKS,
  SCEAUX_SPACING,
} from './evenement';

const DT = 1 / TICK_HZ;

/** Une carte sans un mur : la geometrie seule. */
const ouvert = (): FlowField => new FlowField(MAP_SIZE, FLOWFIELD_CELL);

/** Une graine du genre voulu, a angle varie. */
function graine(genre: number, k: number): number {
  const s = (Math.imul(k + 1, 0x9e37_79b9) >>> 0) % 0xffff_fff0;
  return s - (s % 3) + genre;
}

function joueur(x: number, y: number, extra: Partial<EventPlayer> = {}): EventPlayer {
  return { x, y, hp: 100, moveX: 0, moveY: 0, ...extra };
}

function horde(points: readonly { x: number; y: number }[]): EventHorde {
  return {
    count: points.length,
    x: Float32Array.from(points.map((p) => p.x)),
    y: Float32Array.from(points.map((p) => p.y)),
  };
}
const PERSONNE = horde([]);

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** Fait `n` pas ; rend la premiere issue, ou `null`. */
function pas(run: EventRun, n: number, joueurs: readonly EventPlayer[], h = PERSONNE): number | null {
  for (let i = 0; i < n; i++) {
    const issue = run.step(joueurs, h, DT);
    if (issue !== null) {
      return issue;
    }
  }
  return null;
}

describe('etape 14 : placeEvent', () => {
  const equipe = [
    { x: 2900, y: 3000 },
    { x: 3100, y: 3000 },
  ];

  it('le genre est graine % 3', () => {
    for (let s = 0; s < 300; s++) {
      expect(placeEvent(s, equipe, ouvert()).kind).toBe(s % 3);
    }
  });

  it('le site est a EVENT_SPAWN_DISTANCE du CENTRE des vivants, dans la direction de la graine', () => {
    for (let k = 0; k < 200; k++) {
      const s = graine(EVENT_KIND.FORGE, k);
      const plan = placeEvent(s, equipe, ouvert());
      const theta = ((s >>> 8) / 0x100_0000) * Math.PI * 2;
      const site = plan.points[0] ?? { x: 0, y: 0 };
      expect(plan.points).toHaveLength(1);
      expect(Math.abs(site.x - (3000 + Math.cos(theta) * EVENT_SPAWN_DISTANCE))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(site.y - (3000 + Math.sin(theta) * EVENT_SPAWN_DISTANCE))).toBeLessThanOrEqual(0.5);
      expect(Number.isInteger(site.x) && Number.isInteger(site.y)).toBe(true);
    }
  });

  it('les sceaux : un en solo, N a SCEAUX_SPACING de leurs voisins pour N = 2, 3, 4', () => {
    expect(placeEvent(graine(EVENT_KIND.SCEAUX, 1), [{ x: 3000, y: 3000 }], ouvert()).points).toHaveLength(1);
    for (const n of [2, 3, 4]) {
      const vivants = Array.from({ length: n }, () => ({ x: 3000, y: 3000 }));
      for (let k = 0; k < 50; k++) {
        const plan = placeEvent(graine(EVENT_KIND.SCEAUX, k), vivants, ouvert());
        expect(plan.points).toHaveLength(n);
        expect(plan.solo).toBe(false);
        for (let i = 0; i < n; i++) {
          const a = plan.points[i] ?? { x: 0, y: 0 };
          const b = plan.points[(i + 1) % n] ?? { x: 0, y: 0 };
          expect(Math.abs(dist(a, b) - SCEAUX_SPACING)).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('le convoi : depart au site, arrivee a CONVOI_DISTANCE vers le centre de la carte, et dans la carte', () => {
    for (const centre of [
      { x: 3000, y: 3000 },
      { x: 50, y: 50 },
      { x: 5950, y: 120 },
    ]) {
      for (let k = 0; k < 100; k++) {
        const plan = placeEvent(graine(EVENT_KIND.CONVOI, k), [centre], ouvert());
        const [s, e] = plan.points;
        if (!s || !e) {
          throw new Error('le convoi a deux points');
        }
        expect(Math.abs(dist(s, e) - CONVOI_DISTANCE)).toBeLessThanOrEqual(1);
        // Vers le centre : E est plus pres du milieu de la carte que S.
        expect(dist(e, { x: MAP_SIZE / 2, y: MAP_SIZE / 2 })).toBeLessThan(
          dist(s, { x: MAP_SIZE / 2, y: MAP_SIZE / 2 }) + 1,
        );
      }
    }
  });

  it('pres d un coin : chaque point dans la carte, entier (il voyage en int16)', () => {
    for (let s = 0; s < 300; s++) {
      for (const p of placeEvent(s, [{ x: 30, y: 30 }, { x: 60, y: 10 }], ouvert()).points) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(MAP_SIZE);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(MAP_SIZE);
        expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
      }
    }
  });

  it('un site mure est sorti du mur, dans une cellule libre toute proche', () => {
    const s = graine(EVENT_KIND.FORGE, 7);
    const libre = placeEvent(s, equipe, ouvert()).points[0] ?? { x: 0, y: 0 };
    const mure = ouvert();
    mure.block(Math.floor(libre.x / FLOWFIELD_CELL), Math.floor(libre.y / FLOWFIELD_CELL));
    const sorti = placeEvent(s, equipe, mure).points[0] ?? { x: 0, y: 0 };
    expect(mure.blocked[mure.indexAt(sorti.x, sorti.y)]).toBe(0);
    expect(dist(sorti, libre)).toBeLessThanOrEqual(3 * FLOWFIELD_CELL);
  });

  it('sans vivant, le plan reste defini (jamais NaN) — le salon ne l appelle pas, mais rien ne casse', () => {
    for (const p of placeEvent(graine(EVENT_KIND.SCEAUX, 3), [], ouvert()).points) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe('etape 14 : EventRun — les trois sceaux', () => {
  const plan: EventPlan = {
    kind: EVENT_KIND.SCEAUX,
    points: [
      { x: 1000, y: 1000 },
      { x: 1800, y: 1000 },
    ],
    solo: false,
  };

  it('tous tenus, ca avance ; un vide SUSPEND sans remettre a zero', () => {
    const run = new EventRun(plan, ouvert());
    const a = joueur(1000, 1000 + SCEAU_RADIUS);
    const b = joueur(1800, 1000);
    expect(pas(run, SCEAUX_HOLD_TICKS / 2, [a, b])).toBeNull();
    expect(run.progress).toBeCloseTo(0.5, 5);
    // B quitte son sceau : rien ne bouge, rien ne redescend.
    expect(pas(run, 100, [a, joueur(2500, 1000)])).toBeNull();
    expect(run.progress).toBeCloseTo(0.5, 5);
    expect(pas(run, SCEAUX_HOLD_TICKS / 2, [a, b])).toBe(EVENT_OUTCOME.REUSSI);
    expect(run.progress).toBe(1);
  });

  it('un mort n occupe pas ; deux joueurs dans le meme sceau n en valent qu un', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 60, [joueur(1000, 1000), joueur(1800, 1000, { hp: 0 })]);
    pas(run, 60, [joueur(1000, 1000), joueur(1010, 1000)]);
    expect(run.progress).toBe(0);
  });

  it('s eteint a EVENT_DURATION_TICKS ticks, pas un de moins', () => {
    const run = new EventRun(plan, ouvert());
    expect(pas(run, EVENT_DURATION_TICKS - 1, [])).toBeNull();
    expect(run.step([], PERSONNE, DT)).toBe(EVENT_OUTCOME.EXPIRE);
  });

  it('wireState : progression floor(255 x fraction), zeros hors convoi', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, SCEAUX_HOLD_TICKS / 2, [joueur(1000, 1000), joueur(1800, 1000)]);
    expect(run.wireState()).toEqual({ progress: 127, cartX: 0, cartY: 0, cartHp: 0 });
  });
});

describe('etape 14 : EventRun — la forge', () => {
  const forge = { x: 2000, y: 2000 };
  const duo: EventPlan = { kind: EVENT_KIND.FORGE, points: [forge], solo: false };
  const solo: EventPlan = { ...duo, solo: true };

  it('immobile dans le rayon : 30 s a plusieurs, 15 s seul', () => {
    expect(pas(new EventRun(duo, ouvert()), FORGE_HOLD_TICKS - 1, [joueur(2000, 2000 + FORGE_RADIUS)])).toBeNull();
    const run = new EventRun(duo, ouvert());
    expect(pas(run, FORGE_HOLD_TICKS, [joueur(2000, 2000)])).toBe(EVENT_OUTCOME.REUSSI);
    expect(pas(new EventRun(solo, ouvert()), FORGE_HOLD_TICKS_SOLO, [joueur(2000, 2000)])).toBe(
      EVENT_OUTCOME.REUSSI,
    );
  });

  it('immobile se lit sur l ENTREE : moveX 0,2 suspend, une derive de stick sous 20 px/s non', () => {
    const run = new EventRun(duo, ouvert());
    pas(run, 90, [joueur(2000, 2000, { moveX: 0.2 })]);
    expect(run.progress).toBe(0);
    pas(run, 90, [joueur(2000, 2000, { moveX: 0.07 })]);
    expect(run.progress).toBeCloseTo(90 / FORGE_HOLD_TICKS, 5);
  });

  it('pousse sans entree (un gardien, la horde), il canalise encore', () => {
    const run = new EventRun(duo, ouvert());
    for (let i = 0; i < 60; i++) {
      run.step([joueur(2000 + (i % 40), 2000)], PERSONNE, DT);
    }
    expect(run.progress).toBeCloseTo(60 / FORGE_HOLD_TICKS, 5);
  });

  it('hors du rayon, ou mort, rien', () => {
    const run = new EventRun(duo, ouvert());
    pas(run, 60, [joueur(2000 + FORGE_RADIUS + 1, 2000), joueur(2000, 2000, { hp: 0 })]);
    expect(run.progress).toBe(0);
  });
});

describe('etape 14 : EventRun — le convoi', () => {
  const S = { x: 1000, y: 3000 };
  const E = { x: 1000 + CONVOI_DISTANCE, y: 3000 };
  const plan: EventPlan = { kind: EVENT_KIND.CONVOI, points: [S, E], solo: false };

  it('sans escorte il attend ; escorte, il avance de CONVOI_SPEED px/s', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 30, [joueur(S.x, S.y + CONVOI_ESCORT_RADIUS + 1)]);
    expect(run.cart).toEqual(S);
    pas(run, 30, [joueur(S.x, S.y + 100)]);
    // Le champ melange ses cellules voisines : le pas fait 2 px, la route n'est pas une regle.
    expect(dist(run.cart, S)).toBeCloseTo(CONVOI_SPEED, 0);
    expect(run.cart.x).toBeGreaterThan(S.x);
  });

  it('escorte jusqu au bout : reussi a l arrivee, progression 1', () => {
    const run = new EventRun(plan, ouvert());
    let issue: number | null = null;
    for (let t = 0; t < EVENT_DURATION_TICKS && issue === null; t++) {
      issue = run.step([joueur(run.cart.x, run.cart.y)], PERSONNE, DT);
    }
    expect(issue).toBe(EVENT_OUTCOME.REUSSI);
    expect(run.progress).toBe(1);
    // 1 500 px a 60 px/s : 25 s au mieux ; le melange du champ peut allonger un peu la route.
    expect(run.elapsed).toBeLessThanOrEqual(30 * TICK_HZ);
  });

  /**
   * ⚠️ **Un mur EN TRAVERS** : la ligne droite le traverse, `moveOnMap` seul
   * collerait le chariot contre lui. Le champ de flux le fait contourner, et
   * `moveOnMap` l'empeche d'y entrer.
   */
  it('contourne un mur en travers de la route, sans jamais y entrer', () => {
    const terrain = ouvert();
    for (let cx = 27; cx <= 28; cx++) {
      for (let cy = 39; cy <= 54; cy++) {
        terrain.block(cx, cy);
      }
    }
    const run = new EventRun(plan, terrain);
    let issue: number | null = null;
    for (let t = 0; t < EVENT_DURATION_TICKS && issue === null; t++) {
      issue = run.step([joueur(run.cart.x, run.cart.y)], PERSONNE, DT);
      expect(terrain.blocked[terrain.indexAt(run.cart.x, run.cart.y)]).toBe(0);
    }
    expect(issue).toBe(EVENT_OUTCOME.REUSSI);
  });

  it('cinq ennemis colles ou cinquante coutent pareil : 5 x 8 PV toutes les 15 ticks', () => {
    const cinq = new EventRun(plan, ouvert());
    pas(cinq, 15, [], horde(Array.from({ length: 5 }, () => S)));
    const cinquante = new EventRun(plan, ouvert());
    pas(cinquante, 15, [], horde(Array.from({ length: 50 }, () => S)));
    const un = new EventRun(plan, ouvert());
    pas(un, 15, [], horde([{ x: S.x + CONVOI_CONTACT_RADIUS, y: S.y }]));
    expect(cinq.cartHp).toBe(CONVOI_HP - 40);
    expect(cinquante.cartHp).toBe(CONVOI_HP - 40);
    expect(un.cartHp).toBe(CONVOI_HP - 8);
    // Juste hors de portee : rien.
    const loin = new EventRun(plan, ouvert());
    pas(loin, 15, [], horde([{ x: S.x + CONVOI_CONTACT_RADIUS + 1, y: S.y }]));
    expect(loin.cartHp).toBe(CONVOI_HP);
  });

  it('detruit a 0 PV : 400 PV sous cinq ennemis, au 150e tick', () => {
    const run = new EventRun(plan, ouvert());
    const cinq = horde(Array.from({ length: 5 }, () => S));
    expect(pas(run, 149, [], cinq)).toBeNull();
    expect(run.step([], cinq, DT)).toBe(EVENT_OUTCOME.DETRUIT);
    expect(run.cartHp).toBe(0);
  });

  it('en solo : CONVOI_HP_SOLO PV, meme vitesse', () => {
    const run = new EventRun({ ...plan, solo: true }, ouvert());
    expect(run.cartHpMax).toBe(CONVOI_HP_SOLO);
    expect(pas(run, 150, [], horde(Array.from({ length: 5 }, () => S)))).toBeNull();
    expect(run.cartHp).toBe(CONVOI_HP_SOLO - 400);
  });

  it('wireState : la position arrondie et les PV en ceil(255 x pv / pvMax)', () => {
    const run = new EventRun(plan, ouvert());
    expect(run.wireState()).toEqual({ progress: 0, cartX: S.x, cartY: S.y, cartHp: 255 });
    pas(run, 15, [], horde([S]));
    expect(run.wireState().cartHp).toBe(Math.ceil((255 * (CONVOI_HP - 8)) / CONVOI_HP));
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run src/evenement.test.ts`
Attendu : ÉCHEC — `./evenement` introuvable.

- [ ] **Étape 3 : implémenter**

`shared/waves.ts` l.112 : `function nudgeOutOfObstacle(` devient `export function nudgeOutOfObstacle(`
(son docbloc dit déjà pourquoi elle écrit dans des tableaux).

`back/src/evenement.ts` (créé) :

```ts
import {
  CONTACT_DAMAGE,
  CONTACT_INTERVAL_TICKS,
  CONTACT_RADIUS,
  FLOWFIELD_CELL,
  MAP_SIZE,
  PLAYER_SPEED,
} from '@shared/constants';
import {
  CONVOI_ESCORT_RADIUS,
  CONVOI_RADIUS,
  EVENT_DURATION_TICKS,
  EVENT_KIND,
  EVENT_OUTCOME,
  FORGE_RADIUS,
  SCEAU_RADIUS,
} from '@shared/evenements';
import type { FlowField } from '@shared/flowfield';
import { nudgeOutOfObstacle, type ObstacleField } from '@shared/waves';
import { moveOnMap } from '@shared/worldmap';

/**
 * Les evenements bonus (etape 14), cote SERVEUR seul : ou ils naissent et
 * comment ils avancent. Aucun client ne place ni ne simule un evenement — il
 * lit ses points dans `EVENT_START` et son etat dans `EVENT_STATE`. Rien a
 * rejouer, donc rien a garder deterministe entre deux machines : seul le
 * salon fait foi.
 */

/** Distance entre le centre des vivants et le site (§2.2). Pres d'un bord, plus pres : le « ~ » du design. */
export const EVENT_SPAWN_DISTANCE = 1200;
/** Deux sceaux voisins sont a 800 px l'un de l'autre (rayons 400, 462, 566 px pour N = 2, 3, 4). */
export const SCEAUX_SPACING = 800;
/** 20 s CUMULEES : un sceau vide suspend la progression, il ne la fait pas redescendre. */
export const SCEAUX_HOLD_TICKS = 600;
export const FORGE_HOLD_TICKS = 900;
export const FORGE_HOLD_TICKS_SOLO = 450;
/**
 * Immobile se lit sur l'ENTREE, pas sur le deplacement (§3.2) : un joueur
 * pousse par un gardien ou la horde ne bouge pas de son fait. A la manette,
 * une derive de stick sous ~10/127 ne casse pas la canalisation. Et c'est sans
 * etat : aucune position du tick d'avant a retenir.
 */
export const FORGE_STILL_SPEED = 20;
export const CONVOI_DISTANCE = 1500;
/** 25 s de trajet au mieux, sur 60. */
export const CONVOI_SPEED = 60;
export const CONVOI_HP = 400;
export const CONVOI_HP_SOLO = 800;
export const CONVOI_CONTACT_RADIUS = CONVOI_RADIUS + CONTACT_RADIUS / 2;
export const CONVOI_CONTACT_DAMAGE = CONTACT_DAMAGE;
/** 16 PV/s pour un ennemi colle, 80 PV/s au plus : un chariot noye tient 5 s. */
export const CONVOI_MAX_HITTERS = 5;
export const CONVOI_ARRIVAL_RADIUS = 32;

export interface EventPoint {
  x: number;
  y: number;
}

/** Ce que `placeEvent` decide, et ce que `EVENT_START` transporte (plus `solo`, qui reste ici). */
export interface EventPlan {
  kind: number;
  /** Les sceaux ; la forge ; le depart puis l'arrivee du convoi. Entiers, dans la carte, hors mur. */
  points: EventPoint[];
  /** Un seul vivant au depart : forge en 15 s, chariot a 800 PV. FIGE pour tout l'evenement. */
  solo: boolean;
}

/** Ce qu'un evenement lit d'un joueur. `PlayerState` le satisfait tel quel. */
export interface EventPlayer {
  readonly x: number;
  readonly y: number;
  readonly hp: number;
  /** Axe d'entree normalise, dans [-1, 1] (`Room#applyInput`). */
  readonly moveX: number;
  readonly moveY: number;
}

/** Ce qu'un convoi lit de la horde. `Horde` le satisfait tel quel. */
export interface EventHorde {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
}

const sortieX = new Float32Array(1);
const sortieY = new Float32Array(1);

/** Borne a la carte, sort du mur, arrondit au pixel : le point voyage en `int16`. */
function poser(obstacles: ObstacleField, x: number, y: number): EventPoint {
  const bx = Math.min(MAP_SIZE, Math.max(0, x));
  const by = Math.min(MAP_SIZE, Math.max(0, y));
  nudgeOutOfObstacle(obstacles, bx, by, sortieX, sortieY, 0);
  return { x: Math.round(sortieX[0] ?? bx), y: Math.round(sortieY[0] ?? by) };
}

/**
 * Le genre et les points d'un evenement (§2.2). Le genre vient de `seed % 3`,
 * l'angle des bits `8..31` — disjoints. Le site est a `EVENT_SPAWN_DISTANCE`
 * du CENTRE des vivants (pas du joueur cible par la vague : l'evenement
 * s'adresse a l'equipe), puis borne et sorti des murs.
 *
 * ⚠️ **N sceaux pour N vivants**, pas « 3 a 4, 2 a 2 » : le design valide dit
 * « un sceau par joueur ». Sans vivant, le centre vaut (0, 0) : le salon ne
 * l'appelle pas ainsi, mais rien ici ne rend `NaN`.
 */
export function placeEvent(
  seed: number,
  vivants: readonly { x: number; y: number }[],
  obstacles: ObstacleField,
): EventPlan {
  const n = Math.max(1, vivants.length);
  let cx = 0;
  let cy = 0;
  for (const p of vivants) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  const kind = seed % 3;
  const theta = ((seed >>> 8) / 0x100_0000) * Math.PI * 2;
  const solo = vivants.length <= 1;
  const site = poser(
    obstacles,
    cx + Math.cos(theta) * EVENT_SPAWN_DISTANCE,
    cy + Math.sin(theta) * EVENT_SPAWN_DISTANCE,
  );
  if (kind === EVENT_KIND.SCEAUX && !solo) {
    const rayon = SCEAUX_SPACING / (2 * Math.sin(Math.PI / vivants.length));
    const points = vivants.map((_, k) => {
      const a = theta + (2 * Math.PI * k) / vivants.length;
      return poser(obstacles, site.x + Math.cos(a) * rayon, site.y + Math.sin(a) * rayon);
    });
    return { kind, points, solo };
  }
  if (kind !== EVENT_KIND.CONVOI) {
    return { kind, points: [site], solo };
  }
  // Le convoi va vers le centre de la carte : l'arrivee reste toujours dedans.
  let dx = MAP_SIZE / 2 - site.x;
  let dy = MAP_SIZE / 2 - site.y;
  let d = Math.hypot(dx, dy);
  if (d < 1) {
    dx = Math.cos(theta);
    dy = Math.sin(theta);
    d = 1;
  }
  const arrivee = poser(
    obstacles,
    site.x + (dx / d) * CONVOI_DISTANCE,
    site.y + (dy / d) * CONVOI_DISTANCE,
  );
  return { kind, points: [site, arrivee], solo };
}

/**
 * Un evenement en cours, cote serveur (§3). `step` rend `null` tant qu'il
 * continue, sinon son issue. Les joueurs a `hp <= 0` ne comptent JAMAIS — ni
 * occupant, ni forgeron, ni escorte.
 */
export class EventRun {
  readonly kind: number;
  readonly points: readonly EventPoint[];
  /** Le chariot (convoi) : sa position SERVEUR, que `EVENT_STATE` transporte. */
  readonly cart: EventPoint;
  readonly cartHpMax: number;
  #cartHp: number;
  #elapsed = 0;
  #held = 0;
  readonly #holdTicks: number;
  #arrived = false;
  readonly #trajet: number;
  readonly #field: FlowField;
  readonly #dir = new Float32Array(2);

  constructor(plan: EventPlan, field: FlowField) {
    this.kind = plan.kind;
    this.points = plan.points;
    this.#field = field;
    const depart = plan.points[0] ?? { x: 0, y: 0 };
    const arrivee = plan.points[1] ?? depart;
    this.cart = { x: depart.x, y: depart.y };
    this.cartHpMax = plan.solo ? CONVOI_HP_SOLO : CONVOI_HP;
    this.#cartHp = this.cartHpMax;
    this.#holdTicks =
      plan.kind === EVENT_KIND.FORGE
        ? plan.solo
          ? FORGE_HOLD_TICKS_SOLO
          : FORGE_HOLD_TICKS
        : SCEAUX_HOLD_TICKS;
    this.#trajet = Math.max(1, Math.hypot(arrivee.x - depart.x, arrivee.y - depart.y));
    if (plan.kind === EVENT_KIND.CONVOI) {
      // ⚠️ **UN SEUL BFS par convoi**, enracine sur l'arrivee : une ligne
      // droite peut traverser un mur ou de l'eau.
      field.update(arrivee.x, arrivee.y);
    }
  }

  /** Ticks VIVANTS ecoules : le salon n'appelle pas `step` pendant un gel ni pendant la rampe. */
  get elapsed(): number {
    return this.#elapsed;
  }

  get cartHp(): number {
    return this.#cartHp;
  }

  /** De 0 a 1. Le convoi : `1 - distance(chariot, E) / distance(S, E)`, borne ; 1 a l'arrivee. */
  get progress(): number {
    if (this.kind !== EVENT_KIND.CONVOI) {
      return Math.min(1, this.#held / this.#holdTicks);
    }
    if (this.#arrived) {
      return 1;
    }
    const e = this.points[1] ?? this.cart;
    const reste = Math.hypot(e.x - this.cart.x, e.y - this.cart.y);
    return Math.min(1, Math.max(0, 1 - reste / this.#trajet));
  }

  step(players: readonly EventPlayer[], horde: EventHorde, dt: number): number | null {
    this.#elapsed++;
    const vivants = players.filter((p) => p.hp > 0);
    if (this.kind === EVENT_KIND.CONVOI) {
      const issue = this.#stepConvoi(vivants, horde, dt);
      if (issue !== null) {
        return issue;
      }
    } else {
      if (this.#tenu(vivants)) {
        this.#held++;
      }
      if (this.#held >= this.#holdTicks) {
        return EVENT_OUTCOME.REUSSI;
      }
    }
    return this.#elapsed >= EVENT_DURATION_TICKS ? EVENT_OUTCOME.EXPIRE : null;
  }

  /** Les octets d'`EVENT_STATE`, deja quantifies (§6.1). Zeros hors convoi. */
  wireState(): { progress: number; cartX: number; cartY: number; cartHp: number } {
    const convoi = this.kind === EVENT_KIND.CONVOI;
    return {
      progress: Math.floor(255 * this.progress),
      cartX: convoi ? Math.round(this.cart.x) : 0,
      cartY: convoi ? Math.round(this.cart.y) : 0,
      cartHp: convoi ? Math.ceil((255 * this.#cartHp) / this.cartHpMax) : 0,
    };
  }

  /**
   * Sceaux : CHAQUE sceau a au moins un vivant (deux dans le meme n'en valent
   * qu'un). Forge : un vivant dans le rayon ET immobile a l'entree.
   */
  #tenu(vivants: readonly EventPlayer[]): boolean {
    if (this.kind === EVENT_KIND.SCEAUX) {
      return this.points.every((s) =>
        vivants.some((p) => Math.hypot(p.x - s.x, p.y - s.y) <= SCEAU_RADIUS),
      );
    }
    const f = this.points[0];
    if (!f) {
      return false;
    }
    return vivants.some(
      (p) =>
        Math.hypot(p.x - f.x, p.y - f.y) <= FORGE_RADIUS &&
        Math.hypot(p.moveX, p.moveY) * PLAYER_SPEED < FORGE_STILL_SPEED,
    );
  }

  #stepConvoi(vivants: readonly EventPlayer[], horde: EventHorde, dt: number): number | null {
    const e = this.points[1] ?? this.cart;
    // Il n'avance QUE s'il est escorte.
    if (vivants.some((p) => Math.hypot(p.x - this.cart.x, p.y - this.cart.y) <= CONVOI_ESCORT_RADIUS)) {
      let dx = e.x - this.cart.x;
      let dy = e.y - this.cart.y;
      const d = Math.hypot(dx, dy);
      // A moins d'une cellule, droit sur E : la cellule cible n'a pas de direction.
      this.#dir[0] = 0;
      this.#dir[1] = 0;
      if (d > FLOWFIELD_CELL) {
        this.#field.sampleDirection(this.cart.x, this.cart.y, this.#dir);
      }
      if ((this.#dir[0] ?? 0) !== 0 || (this.#dir[1] ?? 0) !== 0) {
        dx = this.#dir[0] ?? 0;
        dy = this.#dir[1] ?? 0;
      } else if (d > 0) {
        dx /= d;
        dy /= d;
      }
      const avance = Math.min(CONVOI_SPEED * dt, d);
      // ⚠️ Le pas passe par `moveOnMap`, la regle des joueurs : le champ dit
      // ou aller, `moveOnMap` garantit qu'il n'entre jamais dans un mur.
      const f = this.#field;
      const pos = moveOnMap(
        this.cart.x,
        this.cart.y,
        dx * avance,
        dy * avance,
        f.blocked,
        f.cols,
        f.rows,
        f.cellSize,
        MAP_SIZE,
      );
      this.cart.x = pos.x;
      this.cart.y = pos.y;
    }
    if (Math.hypot(e.x - this.cart.x, e.y - this.cart.y) <= CONVOI_ARRIVAL_RADIUS) {
      this.#arrived = true;
      return EVENT_OUTCOME.REUSSI;
    }
    // Les degats : le meme balayage lineaire que `resolveContact`, un seul
    // point, toutes les `CONTACT_INTERVAL_TICKS` ticks VIVANTS. La horde ne le
    // vise pas : il ne prend que ce qui le frole.
    if (this.#elapsed % CONTACT_INTERVAL_TICKS === 0) {
      const r2 = CONVOI_CONTACT_RADIUS * CONVOI_CONTACT_RADIUS;
      let n = 0;
      for (let i = 0; i < horde.count && n < CONVOI_MAX_HITTERS; i++) {
        const hx = (horde.x[i] ?? 0) - this.cart.x;
        const hy = (horde.y[i] ?? 0) - this.cart.y;
        if (hx * hx + hy * hy <= r2) {
          n++;
        }
      }
      this.#cartHp = Math.max(0, this.#cartHp - n * CONVOI_CONTACT_DAMAGE);
      if (this.#cartHp === 0) {
        return EVENT_OUTCOME.DETRUIT;
      }
    }
    return null;
  }
}
```

- [ ] **Étape 4 : les relancer, ils passent ; typecheck**

Run : `cd back && npx vitest run src/evenement.test.ts ../shared/waves.test.ts`
Attendu : PASS.
Run : `npm run typecheck -w back`
Attendu : aucune erreur.

> Si « contourne un mur » rougit parce que le chariot **s'immobilise** contre un coin (et non parce
> qu'il entre dans le mur), l'implémenteur ne change ni le mur ni la tolérance : il le rapporte avec
> la position où il s'est arrêté. C'est une question de réglage (ne pas suivre `sampleDirection`
> près d'un coin), à trancher par le contrôleur.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write back/src/evenement.ts back/src/evenement.test.ts shared/waves.ts
git add back/src/evenement.ts back/src/evenement.test.ts shared/waves.ts
git commit -m "feat(back): les trois evenements, leur placement et leurs regles, purs"
```

---

### Tâche 5 : le salon — l'événement vit, dort pendant le gel, et doit un étalage épique

**Fichiers :**
- Modifier : `back/src/room.ts` (import `@shared/protocol` l.69-75 ; import `@shared/rarity`
  l.77 ; imports locaux l.118-120 ; `#fields` l.395 ; après `#chestsOwed` l.506 ; constructeur
  l.613-620 ; après `drainPickups` l.713-717 ; après `debugOweLevels` l.1195-1198 ; ouverture
  l.1426-1429 ; fin de la boucle des ordres l.1600 ; avant `#checkRunOver()` l.1940 ;
  `#openDraft` l.2587-2617 ; après `#stepDraft` l.2652)
- Tester : `back/src/room.test.ts` (imports l.1-84 ; nouveau `describe` en fin de fichier)

**Interfaces :**
- Consomme : `EVENT_*` de `shared/evenements.ts`, `EVENT_RARITY_FLOOR` (tâche 1) ; `MSG`,
  `EventMessage` (tâche 2) ; `WaveDirector.takeEventSeed()` (tâche 3) ; `placeEvent`, `EventRun`
  (tâche 4).
- Produit : `Room.drainEvents(): EventMessage[]` (ordre de mise en file : un départ précède ses
  états, qui précèdent sa fin) ; `get eventPoints(): readonly { x: number; y: number }[] | null` ;
  écritures de test `debugStartEvent(seed: number): void` et `debugOweChests(n: number): void`.
  Un événement réussi met `EVENT_END { outcome: REUSSI }` en file et doit un étalage : au tick
  suivant, un `LevelUpEvent` au niveau d'avant puis un `DraftOpenEvent` dont toutes les cartes
  ont `rarity >= EVENT_RARITY_FLOOR`. Priorité **coffre > événement > niveau**.

- [ ] **Étape 1 : écrire les tests qui échouent**

`back/src/room.test.ts` : ajouter
`import { EVENT_DURATION_TICKS, EVENT_KIND, EVENT_OUTCOME, EVENT_STATE_PERIOD_TICKS } from '@shared/evenements';`
après l'import de `@shared/elements` ; ajouter `type EventMessage` et `MSG` à l'import de
`@shared/protocol` ; l'import de `@shared/rarity` devient
`import { EVENT_RARITY_FLOOR, RARITY } from '@shared/rarity';`. Puis en fin de fichier :

```ts
describe('etape 14 : les evenements dans le salon', () => {
  /** Une graine du genre voulu : le genre est `graine % 3`. */
  const graine = (genre: number): number => 3 * 0x4_6a2b + genre;

  /** Retire toute la horde HORS du lot de morts : ni XP, ni or, ni porteur qui doive un coffre. */
  function viderHorde(room: Room): void {
    const ids: number[] = [];
    for (let i = 0; i < room.horde.count; i++) {
      ids.push(room.horde.entityIdAt(i));
    }
    if (ids.length > 0) {
      room.horde.kill(ids);
    }
  }

  /**
   * Un tick de decor : horde videe avant et apres, joueurs remis sur pied. Le
   * decor mesure l'evenement, pas la survie d'un joueur passif.
   */
  function pas(room: Room): EventMessage[] {
    viderHorde(room);
    room.step(DT);
    viderHorde(room);
    for (let id = 1; id <= MAX_PLAYERS; id++) {
      room.debugRevive(id);
    }
    return room.drainEvents();
  }

  /** Demarre les sceaux en solo, pose le joueur dessus, avance jusqu'a la fin. */
  function reussirSceauxSolo(room: Room): void {
    room.debugStartEvent(graine(EVENT_KIND.SCEAUX));
    const [sceau] = room.eventPoints ?? [];
    if (!sceau) {
      throw new Error('un sceau attendu en solo');
    }
    room.debugPlace(1, sceau.x, sceau.y);
    for (let t = 0; t < EVENT_DURATION_TICKS; t++) {
      const fin = pas(room).find((m) => m.type === MSG.EVENT_END);
      if (fin) {
        expect(fin).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.REUSSI });
        return;
      }
    }
    throw new Error('les sceaux n ont pas abouti en 60 s');
  }

  it('EVENT_START : genre, duree, un point par vivant, et eventPoints les memes', () => {
    const room = new Room(0x14_0e_0001);
    room.join(1);
    room.join(2);
    room.debugStartEvent(graine(EVENT_KIND.SCEAUX));
    const [start] = room.drainEvents();
    if (start?.type !== MSG.EVENT_START) {
      throw new Error('EVENT_START attendu');
    }
    expect(start.kind).toBe(EVENT_KIND.SCEAUX);
    expect(start.durationTicks).toBe(EVENT_DURATION_TICKS);
    expect(start.points).toHaveLength(2);
    expect(room.eventPoints).toEqual(start.points);
  });

  it('un evenement reussi ouvre au tick suivant un etalage gele, toutes ses cartes au moins epiques', () => {
    const room = new Room(0x14_0e_0002);
    room.join(1);
    reussirSceauxSolo(room);
    expect(room.eventPoints).toBeNull();
    room.drainLevelUps();
    room.drainDraftOpens();
    room.step(DT);
    const ups = room.drainLevelUps();
    const opens = room.drainDraftOpens();
    // Un evenement n'est pas un niveau : le niveau annonce ne monte pas.
    expect(ups).toEqual([{ tick: room.tick, level: 1 }]);
    expect(opens).toHaveLength(1);
    const cartes = opens[0]?.cards ?? [];
    expect(cartes).toHaveLength(4);
    for (const c of cartes) {
      expect(c.rarity ?? RARITY.COMMUNE).toBeGreaterThanOrEqual(EVENT_RARITY_FLOOR);
    }
  });

  /**
   * ⚠️ **La priorite est fixe, et c'est ce qui laisse le client nommer
   * l'etalage sans octet** (§5.1). Les trois dus naissent au MEME tick : le
   * tick ou l'evenement reussit vient de finir, un coffre et un niveau
   * deviennent dus avant que rien ne s'ouvre.
   *
   * ⚠️ Distinguer le coffre de l'evenement se lit sur les raretes : un
   * coffre de quatre cartes a presque toujours une rare, un niveau presque
   * toujours une commune. A graine fixe, c'est deterministe ; si l'une de ces
   * deux lignes rougissait par malchance de graine (~1 %), changer la graine
   * DU SALON de ce seul test et le dire.
   */
  it('coffre, evenement et niveau dus au MEME tick : coffre, puis evenement, puis niveau', () => {
    const room = new Room(0x14_0e_0003);
    room.join(1);
    reussirSceauxSolo(room);
    room.debugOweChests(1);
    room.debugOweLevels(1);
    room.drainLevelUps();
    const raretes: number[][] = [];
    for (let k = 0; k < 3; k++) {
      room.step(DT);
      const open = room.drainDraftOpens();
      expect(open).toHaveLength(1);
      raretes.push((open[0]?.cards ?? []).map((c) => c.rarity ?? RARITY.COMMUNE));
      expect(room.setDraftToken(1, 0)).toBe(true);
      room.step(DT);
      expect(room.drainDraftResults()).toHaveLength(1);
    }
    const [coffre = [], evenement = [], niveau = []] = raretes;
    expect(Math.min(...coffre)).toBe(RARITY.RARE);
    expect(Math.min(...evenement)).toBeGreaterThanOrEqual(RARITY.EPIQUE);
    expect(Math.min(...niveau)).toBe(RARITY.COMMUNE);
    // Le niveau ne s'annonce qu'au troisieme : coffre et evenement disent celui d'avant.
    expect(room.drainLevelUps().map((u) => u.level)).toEqual([1, 1, 2]);
  });

  it('EVENT_STATE tous les EVENT_STATE_PERIOD_TICKS ticks vivants, et rien hors evenement', () => {
    const room = new Room(0x14_0e_0004);
    room.join(1);
    for (let t = 0; t < 60; t++) {
      expect(pas(room)).toEqual([]);
    }
    room.debugStartEvent(graine(EVENT_KIND.FORGE));
    const debut = room.tick;
    expect(room.drainEvents().map((m) => m.type)).toEqual([MSG.EVENT_START]);
    const ticks: number[] = [];
    for (let t = 0; t < 60; t++) {
      for (const m of pas(room)) {
        // Personne sur la forge (elle est a 1 200 px) : progression nulle, zeros hors convoi.
        expect(m).toEqual({ type: MSG.EVENT_STATE, progress: 0, cartX: 0, cartY: 0, cartHp: 0 });
        ticks.push(room.tick);
      }
    }
    expect(ticks).toEqual(
      Array.from({ length: 60 / EVENT_STATE_PERIOD_TICKS }, (_, i) => debut + EVENT_STATE_PERIOD_TICKS * (i + 1)),
    );
  });

  /**
   * ⚠️ **La rampe aussi** (§2.4) : c'est ce qui rend juste, sans octet, le
   * compte a rebours du client pose sur `pingClock`. L'evenement s'eteint
   * apres EXACTEMENT `EVENT_DURATION_TICKS` ticks vivants : la fin tombe
   * d'autant plus tard que l'etalage, son gel et sa rampe ont dure.
   */
  it('l evenement dort pendant l etalage ET pendant la rampe : 1 800 ticks VIVANTS', () => {
    const room = new Room(0x14_0e_0005);
    room.join(1);
    room.debugStartEvent(graine(EVENT_KIND.FORGE));
    const debut = room.tick;
    room.drainEvents();
    const etats: number[] = [];
    const releve = (evs: EventMessage[]): EventMessage | undefined => {
      for (const m of evs) {
        if (m.type === MSG.EVENT_STATE) {
          etats.push(room.tick);
        }
      }
      return evs.find((m) => m.type === MSG.EVENT_END);
    };
    for (let t = 0; t < 100; t++) {
      releve(pas(room));
    }
    room.debugOweLevels(1);
    room.drainLevelUps();
    releve(pas(room));
    const ouverture = room.drainLevelUps()[0]?.tick ?? -1;
    expect(ouverture).toBe(room.tick);
    expect(room.setDraftToken(1, 0)).toBe(true);
    releve(pas(room));
    const fermeture = room.drainDraftResults()[0]?.deadlineTick ?? -1;
    expect(fermeture).toBe(room.tick);
    let fin: EventMessage | undefined;
    for (let t = 0; t < 2 * EVENT_DURATION_TICKS && !fin; t++) {
      fin = releve(pas(room));
    }
    expect(fin).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.EXPIRE });
    expect(room.tick).toBe(
      debut + EVENT_DURATION_TICKS + (fermeture + LEVEL_RESUME_TICKS - ouverture + 1),
    );
    // Aucun etat de l'ouverture de l'etalage a la fin de la rampe.
    expect(etats.filter((t) => t >= ouverture && t <= fermeture + LEVEL_RESUME_TICKS)).toEqual([]);
    expect(etats).toHaveLength(EVENT_DURATION_TICKS / EVENT_STATE_PERIOD_TICKS - 1);
  });

  it('la graine du directeur demarre l evenement au tick meme ou il la rend', () => {
    const lire = vi.spyOn(WaveDirector.prototype, 'takeEventSeed').mockReturnValue(null);
    try {
      const room = new Room(0x14_0e_0006);
      room.join(1);
      for (let t = 0; t < 40; t++) {
        expect(pas(room)).toEqual([]);
      }
      lire.mockReturnValueOnce(graine(EVENT_KIND.CONVOI));
      const [start] = pas(room);
      expect(start).toMatchObject({
        type: MSG.EVENT_START,
        kind: EVENT_KIND.CONVOI,
        durationTicks: EVENT_DURATION_TICKS,
      });
      expect(room.eventPoints).toHaveLength(2);
    } finally {
      lire.mockRestore();
    }
  });

  it('personne debout quand la graine tombe : aucun evenement, aucun message', () => {
    const room = new Room(0x14_0e_0007);
    room.join(1);
    room.debugKill(1);
    room.debugStartEvent(graine(EVENT_KIND.SCEAUX));
    expect(room.eventPoints).toBeNull();
    expect(room.drainEvents()).toEqual([]);
  });

  it('la fin de run l emporte sans message : plus aucun EVENT_* apres RUN_OVER, aucun etalage du', () => {
    const room = new Room(0x14_0e_0008);
    room.join(1);
    room.debugStartEvent(graine(EVENT_KIND.FORGE));
    room.drainEvents();
    room.debugKill(1);
    room.step(DT);
    expect(room.drainRunOver()).not.toBeNull();
    room.drainEvents();
    for (let t = 0; t < 60; t++) {
      room.step(DT);
    }
    expect(room.drainEvents()).toEqual([]);
    expect(room.drainDraftOpens()).toEqual([]);
  });

  /** N est FIGE au depart (§3.1) : le sceau de qui part reste, l'evenement s'eteint a 60 s. */
  it('sceaux a deux, un joueur part : son sceau reste, l evenement expire sans planter ni etalage', () => {
    const room = new Room(0x14_0e_0009);
    room.join(1);
    room.join(2);
    room.debugStartEvent(graine(EVENT_KIND.SCEAUX));
    const [premier] = room.eventPoints ?? [];
    if (!premier) {
      throw new Error('deux sceaux attendus');
    }
    expect(room.eventPoints).toHaveLength(2);
    room.debugPlace(1, premier.x, premier.y);
    room.leave(2);
    let fin: EventMessage | undefined;
    for (let t = 0; t < EVENT_DURATION_TICKS + 5 && !fin; t++) {
      fin = pas(room).find((m) => m.type === MSG.EVENT_END);
    }
    expect(fin).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.EXPIRE });
    room.step(DT);
    expect(room.drainDraftOpens()).toEqual([]);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run src/room.test.ts -t "etape 14"`
Attendu : ÉCHEC — `debugStartEvent`, `drainEvents`, `eventPoints` n'existent pas.

- [ ] **Étape 3 : implémenter**

Dans `back/src/room.ts` :

1. Imports. L'import de `@shared/protocol` (l.69-75) gagne `type EventMessage` et `MSG` ; l'import
   de `@shared/rarity` (l.77) devient
   `import { CHEST_RARITY_FLOOR, EVENT_RARITY_FLOOR, RARITY } from '@shared/rarity';` ; après
   l'import de `@shared/enemy-shots` (l.53) :

```ts
import { EVENT_DURATION_TICKS, EVENT_OUTCOME, EVENT_STATE_PERIOD_TICKS } from '@shared/evenements';
```

   et après `import { Draft } from './draft';` (l.118) :

```ts
import { EventRun, placeEvent } from './evenement';
```

2. Après `readonly #fields: FlowField[];` (l.395) :

```ts
  /**
   * Le champ de flux du chariot (etape 14, §3.3) : meme masque que `#fields`,
   * construit UNE fois au constructeur, un BFS par convoi. Serveur seul : le
   * client lit la position du chariot, il ne la derive pas.
   */
  readonly #convoiField: FlowField;
```

3. Après `#chestsOwed = 0;` (l.506) :

```ts
  /**
   * Les etalages d'evenement dus (etape 14, §5.1), un par evenement reussi.
   * `#openDraft` les sert APRES les coffres et AVANT les niveaux, au plancher
   * `EVENT_RARITY_FLOOR`.
   */
  #eventDraftsOwed = 0;
  /**
   * L'evenement en cours (etape 14), `null` hors evenement. Au plus un : le
   * plancher de 40 vagues du directeur le garantit a lui seul.
   */
  #event: EventRun | null = null;
  /** `EVENT_START` / `EVENT_STATE` / `EVENT_END` a diffuser, dans l'ordre. */
  #pendingEvents: EventMessage[] = [];
```

4. Dans le constructeur, après l'initialisation de `this.#fields` (l.615-619) :

```ts
    this.#convoiField = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    applyObstacles(this.#convoiField, mask);
```

5. Après `drainPickups` (l.713-717) :

```ts
  /**
   * Les messages d'evenement a diffuser (etape 14, §6.4), dans l'ordre de mise
   * en file : un depart precede toujours ses etats, qui precedent sa fin.
   */
  drainEvents(): EventMessage[] {
    const out = this.#pendingEvents;
    this.#pendingEvents = [];
    return out;
  }

  /** Les points de l'evenement en cours (etape 14), `null` hors evenement. Lecture etroite. */
  get eventPoints(): readonly { x: number; y: number }[] | null {
    return this.#event?.points ?? null;
  }
```

6. Après `debugOweLevels` (l.1195-1198) :

```ts
  /**
   * Ecriture de test, meme statut que `debugOweLevels` : `n` coffres dus, comme
   * si `n` porteurs venaient de tomber. Sert a provoquer « coffre, evenement et
   * niveau dus au meme tick » (etape 14).
   */
  debugOweChests(n: number): void {
    this.#chestsOwed += n;
  }

  /**
   * Ecriture de test, meme statut que `debugOweLevels` : demarre tout de suite
   * l'evenement de graine `seed`, comme si le directeur venait de la rendre.
   * Attendre la vague 20 couterait deux minutes de temps reel par test.
   */
  debugStartEvent(seed: number): void {
    this.#startEvent(seed);
  }
```

7. L'ouverture (l.1426-1429) devient :

```ts
    // Un coffre, un evenement ou un niveau attend, et aucun etalage n'est
    // ouvert : on ouvre (`#openDraft` choisit lequel, dans cet ordre).
    if (
      this.#draft.phase === 'closed' &&
      (this.#chestsOwed > 0 || this.#eventDraftsOwed > 0 || this.#pendingLevels > 0)
    ) {
      this.#openDraft();
    }
```

8. Juste après la boucle des ordres (l'accolade qui ferme `for (const order of vague) {…}`,
   l.1600), **avant** le commentaire du portail :

```ts
    // Etape 14 : la vague qui vient de sortir a peut-etre marque un evenement.
    // Lue ICI, une fois : le directeur l'oublie a la lecture.
    const graineEvenement = this.#director.takeEventSeed();
    if (graineEvenement !== null) {
      this.#startEvent(graineEvenement);
    }
```

9. Juste avant `this.#checkRunOver();` (l.1940) :

```ts
    // Etape 14 : apres le deplacement des joueurs, de la horde et le contact —
    // l'evenement lit les positions de CE tick.
    this.#stepEvent(dt);
```

10. `#openDraft` (l.2587-2617) : compléter le docbloc et remplacer le corps :

```ts
   *
   * ⚠️ **Puis un etalage d'evenement, puis un niveau** (etape 14, §5.1). La
   * priorite est FIXE des deux cotes : deux dus ne coexistent que s'ils sont
   * nes au meme tick, et pour ceux-la le client deduit la meme suite.
   */
  #openDraft(): void {
    const coffre = this.#chestsOwed > 0;
    const evenement = !coffre && this.#eventDraftsOwed > 0;
    if (coffre) {
      this.#chestsOwed--;
    } else if (evenement) {
      this.#eventDraftsOwed--;
    } else {
      this.#pendingLevels--;
    }
    const loadouts = new Map<number, Loadout>();
    for (const [id, p] of this.#players) {
      loadouts.set(id, p.loadout);
    }
    const plancher = coffre ? CHEST_RARITY_FLOOR : evenement ? EVENT_RARITY_FLOOR : RARITY.COMMUNE;
    const spread = drawSpread(loadouts, this.#draftRng, plancher);
    this.#draft.open(this.#tick, spread, [...this.#players.keys()], loadouts);
```

    puis le commentaire existant sur le niveau annoncé reste, et la ligne
    `const niveauAnnonce = coffre ? this.#level - this.#pendingLevels : this.#level;` devient :

```ts
    // Un evenement, comme un coffre, n'est pas un niveau (etape 14).
    const bonus = coffre || evenement;
    const niveauAnnonce = bonus ? this.#level - this.#pendingLevels : this.#level;
```

    (les deux `push` qui suivent ne changent pas).

11. Après `#stepDraft` (fin l.2652) :

```ts
  /**
   * Demarre l'evenement de graine `seed` (etape 14, §2.2). Le genre, le site et
   * les points se derivent de la graine et des joueurs VIVANTS : un mort ne
   * compte ni pour le centre ni pour N. Personne debout : rien — la run
   * s'acheve a ce tick de toute facon.
   */
  #startEvent(seed: number): void {
    const vivants = [...this.#players.values()].filter((p) => p.hp > 0);
    if (vivants.length === 0) {
      return;
    }
    // `#convoiField` porte le meme masque que `#fields` et n'est jamais
    // `undefined` : il sert aussi a sortir les points des murs.
    const plan = placeEvent(seed, vivants, this.#convoiField);
    this.#event = new EventRun(plan, this.#convoiField);
    this.#pendingEvents.push({
      type: MSG.EVENT_START,
      kind: plan.kind,
      durationTicks: EVENT_DURATION_TICKS,
      points: plan.points,
    });
  }

  /**
   * Un tick de l'evenement en cours (etape 14, §2.4 et §6.2).
   *
   * ⚠️ **Il dort tant que `#tick <= #resumeEndTick` — la rampe comprise.**
   * Pendant un etalage ou un gel, `step` est deja sorti plus haut ; pendant la
   * rampe de reprise, c'est ce garde. Le client compte le temps restant sur
   * `pingClock`, qui s'arrete pendant `isFrozen` (gel ET rampe) : courir
   * pendant la rampe decalerait son compte a rebours d'une seconde par
   * etalage.
   */
  #stepEvent(dt: number): void {
    const ev = this.#event;
    if (ev === null || this.#tick <= this.#resumeEndTick) {
      return;
    }
    const issue = ev.step([...this.#players.values()], this.horde, dt);
    if (issue === null) {
      if (ev.elapsed % EVENT_STATE_PERIOD_TICKS === 0) {
        this.#pendingEvents.push({ type: MSG.EVENT_STATE, ...ev.wireState() });
      }
      return;
    }
    this.#event = null;
    if (issue === EVENT_OUTCOME.REUSSI) {
      this.#eventDraftsOwed++;
    }
    this.#pendingEvents.push({ type: MSG.EVENT_END, outcome: issue });
  }
```

La fin de run n'a rien à faire : `step` revient dès sa tête une fois `#runOver` vrai, l'événement
n'est plus jamais appelé, et `RUN_OVER` dit tout (§2.4).

- [ ] **Étape 4 : les relancer, ils passent ; typecheck**

Run : `cd back && npx vitest run src/room.test.ts src/draft.test.ts src/wave-director.test.ts src/evenement.test.ts`
Attendu : PASS.
Run : `npm run typecheck -w back`
Attendu : aucune erreur.

> Un test existant de `room.test.ts` ne voit d'événement que s'il franchit la vague 23 avec des boss
> abattus : improbable. S'il en voit un et rougit (un `EVENT_STATE` qui ne serait pas drainé n'est
> pas une cause — la file n'est lue par personne), l'implémenteur cherche pourquoi et le dit, sans
> changer de graine.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write back/src/room.ts back/src/room.test.ts
git add back/src/room.ts back/src/room.test.ts
git commit -m "feat(back): le salon fait vivre l evenement et doit un etalage epique a sa reussite"
```

---

### Tâche 6 : le serveur diffuse les EVENT_* avant LEVEL_UP

**Fichiers :**
- Modifier : `back/src/server.ts` (import `@shared/protocol` l.6-28 ; `#broadcast`, après la
  boucle `drainPickups` l.621-623)
- Tester : `back/src/server.test.ts` (imports l.3-24 ; nouveau `describe` en fin de fichier)

**Interfaces :**
- Consomme : `encodeEvent` (tâche 2) ; `Room.drainEvents`, `debugStartEvent`, `eventPoints`
  (tâche 5).
- Produit : sur le fil, les `EVENT_*` d'un envoi partent **après** `PICKUPS` et **avant**
  `LEVEL_UP`.

- [ ] **Étape 1 : écrire le test qui échoue**

`back/src/server.test.ts` : ajouter
`import { EVENT_KIND, EVENT_OUTCOME } from '@shared/evenements';` après l'import de
`@shared/elements`. Puis en fin de fichier :

```ts
describe('etape 14 : les evenements sur le fil', () => {
  /**
   * ⚠️ **La garantie du §6.4** : un client doit lire l'`EVENT_END` reussi
   * AVANT le `LEVEL_UP` qui ouvre l'etalage, sans quoi il nommerait l'etalage
   * « Niveau » — meme quand les deux partent dans le MEME envoi. Tout se joue
   * dans un bloc SYNCHRONE : le minuteur du salon ne peut pas s'intercaler, et
   * le `#broadcast` suivant draine depart, etats, fin et `LEVEL_UP` ensemble.
   */
  it('EVENT_START, puis les etats, puis EVENT_END reussi, puis LEVEL_UP, dans le meme envoi', async () => {
    const code = await createRoomCode();
    const { ws, playerId } = await connect(code);
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const recus: Message[] = [];
    ws.on('message', (data: ArrayBuffer) => {
      const m = decode(data);
      if (m.type !== MSG.SNAPSHOT) {
        recus.push(m);
      }
    });

    room.debugStartEvent(3 * 0x4_6a2b + EVENT_KIND.FORGE);
    const forge = room.eventPoints?.[0];
    if (!forge) {
      throw new Error('forge attendue');
    }
    room.debugPlace(playerId, forge.x, forge.y);
    for (let t = 0; t < 2000 && room.eventPoints !== null; t++) {
      const ids: number[] = [];
      for (let i = 0; i < room.horde.count; i++) {
        ids.push(room.horde.entityIdAt(i));
      }
      if (ids.length > 0) {
        room.horde.kill(ids);
      }
      room.step(1 / TICK_HZ);
      room.debugRevive(playerId);
    }
    expect(room.eventPoints).toBeNull();
    // L'etalage s'ouvre au tick suivant : LEVEL_UP en file avec la fin.
    room.step(1 / TICK_HZ);

    await nextMessage(ws, (m) => m.type === MSG.DRAFT_OPEN, 5000);
    const types = recus.map((m) => m.type);
    const iDebut = types.indexOf(MSG.EVENT_START);
    const iEtat = types.indexOf(MSG.EVENT_STATE);
    const iFin = types.indexOf(MSG.EVENT_END);
    const iUp = types.indexOf(MSG.LEVEL_UP);
    expect(iDebut).toBeGreaterThanOrEqual(0);
    expect(iEtat).toBeGreaterThan(iDebut);
    expect(iFin).toBeGreaterThan(iEtat);
    expect(recus[iFin]).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.REUSSI });
    expect(iUp).toBeGreaterThan(iFin);
    expect(types.lastIndexOf(MSG.EVENT_STATE)).toBeLessThan(iFin);
  }, 15_000);
});
```

- [ ] **Étape 2 : le lancer, il échoue**

Run : `cd back && npx vitest run src/server.test.ts -t "etape 14"`
Attendu : ÉCHEC sur `expect(iDebut).toBeGreaterThanOrEqual(0)` — le salon (tâche 5) met bien les
`EVENT_*` en file et le `DRAFT_OPEN` arrive, mais le serveur ne les diffuse pas encore.

- [ ] **Étape 3 : implémenter**

`back/src/server.ts` : ajouter `encodeEvent` à l'import de `@shared/protocol`, puis dans
`#broadcast`, après la boucle `for (const batch of this.room.drainPickups()) {…}` (l.621-623) :

```ts
    // Etape 14 : les evenements, APRES les morts et les ramassages (« ce qui
    // en decoule »), et surtout AVANT `LEVEL_UP` — c'est ce qui garantit
    // qu'un client a lu l'`EVENT_END` reussi avant le `LEVEL_UP` qui ouvre
    // l'etalage, meme dans le meme envoi (§6.4).
    for (const ev of this.room.drainEvents()) {
      this.#send(encodeEvent(ev));
    }
```

- [ ] **Étape 4 : le relancer, il passe**

Run : `cd back && npx vitest run src/server.test.ts`
Attendu : PASS (Postgres local requis ; un échec de compte isolé se relance une fois — voir les
Contraintes globales).

Contre-épreuve : déplacer la boucle des événements **après** celle des `drainLevelUps` → le test
rougit sur `iUp > iFin` ; remettre en place.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write back/src/server.ts back/src/server.test.ts
git add back/src/server.ts back/src/server.test.ts
git commit -m "feat(back): les evenements partent avant le level_up qui ouvre leur etalage"
```

---

### Tâche 7 : le miroir client — l'événement, son compte à rebours, son étalage

**Fichiers :**
- Modifier : `front/src/net/client.ts` (imports l.12-29 et l.49-71 ; après `PORTEUR_BANNER_MS`
  l.253 ; après `#draftIsChest = false;` l.1439 ; après le getter `porteur` l.2002-2012 ;
  `#onFrame` après le cas `PING_SHOWN` l.2378-2381 ; `LEVEL_UP` l.2431-2436 ; `RUN_OVER`
  l.2523-2529 ; après `#onPingShown` l.2085)
- Créer : `front/src/net/evenement.test.ts`

**Interfaces :**
- Consomme : `EVENT_KIND`, `EVENT_OUTCOME`, `EVENT_STATE_PERIOD_TICKS`, `EVENT_DURATION_TICKS`
  (tâche 1) ; `encodeEvent`, `EventMessage` (tâche 2).
- Produit : `export const EVENT_BANNER_MS = 4000` ;
  `export interface EventView { kind: number; points: readonly { x: number; y: number }[]; progress: number; secondsLeft: number; cart: { x: number; y: number } | null; cartHp: number }`
  (`progress` et `cartHp` dans 0-1 ; `cart` interpolé, `null` hors convoi) ; getters de
  `GameClient` : `event: EventView | null`, `eventCount: number` (`EVENT_START` reçus),
  `eventBanner: string | null` (le texte pendant `EVENT_BANNER_MS`), `draftIsEvent: boolean`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/net/evenement.test.ts` (créé) :

```ts
import { PORTEUR_ARCHETYPE } from '@shared/archetypes';
import { LEVEL_RESUME_TICKS, TICK_HZ } from '@shared/constants';
import { EVENT_DURATION_TICKS, EVENT_KIND, EVENT_OUTCOME } from '@shared/evenements';
import { entityIdOf } from '@shared/horde';
import {
  encodeDeaths,
  encodeDraftResult,
  encodeEvent,
  encodeLevelUp,
  encodeLobby,
  encodeRunOver,
  encodeSnapshot,
  encodeWaveOrder,
  encodeWelcome,
  type EventMessage,
  MSG,
  NO_WEAPON,
} from '@shared/protocol';
import { FORMATION } from '@shared/waves';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EVENT_BANNER_MS, GameClient } from './client';

/**
 * Le miroir client des evenements (etape 14, §6.5 et §7.1), sur le patron de
 * `ping.test.ts` : une fausse socket, des messages encodes par les VRAIS
 * encodeurs, et l'horloge murale bouchonnee.
 */

const STEP = 1 / TICK_HZ;

class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readonly #listeners = new Map<string, ((event: { data: ArrayBuffer }) => void)[]>();
  readonly sent: ArrayBuffer[] = [];
  binaryType = '';
  readyState = 0;

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  addEventListener(type: string, cb: (event: { data: ArrayBuffer }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), cb]);
  }

  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    // Rien a fermer.
  }

  emit(data: ArrayBuffer): void {
    for (const cb of this.#listeners.get('message') ?? []) {
      cb({ data });
    }
  }
}

let horloge = 10_000;
beforeEach(() => {
  FakeSocket.last = null;
  vi.stubGlobal('WebSocket', FakeSocket);
  horloge = 10_000;
  vi.spyOn(performance, 'now').mockImplementation(() => horloge);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const joueur = (id: number) => ({
  id,
  x: 100,
  y: 100,
  hp: 100,
  aimX: 0,
  aimY: 0,
  pickupRadius: 0,
  shield: 0,
});

function connecte(): { client: GameClient; socket: FakeSocket } {
  const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
  client.connect();
  const socket = FakeSocket.last;
  if (!socket) {
    throw new Error('aucune socket');
  }
  socket.emit(
    encodeLobby(1, [
      { playerId: 1, weaponId: NO_WEAPON, classId: 0 },
      { playerId: 2, weaponId: NO_WEAPON, classId: 0 },
    ]),
  );
  socket.emit(encodeWelcome(1, 0, 0x51ee_d0));
  socket.emit(encodeSnapshot(0, 0, 0, [joueur(1), joueur(2)]));
  client.update(0, STEP);
  return { client, socket };
}

const ev = (msg: EventMessage): ArrayBuffer => encodeEvent(msg);
const FORGE: EventMessage = {
  type: MSG.EVENT_START,
  kind: EVENT_KIND.FORGE,
  durationTicks: EVENT_DURATION_TICKS,
  points: [{ x: 4200, y: 3000 }],
};
const CONVOI: EventMessage = {
  type: MSG.EVENT_START,
  kind: EVENT_KIND.CONVOI,
  durationTicks: EVENT_DURATION_TICKS,
  points: [
    { x: 1000, y: 3000 },
    { x: 2500, y: 3000 },
  ],
};
const REUSSI: EventMessage = { type: MSG.EVENT_END, outcome: EVENT_OUTCOME.REUSSI };

describe('etape 14 : le client tient l evenement', () => {
  it('EVENT_START : la vue, 60 s restantes, un compteur, et le bandeau du genre pendant EVENT_BANNER_MS', () => {
    const { client, socket } = connecte();
    expect(client.event).toBeNull();
    expect(client.eventCount).toBe(0);
    socket.emit(ev(FORGE));
    expect(client.event).toEqual({
      kind: EVENT_KIND.FORGE,
      points: [{ x: 4200, y: 3000 }],
      progress: 0,
      secondsLeft: 60,
      cart: null,
      cartHp: 1,
    });
    expect(client.eventCount).toBe(1);
    expect(client.eventBanner).toBe("La forge s'allume !");
    horloge += EVENT_BANNER_MS - 1;
    expect(client.eventBanner).toBe("La forge s'allume !");
    horloge += 1;
    expect(client.eventBanner).toBeNull();
  });

  it('EVENT_STATE : la progression, et le chariot INTERPOLE sur 200 ms depuis sa position affichee', () => {
    const { client, socket } = connecte();
    socket.emit(ev(CONVOI));
    expect(client.event?.cart).toEqual({ x: 1000, y: 3000 });
    socket.emit(ev({ type: MSG.EVENT_STATE, progress: 51, cartX: 1012, cartY: 3000, cartHp: 204 }));
    expect(client.event?.progress).toBeCloseTo(0.2, 5);
    expect(client.event?.cartHp).toBeCloseTo(0.8, 5);
    expect(client.event?.cart).toEqual({ x: 1000, y: 3000 });
    horloge += 100;
    expect(client.event?.cart?.x).toBeCloseTo(1006, 5);
    horloge += 100;
    expect(client.event?.cart).toEqual({ x: 1012, y: 3000 });
    horloge += 500;
    expect(client.event?.cart).toEqual({ x: 1012, y: 3000 });
  });

  it('un EVENT_STATE sans depart (arrivee en cours d evenement) est ignore : pas de chariot fantome', () => {
    const { client, socket } = connecte();
    socket.emit(ev({ type: MSG.EVENT_STATE, progress: 99, cartX: 0, cartY: 0, cartHp: 255 }));
    expect(client.event).toBeNull();
  });

  it('les secondes restantes sont FIGEES pendant isFrozen, gel et rampe compris (pingClock)', () => {
    const { client, socket } = connecte();
    socket.emit(ev(FORGE));
    for (let i = 0; i < TICK_HZ; i++) {
      client.update(0, STEP);
    }
    expect(client.event?.secondsLeft).toBeCloseTo(59, 5);
    socket.emit(encodeLevelUp(client.hordeTick + 1, 2));
    for (let i = 0; i < 3 * TICK_HZ; i++) {
      client.update(0, STEP);
    }
    expect(client.event?.secondsLeft).toBeCloseTo(59, 5);
    socket.emit(encodeDraftResult(client.hordeTick, []));
    for (let i = 0; i < LEVEL_RESUME_TICKS + 5; i++) {
      client.update(0, STEP);
    }
    expect(client.isFrozen).toBe(false);
    const avant = client.event?.secondsLeft ?? 0;
    for (let i = 0; i < TICK_HZ; i++) {
      client.update(0, STEP);
    }
    expect(avant - (client.event?.secondsLeft ?? 0)).toBeCloseTo(1, 5);
  });

  it('EVENT_END : l evenement s efface, le bandeau de l issue s allume', () => {
    const { client, socket } = connecte();
    socket.emit(ev(CONVOI));
    socket.emit(ev({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.DETRUIT }));
    expect(client.event).toBeNull();
    expect(client.eventBanner).toBe('Le convoi est détruit…');
    socket.emit(ev(FORGE));
    socket.emit(ev({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.EXPIRE }));
    expect(client.eventBanner).toBe("L'événement s'éteint…");
    socket.emit(ev(FORGE));
    socket.emit(ev(REUSSI));
    expect(client.eventBanner).toBe('Réussi — étalage de règles !');
  });

  it('RUN_OVER : le client oublie l evenement', () => {
    const { client, socket } = connecte();
    socket.emit(ev(FORGE));
    socket.emit(encodeRunOver(500, 500, 3, 10));
    expect(client.event).toBeNull();
  });
});

describe('etape 14 : le client reconnait l etalage d evenement, sans un octet', () => {
  it('EVENT_END reussi puis LEVEL_UP : ce LEVEL_UP est un evenement, le suivant un niveau', () => {
    const { client, socket } = connecte();
    socket.emit(ev(FORGE));
    socket.emit(ev(REUSSI));
    socket.emit(encodeLevelUp(31, 1));
    expect(client.draftIsEvent).toBe(true);
    expect(client.draftIsChest).toBe(false);
    expect(client.level).toBe(1);
    socket.emit(encodeLevelUp(40, 2));
    expect(client.draftIsEvent).toBe(false);
  });

  it('un evenement expire ou detruit ne doit aucun etalage', () => {
    const { client, socket } = connecte();
    socket.emit(ev(FORGE));
    socket.emit(ev({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.EXPIRE }));
    socket.emit(encodeLevelUp(31, 2));
    expect(client.draftIsEvent).toBe(false);
  });

  /** La meme priorite que le salon (§5.1) : coffre, puis evenement, puis niveau. */
  it('DEATHS du porteur et EVENT_END reussi avant un meme LEVEL_UP : coffre, puis evenement, puis niveau', () => {
    const { client, socket } = connecte();
    socket.emit(
      encodeWaveOrder({
        waveId: 4242,
        spawnTick: 0,
        seed: 7,
        archetype: PORTEUR_ARCHETYPE,
        formation: FORMATION.POINT,
        anchorX: 4500,
        anchorY: 3000,
        count: 1,
      }),
    );
    socket.emit(ev(FORGE));
    socket.emit(encodeDeaths(30, [entityIdOf(4242, 0)]));
    socket.emit(ev(REUSSI));
    const drapeaux: [boolean, boolean][] = [];
    for (const tick of [31, 40, 50]) {
      socket.emit(encodeLevelUp(tick, 1));
      drapeaux.push([client.draftIsChest, client.draftIsEvent]);
    }
    expect(drapeaux).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  /** Ecart n° 12 du plan : l'`EVENT_END` suffit, le depart n'est pas requis. */
  it('arrive en cours d evenement : son EVENT_END reussi compte quand meme l etalage', () => {
    const { client, socket } = connecte();
    socket.emit(ev(REUSSI));
    socket.emit(encodeLevelUp(31, 1));
    expect(client.draftIsEvent).toBe(true);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/net/evenement.test.ts`
Attendu : ÉCHEC — `EVENT_BANNER_MS` non exporté, `client.event` indéfini.

- [ ] **Étape 3 : implémenter**

Dans `front/src/net/client.ts` :

1. Imports : après l'import de `@shared/enemy-shots` (l.32) :

```ts
import { EVENT_KIND, EVENT_OUTCOME, EVENT_STATE_PERIOD_TICKS } from '@shared/evenements';
```

   et ajouter `type EventMessage` à l'import de `@shared/protocol` (l.49-71). (`TICK_HZ` est déjà
   importé de `@shared/constants`.)

2. Après `PORTEUR_BANNER_MS` (l.253) :

```ts
/**
 * Duree du bandeau d'un evenement (etape 14, §7.1), depart ou fin, en
 * horloge murale depuis la RECEPTION du message.
 */
export const EVENT_BANNER_MS = 4000;

/**
 * Le chariot est montre une periode d'`EVENT_STATE` en retard, interpole sur
 * elle (§6.2) : 200 ms, 12 px a 60 px/s. Les PV, eux, viennent du serveur.
 */
const CART_LERP_MS = (1000 * EVENT_STATE_PERIOD_TICKS) / TICK_HZ;

/** Le bandeau du depart, par genre (`EVENT_KIND`). */
const EVENT_START_BANNERS: readonly string[] = [
  "Les sceaux s'éveillent !",
  "La forge s'allume !",
  'Un convoi attend son escorte !',
];

/** Le bandeau de la fin, par issue (`EVENT_OUTCOME`). */
const EVENT_END_BANNERS: readonly string[] = [
  'Réussi — étalage de règles !',
  "L'événement s'éteint…",
  'Le convoi est détruit…',
];

/** Ce que l'ecran montre d'un evenement (etape 14) : HUD, sol, fleches de bord. */
export interface EventView {
  /** `EVENT_KIND`. */
  kind: number;
  /** Tels qu'`EVENT_START` les a portes : sceaux, forge, ou depart puis arrivee. */
  points: readonly { x: number; y: number }[];
  /** De 0 a 1. */
  progress: number;
  /** Sur `pingClock` : fige pendant le gel et la rampe, comme l'evenement au serveur. */
  secondsLeft: number;
  /** Le chariot interpole (convoi), `null` sinon. */
  cart: { x: number; y: number } | null;
  /** PV du chariot, de 0 a 1. */
  cartHp: number;
}

/** Le miroir d'un evenement en cours, tel que les messages l'ont dit. */
interface EventMirror {
  kind: number;
  points: readonly { x: number; y: number }[];
  /** Echeance sur `pingClock`, posee a la reception d'`EVENT_START`. */
  deadline: number;
  progress: number;
  cartFrom: { x: number; y: number };
  cartTo: { x: number; y: number };
  cartAtMs: number;
  cartHp: number;
}
```

3. Après `#draftIsChest = false;` (l.1439) :

```ts
  /** L'evenement en cours (etape 14), `null` hors evenement. Pose, mis a jour et efface par le fil. */
  #event: EventMirror | null = null;
  /** `EVENT_START` recus depuis la connexion : l'audio en deduit quand sonner. */
  #eventCount = 0;
  /** Le dernier bandeau d'evenement, depart ou fin. */
  #eventBanner: { text: string; atMs: number } | null = null;
  /**
   * Etalages d'evenement dus : un par `EVENT_END` reussi, consommes au
   * `LEVEL_UP` suivant APRES les coffres — la meme priorite fixe que le salon.
   */
  #eventDraftsOwed = 0;
  #draftIsEvent = false;
```

4. Après le getter `porteur` (l.2002-2012) :

```ts
  /** L'etalage courant est-il un etalage d'evenement (etape 14) ? Fige au `LEVEL_UP`. */
  get draftIsEvent(): boolean {
    return this.#draftIsEvent;
  }

  /** `EVENT_START` recus depuis la connexion (etape 14). */
  get eventCount(): number {
    return this.#eventCount;
  }

  /** Le texte du bandeau d'evenement pendant `EVENT_BANNER_MS`, sinon `null`. */
  get eventBanner(): string | null {
    const b = this.#eventBanner;
    return b !== null && performance.now() - b.atMs < EVENT_BANNER_MS ? b.text : null;
  }

  /** L'evenement en cours (etape 14), ou `null`. */
  get event(): EventView | null {
    const ev = this.#event;
    if (ev === null) {
      return null;
    }
    return {
      kind: ev.kind,
      points: ev.points,
      progress: ev.progress,
      secondsLeft: Math.max(0, ev.deadline - this.#pingClock) / TICK_HZ,
      cart: ev.kind === EVENT_KIND.CONVOI ? this.#cartAt(ev, performance.now()) : null,
      cartHp: ev.cartHp,
    };
  }
```

5. Après `#onPingShown` (méthode qui commence l.2085) :

```ts
  /**
   * Les trois messages d'evenement (etape 14), lus A LA RECEPTION : ils ne
   * touchent pas la simulation, rien a rejouer.
   */
  #onEvent(msg: EventMessage): void {
    const now = performance.now();
    if (msg.type === MSG.EVENT_START) {
      const depart = msg.points[0] ?? { x: 0, y: 0 };
      this.#event = {
        kind: msg.kind,
        points: msg.points,
        // Une DUREE, posee sur `pingClock` : elle dort exactement quand
        // l'evenement dort au serveur.
        deadline: this.#pingClock + msg.durationTicks,
        progress: 0,
        cartFrom: depart,
        cartTo: depart,
        cartAtMs: now,
        cartHp: 1,
      };
      this.#eventCount++;
      this.#eventBanner = { text: EVENT_START_BANNERS[msg.kind] ?? '', atMs: now };
      return;
    }
    if (msg.type === MSG.EVENT_STATE) {
      const ev = this.#event;
      // Arrive en cours d'evenement : sans depart, rien a montrer (§10).
      if (ev === null) {
        return;
      }
      ev.progress = msg.progress / 255;
      ev.cartFrom = this.#cartAt(ev, now);
      ev.cartTo = { x: msg.cartX, y: msg.cartY };
      ev.cartAtMs = now;
      ev.cartHp = msg.cartHp / 255;
      return;
    }
    this.#event = null;
    // ⚠️ Compte meme sans depart vu (ecart n° 12 du plan) : l'`EVENT_END`
    // suffit a nommer l'etalage qui suit.
    if (msg.outcome === EVENT_OUTCOME.REUSSI) {
      this.#eventDraftsOwed++;
    }
    this.#eventBanner = { text: EVENT_END_BANNERS[msg.outcome] ?? '', atMs: now };
  }

  /** Le chariot a l'instant `now`, entre ses deux derniers etats connus. */
  #cartAt(ev: EventMirror, now: number): { x: number; y: number } {
    const t = Math.min(1, Math.max(0, (now - ev.cartAtMs) / CART_LERP_MS));
    return {
      x: ev.cartFrom.x + (ev.cartTo.x - ev.cartFrom.x) * t,
      y: ev.cartFrom.y + (ev.cartTo.y - ev.cartFrom.y) * t,
    };
  }
```

6. Dans `#onFrame`, juste après le bloc `if (msg.type === MSG.PING_SHOWN) {…}` (l.2378-2381) :

```ts
    if (msg.type === MSG.EVENT_START || msg.type === MSG.EVENT_STATE || msg.type === MSG.EVENT_END) {
      this.#onEvent(msg);
      return;
    }
```

7. Dans le gestionnaire `LEVEL_UP`, le bloc de l'étape 11 (l.2431-2436) devient :

```ts
      // Etape 11 : un coffre du est TOUJOURS le premier `LEVEL_UP` qui suit la
      // mort du porteur — le salon l'ouvre avant tout niveau. Etape 14 : puis
      // un etalage d'evenement, avant tout niveau. Meme priorite que le salon.
      this.#draftIsChest = this.#chestsOwed > 0;
      if (this.#draftIsChest) {
        this.#chestsOwed--;
      }
      this.#draftIsEvent = !this.#draftIsChest && this.#eventDraftsOwed > 0;
      if (this.#draftIsEvent) {
        this.#eventDraftsOwed--;
      }
```

8. Dans le gestionnaire `RUN_OVER` (l.2523), avant `this.onRunOver(...)` :

```ts
      // Etape 14 : la fin de run l'emporte sans message (§2.4).
      this.#event = null;
```

- [ ] **Étape 4 : les relancer, ils passent ; typecheck**

Run : `cd front && npx vitest run src/net/evenement.test.ts src/net/ping.test.ts src/net/client.test.ts`
Attendu : PASS.
Run : `npm run typecheck -w front`
Attendu : aucune erreur.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/net/client.ts front/src/net/evenement.test.ts
git add front/src/net/client.ts front/src/net/evenement.test.ts
git commit -m "feat(front): le client tient l evenement et reconnait son etalage, sans octet"
```

---

### Tâche 8 : l'annonce — bandeau, état au HUD, titre « Événement », son

**Fichiers :**
- Modifier : `front/src/audio/audio.ts` (`Cue` l.17-32 ; `CueSnapshot` l.35-51 ; `cuesBetween`
  l.94-96 ; `MIN_GAP_S` l.111-127 ; `play`, après `case 'porteur'` l.266-272),
  `front/src/ui/hud.ts` (imports l.1-10 ; `HudSource` l.108-111 ; `HudElements` l.228-230 ;
  `paintHud` l.304-307), `front/src/ui/draft.ts` (`DraftSource` l.57-59 ; titre l.649-653),
  `front/index.html` (après `hud-porteur` l.457-462), `front/src/main.ts` (`hudElements` l.217 ;
  `CueSnapshot` l.811)
- Tester : `front/src/audio/audio.test.ts` (fixture `calme` l.5-18 ; nouveau test),
  `front/src/ui/hud.test.ts` (câblage l.50-71 ; `hudElements()` l.146-169 ; `FakeSource`
  l.~198-215 ; nouveau `describe`), `front/src/ui/draft.test.ts` (`FakeClient` l.48 ; nouveau
  `describe`)

**Interfaces :**
- Consomme : `GameClient.event`, `eventCount`, `eventBanner`, `draftIsEvent`, `EventView`
  (tâche 7) ; `formatTimer` (`front/src/render/stage.ts` l.802).
- Produit : `Cue` gagne `'evenement'` ; `CueSnapshot.evenements: number` ;
  `HudSource.draftIsEvent?`, `HudSource.eventBanner?: string | null`,
  `HudSource.event?: EventView | null` ; `HudElements.evenement?`, `HudElements.evenementEtat?` ;
  `export function eventStatusText(event: EventView): string` (`hud.ts`) ;
  `DraftSource.draftIsEvent?` ; éléments `#hud-evenement` et `#hud-evenement-etat`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/audio/audio.test.ts` : la fixture `calme` gagne `evenements: 0,` (après
`porteurs: 0,`), puis dans `describe('cuesBetween ...')` :

```ts
  it('etape 14 : un evenement annonce sonne une fois ; sa reussite ne joue pas le son de niveau', () => {
    expect(cuesBetween(calme, { ...calme, evenements: 1 })).toEqual(['evenement']);
    expect(cuesBetween({ ...calme, evenements: 1 }, { ...calme, evenements: 1 })).toEqual([]);
    // Le LEVEL_UP d'un evenement ne monte pas le niveau : rien a jouer.
    expect(cuesBetween(calme, { ...calme, level: calme.level })).toEqual([]);
  });
```

`front/src/ui/hud.test.ts` :

- dans « trouve les cinq elements que main.ts va chercher », ajouter :

```ts
    // Etape 14 : le bandeau d'evenement et son etat.
    expect(document.getElementById('hud-evenement')).not.toBeNull();
    expect(document.getElementById('hud-evenement-etat')).not.toBeNull();
```

- `hudElements()` gagne `evenement: pick('hud-evenement'),` et
  `evenementEtat: pick('hud-evenement-etat'),` ;
- importer `import type { EventView } from '../net/client';`,
  `import { EVENT_KIND } from '@shared/evenements';` et ajouter `eventStatusText` à l'import de
  `./hud` ;
- `FakeSource` gagne :

```ts
  draftIsEvent = false;
  eventBanner: string | null = null;
  event: EventView | null = null;
```

- en fin de fichier :

```ts
describe('etape 14 : l evenement au HUD', () => {
  const forge: EventView = {
    kind: EVENT_KIND.FORGE,
    points: [{ x: 1, y: 2 }],
    progress: 0.62,
    secondsLeft: 40.2,
    cart: null,
    cartHp: 0,
  };

  it('eventStatusText : « La forge — 62 % — 0:41 », « Le convoi — 40 % — chariot 70 % — 0:33 »', () => {
    expect(eventStatusText(forge)).toBe('La forge — 62 % — 0:41');
    expect(
      eventStatusText({
        kind: EVENT_KIND.CONVOI,
        points: [],
        progress: 0.4,
        secondsLeft: 32.5,
        cart: { x: 0, y: 0 },
        cartHp: 0.7,
      }),
    ).toBe('Le convoi — 40 % — chariot 70 % — 0:33');
    expect(eventStatusText({ ...forge, kind: EVENT_KIND.SCEAUX, progress: 0 })).toBe(
      'Les sceaux — 0 % — 0:41',
    );
  });

  it('le bandeau de gel dit « Événement » pendant un etalage d evenement, « Coffre » d abord', () => {
    const el = hudElements();
    const source = new FakeSource();
    source.draftIsEvent = true;
    paintHud(el, { ...INFO, frozen: true }, 0, 0, source);
    expect(el.freeze.textContent).toBe('Événement — pause…');
    source.draftIsChest = true;
    paintHud(el, { ...INFO, frozen: true }, 0, 0, source);
    expect(el.freeze.textContent).toBe('Coffre — pause…');
  });

  it('le bandeau passager suit eventBanner, l etat suit event', () => {
    const el = hudElements();
    const source = new FakeSource();
    paintHud(el, INFO, 0, 0, source);
    expect(el.evenement?.classList.contains('hidden')).toBe(true);
    expect(el.evenementEtat?.classList.contains('hidden')).toBe(true);
    source.eventBanner = "La forge s'allume !";
    source.event = forge;
    paintHud(el, INFO, 0, 0, source);
    expect(el.evenement?.classList.contains('hidden')).toBe(false);
    expect(el.evenement?.textContent).toBe("La forge s'allume !");
    expect(el.evenementEtat?.classList.contains('hidden')).toBe(false);
    expect(el.evenementEtat?.textContent).toBe('La forge — 62 % — 0:41');
  });
});
```

`front/src/ui/draft.test.ts` : `FakeClient` gagne `draftIsEvent?: boolean;` (après
`draftIsChest?: boolean;`), puis en fin de fichier :

```ts
describe('etape 14 : le titre d un etalage d evenement', () => {
  it('« Événement » pour un etalage d evenement, « Coffre » et « Niveau N » inchanges', () => {
    const h = harness();
    const titre = document.createElement('span');
    titre.id = 'draft-title';
    h.root.prepend(titre);
    const ecran = new DraftScreen(h.root, h.status, h.list, h.client);
    h.client.draftCards = spread();
    h.client.level = 7;
    h.client.draftIsEvent = true;
    ecran.update();
    expect(titre.textContent).toBe('Événement');
    h.client.draftIsEvent = false;
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
Attendu : ÉCHEC — `evenements` inconnu de `CueSnapshot`, `hud-evenement` absent,
`eventStatusText` non exporté, titre « Niveau 7 ».

- [ ] **Étape 3 : implémenter**

`front/src/audio/audio.ts` :

- `Cue` gagne `| 'evenement'` (après `'porteur'`) ;
- `CueSnapshot` gagne, après `porteurs` :

```ts
  /** Evenements annonces depuis la connexion (etape 14). */
  evenements: number;
```

- dans `cuesBetween`, avant `return out;` :

```ts
  if (cur.evenements > prev.evenements) {
    out.push('evenement');
  }
```

- `MIN_GAP_S` gagne `evenement: 1,` ;
- dans `play`, après le `case 'porteur'` :

```ts
      case 'evenement':
        // Trois notes GRAVES puis une quinte : « un objectif », distinct de
        // l'arpege brillant du porteur. La reussite n'a pas de son : le
        // bandeau l'annonce, et son LEVEL_UP ne monte pas le niveau.
        [0, 0, 0, 7].forEach((s, k) => {
          tone('triangle', hz(-12 + s), hz(-12 + s), k * 0.16, 0.22, 0.12);
        });
        break;
```

`front/src/ui/hud.ts` :

- imports : après l'import de `@shared/constants` :
  `import { EVENT_KIND } from '@shared/evenements';` ; l'import de `../render/stage` devient
  `import { formatTimer, type HudInfo } from '../render/stage';` ; ajouter
  `import type { EventView } from '../net/client';` avant lui ;
- `HudSource` gagne, après `porteurBannerOn` :

```ts
  /** L'etalage en cours est un etalage d'evenement (etape 14). Absent : non. */
  readonly draftIsEvent?: boolean;
  /** Le texte du bandeau d'evenement, ou `null` (etape 14). Absent : rien. */
  readonly eventBanner?: string | null;
  /** L'evenement en cours (etape 14), ou `null`. Absent : rien. */
  readonly event?: EventView | null;
```

- `HudElements` gagne, après `porteur?: HTMLElement;` :

```ts
  /** Le bandeau passager d'un evenement (etape 14). Optionnel, comme `porteur`. */
  evenement?: HTMLElement;
  /** L'etat d'un evenement en cours (etape 14). Optionnel. */
  evenementEtat?: HTMLElement;
```

- avant `paintHud` :

```ts
/** Le nom de chaque evenement au HUD, par `EVENT_KIND`. */
const EVENT_NAMES: readonly string[] = ['Les sceaux', 'La forge', 'Le convoi'];

/**
 * « La forge — 62 % — 0:41 », « Le convoi — 40 % — chariot 70 % — 0:33 »
 * (etape 14, §7.4). PURE. Le temps est arrondi a la seconde SUPERIEURE : un
 * compte a rebours ne montre « 0:00 » qu'a la fin.
 */
export function eventStatusText(event: EventView): string {
  const nom = EVENT_NAMES[event.kind] ?? 'Événement';
  const avance = `${Math.floor(event.progress * 100)} %`;
  const temps = formatTimer(Math.ceil(event.secondsLeft) * TICK_HZ);
  return event.kind === EVENT_KIND.CONVOI
    ? `${nom} — ${avance} — chariot ${Math.round(event.cartHp * 100)} % — ${temps}`
    : `${nom} — ${avance} — ${temps}`;
}
```

- dans `paintHud`, les deux dernières lignes (l.306-307) deviennent :

```ts
  el.freeze.textContent = source.draftIsChest
    ? 'Coffre — pause…'
    : source.draftIsEvent
      ? 'Événement — pause…'
      : 'Niveau supérieur — pause…';
  el.porteur?.classList.toggle('hidden', source.porteurBannerOn !== true);
  // Etape 14 : le bandeau passager, puis l'etat tant qu'un evenement court.
  const banniere = source.eventBanner ?? null;
  if (el.evenement) {
    el.evenement.classList.toggle('hidden', banniere === null);
    el.evenement.textContent = banniere ?? '';
  }
  const ev = source.event ?? null;
  if (el.evenementEtat) {
    el.evenementEtat.classList.toggle('hidden', ev === null);
    el.evenementEtat.textContent = ev ? eventStatusText(ev) : '';
  }
```

`front/src/ui/draft.ts` :

- `DraftSource` gagne, après `draftIsChest` :

```ts
  /** L'etalage est un etalage d'evenement (etape 14) : le ruban dit « Événement ». Optionnel. */
  readonly draftIsEvent?: boolean;
```

- le titre (l.649-653) devient :

```ts
    if (this.#title && source.draftIsChest) {
      this.#title.textContent = 'Coffre';
    } else if (this.#title && source.draftIsEvent) {
      this.#title.textContent = 'Événement';
    } else if (this.#title && source.level !== undefined) {
      this.#title.textContent = `Niveau ${source.level}`;
    }
```

`front/index.html`, juste après la `div` `hud-porteur` (l.457-462) — mêmes classes, donc
**aucune** règle CSS nouvelle (`main.css` n'est pas touché) :

```html
            <div
              id="hud-evenement"
              class="k k-carved3 f-meta ol mt-[10px] hidden text-[24px]"
            ></div>
            <div
              id="hud-evenement-etat"
              class="k k-carved3 f-meta ol mt-[10px] hidden text-[24px]"
            ></div>
```

`front/src/main.ts` :

- `hudElements` gagne, après `porteur: el('hud-porteur'),` :
  `evenement: el('hud-evenement'),` et `evenementEtat: el('hud-evenement-etat'),` ;
- le `CueSnapshot` de `renderFrame` gagne, après `porteurs: client.porteurCount,` :
  `evenements: client.eventCount,`.

(`GameClient` est passé tel quel comme `HudSource` et `DraftSource` : ses getters de la tâche 7
suffisent.)

- [ ] **Étape 4 : les relancer, ils passent ; typecheck**

Run : `cd front && npx vitest run src/audio/audio.test.ts src/ui/hud.test.ts src/ui/draft.test.ts`
Attendu : PASS.
Run : `npm run typecheck -w front`
Attendu : aucune erreur.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/audio/audio.ts front/src/audio/audio.test.ts front/src/ui/hud.ts front/src/ui/hud.test.ts front/src/ui/draft.ts front/src/ui/draft.test.ts front/index.html front/src/main.ts
git add front/src/audio/audio.ts front/src/audio/audio.test.ts front/src/ui/hud.ts front/src/ui/hud.test.ts front/src/ui/draft.ts front/src/ui/draft.test.ts front/index.html front/src/main.ts
git commit -m "feat(front): l evenement s annonce, bandeau, etat au hud, titre et son"
```

---

### Tâche 9 : au sol — les zones, l'anneau de progression, le chariot

**Fichiers :**
- Modifier : `front/src/render/behavior-renderer.ts` (imports l.1-14 ; `CHEST_BROWN` l.43 ;
  après `behaviorShapes` l.68-133 ; `draw` l.220-334), `front/src/render/stage.ts`
  (`drawBehaviors` l.415-422), `front/src/render/frame.ts` (`FrameClient` l.~126 ;
  `FrameStage.drawBehaviors` l.145-150 ; appel l.309)
- Tester : `front/src/render/behavior-renderer.test.ts` (imports ; nouveau `describe`),
  `front/src/render/frame.test.ts` (imports ; `RecordingClient` l.~151 ; nouveau test)

**Interfaces :**
- Consomme : `EventView` (tâche 7) ; `SCEAU_RADIUS`, `FORGE_RADIUS`, `CONVOI_ESCORT_RADIUS`,
  `CONVOI_RADIUS`, `EVENT_KIND` (tâche 1).
- Produit : `export interface EventShape { kind: 'sceau' | 'forge' | 'chariot' | 'arrivee'; x; y; radius; occupied?: boolean; progress?: number; hp?: number }` ;
  `export function eventShapes(event: EventView | null, players: readonly { x: number; y: number; hp: number }[], view: Rectangle): EventShape[]` ;
  `BehaviorRenderer.draw(..., event: EventView | null = null, players = [])` ;
  `Stage.drawBehaviors(horde, blasts, shots, timeMs, event = null, players = [])` ;
  `FrameClient.event?: EventView | null` ; `FrameStage.drawBehaviors` gagne `event` et `players`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/render/behavior-renderer.test.ts` : ajouter
`import { CONVOI_ESCORT_RADIUS, CONVOI_RADIUS, EVENT_KIND, FORGE_RADIUS, SCEAU_RADIUS } from '@shared/evenements';`,
`import type { EventView } from '../net/client';` (à côté de l'import de `../net/client`), et
`eventShapes` à l'import de `./behavior-renderer`. Puis en fin de fichier :

```ts
describe('etape 14 : les formes d un evenement', () => {
  const view = new Rectangle(0, 0, 800, 600);
  const base = { progress: 0.5, secondsLeft: 30, cart: null, cartHp: 0 };

  it('un sceau par point dans le cadre, OCCUPE si un joueur vivant s y tient, rien hors cadre', () => {
    const sceaux: EventView = {
      ...base,
      kind: EVENT_KIND.SCEAUX,
      points: [
        { x: 100, y: 100 },
        { x: 500, y: 100 },
        { x: 9000, y: 9000 },
      ],
    };
    const joueurs = [
      { x: 100 + SCEAU_RADIUS, y: 100, hp: 50 },
      { x: 500, y: 100, hp: 0 },
    ];
    expect(eventShapes(sceaux, joueurs, view)).toEqual([
      { kind: 'sceau', x: 100, y: 100, radius: SCEAU_RADIUS, occupied: true, progress: 0.5 },
      { kind: 'sceau', x: 500, y: 100, radius: SCEAU_RADIUS, occupied: false, progress: 0.5 },
    ]);
  });

  it('la forge : sa zone et son anneau', () => {
    const forge: EventView = { ...base, kind: EVENT_KIND.FORGE, points: [{ x: 300, y: 300 }] };
    expect(eventShapes(forge, [{ x: 300, y: 300, hp: 10 }], view)).toEqual([
      { kind: 'forge', x: 300, y: 300, radius: FORGE_RADIUS, occupied: false, progress: 0.5 },
    ]);
  });

  it('le convoi : l arrivee et le chariot a sa position INTERPOLEE, jamais le depart', () => {
    const convoi: EventView = {
      ...base,
      kind: EVENT_KIND.CONVOI,
      points: [
        { x: 50, y: 50 },
        { x: 700, y: 400 },
      ],
      cart: { x: 200, y: 210 },
      cartHp: 0.75,
    };
    expect(eventShapes(convoi, [], view)).toEqual([
      { kind: 'arrivee', x: 700, y: 400, radius: CONVOI_RADIUS },
      { kind: 'chariot', x: 200, y: 210, radius: CONVOI_ESCORT_RADIUS, hp: 0.75 },
    ]);
  });

  it('rien sans evenement', () => {
    expect(eventShapes(null, [], view)).toEqual([]);
  });
});
```

`front/src/render/frame.test.ts` : ajouter `import { EVENT_KIND } from '@shared/evenements';` et
`type EventView` à l'import de `../net/client`. `RecordingClient` gagne, après `porteur` :

```ts
  /** L'evenement (etape 14) : une forge reconnaissable, distincte de tout le decor. */
  readonly event: EventView = {
    kind: EVENT_KIND.FORGE,
    points: [{ x: 777, y: 888 }],
    progress: 0.25,
    secondsLeft: 42,
    cart: null,
    cartHp: 0,
  };
```

puis, dans le `describe` de `composeFrame` (à côté du test des pings) :

```ts
  it('etape 14 : les comportements recoivent l evenement du client et les joueurs DESSINES', () => {
    const { stage, client, state } = compose();
    expect(stage.argsOf('comportements')).toEqual([
      client.horde,
      client.blastFlashes,
      client.shots.shots,
      NOW,
      client.event,
      state.players,
    ]);
  });
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/render/behavior-renderer.test.ts src/render/frame.test.ts`
Attendu : ÉCHEC — `eventShapes` non exporté ; `comportements` reçoit quatre arguments.

- [ ] **Étape 3 : implémenter**

`front/src/render/behavior-renderer.ts` :

- imports : après celui de `@shared/enemy-shots`,
  `import { CONVOI_ESCORT_RADIUS, CONVOI_RADIUS, EVENT_KIND, FORGE_RADIUS, SCEAU_RADIUS } from '@shared/evenements';` ;
  l'import de `../net/client` devient
  `import { type BlastFlash, type EventView, flashLifeMs } from '../net/client';` ;
- `const CHEST_BROWN = 0x5a3a1a;` (l.43) devient `export const CHEST_BROWN = 0x5a3a1a;` ;
- après `behaviorShapes` :

```ts
/** Une forme d'evenement au sol (etape 14, §7.2). */
export interface EventShape {
  kind: 'sceau' | 'forge' | 'chariot' | 'arrivee';
  x: number;
  y: number;
  radius: number;
  /** Sceau : un joueur vivant du SNAPSHOT s'y tient (cosmetique, derive ici). */
  occupied?: boolean;
  /** Sceau, forge : la progression de l'anneau, de 0 a 1. */
  progress?: number;
  /** Chariot : ses PV, de 0 a 1. */
  hp?: number;
}

/** Le brun du chariot, sous le contour `CHEST_BROWN`. */
const CART_BROWN = 0x7a4e2a;
/** L'orange de la forge. */
const FORGE_ORANGE = 0xff8a3d;

/**
 * Les formes d'un evenement dans le cadre `view` (et sa marge). PURE : c'est
 * elle que les tests lisent. Le convoi montre le CHARIOT (interpole) et son
 * arrivee, jamais son depart.
 */
export function eventShapes(
  event: EventView | null,
  players: readonly { x: number; y: number; hp: number }[],
  view: Rectangle,
): EventShape[] {
  if (!event) {
    return [];
  }
  const marge = CONVOI_ESCORT_RADIUS;
  const dedans = (x: number, y: number): boolean =>
    x >= view.x - marge &&
    x <= view.x + view.width + marge &&
    y >= view.y - marge &&
    y <= view.y + view.height + marge;
  const out: EventShape[] = [];
  if (event.kind === EVENT_KIND.CONVOI) {
    const arrivee = event.points[1];
    if (arrivee && dedans(arrivee.x, arrivee.y)) {
      out.push({ kind: 'arrivee', x: arrivee.x, y: arrivee.y, radius: CONVOI_RADIUS });
    }
    if (event.cart && dedans(event.cart.x, event.cart.y)) {
      out.push({
        kind: 'chariot',
        x: event.cart.x,
        y: event.cart.y,
        radius: CONVOI_ESCORT_RADIUS,
        hp: event.cartHp,
      });
    }
    return out;
  }
  const forge = event.kind === EVENT_KIND.FORGE;
  const radius = forge ? FORGE_RADIUS : SCEAU_RADIUS;
  for (const p of event.points) {
    if (!dedans(p.x, p.y)) {
      continue;
    }
    const occupied =
      !forge && players.some((j) => j.hp > 0 && Math.hypot(j.x - p.x, j.y - p.y) <= radius);
    out.push({
      kind: forge ? 'forge' : 'sceau',
      x: p.x,
      y: p.y,
      radius,
      occupied,
      progress: event.progress,
    });
  }
  return out;
}

/** L'anneau de progression autour d'une zone : un arc or, depuis midi, dans le sens horaire. */
function progressRing(g: Graphics, s: EventShape): void {
  const p = s.progress ?? 0;
  if (p <= 0) {
    return;
  }
  const r = s.radius + 10;
  const debut = -Math.PI / 2;
  // `moveTo` d'abord : sans lui, Pixi relierait l'arc a la forme precedente.
  g.moveTo(s.x + Math.cos(debut) * r, s.y + Math.sin(debut) * r);
  g.arc(s.x, s.y, r, debut, debut + Math.PI * 2 * p).stroke({ color: COIN_TINT, width: 6 });
}

/** Le chariot : l'escorte en pointille, les roues, la caisse, un coffre dessus, sa barre de PV. */
function drawCart(g: Graphics, s: EventShape): void {
  const { x, y } = s;
  for (let k = 0; k < 24; k += 2) {
    const a0 = (k * Math.PI * 2) / 24;
    const a1 = ((k + 1) * Math.PI * 2) / 24;
    g.moveTo(x + Math.cos(a0) * s.radius, y + Math.sin(a0) * s.radius);
    g.arc(x, y, s.radius, a0, a1).stroke({ color: COIN_TINT, width: 2, alpha: 0.25 });
  }
  g.circle(x - 14, y + 15, 8).fill(CHEST_BROWN);
  g.circle(x + 14, y + 15, 8).fill(CHEST_BROWN);
  g.rect(x - 24, y - 15, 48, 30).fill(CART_BROWN).stroke({ color: CHEST_BROWN, width: 2 });
  drawChest(g, x, y - 23, 0.8);
  const hp = Math.min(1, Math.max(0, s.hp ?? 1));
  g.rect(x - 24, y - 41, 48, 5).fill(0x1a0f0a);
  g.rect(x - 24, y - 41, 48 * hp, 5).fill(hp > 0.5 ? 0x5bd16a : hp > 0.25 ? COIN_TINT : 0xff3b2f);
}
```

- `draw` gagne deux paramètres après `nowMs: number,` :

```ts
    event: EventView | null = null,
    players: readonly { x: number; y: number; hp: number }[] = [],
```

  et, juste avant la boucle finale qui cache les sprites inutilisés
  (`for (let k = this.#used; k < this.#pool.length; k++)`) :

```ts
    // Etape 14 : l'evenement au sol, en Graphics procedural — aucun fichier
    // d'image. L'or du porteur : « dore » veut dire « recompense » partout.
    for (const s of eventShapes(event, players, view)) {
      if (s.kind === 'sceau') {
        g.circle(s.x, s.y, s.radius).fill({ color: COIN_TINT, alpha: s.occupied ? 0.35 : 0.12 });
        g.circle(s.x, s.y, s.radius).stroke({ color: COIN_TINT, width: s.occupied ? 5 : 3 });
        progressRing(g, s);
      } else if (s.kind === 'forge') {
        g.circle(s.x, s.y, s.radius).fill({ color: FORGE_ORANGE, alpha: 0.2 });
        g.circle(s.x, s.y, s.radius).stroke({ color: COIN_TINT, width: 3 });
        // Une petite enclume : deux rectangles bruns.
        g.rect(s.x - 14, s.y - 6, 28, 8).fill(CHEST_BROWN);
        g.rect(s.x - 6, s.y + 2, 12, 10).fill(CHEST_BROWN);
        progressRing(g, s);
      } else if (s.kind === 'chariot') {
        drawCart(g, s);
      } else {
        // L'arrivee : un fanion, un trait de 40 px et un triangle or.
        g.moveTo(s.x, s.y)
          .lineTo(s.x, s.y - 40)
          .stroke({ color: CHEST_BROWN, width: 3 });
        g.poly([s.x, s.y - 40, s.x + 22, s.y - 33, s.x, s.y - 26]).fill(COIN_TINT);
      }
    }
```

`front/src/render/stage.ts`, `drawBehaviors` (l.415-422) devient :

```ts
  drawBehaviors(
    horde: Horde,
    blasts: readonly BlastFlash[],
    shots: readonly EnemyShot[],
    timeMs: number,
    event: EventView | null = null,
    players: readonly { x: number; y: number; hp: number }[] = [],
  ): void {
    this.#behaviors.draw(horde, blasts, shots, this.viewRect(), timeMs, event, players);
  }
```

(ajouter `type EventView` à l'import de `../net/client` en tête de `stage.ts`, l.10-27).

`front/src/render/frame.ts` :

- ajouter `type EventView` à l'import de `../net/client` ;
- `FrameClient` gagne, après `porteur` :

```ts
  /**
   * L'evenement en cours (etape 14), ou `null` — voir `GameClient.event`.
   * Optionnel : les doubles qui n'en ont pas passent `null`.
   */
  readonly event?: EventView | null;
```

- `FrameStage.drawBehaviors` gagne, après `timeMs: number,` :

```ts
    event: EventView | null,
    players: readonly { x: number; y: number; hp: number }[],
```

- l'appel (l.309) devient :

```ts
  // Etape 14 : l'evenement au sol, avec les joueurs DESSINES (occupation des sceaux).
  stage.drawBehaviors(
    client.horde,
    client.blastFlashes,
    client.shots.shots,
    now,
    client.event ?? null,
    state.players,
  );
```

- [ ] **Étape 4 : les relancer, ils passent ; typecheck**

Run : `cd front && npx vitest run src/render/behavior-renderer.test.ts src/render/frame.test.ts src/render/stage.test.ts`
Attendu : PASS.
Run : `npm run typecheck -w front`
Attendu : aucune erreur.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/render/behavior-renderer.ts front/src/render/behavior-renderer.test.ts front/src/render/stage.ts front/src/render/frame.ts front/src/render/frame.test.ts
git add front/src/render/behavior-renderer.ts front/src/render/behavior-renderer.test.ts front/src/render/stage.ts front/src/render/frame.ts front/src/render/frame.test.ts
git commit -m "feat(front): l evenement au sol, zones dorees, anneau de progression et chariot"
```

---

### Tâche 10 : le suivre hors champ — flèches or de bord

**Fichiers :**
- Modifier : `front/src/render/ping-renderer.ts` (import l.4 ; `draw` l.145-196),
  `front/src/render/stage.ts` (`drawPings` l.519-541), `front/src/render/frame.ts`
  (`FrameStage.drawPings` l.221-228 ; appel l.350-357)
- Tester : `front/src/render/ping-renderer.test.ts` (imports l.1-7 ; nouveau `describe`),
  `front/src/render/frame.test.ts` (assertion des pings l.469-476)

**Interfaces :**
- Consomme : `EventView` (tâche 7) ; `FrameClient.event` (tâche 9) ; `edgeArrow`, `drawArrow`,
  `COIN_TINT` existants.
- Produit : `PingRenderer.draw(..., porteur = null, event: EventView | null = null)` ;
  `Stage.drawPings(..., porteur = null, event: EventView | null = null)` ;
  `FrameStage.drawPings` gagne un septième paramètre `event: EventView | null`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/render/ping-renderer.test.ts` : ajouter
`import { EVENT_KIND } from '@shared/evenements';` et, à l'import de `../net/client`,
`type EventView` (l'import devient `import type { ActivePing, EventView } from '../net/client';`).
Puis en fin de fichier :

```ts
describe('etape 14 : les fleches d un evenement', () => {
  /** Les remplissages OR du calque ECRAN par un `draw` sans ping, sans allie ni porteur. */
  function flechesOr(event: EventView | null): number {
    const r = new PingRenderer(() => 0xffffff);
    const ecran = new Container();
    r.attachScreen(ecran);
    r.draw([], [], (x, y) => ({ x, y }), 800, 600, null, event);
    const g = ecran.children[0] as Graphics;
    return g.context.instructions.filter(
      (i) =>
        i.action === 'fill' && (i.data as { style: { color: number } }).style.color === COIN_TINT,
    ).length;
  }
  const base = { progress: 0, secondsLeft: 60, cart: null, cartHp: 1 };

  it('une fleche or par sceau HORS champ, aucune pour un sceau dans le champ', () => {
    expect(
      flechesOr({
        ...base,
        kind: EVENT_KIND.SCEAUX,
        points: [
          { x: 5000, y: 300 },
          { x: -900, y: 300 },
          { x: 400, y: 300 },
        ],
      }),
    ).toBe(2);
  });

  it('la forge hors champ : une fleche', () => {
    expect(flechesOr({ ...base, kind: EVENT_KIND.FORGE, points: [{ x: 400, y: 4000 }] })).toBe(1);
  });

  it('le convoi : une fleche vers le CHARIOT hors champ, jamais vers l arrivee', () => {
    const convoi = {
      ...base,
      kind: EVENT_KIND.CONVOI,
      points: [
        { x: 400, y: 300 },
        { x: 5000, y: 300 },
      ],
    };
    expect(flechesOr({ ...convoi, cart: { x: 400, y: 300 } })).toBe(0);
    expect(flechesOr({ ...convoi, cart: { x: 5000, y: 5000 } })).toBe(1);
  });

  it('rien sans evenement', () => {
    expect(flechesOr(null)).toBe(0);
  });
});
```

`front/src/render/frame.test.ts`, l'assertion du test « les pings recoivent la carte du
client... » (l.469-476) devient :

```ts
    expect(stage.argsOf('pings')).toEqual([
      client.pings,
      state.players,
      state.localId,
      client.pingClock,
      NOW,
      client.porteur,
      client.event,
    ]);
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/render/ping-renderer.test.ts src/render/frame.test.ts`
Attendu : ÉCHEC — `draw` ignore son septième argument ; `drawPings` reçoit six arguments.

- [ ] **Étape 3 : implémenter**

`front/src/render/ping-renderer.ts` :

- imports : après `import type { ActivePing } from '../net/client';`, celui-ci devient
  `import type { ActivePing, EventView } from '../net/client';`, et ajouter
  `import { EVENT_KIND } from '@shared/evenements';` après l'import de `@shared/ping` ;
- `draw` gagne un septième paramètre `event: EventView | null = null,` (après `porteur`) et, après
  le bloc du porteur :

```ts
    // Etape 14 : chaque cible d'evenement hors champ — chaque sceau, la forge,
    // ou le CHARIOT (pas l'arrivee) — une fleche or au bord, sur le modele
    // exact du porteur. Dans le champ, rien : le sol suffit.
    if (event) {
      const cibles =
        event.kind === EVENT_KIND.CONVOI ? (event.cart ? [event.cart] : []) : event.points;
      for (const c of cibles) {
        const sp = toScreen(c.x, c.y);
        const a = edgeArrow(w, h, sp.x, sp.y, MARGIN);
        if (a) {
          drawArrow(s, a, 1.2, COIN_TINT, 1);
        }
      }
    }
```

`front/src/render/stage.ts`, `drawPings` (l.519-541) : ajouter le paramètre
`event: EventView | null = null,` après `porteur`, et passer `event` en septième argument à
`this.#pings.draw(...)`.

`front/src/render/frame.ts` :

- `FrameStage.drawPings` gagne `event: EventView | null,` après `porteur: … | null,` ;
- l'appel (l.350-357) gagne un septième argument : `client.event ?? null,` après
  `client.porteur ?? null,`.

- [ ] **Étape 4 : les relancer, ils passent ; typecheck**

Run : `cd front && npx vitest run src/render/ping-renderer.test.ts src/render/frame.test.ts src/render/stage.test.ts`
Attendu : PASS.
Run : `npm run typecheck -w front`
Attendu : aucune erreur.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/render/ping-renderer.ts front/src/render/ping-renderer.test.ts front/src/render/stage.ts front/src/render/frame.ts front/src/render/frame.test.ts
git add front/src/render/ping-renderer.ts front/src/render/ping-renderer.test.ts front/src/render/stage.ts front/src/render/frame.ts front/src/render/frame.test.ts
git commit -m "feat(front): une fleche doree au bord vers chaque objectif d evenement hors champ"
```

---

### Tâche 11 : le livrable — trois événements sur vraies sockets

**Fichiers :**
- Créer : `back/src/evenement.integration.test.ts`

**Interfaces :**
- Consomme : tout le serveur (tâches 1 à 6) : `Room.debugStartEvent`, `eventPoints`,
  `debugPlace` ; `EVENT_KIND`, `EVENT_OUTCOME`, `EVENT_STATE_PERIOD_TICKS`,
  `EVENT_RARITY_FLOOR` ; `decode`, `encodeInput`.

Le harnais est celui de `back/src/porteur.integration.test.ts` (même `buildServer({ roomSeed })`,
même `connect`, même `waitFor`), à deux sockets, **sans** `vi.mock`. Chaque test démarre son
événement par `debugStartEvent` (écart n° 5) et enveloppe `room.step` pour tenir le décor : la
horde retirée **hors du lot de morts** à chaque tick (ni XP — donc aucun niveau parasite —, ni
joueur submergé, ni porteur qui doive un coffre).

- [ ] **Étape 1 : écrire le test**

`back/src/evenement.integration.test.ts` :

```ts
import type { AddressInfo } from 'node:net';
import { EVENT_KIND, EVENT_OUTCOME, EVENT_STATE_PERIOD_TICKS } from '@shared/evenements';
import { entityIdOf } from '@shared/horde';
import {
  decode,
  type EventStateMessage,
  encodeHello,
  encodeInput,
  type Message,
  MSG,
} from '@shared/protocol';
import { EVENT_RARITY_FLOOR } from '@shared/rarity';
import { FORMATION } from '@shared/waves';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, prisma } from './accounts';
import type { Room } from './room';
import { buildServer } from './server';

/**
 * Le livrable de l'etape 14 (§1 de la spec) : **sur deux vraies sockets, les
 * deux clients recoivent le meme `EVENT_START`, puis des `EVENT_STATE` a 5 Hz
 * qui montent quand les joueurs remplissent l'objectif et s'arretent quand il
 * s'acheve ; un `EVENT_END` reussi est suivi d'un `LEVEL_UP` et d'un
 * `DRAFT_OPEN` dont chaque carte est au moins epique, et chaque client sait
 * que c'est un etalage d'evenement. Le `SNAPSHOT` garde sa taille.**
 *
 * ⚠️ **« Son `GameClient` dit `draftIsEvent` »** est rejoue par
 * `drapeauxDEvenement`, la regle exacte de `GameClient` (ecart n° 11) : le
 * back n'importe pas le front. `front/src/net/evenement.test.ts` couvre le
 * `GameClient` lui-meme.
 */

const ROOM_SEED = 0x14_e0_e0e0;
/** 22 octets d'en-tete + 2 joueurs x 11 (le bouclier des pactes) : ecrit NU, jamais recalcule. */
const SNAPSHOT_A_DEUX = 44;
/** Une graine du genre voulu : le genre est `graine % 3`. */
const graine = (genre: number): number => 3 * 0x4_6a2b + genre;

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
  /** Tout ce qui est arrive sur CETTE socket, hors snapshots. */
  received: Message[];
  /** Les tailles BRUTES des snapshots recus. */
  snapshotBytes: Set<number>;
  /** Les tailles BRUTES des messages d'evenement, par type. */
  eventBytes: Map<number, Set<number>>;
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
    eventBytes: new Map(),
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
    if (msg.type === MSG.EVENT_START || msg.type === MSG.EVENT_STATE || msg.type === MSG.EVENT_END) {
      const tailles = client.eventBytes.get(msg.type) ?? new Set<number>();
      tailles.add(data.byteLength);
      client.eventBytes.set(msg.type, tailles);
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

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retire de la horde tout ce qui n'est pas dans `garder`, HORS du lot de morts. */
function viderSauf(room: Room, garder: ReadonlySet<number>): void {
  const ids: number[] = [];
  for (let i = 0; i < room.horde.count; i++) {
    const id = room.horde.entityIdAt(i);
    if (!garder.has(id)) {
      ids.push(id);
    }
  }
  if (ids.length > 0) {
    room.horde.kill(ids);
  }
}

/** Enveloppe `room.step` : `apres` s'execute a la fin de chaque tick du serveur. */
function envelopper(room: Room, apres: () => void): void {
  const pas = room.step.bind(room);
  room.step = (dt: number): void => {
    pas(dt);
    apres();
  };
}

/**
 * La regle de `GameClient` (etape 14, §6.5), rejouee sur les messages
 * DECODES, dans l'ordre d'arrivee : un drapeau « evenement ? » par `LEVEL_UP`.
 * Aucun coffre ici : la horde est retiree hors du lot de morts.
 */
function drapeauxDEvenement(recus: readonly Message[]): boolean[] {
  let dus = 0;
  const out: boolean[] = [];
  for (const m of recus) {
    if (m.type === MSG.EVENT_END && m.outcome === EVENT_OUTCOME.REUSSI) {
      dus++;
    } else if (m.type === MSG.LEVEL_UP) {
      out.push(dus > 0);
      if (dus > 0) {
        dus--;
      }
    }
  }
  return out;
}

const etats = (c: Client): EventStateMessage[] =>
  c.received.filter((m): m is EventStateMessage => m.type === MSG.EVENT_STATE);

async function salonADeux(): Promise<{ room: Room; a: Client; b: Client }> {
  const code = await createRoomCode();
  const room = app.rooms.get(code);
  if (!room) {
    throw new Error('le registre de salons doit etre accessible depuis l app');
  }
  const a = await connect(code);
  const b = await connect(code);
  // A un seul joueur, le snapshot fait 33 octets : on ne mesure qu'a deux.
  a.snapshotBytes.clear();
  b.snapshotBytes.clear();
  return { room, a, b };
}

describe('etape 14 : les evenements bonus, sur vraies sockets (le livrable)', () => {
  it('les sceaux : meme depart chez les deux, etats a 5 Hz, reussite, puis un etalage tout epique nomme evenement', async () => {
    const { room, a, b } = await salonADeux();
    let debut = -1;
    let fin = -1;
    envelopper(room, () => {
      viderSauf(room, new Set());
      const sceaux = room.eventPoints;
      const [s0, s1] = sceaux ?? [];
      if (s0 && s1) {
        room.debugPlace(a.playerId, s0.x, s0.y);
        room.debugPlace(b.playerId, s1.x, s1.y);
      } else if (debut >= 0 && fin < 0) {
        fin = room.tick;
      }
    });
    room.debugStartEvent(graine(EVENT_KIND.SCEAUX));
    debut = room.tick;

    // ---- 1. La reussite, chez les deux --------------------------------------
    await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.EVENT_END) ?? null,
          `EVENT_END (joueur ${c.playerId})`,
          40_000,
        ),
      ),
    );
    // ---- 2. Puis l'etalage ---------------------------------------------------
    const opens = await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.DRAFT_OPEN) ?? null,
          `DRAFT_OPEN (joueur ${c.playerId})`,
          5_000,
        ),
      ),
    );

    // ---- 3. Le meme depart, en 13 octets (deux sceaux) -----------------------
    const departs = [a, b].map((c) => c.received.find((m) => m.type === MSG.EVENT_START));
    expect(departs[0]).toEqual(departs[1]);
    expect(departs[0]).toMatchObject({ type: MSG.EVENT_START, kind: EVENT_KIND.SCEAUX });
    for (const c of [a, b]) {
      expect([...(c.eventBytes.get(MSG.EVENT_START) ?? [])]).toEqual([13]);
      expect([...(c.eventBytes.get(MSG.EVENT_STATE) ?? [])]).toEqual([7]);
      expect([...(c.eventBytes.get(MSG.EVENT_END) ?? [])]).toEqual([2]);
    }

    // ---- 4. Les etats : 5 Hz de jeu, qui montent, et rien apres la fin -------
    expect(fin).toBeGreaterThan(debut);
    expect(etats(a)).toHaveLength(etats(b).length);
    expect(Math.abs(etats(a).length - (fin - debut) / EVENT_STATE_PERIOD_TICKS)).toBeLessThanOrEqual(1);
    const progres = etats(a).map((e) => e.progress);
    expect(progres).toEqual([...progres].sort((x, y) => x - y));
    expect(progres.at(-1)).toBeGreaterThan(0);
    for (const c of [a, b]) {
      const types = c.received.map((m) => m.type);
      const iFin = types.indexOf(MSG.EVENT_END);
      expect(c.received[iFin]).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.REUSSI });
      expect(types.lastIndexOf(MSG.EVENT_STATE)).toBeLessThan(iFin);
      // Dans l'ordre : la fin, le LEVEL_UP, l'etalage.
      expect(types.indexOf(MSG.LEVEL_UP)).toBeGreaterThan(iFin);
      expect(types.indexOf(MSG.DRAFT_OPEN)).toBeGreaterThan(types.indexOf(MSG.LEVEL_UP));
    }

    // ---- 5. L'etalage : min(2 + 3, 6) cartes, toutes au moins epiques -------
    for (const open of opens) {
      if (open.type !== MSG.DRAFT_OPEN) {
        throw new Error('DRAFT_OPEN attendu');
      }
      expect(open.cards).toHaveLength(5);
      for (const carte of open.cards) {
        expect(carte.rarity).toBeGreaterThanOrEqual(EVENT_RARITY_FLOOR);
      }
    }

    // ---- 6. Chacun sait que c'est un etalage d'evenement, sans un octet ------
    expect(drapeauxDEvenement(a.received)).toEqual([true]);
    expect(drapeauxDEvenement(b.received)).toEqual([true]);

    // ---- 7. Rien de plus par tick --------------------------------------------
    expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
    expect([...b.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
  }, 60_000);

  /**
   * La forge se lit sur l'ENTREE (§3.2). Le decor repose A sur la forge a
   * chaque tick : l'entree de mouvement envoyee PAR LA SOCKET est donc la
   * seule chose qui change — et elle suffit a suspendre, sans remise a zero.
   */
  it('la forge : immobile elle monte, une entree de mouvement la suspend sans la remettre a zero', async () => {
    const { room, a, b } = await salonADeux();
    envelopper(room, () => {
      viderSauf(room, new Set());
      const forge = room.eventPoints?.[0];
      if (forge) {
        room.debugPlace(a.playerId, forge.x, forge.y);
      }
    });
    room.debugStartEvent(graine(EVENT_KIND.FORGE));

    // 1. Immobile : ca monte.
    await waitFor(
      () => (etats(a).filter((e) => e.progress > 0).length >= 2 ? true : null),
      'la forge monte',
      5_000,
    );
    // 2. A bouge, par la socket.
    const bouge = setInterval(() => {
      a.seq++;
      a.ws.send(encodeInput(a.seq, 127, 0, 0, 0));
    }, 10);
    let gele = -1;
    try {
      await dormir(600);
      gele = etats(a).at(-1)?.progress ?? -1;
      const n = etats(a).length;
      await dormir(1_000);
      const pendant = etats(a).slice(n);
      expect(pendant.length).toBeGreaterThanOrEqual(3);
      for (const e of pendant) {
        expect(e.progress).toBe(gele);
      }
      // Suspendu, pas remis a zero.
      expect(gele).toBeGreaterThan(0);
    } finally {
      clearInterval(bouge);
    }
    // 3. Immobile de nouveau : ca repart d'ou c'etait.
    a.seq++;
    a.ws.send(encodeInput(a.seq, 0, 0, 0, 0));
    await waitFor(
      () => ((etats(a).at(-1)?.progress ?? 0) > gele ? true : null),
      'la forge repart',
      5_000,
    );
    expect(etats(b).length).toBeGreaterThan(0);
  }, 30_000);

  it('le convoi : sans escorte et sous cinq ennemis, il est detruit — aucun etalage', async () => {
    const { room, a, b } = await salonADeux();
    room.debugStartEvent(graine(EVENT_KIND.CONVOI));
    const depart = room.eventPoints?.[0];
    if (!depart) {
      throw new Error('le convoi a un depart');
    }
    // Cinq frappeurs, reposes sur le chariot a chaque tick ; tout le reste retire.
    // Les joueurs sont a ~1 200 px : personne n'escorte, le chariot attend.
    room.horde.spawn({
      waveId: 990_014,
      spawnTick: room.tick,
      seed: 1,
      archetype: 0,
      formation: FORMATION.SCATTER,
      anchorX: depart.x,
      anchorY: depart.y,
      count: 5,
    });
    const frappeurs = new Set(Array.from({ length: 5 }, (_, k) => entityIdOf(990_014, k)));
    envelopper(room, () => {
      viderSauf(room, frappeurs);
      for (let i = 0; i < room.horde.count; i++) {
        room.horde.x[i] = depart.x;
        room.horde.y[i] = depart.y;
      }
    });

    const fins = await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.EVENT_END) ?? null,
          `EVENT_END (joueur ${c.playerId})`,
          15_000,
        ),
      ),
    );
    for (const f of fins) {
      expect(f).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.DETRUIT });
    }
    // Les PV du chariot descendent, le chariot n'a pas bouge.
    const pv = etats(a).map((e) => e.cartHp);
    expect(pv[0]).toBe(255);
    expect(pv).toEqual([...pv].sort((x, y) => y - x));
    for (const e of etats(a)) {
      expect({ x: e.cartX, y: e.cartY }).toEqual(depart);
    }
    // Un evenement rate ne doit rien : aucun etalage.
    await dormir(1_000);
    for (const c of [a, b]) {
      expect(c.received.some((m) => m.type === MSG.LEVEL_UP)).toBe(false);
      expect(c.received.some((m) => m.type === MSG.DRAFT_OPEN)).toBe(false);
      expect([...(c.eventBytes.get(MSG.EVENT_START) ?? [])]).toEqual([13]);
    }
    expect(drapeauxDEvenement(a.received)).toEqual([]);
    expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
    expect([...b.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
  }, 30_000);
});
```

- [ ] **Étape 2 : le lancer, il passe ; contre-épreuve**

Run : `cd back && npx vitest run src/evenement.integration.test.ts`
Attendu : PASS (~35 s : 20 s de sceaux, ~4 s de forge, ~5 s de convoi). Postgres local requis ; un
échec isolé de compte ou de WELCOME se relance une fois (une autre session peut vider la base au
même moment).

Puis **contre-épreuve**, une mutation à la fois, chacune annulée avant la suivante :

1. dans `Room#openDraft`, passer `RARITY.COMMUNE` au lieu d'`EVENT_RARITY_FLOOR` → le test des
   sceaux doit rougir à l'étape 5 (une carte sous l'épique, graine fixe) ;
2. dans `EventRun#tenu`, retirer la condition `Math.hypot(p.moveX, p.moveY) * PLAYER_SPEED <
   FORGE_STILL_SPEED` → le test de la forge doit rougir (la progression monte pendant le
   mouvement) ;
3. dans `EventRun#stepConvoi`, retirer `this.#cartHp = Math.max(...)` → le test du convoi doit
   rougir (aucun `EVENT_END` en 15 s… puis `EXPIRE` à 60 s, hors délai).

`git diff` doit être vide hors du nouveau fichier.

- [ ] **Étape 3 : commit**

```bash
npx biome check --write back/src/evenement.integration.test.ts
git add back/src/evenement.integration.test.ts
git commit -m "test(back): le livrable, les evenements bonus sur vraies sockets"
```

---

### Tâche 12 : le portique et le bilan (contrôleur, seul)

**Fichiers :**
- Créer : `docs/plans/2026-10-16-etape-14-resultats.md`
- Modifier : `README.md` (nouvelle ligne après celle de l'étape 11, l.34)

- [ ] **Étape 1 : le portique complet, rien d'autre en vol**

Run : `npm run lint && npm run typecheck && npm test`
Attendu : tout vert. Noter le nombre de tests front et back **de cette exécution seule**. Un échec
isolé de compte ou de crédit dans un test d'intégration se relance **une fois** (base partagée avec
une autre session) avant d'en conclure quoi que ce soit.

Puis les bancs, seul aussi : `npm run bench` — noter `bench:sim` et `bench:net` (le coût
serveur du convoi, §10 de la spec : un balayage de la horde par 15 ticks et un BFS par convoi —
les bancs ne démarrent pas d'événement, ils mesurent que rien n'a régressé hors événement).

- [ ] **Étape 2 : mettre le graphe à jour**

Run : `graphify update .`

- [ ] **Étape 3 : écrire le bilan**

`docs/plans/2026-10-16-etape-14-resultats.md`, sur le modèle de
`2026-10-15-etape-11-resultats.md` : en-tête (Spec, Plan), livré (le directeur qui marque sans
tirage, les trois événements, la pause pendant le gel et la rampe, l'étalage au plancher épique et
la remontée de palier, la reconnaissance sans octet, le HUD, le sol, les flèches), nombre de tests
(de l'étape 1), coût sur le fil (**trois messages nouveaux, 28 à 30** ; `EVENT_STATE` 7 o × 5 Hz =
35 o/s par client pendant 60 s au plus ; `EVENT_START` 9 à 21 o ; `EVENT_END` 2 o ; **rien par
tick**, `SNAPSHOT` à 44 octets à deux), les empreintes relevées (directeur `3_330_581_021`,
étalages commun/rare `2_604_871_415`), les quatorze écarts assumés de ce plan, puis la section
**« Vérification manuelle — ouverte »** avec les points du §9 de la spec :

- les trois événements se lisent-ils d'un coup d'œil en pleine horde (zones, anneau, chariot) ?
- les sceaux à 800 px : assez loin pour forcer la séparation, assez près pour se regrouper après ?
- la forge en solo (15 s immobile sous la horde) est-elle jouable ? à quatre, 30 s est-il trop long ?
- 60 px/s, 400 PV, 150 px d'escorte : le convoi est-il tendu sans être injouable ?
- 60 s suffisent-elles quand le site naît à 1 200 px (≈ 5 s de marche à 260 px/s) ?
- un étalage de cartes de règle fait-il événement ? les pactes qu'il offre (25 % des
  emplacements) sont-ils un choix ou un piège ?
- le premier événement vers 2 min : bon moment ?
- le bandeau et le son se remarquent-ils sans gêner ?

Plus les risques du §10 à surveiller : un pacte imposé par l'attribution d'office, six cartes de
règle seulement (à quatre, l'étalage les contient toutes), le premier événement qui dépend des
boss, le sceau orphelin, le chariot montré 200 ms en retard.

- [ ] **Étape 4 : le README**

Après la ligne de l'étape 11 (`README.md` l.34 — il n'y a pas de ligne pour les étapes 12 et 13,
écart n° 13), ajouter :

```markdown
| 14 | Événements bonus : trois sceaux, une forge, un convoi — un étalage de cartes de règle à la clé | 📝 — [spec](docs/specs/2026-10-16-etape-14-evenements.md) · [plan](docs/plans/2026-10-16-etape-14-evenements.md) · [résultats](docs/plans/2026-10-16-etape-14-resultats.md) |
```

- [ ] **Étape 5 : commit**

```bash
git add docs/plans/2026-10-16-etape-14-resultats.md README.md
git commit -m "docs: le bilan de l etape 14"
```

---
