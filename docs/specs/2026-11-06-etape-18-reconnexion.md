# Étape 18 — la reconnexion avec état complet

**Statut :** à valider. Décision de Léo du 6 novembre : « Prévoir une reconnexion avec état
complet. »
**Ancres :** lignes du commit `0b46ec3` (tête de `main` le 6 novembre).
**Remplace :** le §4.2 de [l'étape 7a](2026-10-10-etape-7a-or-persistant.md) sur un point, « qui
est crédité » ; réalise le §3.7 de
[l'orientation](2026-08-19-coop-survivors-orientation.md) (« le serveur possède l'état, il envoie
un instantané complet »). Ferme le premier risque de [l'étape 17](2026-11-06-etape-17-extraction.md)
(§6 : un joueur qui arrive pendant le portail ne sait pas que le monde est gelé).

## 0. Pourquoi

Aujourd'hui une socket qui tombe en run **détruit le joueur** :

- `Session.remove` (`back/src/server.ts` l.277-289) appelle `room.leave` sans délai ;
  `Room.leave` (`back/src/room.ts` l.1255-1263) efface le `PlayerState` — loadout, cartes, PV,
  classe, recharges — et l'oublie de l'étalage, du portail et de l'événement ;
- `#creditAccounts` (`server.ts` l.436-454) ne verse l'or qu'aux valeurs de `#accounts`, « les
  comptes encore connectés » : une coupure Wi-Fi à dix secondes de l'extraction coûte la run ;
- un joueur qui revient entre **comme nouveau** : `onFirst` (`server.ts` l.233-257) lui donne le
  plus petit slot libre et un `Loadout` vide (`Room.join` l.1226-1227) ; son client reçoit un
  `WELCOME` de 10 octets (`front/src/net/client.ts` l.2400-2437) et rien d'autre — horde locale
  vide (les `WAVE_ORDER` passés sont perdus), aucune zone, aucune charge, aucun étalage, aucun
  événement, classe par défaut, dague.

Côté client, toute fermeture mène à `window.location.reload()` (`front/src/main.ts` l.486-491,
l.819) : quitter, le bilan, et donc aussi une coupure. Le joueur revient à l'accueil, retape le
code, et repart de zéro.

Objectif : une socket qui tombe en run laisse **un slot réservé une minute**, et le joueur qui
revient sur son compte **reprend sa place avec tout** — son build, la horde au pixel près, les
zones, l'étalage ou le vote en cours, l'événement, le gel. Et l'or de l'extraction lui revient
s'il était de la run.

## 1. Les règles

### 1.1 La fenêtre de grâce

`RECONNECT_GRACE_MS = 60 000` (`shared/constants.ts`, lu par le serveur **et** le client).

À la fermeture de la socket d'un joueur **en run** (salon lancé, run non finie, joueur présent dans
`Room`) :

1. le slot et le `PlayerState` sont **conservés** ; `Room.leave` n'est pas appelé ;
2. le joueur passe **absent** (§1.3) ; les autres reçoivent `PRESENCE(id, absent)` (§3.2) ;
3. un minuteur de `RECONNECT_GRACE_MS` démarre dans `Session` ; à l'échéance, `Room.leave` réel,
   comme aujourd'hui — le joueur disparaît des `SNAPSHOT`, aucun message de plus.

**Pourquoi 60 s.** L'orientation proposait 90 s. Un rechargement de page plus un `HELLO` tient en
2 s (actifs en cache) ; une bascule Wi-Fi ↔ 4G, 10 à 30 s. 60 s couvre les deux. Au-delà, le prix
pour l'équipe monte : l'absent compte dans `#players.size`, donc dans le seuil de niveau
(`room.ts` l.2922), les PV du boss (l.1527) et la moyenne de « Savoir » (l.2910) — trois joueurs
portent le poids d'un quatrième. Une minute borne ce poids. Les fenêtres de jeu les plus longues
(étalage, portail) font 20 s : l'absent n'en tient aucune ouverte (§1.3), la grâce peut donc les
dépasser sans gêner.

⚠️ **Hors run, rien ne change.** En salle d'attente (`#started === false`), `remove` fait ce qu'il
fait aujourd'hui : retrait du `#lobby`, rediffusion `LOBBY`. Après `RUN_OVER`, idem : un joueur qui
quitte le bilan part pour de bon, sans grâce — sinon la `Session` traînerait une minute après que
tout le monde a quitté l'écran de fin.

### 1.2 L'identification : le compte, sur le même code

Le jeton anonyme de l'étape 7a identifie le joueur : `findAccountIdByToken` (`server.ts` l.190)
rend un `accountId`. `Session` tient `#graces: Map<accountId, { id, timer }>`.

- **Même compte, même code, dans la fenêtre** : `onFirst` trouve le compte dans `#graces`, annule
  le minuteur, et **réattache le slot** : `#clients.set(id, ws)`, `#accounts.set(id, accountId)`,
  `room.setAbsent(id, false)`, puis `WELCOME` (inchangé, 10 o) et `RESYNC` (§3.1). La lecture des
  achats (`purchasesOf`, l.217) est sautée : les bonus du compte sont déjà dans le `PlayerState`
  (`accountBonuses`, posés au `join`).
- **Le salon s'est rempli entre-temps** : impossible, le slot est **réservé**. `#freeId`
  (l.601-608) saute les identifiants tenus par `#clients` **et** par `#graces`. Un cinquième compte
  reçoit `ROOM_FULL` tant que la grâce court.
- **La `Session` s'est fermée** (`onEmpty`) : `onEmpty` ne part plus quand `#clients` est vide,
  mais quand `#clients` **et** `#graces` le sont. Le dernier joueur qui tombe laisse donc le salon
  tourner une minute sans personne — la horde n'a plus de cible (`dueWave` ne sort rien sans
  joueur, l.446 de `wave-director.ts`), le coût est un `setInterval` qui ne fait rien. À
  l'échéance, `leave` puis `onEmpty`. Un retour après : `UNKNOWN_ROOM`, comme aujourd'hui.
