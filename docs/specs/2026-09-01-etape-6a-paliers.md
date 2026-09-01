# Étape 6a — la run a une fin : paliers, boss, or non sécurisé, vote

> **Découpage assumé.** Le §13 de l'orientation décrit une étape 6 unique : boss, paliers,
> difficulté non bornée, vote d'extraction, or. Cinq sous-systèmes.
>
> Cette spec couvre **6a : le mécanisme**. Paliers, **un** boss sans affixe, la formule de
> difficulté, l'or non sécurisé et le vote. Le livrable du §13 est atteint en entier. **6b** livrera
> le pool tournant de boss et les affixes — du contenu piloté par la donnée, comme la 5b.
>
> C'est le découpage qui a marché à l'étape 5 : le mécanisme d'abord, le contenu ensuite.

**Orientation :** [`2026-08-19-coop-survivors-orientation.md`](2026-08-19-coop-survivors-orientation.md) — §9 en entier
**Étape précédente :** [`2026-08-27-etape-5a-elements.md`](2026-08-27-etape-5a-elements.md)

## 1. Ce que l'étape change au jeu

**Aujourd'hui une run n'a pas de fin, seulement une mort.** Les vagues tombent toutes les six
secondes jusqu'à ce que l'équipe soit effacée, et `RUN_OVER` annonce un temps de survie. Rien ne
structure, rien ne récompense, rien ne se décide.

Après cette étape : **4 vagues, un boss, un portail de 20 s, et un choix qui coûte.**

**Dans l'étape :**
- la structure en **paliers** — 4 vagues + 1 boss ≈ 5 min (§9.1) ;
- **un** boss, sans affixe, avec une **barre de vie visible** — la seule du jeu ;
- la **difficulté comme formule**, pas comme table (§9.2) ;
- l'**or non sécurisé**, son multiplicateur, et sa perte à l'effacement ;
- le **vote d'extraction** : 20 s, majorité, égalité = on continue (§9.3).

**Hors de l'étape :**
- le pool tournant de boss et les **affixes** (§9.2) — contenu, étape 6b ;
- la **persistance** de l'or entre les runs — c'est l'étape 7, et le §1.3 ci-dessous en tire une
  conséquence qu'il faut regarder en face ;
- les événements bonus (§10).

## 1.1 Ce que cette étape ne met pas en danger

**Le contrat de réplication tient depuis l'étape 2 et ne doit rien coûter de plus par entité.**

Cette étape introduit **un boss**, et un boss a une barre de vie **visible** — donc une donnée par
entité sur le fil, ce que tout le projet refuse depuis quatre étapes.

**La réponse est le nombre.** Un boss par palier, jamais plus d'un vivant. Annoncer ses points de
vie coûte quelques octets par snapshot, comme les joueurs — et c'est précisément parce qu'ils sont
**peu** que les joueurs sont répliqués et que la horde ne l'est pas. **Le boss est du côté des
joueurs, pas du côté de la horde.**

⚠️ **La règle qui ne doit pas plier :** si un jour un palier fait apparaître dix boss, ce n'est plus
un boss, c'est de la piétaille d'élite — et sa vie redevient serveur seul.

## 1.2 Le boss vit DANS la horde, et sa vie voyage à côté

Il réutilise tout ce que quatre étapes ont construit : le champ de flux, la séparation, la
collision, les orbes, les marques élémentaires, le rejeu. Il est une vague de `count: 1`, avec son
identité arithmétique comme n'importe qui.

**Seuls deux choses le distinguent, et elles sont hors de la horde :**
- sa **vie annoncée**, dans le snapshot, une fois par tick ;
- son **archétype**, dont les points de vie et la taille sortent de la formule du §3.

## 1.3 Le vote engage un or qui ne survit pas encore à la session

**À dire en face plutôt que de le découvrir au playtest.** Le §13 fait de l'or persistant l'étape 7.
À l'étape 6a, l'or d'une run est **un score** : il se gagne, se multiplie, se perd — et disparaît
quand l'onglet se ferme.

