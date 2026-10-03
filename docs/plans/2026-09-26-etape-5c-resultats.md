# Étape 5c — la Chaux, le Vif-argent : résultats

32 commits, **1 536 tests** (1 064 back, 472 front). Deux éléments, neuf réactions, quatre armes —
et le **tableau des six éléments est clos** : les quinze paires existent, le champ de 3 bits est
plein, et le pitch du README est pour la première fois une assertion plutôt qu'une phrase.

**Spec :** [`../specs/2026-09-26-etape-5c-chaux-vif-argent.md`](../specs/2026-09-26-etape-5c-chaux-vif-argent.md)
**Plan :** [`2026-09-26-etape-5c-chaux-vif-argent.md`](2026-09-26-etape-5c-chaux-vif-argent.md)

Le plan comptait onze tâches. Il les a livrées toutes, sans en ajouter aucune. Mais **trente
décisions** ont dû être prises à l'exécution, dont **neuf corrigent mes propres documents ou mes
propres mesures**. Deux d'entre elles sont les plus coûteuses du projet à ce jour : quatre mécanismes
de cette étape étaient **morts en production** après avoir été déclarés corrects deux fois, et le
livrable portait un **faux vert**.

⚠️ **Ce document est ouvert.** Le §12 attend la run de l'auteur.

## 1. Le livrable : six éléments, quinze réactions

`back/src/elements-5c.integration.test.ts` — 1 513 lignes, quatre tests, quatre vraies sockets.

**Les quinze réactions se déclenchent une par une, identifiées, et rien d'autre.** Le décor est
**trois salons successifs**, quatre clients chacun, **une seule arme élémentaire par joueur** :

| Salon | Éléments portés | Paires neuves |
| --- | --- | --- |
| A | Braise, Givre, Foudre, Poix | 6 — Choc thermique, Surchauffe, Embrasement, Supraconduction, Verglas, Court-circuit |
| B | Chaux, Vif-argent, Braise, Givre | 5 — Aveuglement, Fournée, Éclat de gel, Vaporisation, Gel profond |
| C | Foudre, Poix, Chaux, Vif-argent | 4 — Arc caustique, Paratonnerre, Mortier vif, Amalgame |

6 + 5 + 4 = **15**, et le test assène ce `[6, 5, 4]` lui-même.

**Pourquoi trois salons et pas un.** Quatre joueurs portant chacun **une** arme élémentaire couvrent
quatre éléments, donc C(4,2) = **six** paires. Un salon unique ne peut donc pas produire les quinze
avec les deux côtés tirés par deux joueurs **distincts**. Donner deux armes élémentaires à un joueur
le ferait — et réintroduirait exactement l'instabilité du livrable de 5b, qui échouait **2 fois sur
13** parce qu'un joueur portait deux éléments : quand ses deux projectiles atterrissaient dans le
même pas, la réaction cessait d'être inter-joueurs.

Conséquence : **aucune marque n'est posée à la main**. Le livrable de 5b entretenait l'autre élément
de chaque paire sur la cible (quatre appels) ; celui-ci n'en fait aucun. Les deux côtés de chaque
paire sortent toujours d'une **arme réelle** tirée par deux joueurs différents. C'est strictement
plus fort que l'étape précédente.

**Et `synergyCharge` est assénée sur chaque réaction de chaque phase**, plus la barre qui suit les
charges. C'était le trou nommé du livrable de 5b : la mutation « la Synergie ne charge jamais » —
la règle que le code appelle *le cœur du projet* — y laissait trois tests verts.

**La meilleure assertion du fichier**, d'après la revue indépendante : la somme des lots par cible
égale le total reçu. Elle est rendue **non contournable** par l'écartement des cibles — plus de
`4 × ZONE_RADIUS` = 280 px, contre un lot de rayon `BUCKET` = 140 : une réaction ne peut donc tomber
ni dans deux lots ni hors de tous sans faire rougir la somme. C'est ce qui tue la lecture « les
quinze se déclenchent, et n'importe quoi d'autre aussi ».

