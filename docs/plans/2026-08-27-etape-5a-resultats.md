# Étape 5a — les éléments : résultats

38 commits, 846 tests (531 back, 315 front). Un projectile marque, un second élément déclenche, la
réaction laisse un champ — et une réaction entre deux joueurs charge la barre de Synergie.

**Spec :** [`../specs/2026-08-27-etape-5a-elements.md`](../specs/2026-08-27-etape-5a-elements.md)
**Plan :** [`2026-08-27-etape-5a-elements.md`](2026-08-27-etape-5a-elements.md)

Le plan comptait onze tâches. Il en compte **vingt-et-une**. Les dix ajoutées viennent toutes de
l'auteur en train de jouer — comme les quinze de l'étape 3, et comme la révision du modèle de cartes
de l'étape 4. **C'est le troisième cycle consécutif où le jeu corrige le raisonnement**, et le
motif est maintenant assez stable pour être nommé.

## 1. Le livrable du §13, en entier

> *Une réaction inter-joueurs charge la barre, une réaction solo non ; deux zones qui se recouvrent
> réagissent.*

Quatre vrais clients, quatre vraies sockets. Le test **assène** plutôt que de constater l'absence de
plantage : un conflit a eu lieu, la barre monte entre deux joueurs et ne bouge pas en solo, deux
zones qui se recouvrent réagissent.

⚠️ **La moitié négative a demandé plus de soin que la positive.** « La barre ne bouge pas » se lit
aussi bien « aucune réaction n'a eu lieu » : le test compare les **deux listes de réactions champ à
champ**, douze de chaque côté, seul le bit diffère. Sans ça il aurait passé avec un salon où plus
rien ne réagit.

## 2. Le contrat de réplication tient, y compris quand un élément touche le déplacement

| Scénario | Dérive |
| --- | --- |
| Morts + séparation, **avec** rejeu | **0,000 px** |
| Apparition tardive, **avec** rattrapage | **0,000 px** |
| Tick serveur recalé en continu | **0,000 px** |
| **Givre en jeu, avec rejeu** | **0,000 px** |
| Givre en jeu, **sans** rejeu | 372,760 px |
| Zone arrivée hors de l'anneau de rejeu (12 > 8 ticks) | 318,399 px, comptées |

**Le ralentissement du Givre était le vrai risque de l'étape** : c'est le premier effet élémentaire
qui touche le déplacement, donc le contrat que tout le projet protège depuis l'étape 2.

Ce qui l'a sauvé n'est pas un correctif mais un **choix de modèle** : l'effet porte sur la **zone**,
pas sur la marque. La marque ne voyage pas — le client ne peut rien en dériver. Les zones sont
annoncées et leur mort dérivée, et les positions sont **bit-identiques** : le prédicat
`dx² + dy² < r²` rend donc le **même booléen** des deux côtés. Zéro octet de plus, zéro divergence.

Un chemin de repli était écrit d'avance — faire du Givre un pur marqueur — et n'a pas servi.

## 3. Ce que la vérification manuelle a trouvé

**C'est la section la plus importante de ce document.** Dix tâches, toutes nées de l'œil.

| Signalé par l'auteur | Ce que c'était |
| --- | --- |
| « les ennemis ont une réserve d'HP » | la piétaille mourait au premier impact, le modèle élémentaire était **mécaniquement impossible** |
| « on fera moins d'ennemis au début » | le générateur était calibré pour l'étape 3 |
| « je ne vois pas la marque » | la teinte de sprite du §6.6, donnée comme gratuite, était **illisible** |
| « la hitbox semble plus basse » | `anchorY: 0.75` — le corps était dessiné **16 px** au-dessus de sa hitbox |
| « les ennemis sont trop petits » | la texture d'impact faisait **75 %** du diamètre d'une créature |
| « parfois les anneaux disparaissent » | **ma propre borne** : un anneau par cellule de grille |
| « l'aimantation attire jusqu'à lui, même s'il s'éloigne » | l'attraction était une fonction de la distance, pas une capture |
| « les réactions doivent faire les cercles, pas les projectiles » | bascule du §6.3 vers le §6.4 de l'orientation |

### Le cas qui résume l'étape

*« Parfois ils disparaissent lors des superpositions »* n'était pas un bug : c'était la borne que
**j'avais approuvée** deux tâches plus tôt. La tâche 13 dédoublonnait les anneaux par cellule de
grille pour que le compte ne suive pas l'effectif — 816 quads au lieu de 4 000. Élégant, mesuré, et
**il jetait exactement là où ça se voit** : quand les ennemis se serrent.