**Le vote reste-t-il un vrai choix ?** Oui, et pour la raison qui compte : ce qui se décide en vingt
secondes, c'est *risquer ce qu'on a pour ce qu'on n'a pas*, et cette tension existe dès que le
nombre est affiché et qu'il peut tomber à zéro. La persistance change ce qu'on risque, pas le fait
de risquer.

Mais **le §13 le dit et cette spec le répète** : tant que l'étape 7 n'est pas là, le playtest juge
la tension d'une session, pas celle d'une progression.

## 2. Les paliers

| Unité | Durée cible | Ce qui la termine |
| --- | --- | --- |
| Vague | ~60 s | la suivante tombe |
| **Palier** | 4 vagues + 1 boss ≈ 5 min | **le boss meurt** |
| Run | 20-30 min | l'extraction, ou l'effacement |

⚠️ **Le palier se termine à la MORT DU BOSS, pas à un tick.** C'est ce qui rend le rythme
élastique : une équipe qui peine reste plus longtemps, une équipe qui domine avance. Un palier daté
par tick punirait la première et ennuierait la seconde.

⚠️ **Les vagues ne s'arrêtent pas pendant le boss.** Le §9.1 ne le dit pas, et l'intuition inverse
est tentante — « le boss, seul, en duel ». Elle est fausse pour ce genre : un bullet heaven où la
horde disparaît est un jeu qui s'arrête. Le boss arrive **dans** la mêlée.

## 3. La difficulté est une formule

Le §9.2 est catégorique : *« sans boss final, la difficulté doit être une formule, pas une table —
sinon le contenu s'épuise en trois soirées »*. Point de départ, pour un palier `k` (le premier vaut
`k = 0`) :

| Grandeur | Formule | À `k = 0` | À `k = 5` |
| --- | --- | --- | --- |
| Nombre d'ennemis par vague | `× (1 + 0,15 k)` | ×1 | ×1,75 |
| Points de vie | `× 1,12^k` | ×1 | ×1,76 |
| Or du palier | croissant avec `k` | — | — |

⚠️ **Ces trois lignes ne sont pas du réglage, elles sont la durée de vie du jeu.** Une table
s'épuise ; une formule ne s'épuise pas mais peut diverger. **Les deux sens comptent** : trop plate,
la run n'a pas de fin ; trop raide, le palier 8 est un mur.

⚠️ **La montée des PV multiplie ce que l'étape 5a vient de mesurer.** Le rythme de mise à mort de la
piétaille lourde est déjà à −12,8 % du rythme de l'étape 3. `×1,12^k` le divise encore, et le §7
en fait une porte.

## 4. Le boss

**Un seul modèle à cette étape, sans affixe** — le pool tournant est l'étape 6b.

| | |
| --- | --- |
| Points de vie | plusieurs centaines de fois ceux de la piétaille lourde, croissant en `1,12^k` **et avec le nombre de joueurs** — même forme que le seuil d'expérience. Mesuré : quatre joueurs le tuent en 87 s, **un joueur seul ne le tue jamais** |
| Taille | nettement plus grand que la piétaille — c'est ce qui le rend lisible dans la mêlée |
| Barre de vie | **visible, et c'est la seule du jeu** |
| Comportement | celui de la piétaille : il marche vers le joueur le plus proche |

⚠️ **Une première version de ce paragraphe disait que son comportement reste celui de la piétaille**
— *« un boss avec des phases, des attaques téléguidées et des patterns est un autre jeu »*. L'auteur
a tranché l'inverse, et le §8 de ce document posait déjà la question : *« un boss qui n'a que des
points de vie se sent-il comme un boss ? »*. **La réponse est non.**

**Il charge.** Un **long rectangle** légèrement rouge s'annonce devant lui, son opacité monte, puis
il **le traverse en tournant sur lui-même**. Une attaque avec un temps de chargement — très loin des
phases et des patterns que ce paragraphe refusait.

⚠️ **Ce n'est pas un télégraphe, c'est un déplacement.** La première formulation parlait d'une zone
qui se remplit sur place ; l'auteur a précisé, et ça change la nature de la chose : **la position du
boss est pilotée par l'attaque, pas par le champ de flux, pendant toute la charge**. C'est donc le
même risque que le ralentissement du Givre à l'étape 5a — un effet qui touche le déplacement touche
le contrat de réplication.