## 2. Le pitch du README devient une assertion

« Un joueur seul ne peut pas couvrir assez d'éléments pour tout déclencher lui-même » est la première
phrase du README depuis l'étape 0. Elle n'avait jamais été testée.

Elle l'est : quatre slots d'armes, quatre éléments distincts, **six** paires atteintes — l'ensemble
exact, comparé champ à champ — et les **neuf** autres jamais vues. Plus l'assertion que la production
**refuse** un cinquième élément : `Loadout#addWeapon` lève, et l'effet observable (le loadout reste à
quatre) est épinglé lui aussi. Le pitch repose donc sur le code, pas sur l'arithmétique du test.

⚠️ **Et il a fallu corriger ce test après revue.** Il se jouait sur `ELEMENTS_REELS.slice(0, 4)` —
qui, puisque `CHAUX = 5` et `VIF_ARGENT = 6`, tire exactement **les quatre éléments d'avant cette
étape**. Les neuf paires « interdites » étaient donc toutes et seulement celles qui exigent les deux
éléments neufs : **aucune arme du salon ne pouvait les porter**, et la moitié négative était quasi
tautologique. Corrigé en prenant la **queue** de la liste : les éléments neufs passent par le chemin
solo, et les paires **anciennes** peuplent la moitié négative.

## 3. Le tableau est clos, et c'est l'arithmétique qui le ferme

Six éléments font C(6,2) = **quinze** paires. Le dépôt en nomme **quatorze** dans `REACTION_DEFS` ;
la quinzième est **Choc thermique** (Braise + Givre), le chemin générique de l'étape 5a, qui porte
l'identifiant de réaction `0`. Quatorze + une = quinze, sur un **nibble de 4 bits** qui en tient
quinze exactement.

L'élément tient sur **3 bits** : sept valeurs, dont les six du jeu plus `NEUTRE` — l'identifiant 7
est pris par une sentinelle de test. **Le champ est plein.** Un septième élément ne tiendrait pas
sans changer l'octet de `ZONE`, donc sans rouvrir le contrat de réplication. C'est pour ça que le
§6.3 de la spec s'appelle « Les six éléments » et qu'il **ferme la liste**.

## 4. Le motif de l'étape : « le décor qui masque », cinquième et sixième formes

L'étape 5b en avait nommé quatre. Celle-ci en ajoute deux.

**Cinquième forme — deux mécanismes rendus indiscernables par l'ordre relatif de deux constantes.**
`LINK_RADIUS = 80` est plus petit que `REACTION_RADIUS = 90`. Tant que cet ordre tient, un ennemi lié
est **toujours** aussi dans le rayon de la réaction : le partage d'Amalgame et un balayage générique
rendent le **même** résultat, et le test qui prétendait les séparer ne les séparait pas. Il a fallu un
décor où un ennemi est lié **sans** être dans le rayon — donc un décor qui dépend de l'ordre inverse.

**Sixième forme — le mécanisme mort, déclaré correct deux fois par lecture de la spec.** Voir le §5.

## 5. Quatre mécanismes morts en production, et ce qui les a trouvés

**Ce que j'ai jugé, deux fois, sans mesurer.** `linkedNeighbours` ne suivait que les zones dont le
nibble de réaction valait `0`. J'ai statué que c'était correct au point de revue n°5, puis encore au
n°13, **en lisant la spec les deux fois**. La spec disait « une zone de Vif-argent lie » ; le code
disait « une zone dont la réaction est nulle **et** l'élément Vif-argent ». J'ai lu la première
phrase dans la seconde.