- **Le compte revient sur un AUTRE salon** : le salon B lui donne un slot neuf ; la grâce dans A
  court jusqu'à son terme. Si A s'extrait dans la minute, le compte touche l'or de A (§1.6). C'est
  le même compte dans deux salons, déjà permis par l'étape 7a (« deux onglets »). Pas d'annulation
  croisée : elle demanderait à une `Session` d'en connaître une autre.
- **Le même compte déjà connecté** (second onglet) : rien ne change, il obtient un second slot ; la
  reprise ne concerne que les comptes de `#graces`.

### 1.3 L'absent : comme un mort, sauf qu'il peut revenir

`PlayerState.absent: boolean`, posé par `Room.setAbsent(id, absent)`. Un absent :

- **ne bouge pas, ne tire pas** : `setAbsent(true)` met `moveX`, `moveY`, `aimX`, `aimY` à zéro.
  ⚠️ Nécessaire : plus aucun `INPUT` n'arrive, donc la dernière entrée **resterait appliquée** et
  le joueur marcherait tout droit jusqu'au mur ; `aim = (0, 0)` vaut « ne tire pas » (l.164-165) ;
- **n'est pas une cible** : exclu des positions qui nourrissent les champs et ancrent les vagues
  (l.1470-1477), de l'historique de fin de pas (l.1899-1911), de l'ancrage du directeur. Même filtre
  que `hp > 0`, et le client applique le même sur le `SNAPSHOT` (§4.3) ;
- **ne ramasse rien** (l.1844-1852) ;
- **ne tient rien ouvert** : `#draft.forget`, `#portal.forget`, `#event?.forget` à l'entrée en
  absence, exactement ce que `leave` fait aujourd'hui (l.1259-1262) — un jeton posé tombe, une
  relique portée tombe ;
- **compte comme un mort pour la fin de run** (`#checkRunOver`, l.2930-2949) : la run se termine
  quand tous les **présents** sont à terre. S'il n'y a **aucun** présent (solo qui tombe), rien ne
  se décide : la run attend, horde sans cible, jusqu'au retour ou à l'échéance ;
- **reste vulnérable** : `resolveContact` et les tirs des tireurs le touchent s'il est sur le
  chemin. Il n'attire pas, mais il n'est pas invulnérable — sans quoi couper sa socket éviterait une
  charge de boss ;
- **garde sa régénération** et son bouclier : inoffensif, et un garde de moins.

