# Étape 11 — le porteur de coffre

## 0. Statut et place dans la suite

Troisième des quatre étapes décidées le 15 octobre 2026 (roue de ping, rareté et passifs, **élites à
coffre**, événements bonus). Le design a été validé par Léo avant d'écrire ; ce document le rend
exact contre le code, il ne le change pas. Là où le code oblige à préciser ou à dévier, c'est dit
sur place (⚠️) et repris au §8.

- **Un porteur par palier**, pendant la 2ᵉ vague du palier, à ~1 500 px de l'équipe.
- **Zéro message nouveau** : il arrive par l'ordre de vague existant, une vague d'un seul ennemi.
- **Il fuit** le joueur le plus proche à moins de 400 px, un peu moins vite qu'un joueur. Seul,
  c'est dur ; à deux, en tenaille, il se prend — c'est **la battue** du §10 de l'orientation.
- **Sa mort ouvre un étalage d'équipe**, mêmes règles qu'une montée de niveau (gel, jetons,
  conflits), dont toutes les cartes sont **au moins rares** : le plancher de rareté que l'étape 10
  renvoyait ici (§2.3 de `2026-10-15-etape-10-rarete.md`).

Elle réalise le levier 4 du §8 de l'orientation (`docs/specs/2026-08-19-coop-survivors-orientation.md`
l.612) sous sa forme la plus petite — *« objectif exigeant au moins deux joueurs, récompense
d'équipe »* — et ouvre le premier étalage hors montée de niveau, que l'étape 12 réutilisera.

L'exécution se fera dans un worktree, comme les étapes 9 et 10.

## 1. Le livrable en une phrase

**Une fois par palier, un porteur de coffre doré apparaît loin de l'équipe et la fuit ; l'abattre
ouvre un étalage d'équipe dont toutes les cartes sont rares ou légendaires.**

Vérifiable ainsi : sur deux vraies sockets, l'ordre de vague du porteur arrive aux deux clients,
sa mort leur ouvre un `DRAFT_OPEN` dont chaque carte porte une rareté ≥ rare, et chaque client sait
que cet étalage est un coffre **sans un octet de plus** — ni message, ni champ, ni octet par tick.

## 2. L'apparition

### 2.1 Quand : la 2ᵉ vague du palier, et pas plus d'une fois toutes les cinq minutes

Le directeur (`back/src/wave-director.ts`) gagne trois champs :

| Champ | Rôle |
| --- | --- |
| `#wavesSincePalier` | vagues (groupes) émises depuis le début du palier ; remis à 0 par `bossDefeated()` (l.397) |
| `#lastPorteurWave` | `#waveNumber` du dernier porteur demandé, `-Infinity` au départ |
| `#porteurEnJeu` | vrai entre la demande et `porteurGone()` |

Dans `dueWave` (l.458), après `this.#waveNumber++` (l.474), `#wavesSincePalier++` ; le porteur est
dû si **les trois** tiennent :

```ts
this.#wavesSincePalier === PORTEUR_WAVE_IN_PALIER &&
  this.#waveNumber - this.#lastPorteurWave >= PORTEUR_MIN_GAP_WAVES &&
  !this.#porteurEnJeu
```

S'il est dû, son ordre est **ajouté en dernier au groupe** que `dueWave` rend — y compris quand ce
groupe est celui du boss (branche l.485-501). Le salon fait déjà naître chaque ordre d'un groupe
dans l'ordre (`back/src/room.ts` l.1412-1469), les clients aussi : rien à changer de ce côté.

⚠️ **« Un par palier » ne veut pas dire « toutes les cinq minutes » dans ce code.** Le §9.1 de
l'orientation fait un palier de ≈ 5 min, mais depuis `5d14288` un boss sort toutes les
`WAVES_PER_PALIER` vagues *qu'il en vive un autre ou non* (`wave-director.ts` l.398-402), soit un
toutes les 30 s, et **chaque** boss abattu fait monter le palier. Une équipe qui tue les boss à
mesure change donc de palier toutes les 30 à 90 s, et un porteur par palier en ferait un par
minute. D'où le plancher `PORTEUR_MIN_GAP_WAVES = 50` (50 × 6 s = 5 min) : la cadence est
*« un par palier, au plus un toutes les cinq minutes »*, ce que le design visait. Un palier qui
passe sa 2ᵉ vague sans porteur (plancher pas atteint, ou porteur précédent encore en vie) n'en
aura pas : rien ne se rattrape.

