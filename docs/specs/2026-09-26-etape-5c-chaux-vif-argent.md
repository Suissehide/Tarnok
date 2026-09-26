# Étape 5c — Chaux, Vif-argent, et les neuf dernières réactions

**Étape précédente :** [`2026-09-25-etape-5b-foudre-poix.md`](2026-09-25-etape-5b-foudre-poix.md)
**Orientation :** [`2026-08-19-coop-survivors-orientation.md`](2026-08-19-coop-survivors-orientation.md) — §6.3, §6.4

## 1. Ce que l'étape change au jeu

Les deux derniers éléments — **Chaux** et **Vif-argent** — et les **neuf réactions** restantes. Le jeu
passe de 4 éléments et 6 réactions à **6 éléments et 15 réactions**. C'est la fin du §6.3 et du §6.4.

**Et le pitch du projet devient vrai.** Le README promet qu'*« un joueur seul ne peut pas couvrir
assez d'éléments pour tout déclencher lui-même »*. Avec six éléments et **quatre** slots d'arme, un
joueur seul en couvre au mieux quatre, donc **six réactions sur quinze**. Une équipe de quatre couvre
les six éléments, donc les quinze. La phrase cesse d'être une intention — elle était fausse à quatre
éléments, où un joueur seul couvrait tout.

**Le critère de l'étape reste celui de 5b : zéro octet de plus sur le fil.** Aucun message nouveau,
aucun champ ajouté. Le nibble de réaction de `ZONE.kind` fait 4 bits, soit 16 valeurs ; quinze
réactions y tiennent, **avec une de reste**. C'est juste, et il faut le dire : une seizième réaction
demanderait un octet.

## 1.1 Plus grosse que 5b en volume, pas en risque

Neuf réactions contre cinq, mais **une seule est structurellement neuve** :

| Mécanisme | Réactions | Machinerie |
| --- | --- | --- |
| Dégât ou zone | Fournée, Vaporisation, Éclat de gel, Arc caustique | **prouvée** à 5b |
| Réutilisation de `chainTargets` | Paratonnerre | **prouvée** |
| Déplacement par la zone | Gel profond, Mortier vif, Aveuglement | **prouvée** (Supraconduction, Verglas) |
| **Partage de dégâts entre entités** | **Amalgame** | **neuve** — serveur seul, aucune réplication |

⚠️ **Le découpage 5b / 5c avait mis de côté les deux effets risqués du §6.3** — celui qui touche le
ciblage et celui qui lie des entités. **Les deux sont désarmés, et le §3 et le §4 disent comment.**
Ce n'est pas que le risque a disparu : c'est qu'une étape d'expérience de plus a montré où il ne
vivait pas.

## 1.2 Ce que cette étape ne met pas en danger

**Le contrat de la horde.** Tout effet de déplacement vit sur une **zone annoncée** dont les deux
côtés dérivent le même prédicat à partir de positions bit-identiques. C'est le modèle du Givre, tenu
par la Supraconduction et par Verglas, et il n'est pas revisité.

**Le contrat des PROJECTILES — et c'est la découverte du cadrage.** `shared/projectiles.ts` porte un
second contrat de réplication, parallèle à celui de la horde : *« simulés localement, jamais
répliqués… la salve reste calculée identiquement des deux côtés à partir de la même direction
quantifiée »*, verrouillé par un test de dérivation (deux instances indépendantes, mêmes entrées,
mêmes projectiles).

Une trajectoire ne dépend aujourd'hui que de **quatre** choses : l'arme, le tick, la position du
tireur, la direction quantifiée. **Aucune ne concerne la horde, et le §4 garantit que ça ne change
pas.**

**Les quatorze tableaux de `Horde` ne bougent pas**, ni leurs quatre sites de synchronisation
(`#removeAt`, `spawn`, `saveState`, `restoreState`).

⚠️ **La marque reste cosmétique côté client.** `GameClient#markLocally` l'écrit et interdit de la
rendre autoritaire. **Aucun effet de cette étape ne roule sur la marque** — ni la fuite, ni la
liaison, ni le rayon élargi.

## 2. La Chaux

**Effet seul, deux moitiés :**

| Moitié | Mécanisme | Risque |
| --- | --- | --- |
| **réduit l'armure** | `ZoneField.armorReductionAt`, qui **existe déjà** (étape 5b, tâche 7) | aucun |
| **fait fuir** | la direction du champ est **inversée** pour un ennemi en zone de Chaux | déplacement, donc zone |

