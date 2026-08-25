# Étape 3 — le combat : résultats

50 commits, 294 tests (234 back, 60 front). Une run solo se joue de bout en bout : on tire,
les ennemis meurent, on ramasse, on monte de niveau, on finit par mourir.

**Spec :** [`../specs/2026-08-24-etape-3-combat.md`](../specs/2026-08-24-etape-3-combat.md)
**Plan :** [`2026-08-24-etape-3-combat.md`](2026-08-24-etape-3-combat.md)

## 1. Le livrable : la réplication survit aux morts

L'étape 2 avait prouvé que mille ennemis convergent identiquement à partir d'un message de
19 octets. L'étape 3 mettait ça en danger deux fois : la **séparation couple** les entités —
retirer un ennemi en déplace des dizaines — et les **morts arrivent en retard**.

| Scénario | Dérive maximale |
| --- | --- |
| Morts + séparation, **sans** rejeu | **750,039 px** |
| Morts + séparation, **avec** rejeu | **0,000 px** |
| Mort sortie de l'anneau, appliquée au présent et signalée | **433,988 px** |

216 morts sur 1000, horde déplacée de 5829 px. Une dérive de zéro sur une horde immobile ne
vaudrait rien ; ces deux chiffres sont là pour qu'on puisse le vérifier.

La ligne à 750 px est la plus utile du tableau. Elle mesure ce que le mécanisme ferait **sans
ses corrections**, et retombe sur l'ordre de grandeur des 694 et 769 px de l'étape 2 — même
cause, même croissance sans borne. Un test qui ne prouve que le bon cas n'apprend rien sur la
raison d'être de la machinerie.

## 2. La porte de performance, et pourquoi elle a d'abord échoué

Le §3.3 de la spec engageait trois issues **avant** la mesure, pour ne pas trancher sous la
pression du résultat.

| Mesure du rejeu à 1 500 entités | Verdict |
| --- | --- |
| Première exécution | 4,56–4,95 ms → **rouvrir le §3.2** |
| Après correction | **1,12 ms** → « à borner » |

**La porte avait sauté pour une constante fausse, pas pour l'architecture.** `SEPARATION_STRENGTH`
valait 120 px/s, et à cette valeur la répulsion perd contre le flowfield : l'équilibre n'est
jamais atteint, la densité monte tant que des monstres arrivent, et le coût — qui croît avec le
**carré** de la densité — explose.

| Force | Voisins à t60 → t360 | Rejeu de 3 ticks |
| --- | --- | --- |
| 120 | 11,5 → **29,0**, jamais stable | 3,8 ms |
| **1200** | **3,5 → 4,0, stable** | **1,3 ms** |

Écarté par la mesure : la formation n'y était pour rien (SCATTER et CLUSTER convergent vers la
même densité), et **plafonner le déplacement par tick aggrave le mal** — brider la poussée
empêche l'entassement de se relâcher.

Le tableau « Cohérence des constantes » du plan donnait `SEPARATION_STRENGTH` comme « réglage
de sensation, sans effet sur le déterminisme ». Vrai pour le déterminisme, faux pour le coût,
dont c'est le principal levier. **Un tableau de contraintes ne protège que si les contraintes
qu'on y écrit sont les bonnes.**

Le banc porte désormais deux colonnes de densité et bascule son verdict sur « mesure invalide »
quand l'équilibre n'est pas atteint.

## 3. Bancs

Séparation, après réglage — équilibre atteint à tous les effectifs :

| Entités | Pas sans séparation | Pas avec | Rejeu de 3 ticks | Verdict |
| --- | --- | --- | --- | --- |
| 1 000 | 0,01 ms | 0,18 ms | 0,71 ms | OK |
| **1 500** | 0,01 ms | **0,28 ms** | **1,12 ms** | à borner |
| 4 000 | 0,04 ms | 0,81 ms | 3,24 ms | à borner |

Réseau, salons réels à 4 joueurs : **1,09 ko/s par joueur**, un cœur saturé vers 79 salons —
sans rapport avec le nombre d'entités, comme l'exige le §3.3.

Flowfield à 1 500 entités, cellule de 64 px : une passe de quatre champs en 0,84 ms.

