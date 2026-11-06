# Étape 18 — la reconnexion avec état complet : plan d'implémentation

> **Pour les agents :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou
> superpowers:executing-plans, tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**But :** une socket qui tombe en run laisse un slot réservé `RECONNECT_GRACE_MS` ; le joueur qui
revient sur son compte reprend sa place avec tout son état, reçu une fois dans un `RESYNC` ; l'or
de l'extraction lui revient s'il était encore de la run.

**Architecture :** `Session` (`back/src/server.ts`) tient les grâces (`#graces`, un minuteur par
compte) et envoie `RESYNC` **dans `#broadcast`, après les drains et avant le `SNAPSHOT`** ; `Room`
marque un joueur absent (comme un mort, mais vulnérable) et rassemble l'instantané dans
`resyncState()` sans rien savoir du réseau ; `shared/protocol.ts` encode `RESYNC` (horde en f32
pour 0,000 px, `Horde.restoreState` côté client) et `PRESENCE` (3 o, sur changement) ; le front
**recharge la page** et rejoint seul grâce à un mot dans `sessionStorage`. **Zéro octet de plus par
tick.**

**Pile :** TypeScript, `ws`, Fastify, Pixi.js v8, Vitest (jsdom côté front), Biome, Prisma/Postgres
pour les tests sur vraies sockets.

**Spec :** [`docs/specs/2026-11-06-etape-18-reconnexion.md`](../specs/2026-11-06-etape-18-reconnexion.md)

**Où l'on travaille :** dans un worktree, sur la branche `etape-18-reconnexion`.

```bash
git worktree add ../Tarnok-reconnexion -b etape-18-reconnexion
cd ../Tarnok-reconnexion && npm ci && npm run db:generate -w back
cp ../Tarnok/back/.env back/.env && cp ../Tarnok/front/.env front/.env
```

Les chemins sont relatifs à la racine du worktree. Les ancres `l.N` sont celles du commit
`0b46ec3` (tête de `main` le 6 novembre).

## Contraintes globales

- Constantes, valeurs de la spec, **jamais un nombre en dur ailleurs** :
  - `shared/constants.ts` : `RECONNECT_GRACE_MS = 60_000`.
  - `shared/protocol.ts` : `MSG.RESYNC = 31`, `MSG.PRESENCE = 32`, `PRESENCE_BYTES = 3`,
    `RESYNC_HEADER_BYTES = 19`, `RESYNC_PLAYER_BYTES = 4`, `RESYNC_WEAPON_BYTES = 1 + UPGRADE_KINDS +
    4` (17), `RESYNC_PASSIVES_BYTES = PASSIVES.length * 2` (32), `RESYNC_HISTORY_TICKS =
    FIELD_INPUT_DELAY_TICKS + Math.round(TICK_HZ / FLOWFIELD_HZ)` (6), `RESYNC_ENTITY_BYTES = 24`,
    `RESYNC_ORB_BYTES = 8`, `RESYNC_ZONE_BYTES = ZONE_BYTES - 1` (10), `RESYNC_DECOY_BYTES = 9`,
    `RESYNC_CHARGE_BYTES = BOSS_CHARGE_BYTES - 1` (28), `RESYNC_EVENT_HEADER_BYTES = 12`,
    `RESYNC_DRAFT_HEADER_BYTES = 5`, `RESYNC_PORTAL_BYTES = 6`. Les bits de `flags` : `RESYNC_FLAG =
    { DRAFT_OPEN: 1, DRAFT_CHEST: 2, DRAFT_EVENT: 4, PORTAL_OPEN: 8, EVENT: 16, CHARGE: 32 }`.
  - `front/src/net/rejoin.ts` : `REJOIN_KEY = 'tarnok.rejoin'`, `REJOIN_RETRY_MS = 2_000`.
  - `front/src/render/player-renderer.ts` : `ABSENT_BASE = 0x8a8f99` (le gris du totem, étape 16).
- **Rien d'ajouté aux messages par tick.** `SNAPSHOT`, `WAVE_ORDER`, `ZONE`, `DEATHS`… ne bougent
  pas. `RESYNC` part une fois par entrée dans un salon lancé ; `PRESENCE` sur changement.
- **`Room` ne connaît pas le réseau** (règle Biome du README) : `resyncState()` rend un objet,
  `encodeResync` vit dans `shared/protocol.ts`.
- **La horde voyage en f32**, jamais quantifiée : c'est ce qui donne 0,000 px.
- **`WELCOME` ne change pas d'un octet.**
- Commentaires de code en français **sans accents** ; textes affichés avec accents ; messages de
  commit conventionnels en français sans accents, sujet en minuscules.