La parade est celle qui a déjà servi trois fois : le serveur annonce **une fois** — origine,
direction, longueur, ticks de départ et de fin — et **les deux côtés dérivent la position le long du
couloir**. Zéro octet après l'annonce, même position partout, par construction.

⚠️ **La direction est figée au chargement, elle ne suit pas.** C'est ce qui rend l'esquive possible :
un couloir qui suivrait sa cible serait une taxe, pas une attaque.

Le pack a déjà les trois temps — `Troll_Windup`, `Troll_Attack`, `Troll_Recovery`.

Ce qui la rend peu coûteuse : elle est déjà écrite quatre fois dans ce dépôt. Annoncée à la création
et dérivée ensuite comme une zone, **datée par tick** comme le gel de niveau, un cercle qui grossit
comme le vol d'une orbe, des dégâts arbitrés serveur comme le contact.

⚠️ **Le télégraphe est cosmétique jusqu'à l'impact, et c'est ce qui le rend sûr** — rien ne fait mal
avant le tick annoncé. Ce qui le rend intéressant, c'est que **le joueur peut sortir du cercle** :
le temps de chargement est la fenêtre de réaction.

⚠️ **Il porte des marques élémentaires comme tout le monde** (étape 5a), et c'est le premier ennemi
qui survivra assez longtemps pour qu'une réaction se voie sur lui.

## 5. L'or

**L'or ramassé pendant la run n'est pas acquis. Il est non sécurisé jusqu'à l'extraction.**

| Événement | Effet sur l'or non sécurisé |
| --- | --- |
| Boss vaincu | un **bonus de palier**, croissant avec `k` |
| **Rester** au vote | le **multiplicateur** augmente |
| **Partir** au vote | tout est acquis, majoré du multiplicateur. La run se termine |
| **Effacement de l'équipe** | **tout est perdu** |
| Mort d'un seul joueur | **rien** — le §9.3 est explicite |

⚠️ **La perte de 100 % est un PARAMÈTRE, pas une valeur en dur**, et le §9.3 appelle cette ligne
*« le principal risque de design de tout le document »*. Décision de l'auteur : **100 % perdu, et on
juge en jeu**. Le §9.3 nomme le risque assumé — *« perdre 25 minutes d'or sans rien est un motif
d'arrêt de jeu »* — et les deux alternatives qu'il faudra pouvoir essayer sans refonte : un plancher
de 10 à 20 %, ou le bonus de palier toujours payé.

**C'est pour ça que ce doit être un paramètre.** Une valeur en dur transformerait un réglage de
playtest en refonte.

## 6. Le vote d'extraction

Après chaque boss vaincu, un portail s'ouvre **20 secondes**.

| Question | Décision |
| --- | --- |
| Comment tranche-t-on ? | **majorité ; égalité = on continue** |
| Qui vote ? | tout joueur connecté, mort ou vif |
| Que voit-on ? | **les votes des autres, en continu** |
| Le monde s'arrête-t-il ? | **NON** |

⚠️ **Le monde ne s'arrête PAS, et c'est la différence structurante avec le draft.** Le §9.3 dit
*« pendant que la vague suivante approche »* : c'est la vague qui met la pression, et un gel la
supprimerait. Le draft gèle parce qu'un choix de carte n'a pas d'enjeu temporel ; le vote n'en gèle
pas parce que **le temps EST son enjeu**.

⚠️ **Les votes sont visibles, comme les jetons du draft.** Le §7.2 de l'étape 4 l'a établi pour les
cartes : *« sans cette visibilité, la mécanique n'existe pas »*. Ici c'est plus vrai encore — on ne
négocie pas un choix qu'on ne voit pas.

**La forme du protocole est celle du draft**, et elle a déjà servi : une ouverture datée, des
intentions rediffusées, une résolution annoncée. Ce qui change : deux choix au lieu de N cartes,
aucun gel, et une majorité au lieu d'un tirage.