La leçon n'est pas « ne pas borner ». C'est que **la façon dont une borne dégrade est une décision
de design**, pas un détail d'implémentation. La consigne écrite pour la suite : si un plafond
redevient nécessaire, garder **les plus proches du joueur** — un plafond qui dégrade par distance se
comprend, un plafond qui dégrade par ordre de créneau se lit comme une panne.

## 4. Vingt-huit erreurs de mes documents, rattrapées à l'exécution

**Le plan et la spec se sont trompés plus souvent que le code**, et chaque fois l'implémenteur a
signalé au lieu de choisir en silence. Les plus coûteuses :

- **« Une zone qui réagit se consomme »** — contradiction dure avec le §2 : la mort d'une zone n'est
  jamais annoncée, donc en retirer une côté serveur ferait **diverger le déplacement**. Le
  sous-agent a refusé de l'implémenter.
- **`spawn` oublié** dans la liste des sites à tenir à jour : un créneau recyclé aurait fait naître
  un monstre **déjà marqué par un joueur qu'il n'a jamais croisé**, capable de déclencher une
  réaction *et une charge de Synergie*.
- **Un facteur 2 entre spec et plan** sur le rayon de fusion : avec ma version, deux zones du même
  élément ne se recouvraient **jamais** et une traînée de tir aurait eu des trous.
- **`ZONE` fait 11 octets, pas 12** : la spec disait « ~12 », un ordre de grandeur, et le plan l'a
  durci en chiffre exact **sans recompter**.
- **La zone porte l'élément du déclencheur, pas de la marque** — mon plan disait l'inverse. Mesuré :
  37 réactions contre 1. Le champ de la marque remarque l'ennemi de l'élément que la réaction vient
  de consommer, et le second élément devient inutile.
- **« Deux cartes de puissance font mourir un ennemi lourd en moins d'impacts »** est
  arithmétiquement faux — il en faut quatre. C'est le motif que j'avais moi-même documenté à l'étape
  4, et dans lequel je suis retombé en écrivant ce plan.

Et une affirmation de mon brief **réfutée par la sonde** plutôt que discutée : marquer un ennemi
mourant n'est pas dangereux avec le `Horde` d'aujourd'hui, parce que `#removeAt` écrase la marque au
lieu de l'hériter.

## 5. Le motif de l'étape : deux gardes qui se couvrent

**Quinze occurrences**, dont plusieurs soldées par une **suppression de code** plutôt que par un
test :

| Les deux gardes | Ce qui les séparait |
| --- | --- |
| plafond de réduction / plancher d'un tick | des valeurs que le catalogue n'atteint pas |
| `if (!card)` / le `catch` du rangement | **rien** — `noUncheckedIndexedAccess` tient la garde |
| garde serveur / garde client sur les jetons périmés | un message périmé arrivant après le résultat |
| le `Set` d'unicité / le `splice` de `drawSpread` | **rien** — le `Set` était mort |
| plafond de zones / règle de fusion | l'ordre des deux, et un seul test le voyait |

**La leçon a évolué depuis l'étape 3.** Elle disait : *appliquer la mutation, ne pas la raisonner*.
Elle dit maintenant, en plus : **quand une mutation survit, chercher d'abord si une AUTRE garde la
masque, avant d'écrire un test.**

## 6. Neuf fixtures qui rendaient une mutation invisible

Le motif s'est déplacé du test vers **le décor du test**, et une fois vers **une constante de
production** :

- le porteur mis **en premier**, donc « ne regarder que le premier inventaire » passait ;
- un seul perdant au reconflit, donc aucune collision possible ;
- des joueurs ayant **tous** une carte réservée, donc deux attributions divergeaient sans le garde ;
- un `rng` constant, qui rend l'ordre de consommation invisible ;
- `cell: 32` pour un contenu `32×32` : l'échelle calculée depuis la cellule, la largeur, la hauteur
  ou correctement **donnent toutes le même nombre** — trois mutations y survivaient ;
- `MARK_RING_TEXTURE_DIAMETER` égal au diamètre affiché, donc l'échelle valait 1 et **toute mutation
  d'échelle était indistinguable** ;
- un vol né à l'instant 0, donc oublier sa naissance ne changeait rien ;
- deux zones **alignées**, donc l'axe Y jamais éprouvé ;
- le banc des zones peuplé de piétaille **légère**, tuée du même impact, donc jamais marquée : il
  rendait **zéro partout**.

**Compter le cas qu'on croit créer, ne jamais le supposer.**

## 7. Trois tests et un banc qui passaient en cessant de mesurer