Au retour, `setAbsent(false)` : entrées à zéro (le premier `INPUT` les pose), `#draft.rejoin(id,
vivant)` et `#portal.rejoin(id)` si une fenêtre est ouverte — le revenant participe à l'étalage en
cours (il peut poser un jeton, il sera servi) et au vote (`NO_VOTE` jusqu'à son clic).

### 1.4 Ce que voient les autres

Un **socle gris** sous le personnage immobile (`front/src/render/player-renderer.ts`, le socle à la
couleur du joueur l.18-73) — la même lecture qu'un mort : « il est là, il ne joue pas ». Pas de
bandeau : un écran de plus pour dire ce que le socle dit déjà. Le socle redevient coloré au
`PRESENCE(id, present)` du retour.

### 1.5 Le retour : `WELCOME` puis `RESYNC`

`WELCOME` ne change pas d'un octet : le client y régénère la carte depuis la graine (l.2409-2418).
`RESYNC` suit dans la **diffusion suivante** (§3.3) et porte tout le reste. Il part aussi à **tout
joueur qui rejoint un salon lancé** (chemin `onFirst` l.246-257), reconnexion ou non : c'est le
même manque, et ça ferme le risque de l'étape 17.

### 1.6 L'or : tous ceux qui étaient de la run

`#creditAccounts` crédite les comptes de `#accounts` **et** ceux de `#graces`. Un joueur absent à
l'extraction, mais encore dans sa fenêtre, touche la cagnotte entière — comme un mort connecté
(étape 7a, §4.2 : « le mort reste de l'équipe »). Un joueur dont la grâce a expiré a **quitté**
(`leave`) : rien, comme aujourd'hui.

**Pourquoi c'est juste** : la cagnotte est d'équipe (un seul nombre, `#gold`), il l'a fait monter,
et une coupure n'est pas un choix.

**L'abus possible, et pourquoi il n'existe pas** : « couper pour éviter la mort ». L'absent reste
vulnérable (§1.3) et compte comme mort pour la fin de run : si l'équipe est effacée, la cagnotte
tombe à `WIPE_GOLD_KEPT` pour lui comme pour les autres. Être absent ne rapporte jamais plus que
d'être présent. Le seul gain d'un départ volontaire est de se faire porter une minute — c'est le
prix de ne pas punir une coupure, et il est borné.

Les deux variantes écartées : « l'absent ne touche que ce qui est sécurisé à l'instant où il
part » — rien n'est sécurisé avant l'extraction, la règle serait vide ; « rien tant qu'il n'est
pas revenu » — punit la coupure, exactement ce qu'on veut éviter.

### 1.7 La run finit pendant l'absence

`#creditAccounts` l'a crédité. Son `HELLO` tombe sur `room.runOver === true` : la socket est fermée
`ROOM_CLOSED` (4008, existant), le client affiche « Salon fermé — la run est terminée ou le salon a
été dissous. » sur l'écran de salon. Pas de bilan pour lui : `RUN_OVER` est drainé une fois
(l.869-873) et `Room` n'en garde pas copie. Son or est au compte, lisible à l'accueil.

## 2. L'état complet : un instantané, pas un rejeu

Deux voies pour rendre la horde au revenant.

**Rejouer les `WAVE_ORDER` depuis le début.** Impossible, pas seulement cher :

- `Horde.kill` (`shared/horde.ts` l.517-546) **compacte** les créneaux et rien ne retient les
  morts ; `#pendingDeaths` et `#pendingOrders` sont **vidés à chaque diffusion** (`room.ts`
  l.661-672). Le serveur n'a pas de journal ; il faudrait en créer un, et le garder toute la run ;
- `spawnCatchingUp` (l.996-1030) rattrape **une vague seule**, sans séparation avec les autres ni
  morts intermédiaires : il est fait pour quelques ticks de latence, pas pour dix minutes ;
- un rejeu fidèle = rejouer `step` sur 18 000 ticks (10 min à 30 Hz) avec tous les `DEATHS`,
  `ZONE`, `BOSS_CHARGE`, leurres et gels dans l'ordre : ~0,9 ms par pas mesuré au banc de l'étape 1
  (4 000 entités, flowfield et déplacement seuls, la séparation en plus) → **≥ 16 s de calcul** avant
  la première image.

**Envoyer les positions.** `Horde.saveState` / `restoreState` (l.562-614) existent déjà : quinze
tableaux et un compte, c'est l'anneau de rejeu du client. `RESYNC` en transporte la partie qui
décide du mouvement, le client appelle `restoreState`, et la horde continue **au même tick, avec
les mêmes vitesses** : dérive 0,000 px par construction, la même que l'anneau.

| | Rejeu des ordres | Instantané |
| --- | --- | --- |
| Ordres de 10 min | ~200 × 19 o = 3,8 Kio | — |
| Journal des morts de 10 min | ~15 000 × 4 o + en-têtes ≈ 60-80 Kio **à garder côté serveur** | — |
| Horde (hypothèse 1 200 vivants) | — | 1 200 × 24 o = 28,8 Kio |
| Calcul client avant la première image | ≥ 16 s | ~0 |
| Code nouveau | un journal de tout ce qui bouge, un rejeu long | un encodeur |

Le nombre de vivants à 10 min **n'est pas établi depuis le code** (dépend de la vitesse à laquelle
l'équipe tue) ; 1 200 est l'ordre de grandeur de la cible d'orientation (800-1 500). Le test du
livrable imprime la taille réelle.

## 3. Les messages

### 3.1 `RESYNC` (S → C, `MSG.RESYNC = 31`), une fois, hors tick

Petit-boutien, comme tout le protocole. Les sections conditionnelles ne sont présentes que si leur
bit de `flags` est levé.

**En-tête — 19 o**

| Champ | Type | Note |
| --- | --- | --- |
| type | u8 | 31 |
| tick | u32 | le tick `T` de l'instantané, celui du `SNAPSHOT` qui suit |
| level | u16 | `#level` |
| kills | u32 | `#totalKills` (le HUD) |
| freezeUntilTick | i32 | `#freezeUntilTick`, −1 hors gel ; le client en dérive `resumeEnd = +LEVEL_RESUME_TICKS` |
| chestsOwed | u8 | `#chestsOwed` |
| eventDraftsOwed | u8 | `#eventDraftsOwed` |
| flags | u8 | bit 0 étalage ouvert · bit 1 c'est un coffre · bit 2 c'est un événement · bit 3 portail ouvert · bit 4 événement en cours · bit 5 charge en cours |
| playerCount | u8 | |

**Joueurs — par joueur, 4 o + 17 o par arme tenue + 32 o**

| Champ | Type | Note |
| --- | --- | --- |
| id | u8 | |
| classId | u8 | la classe : le client n'a plus de `LOBBY` après rechargement |
| flags | u8 | bit 0 absent |
| nWeapons | u8 | ≤ `WEAPON_SLOTS` (4) |
| par arme : weaponId | u8 | dans l'ordre de `Loadout.weaponIds` (l'ordre des slots) |
| par arme : upgrades | `UPGRADE_KINDS` (12) × u8 | `upgradesOf(id, aspect)` ; le nombre d'exemplaires n'est pas envoyé : `stacks = 1 + Σ upgrades` (`addWeapon`, `shared/loadout.ts` l.95-115) |
| par arme : lastFireTick | u32 | 0 = jamais ; le miroir de tir du client ne vide pas tout son chargeur au premier tick |
| passifs | `PASSIVES.length` (16) × u16 | `stacksOf(id)` ; u16 parce que « sans plafond » |

Le client reconstruit un `Loadout` **par l'API publique** : `addWeapon(id)` puis `addWeapon(id,
aspect)` × `upgrades[aspect]`, `addPassive(id)` × `stacks`. Pas de chemin d'écriture nouveau.
`maxHp` n'est pas envoyé : le client le dérive déjà (`localMaxHp`, l.1882-1888) ; les PV courants
sont dans le `SNAPSHOT`.

**Historique des positions — 6 enregistrements, ≤ 126 o**

`HISTORY_TICKS = FIELD_INPUT_DELAY_TICKS + STEPS_PER_FIELD` = 3 + 3 = 6, ticks `T−5 … T`
implicites. Par enregistrement : `count u8`, puis `count × (id u8 · x i16 · y i16)`. Ce sont les
vivants présents, arrondis, comme `#history.record` (l.1899-1911). ⚠️ **Indispensable** : le
rafraîchissement des champs lit les positions de `tick − 3` (`#history.delayed`,
`shared/player-history.ts` l.74) ; sans historique, le client sauterait un ou deux
rafraîchissements que le serveur a faits, et les entités dont le recalcul de trajectoire tombe dans
ce trou partiraient dans une direction périmée — pour toujours.