- **Discipline des sous-agents** : un sous-agent ne lance **que les fichiers de test de sa tâche**,
  **au premier plan** (`npx vitest run <fichier>`) — jamais `npm test`, jamais un banc, jamais une
  commande en arrière-plan. Le portique complet et les bancs sont au contrôleur, **seul**, à la
  dernière tâche.
- Commandes : tests de `shared/` depuis `back/` (`cd back && npx vitest run ../shared/<fichier>`),
  tests du back depuis `back/`, tests du front depuis `front/` (`cd front && npx vitest run src/…`).
- **Postgres local.** Les `*.integration.test.ts` et `server.test.ts` ouvrent de vraies sockets sur
  une base possiblement partagée (`deleteMany` en `beforeEach`) : un échec isolé de compte ou d'or
  se **relance une fois** avant d'en conclure quoi que ce soit.
- Avant chaque commit : `npx biome check --write <fichiers de la tâche>`.
- **Des commits NOUVEAUX seulement** : jamais `--amend`, `rebase`, `reset`, `stash`, ni `checkout`
  d'un autre commit.
- Jamais `pkill -f` : les serveurs de dev de Léo tournent sur 5173 et 3100.
- Aucun actif nouveau sur MinIO.

## Points de vigilance de la revue

1. **`RESYNC` depuis `onFirst`** au lieu de `#broadcast` : vagues en double, morts fantômes. →
   tâche 5, et le livrable (test 2) le verrait.
2. **`#assertFieldsNotRefreshed`** (`shared/horde.ts` l.1480-1495) : après les `update` du
   `RESYNC`, le premier ordre en retard lève. → `Horde.acknowledgeFields`, tâche 6.
3. **Les minuteurs de grâce et `stop()`** : un `setTimeout` de 60 s oublié fait attendre Vitest et
   fuit une `Room`. → tâche 5.
4. **La dernière entrée qui reste appliquée** à un absent : il marche jusqu'au mur. → `setAbsent`
   met les axes à zéro, tâche 3.
5. **L'historique des positions omis** : le livrable passe (la horde est copiée au tick près), mais
   le client diverge trois ticks plus tard. → le test « 300 ticks » de `client.test.ts`, tâche 6.
6. **`Loadout` reconstruit par un chemin privé** : passer par `addWeapon`/`addPassive`, sinon
   `#weaponOrder` et `#upgrades` divergent. → tâche 6.
7. **La grâce après `RUN_OVER`** : la `Session` traînerait une minute après le bilan. → `remove`
   teste `room.runOver`, tâche 5.

## Carte des fichiers

| Fichier | Rôle dans l'étape |
| --- | --- |
| `shared/constants.ts` | `RECONNECT_GRACE_MS` |
| `shared/protocol.ts`, `shared/protocol.test.ts` | `RESYNC`, `PRESENCE`, `ResyncState` |
| `shared/player-history.ts` | lecture `at(tick)` |
| `shared/horde.ts`, `shared/horde.test.ts` | `acknowledgeFields` |
| `back/src/draft.ts`, `back/src/portal.ts` (+ tests) | `rejoin` |
| `back/src/room.ts`, `back/src/room.test.ts` | `absent`, `setAbsent`, `runOver`, `#draftKind`, `resyncState` |
| `back/src/server.ts`, `back/src/server.test.ts` | grâces, `RESYNC` dans `#broadcast`, `PRESENCE`, crédit, `graceMs` |
| `back/src/{ping,boutique,or-survit,credit}.integration.test.ts` | `graceMs: 0` |
| `front/src/net/client.ts`, `front/src/net/client.test.ts` | réception `RESYNC`/`PRESENCE`, `absent`, `classes`, `roster`, `onResync` |
| `front/src/render/player-renderer.ts` (+ test), `front/src/render/frame.ts` | socle gris |
| `front/src/net/rejoin.ts` (+ test), `front/src/main.ts` | rechargement et reprise automatique |
| `back/src/reconnexion.integration.test.ts` | le livrable |
| `docs/plans/2026-11-06-etape-18-resultats.md`, `README.md` | le bilan |

---

### Tâche 1 : le fil — `RESYNC` et `PRESENCE` dans `shared/protocol.ts`

**Fichiers :**
- Modifier : `shared/constants.ts` (fin de fichier), `shared/protocol.ts` (`MSG` l.11-42 ;
  interfaces après `PortalResultMessage` l.481-491 ; `Message` l.340-371 ; constantes après
  `RUN_OVER_BYTES` l.725 ; encodeurs/décodeurs en fin de fichier ; `decode` l.1214-1283)
- Tester : `shared/protocol.test.ts` (nouveau `describe` en fin de fichier)