- le test de capacité des projectiles mesurait un pic de 208 **sous son propre seuil de 256** ;
- le test de réplication de l'étape 2 coûtait 5,7 s contre 5 s de délai : il échouait une fois sur
  quatre **sans rien dire du contrat qu'il garde** ;
- deux tests de troncature de vague se fiaient à `WAVE1_MIN_COUNT = 16` et sont devenus intermittents
  quand il est passé à 10 ;
- le banc des zones rendait zéro parce que son décor ne pouvait produire aucune zone.

**Un test intermittent est pire qu'un test absent : on finit par l'ignorer.**

## 8. La dette de `main.ts`, soldée à sa troisième occurrence

| Étape | Ce que rien ne gardait | Tests verts alors |
| --- | --- | --- |
| 3 | le gel de niveau côté client | 76 |
| 4 | `draftScreen.update()` | 117 |
| 5a | `drawZones`, `drawReactionFlashes`, `paintSynergy` | **170** |

Cause unique : `main.ts` faisait ses recherches DOM et son `await stage.init()` **au niveau module**,
donc l'importer exécutait tout le démarrage. **Sept mutations survivaient rien qu'à la tâche 9.**

Elles meurent toutes depuis l'extraction de `composeFrame`, la dette de l'étape 4 comprise. Ce qui a
rendu l'extraction réelle plutôt que cosmétique : **`Stage` satisfait la nouvelle interface sans
adaptateur.** Un adaptateur aurait déplacé le câblage non gardé au lieu de le supprimer.

Quatre mutations survivent encore, **mesurées et nommées** : le branchement du ticker, deux lignes de
câblage du HUD, et la moitié GPU de l'initialisation, qui exige un contexte WebGL.

## 9. Bancs

| | Étape 4 | Étape 5a |
| --- | --- | --- |
| Rejeu de 3 ticks à 1 500 | 3,44 ms | **3,53 ms** |
| Saut maximal | 7,17 px | **7,17 px** |
| Marquage par zone, 30 zones à 4 000 entités | — | **0,176 ms** (1,6 % du budget) |
| Pas complet, armes élémentaires, 4 000 entités | — | **5,91 ms** (budget 11,11) |
| Trafic `ZONE`, 4 joueurs | — | **0,01 ko/s par client** |

**Trois bornes ont été posées par construction plutôt que par espoir**, chacune après mesure :

- **les zones** : une pose qui recouvre une zone du même élément la **rafraîchit** au lieu de
  s'ajouter — le compte suit la surface, pas la cadence. Sans ça : 368 zones à huit exemplaires par
  arme, contre « quelques dizaines » budgetées ;
- **le trafic** : **l'annonce EST la vérité**, une ré-annonce par demi-vie au plus, et le serveur ne
  prolonge pas entre deux. Sans ça : 9,67 ko/s par client à 30 zones, contre 1,22 de trafic total ;
- **la traînée des projectiles** : un quad **étiré et tourné**, pas une file de segments — 2 048
  quads au lieu de 6 144.

Et depuis la tâche 21, les zones naissent des **réactions** : leur compte tombe de 27 à 5, et le
trafic de 0,08 à 0,01 ko/s. **Aucune borne n'a été retirée** — le jour où une réaction en chaîne
arrivera, elles seront déjà là.

## 10. Ce qui reste ouvert

- **La vérification manuelle n'est pas close.** Six réglages n'ont qu'un point de départ raisonné :
  `MARK_DURATION_TICKS` (60), `REACTION_DAMAGE` (25), `BODY_SCALE` (1,25, plafonné à 1,28 par un
  test), `ZONE_ALPHA` (0,34), `MARK_RING_SQUASH` (0,55) et `ORB_FLIGHT_LIFETIME_MS` (200).
- **Une arme de Givre seule ne ralentit plus rien** depuis la tâche 21, et **la piétaille légère ne
  produit aucun champ** puisqu'elle meurt avant d'être marquée. Cohérent avec « la réaction est la
  trace d'une combinaison », mais c'est un choix.
- **L'aimantation peut encore mentir dans un cas**, préexistant : la position locale est *prédite*,
  donc elle peut effleurer le rayon puis être corrigée. Pour un allié, aucun risque — il est vu en
  retard, donc le serveur a ramassé avant.
- **Le lance-flammes reste neutre** pour une raison qui n'existe plus : il craignait 216 zones à lui
  seul, ce que le modèle de la tâche 21 rend impossible.
- **`ZONE_CAPACITY = 128` reste raisonné**, pas mesuré au pire cas de couverture.
- Hérité de l'étape 3 : le plafond de 4 000 entités n'est plus tenu, et le multijoueur n'a jamais été
  joué sur un vrai réseau.