**Cibles des champs — ≤ 17 o**

`n u8`, puis `n × (x i16 · y i16)` : `Horde.aimX/aimY` (l.226-227), les positions retardées du
dernier `retarget`. Le client appelle `#fields[f].update(x, y)` pour chaque : un champ est une
fonction pure de (masque, cellule cible), donc les champs sont identiques sans qu'une cellule ne
transite — les 8 836 cellules × 4 champs restent hors du fil, comme la carte.

**Horde — 2 o + 24 o par entité**

| Champ | Type | Note |
| --- | --- | --- |
| count | u16 | ≤ `MAX_ENTITIES` |
| waveId, indexInWave | u16, u16 | l'identité (`entityIdOf`) |
| x, y | f32, f32 | ⚠️ **flottants, pas i16** : la horde ne passe jamais quantifiée sur le fil, et 0,000 px exige les mêmes bits |
| vx, vy | f32, f32 | la vitesse **tenue** entre deux recalculs (`STEERING_RECOMPUTE_TICKS` = 9) ; quantifiée, l'erreur de position ne se corrigerait jamais |
| archetype | u8 | |
| animPhase | u8 | cosmétique, 1 o, pour que le revenant voie les mêmes images |
| targetField | u8 | le champ suivi jusqu'au prochain `retarget` |
| flags | u8 | bit 0 `stopped` · bit 1 `fleeing` (le voleur qui fuit « pour toujours », l.230-235) |

Non envoyés : `hp` (le client n'arbitre aucun dégât ; la barre du boss vient du `SNAPSHOT`),
`mark`/`markBy`/`markUntil` (teinte cosmétique, morte en `MARK_DURATION_TICKS` = 2 s), `aura`
(serveur seul). `restoreState` les laisse à zéro.

**Orbes — 2 o + 8 o par orbe**

`count u16`, puis `count × (id u32 · x i16 · y i16)`. Les orbes n'expirent jamais (`DerivedOrbs`,
`client.ts` l.475-483) et le client les dérive des `DEATHS` qu'il n'a pas vus : il faut les
envoyer. Positions en i16 : le ramassage est arbitré par `PICKUPS`, la position ne sert qu'à
dessiner.

**Zones — 1 o + 10 o par zone**

`count u8` (≤ `ZONE_CAPACITY` = 128), puis `kind u8 · x i16 · y i16 · bornTick u32 · by u8` — le
corps de `ZONE` sans son octet de type. Le client appelle `zones.spawn` comme pour un `ZONE`.

**Leurres — 1 o + 9 o par leurre**

`count u8`, puis `playerId u8 · x i16 · y i16 · bornTick u32`. Les leurres vivants
(`DECOY_LIFETIME_TICKS`) substituent leur lanceur dans l'entrée des champs : sans eux, le prochain
rafraîchissement diverge.

**Charge en cours — 28 o si bit 5** : le corps de `BOSS_CHARGE` sans l'octet de type.

**Événement — 12 o + 4 o par point si bit 4** : `genre|solo u8 · durationTicks u16 · elapsed u16
· progress u8 · cartX i16 · cartY i16 · cartHp u8 · n u8 · n × (x i16 · y i16)` — un `EVENT_START`
et un `EVENT_STATE` en un, plus `elapsed` pour le compte à rebours
(`deadline = pingClock + durationTicks − elapsed`). Les proies de la chasse se reconnaissent dans
la horde à leur archétype, comme le porteur.

**Étalage — 5 o + 4 o par carte si bit 0** : `deadlineTick u32 · n u8 · n × DRAFT_CARD_BYTES`.
Les jetons posés ne sont pas envoyés : `DRAFT_INTENTS` repart à chaque diffusion tant qu'il y en a
(`server.ts` l.545-550).

**Portail — 6 o si bit 3** : `deadlineTick u32 · multiplier u16`, comme `PORTAL_OPEN`. Les votes
repartent à chaque diffusion (l.566-572).

Non envoyés, et pourquoi : les projectiles (jamais répliqués, le miroir repart de `lastFireTick`),
les remparts, gardiens, ondes, frappes, halos, venins (dégâts serveur ; côté client des traces
cosmétiques bornées par leur durée), `#extractMultiplier` hors portail (le prochain `PORTAL_OPEN` le
porte), `#pendingLevels` (le client ne le reflète pas), `xp`, `synergy`, `gold`, le boss et les PV
(le `SNAPSHOT` du même tick suit immédiatement).

