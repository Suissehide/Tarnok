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
| Solo, échecs au niveau 2 | 19/40 | légitimement inchangé (piétaille légère, armure 0) |

⚠️ **Le chiffre à 64× n'a pas de décimale fiable.** Observé de **60,4 % à 85,4 %** sur sept
exécutions, à chaud comme à froid — le relevé froid (77,3 %) est **plus haut** que le relevé sous
charge (66,3 %), donc la variance est intrinsèque et non un artefact d'exécution concurrente. Le
verdict ne bascule à aucune exécution. **Et l'empilement n'a aucun plafond de jeu** :
`Loadout.addWeapon` ne borne que le nombre de **types** distincts.

⚠️ **L'occupation réelle de la réserve de zones est de 25 %, pas de 13 à 19 %** comme mon plan le
portait depuis l'extrapolation synthétique de la tâche 6. Le verdict ne change pas — 75 % de marge —
mais l'estimation était trop optimiste, et la marge est **observée**, pas garantie par une borne du
code.

## 8. `kills.bench` ne mesure rien de cette étape

Le rapport morts/apparitions est **exactement** celui d'avant l'étape : 0,47. Ce n'est pas la preuve
que le contenu neuf ne change rien — c'est la preuve que **le banc ne le touche pas**.

`kills.bench` équipe ses joueurs par `WEAPONS.filter(...).slice(0, armes)` : les **cinq premières**
armes du catalogue. Les quatre nouvelles ont été **ajoutées à la fin**. Aucune Foudre, aucune Poix,
aucune des cinq réactions nouvelles n'entre dans cette mesure.

⚠️ **C'est « le banc qui renvoie zéro » sous une forme neuve** — cinquième occurrence du motif dans
ce projet, et la plus retorse : le banc ne renvoie pas zéro, il renvoie **le chiffre de l'ancien
jeu**, qui ressemble à un résultat. J'ai failli l'écrire ici comme une mesure de l'étape.

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
| `kills.bench` est aveugle au contenu neuf (§8) | son `.slice(0, 5)` est à revoir, ou la mesure à refaire autrement |
| Le coût à fort empilement n'a pas de décimale fiable (§7) | et l'empilement n'a aucun plafond de jeu |
| Pas de test d'intégration `room.test.ts` pour `resolveVerglasCollisions` | trou **pré-existant**, partagé par `resolveBurn` et la Supraconduction |
| Une entité qui dérape saute son calcul de répulsion | donc perd sa correction anti-agglomération pendant qu'elle glisse. Mesuré sans conséquence (`k` ≤ 33), non borné par construction |
| **L'atlas dérivé n'est toujours pas sur MinIO** | en production **toute la horde disparaîtrait** |
| `main` est à 45+ commits derrière, et `origin/main` n'a rien reçu | |