`porteurGone()` est **la seule** sortie de `#porteurEnJeu`, appelée par le salon à la mort du
porteur et quand son ordre n'a rien fait naître (horde pleine), sur le modèle de `bossMissing()`
(l.416). Une seule méthode pour les deux cas : le directeur n'a pas à savoir lequel.

### 2.2 Où : une ancre posée par le serveur, une formation qui existe

L'ordre du porteur :

| Champ | Valeur |
| --- | --- |
| `archetype` | `PORTEUR_ARCHETYPE` (§3.1) |
| `formation` | `FORMATION.POINT` (`shared/waves.ts` l.27, rayon 40 px, l.73) |
| `count` | `1` |
| `seed` | `(seed de l'ordre principal ^ 0x5f3a_c0f1) >>> 0` |
| `anchorX/Y` | la position du joueur ciblé par la vague, + `PORTEUR_SPAWN_DISTANCE` dans une direction tirée de cette graine |

⚠️ **Aucun tirage de plus dans `#rng`.** Le flux du générateur est verrouillé par le test de
déterminisme et pèse sur tous les bancs (`wave-director.ts` l.172-174, l.479-480) : la graine et
l'angle du porteur se **dérivent** de la graine de l'ordre principal, déjà tirée. Les ordres
ordinaires restent bit-identiques à ceux d'avant l'étape ; seuls les `waveId` qui suivent un porteur
se décalent d'un cran.

L'ancre voyage déjà dans l'ordre, en `int16` (`shared/protocol.ts` l.1444-1445) : **le client ne
dérive pas l'angle**, il lit l'ancre. Aucune formation nouvelle — `ENCIRCLE` poserait le porteur à
`ENCIRCLE_RADIUS` = 1 800 px (`waves.ts` l.46), et une formation dédiée coûterait du code partagé
pour un nombre que l'ancre porte déjà.

`formationPositions` borne la position à la carte (`waves.ts` l.271-272) puis la sort d'un mur ou
de l'eau (`nudgeOutOfObstacle`, l.112) : près d'un bord, le porteur naît **plus près** que 1 500 px.
C'est le « ~ » du design.

### 2.3 Le fil : rien de neuf

Un ordre de vague de 19 octets (`WAVE_ORDER_BYTES`, `protocol.ts` l.682), une fois toutes les
cinq minutes au plus. Le client reconnaît le porteur à son `archetype` — exactement comme il
reconnaît déjà le relevé du nécromancien à `formation` + `archetype` (`front/src/net/client.ts`
l.2207-2219).

## 3. Le porteur

### 3.1 L'entrée du bestiaire

`shared/archetypes.ts` gagne un comportement `'porteur'` dans `Behavior` (l.347) et un archétype
**ajouté après le troll** (id 20) : les id existants ne bougent pas, et il n'entre pas dans
`STEP2_ARCHETYPES` (l.650), donc le directeur ne le tire jamais au hasard.

| Constante | Valeur | Effet |
| --- | --- | --- |
| `PORTEUR_NAME` | `'porteur'` | `PORTEUR_ARCHETYPE` en dérive, comme `BOSS_ARCHETYPE` (l.663) — jamais un `20` en dur |
| `PORTEUR_HP_MULTIPLE` | **10** | PV = `HEAVY_HP × 10` = **200** au palier 0 |
| `PORTEUR_FLEE_RADIUS` | **400** px | il fuit si le joueur le plus proche est à 400 px ou moins |
| `PORTEUR_SPEED_FACTOR` | **0,9** | `speed` = `round(PLAYER_SPEED × 0,9)` = **234 px/s** (`PLAYER_SPEED` = 260, `shared/constants.ts` l.99) |
| `PORTEUR_BODY_SCALE` | **1,6** | dessiné 1,6 fois plus gros qu'un voleur ordinaire (1), bien moins que le boss (3, l.237) |

Rôle `'troupe'` comme les autres élites (l.634) : armure 0, et `countFactor` sans objet (`count`
vaut 1). `hpOf`, `bodyScaleOf` (l.466-473) gagnent chacun une ligne pour le porteur, sur le
modèle du boss.