**Ce qui l'a trouvé : un compteur dans le banc.** `zonesLiantesVues = 0` sur 2 700 ticks de jeu réel.
Zéro, pas « peu ». Et la raison est structurelle, donc définitive : `postZone` est le **seul**
créateur de zones, il ne tourne que depuis `applyReactions`, et les **cinq** paires du Vif-argent
sont **toutes nommées** — donc aucune zone produite par le jeu n'a jamais pu avoir un nibble nul avec
un élément Vif-argent. Le filtre ne filtrait pas : il **excluait tout**.

Morts en production, pendant toute l'étape, avec leurs tests verts : **Amalgame, Vaporisation,
Paratonnerre, et le rayon de touche élargi**.

**Et une mesure qui ne mesurait rien.** J'avais écrit : « 1,29 ms isolé à 500 déclencheurs, 6× sous le
budget ». Ce chemin ne s'exécutait pas. Le même décor, une fois le mécanisme vivant, mesure
**243,5 ms**. Un banc peut rendre un chiffre rassurant précisément parce que le code qu'il croit
mesurer ne tourne pas.

**Et mon correctif a dépassé la cible.** Faire lier **toute** zone appariant le Vif-argent inversait
la décision écrite de la tâche 6, qui exclut Gel profond et Aveuglement. Corrigé en un champ explicite
`zoneVifArgent` sur les trois réactions concernées — une table, pas une déduction. Et un seul critère
pour les **deux** consommateurs (`linkedNeighbours` et `hitRadiusBonusAt`), qui divergeaient.

Après correctif : `zonesLiantesVues` = **261**.

**La leçon, écrite pour la prochaine étape :** *une lecture de spec n'est pas une mesure.* Un
mécanisme déclaré correct doit porter un compteur qui prouve qu'il **tourne**.

## 6. Le livrable portait un faux vert — et un vert intermittent se croit

Trouvé par une revue indépendante **après** cinq runs verts et une campagne de mutation à 5 sur 5.

Le test du rayon élargi place une cible à **40 px** de la trajectoire d'un frôlement, entre le rayon
de base (32 px) et le rayon élargi (48 px) : elle ne doit être touchée que si le bonus existe. Mais :

- la cible est **vivante et mobile** — `skull`, 95 px/s, soit **3,17 px/tick** — et sa distance au
  joueur le plus proche (72 px) dépasse `CONTACT_RADIUS = 34`, donc elle n'est jamais figée ;
- sa traction vers ce joueur a une composante **latérale de −1,76 px/tick**, c'est-à-dire **vers** la
  trajectoire ;
- le pilote qui la rè-épinglait tournait en **horloge murale** (`setInterval(…, 8)`) alors que la
  simulation tourne en **ticks**, et `MAX_CATCH_UP_STEPS = 5` : après un blocage de boucle ≥ 167 ms,
  **cinq `room.step` s'enchaînent sans un seul rè-épinglage** ;
- cinq pas de dérive = **−8,8 px** → l'écart tombe à **31,2 px < 32 px** → le projectile accroche au
  **rayon de base**, et le seul test qui décide du §4 passe **avec `hitRadiusBonusAt` à zéro**.

**Un rouge intermittent se diagnostique ; un vert intermittent se croit.** C'est la pire catégorie, et
la charge concurrente qui l'ouvre est exactement celle qui, ailleurs, ne produisait que des rouges.

**Trois géométries ont été étudiées et écartées** : rendre la traction parallèle au rayon, inverser le
signe de l'écart latéral, figer la cible par `stopped`. Toutes échouent parce que les joueurs
apparaissent aux **quatre coins** — le joueur le plus proche de la cible se trouve **toujours** du côté
de la trajectoire — et parce que `CONTACT_RADIUS = 34` est plus petit que l'écart requis de 40, ce qui
rend `stopped` inatteignable.