**Interfaces :**
- Produit : `RECONNECT_GRACE_MS` ; `MSG.RESYNC`, `MSG.PRESENCE` ; `ResyncState` (l'objet que
  `Room.resyncState()` rendra, **structurel** : `tick, level, kills, freezeUntilTick, chestsOwed,
  eventDraftsOwed, draft: { deadlineTick, cards, kind } | null, portal: { deadlineTick, multiplier
  } | null, event: { kind, solo, durationTicks, elapsed, progress, cartX, cartY, cartHp, points }
  | null, charge: BossCharge | null, players: { id, classId, absent, weapons: { weaponId,
  upgrades: number[], lastFireTick }[], passives: number[] }[], history: { count, ids, x, y }[],
  fieldTargets: { x, y }[], horde: HordeState (les tableaux lus jusqu'à `count`), orbs: { id, x,
  y }[], zones: { kind, x, y, bornTick, by }[], decoys: Decoy[]`) ; `ResyncMessage = { type } &
  ResyncState` ; `PresenceMessage { type, playerId, present }` ; `encodeResync(state)`,
  `decodeResync`, `encodePresence(playerId, present)`, `decodePresence` ; les constantes de taille
  des contraintes globales.
- ⚠️ `encodeResync` prend la horde par un **paramètre structurel** (`{ count, x, y, vx, vy,
  archetype, waveId, indexInWave, animPhase, targetField, stopped, fleeing, aimX, aimY }`) : le
  protocole n'importe pas `Horde`, comme il n'importe pas `WaveOrder` (l.1174-1183). `decodeResync`
  rend des tableaux typés **dimensionnés à `count`** ; c'est le client qui les recopie dans un
  `HordeState` de capacité `MAX_ENTITIES`.
- `lastFireTick` : `−Infinity` → `0` à l'encodage, `0` → `−Infinity` au décodage (le tick 0 n'est
  jamais un tick de tir : `step` commence par `tick++`).

- [ ] **Étape 1 : les tests qui échouent** — dans `shared/protocol.test.ts` :
  - `RESYNC` et `PRESENCE` ont leurs numéros (31, 32) et ne percutent aucun autre ;
  - aller-retour d'un `RESYNC` **plein** (4 joueurs avec armes, aspects et passifs ; 6
    enregistrements ; 4 cibles ; 3 entités à positions et vitesses **non représentables en i16**
    comme `1234.5678` ; 2 orbes ; 2 zones ; 1 leurre ; charge ; événement convoi ; étalage de 7
    cartes ; portail) : `decode(encodeResync(s))` égale `s` **à l'égalité stricte sur les f32**
    (`Math.fround` des valeurs d'entrée) ;
  - aller-retour d'un `RESYNC` **vide** (aucune section, horde vide, un joueur sans arme ni
    passif) : `byteLength` égale la somme des constantes (`RESYNC_HEADER_BYTES +
    RESYNC_PLAYER_BYTES + RESYNC_PASSIVES_BYTES + RESYNC_HISTORY_TICKS × 1 + 1 + 2 + 2 + 1 + 1`),
    **dérivée**, jamais un nombre nu ;
  - la taille d'un `RESYNC` à N entités vaut `base + N × RESYNC_ENTITY_BYTES` (dérivé) ;
  - `flags` : chaque bit allume exactement sa section (sept cas) ;
  - `lastFireTick` : `−Infinity` fait l'aller-retour ;
  - un `RESYNC` tronqué au milieu de la horde **lève** (`viewOf`), comme `decodeSnapshot` ;
  - `PRESENCE` : 3 o, `present` ∈ {0, 1} fait l'aller-retour en booléen.
- [ ] **Étape 2 : les lancer, ils échouent** — `cd back && npx vitest run ../shared/protocol.test.ts`
  (exports absents).
- [ ] **Étape 3 : implémenter** — l'en-tête, les sections dans l'ordre du §3.1 de la spec, chaque
  octet écrit **borné** avant `setUint8`/`setUint16` (comme `encodeEvent` l.1885-1917). Les f32 par
  `setFloat32(o, v, true)`. `decode` gagne deux `case`.
- [ ] **Étape 4 : relancer, ils passent.**
- [ ] **Étape 5 : commit** — `feat(shared): les messages RESYNC et PRESENCE, l etat complet hors tick`

---

### Tâche 2 : `Draft.rejoin` et `Portal.rejoin`

**Fichiers :**
- Modifier : `back/src/draft.ts` (après `forget` l.127-131), `back/src/portal.ts` (après `forget`
  l.96-99)
- Tester : `back/src/draft.test.ts`, `back/src/portal.test.ts`