## 4. Ce que la vérification manuelle a trouvé, et qu'aucun test ne pouvait voir

La run a été jouée par l'auteur, au premier plan. Trois retours, dont deux ont ouvert du
travail réel.

**La masse respire.** Les files de l'étape 2 ont disparu : c'était la raison d'être de la
séparation, et elle est remplie.

**Le jeu était injouable.** Le générateur de vagues était resté celui de l'étape 2, calibré
pour charger le *rendu* à 1000 entités.

| | Avant | Après |
| --- | --- | --- |
| Apparitions, vague 1 | ~37/s | **3,67/s** |
| Morts par seconde | 2/s | jusqu'à **4,29/s** |
| Temps jusqu'au niveau 2 | inatteignable | **~14 s** en jouant |

Réplication à 0,000 px, combat arbitré, 266 tests verts — et injouable. **La vérification
manuelle n'est pas une formalité de clôture, c'est le seul instrument qui mesure cette classe
de défaut.**

**Deux bugs de rendu, une cause chacun, aucune détectable par la suite.**

*Les monstres sortaient de la carte.* Mesuré : `x ∈ [−6580, 8486]` sur une carte de 6000.
`SeparationGrid.apply` était le seul chemin qui n'était pas borné — `Horde.step` et les
formations d'apparition l'étaient déjà. Ce n'est pas un défaut de réplication : les deux côtés
sortaient de la carte **identiquement**, à 0,000 px de dérive. Il a fallu que quelqu'un joue
près d'un bord.

*Le clignotement de z-index* venait de la largeur de bande du tri de profondeur : 64 px, avec un
commentaire qui la justifiait par « à l'intérieur d'une bande l'ordre est indifférent, c'est la
hauteur d'un demi-sprite ». **C'est exactement à l'envers** : sur un demi-sprite de haut, deux
entités se recouvrent presque totalement, donc savoir laquelle passe devant est on ne peut plus
visible.

| Bande | Inversions d'ordre que rien dans les `y` ne justifie |
| --- | --- |
| 64 px | 1,99 % des paires |
| **2 px** | **0,15 %** |

Deux fausses pistes écartées par la mesure avant d'arriver là : la corruption du tri par un
`bandOf` hors bornes (il était gardé depuis toujours) et l'instabilité de l'ordre du tableau
après compaction (un départage stable par identité ne change **rien** — 31 228 inversions
contre 31 698). J'ai avancé les deux avec assurance ; les deux étaient fausses.

**La visée suit désormais le curseur**, décision de l'auteur contre le §5.3 de la spec. La
direction cesse d'être dérivable : elle transite dans `INPUT` (5 → 7 octets) puis se
redistribue dans le `SNAPSHOT` (6 → 8 octets par joueur), parce que chaque client dessine aussi
les tirs de ses alliés. 240 o/s à quatre joueurs, sans rapport avec le nombre d'entités.

## 5. Onze tests qui ne testaient rien

C'est le résultat le plus transférable de cette étape. **Onze tests écrits dans ce plan se sont
avérés incapables d'attraper le défaut qu'ils nommaient.** Aucun n'était visible à la lecture.
Tous l'étaient en cassant le code.

| Le test | Ce qu'il ne voyait pas |
| --- | --- |
| « n'alloue pas à chaque appel » | mille appels dans `not.toThrow()` — réintroduire l'allocation le laissait vert |
| « ne touche pas au-delà du rayon » | entités à 84 px = deux cellules d'écart : la grille n'examinait jamais la paire |
| « emmène toutes les propriétés » | vérifiait 2 des 7 tableaux ; supprimer `x`, `y` ou `targetField` passait |
| filtre `slot >= 0` | masqué par coïncidence : une identité inconnue seule était confondue avec `previous = -1` |
| dérivation des salves | comparait **deux tableaux vides** — les armes ne tiraient jamais |
| réplication, scénario 9 | morts toujours sur une frontière de rafraîchissement : un réamorçage faux rendait 0,000 px |
| `#drainPendingDeaths` | jamais deux lots au même tick : la boucle pouvait devenir un seul `shift()` |
| `orbs.expire` | aucun test — les orbes pouvaient ne jamais disparaître |
| prédiction locale du tir | jeter la position prédite laissait 18 tests verts |
| suppression du tir pendant le gel | tirer pendant le gel laissait 18 tests verts |
| `bandOf(63) === 0` | gardait la **valeur d'une constante**, pas le comportement — a échoué en changeant la bande |