Le correctif **enveloppe `Room#step`** : épingler avant le pas, relever après. La dérive devient
bornée par **un seul tick = 1,76 px** contre 8 px de marge, et bornée de façon **déterministe** au lieu
de statistique. Et un témoin enregistre la distance perpendiculaire **à chaque tick** pour assener
`min >= PROJECTILE_HIT_RADIUS` : la touche ne peut alors venir **que** du rayon élargi, par **mesure**
et non par espérance géométrique. La mutation `hitRadiusBonusAt → 0` rougit désormais.

## 7. Le contrat de réplication tient, neuf familles de scénarios

| Scénario | Sans rejeu | Avec rejeu | Témoin : l'effet mord vraiment |
| --- | --- | --- | --- |
| ZF — Supraconduction | 696,921 px | **0,000 px** | 649,886 px d'écart au témoin neutre |
| VF — Verglas | 521,515 px | **0,000 px** | 588,963 px |
| CF — Chaux | 1 484,405 px | **0,000 px** | 1 406,740 px |
| GF — Gel profond | 675,747 px | **0,000 px** | 629,295 px |
| MV — Mortier vif | 646,606 px | **0,000 px** | 718,004 px |
| AV — Aveuglement | 1 385,808 px | **0,000 px** | 1 282,842 px |

Chaque zéro est **apparié à deux non-zéros** : la dérive sans rejeu prouve que le rejeu fait le
travail, le témoin prouve que l'effet existe. Un zéro seul ne prouverait rien — il serait compatible
avec un effet qui ne s'applique jamais.

⚠️ **La réplication n'est PAS mesurée dans le livrable d'intégration**, et c'est voulu : le décor d'un
test à quatre sockets balaie la horde par `Horde.kill`, qui court-circuite volontairement le lot
`DEATHS`. Un client qui dériverait sa horde du fil divergerait **par construction**, et le chiffre
lu là ne dirait rien des réactions.

## 8. Bancs, mesurés à froid — et deux faux débordements qui étaient les miens

**La porte du §7, chaîne seule :** pire p95 **8,581 ms** à 4 000 entités et **64** exemplaires par
joueur, soit **77,2 %** du budget de 11,111 ms. ON GARDE.

**Saturation des zones :** `truncatedZones` = **0** sur les quatre verdicts — rafale 20 s et soutenu
60 s, à quatre éléments puis à **six**. Occupation maximale **55/128 = 43,0 %**. La fusion sur le
`kind` complet tient avec 57 % de marge.

**Le pas complet, liaison Amalgame vivante :**

| Entités | Exemplaires/joueur | Pas p95 | Part du budget | |
| --- | --- | --- | --- | --- |
| 4 000 | 8 (plafond du jeu) | 5,976 ms | 53,8 % | OK |
| 4 000 | 16 | 7,018 ms | 63,2 % | OK |
| 4 000 | 32 | 9,027 ms | 81,2 % | OK |
| 4 000 | 64 | **12,758 ms** | **114,8 %** | HORS BUDGET |

**Un seul débordement réel subsiste**, à 64 exemplaires par joueur. Rien dans le jeu n'y mène
aujourd'hui : la section est explicitement étiquetée « aucun plafond de jeu ». Dans le régime jouable
(≤ 8), le pire est 53,8 %.

**L'attribution, mesurée balayage par balayage** à 4 000 entités lourdes et 128 zones :

| Balayage | p95 | Part de la somme |
| --- | --- | --- |
| `appliquerDegats` — `ampAt` + `armorReductionAt` | **9,303 ms** | **39,0 %** |
| `resolveVerglasCollisions` — `collisionDamageAt` | 4,510 ms | 18,9 % |
| `resolveBurn` — `burnAt` | 4,484 ms | 18,8 % |
| `Projectiles.collide` — `hitRadiusBonusAt` (borne haute) | 4,420 ms | 18,5 % |
| `Horde.step`, delta zones | 1,162 ms | 4,9 % |

C'est `appliquerDegats` qu'il faut borner en premier, et son coût est proportionnel aux **touches qui
atterrissent**, pas aux zones. Le borner demande un **index spatial pour les zones** : hors périmètre
de 5c, inscrit au §11 comme dette.