- [ ] **Étape 1 : les tests** —
  - `draft.test.ts` : fenêtre ouverte à {1, 2}, `forget(2)`, `rejoin(2, true)` → `setToken(2, 0)`
    rend `true`, et la fenêtre **attend** 2 (elle ne se ferme pas quand 1 seul a posé) ;
    `rejoin(2, false)` (mort) → il peut poser mais ne tient pas la fenêtre ; `rejoin` sur une
    fenêtre fermée ne fait rien ; `rejoin` d'un id déjà présent ne le double pas dans `#pending`
    (sinon `step` compterait deux jetons attendus).
  - `portal.test.ts` : `forget(2)` puis `rejoin(2)` → `votes()` porte `2 → NO_VOTE`, `setVote(2,
    LEAVE)` accepté, la fenêtre attend 2 ; fermée : rien ; pas de doublon.
- [ ] **Étape 2 : échec.** `cd back && npx vitest run src/draft.test.ts src/portal.test.ts`
- [ ] **Étape 3 : implémenter** — quatre lignes chacune, miroir de `forget`.
- [ ] **Étape 4 : passent.**
- [ ] **Étape 5 : commit** — `feat(back): un joueur revenu reprend part a l etalage et au vote ouverts`

---

### Tâche 3 : `Room` — l'absent

**Fichiers :**
- Modifier : `back/src/room.ts` (`PlayerState` l.153-220 ; `join` l.1210-1253 ; `leave`
  l.1255-1263 ; `step` l.1470-1477, l.1844-1852, l.1899-1911 ; `#openDraft` l.2438 ; `#startEvent`
  l.2495 ; `#stepEvent` l.2541 ; `#checkRunOver` l.2930-2949 ; getters près de `tick` l.875)
- Tester : `back/src/room.test.ts` (nouveau `describe('etape 18 : l absent')`)

**Interfaces :**
- Produit : `PlayerState.absent: boolean` (faux au `join`) ; `Room.setAbsent(id, absent)` ;
  `Room.isAbsent(id)` ; `get runOver(): boolean` ; `#draftKind: 'level' | 'chest' | 'event'` posé
  dans `#openDraft`.
- `join` appelle `#draft.rejoin(id, true)` et `#portal.rejoin(id)` après avoir posé le joueur.