**Le motif ne varie pas : le test met en scène la bonne intention mais rate la ligne qu'il
nomme.** Deux ont été trouvés parce qu'un *chiffre* était suspect, pas parce que le code se
lisait mal. Cinq ont été trouvés par les implémenteurs eux-mêmes, en cherchant des mutations
survivantes de leur propre initiative.

La leçon opérationnelle : **appliquer la mutation, ne pas la raisonner.** Un test vert dont on
n'a pas vu l'échec ne prouve rien.

## 6. Cinq erreurs du plan, corrigées par les implémenteurs

Le plan s'est trompé plus souvent que le code. Chaque fois, l'implémenteur a signalé la
contradiction au lieu de choisir en silence.

- **L'ordre du tick** : le brief inversait rafraîchissement et engendrement. Le code éprouvé —
  celui qui mesure 0,000 px — faisait l'inverse depuis l'étape 2.
- **L'auto-visée sur `T − K`** : le retard marche pour le flowfield parce qu'il porte sur des
  positions **répliquées**. Le ciblage dépend de la horde, *dérivée*, dont le désaccord vient de
  la propagation des morts et non de la latence d'entrée. J'avais emprunté un mécanisme qui
  résout un problème pour l'appliquer à un autre. `TARGETING_DELAY_TICKS` supprimée.
- **La contrainte anti-tunnel** : `PROJECTILE_HIT_RADIUS ≥ vitesse / TICK_HZ` ne protégeait que
  les cibles pile sur l'axe de tir. Une parade numérique à un problème géométrique. `collide`
  balaie désormais le segment parcouru, et la contrainte a été supprimée **avec son test**.
- **Le rejeu des projectiles** : le plan le demandait. Leur position ne dépend que de leur
  vitesse ; les rejouer les faisait avancer **deux fois**.
- **Deux dispositions de messages** absentes ou contraires au modèle de jeu — dont l'expérience
  portée par joueur alors qu'elle est celle de l'équipe, ce qui créait **deux sources de vérité
  pour un seul nombre**.

## 7. Le piège qui a coûté 79 px

`HordeHistory.restore` remet la *horde* au tick de la mort. Mais `FlowField` est un objet
**mutable partagé** que l'anneau ne sauvegarde jamais : au démarrage du rejeu il porte encore le
dernier rafraîchissement réel — celui du présent, plusieurs générations trop frais.

C'est mot pour mot le défaut déjà documenté sur `Horde.spawnCatchingUp` à l'étape 2 : **le bon
mécanisme dans le mauvais ordre est pire que rien.** Sans réamorçage, le scénario 9 mesurait
79,3 px au lieu de 0,000.

## 8. Ce qui reste ouvert

- **La visée au curseur n'a pas encore été jouée.** Le ressenti du tir reste à valider.
- **`shared/targeting.ts` et `Projectiles.fireSalvo` n'ont plus d'appelant** depuis la visée au
  curseur. Conservés pour l'étape 4 (armes à tête chercheuse), et **annotés comme tels** — un
  module qui nomme un mécanisme absent induit en erreur.
- **`Horde.slotOf` est un balayage linéaire**, appelé une fois par mort. À cent morts sur quatre
  mille entités, 400 000 comparaisons par tick. Mesurer avant de remplacer.
- **`Projectiles.collide` est en O(projectiles × entités)**, sans grille spatiale. Même règle.
- **Le multijoueur réel n'a pas été joué** : la spec §13 demande quatre vrais clients sur un vrai
  réseau. Le test de réplication modélise la latence, il ne la subit pas.
- **Le réglage n'est pas fini.** Le test « le niveau 2 est atteignable » garde ce qu'il annonce,
  pas la *qualité* du réglage — cette distinction est réelle, et c'est l'œil de l'auteur qui en
  tient lieu.