⚠️ **Et un aveu de méthode.** Mes premiers relevés donnaient `truncatedZones = 493`, une occupation
128/128, et un pas de 14-16 ms à 64 exemplaires. **Les trois étaient faux** : mesurés pendant que
plusieurs suites de tests et un autre banc tournaient sur la même machine. Un agent qui me
contredisait avait raison. **Le banc et le portique tournent seuls, sinon leurs chiffres ne valent
rien.**

## 9. Un plantage de production, trouvé par une arme de trop

L'atlas des projectiles était une grille **fixe de 16 cases**. La dix-septième arme de l'étape
plantait le jeu **au démarrage**. Corrigé en dérivant la colonne du nombre d'armes :
`Math.ceil(Math.sqrt(WEAPONS.length))`. Une constante figée sur une valeur qui venait de changer — la
première forme du « décor qui masque », mais côté production.

## 10. Le portique rougissait sur un délai, trois fois, jamais sur une assertion

Trois vagues de rouges intermittents ont coûté une demi-journée. **Aucune n'était un défaut de
code** ; les trois étaient des délais dépassés, et les causes diffèrent :

1. **Ma propre charge.** Quatre rouges sur une suite lancée pendant que des agents et un banc
   tournaient ; les mêmes fichiers relancés seuls donnaient 39/39. Pas de correctif au dépôt — une
   discipline : le portique tourne seul.
2. **Le front tournait sur le délai par défaut de 5 s.** Ses 132 tests les plus lourds coûtent
   **4,71 s à eux tous** machine libre, mais deux d'entre eux ont été mesurés à **13,1 s et 13,3 s**
   dans la suite complète — treize fois leur coût réel, par famine de CPU. Et ils sont **entièrement
   déterministes** : leur paramètre de temps est une variable de boucle, jamais une horloge. Relevé
   à 60 s, comme le back l'avait déjà fait deux fois.
3. **Les scénarios de réplication dépassent 60 s.** Mesure `--reporter=verbose`, fichier seul :

   | Scénario | Coût |
   | --- | --- |
   | 11a — la charge déplace le boss | **104,3 s** |
   | GF0 — Gel profond mord | **96,2 s** |
   | MV0 — Mortier vif mord | **72,5 s** |
   | 11b — charge sans rejeu | **65,5 s** |
   | VF0 — Verglas mord | **63,4 s** |

   Cinq scénarios au-dessus des 60 s déclarés, dont deux au-dessus de 90 s. Et le même relevé dans la
   suite **complète** donne 62,2 s et 71,7 s pour les deux pires — **moins que seuls** : le coût de ce
   fichier varie d'un facteur **1,5** selon l'état de la machine, donc un délai au ras de la mesure
   rougit au hasard.

   Troisième relèvement de ce fichier (30 s à l'étape 4, 60 s à l'étape 6a) et **premier à être mesuré
   scénario par scénario**. Le réglage est **local au fichier** : les 1 026 autres tests gardent 60 s,
   parce qu'un vrai blocage doit se voir vite. Relever le réglage global aurait émoussé tout le
   portique pour les besoins d'un seul fichier.

⚠️ **À ne pas résoudre en allégeant les scénarios.** Un scénario de réplication qui ne fait plus
converger assez de pas ne prouve plus rien ; le coût est la contrepartie de la preuve. Si ce fichier
devient trop lourd pour le portique, la sortie est de le **sortir** du portique, pas de l'affaiblir.

## 11. Écarts assumés et dette nommée

- **`appliquerDegats` n'est pas borné.** Son coût suit les touches qui atterrissent. Un index spatial
  pour les zones est la sortie ; il n'est pas de cette étape.
- **Le pas déborde à 64 exemplaires par joueur.** Aucun chemin de jeu n'y mène ; le plafond réel est
  8. À rouvrir si un palier futur lève ce plafond.