⚠️ **« Brouiller le ciblage » ne peut pas être une écriture dans `targetField`.** `Horde#retarget`
le **recalcule à chaque tick** depuis les positions des joueurs : toute écriture serait écrasée au
tick suivant. C'est donc une **substitution de direction au moment du déplacement**, dérivée de
l'appartenance à la zone — exactement la forme du ralentissement, du gel et du dérapage.

**Décision : l'ennemi FUIT, direction du champ inversée.** Trois formes étaient dérivables ; c'est
une décision de jeu, pas de plomberie.

| Forme | Pourquoi pas |
| --- | --- |
| il **erre** (direction pseudo-aléatoire dérivée de `entityId` et du tick) | fidèle au §6.4, mais une horde qui erre **perd sa pression**, et la pression est la tension du genre |
| il **se trompe de joueur** (index de champ décalé) | belle texture coopérative, mais **littéralement inerte en solo** — un seul champ — ce qui se lit comme un bug et non comme une faiblesse |
| **il fuit** | lisible, dérivable en une ligne, **identique en solo et à quatre**, et ça fait de la Chaux un outil de **contrôle** : on repousse un paquet pour se dégager |

⚠️ **Écart au §6.4 assumé, et il porte sur *Aveuglement*** (Chaux + Vif-argent), décrit comme *« les
ennemis perdent leur cible et **errent** »*. La réaction reprendra la fuite, plus forte ou plus
longue, pas l'errance. La raison est ci-dessus, et elle doit être écrite dans la table.

**Et la Chaux disperse, là où *Amalgame* et *Mortier vif* rassemblent.** Le §6.4 dit que ces deux-là
sont délibérément des outils de regroupement, *« parce que rassembler la horde est une action
offensive »*. La Chaux est donc le levier **inverse**, assumé : deux leçons opposées à apprendre, et
c'est du contenu, pas une incohérence.

## 3. Le Vif-argent — la liaison se dérive, aucun graphe ne voyage

**Deux ennemis sont liés s'ils sont dans la même zone de Vif-argent et à moins de `LINK_RADIUS` l'un
de l'autre.** Les zones sont annoncées, les positions bit-identiques : les deux côtés calculent **les
mêmes paires**. Aucun octet, aucune relation à transporter, aucun tableau de plus sur `Horde`.

⚠️ **La liaison n'est PAS transitive, et c'est la contrainte structurante du §3.** Un amas par
fermeture transitive est un **parcours de graphe**, dont le résultat dépend de l'**ordre de visite** —
or cet ordre dépend du compactage de la horde, qui n'est pas garanti identique des deux côtés.

C'est la troisième fois que ce projet rencontre ce piège, et les deux premières fois ont produit la
même parade :

| Occurrence | Parade |
| --- | --- |
| la chaîne de la Foudre (5b, tâche 2) | départage par `entityId`, jamais par l'ordre du tableau |
| *Embrasement* (5b, tâche 6) | **un rayon, pas une propagation** de proche en proche |
| **la liaison du Vif-argent** | **un rayon, pas un amas** |

**Conséquence directe : *Amalgame* partage les dégâts dans un RAYON, pas sur un amas.** Écart assumé
au §6.4, même raison qu'*Embrasement*.

## 4. Le Vif-argent — « attire les projectiles » devient un rayon de touche élargi

**Décision : l'attraction est un effet de DÉGÂT, côté serveur seul. Aucune trajectoire n'est
courbée.**

Un ennemi dans une zone de Vif-argent est plus facile à toucher : `PROJECTILE_HIT_RADIUS` (32) est
majoré pour lui. Le joueur **lit** ça comme de l'attraction — ses tirs accrochent — sans qu'aucun
projectile ne dévie.

⚠️ **Ce que ça protège.** Courber les trajectoires ferait dépendre le contrat des projectiles de
celui de la horde : deux invariants couplés au lieu d'un, et le test de dérivation des projectiles
devrait désormais s'exécuter avec une horde non vide. Le §1.2 dit pourquoi ça compte — et **si
l'attraction avait visé les ennemis MARQUÉS plutôt que les zones, elle aurait divergé
immédiatement**, la marque étant cosmétique côté client.

**Écart assumé au §6.3**, qui dit *« attire les projectiles »*. C'est l'effet qui est rendu, pas le
mécanisme.

## 5. Les neuf réactions