Sprite : celui du voleur (`sheet`, `frames`, `cell` repris de l'entrée `thief`, l.544-552), dessiné ×1,6 — voir §3.4.

### 3.2 La fuite, dérivée des deux côtés

Le voleur montre la voie (`shared/horde.ts` l.870-875) : sa fuite se décide dans `retarget`, à
partir des **positions retardées** que serveur et clients passent déjà au flowfield
(`back/src/room.ts` l.1391-1406, `FIELD_INPUT_DELAY_TICKS`) — mêmes données, même cadence
(`FLOWFIELD_HZ` = 10), donc la même décision au même tick. La règle « joueur le plus proche à
400 px » se dérive donc **exactement** : `retarget` calcule déjà `bestDist`, le carré de la distance
au joueur le plus proche (l.855-866).

Dans `retarget`, pour un porteur :

```ts
this.fleeing[i] = bestDist <= PORTEUR_FLEE_R2 ? 1 : 0; // pas collant, contrairement au voleur
this.stopped[i] = this.fleeing[i] === 1 ? 0 : 1;
```

- **Hors du rayon, il attend sur place** (`stopped = 1`) : il ne marche pas vers l'équipe, c'est à
  elle d'aller le chercher. Sans cette règle il avancerait jusqu'à 400 px puis reculerait, en
  oscillant au bord du rayon.
- **Dans le rayon, il fuit** : `#advanceByVelocity` inverse déjà la vitesse de tout `fleeing`
  (l.1416-1419). Le facteur devient `-1` pour le porteur, `-THIEF_FLEE_SPEED` (1,3, `archetypes.ts`
  l.387) restant celui du voleur — sa vitesse propre (234 px/s) *est* sa vitesse de fuite. Il
  remonte le flowfield du joueur qui le menace, contourne donc les murs, et **se coince** contre
  l'eau et les bords (`#moveOnLand`, l.1385) : c'est là que la tenaille le prend.

Les autres sites qui lisent `fleeing` filtrent déjà sur `'voleur'` (`room.ts` l.2410,
`front/src/render/behavior-renderer.ts` l.47) : un porteur ne vole pas d'or.

`fleeing` fait partie des quinze tableaux rejoués par l'historique de la horde (`horde.ts` l.168,
l.709) : le rejeu le restaure sans rien apprendre.

**Il ne disparaît jamais** : rien dans le jeu ne retire un ennemi vivant hors du lot de morts. Il
attend qu'on vienne.

### 3.3 Les PV

Rien à écrire. Le porteur passe par le chemin ordinaire de `Room` : `#scalePalierHp` (`room.ts`
l.1968) applique `palierHp`, qui multiplie par `1,12^k` toute réserve au-dessus de `LIGHT_HP`
(`shared/paliers.ts` l.141). 200 en est loin : **200 × 1,12^k**, comme la horde, sans facteur de
joueurs (contrairement au boss, `bossHp`). Les PV restent serveur seul (`archetypes.ts` l.28-33).

### 3.4 Le sprite : le voleur, en plus grand

Décision de Léo : **le porteur est un voleur** — un voleur qui porte le butin, la lecture tient
d'elle-même. Il reprend la planche du voleur (`Thief/Thief_Run.png`, 6 images, cellule 192 px,
`archetypes.ts` l.544-552), déjà dans l'atlas (`tools/build_monster_atlas.py` l.105). **Aucune
reconstruction d'atlas, aucun actif nouveau.**

⚠️ **Mais l'atlas range ses textures par identifiant d'archétype**, et le manifeste n'a pas
d'entrée 20 : sans rien faire, `HordeRenderer.draw` sauterait le porteur en silence, faute de
textures (`horde-renderer.ts` l.672-683). `adoptAtlas` (l.559) gagne donc, **après** sa boucle sur
le manifeste et **avant** `archetypeScales` (l.596), un alias :

```ts
const voleur = archetypeIdOf('thief');
this.#runFrames[PORTEUR_ARCHETYPE] = this.#runFrames[voleur] ?? [];
this.#attackFrames[PORTEUR_ARCHETYPE] = this.#runFrames[voleur]?.slice(0, 1) ?? [];
sizesPx[PORTEUR_ARCHETYPE] = sizesPx[voleur] ?? 0;
```

