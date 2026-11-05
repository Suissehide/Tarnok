# Étape 16 — les événements bonus, deuxième fournée : plan d'implémentation

> **Pour les agents :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou
> superpowers:executing-plans, tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**But :** quatre nouveaux objectifs rejoignent le tirage de l'étape 14 — un totem à défendre (*le
siège*), une relique à porter à l'autel (*la relique*), des proies à abattre (*la chasse*), une
nuit à traverser autour d'une lanterne (*le noir*) — et chacun, réussi, ouvre le même étalage
d'équipe au plancher épique.

**Architecture :** le directeur ne bouge pas ; le genre passe de `seed % 3` à `seed % 7` dans
`placeEvent`. Les règles des quatre genres vivent dans `EventRun` (`back/src/evenement.ts`, pur,
serveur seul) ; le salon fait naître les proies par `#spawnAt` (des `WAVE_ORDER` ordinaires, sans
un `rng()`), retire les PV du noir à la main, et pousse un `EVENT_STATE` hors cadence quand le
porteur de la relique change. Le fil ne gagne **aucun octet** : le bit 7 de l'octet de genre
d'`EVENT_START` dit « solo », l'octet 6 d'`EVENT_STATE` (« PV du chariot ») porte selon le genre les
PV du totem, l'id du porteur de la relique ou celui de la lanterne. Le client date le porteur de la
relique par le `SNAPSHOT` qui suit (D + 1), ralentit sa prédiction et fait taire son miroir de tir
avec la même règle partagée (`shared/evenements.ts` + `fireCooldown` extrait dans
`shared/firing.ts`) ; il dessine totem, relique, autel, anneau rouge des proies, et l'obscurité par
un seul `Graphics` troué (`cut()`).

