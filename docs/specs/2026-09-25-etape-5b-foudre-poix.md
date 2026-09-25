# Étape 5b — Foudre, Poix, et l'armure

**Étape précédente :** [`2026-09-01-etape-6a-paliers.md`](2026-09-01-etape-6a-paliers.md)
**Orientation :** [`2026-08-19-coop-survivors-orientation.md`](2026-08-19-coop-survivors-orientation.md) — §6.3, §6.4

## 1. Ce que l'étape change au jeu

Deux éléments de plus — **Foudre** et **Poix** — une statistique de plus — **l'armure** — et
**cinq réactions** de plus. Le jeu passe de 2 éléments et 1 réaction à **4 éléments et
6 réactions**.

**Et zéro octet de plus sur le fil.** C'est le critère de l'étape, pas son espoir : aucun message
nouveau, aucun champ ajouté à un message existant. `ZONE` porte déjà un `element` sur un `u8` qui a
de la place ; `REACTION` porte déjà la `pair` ; et la chaîne de la Foudre se **dérive** (§4).

⚠️ **Le découpage 5b / 5c est fait par le RISQUE, pas par le nombre.** Le §6.3 donne à chaque
élément un effet seul, et ces effets ne coûtent pas la même chose :

| Élément | Effet seul (§6.3) | Ce qu'il touche | Étape |
| --- | --- | --- | --- |
| **Foudre** | chaîne vers quelques ennemis proches | dégâts | **5b** |
| **Poix** | englue, ralentit, amplifie les dégâts reçus | zone + dégâts | **5b** |
| Chaux | réduit l'armure, **brouille le ciblage** | `targetField` | 5c |
| Vif-argent | **lie les ennemis proches**, attire les projectiles | relation entre entités | 5c |

La Foudre ne touche rien que le serveur n'arbitre déjà. La Poix est une flaque, donc une **zone
annoncée** — exactement la parade qui a sauvé le Givre à l'étape 5a. La Chaux et le Vif-argent
portent les deux vrais problèmes : un champ suivi qui change, et une relation par paire d'entités
qui ne vit sur aucune géométrie. Ils attendent une étape d'expérience de plus.

## 1.1 Ce que cette étape ne met pas en danger

**Le contrat de réplication.** Tout effet de déplacement de cette étape vit sur une **zone
annoncée**, dont les deux côtés dérivent le même prédicat `dx² + dy² < r²` à partir de positions
bit-identiques. C'est le modèle du Givre, et il n'est pas revisité.

⚠️ **La marque est cosmétique côté client, et doit le rester.** `GameClient#markLocally` le dit en
toutes lettres et interdit de la rendre autoritaire. **Aucun effet de cette étape ne roule sur la
marque** — ni le ralentissement, ni le gel, ni l'amplification. La marque teinte, elle ne décide
pas.

**Les quatorze tableaux de la horde ne bougent pas.** L'armure vit sur l'**archétype**, pas sur
l'entité : les quatre sites à tenir synchronisés (`#removeAt`, `spawn`, `saveState`,
`restoreState`) ne gagnent aucune ligne.

## 1.2 Le pitch du projet n'est pas encore vrai, et ne le sera pas à la fin de cette étape

Le README promet qu'*« un joueur seul ne peut pas couvrir assez d'éléments pour tout déclencher
lui-même »*. Avec **quatre** éléments et **quatre** slots d'arme, un joueur seul les couvre tous —
donc les six réactions.

**La rareté ne mord qu'au cinquième élément**, et l'affirmation ne devient vraie qu'en 5c. Ça ne
change pas le découpage ; ça dit que 5c n'est pas optionnelle, et que la phrase du README reste une
intention jusque-là.

## 2. L'armure

Un champ `armor` sur l'archétype, **en fraction** : `dégâts × (1 − armure)`.

**Le pourcentage, et pas une réduction plate.** La raison est mesurable : `Horde.hp` est une
`Float32Array`, et les PV sont déjà fractionnaires — la combustion de la Braise retire 0,1 par
tick. `5 × (1 − 0,3) = 3,5` ne s'arrondit donc **nulle part** : l'ennemi tombe à 1,5 PV et meurt au
coup suivant.

⚠️ **R9 ne mord pas ici, et c'est un fait à vérifier plutôt qu'à croire.** L'arrondi a mordu deux
fois dans ce projet — il a avalé l'empilement des passifs à l'étape 4, il a amplifié l'échelle de
palier à l'étape 6a. Un test doit assener qu'une réduction fractionnaire **arrive entière** jusqu'aux
PV, sans passer par un `Math.round` intermédiaire.

**Un seul chemin.** Les dégâts s'appliquent aujourd'hui en trois endroits de `back/src/combat.ts`
(`hp[i] -= …`). Ils passeront tous par **une seule fonction**, sur le modèle de `Room#grantCard` :
*« c'est le seul chemin par lequel une carte entre dans un inventaire »*. Deux formules d'armure
divergeraient, et le jour où elles divergent, c'est un test qui manque, pas un bug qui se voit.

