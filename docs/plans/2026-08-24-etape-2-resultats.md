# Étape 2 — résultats

Clôture de l'étape 2, dont la spec est
[`../specs/2026-08-24-etape-2-horde.md`](../specs/2026-08-24-etape-2-horde.md) et le plan
[`2026-08-24-etape-2-horde.md`](2026-08-24-etape-2-horde.md).

**Ce qui est prouvé : le déterminisme de `shared/` — mille ennemis convergent identiquement
sur cinq simulations partageant les mêmes entrées — et, depuis la relecture finale du
24 août 2026, la réplication sous une latence réseau simulée (§1.1 ci-dessous). Aucune
position de monstre ne transite sur le fil.**

**Ce qui n'est pas prouvé : le livrable du §13 tel qu'énoncé.** Il parle de quatre
*clients* qui convergent, et aucune des mesures ci-dessous ne fait intervenir un vrai
chemin réseau client↔serveur — `shared/horde.replication.test.ts` instancie cinq
simulations *dans le même process*, sans socket ni sérialisation. La vérification en
conditions réelles du §3 porte sur **un** client, pas quatre, et ne mesure pas la
convergence entre plusieurs clients réels. La relecture finale a de surcroît trouvé un
défaut structurel (§1.1) qui aurait fait diverger un vrai client sous latence — masqué
précisément parce qu'aucun test ne faisait transiter la donnée par un vrai client. Tant
qu'un test n'exerce pas `GameClient` et `Room` avec de vraies sockets, sous une latence
réseau réelle ou simulée à ce niveau, le livrable du §13 reste **partiellement** vérifié,
pas atteint.

---

## 1. Le tableau qui porte l'étape

Sept scénarios, mesurés par `shared/horde.replication.test.ts`. Chacun fait tourner cinq
simulations en parallèle — un serveur et quatre clients — sur les mêmes ordres de vague.

| Scénario | Dérive maximale | Identités |
| --- | --- | --- |
| 1 000 entités, 600 pas | **0,000 px** | strictement égales |
| Seconde vague en cours de partie | **0,000 px** | strictement égales |
| Apparition tardive (1-2 ticks), **sans** rattrapage | **693,899 px** | strictement égales |
| Apparition tardive (1-2 ticks), **avec** rattrapage | **0,000 px** | strictement égales |
| Séquence **serveur** contre séquence **client** | **0,000 px** | strictement égales |
| C1 — historique indexé sous le tick **local**, jamais recalé | **769,738 px** | strictement égales |
| C1 — historique indexé sous le tick **serveur**, recalé en continu | **0,000 px** | strictement égales |

La troisième ligne est celle qui justifie les quatre suivantes : c'est ce que produirait le
mécanisme sans les corrections trouvées en cours de route. Les deux dernières lignes sont
celles de la relecture finale (§1.1) : elles jouent exactement le même rôle pour un défaut
que les cinq premiers scénarios ne pouvaient structurellement pas voir.

### 1.1 C1 — le défaut que la relecture finale a trouvé, et que les cinq premiers scénarios ne voyaient pas

Les cinq premiers scénarios donnent, à **tous** les participants, le même tableau de
positions sous la **même clé de tick** (`history.record(tick, xs, ys)`, où `tick` est la
variable de boucle commune à toutes les simulations). Structurellement, ils ne peuvent pas
révéler un défaut d'*indexation* : `SnapshotBuffer.latest()` (`front/src/net/interpolation.ts`)
jetait le tick du serveur porté par chaque `SnapshotMessage`, et `GameClient#advanceHorde`
(`front/src/net/client.ts`) enregistrait alors le contenu du dernier snapshot reçu sous SA
PROPRE clé de tick locale — qui n'a aucune raison de coïncider avec le tick auquel ce contenu
a été calculé côté serveur. Avec de la latence, `history[T]` du client contenait les positions
du tick `T − latence`, alors que côté serveur `history[T]` contient celles du tick `T` :
`delayed(T)` rendait donc des entrées différentes des deux côtés.

Trois sous-défauts composaient le même mécanisme :