- [ ] **Étape 1 : les tests** — avec deux joueurs et une horde posée (`room.horde.spawn`), comme
  les tests voisins :
  - `setAbsent(2, true)` après un `applyInput(2, …, 127, 0, 127, 0)` : sur 10 `step`,
    `positionOf(2)` ne bouge pas et `lastFireTickOf(2, BASE_WEAPON_ID)` reste `−Infinity` ;
  - absent, 2 n'est pas dans `room.horde.aimX` après un `retarget` (avancer jusqu'à un tick
    multiple de 3 avec historique) ; présent, il y est ;
  - un orbe posé sous 2 absent n'est pas ramassé (`drainPickups` vide) ;
  - `debugOweLevels(1)`, 2 absent : la fenêtre se ferme dès que 1 a posé (2 n'est pas attendu) ;
  - `setAbsent(2, false)` pendant l'étalage : `setDraftToken(2, 0)` accepté ;
  - `#checkRunOver` : 1 mort, 2 absent vivant → `drainRunOver()` non nul ; 1 et 2 absents vivants →
    nul, et après 30 `step` toujours nul ;
  - 2 absent sous un monstre au contact : ses PV **baissent** (vulnérable) ;
  - `runOver` vaut faux puis vrai après la fin ; `isAbsent` suit `setAbsent`.
- [ ] **Étape 2 : échec.** `cd back && npx vitest run src/room.test.ts -t "etape 18"`
- [ ] **Étape 3 : implémenter** — un filtre `p.hp > 0 && !p.absent` aux quatre endroits de `step`,
  dans `#openDraft` (attendus), `#startEvent` (vivants), `#stepEvent` (les joueurs passés à
  `ev.step`) ; `#checkRunOver` : parcourir les présents ; aucun présent → `return`. `setAbsent(true)`
  : axes à zéro, `#draft.forget`, `#portal.forget`, `#event?.forget` ; `setAbsent(false)` :
  `#draft.rejoin(id, p.hp > 0)`, `#portal.rejoin(id)`.
- [ ] **Étape 4 : passent** ; puis `cd back && npx vitest run src/room.test.ts` entier (le reste du
  fichier ne doit pas bouger).
- [ ] **Étape 5 : commit** — `feat(back): un joueur absent, immobile et sans cible, qui garde sa place`

---

### Tâche 4 : `Room.resyncState()` — l'instantané, sans réseau

**Fichiers :**
- Modifier : `back/src/room.ts` (nouvelle méthode après `snapshot` l.1914-1957),
  `shared/player-history.ts` (lecture `at(tick): PlayerPositions | null` à côté de `delayed`
  l.74 ; `#at` existe déjà l.76, l'exposer)
- Tester : `back/src/room.test.ts`, `shared/player-history.test.ts`

**Interfaces :**
- Produit : `Room.resyncState(): ResyncState` ; `PlayerHistory.at(tick)`.
- Consomme : `ResyncState` (tâche 1), `Loadout.weaponIds/upgradesOf/stacksOf`, `Horde` (tableaux
  publics, `aimX/aimY`), `OrbField.id/x/y/count` (`back/src/combat.ts` l.138-157), `ZoneField`
  (`kind/x/y/bornTick/by/count`, `aliveAt`), `#decoys`, `#charge`, `#event` (`kind, points, solo,
  elapsed, wireState()`), `#draft` (`phase, spread, deadlineTick`), `#portal` (`phase,
  deadlineTick`), `#extractMultiplier`.

- [ ] **Étape 1 : les tests** —
  - `player-history.test.ts` : `at(t)` rend l'enregistrement exact ou `null`.
  - `room.test.ts` : un salon à deux, 60 `step` avec horde, un orbe, une zone (`debugStartEvent`
    ou une réaction), un leurre (Appât) ; `resyncState()` :
    - `horde` : mêmes `count`, `x/y/vx/vy` **identiques** (`toEqual` sur `subarray(0, count)`) à
      `room.horde` ;
    - `history` : `RESYNC_HISTORY_TICKS` entrées, la dernière égale à l'historique du tick courant
      (vivants présents, arrondis) ;
    - `fieldTargets` égale `horde.aimX/aimY` ;
    - `players[i].weapons` reconstruit par `addWeapon` donne un `Loadout` dont `weaponIds`,
      `upgradesOf`, `stacksOf` égalent l'original pour chaque arme et passif ;
    - étalage ouvert → `draft` non nul avec `kind` ; coffre dû → `'chest'` ; portail ouvert →
      `portal` ; charge → `charge` ; événement → `event.elapsed` égal à `EventRun.elapsed` ;
    - zones **vivantes** seulement (une zone expirée n'y est pas) ;
    - `absent` reflète `setAbsent`.
- [ ] **Étape 2 : échec.** `cd back && npx vitest run src/room.test.ts -t "resyncState" ../shared/player-history.test.ts`
- [ ] **Étape 3 : implémenter** — une méthode qui **lit**, n'écrit rien, n'alloue que l'objet rendu
  (elle part une fois par reconnexion, pas par tick). `#draftKind` vient de la tâche 3.
- [ ] **Étape 4 : passent.**
- [ ] **Étape 5 : commit** — `feat(back): l instantane de resynchronisation du salon`

---

### Tâche 5 : `Session` — la grâce, `RESYNC` dans la diffusion, `PRESENCE`, le crédit

**Fichiers :**
- Modifier : `back/src/server.ts` (champs l.73-100 ; `onFirst` l.174-258 ; `remove` l.277-289 ;
  `stop` l.313-320 ; `#creditAccounts` l.436-454 ; `#broadcast` l.486-598 ; `#freeId` l.601-608 ;
  `ServerOptions` l.649-661 ; `new Session(…)` l.703), `back/src/ping.integration.test.ts` (l.26),
  `back/src/boutique.integration.test.ts`, `back/src/or-survit.integration.test.ts`,
  `back/src/credit.integration.test.ts` (leur `buildServer`)
- Tester : `back/src/server.test.ts` (nouveau `describe('etape 18 : la grace')`, vraies sockets
  comme le reste du fichier)

**Interfaces :**
- Produit : `ServerOptions.graceMs?: number` (défaut `RECONNECT_GRACE_MS`) ; `Session` reçoit
  `graceMs` au constructeur.
- Comportement : §5.1 de la spec, point par point.

- [ ] **Étape 1 : les tests** (`server.test.ts`, `waitingRoom: true`, `graceMs: 400` sauf mention) :
  - **slot réservé** : J1, J2, `START` ; J2 ferme ; un **compte neuf** entre à 100 ms → slot 3 ;
    avec quatre joueurs, un cinquième → `ROOM_FULL` ;
  - **reprise** : J2 ferme ; le même jeton à 100 ms → `WELCOME.playerId === 2`, puis un `RESYNC`
    (`MSG.RESYNC`) **avant** le premier `SNAPSHOT` reçu après le `WELCOME`, et `RESYNC.tick ===
    SNAPSHOT.tick` ;
  - **`PRESENCE`** : J1 reçoit `(2, false)` à la coupure, `(2, true)` au retour ;
  - **expiration** : sans retour, `room.playerCount` passe à 1 après ~400 ms, pas avant 300 ;
  - **`onEmpty` différé** : J1 seul ferme ; à 200 ms `app.rooms.get(code)` existe encore et
    `room.tick` avance ; à 600 ms il n'existe plus ;
  - **`graceMs: 0`** : `room.playerCount` tombe sans attendre (le chemin des tests existants) ;
  - **pas de grâce hors run** : en salle d'attente, fermer retire du `LOBBY` tout de suite ;
  - **pas de grâce après `RUN_OVER`** : `room.debugKill` des deux, `RUN_OVER` reçu, J2 ferme → pas
    de `PRESENCE`, `playerCount` tombe ;
  - **run finie pendant la grâce** : J2 ferme, l'équipe est effacée, J2 revient → fermeture
    `ROOM_CLOSED` ;
  - **`stop()` efface les minuteurs** : `app.close()` revient en moins de 200 ms avec une grâce de
    60 s en cours (`graceMs` par défaut) — c'est le test qui garde le point 3 de la revue ;
  - **mid-run join** : un compte neuf qui entre dans un salon lancé reçoit `WELCOME` puis `RESYNC`.
- [ ] **Étape 2 : échec.** `cd back && npx vitest run src/server.test.ts -t "etape 18"`
- [ ] **Étape 3 : implémenter** — dans cet ordre : `#graces`, `#resyncPending`, `graceMs` ;
  `#freeId` ; `remove` → `#startGrace(id)` / `#expire(id)` ; `onFirst` (la reprise **après** les
  gardes `readyState`/`#stopped` qui suivent `findAccountIdByToken`, l.199-209 ; `room.runOver` →
  `ROOM_CLOSED` ; `#resyncPending.add(ws)` dans la branche salon lancé) ; `#broadcast` : le bloc
  `RESYNC` juste avant `this.#outbox.buffers.length = 0` (l.593) ; `#creditAccounts` : `[...#accounts,
  ...graces]` ; `stop()` : `clearTimeout` de chaque grâce. ⚠️ `libere` (l.164-170) reste
  idempotente : `remove` d'un id déjà en grâce ne fait rien.
- [ ] **Étape 4 : passent** ; puis les quatre fichiers d'intégration avec `graceMs: 0` :
  `cd back && npx vitest run src/ping.integration.test.ts src/boutique.integration.test.ts src/or-survit.integration.test.ts src/credit.integration.test.ts`
  — verts sans autre changement.
- [ ] **Étape 5 : commit** — `feat(back): la fenetre de grace, le RESYNC dans la diffusion et le credit des absents`

---

### Tâche 6 : `GameClient` — recevoir `RESYNC` et `PRESENCE`

**Fichiers :**
- Modifier : `shared/horde.ts` (`acknowledgeFields` à côté de l.1462-1468), `front/src/net/client.ts`
  (`RenderState` l.142-160 : `absent?: ReadonlySet<number>` ; champs l.1167-1560 : `#classes`,
  `#absent` ; `#onFrame` l.2397 : deux branches ; `update` l.2353 : `classes` depuis `#classes` ;
  `get roster`, `get localClassId` l.2069, `onResync`)
- Tester : `shared/horde.test.ts`, `front/src/net/client.test.ts` (nouveau `describe('etape 18 :
  le RESYNC')`, sur le même harnais que les tests de `WELCOME`/`WAVE_ORDER` du fichier)

**Interfaces :**
- Produit : `Horde.acknowledgeFields(fields)` ; `GameClient.onResync: () => void` (patron
  `onLobby` l.1941-1949) ; `get roster(): readonly { playerId: number; classId: number }[]` (du
  `LOBBY` ou du `RESYNC`) ; `isAbsent(id)` ; `RenderState.absent`.

- [ ] **Étape 1 : les tests** —
  - `horde.test.ts` : `spawnCatchingUp` après un `update` de champ lève ; après `acknowledgeFields`,
    ne lève plus.
  - `client.test.ts` :
    - **suivi à 0,000 px sur 300 ticks** : une `Horde` de référence conduite à la main (le fichier
      en construit déjà une avec `FlowField`, `PlayerHistory` et `ZoneField`, l.566 et suivantes ;
      le back n'est pas importable depuis le front) avance 120 ticks avec quelques `WaveOrder` ;
      on fabrique un `RESYNC` depuis son état (`saveState`, l'historique, les cibles) ; un
      `GameClient` neuf reçoit `WELCOME`, puis **un `WAVE_ORDER` daté ≤ T** (le piège du §3.3),
      puis `RESYNC`, puis `SNAPSHOT(T)` ; 300 ticks de plus des deux côtés avec les mêmes ordres →
      `maxDrift === 0` et identités égales. Contre-épreuve dans le test : sans l'historique, la
      dérive est > 0 (ça prouve que la section sert) ;
    - les files sont vides après `RESYNC` (`#pendingOrders` : l'ordre ≤ T n'a pas doublé la horde) ;
    - `loadoutOf(2).weaponIds`, `upgradesOf`, `stacksOf` reconstruits ; `lastFireTickOf` ;
    - étalage ouvert → `draftCards`, `draftDeadlineTick`, `isFrozen` vrai, `draftIsChest` selon le
      bit ; portail ouvert → `portalOpen`, `portalMultiplier`, `isFrozen` ; gel fini à `F` →
      `isFrozen` jusqu'à `F + LEVEL_RESUME_TICKS` ;
    - événement → `event` non nul avec `kind`, `solo`, compte à rebours `durationTicks − elapsed` ;
    - `level`, `kills`, `localClassId`, `roster`, `porteur` (archétype dans la horde) ;
    - `PRESENCE(2, false)` → `isAbsent(2)` et `update().absent` ; `(2, true)` → plus.
- [ ] **Étape 2 : échec.** `cd back && npx vitest run ../shared/horde.test.ts -t "acknowledge"` puis
  `cd front && npx vitest run src/net/client.test.ts -t "etape 18"`
- [ ] **Étape 3 : implémenter** — la branche `RESYNC` de `#onFrame` dans l'ordre du §4 de la spec
  (« Ce que `RESYNC` remplit »). Le `HordeState` : alloué **une fois** à la capacité
  `MAX_ENTITIES` (même fabrique que `HordeHistory`), rempli par `set` des tableaux décodés, puis
  `horde.restoreState`. Les champs : `#fields[f].update(x, y)` par cible, puis
  `horde.acknowledgeFields(#fields)`. L'événement : appeler `#onEvent` avec un `EVENT_START` puis un
  `EVENT_STATE` synthétiques, puis corriger `deadline` par `elapsed`.
- [ ] **Étape 4 : passent** ; puis `cd front && npx vitest run src/net/client.test.ts` entier.
- [ ] **Étape 5 : commit** — `feat(front): le client recoit l etat complet et la presence`

---

### Tâche 7 : le socle gris

**Fichiers :**
- Modifier : `front/src/render/player-renderer.ts` (`draw` l.119 : un prédicat `absent` ;
  l.140-151 : le socle), `front/src/render/stage.ts` (`draw` l.307-313 : passer `state.absent`),
  `front/src/render/frame.ts` (si `RenderState` y est recopié)
- Tester : `front/src/render/player-renderer.test.ts`

- [ ] **Étape 1 : le test** — un joueur absent : son socle est `ABSENT_BASE`, alpha du mort
  (0,25) ; présent : sa couleur ; absent **et** mort : le gris (l'absence se lit même au sol).
- [ ] **Étape 2 : échec.** `cd front && npx vitest run src/render/player-renderer.test.ts`
- [ ] **Étape 3 : implémenter** — trois lignes dans `draw`.
- [ ] **Étape 4 : passent.**
- [ ] **Étape 5 : commit** — `feat(front): le socle gris de l absent`

---

### Tâche 8 : recharger et rejoindre tout seul

**Fichiers :**
- Créer : `front/src/net/rejoin.ts`, `front/src/net/rejoin.test.ts`
- Modifier : `front/src/main.ts` (`leave` l.486-491 ; `onStatus` l.857-874 et `CLOSE_HINTS`
  l.852-855 ; le câblage `onStatus` du `GameClient` l.496 ; après `chargeSolde` l.347-354 ; le
  préchargement des unités l.519-528 → `client.roster` à `client.onResync`)

**Interfaces :**
- `rejoin.ts`, pur, testé : `DEFINITIVE_CLOSE_CODES` (`UNKNOWN_ROOM, ROOM_FULL, UNKNOWN_TOKEN,
  ROOM_CLOSED, NO_HELLO, BAD_FRAME`) ; `shouldRejoin(code: number | undefined, inRun: boolean,
  voluntary: boolean): boolean` ; `rememberRejoin(storage, code, now)` / `readRejoin(storage, now):
  string | null` (vide ou périmé → `null`, et **efface**) / `forgetRejoin(storage)` — chaque accès
  au stockage sous `try/catch`.

- [ ] **Étape 1 : les tests** (`rejoin.test.ts`, un `Storage` en mémoire) — les six codes définitifs
  rendent faux ; `1006` (fermeture anormale) et `undefined` en run rendent vrai ; hors run faux ;
  volontaire faux ; `readRejoin` rend le code sous la fenêtre, `null` et efface au-delà de
  `RECONNECT_GRACE_MS` ; un `Storage` qui lève ne casse rien.
- [ ] **Étape 2 : échec.** `cd front && npx vitest run src/net/rejoin.test.ts`
- [ ] **Étape 3 : implémenter** — `rejoin.ts` ; dans `main.ts` : `leave()` → `forgetRejoin` **avant**
  `disconnect()` et pose `quitting = true` ; le `onStatus` passé au client devient une fermeture
  qui, sur `closed`, si `shouldRejoin(code, !hud.classList.contains('hidden'), quitting)` →
  `rememberRejoin` puis `reload()` ; sinon si une reprise est en cours et que `readRejoin` rend
  encore le code → `setTimeout(() => client.connect(), REJOIN_RETRY_MS)` ; sinon l'affichage
  existant. Au démarrage : `const code = readRejoin(sessionStorage, Date.now()); if (code) {
  roomHint = 'Reconnexion…'; join(code); }`. `CLOSE_HINTS` gagne `ROOM_CLOSED`. Le préchargement
  des unités lit `client.roster` dans `client.onResync` (en plus de `onMapReady`, qui le lit déjà
  depuis `lastLobby`).
- [ ] **Étape 4 : passent** ; `cd front && npx vitest run src/net/rejoin.test.ts src/main.test.ts`
  (le double de `Stage` de `main.test.ts` ne doit pas rougir).
- [ ] **Étape 5 : commit** — `feat(front): la page se recharge et rejoint seule pendant la grace`

---

### Tâche 9 : le livrable — `back/src/reconnexion.integration.test.ts`

**Fichiers :**
- Créer : `back/src/reconnexion.integration.test.ts` (harnais copié d'`evenement.integration.test.ts`
  : `connect`, `waitFor`, `envelopper`, `viderSauf`, `waitingRoom: true` + `START`, un `ROOM_SEED`
  fixe ; `voteExtraction` et `quatreClients` repris de `credit.integration.test.ts` ; une aide
  `reconnect(code, token)` qui refait `HELLO` avec le **même** jeton)

- [ ] **Étape 1 : les dix tests du §7 de la spec**, numérotés et nommés comme là-bas. Pour le test 2
  : `envelopper(room, …)` copie `room.horde` par `saveState` dans un `HordeState` à chaque tick ;
  au `RESYNC` reçu, comparer avec la copie du tick `RESYNC.tick` : identités dans le même ordre,
  `x/y/vx/vy` par `toEqual` sur `Float32Array.subarray(0, count)` ; `console.info` de
  `data.byteLength` et de `count` (la mesure que la spec attend). Pour le test 10 : `snapshotBytes`
  à quatre vaut `{ 66 }`, écrit nu comme à l'étape 16.
- [ ] **Étape 2 : les lancer** — `cd back && npx vitest run src/reconnexion.integration.test.ts`.
  Tout doit passer **sans toucher au code** : les tâches 1 à 8 sont le code. Un test qui rougit ici
  est un bug d'une tâche précédente, pas un test à ajuster.
- [ ] **Étape 3 : les contre-épreuves** du §7, chacune à la main, chacune annulée, consignées pour
  le bilan.
- [ ] **Étape 4 : commit** — `test(back): le livrable de la reconnexion sur vraies sockets`

---

### Tâche 10 : le portique et le bilan (contrôleur, seul)

**Fichiers :**
- Créer : `docs/plans/2026-11-06-etape-18-resultats.md`
- Modifier : `README.md` (tableau « État », après la ligne 16 — et la 17 si elle manque encore)

- [ ] **Étape 1 : le portique** — `npm run lint`, `npm run typecheck`, `npm test` (Postgres
  lancée), `npm run bench -w back` (aucun banc ne doit bouger : rien dans la boucle). Relancer une
  fois un échec isolé de compte avant de conclure.
- [ ] **Étape 2 : le bilan** — même forme que `2026-11-05-etape-16-resultats.md` : le livrable
  (dix tests, la taille mesurée du `RESYNC` et le nombre d'entités au moment de la mesure, à
  confronter aux 31 Kio / 1 200 de la spec), les contre-épreuves (tableau « règle cassée → échec
  observé »), ce qui est livré, les écarts avec la spec, et un §« vérification manuelle » **ouvert**
  qui recopie le §9 de la spec, case par case, pour la run de Léo.
- [ ] **Étape 3 : le README** — une ligne :
  `| 18 | Reconnexion avec état complet : fenêtre de grâce, \`RESYNC\` hors tick — **zéro octet de plus par tick** | 📝 — [spec](docs/specs/2026-11-06-etape-18-reconnexion.md) · [plan](docs/plans/2026-11-06-etape-18-reconnexion.md) · [résultats](docs/plans/2026-11-06-etape-18-resultats.md) |`
- [ ] **Étape 4 : `graphify update .`** (AST seul).
- [ ] **Étape 5 : commit** — `docs: le bilan de l etape 18, la reconnexion (verification manuelle ouverte)`