- **La taille passe par le mécanisme du boss, sans une ligne de rendu de plus.** `BOSS_BODY_SCALE`
  n'est lu nulle part dans le rendu : il entre dans `Archetype.bodyScale` par `bodyScaleOf`
  (`archetypes.ts` l.471-473, l.640), et `archetypeScales` le lit par identifiant
  (`horde-renderer.ts` l.342) pour le passer à `spriteScale` (l.319-323), qui multiplie le facteur
  commun `BODY_SCALE`. Donner `PORTEUR_BODY_SCALE = 1,6` au porteur dans `bodyScaleOf`, et la
  taille de contenu du voleur dans `sizesPx[PORTEUR_ARCHETYPE]`, suffit : `#scale[20]` vaut
  1,6 × celui du voleur. La hitbox, elle, ne grossit pas (`PROJECTILE_HIT_RADIUS` ne varie pas par
  archétype, `archetypes.ts` l.71-78) — le même prix que le boss, assumé.
- **Le clip d'attente est la première image de la course, figée.** `selectClip` montre le clip
  d'« attaque » quand `stopped` vaut 1 (`horde-renderer.ts` l.367), c'est-à-dire exactement quand
  le porteur attend : avec le vrai clip d'attaque du voleur, il frapperait dans le vide. Un clip
  d'une image le montre immobile ; en fuite, il court.

⚠️ **Pas de teinte sur le corps.** Le `ParticleContainer` de la horde ne téléverse plus la couleur
(`horde-renderer.ts` l.469, `color: false`, retiré exprès à la tâche 13) : teinter **un** monstre
obligerait à reteléverser celle des milliers d'autres à chaque image. L'or vient du sol et de
l'icône (§5.1).

**Distinguer le porteur d'un voleur ordinaire**, d'un coup d'œil, tient à trois choses : la taille
(×1,6), l'anneau doré au sol et l'icône de coffre au-dessus (§5.1), présents en permanence. Le
voleur ordinaire n'a ni l'un ni l'autre, et son `'butin'` n'apparaît qu'en fuite (l.47).

**Le voleur ordinaire ne change pas** : archétype 8, comportement `'voleur'`, fuite collante à
`-THIEF_FLEE_SPEED`, vol d'or (`room.ts` l.2410). Le porteur a son propre archétype, son propre
comportement `'porteur'` et sa propre règle de fuite (§3.2) ; il ne partage avec le voleur que des
textures, côté rendu.

## 4. La récompense : un étalage d'équipe, au plancher rare

### 4.1 Le salon : une file de plus, la même machine

`Room` gagne `#porteur: number | null` (l'identité de l'entité, comme `#bosses`) et
`#chestsOwed = 0`.

- **À l'apparition** (boucle des ordres, `room.ts` l.1412-1469) : un ordre `PORTEUR_ARCHETYPE` qui
  a fait naître son entité pose `#porteur = entityIdOf(order.waveId, 0)` ; sinon (horde pleine)
  `this.#director.porteurGone()`. Ses PV passent par `#scalePalierHp` comme le reste.
- **À sa mort**, dans le lot de morts unique du tick, à côté des boss (l.1656-1685) :
  `#chestsOwed++`, `#porteur = null`, `#director.porteurGone()`. Le même garde que les boss
  (l.1688-1690) oublie un porteur retiré hors du lot (bancs), sans coffre.
- **L'ouverture** (l.1299-1302) devient :

  ```ts
  if (this.#draft.phase === 'closed' && (this.#chestsOwed > 0 || this.#pendingLevels > 0)) {
    this.#openDraft();
  }
  ```

  `#openDraft` (l.2310) consomme **un coffre s'il en doit un, sinon un niveau**, et passe le
  plancher à `drawSpread`. Il met en file `LEVEL_UP` (avec `this.#level`, inchangé) et
  `DRAFT_OPEN` exactement comme aujourd'hui.

Tout le reste est l'étalage existant, sans une ligne : `Draft.open`/`step` (`back/src/draft.ts`),
jetons, conflits, expiration, `grantCard`, fin du gel par `DRAFT_RESULT` et rampe de reprise
(`#stepDraft`, l.2335-2354).

**Le gel est celui d'une montée de niveau**, et il passe par le même message : le client gèle sur
`LEVEL_UP` (`client.ts` l.2274-2291). Un `LEVEL_UP` dont le niveau ne monte pas ne joue pas le son
de niveau — `cuesBetween` ne le joue que si `level` augmente (`front/src/audio/audio.ts` l.55-61).