- l'historique était indexé sur le mauvais tick (ci-dessus) ;
- `#lastHordeTick` n'était initialisé qu'une fois, à la réception du `WELCOME` — lui-même
  arrivé après un temps de trajet réseau — puis ne dérivait plus jamais : un client restait
  donc en permanence en retard du temps de trajet du `WELCOME`, pour toute la vie de la
  connexion ;
- rien ne recalait ce compteur en cours de partie : un onglet mis en arrière-plan perdait des
  pas définitivement (le plafond de rattrapage de `update()` les jette), sans que
  `#lastHordeTick` ne s'en aperçoive jamais.

Un quatrième défaut, plus discret, aggravait le tout : `back/src/room.ts` enregistrait des
positions **flottantes** dans son propre historique, alors que le client ne connaîtra jamais
que leur version arrondie à l'entier — le protocole quantifie en `int16`
(`shared/protocol.ts`). Le serveur ne s'imposait pas l'arrondi qu'il impose déjà au retard.

**Mesure, avant/après, sur un scénario dédié** (`shared/horde.replication.test.ts`, ajouté
*avant* la correction pour prouver qu'il la révélait réellement — voir le rapport final de la
relecture) : cinq participants, 1 000 entités, une vague synchrone, 450 pas simulés après
l'apparition, chaque client recevant les positions des joueurs avec 1 à 3 ticks de retard
réseau et un compteur de tick local décalé au départ, comme le produirait un `WELCOME`
lui-même arrivé en retard.

| | Dérive maximale |
| --- | --- |
| **Avant** (indexation locale, jamais recalée) | **769,738 px** |
| **Après** (indexation sous le tick serveur, recalage continu à tolérance de retard = 1 tick) | **0,000 px** |

Le champ de directions discret s'est révélé assez sensible pour que la tolérance de recalage
elle-même compte : dans ce scénario, tolérer un retard persistant de 2 ticks plutôt que 1
suffit à faire remonter la dérive à plus de 600 px (voir le commentaire de
`CATCHUP_TOLERANCE` dans le test, et de `HORDE_TICK_LAG_TOLERANCE` dans `client.ts`).

**Correctifs appliqués** (voir le rapport de la relecture finale pour le détail) :

1. `SnapshotBuffer.latest()` rend désormais `{ tick, players }` au lieu de `{ players }`.
2. `GameClient#advanceHorde` enregistre l'historique sous `snapshot.tick` (le tick serveur),
   plus jamais sous son tick local.
3. `#lastHordeTick` se recale en continu sur le tick du dernier snapshot reçu dès qu'il prend
   plus d'un tick de retard sur lui — tolérance volontairement asymétrique, puisqu'être en
   avance du dernier tick connu est le fonctionnement normal sous latence.
4. `Room.step` arrondit désormais les positions avant de les enregistrer dans son propre
   historique, pour que le serveur travaille sur exactement ce que le client recevra.

Cette classe de défaut n'était détectable par **aucun** des 152 tests qui passaient avant la
relecture : tous démarraient des compteurs de tick proches de zéro et sans latence simulée à
ce niveau précis (indexation + recalage), exactement comme le §4.3 l'avait déjà montré pour le
rattrapage à l'apparition.

### Ce que ces tests savent détecter

Un test qui rend zéro peut aussi bien ne rien comparer. Chaque propriété a donc été
vérifiée par mutation — on casse volontairement le code et on regarde si le test rougit :

| Défaut injecté | Réaction |
| --- | --- |
| Un participant reçoit une carte d'obstacles différente | dérive **1 137 px**, échec |
| Deux identités permutées à indice constant | **1 200** incohérences, échec |
| Protection de la zone d'apparition supprimée | échec du test de carte |
| `fill(0)` retiré d'`applyObstacles` | échec du test de masque tronqué |
| Garde-fou d'ordre d'appel neutralisé | échec du test dédié |
| 300 fausses positions ajoutées au snapshot | **123 902 octets** contre 4 950, échec |

---

## 2. Le réseau

