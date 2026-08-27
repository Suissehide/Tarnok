# Étape 4 — le draft : résultats

21 commits, 460 tests (342 back, 118 front). On monte de niveau, l'étalage s'ouvre, on pose son
jeton, on obtient une carte, et l'arme qu'on vient de prendre tire.

**Spec :** [`../specs/2026-08-26-etape-4-draft.md`](../specs/2026-08-26-etape-4-draft.md)
**Plan :** [`2026-08-26-etape-4-draft.md`](2026-08-26-etape-4-draft.md)

Le plan comptait douze tâches et il en compte toujours douze. **Mais le modèle de cartes qu'il
décrivait a été remplacé après son exécution complète, sur trois phrases de l'auteur en train de
jouer.** C'est le résultat principal de cette étape.

## 1. Le modèle que le raisonnement avait construit, et celui que le jeu a imposé

La spec décrivait quatre natures de carte, des armes qui montaient de niveau jusqu'à évoluer, un
champ `owner` qui portait l'exclusivité, et une exclusivité d'arme à l'échelle de l'équipe. Tout
cela a été implémenté, testé, et livré sur douze tâches.

Puis l'auteur a joué :

> *« Il n'y a pas de "niveau" d'arme. Si quelqu'un a déjà pris "Lance-flammes", je peux lui "voler"
> la carte la prochaine fois. C'est l'accumulation des cartes qui fait la puissance. »*

| Retiré | Remplacé par |
| --- | --- |
| `WEAPON_LEVEL`, `EVOLUTION` | les armes s'empilent comme les passifs |
| `maxLevel`, `evolutionPassiveId`, `WEAPON_MAX_LEVEL` | rien — plus de borne |
| `Card.owner` | `Loadout.canTake` — l'éligibilité se **dérive** de l'inventaire |
| l'exclusivité d'arme d'équipe | rien — chacun a son propre exemplaire |
| la fenêtre de repioche, `DRAFT_REPICK_TICKS` | l'attribution d'office, immédiate |
| l'octet `phase` de `DRAFT_RESULT` | rien — un seul message par draft |

**Le modèle y a gagné en uniformité.** Une carte est une arme ou un passif ; tout s'empile ; tout
est ouvert à tous ; la résolution est un seul moment. Les cas particuliers qui peuplaient trois
sections de la spec ont disparu **avec ce qu'ils réglaient**.

> Aucun test ne pouvait trouver ça. Tous mesuraient la conformité au modèle décrit, et le modèle
> décrit était cohérent — simplement, il n'était pas le bon jeu.

## 2. Ce que la vérification manuelle a trouvé

| Signalé par l'auteur | Ce que c'était |
| --- | --- |
| « j'ai déjà mon jeton dessus et je peux pas le reprendre » | **deux** défauts composés — le serveur rediffusait les jetons après la fermeture, le client ne les vidait pas à l'ouverture suivante |
| « il n'y a pas de niveau d'arme » | tout le §3 de la spec |
| « je peux lui voler la carte la prochaine fois » | l'exclusivité d'équipe |
| « je peux poser mon jeton dessus » | la négociation elle-même |

### Le cas du jeton fantôme

`Session#broadcast` diffuse `DRAFT_INTENTS` dès que `intents()` n'est pas vide. `Draft` gardait ses
jetons après la fermeture — donc le serveur **rediffusait le jeton du tour précédent à chaque
tick**, jusqu'à l'ouverture suivante. Le client, lui, ne vidait pas sa table à `DRAFT_OPEN`.

Le joueur voyait donc son propre jeton déjà posé sur une carte du nouvel étalage. Et comme le §4.1
fait du reclic un **retrait**, cliquer la carte qu'il voulait la lui refusait.

**Les trois états de `phase` étaient couverts par des tests. Rien ne regardait ce que la machine
laissait derrière elle.**

## 3. Dix-huit tests qui ne testaient rien, et un motif qui revient

**Deux assertions creuses de plus** — la seizième et la dix-septième du projet :

| Le test | Ce qu'il ne voyait pas |
| --- | --- |
| « personne ne repart les mains vides » | `cardIndex >= 0` passe pour un `LOST` : c'est l'indice de la carte **perdue** |
| exclusivité d'équipe de `drawSpread` | le porteur mis **en premier** dans la fixture |