### 3.2 `PRESENCE` (S → C, `MSG.PRESENCE = 32`), 3 o, sur changement

`type u8 · playerId u8 · present u8`. Envoyé à tous quand un joueur entre en grâce (`present = 0`)
et quand il revient (`present = 1`). Le `RESYNC` porte le bit « absent » de chacun : le revenant
n'a pas besoin des `PRESENCE` passés.

### 3.3 Où et quand `RESYNC` part : dans `#broadcast`, après les drains, avant le `SNAPSHOT`

⚠️ **Pas depuis `onFirst`.** `onFirst` s'exécute entre deux diffusions : la horde a déjà joué le
tick `T` (les morts sont compactées, les vagues de `T` sont nées), mais `#pendingDeaths`,
`#pendingOrders`, `#pendingZones`… de `T` **ne sont pas encore drainés**. Envoyés après un
`RESYNC` pris à `T`, ils feraient renaître des vagues déjà dans l'instantané et tuer des entités
déjà absentes.

`Session` tient donc `#resyncPending: Set<WebSocket>` ; `onFirst` y pose la socket après le
`WELCOME`. `#broadcast` (l.486-598) encode **un** `RESYNC` **après tous les drains** (ordres, morts,
verbes, zones, charges, réactions, ramassages, événements, niveaux, étalages, portail) et **avant**
`room.snapshot` — le même tampon pour toutes les sockets en attente, puis vide l'ensemble. Le
revenant reçoit donc, dans l'ordre : `WELCOME`, éventuellement des messages datés `≤ T` (les drains
de cette diffusion), `RESYNC(T)`, `SNAPSHOT(T)`. **Règle client** : à `RESYNC`, vider
`#pendingOrders`, `#pendingDeaths`, `#pendingZones`, `#pendingCharges`, `#pendingDecoys` — tout ce
qui est daté `≤ T` est dans l'instantané. Au plus 33 ms d'attente (`BROADCAST_MS`).

### 3.4 Taille, à 10 min et 4 joueurs

Hypothèses (non établies depuis le code, à relever au livrable) : 1 200 entités vivantes, 300 orbes
au sol, 40 zones, 2 leurres, un convoi en cours, deux armes et six passifs par joueur, ni étalage,
ni portail, ni charge.

| Section | Octets |
| --- | --- |
| En-tête | 19 |
| 4 joueurs × (4 + 2 × 17 + 32) | 280 |
| Historique 6 × (1 + 4 × 5) | 126 |
| Cibles des champs 1 + 4 × 4 | 17 |
| Horde 2 + 1 200 × 24 | 28 802 |
| Orbes 2 + 300 × 8 | 2 402 |
| Zones 1 + 40 × 10 | 401 |
| Leurres 1 + 2 × 9 | 19 |
| Événement (convoi, 2 points) | 20 |
| **Total** | **32 086 o ≈ 31,3 Kio** |

Borne haute (4 000 entités, 4 000 orbes, 128 zones, 4 leurres, tout ouvert) : 19 + 416 + 126 + 17 +
96 002 + 32 002 + 1 281 + 37 + 28 + 24 + 33 + 6 = **129 991 o ≈ 127 Kio**.

Repère : un `SNAPSHOT` à quatre fait 66 o, soit 1 980 o/s. Le `RESYNC` nominal vaut **16 s de
snapshots**, une fois par reconnexion. **Zéro octet de plus par tick** : `SNAPSHOT`, `ZONE`,
`WAVE_ORDER` et tous les autres ne bougent pas ; `PRESENCE` fait 3 o par changement d'état.

## 4. Le client : recharger la page, puis rejoindre tout seul

Deux voies : vider et reconstruire `GameClient` + `Stage` en place, ou recharger et rejouer `HELLO`.

**Recharger.** `main.ts` recharge déjà partout (l.486-491 : « `Stage`/`Keyboard` ne se démontent
pas proprement, et le lobby se recharge de toute façon » ; l.819 pour le bilan). Vider en place
voudrait dire remettre à zéro une quarantaine de champs de `GameClient` (l.1167-1560 : horde,
anneau, zones, orbes, projectiles, cinq réservoirs de flashs, inventaires, étalage, portail,
événement, leurres…) et recâbler `DraftScreen`, `PortalScreen`, `composeFrame` sur un nouveau
client. Chaque champ oublié est un fantôme de l'ancienne run. Le rechargement donne un client
**neuf** et un `Stage` neuf, gratuitement, et le `RESYNC` n'a plus qu'à **remplir**, jamais à
vider.

Le flux :

1. **À la fermeture inattendue en run** (HUD visible, socket fermée sans que `leave()` l'ait
   demandé, code de fermeture ni `UNKNOWN_ROOM`, ni `ROOM_FULL`, ni `UNKNOWN_TOKEN`, ni
   `ROOM_CLOSED`, ni `NO_HELLO`, ni `BAD_FRAME`) : `sessionStorage` reçoit
   `{ code, since: Date.now() }` sous `tarnok.rejoin`, puis `window.location.reload()` — comme
   aujourd'hui, un rechargement, mais avec un mot pour la suite. `sessionStorage` et pas
   `localStorage` : il est **par onglet**, deux onglets du même compte rejoignent chacun leur salon.
