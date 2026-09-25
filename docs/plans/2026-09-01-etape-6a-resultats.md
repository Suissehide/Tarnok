# Étape 6a — les paliers, le boss, l'or : résultats

35 commits, 1 172 tests (718 back, 454 front). La run a une fin qu'on choisit : quatre vagues, un
boss, un portail qui s'ouvre vingt secondes — et une cagnotte qui n'est acquise qu'en partant.

**Spec :** [`../specs/2026-09-01-etape-6a-paliers.md`](../specs/2026-09-01-etape-6a-paliers.md)
**Plan :** [`2026-09-01-etape-6a-paliers.md`](2026-09-01-etape-6a-paliers.md)

Le plan comptait douze tâches. Il en compte **dix-neuf**. Les sept ajoutées viennent toutes de
l'auteur en train de jouer. **C'est le quatrième cycle consécutif où le jeu corrige le
raisonnement** — après les quinze tâches de l'étape 3, la révision du modèle de cartes de l'étape 4
et les dix de l'étape 5a. Le motif n'est plus une observation, c'est une propriété du projet.

⚠️ **Ce document est ouvert.** Le §3 attend la run de l'auteur.

## 1. Le livrable du §13, en entier

> *Une run infinie avec un vote qui engage réellement l'or.*

`back/src/portal.integration.test.ts` — quatre sockets réelles, deux tests, 5,9 s. Un palier se
termine, le portail s'ouvre sur les quatre sockets, les silences et les voix se voient, la majorité
tranche, **l'égalité continue**, et l'or bouge **dans les deux sens** : 212 → 265 en partant au
multiplicateur 1,25, 100 → 0 à l'effacement.

⚠️ **La moitié négative porte le sens, encore.** « L'or est acquis quand on part » se lit aussi
bien avec un or qui ne bouge jamais ; il a fallu **partir** *et* **être effacé**, dans deux tests
qui partagent leur décor. C'était déjà la leçon de la Synergie à l'étape 5a.

Deux précautions valent d'être nommées, parce qu'elles sont l'inverse exact des défauts du dépôt :

- **Le 2-2 ne peut pas être « deux voix et deux absences ».** L'absence ne compte pas — le résultat
  serait le même pour une autre raison. C'est `effectTick < deadlineTick` qui le prouve : le
  portail ne ferme avant l'échéance que si **personne** ne se tait.
- **L'or majoré ne peut pas être « recopié ».** Au premier portail le multiplicateur vaut 1, et
  `×1` est indistinguable d'une affectation. Le test ne mesure qu'au **second**, à 1,25.

## 2. Le contrat de réplication, et une limite du test d'intégration

| Scénario | Dérive |
| --- | --- |
| Morts + séparation, **avec** rejeu | **0,000 px** |
| Apparition tardive, **avec** rattrapage | **0,000 px** |
| Tick serveur recalé en continu | **0,000 px** |
| Charge du boss dans l'anneau de rejeu | **0,000 px** |
| Apparition tardive, **sans** rattrapage | 430,569 px |
| Tick local jamais recalé | 544,360 px |

Les deux dernières lignes sont là pour une raison : **sans elles, les zéros ne prouveraient rien.**
Une mesure qui ne sait produire que 0,000 px ne mesure pas.

⚠️ **Le plan demandait au test d'intégration de porter ces chiffres. Il ne peut pas**, et c'est
l'exécutant qui l'a établi plutôt que de fabriquer une seconde mesure. Le décor balaie la horde par
`Horde.kill`, qui court-circuite délibérément le lot `DEATHS` : un client qui dériverait sa horde du
fil divergerait **par construction**, et le chiffre lu ne dirait rien du portail. Les trois chiffres
vivent dans `shared/horde.replication.test.ts`, en simulation pure — ni serveur, ni socket.

**Le vote était pourtant le bon endroit où s'inquiéter** : c'est la première mécanique du projet qui
laisse le monde tourner pendant qu'une fenêtre d'interface est ouverte.

## 3. Ce que la vérification manuelle a trouvé

**En attente de la run de l'auteur.** Les quatre questions que rien n'automatise :

- vingt secondes, est-ce assez pour décider à quatre ?
- la perte totale se **vit**-elle comme une tension ou comme une punition ? Le §9.3 en fait le
  risque de design le plus lourd de tout le document ;
- un boss qui n'a que des points de vie **se sent**-il comme un boss ?
- le palier 3 ou 4 est-il encore jouable, ou la formule a-t-elle divergé ?