**Les files.** Pendant un étalage le monde est gelé, donc **aucune mort** n'arrive : un porteur ne
meurt jamais pendant qu'un étalage est ouvert, et un coffre dû attend toujours la fermeture du
précédent — c'est le cas « un étalage est déjà ouvert » du design, tenu par construction.

⚠️ **Quand un coffre et un niveau sont dus au même instant, le coffre passe d'abord.** Le design dit
que le coffre attend le premier étalage ; c'est vrai de tout étalage *déjà ouvert*. Dans le seul cas
où les deux sont dus alors que rien n'est ouvert (le porteur meurt au tick où l'XP franchit un
seuil), l'ordre « coffre d'abord » est ce qui permet au client de savoir **sans octet** lequel est un
coffre (§4.3). Le niveau suit à la fermeture, dans la même file.

### 4.2 Le plancher

`shared/rarity.ts` :

| Constante | Valeur |
| --- | --- |
| `CHEST_RARITY_FLOOR` | `RARITY.RARE` |

`rollRarity(rng, floor = RARITY.COMMUNE)` (l.44) ne tire que parmi les raretés `>= floor` : au
plancher rare, **rare 15/18 ≈ 83 %, légendaire 3/18 ≈ 17 %**. `drawSpread(loadouts, rng, floor =
RARITY.COMMUNE)` (`shared/cards.ts` l.151) le transmet à `rollRarity` (l.166) ; rien d'autre ne
change — les passifs exclusivement légendaires n'entrent toujours que sur un emplacement
légendaire (l.167-169).

Avec le plancher par défaut, le flux de `rng` et l'étalage sont **identiques** à ceux d'aujourd'hui :
une montée de niveau ne voit aucune différence.

(Un plancher par `Math.max(floor, rollRarity(rng))` aurait laissé la légendaire à 3 % ; la
renormalisation donne au coffre sa raison d'être un événement. Réglable au playtest : c'est le seul
choix de cette section.)

### 4.3 Le client sait que c'est un coffre, sans octet

Le client voit naître le porteur (`WAVE_ORDER`) et le voit mourir (`DEATHS`) ; le serveur ouvre un
coffre dû **avant** tout niveau (§4.1), et il diffuse les morts **avant** les `LEVEL_UP` du même
envoi (`back/src/server.ts` l.579 puis l.624). D'où, dans `GameClient` :

- `WAVE_ORDER` d'archétype `PORTEUR_ARCHETYPE` (l.2207) : `#porteurId = entityIdOf(waveId, 0)`,
  compteur d'annonces `+1`, heure murale de l'annonce retenue ;
- `DEATHS` (l.2221) qui contient `#porteurId` : `#chestsOwed++`, `#porteurId = null` — lu **à la
  réception**, sur les identités du message, sans attendre que le rejeu l'applique ;
- `LEVEL_UP` (l.2274) : `#draftIsChest = #chestsOwed > 0`, et si oui `#chestsOwed--`.

Le getter `draftIsChest` sert à deux libellés : le titre de l'étalage (`front/src/ui/draft.ts`
l.585-586, « Niveau N » → **« Coffre »**) et le bandeau de gel (`front/index.html` l.378-383,
« Niveau supérieur — pause… » → **« Coffre — pause… »**, basculé par `hud.ts` l.281).

Les raretés, elles, voyagent déjà dans `DRAFT_OPEN` (4 octets par carte, `protocol.ts` l.694) : la
bordure or/bleu de l'étape 10 dit le plancher sans rien ajouter.

## 5. Le suivi et l'annonce

Le client tient la position du porteur par `horde.slotOf(#porteurId)` (`shared/horde.ts` l.674),
une fois par image — le même balayage que la barre du boss fait déjà. Getter `porteur: { x, y } |
null` (null s'il n'est pas, ou plus, dans la horde du client).

### 5.1 Au sol

`behaviorShapes` (`front/src/render/behavior-renderer.ts` l.37) gagne une forme `'coffre'` pour
chaque porteur dans le cadre, dessinée en `Graphics` procédural comme les autres formes du module
(l.184-230) — **aucun fichier d'image** :

- **l'anneau** : un cercle de rayon 46 px sous ses pieds, trait de 4 px en `COIN_TINT`
  (`0xf5c542`, la couleur de la pièce, `front/src/render/orb-renderer.ts` l.136), rempli à 20 %
  d'alpha ;