Le §4.4 de la spec — « les perdants d'un reconflit reçoivent l'attribution automatique » — **n'était
pas implémenté**, et le test qui prétendait le couvrir passait pour un joueur qui n'obtenait rien.

### Le motif de l'étape : deux gardes qui se couvrent

**Six occurrences**, dont aucune n'était visible à la lecture :

| Les deux gardes | Ce qui les séparait |
| --- | --- |
| plafond de réduction / plancher d'un tick (`cooldownWithBonus`) | des valeurs que le catalogue n'atteint pas |
| `if (!card) continue` / le `catch` du rangement | **rien** — `noUncheckedIndexedAccess` tient la garde, pas un test |
| garde serveur / garde client sur les jetons périmés | un `DRAFT_INTENTS` arrivant **après** le résultat |
| le `Set` d'unicité / le `splice` de `drawSpread` | **rien** — le `Set` était du code mort |
| `settled` / `state !== 'idle'` dans l'écran | **rien** — mutation inerte |
| `LOST` du serveur / `takenByOther` de l'écran | une entrée que `back/` ne produit pas aujourd'hui |

**La leçon opérationnelle a changé depuis l'étape 3.** Elle disait : *appliquer la mutation, ne pas
la raisonner*. Elle dit maintenant, en plus : **quand une mutation survit, chercher d'abord si une
AUTRE garde la masque, avant d'écrire un test.** Trois de ces six cas se sont soldés par une
suppression de code, pas par un test.

### Le piège de la fixture

Quatre fois, une mutation a survécu parce que la fixture rendait le cas impossible : le porteur mis
en premier, un seul perdant au reconflit, des joueurs qui avaient tous une carte réservée, un `rng`
constant qui rendait l'ordre de consommation invisible. **Compter le cas qu'on croit créer, ne
jamais le supposer.**

## 4. Deux bornes silencieuses, trouvées et mesurées

### Les points de vie tenaient sur un octet

`SNAPSHOT_PLAYER_BYTES` encodait `hp` en `u8`. Le passif « vitalité » ajoute 20 PV par carte : à la
**huitième** (100 + 160 = 260), le joueur se repliait silencieusement à **4 PV** au décodage — de
presque trois barres de vie à la mort en un ramassage. Un plafond à 255 aurait rendu la carte inerte
sans le dire. Le champ passe en `u16`.

### L'empilement lève la borne des projectiles

Le plafond de cinq armes ne borne plus rien : ce sont les exemplaires qui grossissent.

| Exemplaires par arme | Cartes d'armes | Projectiles à quatre joueurs |
| --- | --- | --- |
| 1 | ~5 | 112 |
| 6 | ~30 | 252 |
| 8 | ~40 | **308 — au-delà de l'ancienne capacité** |
| 16 | ~80 | 424 |

`PROJECTILE_CAPACITY` passe de 256 à **1024** et descend dans `shared/` — elle était **recopiée**
côté serveur et côté client. `Projectiles.truncatedProjectiles` compte désormais ce qui n'est pas
parti : **une salve tronquée est une carte que le joueur a payée et qui ne fait rien.**

## 5. Bancs

Les trois bancs de l'étape 3, rejoués :

| | Étape 3 | Étape 4 |
| --- | --- | --- |
| Simulation, p95 à 1 500 | 1,94 ms | **1,92 ms** |
| Rejeu de 3 ticks à 1 500 | 3,60 ms | **3,44 ms** |
| Rejeu de 3 ticks à 4 000 | 13,86 ms | **13,19 ms** |
| Réseau, 4 joueurs réels | 1,09 ko/s | **1,22 ko/s** |
| Saut maximal | 7,17 px | **7,17 px** |

La hausse du trafic (+12 %) est **entièrement attribuable** à l'élargissement de `hp` en `u16` : le
snapshot à quatre joueurs passe de 40 à 44 octets.

### Un quatrième banc, parce qu'aucun des trois ne répondait à la question