| Paire | Nom (§6.4) | Ce qu'on implémente | Porté par |
| --- | --- | --- | --- |
| Braise + Chaux | **Fournée** | la combustion double, et l'armure **tombe à zéro** dans la zone | zone |
| Braise + Vif-argent | **Vaporisation** | dégâts dans un rayon autour des ennemis **liés** | géométrie |
| Givre + Chaux | **Éclat de gel** | dégâts bruts massifs sur une cible | dégât |
| Givre + Vif-argent | **Gel profond** | vitesse nulle dans la zone, **plus forte ou plus longue** que Supraconduction | zone |
| Foudre + Chaux | **Arc caustique** | la chaîne laisse un champ corrosif (réduction d'armure) à chaque saut | zone + `chainTargets` |
| Foudre + Vif-argent | **Paratonnerre** | la chaîne préfère les ennemis **liés** — `exclude` pré-rempli des non-liés | `chainTargets` |
| Poix + Chaux | **Mortier vif** | vitesse nulle **et** amplification : scellés et fragiles | zone |
| Poix + Vif-argent | **Amalgame** | les dégâts subis par un ennemi lié frappent aussi ses voisins **dans un rayon** | serveur seul |
| Chaux + Vif-argent | **Aveuglement** | la fuite, plus forte ou plus longue que la Chaux seule | zone |

**Aucune ne pose d'état par entité sur le fil.** Six dérivent de l'appartenance à une zone annoncée,
deux réutilisent `chainTargets`, une vit entièrement côté serveur.

⚠️ **« Ignore l'armure » ne doit PAS contourner `appliquerDegats`.** Le §6.4 écrit *« ignore
l'armure »* pour *Fournée* ; un chemin de dégât qui sauterait la fonction serait **un second chemin**,
c'est-à-dire exactement ce que « un seul chemin » existe pour empêcher — et le docbloc de
`damageInRadius` porte déjà la trace de cette erreur commise une fois. La forme correcte : la zone de
*Fournée* pousse `armorReductionAt` jusqu'à **annuler** l'armure de l'archétype. `armureA` est déjà
bornée par le bas (`Math.max(0, base - reduction)`) : il n'y a rien à ajouter, seulement une valeur à
choisir.

⚠️ **Deux réactions doivent être distinguables de leur élément, sinon elles sont du contenu mort.**
*Gel profond* face à la Supraconduction, et *Aveuglement* face à la Chaux seule, ne diffèrent que par
l'intensité ou la durée. **Si les chiffres ne les séparent pas en jeu, la réaction n'existe pas** — et
c'est une question de la vérification manuelle, pas du code.

⚠️ **Et un piège d'ordre que l'étape 5b a payé deux fois.** Une zone de réaction porte, dans ses bits
d'élément, celui du **déclencheur** — donc du projectile arrivé second. Toute réaction dont l'effet se
dériverait de son élément serait **dépendante de l'ordre d'arrivée**. `zoneSlowFactor` existe pour
ça ; **chaque nouvelle réaction qui touche une grandeur de zone doit porter sa valeur explicitement**,
et son test doit poser les deux ordres et assener l'égalité.

## 6. Les combinaisons de zones se prennent au MAXIMUM

Quatre grandeurs de zone se combinent déjà par maximum — `ampAt`, `armorReductionAt`,
`collisionDamageAt`, `burnAt` — et chacune porte son test « ne cumulent pas ».

⚠️ **La cinquième, le rayon de touche élargi du §4, suit la même règle, et son test appartient à la
même famille.** L'étape 5b a appris ça au prix d'un bug : la brûlure de zone était la seule grandeur à
**sommer**, quatre champs superposés faisaient 72 PV/s — et la seule sans test « ne cumulent pas »
était précisément celle qui sommait.

Le **minimum** de `Horde#computeSlow` reste à part, et sa raison est **arithmétique** et non de jeu :
*« le minimum est commutatif et associatif exactement ; un produit de flottants ne l'est pas »*, parce
que l'ordre d'itération n'est pas garanti identique des deux côtés. **Ne pas confondre les deux
raisons.**

## 7. Les armes

Le §6.3 vise six à sept armes par élément plus quatre à six neutres, sur un pool de 40. Le pool en
compte **13**.

Cette étape ajoute **au moins deux armes par nouvel élément** — en dessous, l'élément ne se draftera
qu'accidentellement et l'étape ne se jugera pas. Le pool complet reste une étape de contenu à part.

⚠️ **`Weapon.look` est obligatoire et chaque apparence doit être distincte** — la garde est machine
(`assertWeaponLooks`, et un test de rendu qui compare au compte dynamique de `WEAPONS`). À 13 armes
elle a déjà attrapé une collision de diamètre.

## 8. La porte de performance

**Deux mesures engagées AVANT de les faire.**

**A. La liaison est une recherche de paires.** Naïvement en `O(n²)` sur les ennemis en zone. Le banc
doit le mesurer **peuplé de LOURDS** — le banc `zones` a menti une fois en étant peuplé de piétaille
légère, qui meurt au premier impact.

| Issue | Ce qu'on fait |
| --- | --- |
| pas p95 sous **11,11 ms** à 4 000 entités | **on garde** |
| il dépasse | la liaison passe par la **grille de voisinage** qui sert déjà à la séparation |

**B. `ZONE_CAPACITY` (128) avec quinze types de champ.** L'étape 5b a mesuré **25 %** d'occupation en
régime soutenu avec six réactions, et `truncatedZones` à zéro. Quinze réactions **multiplient les
`kind` distincts**, et deux zones de `kind` différent **ne fusionnent pas** depuis 5b.

⚠️ **C'est la mesure la plus susceptible de mal tourner de toute l'étape**, et elle n'est pas
extrapolable : 5b a déjà démenti une extrapolation de 13-19 % par une mesure à 25 %.

## 9. Vérification

**Le livrable :** *quatre joueurs portant quatre éléments différents déclenchent six réactions ; les
quinze ne sont atteignables qu'en couvrant les six éléments — donc jamais par un joueur seul.*

C'est le §13 de l'orientation rendu littéral, et c'est la première fois que le pitch est **testable**.

⚠️ **Les deux moitiés, toujours.** *« Les quinze réactions se déclenchent »* se lit aussi bien avec un
salon qui déclenche n'importe quoi. Il faut assener **quelle** réaction, et qu'une paire qui ne doit
rien produire ne produise **rien** — en comparant deux listes champ à champ.

**Ce qui doit rester vrai :**
- les chiffres de réplication à **0,000 px**, mesurés là où ils vivent
  (`shared/horde.replication.test.ts`), avec leurs chiffres non nuls à côté ;
- le **test de dérivation des projectiles** intact, et toujours indépendant de la horde ;
- **aucun octet de plus par tick** — le trafic par joueur ne bouge pas, mesuré au niveau socket ;
- `truncatedZones` à **zéro**, et l'occupation mesurée et non extrapolée ;
- le pas p95 sous 11,11 ms à 4 000 entités.

**Ce qui relève du jugement :**
- **quinze réactions, est-ce lisible ?** Un joueur peut-il savoir ce qui vient de se produire ?
- *Gel profond* se distingue-t-il de la **Supraconduction** ? *Aveuglement* de la **Chaux seule** ?
- la Chaux qui **disperse** se comprend-elle, à côté d'*Amalgame* et *Mortier vif* qui rassemblent ?
- le rayon de touche élargi **se sent**-il comme de l'attraction, ou comme rien ?
- six éléments et quatre slots : le **draft** a-t-il enfin un enjeu ?

## 10. Écarts assumés

**§6.4 — *Aveuglement* fait fuir, il ne fait pas errer.** Raison au §2 : une horde qui erre perd sa
pression.

**§6.4 — *Amalgame* partage dans un rayon, pas sur un amas.** Raison au §3 : un parcours de graphe
dépend de son ordre de visite. Même écart qu'*Embrasement* à l'étape 5b.

**§6.3 — « attire les projectiles » devient un rayon de touche élargi.** Raison au §4 : courber les
trajectoires coupleraient deux contrats de réplication.

**§6.2 — le pool reste loin de 40 armes.** Cette étape en ajoute quatre environ.

## 11. Questions laissées ouvertes

- **`LINK_RADIUS`, et l'intensité de chaque réaction** : valeurs de départ, à régler à l'œil.
- **Le rayon de touche élargi ne se voit pas.** Aucun retour visuel n'est prévu ; si ça ne se sent
  pas, c'est du contenu invisible.
- **Une réaction impliquant la Poix amplifie ses propres dégâts** (mesuré à 5b, ×1,5) : avec
  *Amalgame* et *Mortier vif* qui ajoutent deux paires à la Poix, la question de jeu devient plus
  lourde, pas moins.
- **La dette de mesure de 5b n'est pas soldée** : `npm run bench` mesure l'ancien jeu — `kills`,
  `slots` et `zones` choisissent leurs armes par `.slice(0, 4)` ou par élément codé en dur, et
  `bench:elements`, le seul qui voit juste, est hors de l'agrégat. **5c ajoute ses mesures à
  `bench:elements` et ne corrige pas le reste** : mêler les deux ferait deux choses mal.