- **le coffre**, centré à 60 px au-dessus de lui : un rectangle de 22 × 15 px rempli de
  `COIN_TINT`, contouré de brun foncé (`0x5a3a1a`, 2 px), une ligne horizontale de même brun au
  tiers haut pour le couvercle, et un petit carré de 4 px au centre pour la serrure.

C'est ce qui fait « l'élite dorée » : le corps reste celui d'un voleur, l'or est autour.

### 5.2 Mini-carte

`MinimapView` (`front/src/ui/minimap.ts` l.32) gagne `porteur: { x: number; y: number } | null`,
dessiné en point **or** (`#f5c542`) de 6 px, au-dessus des ennemis et sous les joueurs. Câblé dans
`front/src/main.ts` à côté de `pings` (l.729-737).

### 5.3 Flèche de bord

`PingRenderer.draw` (`front/src/render/ping-renderer.ts` l.145) reçoit en plus `porteur` ; hors
champ, `edgeArrow` (l.62) le place et `drawArrow` (l.188) le dessine en or, avec la petite icône de
coffre en retrait comme celle d'une intention. Dans le champ, rien. Câblé par `Stage.drawPings`
(`front/src/render/stage.ts` l.498-519). Aucune fonction nouvelle : `edgeArrow` est déjà pure et
testée.

### 5.4 Le son et le bandeau

- Un effet `'porteur'` rejoint l'union `Cue` (`audio.ts` l.17-31) : un arpège ascendant brillant,
  distinct de `'levelup'` (l.254-258). `CueSnapshot` gagne `porteurs` (annonces reçues), sur le
  modèle de `pings` (l.45) ; `cuesBetween` joue l'effet quand il augmente.
- Un bandeau **« Un porteur de coffre est apparu ! »** : il n'existe pas de bandeau passager dans le
  HUD, le plus proche est `hud-freeze` (`index.html` l.378-383). Un frère, `hud-porteur`, mêmes
  classes (`k k-carved3 f-meta ol`), visible `PORTEUR_BANNER_MS = 4000` ms après l'annonce.

L'annonce se fait **à la réception de l'ordre**, pas à la naissance : quelques ticks d'avance, et
c'est ce que chaque client voit au même moment.

## 6. Ce qui n'est PAS dans cette étape

- plusieurs porteurs en même temps : un porteur en vie bloque le suivant (§2.1) ;
- un délai de fuite, ou un porteur qui finit par s'échapper ;
- des coffres ailleurs que sur ce porteur (au sol, en récompense de boss) ;
- un pool d'élites, ou un corps nouveau : le porteur est un voleur agrandi ;
- le point du boss sur la mini-carte, jamais câblé (`main.ts` l.733, `boss: null`) — pas cette
  étape.

## 7. Les tests et le livrable

