# Étape 16 — les événements bonus, deuxième fournée

## 0. Statut et place dans la suite

Suite directe de l'étape 14 (`docs/specs/2026-10-16-etape-14-evenements.md`, bilan
`docs/plans/2026-10-16-etape-14-resultats.md`) : son moteur d'événements est livré sur `main`, cette
étape lui ajoute **quatre événements** — *le siège*, *la relique*, *la chasse*, *le noir* — et ne
touche ni à la cadence ni à la récompense. Elle vient après l'étape 15 (progression,
`docs/plans/2026-10-19-etape-15-progression.md`), dont elle reprend l'échelle des PV de monstres
pour les proies (§5.3).

Le design a été validé par Léo avant d'écrire ; ce document le rend exact contre le code, il ne le
change pas. Là où le code oblige à préciser ou à dévier, c'est dit sur place (⚠️) et repris au §12.
Les numéros de ligne sont ceux de la branche `etape-15-progression` au 5 novembre 2026 (`a542989`).

- **Au plus un événement à la fois**, tiré au hasard parmi **sept** (les trois de l'étape 14 et les
  quatre d'ici), imposé, à la même cadence : 3ᵉ vague d'un palier, jamais avant la vague
  `EVENT_FIRST_WAVE` (20), au moins `EVENT_MIN_GAP_WAVES` (40) vagues après le précédent.
- **Même récompense** : un étalage d'équipe au plancher épique (`EVENT_RARITY_FLOOR`), même
  priorité coffre > événement > niveau (`room.ts` l.1355-1360, `#openDraft` l.2356-2384).
- **Le fil** : les trois messages de l'étape 14, **sans un octet de plus dans leur format**. Le
  porteur de la relique et celui de la lanterne voyagent dans l'octet « PV du chariot »
  d'`EVENT_STATE` ; le drapeau « solo » dans le bit haut de l'octet de genre d'`EVENT_START` (§7).
- **Un effet de rendu nouveau** : l'obscurité du noir, un `Graphics` troué d'un cercle de lumière
  (§9.4).

L'exécution se fera dans un worktree, sur un `main` qui contient l'étape 15.

## 1. Le livrable en une phrase

**Quatre nouveaux objectifs rejoignent le tirage — un totem à défendre, une relique à porter à
l'autel, des proies à abattre, une nuit à traverser autour d'une lanterne — et chacun, réussi,
ouvre le même étalage d'équipe au plancher épique.**

Vérifiable ainsi : sur deux vraies sockets, les deux clients reçoivent le même `EVENT_START` pour
chacun des quatre genres ; pour la relique, l'octet de porteur d'`EVENT_STATE` dit le même
identifiant chez les deux, le porteur avance à 60 % au serveur, **aucune salve n'est tirée pour lui
ni au serveur ni dans le miroir du `GameClient`** tant qu'il porte, et la livraison à l'autel donne
`EVENT_END` réussi puis `LEVEL_UP` puis `DRAFT_OPEN` épique ; pour le noir, un joueur hors de la
lumière perd 2 PV/s dans les `SNAPSHOT`, et la chute du porteur de lanterne donne `EVENT_END` en
échec. Le `SNAPSHOT` garde sa taille.

## 2. Le tirage : sept genres, même cadence

### 2.1 Le directeur ne change pas

Le directeur ne connaît pas le genre : il marque une **graine** à la 3ᵉ vague de palier
(`#marquerEvenement`, `back/src/wave-director.ts` l.383-394, appelé l.483 et l.520), dérivée de la
graine de l'ordre principal par le masque `0x2c9e_7d43`, sans `rng()` ni `waveId`. Les trois
constantes de cadence (`EVENT_WAVE_IN_PALIER` = 3, `EVENT_MIN_GAP_WAVES` = 40,
`EVENT_FIRST_WAVE` = 20, l.229-241) **ne bougent pas**. L'empreinte FNV du test des ordres
bit-identiques (étape 14 §9) ne bouge pas non plus : aucune ligne du directeur n'est touchée.

### 2.2 Le genre : `seed % 7`

Le genre se dérive dans `placeEvent` (`back/src/evenement.ts` l.210) : aujourd'hui
`const kind = seed % 3`. Il devient :

```ts
const kind = seed % EVENT_KIND_COUNT;
```

`shared/evenements.ts` (l.10-14) gagne quatre genres **après** les trois existants — l'index est
l'identifiant, et les trois premiers ne bougent pas :

| Constante | Valeur |
| --- | --- |
| `EVENT_KIND.SCEAUX` / `FORGE` / `CONVOI` | 0 / 1 / 2 (inchangés) |
| `EVENT_KIND.SIEGE` | **3** |
| `EVENT_KIND.RELIQUE` | **4** |
| `EVENT_KIND.CHASSE` | **5** |
| `EVENT_KIND.NOIR` | **6** |
| `EVENT_KIND_COUNT` | **7** |

Chaque genre sort avec une probabilité 1/7 (la graine est un `u32` uniforme ; le biais du modulo,
2³² mod 7 = 4 valeurs, est de l'ordre de 10⁻⁹). Aucun tirage de plus : c'est la même graine, lue
modulo 7 au lieu de 3. L'angle θ reste `((seed >>> 8) / 0x100_0000) × 2π` (l.211).

⚠️ **Trois aides de test lisent `graine % 3`** et passent à `% EVENT_KIND_COUNT` :
`back/src/evenement.test.ts` l.38-41, `back/src/evenement.integration.test.ts` l.38,
`back/src/room.test.ts` l.5920. Le test « le genre est graine % 3 » (`evenement.test.ts` l.111-113)
devient « graine % 7 ».

### 2.3 Ce que `placeEvent` reçoit en plus

`placeEvent(seed, vivants, obstacles)` (l.196) reçoit des vivants **avec leur identifiant** —
`readonly { id: number; x: number; y: number }[]`, que `PlayerState` satisfait (`room.ts` l.151) —
parce que le noir choisit un porteur de lanterne (§6.1). `EventPlan` (l.62-68) gagne :

| Champ | Rôle |
| --- | --- |
| `carrier: number` | noir : l'id du porteur de lanterne ; 0 sinon |

Points rendus par genre (les trois anciens inchangés) :

| Genre | Points | Placement |
| --- | --- | --- |
| Siège | 1 | le site S, posé par `poserGroupe` (l.147-182) comme la forge |
| Relique | 2 | la relique S, puis l'autel E = S + `RELIQUE_DISTANCE` (1 500 px) vers le centre de la carte — **exactement le chemin du convoi** (l.233-245), la condition `kind !== EVENT_KIND.CONVOI` (l.230) devenant `kind !== CONVOI && kind !== RELIQUE` |
| Chasse | 3, ou 2 en solo | l'anneau des sceaux (l.215-223) avec `CHASSE_SPACING` (1 200 px) au lieu de `SCEAUX_SPACING` et `CHASSE_PREY` / `CHASSE_PREY_SOLO` points au lieu de N : rayon `1200 / (2 sin(π/n))` = **693 px** pour 3, **600 px** pour 2 |
| Noir | **0** | aucun lieu : la lumière suit son porteur |

`poserGroupe` est réutilisé tel quel : ses seuils (déplacement ≤ `SCEAU_RADIUS`, paires >
`2 × SCEAU_RADIUS`) sont des garde-fous de géométrie, pas des règles de sceau, et valent pour
l'anneau des proies.

### 2.4 Le salon : ce qui change dans `#startEvent` et `#stepEvent`

`#startEvent` (`room.ts` l.2422-2438) passe les vivants avec leur id, et pour la chasse fait naître
les proies (§5.2) **avant** de construire `EventRun`, à qui il passe leurs identités.
`#stepEvent` (l.2449-2466) gagne deux choses :

- **un `EVENT_STATE` hors cadence** quand le porteur de la relique change (§7.3) ;
- **la nuit** : après `ev.step`, la perte de PV des joueurs hors de la lumière (§6.3).

Le reste — le sommeil pendant gel et rampe (`this.#tick <= this.#resumeEndTick`, l.2451), la
cadence de 6 ticks vivants, `EVENT_END` puis `#eventDraftsOwed++` à la réussite — est celui de
l'étape 14, mot pour mot.

`EventPlayer` (`back/src/evenement.ts` l.71-78) gagne `readonly id: number` ; `EventHorde`
(l.81-85) gagne `slotOf(id: number): number` — `Horde` le satisfait déjà (le salon s'en sert l.1755).

## 3. Le siège

Un convoi qui ne bouge pas : un totem apparaît, les ennemis qui le touchent l'abîment, l'équipe le
tient 45 s.

| Constante | Valeur | Où |
| --- | --- | --- |
| `TOTEM_RADIUS` | **28** px (corps dessiné) | `shared/evenements.ts` |
| `SIEGE_DEFEND_RADIUS` | **150** px (= l'escorte du convoi) | `shared/evenements.ts` |
| `SIEGE_HOLD_TICKS` | **1 350** (45 s) | `back/src/evenement.ts` |
| `SIEGE_HP` | **600** | `back/src/evenement.ts` |
| `SIEGE_HP_SOLO` | **1 200** | `back/src/evenement.ts` |
| `SIEGE_CONTACT_RADIUS` | `TOTEM_RADIUS + CONTACT_RADIUS / 2` = **45** px | `back/src/evenement.ts` |

**Les dégâts : ceux du convoi, sur un point fixe.** Le balayage de `#stepConvoi`
(`back/src/evenement.ts` l.411-425) — toutes les `CONTACT_INTERVAL_TICKS` (15) ticks vivants,
`min(n, CONVOI_MAX_HITTERS) × CONVOI_CONTACT_DAMAGE` (5 × 8 au plus) — sort dans une méthode privée
`#subirContact(x, y, rayon)` que le convoi et le siège appellent. Le totem est `points[0]` ; ses PV
réutilisent `#cartHp` / `cartHpMax` (l.257-259), posés à `SIEGE_HP` ou `SIEGE_HP_SOLO`. Noyé, un
totem de 600 PV tient 7,5 s ; à 1 200 en solo, 15 s. **Échoué** (`EVENT_OUTCOME.DETRUIT`) à 0 PV.

Les PV du totem **ne suivent pas le niveau** (étape 15) : ce qui l'abîme est le contact, et
`CONTACT_DAMAGE` (`shared/constants.ts` l.161) est fixe.

⚠️ **« Tenir 45 s » se lit « 45 s cumulées avec un défenseur à ≤ 150 px ».** Le design dit « tenir
45 s pendant que les ennemis qui le touchent l'abîment ». Mais la horde ne vise **que** les joueurs :
ses champs de flux s'enracinent sur leurs positions retardées (`room.ts` l.1418-1433,
`horde.retarget`), et le chariot de l'étape 14 « ne prend que ce qui le frôle » (§3.3 de sa spec).
Un totem qu'on n'a pas besoin d'approcher se gagne en **s'éloignant** : rien ne le touche, et
45 s de minuterie suffisent. Faire viser le totem par la horde coûterait un champ de flux de plus
**rejoué par chaque client** (`#fields` = un par joueur, `MAX_PLAYERS` = 4) et une date exacte de
son apparition que `EVENT_START`, non daté, ne donne pas. D'où la règle des sceaux et de la forge :
à chaque tick vivant, si **un** joueur vivant est à `SIEGE_DEFEND_RADIUS` ou moins du totem,
`held++` ; sinon la progression se suspend sans redescendre. Réussi à
`held >= SIEGE_HOLD_TICKS`, dans la fenêtre de 60 s (`EVENT_DURATION_TICKS`) — sinon
`EVENT_OUTCOME.EXPIRE`. La horde qui court vers les défenseurs frôle le totem : c'est le siège.

Solo : `SIEGE_HP_SOLO`, même rayon, même durée.

**Progression** : `held / SIEGE_HOLD_TICKS`.

## 4. La relique

Une relique apparaît ; un joueur la ramasse en marchant dessus et la porte à un autel à ~1 500 px.
Le porteur avance à 60 % et ne tire pas.

| Constante | Valeur | Où |
| --- | --- | --- |
| `RELIQUE_CARRIER_SPEED` | **0,6** | `shared/evenements.ts` (le client prédit avec) |
| `RELIQUE_CARRIER_SPEED_SOLO` | **0,8** | `shared/evenements.ts` |
| `RELIQUE_ALTAR_RADIUS` | **80** px | `shared/evenements.ts` (dessiné) |
| `RELIQUE_DISTANCE` | **1 500** px | `back/src/evenement.ts` |
| `RELIQUE_PICKUP_RADIUS` | **48** px | `back/src/evenement.ts` |

### 4.1 La règle

`EventRun` gagne `relic: EventPoint` (position serveur, posée sur `points[0]`) et
`carrier: number` (0 = au sol). À chaque tick vivant, dans cet ordre :

1. **Le porteur tombe ou part** : si `carrier !== 0` et que ce joueur n'est plus parmi les vivants
   (`hp <= 0`, ou absent après `Room#leave`, l.1235), `carrier = 0` — la relique **reste au sol** là
   où elle était, c'est-à-dire la dernière position du porteur.
2. **Ramassage** : si `carrier === 0`, le **premier** vivant, dans l'ordre d'itération de
   `#players`, à `RELIQUE_PICKUP_RADIUS` ou moins de la relique la prend : `carrier = p.id`.
3. **Elle suit** : si `carrier !== 0`, `relic = (round(p.x), round(p.y))` du porteur.
4. **Livraison** : si le porteur est à `RELIQUE_ALTAR_RADIUS` ou moins de l'autel `points[1]`,
   `EVENT_OUTCOME.REUSSI`.

Toute transition de `carrier` lève un drapeau lu une fois par le salon
(`takeCarrierChanged(): boolean`) — §7.3. Pas de passe entre joueurs, pas de lâcher volontaire.

**Échec** : 60 s écoulées sans livraison, `EVENT_OUTCOME.EXPIRE` — la chute du porteur n'en est pas
un. **Progression** : `1 − distance(relique, autel) / distance(S, autel)`, bornée à `[0, 1]`, comme
le convoi (l.300-311).

### 4.2 Le ralentissement et le silence, au serveur

`EventRun` expose deux lectures, qui ne valent que pour la relique :

```ts
/** La relique ralentit son porteur (`RELIQUE_CARRIER_SPEED`, ou `_SOLO`). 1 pour tout autre. */
speedFactorOf(id: number): number
/** Vrai si `id` porte la relique : il ne tire pas. */
holdsFire(id: number): boolean
```

- **Déplacement** (`room.ts` l.1386) :
  `const speed = (PLAYER_SPEED + p.loadout.bonus('speed') + p.accountBonuses.speed) * (this.#event?.speedFactorOf(p.id) ?? 1);`
  Le facteur multiplie la vitesse **entière**, cartes « fougue » comprises ; la poussée des gardiens
  (l.1408-1426) n'est pas ralentie, elle ne vient pas de l'entrée.
- **Tir** (`#fireWeapons`, l.2199-2214) : `if (this.#event?.holdsFire(p.id)) continue;` à côté du
  garde `p.hp <= 0`. Toutes les armes se taisent, halo et invocation compris — ils passent tous par
  `#fireOne`. `p.lastFireTick` reste figé ; à la livraison ou à la chute, la première salve part au
  premier tick où la recharge est faite, c'est-à-dire **tout de suite** si le port a duré plus
  qu'une recharge.
- **Le verbe de classe reste permis** : le design dit « ne tire pas ». Un porteur qui lance un
  Relais (`#relais`, l.960-990) se téléporte sur un allié à `RELAIS_RANGE`, relique comprise (elle
  suit, règle 3). Laissé au playtest (§11).

**L'ordre dans le tick** : `carrier` change dans `#stepEvent`, appelé en fin de `step` (l.1839),
**après** le déplacement (l.1384) et le tir (l.1563). Un ramassage au tick D ralentit et fait taire
à partir du tick **D + 1**. C'est cette date que le client reconstruit (§8).

Solo : `RELIQUE_CARRIER_SPEED_SOLO` — le client le sait par le drapeau solo d'`EVENT_START` (§7.1).

## 5. La chasse

Trois proies d'élite apparaissent à ~1 200 px l'une de l'autre ; les abattre toutes en 60 s.

| Constante | Valeur | Où |
| --- | --- | --- |
| `CHASSE_SPACING` | **1 200** px | `back/src/evenement.ts` |
| `CHASSE_PREY` | **3** | `back/src/evenement.ts` |
| `CHASSE_PREY_SOLO` | **2** | `back/src/evenement.ts` |
| `PROIE_NAME` | `'proie'` | `shared/archetypes.ts` |
| `PROIE_HP_MULTIPLE` | **8** → `PROIE_HP` = `HEAVY_HP × 8` = **160** au niveau 1 | `shared/archetypes.ts` |
| `PROIE_SPEED_FACTOR` | **0,75** de `PLAYER_SPEED` = **195** px/s | `shared/archetypes.ts` |
| `PROIE_BODY_SCALE` | **1,6** (comme le porteur) | `shared/archetypes.ts` |
| `PROIE_ARCHETYPE` | dérivé du nom, comme `PORTEUR_ARCHETYPE` (l.631) | `shared/archetypes.ts` |

### 5.1 L'archétype : un gnoll agrandi, la règle de fuite du porteur

Ajoutée **après** `PORTEUR` dans `ARCHETYPES` (`shared/archetypes.ts` l.571-575), pour qu'aucun
identifiant existant ne bouge — même discipline que le porteur (l.548-550) :

```ts
const PROIE = {
  name: PROIE_NAME,
  sheet: 'Gnoll/Gnoll_Walk.png',
  frames: 8,
  cell: 192,
  speed: Math.round(PLAYER_SPEED * PROIE_SPEED_FACTOR),
  role: 'troupe',
  behavior: 'proie',
};
```

`hpOf` (l.388-393) et `bodyScaleOf` (l.396-401) gagnent la branche `PROIE_NAME`. Rôle `troupe` :
armure 0, jamais tirée par le générateur (absente de `STEP2_ARCHETYPES`, l.591-594).

**Le comportement `'proie'`** rejoint `Behavior` (l.239-250) et **partage la règle du porteur**
dans la horde : `shared/horde.ts` l.710 devient `behavior === 'porteur' || behavior === 'proie'`,
et l.1120 de même. La proie attend loin de l'équipe et fuit le joueur le plus proche sous
`PORTEUR_FLEE_RADIUS` (400 px), sur les positions retardées du champ — **la règle déjà rejouée à
l'identique des deux côtés**, rien de neuf dans le chemin répliqué. Plus lente que le porteur
(195 contre 234 px/s), elle se rattrape à 65 px/s, et la plupart des armes portent au-delà de
400 px.

⚠️ **La fuite est un choix de cette spec**, le design ne disait que « des proies d'élite ». Sans
elle, trois élites marchent vers l'équipe et la « chasse » se joue à l'arrêt ; avec elle, c'est la
règle existante du porteur, sans une ligne de comportement nouvelle.

**Le sprite** : le gnoll est dans l'atlas (piétaille, 192 px). `HordeRenderer.adoptAtlas`
l'aliase comme il aliase le voleur pour le porteur (`front/src/render/horde-renderer.ts`
l.490-501) : trois lignes, `#runFrames`, `#attackFrames` (première image figée) et `sizesPx` de
`PROIE_ARCHETYPE` pris sur `archetypeIdOf('gnoll')`. Aucun actif nouveau sur MinIO.

### 5.2 La naissance : par `WAVE_ORDER`, sans tirage

Comme le porteur de l'étape 11 (`docs/specs/2026-10-15-etape-11-porteur.md`), les proies naissent
par un ordre de vague ordinaire, que les clients appliquent et rejouent sans savoir qu'il s'agit
d'un événement. Différence : le porteur est un ordre du **directeur** (`#avecPorteur`,
`wave-director.ts` l.349-374), alors que le genre n'est connu qu'au **salon** (§2.2). Le salon les
fait donc naître lui-même, par le chemin des petits du diviseur et du nécromancien : `#spawnAt`
(`room.ts` l.2567-2582), qui prend un `waveId` par `this.#director.allocWaveId()` — un compteur, pas
un `rng()`.

`#spawnAt` gagne un paramètre `spawnTick = this.#tick + 1` et rend `true` si l'entité est née.
⚠️ **`spawnTick` vaut `this.#tick` pour les proies**, pas `+ 1` : `#startEvent` est appelé juste
après la boucle des ordres (l.1526-1529), **avant** `horde.step` (l.1555) — exactement comme les
ordres du groupe, qui portent `spawnTick: tick`. Les petits du diviseur, eux, naissent après le pas
de horde, d'où leur `+ 1`.

```ts
const proies: number[] = [];
if (plan.kind === EVENT_KIND.CHASSE) {
  for (const p of plan.points) {
    const waveId = /* lu dans #spawnAt */;
    if (this.#spawnAt(p, PROIE_ARCHETYPE, 1, this.#tick)) {
      proies.push(entityIdOf(waveId, 0));
    }
  }
  if (proies.length === 0) {
    return; // horde pleine : pas d'evenement du tout, aucun message
  }
}
this.#event = new EventRun(plan, this.#convoiField, proies);
```

(`#spawnAt` rendra l'id de l'entité née, ou `null`, plutôt qu'un booléen : le plan d'exécution
tranchera la signature.) Les ordres partent par `#pendingOrders`, donc **avant** l'`EVENT_START` du
même envoi (`server.ts` l.518-520 puis l.564).

⚠️ **Les `waveId` qui suivent se décalent** de 2 ou 3, comme après un porteur ou un nécromancien.
Aucun `rng()` n'est consommé : les ordres du directeur restent bit-identiques, `waveId` à part.

### 5.3 Les PV : l'échelle de l'étape 15

`#spawnAt` appelle déjà `#scaleMonsterHp(before)` (l.2581, corps l.1992-1997) : la proie prend
`monsterHp(PROIE_HP, niveau)` = 160 × 1,10^(niveau − 1) (`shared/paliers.ts` l.65-84), **le chemin
du porteur** (étape 15 §2 : « tout le monde monte, boss et porteur compris »). Au niveau 10, vers
le premier événement : ≈ 377 PV. **Pas** de facteur par joueur (contrairement au boss,
`bossHp`) : l'équipe a une proie de plus que le solo, c'est l'échelle.

### 5.4 La règle

`EventRun` retient les identités des proies nées. À chaque tick vivant : une proie dont
`horde.slotOf(id) < 0` est **tombée** — morte dans le lot unique du tick, ou retirée (bancs,
tests). Réussi quand toutes le sont ; sinon `EVENT_OUTCOME.EXPIRE` à 60 s. **Progression** :
`tombées / nées`.

Les proies survivantes à l'expiration **restent dans la horde** : seule une mort les retire, et une
mort hors du lot unique casserait le rejeu (`room.ts` l.1692-1705). Elles continuent de fuir et se
tuent comme n'importe quelle élite, sans récompense d'événement.

Solo : `CHASSE_PREY_SOLO` = 2 proies, à 1 200 px l'une de l'autre.

## 6. Le noir

La carte s'assombrit ; un joueur tiré au sort porte la lanterne ; tenir 40 s ; hors de la lumière
on perd 2 PV/s ; la chute du porteur de lanterne fait échouer.

| Constante | Valeur | Où |
| --- | --- | --- |
| `NOIR_LIGHT_RADIUS` | **350** px | `shared/evenements.ts` |
| `NOIR_LIGHT_RADIUS_SOLO` | **500** px | `shared/evenements.ts` |
| `NOIR_HOLD_TICKS` | **1 200** (40 s) | `back/src/evenement.ts` |
| `NOIR_DRAIN_PER_SEC` | **2** PV/s | `back/src/evenement.ts` |

### 6.1 Le porteur de lanterne : tiré de la graine

Aucun tirage : `placeEvent` le dérive de la même fraction que l'angle θ (l.211), inutilisé par le
noir puisqu'il n'a pas de lieu :

```ts
carrier = vivants[Math.floor(((seed >>> 8) / 0x100_0000) * vivants.length)].id;
```

Figé pour tout l'événement. Solo : le seul vivant.

### 6.2 La règle

À chaque tick vivant : si le porteur de lanterne n'est plus parmi les vivants (mort, ou parti),
**`EVENT_OUTCOME.DETRUIT`**. Sinon, réussi à `elapsed >= NOIR_HOLD_TICKS` — 40 s, dans la fenêtre
de 60 : le noir ne peut pas expirer. **Progression** : `elapsed / NOIR_HOLD_TICKS`.

### 6.3 La perte de PV, au serveur seul

Dans `#stepEvent`, **après** `ev.step` et seulement si l'événement continue, hors solo :

```ts
for (const p of this.#players.values()) {
  if (p.hp > 0 && ev.inDark(p)) {
    p.hp = Math.max(0, p.hp - NOIR_DRAIN_PER_SEC / TICK_HZ);
  }
}
```

`inDark(p)` : distance au porteur de lanterne `> NOIR_LIGHT_RADIUS`. Le porteur est toujours dans
sa lumière.

⚠️ **Une soustraction directe, pas `hurtPlayer`** (`back/src/combat.ts` l.70-82), sur le modèle
de `#regenerate` (`room.ts` l.2720-2731) qui écrit `p.hp` fractionnaire : l'obscurité n'est pas un
coup. Par `hurtPlayer`, l'armure la réduirait, le bouclier l'absorberait, et surtout
`shieldCalmTicks` serait remis à zéro **à chaque tick** — le bouclier de Transcendance ne se
rechargerait jamais dans le noir. Les cartes « regain » la compensent, c'est voulu.
`encodeSnapshot` tronque `hp` en `u16` : le client voit la perte par pas d'un PV.

**L'ordre** : `#stepEvent` vient après `resolveContact` et `#regenerate` (l.1789-1790) et avant
`#checkRunOver` (l.1840) — un joueur achevé par le noir est vu mort au même tick. À 100 PV et
2 PV/s, l'obscurité seule tue en 50 s : plus que les 40 s de l'événement.

Solo : `NOIR_LIGHT_RADIUS_SOLO`, **aucune perte** — le seul joueur porte la lanterne de toute
façon ; reste l'obscurité, qui cache la horde.

## 7. Le fil

### 7.1 `EVENT_START` : le bit solo

Format inchangé (`shared/protocol.ts` l.1842-1856 et l.1877-1893) : type `u8` · genre `u8` ·
durée `u16` · n `u8` · n × (x `int16`, y `int16`). Le genre tient sur 3 bits (0-6) : **le bit 7 de
l'octet de genre porte « solo »**.

| Constante (`shared/evenements.ts`) | Valeur |
| --- | --- |
| `EVENT_SOLO_FLAG` | **0x80** |

`EventStartMessage` (l.1805-1811) gagne `solo: boolean` ; l'encodeur écrit
`msg.kind | (msg.solo ? EVENT_SOLO_FLAG : 0)`, le décodeur rend `kind = b & 0x7f` et
`solo = (b & EVENT_SOLO_FLAG) !== 0`. `#startEvent` le remplit depuis `plan.solo`.

⚠️ **Pourquoi le client doit savoir « solo »** : `EventPlan.solo` « reste ici », au serveur
(`back/src/evenement.ts` l.61-67), parce que l'étape 14 n'en avait pas besoin au client. Ici, il
prédit la vitesse du porteur (0,6 ou 0,8) et dessine la lumière (350 ou 500 px). Le déduire des
vivants du `SNAPSHOT` à la réception se tromperait au tick où un joueur tombe. Zéro octet.

| Genre | n | Taille |
| --- | --- | --- |
| Siège | 1 (le totem) | 9 o |
| Relique | 2 (la relique, l'autel) | 13 o |
| Chasse | 3, ou 2 en solo (les lieux de naissance) | 17 / 13 o |
| Noir | **0** | 5 o |

Le décodeur accepte déjà n = 0 (`viewOf(buf, 5 + 0)`).

### 7.2 `EVENT_STATE` : les mêmes 7 octets, lus selon le genre

Format inchangé (l.1857-1867) : type `u8` · progression `u8` · x `int16` · y `int16` · octet 6
`u8`. L'octet 6, « PV du chariot » à l'étape 14, devient **l'octet d'état**, lu selon le genre que
le client tient depuis `EVENT_START` :

| Genre | progression | x, y | octet 6 |
| --- | --- | --- | --- |
| Sceaux, forge | `held / hold` | 0, 0 | 0 |
| Convoi | trajet | le chariot | `ceil(255 × pv / pvMax)` |
| **Siège** | `held / SIEGE_HOLD_TICKS` | 0, 0 | **`ceil(255 × pv / pvMax)` du totem** |
| **Relique** | `1 − d(relique, autel) / d(S, autel)` | **la relique** | **l'id du porteur, 0 au sol** |
| **Chasse** | `tombées / nées` | 0, 0 | 0 |
| **Noir** | `elapsed / NOIR_HOLD_TICKS` | 0, 0 | **l'id du porteur de lanterne** |

Les identifiants de joueur valent 1 à `MAX_PLAYERS` (`server.ts` `#freeId`, l.629-634) : 0 est
libre pour « au sol », et la borne `[0, 255]` de l'encodeur (l.1866) les laisse passer intacts.
`EventRun.wireState()` (`back/src/evenement.ts` l.333-341) rend ces valeurs ; le champ garde son
nom `cartHp` dans `EventStateMessage`, sa doc dit les trois lectures.

### 7.3 Un état hors cadence quand le porteur change

`#stepEvent` pousse un `EVENT_STATE` quand `ev.elapsed % EVENT_STATE_PERIOD_TICKS === 0` **ou**
quand `ev.takeCarrierChanged()` est vrai (relique seulement). Le **format** ne gagne rien ; un
ramassage ou une chute coûte un message de 7 o de plus, quelques fois par événement. C'est ce qui
permet au client de **dater** le changement au tick près (§8.1) — à la cadence seule, il
l'apprendrait jusqu'à 5 ticks en retard.

Le noir n'en a pas besoin : son porteur ne change pas, le client l'apprend au premier
`EVENT_STATE` (6 ticks vivants après le départ) et l'obscurité met `NOIR_FADE_MS` à tomber (§9.4).

### 7.4 `EVENT_END` : inchangé

`EVENT_OUTCOME` garde ses trois valeurs. Le bandeau de fin se choisit au client par **(genre,
issue)** : le genre est lu dans le miroir **avant** de l'effacer (`client.ts` l.2037). Un client
sans miroir (arrivé en cours d'événement) retombe sur le texte par issue.

### 7.5 Le coût

| | Par client |
| --- | --- |
| `EVENT_STATE` | 35 o/s pendant l'événement, comme à l'étape 14 ; + 7 o par changement de porteur de relique |
| `EVENT_START` | 5 à 17 o, une fois |
| `SNAPSHOT` | **inchangé** |

## 8. La relique au client : prédiction et tir

### 8.1 Dater le porteur sans octet

L'`EVENT_STATE` part **avant** le `SNAPSHOT` du même envoi (`server.ts` l.564 puis l.622), et un
envoi suit un pas de simulation (`FixedStepAccumulator`, l.144-160). Un changement de porteur
survenu dans le `#stepEvent` du tick D arrive donc juste avant le `SNAPSHOT` daté D.

Le miroir (`EventMirror`, `client.ts` l.282-292) gagne :

| Champ | Rôle |
| --- | --- |
| `solo` | lu dans `EVENT_START` |
| `carrier`, `carrierPrev` | l'id courant et le précédent (0 = aucun) |
| `carrierFromTick` | le tick à partir duquel `carrier` vaut |
| `carrierPending: number \| null` | l'octet du dernier `EVENT_STATE`, en attente de sa date |
| `startedAtMs` | horloge murale du départ (fondu du noir, §9.4) |

À l'`EVENT_STATE` (`#onEvent`, l.2024-2035) d'une relique ou d'un noir : si l'octet diffère de
`carrier`, `carrierPending = octet`. Au `SNAPSHOT` suivant (l.2458 et suivantes), si
`carrierPending !== null` : `carrierPrev = carrier`, `carrier = carrierPending`,
`carrierFromTick = msg.tick + 1`, `carrierPending = null`. Le porteur au tick t est :

```ts
#relicCarrierAt(tick: number): number  // ev.kind === RELIQUE ? (tick >= carrierFromTick ? carrier : carrierPrev) : 0
```

⚠️ **D + 1, pas D** : le serveur a tiré et bougé au tick D **avant** le changement (§4.2).

⚠️ **Exact quand un pas précède un envoi**, le cas nominal. Sous rattrapage (jusqu'à
`MAX_CATCH_UP_STEPS` = 5 pas pour un envoi, `server.ts` l.56), le changement d'un pas antérieur
est daté du dernier : jusqu'à 4 ticks de retard, rare et borné.

### 8.2 La vitesse prédite : tolérer la correction

`#localSpeed()` (`client.ts` l.2197-2203) multiplie son résultat par
`RELIQUE_CARRIER_SPEED[_SOLO]` quand `#relicCarrierAt(this.#lastHordeTick) === this.#localId`.

**Le choix : tolérer la correction, pas la prévenir.** La prédiction de ce dépôt ne rejoue pas les
entrées : à chaque `SNAPSHOT`, `PredictedPlayer.reconcile` adopte la position serveur et range
l'écart dans `#errorX/Y`, qui s'éteint en `RECONCILE_TAU_MS` = 33 ms (`prediction.ts` l.131-136,
l.125-127 ; appelé `client.ts` l.2495, à `SNAPSHOT_HZ` = 30). Une vitesse prédite fausse ne
s'accumule donc **jamais au-delà d'un intervalle de snapshot** : au pire
`(1 − 0,6) × 260 px/s × 1/30 s` ≈ **3,5 px** par snapshot, résorbés en 33 ms — sous le seuil de
ce que la réconciliation corrige déjà pour la latence d'entrée. Lire le porteur « au même tick »
exigerait que le client décide lui-même du ramassage (positions des autres joueurs à ±1 px, ordre
des ex æquo) : une seconde autorité pour 3,5 px.

Le facteur n'entre que dans `speed` ; le `scale` de la rampe (`#movementScale`, l.2113) reste à
part, comme au serveur.

### 8.3 Le tir : le même garde, à la même date

`GameClient#fireWeapons` (l.3041-3063), miroir cosmétique de `Room#fireWeapons` — les dégâts
restent au serveur, la horde se dérive de `DEATHS` (l.3026-3027) — gagne le garde du serveur :

```ts
if (p.id === this.#relicCarrierAt(tick)) {
  continue;
}
```

`tick` est le tick de horde du pas en cours (l.2623). Comme le tick de horde suit le dernier
`SNAPSHOT` à `HORDE_TICK_LAG_TOLERANCE` = 1 près (l.205, l.2468-2470), la date D + 1 arrive en
général **avant** que le client ne simule D + 1 : le miroir se tait au même tick que le serveur, et
reprend au même tick.

**Quand la date arrive en retard** (client déjà au-delà de D + 1) :

- **au ramassage**, le client a pu dessiner une salve de trop entre D + 1 et la réception. Les
  projectiles ne sont pas rejoués (l.2619-2621) : elle reste à l'écran jusqu'à sa fin de vie,
  cosmétique, sans dégât ;
- **à la livraison ou à la chute**, le serveur a tiré à D + 1 (recharge faite) ; le client, qui
  croyait encore au port, non. Pour ne pas garder une phase décalée pour le reste de la run
  (le défaut que `client.ts` l.3074-3078 nomme déjà), à l'application de la date le client
  **recale** `#lastFireTick` de l'ancien porteur : pour chaque arme dont la recharge était faite à
  D + 1, `last[w] = D + 1` — la salve que le serveur a tirée, non dessinée. Les salves suivantes
  tombent alors aux mêmes ticks des deux côtés.

Pour le recalage, la recharge sort dans `shared/firing.ts` :

```ts
export function fireCooldown(loadout: Loadout, weaponId: number, accountFireRate: number): number
```

— l'expression aujourd'hui écrite deux fois (`room.ts` l.2225-2230, `client.ts` l.3096-3101).
Pour un allié, le client lui passe ses propres bonus de compte, la même approximation que
`#fireOne` aujourd'hui (l.3094-3101).

## 9. L'affichage

### 9.1 Ce que tient le client

`EventView` (`client.ts` l.265-279) gagne :

| Champ | Rôle |
| --- | --- |
| `solo` | §7.1 |
| `carrierId` | relique : le porteur au tick de horde courant (0 au sol) ; noir : la lanterne |
| `relic` | relique au sol : la position interpolée (le `#cartAt` du chariot, l.2047) ; `null` portée ou hors relique |
| `targets` | les cibles des flèches de bord (§9.3) |

Bandeaux (`EVENT_START_BANNERS`, l.251-255, étendu aux genres 3-6) :

| Moment | Texte |
| --- | --- |
| départ, siège | « Un totem appelle ses défenseurs ! » |
| départ, relique | « Une relique attend son porteur ! » |
| départ, chasse | « Des proies rôdent ! » |
| départ, noir | « La nuit tombe ! » |
| détruit, siège | « Le totem est tombé… » |
| détruit, noir | « La lanterne s'éteint… » |
| expiré, tout genre | « L'événement s'éteint… » (inchangé) |
| réussi, tout genre | « Réussi — étalage de règles ! » (inchangé) |

HUD (`EVENT_NAMES` et `eventStatusText`, `front/src/ui/hud.ts` l.213-227) :
« Le siège — 62 % — totem 70 % — 0:41 », « La relique — 40 % — 0:33 »,
« La chasse — 1 / 3 — 0:41 » (`round(progress × n)` sur n = `points.length`, exact puisque
`floor(255 k / n) / 255 × n` s'arrondit à k pour n ≤ 3), « Le noir — 55 % — 0:18 ».

Son : le même `'evenement'` au départ (`audio.ts` l.99-100), rien de neuf.

### 9.2 Au sol (`behavior-renderer.ts`)

`eventShapes` (l.166-215) gagne les formes ci-dessous, et prend des joueurs **avec leur id**
(`RenderState.players` le porte déjà) pour poser la relique sur son porteur. Le trait pointillé et
la barre de PV du chariot (`drawCart`, l.231-248) sortent en deux aides, `dashedCircle` et
`hpBar`, réutilisées par le totem.

| Forme | Dessin |
| --- | --- |
| totem | cercle pointillé de `SIEGE_DEFEND_RADIUS` à 25 % (comme l'escorte), anneau de progression autour (`progressRing`, l.218-228), un pilier de 24 × 56 px gris `0x8a8f99` contouré `CHEST_BROWN` coiffé d'un losange or, `hpBar` au-dessus |
| relique | un losange or `COIN_TINT` de 14 px dans un halo à 30 % ; au sol à `relic`, sinon **au-dessus du porteur dessiné** (y − 48) — sa position prédite si c'est soi, interpolée sinon, jamais en retard de 200 ms |
| autel | disque de `RELIQUE_ALTAR_RADIUS` rempli or à 12 %, trait de 3 px, `progressRing` |
| proie | dans **`behaviorShapes`** (l.74-139), à côté du porteur (l.114-117) : un anneau rouge `PROIE_RED` = `0xe0352b` de `PROIE_RING_RADIUS` = **46** px, rempli à 15 %, trait de 4 px — en permanence, comme celui du porteur ; `'proie'` rejoint la liste des comportements dessinés (l.85-92) |

### 9.3 Les flèches de bord

`PingRenderer.draw` (`ping-renderer.ts` l.146-201) remplace sa branche d'événement (l.188-200) par
une boucle sur `event.targets`, flèche or `COIN_TINT` comme aujourd'hui. `targets` se calcule dans
le getter `event` (`client.ts` l.1900-1913), où le client a tout :

| Genre | Cibles |
| --- | --- |
| sceaux, forge | `points` (inchangé) |
| convoi | le chariot (inchangé) |
| siège | le totem |
| relique | au sol : la relique ; portée : **l'autel** |
| chasse | les proies vivantes de la horde du client (balayage de `horde.archetype` pour `PROIE_ARCHETYPE`, une fois par image, comme `behaviorShapes`) |
| noir | le porteur de lanterne, position du dernier `SNAPSHOT` ; rien si c'est soi |

### 9.4 Le noir : un `Graphics` troué

**Un calque nouveau, `DarknessRenderer`** (`front/src/render/darkness-renderer.ts`), sur le
patron des calques procéduraux : `attach`, `load`, `loaded`, `draw`. Une fonction **pure**
`darknessHole(event, players)` rend `{ x, y, radius } | null` (le porteur de lanterne **dessiné**
— prédit si c'est soi — et le rayon solo ou non), c'est elle que les tests lisent.

Le dessin, chaque image, dans un seul `Graphics` en coordonnées **monde** :

```ts
g.clear();
g.rect(view.x - M, view.y - M, view.width + 2 * M, view.height + 2 * M)
  .fill({ color: 0x05040a, alpha: a });
g.circle(x, y, r + NOIR_FEATHER_PX).cut();
for (let k = 0; k < 4; k++) {
  // quatre anneaux du bord vers le centre, alpha decroissant : un bord doux
  g.circle(x, y, r + ((k + 1) * NOIR_FEATHER_PX) / 4).fill({ color: 0x05040a, alpha: a * (1 - (k + 1) / 5) });
  g.circle(x, y, r + (k * NOIR_FEATHER_PX) / 4).cut();
}
```

| Constante (`darkness-renderer.ts`) | Valeur |
| --- | --- |
| `NOIR_DARK_ALPHA` | **0,9** |
| `NOIR_FEATHER_PX` | **80** |
| `NOIR_FADE_MS` | **800** (`a` monte de 0 à `NOIR_DARK_ALPHA` depuis `startedAtMs`) |

`cut()` est l'API de trou de Pixi 8 (`pixi.js` 8.20, `front/package.json` l.20) : **ni filtre, ni
masque, ni `RenderTexture`** — une douzaine de primitives par image, le coût du chariot. Dans le
monde, le cercle subit l'écrasement vertical (`VERTICAL_SQUASH`, `stage.ts` l.66) comme toutes les
formes au sol : une ellipse, cohérente avec les sceaux. Sans porteur connu (premier état pas encore
reçu) : rien n'est dessiné, le fondu commence à la réception. Porteur introuvable (mort) : tout
noir, jusqu'à l'`EVENT_END` du même envoi.

**Sa place dans le z-order** (`Stage.#layers`, `stage.ts` l.143-170) : **après `#bossBar`, avant
`#pings`**, et dans `#procedural` (l.181-196).

- **Sous lui** : zones, horde, projectiles, flashs, barre du boss — la menace disparaît, c'est
  l'effet.
- **Au-dessus de lui, dans le monde** : les marqueurs de ping et les chiffres de dégâts (calques
  suivants), puis **les joueurs** — `#depth` et `#ghosts` sont ajoutés **après** tous les calques
  (`stage.ts` l.219-223) : chacun voit son personnage et ses alliés à l'écran, même dans le noir.
  Les arbres, qui vivent dans `#depth` avec les joueurs, restent aussi visibles : le tri par les
  pieds ne se sépare pas pour un effet.
- **Au-dessus de tout** : les **flèches de bord des alliés**, dessinées sur un `Graphics` écran
  attaché à `app.stage` après `#world` (`stage.ts` l.211-214, `ping-renderer.ts` l.135-137). Un
  joueur dans le noir les garde, comme le design l'exige — sans une ligne de plus.

`Stage.drawDarkness(event, players)` et son appel dans `composeFrame` (`frame.ts`, à côté de
`drawBehaviors`, l.297-302).

**La mini-carte** trahirait la horde : pendant le noir, `main.ts` l.713-716 lui passe
`enemies: { count: 0, … }` au lieu de `client.horde`. Une condition.

## 10. Ce qui ne bouge pas, et ce qui n'est PAS dans cette étape

Ne bougent pas : le directeur (§2.1) ; la cadence ; la récompense, son plancher et sa priorité ; le
format des trois messages ; le `SNAPSHOT` ; la horde répliquée, sauf l'archétype `proie` qui
emprunte une règle existante (§5.1).

Hors de l'étape :

- **Le marchand** (§10 de l'orientation) ;
- **les affixes de boss** ;
- **le réglage de fréquence par événement** : sept genres équiprobables ;
- une horde qui vise le totem ou la relique (§3, §12) ;
- passer la relique, la lâcher volontairement ;
- des proies retirées à l'expiration (§5.4) ;
- le rattrapage d'un client arrivé en cours d'événement (inchangé depuis l'étape 14).

## 11. Les tests et le livrable

| Où | Quoi |
| --- | --- |
| `shared/protocol.test.ts` | `EVENT_START` : aller-retour de `solo` vrai et faux pour les sept genres, l'octet de genre vaut `kind \| 0x80` en solo ; n = 0 (noir) fait 5 o ; tailles 9, 13, 17 |
| `shared/archetypes.test.ts` | `PROIE_ARCHETYPE` vient après `PORTEUR_ARCHETYPE` ; les ids existants n'ont pas bougé ; PV 160, vitesse 195, absent de `STEP2_ARCHETYPES` |
| `shared/horde.test.ts` | une proie attend hors de `PORTEUR_FLEE_RADIUS` et fuit dedans, à sa vitesse ; rejouée à l'identique (le scénario du porteur, archétype changé) |
| `shared/firing.test.ts` | `fireCooldown` rend ce que `Room#fireOne` calculait |
| `back/src/evenement.test.ts` | genre = graine % 7 ; **siège** : un défenseur fait monter, personne suspend, 5 ennemis collés coûtent 40 PV par 15 ticks, détruit à 0, 1 200 PV en solo, réussi à 1 350 ticks tenus ; **relique** : ramassage à 48 px par le premier vivant, la relique suit, la mort du porteur la laisse au sol à sa dernière position, un autre la reprend, livraison à 80 px de l'autel, `speedFactorOf` 0,6 / 0,8 solo / 1 pour les autres, `holdsFire`, `takeCarrierChanged` vrai une fois par transition ; **chasse** : 3 points à 1 200 px (2 en solo), réussi quand toutes les proies ont `slotOf < 0`, expirée sinon ; **noir** : le porteur dérivé de la graine sans tirage, détruit à sa mort, réussi à 1 200 ticks, `inDark` à 351 px et pas à 350 |
| `back/src/room.test.ts` | relique : le porteur avance à 0,6 × sa vitesse (cartes fougue comprises) dès le tick D + 1, **aucune salve** (ni projectile, ni pulsation de halo) tant qu'il porte, la première salve au tick qui suit la livraison ; un `EVENT_STATE` hors cadence au ramassage ; chasse : 3 `WAVE_ORDER` de `PROIE_ARCHETYPE` au `spawnTick` du tick courant, PV `monsterHp(160, niveau)`, aucune proie née → aucun message ; noir : −2 PV/s hors lumière, rien dans la lumière ni en solo, bouclier non entamé ; siège : progression suspendue sans défenseur |
| `back/src/evenement.integration.test.ts` | **le livrable** : deux vraies sockets ; pour chacun des quatre genres, même `EVENT_START` (genre, solo, points) chez les deux ; **relique** : même octet de porteur chez les deux, le `GameClient` du porteur ne tire aucune salve pour lui à partir de `carrierFromTick`, la livraison donne `EVENT_END` réussi → `LEVEL_UP` → `DRAFT_OPEN` épique et `draftIsEvent` ; **noir** : PV du joueur hors lumière qui baissent dans les `SNAPSHOT`, mort du porteur → `EVENT_END` détruit, aucun étalage ; `SNAPSHOT` de même taille |
| `front/src/net/client.test.ts` (ou `evenement.test.ts`) | un `EVENT_STATE` de relique puis un `SNAPSHOT` daté D donnent `carrierFromTick` = D + 1 ; `#relicCarrierAt` avant / après ; `#localSpeed` × 0,6 pour soi porteur, × 0,8 en solo ; recalage de `#lastFireTick` à D + 1 quand la date arrive en retard ; bandeau de fin par (genre, issue) |
| `front/src/net/prediction.test.ts` | une vitesse prédite de 260 contre 156 au serveur : l'écart après un `reconcile` reste sous 4 px et s'éteint |
| `front/src/render/behavior-renderer.test.ts` | `eventShapes` : totem et sa barre, autel, relique au sol puis au-dessus du porteur dessiné ; `behaviorShapes` : un anneau rouge par proie |
| `front/src/render/darkness-renderer.test.ts` | `darknessHole` : centré sur le porteur dessiné, rayon 350 / 500 solo, `null` hors noir ; le calque est entre `#bossBar` et `#pings` (`stage.test.ts`) |
| `front/src/render/ping-renderer.test.ts` | flèche vers l'autel quand la relique est portée, vers chaque proie hors champ, vers le porteur de lanterne |
| `front/src/ui/hud.test.ts` | les quatre textes d'état |

**Vérification manuelle**, ouverte jusqu'au playtest :

- les quatre événements se lisent-ils d'un coup d'œil (totem, relique, anneau rouge, nuit) ?
- **le siège** : 45 s cumulées dans 60, avec ~5 s de marche — tenable ? 600 PV, trop ou pas assez ?
  La présence exigée à 150 px (§3) rend-elle bien le « siège » ?
- **la relique** : 1 500 px à 156 px/s, c'est ~10 s de marche pure ; le porteur muet est-il
  protégé par l'équipe ou abandonné ? Le Relais d'un porteur (téléportation avec la relique) :
  astuce d'équipe ou triche ?
- **la chasse** : des proies qui fuient à 195 px/s, 160 PV au niveau 1 (≈ 377 au niveau 10),
  trois en 60 s — rythme juste ? Les proies survivantes qui restent dans la horde gênent-elles ?
- **le noir** : 0,9 d'obscurité, est-ce lisible sans être frustrant ? Les arbres visibles dans le
  noir se remarquent-ils ? 2 PV/s pousse-t-il à rester groupé ? Les chiffres de dégâts au-dessus
  du noir trahissent-ils trop la horde ?
- sept genres équiprobables : un genre revient-il trop souvent pour son intérêt ?

## 12. Risques

- **Le siège demande la présence, le design ne le disait pas** (§3). Sans elle, s'éloigner du
  totem le gagne ; faire viser le totem par la horde coûterait un champ de flux rejoué par chaque
  client et une date d'apparition absente du fil.
- **La date du porteur repose sur l'ordre d'envoi** (`EVENT_STATE` avant `SNAPSHOT`, `server.ts`
  l.564 et l.622). Si cet ordre changeait, la date glisserait d'un envoi : le recalage de §8.3 en
  limite l'effet à une salve cosmétique, mais un test (§11) tient l'ordre.
- **Une salve de trop au ramassage** quand la date arrive après que le client a simulé D + 1 :
  cosmétique, jamais de dégât (la horde vient de `DEATHS`).
- **La prédiction du porteur** se trompe de ≤ 3,5 px par snapshot pendant ~200 ms + latence autour
  d'un ramassage : sous ce que la réconciliation corrige déjà.
- **Le bit solo** occupe le bit haut de l'octet de genre : 127 genres au plus, large.
- **Les `waveId` décalés par les proies** : comme le porteur et le nécromancien ; un test à
  empreinte de salon (pas de directeur) qui ferait naître une chasse devra relever la sienne.
- **Les proies d'une chasse ratée** restent dans la horde, anneau rouge compris, jusqu'à leur mort :
  un leurre de récompense. Les retirer exigerait une mort hors du lot unique du tick, ce que le
  rejeu interdit.
- **Le noir n'est pas un brouillard de guerre** : la horde reste dans la mémoire du client, et un
  client modifié la verrait. Coopératif, sans enjeu compétitif : assumé.
- **`cut()` de Pixi 8** : un trou par primitive ; si un pilote rend mal les trous imbriqués du bord
  doux, le repli est un seul trou net (`NOIR_FEATHER_PX` = 0), sans autre changement.
- **Le noir en solo** n'enlève aucun PV : c'est un événement de visibilité seule, plus facile que
  les autres — voulu par le design.
