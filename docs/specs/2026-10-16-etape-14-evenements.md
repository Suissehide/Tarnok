# Étape 14 — les événements bonus

## 0. Statut et place dans la suite

Dernière des étapes décidées le 15 octobre 2026 (roue de ping, rareté et passifs, élites à coffre,
**événements bonus**). Le tableau du §0 de l'étape 9 la numérotait 12 ; le 12 est pris sur `main`
par les trajectoires (`docs/specs/2026-10-15-etape-12-trajectoires.md`, familles « frappe » et
« onde »), le 13 par les pactes, d'où le 14. Le design a été validé par Léo avant d'écrire ; ce
document le rend exact contre le code, il ne le change pas, sauf deux décisions prises par Léo après
la première rédaction (le plancher épique, §5.2 ; le premier événement à 2 min, §2.1). Là où le
code oblige à préciser ou à dévier, c'est dit sur place (⚠️) et repris au §10.

⚠️ **Dépendance : l'étape 13 (pactes) est fusionnée dans `main` AVANT celle-ci.** Branche
`etape-13-pactes`, spec `docs/specs/2026-10-16-etape-13-paliers-et-pactes.md` (branche
`guide-et-specs`). Ce document décrit la récompense dans **son** modèle de rareté, pas dans celui de
`main` aujourd'hui :

| | `main` aujourd'hui | après les pactes (§2.1 de leur spec) |
| --- | --- | --- |
| `RARITY` | `COMMUNE` 0, `RARE` 1, `LEGENDAIRE` 2 | `COMMUNE` 0, `RARE` 1, **`EPIQUE` 2**, `LEGENDAIRE` 3 |
| `RARITY_MULTIPLIERS` | `[1, 2, 3]` | `[1, 2, 1, 1]` |
| `RARITY_WEIGHTS` | `[82, 15, 3]` | `[72, 20, 6, 2]` |
| épique | — | **trois cartes de règle**, gratuites, ×1 : Écho, Colosse, Contagion (§4.1) |
| légendaire | ×3 de n'importe quelle carte | **trois pactes**, ×1, payés d'un malus : Transcendance, Fournaise, Hâte funeste (§4.2) |
| armes | toutes raretés | plafonnées à rare ×2 (§2.2) |
| palier vide | `break` inatteignable | **descente** d'un cran jusqu'au plancher, jamais dessous (§2.3) |

Les numéros de ligne cités ici sont ceux de `main` au 16 octobre ; ceux des fichiers que les pactes
touchent (`shared/rarity.ts`, `shared/cards.ts`, `shared/protocol.ts`) bougeront à la fusion, et le
plan d'exécution les relèvera à nouveau.