| Où | Quoi |
| --- | --- |
| `shared/archetypes.test.ts` | le porteur existe, après le troll ; comportement `'porteur'` ; PV = `HEAVY_HP × PORTEUR_HP_MULTIPLE` ; vitesse < `PLAYER_SPEED` ; absent de `STEP2_ARCHETYPES` |
| `shared/horde.test.ts` | un voleur ordinaire fuit toujours au contact, pour toujours, à `THIEF_FLEE_SPEED` ; joueur (retardé) à 399 px → fuit, à 401 px → attend (`stopped`) ; la fuite s'arrête quand le joueur s'éloigne ; en fuite il s'éloigne à sa vitesse propre, sans le facteur du voleur |
| `shared/horde.replication.test.ts` | un scénario de plus : un porteur et deux joueurs qui le chassent, horde serveur et horde client bit-identiques sur toute la poursuite |
| `shared/rarity.test.ts` | `rollRarity` au plancher rare ne rend jamais commune, rend encore légendaire ; sans plancher, le même `rng` rend la même suite qu'avant |
| `shared/cards.test.ts` | `drawSpread` au plancher rare : aucune carte commune sur de nombreuses graines ; sans plancher, étalage identique à celui d'avant l'étape |
| `back/src/wave-director.test.ts` | un porteur à la 2ᵉ vague du palier 0, à `PORTEUR_SPAWN_DISTANCE` de son joueur (hors bord), en `POINT`, `count` 1 ; pas d'autre avant 50 vagues ; pas tant que `porteurGone()` n'est pas venu ; les ordres ordinaires identiques à ceux d'un directeur de même graine sans porteur |
| `back/src/room.test.ts` | la mort du porteur ouvre un étalage gelé, toutes cartes ≥ rare ; coffre et niveau dus au même tick → coffre puis niveau ; horde pleine → `porteurGone()` ; PV = 200 × 1,12^k |
| `back/src/porteur.integration.test.ts` | **le livrable** : deux vraies sockets ; l'ordre du porteur arrive aux deux ; une fois tué, chacun reçoit `LEVEL_UP` puis un `DRAFT_OPEN` à raretés ≥ 1, et son `GameClient` dit `draftIsChest` ; aucun type de message nouveau, snapshot de même taille |
| `front/src/net/client.test.ts` | `DEATHS` du porteur puis `LEVEL_UP` → coffre ; `LEVEL_UP` seul → pas coffre ; deux coffres dus se consomment un par un |
| `front/src/render/behavior-renderer.test.ts` | une forme `'coffre'` par porteur dans le cadre, aucune hors cadre ; un voleur ordinaire n'en a pas, et son `'butin'` ne sort toujours qu'en fuite |
| `front/src/render/horde-renderer.test.ts` | sur l'atlas synthétique existant, après `adoptAtlas` le porteur a les textures du voleur, une attente d'une image, et une échelle de 1,6 × celle du voleur |
| `front/src/ui/minimap.test.ts` | le point or à la bonne place, absent si `porteur` est null |
| `front/src/render/ping-renderer.test.ts` | flèche or pour un porteur hors champ, aucune dans le champ |
| `front/src/audio/audio.test.ts` | `'porteur'` joué quand le compteur d'annonces monte, une fois |
| `front/src/ui/draft.test.ts` | titre « Coffre » pour un étalage de coffre, « Niveau N » sinon |

**Vérification manuelle**, ouverte jusqu'au playtest :

- le porteur se distingue-t-il d'un coup d'œil d'un voleur ordinaire (taille, anneau, coffre), en
  pleine horde ?
- seul, est-il vraiment dur à prendre ? à deux, la tenaille marche-t-elle ?
- 234 px/s contre 260 : l'écart est-il le bon ?
- 200 × 1,12^k PV : assez pour qu'on ne le fonde pas de loin (voir §8) ?
- 83 % rare / 17 % légendaire : le coffre fait-il événement ?
- le bandeau et le son se remarquent-ils en pleine horde, sans gêner ?
- une fois toutes les cinq minutes au plus : trop rare, trop fréquent ?

## 8. Risques

- **On peut le tuer sans jamais le faire fuir.** La fuite se déclenche à la *distance*, pas aux
  dégâts — les dégâts sont serveur seul, et une fuite sur blessure ne se dériverait pas côté client.
  Or la plupart des armes portent au-delà de 400 px (650 px/s × 28 ticks ≈ 600 px pour la
  Dague, `shared/weapons.ts` l.519-520 ; 900 × 40 ≈ 1 200 px pour l'Arc lourd, l.602-603). Un tireur qui
  s'arrête à 450 px le crible pendant qu'il attend. Le réglage est `PORTEUR_FLEE_RADIUS` (le
  monter vers la portée des armes) ou `PORTEUR_HP_MULTIPLE`, pas une règle nouvelle.
- **L'alias de textures.** Le porteur n'a pas d'entrée dans l'atlas : s'il manque l'alias de
  `adoptAtlas`, il est simulé et tuable mais pas dessiné, en silence (le défaut que l'étape 6a a
  connu avec le boss). Le test de `horde-renderer.test.ts` du §7 le garde.
- **La cadence.** Le plancher de 50 vagues compte des vagues émises ; les vagues ne tombent pas
  pendant un gel, donc « 5 min » s'entend en temps de jeu. Un palier long (boss résistant) donne un
  porteur par palier, plus rarement.
- **Le coffre avant le niveau.** Dans le cas rare du même tick, le niveau attend le coffre et non
  l'inverse (§4.1). Invisible en jeu, mais c'est un écart au texte du design, assumé pour ne pas
  ajouter d'octet.
- **Le Givre et les ralentissements** le rendent beaucoup plus facile : c'est voulu (l'outil d'un
  allié sert la battue), à surveiller au playtest.