| Grandeur | Mesure |
| --- | --- |
| Ordre de vague | **19 octets**, une fois, quel que soit le nombre d'entités |
| Trafic mesuré, 1 joueur, horde de 172 entités | **913 octets sur 3 s** |
| Trafic attendu « joueurs seuls » | ~990 octets sur 3 s |
| Ce que coûterait une réplication naïve de 1 000 ennemis à 30 Hz | ~**150 ko/s** par joueur |

Le test `back/src/server.test.ts` attend qu'un `WAVE_ORDER` soit réellement reçu avant de
mesurer, puis compare à une **valeur absolue** dérivée des constantes du protocole — pas au
volume de la fenêtre précédente, ce qui laisserait passer une régression présente dès le
début.

---

## 3. Vérification en conditions réelles

Faite au navigateur, sur un serveur et un client réels.

| Critère | Constat |
| --- | --- |
| Entités dans la horde du client | **1 019** |
| Convergence vers le joueur | distance moyenne **705 → 637 px** |
| Silhouettes distinctes à l'écran | deux archétypes simultanés |
| Phases d'animation | **6 distinctes** — pas de marche au pas |
| Tri en profondeur | recouvrements corrects |

> ⚠️ **Une vérification à l'œil dans un onglet en arrière-plan ne prouve rien.** Chrome y
> suspend `requestAnimationFrame` — mesuré : **zéro image en 2,5 secondes**. Le ticker Pixi
> ne tourne donc pas, la horde n'avance pas, et la capture d'écran montre une image
> périmée. C'est le faux bug qui avait coûté du temps à l'étape 0.
>
> D'où la poignée `window.__tarnok` (développement uniquement, absente du bundle de
> production, vérifié par `grep` sur le build) qui permet d'avancer les images à la main.

---

## 4. Ce que l'étape a appris, et qui n'était pas dans la spec

### 4.1 Le §3.3 de l'orientation se trompait d'un facteur 40

Il affirme qu'« une divergence de trois pixels sur un monstre qui vit deux secondes est
invisible ». Mesure réelle, pour une apparition retardée de 1 à 2 ticks — **le cas normal**,
puisqu'un ordre de vague met du temps à arriver :

| Âge de l'entité | Sans rattrapage |
| --- | --- |
| 0,5 s | 25,7 px |
| 2 s | **122,7 px** |
| 10 s | 694,7 px |

Croissance **linéaire, à ~70 px/s, sans borne**.

**La cause n'est pas celle qu'on suppose.** Ce n'est pas la bascule de cible de `retarget` —
écarté par expérience : en forçant une cible unique, donc aucune bascule possible, la dérive
reste à 714 px. C'est **le flowfield lui-même**, champ de directions discret à huit
directions par cellule de 64 px : deux entités décalées d'un seul pas franchissent les
frontières de cellules à des instants différents et prennent des routes divergentes.

**La leçon dépasse l'apparition tardive :** toute différence d'état initial entre deux
simulations s'amplifie au lieu de rester bornée. Le mécanisme du §3.3 ne tolère pas les
approximations « petites » — il exige des entrées identiques.

### 4.2 Le correctif dépend d'un ordre d'appel, à un facteur 35

Rattraper les pas manqués borne la dérive. Mais **seulement s'il a lieu avant le
rafraîchissement du champ du tick courant** :

| Ordre d'application | Dérive |
| --- | --- |
| Rattrapage **avant** le rafraîchissement | 0 à 49 px |
| Rattrapage **après** le rafraîchissement | **782 px** — pire que de ne rien faire |

Un commentaire ne protège pas ça. `FlowField` compte donc ses recalculs, `Horde` relève ce
compteur à chaque pas, et `spawnCatchingUp` **lève une erreur explicite** si elle est
appelée trop tard.

### 4.3 Deux compteurs de ticks incomparables

Le `WELCOME` porte le tick **absolu** du serveur. Le client comptait à partir de zéro. Le
calcul `missedTicks = tick − spawnTick` était donc négatif, clampé à zéro, et **le
rattrapage ne s'exécutait jamais** pour un joueur rejoignant après le premier — c'est-à-dire
presque toujours. Pire, `tick % 3` ne coïncidait qu'une fois sur trois entre les deux côtés,
déphasant le rafraîchissement du champ en permanence.