2. **Au démarrage**, après `chargeSolde()` : si `tarnok.rejoin` existe et que
   `Date.now() − since < RECONNECT_GRACE_MS`, `join(code)` part tout seul, l'écran de salon dit
   « Reconnexion… ». Le reste est le chemin existant : `WELCOME` → `onMapReady` → écran de
   chargement → première image au premier `SNAPSHOT` (`loading.firstSnapshot`, l.446). Le `RESYNC`
   arrive avant ce snapshot (§3.3) : quand le HUD s'affiche, tout est là.
3. **Si la socket retombe** pendant la reprise (serveur encore injoignable) et que la fenêtre
   court : `client.connect()` est rappelé après 2 s (`connect()` crée une socket neuve, l.2221-2248 ;
   `disconnect()` a déjà nettoyé le minuteur d'entrées). Code définitif ou fenêtre passée :
   `tarnok.rejoin` est effacé, l'écran de salon montre le motif (`CLOSE_HINTS`, l.852-855, qui gagne
   `ROOM_CLOSED`).
4. `leave()` (quitter, bilan) efface `tarnok.rejoin` **avant** `disconnect()` : un départ voulu ne
   rejoint pas.

Ce que `RESYNC` remplit dans `GameClient` (`#onFrame`) : `#lastHordeTick = T`, `#hordeAcc = 0` ;
`#level`, `#kills`, `#chestsOwed`, `#eventDraftsOwed` ; gel et reprise (§3.1, et les règles
existantes de `LEVEL_UP` / `PORTAL_OPEN` pour les fenêtres ouvertes — `#freezeStartTick`,
bornes à `MAX_SAFE_INTEGER`) ; `#loadouts`, `#lastFireTick`, `#classes` (nouveau, à la place du
`#lobby` absent), `#localClassId` ; `#history.record` pour chaque enregistrement ; la horde par
`restoreState` ; les champs par `update` puis `horde.acknowledgeFields(#fields)` (⚠️ §8) ; les
zones, orbes, leurres, charge ; l'étalage, le portail, l'événement (`#onEvent` rejoué avec un
`EVENT_START` puis un `EVENT_STATE` synthétiques) ; `#porteurId` par balayage de la horde ;
`#absent` ; puis vidage des files datées. `GameClient.onResync` (même patron que `onLobby`) prévient
`main.ts`, qui précharge les planches d'unités depuis `client.roster` plutôt que depuis `lastLobby`.

Un client qui reçoit `PRESENCE` met à jour `#absent: Set<number>` ; `RenderState` gagne
`absent`, lu par le rendu du socle.

## 5. Le serveur

### 5.1 `Session` (`back/src/server.ts`)