La tâche 12 demandait de rejouer les bancs « parce que le tir depuis plusieurs slots change le coût
du tick ». **Aucun des trois ne mesure ça.** `back/bench/slots.bench.ts` le fait :

| Entités | 1 arme | 6 armes × 1 | 6 armes × 8 | 6 armes × 16 |
| --- | --- | --- | --- | --- |
| 1 500 | 2,29 ms | 2,44 ms | 2,88 ms | **3,28 ms** |
| 4 000 | 4,10 ms | 4,72 ms | 6,09 ms | **7,32 ms** |
| projectiles vivants | 15 | 64 | 232 | **424** |
| salves tronquées | 0 | 0 | 0 | **0** |

**La crainte était légitime, la réponse est rassurante.** `Projectiles.collide` est en
O(projectiles × entités), et on pouvait craindre un facteur quatre. Le budget (p95 < 11,11 ms)
reste tenu avec 34 % de marge au pire cas mesuré.

## 6. Le livrable du §13

Quatre vrais clients, sur quatre vraies sockets, montent de niveau, draftent et se disputent une
carte. Le test **assène** ce qu'il prouve plutôt que de constater l'absence de plantage : un conflit
a bien eu lieu, un seul joueur obtient la carte, le perdant repart avec une autre, et un joueur qui
ne pose aucun jeton est servi d'office sans bloquer les autres.

Il dure **22,4 s**, dont 20 s de fenêtre que le joueur silencieux fait courir jusqu'à son échéance.
**Ce coût est structurel** — c'est le §4.4 lui-même.

**Les trois chiffres de réplication de l'étape 3 restent à 0,000 px.** Le draft ne les met pas en
danger, comme le §2 de la spec l'exigeait.

## 7. Deux commits partis avec le lint rouge

Deux fois dans cette étape, un commit est parti alors que le lint échouait : ma commande enchaînait
vérification et commit, et je n'ai lu que la fin de la sortie. La porte est désormais explicite —
elle lit le **verdict** et refuse — mais le défaut est le même que celui que je fais traquer aux
autres : **regarder le résultat qu'on attend au lieu de celui qui est écrit.**

Trois tests intermittents ont été trouvés et corrigés, dont un par pur hasard, une exécution ayant
rougi là où l'exécution isolée passait :

- le test des drafts enchaînés dépendait de `Math.random()` via `mapSeed` — `Room` accepte
  désormais une graine ;
- le test de réplication de l'étape 2 coûte 5,7 s contre 5 s de délai par défaut : il échouait une
  fois sur quatre **sans rien dire du contrat qu'il garde**. Le délai déclare maintenant le coût
  réel ;
- un test de cadence mesurait sur une fenêtre trop courte pour séparer deux recharges.

## 8. Ce qui reste ouvert

- **Deux passifs sur cinq ne changent rien.** « Puissance » et « acier » calculent un bonus de
  dégâts **inerte** : la piétaille n'a aucune réserve de points de vie depuis l'étape 3, un
  projectile qui touche est toujours létal. Vérifié à son seul point observable pour qu'il ne soit
  pas du code mort silencieux. À rouvrir le jour où des élites auront des PV.
- **La révélation finale n'a qu'une seconde**, et par accident : le gel se termine au tick de
  fermeture, et l'écran vit le temps de la rampe de reprise (`LEVEL_RESUME_TICKS`), une constante
  de l'étape 3 dont ce n'était pas le rôle. Correctif identifié (`DRAFT_REVEAL_TICKS`, à dater côté
  serveur), non appliqué : c'est un jugement.
- **`draftScreen.update()` n'est gardé par aucun test.** Retirer l'appel dans la boucle de rendu
  laisse 118 tests verts — `main.ts` fait `await stage.init()` au niveau module et n'est pas
  testable en l'état. C'est exactement le défaut « gel de niveau côté client » de l'étape 3.
- **Le conflit ne se voit qu'à deux clients.** Une run solo ne l'exercera jamais.
- **L'arrondi avale l'empilement sur les armes rapides** : sur la dague (7 ticks), les deux
  premières cartes de cadence ne changent rien.
- Hérité de l'étape 3 : le plafond de 4 000 entités n'est plus tenu, et le multijoueur n'a jamais
  été joué sur un vrai réseau.