**Invisible à 152 tests**, parce qu'ils démarrent tous des compteurs proches de zéro.

### 4.4 Le même compteur, décorrélé une seconde fois, plus discrètement

Le §4.3 ci-dessus corrigeait un décalage *initial* du compteur de tick client. La relecture
finale du 24 août 2026 en a trouvé un second, structurellement différent : même corrigé au
démarrage, rien ne recalait ce compteur en continu, et l'historique de positions du client
était indexé sous ce compteur local plutôt que sous le tick serveur porté par chaque snapshot
— voir §1.1 pour le détail et la mesure (769,738 px de dérive avant correction, 0,000 px
après). Aucun des cinq scénarios de réplication existants ne pouvait le révéler : ils
partagent tous la même clé de tick entre tous les participants par construction. Il a fallu un
sixième scénario, écrit pour échouer avant toute correction, pour le prouver.

---

## 5. Ce qui reste ouvert

### 5.1 À faire avant un déploiement

**Déposer l'atlas sur MinIO.** Il est construit localement mais absent du stockage, donc le
rendu ne fonctionne qu'en développement :

```bash
mc cp assets/tinyswords/derived/monsters.png  qwetle/tarnok/derived/monsters.png
mc cp assets/tinyswords/derived/monsters.json qwetle/tarnok/derived/monsters.json
```

En attendant, `Stage.init` (`front/src/render/stage.ts`) encaisse maintenant l'échec du
chargement de l'atlas : avant la relecture finale, un manifeste absent (404) faisait échouer
la promesse au niveau module de `main.ts`, et **les gestionnaires de clic n'étaient jamais
installés** — lobby mort, sans le moindre message à l'écran. Le jeu démarre désormais sans
horde visible plutôt que de tout bloquer, avec un message clair dans la console.

### 5.2 Observation visuelle, pour l'étape 3

La horde forme des **files visibles** en suivant le champ : les entités s'alignent sur les
mêmes couloirs, conséquence directe des huit directions discrètes par cellule. Le §4.1 veut
« des formations denses de chair à canon », pas des colonnes.

**Une séparation entre entités sera nécessaire** pour que la masse respire. C'est par
ailleurs le poste que le banc de l'étape 1 désignait déjà comme prochain goulot, et il n'est
toujours pas mesuré.

### 5.3 Réserves des étapes précédentes, toujours valables

- Le banc de l'étape 1 n'a mesuré **ni séparation, ni collisions, ni dégâts** — les systèmes
  qui scalent mal avec N.
- La colonne « machine faible » du tableau de l'étape 1 reste vide.
- `MAP_SIZE` reste à 6 000. Le §15.2 propose 10 000 ; l'agrandir maintenant n'apporterait
  rien tant que la densité de vagues n'est pas réglée.

### 5.4 Ce que l'étape 3 devra vérifier en premier

Les morts vont **retirer des entités** et compacter les tableaux. Or le §4.1 ci-dessus
montre qu'un décalage d'un seul tick suffit à faire diverger deux simulations sans retour.
**Un décalage d'un tick sur une mort produira exactement le même effet.** Le test de
réplication devra être étendu aux morts dès le premier jour de l'étape 3, pas après.

`Horde.spawn` remet maintenant `targetField` à zéro pour chaque créneau qu'il occupe
(relecture finale, constat I3) : sans cette ligne, correcte aujourd'hui uniquement parce
qu'aucun créneau n'est jamais réutilisé, une entité neuve aurait hérité de la cible du mort
qu'elle remplace dès le premier compactage de l'étape 3.

La horde sature à `MAX_ENTITIES` (4 000) en environ 110 s puisque rien ne meurt encore — c'est
attendu, pas un bug. `Room` compte désormais les vagues tronquées par cette saturation et les
publie dans le HUD de métriques (`RoomMetrics.truncatedSpawns`, colonne « vagues tronquées »)
plutôt que de tronquer en silence : l'étape 3 doit pouvoir distinguer, dans ce même HUD, la
saturation actuelle de la capacité (bénigne, connue) d'une future fuite d'entités mortes non
retirées (un bug).
