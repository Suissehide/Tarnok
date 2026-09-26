# Étape 5b — Foudre, Poix, l'armure : résultats

28 commits, 1 351 tests (879 back, 472 front). Deux éléments, une statistique, cinq réactions,
quatre armes — **et zéro octet de plus sur le fil**, mesuré octet par octet sur quatre sockets
réelles.

**Spec :** [`../specs/2026-09-25-etape-5b-foudre-poix.md`](../specs/2026-09-25-etape-5b-foudre-poix.md)
**Plan :** [`2026-09-25-etape-5b-foudre-poix.md`](2026-09-25-etape-5b-foudre-poix.md)

Le plan comptait douze tâches. Il en a livré **onze**, sans en ajouter aucune — première étape du
projet où le plan tient sans être élargi en cours de route. Mais **dix-sept décisions** ont dû être
prises à l'exécution, dont **sept corrigent mes propres documents**.

⚠️ **Ce document est ouvert.** Le §4 attend la run de l'auteur.

## 1. Le critère de l'étape, tenu et mesuré

**« Zéro octet de plus sur le fil »** n'était pas un espoir mais un critère, donc quelque chose qui
pouvait échouer. `back/src/elements-5b.integration.test.ts` le mesure à quatre sockets réelles,
**dans les deux sens** — un salon où la Foudre et la Poix ne tirent jamais, un salon où elles
tirent :

| Message | Octets | Identique entre les deux salons |
| --- | --- | --- |
| `ZONE` | **11** | oui, octet par octet |
| `REACTION` | **11** | oui |
| `SNAPSHOT`, 4 joueurs | **58** (= 22 + 4 × 9) | oui |

⚠️ **Et le salon neuf produit des paires nouvelles** — Supraconduction, une zone de Foudre jamais
vue côté ancien. Sans ça, l'égalité aurait comparé deux ensembles vides : verte et creuse.

**Comment c'est possible.** Trois mécanismes, aucun message ajouté :

- **La chaîne de la Foudre ne voyage pas** : elle se **recalcule** des deux côtés. Les positions sont
  bit-identiques, donc la même entrée rend la même sortie. Il n'y a même rien à annoncer — le point
  d'impact est déjà connu partout.
- **L'octet de `ZONE` porte deux informations** au lieu d'une : 3 bits d'élément, 4 bits de type de
  réaction. Six éléments et quinze réactions tiennent sur 7 bits des 8 disponibles.
- **Tout effet nouveau est DÉRIVÉ**, jamais écrit : l'armure réduite, l'amplification, le gel, le
  dérapage. Un état écrit devrait voyager ; une dérivation ne le doit pas.

## 2. Le contrat de réplication tient, y compris quand l'intégrateur de déplacement change

| Scénario | Dérive |
| --- | --- |
| **Supraconduction** en jeu, avec rejeu (ZF2) | **0,000 px** |
| Supraconduction, le gel mord (ZF0) | 649,886 px |
| Supraconduction, **sans** rejeu (ZF1) | 696,921 px |
| **Verglas** en jeu, avec rejeu (VF2) | **0,000 px** |
| Verglas, le dérapage mord (VF0) | 588,963 px |
| Verglas, **sans** rejeu (VF1) | 521,515 px |

**Les chiffres non nuls comptent autant que les zéros** : une mesure qui ne sait produire que
0,000 px ne mesure pas.

⚠️ **Verglas était le seul trou déclaré du plan**, et il le disait de lui-même : *« "déraper" touche
l'intégrateur de déplacement, et c'est le seul endroit de cette étape où le contrat de réplication
est réellement en jeu. »* Un chemin de repli était écrit d'avance — un simple facteur de vitesse,
sans inertie. **Il n'a pas servi**, comme celui du Givre à l'étape 5a.

**Ce qui l'a sauvé n'est pas un correctif mais une propriété** : l'inertie n'a demandé **aucun
quinzième tableau** à `Horde`. Elle réutilise `vx`/`vy`, que `saveState` et `restoreState` copient
déjà depuis l'étape 6a. Et `#inertiaDampingAt` est purement dérivé — zones, position, tick — donc
rejouable à l'identique. La revue a vérifié que le zéro ne tient pas par chance.

## 3. Le motif de l'étape : la propriété vraie, protégée par une raison fausse

**Quatre fois, une propriété tenait — et ce qui la tenait n'était pas ce qui était écrit.**

**A. La fusion des zones perdait ou inventait le type de réaction, selon l'ordre de pose.** Le
prédicat comparait l'élément et ne réécrivait jamais l'octet. Correct tant que le nibble valait
zéro ; faux dès que `postZone` a empaqueté. Mesuré :