Sept tâches sont déjà nées de l'œil pendant l'étape — les PV du boss suivant le nombre de joueurs,
la charge télégraphiée, l'expérience qui ne s'évapore plus, les armes à effet de zone, le passif de
régénération, l'encerclement, la cadence.

## 4. Le motif de l'étape : la mesure contre le diagnostic

**Trois fois, une mesure a démenti un raisonnement écrit — le mien.**

**A. Les pertes en solo ne viennent pas des PV du boss.** Le plan les attribuait aux « 6 000 PV que
le joueur ne percera pas ». Le correctif divise ces PV par quatre en solo, et le chiffre ne bouge
pas : 3/40 avant, 3/40 après, aux mêmes graines et à la seconde près. Trois décors de contrôle
tranchent : **aucun boss** donne 0/40, un boss à **100 PV** donne 2/40, un boss à **1 500 ou
6 000 PV** donne 3/40. Les deux tiers du coût tiennent à la **présence** du boss — un corps de plus
qui capte le tir automatique — pas à sa réserve.

**B. Le limiteur du rapport morts/apparitions est la VISÉE.** Trois leviers mesurés, trois
plateaux : l'effet de zone monte le rapport de 0,49 à 0,53 (plateau à 0,59 pour un rayon de
400 px) ; **baisser les vagues l'abaisse à 0,41** — pire ; et multiplier la cadence par huit ne
rend que +24 %. Aucun des trois ne touche la cause.

**C. La première marche de `hpScale` double la durabilité.** R9, l'arrondi, encore — mais dans
l'autre sens : à l'étape 4 il *avalait* l'empilement des passifs, ici il **amplifie** l'échelle de
palier. Mesuré par la tâche 2, non résolu par elle, inscrit en tête de la tâche 3.

## 5. Deux corrections de mes propres documents

**« Rester ouvre le palier suivant » est faux, et doit l'être.** `bossDefeated()` avance le palier
**à la mort du boss**, et ses vagues tombent pendant le vote. Si « rester » ouvrait le palier, le
monde serait *partiellement* gelé pendant la fenêtre — exactement ce que le §6 interdit. « Rester »
ne touche qu'au multiplicateur.

**La constante de perte ne couvre pas les deux alternatives que la spec lui prête.** Une
constante-fraction couvre un plancher de 10 à 20 % — une seule valeur à changer — mais **pas** « le
bonus de palier toujours payé », qui demande **deux bourses** : ce qu'on a ramassé et ce qu'on a
terminé. Aucune fraction ne les distingue. Ce que `WIPE_GOLD_KEPT` garantit vraiment, c'est que la
perte passe par **une seule ligne**, celle où cette seconde bourse viendrait se brancher.

⚠️ **Et tant qu'elle vaut 0, aucun test ne la distingue d'un zéro écrit en dur.** Une assertion
`toBe(Math.round(cagnotte * WIPE_GOLD_KEPT))` a été écrite puis **retirée** à la tâche 11 : les deux
côtés de la comparaison bougent ensemble, elle ne gardait rien. Ce qui garde réellement le
comportement, c'est `gold === 0`.

## 6. Une assertion creuse, attrapée par son propre auteur

À la tâche 10, la mutation « le serveur annonce toujours un multiplicateur de 1 » laissait
`server.test.ts` **entièrement vert**. Son décor n'atteignait que le **premier** portail, où le
multiplicateur vaut 1 de toute façon : l'assertion `expect(open.multiplier).toBe(1)` mettait en
scène la bonne intention et ratait la ligne qu'elle nommait.

C'est **le décor qui masque** et **l'assertion creuse** ensemble, sur leur forme la plus coûteuse :
une valeur de production réutilisée comme valeur de décor. Le même défaut que `GEL_TICKS = 60` à
l'étape 3, où 80 tests passaient sur une dérivation fausse. Soldé par un second test de socket qui
enchaîne deux paliers.

**Le fait notable n'est pas le défaut, c'est qu'il ait été trouvé par l'exécution d'une mutation et
non par une relecture.** Deux autres pièges ont été pris de la même façon pendant la tâche 11 : une
sonde d'attente **déjà vraie** au moment où elle est posée — le test qui renvoie zéro, à l'identique
de `kills.bench` — et un or comparé à un relevé antérieur, qu'une pièce ramassée entre-temps aurait
rendu intermittent.

## 7. Largeurs calculées, pas choisies