**Qui en porte :**

| | Armure |
| --- | --- |
| Piétaille légère | **0** |
| Piétaille lourde | > 0 |
| Boss | > 0 |

La légère à zéro par décision : elle meurt en un coup par construction (5 PV, la dague en fait 5),
et lui donner de l'armure rendrait le début de run illisible — le joueur verrait ses tirs ne plus
tuer sans comprendre pourquoi.

**Ce que ça rend vrai :** *« Choc thermique — dégâts bruts massifs sur une cible, **brise
l'armure** »* est écrit au §6.4 depuis le début et n'avait pas d'objet.

⚠️ **L'armure est une donnée d'archétype, et toute modification en est DÉRIVÉE.** Supraconduction
« réduit l'armure dans la zone » (§5) : ce n'est pas une écriture dans un état par ennemi, c'est
une fonction `armureA(entite, tick)` qui lit l'archétype **et** l'appartenance aux zones. La
distinction n'est pas cosmétique — un état écrit devrait voyager, une dérivation ne le doit pas.
C'est la même forme que `aliveAt` et `slowsAt` pour les zones de l'étape 5a.

## 3. La Poix

Effet seul : **amplifie les dégâts reçus**. Une flaque au sol ; tout ce qui frappe un ennemi qui la
piétine fait davantage.

⚠️ **Écart assumé au §6.3, et la raison vaut d'être écrite.** Le §6.3 dit de la Poix *« englue,
ralentit, amplifie »* — mais **le Givre ralentit déjà**. Deux éléments dont l'effet principal est le
même, c'est du contenu mort : personne ne draftera l'un pour ce que l'autre fait déjà, et l'un des
deux sera strictement meilleur.

**Décision : la Poix ne ralentit pas.** Le Givre garde le contrôle, la Poix devient le
multiplicateur. Les deux se draftent alors **ensemble** au lieu de se remplacer — ce qui est
exactement ce qu'un système de réactions doit produire.

L'amplification est dérivée de l'appartenance à la zone, comme le ralentissement du Givre. Elle
s'applique dans la **même fonction unique** que l'armure (§2) : un dégât brut entre, l'armure le
réduit, la Poix le majore, un dégât net sort.

## 4. La Foudre, et la chaîne qui ne coûte rien

Effet seul : chaque impact saute vers quelques ennemis proches.

**La chaîne se dérive des deux côtés.** Les positions de la horde sont bit-identiques — c'est le
contrat tenu depuis l'étape 2, mesuré à 0,000 px sur trois scénarios — donc « les N plus proches
dans un rayon R » rend **la même liste** sur le serveur et sur le client. Le client dessine la
polyligne, le serveur seul prononce les dégâts, et les morts arrivent par `DEATHS` comme toujours.