- `#graces: Map<string, { id: number; timer: NodeJS.Timeout }>` ; `#resyncPending: Set<WebSocket>`.
- `remove(id)` : si `#started && !room.runOver && room.positionOf(id) !== null && graceMs > 0`
  → **grâce** : `#clients.delete`, `#pings.delete` (la fenêtre de ping n'est pas héritée, §6),
  `#accounts` → `#graces`, `room.setAbsent(id, true)`, `#send(PRESENCE(id, 0))`, minuteur
  `#expire(id)`. Sinon : le chemin d'aujourd'hui.
- `#expire(id)` : `room.leave(id)`, `#graces.delete`, puis le test `onEmpty` (vide des deux côtés).
- `#freeId` : saute aussi les `id` de `#graces`.
- `onFirst` : après `findAccountIdByToken` et les gardes de socket et d'arrêt, si `#graces` connaît
  le compte → reprise (§1.2), `WELCOME`, `#resyncPending.add(ws)`, écouteurs, et retour — sans
  `purchasesOf`. Sinon le chemin existant ; dans la branche « salon lancé », `room.runOver` →
  `ROOM_CLOSED` ; sinon `WELCOME` puis `#resyncPending.add(ws)`.
- `#broadcast` : après les drains et avant le snapshot, si `#resyncPending` n'est pas vide,
  `encodeResync(room.resyncState())` une fois, envoi à chaque socket ouverte de l'ensemble, vidage.
- `#creditAccounts` : `partsFortune` sur `#accounts` ∪ `#graces` (clé = compte, déjà dédoublonné).
- `stop()` : ⚠️ **efface tous les minuteurs de grâce** — sans quoi `app.close()` laisse des
  `setTimeout` de 60 s et Vitest attend.
- `ServerOptions.graceMs` (défaut `RECONNECT_GRACE_MS`) : les tests qui ont besoin d'un départ
  immédiat passent `0` (§6).

### 5.2 `Room` (`back/src/room.ts`)

- `PlayerState.absent`, `setAbsent(id, absent)`, les filtres du §1.3 dans `step`, `#openDraft`
  (les attendus, l.2438), `#startEvent` (les vivants, l.2495), `#stepEvent` (les joueurs passés à
  `ev.step`, l.2541 : un absent planté sur un sceau ne compte pas), `#checkRunOver`.
- `get runOver()`.
- `#draftKind: 'level' | 'chest' | 'event'` posé par `#openDraft` (il sait déjà lequel, l.2421-2422)
  pour les bits 1 et 2.
- `resyncState(): ResyncState` : un objet simple qui rassemble tout le §3.1 — `Room` reste sans
  réseau (la règle Biome du README), l'encodage vit dans `shared/protocol.ts`. `PlayerHistory`
  gagne une lecture `at(tick)` (elle n'a aujourd'hui que `delayed`).
- `join` appelle aussi `#draft.rejoin` / `#portal.rejoin` : un joueur qui rejoint un salon lancé
  pendant un étalage y participe (aujourd'hui il ne peut rien poser : `setToken` refuse qui n'est
  pas dans `#pending`, `draft.ts` l.94).

### 5.3 `Draft.rejoin(id, awaited)`, `Portal.rejoin(id)`

Les inverses de `forget` (`draft.ts` l.127-131, `portal.ts` l.96-99), sans effet si la fenêtre est
fermée. `Draft.rejoin` ajoute à `#pending` et, si `awaited`, à `#awaited` ; `Portal.rejoin` ajoute à
`#pending` et pose `NO_VOTE`.

## 6. Le test de l'étape 9, et les autres tests que la grâce touche

**`back/src/ping.integration.test.ts` l.140-155** (« un joueur qui revient sur le meme id ne
recupere pas la fenetre du precedent ») : l'invité ferme sa socket, et un **compte neuf** entre
150 ms plus tard en attendant le slot 2. Avec la grâce, le slot 2 est réservé une minute : le
compte neuf aurait le slot 3 et `expect(p.playerId).toBe(2)` rougirait. **Il change d'une ligne** :
son `beforeEach` passe `graceMs: 0` (l.26). Son sens est intact — un compte neuf qui prend un slot
libéré n'hérite d'aucune fenêtre — et c'est bien le cas qu'il décrit, un *autre* compte. Le cas
« le **même** compte revient » est celui de cette étape, et sa fenêtre non plus n'est pas
héritée : `#pings.delete(id)` a lieu à la coupure (§5.1). Le livrable l'assène (§7).

Même ligne (`graceMs: 0`) dans trois autres fichiers dont une assertion attend un `leave` immédiat :
`back/src/boutique.integration.test.ts` l.296-297 (`room.playerCount === 0` après `close`),
`back/src/or-survit.integration.test.ts` l.396-397 (idem), `back/src/credit.integration.test.ts`
l.612-613 (« un joueur deconnecte avant la fin de run n est pas credite » : vrai pour un départ
**définitif**, ce que `graceMs: 0` est ; le cas « en grâce → crédité » vit dans le livrable).

Tous les autres harnais ferment leurs sockets en `afterEach` puis `app.close()` : `stop()` efface
les minuteurs (§5.1), rien à changer.

## 7. Tests

**Livrable** — `back/src/reconnexion.integration.test.ts`, vraies sockets, décodage seul, modèle
`evenement.integration.test.ts` (`waitingRoom: true`, `START` de l'hôte, `envelopper(room, …)`
pour dater) :

1. **revenir en < grâce rend le même slot et le même build** : J1 et J2 en run ; J2 reçoit une carte
   (`room.grantCard`) ; sa socket se ferme ; J1 reçoit `PRESENCE(2, 0)` ; 300 ms plus tard le **même
   jeton** refait `HELLO` → `WELCOME.playerId === 2`, puis un `RESYNC` dont le bloc du joueur 2 porte
   la carte, et `room.loadoutOf(2)` est le même objet qu'avant ; J1 reçoit `PRESENCE(2, 1)` ;
2. **la horde est identique au pixel** : la horde est peuplée (directeur ou `room.horde.spawn`) ;
   à `envelopper`, au tick du `RESYNC`, on copie `room.horde` (`saveState`) ; le `RESYNC` décodé
   porte les mêmes identités dans le même ordre, et `x`, `y`, `vx`, `vy` **égaux bit à bit**
   (dérive 0,000 px, identités strictement égales — la formulation du README). Le test **imprime la
   taille** du `RESYNC` ;
3. **l'étalage ouvert est reçu** : `room.debugOweLevels(1)`, J1 et J2 reçoivent `DRAFT_OPEN` ; J2
   tombe pendant l'étalage ; revient → `RESYNC` bit 0 levé, mêmes cartes et même `deadlineTick` que
   le `DRAFT_OPEN` de J1 ; J2 envoie `DRAFT_TOKEN` → les `DRAFT_INTENTS` suivants le portent ;
4. **absent, il ne bouge pas et n'est pas visé** : J2 marche (`INPUT` répétés), sa socket se ferme ;
   sur 20 ticks `room.positionOf(2)` ne change pas, et `room.horde.aimX` ne contient que J1 ;
5. **après la grâce, c'est un nouveau joueur** (`graceMs: 300`) : J2 revient à 600 ms → slot 2 de
   nouveau (le plus petit libre), mais `room.loadoutOf(2)` est **neuf** (sans la carte) ;
6. **pendant la grâce, le salon est plein** : quatre joueurs, J4 tombe, un cinquième compte reçoit
   `ROOM_FULL` ;
7. **le compte absent est crédité** : quatre joueurs, J4 tombe, les trois autres votent « partir »
   dans la grâce (`voteExtraction` de `credit.integration.test.ts`) → `goldOf(J4) === 400n` ;
8. **la fenêtre de ping n'est pas héritée par le revenant** : trois pings, coupure, retour sur le
   même jeton, un quatrième ping passe (la contrepartie du test de l'étape 9) ;
9. **le dernier joueur qui tombe ne ferme pas le salon** : J1 seul, coupure, `room.tick` avance
   encore 300 ms plus tard, J1 revient avec son build ;
10. **le `SNAPSHOT` garde sa taille** (66 o à quatre), mesuré comme à l'étape 16.

Contre-épreuves attendues au bilan (chacune doit rougir) : `RESYNC` envoyé depuis `onFirst` (test
2 ou 3 voit une vague en double) ; historique omis (test 2 passe, un test de `client.test.ts` sur
300 ticks rougit) ; `#graces` oublié dans `#creditAccounts` (test 7) ; `#freeId` sans réservation
(test 6).

**Unitaires**, par tâche : `shared/protocol.test.ts` (aller-retour `RESYNC` exact sur les f32,
sections absentes = 0 o, tailles dérivées des constantes, `PRESENCE` 3 o) ; `back/src/draft.test.ts`
et `portal.test.ts` (`rejoin`) ; `back/src/room.test.ts` (`setAbsent` : entrées à zéro, hors
cibles, hors ramassage, étalage non tenu, `#checkRunOver`, `resyncState` miroir exact de la horde
et des loadouts) ; `back/src/server.test.ts` (slot réservé, `onEmpty` différé, `graceMs: 0`,
minuteurs effacés par `stop`) ; `shared/horde.test.ts` (`acknowledgeFields` : un
`spawnCatchingUp` après `update` ne lève plus) ; `front/src/net/client.test.ts` (un `GameClient`
qui reçoit `RESYNC` puis 300 ticks d'ordres suit une `Horde` de référence à 0,000 px ; files
vidées ; étalage, portail, événement, gel posés ; `PRESENCE`) ; `front/src/net/rejoin.test.ts`
(les deux fonctions pures de décision) ; `front/src/render/player-renderer.test.ts` (socle gris).

## 8. Risques et coût sur le fil

- **Sur le fil** : zéro octet par tick. `RESYNC` ≈ 31 Kio une fois (borne 127 Kio) ; `PRESENCE`
  3 o par changement. Rien dans la boucle.
- **`spawnCatchingUp` après `RESYNC`** : `Horde.#assertFieldsNotRefreshed` (l.1480-1495) lève si un
  champ a changé de révision depuis le dernier `step`. Le `RESYNC` appelle `update` sur les quatre
  champs **entre** deux `step` : le premier ordre en retard qui suit lèverait. D'où
  `Horde.acknowledgeFields(fields)`, qui réaligne `#lastFieldRevisions` (le miroir de l.1462-1468).
  Sans ce test unitaire, ça passe en jeu jusqu'au premier ordre en retard après une reconnexion.
- **Un absent pèse sur l'équipe** une minute (seuil de niveau, PV du boss, part des vagues via
  `#players.size`). Borné par la grâce ; si c'est trop en jeu, baisser `RECONNECT_GRACE_MS` est une
  ligne.
- **La horde en solo pendant l'absence** : sans cible, `retarget` ne reçoit aucune position ; les
  entités gardent leur dernière direction jusqu'au retour. Rien à faire : au retour, l'historique
  repart et le champ se recalcule.
- **Le même compte dans deux salons** : crédité par les deux s'ils finissent dans la minute. Déjà
  permis ; pas aggravé.
- **Marques et PV de la horde à zéro après `restoreState`** : la teinte élémentaire manque deux
  secondes chez le revenant. Assumé.
- **Le rechargement coûte une page** : ~1-2 s avec les actifs en cache, plus l'écran de chargement
  (`LOADING_MIN_MS`). Plus court que de déboguer un `GameClient` vidé à la main.
- **`sessionStorage` indisponible** (navigation privée stricte) : le `try/catch` existant autour du
  stockage s'applique ; sans mot, pas de reprise automatique, le joueur retape le code — et reprend
  quand même son slot, le serveur ne dépend pas du client pour ça.

## 9. Vérification manuelle (à la fin, par Léo)

- Couper le Wi-Fi 10 s en pleine horde, à deux : le socle de l'absent passe-t-il gris chez l'autre ?
  Au retour, la horde est-elle **la même** (aucun monstre qui saute) ? Le build est-il là (armes
  dans le HUD, passifs) ?
- Fermer l'onglet pendant un étalage, rouvrir l'URL : la carte est-elle encore proposée, et le
  jeton posable ?
- Idem pendant un portail : la carte compacte s'affiche-t-elle, gelée, avec le bon chrono ?
- Couper pendant un convoi : le chariot et la barre d'événement reprennent-ils au bon endroit ?
- Attendre plus d'une minute : revenir donne-t-il bien un joueur neuf, et les autres ont-ils vu le
  personnage disparaître ?
- Solo : couper 20 s, revenir — la run a-t-elle attendu, la horde est-elle immobile puis repart-elle
  proprement ?
- Le temps entre la coupure et la première image après retour : acceptable ?

## 10. Écarts assumés et questions ouvertes

- Pas de reprise du **bilan** pour un revenant après `RUN_OVER` (§1.7) : il voit « salon fermé » et
  son or à l'accueil.
- Pas d'annulation de grâce quand le compte rejoint un **autre** salon (§1.2).
- `RECONNECT_GRACE_MS = 60 s` est un jugement, pas une mesure : à régler au playtest.
- Le nombre d'entités et d'orbes à 10 min est une hypothèse : le livrable imprime la taille vraie.