**Pile :** TypeScript, `ws`, Fastify, Pixi.js v8 (8.20), Vitest (jsdom côté front pour l'UI),
Biome, Prisma/Postgres pour les tests qui ouvrent de vraies sockets.

**Spec :** [`docs/specs/2026-11-05-etape-16-evenements-2.md`](../specs/2026-11-05-etape-16-evenements-2.md)

**Où l'on travaille :** dans un worktree, sur la branche `etape-16-evenements`.

```bash
git worktree add ../Tarnok-evenements2 -b etape-16-evenements
cd ../Tarnok-evenements2 && npm ci && npm run db:generate -w back
cp ../Tarnok/back/.env back/.env && cp ../Tarnok/front/.env front/.env
```

Tous les chemins de ce plan sont relatifs à la racine du worktree (`../Tarnok-evenements2`). Les
ancres `l.~N` sont celles du commit `4f3053f` (tête de `etape-15-progression`, qui porte l'étape 14
fusionnée **et** l'étape 15 — voir l'écart n° 1).

## Contraintes globales

- Constantes, valeurs de la spec, **jamais un nombre en dur ailleurs** :
  - `shared/evenements.ts` : `EVENT_KIND = { SCEAUX: 0, FORGE: 1, CONVOI: 2, SIEGE: 3, RELIQUE: 4,
    CHASSE: 5, NOIR: 6 }` ; `EVENT_KIND_COUNT = 7` ; `EVENT_SOLO_FLAG = 0x80` ;
    `TOTEM_RADIUS = 28` ; `SIEGE_DEFEND_RADIUS = 150` ; `RELIQUE_CARRIER_SPEED = 0.6` ;
    `RELIQUE_CARRIER_SPEED_SOLO = 0.8` ; `RELIQUE_ALTAR_RADIUS = 80` ; `NOIR_LIGHT_RADIUS = 350` ;
    `NOIR_LIGHT_RADIUS_SOLO = 500`.
  - `back/src/evenement.ts` : `SIEGE_HOLD_TICKS = 1350` (45 s) ; `SIEGE_HP = 600` ;
    `SIEGE_HP_SOLO = 1200` ; `SIEGE_CONTACT_RADIUS = TOTEM_RADIUS + CONTACT_RADIUS / 2` = **45** ;
    `RELIQUE_DISTANCE = 1500` ; `RELIQUE_PICKUP_RADIUS = 48` ; `CHASSE_SPACING = 1200` ;
    `CHASSE_PREY = 3` ; `CHASSE_PREY_SOLO = 2` ; `NOIR_HOLD_TICKS = 1200` (40 s) ;
    `NOIR_DRAIN_PER_SEC = 2`.
  - `shared/archetypes.ts` : `PROIE_NAME = 'proie'` ; `PROIE_HP_MULTIPLE = 8` →
    `PROIE_HP = HEAVY_HP × 8` = **160** ; `PROIE_SPEED_FACTOR = 0.75` → vitesse
    `Math.round(PLAYER_SPEED × 0.75)` = **195** px/s ; `PROIE_BODY_SCALE = 1.6` ; `PROIE_ARCHETYPE`
    dérivé du nom, **après** `PORTEUR_ARCHETYPE`.
  - `front/src/render/behavior-renderer.ts` : `PROIE_RED = 0xe0352b` ; `PROIE_RING_RADIUS = 46` ;
    pilier du totem 24 × 56 px gris `0x8a8f99` contouré `CHEST_BROWN`.
  - `front/src/render/darkness-renderer.ts` : `NOIR_DARK_ALPHA = 0.9` ; `NOIR_FEATHER_PX = 80` ;
    `NOIR_FADE_MS = 800` ; couleur `0x05040a`.
  - Inchangées : `EVENT_WAVE_IN_PALIER = 3`, `EVENT_MIN_GAP_WAVES = 40`, `EVENT_FIRST_WAVE = 20`,
    `EVENT_DURATION_TICKS = 1800`, `EVENT_STATE_PERIOD_TICKS = 6`, `EVENT_RARITY_FLOOR`,
    `CONVOI_MAX_HITTERS = 5`, `CONVOI_CONTACT_DAMAGE = 8`, `CONTACT_INTERVAL_TICKS = 15`,
    `PORTEUR_FLEE_RADIUS = 400`.
- **Les octets `EVENT_*` réutilisés, genre par genre** (aucun format ne change) :

  | Genre | `EVENT_START` octet 1 | n points | `EVENT_STATE` progression | x, y | octet 6 |
  | --- | --- | --- | --- | --- | --- |
  | sceaux 0 / forge 1 | genre \| solo·0x80 | N / 1 | `held / hold` | 0, 0 | 0 |
  | convoi 2 | idem | 2 | trajet | chariot | `ceil(255 pv / pvMax)` |
  | siège 3 | idem | 1 (totem) | `held / SIEGE_HOLD_TICKS` | 0, 0 | `ceil(255 pv / pvMax)` du totem |
  | relique 4 | idem | 2 (relique, autel) | `1 − d(relique, autel) / d(S, autel)` | la relique | id du porteur, 0 au sol |
  | chasse 5 | idem | 3, ou 2 en solo | `tombées / nées` | 0, 0 | 0 |
  | noir 6 | idem | **0** (5 o) | `elapsed / NOIR_HOLD_TICKS` | 0, 0 | id du porteur de lanterne |

  Tout octet écrit est **borné** avant `setUint8` (le genre masqué à `0x7f`, l'octet 6 et la
  progression déjà bornés à `[0, 255]` par l'encodeur, `shared/protocol.ts` l.1863 et l.1866).
- **Rien d'ajouté aux messages par tick.** `SNAPSHOT` garde sa taille ; le seul surcoût est un
  `EVENT_STATE` de 7 o par changement de porteur de relique.
- **Aucun `rng()` de plus, aucune ligne du directeur touchée** : les empreintes de
  `back/src/wave-director.test.ts` ne bougent pas. Les proies prennent leurs `waveId` par
  `allocWaveId()` (un compteur) ; les `waveId` qui suivent se décalent de 2 ou 3, comme après un
  nécromancien.
- **Jamais toucher `sampleDirection`** (`shared/flowfield.ts`) : elle déplace toute la horde, des
  deux côtés (leçon de l'étape 14, §5 de son bilan).
- **Placement testé sur de VRAIES cartes** (`generateObstacles` + `applyObstacles`), pas seulement
  sur un champ ouvert (leçon de l'étape 14).
- Commentaires de code en français **sans accents** ; textes affichés avec leurs accents ;
  messages de commit conventionnels en français sans accents, sujet en minuscules
  (`feat(shared): ...`, `test(back): ...`, `docs: ...`).
- **Discipline des sous-agents** : un sous-agent ne lance **que les fichiers de test de sa tâche**,
  **au premier plan** (`npx vitest run <fichier>`) — jamais `npm test`, jamais un banc, jamais une
  commande en arrière-plan. Le portique complet et les bancs sont au contrôleur, **seul**, à la
  dernière tâche.
- Commandes de test : tests de `shared/` depuis `back/` (`cd back && npx vitest run
  ../shared/<fichier>`), tests du back depuis `back/`, tests du front depuis `front/`
  (`cd front && npx vitest run src/...`).
- **Postgres local.** Les `*.integration.test.ts` et `back/src/server.test.ts` ouvrent de vraies
  sockets et créent des comptes sur une base **possiblement partagée** avec une autre session
  (`deleteMany` en `beforeEach`) : un échec isolé de compte ou d'or à 0 (`createAccount`, jeton
  refusé, `WELCOME` absent, crédit à 0) se **relance une fois** avant d'en conclure quoi que ce soit.
- Avant chaque commit : `npx biome check --write <fichiers de la tâche>`.
- **Des commits NOUVEAUX seulement** : jamais `--amend`, `rebase`, `reset`, `stash`, ni `checkout`
  d'un autre commit.
- Jamais `pkill -f` : les serveurs de dev de Léo tournent sur 5173 et 3100.
- Actifs sur MinIO : **aucun actif nouveau** (la proie réutilise le gnoll de l'atlas).

**Écart assumé n° 1 — la base : `etape-15-progression`, pas `main`.** La spec (§0) dit « un `main`
qui contient l'étape 15 » ; au 5 novembre, `main` (`408307a`) contient l'étape 14 mais **pas**
l'étape 15 (`2243868`, `8c070f2`, `a542989`, et la spec elle-même `4f3053f` ne sont que sur
`etape-15-progression`). Le `git worktree add` ci-dessus branche depuis la tête courante : il se
lance depuis `etape-15-progression` (ou après sa fusion dans `main`), sinon `monsterHp` des proies
(§5.3) et les cartes « dégâts » composées manquent. Les ancres de la spec (prises à `a542989`) sont
justes à une ou deux lignes près ; vérifiées : `room.ts` l.1386, 1526-1529, 1555, 1563, 1789-1790,
1839-1840, 2199-2214, 2225-2230, 2422-2438, 2449-2466, 2567-2582, 2720-2731 ;
`back/src/evenement.ts` l.62-85, 147-182, 196-246, 333-341, 411-425 ; `shared/protocol.ts`
l.1805-1908 ; `client.ts` l.2197-2203, 2468-2470, 2623, 3041-3101.

**Écart assumé n° 2 — les aides de test « `graine % 3` » ne sont pas toutes écrites ainsi.**
`back/src/evenement.test.ts` l.38-41 lit bien `s - (s % 3) + genre`. Mais `back/src/room.test.ts`
l.5920-5921 et `back/src/evenement.integration.test.ts` l.38-39 écrivent
`const graine = (genre) => 3 * 0x4_6a2b + genre` : multiple de 3, **pas** de 7 —
`3 × 0x4_6a2b` vaut 4 modulo 7, donc `graine(SCEAUX)` tirerait **la relique**. Elles deviennent
`7 * 0x4_6a2b + genre` (l'angle change, les tests lisent `eventPoints`, rien d'autre ne bouge). La
spec oublie aussi `shared/protocol.test.ts` l.1743 (`expect(EVENT_KIND).toEqual({ SCEAUX: 0,
FORGE: 1, CONVOI: 2 })`), réécrit à la tâche 1.

**Écart assumé n° 3 — `debugStartEvent` démarre HORS du pas : ses proies sont datées `tick + 1`.**
La spec (§5.2) date les proies `this.#tick` parce que `#startEvent` est appelé dans `step`, avant
`horde.step` (l.1526-1529 puis l.1555). Mais `debugStartEvent` (`room.ts` l.1159-1161), que tous
les tests et le livrable utilisent, l'appelle **entre deux pas** : la horde du serveur a déjà fait
le pas T, un ordre daté T serait posé par le client **avant** son pas T — une dérive. D'où
`#startEvent(seed, spawnTick)` : `step` passe `this.#tick`, `debugStartEvent` passe
`this.#tick + 1`, exactement le cas des petits du diviseur (`#afterDeaths`, l.2556-2562).

**Écart assumé n° 4 — `#spawnAt` rend l'identité de la première entité née, ou `null`.** La spec
laisse la signature au plan : `#spawnAt(at, archetype, count, spawnTick = this.#tick + 1): number |
null`. Les deux appelants actuels (l.2556, l.2562) ignorent le retour.

**Écart assumé n° 5 — la relique vit dans `EventRun.cart`.** La spec (§4.1) ajoute un champ
`relic`. Or `cart` est déjà « le point mobile que l'octet x, y d'`EVENT_STATE` transporte » et sa
progression `1 − d(point, E) / d(S, E)` est déjà écrite (l.300-311) : la relique est `cart`, posée
sur `points[0]`, et la progression du convoi sert telle quelle. Aucun champ, aucune copie.

**Écart assumé n° 6 — le recalage de la livraison tardive vise la DERNIÈRE salve du serveur, pas
`D + 1`.** La spec (§8.3) écrit `last[w] = D + 1`. Faux dès que le retard dépasse une recharge :
l'arme de base recharge en **4 ticks** (`shared/weapons.ts` l.493) ; un client qui apprend la
livraison à D + 7 recalé à D + 1 tirerait à D + 7 (au lieu de D + 9 au serveur, qui a tiré à D + 1
puis D + 5) — la phase resterait décalée. La règle exacte, pure, dans `shared/firing.ts` :
`lastFireAfterCarry(last, from, nextTick, cooldown)` rend le tick de la dernière salve que le
serveur a tirée **avant** `nextTick` (`first = max(from, last + cooldown)`, puis tous les
`cooldown`). Elle n'agit que si la visée de l'ancien porteur est non nulle (le serveur ne tire pas
sans visée, l.2205-2207).

**Écart assumé n° 7 — la datation du porteur est une classe partagée, `CarrierClock`.** La spec
(§8.1) met `carrier`, `carrierPrev`, `carrierFromTick`, `carrierPending` dans l'`EventMirror` du
client. Ils vivent dans `CarrierClock` (`shared/evenements.ts`), que le `GameClient` possède : le
livrable (back, qui n'importe pas le front) rejoue ainsi les messages **décodés de la vraie
socket** dans **le même code** que le client, au lieu d'une copie (cf. écart n° 11 de l'étape 14).
Et une correction : un octet égal au porteur courant **efface** l'attente (ramassage puis chute
dans le même envoi, sous rattrapage) — la spec ne la posait qu'à la différence.

**Écart assumé n° 8 — trois lectures de test.** `Room#lastFireTickOf(playerId, weaponId)`,
`Room#eventCarrier` et `GameClient#lastFireTickOf(playerId, weaponId)` : lectures étroites, même
statut que `positionOf` / `eventPoints`. Ce sont elles qui prouvent « aucune salve » des deux
côtés, au tick près, sans compter des projectiles qui expirent.

**Écart assumé n° 9 — `takeCarrierChanged()` est lu AVANT le test de cadence.** La spec écrit
`elapsed % 6 === 0 || ev.takeCarrierChanged()` : le `||` court-circuite, le drapeau d'un
changement tombé sur un tick de cadence survivrait au tick suivant et y pousserait un état en trop.

**Écart assumé n° 10 — les cibles des flèches sortent dans une fonction pure, `eventTargets`.**
La spec (§9.3) les calcule dans le getter `event`. Le getter l'appelle, mais elle est exportée de
`client.ts` et testée seule (balayage de la horde pour `PROIE_ARCHETYPE`, relique au sol / autel,
lanterne) ; `ping-renderer.ts` ne fait plus que boucler sur `event.targets`.

**Écart assumé n° 11 — `EventView` gagne cinq champs OBLIGATOIRES, cinq fixtures de test
suivent.** `solo`, `carrierId`, `relic`, `targets` (spec §9.1) et `startedAtMs` — que le §9.4
lit pour le fondu mais que le §9.1 n'ajoute pas à la vue ; les vues écrites à la main dans
`front/src/net/evenement.test.ts` l.128-135, `front/src/ui/hud.test.ts` l.530-550,
`front/src/render/behavior-renderer.test.ts` l.105-140, `front/src/render/ping-renderer.test.ts`
l.133 et `front/src/render/frame.test.ts` l.150 les reçoivent (zéros, `null`, `[]`, ou les points
pour les flèches). Optionnels, ils laisseraient passer un oubli dans le getter.

**Écart assumé n° 12 — des tests existants que la spec ne cite pas changent.**
`shared/archetypes.test.ts` l.298 (`toHaveLength(PORTEUR_ARCHETYPE + 1)` → `PROIE_ARCHETYPE + 1`),
les boucles de PV l.101-113 et de corps l.216-228 (une branche `PROIE_ARCHETYPE`) ;
`front/src/render/stage.test.ts` l.368-428 (15 → **16** calques, un `true` de plus entre la barre
du boss et les pings) ; les `EventMessage` d'`EVENT_START` écrits à la main gagnent `solo: false`
(`shared/protocol.test.ts` l.1752, l.1766, l.1820 ; `front/src/net/evenement.test.ts` l.105-118).

**Écart assumé n° 13 — la dérive de la horde répliquée se mesure sur la proie elle-même.** La spec
(§11) demande « le scénario du porteur, archétype changé ». Le scénario de mort tardive
(`shared/horde.replication.test.ts` l.3148-3421, `runChaseDeathScenario`) gagne un paramètre
d'archétype ; PR1 / PR2 (proie) y rejoignent PT1 / PT2 : sans rejeu une dérive non nulle, avec
rejeu **0,000 px**, attente et fuite vues.

**Écart assumé n° 14 — le README n'a de lignes ni pour 12, 13, 15.** Fichiers existants : étape 12
la spec seule ; étape 13 spec et plan ; étape 15 le plan seul (son bilan y est écrit, `8c070f2`).
La tâche 13 ajoute ces trois lignes, liens vers ce qui existe, puis celle de l'étape 16.

**Écart assumé n° 15 — la datation est vérifiée « D + 1, à 4 ticks près » sur vraies sockets.** La
spec (§8.1) le dit elle-même : sous rattrapage (`MAX_CATCH_UP_STEPS` = 5, `server.ts` l.56), la
date glisse jusqu'à 4 ticks. Le livrable exige `from − (D + 1) ∈ [0, 4]` et des dates
**identiques** chez les deux clients ; l'égalité exacte est prouvée en unitaire (tâche 7).

**Écart assumé n° 16 — « la première salve au tick qui suit la livraison » ne se teste pas sur la
livraison.** La spec (§11, `room.test.ts`) la demande. Mais une livraison réussie doit un étalage
(`#eventDraftsOwed++`, `room.ts` l.2463) que `step` ouvre **au tick suivant** (l.1355-1366) : le
monde gèle, personne ne tire à E + 1. La reprise exacte est prouvée sur **la chute** du porteur
(même code : `holdsFire` devient faux dès que `carrier` change), contre `lastFireAfterCarry` ; la
livraison, elle, est prouvée par son `EVENT_END` → `LEVEL_UP` → `DRAFT_OPEN` (tâche 12).

**Écart assumé n° 17 — le bord doux du noir est inversé dans la spec.** La boucle du §9.4
remplit l'anneau k à `a × (1 − (k+1)/5)` : l'anneau collé à la lumière est le plus sombre (0,8 a),
l'extérieur le plus clair (0,2 a), puis le noir plein — un liseré, pas un fondu. Le plan remplit
l'anneau k à `a × (k+1)/5` (tâche 10).

**Écart assumé n° 18 — `inDark` porte lui-même la règle « jamais en solo ».** La spec (§6.3) met
le garde « hors solo » dans `#stepEvent`. `EventRun` connaît `solo` ; le salon garde une boucle
sans condition de plus, et le test unitaire du solo vit avec la règle (tâche 4).

**Écart assumé n° 19 — la mini-carte passe par `minimapEnemies`**, une fonction pure de
`front/src/ui/minimap.ts`, plutôt qu'une condition écrite dans `main.ts` (l.714), que rien ne
teste.

## Points de vigilance de la revue

1. **Le porteur de la relique meurt, ou se déconnecte, en portant** : la relique reste à sa
   dernière position, un autre la reprend, le client daté recalé tire de nouveau au même tick que
   le serveur → tests tâches 4, 6 et 7.
2. **Une chasse dans une horde pleine** : aucune proie née → aucun événement, aucun message (pas
   d'événement fantôme qu'on ne peut pas réussir) → test tâche 6.
3. **Le noir quand le porteur de lanterne part (`leave`)** : `DETRUIT` au tick suivant, l'obscurité
   du client s'efface à l'`EVENT_END`, la mini-carte retrouve la horde → tests tâches 4, 7 et 10.
4. **Un site de siège, de relique ou d'autel près d'une côte réelle** : jamais dans l'eau, toujours
   dans la carte, entier → tests tâche 3 sur `generateObstacles` (cartes 1 à 4).
5. **Le joueur seul** : vitesse 0,8, lumière 500 px, aucune perte de PV, deux proies, 1 200 PV de
   totem ; le bit solo de l'octet de genre arrive et se lit → tests tâches 1, 4, 6, 7.

---

## Carte des fichiers

| Fichier | Rôle |
| --- | --- |
| `shared/evenements.ts` | quatre genres, `EVENT_KIND_COUNT`, `EVENT_SOLO_FLAG`, rayons et vitesses partagés, `relicSpeedFactor`, `lightRadius`, `CarrierClock` |
| `shared/protocol.ts`, `shared/protocol.test.ts` | le bit solo d'`EVENT_START`, la doc de l'octet d'état |
| `shared/archetypes.ts`, `shared/archetypes.test.ts` | l'archétype `proie` |
| `shared/horde.ts`, `shared/horde.test.ts`, `shared/horde.replication.test.ts` | la proie partage la règle de fuite du porteur ; dérive 0,000 px |
| `shared/firing.ts`, `shared/firing.test.ts` | `fireCooldown`, `lastFireAfterCarry` |
| `back/src/evenement.ts`, `back/src/evenement.test.ts` | placement à sept genres, règles du siège, de la relique, de la chasse, du noir |
| `back/src/room.ts`, `back/src/room.test.ts` | proies par `#spawnAt`, vitesse et silence du porteur, perte de PV dans le noir, état hors cadence |
| `front/src/net/client.ts`, `front/src/net/evenement.test.ts`, `front/src/net/prediction.test.ts` | miroir : solo, `CarrierClock`, vitesse prédite, garde de tir, recalage, `eventTargets`, bandeaux |
| `front/src/ui/hud.ts`, `front/src/ui/hud.test.ts` | quatre noms, quatre textes d'état |
| `front/src/render/behavior-renderer.ts`, `…/behavior-renderer.test.ts` | totem, relique, autel, anneau rouge des proies |
| `front/src/render/horde-renderer.ts`, `…/horde-renderer.test.ts` | la proie emprunte le gnoll |
| `front/src/render/darkness-renderer.ts` (créé), `…/darkness-renderer.test.ts` (créé) | l'obscurité, `darknessHole` |
| `front/src/render/stage.ts`, `…/stage.test.ts`, `front/src/render/frame.ts`, `…/frame.test.ts` | le calque d'obscurité, son appel |
| `front/src/main.ts` | la mini-carte vide pendant le noir |
| `front/src/render/ping-renderer.ts`, `…/ping-renderer.test.ts` | les flèches vers `event.targets` |
| `back/src/evenement.integration.test.ts` | **le livrable** (quatre `describe` de plus) |
| `docs/plans/2026-11-05-etape-16-resultats.md` (créé), `README.md` | le bilan |

Pourquoi ce découpage (13 tâches au lieu des 12 suggérées) : le **modèle et le fil** (1) sont un
seul contrat partagé, les constantes seules n'ont pas de cycle de test ; la **proie** (2) touche la
horde répliquée et porte sa propre preuve de dérive ; le **placement** (3) et les **règles** (4)
sont deux revues distinctes de `evenement.ts` (le placement se juge sur de vraies cartes, les
règles sur des pas) — c'est là que se range « le directeur → sept genres », une ligne de
`placeEvent`, puisque **le directeur ne change pas** ; la **règle partagée du tir** (5) précède le
**salon** (6) parce que le salon prouve son calendrier de tir contre `lastFireAfterCarry` ; le
**miroir** (7) est la logique client, l'**annonce** (8), le **sol** (9), l'**obscurité** (10) et les
**flèches** (11) sont des calques qu'on peut accepter l'un sans l'autre — l'obscurité est un calque
nouveau, avec son coût par image, d'où sa tâche ; le **livrable** (12) quand tout est là ; le
**portique** (13) au contrôleur.


---

### Tâche 1 : le modèle partagé et le fil — sept genres, le bit solo, l'octet d'état

**Fichiers :**
- Modifier : `shared/evenements.ts` (`EVENT_KIND` l.10-15 ; constantes en fin de fichier),
  `shared/protocol.ts` (import en tête ; `EventStartMessage` l.1789-1811 ; doc d'`EventStateMessage`
  l.1813-1826 ; `encodeEvent` l.1847 ; `decodeEventStart` l.1887-1892),
  `back/src/room.ts` (`#startEvent`, le message l.2431-2436 : `solo`)
- Tester : `shared/protocol.test.ts` (tests l.1742-1745, l.1751-1757, l.1766-1773, l.1820-1827 ;
  nouveau `describe` en fin de fichier), `front/src/net/evenement.test.ts` (constantes `FORGE` et
  `CONVOI` l.105-118 : `solo: false`)

**Interfaces :**
- Consomme : rien.
- Produit : `EVENT_KIND.SIEGE = 3`, `RELIQUE = 4`, `CHASSE = 5`, `NOIR = 6` ;
  `EVENT_KIND_COUNT = 7` ; `EVENT_SOLO_FLAG = 0x80` ; `TOTEM_RADIUS = 28` ;
  `SIEGE_DEFEND_RADIUS = 150` ; `RELIQUE_CARRIER_SPEED = 0.6` ; `RELIQUE_CARRIER_SPEED_SOLO = 0.8` ;
  `RELIQUE_ALTAR_RADIUS = 80` ; `NOIR_LIGHT_RADIUS = 350` ; `NOIR_LIGHT_RADIUS_SOLO = 500` ;
  `relicSpeedFactor(solo: boolean): number` ; `lightRadius(solo: boolean): number` ;
  `EventStartMessage.solo: boolean` (encodé dans le bit 7 de l'octet de genre).

- [ ] **Étape 1 : écrire les tests qui échouent**

`shared/protocol.test.ts` : l'import l.13 devient

```ts
import {
  EVENT_DURATION_TICKS,
  EVENT_KIND,
  EVENT_KIND_COUNT,
  EVENT_OUTCOME,
  EVENT_SOLO_FLAG,
  lightRadius,
  relicSpeedFactor,
} from './evenements';
```

Le test l.1742-1745 devient :

```ts
  it('le genre et l issue ont leurs valeurs du fil : les trois premiers genres ne bougent pas', () => {
    expect(EVENT_KIND).toEqual({
      SCEAUX: 0,
      FORGE: 1,
      CONVOI: 2,
      SIEGE: 3,
      RELIQUE: 4,
      CHASSE: 5,
      NOIR: 6,
    });
    expect(EVENT_KIND_COUNT).toBe(7);
    expect(EVENT_OUTCOME).toEqual({ REUSSI: 0, EXPIRE: 1, DETRUIT: 2 });
  });
```

Dans les trois `EventMessage` d'`EVENT_START` écrits à la main (l.1752-1757, l.1766-1773,
l.1820-1827), ajouter `solo: false,` après `durationTicks: EVENT_DURATION_TICKS,`. Puis en fin de
fichier :

```ts
describe('etape 16 : le bit solo d EVENT_START, l octet d etat d EVENT_STATE', () => {
  it('EVENT_SOLO_FLAG est le bit haut : les sept genres tiennent sous lui', () => {
    expect(EVENT_SOLO_FLAG).toBe(0x80);
    expect(EVENT_KIND_COUNT - 1).toBeLessThan(EVENT_SOLO_FLAG);
  });

  it('aller-retour de solo vrai et faux pour les sept genres ; l octet vaut kind | 0x80 en solo', () => {
    for (let kind = 0; kind < EVENT_KIND_COUNT; kind++) {
      for (const solo of [false, true]) {
        const msg: EventMessage = {
          type: MSG.EVENT_START,
          kind,
          solo,
          durationTicks: EVENT_DURATION_TICKS,
          points: [{ x: 100 + kind, y: 200 }],
        };
        const buf = encodeEvent(msg);
        expect(new DataView(buf).getUint8(1)).toBe(solo ? kind | 0x80 : kind);
        expect(decode(buf)).toEqual(msg);
      }
    }
  });

  it('le genre est masque a 7 bits : un genre hors bornes ne deborde jamais sur le bit solo', () => {
    const buf = encodeEvent({
      type: MSG.EVENT_START,
      kind: 0x83,
      solo: false,
      durationTicks: EVENT_DURATION_TICKS,
      points: [],
    });
    expect(decode(buf)).toMatchObject({ kind: 3, solo: false });
  });

  it('tailles : siege 9 o, relique 13 o, chasse 17 o (13 o en solo), noir 5 o (n = 0)', () => {
    const taille = (kind: number, n: number): number =>
      encodeEvent({
        type: MSG.EVENT_START,
        kind,
        solo: false,
        durationTicks: EVENT_DURATION_TICKS,
        points: Array.from({ length: n }, (_, i) => ({ x: i, y: i })),
      }).byteLength;
    expect(taille(EVENT_KIND.SIEGE, 1)).toBe(9);
    expect(taille(EVENT_KIND.RELIQUE, 2)).toBe(13);
    expect(taille(EVENT_KIND.CHASSE, 3)).toBe(17);
    expect(taille(EVENT_KIND.CHASSE, 2)).toBe(13);
    expect(taille(EVENT_KIND.NOIR, 0)).toBe(5);
    const noir = encodeEvent({
      type: MSG.EVENT_START,
      kind: EVENT_KIND.NOIR,
      solo: true,
      durationTicks: EVENT_DURATION_TICKS,
      points: [],
    });
    expect(decode(noir)).toEqual({
      type: MSG.EVENT_START,
      kind: EVENT_KIND.NOIR,
      solo: true,
      durationTicks: EVENT_DURATION_TICKS,
      points: [],
    });
  });

  it('l octet d etat porte un identifiant de joueur intact (1 a 4), et 0 « au sol »', () => {
    for (const id of [0, 1, 2, 3, 4]) {
      const buf = encodeEvent({ type: MSG.EVENT_STATE, progress: 10, cartX: 5, cartY: 6, cartHp: id });
      expect(decode(buf)).toMatchObject({ cartHp: id });
    }
  });

  it('la relique ralentit a 0,6 (0,8 seul) ; la lanterne eclaire 350 px (500 seul)', () => {
    expect(relicSpeedFactor(false)).toBe(0.6);
    expect(relicSpeedFactor(true)).toBe(0.8);
    expect(lightRadius(false)).toBe(350);
    expect(lightRadius(true)).toBe(500);
  });
});
```

`front/src/net/evenement.test.ts` : dans `FORGE` (l.105-110) et `CONVOI` (l.111-118), ajouter
`solo: false,` après `durationTicks: EVENT_DURATION_TICKS,`.

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run ../shared/protocol.test.ts`
Attendu : ÉCHEC — `EVENT_KIND_COUNT`, `EVENT_SOLO_FLAG`, `relicSpeedFactor`, `lightRadius` non
exportés ; une fois posés, l'aller-retour échoue encore (`solo` absent du décodé).

- [ ] **Étape 3 : implémenter**

`shared/evenements.ts` : `EVENT_KIND` (l.10-15) devient

```ts
/**
 * Le genre, l'octet `genre` d'`EVENT_START` (ses 7 bits bas ; le bit haut dit
 * « solo », `EVENT_SOLO_FLAG`). L'index EST l'identifiant : les quatre genres
 * de l'etape 16 viennent APRES les trois de l'etape 14, qui ne bougent pas.
 */
export const EVENT_KIND = {
  SCEAUX: 0,
  FORGE: 1,
  CONVOI: 2,
  SIEGE: 3,
  RELIQUE: 4,
  CHASSE: 5,
  NOIR: 6,
} as const;

/** Le nombre de genres : `placeEvent` lit `seed % EVENT_KIND_COUNT`. */
export const EVENT_KIND_COUNT = Object.keys(EVENT_KIND).length;

/**
 * Le bit haut de l'octet de genre d'`EVENT_START` : « un seul vivant au
 * depart ». Zero octet de plus — le client en a besoin pour predire la
 * vitesse du porteur de relique et dessiner la lumiere (etape 16, §7.1).
 */
export const EVENT_SOLO_FLAG = 0x80;
```

et en fin de fichier :

```ts
/** Le siege (etape 16, §3) : le corps dessine du totem ; son rayon de contact en derive au serveur. */
export const TOTEM_RADIUS = 28;
/** Un joueur vivant a cette distance du totem le defend : le compte avance. */
export const SIEGE_DEFEND_RADIUS = 150;
/** La relique (§4) : son porteur avance a cette part de sa vitesse, et ne tire pas. */
export const RELIQUE_CARRIER_SPEED = 0.6;
export const RELIQUE_CARRIER_SPEED_SOLO = 0.8;
/** Le porteur a cette distance de l'autel livre la relique. */
export const RELIQUE_ALTAR_RADIUS = 80;
/** Le noir (§6) : le rayon de la lumiere autour du porteur de lanterne. */
export const NOIR_LIGHT_RADIUS = 350;
export const NOIR_LIGHT_RADIUS_SOLO = 500;

/**
 * Le facteur de vitesse du porteur de relique. UNE fonction pour le salon
 * (`EventRun#speedFactorOf`) et la prediction (`GameClient#localSpeed`) : deux
 * copies divergeraient a la premiere retouche.
 */
export function relicSpeedFactor(solo: boolean): number {
  return solo ? RELIQUE_CARRIER_SPEED_SOLO : RELIQUE_CARRIER_SPEED;
}

/** Le rayon de la lumiere du noir, au salon (`inDark`) comme a l'ecran. */
export function lightRadius(solo: boolean): number {
  return solo ? NOIR_LIGHT_RADIUS_SOLO : NOIR_LIGHT_RADIUS;
}
```

`shared/protocol.ts` : ajouter en tête `import { EVENT_SOLO_FLAG } from './evenements';` (à côté
des autres imports de `./…`). Dans `EventStartMessage` (l.1805-1811), après `kind: number;` :

```ts
  /**
   * Un seul vivant au depart (etape 16, §7.1) : le BIT HAUT de l'octet de
   * genre, zero octet de plus.
   */
  solo: boolean;
```

La doc d'`EventStateMessage` (l.1813-1819) devient :

```ts
/**
 * S -> C : ou en est l'evenement, a 5 Hz de jeu vivant (et une fois de plus
 * a chaque changement de porteur de relique), 7 octets.
 * `type u8 · progression u8 · x i16 · y i16 · etat u8`. Octets DEJA
 * quantifies par le salon. `x, y` : le chariot (convoi), la relique ; zeros
 * sinon. L'octet d'etat `cartHp` se lit selon le genre (etape 16, §7.2) :
 * PV `ceil(255 x pv / pvMax)` du chariot ou du totem (0 seulement detruit),
 * l'id du porteur de la relique (0 au sol), l'id du porteur de lanterne ;
 * zero sinon.
 */
```

Dans `encodeEvent`, la ligne `v.setUint8(1, msg.kind);` (l.1847) devient :

```ts
    // Masque a 7 bits : un genre hors bornes ne deborde jamais sur le bit solo.
    v.setUint8(1, (msg.kind & 0x7f) | (msg.solo ? EVENT_SOLO_FLAG : 0));
```

Dans `decodeEventStart`, le `return` (l.1887-1892) devient :

```ts
  const genre = v.getUint8(1);
  return {
    type: MSG.EVENT_START,
    kind: genre & 0x7f,
    solo: (genre & EVENT_SOLO_FLAG) !== 0,
    durationTicks: v.getUint16(2, true),
    points,
  };
```

`back/src/room.ts`, `#startEvent`, le message mis en file (l.2431-2436) gagne `solo: plan.solo,`
après `kind: plan.kind,` (sinon le typecheck rougit ; le salon le remplit dès maintenant).

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run ../shared/protocol.test.ts src/room.test.ts -t "etape 1[46]"`
puis `cd front && npx vitest run src/net/evenement.test.ts`
Attendu : PASS.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write shared/evenements.ts shared/protocol.ts shared/protocol.test.ts back/src/room.ts front/src/net/evenement.test.ts
git add shared/evenements.ts shared/protocol.ts shared/protocol.test.ts back/src/room.ts front/src/net/evenement.test.ts
git commit -m "feat(shared): sept genres d evenement, le bit solo et l octet d etat"
```

---

### Tâche 2 : la proie — un gnoll agrandi qui fuit comme le porteur, sans un octet ni un pixel de dérive

**Fichiers :**
- Modifier : `shared/archetypes.ts` (constantes après `PORTEUR_BODY_SCALE` l.302 ; `Behavior`
  l.239-250 ; `hpOf` l.388-393 ; `bodyScaleOf` l.396-401 ; `PROIE` après `PORTEUR` l.552-560 ;
  `ARCHETYPES` l.570-576 ; `PROIE_ARCHETYPE` après l.631), `shared/horde.ts` (l.707-714 et
  l.1117-1120)
- Tester : `shared/archetypes.test.ts` (import l.3-28 ; l.101-113 ; l.216-228 ; l.294-299 ;
  nouveau `describe` en fin), `shared/horde.test.ts` (import l.3-11 ; nouveau `describe` en fin),
  `shared/horde.replication.test.ts` (import l.4 ; `runChaseDeathScenario` l.3250 ; deux scénarios
  après PT2, l.3420)

**Interfaces :**
- Consomme : rien.
- Produit : `PROIE_NAME = 'proie'`, `PROIE_HP_MULTIPLE = 8`, `PROIE_HP` (160),
  `PROIE_SPEED_FACTOR = 0.75`, `PROIE_BODY_SCALE = 1.6`, `PROIE_ARCHETYPE: number`
  (= `PORTEUR_ARCHETYPE + 1`, le dernier) ; `Behavior` gagne `'proie'`, que `Horde.retarget` et
  `Horde.step` traitent comme `'porteur'`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`shared/archetypes.test.ts` : ajouter à l'import de `./archetypes` `PROIE_ARCHETYPE`,
`PROIE_BODY_SCALE`, `PROIE_HP`, `PROIE_HP_MULTIPLE`, `PROIE_NAME`, `PROIE_SPEED_FACTOR`. Dans le
test des PV (l.101-113), l'`attendu` devient :

```ts
      const attendu =
        a.id === BOSS_ARCHETYPE
          ? BOSS_HP_PER_PLAYER
          : a.id === PORTEUR_ARCHETYPE
            ? PORTEUR_HP
            : a.id === PROIE_ARCHETYPE
              ? PROIE_HP
              : ROLES[a.role].hp;
```

(et son commentaire « Deux exceptions » devient « Trois exceptions »). Dans le test des corps
(l.224) :

```ts
      const attendu =
        a.id === PORTEUR_ARCHETYPE
          ? PORTEUR_BODY_SCALE
          : a.id === PROIE_ARCHETYPE
            ? PROIE_BODY_SCALE
            : ROLES[a.role].bodyScale;
```

Dans « vient APRES le troll » (l.294-299), la dernière ligne devient
`expect(ARCHETYPES).toHaveLength(PROIE_ARCHETYPE + 1);`. Puis en fin de fichier :

```ts
describe('etape 16 : la proie de la chasse', () => {
  const PROIE = archetypeOf(PROIE_ARCHETYPE);
  const GNOLL = archetypeOf(archetypeIdOf('gnoll'));

  it('vient APRES le porteur : aucun identifiant existant ne bouge', () => {
    expect(PROIE.name).toBe(PROIE_NAME);
    expect(PROIE_ARCHETYPE).toBe(PORTEUR_ARCHETYPE + 1);
    expect(ARCHETYPES[PORTEUR_ARCHETYPE]?.name).toBe(PORTEUR_NAME);
    expect(PORTEUR_ARCHETYPE).toBe(BOSS_ARCHETYPE + 1);
  });

  it('PV = HEAVY_HP x 8 = 160, armure nulle, role troupe, jamais tiree au hasard', () => {
    expect(PROIE_HP).toBe(HEAVY_HP * PROIE_HP_MULTIPLE);
    expect(PROIE.hp).toBe(160);
    expect(PROIE.armor).toBe(0);
    expect(PROIE.role).toBe('troupe');
    expect(STEP2_ARCHETYPES).not.toContain(PROIE_ARCHETYPE);
  });

  it('round(PLAYER_SPEED x 0,75) = 195 px/s, plus lente que le porteur', () => {
    expect(PROIE.speed).toBe(Math.round(PLAYER_SPEED * PROIE_SPEED_FACTOR));
    expect(PROIE.speed).toBe(195);
    expect(PROIE.speed).toBeLessThan(archetypeOf(PORTEUR_ARCHETYPE).speed);
  });

  it('la planche du gnoll, 1,6 fois plus grande, le comportement proie', () => {
    expect(PROIE.sheet).toBe(GNOLL.sheet);
    expect(PROIE.frames).toBe(GNOLL.frames);
    expect(PROIE.cell).toBe(GNOLL.cell);
    expect(PROIE.bodyScale).toBe(PROIE_BODY_SCALE);
    expect(PROIE.hitScale).toBe(PROIE_BODY_SCALE);
    expect(PROIE.behavior).toBe('proie');
  });
});
```

`shared/horde.test.ts` : ajouter `PROIE_ARCHETYPE` à l'import de `./archetypes`, puis en fin de
fichier :

```ts
describe('etape 16 : la proie fuit avec la regle du porteur', () => {
  function seule(archetype: number): Horde {
    const h = new Horde(4);
    h.spawn(order({ archetype, count: 1, formation: FORMATION.POINT }));
    h.x[0] = 1000;
    h.y[0] = 1000;
    return h;
  }

  it('joueur (retarde) a 400 px : elle fuit ; a 401 : elle attend sur place', () => {
    const h = seule(PROIE_ARCHETYPE);
    h.retarget([1000 + PORTEUR_FLEE_RADIUS], [1000]);
    expect(h.fleeing[0]).toBe(1);
    expect(h.stopped[0]).toBe(0);
    h.retarget([1000 + PORTEUR_FLEE_RADIUS + 1], [1000]);
    expect(h.fleeing[0]).toBe(0);
    expect(h.stopped[0]).toBe(1);
  });

  it('en fuite elle s eloigne au facteur -1 de SA vitesse, comme le porteur (pas THIEF_FLEE_SPEED)', () => {
    const proie = seule(PROIE_ARCHETYPE);
    const porteur = seule(PORTEUR_ARCHETYPE);
    for (const h of [proie, porteur]) {
      h.retarget([1300], [1000]);
    }
    for (let t = 1; t <= 10; t++) {
      for (const h of [proie, porteur]) {
        h.vx[0] = 100;
        h.vy[0] = 0;
        h.step(DT, [], t);
      }
    }
    expect(proie.x[0]).toBeLessThan(1000);
    // Meme vitesse posee, meme facteur de fuite : le meme pas.
    expect(proie.x[0]).toBeCloseTo(porteur.x[0] ?? 0, 3);
  });
});
```

`shared/horde.replication.test.ts` : l'import l.4 devient
`import { archetypeOf, PORTEUR_ARCHETYPE, PROIE_ARCHETYPE } from './archetypes';`.
`runChaseDeathScenario` (l.3250) prend un troisième paramètre
`archetype: number = PORTEUR_ARCHETYPE`, et ses deux ordres `porteur` et `escorte` (l.3253-3281)
portent `archetype` au lieu de `PORTEUR_ARCHETYPE`. Puis, après le scénario PT2 (avant la `});`
finale l.3421) :

```ts
  /**
   * Etape 16 : la proie de la chasse emprunte la regle du porteur
   * (`behavior === 'porteur' || 'proie'`) a une autre vitesse (195 px/s au
   * lieu de 234). Meme decor, meme mort tardive : sans rejeu la horde derive,
   * avec rejeu 0,000 px — la proie ne coute rien a la horde repliquee.
   */
  it('scenario PR1 - la proie : sans rejeu, la mort tardive laisse une derive mesurable', () => {
    const r = runChaseDeathScenario(0x11_f1_ee01, false, PROIE_ARCHETYPE);
    process.stdout.write(
      `etape 16, scenario PR1 (sans rejeu) : derive de la proie ${r.bearerDrift.toFixed(3)} px, derive de la horde ${r.maxDrift.toFixed(3)} px\n`,
    );
    expect(r.maxDrift).toBeGreaterThan(0);
  });

  it('scenario PR2 - la proie : avec rejeu, 0,000 px, attente et fuite vues', () => {
    const r = runChaseDeathScenario(0x11_f1_ee01, true, PROIE_ARCHETYPE);
    process.stdout.write(
      `etape 16, scenario PR2 (avec rejeu) : derive de la proie ${r.bearerDrift.toFixed(3)} px, derive de la horde ${r.maxDrift.toFixed(3)} px\n`,
    );
    expect(r.vuAttendre).toBe(true);
    expect(r.vuFuir).toBe(true);
    expect(r.deplacement).toBeGreaterThan(50);
    expect(r.bearerDrift).toBe(0);
    expect(r.maxDrift).toBe(0);
  });
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run ../shared/archetypes.test.ts ../shared/horde.test.ts`
Attendu : ÉCHEC — `PROIE_ARCHETYPE` non exporté.

- [ ] **Étape 3 : implémenter**

`shared/archetypes.ts`, après `PORTEUR_BODY_SCALE` (l.302) :

```ts
/**
 * La proie de la chasse (etape 16, §5) : une elite que le SALON fait naitre
 * pendant l'evenement, jamais le hasard ni le directeur. Un gnoll agrandi qui
 * emprunte la regle de fuite du porteur (`Horde.retarget`) — attendre loin,
 * fuir le plus proche sous `PORTEUR_FLEE_RADIUS` — a sa vitesse a elle.
 */
export const PROIE_NAME = 'proie';
/** Ses PV, en multiple de `HEAVY_HP` : 160 au niveau 1, puis `monsterHp` (etape 15). */
export const PROIE_HP_MULTIPLE = 8;
export const PROIE_HP = HEAVY_HP * PROIE_HP_MULTIPLE;
/** 195 px/s : plus lente que le porteur (234), on la rattrape a 65 px/s. */
export const PROIE_SPEED_FACTOR = 0.75;
/** Dessinee 1,6 fois plus grande — et touchee 1,6 fois plus large, comme le porteur. */
export const PROIE_BODY_SCALE = 1.6;
```

`Behavior` (l.239-250) : ajouter `| 'proie'` après `| 'porteur'`, et à sa doc (l.236-237) :

```ts
 * - `proie` : la proie de la chasse (etape 16) — la regle du porteur, a sa vitesse.
```

`hpOf` (l.388-393) et `bodyScaleOf` (l.396-401) gagnent, en tête :

```ts
  if (name === PROIE_NAME) {
    return PROIE_HP;
  }
```

et respectivement

```ts
  if (name === PROIE_NAME) {
    return PROIE_BODY_SCALE;
  }
```

Après la constante `PORTEUR` (l.552-560) :

```ts
/**
 * La proie : la planche, le cycle et la cellule du gnoll, sa vitesse a elle.
 * Rangee APRES le porteur, pour qu'aucun identifiant existant ne bouge.
 */
const PROIE: Omit<Archetype, 'id' | 'hp' | 'armor' | 'bodyScale' | 'hitScale' | 'countFactor'> = {
  name: PROIE_NAME,
  sheet: 'Gnoll/Gnoll_Walk.png',
  frames: 8,
  cell: 192,
  speed: Math.round(PLAYER_SPEED * PROIE_SPEED_FACTOR),
  role: 'troupe',
  behavior: 'proie',
};
```

Dans `ARCHETYPES` (l.570-576), après `PORTEUR,` : `// La proie (etape 16), apres lui.` puis
`PROIE,`. Après `PORTEUR_ARCHETYPE` (l.631) :

```ts
/** Identifiant de la proie de la chasse, derive du nom comme `PORTEUR_ARCHETYPE`. */
export const PROIE_ARCHETYPE: number = archetypeIdOf(PROIE_NAME);
```

⚠️ Vérifier avant d'écrire que la planche du gnoll a bien `frames: 8, cell: 192`
(`shared/archetypes.ts` l.418-423) ; si elle diffère, recopier SES valeurs — le test « la planche
du gnoll » les compare.

`shared/horde.ts` l.707-710 : le commentaire gagne « La proie de la chasse (etape 16) partage
cette regle. » et la condition devient `if (behavior === 'porteur' || behavior === 'proie') {`.
L.1117-1120 :

```ts
      // En fuite, le voleur remonte le flowfield a `THIEF_FLEE_SPEED` ; le
      // porteur et la proie a leur vitesse propre, qui est deja leur vitesse de fuite.
      const fuite =
        this.fleeing[i] === 1
          ? arch.behavior === 'porteur' || arch.behavior === 'proie'
            ? -1
            : -THIEF_FLEE_SPEED
          : 1;
```

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run ../shared/archetypes.test.ts ../shared/horde.test.ts`
Attendu : PASS.
Run : `cd back && npx vitest run ../shared/horde.replication.test.ts -t "scenario P"`
Attendu : PASS — PT1/PT2 inchangés, PR1 dérive > 0, PR2 **0,000 px**. Si PR2 ne voit pas la proie
fuir (`vuFuir` faux), c'est le décor qui ne la met pas sous 400 px : le dire au contrôleur, ne pas
changer la règle.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write shared/archetypes.ts shared/archetypes.test.ts shared/horde.ts shared/horde.test.ts shared/horde.replication.test.ts
git add shared/archetypes.ts shared/archetypes.test.ts shared/horde.ts shared/horde.test.ts shared/horde.replication.test.ts
git commit -m "feat(shared): la proie de la chasse, un gnoll qui fuit comme le porteur"
```

---

### Tâche 3 : le placement — sept genres, sans un tirage de plus, sur de vraies cartes

**Fichiers :**
- Modifier : `back/src/evenement.ts` (imports l.1-20 ; constantes après l.54 ; `EventPlan`
  l.61-68 ; doc et corps de `placeEvent` l.184-246)
- Tester : `back/src/evenement.test.ts` (imports l.2-30 ; `graine` l.37-41 ; `equipe` l.106-109 ;
  le test l.111-115 ; les appels à `placeEvent` l.113-275 ; les trois `EventPlan` l.282-289,
  l.326, l.366 ; nouveau `describe` après l.279), `back/src/room.test.ts` (l.5920-5921),
  `back/src/evenement.integration.test.ts` (l.38-39)

**Interfaces :**
- Consomme : `EVENT_KIND`, `EVENT_KIND_COUNT` (tâche 1).
- Produit : `placeEvent(seed: number, vivants: readonly { id: number; x: number; y: number }[],
  obstacles: ObstacleField): EventPlan` ; `EventPlan.carrier: number` (noir : l'id du porteur de
  lanterne ; 0 sinon) ; constantes `RELIQUE_DISTANCE = 1500`, `CHASSE_SPACING = 1200`,
  `CHASSE_PREY = 3`, `CHASSE_PREY_SOLO = 2`. Points rendus : siège `[totem]`, relique
  `[relique, autel]`, chasse `[n lieux]`, noir `[]`.

Le directeur (`back/src/wave-director.ts`) **n'est pas touché** : la graine qu'il marque
(l.383-394) est lue modulo 7 au lieu de 3, c'est tout. L'étape 4 le vérifie par ses propres tests,
inchangés.

- [ ] **Étape 1 : écrire les tests qui échouent**

`back/src/evenement.test.ts` : à l'import de `@shared/evenements` ajouter `EVENT_KIND_COUNT` ; à
l'import de `./evenement` ajouter `CHASSE_PREY`, `CHASSE_PREY_SOLO`, `CHASSE_SPACING`,
`RELIQUE_DISTANCE`. `graine` (l.37-41) devient :

```ts
/** Une graine du genre voulu, a angle varie : le genre est `graine % EVENT_KIND_COUNT`. */
function graine(genre: number, k: number): number {
  const s = (Math.imul(k + 1, 0x9e37_79b9) >>> 0) % 0xffff_fff0;
  return s - (s % EVENT_KIND_COUNT) + genre;
}

/** Des vivants avec leur identifiant (1, 2, ...) : `placeEvent` les lit depuis l'etape 16. */
const ids = (pts: readonly { x: number; y: number }[]): { id: number; x: number; y: number }[] =>
  pts.map((p, k) => ({ id: k + 1, x: p.x, y: p.y }));
```

`equipe` (l.106-109) devient `[{ id: 1, x: 2900, y: 3000 }, { id: 2, x: 3100, y: 3000 }]`. Partout
ailleurs où un tableau de vivants est passé à `placeEvent` (l.136, l.139-141, l.164-166, l.193,
l.209-215, l.252-254, l.275), l'envelopper dans `ids(...)` (`[{ x: 3000, y: 3000 }]` devient
`ids([{ x: 3000, y: 3000 }])`, `vivants` devient `ids(vivants)`). Le test l.111-115 devient :

```ts
  it('le genre est graine % 7, sans tirage : la meme graine rend le meme plan', () => {
    for (let s = 0; s < 700; s++) {
      const plan = placeEvent(s, equipe, ouvert());
      expect(plan.kind).toBe(s % EVENT_KIND_COUNT);
      expect(placeEvent(s, equipe, ouvert())).toEqual(plan);
    }
  });
```

Les trois `EventPlan` écrits à la main (l.282-289, l.326, l.366) gagnent `carrier: 0`.

⚠️ **Les deux autres aides de graine (écart n° 2)** : sans elles, `graine(SCEAUX)` tirerait la
relique dès ce commit et les tests de l'étape 14 du salon et du livrable rougiraient.
`back/src/room.test.ts` l.5920-5921 et `back/src/evenement.integration.test.ts` l.38-39
deviennent :

```ts
  /** Une graine du genre voulu : le genre est `graine % EVENT_KIND_COUNT` (7). */
  const graine = (genre: number): number => 7 * 0x4_6a2b + genre;
```

(sans indentation dans le livrable). Puis, après le `describe` de placement (l.279) :

```ts
describe('etape 16 : placeEvent — siege, relique, chasse, noir', () => {
  const centre = { x: 3000, y: 3000 };

  it('le siege : un totem, a EVENT_SPAWN_DISTANCE du centre des vivants, comme la forge', () => {
    for (let k = 0; k < 100; k++) {
      const s = graine(EVENT_KIND.SIEGE, k);
      const plan = placeEvent(s, equipe, ouvert());
      expect(plan.points).toHaveLength(1);
      expect(plan.carrier).toBe(0);
      const t = plan.points[0] ?? { x: 0, y: 0 };
      expect(Math.abs(dist(t, centre) - EVENT_SPAWN_DISTANCE)).toBeLessThanOrEqual(1);
      expect(Number.isInteger(t.x) && Number.isInteger(t.y)).toBe(true);
    }
  });

  it('la relique : la relique au site, l autel a RELIQUE_DISTANCE vers le centre de la carte', () => {
    for (const c of [centre, { x: 50, y: 50 }, { x: 5950, y: 120 }]) {
      for (let k = 0; k < 100; k++) {
        const plan = placeEvent(graine(EVENT_KIND.RELIQUE, k), ids([c]), ouvert());
        const [s, e] = plan.points;
        if (!s || !e) {
          throw new Error('la relique a deux points');
        }
        expect(Math.abs(dist(s, e) - RELIQUE_DISTANCE)).toBeLessThanOrEqual(1);
        const milieu = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
        expect(dist(e, milieu)).toBeLessThan(dist(s, milieu) + 1);
        expect(plan.carrier).toBe(0);
      }
    }
  });

  it('la chasse : 3 lieux a CHASSE_SPACING (rayon 693 px), 2 en solo (600 px)', () => {
    for (const [vivants, n] of [
      [equipe, CHASSE_PREY],
      [ids([centre]), CHASSE_PREY_SOLO],
    ] as const) {
      for (let k = 0; k < 50; k++) {
        const plan = placeEvent(graine(EVENT_KIND.CHASSE, k), vivants, ouvert());
        expect(plan.points).toHaveLength(n);
        for (let i = 0; i < n; i++) {
          const a = plan.points[i] ?? { x: 0, y: 0 };
          const b = plan.points[(i + 1) % n] ?? { x: 0, y: 0 };
          expect(Math.abs(dist(a, b) - CHASSE_SPACING)).toBeLessThanOrEqual(2);
        }
      }
    }
    // Les rayons de la spec, ecrits nus.
    expect(Math.round(CHASSE_SPACING / (2 * Math.sin(Math.PI / 3)))).toBe(693);
    expect(Math.round(CHASSE_SPACING / (2 * Math.sin(Math.PI / 2)))).toBe(600);
  });

  it('le noir : aucun point, le porteur de lanterne derive de la graine, sans tirage', () => {
    const quatre = ids([centre, centre, centre, centre]);
    const vus = new Set<number>();
    for (let k = 0; k < 400; k++) {
      const s = graine(EVENT_KIND.NOIR, k);
      const plan = placeEvent(s, quatre, ouvert());
      expect(plan.points).toEqual([]);
      const attendu = quatre[Math.floor(((s >>> 8) / 0x100_0000) * quatre.length)]?.id;
      expect(plan.carrier).toBe(attendu);
      vus.add(plan.carrier);
    }
    // Chaque joueur porte la lanterne un jour : la fraction couvre [0, 1).
    expect([...vus].sort()).toEqual([1, 2, 3, 4]);
    // Seul : le seul vivant ; personne : 0, jamais d'indice hors tableau.
    expect(placeEvent(graine(EVENT_KIND.NOIR, 1), [{ id: 3, x: 1, y: 1 }], ouvert()).carrier).toBe(3);
    expect(placeEvent(graine(EVENT_KIND.NOIR, 1), [], ouvert()).carrier).toBe(0);
  });

  it('les trois genres de l etape 14 ne portent pas de porteur', () => {
    for (const genre of [EVENT_KIND.SCEAUX, EVENT_KIND.FORGE, EVENT_KIND.CONVOI]) {
      expect(placeEvent(graine(genre, 2), equipe, ouvert()).carrier).toBe(0);
    }
  });

  /**
   * ⚠️ **La lecon de l'etape 14** : sur un champ ouvert tout passe ; sur une
   * VRAIE ile (cotes en eau), un site pres d'un coin tombe a l'eau si
   * `poserGroupe` ne recentre pas. Memes cartes et memes centres que le test
   * des sceaux.
   */
  it('sur une VRAIE carte : totem, relique, autel et proies sur la terre, dans la carte, entiers ; proies jamais collees', () => {
    const bruts = [
      { x: 100, y: 100 },
      { x: MAP_SIZE - 100, y: 100 },
      { x: 100, y: MAP_SIZE - 100 },
      { x: MAP_SIZE - 100, y: MAP_SIZE - 100 },
      { x: MAP_SIZE / 2, y: MAP_SIZE / 2 },
      { x: 2000, y: 2000 },
    ];
    for (let mapSeed = 1; mapSeed <= 4; mapSeed++) {
      const champ = carteReelle(mapSeed);
      for (const c of bruts.map((b) => terreProche(champ, b.x, b.y))) {
        for (const n of [1, 2, 4]) {
          const vivants = ids(Array.from({ length: n }, () => c));
          for (const genre of [EVENT_KIND.SIEGE, EVENT_KIND.RELIQUE, EVENT_KIND.CHASSE]) {
            for (let k = 0; k < 60; k++) {
              const plan = placeEvent(graine(genre, k), vivants, champ);
              for (const p of plan.points) {
                expect(p.x).toBeGreaterThanOrEqual(0);
                expect(p.x).toBeLessThanOrEqual(MAP_SIZE);
                expect(p.y).toBeGreaterThanOrEqual(0);
                expect(p.y).toBeLessThanOrEqual(MAP_SIZE);
                expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
                expect(champ.blocked[champ.indexAt(p.x, p.y)]).toBe(0);
              }
              if (genre === EVENT_KIND.CHASSE) {
                for (let i = 0; i < plan.points.length; i++) {
                  for (let j = i + 1; j < plan.points.length; j++) {
                    const a = plan.points[i] ?? { x: 0, y: 0 };
                    const b = plan.points[j] ?? { x: 0, y: 0 };
                    expect(dist(a, b)).toBeGreaterThan(2 * SCEAU_RADIUS);
                  }
                }
              }
            }
          }
        }
      }
    }
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run src/evenement.test.ts`
Attendu : ÉCHEC — `RELIQUE_DISTANCE` (et les trois autres) non exportés ; le genre vaut encore
`seed % 3`.

- [ ] **Étape 3 : implémenter**

`back/src/evenement.ts` : l'import de `@shared/evenements` (l.9-17) gagne `EVENT_KIND_COUNT`.
Après `CONVOI_ARRIVAL_RADIUS` (l.54) :

```ts
/** La relique (etape 16, §4) : l'autel est a cette distance du site, vers le centre de la carte. */
export const RELIQUE_DISTANCE = 1500;
/** La chasse (§5) : deux lieux de naissance voisins sont a 1 200 px (rayons 693 et 600 px). */
export const CHASSE_SPACING = 1200;
export const CHASSE_PREY = 3;
export const CHASSE_PREY_SOLO = 2;
```

`EventPlan` (l.61-68) gagne, après `solo` :

```ts
  /**
   * Le noir : l'id du porteur de lanterne, derive de la graine (§6.1), fige
   * pour tout l'evenement. 0 pour tout autre genre.
   */
  carrier: number;
```

et sa doc de `points` devient « Les sceaux ; la forge ; le depart puis l'arrivee du convoi ; le
totem ; la relique puis l'autel ; les lieux des proies ; rien pour le noir. Entiers, dans la carte,
hors mur. »

`placeEvent` (l.196-246) devient (la doc l.184-195 garde son texte, « `seed % 3` » devient
« `seed % EVENT_KIND_COUNT` », et gagne le paragraphe sur le noir) :

```ts
/**
 * ...
 * Le noir (etape 16) n'a pas de lieu : la meme fraction que l'angle choisit
 * le porteur de lanterne parmi les vivants, sans tirage. La chasse pose ses
 * proies sur l'anneau des sceaux, a `CHASSE_SPACING`.
 */
export function placeEvent(
  seed: number,
  vivants: readonly { id: number; x: number; y: number }[],
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
  const kind = seed % EVENT_KIND_COUNT;
  const fraction = (seed >>> 8) / 0x100_0000;
  const theta = fraction * Math.PI * 2;
  const solo = vivants.length <= 1;
  if (kind === EVENT_KIND.NOIR) {
    const porteur = vivants[Math.floor(fraction * vivants.length)];
    return { kind, points: [], solo, carrier: porteur?.id ?? 0 };
  }
  const spawnX = cx + Math.cos(theta) * EVENT_SPAWN_DISTANCE;
  const spawnY = cy + Math.sin(theta) * EVENT_SPAWN_DISTANCE;
  // Un anneau : un sceau par vivant (a plusieurs), ou les proies de la chasse.
  const anneau =
    kind === EVENT_KIND.CHASSE
      ? solo
        ? CHASSE_PREY_SOLO
        : CHASSE_PREY
      : kind === EVENT_KIND.SCEAUX && !solo
        ? vivants.length
        : 0;
  if (anneau > 1) {
    const ecart = kind === EVENT_KIND.CHASSE ? CHASSE_SPACING : SCEAUX_SPACING;
    const rayon = ecart / (2 * Math.sin(Math.PI / anneau));
    const points = poserGroupe(obstacles, spawnX, spawnY, (vx, vy) =>
      Array.from({ length: anneau }, (_, k) => {
        const a = theta + (2 * Math.PI * k) / anneau;
        return { x: vx + Math.cos(a) * rayon, y: vy + Math.sin(a) * rayon };
      }),
    );
    return { kind, points, solo, carrier: 0 };
  }
  const [site] = poserGroupe(obstacles, spawnX, spawnY, (vx, vy) => [{ x: vx, y: vy }]);
  if (!site) {
    // Inatteignable : `poserGroupe` rend toujours au moins un point.
    return { kind, points: [], solo, carrier: 0 };
  }
  if (kind !== EVENT_KIND.CONVOI && kind !== EVENT_KIND.RELIQUE) {
    return { kind, points: [site], solo, carrier: 0 };
  }
  // Le convoi et la relique vont vers le centre de la carte : l'arrivee (l'autel) reste dedans.
  let dx = MAP_SIZE / 2 - site.x;
  let dy = MAP_SIZE / 2 - site.y;
  let d = Math.hypot(dx, dy);
  if (d < 1) {
    dx = Math.cos(theta);
    dy = Math.sin(theta);
    d = 1;
  }
  const trajet = kind === EVENT_KIND.RELIQUE ? RELIQUE_DISTANCE : CONVOI_DISTANCE;
  const arriveeX = site.x + (dx / d) * trajet;
  const arriveeY = site.y + (dy / d) * trajet;
  const [arrivee] = poserGroupe(obstacles, arriveeX, arriveeY, (vx, vy) => [{ x: vx, y: vy }]);
  return { kind, points: [site, arrivee ?? site], solo, carrier: 0 };
}
```

⚠️ `poserGroupe` est réutilisé tel quel (spec §2.3) : ses seuils (`SCEAU_RADIUS`) sont des
garde-fous de géométrie. Aucune ligne de `poserGroupe` ni de `poser` ne change.

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run src/evenement.test.ts src/wave-director.test.ts`
Attendu : PASS — `wave-director.test.ts` **sans une ligne changée** (empreintes FNV comprises :
aucune ligne du directeur n'a bougé).
Run : `cd back && npx vitest run src/room.test.ts -t "etape 14"`
Attendu : PASS (les graines `7k + genre` retombent sur les mêmes genres).

- [ ] **Étape 5 : commit**

```bash
npx biome check --write back/src/evenement.ts back/src/evenement.test.ts back/src/room.test.ts back/src/evenement.integration.test.ts
git add back/src/evenement.ts back/src/evenement.test.ts back/src/room.test.ts back/src/evenement.integration.test.ts
git commit -m "feat(back): placer les sept evenements, le porteur de lanterne tire de la graine"
```

---

### Tâche 4 : les règles — siège, relique, chasse, noir, purs et serveur seul

**Fichiers :**
- Modifier : `back/src/evenement.ts` (imports ; constantes après celles de la tâche 3 ;
  `EventPlayer` l.71-78 ; `EventHorde` l.81-85 ; classe `EventRun` l.253-428)
- Tester : `back/src/evenement.test.ts` (imports ; `joueur` l.43-45 ; `horde` l.47-54 ; nouveaux
  `describe` en fin de fichier)

**Interfaces :**
- Consomme : `EventPlan.carrier`, `RELIQUE_DISTANCE` (tâche 3) ; `TOTEM_RADIUS`,
  `SIEGE_DEFEND_RADIUS`, `RELIQUE_ALTAR_RADIUS`, `relicSpeedFactor`, `lightRadius` (tâche 1).
- Produit :
  - `EventPlayer` gagne `readonly id: number` ; `EventHorde` gagne `slotOf(id: number): number`
    (`PlayerState` et `Horde` les satisfont déjà) ;
  - `new EventRun(plan: EventPlan, field: FlowField, proies: readonly number[] = [])` ;
  - `EventRun.solo: boolean` ; `get carrier(): number` (relique : le porteur, 0 au sol ; noir : la
    lanterne) ; `takeCarrierChanged(): boolean` ; `speedFactorOf(id: number): number` ;
    `holdsFire(id: number): boolean` ; `inDark(p: { x: number; y: number }): boolean` ;
  - `wireState()` rend l'octet d'état selon le genre (§7.2) ;
  - constantes `SIEGE_HOLD_TICKS = 1350`, `SIEGE_HP = 600`, `SIEGE_HP_SOLO = 1200`,
    `SIEGE_CONTACT_RADIUS` (45), `RELIQUE_PICKUP_RADIUS = 48`, `NOIR_HOLD_TICKS = 1200`,
    `NOIR_DRAIN_PER_SEC = 2`.
  - La relique vit dans `cart` (écart n° 5).

- [ ] **Étape 1 : écrire les tests qui échouent**

`back/src/evenement.test.ts` : à l'import de `@shared/evenements` ajouter `NOIR_LIGHT_RADIUS`,
`RELIQUE_ALTAR_RADIUS`, `SIEGE_DEFEND_RADIUS` ; à l'import de `./evenement` ajouter
`NOIR_DRAIN_PER_SEC`, `NOIR_HOLD_TICKS`, `RELIQUE_PICKUP_RADIUS`, `SIEGE_CONTACT_RADIUS`,
`SIEGE_HOLD_TICKS`, `SIEGE_HP`, `SIEGE_HP_SOLO`. `joueur` (l.43-45) devient

```ts
function joueur(x: number, y: number, extra: Partial<EventPlayer> = {}): EventPlayer {
  return { id: 1, x, y, hp: 100, moveX: 0, moveY: 0, ...extra };
}
```

et `horde` (l.47-54) devient

```ts
/** Une horde de test ; `vivantes` : les identites encore presentes (`slotOf >= 0`). */
function horde(
  points: readonly { x: number; y: number }[],
  vivantes: ReadonlySet<number> = new Set(),
): EventHorde {
  return {
    count: points.length,
    x: Float32Array.from(points.map((p) => p.x)),
    y: Float32Array.from(points.map((p) => p.y)),
    slotOf: (id: number) => (vivantes.has(id) ? 0 : -1),
  };
}
```

Puis en fin de fichier :

```ts
describe('etape 16 : EventRun — le siege', () => {
  const T = { x: 2000, y: 2000 };
  const plan: EventPlan = { kind: EVENT_KIND.SIEGE, points: [T], solo: false, carrier: 0 };

  it('un defenseur a 150 px fait monter ; personne suspend sans redescendre', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 90, [joueur(T.x + SIEGE_DEFEND_RADIUS, T.y)]);
    expect(run.progress).toBeCloseTo(90 / SIEGE_HOLD_TICKS, 6);
    pas(run, 90, [joueur(T.x + SIEGE_DEFEND_RADIUS + 1, T.y), joueur(T.x, T.y, { hp: 0 })]);
    expect(run.progress).toBeCloseTo(90 / SIEGE_HOLD_TICKS, 6);
  });

  it('cinq ennemis colles coutent 40 PV par 15 ticks, cinquante pas plus ; juste hors de 45 px rien', () => {
    expect(SIEGE_CONTACT_RADIUS).toBe(45);
    const cinq = new EventRun(plan, ouvert());
    pas(cinq, 15, [], horde(Array.from({ length: 5 }, () => T)));
    expect(cinq.cartHp).toBe(SIEGE_HP - 40);
    const cinquante = new EventRun(plan, ouvert());
    pas(cinquante, 15, [], horde(Array.from({ length: 50 }, () => T)));
    expect(cinquante.cartHp).toBe(SIEGE_HP - 40);
    const loin = new EventRun(plan, ouvert());
    pas(loin, 15, [], horde([{ x: T.x + SIEGE_CONTACT_RADIUS + 1, y: T.y }]));
    expect(loin.cartHp).toBe(SIEGE_HP);
  });

  it('detruit a 0 PV : 600 PV sous cinq ennemis au 225e tick ; 1 200 en solo', () => {
    const run = new EventRun(plan, ouvert());
    const cinq = horde(Array.from({ length: 5 }, () => T));
    expect(pas(run, 224, [], cinq)).toBeNull();
    expect(run.step([], cinq, DT)).toBe(EVENT_OUTCOME.DETRUIT);
    const seul = new EventRun({ ...plan, solo: true }, ouvert());
    expect(seul.cartHpMax).toBe(SIEGE_HP_SOLO);
    expect(pas(seul, 225, [], cinq)).toBeNull();
    expect(seul.cartHp).toBe(SIEGE_HP_SOLO - 600);
  });

  it('reussi a 1 350 ticks tenus ; wireState porte les PV du totem et zero position', () => {
    const run = new EventRun(plan, ouvert());
    expect(pas(run, SIEGE_HOLD_TICKS - 1, [joueur(T.x, T.y)])).toBeNull();
    expect(run.step([joueur(T.x, T.y)], PERSONNE, DT)).toBe(EVENT_OUTCOME.REUSSI);
    const etat = new EventRun(plan, ouvert());
    pas(etat, 15, [], horde([T]));
    expect(etat.wireState()).toEqual({
      progress: 0,
      cartX: 0,
      cartY: 0,
      cartHp: Math.ceil((255 * (SIEGE_HP - 8)) / SIEGE_HP),
    });
  });
});

