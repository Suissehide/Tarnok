# Étape 2 — résultats

Clôture de l'étape 2, dont la spec est
[`../specs/2026-08-24-etape-2-horde.md`](../specs/2026-08-24-etape-2-horde.md) et le plan
[`2026-08-24-etape-2-horde.md`](2026-08-24-etape-2-horde.md).

**Le livrable du §13 est atteint : mille ennemis convergent identiquement sur cinq
simulations, sans qu'aucune position de monstre ne transite sur le fil.**

---

## 1. Le tableau qui porte l'étape

Cinq scénarios, mesurés par `shared/horde.replication.test.ts`. Chacun fait tourner cinq
simulations en parallèle — un serveur et quatre clients — sur les mêmes ordres de vague.

| Scénario | Dérive maximale | Identités |
| --- | --- | --- |
| 1 000 entités, 600 pas | **0,000 px** | strictement égales |
| Seconde vague en cours de partie | **0,000 px** | strictement égales |
| Apparition tardive (1-2 ticks), **sans** rattrapage | **693,899 px** | strictement égales |
| Apparition tardive (1-2 ticks), **avec** rattrapage | **0,000 px** | strictement égales |
| Séquence **serveur** contre séquence **client** | **0,000 px** | strictement égales |

La troisième ligne est celle qui justifie les quatre autres : c'est ce que produirait le
mécanisme sans les corrections trouvées en cours de route.

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

---

## 5. Ce qui reste ouvert

### 5.1 À faire avant un déploiement

**Déposer l'atlas sur MinIO.** Il est construit localement mais absent du stockage, donc le
rendu ne fonctionne qu'en développement :

```bash
mc cp assets/tinyswords/derived/monsters.png  qwetle/tarnok/derived/monsters.png
mc cp assets/tinyswords/derived/monsters.json qwetle/tarnok/derived/monsters.json
```

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