- **Au plus un événement à la fois**, tiré au hasard parmi trois, imposé (pas d'autel) : à la
  3ᵉ vague d'un palier (le porteur vient à la 2ᵉ), jamais à moins de 40 vagues (≈ 4 min) du
  précédent, à ~1 200 px de l'équipe.
- **Annoncé** par un bandeau (« La forge s'allume ! »), un son et une flèche dorée au bord de
  l'écran. **60 s** pour le réussir ; passé ce délai il s'éteint, sans pénalité.
- **Trois événements** : *les trois sceaux*, *la forge*, *le convoi* (§3).
- **La récompense** : un étalage d'équipe dont **toutes** les cartes sont **au moins épiques** — des
  cartes de règle, épiques ou pactes — par la machine du coffre de l'étape 11, plancher relevé.
- **Le fil** : contrairement aux étapes 9 à 11, un événement ne se dérive pas à zéro octet. Trois
  messages nouveaux, `EVENT_START`, `EVENT_STATE` (5 Hz, seulement pendant un événement),
  `EVENT_END`. **Rien** d'ajouté aux messages par tick.

Elle réalise le levier 4 du §8 de l'orientation (`docs/specs/2026-08-19-coop-survivors-orientation.md`
l.612) — *« objectif exigeant au moins deux joueurs, récompense d'équipe »* — avec trois des six
événements du §10 (l.710-728). La battue est déjà faite (le porteur, étape 11) ; le noir et le
marchand restent dehors (§8).

L'exécution se fera dans un worktree, comme les étapes 9 à 13, sur un `main` qui contient les pactes.

## 1. Le livrable en une phrase

**Toutes les quatre minutes au plus, un objectif apparaît loin de l'équipe — trois zones à tenir
ensemble, une forge où rester immobile, un chariot à escorter — et le réussir en 60 s ouvre un
étalage d'équipe fait de cartes de règle.**

Vérifiable ainsi : sur deux vraies sockets, les deux clients reçoivent le même `EVENT_START`, puis
des `EVENT_STATE` à 5 Hz qui montent quand les joueurs remplissent l'objectif et s'arrêtent quand il
s'achève ; un `EVENT_END` réussi est suivi d'un `LEVEL_UP` et d'un `DRAFT_OPEN` dont chaque carte
porte une rareté `>= RARITY.EPIQUE`, et chaque `GameClient` dit `draftIsEvent`. Le `SNAPSHOT` garde sa taille.

## 2. Le déclenchement

### 2.1 Quand : le directeur, sans un tirage de plus

Le moment vit dans le directeur (`back/src/wave-director.ts`), à côté du porteur : c'est lui qui
compte les vagues du palier (`#wavesSincePalier`, l.395, remis à 0 par `bossDefeated`, l.439) et
les vagues de la run (`#waveNumber`, l.386). Le reste — le lieu, le genre, l'état — vit dans le
salon (§2.3), parce que le directeur ne connaît ni les joueurs vivants ni les obstacles.

Deux constantes, à côté de `PORTEUR_WAVE_IN_PALIER` (l.348) et `PORTEUR_MIN_GAP_WAVES` (l.360) :

| Constante | Valeur | Rôle |
| --- | --- | --- |
| `EVENT_WAVE_IN_PALIER` | **3** | la 3ᵉ vague (groupe) du palier, boss compris dans le compte, comme le porteur |
| `EVENT_MIN_GAP_WAVES` | **40** | 40 × 6 s (`PERIOD_TICKS`, l.25) = 240 s ≈ 4 min entre deux événements |
| `EVENT_FIRST_WAVE` | `Math.ceil((120 × TICK_HZ) / PERIOD_TICKS)` = **20** | pas d'événement avant la 20ᵉ vague de la run, soit ≈ 2 min de jeu |

Deux champs :

| Champ | Rôle |
| --- | --- |
| `#lastEventWave` | `#waveNumber` du dernier événement demandé, `Number.NEGATIVE_INFINITY` au départ (comme `#lastPorteurWave`, l.397) |
| `#eventSeed: number \| null` | la graine de l'événement dû à cette vague, lue une fois par le salon |

Un `#marquerEvenement(principal)` privé, appelé dans `dueWave` **juste avant les deux `return`
qui rendent un groupe** (branche du boss, l.584 ; branche ordinaire, l.620) :

```ts
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

/** La graine de l'evenement du a cette vague, ou null ; la lit et l'oublie. */
takeEventSeed(): number | null {
  const s = this.#eventSeed;
  this.#eventSeed = null;
  return s;
}
```

**Le premier événement, pas avant 2 minutes** (décision de Léo). `EVENT_FIRST_WAVE` se calcule
dans le directeur, à côté de `PERIOD_TICKS` = `TICK_HZ × 6` = 180 ticks (l.25) : une vague tombe
quand `tick % PERIOD_TICKS === 0` et `tick > 0` (l.547), donc la vague n tombe au plus tôt au tick
180 n, soit 6 n secondes. 120 s × 30 Hz / 180 = **20**. Écrit en formule, pas en `20` en dur : si
la cadence des vagues change, le seuil suit. Un gel retarde les vagues (celles qui tombent pendant
sont sautées), jamais ne les avance : la 20ᵉ vague n'arrive jamais avant 2 min. Le seuil s'ajoute
aux deux autres conditions, il ne les remplace pas : le premier événement est à la première
3ᵉ vague de palier **à partir** de la vague 20 — avec les boss abattus à mesure, autour de 2 min
à 2 min 30. `#lastEventWave` reste à `-Infinity` : le plancher de 40 vagues ne joue qu'entre deux
événements.

⚠️ **Aucun tirage dans `#rng`, et pas même un `waveId`.** Même règle que le porteur
(`#avecPorteur`, l.471-476) : la graine se **dérive** de celle de l'ordre principal, déjà tirée, par
un autre masque que celui du porteur (`0x5f3a_c0f1`, l.487). Mieux que le porteur : un événement
n'est pas un ordre de vague, il ne prend aucun `waveId` (`#nextWaveId`, l.370). Les ordres rendus par
`dueWave` sont donc **bit-identiques** à ceux d'avant l'étape, `waveId` compris — l'empreinte FNV du
test `les ordres ordinaires sont bit-identiques` (`wave-director.test.ts` l.718-738) ne bouge pas,
et le test gagne une variante qui la relève avec des événements demandés.

**Pas de `#evenementEnJeu`, contrairement au porteur (l.402).** Le porteur peut vivre indéfiniment ;
un événement dure au plus `EVENT_DURATION_TICKS` = 1 800 ticks vivants (§2.4). Les vagues tombent
sur les ticks multiples de `PERIOD_TICKS` = 180 et pas pendant un gel (`dueWave` est appelé après
les gardes de gel, `room.ts` l.1335-1361 puis l.1448) : en 1 800 ticks vivants, au plus 11 vagues
passent — loin des 40 du plancher. « Au plus un à la fois » tient donc par le seul plancher ; un
second garde serait de ceux qui se couvrent l'un l'autre sans qu'aucun test ne les tienne. Le test
du salon le vérifie (§9).

### 2.2 Quel événement, et où

`Room.step` lit la graine **juste après** la boucle des ordres (`room.ts` l.1448-1527), avant le
portail :

```ts
const graine = this.#director.takeEventSeed();
if (graine !== null) {
  this.#startEvent(graine);
}
```

`#startEvent` délègue le placement à une fonction pure de `back/src/evenement.ts` (nouveau, serveur
seul — aucun client ne place rien, il lit les points dans `EVENT_START`) :

```ts
placeEvent(seed, vivants: readonly { x: number; y: number }[], obstacles: ObstacleField): EventPlan
```

| Grandeur | Règle |
| --- | --- |
| `vivants` | les joueurs à `hp > 0` — un mort ne compte ni pour le centre ni pour N |
| N | `vivants.length` (1 à `MAX_PLAYERS` = 4, `shared/constants.ts` l.86). **Solo = N vaut 1** : un duo dont l'un est à terre reçoit la variante solo |
| le genre | `seed % 3` → `EVENT_KIND.SCEAUX` (0), `FORGE` (1), `CONVOI` (2) |
| l'angle θ | `((seed >>> 8) / 0x100_0000) × 2π` — bits disjoints de ceux du genre |
| le centre de l'équipe | moyenne des positions des vivants |
| le site S | centre + `EVENT_SPAWN_DISTANCE` (**1 200 px**) dans la direction θ, borné à `[0, MAP_SIZE]` puis sorti des obstacles |

« Sorti des obstacles » : `nudgeOutOfObstacle` de `shared/waves.ts` (l.112), aujourd'hui privée,
gagne `export`. Elle prend un `ObstacleField` (l.90-95), que `FlowField` satisfait tel quel
(`shared/flowfield.ts` l.43-52) : le salon lui passe `this.#fields[0]`, comme à `horde.spawn`
(l.1453-1456). Près d'un bord, le site naît **plus près** que 1 200 px : c'est le « ~ » du design,
comme pour le porteur (§2.2 de l'étape 11).

⚠️ **Le centre de l'équipe, pas le joueur ciblé par la vague.** Le porteur part du joueur que la
vague a tiré (`wave-director.ts` l.553-555) ; le design dit « à ~1 200 px de l'équipe », et
l'événement s'adresse à l'équipe entière. Le salon calcule la moyenne lui-même : aucun tirage.

Les points de l'événement, ceux que `EVENT_START` transporte (§6) :

| Genre | Points | Placement |
| --- | --- | --- |
| Sceaux | N | N = 1 : S seul. N ≥ 2 : sur un cercle de centre S et de rayon `SCEAUX_SPACING / (2 sin(π/N))`, à θ + 2πk/N — deux sceaux voisins sont à **800 px** l'un de l'autre (rayons 400, 462 et 566 px pour N = 2, 3, 4). Chaque point borné puis sorti des obstacles |
| Forge | 1 | S |
| Convoi | 2 | le départ S, puis l'arrivée E = S + `CONVOI_DISTANCE` (**1 500 px**) vers le centre de la carte (`MAP_SIZE / 2`, si S en est à moins d'1 px : dans la direction θ), sortie des obstacles. Vers le centre, E reste toujours dans la carte |

⚠️ **N sceaux pour N joueurs, pas « 3 à 4, 2 à 2 ».** Le §5 de l'orientation (l.332) dimensionnait
autrement ; le design validé dit « un sceau par joueur », et c'est lui qui fait foi.

### 2.3 Dans le salon

`Room` gagne :

| Champ | Rôle |
| --- | --- |
| `#event: EventRun \| null` | l'événement en cours (état serveur, §3) ; `null` hors événement |
| `#eventDraftsOwed = 0` | les étalages d'événement dus, sur le modèle de `#chestsOwed` (l.491) |
| `#pendingEvents: EventMessage[]` | la file de diffusion, vidée par `drainEvents()` (§6.4) |
| `#convoiField: FlowField` | le champ de flux du chariot, construit **une fois** au constructeur avec le même masque (`room.ts` l.598-603) |

### 2.4 Le temps : 60 s vivantes, et l'événement dort pendant tout gel

| Constante (`shared/evenements.ts`) | Valeur |
| --- | --- |
| `EVENT_DURATION_TICKS` | **1 800** (60 s à `TICK_HZ` = 30) |

`#stepEvent` est appelé dans `step`, **juste avant `#checkRunOver()`** (`room.ts` l.1833) — après le
déplacement des joueurs (l.1366-1402), de la horde (l.1548) et le contact (l.1795) : il lit les
positions de ce tick. Il ne fait rien **tant que `this.#tick <= this.#resumeEndTick`** :

- pendant un étalage ou un gel, `step` est déjà sorti plus haut (l.1340-1361) : l'événement ne voit
  pas ces ticks ;
- **pendant la rampe de reprise** (`LEVEL_RESUME_TICKS` = 30, `shared/constants.ts` l.375 ;
  `#movementScale`, `room.ts` l.2842-2848), il dort encore.

⚠️ **La rampe aussi, et c'est ce qui rend l'horloge du client juste sans octet.** Le client compte
le temps restant sur `pingClock` (§6.1), qui s'arrête pendant `isFrozen` — gel strict **et** rampe
(`front/src/net/client.ts` l.1682-1684, l.1847-1854, l.2191-2193). Si le serveur faisait courir
l'événement pendant la rampe, chaque étalage décalerait le compte à rebours affiché d'une seconde.
Une seconde de pause de plus par étalage, pour une horloge exacte des deux côtés.

`EventRun.elapsed` compte les ticks vivants ; à `EVENT_DURATION_TICKS`, l'événement s'éteint
(`EVENT_OUTCOME.EXPIRE`) — **aucune pénalité**, seule la récompense est perdue.

**La fin de run** l'emporte sans message : `RUN_OVER` dit tout (`#endRun`, l.2934-2942), et le
client oublie l'événement en quittant la partie.

## 3. Les trois événements

`EventRun.step(joueurs, horde, dt)` rend `null` tant que l'événement continue, sinon une issue. Les
joueurs à `hp <= 0` ne comptent **jamais** (ni occupant, ni forgeron, ni escorte).

Les rayons lus par le client pour dessiner vivent dans `shared/evenements.ts` ; le reste dans
`back/src/evenement.ts`.

### 3.1 Les trois sceaux

| Constante | Valeur | Où |
| --- | --- | --- |
| `SCEAU_RADIUS` | **120** px | `shared/evenements.ts` |
| `SCEAUX_SPACING` | **800** px | `back/src/evenement.ts` |
| `SCEAUX_HOLD_TICKS` | **600** (20 s) | `back/src/evenement.ts` |

À chaque tick vivant : si **chaque** sceau a au moins un joueur vivant à `SCEAU_RADIUS` ou moins,
`held++`. Sinon rien — la progression **se suspend**, elle ne redescend pas (« 20 s cumulées »).
Deux joueurs dans le même sceau n'en valent qu'un. Réussi à `held >= SCEAUX_HOLD_TICKS`.

Solo : N = 1, un seul sceau, 20 s cumulées dedans.

N est **figé au départ** : un joueur qui meurt ou se déconnecte pendant l'événement laisse un sceau
qu'il ne pourra plus tenir ; l'événement s'éteindra à 60 s. C'est la règle « impossible seul » du
§10 de l'orientation, pas un défaut (§10).

### 3.2 La forge

| Constante | Valeur | Où |
| --- | --- | --- |
| `FORGE_RADIUS` | **90** px | `shared/evenements.ts` |
| `FORGE_HOLD_TICKS` | **900** (30 s) | `back/src/evenement.ts` |
| `FORGE_HOLD_TICKS_SOLO` | **450** (15 s) | `back/src/evenement.ts` |
| `FORGE_STILL_SPEED` | **20** px/s | `back/src/evenement.ts` |

À chaque tick vivant : si **un** joueur vivant est à `FORGE_RADIUS` ou moins du centre **et
immobile**, `held++`. Bouger ou sortir suspend, sans remise à zéro.

**Immobile** se lit sur l'entrée, pas sur le déplacement : `Math.hypot(p.moveX, p.moveY) ×
PLAYER_SPEED < FORGE_STILL_SPEED`. `moveX`/`moveY` sont l'axe normalisé dans `[-1, 1]`
(`room.ts` l.149-151, posés par `applyInput`, l.1205-1222) ; `PLAYER_SPEED` = 260
(`shared/constants.ts` l.99). Au clavier, c'est « aucune touche » ; à la manette, une dérive de
stick sous ~10/127 ne casse pas la canalisation.

⚠️ **L'entrée plutôt que le déplacement mesuré** : un joueur poussé par un gardien
(`pushOutOfGuards`, l.1390) ou par la horde n'a pas bougé de son fait, et il ne perd pas sa forge.
Et c'est sans état : pas de position du tick d'avant à retenir.

« Pendant que la horde afflue » : c'est **la horde ordinaire**. Elle vise déjà le joueur le plus
proche par le flowfield (`horde.retarget`, l.1440) : un forgeron immobile la voit converger sur lui,
et les autres tiennent la ligne. Aucune vague de plus (§8).

### 3.3 Le convoi

| Constante | Valeur | Où |
| --- | --- | --- |
| `CONVOI_ESCORT_RADIUS` | **150** px | `shared/evenements.ts` |
| `CONVOI_RADIUS` | **32** px (corps dessiné) | `shared/evenements.ts` |
| `CONVOI_DISTANCE` | **1 500** px | `back/src/evenement.ts` |
| `CONVOI_SPEED` | **60** px/s (25 s de trajet au mieux, sur 60) | `back/src/evenement.ts` |
| `CONVOI_HP` | **400** | `back/src/evenement.ts` |
| `CONVOI_HP_SOLO` | **800** | `back/src/evenement.ts` |
| `CONVOI_CONTACT_RADIUS` | `CONVOI_RADIUS + CONTACT_RADIUS / 2` = **49** px | `back/src/evenement.ts` |
| `CONVOI_CONTACT_DAMAGE` | `CONTACT_DAMAGE` = **8** par ennemi au contact, toutes les `CONTACT_INTERVAL_TICKS` = 15 | `back/src/evenement.ts` |
| `CONVOI_MAX_HITTERS` | **5** ennemis comptés au plus par coup | `back/src/evenement.ts` |
| `CONVOI_ARRIVAL_RADIUS` | **32** px | `back/src/evenement.ts` |

(`CONTACT_DAMAGE`, `CONTACT_INTERVAL_TICKS`, `CONTACT_RADIUS` : `shared/constants.ts` l.221, l.234,
l.243.)

**Il n'avance que s'il est escorté** : à chaque tick vivant, si un joueur vivant est à
`CONVOI_ESCORT_RADIUS` ou moins, le chariot avance de `CONVOI_SPEED × dt`. Sinon il attend.

**Le chemin : un champ de flux, une fois.** Une ligne droite de 1 500 px peut traverser un mur ou de
l'eau (`generateObstacles`, `shared/worldmap.ts`), et un chariot glissant le long
d'un mur par `moveOnMap` se coincerait dans le premier recoin. Le salon garde donc un
`#convoiField` (§2.3) et, au départ d'un convoi, `this.#convoiField.update(E.x, E.y)` — **un seul
BFS par convoi**, sur une grille de `MAP_SIZE / FLOWFIELD_CELL` = 94 × 94 cellules
(`FLOWFIELD_CELL` = 64, `shared/constants.ts` l.102). À chaque pas, la direction vient de
`sampleDirection` (`shared/flowfield.ts` l.142) ; à moins d'une cellule de E, le chariot va droit
sur E (la cellule cible n'a pas de direction). Réussi quand il est à `CONVOI_ARRIVAL_RADIUS` de E.

Le champ est **serveur seul** : le client ne dérive pas le chariot, il lit sa position à 5 Hz
(§6.2). Rien à rejouer.

**Les dégâts** : toutes les `CONTACT_INTERVAL_TICKS` ticks vivants (sur `elapsed`), on compte les
ennemis de la horde à `CONVOI_CONTACT_RADIUS` ou moins du chariot — **le même balayage linéaire que
`resolveContact`** (`back/src/combat.ts` l.1850-1876), sur `horde.x`/`horde.y` et `horde.count`, un
seul point au lieu d'un par joueur, et seulement pendant un convoi. Le chariot perd
`min(n, CONVOI_MAX_HITTERS) × CONVOI_CONTACT_DAMAGE` : 16 PV/s pour un ennemi collé, 80 PV/s au
plus. À 400 PV, un chariot noyé tient 5 s ; un passant isolé, 25 s. **Échoué** (`EVENT_OUTCOME.DETRUIT`)
à 0 PV.

**La horde ne le vise pas** (design) : aucun champ de flux ne s'enracine sur lui, `retarget` ne le
voit pas. Il ne prend que ce qui le frôle en courant vers son escorte — et une escorte à 150 px en
attire beaucoup.

Solo : `CONVOI_HP_SOLO` = 800 PV, même vitesse, même escorte.

**La progression**, pour le fil : `1 − distance(chariot, E) / distance(S, E)`, bornée à `[0, 1]`.
Un détour autour d'un mur la fait un instant stagner ; elle ne ment pas sur l'essentiel.

## 4. Ce qui ne bouge pas

- **Le directeur ne rend pas un ordre de plus** et ne consomme ni `rng()` ni `waveId` (§2.1).
- **La horde, ses quinze tableaux rejoués, le flowfield des joueurs** : rien. Le chariot n'est pas
  une entité de la horde ; le client ne rejoue rien à cause d'un événement.
- **Le `SNAPSHOT`** : même taille, même cadence.

## 5. La récompense : un étalage au moins épique

### 5.1 Le salon : la même machine, une file de plus

À la réussite, dans `#stepEvent` : `#eventDraftsOwed++`, `EVENT_END` en file, `#event = null`.

L'ouverture (`room.ts` l.1335-1338) devient :

```ts
if (
  this.#draft.phase === 'closed' &&
  (this.#chestsOwed > 0 || this.#eventDraftsOwed > 0 || this.#pendingLevels > 0)
) {
  this.#openDraft();
}
```

`#openDraft` (l.2479-2508) consomme, **dans cet ordre de priorité**, un coffre, sinon un étalage
d'événement, sinon un niveau, et passe le plancher à `drawSpread` :

| Dû | Plancher |
| --- | --- |
| coffre | `CHEST_RARITY_FLOOR` (`RARITY.RARE`, `shared/rarity.ts` l.32) |
| événement | `EVENT_RARITY_FLOOR` (§5.2) |
| niveau | `RARITY.COMMUNE` |

Le niveau annoncé par le `LEVEL_UP` d'un événement est celui d'un coffre : `this.#level -
this.#pendingLevels` (l.2496-2505) — la variable `coffre` devient `bonus = coffre || evenement`
pour ce calcul. Tout le reste est l'étalage existant : `Draft.open`/`step`, jetons, conflits, gel,
`grantCard`, rampe (`#stepDraft`, l.2523-2544).

⚠️ **La priorité est fixe, et c'est ce qui laisse le client nommer l'étalage sans octet** (§6.3).
L'ordre réel d'arrivée ne compte pas : un étalage s'ouvre au tick qui suit le premier dû, avant toute
simulation (l.1335-1338), et le monde gèle aussitôt. Deux dus ne coexistent donc que s'ils sont nés
**au même tick** — et pour ceux-là, une priorité fixe des deux côtés donne la même suite.

### 5.2 Le plancher : épique

`shared/rarity.ts`, à côté de `CHEST_RARITY_FLOOR` :

| Constante | Valeur |
| --- | --- |
| `EVENT_RARITY_FLOOR` | `RARITY.EPIQUE` |

**Le design : toutes les cartes d'un étalage d'événement sont des cartes de règle**, épiques ou
légendaires. `rollRarity(rng, RARITY.EPIQUE)` renormalise sur `{6, 2}` : **75 % épique, 25 %
légendaire** par emplacement, un seul `rng()` comme à tout plancher, donc le flux de `#draftRng`
(`room.ts` l.597) garde sa forme. Une épique et une légendaire s'appliquent **×1**
(`RARITY_MULTIPLIERS` des pactes) : la récompense n'est pas « plus gros », c'est « une règle ». Et
aucune arme : elles plafonnent à rare (§2.2 des pactes).

*Pourquoi pas « tout légendaire », comme le disait le design d'origine.* Avec les pactes, légendaire
n'est plus un multiplicateur mais trois pactes qui coûtent : un étalage tout légendaire offrirait
toujours les trois mêmes cartes, toutes payantes — la spec des pactes l'annonçait elle-même (§0,
« L'étape des événements devra choisir un autre plancher (épique) »).

⚠️ **Il n'existe que six cartes de règle, et la descente des pactes ne remonte pas.** Vérifié contre
leur `drawSpread` (`shared/cards.ts` de `etape-13-pactes`, l.200-238) : un emplacement tire sa
rareté, puis, si ce palier n'a plus de carte, **redescend** jusqu'au plancher ; au plancher vide,
la boucle s'arrête (`break`). Le tirage est sans remise (`pool.splice`). Au plancher épique, cela
donne :

- un emplacement qui tire épique alors que les trois épiques sont déjà sorties arrête l'étalage,
  même s'il reste des légendaires ;
- l'étalage voulu fait `joueurs + SPREAD_BONUS` = N + 3 cartes (`SPREAD_BONUS` = 3,
  `shared/constants.ts` l.445) : 4 à 7, pour 6 cartes de règle au plus.

Mesuré sur la loi des tirages : en solo, 4 épiques tirées d'affilée (0,75⁴ ≈ **32 %**) donnent un
étalage de **3** cartes au lieu de 4 ; à quatre joueurs, le même cas donne **3 cartes pour
4 joueurs** — moins de cartes que de joueurs, le risque « Haute — casse le draft » du §7 des pactes.
`canTake`, lui, ne filtre plus rien : un passif est toujours prenable depuis les pactes
(`shared/loadout.ts` de la branche, l.137-144).

**D'où une règle de plus dans `drawSpread`, et une seule** : *au plancher vide, l'emplacement
remonte avant de s'arrêter.* Après la boucle de descente :

```ts
while (permis.total === 0 && rarity < RARITY_WEIGHTS.length - 1) {
  rarity++;
  permis = permisAt(rarity);
}
```

Aucun `rng()` de plus (on change de palier, on ne retire pas). Elle ne peut se déclencher que pour
un plancher épique : au plancher commun ou rare, la carte ordinaire d'une arme possédée est toujours
permise, donc le niveau et le coffre ne voient **aucune** différence — leurs tests à graine fixe
restent verts. Avec elle, l'étalage d'un événement fait `min(N + 3, 6)` cartes : **4, 5, 6, 6** pour
1 à 4 joueurs — toujours au moins une par joueur, et à quatre, une de moins que N + 3, assumé.

### 5.3 Ce que dit l'écran

- Le titre de l'étalage (`front/src/ui/draft.ts` l.590-594) : **« Événement »**, à côté de
  « Coffre ».
- Le bandeau de gel (`front/src/ui/hud.ts` l.289) : **« Événement — pause… »**.
- La bordure des cartes : celle de leur rareté, épique ou légendaire (§2.5 des pactes), sans rien
  ajouter.

## 6. Le fil

### 6.1 Trois messages

Dans `shared/protocol.ts`, après `PING_SHOWN: 27` (l.38) — 28 à 30 sont libres sur `main` et sur
les branches en vol (les pactes n'ajoutent aucun type, seulement un octet au `SNAPSHOT`) :

| Message | Sens | Octets | Contenu |
| --- | --- | --- | --- |
| `EVENT_START: 28` | serveur → tous | **5 + 4n** | type `u8` · genre `u8` · durée `u16` (ticks) · n `u8` · n × (x `int16`, y `int16`) |
| `EVENT_STATE: 29` | serveur → tous | **7** | type `u8` · progression `u8` · chariot x `int16` · chariot y `int16` · PV du chariot `u8` |
| `EVENT_END: 30` | serveur → tous | **2** | type `u8` · issue `u8` |

Petit-boutiste, comme tout le protocole ; positions en `int16` comme `PING_SHOWN` (l.2097-2111),
`MAP_SIZE` (6 000) loin du plafond. Constantes `EVENT_START_HEADER_BYTES = 5`,
`EVENT_POINT_BYTES = 4`, `EVENT_STATE_BYTES = 7`, `EVENT_END_BYTES = 2`. `decode` (l.1466) gagne
trois `case`. Le décodeur de `EVENT_START` lit l'en-tête par `viewOf(buf, 5)`, puis exige
`viewOf(buf, 5 + 4n)` (l.936-941) : un message tronqué lève, il ne rend pas des points fantaisistes.

**Les champs :**

- **genre** : `EVENT_KIND` de `shared/evenements.ts` — `SCEAUX` 0, `FORGE` 1, `CONVOI` 2.
- **durée** : `EVENT_DURATION_TICKS`, en ticks *vivants*. ⚠️ **Une durée, pas une échéance datée.**
  Le design parle de « deadline » ; mais le tick du salon avance pendant le gel (`room.ts` l.1323,
  l.1346-1361) alors que l'événement dort (§2.4) : un tick d'échéance absolu serait faux dès le
  premier étalage. Le client pose son échéance sur son horloge `pingClock`, qui dort exactement
  quand l'événement dort : `deadline = pingClock + durée`, à la réception.
- **les points** : les n points du §2.2 — les sceaux, la forge, ou le départ puis l'arrivée du convoi.
  Le client ne recalcule aucun placement.
- **progression** : `floor(255 × fraction)`, 255 seulement à la réussite.
- **chariot** : sa position et `ceil(255 × pv / pvMax)` — 0 seulement détruit. Zéros hors convoi :
  un format fixe vaut mieux que trois.
- **issue** : `EVENT_OUTCOME` — `REUSSI` 0, `EXPIRE` 1, `DETRUIT` 2.

Aucun tick dans ces messages : ils ne touchent pas la simulation du client (il ne rejoue rien), ils
s'affichent à la réception, comme `PING_SHOWN` (§5 de l'étape 9).

### 6.2 La cadence

| Constante (`shared/evenements.ts`) | Valeur |
| --- | --- |
| `EVENT_STATE_PERIOD_TICKS` | **6** (`TICK_HZ / 5` : 5 Hz) |

`EVENT_STATE` part quand `elapsed % EVENT_STATE_PERIOD_TICKS === 0`, donc **seulement pendant un
événement, et pas pendant un gel** (`#stepEvent` n'est pas appelé). `EVENT_START` et `EVENT_END`,
une fois chacun.

Le client interpole le chariot entre les deux derniers états reçus, sur 200 ms (une période) : il le
montre 200 ms en retard, soit 12 px à 60 px/s.

### 6.3 Le coût

| | Calcul | Par client |
| --- | --- | --- |
| `EVENT_STATE` | 7 o × 5 Hz | **35 o/s**, pendant 60 s au plus |
| `EVENT_START` | 9 à 21 o | une fois |
| `EVENT_END` | 2 o | une fois |

Au pire, à quatre : 140 o/s pour le salon, pendant une minute sur quatre. Rien par tick.

### 6.4 L'ordre de diffusion

`Room.drainEvents(): EventMessage[]` rend la file dans l'ordre de mise en file (un départ précède
toujours ses états, qui précèdent sa fin). `server.ts` `#broadcast` (l.571) les encode **après
`drainPickups` (l.621-623) et avant `drainLevelUps` (l.624)** :

- après `DEATHS` (l.579) : sans importance pour l'issue, mais garde l'ordre « morts, puis ce qui en
  découle » du reste de la méthode ;
- **avant `LEVEL_UP`** : c'est ce qui garantit qu'un client a lu `EVENT_END` réussi avant le
  `LEVEL_UP` qui ouvre l'étalage, même quand les deux partent dans le même envoi.

### 6.5 Le client sait que c'est un étalage d'événement, sans octet

Dans `GameClient`, sur le modèle du coffre (`client.ts` l.2345-2356, l.2404-2427) :

- `EVENT_END` réussi : `#eventDraftsOwed++` ;
- `LEVEL_UP` : `#draftIsChest = #chestsOwed > 0` ; sinon `#draftIsEvent = #eventDraftsOwed > 0` ;
  le compteur choisi est décrémenté — **la même priorité que le salon** (§5.1).

Getter `draftIsEvent`, lu par `draft.ts` et `hud.ts` (§5.3).

## 7. L'affichage

### 7.1 Ce que tient le client

`GameClient` gagne :

| Champ | Rôle |
| --- | --- |
| `#event` | `{ kind, points, deadline, progress, cart: { x0, y0, x1, y1, atMs }, cartHp }` ou `null` ; posé par `EVENT_START`, mis à jour par `EVENT_STATE`, remis à `null` par `EVENT_END` |
| `#eventCount` | `EVENT_START` reçus depuis la connexion — l'audio en déduit quand sonner (comme `#porteurCount`, l.1426) |
| `#eventBanner` | `{ text, atMs }` du dernier bandeau, départ ou fin |
| `#eventDraftsOwed`, `#draftIsEvent` | §6.5 |

Getters : `event` (la vue : genre, points, progression 0-1, secondes restantes =
`max(0, deadline − pingClock) / TICK_HZ`, chariot interpolé et PV 0-1), `eventCount`,
`eventBanner` (le texte s'il a moins de `EVENT_BANNER_MS` = **4 000** ms, sinon `null` — constante
à côté de `PORTEUR_BANNER_MS`, `client.ts` l.254), `draftIsEvent`.

Un `EVENT_STATE` reçu sans événement en cours (arrivée en cours d'événement) est ignoré (§10).

### 7.2 Au sol : zones, anneau de progression, chariot

`front/src/render/behavior-renderer.ts`, le calque des formes au sol sous les créatures
(`stage.ts` l.153-154). Une fonction **pure** `eventShapes(event, joueurs, view)` à côté de
`behaviorShapes` (l.68), et leur dessin en `Graphics` procédural dans `draw` (l.220-334) — **aucun
fichier d'image**. Couleur : `COIN_TINT` (`0xf5c542`), l'or du porteur, pour que « doré » veuille
dire « récompense » partout.

| Forme | Dessin |
| --- | --- |
| sceau | disque de `SCEAU_RADIUS`, rempli à 12 % d'alpha, trait de 3 px ; **35 %** et trait de 5 px s'il est occupé par un joueur vivant du `SNAPSHOT` (dérivé côté client, cosmétique) |
| forge | disque de `FORGE_RADIUS`, rempli d'orange `0xff8a3d` à 20 %, trait or ; une petite enclume (deux rectangles bruns `CHEST_BROWN`, l.43) au centre |
| anneau de progression | autour de chaque sceau et de la forge : un arc `g.arc(x, y, r + 10, −π/2, −π/2 + 2π × progression)`, trait or de 6 px |
| chariot | rectangle de 48 × 30 px brun `0x7a4e2a` contouré de `CHEST_BROWN`, deux roues (cercles de 8 px) dessous, un petit coffre `drawChest` (l.50) dessus ; barre de PV de 48 × 5 px au-dessus (vert → rouge) ; cercle d'escorte en pointillé de `CONVOI_ESCORT_RADIUS` à 25 % d'alpha |
| arrivée du convoi | un fanion : un trait vertical de 40 px et un triangle or, à E |

`Stage.drawBehaviors` (l.415-422) prend un paramètre `event` de plus ; `composeFrame` le passe
(`front/src/render/frame.ts` l.309).

### 7.3 Les flèches de bord

`PingRenderer.draw` (`front/src/render/ping-renderer.ts` l.147-201) reçoit en plus `event`, sur le
modèle exact du porteur (l.188-200) : pour chaque point **hors champ** — chaque sceau, la forge, ou
le **chariot** (pas l'arrivée) — `edgeArrow` (l.64) et `drawArrow` en `COIN_TINT`. Dans le champ,
rien. Câblé par `Stage.drawPings` (l.519-541) et `frame.ts` (l.350-356). Aucune fonction nouvelle.

### 7.4 Le HUD

Dans `front/index.html`, deux frères de `hud-porteur` (l.384-389), mêmes classes
(`k k-carved3 f-meta ol mt-[10px] hidden text-[24px]`) :

- **`hud-evenement`**, le bandeau passager : son texte vient de `eventBanner`.

  | Moment | Texte |
  | --- | --- |
  | départ, sceaux | « Les sceaux s'éveillent ! » |
  | départ, forge | « La forge s'allume ! » |
  | départ, convoi | « Un convoi attend son escorte ! » |
  | réussi | « Réussi — étalage de règles ! » |
  | expiré | « L'événement s'éteint… » |
  | détruit | « Le convoi est détruit… » |

- **`hud-evenement-etat`**, visible tant qu'un événement court : « La forge — 62 % — 0:41 »,
  « Le convoi — 40 % — chariot 70 % — 0:33 », le temps formaté par `formatTimer`
  (`front/src/render/stage.ts` l.787).

`HudSource` (`hud.ts` l.100-112) gagne `draftIsEvent?`, `eventBanner?`, `eventStatus?` ; `paintHud`
les bascule à côté du porteur (l.286-290) ; `main.ts` les câble à côté de `porteur:
el('hud-porteur')` (l.202).

### 7.5 Le son

Un effet `'evenement'` rejoint `Cue` (`front/src/audio/audio.ts` l.17-32) : trois notes graves
puis une quinte, distinct de l'arpège `'porteur'` (l.266). `CueSnapshot` gagne `evenements`
(l.37-51, câblé dans `main.ts` l.784-797) ; `cuesBetween` le joue quand il monte (sur le modèle des
l.94-96) ; `MIN_GAP_S.evenement = 1` (l.126). La réussite n'a pas de son à elle : le `LEVEL_UP` d'un
événement ne joue pas `'levelup'`, le niveau ne montant pas (§4.1 de l'étape 11) — le bandeau l'annonce.

## 8. Ce qui n'est PAS dans cette étape

- **L'autel**, le choix de l'événement par l'équipe : il est imposé.
- **Le marchand**, **le noir** (§10 de l'orientation).
- **Une horde qui vise le chariot** : il ne prend que ce qui le frôle.
- **Une vague de plus pour la forge** : la horde ordinaire suffit à converger sur le forgeron (§3.2).
- **La mini-carte** : les flèches de bord suffisent ; un point or par sceau s'ajoute le jour où le
  playtest le demande (`minimap.ts` l.131-137 montre comment).
- **Le rattrapage d'un client arrivé en cours d'événement** (§10).
- Plusieurs événements à la fois ; un événement raté qui coûte quelque chose.

## 9. Les tests et le livrable

| Où | Quoi |
| --- | --- |
| `shared/protocol.test.ts` | aller-retour des trois messages ; tailles exactes (9, 13, 21 ; 7 ; 2) ; positions négatives et au plafond ; un `EVENT_START` tronqué au milieu d'un point lève |
| `shared/rarity.test.ts` | `rollRarity` au plancher `EVENT_RARITY_FLOOR` ne rend qu'épique ou légendaire, à 75/25 sur de nombreux tirages, et consomme un seul `rng()` |
| `shared/cards.test.ts` | `drawSpread` au plancher `EVENT_RARITY_FLOOR` : `min(N + 3, 6)` cartes, toutes épiques ou légendaires, sur de nombreuses graines et N = 1 à 4 ; une graine qui tire quatre épiques d'affilée sort quand même 4 cartes en solo (la remontée) ; aux planchers commun et rare, étalages identiques à ceux d'avant l'étape |
| `back/src/wave-director.test.ts` | aucun événement avant la vague `EVENT_FIRST_WAVE` (20), même à la 3ᵉ vague d'un palier ; le premier à la première 3ᵉ vague de palier qui suit ; aucun autre avant 40 vagues ; `takeEventSeed` rend `null` à la seconde lecture ; **l'empreinte du test l.718-738 inchangée**, `waveId` compris, alors que des graines d'événement sont sorties |
| `back/src/evenement.test.ts` | `placeEvent` : genre = graine % 3 ; site à 1 200 px du centre des vivants (hors bord) ; N sceaux à 800 px de leurs voisins pour N = 2, 3, 4, un seul en solo ; un site muré est sorti du mur ; l'arrivée du convoi à 1 500 px et dans la carte. `EventRun.step` : sceaux — tous tenus avancent, un vide suspend sans remettre à zéro, un mort n'occupe pas ; forge — immobile dans le rayon avance, `moveX` = 0,2 suspend, poussé sans entrée avance encore, 15 s en solo ; convoi — sans escorte immobile, escorté avance à 60 px/s, contourne un mur, 5 ennemis collés ou 50 coûtent pareil, détruit à 0 PV, 800 PV en solo ; expiration à 1 800 ticks |
| `back/src/room.test.ts` | un événement réussi ouvre un étalage gelé dont toutes les cartes sont ≥ épique ; coffre, événement et niveau dus au même tick s'ouvrent dans cet ordre ; l'événement ne progresse ni pendant l'étalage ni pendant la rampe ; `EVENT_STATE` tous les 6 ticks vivants, aucun hors événement ; un seul événement en jeu sur 20 min simulées |
| `back/src/evenement.integration.test.ts` | **le livrable** : deux vraies sockets ; même `EVENT_START` chez les deux ; `EVENT_STATE` à ~5 Hz ; objectif rempli → `EVENT_END` réussi puis `LEVEL_UP` puis `DRAFT_OPEN` à raretés toutes `EVENT_RARITY_FLOOR`, et `draftIsEvent` chez chaque `GameClient` ; `SNAPSHOT` de même taille |
| `front/src/net/client.test.ts` | `EVENT_END` réussi puis `LEVEL_UP` → événement ; `DEATHS` du porteur et `EVENT_END` avant un même `LEVEL_UP` → coffre, puis événement au suivant ; `EVENT_STATE` sans départ ignoré ; secondes restantes figées pendant `isFrozen` |
| `front/src/render/behavior-renderer.test.ts` | `eventShapes` : un sceau par point, occupé si un joueur vivant est dedans ; le chariot et son arrivée en convoi ; rien hors cadre |
| `front/src/render/ping-renderer.test.ts` | flèche or vers un sceau hors champ, vers le chariot hors champ, aucune dans le champ |
| `front/src/audio/audio.test.ts` | `'evenement'` joué une fois quand le compteur monte |
| `front/src/ui/draft.test.ts` | titre « Événement » pour un étalage d'événement |

**Vérification manuelle**, ouverte jusqu'au playtest :

- les trois événements se lisent-ils d'un coup d'œil en pleine horde (zones, anneau, chariot) ?
- les sceaux à 800 px : assez loin pour forcer la séparation, assez près pour se regrouper après ?
- la forge en solo (15 s immobile sous la horde) est-elle jouable ? à quatre, 30 s est-il trop long ?
- 60 px/s, 400 PV, 150 px d'escorte : le convoi est-il tendu sans être injouable ?
- 60 s suffisent-elles quand le site naît à 1 200 px (≈ 5 s de marche à 260 px/s) ?
- un étalage de cartes de règle fait-il événement ? les pactes qu'il offre (25 % des emplacements)
  sont-ils un choix ou un piège ?
- le premier événement vers 2 min : bon moment ?
- le bandeau et le son se remarquent-ils sans gêner ?

## 10. Risques

- **Un pacte imposé.** Un joueur qui ne pose pas de jeton reçoit d'office une carte restante
  (`OUTCOME.AUTO`, `back/src/draft.ts` l.226) ; dans un étalage d'événement, c'est une carte de
  règle, donc peut-être un pacte et son malus. À quatre, l'étalage contient presque toujours les six
  cartes de règle, pactes compris. Le playtest dira s'il faut exclure les pactes de l'attribution
  d'office ; ce n'est pas écrit ici.
- **Six cartes de règle seulement.** Un événement toutes les quatre minutes revoit les mêmes six
  cartes ; le pool grandira avec le contenu des pactes, pas ici.
- **La remontée touche `drawSpread`, fichier des pactes.** Une ligne, mais dans la fonction que les
  pactes viennent de réécrire : ce document suppose leur version fusionnée.
- **Le premier événement dépend des boss.** `EVENT_FIRST_WAVE` est un minimum : une équipe qui ne
  tue pas le boss du palier en cours ne repasse pas par une 3ᵉ vague de palier, et attend.
- **Un sceau orphelin.** Un joueur mort ou parti pendant les sceaux rend l'événement impossible ; il
  s'éteint à 60 s. Recalculer N en cours de route déplacerait des zones sous les pieds des autres.
- **Le client arrivé en cours d'événement** ne voit rien jusqu'au suivant (même choix que le porteur
  jamais annoncé, dont la détection de secours a été annulée à l'étape 11, `de9e8d9`). Il reçoit
  quand même l'étalage, sous le titre « Niveau N » : cosmétique.
- **La flèche d'un sceau proche d'un bord** : le placement borné peut rapprocher deux sceaux sous
  800 px. Rare, sans conséquence de jeu.
- **Le chariot interpolé** est montré 200 ms en retard ; un ennemi qui semble le toucher à l'écran
  peut ne pas l'avoir touché au serveur. Les PV, eux, viennent du serveur.
- **Coût serveur du convoi** : un balayage de la horde par 15 ticks et un BFS par convoi — le même
  ordre que `resolveContact` pour un joueur de plus, une minute sur quatre. À regarder au banc si la
  horde grossit.