```
generique BRAISE posee, puis Surchauffe a 10 px  -> kind=1 burn=0   life=90
Surchauffe posee, puis generique BRAISE a 10 px  -> kind=9 burn=0,3 life=135
```

Deux mêmes objets, deux ordres, deux résultats **opposés** : soit Surchauffe ne fait rien, soit un
champ générique brûle 4,5 s pour des joueurs qui n'ont jamais fait Braise + Foudre. **Bug de
production**, atteignable, trouvé par la mesure.

⚠️ **Et le rapport de la tâche décrivait cette règle comme une « découverte structurelle » — puis
s'en servait pour CHOISIR un décor de test qui la contournait.** Le test disait en toutes lettres
« deux zones distinctes, éléments différents, la fusion ne les fond pas ». Éviter le cas au lieu de
se demander ce qu'il signifie : c'est le décor qui masque, transposé du test vers le code.

**B. Le facteur de ralentissement d'une zone de réaction dépendait de l'ordre d'arrivée.** Une zone
de réaction porte, dans ses bits d'élément, celui du **déclencheur** — donc du projectile arrivé
second. Le Givre ralentit, la Foudre non : la même Supraconduction aurait gelé ou pas selon l'ordre.
Trouvé par l'implémenteur lui-même, d'où `zoneSlowFactor`.

**C. L'indépendance d'ordre de Verglas tenait par une inégalité que rien n'affirmait.** Verglas
épingle son facteur à celui du Givre ; le minimum n'est insensible au déclencheur **que parce que**
0,6 ≤ 1 (la Poix est neutre). Un rééquilibrage aurait fait réapparaître le bug sans qu'aucun test ne
le voie. Le test qui l'assène désormais dérive les deux éléments de **la paire de la réaction
elle-même** — il suivra si un troisième élément devient déclencheur.

**D. La borne de `k` dans les collisions de Verglas n'est pas celle que le docbloc annonçait.** Il
disait *« la géométrie borne naturellement k »*. La mesure dit : au réglage actuel, c'est **la mort
par collision** qui vide la zone. En divisant le dégât par vingt, `k` monte de 33 à 58 — et s'y
arrête, parce qu'**il existe bien un second plafond géométrique**, le tassement à
`SEPARATION_RADIUS`. Le docbloc était donc **incomplet dans les deux sens**, ce qui est pire qu'une
erreur franche : il énonçait à moitié une vérité.

## 4. Ce que la vérification manuelle a trouvé

**En attente de la run de l'auteur.** Ce que rien n'automatise :

- la **chaîne** de Foudre se voit-elle, ou disparaît-elle dans la horde ?
- l'**armure** se sent-elle, ou se lit-elle comme des armes qui ont faibli ?
- une **Poix sans ralentissement** se distingue-t-elle du Givre en jeu ?
- une zone de **Supraconduction** annule-t-elle la pression du bullet heaven ?
- **six réactions**, est-ce assez pour que le draft ait un sens ?

## 5. Sept erreurs de mes documents, rattrapées à l'exécution

| Ce que j'avais écrit | Ce qui était vrai |
| --- | --- |
| « les N plus proches dans un rayon R » | le plan décrivait une **étoile** et parlait de **polyligne**, donnait un paramètre `exclude` qui n'a de sens qu'entre sauts, et la tâche 6 exigeait « sans limite de **sauts** ». C'est une **chaîne** |
| un test « la chaîne n'ajoute aucun octet » à la tâche 3 | **inexécutable** à ce niveau : pas de harnais pour compter les octets par tick. Parti en tâche 11 |
| un test pour « deux flaques ne cumulent pas » | il en fallait **trois** — min, somme et produit sont trois erreurs distinctes |
| `appliquerDegats(horde, slot, brut, amp, dead)` | la tâche 7 avait besoin des zones et du tick ; passer des facteurs calculés aurait fait **trois lieux de dérivation** |
| « les deux tests à deux zones posent la plus forte en second » | **un seul** des trois a des valeurs distinctes ; les autres sont indistinguables |
| la ligne `gel : pendant=0,000 px` comme preuve de la tâche 7 | c'était le gel du **vote d'extraction de l'étape 6a**, sans rapport |
| « les fichiers d'intégration tournent en 1 à 6 s » | **11,4 s et 21,7 s** mesurés |

Et une erreur de **méthode** dans mes briefs : ils plaçaient le commit **après** la campagne de
mutations, or la campagne restaure par `git checkout`, qui efface le travail non commité. Ça a coûté
une réécriture de `combat.ts` à la tâche 1 ; les dix briefs suivants committent d'abord.