describe('etape 16 : EventRun — la relique', () => {
  const S = { x: 1000, y: 3000 };
  const E = { x: 2500, y: 3000 };
  const plan: EventPlan = { kind: EVENT_KIND.RELIQUE, points: [S, E], solo: false, carrier: 0 };

  it('ramassage a 48 px par le PREMIER vivant dans l ordre ; un mort ne ramasse pas', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 1, [joueur(S.x + RELIQUE_PICKUP_RADIUS + 1, S.y, { id: 2 })]);
    expect(run.carrier).toBe(0);
    pas(run, 1, [
      joueur(S.x, S.y, { id: 3, hp: 0 }),
      joueur(S.x + RELIQUE_PICKUP_RADIUS, S.y, { id: 2 }),
      joueur(S.x, S.y, { id: 4 }),
    ]);
    expect(run.carrier).toBe(2);
  });

  it('elle suit son porteur, arrondie ; sa mort la laisse au sol a sa derniere position ; un autre la reprend', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 1, [joueur(S.x, S.y, { id: 1 })]);
    pas(run, 1, [joueur(1300.4, 3010.6, { id: 1 })]);
    expect(run.cart).toEqual({ x: 1300, y: 3011 });
    pas(run, 1, [joueur(1400, 3000, { id: 1, hp: 0 }), joueur(5000, 5000, { id: 2 })]);
    expect(run.carrier).toBe(0);
    expect(run.cart).toEqual({ x: 1300, y: 3011 });
    pas(run, 1, [joueur(1300, 3011 + RELIQUE_PICKUP_RADIUS, { id: 2 })]);
    expect(run.carrier).toBe(2);
  });

  it('un porteur absent (parti) la lache aussi', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 1, [joueur(S.x, S.y, { id: 1 })]);
    pas(run, 1, [joueur(5000, 5000, { id: 2 })]);
    expect(run.carrier).toBe(0);
  });

  it('livree a 80 px de l autel : reussi ; la progression suit la relique comme le chariot', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 1, [joueur(S.x, S.y)]);
    pas(run, 1, [joueur(S.x + 750, S.y)]);
    expect(run.progress).toBeCloseTo(0.5, 5);
    expect(pas(run, 1, [joueur(E.x - RELIQUE_ALTAR_RADIUS - 1, E.y)])).toBeNull();
    expect(run.step([joueur(E.x - RELIQUE_ALTAR_RADIUS, E.y)], PERSONNE, DT)).toBe(
      EVENT_OUTCOME.REUSSI,
    );
  });

  it('la chute du porteur n est pas un echec : seules 60 s sans livraison le sont', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 1, [joueur(S.x, S.y)]);
    expect(pas(run, EVENT_DURATION_TICKS - 2, [joueur(S.x, S.y, { hp: 0 })])).toBeNull();
    expect(run.step([], PERSONNE, DT)).toBe(EVENT_OUTCOME.EXPIRE);
  });

  it('speedFactorOf : 0,6 pour le porteur (0,8 seul), 1 pour les autres, et 1 hors relique', () => {
    const run = new EventRun(plan, ouvert());
    expect(run.speedFactorOf(1)).toBe(1);
    pas(run, 1, [joueur(S.x, S.y, { id: 1 })]);
    expect(run.speedFactorOf(1)).toBe(0.6);
    expect(run.speedFactorOf(2)).toBe(1);
    expect(run.speedFactorOf(0)).toBe(1);
    const seul = new EventRun({ ...plan, solo: true }, ouvert());
    pas(seul, 1, [joueur(S.x, S.y, { id: 1 })]);
    expect(seul.speedFactorOf(1)).toBe(0.8);
    const forge = new EventRun(
      { kind: EVENT_KIND.FORGE, points: [S], solo: false, carrier: 0 },
      ouvert(),
    );
    pas(forge, 1, [joueur(S.x, S.y, { id: 1 })]);
    expect(forge.speedFactorOf(1)).toBe(1);
    expect(forge.holdsFire(1)).toBe(false);
  });

  it('holdsFire vrai pour le seul porteur ; takeCarrierChanged vrai UNE fois par transition', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 1, []);
    expect(run.takeCarrierChanged()).toBe(false);
    pas(run, 1, [joueur(S.x, S.y, { id: 1 })]);
    expect(run.holdsFire(1)).toBe(true);
    expect(run.holdsFire(2)).toBe(false);
    expect(run.takeCarrierChanged()).toBe(true);
    expect(run.takeCarrierChanged()).toBe(false);
    pas(run, 1, [joueur(S.x, S.y, { id: 1 })]);
    expect(run.takeCarrierChanged()).toBe(false);
    pas(run, 1, [joueur(S.x, S.y, { id: 1, hp: 0 })]);
    expect(run.holdsFire(1)).toBe(false);
    expect(run.takeCarrierChanged()).toBe(true);
  });

  it('wireState : la relique en x, y et l id du porteur dans l octet d etat (0 au sol)', () => {
    const run = new EventRun(plan, ouvert());
    expect(run.wireState()).toEqual({ progress: 0, cartX: S.x, cartY: S.y, cartHp: 0 });
    pas(run, 1, [joueur(S.x + 10, S.y, { id: 3 })]);
    expect(run.wireState()).toMatchObject({ cartX: S.x + 10, cartY: S.y, cartHp: 3 });
  });
});

describe('etape 16 : EventRun — la chasse', () => {
  const plan: EventPlan = {
    kind: EVENT_KIND.CHASSE,
    points: [
      { x: 1000, y: 1000 },
      { x: 2200, y: 1000 },
      { x: 1600, y: 2000 },
    ],
    solo: false,
    carrier: 0,
  };
  const proies = [101, 102, 103];

  it('reussie quand toutes les proies ont slotOf < 0, progression tombees / nees', () => {
    const run = new EventRun(plan, ouvert(), proies);
    expect(pas(run, 10, [], horde([], new Set(proies)))).toBeNull();
    expect(run.progress).toBe(0);
    expect(pas(run, 1, [], horde([], new Set([102, 103])))).toBeNull();
    expect(run.progress).toBeCloseTo(1 / 3, 6);
    expect(run.wireState()).toEqual({ progress: 85, cartX: 0, cartY: 0, cartHp: 0 });
    expect(run.step([], horde([], new Set()), DT)).toBe(EVENT_OUTCOME.REUSSI);
  });

  it('expiree a 60 s si une proie survit', () => {
    const run = new EventRun(plan, ouvert(), proies);
    const une = horde([], new Set([101]));
    expect(pas(run, EVENT_DURATION_TICKS - 1, [], une)).toBeNull();
    expect(run.step([], une, DT)).toBe(EVENT_OUTCOME.EXPIRE);
  });
});