**Aucun message, aucun octet.** C'est le même raisonnement que « annoncer une fois, dériver
ensuite », poussé d'un cran : ici il n'y a même rien à annoncer, parce que l'entrée de la fonction
(le point d'impact) est déjà connue des deux côtés.

⚠️ **À une condition, et c'est le piège de la section.** La sélection doit être **totalement
déterministe**. Deux ennemis à distance strictement égale, et c'est l'ordre d'itération qui tranche
— or cet ordre dépend du compactage de la horde (`#removeAt` déplace le dernier élément dans le
trou), qui n'est pas garanti identique des deux côtés. **Départager par `entityId`**, et le prouver
par un test qui pose deux ennemis à distance exactement égale.

**Il n'y a pas de RNG dans la chaîne.** Une sélection aléatoire, même semée, demanderait que les
deux côtés consomment le même nombre de tirages au même moment — une contrainte qui se brise
silencieusement.

## 5. Les cinq réactions

| Paire | Nom (§6.4) | Ce qu'on implémente | Porté par |
| --- | --- | --- | --- |
| Braise + Foudre | **Surchauffe** | une zone qui brûle, plus fort et plus longtemps que la zone générique | zone |
| Braise + Poix | **Embrasement** | dégâts à tous les ennemis **poissés** dans un rayon | géométrie |
| Givre + Foudre | **Supraconduction** | vitesse nulle et armure réduite dans la zone | zone |
| Givre + Poix | **Verglas** | friction réduite dans la zone : les ennemis glissent | zone |
| Foudre + Poix | **Court-circuit** | la chaîne sans limite de sauts tant que les cibles sont poissées | dérivé |

**Aucune ne pose d'état par entité sur le fil.** Quatre dérivent de l'appartenance à une zone
annoncée ; la cinquième dérive du même prédicat que la chaîne.

⚠️ **« Gel immédiat » devient « gel tant qu'on piétine ».** Le §6.4 décrit Supraconduction comme un
gel instantané qui colle à l'ennemi. Décision : **l'effet vit sur la zone**. Un ennemi poussé hors
du rayon repart. C'est ce qui garde le contrat de réplication par construction — et en jeu ça
produit des zones de contrôle qu'on pose et qu'on tient, ce qui est un meilleur verbe qu'un
gel qu'on subit.

⚠️ **Embrasement se propage par la géométrie, pas par un graphe.** *« Se propage à tous les ennemis
poissés proches »* se lit comme une propagation de proche en proche. Un graphe de propagation est
un parcours dont le résultat dépend de l'ordre de visite — donc la même fragilité que la chaîne,
en pire. Décision : **un rayon depuis le point de réaction, filtré sur « poissé »**. Une seule
passe, aucun ordre à garantir.

## 6. Les armes

Le §6.3 vise *« six à sept armes par élément, plus quatre à six armes neutres »* sur un pool de 40.
Le pool en compte **neuf** : 2 Braise, 2 Givre, 5 neutres.

Cette étape ajoute **au moins deux armes par nouvel élément** — en dessous, l'élément ne se draftera
qu'accidentellement et l'étape ne se jugera pas. Le pool complet du §6.2 (≥ 40) n'est pas l'objet de
cette étape.

## 7. La porte de performance

**Une mesure engagée AVANT de la faire**, comme le §3.3 de l'étape 3 et le §7 de l'étape 6a.

**La chaîne de Foudre est une recherche de voisinage par impact.** Le tir est automatique et la
cadence a été augmentée de 40 % à l'étape 6a. À quatre joueurs armés de Foudre, c'est une recherche
des N plus proches **par projectile qui touche**, plusieurs fois par tick.

| Issue | Ce qu'on fait |
| --- | --- |
| le pas p95 reste sous 11,11 ms à 4 000 entités | **on garde** |
| il dépasse | la chaîne passe par la **grille de voisinage** qui sert déjà à la séparation, pas par un balayage |

⚠️ **Le banc `zones` a déjà menti une fois** — peuplé de piétaille légère, il mesurait un monde où
presque rien ne survit assez pour porter une zone. Le banc de cette étape doit être peuplé de
**lourds**, sans quoi il rendra un chiffre qui ne mesure rien.

## 8. Vérification

**Le livrable :** *quatre joueurs portant quatre éléments différents déclenchent les six réactions ;
un joueur seul portant deux éléments n'en déclenche qu'une.*

Un test d'intégration à quatre clients réels, comme ceux des étapes 4, 5a et 6a.

⚠️ **Les deux moitiés, toujours.** « Les six réactions se déclenchent » se lit aussi bien avec un
salon qui déclenche n'importe quoi à tout propos. Il faut assener **quelle** réaction, et que la
paire qui ne devrait rien produire ne produise **rien** — en comparant deux listes champ à champ,
comme la Synergie à l'étape 5a, et non en constatant une absence.

**Ce qui doit rester vrai :**
- les trois chiffres de réplication à **0,000 px**, mesurés là où ils vivent
  (`shared/horde.replication.test.ts`) ;
- **aucun octet de plus par tick** — le trafic par joueur ne bouge pas ;
- le pas p95 sous 11,11 ms à 4 000 entités.

**Ce qui relève du jugement :**
- la chaîne de Foudre **se voit**-elle, ou disparaît-elle dans la horde ?
- l'armure **se sent**-elle, ou se lit-elle comme des armes qui ont faibli ?
- une Poix sans ralentissement **se distingue**-t-elle du Givre en jeu ?
- six réactions, est-ce assez pour que le draft ait un sens ?

## 9. Écarts assumés

**§6.3 — la Poix ne ralentit pas.** Le Givre garde le contrôle, la Poix est le multiplicateur.
Raison au §3 : deux ralentissements font du contenu mort.

**§6.4 — Supraconduction gèle tant qu'on piétine, pas immédiatement et définitivement.** Raison au
§5 : l'effet vit sur la zone, ce qui tient le contrat de réplication par construction.

**§6.4 — Embrasement est un rayon, pas une propagation.** Raison au §5 : un parcours de graphe
dépend de son ordre de visite.

**§6.2 — le pool reste loin de 40 armes.** Cette étape en ajoute quatre environ. Le pool complet est
une étape de contenu à part entière.

## 10. Questions laissées ouvertes

- **Combien de sauts pour la chaîne, et quel rayon ?** Des valeurs de départ, à régler à l'œil comme
  `MARK_DURATION_TICKS` — les deux se multiplient.
- **L'armure des lourds, et celle du boss, sont-elles la même ?** Un boss qui n'a que des PV ne se
  sent pas comme un boss (question ouverte de l'étape 6a) ; l'armure est peut-être une partie de la
  réponse, ou une aggravation.
- **La Poix amplifie-t-elle aussi les dégâts de réaction ?** Si oui, Poix + n'importe quoi devient le
  meilleur couple du jeu par construction.
- **Une zone de Supraconduction qui fige la horde annule-t-elle la pression du bullet heaven ?**
  C'est un outil de contrôle très fort dans un genre dont la tension est le nombre.