| Valeur | Largeur | Déborde à | Pourquoi pas plus étroit |
| --- | --- | --- | --- |
| PV du boss | `u32` | — | `u16` déborde au palier 22 |
| Or | `u32` | — | `u16` déborde au palier 22 majoré |
| Multiplicateur d'extraction | `u16`, en centièmes | palier 2 618 | `u8` déborderait au palier **7**, soit une demi-heure de jeu |

L'encodeur **borne** explicitement au lieu de laisser `setUint16` replier modulo 2¹⁶ : sans ça,
655,36 se relirait **0,00** — « partir ne rapporte rien » au moment exact où partir rapporte le
plus.

Le multiplicateur voyage en **valeur**, pas en nombre de paliers restés : un compteur obligerait les
deux côtés à refaire le même calcul à partir de `EXTRACT_MULTIPLIER_STEP`, donc à diverger le jour
où la pente cesse d'être linéaire — ce que le §10 de la spec laisse justement ouvert.

## 8. L'écran du vote n'est pas une modale, et c'est le §6

Le plan disait « `draft.ts` est le modèle ». Le suivre à la lettre donnait un voile plein écran qui
**cache la horde avançant pendant qu'on négocie** — c'est-à-dire exactement la pression que la
fenêtre existe pour produire, et que le plan cite lui-même deux fois. D'où un bandeau bas, les
`pointer-events` rendus aux seuls boutons.

Le test qui garde cette différence est **différentiel** : le draft **a** `inset-0`, le portail ne
l'a **pas**. Un oubli des deux ne peut pas le satisfaire.

**Le draft gèle parce qu'un choix de carte n'a pas d'enjeu temporel ; le vote ne gèle pas parce que
le temps EST son enjeu.** C'est la seule phrase de l'étape dont tout le reste découle.

## 9. Bancs

| Mesure | Valeur | Verdict |
| --- | --- | --- |
| Boss, mêlée à 4 | **59,0 s** médiane (37,7 → 120,9) | bande 30-90 s → **on garde** |
| Boss, duel | 40,2 s, identique sur 8 graines | plancher de décor |
| Pas p95 à 4 000 entités | **1,64 ms** | budget 11,11 ms |
| Coût des champs | indépendant de N | il ne dépend que du nombre de cellules |
| Palier 10, plafond d'une vague | 800, soit **20 %** de `MAX_ENTITIES` | la formule ne diverge pas |
| PV d'un palier, palier 0 → 10 | 13 040 → 54 767 (**×4,2**) | |
| Trafic, 4 joueurs | **1,53 ko/s** par joueur | indépendant du nombre d'entités |
| Trafic, 200 joueurs / 50 salons | 0,97 ko/s par joueur, 92 % d'un cœur | ~54 salons par cœur |
| Rapport morts / apparitions | **0,47** | inchangé — la visée reste le limiteur |

⚠️ **Le banc `niveau2` sort 19 échecs sur 40**, et les quarante lignes disent la même chose : boss à
30 s, run perdue entre 47 et 51 s. **Un joueur seul meurt au boss du palier 0 une fois sur deux.**
Le chiffre était de 3/40 avant l'amélioration de cadence de la tâche 19 — des armes plus fortes
tuent **plus loin**, le butin reste où il tombe, et les ramassages chutent de 44 %. Voir le §10.

## 10. Ce qui reste ouvert

| Question | État |
| --- | --- |
| **Une run solo vaut-elle quelque chose ?** | 19/40 pertes au boss du palier 0. **Rien dans la spec ne le dit**, et ce n'est donc pas un bug tant que la réponse n'est pas écrite |
| **La visée** est le vrai limiteur du rapport morts/apparitions | jamais essayée — trois autres leviers mesurés, trois plateaux |
| **Le rayon de ramassage punit chaque gain de puissance** | tuer plus loin laisse le butin plus loin. Décision de l'auteur |
| **Un boss se tue par les réactions, pas par les armes** | un joueur portant Braise ET Givre fond 1 500 PV en 2,5 s — 55 réactions à 25 dégâts. C'est peut-être le bon design ; ce n'est pas une décision qui a été prise |
| **L'éclat des grenades n'a aucun visuel** | l'effet de zone existe, on ne le voit pas |
| **L'atlas dérivé n'est pas sur MinIO** | en production **toute la horde disparaîtrait**. `mc cp assets/tinyswords/derived/monsters.{png,json} qwetle/tarnok/derived/` |
| **`main` est à 30+ commits derrière**, et `origin/main` n'a rien reçu | |