- **`linkedNeighbours` n'est joué de bout en bout nulle part.** Le décor du livrable ne laisse qu'**une**
  entité vivante, donc le partage entre liés n'est jamais mesuré à quatre sockets. Le fichier prouve
  que Vaporisation, Paratonnerre et Amalgame se **déclenchent** et portent le bon nibble et la bonne
  liaison ; il ne prouve pas que la liaison **change un résultat**. Le second consommateur (le rayon
  élargi) est, lui, joué de bout en bout.
- **Le test de trafic mesure le coût par MESSAGE, pas les octets par TICK.** Le risque que la spec
  nomme elle-même au §8 B — quinze `kind` distincts → les zones fusionnent moins → **plus** de
  messages `ZONE` par tick — reste invisible à ce test. La saturation mesurée au banc (43 % de
  `ZONE_CAPACITY`) le rend peu probable, mais il n'est pas asséné.
- **Le recul de Mortier vif.** À la rupture du sceau, l'ennemi repart en arrière de 6,3 px mesurés :
  `#advanceByVelocity` module le pas, pas la vitesse retenue, donc `vx`/`vy` gardent la direction
  inversée pendant le gel et la relâchent à l'expiration. **Répliqué à 0,000 px** — artefact de jeu
  non tranché, pas une divergence. À arbitrer par l'auteur.
- **Une réaction de Poix amplifie ses propres dégâts ×1,5**, parce que `postZone` pose la zone avant
  le balayage de dégâts. Le §10 de la spec craignait exactement ça. Non corrigé : c'est un réglage de
  jeu, pas un invariant.
- **Le repli `zoneVifArgent` sur l'élément est inatteignable en production** — `postZone` est le seul
  créateur de zones et la seule paire sans ligne est Braise+Givre. Son docbloc le dit ; les tests
  l'utilisent comme raccourci. Code vivant uniquement pour les tests.
- **`npm run bench` mesure l'ancien jeu** (`kills`/`slots`/`zones` aveugles) et `bench:elements` est
  hors de l'agrégat.
- **L'atlas de monstres dérivé n'est pas sur MinIO** : la production perdrait toute la horde.
- **`main` est à 45+ commits derrière.**
- **Les classes (§15.1) ne sont toujours pas tranchées.**

## 12. Vérification manuelle

⚠️ **Section ouverte — attend la run de l'auteur.**

Ce qu'il faut regarder en priorité, parce que les tests ne peuvent pas en juger :

1. **Le recul de Mortier vif** (§11) : 6,3 px en arrière à la rupture du sceau. Artefact à garder ou
   à corriger ?
2. **La lisibilité des quinze réactions à l'écran.** Six éléments et quinze effets sur un même
   ennemi : est-ce qu'on lit encore ce qui se passe ?
3. **L'auto-amplification de la Poix** (×1,5 sur ses propres dégâts) : réglage voulu ou accident ?
4. **La fuite de la Chaux et de l'Aveuglement** : un ennemi qui fuit est-il frustrant ou intéressant ?

## 13. Questions laissées ouvertes

- **Le plafond d'exemplaires par arme n'est pas une règle de jeu écrite.** Le banc mesure jusqu'à 64
  « sans plafond de jeu », et le débordement n'apparaît que là. Si un palier futur permet d'empiler
  au-delà de 8, le §8 se rouvre.
- **Faut-il sortir `horde.replication.test.ts` du portique de commit ?** Il coûte 495 à 721 s à lui
  seul selon l'état de la machine, soit l'essentiel du portique. Trois relèvements de délai en quatre
  étapes suggèrent que la réponse viendra, mais ce n'est pas une décision à prendre au milieu d'une
  étape d'éléments.
- **Deux playtests sont dus** : les documents de résultats de 5b et de 6a ont chacun une section
  ouverte.