describe('etape 16 : EventRun — le noir', () => {
  const plan: EventPlan = { kind: EVENT_KIND.NOIR, points: [], solo: false, carrier: 2 };

  it('detruit a la mort du porteur de lanterne, ou a son depart', () => {
    const run = new EventRun(plan, ouvert());
    expect(pas(run, 10, [joueur(0, 0, { id: 2 })])).toBeNull();
    expect(run.step([joueur(0, 0, { id: 2, hp: 0 })], PERSONNE, DT)).toBe(EVENT_OUTCOME.DETRUIT);
    const parti = new EventRun(plan, ouvert());
    expect(parti.step([joueur(0, 0, { id: 1 })], PERSONNE, DT)).toBe(EVENT_OUTCOME.DETRUIT);
  });

  it('reussi a 1 200 ticks : il ne peut pas expirer ; progression elapsed / 1 200', () => {
    const run = new EventRun(plan, ouvert());
    expect(pas(run, NOIR_HOLD_TICKS / 2, [joueur(0, 0, { id: 2 })])).toBeNull();
    expect(run.progress).toBeCloseTo(0.5, 6);
    expect(run.wireState()).toEqual({ progress: 127, cartX: 0, cartY: 0, cartHp: 2 });
    expect(pas(run, NOIR_HOLD_TICKS / 2, [joueur(0, 0, { id: 2 })])).toBe(EVENT_OUTCOME.REUSSI);
  });

  it('inDark : a 351 px de la lanterne oui, a 350 non ; jamais en solo, jamais hors noir', () => {
    const run = new EventRun(plan, ouvert());
    pas(run, 1, [joueur(1000, 1000, { id: 2 })]);
    expect(run.inDark({ x: 1000 + NOIR_LIGHT_RADIUS + 1, y: 1000 })).toBe(true);
    expect(run.inDark({ x: 1000 + NOIR_LIGHT_RADIUS, y: 1000 })).toBe(false);
    expect(run.inDark({ x: 1000, y: 1000 })).toBe(false);
    const seul = new EventRun({ ...plan, solo: true }, ouvert());
    pas(seul, 1, [joueur(1000, 1000, { id: 2 })]);
    expect(seul.inDark({ x: 4000, y: 4000 })).toBe(false);
    const siege = new EventRun(
      { kind: EVENT_KIND.SIEGE, points: [{ x: 0, y: 0 }], solo: false, carrier: 0 },
      ouvert(),
    );
    expect(siege.inDark({ x: 4000, y: 4000 })).toBe(false);
  });

  it('NOIR_DRAIN_PER_SEC vaut 2 : 50 s pour tuer 100 PV, plus que les 40 s de l evenement', () => {
    expect(NOIR_DRAIN_PER_SEC).toBe(2);
    expect(100 / NOIR_DRAIN_PER_SEC).toBeGreaterThan(NOIR_HOLD_TICKS / TICK_HZ);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run src/evenement.test.ts`
Attendu : ÉCHEC — `SIEGE_HOLD_TICKS` (et les autres) non exportés.

- [ ] **Étape 3 : implémenter**

`back/src/evenement.ts` : l'import de `@shared/evenements` gagne `lightRadius`,
`RELIQUE_ALTAR_RADIUS`, `relicSpeedFactor`, `SIEGE_DEFEND_RADIUS`, `TOTEM_RADIUS`. Après les
constantes de la tâche 3 :

```ts
/** Le siege (etape 16, §3) : 45 s CUMULEES avec un defenseur a `SIEGE_DEFEND_RADIUS`. */
export const SIEGE_HOLD_TICKS = 1350;
/** Noye sous cinq ennemis (40 PV / 15 ticks), le totem tient 7,5 s ; 15 s seul. Fixes : le contact l'est. */
export const SIEGE_HP = 600;
export const SIEGE_HP_SOLO = 1200;
export const SIEGE_CONTACT_RADIUS = TOTEM_RADIUS + CONTACT_RADIUS / 2;
/** Un vivant a cette distance de la relique au sol la ramasse. */
export const RELIQUE_PICKUP_RADIUS = 48;
/** Le noir (§6) : 40 s a tenir, dans la fenetre de 60 — il ne peut pas expirer. */
export const NOIR_HOLD_TICKS = 1200;
/** Hors de la lumiere : 2 PV/s, au serveur seul (`Room#stepEvent`), jamais en solo. */
export const NOIR_DRAIN_PER_SEC = 2;
```

`EventPlayer` (l.71-78) gagne en tête `readonly id: number;` ; `EventHorde` (l.81-85) gagne

```ts
  /** Le creneau d'une identite, `-1` si elle n'est plus dans la horde (la chasse). */
  slotOf(id: number): number;
```

et sa doc devient « Ce qu'un convoi, un siege ou une chasse lit de la horde. `Horde` le satisfait
tel quel. »

Dans `EventRun` :

- champs, après `readonly #dir` (l.266) :

```ts
  /** Un seul vivant au depart : fige pour tout l'evenement. */
  readonly solo: boolean;
  /** Relique : l'id du porteur (0 au sol). Noir : le porteur de lanterne, fige. */
  #carrier: number;
  /** Leve par toute transition de `#carrier` (relique), lu une fois par le salon. */
  #carrierChanged = false;
  /** Chasse : les identites des proies nees ; `#tombees` celles qui n'y sont plus. */
  readonly #proies: readonly number[];
  #tombees = 0;
  /** Noir : la position de la lanterne au dernier pas, `null` avant le premier. */
  #lanterne: EventPoint | null = null;
```

- le constructeur devient `constructor(plan: EventPlan, field: FlowField, proies: readonly number[]
  = [])` ; après `this.#field = field;` : `this.solo = plan.solo; this.#carrier = plan.carrier;
  this.#proies = proies;`. `cartHpMax` et `#holdTicks` deviennent :

```ts
    // `cartHpMax` : les PV du chariot (convoi) ou du totem (siege).
    this.cartHpMax =
      plan.kind === EVENT_KIND.SIEGE
        ? plan.solo
          ? SIEGE_HP_SOLO
          : SIEGE_HP
        : plan.solo
          ? CONVOI_HP_SOLO
          : CONVOI_HP;
    this.#cartHp = this.cartHpMax;
    this.#holdTicks =
      plan.kind === EVENT_KIND.FORGE
        ? plan.solo
          ? FORGE_HOLD_TICKS_SOLO
          : FORGE_HOLD_TICKS
        : plan.kind === EVENT_KIND.SIEGE
          ? SIEGE_HOLD_TICKS
          : plan.kind === EVENT_KIND.NOIR
            ? NOIR_HOLD_TICKS
            : SCEAUX_HOLD_TICKS;
```

  et la doc de `cart` (l.256) devient « Le chariot (convoi) ou la relique (relique) : sa position
  SERVEUR, que `EVENT_STATE` transporte. La relique est posee sur `points[0]`. »

- `progress` (l.300-311) devient :

```ts
  /**
   * De 0 a 1. Convoi et relique : `1 - distance(point mobile, E) / distance(S, E)`,
   * borne ; 1 a l'arrivee du chariot. Chasse : tombees / nees. Noir : le temps.
   */
  get progress(): number {
    if (this.kind === EVENT_KIND.CHASSE) {
      return this.#proies.length === 0 ? 0 : this.#tombees / this.#proies.length;
    }
    if (this.kind === EVENT_KIND.NOIR) {
      return Math.min(1, this.#elapsed / this.#holdTicks);
    }
    if (this.kind !== EVENT_KIND.CONVOI && this.kind !== EVENT_KIND.RELIQUE) {
      return Math.min(1, this.#held / this.#holdTicks);
    }
    if (this.#arrived) {
      return 1;
    }
    const e = this.points[1] ?? this.cart;
    const reste = Math.hypot(e.x - this.cart.x, e.y - this.cart.y);
    return Math.min(1, Math.max(0, 1 - reste / this.#trajet));
  }

  /** Relique : le porteur (0 au sol). Noir : la lanterne. 0 sinon. */
  get carrier(): number {
    return this.#carrier;
  }

  /** Vrai une fois apres chaque changement de porteur de relique (§7.3), puis faux. */
  takeCarrierChanged(): boolean {
    const c = this.#carrierChanged;
    this.#carrierChanged = false;
    return c;
  }

  /** La relique ralentit son porteur (`relicSpeedFactor`). 1 pour tout autre, et hors relique. */
  speedFactorOf(id: number): number {
    return this.holdsFire(id) ? relicSpeedFactor(this.solo) : 1;
  }

  /** Vrai si `id` porte la relique : il ne tire pas (§4.2). */
  holdsFire(id: number): boolean {
    return this.kind === EVENT_KIND.RELIQUE && id !== 0 && id === this.#carrier;
  }

  /**
   * Hors de la lumiere du noir (§6.3) : a plus de `NOIR_LIGHT_RADIUS` de la
   * lanterne au dernier pas. Jamais en solo (le seul joueur la porte), jamais
   * hors noir, jamais avant le premier pas.
   */
  inDark(p: { x: number; y: number }): boolean {
    const l = this.#lanterne;
    if (this.kind !== EVENT_KIND.NOIR || this.solo || l === null) {
      return false;
    }
    return Math.hypot(p.x - l.x, p.y - l.y) > lightRadius(false);
  }
```

- `step` (l.313-330) devient :

```ts
  step(players: readonly EventPlayer[], horde: EventHorde, dt: number): number | null {
    this.#elapsed++;
    const vivants = players.filter((p) => p.hp > 0);
    let issue: number | null;
    if (this.kind === EVENT_KIND.CONVOI) {
      issue = this.#stepConvoi(vivants, horde, dt);
    } else if (this.kind === EVENT_KIND.SIEGE) {
      issue = this.#stepSiege(vivants, horde);
    } else if (this.kind === EVENT_KIND.RELIQUE) {
      issue = this.#stepRelique(vivants);
    } else if (this.kind === EVENT_KIND.CHASSE) {
      issue = this.#stepChasse(horde);
    } else if (this.kind === EVENT_KIND.NOIR) {
      issue = this.#stepNoir(vivants);
    } else {
      if (this.#tenu(vivants)) {
        this.#held++;
      }
      issue = this.#held >= this.#holdTicks ? EVENT_OUTCOME.REUSSI : null;
    }
    if (issue !== null) {
      return issue;
    }
    return this.#elapsed >= EVENT_DURATION_TICKS ? EVENT_OUTCOME.EXPIRE : null;
  }
```

- `wireState` (l.332-341) devient :

```ts
  /**
   * Les octets d'`EVENT_STATE`, deja quantifies (§7.2). `x, y` : le chariot
   * ou la relique ; l'octet d'etat : PV du chariot ou du totem, id du porteur
   * de relique ou de lanterne ; zeros sinon. L'encodeur borne a [0, 255].
   */
  wireState(): { progress: number; cartX: number; cartY: number; cartHp: number } {
    const mobile = this.kind === EVENT_KIND.CONVOI || this.kind === EVENT_KIND.RELIQUE;
    const pv = this.kind === EVENT_KIND.CONVOI || this.kind === EVENT_KIND.SIEGE;
    const porteur = this.kind === EVENT_KIND.RELIQUE || this.kind === EVENT_KIND.NOIR;
    return {
      progress: Math.floor(255 * this.progress),
      cartX: mobile ? Math.round(this.cart.x) : 0,
      cartY: mobile ? Math.round(this.cart.y) : 0,
      cartHp: pv
        ? Math.ceil((255 * this.#cartHp) / this.cartHpMax)
        : porteur
          ? this.#carrier
          : 0,
    };
  }
```

- dans `#stepConvoi`, le balayage des dégâts (l.408-425) est remplacé par
  `return this.#subirContact(this.cart.x, this.cart.y, CONVOI_CONTACT_RADIUS, horde);` et ces méthodes
  rejoignent la classe :

```ts
  /**
   * Les degats d'un point fixe ou mobile (convoi, siege) : le meme balayage
   * lineaire que `resolveContact`, toutes les `CONTACT_INTERVAL_TICKS` ticks
   * VIVANTS, `CONVOI_MAX_HITTERS` frappeurs au plus. La horde ne le vise pas :
   * il ne prend que ce qui le frole.
   */
  #subirContact(x: number, y: number, rayon: number, horde: EventHorde): number | null {
    if (this.#elapsed % CONTACT_INTERVAL_TICKS !== 0) {
      return null;
    }
    const r2 = rayon * rayon;
    let n = 0;
    for (let i = 0; i < horde.count && n < CONVOI_MAX_HITTERS; i++) {
      const hx = (horde.x[i] ?? 0) - x;
      const hy = (horde.y[i] ?? 0) - y;
      if (hx * hx + hy * hy <= r2) {
        n++;
      }
    }
    this.#cartHp = Math.max(0, this.#cartHp - n * CONVOI_CONTACT_DAMAGE);
    return this.#cartHp === 0 ? EVENT_OUTCOME.DETRUIT : null;
  }

  /**
   * Le siege (§3) : un vivant a `SIEGE_DEFEND_RADIUS` fait avancer le compte,
   * personne le suspend sans le faire redescendre. ⚠️ « Tenir » se lit
   * « present » : la horde ne vise que les joueurs, un totem sans defenseur
   * ne serait jamais touche.
   */
  #stepSiege(vivants: readonly EventPlayer[], horde: EventHorde): number | null {
    const t = this.points[0];
    if (!t) {
      return null;
    }
    if (vivants.some((p) => Math.hypot(p.x - t.x, p.y - t.y) <= SIEGE_DEFEND_RADIUS)) {
      this.#held++;
    }
    if (this.#held >= this.#holdTicks) {
      return EVENT_OUTCOME.REUSSI;
    }
    return this.#subirContact(t.x, t.y, SIEGE_CONTACT_RADIUS, horde);
  }

  /**
   * La relique (§4.1), dans cet ordre : le porteur tombe ou part (elle reste
   * a sa derniere position), ramassage par le PREMIER vivant dans l'ordre de
   * `players`, elle suit (arrondie, elle voyage en int16), livraison.
   */
  #stepRelique(vivants: readonly EventPlayer[]): number | null {
    if (this.#carrier !== 0 && !vivants.some((p) => p.id === this.#carrier)) {
      this.#carrier = 0;
      this.#carrierChanged = true;
    }
    if (this.#carrier === 0) {
      const p = vivants.find(
        (v) => Math.hypot(v.x - this.cart.x, v.y - this.cart.y) <= RELIQUE_PICKUP_RADIUS,
      );
      if (p) {
        this.#carrier = p.id;
        this.#carrierChanged = true;
      }
    }
    const porteur = vivants.find((p) => p.id === this.#carrier);
    if (!porteur || this.#carrier === 0) {
      return null;
    }
    this.cart.x = Math.round(porteur.x);
    this.cart.y = Math.round(porteur.y);
    const autel = this.points[1];
    return autel && Math.hypot(porteur.x - autel.x, porteur.y - autel.y) <= RELIQUE_ALTAR_RADIUS
      ? EVENT_OUTCOME.REUSSI
      : null;
  }

  /**
   * La chasse (§5.4) : une proie dont `slotOf < 0` est tombee — morte dans le
   * lot du tick, ou retiree (bancs, tests). Les survivantes a l'expiration
   * restent dans la horde : seule une mort les retire.
   */
  #stepChasse(horde: EventHorde): number | null {
    this.#tombees = this.#proies.filter((id) => horde.slotOf(id) < 0).length;
    return this.#proies.length > 0 && this.#tombees === this.#proies.length
      ? EVENT_OUTCOME.REUSSI
      : null;
  }

  /** Le noir (§6.2) : la lanterne tombe ou part, c'est l'echec ; 40 s, la reussite. */
  #stepNoir(vivants: readonly EventPlayer[]): number | null {
    const l = vivants.find((p) => p.id === this.#carrier);
    if (!l) {
      return EVENT_OUTCOME.DETRUIT;
    }
    this.#lanterne = { x: l.x, y: l.y };
    return this.#elapsed >= this.#holdTicks ? EVENT_OUTCOME.REUSSI : null;
  }
```

  (`#stepConvoi` passe donc `horde` à `#subirContact` : sa signature ne change pas.)

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run src/evenement.test.ts`
Attendu : PASS — les `describe` de l'étape 14 (convoi : « cinq ennemis colles ou cinquante »,
« detruit a 0 PV ») compris : `#subirContact` ne change pas une valeur.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write back/src/evenement.ts back/src/evenement.test.ts
git add back/src/evenement.ts back/src/evenement.test.ts
git commit -m "feat(back): les regles du siege, de la relique, de la chasse et du noir"
```

---

### Tâche 5 : la règle partagée du porteur — `fireCooldown`, `lastFireAfterCarry`, `CarrierClock`

**Fichiers :**
- Modifier : `shared/firing.ts` (import l.4 ; deux fonctions en fin de fichier),
  `shared/evenements.ts` (`CarrierClock` en fin de fichier), `back/src/room.ts` (`#fireOne`
  l.2221-2230 ; import l.84-90), `front/src/net/client.ts` (`#fireOne` l.3094-3101 ; import
  l.34 et l.76-88)
- Créer : `shared/evenements.test.ts`
- Tester : `shared/firing.test.ts` (import l.4 et l.7-15 ; nouveau `describe` en fin)

**Interfaces :**
- Consomme : rien de neuf.
- Produit :
  - `fireCooldown(loadout: Loadout, weaponId: number, accountFireRate: number): number` — la
    recharge que `Room#fireOne` et `GameClient#fireOne` calculaient chacun ;
  - `lastFireAfterCarry(last: number, from: number, nextTick: number, cooldown: number): number`
    — le tick de la dernière salve que le serveur a tirée avant `nextTick`, pour une arme dont la
    dernière salve était `last` et qui peut de nouveau tirer à partir de `from` (écart n° 6) ;
  - `class CarrierClock { carrier: number; previous: number; fromTick: number; heard(byte: number):
    void; dated(snapshotTick: number): { from: number; released: number } | null; at(tick: number):
    number }` — la datation D + 1 du porteur (§8.1, écart n° 7).

Pourquoi avant le salon : la tâche 6 prouve le calendrier de tir du serveur **contre**
`lastFireAfterCarry`, et la tâche 7 celui du client contre la même fonction — c'est ce qui fait de
« aucune salve en trop, aucune en moins » une égalité, pas deux descriptions parallèles.

- [ ] **Étape 1 : écrire les tests qui échouent**

`shared/firing.test.ts` : l'import l.4 devient
`import { aimPoint, armedWeapon, critOf, fireCooldown, lastFireAfterCarry, shotDamage, weaponUpgrades } from './firing';`
et celui de `./weapons` (l.7-15) gagne `cooldownWithBonus`, `FIRE_RATE_PER_UPGRADE`,
`upgradesFor`. En fin de fichier :

```ts
describe('etape 16 : la recharge et la reprise apres un port de relique', () => {
  /** L'expression ecrite dans `Room#fireOne` et `GameClient#fireOne` avant l'etape. */
  function ancienne(l: Loadout, w: number, compte: number): number {
    return cooldownWithBonus(
      armedWeapon(l, w).cooldownTicks,
      l.bonus('fireRate') + compte + FIRE_RATE_PER_UPGRADE * l.upgradesOf(w, UPGRADE.FIRE_RATE),
    );
  }

  it('fireCooldown rend ce que Room#fireOne calculait, armes, cartes de cadence, aspects et compte', () => {
    for (const w of WEAPONS) {
      for (const cartes of [0, 1, 3]) {
        for (const compte of [0, 0.1]) {
          const l = avec('fireRate', cartes, w.id);
          if (upgradesFor(w).includes(UPGRADE.FIRE_RATE)) {
            l.addWeapon(w.id, UPGRADE.FIRE_RATE);
            l.addWeapon(w.id, UPGRADE.FIRE_RATE);
          }
          expect(fireCooldown(l, w.id, compte)).toBe(ancienne(l, w.id, compte));
        }
      }
    }
  });

  it('lastFireAfterCarry : recharge faite au depart, la premiere salve a `from`, puis tous les `cooldown`', () => {
    // Derniere salve a 100, recharge 4, porte de 101 a 150 : libre a 151.
    expect(lastFireAfterCarry(100, 151, 151, 4)).toBe(100); // rien de tire avant 151
    expect(lastFireAfterCarry(100, 151, 152, 4)).toBe(151);
    expect(lastFireAfterCarry(100, 151, 155, 4)).toBe(151);
    expect(lastFireAfterCarry(100, 151, 156, 4)).toBe(155);
    expect(lastFireAfterCarry(100, 151, 158, 4)).toBe(155);
  });

  it('lastFireAfterCarry : recharge PAS faite a `from` — la premiere salve attend last + cooldown', () => {
    // Port court : derniere salve a 100, recharge 36 (grenade), libre a 105.
    expect(lastFireAfterCarry(100, 105, 120, 36)).toBe(100);
    expect(lastFireAfterCarry(100, 105, 137, 36)).toBe(136);
  });

  it('lastFireAfterCarry : jamais tire (-Infinity), la premiere salve est `from`', () => {
    expect(lastFireAfterCarry(Number.NEGATIVE_INFINITY, 40, 41, 4)).toBe(40);
    expect(lastFireAfterCarry(Number.NEGATIVE_INFINITY, 40, 40, 4)).toBe(Number.NEGATIVE_INFINITY);
  });
});
```

`shared/evenements.test.ts` (créé) :

```ts
import { describe, expect, it } from 'vitest';

import { CarrierClock } from './evenements';

/**
 * La datation du porteur (etape 16, §8.1) : l'octet d'`EVENT_STATE` attend le
 * `SNAPSHOT` qui le suit dans le meme envoi ; le changement vaut a partir du
 * tick D + 1, D etant le tick de ce snapshot.
 */
describe('etape 16 : CarrierClock', () => {
  it('un octet seul ne change rien ; date par le SNAPSHOT D, il vaut a partir de D + 1', () => {
    const c = new CarrierClock();
    c.heard(2);
    expect(c.at(1_000)).toBe(0);
    expect(c.dated(500)).toEqual({ from: 501, released: 0 });
    expect(c.at(500)).toBe(0);
    expect(c.at(501)).toBe(2);
    expect(c.carrier).toBe(2);
    expect(c.fromTick).toBe(501);
  });

  it('un SNAPSHOT sans octet en attente ne date rien', () => {
    const c = new CarrierClock();
    expect(c.dated(10)).toBeNull();
    c.heard(0);
    expect(c.dated(11)).toBeNull();
  });

  it('la chute : l ancien porteur est rendu (le client le recale), at() suit la date', () => {
    const c = new CarrierClock();
    c.heard(3);
    c.dated(100);
    c.heard(0);
    expect(c.dated(160)).toEqual({ from: 161, released: 3 });
    expect(c.at(160)).toBe(3);
    expect(c.at(161)).toBe(0);
  });

  it('les etats de cadence repetent le porteur : rien a dater', () => {
    const c = new CarrierClock();
    c.heard(1);
    c.dated(10);
    c.heard(1);
    expect(c.dated(16)).toBeNull();
    expect(c.fromTick).toBe(11);
  });

  /**
   * Sous rattrapage (plusieurs pas pour un envoi) : ramasse puis lachee dans
   * le meme envoi. Le dernier octet egal au porteur courant EFFACE l'attente.
   */
  it('ramasse puis lachee dans le meme envoi : rien a dater', () => {
    const c = new CarrierClock();
    c.heard(2);
    c.heard(0);
    expect(c.dated(40)).toBeNull();
    expect(c.at(41)).toBe(0);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run ../shared/firing.test.ts ../shared/evenements.test.ts`
Attendu : ÉCHEC — `fireCooldown`, `lastFireAfterCarry`, `CarrierClock` non exportés.

- [ ] **Étape 3 : implémenter**

`shared/firing.ts` : l'import l.4 devient

```ts
import {
  cooldownWithBonus,
  DAMAGE_PER_UPGRADE,
  FIRE_RATE_PER_UPGRADE,
  UPGRADE,
  upgradedWeapon,
  type Weapon,
  weaponOf,
} from './weapons';
```

En fin de fichier :

```ts
/**
 * La recharge d'une arme pour CE joueur, en ticks : cartes de cadence, bonus
 * de compte, aspects « cadence » de l'arme. L'expression etait ecrite deux
 * fois (`Room#fireOne`, `GameClient#fireOne`) ; le recalage du porteur de
 * relique (etape 16, §8.3) en fait une troisieme lecture.
 */
export function fireCooldown(loadout: Loadout, weaponId: number, accountFireRate: number): number {
  return cooldownWithBonus(
    armedWeapon(loadout, weaponId).cooldownTicks,
    loadout.bonus('fireRate') +
      accountFireRate +
      FIRE_RATE_PER_UPGRADE * loadout.upgradesOf(weaponId, UPGRADE.FIRE_RATE),
  );
}

/**
 * La derniere salve tiree AVANT `nextTick` par une arme muette jusqu'a
 * `from` (le porteur de relique livre ou tombe a `from - 1`), si elle visait
 * sans arret : la premiere salve part a `max(from, last + cooldown)`, les
 * suivantes tous les `cooldown`. Rend `last` si aucune n'est encore partie.
 *
 * C'est le calendrier exact de `Room#fireOne` (tick - last >= cooldown) ; le
 * client s'y recale quand il apprend la fin du port EN RETARD (etape 16,
 * §8.3, ecart n° 6 du plan) — `last = from` seul garderait une phase decalee
 * des que le retard depasse une recharge.
 */
export function lastFireAfterCarry(
  last: number,
  from: number,
  nextTick: number,
  cooldown: number,
): number {
  const first = Math.max(from, last + cooldown);
  if (first >= nextTick) {
    return last;
  }
  return first + Math.floor((nextTick - 1 - first) / cooldown) * cooldown;
}
```

`shared/evenements.ts`, en fin de fichier :

```ts
/**
 * Le porteur de la relique (ou de la lanterne) tel qu'un CLIENT le date
 * (etape 16, §8.1), sans un octet : l'`EVENT_STATE` d'un changement part
 * AVANT le `SNAPSHOT` du meme envoi (`server.ts`), et le salon change le
 * porteur en fin de pas (`#stepEvent`), apres le deplacement et le tir. Un
 * changement au tick D arrive donc juste avant le `SNAPSHOT` date D, et vaut a
 * partir de D + 1 — des deux cotes.
 *
 * ⚠️ Exact quand un pas precede un envoi (le cas nominal) ; sous rattrapage
 * (jusqu'a `MAX_CATCH_UP_STEPS` pas par envoi), date du dernier pas : au plus
 * 4 ticks de retard.
 *
 * Vit ici et pas dans `client.ts` : le livrable (back) rejoue les messages
 * decodes de la vraie socket dans CE code (ecart n° 7 du plan).
 */
export class CarrierClock {
  /** Le porteur a partir de `fromTick` ; 0 = aucun (relique au sol). */
  carrier = 0;
  /** Le porteur d'avant `fromTick`. */
  previous = 0;
  fromTick = 0;
  #pending: number | null = null;

  /**
   * L'octet d'etat d'un `EVENT_STATE` : en attente de sa date. Egal au porteur
   * courant, il EFFACE l'attente (ramasse puis lachee dans le meme envoi).
   */
  heard(byte: number): void {
    this.#pending = byte !== this.carrier ? byte : null;
  }

  /**
   * Le `SNAPSHOT` date `snapshotTick` qui suit : applique l'octet en attente.
   * Rend la date et l'ANCIEN porteur (0 s'il n'y en avait pas), `null` si rien
   * n'attendait.
   */
  dated(snapshotTick: number): { from: number; released: number } | null {
    if (this.#pending === null) {
      return null;
    }
    this.previous = this.carrier;
    this.carrier = this.#pending;
    this.#pending = null;
    this.fromTick = snapshotTick + 1;
    return { from: this.fromTick, released: this.previous };
  }

  /** Le porteur au tick `tick`. */
  at(tick: number): number {
    return tick >= this.fromTick ? this.carrier : this.previous;
  }
}
```

`back/src/room.ts`, `#fireOne` : les l.2225-2230 (`const cooldown = cooldownWithBonus(...);`)
deviennent

```ts
    const cooldown = fireCooldown(p.loadout, weaponId, p.accountBonuses.fireRate);
```

et l'import de `@shared/firing` (l.55) gagne `fireCooldown`. `front/src/net/client.ts`,
`#fireOne` : les l.3097-3102 deviennent

```ts
    const cooldown = fireCooldown(loadout, weaponId, this.accountBonuses.fireRate);
```

et l'import de `@shared/firing` (l.34) gagne `fireCooldown`. Dans les deux fichiers, retirer de
l'import de `@shared/weapons` `cooldownWithBonus` et `FIRE_RATE_PER_UPGRADE` **s'ils n'ont plus
d'usage** (`grep -n "cooldownWithBonus\|FIRE_RATE_PER_UPGRADE"` ; Biome le signale), et `UPGRADE`
de même. Garder `const weapon = armedWeapon(...)` : il sert aux dégâts.

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run ../shared/firing.test.ts ../shared/evenements.test.ts src/room.test.ts -t "salve|tir|cadence"`
puis `cd front && npx vitest run src/net/client.test.ts -t "tir|salve|recharge"`
Attendu : PASS — le refactor ne change aucune salve.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write shared/firing.ts shared/firing.test.ts shared/evenements.ts shared/evenements.test.ts back/src/room.ts front/src/net/client.ts
git add shared/firing.ts shared/firing.test.ts shared/evenements.ts shared/evenements.test.ts back/src/room.ts front/src/net/client.ts
git commit -m "refactor(shared): une recharge, une reprise et une datation du porteur pour les deux cotes"
```

---

### Tâche 6 : le salon — proies par `#spawnAt`, porteur lent et muet, nuit qui ronge, état hors cadence

**Fichiers :**
- Modifier : `back/src/room.ts` (imports l.2-30, l.54, l.112-121 ; lectures après `eventPoints`
  l.689-691 ; `debugStartEvent` l.1159-1161 ; vitesse l.1386 ; appel l.1528 ; `#fireWeapons`
  l.2203-2208 ; `#startEvent` l.2416-2438 ; `#stepEvent` l.2449-2466 ; `#spawnAt` l.2567-2583)
- Tester : `back/src/room.test.ts` (imports l.2-11, l.54-59, l.82-91 ; nouveau `describe` en fin
  de fichier)

**Interfaces :**
- Consomme : `EventRun` et ses lectures (tâche 4) ; `placeEvent` (tâche 3) ; `PROIE_ARCHETYPE`,
  `PROIE_HP` (tâche 2) ; `fireCooldown`, `lastFireAfterCarry` (tâche 5) ; `RELIQUE_CARRIER_SPEED`,
  `NOIR_LIGHT_RADIUS` (tâche 1).
- Produit :
  - `Room#lastFireTickOf(playerId: number, weaponId: number): number` et
    `get Room#eventCarrier(): number` (lectures de test, écart n° 8) ;
  - `#startEvent(seed: number, spawnTick: number)` : `step` passe `this.#tick`,
    `debugStartEvent` `this.#tick + 1` (écart n° 3) ;
  - `#spawnAt(at, archetype, count, spawnTick = this.#tick + 1): number | null` (écart n° 4) ;
  - les proies partent en `WAVE_ORDER` **avant** l'`EVENT_START` du même envoi (`#pendingOrders`
    est drainé avant `#pendingEvents`, `server.ts` l.518-520 puis l.563-565).

- [ ] **Étape 1 : écrire les tests qui échouent**

`back/src/room.test.ts` : à l'import de `@shared/archetypes` ajouter `PROIE_ARCHETYPE`,
`PROIE_HP` ; à celui de `@shared/evenements` ajouter `NOIR_LIGHT_RADIUS`,
`RELIQUE_CARRIER_SPEED` ; ajouter `import { fireCooldown, lastFireAfterCarry } from
'@shared/firing';` et `import { CHASSE_PREY } from './evenement';`. Puis en fin de fichier :

```ts
describe('etape 16 : les quatre evenements dans le salon', () => {
  /** Une graine du genre voulu : le genre est `graine % 7`. */
  const graine = (genre: number): number => 7 * 0x4_6a2b + genre;
  /** Le centre de l'ile : toujours degage (`SPAWN_CLEARANCE`), on y bouge sans mur. */
  const CENTRE = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
  const FOUGUE: Card = {
    nature: CARD.PASSIVE,
    refId: PASSIVES.find((p) => p.kind === 'speed')?.id ?? -1,
  };

  /** Retire de la horde, HORS du lot de morts, tout ce qui n'est pas dans `garder`. */
  function viderSauf(room: Room, garder: ReadonlySet<number> = new Set()): void {
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

  /** Un tick de decor, horde videe (sauf `garder`) ; PAS de remise sur pied : le noir doit mordre. */
  function pas(room: Room, garder?: ReadonlySet<number>): EventMessage[] {
    viderSauf(room, garder);
    room.step(DT);
    viderSauf(room, garder);
    return room.drainEvents();
  }

  function ou(room: Room, id: number): { x: number; y: number } {
    const p = room.positionOf(id);
    if (!p) {
      throw new Error(`joueur ${id} absent`);
    }
    return p;
  }

  function relique(room: Room): { x: number; y: number } {
    const [r] = room.eventPoints ?? [];
    if (!r) {
      throw new Error('la relique a un point');
    }
    return r;
  }

  describe('la relique', () => {
    it('le porteur avance a 0,6 x sa vitesse ENTIERE (fougue comprise) a partir de D + 1, pas de D', () => {
      expect(FOUGUE.refId).toBeGreaterThanOrEqual(0);
      const room = new Room(0x16_0e_0001);
      room.join(1);
      room.join(2);
      room.grantCard(1, FOUGUE);
      room.grantCard(2, FOUGUE);
      room.debugStartEvent(graine(EVENT_KIND.RELIQUE));
      const r = relique(room);
      // Ramassee au site, portee au centre, lachee la : la relique au sol, en terrain degage.
      room.debugPlace(1, r.x, r.y);
      pas(room);
      room.debugPlace(1, CENTRE.x, CENTRE.y);
      pas(room);
      room.debugKill(1);
      pas(room);
      expect(room.eventCarrier).toBe(0);
      room.debugRevive(1);
      room.debugPlace(2, CENTRE.x, CENTRE.y + 120);
      room.applyInput(1, 1, 127, 0);
      room.applyInput(2, 1, 127, 0);
      const a0 = ou(room, 1).x;
      const b0 = ou(room, 2).x;
      // Tick D : 1 bouge a pleine vitesse, PUIS ramasse (en fin de pas).
      pas(room);
      expect(room.eventCarrier).toBe(1);
      const a1 = ou(room, 1).x;
      const b1 = ou(room, 2).x;
      expect(a1 - a0).toBeCloseTo(b1 - b0, 6);
      // Tick D + 1 : ralenti, sur la vitesse ENTIERE (une fougue chacun : le rapport resterait
      // (0,6 x 260 + 15) / 275 si le facteur ne portait que sur PLAYER_SPEED).
      pas(room);
      const a2 = ou(room, 1).x;
      const b2 = ou(room, 2).x;
      expect(b2 - b1).toBeGreaterThan(0);
      expect((a2 - a1) / (b2 - b1)).toBeCloseTo(RELIQUE_CARRIER_SPEED, 6);
    });

    it('aucune salve tant qu il porte (projectile ni halo) ; a la chute, la reprise suit lastFireAfterCarry', () => {
      const halo = WEAPONS.find((w) => w.kind === 'halo');
      if (!halo) {
        throw new Error('un halo au catalogue');
      }
      const room = new Room(0x16_0e_0002);
      room.join(1);
      room.join(2);
      room.grantCard(1, { nature: CARD.WEAPON, refId: halo.id });
      // Vise a droite, immobile : il tire a chaque recharge.
      room.applyInput(1, 1, 0, 0, 127, 0);
      room.debugStartEvent(graine(EVENT_KIND.RELIQUE));
      for (let t = 0; t < 10; t++) {
        pas(room);
      }
      const r = relique(room);
      room.debugPlace(1, r.x, r.y);
      pas(room); // tick D : il a tire, puis ramasse
      expect(room.eventCarrier).toBe(1);
      const loadout = room.loadoutOf(1);
      if (!loadout) {
        throw new Error('un inventaire');
      }
      const armes = [...loadout.weaponIds];
      expect(armes).toContain(halo.id);
      const avant = armes.map((w) => room.lastFireTickOf(1, w));
      for (const t of avant) {
        expect(t).toBeGreaterThan(Number.NEGATIVE_INFINITY);
      }
      for (let t = 0; t < 40; t++) {
        pas(room);
        armes.forEach((w, k) => expect(room.lastFireTickOf(1, w)).toBe(avant[k]));
      }
      // La chute au tick E ; releve aussitot, il peut tirer a E + 1.
      room.debugKill(1);
      pas(room);
      expect(room.eventCarrier).toBe(0);
      const E = room.tick;
      room.debugRevive(1);
      for (let t = 0; t < 20; t++) {
        pas(room);
        armes.forEach((w, k) =>
          expect(room.lastFireTickOf(1, w)).toBe(
            lastFireAfterCarry(avant[k] ?? 0, E + 1, room.tick + 1, fireCooldown(loadout, w, 0)),
          ),
        );
      }
      // La premiere salve est partie a E + 1 : le port a dure plus qu'une recharge.
      expect(room.lastFireTickOf(1, BASE_WEAPON_ID)).toBeGreaterThan(E);
    });

    it('un EVENT_STATE hors cadence au ramassage et a la chute — un seul, et rien au tick d apres', () => {
      const room = new Room(0x16_0e_0003);
      room.join(1);
      room.join(2);
      room.debugStartEvent(graine(EVENT_KIND.RELIQUE));
      room.drainEvents();
      const r = relique(room);
      room.debugPlace(1, r.x, r.y);
      const ramassage = pas(room); // elapsed 1 : pas un tick de cadence
      expect(ramassage).toHaveLength(1);
      expect(ramassage[0]).toMatchObject({ type: MSG.EVENT_STATE, cartHp: 1 });
      expect(pas(room)).toEqual([]); // elapsed 2 : ni cadence ni changement
      room.debugKill(1);
      const chute = pas(room); // elapsed 3
      expect(chute).toHaveLength(1);
      expect(chute[0]).toMatchObject({ type: MSG.EVENT_STATE, cartHp: 0 });
    });
  });

  describe('la chasse', () => {
    it('debugStartEvent : 3 WAVE_ORDER de proies dates tick + 1, PV monsterHp(160, niveau), puis l EVENT_START', () => {
      const room = new Room(0x16_0e_0004);
      room.join(1);
      room.join(2);
      room.debugSetLevel(10);
      room.drainWaveOrders();
      room.debugStartEvent(graine(EVENT_KIND.CHASSE));
      const ordres = room.drainWaveOrders();
      expect(ordres).toHaveLength(CHASSE_PREY);
      for (const o of ordres) {
        expect(o).toMatchObject({
          archetype: PROIE_ARCHETYPE,
          count: 1,
          spawnTick: room.tick + 1,
          formation: FORMATION.POINT,
        });
        const slot = room.horde.slotOf(entityIdOf(o.waveId, 0));
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(room.horde.hp[slot]).toBe(Math.fround(monsterHp(PROIE_HP, 10)));
      }
      const [start] = room.drainEvents();
      if (start?.type !== MSG.EVENT_START) {
        throw new Error('EVENT_START attendu');
      }
      expect(start).toMatchObject({ kind: EVENT_KIND.CHASSE, solo: false });
      expect(start.points).toEqual(ordres.map((o) => ({ x: o.anchorX, y: o.anchorY })));
    });

    it('au pas, les proies sont datees du tick MEME : apres la boucle des ordres, avant horde.step', () => {
      const lire = vi.spyOn(WaveDirector.prototype, 'takeEventSeed').mockReturnValue(null);
      try {
        const room = new Room(0x16_0e_0005);
        room.join(1);
        room.join(2);
        pas(room);
        room.drainWaveOrders();
        lire.mockReturnValueOnce(graine(EVENT_KIND.CHASSE));
        viderSauf(room);
        room.step(DT);
        const proies = room.drainWaveOrders().filter((o) => o.archetype === PROIE_ARCHETYPE);
        expect(proies).toHaveLength(CHASSE_PREY);
        for (const o of proies) {
          expect(o.spawnTick).toBe(room.tick);
        }
      } finally {
        lire.mockRestore();
      }
    });

    it('reussie quand toutes les proies sont tombees ; tant qu une vit, rien', () => {
      const room = new Room(0x16_0e_0006);
      room.join(1);
      room.join(2);
      room.debugStartEvent(graine(EVENT_KIND.CHASSE));
      room.drainEvents();
      const ids = room.drainWaveOrders().map((o) => entityIdOf(o.waveId, 0));
      for (let t = 0; t < 30; t++) {
        expect(pas(room, new Set(ids)).some((m) => m.type === MSG.EVENT_END)).toBe(false);
      }
      room.horde.kill(ids.slice(0, 2));
      expect(pas(room, new Set(ids)).some((m) => m.type === MSG.EVENT_END)).toBe(false);
      room.horde.kill(ids.slice(2));
      expect(pas(room, new Set(ids)).find((m) => m.type === MSG.EVENT_END)).toEqual({
        type: MSG.EVENT_END,
        outcome: EVENT_OUTCOME.REUSSI,
      });
    });

    it('horde pleine : aucune proie nee, aucun evenement, aucun message', () => {
      const room = new Room(0x16_0e_0007);
      room.join(1);
      for (let k = 0; room.horde.count < room.horde.capacity && k < 100; k++) {
        room.horde.spawn({
          waveId: 60_000 + k,
          spawnTick: room.tick,
          seed: 1,
          archetype: 0,
          formation: FORMATION.SCATTER,
          anchorX: CENTRE.x,
          anchorY: CENTRE.y,
          count: room.horde.capacity,
        });
      }
      expect(room.horde.count).toBe(room.horde.capacity);
      room.debugStartEvent(graine(EVENT_KIND.CHASSE));
      expect(room.eventPoints).toBeNull();
      expect(room.drainEvents()).toEqual([]);
    });

    /**
     * ⚠️ **Aucun `rng()` consomme** : apres une chasse, les ordres du
     * directeur sont ceux d'apres un siege, `waveId` decale des trois proies
     * — la mesure exacte du « decalage de 2 ou 3 » de la spec (§5.2).
     */
    it('les ordres du directeur qui suivent sont les memes qu apres un siege, waveId + 3', () => {
      function ordresApres(genre: number): WaveOrder[] {
        const room = new Room(0x16_0e_0008);
        room.join(1);
        room.join(2);
        room.debugStartEvent(graine(genre));
        const proies = new Set(room.drainWaveOrders().map((o) => entityIdOf(o.waveId, 0)));
        const out: WaveOrder[] = [];
        for (let t = 0; t < 400; t++) {
          pas(room, proies);
          room.debugRevive(1);
          room.debugRevive(2);
          out.push(...room.drainWaveOrders());
        }
        return out;
      }
      const siege = ordresApres(EVENT_KIND.SIEGE);
      const chasse = ordresApres(EVENT_KIND.CHASSE);
      expect(siege.length).toBeGreaterThan(0);
      expect(chasse.map((o) => ({ ...o, waveId: o.waveId - CHASSE_PREY }))).toEqual(siege);
    });
  });

  describe('le noir', () => {
    function noir(seed: number): { room: Room; lanterne: number; autre: number } {
      const room = new Room(seed);
      room.join(1);
      room.join(2);
      room.debugStartEvent(graine(EVENT_KIND.NOIR));
      room.drainEvents();
      const lanterne = room.eventCarrier;
      expect([1, 2]).toContain(lanterne);
      room.debugPlace(lanterne, CENTRE.x, CENTRE.y);
      return { room, lanterne, autre: lanterne === 1 ? 2 : 1 };
    }

    it('hors de la lumiere : -2 PV/s, sans toucher au bouclier ; a 350 px pile, rien ; la lanterne rien', () => {
      const { room, lanterne, autre } = noir(0x16_0e_0009);
      room.debugSetMaxShield(autre, 40);
      room.debugPlace(autre, CENTRE.x + NOIR_LIGHT_RADIUS + 50, CENTRE.y);
      const pv = room.hpOf(autre);
      const pvLanterne = room.hpOf(lanterne);
      for (let t = 0; t < TICK_HZ; t++) {
        pas(room);
      }
      expect(room.hpOf(autre)).toBeCloseTo(pv - 2, 6);
      expect(room.shieldOf(autre)).toBe(40);
      expect(room.hpOf(lanterne)).toBe(pvLanterne);
      room.debugPlace(autre, CENTRE.x + NOIR_LIGHT_RADIUS, CENTRE.y);
      const borne = room.hpOf(autre);
      for (let t = 0; t < TICK_HZ; t++) {
        pas(room);
      }
      expect(room.hpOf(autre)).toBe(borne);
    });

    it('la lanterne part : EVENT_END detruit au pas suivant, aucun etalage', () => {
      const { room, lanterne } = noir(0x16_0e_000a);
      pas(room);
      room.leave(lanterne);
      expect(pas(room).find((m) => m.type === MSG.EVENT_END)).toEqual({
        type: MSG.EVENT_END,
        outcome: EVENT_OUTCOME.DETRUIT,
      });
      room.step(DT);
      expect(room.drainDraftOpens()).toEqual([]);
    });

    it('seul : aucune perte de PV, ou qu il soit', () => {
      const room = new Room(0x16_0e_000b);
      room.join(1);
      room.debugStartEvent(graine(EVENT_KIND.NOIR));
      expect(room.eventCarrier).toBe(1);
      const pv = room.hpOf(1);
      for (let t = 0; t < 60; t++) {
        pas(room);
      }
      expect(room.hpOf(1)).toBe(pv);
    });
  });

  it('le siege : progression suspendue sans defenseur, reprise avec, jamais redescendue', () => {
    const room = new Room(0x16_0e_000c);
    room.join(1);
    room.join(2);
    room.debugStartEvent(graine(EVENT_KIND.SIEGE));
    room.drainEvents();
    const [totem] = room.eventPoints ?? [];
    if (!totem) {
      throw new Error('un totem');
    }
    const progres = (n: number, place: boolean): number[] => {
      const out: number[] = [];
      for (let t = 0; t < n; t++) {
        if (place) {
          room.debugPlace(1, totem.x, totem.y);
        }
        for (const m of pas(room)) {
          if (m.type === MSG.EVENT_STATE) {
            out.push(m.progress);
          }
        }
      }
      return out;
    };
    expect(progres(30, false).every((p) => p === 0)).toBe(true);
    const tenu = progres(60, true);
    expect(tenu.at(-1)).toBeGreaterThan(0);
    room.debugPlace(1, CENTRE.x, CENTRE.y);
    room.debugPlace(2, CENTRE.x, CENTRE.y);
    const apres = progres(30, false);
    expect(apres.every((p) => p === tenu.at(-1))).toBe(true);
  });
});
```

⚠️ Si le centre de l'île n'était pas assez dégagé pour 120 px (premier test), le message serait
« b2 - b1 > 0 » rouge : rapprocher le joueur 2 (`CENTRE.y + 60`), ne pas toucher au salon.

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run src/room.test.ts -t "etape 16"`
Attendu : ÉCHEC — `room.eventCarrier` / `room.lastFireTickOf` indéfinis ; une fois posés, le
porteur avance à pleine vitesse et tire, aucune proie ne naît, aucun PV ne baisse.

- [ ] **Étape 3 : implémenter**

`back/src/room.ts` :

- imports : `PROIE_ARCHETYPE` à `@shared/archetypes` (l.2-30) ; `EVENT_KIND` à
  `@shared/evenements` (l.54) ; `NOIR_DRAIN_PER_SEC` à l'import de `./evenement` (à côté de
  `EventRun`, `placeEvent`).
- après `eventPoints` (l.689-691) :

```ts
  /** Lecture etroite (etape 16) : le porteur de la relique ou de la lanterne, 0 sinon. */
  get eventCarrier(): number {
    return this.#event?.carrier ?? 0;
  }

  /**
   * Lecture etroite (etape 16), comme `positionOf` : le dernier tick de tir de
   * cette arme pour ce joueur, `-Infinity` jamais tire ou absent. C'est elle
   * qui prouve « aucune salve » au tick pres, sans compter des projectiles.
   */
  lastFireTickOf(playerId: number, weaponId: number): number {
    return this.#players.get(playerId)?.lastFireTick[weaponId] ?? Number.NEGATIVE_INFINITY;
  }
```

- `debugStartEvent` (l.1159-1161) :

```ts
  debugStartEvent(seed: number): void {
    // ⚠️ HORS du pas : la horde a deja fait le pas `#tick`. Une proie datee
    // `#tick` serait posee par le client AVANT ce pas — elle nait donc au
    // tick suivant, comme les petits du diviseur (ecart n° 3 du plan).
    this.#startEvent(seed, this.#tick + 1);
  }
```

- l.1528 : `this.#startEvent(graineEvenement, this.#tick);` avec, au-dessus :
  `// Dans le pas, apres les ordres et AVANT horde.step : les proies sont datees de CE tick.`
- l.1386 :

```ts
      // Vitesse propre a ce joueur : les cartes « fougue » empilees s'ajoutent
      // a `PLAYER_SPEED`, en pixels monde par seconde. Etape 16 : le porteur
      // de relique avance a `relicSpeedFactor` de la vitesse ENTIERE ; la
      // poussee des gardiens, plus bas, ne vient pas de l'entree et n'est pas ralentie.
      const speed =
        (PLAYER_SPEED + p.loadout.bonus('speed') + p.accountBonuses.speed) *
        (this.#event?.speedFactorOf(p.id) ?? 1);
```

- `#fireWeapons`, après le garde `if (p.hp <= 0) { continue; }` (l.2203-2205) :

```ts
      // Etape 16 : le porteur de relique ne tire pas — toutes ses armes, halo
      // et invocation compris, passent par `#fireOne`. `lastFireTick` reste
      // fige : a la livraison ou a la chute, la recharge est deja faite.
      if (this.#event?.holdsFire(p.id)) {
        continue;
      }
```

- `#startEvent` (l.2416-2438) :

```ts
  /**
   * Demarre l'evenement de graine `seed` (etape 14, §2.2). ...(doc inchangee)...
   *
   * Etape 16 : la chasse fait naitre ses proies ICI, par `#spawnAt` — des
   * `WAVE_ORDER` ordinaires, sans un `rng()`, datees `spawnTick` (le tick
   * courant dans le pas, le suivant hors du pas). Horde pleine : pas d'evenement
   * du tout, aucun message. Les points annonces sont ceux des proies NEES.
   */
  #startEvent(seed: number, spawnTick: number): void {
    const vivants = [...this.#players.values()].filter((p) => p.hp > 0);
    if (vivants.length === 0) {
      return;
    }
    // `#convoiField` porte le meme masque que `#fields` et n'est jamais
    // `undefined` : il sert aussi a sortir les points des murs.
    let plan = placeEvent(seed, vivants, this.#convoiField);
    const proies: number[] = [];
    if (plan.kind === EVENT_KIND.CHASSE) {
      const nees = plan.points.filter((p) => {
        const id = this.#spawnAt(p, PROIE_ARCHETYPE, 1, spawnTick);
        if (id !== null) {
          proies.push(id);
        }
        return id !== null;
      });
      if (proies.length === 0) {
        return;
      }
      plan = { ...plan, points: nees };
    }
    this.#event = new EventRun(plan, this.#convoiField, proies);
    this.#pendingEvents.push({
      type: MSG.EVENT_START,
      kind: plan.kind,
      solo: plan.solo,
      durationTicks: EVENT_DURATION_TICKS,
      points: plan.points,
    });
  }
```

- `#stepEvent` (l.2449-2466), la branche `issue === null` devient :

```ts
    if (issue === null) {
      // ⚠️ Lu AVANT la cadence (ecart n° 9) : un `||` court-circuiterait le
      // drapeau, qui pousserait un etat de trop au tick suivant.
      const change = ev.takeCarrierChanged();
      // Etape 16 : un etat HORS cadence quand le porteur de relique change —
      // il part avant le SNAPSHOT du meme envoi, qui le date (§7.3, §8.1).
      if (change || ev.elapsed % EVENT_STATE_PERIOD_TICKS === 0) {
        this.#pendingEvents.push({ type: MSG.EVENT_STATE, ...ev.wireState() });
      }
      // La nuit (§6.3), au serveur seul : une soustraction, pas `hurtPlayer`
      // — l'obscurite n'est pas un coup (ni armure, ni bouclier, et
      // `shieldCalmTicks` n'est pas remis a zero). Comme `#regenerate`, `hp`
      // devient fractionnaire ; `encodeSnapshot` le tronque. APRES le contact
      // et la regeneration, AVANT `#checkRunOver` : un joueur acheve par le
      // noir est vu mort au meme tick. `inDark` est faux en solo.
      for (const p of this.#players.values()) {
        if (p.hp > 0 && ev.inDark(p)) {
          p.hp = Math.max(0, p.hp - NOIR_DRAIN_PER_SEC / TICK_HZ);
        }
      }
      return;
    }
```

- `#spawnAt` (l.2567-2583) :

```ts
  /**
   * Fait naitre `count` entites d'`archetype` en `at`, par un ORDRE de vague
   * ordinaire (`allocWaveId` : un compteur, pas un `rng()`). `spawnTick` :
   * le tick SUIVANT par defaut (apres le pas de horde : les petits) ; le tick
   * courant pour une naissance AVANT le pas (les proies, etape 16). Rend
   * l'identite de la premiere entite nee, `null` si la horde etait pleine.
   */
  #spawnAt(
    at: { x: number; y: number },
    archetype: number,
    count: number,
    spawnTick = this.#tick + 1,
  ): number | null {
    const waveId = this.#director.allocWaveId();
    const order: WaveOrder = {
      waveId,
      spawnTick,
      seed: waveId,
      archetype,
      formation: FORMATION.POINT,
      anchorX: Math.round(at.x),
      anchorY: Math.round(at.y),
      count,
    };
    const before = this.horde.count;
    this.horde.spawn(order, this.#fields[0]);
    this.#scaleMonsterHp(before);
    this.#pendingOrders.push(order);
    return this.horde.count > before ? entityIdOf(waveId, 0) : null;
  }
```

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd back && npx vitest run src/room.test.ts -t "etape 1[46]"`
Attendu : PASS (les tests de l'étape 14 du salon compris).
Run : `cd back && npx vitest run src/room.test.ts -t "diviseur|necro|porteur"`
Attendu : PASS — `#spawnAt` rend maintenant une valeur que ses deux anciens appelants ignorent.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write back/src/room.ts back/src/room.test.ts
git add back/src/room.ts back/src/room.test.ts
git commit -m "feat(back): le salon fait naitre les proies, ralentit le porteur, ronge dans le noir"
```

---

### Tâche 7 : le miroir client — le bit solo, le porteur daté D + 1, la vitesse prédite, le tir muet et son recalage, les cibles

**Fichiers :**
- Modifier : `front/src/net/client.ts` (imports l.7, l.33-34 ; `EventView` l.264-278 ;
  `EventMirror` l.281-291 ; getter `event` l.1899-1913 ; lecture `lastFireTickOf` à côté de
  `loadoutOf` l.1707 ; `#onEvent` l.2004-2038 ; `#localSpeed` l.2197-2203 ; gestionnaire de
  `SNAPSHOT` après le recalage l.2468-2470 ; `#fireWeapons` l.3046-3049 ; fonction exportée
  `eventTargets` en fin de fichier)
- Modifier (fixtures, typecheck) : `front/src/ui/hud.test.ts` l.530-550,
  `front/src/render/behavior-renderer.test.ts` l.103, `front/src/render/ping-renderer.test.ts`
  l.133, `front/src/render/frame.test.ts` l.150-157
- Tester : `front/src/net/evenement.test.ts` (imports ; l.128-135 ; nouveaux `describe` en fin),
  `front/src/net/prediction.test.ts` (nouveau `describe` en fin)

**Interfaces :**
- Consomme : `CarrierClock`, `relicSpeedFactor`, `EVENT_KIND.*` (tâches 1 et 5) ;
  `fireCooldown`, `lastFireAfterCarry` (tâche 5) ; `PROIE_ARCHETYPE` (tâche 2) ;
  `EventStartMessage.solo` (tâche 1).
- Produit :
  - `EventView` gagne `solo: boolean`, `carrierId: number` (relique : le porteur au tick de horde
    courant, 0 au sol ; noir : la lanterne ; 0 sinon), `relic: { x: number; y: number } | null`
    (relique au sol, interpolée ; `null` portée ou hors relique), `startedAtMs: number` (horloge
    murale de l'`EVENT_START`, pour le fondu du noir), `targets: readonly { x: number; y: number
    }[]` (les flèches de bord) ;
  - `export function eventTargets(ev: Pick<EventView, 'kind' | 'points' | 'cart' | 'relic' |
    'carrierId'>, horde: Horde, players: readonly { id: number; x: number; y: number }[], localId:
    number | null): { x: number; y: number }[]` ;
  - `GameClient#lastFireTickOf(playerId: number, weaponId: number): number` (lecture de test).

⚠️ `EventView` gagne **cinq** champs (la spec en liste quatre ; `startedAtMs` y est nommé au §8.1
mais pas au §9.1 — il faut bien que le calque d'obscurité le lise). Écart n° 11.

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/net/prediction.test.ts`, ajouter `import { RELIQUE_CARRIER_SPEED } from
'@shared/evenements';` puis en fin de fichier :

```ts
describe('etape 16 : la vitesse du porteur de relique, toleree par la reconciliation', () => {
  /**
   * Le client ne rejoue pas les entrees : une vitesse predite fausse ne
   * s'accumule jamais au-dela d'un intervalle de snapshot (§8.2).
   */
  it('260 predits contre 156 au serveur : l ecart d un snapshot reste sous 4 px et s eteint', () => {
    const p = new PredictedPlayer(1000, 1000);
    p.predict(1, 0, DT, 1, PLAYER_SPEED);
    const serveur = 1000 + (PLAYER_SPEED * RELIQUE_CARRIER_SPEED) / TICK_HZ;
    p.reconcile(serveur, 1000);
    expect(p.simX).toBe(serveur);
    expect(Math.abs(p.renderX - serveur)).toBeGreaterThan(3);
    expect(Math.abs(p.renderX - serveur)).toBeLessThan(4);
    for (let i = 0; i < 10; i++) {
      p.predict(0, 0, DT);
    }
    expect(Math.abs(p.renderX - serveur)).toBeLessThan(0.1);
  });
});
```

`front/src/net/evenement.test.ts` : imports — `EVENT_KIND`… gagne `RELIQUE_CARRIER_SPEED`,
`RELIQUE_CARRIER_SPEED_SOLO` ; ajouter `import { fireCooldown } from '@shared/firing';`,
`import { Horde } from '@shared/horde';` (à côté d'`entityIdOf`), `import { BASE_WEAPON_ID } from
'@shared/weapons';`, `PROIE_ARCHETYPE` à l'import de `@shared/archetypes`, `PLAYER_SPEED` à
celui de `@shared/constants`, et `eventTargets` à celui de `./client`. Le `toEqual` du premier
test (l.128-135) devient :

```ts
    expect(client.event).toEqual({
      kind: EVENT_KIND.FORGE,
      points: [{ x: 4200, y: 3000 }],
      progress: 0,
      secondsLeft: 60,
      cart: null,
      cartHp: 1,
      solo: false,
      carrierId: 0,
      relic: null,
      startedAtMs: 10_000,
      targets: [{ x: 4200, y: 3000 }],
    });
```

Puis en fin de fichier :

```ts
const RELIQUE: EventMessage = {
  type: MSG.EVENT_START,
  kind: EVENT_KIND.RELIQUE,
  solo: false,
  durationTicks: EVENT_DURATION_TICKS,
  points: [
    { x: 1000, y: 3000 },
    { x: 2500, y: 3000 },
  ],
};
const etat = (porteur: number): EventMessage => ({
  type: MSG.EVENT_STATE,
  progress: 0,
  cartX: 1000,
  cartY: 3000,
  cartHp: porteur,
});

/** Comme `connecte`, mais le joueur local vise a droite (il tire) et pousse a droite. */
function connecteTireur(): { client: GameClient; socket: FakeSocket } {
  const client = new GameClient(
    'ws://test',
    () => ({ x: 1, y: 0 }),
    vi.fn(),
    () => ({ x: 1, y: 0 }),
  );
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

/**
 * `n` pas de horde. Avant chacun, si `reseau`, le SNAPSHOT du tick que le
 * serveur vient de faire (`hordeTick - 1` : le client simule le suivant).
 * Rend les ticks auxquels le client a tire l'arme de base pour `id`.
 */
function simule(
  client: GameClient,
  socket: FakeSocket,
  n: number,
  reseau = true,
  id = 1,
  allie = joueur(2),
): number[] {
  const tirs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = client.hordeTick;
    if (reseau) {
      socket.emit(encodeSnapshot(t - 1, 0, 0, [joueur(1), allie]));
    }
    horloge += 1000 / TICK_HZ;
    client.update(horloge, STEP);
    if (client.lastFireTickOf(id, BASE_WEAPON_ID) === t) {
      tirs.push(t);
    }
  }
  return tirs;
}

/** Le calendrier du SERVEUR (`Room#fireOne`) apres un port fini a `from - 1`, de `from` a `jusqua` exclu. */
function calendrier(last: number, from: number, jusqua: number, cd: number): number[] {
  const out: number[] = [];
  for (let t = Math.max(from, last + cd); t < jusqua; t += cd) {
    out.push(t);
  }
  return out;
}

describe('etape 16 : le bit solo et le porteur date au SNAPSHOT qui suit', () => {
  it('EVENT_START porte solo ; la vue le rend', () => {
    const { client, socket } = connecte();
    socket.emit(ev({ ...RELIQUE, solo: true }));
    expect(client.event?.solo).toBe(true);
  });

  it('un EVENT_STATE de relique puis un SNAPSHOT date D : le porteur vaut a partir de D + 1', () => {
    const { client, socket } = connecteTireur();
    socket.emit(ev(RELIQUE));
    simule(client, socket, 5);
    const D = client.hordeTick - 1;
    socket.emit(ev(etat(1)));
    // Sans son SNAPSHOT, l'octet attend.
    expect(client.event?.carrierId).toBe(0);
    socket.emit(encodeSnapshot(D, 0, 0, [joueur(1), joueur(2)]));
    // `hordeTick` = D + 1 : le prochain tick simule est deja porte.
    expect(client.hordeTick).toBe(D + 1);
    expect(client.event?.carrierId).toBe(1);
    expect(client.event?.relic).toBeNull();
    expect(client.event?.targets).toEqual([{ x: 2500, y: 3000 }]);
  });

  it('nominal : le miroir se tait de D + 1 a E et reprend au tick exact du serveur', () => {
    const { client, socket } = connecteTireur();
    socket.emit(ev(RELIQUE));
    const libres = simule(client, socket, 12);
    expect(libres.length).toBeGreaterThan(1);
    const last = libres.at(-1) ?? 0;
    const D = client.hordeTick - 1;
    socket.emit(ev(etat(1)));
    socket.emit(encodeSnapshot(D, 0, 0, [joueur(1), joueur(2)]));
    expect(simule(client, socket, 30)).toEqual([]);
    const E = client.hordeTick - 1;
    socket.emit(ev(etat(0)));
    socket.emit(encodeSnapshot(E, 0, 0, [joueur(1), joueur(2)]));
    const cd = fireCooldown(client.loadoutOf(1), BASE_WEAPON_ID, 0);
    expect(simule(client, socket, 20)).toEqual(calendrier(last, E + 1, E + 21, cd));
  });

  /**
   * ⚠️ **La fin du port apprise EN RETARD** (le client a deja simule E + 1 a
   * E + 7) : le serveur a tire a E + 1 et E + 5 sans que le client ne dessine
   * rien. Sans le recalage, le client tirerait a E + 8 — une phase decalee
   * pour le reste de la run. Avec, il tire a E + 9, comme le serveur.
   */
  it('livraison apprise en retard : recalage, puis exactement le calendrier du serveur', () => {
    const { client, socket } = connecteTireur();
    socket.emit(ev(RELIQUE));
    const last = simule(client, socket, 12).at(-1) ?? 0;
    const D = client.hordeTick - 1;
    socket.emit(ev(etat(1)));
    socket.emit(encodeSnapshot(D, 0, 0, [joueur(1), joueur(2)]));
    simule(client, socket, 30);
    const E = client.hordeTick - 1;
    // Le reseau se tait 7 ticks : le client avance, toujours muet.
    expect(simule(client, socket, 7, false)).toEqual([]);
    socket.emit(ev(etat(0)));
    socket.emit(encodeSnapshot(E, 0, 0, [joueur(1), joueur(2)]));
    const cd = fireCooldown(client.loadoutOf(1), BASE_WEAPON_ID, 0);
    const serveur = calendrier(last, E + 1, E + 8 + 20, cd);
    expect(client.lastFireTickOf(1, BASE_WEAPON_ID)).toBe(
      serveur.filter((t) => t < E + 8).at(-1),
    );
    expect(simule(client, socket, 20)).toEqual(serveur.filter((t) => t >= E + 8));
  });

  it('un allie porteur : le miroir ne tire pas pour lui non plus', () => {
    const { client, socket } = connecteTireur();
    const vise = { ...joueur(2), aimX: 127 };
    socket.emit(ev(RELIQUE));
    expect(simule(client, socket, 12, true, 2, vise).length).toBeGreaterThan(0);
    const D = client.hordeTick - 1;
    socket.emit(ev(etat(2)));
    socket.emit(encodeSnapshot(D, 0, 0, [joueur(1), vise]));
    expect(simule(client, socket, 30, true, 2, vise)).toEqual([]);
  });

  it('la prediction du porteur local : x 0,6, et x 0,8 en solo', () => {
    for (const [solo, facteur] of [
      [false, RELIQUE_CARRIER_SPEED],
      [true, RELIQUE_CARRIER_SPEED_SOLO],
    ] as const) {
      const { client, socket } = connecteTireur();
      socket.emit(ev({ ...RELIQUE, solo }));
      const D = client.hordeTick - 1;
      socket.emit(ev(etat(1)));
      socket.emit(encodeSnapshot(D, 0, 0, [joueur(1), joueur(2)]));
      // Dix images sans snapshot : l'erreur de reconciliation s'eteint (tau 33 ms).
      let x = 0;
      for (let i = 0; i < 11; i++) {
        horloge += 1000 / TICK_HZ;
        const avant = x;
        x = client.update(horloge, STEP).players.find((p) => p.id === 1)?.x ?? 0;
        if (i === 10) {
          expect(x - avant).toBeCloseTo((PLAYER_SPEED * facteur) / TICK_HZ, 2);
        }
      }
    }
  });

  it('noir : la lanterne datee de meme, sans recalage de tir', () => {
    const { client, socket } = connecte();
    socket.emit(ev({ ...RELIQUE, kind: EVENT_KIND.NOIR, points: [] }));
    socket.emit(ev(etat(2)));
    socket.emit(encodeSnapshot(client.hordeTick - 1, 0, 0, [joueur(1), joueur(2)]));
    expect(client.event?.carrierId).toBe(2);
    expect(client.event?.targets).toEqual([{ x: 100, y: 100 }]);
  });
});

describe('etape 16 : eventTargets — vers quoi pointent les fleches', () => {
  const vide = new Horde(8);
  const base = { cart: null, relic: null, carrierId: 0 };
  const pts = [
    { x: 10, y: 20 },
    { x: 30, y: 40 },
  ];

  it('sceaux, forge, siege : leurs points ; convoi : le chariot', () => {
    for (const kind of [EVENT_KIND.SCEAUX, EVENT_KIND.FORGE, EVENT_KIND.SIEGE]) {
      expect(eventTargets({ ...base, kind, points: pts }, vide, [], 1)).toEqual(pts);
    }
    expect(
      eventTargets({ ...base, kind: EVENT_KIND.CONVOI, points: pts, cart: { x: 5, y: 6 } }, vide, [], 1),
    ).toEqual([{ x: 5, y: 6 }]);
  });

  it('relique : au sol la relique, portee l autel', () => {
    const r = { ...base, kind: EVENT_KIND.RELIQUE, points: pts };
    expect(eventTargets({ ...r, relic: { x: 7, y: 8 } }, vide, [], 1)).toEqual([{ x: 7, y: 8 }]);
    expect(eventTargets({ ...r, carrierId: 2 }, vide, [], 1)).toEqual([{ x: 30, y: 40 }]);
  });

  it('chasse : chaque proie vivante de la horde du client', () => {
    const h = new Horde(16);
    h.spawn({
      waveId: 7,
      spawnTick: 0,
      seed: 7,
      archetype: PROIE_ARCHETYPE,
      formation: FORMATION.POINT,
      anchorX: 500,
      anchorY: 600,
      count: 2,
    });
    h.spawn({
      waveId: 8,
      spawnTick: 0,
      seed: 8,
      archetype: 0,
      formation: FORMATION.POINT,
      anchorX: 50,
      anchorY: 60,
      count: 3,
    });
    const cibles = eventTargets({ ...base, kind: EVENT_KIND.CHASSE, points: pts }, h, [], 1);
    expect(cibles).toHaveLength(2);
    for (const c of cibles) {
      expect(Math.hypot(c.x - 500, c.y - 600)).toBeLessThan(100);
    }
  });

  it('noir : le porteur de lanterne (dernier SNAPSHOT) ; rien si c est soi', () => {
    const joueurs = [
      { id: 1, x: 1, y: 2 },
      { id: 2, x: 3, y: 4 },
    ];
    const n = { ...base, kind: EVENT_KIND.NOIR, points: [], carrierId: 2 };
    expect(eventTargets(n, vide, joueurs, 1)).toEqual([{ x: 3, y: 4 }]);
    expect(eventTargets(n, vide, joueurs, 2)).toEqual([]);
  });
});
```

Les fixtures `EventView` des autres fichiers (typecheck) : dans `front/src/ui/hud.test.ts`
(`forge` l.530-537 et la vue du convoi l.541-548), `front/src/render/behavior-renderer.test.ts`
(`base` l.103), `front/src/render/ping-renderer.test.ts` (`base` l.133) et
`front/src/render/frame.test.ts` (`event` l.150-157), ajouter
`solo: false, carrierId: 0, relic: null, startedAtMs: 0, targets: []` (dans `ping-renderer.test.ts`,
`targets` y est réécrit à la tâche 11 ; d'ici là le calque lit encore `points`).

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/net/evenement.test.ts src/net/prediction.test.ts`
Attendu : ÉCHEC — `eventTargets` et `lastFireTickOf` indéfinis ; `prediction.test.ts` passe déjà
(c'est la propriété existante de la réconciliation que l'on documente — voulu).

- [ ] **Étape 3 : implémenter**

`front/src/net/client.ts` :

- imports : l.7 gagne `PROIE_ARCHETYPE` ; l.33 devient
  `import { CarrierClock, EVENT_KIND, EVENT_OUTCOME, EVENT_STATE_PERIOD_TICKS, relicSpeedFactor } from '@shared/evenements';` ;
  l.34 gagne `lastFireAfterCarry` (et `fireCooldown`, déjà là depuis la tâche 5).
- `EventView` (l.264-278) gagne, après `cartHp` :

```ts
  /** Un seul vivant au depart (bit haut de l'octet de genre). */
  solo: boolean;
  /**
   * Relique : le porteur au tick de horde COURANT (0 au sol), date par
   * `CarrierClock`. Noir : le porteur de lanterne. 0 sinon.
   */
  carrierId: number;
  /** Relique AU SOL, interpolee comme le chariot ; `null` portee ou hors relique. */
  relic: { x: number; y: number } | null;
  /** Horloge murale de la reception d'`EVENT_START` : le fondu du noir part de la. */
  startedAtMs: number;
  /** Les cibles des fleches de bord (`eventTargets`). */
  targets: readonly { x: number; y: number }[];
```

- `EventMirror` (l.281-291) gagne `solo: boolean; startedAtMs: number;` et
  `/** Relique, noir : le porteur, date au SNAPSHOT qui suit son EVENT_STATE. */ clock: CarrierClock;`.
- `#onEvent`, branche `EVENT_START` : l'objet gagne `solo: msg.solo, startedAtMs: now,
  clock: new CarrierClock(),`. Branche `EVENT_STATE`, après `ev.progress = ...` :

```ts
      // L'octet d'etat se lit selon le genre (§7.2) : PV du chariot ou du
      // totem, porteur de relique ou de lanterne — ce dernier ATTEND sa date.
      if (ev.kind === EVENT_KIND.RELIQUE || ev.kind === EVENT_KIND.NOIR) {
        ev.clock.heard(msg.cartHp);
      } else {
        ev.cartHp = msg.cartHp / 255;
      }
```

  (la ligne `ev.cartHp = msg.cartHp / 255;` existante l.2034 est remplacée par ce bloc).
- après `loadoutOf` (l.1707-1716) :

```ts
  /** Lecture de test (etape 16) : le dernier tick de tir du miroir, `-Infinity` jamais. */
  lastFireTickOf(playerId: number, weaponId: number): number {
    return this.#lastFireTick.get(playerId)?.[weaponId] ?? Number.NEGATIVE_INFINITY;
  }

  /** Le porteur de la RELIQUE au tick `tick` (0 au sol, et hors relique). */
  #relicCarrierAt(tick: number): number {
    const ev = this.#event;
    return ev !== null && ev.kind === EVENT_KIND.RELIQUE ? ev.clock.at(tick) : 0;
  }
```

- le getter `event` (l.1899-1913) :

```ts
  get event(): EventView | null {
    const ev = this.#event;
    if (ev === null) {
      return null;
    }
    const now = performance.now();
    const porteur = ev.kind === EVENT_KIND.RELIQUE || ev.kind === EVENT_KIND.NOIR;
    const carrierId = porteur ? ev.clock.at(this.#lastHordeTick) : 0;
    const vue: EventView = {
      kind: ev.kind,
      points: ev.points,
      progress: ev.progress,
      secondsLeft: Math.max(0, ev.deadline - this.#pingClock) / TICK_HZ,
      cart: ev.kind === EVENT_KIND.CONVOI ? this.#cartAt(ev, now) : null,
      cartHp: ev.cartHp,
      solo: ev.solo,
      carrierId,
      relic: ev.kind === EVENT_KIND.RELIQUE && carrierId === 0 ? this.#cartAt(ev, now) : null,
      startedAtMs: ev.startedAtMs,
      targets: [],
    };
    vue.targets = eventTargets(vue, this.horde, this.#buffer.latest()?.players ?? [], this.#localId);
    return vue;
  }
```

- `#localSpeed` (l.2197-2203) :

```ts
  #localSpeed(): number {
    const base = PLAYER_SPEED + this.accountBonuses.speed;
    if (this.#localId === null) {
      return base;
    }
    const speed = base + this.loadoutOf(this.#localId).bonus('speed');
    // Etape 16 : porteur de relique, au tick de horde courant. Le facteur
    // multiplie la vitesse ENTIERE, comme `Room.step` ; la rampe (`scale`)
    // reste a part. Une date en retard coute au plus ~3,5 px par snapshot,
    // que la reconciliation eteint (§8.2) : on la tolere, on ne la previent pas.
    const ev = this.#event;
    return ev !== null && this.#relicCarrierAt(this.#lastHordeTick) === this.#localId
      ? speed * relicSpeedFactor(ev.solo)
      : speed;
  }
```

- gestionnaire de `SNAPSHOT`, juste après le recalage de `#lastHordeTick` (l.2468-2470), AVANT
  le `return` sur `mine` :

```ts
    // Etape 16 : l'EVENT_STATE d'un changement de porteur est parti juste
    // avant CE snapshot (meme envoi) : il vaut a partir de msg.tick + 1.
    this.#dateCarrier(msg.tick, msg.players);
```

  et la méthode, après `#relicCarrierAt` :

```ts
  /**
   * Date l'octet de porteur en attente (§8.1). Si la fin d'un port de relique
   * arrive EN RETARD — le client a deja simule `from` en croyant au port —,
   * recale le miroir de tir de l'ancien porteur sur la DERNIERE salve que le
   * serveur a tiree (`lastFireAfterCarry`, ecart n° 6 du plan) : sans quoi sa
   * phase resterait decalee pour toute la run. Seulement s'il vise : le
   * serveur ne tire pas sans visee.
   */
  #dateCarrier(tick: number, players: readonly PlayerSnapshot[]): void {
    const ev = this.#event;
    const d = ev?.clock.dated(tick) ?? null;
    if (ev === null || d === null || ev.kind !== EVENT_KIND.RELIQUE || d.released === 0) {
      return;
    }
    if (this.#lastHordeTick <= d.from) {
      return;
    }
    const allie = players.find((p) => p.id === d.released);
    const aim =
      d.released === this.#localId
        ? this.#localAim
        : allie
          ? { x: allie.aimX, y: allie.aimY }
          : null;
    const last = this.#lastFireTick.get(d.released);
    if (aim === null || (aim.x === 0 && aim.y === 0) || !last) {
      return;
    }
    const loadout = this.loadoutOf(d.released);
    for (const w of loadout.weaponIds) {
      last[w] = lastFireAfterCarry(
        last[w] ?? Number.NEGATIVE_INFINITY,
        d.from,
        this.#lastHordeTick,
        fireCooldown(loadout, w, this.accountBonuses.fireRate),
      );
    }
  }
```

- `#fireWeapons`, après le garde `if (p.hp <= 0) { continue; }` (l.3047-3049) :

```ts
      // Etape 16 : le garde du serveur, a la meme date (D + 1, `CarrierClock`).
      if (p.id === this.#relicCarrierAt(tick)) {
        continue;
      }
```

- en fin de fichier :

```ts
/**
 * Les cibles des fleches de bord d'un evenement (§9.3), PURE. Sceaux, forge,
 * siege : leurs points ; convoi : le chariot ; relique : elle au sol, l'autel
 * portee ; chasse : les proies vivantes de la horde du client (un balayage
 * par image, comme `behaviorShapes`) ; noir : le porteur de lanterne, rien si
 * c'est soi.
 */
export function eventTargets(
  ev: Pick<EventView, 'kind' | 'points' | 'cart' | 'relic' | 'carrierId'>,
  horde: Horde,
  players: readonly { id: number; x: number; y: number }[],
  localId: number | null,
): { x: number; y: number }[] {
  if (ev.kind === EVENT_KIND.CONVOI) {
    return ev.cart ? [ev.cart] : [];
  }
  if (ev.kind === EVENT_KIND.RELIQUE) {
    if (ev.carrierId === 0) {
      return ev.relic ? [ev.relic] : [];
    }
    const autel = ev.points[1];
    return autel ? [autel] : [];
  }
  if (ev.kind === EVENT_KIND.CHASSE) {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < horde.count; i++) {
      if (horde.archetype[i] === PROIE_ARCHETYPE) {
        out.push({ x: horde.x[i] ?? 0, y: horde.y[i] ?? 0 });
      }
    }
    return out;
  }
  if (ev.kind === EVENT_KIND.NOIR) {
    if (ev.carrierId === localId) {
      return [];
    }
    const p = players.find((j) => j.id === ev.carrierId);
    return p ? [{ x: p.x, y: p.y }] : [];
  }
  return [...ev.points];
}
```

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd front && npx vitest run src/net/evenement.test.ts src/net/prediction.test.ts src/net/client.test.ts src/ui/hud.test.ts src/render/behavior-renderer.test.ts src/render/ping-renderer.test.ts src/render/frame.test.ts`
Attendu : PASS. Si « livraison apprise en retard » rougit sur `lastFireTickOf` à E + 8 au lieu de
E + 5, c'est que le recalage n'a pas couru (ordre dans le gestionnaire de `SNAPSHOT`) ; ne pas
toucher au test.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/net/client.ts front/src/net/evenement.test.ts front/src/net/prediction.test.ts front/src/ui/hud.test.ts front/src/render/behavior-renderer.test.ts front/src/render/ping-renderer.test.ts front/src/render/frame.test.ts
git add front/src/net/client.ts front/src/net/evenement.test.ts front/src/net/prediction.test.ts front/src/ui/hud.test.ts front/src/render/behavior-renderer.test.ts front/src/render/ping-renderer.test.ts front/src/render/frame.test.ts
git commit -m "feat(front): le miroir date le porteur, ralentit sa prediction et fait taire son tir"
```

---

### Tâche 8 : l'annonce — bandeaux par (genre, issue), quatre textes d'état, le même son

**Fichiers :**
- Modifier : `front/src/net/client.ts` (`EVENT_START_BANNERS` l.250-255 ; `EVENT_END_BANNERS`
  l.257-262 ; `#onEvent`, branche `EVENT_END` l.2036-2042), `front/src/ui/hud.ts`
  (`EVENT_NAMES` l.213 ; `eventStatusText` l.215-227)
- Tester : `front/src/net/evenement.test.ts` (nouveau `describe` en fin),
  `front/src/ui/hud.test.ts` (nouveau test dans « etape 14 : l evenement au HUD », l.528-580)

**Interfaces :**
- Consomme : `EventView` (tâche 7).
- Produit : `export function eventEndBanner(kind: number | null, outcome: number): string`
  (`client.ts`) ; `eventStatusText` lit les sept genres. Le son reste `'evenement'`, déclenché par
  `eventCount` (`audio.ts` l.99-100) : rien à changer, un test le tient pour le noir. Le titre
  « Événement » de l'étalage (`draftIsEvent`) ne change pas : il suit `EVENT_END` réussi, quel que
  soit le genre.

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/net/evenement.test.ts` : ajouter `eventEndBanner` à l'import de `./client`, puis en fin
de fichier :

```ts
describe('etape 16 : les bandeaux des quatre evenements', () => {
  it('au depart, un bandeau par genre ; eventCount compte (le son « evenement » en depend)', () => {
    const textes: Record<number, string> = {
      [EVENT_KIND.SIEGE]: 'Un totem appelle ses défenseurs !',
      [EVENT_KIND.RELIQUE]: 'Une relique attend son porteur !',
      [EVENT_KIND.CHASSE]: 'Des proies rôdent !',
      [EVENT_KIND.NOIR]: 'La nuit tombe !',
    };
    for (const [kind, texte] of Object.entries(textes)) {
      const { client, socket } = connecte();
      socket.emit(ev({ ...FORGE, kind: Number(kind) }));
      expect(client.eventBanner).toBe(texte);
      expect(client.eventCount).toBe(1);
    }
  });

  it('a la fin, par (genre, issue) : le genre est lu AVANT d effacer le miroir', () => {
    const fin = (kind: number, outcome: number): string | null => {
      const { client, socket } = connecte();
      socket.emit(ev({ ...FORGE, kind }));
      socket.emit(ev({ type: MSG.EVENT_END, outcome }));
      return client.eventBanner;
    };
    expect(fin(EVENT_KIND.SIEGE, EVENT_OUTCOME.DETRUIT)).toBe('Le totem est tombé…');
    expect(fin(EVENT_KIND.NOIR, EVENT_OUTCOME.DETRUIT)).toBe("La lanterne s'éteint…");
    expect(fin(EVENT_KIND.CONVOI, EVENT_OUTCOME.DETRUIT)).toBe('Le convoi est détruit…');
    expect(fin(EVENT_KIND.RELIQUE, EVENT_OUTCOME.EXPIRE)).toBe("L'événement s'éteint…");
    expect(fin(EVENT_KIND.CHASSE, EVENT_OUTCOME.REUSSI)).toBe('Réussi — étalage de règles !');
  });

  it('sans miroir (arrive en cours d evenement), le texte de l issue seule', () => {
    expect(eventEndBanner(null, EVENT_OUTCOME.DETRUIT)).toBe('Le convoi est détruit…');
    expect(eventEndBanner(null, EVENT_OUTCOME.EXPIRE)).toBe("L'événement s'éteint…");
  });
});
```

`front/src/ui/hud.test.ts`, dans le `describe('etape 14 : l evenement au HUD')`, après le premier
test :

```ts
  it('etape 16 : « Le siège — 62 % — totem 70 % », « La relique — 40 % », « La chasse — 1 / 3 », « Le noir — 55 % »', () => {
    expect(
      eventStatusText({ ...forge, kind: EVENT_KIND.SIEGE, progress: 0.62, cartHp: 0.7 }),
    ).toBe('Le siège — 62 % — totem 70 % — 0:41');
    expect(eventStatusText({ ...forge, kind: EVENT_KIND.RELIQUE, progress: 0.4, secondsLeft: 32.5 })).toBe(
      'La relique — 40 % — 0:33',
    );
    // L'octet de progression : floor(255 x 1 / 3) = 85 ; 85 / 255 x 3 s'arrondit a 1.
    const p = { x: 1, y: 2 };
    const chasse: EventView = { ...forge, kind: EVENT_KIND.CHASSE, points: [p, p, p] };
    expect(eventStatusText({ ...chasse, progress: 85 / 255 })).toBe('La chasse — 1 / 3 — 0:41');
    expect(eventStatusText({ ...chasse, progress: 170 / 255 })).toBe(
      'La chasse — 2 / 3 — 0:41',
    );
    expect(eventStatusText({ ...forge, kind: EVENT_KIND.NOIR, progress: 0.55, secondsLeft: 17.4 })).toBe(
      'Le noir — 55 % — 0:18',
    );
  });
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/net/evenement.test.ts src/ui/hud.test.ts`
Attendu : ÉCHEC — `eventEndBanner` non exporté ; « Événement — 62 % » au lieu du siège.

- [ ] **Étape 3 : implémenter**

`front/src/net/client.ts` :

```ts
/** Le bandeau du depart, par genre (`EVENT_KIND`). */
const EVENT_START_BANNERS: readonly string[] = [
  "Les sceaux s'éveillent !",
  "La forge s'allume !",
  'Un convoi attend son escorte !',
  'Un totem appelle ses défenseurs !',
  'Une relique attend son porteur !',
  'Des proies rôdent !',
  'La nuit tombe !',
];

/** Le bandeau de la fin, par issue (`EVENT_OUTCOME`) — le repli sans genre connu. */
const EVENT_END_BANNERS: readonly string[] = [
  'Réussi — étalage de règles !',
  "L'événement s'éteint…",
  'Le convoi est détruit…',
];

/** « Detruit » se dit selon ce qui l'a ete (etape 16, §9.1). */
const EVENT_DESTROYED_BANNERS: Readonly<Record<number, string>> = {
  [EVENT_KIND.CONVOI]: 'Le convoi est détruit…',
  [EVENT_KIND.SIEGE]: 'Le totem est tombé…',
  [EVENT_KIND.NOIR]: "La lanterne s'éteint…",
};

/**
 * Le bandeau d'`EVENT_END`, par (genre, issue). `kind` vaut `null` pour un
 * client sans miroir (arrive en cours d'evenement) : le texte de l'issue seule.
 */
export function eventEndBanner(kind: number | null, outcome: number): string {
  const detruit =
    outcome === EVENT_OUTCOME.DETRUIT && kind !== null ? EVENT_DESTROYED_BANNERS[kind] : undefined;
  return detruit ?? EVENT_END_BANNERS[outcome] ?? '';
}
```

Dans `#onEvent`, la branche finale (l.2036-2042) devient :

```ts
    // ⚠️ Le genre est lu AVANT d'effacer le miroir : le bandeau en depend.
    const kind = this.#event?.kind ?? null;
    this.#event = null;
    // ⚠️ Compte meme sans depart vu (ecart n° 12 du plan) : l'`EVENT_END`
    // suffit a nommer l'etalage qui suit.
    if (msg.outcome === EVENT_OUTCOME.REUSSI) {
      this.#eventDraftsOwed++;
    }
    this.#eventBanner = { text: eventEndBanner(kind, msg.outcome), atMs: now };
```

`front/src/ui/hud.ts` :

```ts
/** Le nom de chaque evenement au HUD, par `EVENT_KIND`. */
const EVENT_NAMES: readonly string[] = [
  'Les sceaux',
  'La forge',
  'Le convoi',
  'Le siège',
  'La relique',
  'La chasse',
  'Le noir',
];

/**
 * « La forge — 62 % — 0:41 », « Le convoi — 40 % — chariot 70 % — 0:33 »
 * (etape 14, §7.4) ; « Le siège — 62 % — totem 70 % — 0:41 », « La chasse —
 * 1 / 3 — 0:41 » (etape 16, §9.1). PURE. Le temps est arrondi a la seconde
 * SUPERIEURE : un compte a rebours ne montre « 0:00 » qu'a la fin.
 *
 * La chasse compte ses proies : `round(progres x n)`, exact pour n <= 3
 * puisque l'octet vaut `floor(255 k / n)`.
 */
export function eventStatusText(event: EventView): string {
  const nom = EVENT_NAMES[event.kind] ?? 'Événement';
  const temps = formatTimer(Math.ceil(event.secondsLeft) * TICK_HZ);
  if (event.kind === EVENT_KIND.CHASSE) {
    const n = event.points.length;
    return `${nom} — ${Math.round(event.progress * n)} / ${n} — ${temps}`;
  }
  const avance = `${Math.floor(event.progress * 100)} %`;
  if (event.kind === EVENT_KIND.CONVOI) {
    return `${nom} — ${avance} — chariot ${Math.round(event.cartHp * 100)} % — ${temps}`;
  }
  if (event.kind === EVENT_KIND.SIEGE) {
    return `${nom} — ${avance} — totem ${Math.round(event.cartHp * 100)} % — ${temps}`;
  }
  return `${nom} — ${avance} — ${temps}`;
}
```

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd front && npx vitest run src/net/evenement.test.ts src/ui/hud.test.ts src/audio/audio.test.ts`
Attendu : PASS.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/net/client.ts front/src/net/evenement.test.ts front/src/ui/hud.ts front/src/ui/hud.test.ts
git add front/src/net/client.ts front/src/net/evenement.test.ts front/src/ui/hud.ts front/src/ui/hud.test.ts
git commit -m "feat(front): les bandeaux et l etat au hud des quatre evenements"
```

---

### Tâche 9 : au sol — le totem, la relique et l'autel, l'anneau rouge des proies, le gnoll emprunté

**Fichiers :**
- Modifier : `front/src/render/behavior-renderer.ts` (imports l.1-15 ; `BehaviorShape.kind` l.30 ;
  constantes après `CHEST_BROWN` l.49 ; `behaviorShapes` l.85-120 ; `EventShape` l.143-154 ;
  `eventShapes` l.166-215 ; `drawCart` l.231-248 → `dashedCircle`, `hpBar` ; `draw` l.334-466),
  `front/src/render/horde-renderer.ts` (import l.1 ; alias après l.501), `front/src/render/stage.ts`
  (`drawBehaviors` l.403-412 : `players` porte `id`)
- Tester : `front/src/render/behavior-renderer.test.ts` (import l.1-15 ; fixtures `joueurs`
  l.117-120 et l.127 gagnent `id` ; nouveaux `describe` en fin), `front/src/render/horde-renderer.test.ts`
  (import l.1-10 ; nouveau `describe` en fin)

**Interfaces :**
- Consomme : `EventView.carrierId`, `EventView.relic` (tâche 7) ; `PROIE_ARCHETYPE` (tâche 2) ;
  `SIEGE_DEFEND_RADIUS`, `RELIQUE_ALTAR_RADIUS` (tâche 1).
- Produit : `eventShapes(event, players: readonly { id: number; x: number; y: number; hp: number }[],
  view)` ; `EventShape.kind` gagne `'totem' | 'relique' | 'autel'` ; `BehaviorShape.kind` gagne
  `'proie'` ; `PROIE_RED = 0xe0352b`, `PROIE_RING_RADIUS = 46`, `RELIC_LIFT = 48`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/render/behavior-renderer.test.ts` : l'import de `@shared/evenements` gagne
`RELIQUE_ALTAR_RADIUS`, `SIEGE_DEFEND_RADIUS` ; celui de `./behavior-renderer` gagne
`PROIE_RING_RADIUS`, `RELIC_LIFT`. Les joueurs des tests de sceaux et de forge (l.117-120, l.127)
gagnent `id: 1` / `id: 2`. Puis en fin de fichier :

```ts
describe('etape 16 : les formes des quatre evenements', () => {
  const view = new Rectangle(0, 0, 800, 600);
  const base = {
    progress: 0.5,
    secondsLeft: 30,
    cart: null,
    cartHp: 0.7,
    solo: false,
    carrierId: 0,
    relic: null,
    startedAtMs: 0,
    targets: [],
  };

  it('le siege : le totem, sa zone de defense, son anneau et ses PV', () => {
    const siege: EventView = { ...base, kind: EVENT_KIND.SIEGE, points: [{ x: 300, y: 300 }] };
    expect(eventShapes(siege, [], view)).toEqual([
      { kind: 'totem', x: 300, y: 300, radius: SIEGE_DEFEND_RADIUS, progress: 0.5, hp: 0.7 },
    ]);
  });

  it('la relique au sol : la relique interpolee et l autel, jamais le site', () => {
    const relique: EventView = {
      ...base,
      kind: EVENT_KIND.RELIQUE,
      points: [
        { x: 50, y: 50 },
        { x: 700, y: 400 },
      ],
      relic: { x: 120, y: 130 },
    };
    expect(eventShapes(relique, [], view)).toEqual([
      { kind: 'autel', x: 700, y: 400, radius: RELIQUE_ALTAR_RADIUS, progress: 0.5 },
      { kind: 'relique', x: 120, y: 130, radius: 14 },
    ]);
  });

  it('portee : au-dessus du porteur DESSINE (sa position dans `players`), jamais en retard', () => {
    const portee: EventView = {
      ...base,
      kind: EVENT_KIND.RELIQUE,
      points: [
        { x: 50, y: 50 },
        { x: 700, y: 400 },
      ],
      carrierId: 2,
    };
    const joueurs = [
      { id: 1, x: 10, y: 10, hp: 100 },
      { id: 2, x: 400, y: 300, hp: 100 },
    ];
    expect(eventShapes(portee, joueurs, view)).toContainEqual({
      kind: 'relique',
      x: 400,
      y: 300 - RELIC_LIFT,
      radius: 14,
    });
    // Porteur introuvable (pas encore dans le snapshot) : pas de relique flottante.
    expect(eventShapes(portee, [], view).map((s) => s.kind)).toEqual(['autel']);
  });

  it('chasse et noir : rien au sol (les proies sont dans behaviorShapes, la nuit a son calque)', () => {
    expect(eventShapes({ ...base, kind: EVENT_KIND.CHASSE, points: [{ x: 1, y: 1 }] }, [], view)).toEqual(
      [],
    );
    expect(eventShapes({ ...base, kind: EVENT_KIND.NOIR, points: [] }, [], view)).toEqual([]);
  });

  it('behaviorShapes : un anneau rouge par proie dans le cadre, en permanence', () => {
    const horde = hordeAt([
      { x: 100, y: 100, behavior: 'proie' },
      { x: 9000, y: 9000, behavior: 'proie' },
    ]);
    horde.fleeing[0] = 1;
    expect(behaviorShapes(horde, [], view, 0)).toEqual([
      { kind: 'proie', x: 100, y: 100, radius: PROIE_RING_RADIUS, alpha: 1 },
    ]);
  });
});
```

(Si `hordeAt` n'accepte pas `'proie'` — il choisit l'archétype par comportement —, il le trouve
puisque `PROIE` est le seul archétype `'proie'` ; ne pas modifier l'aide.)

`front/src/render/horde-renderer.test.ts` : à l'import de `@shared/archetypes` ajouter
`PROIE_ARCHETYPE`, `PROIE_BODY_SCALE` ; puis en fin de fichier :

```ts
/** La proie n'a PAS d'entree dans l'atlas : le gnoll, par alias, comme le porteur et le voleur. */
describe('etape 16 : la proie emprunte le gnoll, en plus grand', () => {
  const GNOLL = archetypeIdOf('gnoll');

  it('dessine la proie avec les textures du gnoll', () => {
    expect(drawnParticles(twoEnemies(PROIE_ARCHETYPE), GNOLL)).toHaveLength(2);
  });

  it('a l arret elle attend sur la PREMIERE image de sa course', () => {
    const horde = twoEnemies(PROIE_ARCHETYPE);
    horde.stopped[0] = 1;
    horde.stopped[1] = 1;
    expect(particleOf(drawnParticles(horde, GNOLL), horde, 0).texture.frame.x).toBe(FIXTURE_RUN_X);
  });

  it('a 1,6 fois l echelle du gnoll', () => {
    const proies = twoEnemies(PROIE_ARCHETYPE);
    const gnolls = twoEnemies(GNOLL);
    const p = particleOf(drawnParticles(proies, GNOLL), proies, 0);
    const g = particleOf(drawnParticles(gnolls, GNOLL), gnolls, 0);
    expect(p.scaleY / g.scaleY).toBeCloseTo(PROIE_BODY_SCALE, 5);
  });
});
```

Le gnoll est une **brute**, dont le `bodyScale` de rôle vaut 1 (`shared/archetypes.ts` l.367-372),
comme le voleur du porteur : le rapport mesuré est exactement `PROIE_BODY_SCALE`.

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/render/behavior-renderer.test.ts src/render/horde-renderer.test.ts`
Attendu : ÉCHEC — `PROIE_RING_RADIUS`, `RELIC_LIFT` non exportés ; la proie n'est pas dessinée.

- [ ] **Étape 3 : implémenter**

`front/src/render/behavior-renderer.ts` :

- l'import de `@shared/evenements` gagne `RELIQUE_ALTAR_RADIUS`, `SIEGE_DEFEND_RADIUS` ;
- `BehaviorShape.kind` (l.30) gagne `| 'proie'` ;
- après `CHEST_BROWN` (l.49) :

```ts
/** La proie de la chasse (etape 16, §9.2) : un anneau ROUGE sous ses pieds, en permanence. */
export const PROIE_RED = 0xe0352b;
export const PROIE_RING_RADIUS = 46;
/** La relique portee flotte a cette hauteur au-dessus de son porteur dessine. */
export const RELIC_LIFT = 48;
/** Le gris du pilier du totem. */
const TOTEM_GREY = 0x8a8f99;
```

- `behaviorShapes` : `behavior !== 'proie' &&` rejoint la liste l.85-92, et avant le `else` final
  (l.118) :

```ts
    } else if (behavior === 'proie') {
      // En permanence, comme l'anneau du porteur : la cible de la chasse se lit d'un coup d'oeil.
      out.push({ kind: 'proie', x, y, radius: PROIE_RING_RADIUS, alpha: 1 });
```

- `EventShape.kind` (l.144) : `'sceau' | 'forge' | 'chariot' | 'arrivee' | 'totem' | 'relique' |
  'autel'` ; la doc de `hp` : « Chariot, totem : ses PV, de 0 a 1. »
- `eventShapes` : la signature prend `players: readonly { id: number; x: number; y: number; hp:
  number }[]`, et, avant la branche du convoi (l.181) :

```ts
  if (event.kind === EVENT_KIND.CHASSE || event.kind === EVENT_KIND.NOIR) {
    // Les proies sont dans `behaviorShapes` ; la nuit a son propre calque.
    return out;
  }
  if (event.kind === EVENT_KIND.SIEGE) {
    const t = event.points[0];
    if (t && dedans(t.x, t.y)) {
      out.push({
        kind: 'totem',
        x: t.x,
        y: t.y,
        radius: SIEGE_DEFEND_RADIUS,
        progress: event.progress,
        hp: event.cartHp,
      });
    }
    return out;
  }
  if (event.kind === EVENT_KIND.RELIQUE) {
    const autel = event.points[1];
    if (autel && dedans(autel.x, autel.y)) {
      out.push({
        kind: 'autel',
        x: autel.x,
        y: autel.y,
        radius: RELIQUE_ALTAR_RADIUS,
        progress: event.progress,
      });
    }
    // Au sol : sa position interpolee. Portee : au-dessus du porteur DESSINE
    // (predit si c'est soi, interpole sinon) — jamais en retard de 200 ms.
    const porteur = players.find((p) => p.id === event.carrierId);
    const r =
      event.carrierId === 0
        ? event.relic
        : porteur
          ? { x: porteur.x, y: porteur.y - RELIC_LIFT }
          : null;
    if (r && dedans(r.x, r.y)) {
      out.push({ kind: 'relique', x: r.x, y: r.y, radius: 14 });
    }
    return out;
  }
```

- `drawCart` (l.231-248) sort ses deux morceaux :

```ts
/** Un cercle pointille or a 25 % : l'escorte du chariot, la defense du totem. */
function dashedCircle(g: Graphics, x: number, y: number, r: number): void {
  for (let k = 0; k < 24; k += 2) {
    const a0 = (k * Math.PI * 2) / 24;
    const a1 = ((k + 1) * Math.PI * 2) / 24;
    g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r);
    g.arc(x, y, r, a0, a1).stroke({ color: COIN_TINT, width: 2, alpha: 0.25 });
  }
}

/** Une barre de PV de 48 x 5 px centree sur `x`, haut a `top` : verte, or, rouge. */
function hpBar(g: Graphics, x: number, top: number, fraction: number): void {
  const hp = Math.min(1, Math.max(0, fraction));
  g.rect(x - 24, top, 48, 5).fill(0x1a0f0a);
  g.rect(x - 24, top, 48 * hp, 5).fill(hp > 0.5 ? 0x5bd16a : hp > 0.25 ? COIN_TINT : 0xff3b2f);
}

/** Le chariot : l'escorte en pointille, les roues, la caisse, un coffre dessus, sa barre de PV. */
function drawCart(g: Graphics, s: EventShape): void {
  const { x, y } = s;
  dashedCircle(g, x, y, s.radius);
  g.circle(x - 14, y + 15, 8).fill(CHEST_BROWN);
  g.circle(x + 14, y + 15, 8).fill(CHEST_BROWN);
  g.rect(x - 24, y - 15, 48, 30)
    .fill(CART_BROWN)
    .stroke({ color: CHEST_BROWN, width: 2 });
  drawChest(g, x, y - 23, 0.8);
  hpBar(g, x, y - 41, s.hp ?? 1);
}
```

- `draw` : la signature prend `players: readonly { id: number; x: number; y: number; hp: number
  }[] = []` ; dans la boucle des comportements, avant la branche `releve` (l.410) :

```ts
      } else if (s.kind === 'proie') {
        g.circle(s.x, s.y, s.radius).fill({ color: PROIE_RED, alpha: 0.15 });
        g.circle(s.x, s.y, s.radius).stroke({ color: PROIE_RED, width: 4 });
```

  et dans la boucle des formes d'événement, avant la branche finale de l'arrivée (l.459) :

```ts
      } else if (s.kind === 'totem') {
        dashedCircle(g, s.x, s.y, s.radius);
        progressRing(g, s);
        // Un pilier de 24 x 56 px, coiffe d'un losange or, sa barre de PV au-dessus.
        g.rect(s.x - 12, s.y - 56, 24, 56)
          .fill(TOTEM_GREY)
          .stroke({ color: CHEST_BROWN, width: 2 });
        g.poly([s.x, s.y - 72, s.x + 9, s.y - 63, s.x, s.y - 54, s.x - 9, s.y - 63]).fill(COIN_TINT);
        hpBar(g, s.x, s.y - 84, s.hp ?? 1);
      } else if (s.kind === 'autel') {
        g.circle(s.x, s.y, s.radius).fill({ color: COIN_TINT, alpha: 0.12 });
        g.circle(s.x, s.y, s.radius).stroke({ color: COIN_TINT, width: 3 });
        progressRing(g, s);
      } else if (s.kind === 'relique') {
        g.circle(s.x, s.y, s.radius * 1.8).fill({ color: COIN_TINT, alpha: 0.3 });
        g.poly([s.x, s.y - s.radius, s.x + s.radius, s.y, s.x, s.y + s.radius, s.x - s.radius, s.y])
          .fill(COIN_TINT)
          .stroke({ color: CHEST_BROWN, width: 2 });
```

`front/src/render/stage.ts`, `drawBehaviors` (l.403-412) : le type de `players` devient
`readonly { id: number; x: number; y: number; hp: number }[]` (`frame.ts` l.297-304 passe déjà
`state.players`, qui porte l'id).

`front/src/render/horde-renderer.ts` : l'import l.1 gagne `PROIE_ARCHETYPE` ; après l'alias du
porteur (l.499-501) :

```ts
    // ⚠️ **La proie de la chasse (etape 16) non plus** : un gnoll agrandi, le
    // meme mecanisme que le porteur — sa course, la premiere image figee a
    // l'arret (elle attend), la taille de contenu du gnoll que `bodyScale`
    // (1,6) agrandit. Aucun actif nouveau sur MinIO.
    const gnoll = archetypeIdOf('gnoll');
    this.#runFrames[PROIE_ARCHETYPE] = this.#runFrames[gnoll] ?? [];
    this.#attackFrames[PROIE_ARCHETYPE] = this.#runFrames[gnoll]?.slice(0, 1) ?? [];
    sizesPx[PROIE_ARCHETYPE] = sizesPx[gnoll] ?? 0;
```

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd front && npx vitest run src/render/behavior-renderer.test.ts src/render/horde-renderer.test.ts src/render/frame.test.ts src/render/stage.test.ts`
Attendu : PASS (les formes de l'étape 14, chariot compris, inchangées).

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/render/behavior-renderer.ts front/src/render/behavior-renderer.test.ts front/src/render/horde-renderer.ts front/src/render/horde-renderer.test.ts front/src/render/stage.ts
git add front/src/render/behavior-renderer.ts front/src/render/behavior-renderer.test.ts front/src/render/horde-renderer.ts front/src/render/horde-renderer.test.ts front/src/render/stage.ts
git commit -m "feat(front): le totem, la relique, l autel et l anneau rouge des proies"
```

---

### Tâche 10 : le noir à l'écran — un `Graphics` troué, entre la barre du boss et les pings, et la mini-carte vide

**Fichiers :**
- Créer : `front/src/render/darkness-renderer.ts`, `front/src/render/darkness-renderer.test.ts`
- Modifier : `front/src/render/stage.ts` (import ; champ après `#bossBar` l.104 ; `#layers`
  l.162-165 ; `#procedural` l.193-194 ; `drawDarkness` après `drawBossBar` l.493-495),
  `front/src/render/frame.ts` (`FrameStage` après `drawBossBar` l.204 ; appel après l.327),
  `front/src/ui/minimap.ts` (fonction `minimapEnemies` après `toMinimap` l.53-56),
  `front/src/main.ts` (l.714 et import l.43)
- Tester : `front/src/render/stage.test.ts` (l.368-428), `front/src/render/frame.test.ts`
  (`RecordingStage` l.81-84 ; ordre l.408-436 ; un test après l.480),
  `front/src/ui/minimap.test.ts` (nouveau `describe` en fin)

**Interfaces :**
- Consomme : `EventView.carrierId`, `EventView.solo`, `EventView.startedAtMs` (tâche 7) ;
  `lightRadius` (tâche 1).
- Produit : `darknessHole(event: EventView | null, players: readonly { id: number; x: number; y:
  number; hp: number }[]): { x: number; y: number; radius: number } | null` (`null` : pas
  d'obscurité ; `radius: 0` : obscurité sans trou, porteur introuvable ou mort) ;
  `darknessAlpha(startedAtMs: number, nowMs: number): number` ; `class DarknessRenderer { attach;
  load; loaded; draw(event, players, view: Rectangle, nowMs: number) }` ;
  `Stage#drawDarkness(event, players, nowMs)` ; `FrameStage.drawDarkness` ;
  `minimapEnemies(event: { kind: number } | null, horde: MinimapView['enemies']):
  MinimapView['enemies']`.

**Le coût par image** : un `clear`, un rectangle plein, puis **neuf** primitives (un trou, quatre
anneaux pleins, quatre trous) — cinq remplissages en tout. Ni filtre, ni masque, ni
`RenderTexture` : le test le compte.

**Le z-order** : sous le calque, zones, horde, projectiles, flashs et barre du boss (la menace
disparaît) ; au-dessus, les pings du monde et les chiffres (calques suivants), puis les joueurs et
les arbres (`#depth`, `#ghosts`, ajoutés après tous les calques, `stage.ts` l.223) ; au-dessus de
tout, les flèches de bord (calque écran sur `app.stage`, l.214). Rien à écrire pour les alliés : ils
restent visibles par construction.

**Écart (spec §9.4)** : la boucle de la spec remplit l'anneau k (de `r + kF/4` à `r + (k+1)F/4`) à
`a × (1 − (k+1)/5)` — **l'anneau intérieur le plus sombre**, l'inverse d'un bord doux. Le plan
remplit l'anneau k à `a × (k+1)/5` : 0,2 a contre la lumière, 0,8 a contre le noir plein.

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/render/darkness-renderer.test.ts` (créé) :

```ts
import { EVENT_KIND, NOIR_LIGHT_RADIUS, NOIR_LIGHT_RADIUS_SOLO } from '@shared/evenements';
import { Container, type Graphics, Rectangle } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import type { EventView } from '../net/client';
import {
  DarknessRenderer,
  darknessAlpha,
  darknessHole,
  NOIR_DARK_ALPHA,
  NOIR_FADE_MS,
} from './darkness-renderer';

const noir: EventView = {
  kind: EVENT_KIND.NOIR,
  points: [],
  progress: 0,
  secondsLeft: 60,
  cart: null,
  cartHp: 0,
  solo: false,
  carrierId: 2,
  relic: null,
  startedAtMs: 1000,
  targets: [],
};
const joueurs = [
  { id: 1, x: 10, y: 20, hp: 100 },
  { id: 2, x: 400, y: 300, hp: 100 },
];

describe('etape 16 : darknessHole', () => {
  it('centre sur le porteur de lanterne DESSINE, rayon 350 (500 seul)', () => {
    expect(darknessHole(noir, joueurs)).toEqual({ x: 400, y: 300, radius: NOIR_LIGHT_RADIUS });
    expect(darknessHole({ ...noir, solo: true }, joueurs)).toEqual({
      x: 400,
      y: 300,
      radius: NOIR_LIGHT_RADIUS_SOLO,
    });
  });

  it('null hors noir, et tant que le porteur n est pas connu (premier etat pas recu)', () => {
    expect(darknessHole(null, joueurs)).toBeNull();
    expect(darknessHole({ ...noir, kind: EVENT_KIND.SIEGE }, joueurs)).toBeNull();
    expect(darknessHole({ ...noir, carrierId: 0 }, joueurs)).toBeNull();
  });

  it('porteur introuvable ou mort : tout noir, sans trou', () => {
    expect(darknessHole({ ...noir, carrierId: 3 }, joueurs)?.radius).toBe(0);
    expect(
      darknessHole(noir, [{ id: 2, x: 400, y: 300, hp: 0 }])?.radius,
    ).toBe(0);
  });

  it('le fondu : 0 au depart, NOIR_DARK_ALPHA apres NOIR_FADE_MS', () => {
    expect(darknessAlpha(1000, 1000)).toBe(0);
    expect(darknessAlpha(1000, 1000 + NOIR_FADE_MS / 2)).toBeCloseTo(NOIR_DARK_ALPHA / 2, 6);
    expect(darknessAlpha(1000, 1000 + NOIR_FADE_MS * 3)).toBe(NOIR_DARK_ALPHA);
  });
});

describe('etape 16 : DarknessRenderer — le cout d une image', () => {
  function dessine(event: EventView | null, nowMs: number): Graphics {
    const r = new DarknessRenderer();
    const monde = new Container();
    r.attach(monde);
    r.load();
    r.draw(event, joueurs, new Rectangle(0, 0, 800, 600), nowMs);
    return monde.children[0] as Graphics;
  }
  const remplissages = (g: Graphics): number[] =>
    g.context.instructions
      .filter((i) => i.action === 'fill')
      .map((i) => (i.data as { style: { alpha: number } }).style.alpha);

  it('cinq remplissages : le voile, puis quatre anneaux de plus en plus sombres vers le dehors', () => {
    const g = dessine(noir, 1000 + NOIR_FADE_MS);
    const alphas = remplissages(g);
    expect(alphas).toHaveLength(5);
    expect(alphas[0]).toBeCloseTo(NOIR_DARK_ALPHA, 6);
    expect(alphas.slice(1).map((a) => a / NOIR_DARK_ALPHA)).toEqual([
      expect.closeTo(0.2, 6),
      expect.closeTo(0.4, 6),
      expect.closeTo(0.6, 6),
      expect.closeTo(0.8, 6),
    ]);
    // Ni filtre, ni masque.
    expect(g.filters ?? []).toHaveLength(0);
    expect(g.mask).toBeNull();
  });

  it('rien hors noir ; rien avant le premier etat ; un seul voile sans porteur', () => {
    expect(remplissages(dessine(null, 5000))).toEqual([]);
    expect(remplissages(dessine({ ...noir, carrierId: 0 }, 5000))).toEqual([]);
    expect(remplissages(dessine({ ...noir, carrierId: 3 }, 5000))).toHaveLength(1);
  });
});
```

`front/src/render/stage.test.ts` : « attache les douze calques » (l.368-375) attend `16` enfants
(commentaire : « Seize calques ») ; dans les deux tableaux `layersLoaded` (l.386-402 et
l.408-424), ajouter un élément après le 13ᵉ (barre du boss) — `true` dans le premier, `false`
dans le second — et le commentaire d'ordre devient « …, barre du boss, obscurité (étape 16),
pings, chiffres ».

`front/src/render/frame.test.ts` : `RecordingStage` gagne, après `drawBossBar` (l.81-83) :

```ts
  drawDarkness(...args: unknown[]): void {
    this.#record('obscurite', ...args);
  }
```

l'ordre attendu (l.410-435) gagne `'obscurite',` juste après `'barre-boss',` (commentaire : « Le
noir : apres la barre du boss, avant les chiffres »), et après le test « etape 14 : les
comportements… » :

```ts
  it('etape 16 : l obscurite recoit l evenement du client, les joueurs DESSINES et l horloge murale', () => {
    const { stage, client, state } = compose();
    expect(stage.argsOf('obscurite')).toEqual([client.event, state.players, NOW]);
  });
```

`front/src/ui/minimap.test.ts`, en fin de fichier (import `minimapEnemies` de `./minimap`,
`EVENT_KIND` de `@shared/evenements`) :

```ts
describe('etape 16 : la mini-carte ne trahit pas la horde dans le noir', () => {
  const horde = { count: 2, x: Float32Array.of(1, 2), y: Float32Array.of(3, 4) };

  it('pendant le noir : aucun ennemi ; sinon, la horde telle quelle', () => {
    expect(minimapEnemies({ kind: EVENT_KIND.NOIR }, horde).count).toBe(0);
    expect(minimapEnemies({ kind: EVENT_KIND.SIEGE }, horde)).toBe(horde);
    expect(minimapEnemies(null, horde)).toBe(horde);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/render/darkness-renderer.test.ts src/render/stage.test.ts src/render/frame.test.ts src/ui/minimap.test.ts`
Attendu : ÉCHEC — `./darkness-renderer` introuvable ; 15 calques ; `obscurite` jamais appelé ;
`minimapEnemies` non exporté.

- [ ] **Étape 3 : implémenter**

`front/src/render/darkness-renderer.ts` (créé) :

```ts
import { EVENT_KIND, lightRadius } from '@shared/evenements';
import { type Container, Graphics, type Rectangle } from 'pixi.js';

import type { EventView } from '../net/client';

/**
 * Le noir (etape 16, §9.4) : un voile sombre sur le monde, troue d'un cercle
 * de lumiere autour du porteur de lanterne. UN `Graphics`, en coordonnees
 * MONDE (le cercle subit l'ecrasement vertical comme toute forme au sol) :
 * ni filtre, ni masque, ni `RenderTexture` — `cut()` est le trou de Pixi 8.
 * Une douzaine de primitives par image, le cout du chariot.
 *
 * ⚠️ **Pas un brouillard de guerre** : la horde reste dans la memoire du
 * client. Cooperatif, sans enjeu : assume (spec §12).
 */

export const NOIR_DARK_ALPHA = 0.9;
/** Le bord doux : quatre anneaux sur 80 px. A 0, un seul trou net (le repli de la spec §12). */
export const NOIR_FEATHER_PX = 80;
/** Le voile monte de 0 a `NOIR_DARK_ALPHA` en 800 ms depuis la reception d'`EVENT_START`. */
export const NOIR_FADE_MS = 800;
const NOIR_COLOR = 0x05040a;
/** Le voile deborde le cadre : la secousse de camera ne doit jamais en montrer le bord. */
const MARGE = 200;

/**
 * Le trou de lumiere, PUR : le porteur de lanterne DESSINE (predit si c'est
 * soi) et le rayon solo ou non. `null` : pas d'obscurite (hors noir, ou
 * porteur pas encore connu). `radius: 0` : tout noir (porteur introuvable ou
 * mort, jusqu'a l'`EVENT_END` du meme envoi).
 */
export function darknessHole(
  event: EventView | null,
  players: readonly { id: number; x: number; y: number; hp: number }[],
): { x: number; y: number; radius: number } | null {
  if (event === null || event.kind !== EVENT_KIND.NOIR || event.carrierId === 0) {
    return null;
  }
  const p = players.find((j) => j.id === event.carrierId);
  if (!p || p.hp <= 0) {
    return { x: 0, y: 0, radius: 0 };
  }
  return { x: p.x, y: p.y, radius: lightRadius(event.solo) };
}

/** L'opacite du voile a `nowMs`, en fondu depuis `startedAtMs`. */
export function darknessAlpha(startedAtMs: number, nowMs: number): number {
  return NOIR_DARK_ALPHA * Math.min(1, Math.max(0, (nowMs - startedAtMs) / NOIR_FADE_MS));
}

export class DarknessRenderer {
  readonly #g = new Graphics();
  #ready = false;

  attach(parent: Container): void {
    parent.addChild(this.#g);
  }

  get loaded(): boolean {
    return this.#ready;
  }

  load(): void {
    this.#ready = true;
  }

  draw(
    event: EventView | null,
    players: readonly { id: number; x: number; y: number; hp: number }[],
    view: Rectangle,
    nowMs: number,
  ): void {
    const g = this.#g;
    g.clear();
    const trou = darknessHole(event, players);
    if (trou === null || event === null) {
      return;
    }
    const a = darknessAlpha(event.startedAtMs, nowMs);
    if (a <= 0) {
      return;
    }
    g.rect(view.x - MARGE, view.y - MARGE, view.width + 2 * MARGE, view.height + 2 * MARGE).fill({
      color: NOIR_COLOR,
      alpha: a,
    });
    if (trou.radius <= 0) {
      return;
    }
    const { x, y, radius: r } = trou;
    g.circle(x, y, r + NOIR_FEATHER_PX).cut();
    // Quatre anneaux, de plus en plus sombres vers le DEHORS : un bord doux
    // (ecart au §9.4 de la spec, dont la boucle assombrissait le dedans).
    for (let k = 0; k < 4; k++) {
      g.circle(x, y, r + ((k + 1) * NOIR_FEATHER_PX) / 4).fill({
        color: NOIR_COLOR,
        alpha: (a * (k + 1)) / 5,
      });
      g.circle(x, y, r + (k * NOIR_FEATHER_PX) / 4).cut();
    }
  }
}
```

`front/src/render/stage.ts` : `import { DarknessRenderer } from './darkness-renderer';` ; après
`#bossBar` (l.104) `readonly #darkness = new DarknessRenderer();` ; dans `#layers` (l.162-165) :

```ts
    this.#bossBar,
    // Etape 16 : le noir. APRES la barre du boss (la menace disparait sous
    // lui), AVANT les pings et les chiffres ; les joueurs et les arbres
    // (`#depth`) et les fleches de bord (ecran) restent au-dessus.
    this.#darkness,
    // Les pings : ...
```

dans `#procedural` (l.193-194) : `this.#bossBar, this.#darkness, this.#pings,` ; et après
`drawBossBar` (l.493-495) :

```ts
  /** Le noir (etape 16) : le porteur de lanterne DESSINE, l'horloge murale pour le fondu. */
  drawDarkness(
    event: EventView | null,
    players: readonly { id: number; x: number; y: number; hp: number }[],
    nowMs: number,
  ): void {
    this.#darkness.draw(event, players, this.viewRect(), nowMs);
  }
```

`front/src/render/frame.ts` : `FrameStage` gagne, après `drawBossBar` (l.204) :

```ts
  /** Le noir (etape 16) : l'evenement, les joueurs DESSINES, l'horloge murale du fondu. */
  drawDarkness(
    event: EventView | null,
    players: readonly { id: number; x: number; y: number; hp: number }[],
    nowMs: number,
  ): void;
```

et après `stage.drawBossBar(client.horde, client.boss);` (l.327) :
`stage.drawDarkness(client.event ?? null, state.players, now);`.

`front/src/ui/minimap.ts`, après `toMinimap` (l.53-56) :

```ts
const AUCUN_ENNEMI: MinimapView['enemies'] = {
  count: 0,
  x: new Float32Array(0),
  y: new Float32Array(0),
};

/**
 * Pendant le noir (etape 16), la mini-carte trahirait la horde que le voile
 * cache : aucun ennemi. Sinon, la horde telle quelle.
 */
export function minimapEnemies(
  event: { kind: number } | null,
  horde: MinimapView['enemies'],
): MinimapView['enemies'] {
  return event?.kind === EVENT_KIND.NOIR ? AUCUN_ENNEMI : horde;
}
```

(import `EVENT_KIND` de `@shared/evenements` en tête). `front/src/main.ts` : l'import l.43 devient
`import { Minimap, minimapEnemies } from './ui/minimap';` et la ligne `enemies: client.horde,`
(l.714) devient `enemies: minimapEnemies(client.event, client.horde),`.

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd front && npx vitest run src/render/darkness-renderer.test.ts src/render/stage.test.ts src/render/frame.test.ts src/ui/minimap.test.ts src/main.test.ts`
Attendu : PASS. Si `g.context.instructions` ne range pas les trous comme des `fill` (ce que le
test suppose), relire la forme réelle avec un `console.log` puis ajuster **le test seul**, en
gardant le compte de 5 remplissages et l'absence de filtre et de masque.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/render/darkness-renderer.ts front/src/render/darkness-renderer.test.ts front/src/render/stage.ts front/src/render/stage.test.ts front/src/render/frame.ts front/src/render/frame.test.ts front/src/ui/minimap.ts front/src/ui/minimap.test.ts front/src/main.ts
git add front/src/render/darkness-renderer.ts front/src/render/darkness-renderer.test.ts front/src/render/stage.ts front/src/render/stage.test.ts front/src/render/frame.ts front/src/render/frame.test.ts front/src/ui/minimap.ts front/src/ui/minimap.test.ts front/src/main.ts
git commit -m "feat(front): la nuit tombe, un voile troue autour de la lanterne"
```

---

### Tâche 11 : le suivre hors champ — les flèches or vers `event.targets`

**Fichiers :**
- Modifier : `front/src/render/ping-renderer.ts` (import l.1 ; branche d'événement l.185-200)
- Tester : `front/src/render/ping-renderer.test.ts` (import ; `describe` « etape 14 : les fleches
  d un evenement » l.120-176 réécrit sur `targets` ; nouveau `describe` en fin)

**Interfaces :**
- Consomme : `EventView.targets`, `eventTargets` (tâche 7).
- Produit : `PingRenderer.draw` dessine une flèche or `COIN_TINT` par cible **hors champ** de
  `event.targets`, aucune dans le champ — sans plus rien savoir des genres.

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/render/ping-renderer.test.ts` : ajouter `import { Horde } from '@shared/horde';`,
`PROIE_ARCHETYPE` (de `@shared/archetypes`), `FORMATION` (de `@shared/waves`) et `eventTargets`
(à l'import de `../net/client`). Dans le `describe` de l'étape 14 (l.120-176), `base` devient

```ts
  const base = {
    progress: 0,
    secondsLeft: 60,
    cart: null,
    cartHp: 1,
    solo: false,
    carrierId: 0,
    relic: null,
    startedAtMs: 0,
  };
  /** La vue complete : ses cibles, calculees comme le client les calcule. */
  const vue = (v: Omit<EventView, 'targets'>, horde = new Horde(4)): EventView => ({
    ...v,
    targets: eventTargets(v, horde, [], 1),
  });
```

et chaque appel `flechesOr({ ...base, ... })` de ce `describe` devient `flechesOr(vue({ ...base,
... }))` (les attendus 2, 1, 0 / 1, 0 ne changent pas). Puis en fin de fichier :

```ts
describe('etape 16 : les fleches des quatre evenements', () => {
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
  const base = {
    progress: 0,
    secondsLeft: 60,
    cart: null,
    cartHp: 1,
    solo: false,
    carrierId: 0,
    relic: null,
    startedAtMs: 0,
  };
  const loin = { x: 5000, y: 300 };
  const ici = { x: 400, y: 300 };

  it('le calque ne lit QUE targets : une fleche par cible hors champ, aucune dans le champ', () => {
    const v: EventView = {
      ...base,
      kind: EVENT_KIND.NOIR,
      points: [],
      targets: [loin, ici, { x: -800, y: 300 }],
    };
    expect(flechesOr(v)).toBe(2);
  });

  it('relique portee : la fleche va a l autel hors champ, pas a la relique dans le champ', () => {
    const v = { ...base, kind: EVENT_KIND.RELIQUE, points: [ici, loin], carrierId: 2 };
    expect(flechesOr({ ...v, targets: eventTargets(v, new Horde(4), [], 1) })).toBe(1);
    const auSol = { ...v, carrierId: 0, relic: ici };
    expect(flechesOr({ ...auSol, targets: eventTargets(auSol, new Horde(4), [], 1) })).toBe(0);
  });

  it('chasse : une fleche par proie hors champ', () => {
    const h = new Horde(8);
    h.spawn({
      waveId: 3,
      spawnTick: 0,
      seed: 3,
      archetype: PROIE_ARCHETYPE,
      formation: FORMATION.POINT,
      anchorX: 5000,
      anchorY: 5000,
      count: 2,
    });
    const v = { ...base, kind: EVENT_KIND.CHASSE, points: [] };
    expect(flechesOr({ ...v, targets: eventTargets(v, h, [], 1) })).toBe(2);
  });

  it('noir : vers le porteur de lanterne hors champ ; aucune si c est soi', () => {
    const joueurs = [
      { id: 1, x: 400, y: 300 },
      { id: 2, x: 5000, y: 300 },
    ];
    const v = { ...base, kind: EVENT_KIND.NOIR, points: [], carrierId: 2 };
    expect(flechesOr({ ...v, targets: eventTargets(v, new Horde(4), joueurs, 1) })).toBe(1);
    expect(flechesOr({ ...v, targets: eventTargets(v, new Horde(4), joueurs, 2) })).toBe(0);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/render/ping-renderer.test.ts`
Attendu : ÉCHEC — « le calque ne lit QUE targets » compte 0 (le calque lit encore `points` :
vide pour le noir) ; la chasse compte 0.

- [ ] **Étape 3 : implémenter**

`front/src/render/ping-renderer.ts`, la branche d'événement (l.185-200) devient :

```ts
    // Etape 14 et 16 : chaque cible d'evenement hors champ — sceau, forge,
    // chariot, totem, relique ou autel, proie, porteur de lanterne
    // (`eventTargets`, calculees par le client) —, une fleche or au bord, sur
    // le modele exact du porteur. Dans le champ, rien : le sol suffit.
    if (event) {
      for (const c of event.targets) {
        const sp = toScreen(c.x, c.y);
        const a = edgeArrow(w, h, sp.x, sp.y, MARGIN);
        if (a) {
          drawArrow(s, a, 1.2, COIN_TINT, 1);
        }
      }
    }
```

et l'import `EVENT_KIND` (l.1) disparaît s'il ne sert plus (Biome le dit).

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd front && npx vitest run src/render/ping-renderer.test.ts src/render/frame.test.ts`
Attendu : PASS.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/render/ping-renderer.ts front/src/render/ping-renderer.test.ts
git add front/src/render/ping-renderer.ts front/src/render/ping-renderer.test.ts
git commit -m "feat(front): les fleches de bord suivent les cibles de chaque evenement"
```

---

### Tâche 12 : le livrable — quatre événements sur vraies sockets, avec contre-épreuves

**Fichiers :**
- Modifier : `back/src/evenement.integration.test.ts` (imports l.1-19 ; `Client` l.43-53 et
  `connect` l.87-114 : un flux complet ; nouveau `describe` en fin)

**Interfaces :**
- Consomme : tout ce qui précède — `Room#eventCarrier`, `Room#lastFireTickOf`,
  `Room#debugStartEvent`, `CarrierClock`, `PROIE_ARCHETYPE`.
- Produit : la preuve du §1 de la spec. Rien de nouveau dans le code de production.

⚠️ **« Le `GameClient` du porteur ne tire aucune salve pour lui »** : le back n'importe pas le
front. Le livrable rejoue les messages **décodés de la vraie socket** dans `CarrierClock` — la
classe que le `GameClient` possède (écart n° 7), pas une copie — et vérifie que les deux clients
datent les mêmes changements, à `D + 1` (à 4 ticks près sous rattrapage, écart n° 15). Que le
`GameClient` se taise à la date de `CarrierClock` et reprenne au tick du serveur est prouvé par la
tâche 7 sur les mêmes encodeurs.

- [ ] **Étape 1 : écrire les tests (ils doivent passer d'emblée : tout est câblé)**

Imports : l.2 devient
`import { CarrierClock, EVENT_KIND, EVENT_OUTCOME, EVENT_STATE_PERIOD_TICKS, NOIR_LIGHT_RADIUS, RELIQUE_CARRIER_SPEED } from '@shared/evenements';` ;
ajouter `import { PROIE_ARCHETYPE } from '@shared/archetypes';`,
`import { MAP_SIZE } from '@shared/constants';`, `import { BASE_WEAPON_ID } from '@shared/weapons';`
et, à l'import de `@shared/protocol`, `type SnapshotMessage`, `type WaveOrderMessage`.

`Client` (l.43-53) gagne :

```ts
  /** TOUT ce qui est arrive, snapshots compris, dans l'ordre d'arrivee (la datation en depend). */
  flux: Message[];
```

`connect` : `flux: [],` dans l'objet `client`, et en tête du gestionnaire `message` (l.96), juste
après `const msg = decode(data);` : `client.flux.push(msg);`.

En fin de fichier :

```ts
describe('etape 16 : quatre evenements de plus, sur vraies sockets (le livrable)', () => {
  const CENTRE = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
  const snapshots = (c: Client): SnapshotMessage[] =>
    c.flux.filter((m): m is SnapshotMessage => m.type === MSG.SNAPSHOT);

  /** Rejoue le flux d'un client dans `CarrierClock` : les dates `from` de chaque changement. */
  function datesDuClient(c: Client): number[] {
    let horloge: CarrierClock | null = null;
    const dates: number[] = [];
    for (const m of c.flux) {
      if (m.type === MSG.EVENT_START) {
        horloge = m.kind === EVENT_KIND.RELIQUE ? new CarrierClock() : null;
      } else if (m.type === MSG.EVENT_STATE) {
        horloge?.heard(m.cartHp);
      } else if (m.type === MSG.EVENT_END) {
        horloge = null;
      } else if (m.type === MSG.SNAPSHOT && horloge) {
        const d = horloge.dated(m.tick);
        if (d) {
          dates.push(d.from);
        }
      }
    }
    return dates;
  }

  it('la relique : meme porteur, date D + 1 chez les deux, 60 % au serveur, aucune salve, livraison → etalage epique', async () => {
    const { room, a, b } = await salonADeux();
    const changes: number[] = [];
    const tirsDuPorteur = new Set<number>();
    let porteur = 0;
    let ramasser = true;
    envelopper(room, () => {
      viderSauf(room, new Set());
      if (room.eventPoints === null) {
        return;
      }
      const c = room.eventCarrier;
      if (c !== porteur) {
        changes.push(room.tick);
        porteur = c;
      }
      if (c === a.playerId) {
        ramasser = false;
        tirsDuPorteur.add(room.lastFireTickOf(a.playerId, BASE_WEAPON_ID));
      }
      const r = room.eventPoints[0];
      if (ramasser && r) {
        room.debugPlace(a.playerId, r.x, r.y);
      }
    });
    // A vise a droite, par la socket : il tire tant qu'il ne porte pas.
    a.seq++;
    a.ws.send(encodeInput(a.seq, 0, 0, 127, 0));
    await dormir(300);
    room.debugStartEvent(graine(EVENT_KIND.RELIQUE));

    // ---- 1. Le ramassage, et le meme octet de porteur chez les deux --------
    await waitFor(() => (room.eventCarrier === a.playerId ? true : null), 'ramassage', 5_000);
    await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => (etats(c).some((e) => e.cartHp === a.playerId) ? true : null),
          `octet de porteur (joueur ${c.playerId})`,
          3_000,
        ),
      ),
    );

    // ---- 2. 60 % au serveur : A porte, B non, meme entree, au centre degage --
    room.debugPlace(a.playerId, CENTRE.x - 120, CENTRE.y);
    room.debugPlace(b.playerId, CENTRE.x - 120, CENTRE.y + 100);
    a.seq++;
    a.ws.send(encodeInput(a.seq, 127, 0, 127, 0));
    b.seq++;
    b.ws.send(encodeInput(b.seq, 127, 0, 0, 0));
    await dormir(200);
    const n0 = snapshots(a).length;
    await dormir(400);
    const fenetre = snapshots(a).slice(n0);
    const premier = fenetre[0];
    const dernier = fenetre.at(-1);
    if (!premier || !dernier) {
      throw new Error('des snapshots pendant la marche');
    }
    const dx = (id: number): number =>
      (dernier.players.find((p) => p.id === id)?.x ?? 0) -
      (premier.players.find((p) => p.id === id)?.x ?? 0);
    expect(dx(b.playerId)).toBeGreaterThan(50);
    expect(dx(a.playerId) / dx(b.playerId)).toBeCloseTo(RELIQUE_CARRIER_SPEED, 1);

    // ---- 3. Aucune salve pour le porteur, au serveur : un seul tick de tir --
    expect(tirsDuPorteur.size).toBe(1);

    // ---- 4. La livraison ---------------------------------------------------
    const autel = room.eventPoints?.[1];
    if (!autel) {
      throw new Error('un autel');
    }
    room.debugPlace(a.playerId, autel.x, autel.y);
    const fins = await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.EVENT_END) ?? null,
          `EVENT_END (joueur ${c.playerId})`,
          5_000,
        ),
      ),
    );
    for (const f of fins) {
      expect(f).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.REUSSI });
    }
    const opens = await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.DRAFT_OPEN) ?? null,
          `DRAFT_OPEN (joueur ${c.playerId})`,
          5_000,
        ),
      ),
    );
    for (const c of [a, b]) {
      const types = c.received.map((m) => m.type);
      expect(types.indexOf(MSG.LEVEL_UP)).toBeGreaterThan(types.indexOf(MSG.EVENT_END));
      expect(types.indexOf(MSG.DRAFT_OPEN)).toBeGreaterThan(types.indexOf(MSG.LEVEL_UP));
      expect(drapeauxDEvenement(c.received)).toEqual([true]);
    }
    for (const open of opens) {
      if (open.type !== MSG.DRAFT_OPEN) {
        throw new Error('DRAFT_OPEN attendu');
      }
      for (const carte of open.cards) {
        expect(carte.rarity).toBeGreaterThanOrEqual(EVENT_RARITY_FLOOR);
      }
    }

    // ---- 5. Le meme depart (13 o), les memes dates, D + 1 a 4 ticks pres ----
    const departs = [a, b].map((c) => c.received.find((m) => m.type === MSG.EVENT_START));
    expect(departs[0]).toEqual(departs[1]);
    expect(departs[0]).toMatchObject({ kind: EVENT_KIND.RELIQUE, solo: false });
    expect([...(a.eventBytes.get(MSG.EVENT_START) ?? [])]).toEqual([13]);
    const datesA = datesDuClient(a);
    expect(datesDuClient(b)).toEqual(datesA);
    expect(datesA).toHaveLength(changes.length);
    datesA.forEach((from, i) => {
      const d = changes[i] ?? 0;
      expect(from - (d + 1)).toBeGreaterThanOrEqual(0);
      expect(from - (d + 1)).toBeLessThanOrEqual(4);
    });
    // L'ORDRE d'envoi qui fait la date (spec §12) : l'etat du ramassage arrive avant tout
    // SNAPSHOT date D ou plus. Inverse (`SNAPSHOT` avant `EVENT_*`), la date glisserait d'un
    // envoi en restant dans la tolerance ci-dessus : c'est cette ligne qui le verrait.
    for (const c of [a, b]) {
      const iEtat = c.flux.findIndex(
        (m) => m.type === MSG.EVENT_STATE && m.cartHp === a.playerId,
      );
      expect(iEtat).toBeGreaterThan(0);
      const avant = c.flux
        .slice(0, iEtat)
        .filter((m): m is SnapshotMessage => m.type === MSG.SNAPSHOT);
      expect(avant.at(-1)?.tick ?? -1).toBeLessThan(changes[0] ?? 0);
    }

    // ---- 6. Rien de plus par tick ------------------------------------------
    expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
    expect([...b.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
  }, 30_000);

  it('le noir : PV hors lumiere qui baissent dans les SNAPSHOT, lanterne tombee → detruit, aucun etalage', async () => {
    const { room, a, b } = await salonADeux();
    room.debugStartEvent(graine(EVENT_KIND.NOIR));
    const lanterne = room.eventCarrier;
    expect([a.playerId, b.playerId]).toContain(lanterne);
    const autre = lanterne === a.playerId ? b.playerId : a.playerId;
    envelopper(room, () => {
      viderSauf(room, new Set());
      if (room.eventPoints !== null) {
        room.debugPlace(lanterne, CENTRE.x, CENTRE.y);
        room.debugPlace(autre, CENTRE.x + NOIR_LIGHT_RADIUS + 100, CENTRE.y);
      }
    });
    await dormir(1_500);
    // Le meme depart, 5 octets (n = 0), et l'octet d'etat dit la lanterne chez les deux.
    const departs = [a, b].map((c) => c.received.find((m) => m.type === MSG.EVENT_START));
    expect(departs[0]).toEqual(departs[1]);
    expect(departs[0]).toMatchObject({ kind: EVENT_KIND.NOIR, points: [] });
    for (const c of [a, b]) {
      expect([...(c.eventBytes.get(MSG.EVENT_START) ?? [])]).toEqual([5]);
      expect(etats(c).length).toBeGreaterThan(0);
      for (const e of etats(c)) {
        expect(e.cartHp).toBe(lanterne);
      }
    }
    const pv = snapshots(a).map((s) => s.players.find((p) => p.id === autre)?.hp ?? 0);
    expect(pv).toEqual([...pv].sort((x, y) => y - x));
    expect((pv[0] ?? 0) - (pv.at(-1) ?? 0)).toBeGreaterThanOrEqual(2);
    const pvLanterne = snapshots(a).map((s) => s.players.find((p) => p.id === lanterne)?.hp);
    expect(new Set(pvLanterne).size).toBe(1);

    room.debugKill(lanterne);
    const fins = await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.EVENT_END) ?? null,
          `EVENT_END (joueur ${c.playerId})`,
          3_000,
        ),
      ),
    );
    for (const f of fins) {
      expect(f).toEqual({ type: MSG.EVENT_END, outcome: EVENT_OUTCOME.DETRUIT });
    }
    await dormir(1_000);
    for (const c of [a, b]) {
      expect(c.received.some((m) => m.type === MSG.DRAFT_OPEN)).toBe(false);
    }
    expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
  }, 30_000);

  it('la chasse : trois WAVE_ORDER de proies avant le meme EVENT_START (17 o), toutes tombees → etalage', async () => {
    const { room, a, b } = await salonADeux();
    room.debugStartEvent(graine(EVENT_KIND.CHASSE));
    const proies = new Set<number>();
    for (let i = 0; i < room.horde.count; i++) {
      if (room.horde.archetype[i] === PROIE_ARCHETYPE) {
        proies.add(room.horde.entityIdAt(i));
      }
    }
    expect(proies.size).toBe(3);
    envelopper(room, () => viderSauf(room, proies));
    await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.EVENT_START) ?? null,
          `EVENT_START (joueur ${c.playerId})`,
          3_000,
        ),
      ),
    );
    const ordresDe = (c: Client): WaveOrderMessage[] =>
      c.received.filter(
        (m): m is WaveOrderMessage =>
          m.type === MSG.WAVE_ORDER && m.archetype === PROIE_ARCHETYPE,
      );
    expect(ordresDe(a)).toHaveLength(3);
    expect(ordresDe(a)).toEqual(ordresDe(b));
    for (const c of [a, b]) {
      const types = c.received.map((m) => m.type);
      const iDepart = types.indexOf(MSG.EVENT_START);
      expect(c.received.lastIndexOf(ordresDe(c).at(-1) as Message)).toBeLessThan(iDepart);
      expect([...(c.eventBytes.get(MSG.EVENT_START) ?? [])]).toEqual([17]);
    }
    await dormir(500);
    room.horde.kill([...proies]);
    await Promise.all(
      [a, b].map((c) =>
        waitFor(
          () => c.received.find((m) => m.type === MSG.DRAFT_OPEN) ?? null,
          `DRAFT_OPEN (joueur ${c.playerId})`,
          5_000,
        ),
      ),
    );
    for (const c of [a, b]) {
      expect(c.received.find((m) => m.type === MSG.EVENT_END)).toEqual({
        type: MSG.EVENT_END,
        outcome: EVENT_OUTCOME.REUSSI,
      });
      expect(drapeauxDEvenement(c.received)).toEqual([true]);
    }
    expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
  }, 30_000);

  it('le siege : sans defenseur la progression reste nulle, cinq ennemis l abattent — aucun etalage', async () => {
    const { room, a, b } = await salonADeux();
    room.debugStartEvent(graine(EVENT_KIND.SIEGE));
    const totem = room.eventPoints?.[0];
    if (!totem) {
      throw new Error('un totem');
    }
    room.horde.spawn({
      waveId: 61_016,
      spawnTick: room.tick,
      seed: 1,
      archetype: 0,
      formation: FORMATION.SCATTER,
      anchorX: totem.x,
      anchorY: totem.y,
      count: 5,
    });
    const frappeurs = new Set(Array.from({ length: 5 }, (_, k) => entityIdOf(61_016, k)));
    envelopper(room, () => {
      viderSauf(room, frappeurs);
      for (let i = 0; i < room.horde.count; i++) {
        room.horde.x[i] = totem.x;
        room.horde.y[i] = totem.y;
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
    const departs = [a, b].map((c) => c.received.find((m) => m.type === MSG.EVENT_START));
    expect(departs[0]).toEqual(departs[1]);
    expect(departs[0]).toMatchObject({ kind: EVENT_KIND.SIEGE, points: [totem] });
    expect([...(a.eventBytes.get(MSG.EVENT_START) ?? [])]).toEqual([9]);
    const pv = etats(a).map((e) => e.cartHp);
    expect(pv[0]).toBe(255);
    expect(pv).toEqual([...pv].sort((x, y) => y - x));
    for (const e of etats(a)) {
      expect(e.progress).toBe(0);
    }
    await dormir(1_000);
    expect(a.received.some((m) => m.type === MSG.DRAFT_OPEN)).toBe(false);
    expect([...a.snapshotBytes]).toEqual([SNAPSHOT_A_DEUX]);
  }, 30_000);
});
```

- [ ] **Étape 2 : les lancer, ils passent**

Run : `cd back && npx vitest run src/evenement.integration.test.ts`
Attendu : PASS, les trois tests de l'étape 14 compris. Un échec isolé de compte (`createAccount`,
`WELCOME` absent) : **relancer une fois** (base partagée), puis seulement conclure.

- [ ] **Étape 3 : les contre-épreuves (chacune faite, constatée rouge, puis défaite à la main —
  jamais par `git checkout` ni `git stash`)**

1. Dans `Room#fireWeapons`, commenter le garde `holdsFire` → « la relique » rougit sur
   `tirsDuPorteur.size` (le porteur tire).
2. Dans `Room.step` l.1386, retirer `* (this.#event?.speedFactorOf(p.id) ?? 1)` → la relique
   rougit sur le rapport 0,6.
3. Dans `#stepEvent`, commenter la boucle de la nuit → « le noir » rougit sur la baisse de PV.
4. Dans `#startEvent`, ne pas pousser les proies (`proies.length === 0` forcé) → « la chasse »
   rougit (aucun `EVENT_START`).
5. Dans `#stepEvent`, ne plus pousser l'état hors cadence (`change ||` retiré) → « la relique »
   rougit sur l'ordre d'arrivée ou sur la date (l'octet n'arrive qu'à la cadence suivante).

Noter dans le rapport de tâche les cinq messages d'échec obtenus (si la cinquième ne rougit pas —
une cadence tombée au tick du ramassage —, le dire). `git diff` doit être vide après la dernière
(hors le fichier de test).

- [ ] **Étape 4 : commit**

```bash
npx biome check --write back/src/evenement.integration.test.ts
git add back/src/evenement.integration.test.ts
git commit -m "test(back): le livrable de l etape 16, quatre evenements sur vraies sockets"
```

---

### Tâche 13 : le portique et le bilan (contrôleur, seul)

**Fichiers :**
- Créer : `docs/plans/2026-11-05-etape-16-resultats.md`
- Modifier : `README.md` (trois lignes après celle de l'étape 11, l.34 ; une après celle de
  l'étape 14, l.35)

**Interfaces :**
- Consomme : les tâches 1 à 12, commitées.
- Produit : le portique vert, le bilan ouvert, le README à jour.

- [ ] **Étape 1 : le portique complet, rien d'autre en vol**

Run : `npm run lint && npm run typecheck && npm test`
Attendu : tout vert. Noter le nombre de tests front et back **de cette exécution seule**. Un échec
isolé de compte ou d'or à 0 dans un test d'intégration se relance **une fois** (base partagée).

Puis les bancs, seul aussi : `npm run bench` — noter `bench:sim` et `bench:net`. Les bancs ne
démarrent pas d'événement : ils mesurent que rien n'a régressé hors événement (la ligne de
`#fireWeapons`, celle de la vitesse et la proie dans `retarget` sont sur le chemin chaud).

Puis la dérive répliquée, seule : `cd back && npx vitest run ../shared/horde.replication.test.ts`
— noter les lignes `etape 16, scenario PR1/PR2` (PR2 doit dire **0,000 px**).

- [ ] **Étape 2 : mettre le graphe à jour**

Run : `graphify update .`

- [ ] **Étape 3 : écrire le bilan**

`docs/plans/2026-11-05-etape-16-resultats.md`, sur le modèle de
`2026-10-16-etape-14-resultats.md` (titre « Étape 16 — les événements bonus, deuxième fournée :
résultats », liens Spec et Plan, « ⚠️ Ce document est ouvert. Le §5 attend la run de l'auteur. ») :

1. **Le livrable** — les quatre tests de `back/src/evenement.integration.test.ts` et leurs
   contre-épreuves (les messages d'échec notés à la tâche 12).
2. **Ce qui est livré** — un tableau pièce / où : sept genres et le bit solo (`shared/evenements.ts`,
   `shared/protocol.ts`) ; la proie (`shared/archetypes.ts`, `shared/horde.ts`, dérive PR2) ; le
   placement sur vraies cartes et les règles (`back/src/evenement.ts`) ; le salon
   (`back/src/room.ts`) ; la règle partagée du porteur (`fireCooldown`, `lastFireAfterCarry`,
   `CarrierClock`) ; le miroir client ; le HUD et les bandeaux ; le sol ; l'obscurité ; les
   flèches.
3. **Le coût sur le fil** — **aucun message nouveau, aucun octet de plus** : `EVENT_START` 5 o
   (noir), 9 o (siège), 13 o (relique, chasse solo), 17 o (chasse) ; `EVENT_STATE` 7 o × 5 Hz,
   + 7 o par changement de porteur de relique ; `SNAPSHOT` inchangé (44 o à deux) ; les proies :
   2 ou 3 `WAVE_ORDER` ordinaires par chasse.
4. **Écarts au plan et à la spec** — les écarts assumés de ce plan (en une ligne chacun), plus ce
   que l'exécution aura changé.
5. **Le portique** — le tableau typecheck / tests front / tests back / lint, les bancs, la dérive.
6. **Vérification manuelle — ouverte**, les points du §11 de la spec :
   - les quatre événements se lisent-ils d'un coup d'œil (totem, relique, anneau rouge, nuit) ?
   - le siège : 45 s cumulées dans 60, avec ~5 s de marche — tenable ? 600 PV, trop ou pas assez ?
     La présence exigée à 150 px rend-elle bien le « siège » ?
   - la relique : 1 500 px à 156 px/s, ~10 s de marche ; le porteur muet est-il protégé ou
     abandonné ? Le Relais d'un porteur (téléportation avec la relique) : astuce ou triche ?
   - la chasse : des proies à 195 px/s, 160 PV au niveau 1 (≈ 377 au niveau 10), trois en 60 s —
     rythme juste ? Les proies survivantes qui restent dans la horde gênent-elles ?
   - le noir : 0,9 d'obscurité, lisible sans être frustrant ? Les arbres visibles se
     remarquent-ils ? 2 PV/s pousse-t-il à rester groupé ? Les chiffres de dégâts au-dessus du noir
     trahissent-ils trop la horde ? Le bord doux (quatre anneaux `cut()`) rend-il bien sur la
     machine de Léo — sinon le repli `NOIR_FEATHER_PX = 0` ?
   - sept genres équiprobables : un genre revient-il trop souvent pour son intérêt ?

   Plus les risques du §12 de la spec à surveiller : la datation qui repose sur l'ordre d'envoi,
   une salve de trop au ramassage tardif (cosmétique), les proies d'une chasse ratée qui restent.

- [ ] **Étape 4 : le README**

Après la ligne de l'étape 11 (`README.md` l.34), ajouter (écart n° 14 — on ne lie que ce qui
existe) :

```markdown
| 12 | Trajectoires | 📝 — [spec](docs/specs/2026-10-15-etape-12-trajectoires.md) |
| 13 | Quatre paliers, et des légendaires qui coûtent | 📝 — [spec](docs/specs/2026-10-16-etape-13-paliers-et-pactes.md) · [plan](docs/plans/2026-10-16-etape-13-paliers-et-pactes.md) |
```

Après la ligne de l'étape 14 (l.35, devenue l.37) :

```markdown
| 15 | La progression : les chiffres qui montent | 📝 — [plan et bilan](docs/plans/2026-10-19-etape-15-progression.md) |
| 16 | Événements bonus, deuxième fournée : siège, relique, chasse, noir — **zéro octet de plus** | 📝 — [spec](docs/specs/2026-11-05-etape-16-evenements-2.md) · [plan](docs/plans/2026-11-05-etape-16-evenements-2.md) · [résultats](docs/plans/2026-11-05-etape-16-resultats.md) |
```

Vérifier avant d'écrire que ces fichiers existent toujours (`ls docs/specs docs/plans`) : un
fichier apparu depuis (un bilan des étapes 12, 13 ou 15) se lie aussi.

- [ ] **Étape 5 : commit**

```bash
git add docs/plans/2026-11-05-etape-16-resultats.md README.md
git commit -m "docs: le bilan de l etape 16 (verification manuelle ouverte)"
```

---