## 6. Les trous nommés se referment, parce qu'ils sont écrits

**Le motif le plus utile de l'étape n'est pas un correctif, c'est une chaîne de causalité.**

| Trou nommé | Où il s'est refermé |
| --- | --- |
| Deux mutations d'`ampAt` indistinguables tant que tous les `damageAmp` valent 1 (T1) | **T4**, par la ligne Poix |
| Une 4e variante d'`ampAt` vivante — la zone forte toujours posée en second (T4) | **T7**, en inversant l'ordre de pose |
| `Room#announceZones` et `Session#broadcast` décodant l'octet avant l'envoi (T5) | **T6**, dès qu'une réaction non nulle a été empaquetée — dont une tuée **de bout en bout sur quatre sockets** |
| La réserve de zones mesurable seulement en synthétique (T6) | **T10**, au vrai banc |
| « Zéro octet » tenable seulement au niveau `combat.ts` (T3) | **T11**, au niveau socket |

Aucun de ces trous n'aurait survécu s'il avait été arrondi dans un rapport. Ils se sont refermés
parce qu'ils étaient **au registre, avec leur porteur**.

## 7. Bancs, mesurés à froid

| Mesure | Valeur | Verdict |
| --- | --- | --- |
| Chaîne, 4 000 entités, 8 exemplaires/joueur | **4,94 ms** p95 (44,5 %) | OK |
| Chaîne, empilement poussé à **64×** | **8,59 ms** p95 (**77,3 %**) | OK — voir l'avertissement |
| `truncatedZones`, rafale 20 s | **0**, occupation max 21,1 % | ON GARDE |
| `truncatedZones`, **régime soutenu 60 s** | **0**, occupation max **25,0 %** | ON GARDE |
| Verglas, `k` max de 200 à 3 500 lourds | **33**, coût 0,043 ms (0,38 %) | le coût tient |
| Rapport morts / apparitions | 0,47 | **ne mesure pas cette étape** — voir §8 |
| Solo, échecs au niveau 2 | 19/40 | légitimement inchangé — mais pour une raison plus large que celle écrite d'abord, voir plus bas |

⚠️ **Corrigé à la revue finale de l'étape 5b : mon avertissement sur la variance était trop
pessimiste, et son explication était fausse.** J'avais écrit *« la variance est intrinsèque et non un
artefact d'exécution concurrente »*, déduit d'**un** relevé froid (77,3 %) plus haut qu'**un** relevé
sous charge (66,3 %) — un seul point de chaque côté ne permettait aucune conclusion sur la cause. La
revue a relancé **six fois à froid, rien d'autre sur la machine** :

| Empilement | Six relevés (% du budget) |
| --- | --- |
| 16× | 49,1 / 48,1 / 48,3 / 48,9 / 46,1 / 50,8 |
| 32× | 55,6 / 56,1 / 56,4 / 59,3 / 51,7 / 58,3 |
| **64×** | **74,9 / 75,5 / 75,6 / 76,7 / 66,8 / 77,9** — p95 de 7,425 à 8,652 ms |