## 7. La porte de performance

**Deux mesures engagées AVANT de les faire**, comme le §3.3 de l'étape 3 :

**A. Le boss se tue-t-il dans le temps d'un palier ?** Ses PV sortent d'une formule ; le rythme de
mise à mort a déjà baissé de 12,8 % à l'étape 5a et la formule `1,12^k` le divise encore.

| Issue | Ce qu'on fait |
| --- | --- |
| le boss meurt en 30 à 90 s au palier 0 | **on garde** |
| il meurt en moins de 15 s | **on monte ses PV**, pas la formule |
| il tient plus de 3 min | **on baisse ses PV**, et on rouvre `1,12^k` |

**B. La difficulté diverge-t-elle ?** Simuler dix paliers sans jouer, et regarder l'effectif et les
PV totaux. Si le palier 8 dépasse `MAX_ENTITIES`, ce n'est pas un réglage — c'est `waveCountBounds`
qui doit plafonner.

## 8. Vérification

**Le livrable du §13 :** *« Une run infinie avec un vote qui engage réellement l'or. »*

Un test d'intégration à quatre clients réels, comme ceux des étapes 4 et 5a : un palier se termine,
le portail s'ouvre, les votes se voient, la majorité tranche, et **l'or bouge dans les deux sens** —
acquis à l'extraction, perdu à l'effacement.

⚠️ **Les deux moitiés, toujours.** « L'or est acquis quand on part » se lit aussi bien avec un or
qui ne bouge jamais. Il faut **partir** et **être effacé**, dans le même test ou dans deux tests qui
partagent leur décor.

**Ce qui doit rester vrai :** les trois chiffres de réplication à 0,000 px, l'indépendance du trafic
au nombre d'entités, et le budget de pas p95 < 11,11 ms.

**Ce qui relève du jugement :**
- vingt secondes, est-ce assez pour décider à quatre ?
- la perte totale se **vit**-elle comme une tension ou comme une punition ? C'est la question que le
  §9.3 désigne comme la plus risquée du projet ;
- un boss qui n'a que des points de vie **se sent**-il comme un boss ?

## 9. Écarts assumés

**§9.2 — le pool de boss et les affixes sont reportés en 6b.** Cette étape livre un boss, pas un
bestiaire.

**§9.1 — les vagues ne s'arrêtent pas pendant le boss.** Le document ne le tranchait pas ; c'est
tranché ici, et dans le sens qui préserve le genre.

## 10. Questions laissées ouvertes

- **Que doit valoir une run solo ?** Ce document ne le dit nulle part, et la mesure de la tâche 3 bis
  en fait une question : un joueur seul perd **3 runs sur 40** au palier 0, et **les deux tiers du
  coût tiennent à la PRÉSENCE du boss**, pas à sa réserve — un corps de plus qui capte le tir
  automatique, et un palier qui n'avance que s'il tombe. Réduire ses PV n'y change rien : mesuré,
  3/40 à 6 000 PV comme à 1 500.
- **Un boss se tue-t-il par les armes ou par les réactions ?** Mesuré en passant à la tâche 4 : un
  joueur seul portant Braise **et** Givre fond 1 500 PV en **2,5 secondes** — 55 réactions à 25 points
  de dégâts. Une équipe qui tient deux éléments ne tue donc pas un boss avec ses armes, elle le tue
  avec le système élémentaire. **C'est peut-être le bon design ; ce n'est pas une décision qui a été
  prise.**
- **Que devient un joueur mort au moment du vote ?** Il vote — le §9.3 dit que la mort d'un seul ne
  coûte rien, donc elle ne doit pas non plus coûter la voix.
- **Le multiplicateur croît-il linéairement ou plus vite ?** Trop plat, rester ne se justifie pas ;
  trop raide, partir tôt devient absurde. Réglage de playtest.
- **Que se passe-t-il si tout le monde se déconnecte pendant le vote ?** Le §4.4 de l'étape 4 a déjà
  répondu pour le draft — l'absence ne bloque jamais — et la même règle vaut ici : à l'échéance, on
  continue.