L'étendue passe de **25 points** (les sept exécutions mêlant charge et calme) à **11**, et **5
relevés sur 6 tiennent dans 3 points**. **C'était bien un artefact de mes propres agents
concurrents** : 66,8 % se révèle être le point **bas** du bruit une fois la machine calme, pas une
référence distincte à opposer au relevé chaud. Le chiffre se lit à l'unité : **~75-78 % à 64×**, pire
cas 8,652 ms contre 11,111, **22 % de marge**, verdict jamais basculé sur **douze** exécutions (les
sept d'origine plus ces six). **Et l'empilement n'a aucun plafond de jeu** : `Loadout.addWeapon` ne
borne que le nombre de **types** distincts.

⚠️ **L'occupation réelle de la réserve de zones est de 25 %, pas de 13 à 19 %** comme mon plan le
portait depuis l'extrapolation synthétique de la tâche 6. Le verdict ne change pas — 75 % de marge —
mais l'estimation était trop optimiste, et la marge est **observée**, pas garantie par une borne du
code.

⚠️ **Corrigé à la revue finale de l'étape 5b : ma justification du 19/40 était fausse en raison, la
conclusion reste juste.** J'avais écrit « légitimement inchangé (piétaille légère, armure 0) ». La
vraie raison est plus large : **`niveau2.bench` n'équipe aucune arme** — son décor fait `room.join(1)`
et zéro `grantCard`. Il ne peut voir ni élément, ni zone, ni réaction, ni ceux de l'étape 5b ni ceux
de l'étape 5a — l'armure à 0 et la piétaille légère n'y sont pour rien, le joueur simulé n'a tout
simplement **aucune arme en main**.

## 8. `kills.bench` ne mesure rien de cette étape

Le rapport morts/apparitions est **exactement** celui d'avant l'étape : 0,47. Ce n'est pas la preuve
que le contenu neuf ne change rien — c'est la preuve que **le banc ne le touche pas**.

`kills.bench` équipe ses joueurs par `WEAPONS.filter(...).slice(0, armes)` : les **cinq premières**
armes du catalogue. Les quatre nouvelles ont été **ajoutées à la fin**. Aucune Foudre, aucune Poix,
aucune des cinq réactions nouvelles n'entre dans cette mesure.

⚠️ **C'est « le banc qui renvoie zéro » sous une forme neuve** — cinquième occurrence du motif dans
ce projet, et la plus retorse : le banc ne renvoie pas zéro, il renvoie **le chiffre de l'ancien
jeu**, qui ressemble à un résultat. J'ai failli l'écrire ici comme une mesure de l'étape.

⚠️ **Corrigé à la revue finale de l'étape 5b : `kills.bench` est pire que je ne l'écrivais ci-dessus,
et il n'est pas seul.** `armes = WEAPON_SLOTS = 4` donne exactement `dague, éventail (Braise),
arc-lourd, lance-flammes, grenade (Braise)` — **aucun Givre, aucune Foudre, aucune Poix**. Ce banc ne
mesure donc pas seulement « le jeu sans les quatre armes de cette étape » : il mesure **le jeu
d'avant l'étape 5a**.

Et deux AUTRES bancs sont aveugles de la même façon, tous deux dans l'agrégat par défaut :

- **`slots.bench.ts:64`** — même idiome : `WEAPONS.filter((w) => w.id !== BASE_WEAPON_ID).slice(0,
  slots)` prend les armes **dans l'ordre du catalogue**, où Foudre et Poix arrivent en dernier.
- **`zones.bench.ts:68-69`** — l'arme est choisie par `WEAPONS.find((w) => w.element ===
  ELEMENT.BRAISE)` / `ELEMENT.GIVRE` : seul le Choc thermique (générique, étape 5a) peut s'y
  déclencher, jamais une des cinq réactions de cette étape.

**Les deux sont DANS l'agrégat `npm run bench`** (`sim`, `net`, `sep`, `slots`, `zones`) — dont
`bench:elements` (le seul à réellement couvrir Foudre, Poix et les cinq réactions) est **exclu**, au
même titre que `kills` et `niveau2`. Autrement dit : **`npm run bench` est devenu le banc de l'ancien
jeu.** Voir §10.

## 8 bis. Ce que onze revues de tâche n'ont pas pu voir

**La revue finale de branche a trouvé quatre choses bloquantes, et aucune n'était visible depuis le
périmètre d'une tâche.** Trois sont la même erreur sous trois formes : une convention posée tôt,
contredite tard, et un texte resté en place.

**A. La brûlure de zone était la seule grandeur de zone qui se CUMULAIT.** La boucle appelait
`appliquerDegats` une fois par zone :

| Décor | Perte / tick |
| --- | --- |
| 1 Surchauffe | 0,300 |
| 2 Surchauffe, même point, **déclencheurs opposés** | 0,600 |
| 4 superposées | **1,200** — soit 72 PV/s : `HEAVY_HP` tombe en **0,28 s** |

Atteignable dès **deux joueurs**. Or la tâche 8 avait écrit **en gras** la règle inverse : *« une
seule liste pour toutes les zones qui se recouvrent, jamais une passe par zone… le MAXIMUM, comme
`ampAt` / `armorReductionAt` »*. Trois grandeurs voisines prennent le maximum et ont chacune leur
test « ne cumulent pas » — **la seule sans ce test était la seule qui sommait.** `burnAt` est
désormais la quatrième de la famille.

⚠️ **Chaque revue de tâche avait raison dans son périmètre.** La tâche 6 a écrit un cumul, la
tâche 8 a écrit l'interdiction ; ni l'une ni l'autre ne voyait le diff de sa voisine.

**B. Le test qui nommait A affirmait une propriété fausse.** Intitulé *« deux zones de Surchauffe
qui se recouvrent ne brûlent pas deux fois »*, son décor posait la cible à **0,05 PV** : elle
mourait à la première application, la garde `hp <= 0` sautait la seconde, et les assertions ne
portaient que sur la déduplication des morts. **C'est pire qu'un test creux — c'est un test qui
enseigne l'inverse.**

**C. Un docbloc interdisait en gras ce que le fichier faisait dix lignes plus bas.**
`damageInRadius` déclarait qu'*« un second balayage divergerait à la première retouche »* ; la
tâche 6 avait écrit ce second balayage, même signature à huit paramètres, même corps, une ligne de
filtre en plus. Les deux sont fondus, filtre optionnel — et le docbloc **raconte** désormais la
duplication au lieu de l'interdire. Une interdiction se contourne sans qu'on s'en aperçoive ; un
récit se lit.

**D. Une assertion instable, introduite par le dernier commit, et c'est une décision de
coordination qui l'a laissée passer.** L'assertion de Synergie du livrable échouait **2 fois sur 13**
exécutions de la suite complète — jamais quand le fichier tournait seul. Un joueur portait les deux
éléments et tirait seul sur la cible : quand ses deux projectiles atterrissaient dans le même pas
serveur, la réaction cessait d'être inter-joueurs.

⚠️ **J'avais refusé la re-revue de ce correctif en écrivant « surface de régression de production
nulle ».** C'était vrai de la production et faux de la **suite** — et « 885 tests verts » n'était
alors vrai que sur une exécution qui gagne la course. Corrigé en faisant viser la cible par un
**troisième client**, de sorte que le porteur des deux éléments ne puisse plus y atteindre
géométriquement : le décor ne rend plus la propriété probable, il la rend nécessaire.

**La leçon de méthode :** une revue par tâche ne peut pas voir une convention contredite d'une tâche
à l'autre, et un contrôleur ne peut pas juger « surface de régression nulle » sur une base de tests
concurrente. Les deux défauts sont structurels, pas des inattentions.

## 9. Écarts assumés

**§6.3 — la Poix ne ralentit pas.** Le Givre garde le contrôle, la Poix est le multiplicateur. Deux
ralentissements auraient fait du contenu mort : personne ne drafte l'un pour ce que l'autre fait
déjà. La raison est écrite **dans la table**, pas seulement ici.

**§6.4 — Supraconduction gèle tant qu'on piétine**, pas définitivement. L'effet vit sur la zone, ce
qui tient le contrat de réplication par construction.

**§6.4 — Embrasement est un rayon**, pas une propagation de proche en proche : un parcours de graphe
dépend de son ordre de visite.

**§6.2 — le pool reste à 13 armes** sur les 40 visés.

**Une garde a changé de nature plutôt que d'être vidée.** `ELEMENTS_SANS_EFFET_DE_MARQUE` exigeait
que tout élément brûle ou ralentisse — vrai avec deux éléments, faux dès que la Poix amplifie. Le
prédicat a été **élargi** à l'amplification, ce qui en sort la Poix ; la Foudre y reste seule, pour
une raison **structurelle** et non une dette de tâche : sa chaîne se déclenche sur un **identifiant**
(`back/src/combat.ts`), jamais par la lecture d'un champ d'`Element`.

## 10. Questions laissées ouvertes

| Question | État |
| --- | --- |
| **Une réaction impliquant la Poix amplifie ses PROPRES dégâts** (×1,5) — `postZone` pose la zone avant le balayage | **Mesuré**, pas supposé. Le §10 de la spec redoutait exactement ça : *« Poix + n'importe quoi devient le meilleur couple du jeu par construction »*. **Arbitrage de jeu, pas un bug** |
| Le pitch du README reste faux | avec 4 éléments et 4 slots, un joueur seul les couvre **tous**. *« Un joueur seul ne peut pas couvrir assez d'éléments »* ne devient vrai qu'au **cinquième** — donc en 5c |
| `kills.bench`, `slots.bench` et `zones.bench` sont aveugles au contenu neuf — `npm run bench` mesure l'ancien jeu (§8) | à revoir (catalogue interrogé par élément/position plutôt que par nom, ou décor dédié) — **pas cette vague** : c'est une étape de contenu à part entière, pas une correction |
| Le coût à fort empilement n'a pas de décimale fiable (§7) | et l'empilement n'a aucun plafond de jeu |
| Pas de test d'intégration `room.test.ts` pour `resolveVerglasCollisions` | trou **pré-existant**, partagé par `resolveBurn` et la Supraconduction |
| Une entité qui dérape saute son calcul de répulsion | donc perd sa correction anti-agglomération pendant qu'elle glisse. Mesuré sans conséquence (`k` ≤ 33), non borné par construction |
| **L'atlas dérivé n'est toujours pas sur MinIO** | en production **toute la horde disparaîtrait** |
| `main` est à 45+ commits derrière, et `origin/main` n'a rien reçu | |
